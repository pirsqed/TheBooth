import { describe, expect, it, vi } from 'vitest';
import {
  GeminiInteractionsClient,
  GeminiTtsError,
  GeminiTtsProvider,
} from '../src/providers/gemini.js';
import { validateWavBuffer, wrapPcm16AsWav } from '../src/providers/interface.js';

function makeSampleWav(samples = 2400): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(i * 0.08) * 12000), i * 2);
  }
  return wrapPcm16AsWav(pcm, 24000, 1);
}

describe('GeminiTtsProvider (v1beta Interactions API)', () => {
  it('sends direction strictly via speech_metadata annotations and validates returned WAV', async () => {
    const sampleWav = makeSampleWav();
    const createMock = vi.fn().mockResolvedValue({
      id: 'int_123',
      status: 'completed',
      output_audio: {
        data: sampleWav.toString('base64'),
        mime_type: 'audio/wav',
      },
    });
    const fakeClient: GeminiInteractionsClient = {
      interactions: { create: createMock },
    };

    const provider = new GeminiTtsProvider({
      client: fakeClient,
      defaultModel: 'gemini-3.8-flash-tts',
      safetyThreshold: 'block_none',
    });

    const result = await provider.synthesize({
      text: 'Take a slow breath. <short pause> Tonight, let everything settle.',
      voiceId: 'voice_custom_sample01',
      direction: 'warm, unhurried, gentle, intimate',
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const payload = createMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: 'gemini-3.8-flash-tts',
      store: false,
      response_format: {
        type: 'audio',
        mime_type: 'audio/wav',
      },
      generation_config: {
        speech_config: [{ voice: 'voice_custom_sample01' }],
      },
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: 'Take a slow breath. <short pause> Tonight, let everything settle.',
              annotations: [
                {
                  type: 'speech_metadata',
                  style: 'warm, unhurried, gentle, intimate',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(payload.safety_settings).toEqual([
      { type: 'hate_speech', threshold: 'off' },
      { type: 'harassment', threshold: 'off' },
      { type: 'sexually_explicit', threshold: 'off' },
      { type: 'dangerous_content', threshold: 'off' },
    ]);

    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('gemini-3.8-flash-tts');
    expect(result.sampleRate).toBe(24000);
    expect(result.channels).toBe(1);
    expect(validateWavBuffer(result.wavBuffer).dataSize).toBe(4800);
  });

  it('omits annotations when direction is null and wraps raw PCM from steps fallback cleanly', async () => {
    const rawPcm = Buffer.alloc(4800);
    const createMock = vi.fn().mockResolvedValue({
      id: 'int_pcm',
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [
            {
              type: 'audio',
              data: rawPcm.toString('base64'),
              mime_type: 'audio/l16',
              rate: 24000,
              channels: 1,
            },
          ],
        },
      ],
    });

    const provider = new GeminiTtsProvider({
      client: { interactions: { create: createMock } },
    });

    const result = await provider.synthesize({
      text: 'Clean plain line.',
      voiceId: 'Kore',
      direction: null,
    });

    const payload = createMock.mock.calls[0]![0] as {
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(payload.input[0]!.content[0]).toEqual({
      type: 'text',
      text: 'Clean plain line.',
    });
    expect(result.wavBuffer.toString('ascii', 0, 4)).toBe('RIFF');
    expect(validateWavBuffer(result.wavBuffer).sampleRate).toBe(24000);
  });

  it('retries transient 429/503 errors with bounded backoff and fails fast on 400 length limits', async () => {
    const sampleWav = makeSampleWav();
    const sleeps: number[] = [];
    const createMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Rate limit'), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { status: 503 }))
      .mockResolvedValueOnce({
        status: 'completed',
        output_audio: { data: sampleWav.toString('base64') },
      });

    const provider = new GeminiTtsProvider({
      client: { interactions: { create: createMock } },
      maxRetries: 3,
      baseRetryDelayMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const res = await provider.synthesize({ text: 'Retry test.', voiceId: 'Sulafat' });
    expect(res.sampleRate).toBe(24000);
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);

    // Non-retryable 400 length limit error should NOT retry
    const lengthMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Input token length exceeds limit'), { status: 400 }));
    const failProvider = new GeminiTtsProvider({
      client: { interactions: { create: lengthMock } },
      maxRetries: 3,
      sleep: async () => {},
    });

    await expect(
      failProvider.synthesize({ text: 'Too long.', voiceId: 'Sulafat' }),
    ).rejects.toMatchObject({
      name: 'GeminiTtsError',
      statusCode: 400,
      retryable: false,
    });
    expect(lengthMock).toHaveBeenCalledTimes(1);
  });

  it('rejects truncated WAV payloads instead of saving corrupt audio', async () => {
    const validWav = makeSampleWav(1000);
    const truncated = validWav.subarray(0, validWav.length - 200);
    const provider = new GeminiTtsProvider({
      client: {
        interactions: {
          create: vi.fn().mockResolvedValue({
            status: 'completed',
            output_audio: { data: truncated.toString('base64') },
          }),
        },
      },
      maxRetries: 0,
    });

    await expect(
      provider.synthesize({ text: 'Truncated test.', voiceId: 'Kore' }),
    ).rejects.toThrow(GeminiTtsError);
  });
});
