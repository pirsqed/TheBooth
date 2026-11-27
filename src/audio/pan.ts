export interface ConstantPowerGains {
  left: number;
  right: number;
}

/**
 * Constant-power stereo pan law:
 *   theta = (pan + 1) * pi / 4
 *   L = cos(theta), R = sin(theta)
 * Keeps perceived power L^2 + R^2 = 1 constant across [-1, +1].
 */
export function computeConstantPowerGains(pan: number): ConstantPowerGains {
  const clamped = Math.max(-1, Math.min(1, pan));
  const theta = ((clamped + 1) * Math.PI) / 4;
  return {
    left: Math.cos(theta),
    right: Math.sin(theta),
  };
}

export interface PanFilterOptions {
  inputLabel: string;
  outputLabel: string;
  pan: number;
  headphoneCrossfeed: boolean;
  sampleRate: number;
  uid: string;
}

/**
 * Builds an FFmpeg filtergraph segment that converts a mono (or downmixed) stem
 * into stereo using constant-power panning plus optional headphone crossfeed
 * (~15% opposite-ear bleed, 0.25–0.45 ms interaural delay, 4 kHz head-shadow LPF).
 */
export function buildPanFilterSegment(options: PanFilterOptions): string[] {
  const { inputLabel, outputLabel, pan, headphoneCrossfeed, sampleRate, uid } = options;
  const clampedPan = Math.max(-1, Math.min(1, pan));
  const { left, right } = computeConstantPowerGains(clampedPan);
  const absPan = Math.abs(clampedPan);

  const lStr = left.toFixed(6);
  const rStr = right.toFixed(6);

  // Center or crossfeed disabled: pure constant-power pan
  if (!headphoneCrossfeed || absPan <= 0.01) {
    return [
      `[${inputLabel}]aformat=channel_layouts=mono,pan=stereo|c0=${lStr}*c0|c1=${rStr}*c0[${outputLabel}]`,
    ];
  }

  // Headphone crossfeed:
  // Smoothly ramp bleed with pan depth (zero discontinuity near center) and
  // bleed ONLY from the dominant (near) ear into the far ear so the primary
  // ear stays 100% phase-pure with zero comb-filtering.
  const crossfeedRatio = 0.16 * absPan;
  const itdMs = 0.25 + 0.2 * absPan;
  const itdSamples = Math.max(1, Math.round((itdMs / 1000) * sampleRate));

  // Normalize slightly so total energy matches constant-power expectation
  const energyNorm = 1 / Math.sqrt(1 + crossfeedRatio * crossfeedRatio);
  const dirL = (left * energyNorm).toFixed(6);
  const dirR = (right * energyNorm).toFixed(6);
  // Pan < 0 => Left is near ear, bleed into Right (far ear) only
  // Pan > 0 => Right is near ear, bleed into Left (far ear) only
  const xfL = (clampedPan > 0 ? right * crossfeedRatio * energyNorm : 0).toFixed(6);
  const xfR = (clampedPan < 0 ? left * crossfeedRatio * energyNorm : 0).toFixed(6);

  const dirIn = `${uid}_din`;
  const xfIn = `${uid}_xin`;
  const dirOut = `${uid}_dout`;
  const xfOut = `${uid}_xout`;

  return [
    `[${inputLabel}]aformat=channel_layouts=mono,asplit=2[${dirIn}][${xfIn}]`,
    `[${dirIn}]pan=stereo|c0=${dirL}*c0|c1=${dirR}*c0[${dirOut}]`,
    `[${xfIn}]pan=stereo|c0=${xfL}*c0|c1=${xfR}*c0,lowpass=f=4000:poles=1,adelay=${itdSamples}S|${itdSamples}S,asetpts=NB_CONSUMED_SAMPLES/SR/TB[${xfOut}]`,
    `[${dirOut}][${xfOut}]amix=inputs=2:normalize=0:dropout_transition=0,asetpts=NB_CONSUMED_SAMPLES/SR/TB[${outputLabel}]`,
  ];
}
