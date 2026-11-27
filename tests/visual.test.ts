import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/api/server.js';
import { createMcpServer } from '../src/mcp/server.js';
import { wrapPcm16AsWav } from '../src/providers/interface.js';
import { MockTtsProvider } from '../src/providers/mock.js';
import { StudioService } from '../src/studio/service.js';
import { ProjectStore } from '../src/studio/store.js';

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).equals(PNG_SIG)).toBe(true);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

describe('Visual-Audio Inspection (booth_inspect_visual)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function setupStudio() {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'the-booth-visual-'));
    tempDirs.push(tmp);
    const store = new ProjectStore(tmp);
    const mock = new MockTtsProvider();
    const service = new StudioService({
      store,
      providers: { mock, gemini: mock },
      defaultProvider: 'mock',
    });

    const project = await service.createProject({ name: 'Visual QC Test' });
    await service.upsertVoice(project.id, 'mara', {
      label: 'Mara',
      provider: 'mock',
      providerVoiceId: 'mock_mara',
      defaultPan: -0.5,
      defaultEqPreset: 'intimate',
    });
    await service.upsertVoice(project.id, 'margaux', {
      label: 'Margaux',
      provider: 'mock',
      providerVoiceId: 'mock_margaux',
      defaultPan: 0.55,
      defaultEqPreset: 'intimate',
    });

    await service.importScript(project.id, {
      mode: 'replace',
      script: [
        '[[voice:mara]] [[pan:-0.5]] First line on the left side of the stage.',
        '[[pause:1]]',
        '[[voice:margaux]] [[pan:0.55]] Second line answering from the right side.',
      ].join('\n'),
    });

    const { done } = await service.startRenderAll(project.id, { concurrency: 2 });
    await done;
    const { exportRecord } = await service.mixProject(project.id, { format: 'wav' });
    const updated = await store.requireProject(project.id);
    return { service, project: updated, exportRecord };
  }

  it('renders default 4-panel master PNG + fast pure-FFmpeg PNG for exports and takes', async () => {
    const { service, project, exportRecord } = await setupStudio();

    // 1) Master 4-panel view on export (includes DAW cues panel)
    const master = await service.inspectVisual({
      projectId: project.id,
      target: { type: 'export', exportId: exportRecord.id },
    });
    expect(master.preset).toBe('master');
    expect(master.mode).toBe('zoom');
    expect(master.panels).toEqual(['cues', 'waveform', 'rms', 'spectrogram']);
    expect(master.pxPerSec).toBeGreaterThanOrEqual(30);
    expect(master.warnings).toEqual([]);
    expect(master.imagePath).toBeTruthy();
    expect(readPngDimensions(master.pngBuffer)).toEqual({ width: 1600, height: 900 });
    expect(Array.isArray(master.summaryTelemetry.cuesInWindow)).toBe(true);
    expect((master.summaryTelemetry.cuesInWindow as unknown[]).length).toBe(2);

    // 2) Fast pure-FFmpeg path on export
    const fast = await service.inspectVisual({
      projectId: project.id,
      target: { type: 'export', exportId: exportRecord.id },
      preset: 'fast',
    });
    expect(fast.preset).toBe('fast');
    expect(fast.panels).toEqual(['waveform', 'spectrogram']);
    expect(readPngDimensions(fast.pngBuffer)).toEqual({ width: 1600, height: 900 });

    // 3) Take visual without passing cueId (auto-resolved from takeId) - both master & fast
    // Raw takes are 24 kHz mono WAVs, which used to trigger an FFmpeg vstack width mismatch
    // (1584 vs 1600) in preset="fast" before resampling to 48 kHz stereo.
    const firstTakeId = project.cues[0]!.activeTakeId!;
    const takeVis = await service.inspectVisual({
      projectId: project.id,
      target: { type: 'take', takeId: firstTakeId },
    });
    expect(takeVis.panels).toEqual(['waveform', 'rms', 'spectrogram']);
    expect(readPngDimensions(takeVis.pngBuffer)).toEqual({ width: 1600, height: 900 });

    const takeVisFast = await service.inspectVisual({
      projectId: project.id,
      target: { type: 'take', takeId: firstTakeId },
      preset: 'fast',
    });
    expect(takeVisFast.preset).toBe('fast');
    expect(takeVisFast.channels).toBe(1);
    expect(takeVisFast.sampleRate).toBe(24000);
    expect(readPngDimensions(takeVisFast.pngBuffer)).toEqual({ width: 1600, height: 900 });
  });

  it('enforces zoom <= 45s cap and warns below 30 px/s in overview mode', async () => {
    const { service, project } = await setupStudio();
    // Create a 60s pause so the mixed export exceeds 45s
    await service.updateCue(project.id, project.cues[1]!.id, {
      timing: { offsetMs: 55000 },
    });
    const { exportRecord } = await service.mixProject(project.id, { format: 'ogg' });

    // Explicit zoom > 45s must fail cleanly with 400
    await expect(
      service.inspectVisual({
        projectId: project.id,
        target: { type: 'export', exportId: exportRecord.id },
        mode: 'zoom',
        startSec: 0,
        endSec: 55,
      }),
    ).rejects.toThrow(/Zoom mode is capped at 45s/i);

    // Overview mode succeeds and emits the < 30 px/s resolution cliff warning
    const overview = await service.inspectVisual({
      projectId: project.id,
      target: { type: 'export', exportId: exportRecord.id },
      mode: 'overview',
    });
    expect(overview.mode).toBe('overview');
    expect(overview.pxPerSec).toBeLessThan(30);
    expect(overview.warnings.length).toBeGreaterThan(0);
    expect(overview.warnings[0]).toMatch(/<150 ms dropouts/i);
    expect(readPngDimensions(overview.pngBuffer)).toEqual({ width: 1600, height: 900 });
  });

  it('serves visual PNG + JSON over REST and inline image block over MCP', async () => {
    const { service, project, exportRecord } = await setupStudio();

    // REST API check
    const app = await buildServer({ service });
    try {
      const pngRes = await app.inject({
        method: 'GET',
        url: `/projects/${project.id}/exports/${exportRecord.id}/visual?preset=master`,
      });
      expect(pngRes.statusCode).toBe(200);
      expect(pngRes.headers['content-type']).toBe('image/png');
      expect(readPngDimensions(pngRes.rawPayload)).toEqual({ width: 1600, height: 900 });

      const jsonRes = await app.inject({
        method: 'GET',
        url: `/projects/${project.id}/exports/${exportRecord.id}/visual?format=json&preset=fast`,
      });
      expect(jsonRes.statusCode).toBe(200);
      const body = jsonRes.json() as { preset: string; imageBase64: string; width: number };
      expect(body.preset).toBe('fast');
      expect(body.width).toBe(1600);
      expect(readPngDimensions(Buffer.from(body.imageBase64, 'base64'))).toEqual({
        width: 1600,
        height: 900,
      });
    } finally {
      await app.close();
    }

    // MCP tool check
    const mcpServer = createMcpServer(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'visual-test', version: '0.1.0' });
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: 'booth_inspect_visual',
        arguments: {
          projectId: project.id,
          target: { type: 'export', exportId: exportRecord.id },
          preset: 'master',
        },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      expect(content.length).toBe(2);
      expect(content[0]?.type).toBe('text');
      expect(content[1]?.type).toBe('image');
      expect(content[1]?.mimeType).toBe('image/png');
      const imgBuf = Buffer.from(content[1]!.data!, 'base64');
      expect(readPngDimensions(imgBuf)).toEqual({ width: 1600, height: 900 });
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });

  it('renders dedicated SFX overlay lane and aligns DAW cues/SFX for scene-scoped partial exports', async () => {
    const { service, project } = await setupStudio();

    // Add a short SFX asset and anchor it to cue 2
    const samples = Math.round(0.4 * 48000);
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 520 * i) / 48000) * 12000), i * 2);
    }
    await service.uploadAsset({
      assetPath: 'door_latch.wav',
      buffer: wrapPcm16AsWav(pcm, 48000, 1),
    });
    const cue2Id = project.cues[1]!.id;
    await service.upsertSfx(project.id, 'latch_click', {
      label: 'Door Latch',
      assetPath: 'door_latch.wav',
      anchor: { cueId: cue2Id, edge: 'start', offsetMs: 100 },
      gainDb: -6,
      pan: 0.4,
      fadeInMs: 15,
      fadeOutMs: 40,
    });

    // Full export visual includes SFX lane telemetry
    const fullMix = await service.mixProject(project.id, { format: 'wav' });
    const fullVis = await service.inspectVisual({
      projectId: project.id,
      target: { type: 'export', exportId: fullMix.exportRecord.id },
      preset: 'master',
    });
    expect(readPngDimensions(fullVis.pngBuffer)).toEqual({ width: 1600, height: 900 });
    expect(fullVis.summaryTelemetry.sfxCount).toBe(1);
    const sfxInWin = fullVis.summaryTelemetry.sfxInWindow as Array<{ id: string; startSec: number }>;
    expect(sfxInWin).toHaveLength(1);
    expect(sfxInWin[0]!.id).toBe('latch_click');
    expect(sfxInWin[0]!.startSec).toBeGreaterThan(1.0);

    // Partial export scoped to cue 2 only: DAW cues & SFX coordinates rebase to 0s!
    const partialMix = await service.mixProject(project.id, {
      format: 'wav',
      fromCueId: cue2Id,
      toCueId: cue2Id,
    });
    const partialVis = await service.inspectVisual({
      projectId: project.id,
      target: { type: 'export', exportId: partialMix.exportRecord.id },
      preset: 'master',
    });
    expect(readPngDimensions(partialVis.pngBuffer)).toEqual({ width: 1600, height: 900 });
    expect(partialVis.summaryTelemetry.window).toBeDefined();
    const partialCues = partialVis.summaryTelemetry.cuesInWindow as Array<{ id: string; startSec: number }>;
    expect(partialCues).toHaveLength(1);
    expect(partialCues[0]!.id).toBe(cue2Id);
    expect(partialCues[0]!.startSec).toBeCloseTo(0, 2);
    const partialSfx = partialVis.summaryTelemetry.sfxInWindow as Array<{ id: string; startSec: number }>;
    expect(partialSfx).toHaveLength(1);
    expect(partialSfx[0]!.id).toBe('latch_click');
    expect(partialSfx[0]!.startSec).toBeCloseTo(0.1, 1);
  });
});
