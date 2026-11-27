import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExportFormat } from '../types/project.js';
import { measureAudioLoudness, probeAudio, runCommand } from './ffmpeg.js';
import { buildRoomToneFilterSegment } from './roomtone.js';

export interface ReelInputEntry {
  label: string;
  id: string;
  audioPath: string;
  meta?: Record<string, unknown>;
}

export interface RenderedReelEntry {
  label: string;
  id: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  appliedGainDb: number;
  meta?: Record<string, unknown>;
}

export interface RenderComparisonReelOptions {
  entries: ReelInputEntry[];
  outputPath: string;
  format?: ExportFormat;
  /** Target loudness in LUFS for loudness-matched A/B comparison (default: -20) */
  targetLufs?: number;
  /** Whether to match each variant's loudness to targetLufs (default: true) */
  loudnessMatch?: boolean;
  /** Pause gap between labeled entries in ms (default: 700) */
  gapMs?: number;
  /** Soft musical cue-pip count matching entry index (1 pip = A, 2 pips = B, etc.; default: true) */
  includeCuePips?: boolean;
  sampleRate?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
}

export interface RenderComparisonReelResult {
  outputPath: string;
  format: ExportFormat;
  durationSec: number;
  entries: RenderedReelEntry[];
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

export function indexToReelLabel(index: number): string {
  // 0 -> "A", 1 -> "B", ..., 25 -> "Z", 26 -> "AA"
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Stitches 2+ labeled audio variants ("A", "B", ...) into a single loudness-matched,
 * warm-room-tone stereo A/B comparison reel with gentle musical cue pips (1 pip = A, 2 pips = B...)
 * so humans and agents on any MCP host can compare casting auditions or in-context retakes effortlessly.
 */
export async function renderComparisonReel(
  options: RenderComparisonReelOptions,
): Promise<RenderComparisonReelResult> {
  if (options.entries.length === 0) {
    throw new Error('renderComparisonReel requires at least one entry');
  }

  const format: ExportFormat = options.format ?? 'ogg';
  const sampleRate = options.sampleRate ?? 48000;
  const targetLufs = options.targetLufs ?? -20;
  const loudnessMatch = options.loudnessMatch !== false;
  const gapMs = Math.max(200, Math.round(options.gapMs ?? 700));
  const includeCuePips = options.includeCuePips !== false;
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';

  // Probe durations and loudness of each variant in parallel
  const measured = await Promise.all(
    options.entries.map(async (entry) => {
      const [probe, loudness] = await Promise.all([
        probeAudio(entry.audioPath, ffprobePath),
        loudnessMatch ? measureAudioLoudness(entry.audioPath, ffmpegPath) : Promise.resolve(null),
      ]);
      let gainDb = 0;
      if (loudnessMatch && loudness) {
        const ref =
          loudness.measuredLufs !== null && probe.durationMs >= 800
            ? loudness.measuredLufs
            : loudness.measuredRmsDbfs;
        if (Number.isFinite(ref) && ref > -70) {
          gainDb = Math.max(-12, Math.min(12, targetLufs - ref));
        }
      }
      return {
        entry,
        durationMs: Math.max(100, probe.durationMs),
        gainDb: Number(gainDb.toFixed(2)),
      };
    }),
  );

  // Build timeline: lead-in -> [pip(s) + 220ms air + clip] -> gap -> next... -> tail
  const leadMs = 300;
  const pipDurMs = 85;
  const pipStepMs = 155;
  const postPipAirMs = 240;
  const tailMs = 900;

  let cursorMs = leadMs;
  const scheduled: Array<{
    inputIdx: number;
    entry: ReelInputEntry;
    gainDb: number;
    pipStartsMs: number[];
    clipStartMs: number;
    clipEndMs: number;
    durationMs: number;
  }> = [];

  for (let i = 0; i < measured.length; i++) {
    const m = measured[i]!;
    const pipCount = includeCuePips ? Math.min(4, i + 1) : 0;
    const pipStartsMs: number[] = [];
    for (let p = 0; p < pipCount; p++) {
      pipStartsMs.push(cursorMs + p * pipStepMs);
    }
    const pipBlockMs = pipCount > 0 ? (pipCount - 1) * pipStepMs + pipDurMs + postPipAirMs : 0;
    const clipStartMs = cursorMs + pipBlockMs;
    const clipEndMs = clipStartMs + m.durationMs;

    scheduled.push({
      inputIdx: i,
      entry: m.entry,
      gainDb: m.gainDb,
      pipStartsMs,
      clipStartMs,
      clipEndMs,
      durationMs: m.durationMs,
    });

    cursorMs = clipEndMs + gapMs;
  }

  const totalDurationMs = (scheduled[scheduled.length - 1]?.clipEndMs ?? 1000) + tailMs;
  const totalSec = (totalDurationMs / 1000).toFixed(4);

  const inputArgs: string[] = [];
  const filterLines: string[] = [];
  const mixLabels: string[] = [];

  // Continuous warm_dark room tone bed so A/B gaps never cut to digital vacuum
  filterLines.push(
    ...buildRoomToneFilterSegment({
      style: 'warm_dark',
      durationMs: totalDurationMs,
      sampleRate,
      gainDb: -54,
      fadeInMs: 250,
      fadeOutMs: 600,
      outputLabel: 'rt_bed',
      uid: 'reel',
    }),
  );
  mixLabels.push('[rt_bed]');

  // Soft studio cue pips (gentle sine bells, -20 dBFS, 587 Hz / 659 Hz)
  let pipUid = 0;
  for (let i = 0; i < scheduled.length; i++) {
    const item = scheduled[i]!;
    const freqHz = i % 2 === 0 ? 587.33 : 659.25; // D5 / E5 warm gentle marker
    for (const startMs of item.pipStartsMs) {
      const lbl = `pip_${pipUid++}`;
      const durStr = (pipDurMs / 1000).toFixed(4);
      filterLines.push(
        `sine=f=${freqHz}:r=${sampleRate}:d=${durStr},aformat=channel_layouts=stereo,volume=-20dB,afade=t=in:st=0:d=0.015:curve=qsin,afade=t=out:st=0.050:d=0.035:curve=qsin,adelay=${startMs}|${startMs}[${lbl}]`,
      );
      mixLabels.push(`[${lbl}]`);
    }
  }

  // Loudness-matched variant clips
  for (let i = 0; i < scheduled.length; i++) {
    const item = scheduled[i]!;
    inputArgs.push('-i', item.entry.audioPath);
    const lbl = `clip_${i}`;
    const durS = Math.max(0.05, item.durationMs / 1000);
    const fadeOutSt = Math.max(0, durS - 0.025).toFixed(4);
    const chain = [
      `aresample=${sampleRate}`,
      'aformat=channel_layouts=stereo',
      ...(Math.abs(item.gainDb) > 0.05 ? [`volume=${item.gainDb.toFixed(2)}dB`] : []),
      'afade=t=in:st=0:d=0.015:curve=qsin',
      `afade=t=out:st=${fadeOutSt}:d=0.025:curve=qsin`,
      ...(item.clipStartMs > 0 ? [`adelay=${item.clipStartMs}|${item.clipStartMs}`] : []),
    ];
    filterLines.push(`[${item.inputIdx}:a]${chain.join(',')}[${lbl}]`);
    mixLabels.push(`[${lbl}]`);
  }

  const limiterCeiling = Math.pow(10, -1.5 / 20).toFixed(6);
  filterLines.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:normalize=0:dropout_transition=0,apad=whole_dur=${totalSec},atrim=0:${totalSec},alimiter=limit=${limiterCeiling}:attack=5:release=50:level=disabled[reel_out]`,
  );

  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thebooth-reel-'));
  try {
    const scriptPath = path.join(tempDir, 'reel.ffscript');
    await fs.writeFile(scriptPath, filterLines.join(';\n'), 'utf8');
    await runCommand(ffmpegPath, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs,
      '-filter_complex_script',
      scriptPath,
      '-map',
      '[reel_out]',
      '-map_metadata',
      '-1',
      ...buildCodecArgs(format, sampleRate),
      options.outputPath,
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    outputPath: options.outputPath,
    format,
    durationSec: Number((totalDurationMs / 1000).toFixed(3)),
    entries: scheduled.map((s) => ({
      label: s.entry.label,
      id: s.entry.id,
      startSec: Number((s.clipStartMs / 1000).toFixed(3)),
      endSec: Number((s.clipEndMs / 1000).toFixed(3)),
      durationSec: Number((s.durationMs / 1000).toFixed(3)),
      appliedGainDb: s.gainDb,
      ...(s.entry.meta ? { meta: s.entry.meta } : {}),
    })),
  };
}
