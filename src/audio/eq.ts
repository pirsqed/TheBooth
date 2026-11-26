import { EqPreset } from '../types/project.js';

/**
 * Curated spoken-word EQ preset chains for Stage-2 FFmpeg processing.
 */
const EQ_PRESET_FILTERS: Record<EqPreset, string> = {
  // Clean 70 Hz HPF only (removes sub-rumble without coloring voice)
  neutral: 'highpass=f=70:poles=2',

  // Warm close-mic proximity lift + gentle de-harsh + soft air
  intimate:
    'highpass=f=75:poles=2,equalizer=f=180:t=q:w=1.1:g=2.5,equalizer=f=3200:t=q:w=1.8:g=-2.0,highshelf=f=9500:g=1.5',

  // Velvety low-pass rolloff + gentle de-ess & soft compression
  whisper:
    'highpass=f=100:poles=2,equalizer=f=6500:t=q:w=2.0:g=-3.5,lowpass=f=8500:poles=2,acompressor=threshold=-24dB:ratio=2.2:attack=15:release=140:makeup=1',

  // 300–3400 Hz narrowband telephone filter
  phone:
    'highpass=f=300:poles=2,lowpass=f=3400:poles=2,equalizer=f=1400:t=q:w=1.2:g=3.0',

  // Band-limited comms + subtle grit
  radio:
    'highpass=f=280:poles=2,lowpass=f=3800:poles=2,equalizer=f=1800:t=q:w=1.4:g=3.5,acrusher=bits=11:mode=log:aa=1:mix=0.2',

  // High-frequency rolloff + gentle attenuation
  distant:
    'highpass=f=120:poles=2,lowpass=f=4500:poles=2,volume=-3dB',
};

export function buildEqFilter(preset: EqPreset): string {
  return EQ_PRESET_FILTERS[preset];
}
