export interface SynthesizeRequest {
  text: string;
  voiceId: string;
  direction?: string | null;
  model?: string;
}

export interface SynthesizeResult {
  wavBuffer: Buffer;
  sampleRate: number;
  channels: number;
  provider: string;
  model: string;
}

export type VoiceGender = 'female' | 'male' | 'neutral';
export type VoicePitch = 'low' | 'medium' | 'high';
export type ProviderVoiceType = 'prebuilt' | 'prompted' | 'replicated';

export interface ProviderVoiceEntry {
  id: string;
  label: string;
  type?: ProviderVoiceType | string;
  displayName?: string;
  description?: string;
  gender?: string;
  languageCode?: string;
  regionCode?: string;
  accent?: string;
  pitch?: string;
  persona?: string;
  context?: string;
  model?: string;
  prompt?: string;
  baseVoice?: string;
  expireTime?: string;
}

export interface ListVoicesFilter {
  type?: string[];
  languageCode?: string[];
  regionCode?: string[];
  accent?: string[];
  gender?: string[];
  pitch?: string[];
  persona?: string[];
  contexts?: string[];
  search?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface ListVoicesResult {
  voices: ProviderVoiceEntry[];
  nextPageToken?: string;
}

export interface ProviderVoiceDetails extends ProviderVoiceEntry {
  provider: string;
  sampleWavBuffer?: Buffer;
}

export interface DesignVoiceRequest {
  displayName: string;
  prompt: string;
  description?: string;
  gender?: VoiceGender;
  languageCode?: string;
  regionCode?: string;
  accent?: string;
  pitch?: VoicePitch;
  persona?: string;
  context?: string;
  baseVoice?: string;
  /** Prompted voices require store=true on Gemini; passing false is rejected. */
  store?: boolean;
  model?: string;
}

export interface DesignVoiceResult {
  voiceId: string;
  displayName: string;
  provider: string;
  model: string;
  type?: string;
  gender?: string;
  languageCode?: string;
  regionCode?: string;
  accent?: string;
  pitch?: string;
  persona?: string;
  context?: string;
  description?: string;
  prompt?: string;
  baseVoice?: string;
  expireTime?: string;
  sampleWavBuffer?: Buffer;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(req: SynthesizeRequest): Promise<SynthesizeResult>;
  listVoices?(filter?: ListVoicesFilter): Promise<ListVoicesResult>;
  getVoice?(voiceId: string): Promise<ProviderVoiceDetails>;
  deleteVoice?(voiceId: string): Promise<{ deleted: boolean; voiceId: string }>;
  designVoice?(req: DesignVoiceRequest): Promise<DesignVoiceResult>;
}

export interface WavHeaderInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
  durationMs: number;
}

/**
 * Validates that a buffer is a well-formed, non-truncated RIFF/WAVE PCM file
 * and extracts its format metadata.
 */
export function validateWavBuffer(buf: Buffer): WavHeaderInfo {
  if (buf.length < 44) {
    throw new Error(`Invalid WAV buffer: too short (${buf.length} bytes)`);
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV buffer: missing RIFF/WAVE header');
  }

  let offset = 12;
  let audioFormat: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let dataOffset: number | null = null;
  let dataSize: number | null = null;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || chunkDataStart + 16 > buf.length) {
        throw new Error('Invalid WAV buffer: truncated fmt chunk');
      }
      audioFormat = buf.readUInt16LE(chunkDataStart);
      channels = buf.readUInt16LE(chunkDataStart + 2);
      sampleRate = buf.readUInt32LE(chunkDataStart + 4);
      bitsPerSample = buf.readUInt16LE(chunkDataStart + 14);
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart;
      dataSize = chunkSize;
      break;
    }

    // Chunks are word-aligned (even byte boundaries)
    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (
    audioFormat === null ||
    channels === null ||
    sampleRate === null ||
    bitsPerSample === null
  ) {
    throw new Error('Invalid WAV buffer: missing fmt chunk');
  }
  if (dataOffset === null || dataSize === null || dataSize === 0) {
    throw new Error('Invalid WAV buffer: missing or empty data chunk');
  }
  if (dataOffset + dataSize > buf.length) {
    throw new Error(
      `Truncated WAV buffer: declared ${dataSize} data bytes, only ${buf.length - dataOffset} present`,
    );
  }
  if (channels <= 0 || sampleRate <= 0 || bitsPerSample <= 0) {
    throw new Error('Invalid WAV buffer: invalid audio parameters');
  }

  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  const durationMs = Math.round((dataSize / bytesPerSecond) * 1000);

  return {
    audioFormat,
    channels,
    sampleRate,
    bitsPerSample,
    dataOffset,
    dataSize,
    durationMs,
  };
}

/**
 * Wraps raw 16-bit signed little-endian PCM bytes in a canonical 44-byte RIFF/WAVE header.
 */
export function wrapPcm16AsWav(
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
): Buffer {
  if (pcmBuffer.length === 0 || pcmBuffer.length % (2 * channels) !== 0) {
    throw new Error(
      `Invalid 16-bit PCM buffer length (${pcmBuffer.length}) for ${channels} channel(s)`,
    );
  }
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}
