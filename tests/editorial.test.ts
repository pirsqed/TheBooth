import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/api/server.js';
import { probeAudio } from '../src/audio/ffmpeg.js';
import { resolveTimeline } from '../src/audio/timeline.js';
import { MockDirectorReviewer } from '../src/director/mock.js';
import { createMcpServer } from '../src/mcp/server.js';
import { MockTtsProvider } from '../src/providers/mock.js';
import { StudioService } from '../src/studio/service.js';
import { ProjectStore } from '../src/studio/store.js';

describe('Editorial & Cross-Host Collaboration Features (Moments, Split Cue, A/B Reels)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function setupScene() {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'the-booth-editorial-'));
    tempDirs.push(tmp);
    const store = new ProjectStore(path.join(tmp, 'data'));
    const mock = new MockTtsProvider();
    const director = new MockDirectorReviewer({ approveOnAttempt: 1 });
    const service = new StudioService({
      store,
      providers: { mock, gemini: mock },
      defaultProvider: 'mock',
      director,
    });

    const project = await service.createProject({ name: 'Dracula Mirror Scene' });
    await service.upsertVoice(project.id, 'dracula', {
      label: 'Count Dracula',
      provider: 'mock',
      providerVoiceId: 'mock_dracula',
      defaultPan: 0.45,
      defaultEqPreset: 'intimate',
    });
    await service.upsertVoice(project.id, 'harker', {
      label: 'Jonathan Harker',
      provider: 'mock',
      providerVoiceId: 'mock_harker',
      defaultPan: -0.35,
      defaultEqPreset: 'intimate',
    });

    await service.importScript(project.id, {
      mode: 'replace',
      script: [
        '[[voice:dracula]] [[pan:0.45]] You seem restless, Mr. Harker.',
        '[[overlap:150]]',
        '[[voice:harker]] [[pan:-0.35]] I started when I saw the glass. It was blank.',
        '[[pause:500]]',
        '[[voice:dracula]] [[pan:0.45]] Take care how you cut yourself.',
      ].join('\n'),
    });

    await service.renderAll(project.id);
    const updated = await store.requireProject(project.id);
    return { tmp, store, service, project: updated };
  }

  it('returns Director timestamped moments & decision-first summary and hides /10 scores by default over MCP', async () => {
    const { service, project } = await setupScene();
    const harkerCue = project.cues[1]!;

    // Service returns observation, changeSummary, and moments[]
    const directRes = await service.directCue(project.id, harkerCue.id, {
      persona: 'audio_drama',
      maxRetakes: 2,
    });
    expect(directRes.approved).toBe(true);
    expect(directRes.retakesUsed).toBe(1);
    expect(directRes.observation).toBeTruthy();
    expect(directRes.changeSummary).toMatch(/1 retake/i);
    expect(directRes.moments.length).toBeGreaterThan(0);
    expect(typeof directRes.moments[0]!.timestampSec).toBe('number');
    expect(directRes.moments[0]!.note).toBeTruthy();

    // MCP hides numeric scores by default unless includeScores=true
    const mcpServer = createMcpServer(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'astra-director-test', version: '0.1.0' });
    await client.connect(clientTransport);
    try {
      const rDefault = await client.callTool({
        name: 'booth_direct_cue',
        arguments: { projectId: project.id, cueId: project.cues[0]!.id, maxRetakes: 1 },
      });
      const defaultJson = JSON.parse(
        ((rDefault.content as Array<{ type: string; text?: string }>)[0]!.text)!,
      ) as Record<string, unknown>;
      expect(defaultJson.observation).toBeTruthy();
      expect(defaultJson.changeSummary).toBeTruthy();
      expect(Array.isArray(defaultJson.moments)).toBe(true);
      expect('bestScore' in defaultJson).toBe(false);
      const attempts = defaultJson.attempts as Array<{ verdict: Record<string, unknown> }>;
      expect('score' in attempts[0]!.verdict).toBe(false);

      const rScores = await client.callTool({
        name: 'booth_direct_cue',
        arguments: {
          projectId: project.id,
          cueId: project.cues[2]!.id,
          maxRetakes: 0,
          includeScores: true,
        },
      });
      const scoredJson = JSON.parse(
        ((rScores.content as Array<{ type: string; text?: string }>)[0]!.text)!,
      ) as Record<string, unknown>;
      expect(typeof scoredJson.bestScore).toBe('number');
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it('non-destructively splits a rendered cue at playhead without re-synthesizing and shifts downstream timing cleanly', async () => {
    const { store, service, project } = await setupScene();
    const harkerCue = project.cues[1]!;
    const rawTake = harkerCue.takes.find((t) => t.id === harkerCue.activeTakeId)!;
    const beforeTimeline = resolveTimeline(project);

    const splitAtMs = Math.round(rawTake.durationMs * 0.5);
    const gapMs = 650;
    const split = await service.splitCue(project.id, harkerCue.id, {
      atMs: splitAtMs,
      gapMs,
      textBefore: 'I started when I saw the glass.',
      textAfter: 'It was blank.',
    });

    // Both halves share the exact same immutable raw take WAV
    expect(split.firstCue.activeTakeId).toBe(rawTake.id);
    expect(split.secondCue.activeTakeId).toBe(rawTake.id);
    expect(split.firstCue.mix.trim).toEqual({ startMs: 0, endMs: splitAtMs });
    expect(split.secondCue.mix.trim).toEqual({
      startMs: splitAtMs,
      endMs: Math.round(rawTake.durationMs),
    });
    expect(split.secondCue.timing).toEqual({
      afterCueId: split.firstCue.id,
      offsetMs: gapMs,
    });

    // Total timeline grew by exact gapMs
    const afterProject = await store.requireProject(project.id);
    expect(afterProject.cues.length).toBe(4);
    const afterTimeline = resolveTimeline(afterProject);
    expect(afterTimeline.totalDurationMs - beforeTimeline.totalDurationMs).toBe(gapMs);

    // Stage-2 mixdown renders cleanly with non-destructive atrim
    const { exportRecord } = await service.mixProject(project.id, { format: 'wav' });
    const wavPath = store.resolveProjectFile(project.id, exportRecord.audioPath);
    const probe = await probeAudio(wavPath);
    expect(probe.channels).toBe(2);
    expect(Math.abs(probe.durationMs - afterTimeline.totalDurationMs)).toBeLessThan(120);
  });

  it('generates labeled A/B casting reels, selects by "A"/"B", and renders in-context take A/B reels', async () => {
    const { tmp, service, project } = await setupScene();
    const outDir = path.join(tmp, 'shared_reels');

    // 1) Audition 2 candidates -> auto-generates labeled A/B casting reel delivered to workspace
    const castReelDest = path.join(outDir, 'harker_casting_ab.ogg');
    const audRes = await service.auditionVoice(project.id, 'harker', {
      candidateVoiceIds: ['mock_harker_a', 'mock_harker_b'],
      sampleText: 'I started when I saw the glass.',
      reelOutputPath: castReelDest,
    });
    expect(audRes.auditions.map((a) => a.label)).toEqual(['A', 'B']);
    expect(audRes.reel).toBeDefined();
    expect(audRes.reel!.deliveredPath).toBe(path.resolve(castReelDest));
    expect(audRes.reel!.entries.map((e) => e.label)).toEqual(['A', 'B']);
    const castProbe = await probeAudio(audRes.reel!.deliveredPath!);
    expect(castProbe.codecName).toBe('opus');
    expect(castProbe.channels).toBe(2);

    // 2) Select candidate directly by friendly label "B"
    const casted = await service.selectAudition(project.id, 'harker', 'B');
    expect(casted.providerVoiceId).toBe('mock_harker_b');

    // 3) Render a second take on Harker's cue, then generate an IN-CONTEXT A/B comparison reel
    const harkerCue = project.cues[1]!;
    await service.renderTake(project.id, harkerCue.id, { activate: true });

    const abDest = path.join(outDir, 'harker_razor_ab.wav');
    const abReel = await service.renderTakeComparisonReel(project.id, harkerCue.id, {
      contextBeforeCues: 1,
      contextAfterCues: 0,
      outputPath: abDest,
    });
    expect(abReel.contextCueIds).toEqual([project.cues[0]!.id, harkerCue.id]);
    expect(abReel.entries.map((e) => e.label)).toEqual(['A', 'B']);
    expect(abReel.entries[1]!.startSec).toBeGreaterThan(abReel.entries[0]!.endSec);
    expect(abReel.deliveredPath).toBe(path.resolve(abDest));
    const abProbe = await probeAudio(abReel.deliveredPath!);
    expect(abProbe.codecName).toBe('pcm_s16le');
    expect(abProbe.channels).toBe(2);

    // 4) Verify REST & MCP exposure for split + A/B reel
    const app = await buildServer({ service });
    try {
      const restAb = await app.inject({
        method: 'POST',
        url: `/projects/${project.id}/cues/${harkerCue.id}/ab-reel`,
        payload: { contextBeforeCues: 1, format: 'ogg' },
      });
      expect(restAb.statusCode).toBe(201);
      const body = restAb.json() as { entries: Array<{ label: string }> };
      expect(body.entries.map((e) => e.label)).toEqual(['A', 'B']);
    } finally {
      await app.close();
    }

    const mcpServer = createMcpServer(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'astra-reel-test', version: '0.1.0' });
    await client.connect(clientTransport);
    try {
      const mcpAb = await client.callTool({
        name: 'booth_render_ab_reel',
        arguments: {
          projectId: project.id,
          cueId: harkerCue.id,
          contextBeforeCues: 1,
          format: 'ogg',
        },
      });
      expect(mcpAb.isError).not.toBe(true);
      const blocks = mcpAb.content as Array<{ type: string; mimeType?: string }>;
      expect(blocks[0]?.type).toBe('text');
      expect(blocks[1]?.type).toBe('audio');
      expect(blocks[1]?.mimeType).toBe('audio/ogg');
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });
});
