import { RoomToneStyle } from '../types/project.js';

export interface RoomToneFilterOptions {
  style: RoomToneStyle;
  durationMs: number;
  sampleRate: number;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  outputLabel: string;
  uid: string;
}

/**
 * Generates a deterministic, subtle stereo room-tone floor using two
 * decorrelated seeded noise generators shaped below ~3 kHz so pauses never
 * drop into unnatural -inf dBFS digital silence.
 *
 * Calibrated so `gainDb` reflects approximate output RMS dBFS (e.g. -54 dB -> ~ -54 dBFS).
 */
export function buildRoomToneFilterSegment(options: RoomToneFilterOptions): string[] {
  const {
    style,
    durationMs,
    sampleRate,
    gainDb,
    fadeInMs,
    fadeOutMs,
    outputLabel,
    uid,
  } = options;

  const durationSec = Math.max(0.1, durationMs / 1000);
  const durationStr = durationSec.toFixed(3);

  // Calibrated compensation for anoisesrc + spectral shaping RMS offset
  // so that setting gainDb = -54 lands close to -54 dBFS measured RMS.
  const isWarmDark = style === 'warm_dark';
  const color = isWarmDark ? 'brown' : 'pink';
  const calibrationDb = isWarmDark ? 20 : 14;
  const effectiveGainDb = Math.min(0, gainDb + calibrationDb);

  const shapingFilter = isWarmDark
    ? 'highpass=f=35:poles=1,lowpass=f=2400:poles=2,equalizer=f=160:t=q:w=0.8:g=2'
    : 'highpass=f=45:poles=1,lowpass=f=3200:poles=2';

  const fadeInSec = Math.min(durationSec / 2, Math.max(0, fadeInMs / 1000));
  const fadeOutSec = Math.min(durationSec / 2, Math.max(0, fadeOutMs / 1000));
  const fadeOutStartSec = Math.max(0, durationSec - fadeOutSec);

  const fades: string[] = [];
  if (fadeInSec > 0) {
    fades.push(`afade=t=in:st=0:d=${fadeInSec.toFixed(3)}:curve=qsin`);
  }
  if (fadeOutSec > 0) {
    fades.push(
      `afade=t=out:st=${fadeOutStartSec.toFixed(3)}:d=${fadeOutSec.toFixed(3)}:curve=qsin`,
    );
  }

  const leftLbl = `${uid}_rtl`;
  const rightLbl = `${uid}_rtr`;
  const postChain = [
    shapingFilter,
    `volume=${effectiveGainDb.toFixed(2)}dB`,
    ...fades,
  ].join(',');

  return [
    `anoisesrc=d=${durationStr}:c=${color}:r=${sampleRate}:a=1.0:s=104729[${leftLbl}]`,
    `anoisesrc=d=${durationStr}:c=${color}:r=${sampleRate}:a=1.0:s=104743[${rightLbl}]`,
    `[${leftLbl}][${rightLbl}]amerge=inputs=2,aformat=sample_rates=${sampleRate}:channel_layouts=stereo,${postChain}[${outputLabel}]`,
  ];
}
