import { createHash } from 'node:crypto';
import {
  DesignVoiceRequest,
  DesignVoiceResult,
  ListVoicesFilter,
  ListVoicesResult,
  ProviderVoiceDetails,
  ProviderVoiceEntry,
  SynthesizeRequest,
  SynthesizeResult,
  TtsProvider,
  wrapPcm16AsWav,
} from './interface.js';

export interface MockTtsProviderOptions {
  /** Sample rate for generated WAVs (default 24000 to mirror Gemini 3.8 TTS) */
  sampleRate?: number;
  /** Default amplitude in dBFS for normal speech bursts (default -18 dBFS peak) */
  defaultPeakDbfs?: number;
  /** Optional per-request overrides for testing specific loudness or durations */
  override?: (req: SynthesizeRequest) => {
    durationMs?: number;
    peakDbfs?: number;
    fundamentalHz?: number;
  } | null;
}

const PREBUILT_MOCK_VOICES: ProviderVoiceEntry[] = [
  {
    id: 'mock_mara',
    label: 'Mock Mara',
    displayName: 'Mock Mara',
    type: 'prebuilt',
    gender: 'female',
    languageCode: 'en-US',
    accent: 'American',
    pitch: 'medium',
    persona: 'Warm, Intimate',
    context: 'Conversational',
  },
  {
    id: 'mock_narrator',
    label: 'Mock Narrator',
    displayName: 'Mock Narrator',
    type: 'prebuilt',
    gender: 'male',
    languageCode: 'en-GB',
    accent: 'British',
    pitch: 'low',
    persona: 'Narrator',
    context: 'Audiobook',
  },
  {
    id: 'mock_lina',
    label: 'Mock Lina',
    displayName: 'Mock Lina',
    type: 'prebuilt',
    gender: 'female',
    languageCode: 'en-US',
    accent: 'American',
    pitch: 'high',
    persona: 'Lively',
    context: 'Conversational',
  },
];

function matchesAny(value: string | undefined, candidates?: string[]): boolean {
  if (!candidates || candidates.length === 0) return true;
  if (!value) return false;
  const lower = value.toLowerCase();
  return candidates.some((c) => c.toLowerCase() === lower);
}

/**
 * Deterministic, zero-cost TTS provider for automated testing and offline development.
 * Synthesizes speech-like harmonic bursts (syllable envelopes) as valid 16-bit PCM WAVs.
 */
export class MockTtsProvider implements TtsProvider {
  readonly name = 'mock';
  private readonly sampleRate: number;
  private readonly defaultPeakDbfs: number;
  private readonly override?: MockTtsProviderOptions['override'];
  private readonly customVoices = new Map<string, ProviderVoiceDetails>();

  constructor(options: MockTtsProviderOptions = {}) {
    this.sampleRate = options.sampleRate ?? 24000;
    this.defaultPeakDbfs = options.defaultPeakDbfs ?? -14;
    this.override = options.override;
  }

  async listVoices(filter?: ListVoicesFilter): Promise<ListVoicesResult> {
    // Custom voices newest-first, followed by prebuilt voices (mirroring Gemini Voices API)
    const customList: ProviderVoiceEntry[] = Array.from(this.customVoices.values())
      .reverse()
      .map(({ sampleWavBuffer: _buf, provider: _prov, ...entry }) => ({ ...entry }));
    let voices: ProviderVoiceEntry[] = [
      ...customList,
      ...PREBUILT_MOCK_VOICES.map((v) => ({ ...v })),
    ];

    if (filter) {
      voices = voices.filter((v) => {
        if (!matchesAny(v.type, filter.type)) return false;
        if (!matchesAny(v.languageCode, filter.languageCode)) return false;
        if (!matchesAny(v.regionCode, filter.regionCode)) return false;
        if (!matchesAny(v.accent, filter.accent)) return false;
        if (!matchesAny(v.gender, filter.gender)) return false;
        if (!matchesAny(v.pitch, filter.pitch)) return false;
        if (!matchesAny(v.persona, filter.persona)) return false;
        if (!matchesAny(v.context, filter.contexts)) return false;
        if (filter.search) {
          const needle = filter.search.toLowerCase();
          const haystack = `${v.id} ${v.label} ${v.displayName ?? ''} ${v.description ?? ''}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        return true;
      });
      if (filter.pageSize !== undefined && filter.pageSize > 0) {
        voices = voices.slice(0, filter.pageSize);
      }
    }

    return { voices };
  }

  async designVoice(req: DesignVoiceRequest): Promise<DesignVoiceResult> {
    if (req.store === false) {
      const err = new Error(
        'Prompted voice design/remixing requires store=true',
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const hash = createHash('sha256')
      .update(
        `${req.displayName}|${req.prompt}|${req.baseVoice ?? ''}|${req.gender ?? ''}|${req.languageCode ?? ''}`,
      )
      .digest('hex')
      .slice(0, 10);
    const voiceId = `mock_voice_${hash}`;
    const sample = await this.synthesize({
      text: `Audition sample for ${req.displayName}.`,
      voiceId,
      model: req.model,
    });
    const expireTime = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const stored: ProviderVoiceDetails = {
      id: voiceId,
      label: req.displayName,
      displayName: req.displayName,
      type: 'prompted',
      provider: this.name,
      model: sample.model,
      languageCode: req.languageCode ?? 'en-US',
      ...(req.gender ? { gender: req.gender } : {}),
      ...(req.description ? { description: req.description } : {}),
      ...(req.regionCode ? { regionCode: req.regionCode } : {}),
      ...(req.accent ? { accent: req.accent } : {}),
      ...(req.pitch ? { pitch: req.pitch } : {}),
      ...(req.persona ? { persona: req.persona } : {}),
      ...(req.context ? { context: req.context } : {}),
      prompt: req.prompt,
      ...(req.baseVoice ? { baseVoice: req.baseVoice } : {}),
      expireTime,
      sampleWavBuffer: sample.wavBuffer,
    };
    // Re-insert so newest-first ordering updates if re-designed
    this.customVoices.delete(voiceId);
    this.customVoices.set(voiceId, stored);

    return {
      voiceId,
      displayName: req.displayName,
      provider: this.name,
      model: sample.model,
      type: 'prompted',
      languageCode: stored.languageCode,
      ...(stored.gender ? { gender: stored.gender } : {}),
      ...(stored.description ? { description: stored.description } : {}),
      ...(stored.regionCode ? { regionCode: stored.regionCode } : {}),
      ...(stored.accent ? { accent: stored.accent } : {}),
      ...(stored.pitch ? { pitch: stored.pitch } : {}),
      ...(stored.persona ? { persona: stored.persona } : {}),
      ...(stored.context ? { context: stored.context } : {}),
      prompt: req.prompt,
      ...(stored.baseVoice ? { baseVoice: stored.baseVoice } : {}),
      expireTime,
      sampleWavBuffer: sample.wavBuffer,
    };
  }

  async getVoice(voiceId: string): Promise<ProviderVoiceDetails> {
    const cleanId = voiceId.startsWith('voices/') ? voiceId.slice('voices/'.length) : voiceId;
    const found = this.customVoices.get(cleanId);
    if (!found) {
      const err = new Error(`Mock custom voice not found: ${cleanId}`) as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }
    return { ...found };
  }

  async deleteVoice(voiceId: string): Promise<{ deleted: boolean; voiceId: string }> {
    const cleanId = voiceId.startsWith('voices/') ? voiceId.slice('voices/'.length) : voiceId;
    if (PREBUILT_MOCK_VOICES.some((v) => v.id === cleanId)) {
      const err = new Error(`Prebuilt voice "${cleanId}" cannot be deleted`) as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }
    if (!this.customVoices.delete(cleanId)) {
      const err = new Error(`Mock custom voice not found: ${cleanId}`) as Error & {
        statusCode?: number;
      };
      err.statusCode = 404;
      throw err;
    }
    return { deleted: true, voiceId: cleanId };
  }

  async synthesize(req: SynthesizeRequest): Promise<SynthesizeResult> {
    const hash = createHash('sha256')
      .update(`${req.voiceId}|${req.direction ?? ''}|${req.text}`)
      .digest();

    const custom = this.override?.(req) ?? null;

    // Deterministic voice pitch derived from voiceId so different speakers are distinguishable
    const voiceHash = createHash('sha256').update(req.voiceId).digest();
    const baseFreq =
      custom?.fundamentalHz ?? 155 + (voiceHash.readUInt16BE(0) % 110);

    // Strip inline vocal tags when estimating spoken syllable count
    const spokenText = req.text.replace(/<[^>]+>/g, ' ').trim();
    const wordCount = spokenText ? spokenText.split(/\s+/).length : 0;

    // Short vocal-only cues like "<sigh>" yield a realistic sub-second clip (~350 ms)
    const computedDurationMs =
      wordCount === 0
        ? 350
        : Math.min(4500, Math.max(600, Math.round(wordCount * 220 + 250)));
    const durationMs = custom?.durationMs ?? computedDurationMs;

    // Adjust peak subtly based on direction hints unless overridden
    let peakDbfs = custom?.peakDbfs ?? this.defaultPeakDbfs;
    if (custom?.peakDbfs === undefined && req.direction) {
      const dir = req.direction.toLowerCase();
      if (dir.includes('whisper') || dir.includes('soft')) {
        peakDbfs -= 8;
      } else if (dir.includes('shout') || dir.includes('loud') || dir.includes('angry')) {
        peakDbfs += 5;
      }
    }

    const peakLinear = Math.min(0.95, Math.pow(10, peakDbfs / 20));
    const totalSamples = Math.max(1, Math.round((durationMs / 1000) * this.sampleRate));
    const pcm = Buffer.alloc(totalSamples * 2);

    // Syllable modulation rate (~4.2 Hz) with gentle lead-in/lead-out envelope
    const syllableHz = 3.8 + (hash[0]! / 255) * 1.4;
    const edgeSamples = Math.min(Math.floor(this.sampleRate * 0.025), Math.floor(totalSamples / 4));

    for (let i = 0; i < totalSamples; i++) {
      const t = i / this.sampleRate;

      // Slight pitch contour so it behaves like voice energy rather than a static sine
      const f0 = baseFreq * (1 + 0.04 * Math.sin(2 * Math.PI * 1.3 * t));
      const harmonic =
        0.62 * Math.sin(2 * Math.PI * f0 * t) +
        0.25 * Math.sin(2 * Math.PI * f0 * 2 * t + 0.4) +
        0.13 * Math.sin(2 * Math.PI * f0 * 3 * t + 1.1);

      // Smooth syllable envelope (stays between 0.35 and 1.0 during speech)
      const syllEnv = 0.68 + 0.32 * Math.sin(2 * Math.PI * syllableHz * t);

      // Gentle edge taper
      let edgeEnv = 1;
      if (edgeSamples > 0) {
        if (i < edgeSamples) {
          edgeEnv = i / edgeSamples;
        } else if (i >= totalSamples - edgeSamples) {
          edgeEnv = (totalSamples - 1 - i) / edgeSamples;
        }
      }

      const sample = Math.max(-1, Math.min(1, harmonic * syllEnv * edgeEnv * peakLinear));
      pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
    }

    const wavBuffer = wrapPcm16AsWav(pcm, this.sampleRate, 1);

    return {
      wavBuffer,
      sampleRate: this.sampleRate,
      channels: 1,
      provider: this.name,
      model: req.model ?? 'mock-speech-v1',
    };
  }
}
