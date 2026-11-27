import { spawn } from 'node:child_process';
import * as zlib from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';
import { FfmpegError, probeAudio } from './ffmpeg.js';

export type VisualPreset = 'master' | 'fast';
export type VisualMode = 'zoom' | 'overview';
export type VisualPanel = 'cues' | 'waveform' | 'rms' | 'spectrogram';

export const ZOOM_MAX_SPAN_SEC = 45;
export const MIN_SURGICAL_PX_PER_SEC = 30;
const DSP_SAMPLE_RATE = 48000;
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;

export interface VisualCueBlock {
  id: string;
  speaker: string;
  startSec: number;
  endSec: number;
  plannedPan: number;
  gainDb?: number;
}

export interface VisualSfxBlock {
  id: string;
  label: string;
  startSec: number;
  endSec: number;
  pan: number;
  gainDb?: number;
}

export interface RenderVisualOptions {
  audioPath: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** 'master' (default 4-panel annotated stack) or 'fast' (pure FFmpeg showwavespic + showspectrumpic) */
  preset?: VisualPreset;
  /** 'zoom' (<= 45s, >= 30 px/s) or 'overview' (macro arcs + broadband click scan on 180s+ tracks) */
  mode?: VisualMode;
  startSec?: number;
  endSec?: number;
  /** Custom subset of panels for preset='master' */
  panels?: VisualPanel[];
  /** Timeline cue spans for DAW Cue Overlay (Panel 1) */
  cueBlocks?: VisualCueBlock[];
  /** Timeline SFX spans for the dedicated SFX lane in DAW Cue Overlay (Panel 1) */
  sfxBlocks?: VisualSfxBlock[];
  /** Neutral or descriptive chart title */
  title?: string;
  width?: number;
  height?: number;
}

export interface RenderVisualResult {
  pngBuffer: Buffer;
  width: number;
  height: number;
  preset: VisualPreset;
  mode: VisualMode;
  panels: VisualPanel[];
  totalDurationSec: number;
  startSec: number;
  endSec: number;
  windowDurationSec: number;
  pxPerSec: number;
  channels: number;
  sampleRate: number;
  warnings: string[];
}

export class VisualValidationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'VisualValidationError';
  }
}

// ---------------------------------------------------------------------------
// Binary FFmpeg Runner (stdout Buffer)
// ---------------------------------------------------------------------------

function runFfmpegBinary(binary: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    child.on('error', (err) => {
      reject(new Error(`Failed to execute "${binary}": ${err.message}`));
    });
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8');
        reject(
          new FfmpegError(
            `${binary} exited with code ${exitCode}: ${stderr.slice(-800)}`,
            stderr,
            exitCode,
          ),
        );
        return;
      }
      resolve(Buffer.concat(outChunks));
    });
  });
}

async function decodeSliceStereo48k(
  audioPath: string,
  startSec: number,
  durationSec: number,
  ffmpegPath: string,
): Promise<{ left: Float32Array; right: Float32Array }> {
  const raw = await runFfmpegBinary(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    startSec.toFixed(4),
    '-t',
    durationSec.toFixed(4),
    '-i',
    audioPath,
    '-ar',
    String(DSP_SAMPLE_RATE),
    '-ac',
    '2',
    '-f',
    'f32le',
    'pipe:1',
  ]);

  const totalFloats = Math.floor(raw.byteLength / 4);
  const frames = Math.floor(totalFloats / 2);
  const view = new Float32Array(raw.buffer, raw.byteOffset, frames * 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = view[i * 2]!;
    right[i] = view[i * 2 + 1]!;
  }
  return { left, right };
}

// ---------------------------------------------------------------------------
// Pure-TS Radix-2 FFT + Log-Mel Spectrogram + Minimal PNG Encoder
// ---------------------------------------------------------------------------

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  // Cooley-Tukey butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepRe = Math.cos(angle);
    const wStepIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j]!;
        const uIm = im[i + j]!;
        const vRe = re[i + j + half]! * wRe - im[i + j + half]! * wIm;
        const vIm = re[i + j + half]! * wIm + im[i + j + half]! * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        wIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
      }
    }
  }
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

interface MelFilterbank {
  nMels: number;
  melHz: Float64Array;
  /** Sparse per-band non-zero bin weights for ultra-fast matrix multiply */
  bands: Array<Array<{ bin: number; weight: number }>>;
}

let cachedFilterbank: MelFilterbank | null = null;

function getMelFilterbank(): MelFilterbank {
  if (cachedFilterbank) return cachedFilterbank;
  const nFft = 1024;
  const nBins = nFft / 2 + 1;
  const nMels = 128;
  const fMin = 50;
  const fMax = 16000;

  const freqs = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) {
    freqs[k] = (k * DSP_SAMPLE_RATE) / nFft;
  }

  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);
  const hzPts = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    const mel = melMin + ((melMax - melMin) * i) / (nMels + 1);
    hzPts[i] = melToHz(mel);
  }

  const melHz = new Float64Array(nMels);
  const bands: Array<Array<{ bin: number; weight: number }>> = [];

  for (let m = 0; m < nMels; m++) {
    const fLeft = hzPts[m]!;
    const fCenter = hzPts[m + 1]!;
    const fRight = hzPts[m + 2]!;
    melHz[m] = fCenter;

    const entries: Array<{ bin: number; weight: number }> = [];
    let sum = 0;
    for (let k = 0; k < nBins; k++) {
      const f = freqs[k]!;
      const up = (f - fLeft) / Math.max(fCenter - fLeft, 1e-9);
      const down = (fRight - f) / Math.max(fRight - fCenter, 1e-9);
      const w = Math.max(0, Math.min(up, down));
      if (w > 0) {
        entries.push({ bin: k, weight: w });
        sum += w;
      }
    }

    if (sum > 0) {
      for (const e of entries) e.weight /= sum;
    } else {
      // Low-frequency Mel band fell strictly between two FFT bins: linearly interpolate brackets
      let hi = 1;
      while (hi < nBins - 1 && freqs[hi]! < fCenter) hi++;
      const lo = hi - 1;
      const alpha = (fCenter - freqs[lo]!) / Math.max(freqs[hi]! - freqs[lo]!, 1e-9);
      entries.push({ bin: lo, weight: 1 - alpha });
      entries.push({ bin: hi, weight: alpha });
    }
    bands.push(entries);
  }

  cachedFilterbank = { nMels, melHz, bands };
  return cachedFilterbank;
}

// Perceptually uniform Matplotlib "magma" keyframe stops (0..1)
const MAGMA_STOPS: Array<[number, number, number, number]> = [
  [0.0, 0, 0, 4],
  [0.125, 28, 16, 68],
  [0.25, 79, 18, 123],
  [0.375, 129, 37, 129],
  [0.5, 181, 54, 122],
  [0.625, 229, 80, 100],
  [0.75, 251, 135, 97],
  [0.875, 254, 194, 135],
  [1.0, 252, 253, 191],
];

const MAGMA_LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
  const t = i / 255;
  let idx = 0;
  while (idx < MAGMA_STOPS.length - 2 && t > MAGMA_STOPS[idx + 1]![0]) idx++;
  const a = MAGMA_STOPS[idx]!;
  const b = MAGMA_STOPS[idx + 1]!;
  const f = (t - a[0]) / Math.max(b[0] - a[0], 1e-9);
  MAGMA_LUT[i * 3] = Math.round(a[1] + (b[1] - a[1]) * f);
  MAGMA_LUT[i * 3 + 1] = Math.round(a[2] + (b[2] - a[2]) * f);
  MAGMA_LUT[i * 3 + 2] = Math.round(a[3] + (b[3] - a[3]) * f);
}

// CRC32 table for minimal zero-dep PNG encoder
const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodeRgbPng(width: number, height: number, rgb: Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 2; // RGB color type
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0; // filter type None
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), dst + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderLogMelSpectrogramPng(
  left: Float32Array,
  right: Float32Array,
  targetCols: number,
): { pngBase64: string; melHz: Float64Array; nMels: number } {
  const nSamples = left.length;
  const nFft = 1024;
  const halfFft = nFft / 2;
  const nBins = halfFft + 1;
  const fb = getMelFilterbank();

  const hann = new Float64Array(nFft);
  let winSum = 0;
  for (let i = 0; i < nFft; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (nFft - 1)));
    hann[i] = w;
    winSum += w;
  }
  const winNorm = winSum / 2;

  const cols = Math.max(64, Math.min(targetCols, Math.max(64, Math.ceil(nSamples / 128))));
  const rgb = new Uint8Array(cols * fb.nMels * 3);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  const power = new Float64Array(nBins);

  // Peak-preserving STFT columns: for windows > ~15s where multiple hops fall in one column,
  // evaluate up to 3 sub-frames per pixel column and take the max per Mel band so 2-3ms clicks
  // NEVER vanish between hop samples!
  const samplesPerCol = nSamples / cols;
  const subSteps = samplesPerCol > nFft ? Math.min(4, Math.ceil(samplesPerCol / (nFft * 0.5))) : 1;
  const colMelMax = new Float64Array(fb.nMels);

  for (let col = 0; col < cols; col++) {
    colMelMax.fill(1e-12);
    const colStart = col * samplesPerCol;

    for (let s = 0; s < subSteps; s++) {
      const center = Math.floor(colStart + ((s + 0.5) * samplesPerCol) / subSteps);
      const start = center - halfFft;
      for (let i = 0; i < nFft; i++) {
        const idx = start + i;
        if (idx >= 0 && idx < nSamples) {
          const mono = 0.5 * (left[idx]! + right[idx]!);
          re[i] = mono * hann[i]!;
        } else {
          re[i] = 0;
        }
        im[i] = 0;
      }

      fftInPlace(re, im);
      const invNormSq = 1 / (winNorm * winNorm);
      for (let k = 0; k < nBins; k++) {
        power[k] = (re[k]! * re[k]! + im[k]! * im[k]!) * invNormSq;
      }

      for (let m = 0; m < fb.nMels; m++) {
        let p = 0;
        const band = fb.bands[m]!;
        for (let b = 0; b < band.length; b++) {
          const entry = band[b]!;
          p += power[entry.bin]! * entry.weight;
        }
        if (p > colMelMax[m]!) colMelMax[m] = p;
      }
    }

    for (let m = 0; m < fb.nMels; m++) {
      const db = 10 * Math.log10(Math.max(colMelMax[m]!, 1e-12));
      const norm = Math.max(0, Math.min(1, (db - -80) / 80));
      const lutIdx = Math.round(norm * 255) * 3;
      // Row 0 in PNG is top (highest frequency = nMels - 1)
      const y = fb.nMels - 1 - m;
      const dst = (y * cols + col) * 3;
      rgb[dst] = MAGMA_LUT[lutIdx]!;
      rgb[dst + 1] = MAGMA_LUT[lutIdx + 1]!;
      rgb[dst + 2] = MAGMA_LUT[lutIdx + 2]!;
    }
  }

  const png = encodeRgbPng(cols, fb.nMels, rgb);
  return { pngBase64: png.toString('base64'), melHz: fb.melHz, nMels: fb.nMels };
}

// ---------------------------------------------------------------------------
// Waveform & 300ms RMS Envelope Computation
// ---------------------------------------------------------------------------

function computePeakEnvelope(
  samples: Float32Array,
  nBins: number,
): { mins: Float32Array; maxs: Float32Array } {
  const n = samples.length;
  const mins = new Float32Array(nBins);
  const maxs = new Float32Array(nBins);
  if (n === 0) return { mins, maxs };

  for (let i = 0; i < nBins; i++) {
    const a = Math.floor((i * n) / nBins);
    const b = Math.max(a + 1, Math.min(n, Math.floor(((i + 1) * n) / nBins)));
    let lo = 0;
    let hi = 0;
    for (let k = a; k < b; k++) {
      const v = samples[k]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mins[i] = lo;
    maxs[i] = hi;
  }
  return { mins, maxs };
}

interface RmsSeries {
  timesSec: Float64Array;
  leftDb: Float64Array;
  rightDb: Float64Array;
  combinedDb: Float64Array;
}

function computeShortTermRms(
  left: Float32Array,
  right: Float32Array,
  startSec: number,
  windowDurationSec: number,
): RmsSeries {
  const n = left.length;
  const winSamples = Math.max(1, Math.round(0.3 * DSP_SAMPLE_RATE)); // 300 ms
  const halfWin = winSamples >> 1;

  // Prefix sums of squared samples for O(N) exact 300ms sliding RMS even on 180s audio!
  const prefL = new Float64Array(n + 1);
  const prefR = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const l = left[i]!;
    const r = right[i]!;
    prefL[i + 1] = prefL[i]! + l * l;
    prefR[i + 1] = prefR[i]! + r * r;
  }

  const nPoints = Math.min(700, Math.max(120, Math.round(windowDurationSec / 0.02)));
  const timesSec = new Float64Array(nPoints);
  const leftDb = new Float64Array(nPoints);
  const rightDb = new Float64Array(nPoints);
  const combinedDb = new Float64Array(nPoints);

  for (let i = 0; i < nPoints; i++) {
    const frac = nPoints > 1 ? i / (nPoints - 1) : 0;
    timesSec[i] = startSec + frac * windowDurationSec;
    const center = Math.min(n - 1, Math.round(frac * Math.max(0, n - 1)));
    const a = Math.max(0, center - halfWin);
    const b = Math.min(n, center + halfWin);
    const count = Math.max(1, b - a);
    const eL = (prefL[b]! - prefL[a]!) / count;
    const eR = (prefR[b]! - prefR[a]!) / count;
    const eC = 0.5 * (eL + eR);
    leftDb[i] = 10 * Math.log10(Math.max(eL, 1e-12));
    rightDb[i] = 10 * Math.log10(Math.max(eR, 1e-12));
    combinedDb[i] = 10 * Math.log10(Math.max(eC, 1e-12));
  }

  return { timesSec, leftDb, rightDb, combinedDb };
}

// ---------------------------------------------------------------------------
// SVG Chart Composer (4-Panel Master View, 1600x900)
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function chooseMajorTimeStep(spanSec: number): { major: number; minor: number } {
  if (spanSec <= 6) return { major: 0.5, minor: 0.1 };
  if (spanSec <= 16) return { major: 1.0, minor: 0.2 };
  if (spanSec <= 35) return { major: 2.0, minor: 0.5 };
  if (spanSec <= 60) return { major: 5.0, minor: 1.0 };
  if (spanSec <= 120) return { major: 10.0, minor: 2.0 };
  return { major: 15.0, minor: 5.0 };
}

function formatTimeTick(t: number, majorStep: number): string {
  if (majorStep < 1) return `${t.toFixed(1)}s`;
  return `${Math.round(t)}s`;
}

function buildWaveformPath(
  mins: Float32Array,
  maxs: Float32Array,
  x0: number,
  plotW: number,
  y0: number,
  h: number,
): string {
  const n = mins.length;
  if (n === 0) return '';
  const cy = y0 + h / 2;
  const halfH = h * 0.47;
  const parts: string[] = [];

  for (let i = 0; i < n; i++) {
    const x = x0 + ((i + 0.5) / n) * plotW;
    const yTop = cy - Math.max(-1, Math.min(1, maxs[i]!)) * halfH;
    parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yTop.toFixed(1)}`);
  }
  for (let i = n - 1; i >= 0; i--) {
    const x = x0 + ((i + 0.5) / n) * plotW;
    const yBot = cy - Math.max(-1, Math.min(1, mins[i]!)) * halfH;
    parts.push(`L${x.toFixed(1)},${yBot.toFixed(1)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

function buildRmsPolyline(
  times: Float64Array,
  valsDb: Float64Array,
  startSec: number,
  spanSec: number,
  x0: number,
  plotW: number,
  y0: number,
  h: number,
): string {
  const pts: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const x = x0 + ((times[i]! - startSec) / spanSec) * plotW;
    const clamped = Math.max(-48, Math.min(0, valsDb[i]!));
    const y = y0 + ((0 - clamped) / 48) * h;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(' ');
}

function renderMasterSvgToPng(params: {
  left: Float32Array;
  right: Float32Array;
  startSec: number;
  endSec: number;
  panels: VisualPanel[];
  cueBlocks: VisualCueBlock[];
  sfxBlocks: VisualSfxBlock[];
  title: string;
  width: number;
  height: number;
}): { pngBuffer: Buffer; plotW: number } {
  const { left, right, startSec, endSec, panels, cueBlocks, sfxBlocks, title, width, height } = params;
  const spanSec = Math.max(0.05, endSec - startSec);
  const hasSfxLane = sfxBlocks.length > 0;

  const marginLeft = 104;
  const marginRight =
    panels.includes('spectrogram') || panels.includes('rms') ? 108 : 36;
  const marginTop = 52;
  const marginBottom = 56;
  const plotX = marginLeft;
  const plotW = width - marginLeft - marginRight;
  const availH = height - marginTop - marginBottom;

  // Allocate vertical heights proportionally by enabled panels
  const weights: Record<VisualPanel, number> = {
    cues: hasSfxLane ? 15 : 11,
    waveform: 26,
    rms: 20,
    spectrogram: 43,
  };
  const gapPx = 12;
  const totalGaps = Math.max(0, panels.length - 1) * gapPx;
  const totalWeight = panels.reduce((acc, p) => acc + weights[p], 0);

  const layout = new Map<VisualPanel, { y: number; h: number }>();
  let curY = marginTop;
  for (const p of panels) {
    const h = Math.round(((availH - totalGaps) * weights[p]) / totalWeight);
    layout.set(p, { y: curY, h });
    curY += h + gapPx;
  }

  const { major: majorStep, minor: minorStep } = chooseMajorTimeStep(spanSec);
  const firstMinor = Math.ceil(startSec / minorStep) * minorStep;
  const firstMajor = Math.ceil(startSec / majorStep) * majorStep;

  const svg: string[] = [];
  svg.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  svg.push('<defs>');
  // Magma vertical colorbar gradient
  svg.push('<linearGradient id="magmaGrad" x1="0" y1="1" x2="0" y2="0">');
  for (const [stop, r, g, b] of MAGMA_STOPS) {
    svg.push(`<stop offset="${(stop * 100).toFixed(1)}%" stop-color="rgb(${r},${g},${b})"/>`);
  }
  svg.push('</linearGradient>');
  // Clip paths for each panel
  for (const p of panels) {
    const box = layout.get(p)!;
    svg.push(
      `<clipPath id="clip_${p}"><rect x="${plotX}" y="${box.y}" width="${plotW}" height="${box.h}"/></clipPath>`,
    );
  }
  svg.push('</defs>');

  // Canvas background
  svg.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#0d1117"/>`);

  // Header title
  svg.push(
    `<text x="${(width / 2).toFixed(1)}" y="33" text-anchor="middle" fill="#e6edf3" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="700">${escapeXml(title)}</text>`,
  );

  const timeToX = (t: number) => plotX + ((t - startSec) / spanSec) * plotW;

  const pushTimeGrid = (y: number, h: number, lightOverlay = false) => {
    const minorCol = lightOverlay ? 'rgba(255,255,255,0.08)' : '#1d2530';
    const majorCol = lightOverlay ? 'rgba(255,255,255,0.18)' : '#2e3948';
    for (let t = firstMinor; t <= endSec + 1e-6; t += minorStep) {
      const x = timeToX(t);
      if (x < plotX - 0.5 || x > plotX + plotW + 0.5) continue;
      svg.push(
        `<line x1="${x.toFixed(1)}" y1="${y}" x2="${x.toFixed(1)}" y2="${y + h}" stroke="${minorCol}" stroke-width="0.6"/>`,
      );
    }
    for (let t = firstMajor; t <= endSec + 1e-6; t += majorStep) {
      const x = timeToX(t);
      if (x < plotX - 0.5 || x > plotX + plotW + 0.5) continue;
      svg.push(
        `<line x1="${x.toFixed(1)}" y1="${y}" x2="${x.toFixed(1)}" y2="${y + h}" stroke="${majorCol}" stroke-width="1"/>`,
      );
    }
  };

  // --- Panel 1: DAW Cue-Block & SFX Overlay Track (A2) ---
  const cuesBox = layout.get('cues');
  if (cuesBox) {
    svg.push(
      `<rect x="${plotX}" y="${cuesBox.y}" width="${plotW}" height="${cuesBox.h}" fill="#11161f" stroke="#3b4758" stroke-width="1"/>`,
    );
    pushTimeGrid(cuesBox.y, cuesBox.h);

    const visibleCues = cueBlocks.filter((c) => c.endSec > startSec && c.startSec < endSec);
    const visibleSfx = sfxBlocks.filter((s) => s.endSec > startSec && s.startSec < endSec);
    const laneCount = hasSfxLane ? 3 : 2;
    const laneH = Math.max(16, Math.floor((cuesBox.h - (laneCount === 3 ? 20 : 14)) / laneCount));
    const laneTops =
      laneCount === 3
        ? [cuesBox.y + 4, cuesBox.y + 4 + laneH + 4, cuesBox.y + 4 + (laneH + 4) * 2 + 2]
        : [cuesBox.y + 5, cuesBox.y + 5 + laneH + 4];

    svg.push(
      `<text x="${plotX - 10}" y="${laneTops[0]! + laneH / 2 + 4}" text-anchor="end" fill="#9ba7b4" font-family="Arial, sans-serif" font-size="11">Lane A</text>`,
    );
    svg.push(
      `<text x="${plotX - 10}" y="${laneTops[1]! + laneH / 2 + 4}" text-anchor="end" fill="#9ba7b4" font-family="Arial, sans-serif" font-size="11">Lane B</text>`,
    );
    if (hasSfxLane) {
      const dividerY = laneTops[2]! - 3;
      svg.push(
        `<line x1="${plotX}" y1="${dividerY}" x2="${plotX + plotW}" y2="${dividerY}" stroke="#2a3444" stroke-width="1"/>`,
      );
      svg.push(
        `<text x="${plotX - 10}" y="${laneTops[2]! + laneH / 2 + 4}" text-anchor="end" fill="#34d399" font-family="Arial, sans-serif" font-size="11" font-weight="700">SFX</text>`,
      );
    }
    svg.push(
      `<text x="20" y="${(cuesBox.y + cuesBox.h / 2).toFixed(1)}" text-anchor="middle" fill="#e6edf3" font-family="Arial, sans-serif" font-size="12" font-weight="700" transform="rotate(-90 20 ${(cuesBox.y + cuesBox.h / 2).toFixed(1)})">${hasSfxLane ? 'DAW + SFX' : 'DAW Cues'}</text>`,
    );

    svg.push('<g clip-path="url(#clip_cues)">');
    for (let i = 0; i < visibleCues.length; i++) {
      const c = visibleCues[i]!;
      const laneIdx = i % 2;
      const x1 = timeToX(Math.max(startSec, c.startSec));
      const x2 = timeToX(Math.min(endSec, c.endSec));
      const bw = Math.max(4, x2 - x1);
      const isRight = c.plannedPan > 0.05;
      const isCenter = Math.abs(c.plannedPan) <= 0.05;
      const fillCol = isCenter ? '#94a3b8' : isRight ? '#fbbf24' : '#38bdf8';
      const panTag = isCenter
        ? 'C'
        : `${c.plannedPan > 0 ? '+' : ''}${c.plannedPan.toFixed(2)}`;

      svg.push(
        `<rect x="${x1.toFixed(1)}" y="${laneTops[laneIdx]}" width="${bw.toFixed(1)}" height="${laneH}" rx="4" fill="${fillCol}" fill-opacity="0.32" stroke="#f8fafc" stroke-opacity="0.85" stroke-width="1.2"/>`,
      );
      if (bw >= 44) {
        const label =
          bw >= 175
            ? `${c.id} [${c.speaker}] pan=${panTag} (${c.startSec.toFixed(2)}-${c.endSec.toFixed(2)}s)`
            : bw >= 95
              ? `${c.id} [${c.speaker}] ${panTag}`
              : c.id;
        svg.push(
          `<text x="${(x1 + 6).toFixed(1)}" y="${(laneTops[laneIdx]! + laneH / 2 + 4).toFixed(1)}" fill="#f8fafc" font-family="Arial, sans-serif" font-size="11" font-weight="700">${escapeXml(label)}</text>`,
        );
      }
    }

    if (hasSfxLane) {
      const sfxY = laneTops[2]!;
      for (const s of visibleSfx) {
        const x1 = timeToX(Math.max(startSec, s.startSec));
        const x2 = timeToX(Math.min(endSec, s.endSec));
        const bw = Math.max(5, x2 - x1);
        const isCenter = Math.abs(s.pan) <= 0.05;
        const panTag = isCenter ? 'C' : `${s.pan > 0 ? '+' : ''}${s.pan.toFixed(2)}`;
        const shortLbl = s.label.length > 20 ? `${s.label.slice(0, 19)}…` : s.label;

        svg.push(
          `<rect x="${x1.toFixed(1)}" y="${sfxY}" width="${bw.toFixed(1)}" height="${laneH}" rx="3" fill="#34d399" fill-opacity="0.34" stroke="#6ee7b7" stroke-opacity="0.92" stroke-width="1.2"/>`,
        );
        if (bw >= 36) {
          const label =
            bw >= 185
              ? `${s.id} [${shortLbl}] pan=${panTag} (${s.startSec.toFixed(2)}-${s.endSec.toFixed(2)}s)`
              : bw >= 95
                ? `${s.id} [${shortLbl}] ${panTag}`
                : s.id;
          svg.push(
            `<text x="${(x1 + 5).toFixed(1)}" y="${(sfxY + laneH / 2 + 4).toFixed(1)}" fill="#ecfdf5" font-family="Arial, sans-serif" font-size="10.5" font-weight="700">${escapeXml(label)}</text>`,
          );
        }
      }
    }
    svg.push('</g>');
  }

  // --- Panel 2: Split L / R Waveforms (S1) ---
  const waveBox = layout.get('waveform');
  if (waveBox) {
    const subGap = 6;
    const subH = Math.floor((waveBox.h - subGap) / 2);
    const lBox = { y: waveBox.y, h: subH };
    const rBox = { y: waveBox.y + subH + subGap, h: waveBox.h - subH - subGap };

    const envL = computePeakEnvelope(left, plotW);
    const envR = computePeakEnvelope(right, plotW);

    for (const [box, env, col, label] of [
      [lBox, envL, '#38bdf8', 'Left (L)'],
      [rBox, envR, '#fbbf24', 'Right (R)'],
    ] as const) {
      svg.push(
        `<rect x="${plotX}" y="${box.y}" width="${plotW}" height="${box.h}" fill="#11161f" stroke="#3b4758" stroke-width="1"/>`,
      );
      pushTimeGrid(box.y, box.h);

      const cy = box.y + box.h / 2;
      const halfH = box.h * 0.47;
      svg.push(
        `<line x1="${plotX}" y1="${cy.toFixed(1)}" x2="${plotX + plotW}" y2="${cy.toFixed(1)}" stroke="#475569" stroke-width="0.9"/>`,
      );
      for (const lvl of [-0.5, 0.5]) {
        const y = cy - lvl * halfH;
        svg.push(
          `<line x1="${plotX}" y1="${y.toFixed(1)}" x2="${plotX + plotW}" y2="${y.toFixed(1)}" stroke="#475569" stroke-dasharray="4,4" stroke-width="0.7" opacity="0.7"/>`,
        );
        svg.push(
          `<text x="${plotX - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="11">${lvl > 0 ? '+0.5' : '-0.5'}</text>`,
        );
      }
      svg.push(
        `<text x="${plotX - 8}" y="${(cy + 4).toFixed(1)}" text-anchor="end" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="11">0.0</text>`,
      );
      svg.push(
        `<text x="20" y="${cy.toFixed(1)}" text-anchor="middle" fill="${col}" font-family="Arial, sans-serif" font-size="12" font-weight="700" transform="rotate(-90 20 ${cy.toFixed(1)})">${label}</text>`,
      );

      const d = buildWaveformPath(env.mins, env.maxs, plotX, plotW, box.y, box.h);
      if (d) {
        svg.push(`<path d="${d}" fill="${col}" fill-opacity="0.92" stroke="none"/>`);
      }
    }
  }

  // --- Panel 3: Split L / R dB + Combined 300ms RMS (L1) ---
  const rmsBox = layout.get('rms');
  if (rmsBox) {
    svg.push(
      `<rect x="${plotX}" y="${rmsBox.y}" width="${plotW}" height="${rmsBox.h}" fill="#11161f" stroke="#3b4758" stroke-width="1"/>`,
    );
    pushTimeGrid(rmsBox.y, rmsBox.h);

    // 6 dB solid major + 3 dB dashed minor horizontal gridlines (-48..0 dBFS)
    for (let db = -48; db <= 0; db += 3) {
      const y = rmsBox.y + ((0 - db) / 48) * rmsBox.h;
      const isMajor = db % 6 === 0;
      svg.push(
        `<line x1="${plotX}" y1="${y.toFixed(1)}" x2="${plotX + plotW}" y2="${y.toFixed(1)}" stroke="${isMajor ? '#3b4758' : '#253040'}" stroke-width="${isMajor ? 0.9 : 0.6}" ${isMajor ? '' : 'stroke-dasharray="4,4"'}/>`,
      );
      if (db % 12 === 0 || db === -6 || db === -18) {
        svg.push(
          `<text x="${plotX - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#e6edf3" font-family="Arial, sans-serif" font-size="11">${db === 0 ? '0 dB' : String(db)}</text>`,
        );
      }
    }

    const rms = computeShortTermRms(left, right, startSec, spanSec);
    const ptsL = buildRmsPolyline(rms.timesSec, rms.leftDb, startSec, spanSec, plotX, plotW, rmsBox.y, rmsBox.h);
    const ptsR = buildRmsPolyline(rms.timesSec, rms.rightDb, startSec, spanSec, plotX, plotW, rmsBox.y, rmsBox.h);
    const ptsC = buildRmsPolyline(rms.timesSec, rms.combinedDb, startSec, spanSec, plotX, plotW, rmsBox.y, rmsBox.h);

    svg.push('<g clip-path="url(#clip_rms)">');
    svg.push(`<polyline points="${ptsL}" fill="none" stroke="#38bdf8" stroke-width="1.7" stroke-opacity="0.85"/>`);
    svg.push(`<polyline points="${ptsR}" fill="none" stroke="#fbbf24" stroke-width="1.7" stroke-opacity="0.85"/>`);
    svg.push(`<polyline points="${ptsC}" fill="none" stroke="#f8fafc" stroke-width="2.4" stroke-opacity="0.98"/>`);
    svg.push('</g>');

    // Compact legend parked cleanly in the right margin outside the plot area
    // so even brick-walled 0 dBFS peaks near the right edge are never occluded.
    const legW = 94;
    const legH = 74;
    const legX = plotX + plotW + 8;
    const legY = rmsBox.y + Math.max(4, Math.floor((rmsBox.h - legH) / 2));
    svg.push(
      `<rect x="${legX}" y="${legY}" width="${legW}" height="${legH}" rx="4" fill="#11161f" stroke="#3b4758" stroke-width="0.9"/>`,
    );
    svg.push(`<line x1="${legX + 8}" y1="${legY + 15}" x2="${legX + 24}" y2="${legY + 15}" stroke="#38bdf8" stroke-width="2.2"/>`);
    svg.push(`<text x="${legX + 30}" y="${legY + 19}" fill="#e6edf3" font-family="Arial, sans-serif" font-size="11">L RMS</text>`);
    svg.push(`<line x1="${legX + 8}" y1="${legY + 33}" x2="${legX + 24}" y2="${legY + 33}" stroke="#fbbf24" stroke-width="2.2"/>`);
    svg.push(`<text x="${legX + 30}" y="${legY + 37}" fill="#e6edf3" font-family="Arial, sans-serif" font-size="11">R RMS</text>`);
    svg.push(`<line x1="${legX + 8}" y1="${legY + 51}" x2="${legX + 24}" y2="${legY + 51}" stroke="#f8fafc" stroke-width="2.6"/>`);
    svg.push(`<text x="${legX + 30}" y="${legY + 55}" fill="#e6edf3" font-family="Arial, sans-serif" font-size="11">Stereo</text>`);
    svg.push(`<text x="${legX + 8}" y="${legY + 68}" fill="#9ba7b4" font-family="Arial, sans-serif" font-size="9.5">300ms | 3dB grid</text>`);

    const rcy = rmsBox.y + rmsBox.h / 2;
    svg.push(
      `<text x="20" y="${rcy.toFixed(1)}" text-anchor="middle" fill="#e6edf3" font-family="Arial, sans-serif" font-size="12" font-weight="700" transform="rotate(-90 20 ${rcy.toFixed(1)})">RMS (dBFS)</text>`,
    );
  }

  // --- Panel 4: Log-Mel Spectrogram (50 Hz - 16 kHz, magma) ---
  const specBox = layout.get('spectrogram');
  if (specBox) {
    const spec = renderLogMelSpectrogramPng(left, right, plotW);
    svg.push(
      `<rect x="${plotX}" y="${specBox.y}" width="${plotW}" height="${specBox.h}" fill="#000004" stroke="#3b4758" stroke-width="1"/>`,
    );
    svg.push(
      `<image x="${plotX}" y="${specBox.y}" width="${plotW}" height="${specBox.h}" preserveAspectRatio="none" href="data:image/png;base64,${spec.pngBase64}"/>`,
    );
    pushTimeGrid(specBox.y, specBox.h, true);

    // Frequency ticks mapped cleanly via Mel scale
    const melMin = hzToMel(50);
    const melMax = hzToMel(16000);
    const freqTicks: Array<[number, string]> = [
      [100, '100 Hz'],
      [250, '250 Hz'],
      [500, '500 Hz'],
      [1000, '1 kHz'],
      [2000, '2 kHz'],
      [4000, '4 kHz'],
      [8000, '8 kHz'],
      [16000, '16 kHz'],
    ];
    for (const [hz, label] of freqTicks) {
      const norm = (hzToMel(hz) - melMin) / (melMax - melMin);
      const y = specBox.y + (1 - norm) * specBox.h;
      svg.push(
        `<line x1="${plotX}" y1="${y.toFixed(1)}" x2="${plotX + plotW}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.22)" stroke-width="0.6"/>`,
      );
      svg.push(
        `<text x="${plotX - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#e6edf3" font-family="Arial, sans-serif" font-size="11.5">${label}</text>`,
      );
    }
    const scy = specBox.y + specBox.h / 2;
    svg.push(
      `<text x="20" y="${scy.toFixed(1)}" text-anchor="middle" fill="#e6edf3" font-family="Arial, sans-serif" font-size="12" font-weight="700" transform="rotate(-90 20 ${scy.toFixed(1)})">Log-Mel (Hz)</text>`,
    );

    // Colorbar (-80..0 dBFS) on right
    const cbX = plotX + plotW + 18;
    const cbW = 18;
    svg.push(
      `<rect x="${cbX}" y="${specBox.y}" width="${cbW}" height="${specBox.h}" fill="url(#magmaGrad)" stroke="#3b4758" stroke-width="1"/>`,
    );
    for (const db of [-80, -60, -40, -24, -12, -6, 0]) {
      const y = specBox.y + ((0 - db) / 80) * specBox.h;
      svg.push(
        `<line x1="${cbX + cbW}" y1="${y.toFixed(1)}" x2="${cbX + cbW + 4}" y2="${y.toFixed(1)}" stroke="#e6edf3" stroke-width="1"/>`,
      );
      svg.push(
        `<text x="${cbX + cbW + 8}" y="${(y + 4).toFixed(1)}" fill="#e6edf3" font-family="Arial, sans-serif" font-size="11">${db === 0 ? '0 dB' : String(db)}</text>`,
      );
    }
    const cbLabelX = width - 16;
    svg.push(
      `<text x="${cbLabelX}" y="${scy.toFixed(1)}" text-anchor="middle" fill="#e6edf3" font-family="Arial, sans-serif" font-size="11.5" font-weight="700" transform="rotate(-90 ${cbLabelX} ${scy.toFixed(1)})">Level (dBFS)</text>`,
    );
  }

  // Bottom shared time axis ticks & label
  const lastPanel = panels[panels.length - 1]!;
  const bottomY = layout.get(lastPanel)!.y + layout.get(lastPanel)!.h;
  for (let t = firstMajor; t <= endSec + 1e-6; t += majorStep) {
    const x = timeToX(t);
    if (x < plotX - 0.5 || x > plotX + plotW + 0.5) continue;
    svg.push(
      `<line x1="${x.toFixed(1)}" y1="${bottomY}" x2="${x.toFixed(1)}" y2="${bottomY + 6}" stroke="#e6edf3" stroke-width="1.2"/>`,
    );
    svg.push(
      `<text x="${x.toFixed(1)}" y="${bottomY + 22}" text-anchor="middle" fill="#e6edf3" font-family="Arial, sans-serif" font-size="12.5">${formatTimeTick(t, majorStep)}</text>`,
    );
  }
  svg.push(
    `<text x="${(plotX + plotW / 2).toFixed(1)}" y="${height - 12}" text-anchor="middle" fill="#e6edf3" font-family="Arial, sans-serif" font-size="13.5" font-weight="700">Time (seconds)</text>`,
  );

  svg.push('</svg>');

  const resvg = new Resvg(svg.join('\n'), {
    fitTo: { mode: 'width', value: width },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Arial',
    },
  });
  const pngBuffer = Buffer.from(resvg.render().asPng());
  return { pngBuffer, plotW };
}

// ---------------------------------------------------------------------------
// Pure-FFmpeg Fast Path (preset='fast', verified 1.000 F1 in Phase 1)
// ---------------------------------------------------------------------------

async function renderFastFfmpegPng(params: {
  audioPath: string;
  startSec: number;
  durationSec: number;
  ffmpegPath: string;
}): Promise<{ pngBuffer: Buffer; width: number; height: number; plotW: number }> {
  const { audioPath, startSec, durationSec, ffmpegPath } = params;
  // Exact pixel-aligned 1600x900 layout: resample to 48 kHz stereo so showspectrumpic's
  // legend width is deterministic across 8-96 kHz inputs (e.g. 24 kHz mono takes would
  // otherwise produce 1584px and fail vstack against 1600px). Scale is a no-op at 1600x650
  // and guards against FFmpeg version-specific legend margin differences.
  const fc = [
    '[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[a1][a2]',
    '[a1]showwavespic=s=1316x250:colors=#38bdf8|#fbbf24:split_channels=1:scale=lin:filter=peak[wraw]',
    'color=c=#0d1117:s=1600x250:d=1[bg]',
    '[bg][wraw]overlay=x=142:y=0:shortest=1,format=rgb24[w]',
    '[a2]showspectrumpic=s=1316x522:mode=combined:color=magma:scale=log:fscale=log:gain=1:drange=100:legend=1,scale=1600:650,format=rgb24[s]',
    '[w][s]vstack=inputs=2[out]',
  ].join(';');

  const pngBuffer = await runFfmpegBinary(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    startSec.toFixed(4),
    '-t',
    durationSec.toFixed(4),
    '-i',
    audioPath,
    '-filter_complex',
    fc,
    '-map',
    '[out]',
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    'pipe:1',
  ]);

  return { pngBuffer, width: 1600, height: 900, plotW: 1316 };
}

// ---------------------------------------------------------------------------
// Public Entry Point
// ---------------------------------------------------------------------------

export async function renderAudioVisual(
  options: RenderVisualOptions,
): Promise<RenderVisualResult> {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const preset: VisualPreset = options.preset ?? 'master';
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;

  const probe = await probeAudio(options.audioPath, ffprobePath);
  const totalDurationSec = Math.max(0.05, probe.durationMs / 1000);

  const startSec = Math.max(0, options.startSec ?? 0);
  if (startSec >= totalDurationSec) {
    throw new VisualValidationError(
      `startSec (${startSec.toFixed(2)}s) must be less than audio duration (${totalDurationSec.toFixed(2)}s)`,
      400,
    );
  }

  let endSec: number;
  if (options.endSec !== undefined) {
    endSec = Math.min(totalDurationSec, options.endSec);
  } else if (options.mode === 'zoom' && totalDurationSec - startSec > ZOOM_MAX_SPAN_SEC) {
    endSec = Math.min(totalDurationSec, startSec + ZOOM_MAX_SPAN_SEC);
  } else {
    endSec = totalDurationSec;
  }

  if (endSec <= startSec + 0.05) {
    throw new VisualValidationError(
      `endSec (${endSec.toFixed(2)}s) must be greater than startSec (${startSec.toFixed(2)}s)`,
      400,
    );
  }

  const windowDurationSec = endSec - startSec;
  const mode: VisualMode =
    options.mode ?? (windowDurationSec <= ZOOM_MAX_SPAN_SEC ? 'zoom' : 'overview');

  if (mode === 'zoom' && windowDurationSec > ZOOM_MAX_SPAN_SEC + 0.05) {
    throw new VisualValidationError(
      `Zoom mode is capped at ${ZOOM_MAX_SPAN_SEC}s (>= ${MIN_SURGICAL_PX_PER_SEC} px/s) to preserve sub-200 ms dropout/overlap visibility. Requested ${windowDurationSec.toFixed(1)}s; narrow startSec/endSec to <= ${ZOOM_MAX_SPAN_SEC}s or use mode="overview".`,
      400,
    );
  }

  const cueBlocks = options.cueBlocks ?? [];
  const sfxBlocks = options.sfxBlocks ?? [];
  const defaultPanels: VisualPanel[] =
    cueBlocks.length > 0 || sfxBlocks.length > 0
      ? ['cues', 'waveform', 'rms', 'spectrogram']
      : ['waveform', 'rms', 'spectrogram'];
  const panels: VisualPanel[] =
    preset === 'fast'
      ? ['waveform', 'spectrogram']
      : options.panels && options.panels.length > 0
        ? options.panels
        : defaultPanels;

  let pngBuffer: Buffer;
  let outW = width;
  let outH = height;
  let plotW = 1316;

  if (preset === 'fast') {
    const fast = await renderFastFfmpegPng({
      audioPath: options.audioPath,
      startSec,
      durationSec: windowDurationSec,
      ffmpegPath,
    });
    pngBuffer = fast.pngBuffer;
    outW = fast.width;
    outH = fast.height;
    plotW = fast.plotW;
  } else {
    const { left, right } = await decodeSliceStereo48k(
      options.audioPath,
      startSec,
      windowDurationSec,
      ffmpegPath,
    );
    const title =
      options.title ??
      `Audio Visual Inspection | ${startSec.toFixed(2)}s - ${endSec.toFixed(2)}s (${mode})`;
    const rendered = renderMasterSvgToPng({
      left,
      right,
      startSec,
      endSec,
      panels,
      cueBlocks,
      sfxBlocks,
      title,
      width,
      height,
    });
    pngBuffer = rendered.pngBuffer;
    plotW = rendered.plotW;
  }

  const pxPerSec = Number((plotW / windowDurationSec).toFixed(2));
  const warnings: string[] = [];
  if (pxPerSec < MIN_SURGICAL_PX_PER_SEC) {
    warnings.push(
      `Window is ${windowDurationSec.toFixed(1)}s (${pxPerSec} px/s < ${MIN_SURGICAL_PX_PER_SEC} px/s): broadband clicks and macro pacing/loudness arcs remain visible, but <150 ms dropouts and overlaps fall below the pixel resolution cliff. Re-run with mode="zoom" on <= ${ZOOM_MAX_SPAN_SEC}s spans for surgical seam QC.`,
    );
  }

  return {
    pngBuffer,
    width: outW,
    height: outH,
    preset,
    mode,
    panels,
    totalDurationSec: Number(totalDurationSec.toFixed(3)),
    startSec: Number(startSec.toFixed(3)),
    endSec: Number(endSec.toFixed(3)),
    windowDurationSec: Number(windowDurationSec.toFixed(3)),
    pxPerSec,
    channels: probe.channels,
    sampleRate: probe.sampleRate,
    warnings,
  };
}
