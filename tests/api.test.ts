import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { validateWavBuffer, wrapPcm16AsWav } from '../src/providers/interface.js';
import { MockTtsProvider } from '../src/providers/mock.js';
import { StudioService } from '../src/studio/service.js';
import { ProjectStore } from '../src/studio/store.js';

function makeAssetWav(durationMs = 500, sampleRate = 48000): Buffer {
  const n = Math.round((durationMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(i * 0.04) * 5000), i * 2);
  }
  return wrapPcm16AsWav(pcm, sampleRate, 1);
}

describe('The Booth REST API (Milestone 2)', () => {
  let tempDataDir: string;
  let store: ProjectStore;
  let service: StudioService;
  let app: FastifyInstance;

  beforeEach(async () => {
    tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thebooth-api-'));
    store = new ProjectStore(tempDataDir);
    await store.ensureDataDirs();
    service = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
    });
    app = buildServer({ service });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('executes the full studio REST lifecycle: project -> voices -> import -> async render-all -> audio stream -> mix -> export stream', async () => {
    // 1. Health check
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', service: 'the-booth' });

    // 2. Create project
    const created = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { id: 'pmr_night', name: 'PMR Night Session', audio: { tailMs: 500 } },
    });
    expect(created.statusCode).toBe(201);
    const proj = created.json();
    expect(proj.id).toBe('pmr_night');
    expect(proj.beds).toHaveLength(1); // default room tone initialized

    // 3. List projects
    const listed = await app.inject({ method: 'GET', url: '/projects' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().projects).toHaveLength(1);

    // 4. Register voice
    const voiceRes = await app.inject({
      method: 'PUT',
      url: '/projects/pmr_night/voices/mara',
      payload: {
        label: 'Mara',
        provider: 'mock',
        providerVoiceId: 'mock_mara',
        defaultDirection: 'warm, gentle',
        defaultEqPreset: 'intimate',
      },
    });
    expect(voiceRes.statusCode).toBe(200);
    expect(voiceRes.json().voices.mara.label).toBe('Mara');

    // 5. Import script
    const importRes = await app.inject({
      method: 'POST',
      url: '/projects/pmr_night/import-script',
      payload: {
        mode: 'replace',
        script: `
[[voice:mara]]
[[dir:warm, unhurried]]
[[eq:intimate]]

Welcome in. <short pause> Take a slow breath in.

[[pause:1.5]]
[[pan:-0.6]]
[[gain:-3dB]]

Let your shoulders drop all the way down.
`,
      },
    });
    expect(importRes.statusCode).toBe(200);
    const imported = importRes.json();
    expect(imported.importedCueCount).toBe(2);
    const cue1Id = imported.project.cues[0].id as string;

    // 6. Render single cue explicitly (with activate: true)
    const singleRender = await app.inject({
      method: 'POST',
      url: `/projects/pmr_night/cues/${cue1Id}/render`,
      payload: { activate: true },
    });
    expect(singleRender.statusCode).toBe(201);
    const take1Id = singleRender.json().take.id as string;

    // 7. Stream immutable raw take WAV for ear review
    const takeAudioRes = await app.inject({
      method: 'GET',
      url: `/projects/pmr_night/cues/${cue1Id}/takes/${take1Id}/audio`,
    });
    expect(takeAudioRes.statusCode).toBe(200);
    expect(takeAudioRes.headers['content-type']).toBe('audio/wav');
    const wavInfo = validateWavBuffer(takeAudioRes.rawPayload);
    expect(wavInfo.sampleRate).toBe(24000);

    // 8. Async render-all (should only render remaining cue #2!)
    const renderAllRes = await app.inject({
      method: 'POST',
      url: '/projects/pmr_night/render-all',
      payload: { concurrency: 2 },
    });
    expect(renderAllRes.statusCode).toBe(202);
    const { jobId } = renderAllRes.json();
    expect(jobId).toMatch(/^job_/);

    // Poll GET /jobs/:jobId until completed
    let jobState: { status: string; total: number; completed: number; failed: number };
    const deadline = Date.now() + 10000;
    while (true) {
      const poll = await app.inject({ method: 'GET', url: `/jobs/${jobId}` });
      expect(poll.statusCode).toBe(200);
      jobState = poll.json();
      if (jobState.status === 'completed' || jobState.status === 'failed') break;
      if (Date.now() > deadline) throw new Error('Timed out waiting for render-all job');
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(jobState.status).toBe('completed');
    expect(jobState.total).toBe(1);
    expect(jobState.completed).toBe(1);

    // 9. GET /projects/:id returns manifest + resolved timeline
    const fetched = await app.inject({ method: 'GET', url: '/projects/pmr_night' });
    expect(fetched.statusCode).toBe(200);
    const { project: fullProject, timeline } = fetched.json();
    expect(fullProject.cues).toHaveLength(2);
    expect(timeline.cues[1].startMs).toBeGreaterThan(timeline.cues[0].endMs + 1000);

    // 10. Stage-2 mix to OGG + stream finished master
    const mixRes = await app.inject({
      method: 'POST',
      url: '/projects/pmr_night/mix',
      payload: { format: 'ogg' },
    });
    expect(mixRes.statusCode).toBe(200);
    const { export: exp, telemetry } = mixRes.json();
    expect(exp.format).toBe('ogg');
    expect(telemetry.renderedCueCount).toBe(2);

    const exportAudioRes = await app.inject({
      method: 'GET',
      url: `/projects/pmr_night/exports/${exp.id}/audio`,
    });
    expect(exportAudioRes.statusCode).toBe(200);
    expect(exportAudioRes.headers['content-type']).toBe('audio/ogg');
    // OggS magic header
    expect(exportAudioRes.rawPayload.subarray(0, 4).toString('ascii')).toBe('OggS');
  });

  it('handles cue/bed/sfx CRUD, safe cue deletion re-anchoring, and clean 400/404 errors', async () => {
    await fs.writeFile(path.join(store.assetsDir, 'chime.wav'), makeAssetWav(400));

    await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { id: 'crud_test', name: 'CRUD Test' },
    });

    // Add 3 cues
    const c1 = (
      await app.inject({
        method: 'POST',
        url: '/projects/crud_test/cues',
        payload: { id: 'c1', speaker: 'mara', text: 'One.' },
      })
    ).json().cue;
    const c2 = (
      await app.inject({
        method: 'POST',
        url: '/projects/crud_test/cues',
        payload: {
          id: 'c2',
          speaker: 'mara',
          text: 'Two.',
          timing: { afterCueId: c1.id, offsetMs: 500 },
        },
      })
    ).json().cue;
    await app.inject({
      method: 'POST',
      url: '/projects/crud_test/cues',
      payload: {
        id: 'c3',
        speaker: 'mara',
        text: 'Three.',
        timing: { afterCueId: c2.id, offsetMs: 250 },
      },
    });

    // Cyclic update must return 400
    const cycleRes = await app.inject({
      method: 'PATCH',
      url: '/projects/crud_test/cues/c1',
      payload: { timing: { afterCueId: 'c3' } },
    });
    expect(cycleRes.statusCode).toBe(400);

    // Delete middle cue c2 -> c3 safely re-anchors to c1
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/projects/crud_test/cues/c2',
    });
    expect(delRes.statusCode).toBe(200);
    const remainingC3 = delRes.json().cues.find((c: { id: string }) => c.id === 'c3');
    expect(remainingC3.timing.afterCueId).toBe('c1');

    // Upsert & delete bed + SFX
    const bedRes = await app.inject({
      method: 'PUT',
      url: '/projects/crud_test/beds/soft_room',
      payload: {
        label: 'Soft Pink',
        kind: 'synthetic_room_tone',
        roomToneStyle: 'soft_pink',
        gainDb: -52,
      },
    });
    expect(bedRes.statusCode).toBe(200);

    const sfxRes = await app.inject({
      method: 'PUT',
      url: '/projects/crud_test/sfx/chime_1',
      payload: {
        label: 'Chime',
        assetPath: 'chime.wav',
        anchor: { cueId: 'c1', edge: 'end', offsetMs: 100 },
      },
    });
    expect(sfxRes.statusCode).toBe(200);

    const delSfx = await app.inject({
      method: 'DELETE',
      url: '/projects/crud_test/sfx/chime_1',
    });
    expect(delSfx.statusCode).toBe(200);
    expect(delSfx.json().sfx).toHaveLength(0);

    // 404 on unknown project & unknown job
    expect((await app.inject({ method: 'GET', url: '/projects/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/jobs/job_missing' })).statusCode).toBe(404);

    // 400 validation error on bad payload
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/projects',
          payload: { name: '' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('supports shared asset library upload (JSON base64 + raw binary), listing, validation, and deletion', async () => {
    const wav = makeAssetWav(600);

    // Upload via JSON base64 POST /assets
    const postRes = await app.inject({
      method: 'POST',
      url: '/assets',
      payload: {
        assetPath: 'foley/tea_cup.wav',
        dataBase64: wav.toString('base64'),
      },
    });
    expect(postRes.statusCode).toBe(201);
    expect(postRes.json()).toMatchObject({
      path: 'foley/tea_cup.wav',
      sampleRate: 48000,
      channels: 1,
    });

    // Upload via raw binary PUT /assets/*
    const putRes = await app.inject({
      method: 'PUT',
      url: '/assets/rain_soft.wav',
      headers: { 'content-type': 'audio/wav' },
      payload: wav,
    });
    expect(putRes.statusCode).toBe(201);
    expect(putRes.json().path).toBe('rain_soft.wav');

    // List assets
    const listRes = await app.inject({ method: 'GET', url: '/assets' });
    expect(listRes.statusCode).toBe(200);
    const paths = listRes.json().assets.map((a: { path: string }) => a.path);
    expect(paths).toEqual(['foley/tea_cup.wav', 'rain_soft.wav']);

    // Reject corrupt non-audio payload & path traversal
    const badAudio = await app.inject({
      method: 'POST',
      url: '/assets',
      payload: {
        assetPath: 'broken.wav',
        dataBase64: Buffer.from('not a real wav').toString('base64'),
      },
    });
    expect(badAudio.statusCode).toBe(400);

    const traversal = await app.inject({
      method: 'POST',
      url: '/assets',
      payload: {
        assetPath: '../outside.wav',
        dataBase64: wav.toString('base64'),
      },
    });
    expect(traversal.statusCode).toBe(400);

    // Delete asset
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/assets/foley/tea_cup.wav',
    });
    expect(delRes.statusCode).toBe(204);

    const listAfter = await app.inject({ method: 'GET', url: '/assets' });
    expect(listAfter.json().assets.map((a: { path: string }) => a.path)).toEqual([
      'rain_soft.wav',
    ]);
  });
});
