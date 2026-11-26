import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BedTrack,
  Cue,
  ExportFormat,
  MixExport,
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
import { getActiveTake, resolveTimeline, ResolvedCueTiming } from './timeline.js';

export interface MixdownOptions {
  format?: ExportFormat;
  ffmpegPath?: string;
  ffprobePath?: string;
  allowCustomFfmpegFilter?: boolean;
  /** Max cue stems mixed in a single ffmpeg pass before intermediate bus batching (default 32) */
  maxCuesPerBatch?: number;
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
  warnings: string[];
  createdAt: string;
}

const ASSET_FALLBACK_EXTENSIONS = ['.wav', '.ogg', '.mp3', '.flac'];

async function resolveAssetFile(
  store: ProjectStore,
  assetPath: string,
): Promise<string> {
  const direct = store.resolveAssetPath(assetPath);
  try {
    const st = await fs.stat(direct);
    if (st.isFile()) return direct;
  } catch {
    // Try fallback extensions if extensionless
  }

  if (!path.extname(assetPath)) {
    for (const ext of ASSET_FALLBACK_EXTENSIONS) {
      const candidate = store.resolveAssetPath(`${assetPath}${ext}`);
      try {
        const st = await fs.stat(candidate);
        if (st.isFile()) return candidate;
      } catch {
        // continue
      }
    }
  }

  throw new StoreError(`Audio asset not found under assets/: ${assetPath}`, 404);
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
  const { cue, take, resolved } = entry;
  const sampleRate = project.audio.sampleRate;
  const effectiveMode = cue.mix.autoLevel ?? project.audio.autoLevel;
  const leveling = computeAutoLevelGain({
    mode: effectiveMode,
    workingTakeLufs: project.audio.workingTakeLufs,
    take,
  });

  const totalGainDb = leveling.autoGainDb + cue.mix.gainDb;
  const durSec = Math.max(0.01, take.durationMs / 1000);
  const fadeInSec = Math.min(durSec / 2, Math.max(0, cue.mix.fadeInMs / 1000));
  const fadeOutSec = Math.min(durSec / 2, Math.max(0, cue.mix.fadeOutMs / 1000));
  const fadeOutStartSec = Math.max(0, durSec - fadeOutSec);

  const prePanFilters: string[] = [
    `aresample=${sampleRate}`,
    buildEqFilter(cue.mix.eqPreset),
  ];

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
  const pannedLabel = resolved.startMs > 0 ? `${uid}_pan` : outputLabel;

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

  if (resolved.startMs > 0) {
    lines.push(
      `[${pannedLabel}]adelay=${resolved.startMs}|${resolved.startMs}[${outputLabel}]`,
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

  // 1. Resolve & probe all SFX assets upfront so timeline endMs is exact
  const sfxAssetFiles = new Map<string, { filePath: string; durationMs: number; channels: number }>();
  const sfxDurationsMs: Record<string, number> = {};
  for (const evt of project.sfx) {
    const filePath = await resolveAssetFile(store, evt.assetPath);
    const probe = await probeAudio(filePath, ffprobePath);
    sfxAssetFiles.set(evt.id, {
      filePath,
      durationMs: probe.durationMs,
      channels: probe.channels,
    });
    sfxDurationsMs[evt.id] = probe.durationMs;
  }

  // 2. Resolve asset_file beds upfront
  const bedAssetFiles = new Map<string, string>();
  for (const bed of project.beds) {
    if (bed.kind === 'asset_file' && bed.assetPath) {
      const filePath = await resolveAssetFile(store, bed.assetPath);
      bedAssetFiles.set(bed.id, filePath);
    }
  }

  // 3. Resolve timeline
  const timeline = resolveTimeline(project, sfxDurationsMs);
  const warnings: string[] = [...timeline.warnings];

  const renderedCues: RenderedCueEntry[] = [];
  for (let i = 0; i < project.cues.length; i++) {
    const cue = project.cues[i]!;
    const resolved = timeline.cues[i]!;
    const take = getActiveTake(cue);
    if (!take) {
      warnings.push(`Cue "${cue.id}" has no active take and was skipped in mixdown.`);
      continue;
    }
    const wavPath = store.resolveProjectFile(project.id, take.audioPath);
    renderedCues.push({ cue, take, resolved, wavPath });
  }

  if (renderedCues.length === 0 && project.beds.length === 0 && project.sfx.length === 0) {
    throw new StoreError(
      'Cannot mix an empty project with no rendered takes, beds, or SFX.',
      400,
    );
  }

  const totalDurationMs = Math.max(500, timeline.totalDurationMs);
  const totalSec = (totalDurationMs / 1000).toFixed(4);

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

    // Prepare sidechain splits of [speech_bus] if any beds duck under speech
    const duckedBedIds = new Set(
      project.beds
        .filter((b) => hasSpeech && b.ducking.enabled && b.ducking.amountDb < 0)
        .map((b) => b.id),
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
    for (let i = 0; i < project.beds.length; i++) {
      const bed = project.beds[i]!;
      const bedStartMs = Math.max(0, bed.startMs ?? 0);
      const bedEndMs =
        bed.endMs != null ? Math.min(totalDurationMs, bed.endMs) : totalDurationMs;
      const bedDurationMs = Math.max(100, bedEndMs - bedStartMs);
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
            fadeInMs: bed.fadeInMs,
            fadeOutMs: bed.fadeOutMs,
            outputLabel: rawBedLabel,
            uid: `bed${i}`,
          }),
        );
      } else {
        const assetFile = bedAssetFiles.get(bed.id)!;
        const idx = nextInputIdx++;
        if (bed.loop) {
          inputArgs.push('-stream_loop', '-1');
        }
        inputArgs.push('-i', assetFile);

        const fadeInSec = Math.min(
          bedDurationMs / 2000,
          Math.max(0, bed.fadeInMs / 1000),
        );
        const fadeOutSec = Math.min(
          bedDurationMs / 2000,
          Math.max(0, bed.fadeOutMs / 1000),
        );
        const fadeOutStartSec = Math.max(0, bedDurationMs / 1000 - fadeOutSec);

        const chain: string[] = [
          `aresample=${sampleRate}`,
          `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`,
          `atrim=0:${bedDurationSec}`,
          'asetpts=PTS-STARTPTS',
          `volume=${bed.gainDb.toFixed(2)}dB`,
        ];
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

      // Align bed start/end onto full timeline
      const alignedBedLabel = duckedBedIds.has(bed.id) ? `bed_al_${i}` : finalBedLabel;
      const alignChain: string[] = [];
      if (bedStartMs > 0) {
        alignChain.push(`adelay=${bedStartMs}|${bedStartMs}`);
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
    for (let i = 0; i < project.sfx.length; i++) {
      const evt: SfxEvent = project.sfx[i]!;
      const resolved = timeline.sfx[i]!;
      const info = sfxAssetFiles.get(evt.id)!;
      const idx = nextInputIdx++;
      inputArgs.push('-i', info.filePath);

      const durSec = Math.max(0.01, info.durationMs / 1000);
      const fadeInSec = Math.min(durSec / 2, Math.max(0, evt.fadeInMs / 1000));
      const fadeOutSec = Math.min(durSec / 2, Math.max(0, evt.fadeOutMs / 1000));
      const fadeOutStartSec = Math.max(0, durSec - fadeOutSec);

      const preFilters: string[] = [
        `aresample=${sampleRate}`,
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
      if (resolved.startMs > 0) {
        postFilters.push(`adelay=${resolved.startMs}|${resolved.startMs}`);
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
      cueCount: project.cues.length,
      renderedCueCount: renderedCues.length,
      bedCount: project.beds.length,
      sfxCount: project.sfx.length,
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
      warnings,
      createdAt,
    };

    return { exportRecord, telemetry };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
