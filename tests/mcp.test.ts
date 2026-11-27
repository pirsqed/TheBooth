import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';
import { validateWavBuffer, wrapPcm16AsWav } from '../src/providers/interface.js';
import { MockTtsProvider } from '../src/providers/mock.js';
import { StudioService } from '../src/studio/service.js';
import { ProjectStore } from '../src/studio/store.js';

function makeToneWav(durationMs = 600, sampleRate = 48000): Buffer {
  const n = Math.round((durationMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(i * 0.03) * 6000), i * 2);
  }
  return wrapPcm16AsWav(pcm, sampleRate, 1);
}

function parseToolJson(result: Record<string, unknown>): Record<string, unknown> {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const textBlock = blocks.find((b) => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error('Expected text block in MCP tool response');
  }
  return JSON.parse(textBlock.text) as Record<string, unknown>;
}

describe('The Booth MCP Server (Milestone 3)', () => {
  let tempDataDir: string;
  let service: StudioService;
  let client: Client;
  let closeAll: () => Promise<void>;

  beforeEach(async () => {
    tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thebooth-mcp-'));
    const store = new ProjectStore(tempDataDir);
    await store.ensureDataDirs();
    service = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
    });

    const mcpServer = createMcpServer(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
    await client.connect(clientTransport);

    closeAll = async () => {
      await client.close();
      await mcpServer.close();
    };
  });

  afterEach(async () => {
    await closeAll();
    await fs.rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('reports busy until foreground calls and queued or running jobs finish', async () => {
    const idle = async () => {
      const response = await client.readResource({ uri: 'booth://runtime/idle' });
      const value = response.contents[0];
      return value && 'text' in value && JSON.parse(value.text).idle;
    };
    expect(await idle()).toBe(true);
    const job = service.jobs.create('test', 'direct_project', 1);
    expect(await idle()).toBe(false);
    service.jobs.update(job.id, { status: 'running' });
    expect(await idle()).toBe(false);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(service, 'listProjects').mockImplementationOnce(async () => {
      started();
      await gate;
      return [];
    });
    const call = client.callTool({ name: 'booth_list_projects', arguments: {} });
    await entered;
    service.jobs.update(job.id, { status: 'completed' });
    try { expect(await idle()).toBe(false); }
    finally { release(); await call; }
    expect(await idle()).toBe(true);
  });

  it('exposes the full 1:1 studio + asset library MCP tool surface', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const expected of [
      'booth_create_project',
      'booth_list_projects',
      'booth_get_project',
      'booth_update_project',
      'booth_delete_project',
      'booth_upsert_voice',
      'booth_import_script',
      'booth_add_cue',
      'booth_update_cue',
      'booth_delete_cue',
      'booth_split_cue',
      'booth_render_take',
      'booth_render_all',
      'booth_job_status',
      'booth_get_take_audio',
      'booth_upsert_bed',
      'booth_delete_bed',
      'booth_upsert_sfx',
      'booth_delete_sfx',
      'booth_mix',
      'booth_get_export_audio',
      'booth_inspect_visual',
      'booth_render_audition_reel',
      'booth_render_ab_reel',
      'booth_list_assets',
      'booth_index_assets',
      'booth_search_assets',
      'booth_get_asset_audio',
      'booth_upload_asset',
      'booth_delete_asset',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('executes a full agent workflow over MCP: upload asset -> create project -> import -> render -> listen -> mix -> export audio', async () => {
    // 1. Upload reusable ambient bed into asset library
    const bedWav = makeToneWav(800);
    const uploadRes = await client.callTool({
      name: 'booth_upload_asset',
      arguments: {
        assetPath: 'beds/soft_rain.wav',
        dataBase64: bedWav.toString('base64'),
      },
    });
    expect(uploadRes.isError).not.toBe(true);
    const uploaded = parseToolJson(uploadRes);
    expect(uploaded.path).toBe('beds/soft_rain.wav');
    expect(uploaded.durationMs).toBeGreaterThanOrEqual(750);

    // 2. List asset library
    const listAssetsRes = await client.callTool({
      name: 'booth_list_assets',
      arguments: {},
    });
    const assetsPayload = parseToolJson(listAssetsRes) as {
      assets: Array<{ path: string }>;
    };
    expect(assetsPayload.assets.map((a) => a.path)).toContain('beds/soft_rain.wav');

    // 3. Create project & register voice
    const createRes = await client.callTool({
      name: 'booth_create_project',
      arguments: {
        id: 'mcp_story',
        name: 'MCP Studio Story',
        audio: { tailMs: 500 },
      },
    });
    expect(createRes.isError).not.toBe(true);

    await client.callTool({
      name: 'booth_upsert_voice',
      arguments: {
        projectId: 'mcp_story',
        voiceId: 'mara',
        label: 'Mara',
        provider: 'mock',
        providerVoiceId: 'mock_mara',
      },
    });

    // 4. Import script referencing uploaded bed
    const importRes = await client.callTool({
      name: 'booth_import_script',
      arguments: {
        projectId: 'mcp_story',
        script: `
[[voice:mara]]
[[bed:beds/soft_rain.wav gain=-22dB duck=-6dB]]

Welcome to the MCP studio session.

[[pause:1]]
[[pan:-0.6]]

Everything flows through one shared core.
`,
      },
    });
    expect(importRes.isError).not.toBe(true);
    const imported = parseToolJson(importRes) as {
      importedCueCount: number;
      project: { cues: Array<{ id: string }> };
    };
    expect(imported.importedCueCount).toBe(2);
    const firstCueId = imported.project.cues[0]!.id;

    // 5. Render all cues via async job + poll booth_job_status
    const renderAllRes = await client.callTool({
      name: 'booth_render_all',
      arguments: { projectId: 'mcp_story', concurrency: 2 },
    });
    const { jobId } = parseToolJson(renderAllRes) as { jobId: string };
    expect(jobId).toMatch(/^job_/);

    let jobStatus = '';
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const pollRes = await client.callTool({
        name: 'booth_job_status',
        arguments: { jobId },
      });
      const job = parseToolJson(pollRes) as { status: string; completed: number };
      jobStatus = job.status;
      if (jobStatus === 'completed' || jobStatus === 'failed') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(jobStatus).toBe('completed');

    // 6. Listen to a single take via inline MCP audio content block
    const projRes = await client.callTool({
      name: 'booth_get_project',
      arguments: { projectId: 'mcp_story' },
    });
    const projData = parseToolJson(projRes) as {
      project: { cues: Array<{ id: string; activeTakeId: string }> };
    };
    const takeId = projData.project.cues[0]!.activeTakeId;

    const takeAudioRes = await client.callTool({
      name: 'booth_get_take_audio',
      arguments: {
        projectId: 'mcp_story',
        cueId: firstCueId,
        takeId,
      },
    });
    expect(takeAudioRes.isError).not.toBe(true);
    const takeBlocks = takeAudioRes.content as Array<{
      type: string;
      data?: string;
      mimeType?: string;
    }>;
    const takeAudioBlock = takeBlocks.find((b) => b.type === 'audio');
    expect(takeAudioBlock?.mimeType).toBe('audio/wav');
    const wavBuf = Buffer.from(takeAudioBlock!.data!, 'base64');
    expect(validateWavBuffer(wavBuf).sampleRate).toBe(24000);

    // 7. Stage-2 mix & fetch rendered OGG export inline
    const mixRes = await client.callTool({
      name: 'booth_mix',
      arguments: { projectId: 'mcp_story', format: 'ogg' },
    });
    expect(mixRes.isError).not.toBe(true);
    const mixData = parseToolJson(mixRes) as { export: { id: string } };

    const expAudioRes = await client.callTool({
      name: 'booth_get_export_audio',
      arguments: { projectId: 'mcp_story', exportId: mixData.export.id },
    });
    const expBlocks = expAudioRes.content as Array<{
      type: string;
      data?: string;
      mimeType?: string;
    }>;
    const expAudioBlock = expBlocks.find((b) => b.type === 'audio');
    expect(expAudioBlock?.mimeType).toBe('audio/ogg');
    const oggBuf = Buffer.from(expAudioBlock!.data!, 'base64');
    expect(oggBuf.subarray(0, 4).toString('ascii')).toBe('OggS');

    // 8. Delete asset & delete project cleanly
    const delAsset = await client.callTool({
      name: 'booth_delete_asset',
      arguments: { assetPath: 'beds/soft_rain.wav' },
    });
    expect(delAsset.isError).not.toBe(true);

    const delProj = await client.callTool({
      name: 'booth_delete_project',
      arguments: { projectId: 'mcp_story' },
    });
    expect(delProj.isError).not.toBe(true);
  });

  it('returns clean MCP tool errors for path traversal and corrupt asset uploads', async () => {
    const traversal = await client.callTool({
      name: 'booth_upload_asset',
      arguments: {
        assetPath: '../escape.wav',
        dataBase64: makeToneWav(200).toString('base64'),
      },
    });
    expect(traversal.isError).toBe(true);

    const corrupt = await client.callTool({
      name: 'booth_upload_asset',
      arguments: {
        assetPath: 'corrupt.wav',
        dataBase64: Buffer.from('definitely not audio').toString('base64'),
      },
    });
    expect(corrupt.isError).toBe(true);
  });
});
