import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { GeminiDirectorReviewer } from '../src/director/gemini.js';
import { MockDirectorReviewer } from '../src/director/mock.js';
import {
  buildDirectorSystemInstruction,
  listDirectorPersonas,
  resolveDirectorPersona,
} from '../src/director/personas.js';
import { createMcpServer } from '../src/mcp/server.js';
import { GeminiTtsProvider } from '../src/providers/gemini.js';
import { validateWavBuffer, wrapPcm16AsWav } from '../src/providers/interface.js';
import { MockTtsProvider } from '../src/providers/mock.js';
import { StudioService } from '../src/studio/service.js';
import { ProjectStore } from '../src/studio/store.js';

function makeTinyWav(): Buffer {
  const pcm = Buffer.alloc(2400 * 2);
  for (let i = 0; i < 2400; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(i * 0.06) * 8000), i * 2);
  }
  return wrapPcm16AsWav(pcm, 24000, 1);
}

describe('Director Personas & System Instructions', () => {
  it('resolves built-in presets and custom persona prompts cleanly into system instructions', () => {
    const presets = listDirectorPersonas();
    expect(presets.map((p) => p.id)).toEqual(
      expect.arrayContaining(['default', 'intimate_sleep', 'audio_drama', 'audiobook']),
    );

    const sleepSys = buildDirectorSystemInstruction({
      persona: 'intimate_sleep',
      projectName: 'Midnight PMR',
      extraInstructions: 'Keep breaths ultra-soft.',
    });
    expect(sleepSys).toContain('## Director Persona');
    expect(sleepSys).toContain('progressive muscle relaxation');
    expect(sleepSys).toContain('Project: Midnight PMR');
    expect(sleepSys).toContain('Keep breaths ultra-soft.');

    const customPersona =
      'You are a gravelly 1940s noir radio play director who loves tense silences.';
    const resolved = resolveDirectorPersona(customPersona);
    expect(resolved.presetId).toBeNull();
    expect(resolved.instructions).toBe(customPersona);

    const customSys = buildDirectorSystemInstruction({ persona: customPersona });
    expect(customSys).toContain(`## Director Persona\n${customPersona}`);
  });
});

describe('GeminiDirectorReviewer & Gemini Voices Design API', () => {
  it('sends persona system_instruction + multimodal WAV audio and parses structured JSON verdict', async () => {
    const createMock = vi.fn().mockResolvedValue({
      status: 'completed',
      output_text: JSON.stringify({
        approved: false,
        score: 6,
        feedback: 'Opening word felt slightly rushed.',
        suggestedDirection: 'slower, warmer, softer whisper',
        suggestedText: null,
        suggestedMixPatch: { gainDb: -2, eqPreset: 'whisper' },
      }),
    });

    const reviewer = new GeminiDirectorReviewer({
      model: 'gemini-3.5-flash',
      client: { interactions: { create: createMock } },
    });

    const verdict = await reviewer.reviewTake({
      projectName: 'Sleep Demo',
      cue: {
        id: 'c1',
        speaker: 'mara',
        text: 'Let your shoulders drop.',
        direction: 'warm, gentle',
        timing: { offsetMs: 0 },
        mix: { gainDb: 0, pan: 0, eqPreset: 'intimate', fadeInMs: 20, fadeOutMs: 30 },
        activeTakeId: 't1',
        takes: [],
      },
      take: {
        id: 't1',
        provider: 'gemini',
        model: 'gemini-3.8-flash-tts',
        providerVoiceId: 'Sulafat',
        direction: 'warm, gentle',
        textHash: 'hash',
        audioPath: 'takes/t1.wav',
        durationMs: 2100,
        measuredLufs: -20.4,
        measuredRmsDbfs: -22.1,
        peakDbfs: -4.2,
        createdAt: new Date().toISOString(),
      },
      voiceLabel: 'Mara',
      wavBuffer: makeTinyWav(),
      persona: 'intimate_sleep',
      extraInstructions: 'Extra calm tonight.',
      attempt: 0,
      maxRetakes: 2,
      previousFeedback: [],
    });

    expect(verdict).toMatchObject({
      approved: false,
      score: 6,
      suggestedDirection: 'slower, warmer, softer whisper',
      suggestedMixPatch: { gainDb: -2, eqPreset: 'whisper' },
    });

    const payload = createMock.mock.calls[0]![0] as {
      system_instruction: string;
      input: Array<{ content: Array<{ type: string; mime_type?: string }> }>;
      response_format: { type: string; mime_type: string };
    };
    expect(payload.system_instruction).toContain('## Director Persona');
    expect(payload.system_instruction).toContain('Extra calm tonight.');
    expect(payload.input[0]!.content[1]).toMatchObject({
      type: 'audio',
      mime_type: 'audio/wav',
    });
    expect(payload.response_format).toMatchObject({
      type: 'text',
      mime_type: 'application/json',
    });
  });

  it('uses SDK client.voices.{create,list,get,delete} for voice design, remixing, filtering, and cleanup', async () => {
    const sampleWav = makeTinyWav();
    const voicesCreateMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Rate limited'), { status: 429 }))
      .mockResolvedValueOnce({
        id: 'voice_designed_001',
        type: 'prompted',
        display_name: 'Velvet Midnight',
        gender: 'female',
        language_code: 'en-US',
        description: 'Velvety late-night close-mic voice',
        model: 'gemini-3.8-flash-tts',
        expire_time: '2027-11-26T00:00:00Z',
        prompted: {
          input: 'Warm, intimate female voice in her late twenties with velvety close-mic presence.',
          base_voice: 'Sulafat',
        },
        sample_audio: { data: sampleWav.toString('base64'), mime_type: 'audio/wav' },
      });
    const voicesListMock = vi.fn().mockResolvedValue({
      voices: [
        {
          id: 'voice_designed_001',
          type: 'prompted',
          display_name: 'Velvet Midnight',
          gender: 'female',
          language_code: 'en-US',
          accent: 'American',
          pitch: 'low',
          persona: 'Warm, Intimate',
        },
      ],
      next_page_token: 'page_2',
    });
    const voicesGetMock = vi.fn().mockResolvedValue({
      id: 'voice_designed_001',
      type: 'prompted',
      display_name: 'Velvet Midnight',
      gender: 'female',
      language_code: 'en-US',
      sample_audio: { data: sampleWav.toString('base64'), mime_type: 'audio/wav' },
    });
    const voicesDeleteMock = vi.fn().mockResolvedValue({});

    const sleeps: number[] = [];
    const provider = new GeminiTtsProvider({
      client: {
        interactions: { create: vi.fn() },
        voices: {
          create: voicesCreateMock,
          list: voicesListMock,
          get: voicesGetMock,
          delete: voicesDeleteMock,
        },
      },
      maxRetries: 2,
      baseRetryDelayMs: 50,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    // Guardrail: prompted voices require store=true
    await expect(
      provider.designVoice({
        displayName: 'Invalid Stateless',
        prompt: 'Warm, intimate voice.',
        store: false,
      }),
    ).rejects.toMatchObject({ statusCode: 400, retryable: false });

    // Design + remix with gender/description + transient 429 retry
    const designed = await provider.designVoice({
      displayName: 'Velvet Midnight',
      prompt: 'Warm, intimate female voice in her late twenties with velvety close-mic presence.',
      description: 'Velvety late-night close-mic voice',
      gender: 'female',
      languageCode: 'en-US',
      baseVoice: 'Sulafat',
      store: true,
    });

    expect(voicesCreateMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([50]);
    expect(designed.voiceId).toBe('voice_designed_001');
    expect(designed.gender).toBe('female');
    expect(designed.baseVoice).toBe('Sulafat');
    expect(designed.expireTime).toBe('2027-11-26T00:00:00Z');
    expect(designed.sampleWavBuffer).toBeDefined();
    expect(validateWavBuffer(designed.sampleWavBuffer!).sampleRate).toBe(24000);

    expect(voicesCreateMock.mock.calls[0]![0]).toMatchObject({
      store: true,
      voice: {
        model: 'gemini-3.8-flash-tts',
        type: 'prompted',
        display_name: 'Velvet Midnight',
        gender: 'female',
        description: 'Velvety late-night close-mic voice',
        language_code: 'en-US',
        prompted: {
          base_voice: 'Sulafat',
        },
      },
    });

    // List with Extended Library & custom voice filters
    const listed = await provider.listVoices({
      type: ['prompted'],
      languageCode: ['en-US'],
      gender: ['female'],
      pitch: ['low'],
      search: 'Velvet',
      pageSize: 25,
    });
    expect(voicesListMock).toHaveBeenCalledWith({
      type: ['prompted'],
      language_code: ['en-US'],
      gender: ['female'],
      pitch: ['low'],
      search: 'Velvet',
      page_size: 25,
    });
    expect(listed.voices).toHaveLength(1);
    expect(listed.voices[0]!.id).toBe('voice_designed_001');
    expect(listed.nextPageToken).toBe('page_2');

    // Get strips optional voices/ prefix and validates sample_audio
    const details = await provider.getVoice('voices/voice_designed_001');
    expect(voicesGetMock).toHaveBeenCalledWith('voice_designed_001');
    expect(details.id).toBe('voice_designed_001');
    expect(details.sampleWavBuffer).toBeDefined();
    expect(validateWavBuffer(details.sampleWavBuffer!).sampleRate).toBe(24000);

    // Delete strips optional voices/ prefix
    const deleted = await provider.deleteVoice('voices/voice_designed_001');
    expect(voicesDeleteMock).toHaveBeenCalledWith('voice_designed_001');
    expect(deleted).toEqual({ deleted: true, voiceId: 'voice_designed_001' });
  });
});

describe("Director's Chair Loop & Voice Auditioning (Service, REST, MCP)", () => {
  let tempDataDir: string;
  let store: ProjectStore;

  beforeEach(async () => {
    tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thebooth-m4-'));
    store = new ProjectStore(tempDataDir);
    await store.ensureDataDirs();
  });

  afterEach(async () => {
    await fs.rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('runs bounded directed retakes, applies suggested direction & mix patch, and records review notes', async () => {
    const director = new MockDirectorReviewer({
      decide: (req) => {
        if (req.attempt === 0) {
          return {
            approved: false,
            score: 5.5,
            feedback: 'Too crisp; soften for sleep.',
            suggestedDirection: 'ultra-soft, slow, sleepy whisper',
          };
        }
        return {
          approved: true,
          score: 9.0,
          feedback: 'Gorgeous velvety delivery.',
          suggestedMixPatch: { gainDb: -3, eqPreset: 'whisper' },
        };
      },
    });

    const service = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
      director,
    });

    const proj = await service.createProject({ id: 'dir_loop', name: 'Director Loop' });
    const { cue } = await service.addCue(proj.id, {
      speaker: 'mara',
      text: 'Drift right off to sleep.',
      direction: 'warm, casual',
    });

    const result = await service.directCue(proj.id, cue.id, {
      persona: 'intimate_sleep',
      maxRetakes: 2,
    });

    expect(result.approved).toBe(true);
    expect(result.retakesUsed).toBe(1);
    expect(result.bestScore).toBe(9.0);
    expect(result.personaUsed).toBe('intimate_sleep');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1]!.directionUsed).toBe('ultra-soft, slow, sleepy whisper');

    const { project: loaded } = await service.getProject(proj.id);
    const updatedCue = loaded.cues[0]!;
    expect(updatedCue.takes).toHaveLength(2);
    expect(updatedCue.activeTakeId).toBe(result.selectedTakeId);
    expect(updatedCue.mix.gainDb).toBe(-3);
    expect(updatedCue.mix.eqPreset).toBe('whisper');
    expect(updatedCue.takes[0]!.notes).toContain('RETAKE');
    expect(updatedCue.takes[1]!.notes).toContain('APPROVED');
  });

  it('strictly enforces per-cue & project-wide retake caps and preserves the highest-scoring take when unapproved', async () => {
    const scores = [5.0, 7.2, 4.5];
    const director = new MockDirectorReviewer({
      decide: (req) => ({
        approved: false,
        score: scores[req.attempt] ?? 4.0,
        feedback: `Attempt ${req.attempt + 1} not quite there.`,
        suggestedDirection: `adjustment ${req.attempt + 1}`,
      }),
    });

    const service = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
      director,
    });

    const proj = await service.createProject({ id: 'cap_test', name: 'Cap Test' });
    const c1 = await service.addCue(proj.id, { speaker: 'mara', text: 'Cue one.' });
    const c2 = await service.addCue(proj.id, { speaker: 'mara', text: 'Cue two.' });

    // Direct cue 1 with maxRetakes=2 -> strictly 3 total takes, take #2 (score 7.2) must win!
    const res1 = await service.directCue(proj.id, c1.cue.id, { maxRetakes: 2 });
    expect(res1.approved).toBe(false);
    expect(res1.retakesUsed).toBe(2);
    expect(res1.attempts).toHaveLength(3);
    expect(res1.bestScore).toBe(7.2);
    expect(res1.selectedTakeId).toBe(res1.attempts[1]!.takeId);

    // Direct entire project with maxTotalRetakes=1 -> strictly caps total retakes across both cues
    const projRes = await service.directProject(proj.id, {
      cueIds: [c1.cue.id, c2.cue.id],
      maxRetakes: 2,
      maxTotalRetakes: 1,
    });
    expect(projRes.result.totalRetakesUsed).toBe(1);
  });

  it('exposes voice design, auditioning, casting, and Director personas over both REST and MCP', async () => {
    const service = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
      director: new MockDirectorReviewer({ approveOnAttempt: 0 }),
    });

    // --- REST checks ---
    const app = buildServer({ service });
    await app.ready();

    try {
      const personasRes = await app.inject({ method: 'GET', url: '/director/personas' });
      expect(personasRes.statusCode).toBe(200);
      expect(personasRes.json().personas.length).toBeGreaterThanOrEqual(4);

      const voicesRes = await app.inject({ method: 'GET', url: '/providers/mock/voices' });
      expect(voicesRes.statusCode).toBe(200);
      expect(voicesRes.json().voices.length).toBe(3);

      const designRes = await app.inject({
        method: 'POST',
        url: '/voices/design',
        payload: {
          provider: 'mock',
          displayName: 'Midnight Host',
          prompt: 'Warm, relaxed late-night radio voice with gentle timbre.',
          gender: 'female',
          languageCode: 'en-US',
          description: 'Velvety midnight studio host',
        },
      });
      expect(designRes.statusCode).toBe(201);
      const designJson = designRes.json();
      const designedVoiceId = designJson.voiceId as string;
      expect(designJson.gender).toBe('female');
      expect(designJson.previewAudioAvailable).toBe(true);
      expect(designJson.previewAudioUrl).toBe(`/providers/mock/voices/${designedVoiceId}/preview`);
      // Raw base64 is omitted from JSON unless explicitly requested
      expect(designJson.sampleAudioBase64).toBeUndefined();

      // Reject store=false for prompted voice design
      const badStoreRes = await app.inject({
        method: 'POST',
        url: '/voices/design',
        payload: {
          provider: 'mock',
          displayName: 'Bad Stateless',
          prompt: 'Should reject store=false cleanly.',
          store: false,
        },
      });
      expect(badStoreRes.statusCode).toBe(400);

      // Stream designed voice preview WAV over REST
      const previewRes = await app.inject({
        method: 'GET',
        url: `/providers/mock/voices/${designedVoiceId}/preview`,
      });
      expect(previewRes.statusCode).toBe(200);
      expect(previewRes.headers['content-type']).toBe('audio/wav');
      expect(validateWavBuffer(previewRes.rawPayload).sampleRate).toBe(24000);

      // Filter provider voices & inspect stored voice over REST
      const filteredRes = await app.inject({
        method: 'GET',
        url: '/providers/mock/voices?type=prompted&gender=female',
      });
      expect(filteredRes.statusCode).toBe(200);
      expect(filteredRes.json().voices.map((v: { id: string }) => v.id)).toEqual([
        designedVoiceId,
      ]);

      const getVoiceRes = await app.inject({
        method: 'GET',
        url: `/providers/mock/voices/${designedVoiceId}`,
      });
      expect(getVoiceRes.statusCode).toBe(200);
      expect(getVoiceRes.json()).toMatchObject({
        id: designedVoiceId,
        displayName: 'Midnight Host',
        previewAudioAvailable: true,
      });

      await app.inject({
        method: 'POST',
        url: '/projects',
        payload: { id: 'casting_proj', name: 'Casting Project' },
      });

      const audRes = await app.inject({
        method: 'POST',
        url: '/projects/casting_proj/voices/mara/audition',
        payload: {
          candidateVoiceIds: ['mock_mara', designedVoiceId],
          sampleText: 'Good evening, welcome into the booth.',
        },
      });
      expect(audRes.statusCode).toBe(201);
      const auditions = audRes.json().auditions as Array<{
        id: string;
        providerVoiceId: string;
      }>;
      expect(auditions).toHaveLength(2);

      // Stream audition WAV
      const audAudio = await app.inject({
        method: 'GET',
        url: `/projects/casting_proj/voices/mara/auditions/${auditions[1]!.id}/audio`,
      });
      expect(audAudio.statusCode).toBe(200);
      expect(audAudio.headers['content-type']).toBe('audio/wav');
      expect(validateWavBuffer(audAudio.rawPayload).sampleRate).toBe(24000);

      // Select designed voice audition as cast voice
      const selRes = await app.inject({
        method: 'POST',
        url: `/projects/casting_proj/voices/mara/auditions/${auditions[1]!.id}/select`,
      });
      expect(selRes.statusCode).toBe(200);
      expect(selRes.json().voice.providerVoiceId).toBe(designedVoiceId);

      // Add a cue and run Director over REST with custom persona
      const cueRes = await app.inject({
        method: 'POST',
        url: '/projects/casting_proj/cues',
        payload: { id: 'c1', speaker: 'mara', text: 'Settle in tonight.' },
      });
      expect(cueRes.statusCode).toBe(201);

      const directRes = await app.inject({
        method: 'POST',
        url: '/projects/casting_proj/cues/c1/direct',
        payload: {
          persona: 'Cozy late-night fireside storyteller persona.',
          maxRetakes: 1,
        },
      });
      expect(directRes.statusCode).toBe(200);
      expect(directRes.json()).toMatchObject({
        approved: true,
        personaUsed: 'Custom Persona',
      });
    } finally {
      await app.close();
    }

    // --- MCP checks ---
    const mcpServer = createMcpServer(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'test-m4-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'booth_list_provider_voices',
          'booth_design_voice',
          'booth_get_provider_voice',
          'booth_delete_provider_voice',
          'booth_audition_voice',
          'booth_get_audition_audio',
          'booth_select_audition',
          'booth_list_director_personas',
          'booth_direct_cue',
          'booth_direct_project',
        ]),
      );

      // MCP booth_design_voice returns clean JSON text (NO raw base64) + inline MCP audio block
      const mcpDesign = await client.callTool({
        name: 'booth_design_voice',
        arguments: {
          provider: 'mock',
          displayName: 'Margaux Custom',
          prompt: 'Sharp, warm, gravelly Parisian film director in her sixties.',
          gender: 'female',
          languageCode: 'en-GB',
        },
      });
      expect(mcpDesign.isError).not.toBe(true);
      const designBlocks = mcpDesign.content as Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
      const designTextBlock = designBlocks.find((b) => b.type === 'text');
      const designAudioBlock = designBlocks.find((b) => b.type === 'audio');
      expect(designTextBlock?.text).toBeDefined();
      expect(designTextBlock!.text).not.toContain('sampleAudioBase64');
      const designMeta = JSON.parse(designTextBlock!.text!) as {
        voiceId: string;
        inlineAudioIncluded: boolean;
        previewAudioPath: string;
      };
      expect(designMeta.inlineAudioIncluded).toBe(true);
      expect(designMeta.previewAudioPath).toContain(designMeta.voiceId);
      expect(designAudioBlock?.mimeType).toBe('audio/wav');
      expect(validateWavBuffer(Buffer.from(designAudioBlock!.data!, 'base64')).sampleRate).toBe(
        24000,
      );

      // MCP booth_get_provider_voice returns metadata + inline audio block
      const mcpGetVoice = await client.callTool({
        name: 'booth_get_provider_voice',
        arguments: {
          provider: 'mock',
          voiceId: designMeta.voiceId,
        },
      });
      expect(mcpGetVoice.isError).not.toBe(true);
      const getBlocks = mcpGetVoice.content as Array<{
        type: string;
        data?: string;
        mimeType?: string;
      }>;
      expect(getBlocks.find((b) => b.type === 'audio')?.mimeType).toBe('audio/wav');

      // MCP booth_list_provider_voices filters custom voices
      const mcpListVoices = await client.callTool({
        name: 'booth_list_provider_voices',
        arguments: {
          provider: 'mock',
          type: ['prompted'],
          search: 'Margaux',
        },
      });
      expect(mcpListVoices.isError).not.toBe(true);
      const listJson = JSON.parse(
        (mcpListVoices.content as Array<{ type: string; text?: string }>)[0]!.text!,
      ) as { voices: Array<{ id: string }> };
      expect(listJson.voices.map((v) => v.id)).toContain(designMeta.voiceId);

      // MCP booth_delete_provider_voice removes the voice & local preview
      const mcpDelVoice = await client.callTool({
        name: 'booth_delete_provider_voice',
        arguments: {
          provider: 'mock',
          voiceId: designMeta.voiceId,
        },
      });
      expect(mcpDelVoice.isError).not.toBe(true);
      const delJson = JSON.parse(
        (mcpDelVoice.content as Array<{ type: string; text?: string }>)[0]!.text!,
      ) as { deleted: boolean; voiceId: string };
      expect(delJson).toMatchObject({ deleted: true, voiceId: designMeta.voiceId });

      const mcpDirect = await client.callTool({
        name: 'booth_direct_project',
        arguments: {
          projectId: 'casting_proj',
          persona: 'intimate_sleep',
          wait: true,
        },
      });
      expect(mcpDirect.isError).not.toBe(true);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });
});
