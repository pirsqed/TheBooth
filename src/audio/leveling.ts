import { AutoLevelMode, Take } from '../types/project.js';

export interface AutoLevelInput {
  mode: AutoLevelMode;
  workingTakeLufs: number;
  take: Pick<Take, 'durationMs' | 'measuredLufs' | 'measuredRmsDbfs' | 'peakDbfs'>;
}

export interface AutoLevelResult {
  autoGainDb: number;
  source: 'lufs' | 'rms_fallback' | 'off' | 'silent_guard';
  referenceLevelDb: number | null;
  clamped: boolean;
}

const SUB_SECOND_THRESHOLD_MS = 800;
const SILENCE_FLOOR_DBFS = -70;

function clamp(value: number, min: number, max: number): { value: number; clamped: boolean } {
  if (value < min) return { value: min, clamped: true };
  if (value > max) return { value: max, clamped: true };
  return { value, clamped: false };
}

/**
 * Computes Stage-2 non-destructive linear clip-gain leveling from immutable
 * Stage-1 measurements. Never modifies stored takes on disk.
 *
 * Modes (per SPEC.md Section 4 Rule 2):
 * - gentle (default): 50% pull toward workingTakeLufs, clamped to [-6 dB, +4 dB]
 *   (or [-6 dB, +2 dB] on sub-second RMS fallback to protect sighs/breaths).
 * - match: 100% pull toward workingTakeLufs, clamped to [-12 dB, +12 dB]
 *   (or [-12 dB, +4 dB] on sub-second RMS fallback).
 * - off: 0 dB correction.
 */
export function computeAutoLevelGain(input: AutoLevelInput): AutoLevelResult {
  const { mode, workingTakeLufs, take } = input;

  if (mode === 'off') {
    return {
      autoGainDb: 0,
      source: 'off',
      referenceLevelDb: take.measuredLufs,
      clamped: false,
    };
  }

  const useLufs =
    take.measuredLufs !== null &&
    Number.isFinite(take.measuredLufs) &&
    take.measuredLufs > SILENCE_FLOOR_DBFS &&
    take.durationMs >= SUB_SECOND_THRESHOLD_MS;

  const source: 'lufs' | 'rms_fallback' = useLufs ? 'lufs' : 'rms_fallback';
  const referenceLevelDb = useLufs ? take.measuredLufs! : take.measuredRmsDbfs;

  if (!Number.isFinite(referenceLevelDb) || referenceLevelDb <= SILENCE_FLOOR_DBFS) {
    return {
      autoGainDb: 0,
      source: 'silent_guard',
      referenceLevelDb: null,
      clamped: false,
    };
  }

  const rawDelta = workingTakeLufs - referenceLevelDb;

  let targetGain: number;
  let minGain: number;
  let maxGain: number;

  if (mode === 'gentle') {
    targetGain = rawDelta * 0.5;
    minGain = -6;
    maxGain = source === 'rms_fallback' ? 2 : 4;
  } else {
    // match
    targetGain = rawDelta;
    minGain = -12;
    maxGain = source === 'rms_fallback' ? 4 : 12;
  }

  const { value, clamped } = clamp(targetGain, minGain, maxGain);
  return {
    autoGainDb: Number(value.toFixed(2)),
    source,
    referenceLevelDb,
    clamped,
  };
}
