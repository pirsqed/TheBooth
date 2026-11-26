import { GoogleGenAI } from '@google/genai';
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
  validateWavBuffer,
  wrapPcm16AsWav,
} from './interface.js';

export type GeminiSafetyThreshold =
  | 'block_low_and_above'
  | 'block_medium_and_above'
  | 'block_only_high'
  | 'block_none'
  | 'off';

export class GeminiTtsError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 502,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'GeminiTtsError';
  }
}

export interface GeminiVoiceOutput {
  id?: string;
  key?: string;
  type?: string;
  display_name?: string;
  description?: string;
  gender?: string;
  language_code?: string;
  region_code?: string;
  accent?: string;
  pitch?: string;
  persona?: string;
  context?: string;
  model?: string;
  expire_time?: string;
  prompted?: {
    input?: string;
    base_voice?: string;
  };
  sample_audio?: {
    data?: string;
    mime_type?: string;
  };
}

export interface GeminiVoicesClient {
  create(params: Record<string, unknown>): Promise<GeminiVoiceOutput>;
  list(params?: Record<string, unknown>): Promise<{
    voices?: GeminiVoiceOutput[];
    next_page_token?: string;
  }>;
  get(id: string): Promise<GeminiVoiceOutput>;
  delete(id: string): Promise<unknown>;
}

export interface GeminiInteractionsClient {
  interactions: {
    create(params: Record<string, unknown>): Promise<{
      id?: string;
      status?: string;
      output_audio?: {
        data?: string;
        mime_type?: string;
        rate?: number;
        channels?: number;
      };
      steps?: Array<{
        type?: string;
        content?: Array<{
          type?: string;
          data?: string;
          mime_type?: string;
          rate?: number;
          channels?: number;
        }>;
      }>;
    }>;
  };
  voices?: GeminiVoicesClient;
}

export interface GeminiTtsProviderOptions {
  apiKey?: string;
  defaultModel?: string;
  safetyThreshold?: GeminiSafetyThreshold;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  maxInputBytes?: number;
  /** Optional injected SDK client for deterministic unit testing */
  client?: GeminiInteractionsClient;
  /** Optional injected sleep function for fast unit testing */
  sleep?: (ms: number) => Promise<void>;
}

const PREBUILT_VOICES: ProviderVoiceEntry[] = [
  { id: 'Zephyr', label: 'Zephyr (Bright)', displayName: 'Zephyr', type: 'prebuilt' },
  { id: 'Puck', label: 'Puck (Upbeat)', displayName: 'Puck', type: 'prebuilt' },
  { id: 'Charon', label: 'Charon (Informative)', displayName: 'Charon', type: 'prebuilt' },
  { id: 'Kore', label: 'Kore (Firm)', displayName: 'Kore', type: 'prebuilt' },
  { id: 'Fenrir', label: 'Fenrir (Excitable)', displayName: 'Fenrir', type: 'prebuilt' },
  { id: 'Leda', label: 'Leda (Youthful)', displayName: 'Leda', type: 'prebuilt' },
  { id: 'Orus', label: 'Orus (Firm)', displayName: 'Orus', type: 'prebuilt' },
  { id: 'Aoede', label: 'Aoede (Breezy)', displayName: 'Aoede', type: 'prebuilt' },
  { id: 'Callirrhoe', label: 'Callirrhoe (Easy-going)', displayName: 'Callirrhoe', type: 'prebuilt' },
  { id: 'Autonoe', label: 'Autonoe (Bright)', displayName: 'Autonoe', type: 'prebuilt' },
  { id: 'Enceladus', label: 'Enceladus (Breathy)', displayName: 'Enceladus', type: 'prebuilt' },
  { id: 'Iapetus', label: 'Iapetus (Clear)', displayName: 'Iapetus', type: 'prebuilt' },
  { id: 'Umbriel', label: 'Umbriel (Easy-going)', displayName: 'Umbriel', type: 'prebuilt' },
  { id: 'Algieba', label: 'Algieba (Smooth)', displayName: 'Algieba', type: 'prebuilt' },
  { id: 'Despina', label: 'Despina (Smooth)', displayName: 'Despina', type: 'prebuilt' },
  { id: 'Erinome', label: 'Erinome (Clear)', displayName: 'Erinome', type: 'prebuilt' },
  { id: 'Algenib', label: 'Algenib (Gravelly)', displayName: 'Algenib', type: 'prebuilt' },
  { id: 'Rasalgethi', label: 'Rasalgethi (Informative)', displayName: 'Rasalgethi', type: 'prebuilt' },
  { id: 'Laomedeia', label: 'Laomedeia (Upbeat)', displayName: 'Laomedeia', type: 'prebuilt' },
  { id: 'Achernar', label: 'Achernar (Soft)', displayName: 'Achernar', type: 'prebuilt' },
  { id: 'Alnilam', label: 'Alnilam (Firm)', displayName: 'Alnilam', type: 'prebuilt' },
  { id: 'Schedar', label: 'Schedar (Even)', displayName: 'Schedar', type: 'prebuilt' },
  { id: 'Gacrux', label: 'Gacrux (Mature)', displayName: 'Gacrux', type: 'prebuilt' },
  { id: 'Pulcherrima', label: 'Pulcherrima (Forward)', displayName: 'Pulcherrima', type: 'prebuilt' },
  { id: 'Achird', label: 'Achird (Friendly)', displayName: 'Achird', type: 'prebuilt' },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi (Casual)', displayName: 'Zubenelgenubi', type: 'prebuilt' },
  { id: 'Vindemiatrix', label: 'Vindemiatrix (Gentle)', displayName: 'Vindemiatrix', type: 'prebuilt' },
  { id: 'Sadachbia', label: 'Sadachbia (Lively)', displayName: 'Sadachbia', type: 'prebuilt' },
  { id: 'Sadaltager', label: 'Sadaltager (Knowledgeable)', displayName: 'Sadaltager', type: 'prebuilt' },
  { id: 'Sulafat', label: 'Sulafat (Warm)', displayName: 'Sulafat', type: 'prebuilt' },
];

const SAFETY_CATEGORIES = [
  'hate_speech',
  'harassment',
  'sexually_explicit',
  'dangerous_content',
] as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeVoiceResourceId(voiceId: string): string {
  const trimmed = voiceId.trim();
  return trimmed.startsWith('voices/') ? trimmed.slice('voices/'.length) : trimmed;
}

function decodeSampleAudio(sampleAudio?: { data?: string; mime_type?: string }): Buffer | undefined {
  if (!sampleAudio?.data) return undefined;
  const raw = Buffer.from(sampleAudio.data, 'base64');
  if (raw.length === 0) return undefined;

  const isRiffWav =
    raw.length >= 12 &&
    raw.toString('ascii', 0, 4) === 'RIFF' &&
    raw.toString('ascii', 8, 12) === 'WAVE';

  const wavBuffer = isRiffWav ? raw : wrapPcm16AsWav(raw, 24000, 1);
  validateWavBuffer(wavBuffer);
  return wavBuffer;
}

function mapGeminiVoiceOutput(raw: GeminiVoiceOutput): ProviderVoiceEntry {
  const id = raw.id ?? raw.display_name ?? '';
  const displayName = raw.display_name ?? id;
  const tagParts = [raw.persona, raw.accent, raw.gender].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
  const label =
    displayName && tagParts.length > 0 && !displayName.includes('(')
      ? `${displayName} (${tagParts.slice(0, 2).join(', ')})`
      : displayName || id;

  return {
    id,
    label,
    ...(raw.type ? { type: raw.type } : {}),
    ...(raw.display_name ? { displayName: raw.display_name } : {}),
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.gender ? { gender: raw.gender } : {}),
    ...(raw.language_code ? { languageCode: raw.language_code } : {}),
    ...(raw.region_code ? { regionCode: raw.region_code } : {}),
    ...(raw.accent ? { accent: raw.accent } : {}),
    ...(raw.pitch ? { pitch: raw.pitch } : {}),
    ...(raw.persona ? { persona: raw.persona } : {}),
    ...(raw.context ? { context: raw.context } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    ...(raw.prompted?.input ? { prompt: raw.prompted.input } : {}),
    ...(raw.prompted?.base_voice ? { baseVoice: raw.prompted.base_voice } : {}),
    ...(raw.expire_time ? { expireTime: raw.expire_time } : {}),
  };
}

function classifyError(err: unknown, operation = 'Gemini TTS synthesis'): GeminiTtsError {
  if (err instanceof GeminiTtsError) return err;

  const anyErr = err as {
    status?: number;
    statusCode?: number;
    code?: string;
    message?: string;
  };
  const message = anyErr?.message ?? String(err);
  const status = anyErr?.status ?? anyErr?.statusCode;

  if (
    status === 400 &&
    /length|token|too long|exceeds|limit/i.test(message)
  ) {
    return new GeminiTtsError(
      `${operation} input length limit exceeded: ${message}`,
      400,
      false,
    );
  }

  if (status === 400 || status === 404) {
    return new GeminiTtsError(`${operation} failed (${status}): ${message}`, status, false);
  }

  if (status === 401 || status === 403) {
    return new GeminiTtsError(
      `Gemini API authentication/authorization error: ${message}`,
      status,
      false,
    );
  }

  if (status === 429) {
    return new GeminiTtsError(`Gemini API rate limited: ${message}`, 429, true);
  }

  if (status !== undefined && status >= 500 && status <= 599) {
    return new GeminiTtsError(`Gemini API server error (${status}): ${message}`, 503, true);
  }

  if (
    anyErr?.code === 'ECONNRESET' ||
    anyErr?.code === 'ETIMEDOUT' ||
    anyErr?.code === 'EAI_AGAIN' ||
    /fetch failed|network|timeout|rate limit|429|503|502|500/i.test(message)
  ) {
    return new GeminiTtsError(`Transient Gemini API error: ${message}`, 503, true);
  }

  return new GeminiTtsError(`${operation} failed: ${message}`, status ?? 502, false);
}

/**
 * Gemini 3.8 Flash TTS adapter built on the v1beta Interactions & Voices APIs (`@google/genai`).
 *
 * - Strictly separates spoken `text` from delivery `direction` via
 *   `annotations: [{ type: 'speech_metadata', style }]` (never concatenates direction into text).
 * - Passes `store: false` for stateless isolated cue renders.
 * - Uses native `client.voices.{create,list,get,delete}` for Voice Design, Remixing,
 *   Extended Voice Library browsing, and stored custom voice lifecycle management.
 * - Requests `audio/wav` and validates RIFF/WAVE framing (or wraps raw 16-bit LE PCM cleanly).
 */
export class GeminiTtsProvider implements TtsProvider {
  readonly name = 'gemini';
  private readonly defaultModel: string;
  private readonly safetyThreshold: GeminiSafetyThreshold;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxInputBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private client: GeminiInteractionsClient | null;
  private readonly apiKey?: string;

  constructor(options: GeminiTtsProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? 'gemini-3.8-flash-tts';
    // Gemini Developer API v1beta Interactions supports 'off' (whereas 'block_none' is Vertex-only)
    const rawThreshold = options.safetyThreshold ?? 'off';
    this.safetyThreshold = rawThreshold === 'block_none' ? 'off' : rawThreshold;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
    this.maxInputBytes = options.maxInputBytes ?? 16000;
    this.sleep = options.sleep ?? defaultSleep;
    this.client = options.client ?? null;
  }

  private getClient(): GeminiInteractionsClient {
    if (this.client) return this.client;
    if (!this.apiKey) {
      throw new GeminiTtsError(
        'GEMINI_API_KEY is not configured for GeminiTtsProvider',
        503,
        false,
      );
    }
    const sdkClient = new GoogleGenAI({
      apiKey: this.apiKey,
      httpOptions: { apiVersion: 'v1beta' },
    });
    this.client = sdkClient as unknown as GeminiInteractionsClient;
    return this.client;
  }

  private getVoicesClient(): GeminiVoicesClient {
    const client = this.getClient();
    if (!client.voices) {
      throw new GeminiTtsError(
        'Gemini Voices API client is unavailable on the configured SDK instance',
        503,
        false,
      );
    }
    return client.voices;
  }

  private async withRetries<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let lastError: GeminiTtsError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        const classified = classifyError(err, operation);
        lastError = classified;
        if (!classified.retryable || attempt >= this.maxRetries) {
          throw classified;
        }
        const delayMs = this.baseRetryDelayMs * Math.pow(2, attempt);
        await this.sleep(delayMs);
      }
    }
    throw lastError ?? new GeminiTtsError(`${operation} failed`, 502, false);
  }

  /**
   * Lists custom stored voices and prebuilt/Extended Voice Library catalog voices
   * via `client.voices.list(...)` (`GET /v1beta/voices`). Falls back to the 30 curated
   * prebuilt voices when no API key or injected SDK client is configured.
   */
  async listVoices(filter?: ListVoicesFilter): Promise<ListVoicesResult> {
    if (!this.client && !this.apiKey) {
      let voices = PREBUILT_VOICES.map((v) => ({ ...v }));
      if (filter?.type && filter.type.length > 0) {
        const allowed = new Set(filter.type.map((t) => t.toLowerCase()));
        voices = voices.filter((v) => allowed.has((v.type ?? 'prebuilt').toLowerCase()));
      }
      if (filter?.search) {
        const needle = filter.search.toLowerCase();
        voices = voices.filter(
          (v) =>
            v.id.toLowerCase().includes(needle) ||
            v.label.toLowerCase().includes(needle),
        );
      }
      if (filter?.pageSize && filter.pageSize > 0) {
        voices = voices.slice(0, filter.pageSize);
      }
      return { voices };
    }

    const voicesClient = this.getVoicesClient();
    const params: Record<string, unknown> = {};
    if (filter?.type?.length) params.type = filter.type;
    if (filter?.languageCode?.length) params.language_code = filter.languageCode;
    if (filter?.regionCode?.length) params.region_code = filter.regionCode;
    if (filter?.accent?.length) params.accent = filter.accent;
    if (filter?.gender?.length) params.gender = filter.gender;
    if (filter?.pitch?.length) params.pitch = filter.pitch;
    if (filter?.persona?.length) params.persona = filter.persona;
    if (filter?.contexts?.length) params.contexts = filter.contexts;
    if (filter?.search) params.search = filter.search;
    if (filter?.pageSize !== undefined) params.page_size = filter.pageSize;
    if (filter?.pageToken) params.page_token = filter.pageToken;

    const res = await this.withRetries('Gemini Voices list', () =>
      voicesClient.list(Object.keys(params).length > 0 ? params : undefined),
    );

    return {
      voices: (res.voices ?? []).map(mapGeminiVoiceOutput).filter((v) => v.id.length > 0),
      ...(res.next_page_token ? { nextPageToken: res.next_page_token } : {}),
    };
  }

  /**
   * Designs a new persistent custom voice (`voice_...`) or remixes an existing `baseVoice`
   * via `client.voices.create(...)` (`POST /v1beta/voices`).
   */
  async designVoice(req: DesignVoiceRequest): Promise<DesignVoiceResult> {
    if (req.store === false) {
      throw new GeminiTtsError(
        'Prompted voice design/remixing requires store=true (Gemini Voices API rejects store=false for prompted voices)',
        400,
        false,
      );
    }

    const voicesClient = this.getVoicesClient();
    const model = req.model ?? this.defaultModel;
    const prompted: Record<string, unknown> = {
      input: req.prompt,
    };
    if (req.baseVoice) {
      prompted.base_voice = req.baseVoice;
    }

    const voicePayload: Record<string, unknown> = {
      model,
      type: 'prompted',
      display_name: req.displayName,
      language_code: req.languageCode ?? 'en-US',
      prompted,
    };
    if (req.gender) voicePayload.gender = req.gender;
    if (req.description) voicePayload.description = req.description;
    if (req.regionCode) voicePayload.region_code = req.regionCode;
    if (req.accent) voicePayload.accent = req.accent;
    if (req.pitch) voicePayload.pitch = req.pitch;
    if (req.persona) voicePayload.persona = req.persona;
    if (req.context) voicePayload.context = req.context;

    const data = await this.withRetries('Gemini Voice design', () =>
      voicesClient.create({
        store: true,
        voice: voicePayload,
      }),
    );

    if (!data.id) {
      throw new GeminiTtsError('Gemini Voices API returned no voice ID', 502, false);
    }

    const sampleWavBuffer = decodeSampleAudio(data.sample_audio);

    return {
      voiceId: data.id,
      displayName: data.display_name ?? req.displayName,
      provider: this.name,
      model: data.model ?? model,
      type: data.type ?? 'prompted',
      ...(data.gender ?? req.gender ? { gender: data.gender ?? req.gender } : {}),
      ...(data.language_code ?? req.languageCode
        ? { languageCode: data.language_code ?? req.languageCode }
        : {}),
      ...(data.region_code ?? req.regionCode
        ? { regionCode: data.region_code ?? req.regionCode }
        : {}),
      ...(data.accent ?? req.accent ? { accent: data.accent ?? req.accent } : {}),
      ...(data.pitch ?? req.pitch ? { pitch: data.pitch ?? req.pitch } : {}),
      ...(data.persona ?? req.persona ? { persona: data.persona ?? req.persona } : {}),
      ...(data.context ?? req.context ? { context: data.context ?? req.context } : {}),
      ...(data.description ?? req.description
        ? { description: data.description ?? req.description }
        : {}),
      ...(data.prompted?.input ?? req.prompt
        ? { prompt: data.prompted?.input ?? req.prompt }
        : {}),
      ...(data.prompted?.base_voice ?? req.baseVoice
        ? { baseVoice: data.prompted?.base_voice ?? req.baseVoice }
        : {}),
      ...(data.expire_time ? { expireTime: data.expire_time } : {}),
      sampleWavBuffer,
    };
  }

  /**
   * Retrieves metadata and `sample_audio` preview (when available) for a custom stored voice
   * via `client.voices.get(id)` (`GET /v1beta/voices/{id}`).
   */
  async getVoice(voiceId: string): Promise<ProviderVoiceDetails> {
    const cleanId = normalizeVoiceResourceId(voiceId);
    if (!cleanId) {
      throw new GeminiTtsError('voiceId is required', 400, false);
    }
    const voicesClient = this.getVoicesClient();
    const data = await this.withRetries('Gemini Voices get', () =>
      voicesClient.get(cleanId),
    );
    const mapped = mapGeminiVoiceOutput({ ...data, id: data.id ?? cleanId });
    const sampleWavBuffer = decodeSampleAudio(data.sample_audio);
    return {
      ...mapped,
      provider: this.name,
      ...(sampleWavBuffer ? { sampleWavBuffer } : {}),
    };
  }

  /**
   * Permanently deletes a stored custom voice from the Gemini project via
   * `client.voices.delete(id)` (`DELETE /v1beta/voices/{id}`), freeing a quota slot.
   */
  async deleteVoice(voiceId: string): Promise<{ deleted: boolean; voiceId: string }> {
    const cleanId = normalizeVoiceResourceId(voiceId);
    if (!cleanId) {
      throw new GeminiTtsError('voiceId is required', 400, false);
    }
    const voicesClient = this.getVoicesClient();
    await this.withRetries('Gemini Voices delete', () =>
      voicesClient.delete(cleanId),
    );
    return { deleted: true, voiceId: cleanId };
  }

  async synthesize(req: SynthesizeRequest): Promise<SynthesizeResult> {
    const text = req.text.trim();
    if (!text) {
      throw new GeminiTtsError('Cannot synthesize empty cue text', 400, false);
    }

    const byteLen = Buffer.byteLength(text, 'utf8');
    if (byteLen > this.maxInputBytes) {
      throw new GeminiTtsError(
        `Cue text (${byteLen} UTF-8 bytes) exceeds max allowed size (${this.maxInputBytes} bytes). Split into smaller cues before rendering.`,
        400,
        false,
      );
    }

    const model = req.model ?? this.defaultModel;
    const direction = req.direction?.trim() || null;

    const textBlock: Record<string, unknown> = {
      type: 'text',
      text,
    };
    if (direction) {
      textBlock.annotations = [
        {
          type: 'speech_metadata',
          style: direction,
        },
      ];
    }

    const payload: Record<string, unknown> = {
      model,
      store: false,
      input: [
        {
          type: 'user_input',
          content: [textBlock],
        },
      ],
      response_format: {
        type: 'audio',
        mime_type: 'audio/wav',
      },
      generation_config: {
        speech_config: [{ voice: req.voiceId }],
      },
      safety_settings: SAFETY_CATEGORIES.map((type) => ({
        type,
        threshold: this.safetyThreshold,
      })),
    };

    const client = this.getClient();
    return this.withRetries('Gemini TTS synthesis', async () => {
      const interaction = await client.interactions.create(payload);

      // Extract audio payload from SDK sugar property or model_output step
      let audioBlock = interaction.output_audio;
      if (!audioBlock?.data && Array.isArray(interaction.steps)) {
        for (const step of interaction.steps) {
          if (step.type === 'model_output' && Array.isArray(step.content)) {
            const found = step.content.find(
              (c) => c.type === 'audio' && typeof c.data === 'string',
            );
            if (found) {
              audioBlock = found;
              break;
            }
          }
        }
      }

      if (!audioBlock?.data) {
        throw new GeminiTtsError(
          `Gemini TTS returned no audio payload (status: ${interaction.status ?? 'unknown'})`,
          502,
          true,
        );
      }

      const rawBytes = Buffer.from(audioBlock.data, 'base64');
      if (rawBytes.length === 0) {
        throw new GeminiTtsError('Gemini TTS returned empty audio buffer', 502, true);
      }

      const isRiffWav =
        rawBytes.length >= 12 &&
        rawBytes.toString('ascii', 0, 4) === 'RIFF' &&
        rawBytes.toString('ascii', 8, 12) === 'WAVE';

      const wavBuffer = isRiffWav
        ? rawBytes
        : wrapPcm16AsWav(
            rawBytes,
            audioBlock.rate ?? 24000,
            audioBlock.channels ?? 1,
          );

      // Strict RIFF/WAVE validation prevents saving truncated takes
      const wavInfo = validateWavBuffer(wavBuffer);

      return {
        wavBuffer,
        sampleRate: wavInfo.sampleRate,
        channels: wavInfo.channels,
        provider: this.name,
        model,
      };
    });
  }
}
