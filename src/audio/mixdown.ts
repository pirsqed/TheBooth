import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BedTrack,
  Cue,
  ExportFormat,
  MixExport,
  MixExportWindow,
  Project,
  SfxEvent,
  Take,
} from '../types/project.js';
import { ProjectStore, StoreError } from '../studio/store.js';
import { buildEqFilter } from './eq.js';
import { measureAudioLoudness, probeAudio, runCommand } from './ffmpeg.js';
import { computeAutoLevelGain } from './leveling.js';
import { buildPanFilterSegment } from './pan.js';
import { buildRoomToneFilterSegment } from './roomtone.js';
import {
  computeEffectiveTakeSpan,
  getActiveTake,
  resolveTimeline,
  ResolvedCueTiming,
} from './timeline.js';

export interface MixdownOptions {
  format?: ExportFormat;
  ffmpegPath?: string;
  ffprobePath?: string;
  allowCustomFfmpegFilter?: boolean;
  /** Max cue stems mixed in a single ffmpeg pass before intermediate bus batching (default 32) */
  maxCuesPerBatch?: number;
  /** Optional first cue ID for a scene-scoped partial mixdown */
  fromCueId?: string;
  /** Optional last cue ID for a scene-scoped partial mixdown */
  toCueId?: string;
  /** Optional start timestamp in seconds on the full timeline for a partial mixdown */
  startSec?: number;
  /** Optional end timestamp in seconds on the full timeline for a partial mixdown */
  endSec?: number;
}

export interface MixdownTelemetry {
  exportId: string;
  projectId: string;
  format: ExportFormat;
  durationMs: number;
  integratedLufs: number | null;
  truePeakDbtp: number;
  measuredRmsDbfs: number;
  channelRmsDbfs: number[];
  sampleRate: number;
  channels: number;
  masterNormalizeApplied: boolean;
  masterMakeupDb: number;
  cueCount: number;
  renderedCueCount: number;
  bedCount: number;
  sfxCount: number;
  window?: MixExportWindow;
  warnings: string[];
  createdAt: string;
}

export interface EffectiveClipSpan {
  isSliced: boolean;
  startMs: number;
  durationMs: number;
}

/**
 * Computes a safely clamped source clip slice `(startMs, durationMs)` for an SFX event
 * or `asset_file` bed, emitting warnings if `clipStartMs` or `clipDurationMs` exceeds
 * the probed source duration.
 */
export function computeEffectiveClipSpan(
  sourceDurationMs: number,
  clipStartMs: number | undefined,
  clipDurationMs: number | undefined,
  label: string,
  warnings: string[],
): EffectiveClipSpan {
  const safeSourceMs = Math.max(0, Math.round(sourceDurationMs));
  if (clipStartMs === undefined && clipDurationMs === undefined) {
    return { isSliced: false, startMs: 0, durationMs: safeSourceMs };
  }

  let startMs = Math.max(0, Math.round(clipStartMs ?? 0));
  if (safeSourceMs > 0 && startMs >= safeSourceMs) {
    const clampedStart = Math.max(0, safeSourceMs - 50);
    warnings.push(
      `${label}: clipStartMs (${startMs} ms) exceeds source duration (${safeSourceMs} ms); clamped to ${clampedStart} ms.`,
    );
    startMs = clampedStart;
  }

  const remainingMs = Math.max(10, safeSourceMs - startMs);
  let durationMs = remainingMs;
  if (clipDurationMs !== undefined) {
    const requestedDur = Math.max(10, Math.round(clipDurationMs));
    if (safeSourceMs > 0 && requestedDur > remainingMs) {
      warnings.push(
        `${label}: clipDurationMs (${requestedDur} ms) exceeds remaining source duration (${remainingMs} ms); clamped to ${remainingMs} ms.`,
      );
      durationMs = remainingMs;
    } else {
      durationMs = requestedDur;
    }
  }

  return {
    isSliced: true,
    startMs,
    durationMs,
  };
}

function validateCustomFilter(filter: string): string {
  const trimmed = filter.trim();
  if (!trimmed) return '';
  if (/[;\[\]\r\n]/.test(trimmed)) {
    throw new StoreError(
      'customFfmpegFilter cannot contain filtergraph delimiters (;, [, ], or newlines)',
      400,
    );
  }
  return trimmed;
}

function buildCodecArgs(format: ExportFormat, sampleRate: number): string[] {
  switch (format) {
    case 'wav':
      return ['-c:a', 'pcm_s16le', '-ar', String(sampleRate), '-ac', '2'];
    case 'ogg':
      return ['-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on', '-ar', String(sampleRate), '-ac', '2'];
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-q:a', '2', '-ar', String(sampleRate), '-ac', '2'];
  }
}

function buildLimiterFilter(truePeakCeilingDb: number): string {
  const linear = Math.max(0.0625, Math.min(1.0, Math.pow(10, truePeakCeilingDb / 20)));
  // level=disabled is critical: FFmpeg alimiter defaults to auto-leveling up to 0 dBFS!
  return `alimiter=limit=${linear.toFixed(6)}:attack=5:release=50:level=disabled`;
}

interface RenderedCueEntry {
  cue: Cue;
  take: Take;
  resolved: ResolvedCueTiming;
  wavPath: string;
  localStartMs: number;
  extraTrimStartMs: number;
  maxDurationMs?: number;
}

/**
 * Builds the per-cue FFmpeg filter chain:
 * resample -> EQ -> optional custom filter -> Stage-2 autoLevel + cue gainDb -> cosine fades -> pan/crossfeed -> adelay
 */
function buildCueFilterSegment(
  inputIdx: number,
  entry: RenderedCueEntry,
  project: Project,
  outputLabel: string,
  uid: string,
  allowCustomFfmpegFilter: boolean,
): string[] {
  const { cue, take } = entry;
  const sampleRate = project.audio.sampleRate;
  const effectiveMode = cue.mix.autoLevel ?? project.audio.autoLevel;
  const leveling = computeAutoLevelGain({
    mode: effectiveMode,
    workingTakeLufs: project.audio.workingTakeLufs,
    take,
  });

  const totalGainDb = leveling.autoGainDb + cue.mix.gainDb;
  const baseSpan = computeEffectiveTakeSpan(cue, take);
  const trimStartMs = Math.min(baseSpan.trimEndMs, baseSpan.trimStartMs + entry.extraTrimStartMs);
  const trimEndMs =
    entry.maxDurationMs !== undefined
      ? Math.min(baseSpan.trimEndMs, trimStartMs + entry.maxDurationMs)
      : baseSpan.trimEndMs;
  const effDurationMs = Math.max(10, trimEndMs - trimStartMs);
  const isTrimmed = trimStartMs > 0 || trimEndMs < baseSpan.rawDurationMs;

  const durSec = Math.max(0.01, effDurationMs / 1000);
  const fadeInSec = Math.min(durSec / 2, Math.max(0, cue.mix.fadeInMs / 1000));
  const fadeOutSec = Math.min(durSec / 2, Math.max(0, cue.mix.fadeOutMs / 1000));
  const fadeOutStartSec = Math.max(0, durSec - fadeOutSec);

  const prePanFilters: string[] = [`aresample=${sampleRate}`];
  if (isTrimmed) {
    prePanFilters.push(
      `atrim=start=${(trimStartMs / 1000).toFixed(4)}:end=${(trimEndMs / 1000).toFixed(4)}`,
      'asetpts=PTS-STARTPTS',
    );
  }
  prePanFilters.push(buildEqFilter(cue.mix.eqPreset));

  if (cue.mix.customFfmpegFilter && allowCustomFfmpegFilter) {
    const safeCustom = validateCustomFilter(cue.mix.customFfmpegFilter);
    if (safeCustom) prePanFilters.push(safeCustom);
  }

  if (Math.abs(totalGainDb) > 0.005) {
    prePanFilters.push(`volume=${totalGainDb.toFixed(2)}dB`);
  }

  if (fadeInSec > 0) {
    prePanFilters.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(4)}:curve=qsin`);
  }
  if (fadeOutSec > 0) {
    prePanFilters.push(
      `afade=t=out:st=${fadeOutStartSec.toFixed(4)}:d=${fadeOutSec.toFixed(4)}:curve=qsin`,
    );
  }

  const prePanLabel = `${uid}_pre`;
  const pannedLabel = entry.localStartMs > 0 ? `${uid}_pan` : outputLabel;

  const lines: string[] = [
    `[${inputIdx}:a]${prePanFilters.join(',')}[${prePanLabel}]`,
    ...buildPanFilterSegment({
      inputLabel: prePanLabel,
      outputLabel: pannedLabel,
      pan: cue.mix.pan,
      headphoneCrossfeed: project.audio.headphoneCrossfeed,
      sampleRate,
      uid,
    }),
  ];

  if (entry.localStartMs > 0) {
    // Reset PTS immediately after adelay so downstream atrim=0:... never strips prepended silence
    lines.push(
      `[${pannedLabel}]adelay=${entry.localStartMs}|${entry.localStartMs},asetpts=PTS-STARTPTS[${outputLabel}]`,
    );
  }

  return lines;
}

/**
 * Renders a batch of cues into a 32-bit float stereo intermediate WAV
 * using -filter_complex_script to stay well within OS limits.
 */
async function renderCueBatch(
  entries: RenderedCueEntry[],
  project: Project,
  totalDurationMs: number,
  outWavPath: string,
  tempDir: string,
  batchIndex: number,
  ffmpegPath: string,
  allowCustomFfmpegFilter: boolean,
): Promise<void> {
  const sampleRate = project.audio.sampleRate;
  const totalSec = (totalDurationMs / 1000).toFixed(4);
  const inputArgs: string[] = [];
  const filterLines: string[] = [];
  const cueLabels: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    inputArgs.push('-i', entry.wavPath);
    const outLbl = `bc_${i}`;
    cueLabels.push(`[${outLbl}]`);
    filterLines.push(
      ...buildCueFilterSegment(
        i,
        entry,
        project,
        outLbl,
        `b${batchIndex}_c${i}`,
        allowCustomFfmpegFilter,
      ),
    );
  }

  if (cueLabels.length === 1) {
    filterLines.push(
      `${cueLabels[0]}apad=whole_dur=${totalSec},atrim=0:${totalSec}[batch_out]`,
    );
  } else {
    filterLines.push(
      `${cueLabels.join('')}amix=inputs=${cueLabels.length}:duration=longest:normalize=0:dropout_transition=0,apad=whole_dur=${totalSec},atrim=0:${totalSec}[batch_out]`,
    );
  }

  const scriptPath = path.join(tempDir, `batch_${batchIndex}.ffscript`);
  await fs.writeFile(scriptPath, filterLines.join(';\n') + '\n', 'utf8');

  await runCommand(ffmpegPath, [
    '-hide_banner',
    '-y',
    ...inputArgs,
    '-filter_complex_script',
    scriptPath,
    '-map',
    '[batch_out]',
    '-c:a',
    'pcm_f32le',
    '-ar',
    String(sampleRate),
    '-ac',
    '2',
    outWavPath,
  ]);
}

function buildSidechainDuckingFilter(bed: BedTrack): string {
  const absDuck = Math.max(0.5, Math.min(24, Math.abs(bed.ducking.amountDb)));
  // Speech bus sits near -20 LUFS; setting threshold ~ -34 dBFS (0.02 linear)
  // gives ~14 dB excess so ratio maps cleanly to the desired dB reduction.
  const nominalExcessDb = 14;
  const clampedDuck = Math.min(nominalExcessDb - 1, absDuck);
  const ratio = Math.max(
    1.5,
    Math.min(20, nominalExcessDb / (nominalExcessDb - clampedDuck)),
  );
  const thresholdLinear = 0.02;
  return `sidechaincompress=threshold=${thresholdLinear}:ratio=${ratio.toFixed(2)}:attack=${bed.ducking.attackMs}:release=${bed.ducking.releaseMs}:knee=4:detection=rms:link=average`;
}

/**
 * Executes Stage-2 deterministic local mixdown for a project:
 * - Resolves cycle-free timeline (cues + SFX + tail)
 * - Batches speech cues cleanly when >32 cues
 * - Applies non-destructive autoLevel, EQ, cosine edge fades, constant-power pan + headphone crossfeed
 * - Mixes synthetic room tone & looped ambient beds with smooth speech-triggered sidechain ducking
 * - Applies true-peak limiter (-1.5 dBTP) and optional master normalization
 * - Writes rendered audio + JSON telemetry under projects/<projectId>/exports/
 */
export async function runMixdown(
  project: Project,
  store: ProjectStore,
  options: MixdownOptions = {},
): Promise<{ exportRecord: MixExport; telemetry: MixdownTelemetry }> {
  const format: ExportFormat = options.format ?? 'ogg';
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const allowCustomFfmpegFilter = options.allowCustomFfmpegFilter ?? false;
  const maxCuesPerBatch = options.maxCuesPerBatch ?? 32;
  const sampleRate = project.audio.sampleRate;

  const sliceWarnings: string[] = [];

  // 1. Resolve & probe all SFX assets upfront so timeline endMs (and slice fades) are exact
  const sfxAssetFiles = new Map<
    string,
    {
      filePath: string;
      sourceDurationMs: number;
      isSliced: boolean;
      sliceStartMs: number;
      effectiveDurationMs: number;
      channels: number;
    }
  >();
  const sfxDurationsMs: Record<string, number> = {};
  for (const evt of project.sfx) {
    const resolvedAsset = await store.resolveExistingAssetFile(evt.assetPath);
    const probe = await probeAudio(resolvedAsset.absPath, ffprobePath);
    const clip = computeEffectiveClipSpan(
      probe.durationMs,
      evt.clipStartMs,
      evt.clipDurationMs,
      `SFX "${evt.id}"`,
      sliceWarnings,
    );
    sfxAssetFiles.set(evt.id, {
      filePath: resolvedAsset.absPath,
      sourceDurationMs: probe.durationMs,
      isSliced: clip.isSliced,
      sliceStartMs: clip.startMs,
      effectiveDurationMs: clip.durationMs,
      channels: probe.channels,
    });
    sfxDurationsMs[evt.id] = clip.durationMs;
  }

  // 2. Resolve asset_file beds upfront (probing when source-sliced)
  const bedAssetFiles = new Map<
    string,
    {
      filePath: string;
      isSliced: boolean;
      sliceStartMs: number;
      sliceDurationMs: number;
    }
  >();
  for (const bed of project.beds) {
    if (bed.kind === 'asset_file' && bed.assetPath) {
      const resolvedAsset = await store.resolveExistingAssetFile(bed.assetPath);
      if (bed.clipStartMs !== undefined || bed.clipDurationMs !== undefined) {
        const probe = await probeAudio(resolvedAsset.absPath, ffprobePath);
        const clip = computeEffectiveClipSpan(
          probe.durationMs,
          bed.clipStartMs,
          bed.clipDurationMs,
          `Bed "${bed.id}"`,
          sliceWarnings,
        );
        bedAssetFiles.set(bed.id, {
          filePath: resolvedAsset.absPath,
          isSliced: true,
          sliceStartMs: clip.startMs,
          sliceDurationMs: clip.durationMs,
        });
      } else {
        bedAssetFiles.set(bed.id, {
          filePath: resolvedAsset.absPath,
          isSliced: false,
          sliceStartMs: 0,
          sliceDurationMs: 0,
        });
      }
    }
  }

  // 3. Resolve full timeline (cues, SFX, cue-anchored beds, leadInMs, tailMs)
  const timeline = resolveTimeline(project, sfxDurationsMs);
  const warnings: string[] = [...sliceWarnings, ...timeline.warnings];

  const hasCueBounds = options.fromCueId !== undefined || options.toCueId !== undefined;
  const hasSecBounds = options.startSec !== undefined || options.endSec !== undefined;
  if (hasCueBounds && hasSecBounds) {
    throw new StoreError(
      'Specify either fromCueId/toCueId or startSec/endSec for partial mixdown, not both.',
      400,
    );
  }

  const fullTotalDurationMs = Math.max(500, timeline.totalDurationMs);
  const isPartial = hasCueBounds || hasSecBounds;
  let windowStartMs = 0;
  let windowEndMs = fullTotalDurationMs;
  let fromCueIdx = 0;
  let toCueIdx = project.cues.length - 1;
  let cueScopeEndMs: number | null = null;

  if (hasCueBounds) {
    if (project.cues.length === 0) {
      throw new StoreError('Cannot use fromCueId/toCueId on a project with no cues.', 400);
    }
    if (options.fromCueId !== undefined) {
      fromCueIdx = project.cues.findIndex((c) => c.id === options.fromCueId);
      if (fromCueIdx === -1) {
        throw new StoreError(`fromCueId not found: ${options.fromCueId}`, 404);
      }
    }
    if (options.toCueId !== undefined) {
      toCueIdx = project.cues.findIndex((c) => c.id === options.toCueId);
      if (toCueIdx === -1) {
        throw new StoreError(`toCueId not found: ${options.toCueId}`, 404);
      }
    }
    if (fromCueIdx > toCueIdx) {
      throw new StoreError(
        `fromCueId "${options.fromCueId}" appears after toCueId "${options.toCueId}".`,
        400,
      );
    }
    const fromResolved = timeline.cues[fromCueIdx]!;
    const toResolved = timeline.cues[toCueIdx]!;
    windowStartMs = options.fromCueId !== undefined ? fromResolved.startMs : 0;
    const tailPadMs = project.audio.tailMs ?? 2000;
    cueScopeEndMs = toResolved.endMs;
    windowEndMs =
      options.toCueId !== undefined
        ? Math.min(fullTotalDurationMs, toResolved.endMs + tailPadMs)
        : fullTotalDurationMs;
    if (windowEndMs <= windowStartMs) {
      throw new StoreError('Selected cue window has zero duration (render takes first).', 400);
    }
  } else if (hasSecBounds) {
    const rawStartMs = Math.round((options.startSec ?? 0) * 1000);
    if (!Number.isFinite(rawStartMs) || rawStartMs < 0) {
      throw new StoreError(`Invalid startSec: ${options.startSec}`, 400);
    }
    if (rawStartMs >= fullTotalDurationMs) {
      throw new StoreError(
        `startSec (${(rawStartMs / 1000).toFixed(2)}s) must be less than project duration (${(fullTotalDurationMs / 1000).toFixed(2)}s).`,
        400,
      );
    }
    const rawEndMs =
      options.endSec !== undefined
        ? Math.min(fullTotalDurationMs, Math.round(options.endSec * 1000))
        : fullTotalDurationMs;
    if (!Number.isFinite(rawEndMs) || rawEndMs <= rawStartMs + 50) {
      throw new StoreError(
        `endSec (${(rawEndMs / 1000).toFixed(2)}s) must be greater than startSec (${(rawStartMs / 1000).toFixed(2)}s).`,
        400,
      );
    }
    windowStartMs = rawStartMs;
    windowEndMs = rawEndMs;
  }

  const cueIndexById = new Map<string, number>();
  project.cues.forEach((c, idx) => cueIndexById.set(c.id, idx));

  const renderedCues: RenderedCueEntry[] = [];
  for (let i = 0; i < project.cues.length; i++) {
    if (hasCueBounds && (i < fromCueIdx || i > toCueIdx)) continue;
    const cue = project.cues[i]!;
    const resolved = timeline.cues[i]!;
    if (isPartial && (resolved.endMs <= windowStartMs || resolved.startMs >= windowEndMs)) {
      continue;
    }
    const take = getActiveTake(cue);
    if (!take) {
      warnings.push(`Cue "${cue.id}" has no active take and was skipped in mixdown.`);
      continue;
    }
    const wavPath = store.resolveProjectFile(project.id, take.audioPath);
    const extraTrimStartMs = Math.max(0, windowStartMs - resolved.startMs);
    const localStartMs = Math.max(0, resolved.startMs - windowStartMs);
    const clippedEndMs = Math.min(resolved.endMs, windowEndMs);
    const clippedStartMs = Math.max(resolved.startMs, windowStartMs);
    const maxDurationMs =
      resolved.endMs > windowEndMs ? Math.max(10, clippedEndMs - clippedStartMs) : undefined;
    renderedCues.push({
      cue,
      take,
      resolved,
      wavPath,
      localStartMs,
      extraTrimStartMs,
      maxDurationMs,
    });
  }

  // Filter active beds intersecting [windowStartMs, windowEndMs]
  const activeBeds: Array<{
    bed: BedTrack;
    resolvedStartMs: number;
    resolvedEndMs: number;
    localStartMs: number;
    localDurationMs: number;
    fadeInMs: number;
    fadeOutMs: number;
  }> = [];
  for (let i = 0; i < project.beds.length; i++) {
    const bed = project.beds[i]!;
    const resolvedBed = timeline.beds[i]!;
    const clippedStart = Math.max(resolvedBed.startMs, windowStartMs);
    const clippedEnd = Math.min(resolvedBed.endMs, windowEndMs);
    if (clippedEnd <= clippedStart) continue;
    activeBeds.push({
      bed,
      resolvedStartMs: resolvedBed.startMs,
      resolvedEndMs: resolvedBed.endMs,
      localStartMs: clippedStart - windowStartMs,
      localDurationMs: Math.max(50, clippedEnd - clippedStart),
      fadeInMs: resolvedBed.startMs >= windowStartMs ? bed.fadeInMs : Math.min(bed.fadeInMs, 30),
      fadeOutMs: resolvedBed.endMs <= windowEndMs ? bed.fadeOutMs : Math.min(bed.fadeOutMs, 150),
    });
  }

  // Filter active SFX intersecting [windowStartMs, windowEndMs]
  const activeSfx: Array<{
    evt: SfxEvent;
    info: {
      filePath: string;
      sourceDurationMs: number;
      isSliced: boolean;
      sliceStartMs: number;
      effectiveDurationMs: number;
      channels: number;
    };
    localStartMs: number;
    leftClipMs: number;
    effDurationMs: number;
  }> = [];
  for (let i = 0; i < project.sfx.length; i++) {
    const evt = project.sfx[i]!;
    const resolved = timeline.sfx[i]!;
    const info = sfxAssetFiles.get(evt.id)!;
    if (isPartial && (resolved.endMs <= windowStartMs || resolved.startMs >= windowEndMs)) {
      continue;
    }
    if (hasCueBounds && evt.anchor.cueId != null) {
      const anchorIdx = cueIndexById.get(evt.anchor.cueId);
      if (
        anchorIdx !== undefined &&
        (anchorIdx < fromCueIdx || anchorIdx > toCueIdx) &&
        cueScopeEndMs !== null &&
        resolved.startMs >= cueScopeEndMs
      ) {
        continue;
      }
    }
    const leftClipMs = Math.max(0, windowStartMs - resolved.startMs);
    const effDurationMs = Math.max(10, info.effectiveDurationMs - leftClipMs);
    const localStartMs = Math.max(0, resolved.startMs - windowStartMs);
    activeSfx.push({ evt, info, localStartMs, leftClipMs, effDurationMs });
  }

  if (renderedCues.length === 0 && activeBeds.length === 0 && activeSfx.length === 0) {
    throw new StoreError(
      'Cannot mix an empty project or empty window with no rendered takes, beds, or SFX.',
      400,
    );
  }

  const totalDurationMs = Math.max(100, windowEndMs - windowStartMs);
  const totalSec = (totalDurationMs / 1000).toFixed(4);
  const exportWindow: MixExportWindow | undefined = isPartial
    ? {
        startMs: windowStartMs,
        endMs: windowEndMs,
        ...(options.fromCueId ? { fromCueId: options.fromCueId } : {}),
        ...(options.toCueId ? { toCueId: options.toCueId } : {}),
      }
    : undefined;

  const exportId = `exp_${crypto.randomBytes(6).toString('hex')}`;
  const audioRelPath = `exports/${exportId}.${format}`;
  const audioAbsPath = store.resolveProjectFile(project.id, audioRelPath);
  await fs.mkdir(path.dirname(audioAbsPath), { recursive: true });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thebooth-mix-'));

  try {
    const inputArgs: string[] = [];
    let nextInputIdx = 0;
    const filterLines: string[] = [];

    // 4. Build [speech_bus] (either directly or via batched intermediate 32-bit float WAVs)
    const hasSpeech = renderedCues.length > 0;
    if (hasSpeech) {
      if (renderedCues.length <= maxCuesPerBatch) {
        const cueLabels: string[] = [];
        for (let i = 0; i < renderedCues.length; i++) {
          const entry = renderedCues[i]!;
          const idx = nextInputIdx++;
          inputArgs.push('-i', entry.wavPath);
          const lbl = `cue_${i}`;
          cueLabels.push(`[${lbl}]`);
          filterLines.push(
            ...buildCueFilterSegment(
              idx,
              entry,
              project,
              lbl,
              `c${i}`,
              allowCustomFfmpegFilter,
            ),
          );
        }
        if (cueLabels.length === 1) {
          filterLines.push(
            `${cueLabels[0]}apad=whole_dur=${totalSec},atrim=0:${totalSec}[speech_bus]`,
          );
        } else {
          filterLines.push(
            `${cueLabels.join('')}amix=inputs=${cueLabels.length}:duration=longest:normalize=0:dropout_transition=0,apad=whole_dur=${totalSec},atrim=0:${totalSec}[speech_bus]`,
          );
        }
      } else {
        // Batch into intermediate float32 WAV sums to keep file handles & memory bounded
        const batchLabels: string[] = [];
        let batchIdx = 0;
        for (let start = 0; start < renderedCues.length; start += maxCuesPerBatch) {
          const slice = renderedCues.slice(start, start + maxCuesPerBatch);
          const batchWav = path.join(tempDir, `speech_batch_${batchIdx}.wav`);
          await renderCueBatch(
            slice,
            project,
            totalDurationMs,
            batchWav,
            tempDir,
            batchIdx,
            ffmpegPath,
            allowCustomFfmpegFilter,
          );
          const idx = nextInputIdx++;
          inputArgs.push('-i', batchWav);
          batchLabels.push(`[${idx}:a]`);
          batchIdx += 1;
        }
        filterLines.push(
          `${batchLabels.join('')}amix=inputs=${batchLabels.length}:duration=longest:normalize=0:dropout_transition=0,apad=whole_dur=${totalSec},atrim=0:${totalSec}[speech_bus]`,
        );
      }
    }

    // Prepare sidechain splits of [speech_bus] only for active beds that duck under speech
    const duckedBedIds = new Set(
      activeBeds
        .filter((b) => hasSpeech && b.bed.ducking.enabled && b.bed.ducking.amountDb < 0)
        .map((b) => b.bed.id),
    );

    const masterMixInputs: string[] = [];
    const sidechainQueue: string[] = [];

    if (hasSpeech) {
      if (duckedBedIds.size > 0) {
        const splitCount = 1 + duckedBedIds.size;
        const splitOutputs = ['speech_main'];
        for (let i = 0; i < duckedBedIds.size; i++) {
          const scLbl = `speech_sc_${i}`;
          splitOutputs.push(scLbl);
          sidechainQueue.push(scLbl);
        }
        filterLines.push(
          `[speech_bus]asplit=${splitCount}${splitOutputs.map((l) => `[${l}]`).join('')}`,
        );
        masterMixInputs.push('[speech_main]');
      } else {
        masterMixInputs.push('[speech_bus]');
      }
    }

    // 5. Build beds (synthetic room tone + looped/trimmed asset files + optional ducking)
    for (let i = 0; i < activeBeds.length; i++) {
      const activeBed = activeBeds[i]!;
      const { bed } = activeBed;
      const bedStartMs = activeBed.localStartMs;
      const bedDurationMs = activeBed.localDurationMs;
      const bedDurationSec = (bedDurationMs / 1000).toFixed(4);
      const rawBedLabel = `bed_raw_${i}`;
      const finalBedLabel = `bed_${i}`;

      if (bed.kind === 'synthetic_room_tone') {
        filterLines.push(
          ...buildRoomToneFilterSegment({
            style: bed.roomToneStyle ?? 'warm_dark',
            durationMs: bedDurationMs,
            sampleRate,
            gainDb: bed.gainDb,
            fadeInMs: activeBed.fadeInMs,
            fadeOutMs: activeBed.fadeOutMs,
            outputLabel: rawBedLabel,
            uid: `bed${i}`,
          }),
        );
      } else {
        const bedAsset = bedAssetFiles.get(bed.id)!;
        const idx = nextInputIdx++;
        if (bedAsset.isSliced) {
          // Fast input-side seek + duration avoids decoding long archives and keeps PTS clean
          inputArgs.push(
            '-ss',
            (bedAsset.sliceStartMs / 1000).toFixed(4),
            '-t',
            (bedAsset.sliceDurationMs / 1000).toFixed(4),
          );
        } else if (bed.loop) {
          inputArgs.push('-stream_loop', '-1');
        }
        inputArgs.push('-i', bedAsset.filePath);

        const effectiveBedSpanMs =
          bedAsset.isSliced && !bed.loop
            ? Math.min(bedDurationMs, bedAsset.sliceDurationMs)
            : bedDurationMs;
        const fadeInSec = Math.min(
          effectiveBedSpanMs / 2000,
          Math.max(0, activeBed.fadeInMs / 1000),
        );
        const fadeOutSec = Math.min(
          effectiveBedSpanMs / 2000,
          Math.max(0, activeBed.fadeOutMs / 1000),
        );
        const fadeOutStartSec = Math.max(0, effectiveBedSpanMs / 1000 - fadeOutSec);

        const chain: string[] = [
          `aresample=${sampleRate}`,
          `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`,
          'asetpts=PTS-STARTPTS',
        ];

        if (bedAsset.isSliced && bed.loop) {
          const clipSamples = Math.max(
            1,
            Math.round((bedAsset.sliceDurationMs * sampleRate) / 1000),
          );
          chain.push(`aloop=loop=-1:size=${clipSamples}`);
        }

        chain.push(
          `atrim=0:${bedDurationSec}`,
          'asetpts=PTS-STARTPTS',
          `volume=${bed.gainDb.toFixed(2)}dB`,
        );
        if (fadeInSec > 0) {
          chain.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(4)}:curve=qsin`);
        }
        if (fadeOutSec > 0) {
          chain.push(
            `afade=t=out:st=${fadeOutStartSec.toFixed(4)}:d=${fadeOutSec.toFixed(4)}:curve=qsin`,
          );
        }
        filterLines.push(`[${idx}:a]${chain.join(',')}[${rawBedLabel}]`);
      }

      // Align bed start/end onto full timeline (asetpts AFTER adelay prevents atrim from stripping delay!)
      const alignedBedLabel = duckedBedIds.has(bed.id) ? `bed_al_${i}` : finalBedLabel;
      const alignChain: string[] = [];
      if (bedStartMs > 0) {
        alignChain.push(`adelay=${bedStartMs}|${bedStartMs}`, 'asetpts=PTS-STARTPTS');
      } else {
        alignChain.push('asetpts=PTS-STARTPTS');
      }
      alignChain.push(`apad=whole_dur=${totalSec}`, `atrim=0:${totalSec}`);
      filterLines.push(`[${rawBedLabel}]${alignChain.join(',')}[${alignedBedLabel}]`);

      if (duckedBedIds.has(bed.id)) {
        const scLbl = sidechainQueue.shift()!;
        filterLines.push(
          `[${alignedBedLabel}][${scLbl}]${buildSidechainDuckingFilter(bed)}[${finalBedLabel}]`,
        );
      }

      masterMixInputs.push(`[${finalBedLabel}]`);
    }

    // 6. Build SFX events
    for (let i = 0; i < activeSfx.length; i++) {
      const { evt, info, localStartMs, leftClipMs, effDurationMs } = activeSfx[i]!;
      const idx = nextInputIdx++;
      const effSliceStartMs = info.sliceStartMs + leftClipMs;
      const effIsSliced = info.isSliced || leftClipMs > 0;
      if (effIsSliced) {
        inputArgs.push(
          '-ss',
          (effSliceStartMs / 1000).toFixed(4),
          '-t',
          (effDurationMs / 1000).toFixed(4),
        );
      }
      inputArgs.push('-i', info.filePath);

      const durSec = Math.max(0.01, effDurationMs / 1000);
      const fadeInSec = Math.min(durSec / 2, Math.max(0, evt.fadeInMs / 1000));
      const fadeOutSec = Math.min(durSec / 2, Math.max(0, evt.fadeOutMs / 1000));
      const fadeOutStartSec = Math.max(0, durSec - fadeOutSec);

      const preFilters: string[] = [
        `aresample=${sampleRate}`,
        'asetpts=PTS-STARTPTS',
        `volume=${evt.gainDb.toFixed(2)}dB`,
      ];
      if (fadeInSec > 0) {
        preFilters.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(4)}:curve=qsin`);
      }
      if (fadeOutSec > 0) {
        preFilters.push(
          `afade=t=out:st=${fadeOutStartSec.toFixed(4)}:d=${fadeOutSec.toFixed(4)}:curve=qsin`,
        );
      }

      const preLbl = `sfx_pre_${i}`;
      const pannedLbl = `sfx_pan_${i}`;
      const finalLbl = `sfx_${i}`;

      filterLines.push(`[${idx}:a]${preFilters.join(',')}[${preLbl}]`);

      // Preserve native stereo image for centered stereo SFX; pan otherwise
      if (info.channels >= 2 && Math.abs(evt.pan) <= 0.01) {
        filterLines.push(
          `[${preLbl}]aformat=sample_rates=${sampleRate}:channel_layouts=stereo[${pannedLbl}]`,
        );
      } else {
        filterLines.push(
          ...buildPanFilterSegment({
            inputLabel: preLbl,
            outputLabel: pannedLbl,
            pan: evt.pan,
            headphoneCrossfeed: project.audio.headphoneCrossfeed,
            sampleRate,
            uid: `sfx${i}`,
          }),
        );
      }

      const postFilters: string[] = [];
      if (localStartMs > 0) {
        // Reset PTS immediately after adelay so atrim=0:... never strips prepended silence on FLAC/WAV slices
        postFilters.push(`adelay=${localStartMs}|${localStartMs}`, 'asetpts=PTS-STARTPTS');
      } else {
        postFilters.push('asetpts=PTS-STARTPTS');
      }
      postFilters.push(`apad=whole_dur=${totalSec}`, `atrim=0:${totalSec}`);
      filterLines.push(`[${pannedLbl}]${postFilters.join(',')}[${finalLbl}]`);
      masterMixInputs.push(`[${finalLbl}]`);
    }

    // 7. Combine master bus + true-peak limiter
    const limiter = buildLimiterFilter(project.audio.truePeakCeilingDb);
    if (masterMixInputs.length === 1) {
      filterLines.push(
        `${masterMixInputs[0]}atrim=0:${totalSec},${limiter}[master_out]`,
      );
    } else {
      filterLines.push(
        `${masterMixInputs.join('')}amix=inputs=${masterMixInputs.length}:duration=longest:normalize=0:dropout_transition=0,atrim=0:${totalSec},${limiter}[master_out]`,
      );
    }

    const masterScriptPath = path.join(tempDir, 'master.ffscript');
    await fs.writeFile(masterScriptPath, filterLines.join(';\n') + '\n', 'utf8');

    let masterMakeupDb = 0;
    let masterNormalizeApplied = false;

    if (!project.audio.masterNormalize) {
      await runCommand(ffmpegPath, [
        '-hide_banner',
        '-y',
        ...inputArgs,
        '-filter_complex_script',
        masterScriptPath,
        '-map',
        '[master_out]',
        ...buildCodecArgs(format, sampleRate),
        audioAbsPath,
      ]);
    } else {
      // Two-pass linear master normalization: render float32 pre-master, measure LUFS, apply linear makeup + limiter
      const preMasterWav = path.join(tempDir, 'pre_master.wav');
      await runCommand(ffmpegPath, [
        '-hide_banner',
        '-y',
        ...inputArgs,
        '-filter_complex_script',
        masterScriptPath,
        '-map',
        '[master_out]',
        '-c:a',
        'pcm_f32le',
        '-ar',
        String(sampleRate),
        '-ac',
        '2',
        preMasterWav,
      ]);

      const preMeasure = await measureAudioLoudness(preMasterWav, ffmpegPath);
      if (preMeasure.measuredLufs !== null && Number.isFinite(preMeasure.measuredLufs)) {
        const rawDelta = project.audio.masterTargetLufs - preMeasure.measuredLufs;
        masterMakeupDb = Number(Math.max(-12, Math.min(12, rawDelta)).toFixed(2));
        masterNormalizeApplied = true;
      } else {
        warnings.push(
          'masterNormalize was enabled, but integrated LUFS could not be measured (silent/sub-second mix); skipped makeup gain.',
        );
      }

      const normFilter =
        Math.abs(masterMakeupDb) > 0.01
          ? `volume=${masterMakeupDb.toFixed(2)}dB,${limiter}`
          : limiter;

      await runCommand(ffmpegPath, [
        '-hide_banner',
        '-y',
        '-i',
        preMasterWav,
        '-af',
        normFilter,
        ...buildCodecArgs(format, sampleRate),
        audioAbsPath,
      ]);
    }

    // 8. Measure final exported master and persist telemetry
    const [finalProbe, finalLoudness] = await Promise.all([
      probeAudio(audioAbsPath, ffprobePath),
      measureAudioLoudness(audioAbsPath, ffmpegPath),
    ]);

    const createdAt = new Date().toISOString();
    const telemetry: MixdownTelemetry = {
      exportId,
      projectId: project.id,
      format,
      durationMs: finalProbe.durationMs,
      integratedLufs: finalLoudness.measuredLufs,
      truePeakDbtp: finalLoudness.truePeakDbtp,
      measuredRmsDbfs: finalLoudness.measuredRmsDbfs,
      channelRmsDbfs: finalLoudness.channelRmsDbfs,
      sampleRate: finalProbe.sampleRate || sampleRate,
      channels: finalProbe.channels || 2,
      masterNormalizeApplied,
      masterMakeupDb,
      cueCount: hasCueBounds ? toCueIdx - fromCueIdx + 1 : project.cues.length,
      renderedCueCount: renderedCues.length,
      bedCount: activeBeds.length,
      sfxCount: activeSfx.length,
      ...(exportWindow ? { window: exportWindow } : {}),
      warnings,
      createdAt,
    };

    const telemetryRelPath = await store.writeExportTelemetry(
      project.id,
      exportId,
      telemetry,
    );

    const exportRecord: MixExport = {
      id: exportId,
      format,
      audioPath: audioRelPath,
      telemetryPath: telemetryRelPath,
      durationMs: telemetry.durationMs,
      integratedLufs: telemetry.integratedLufs,
      truePeakDbtp: telemetry.truePeakDbtp,
      sampleRate: telemetry.sampleRate,
      channels: telemetry.channels,
      ...(exportWindow ? { window: exportWindow } : {}),
      warnings,
      createdAt,
    };

    return { exportRecord, telemetry };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
