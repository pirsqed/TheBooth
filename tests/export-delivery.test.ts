import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/api/server.js';
import { probeAudio } from '../src/audio/ffmpeg.js';
import { createMcpServer } from '../src/mcp/server.js';
import { MockTtsProvider } from '../src/providers/mock.js';
import { StudioService } from '../src/studio/service.js';
import { ProjectStore } from '../src/studio/store.js';

describe('Mixdown outputPath delivery (Service, REST, MCP)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function setup(allowedExportDirs?: string[]) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'the-booth-delivery-'));
    tempDirs.push(tmp);
    const dataDir = path.join(tmp, 'data');
    const outDir = path.join(tmp, 'workspace_exports');
    const store = new ProjectStore(dataDir);
    const mock = new MockTtsProvider();
    const service = new StudioService({
      store,
      providers: { mock, gemini: mock },
      defaultProvider: 'mock',
      allowedExportDirs,
    });

    const project = await service.createProject({ name: 'Dracula Scene 1' });
    await service.upsertVoice(project.id, 'harker', {
      label: 'Jonathan Harker',
      provider: 'mock',
      providerVoiceId: 'mock_harker',
    });
    await service.importScript(project.id, {
      mode: 'replace',
      script: '[[voice:harker]] I turned to the glass and froze.',
    });
    await service.renderAll(project.id);
    return { tmp, outDir, service, project };
  }

  it('delivers directly to a file path, infers format from extension, and supports directory targets', async () => {
    const { outDir, service, project } = await setup();

    // 1) Explicit file path with .wav extension -> infers wav format automatically
    const wavDest = path.join(outDir, 'nested', 'dracula_scene1.wav');
    const resWav = await service.mixProject(project.id, { outputPath: wavDest });
    expect(resWav.exportRecord.format).toBe('wav');
    expect(resWav.deliveredPath).toBe(path.resolve(wavDest));
    const probe = await probeAudio(resWav.deliveredPath!);
    expect(probe.channels).toBe(2);
    expect(probe.sampleRate).toBe(48000);
    expect(probe.codecName).toBe('pcm_s16le');

    // 2) Existing directory path -> auto-names <projectId>_<exportId>.<format>
    await fs.mkdir(outDir, { recursive: true });
    const resDir = await service.mixProject(project.id, {
      format: 'ogg',
      outputPath: outDir,
    });
    expect(resDir.deliveredPath).toBe(
      path.join(path.resolve(outDir), `${project.id}_${resDir.exportRecord.id}.ogg`),
    );
    const dirProbe = await probeAudio(resDir.deliveredPath!);
    expect(dirProbe.codecName).toBe('opus');

    // 3) Extensionless file path -> appends .<format>
    const noExt = path.join(outDir, 'scene1_final');
    const resNoExt = await service.mixProject(project.id, {
      format: 'mp3',
      outputPath: noExt,
    });
    expect(resNoExt.deliveredPath).toBe(`${path.resolve(noExt)}.mp3`);
    await expect(fs.access(resNoExt.deliveredPath!)).resolves.toBeUndefined();
  });

  it('rejects mismatched or non-audio extensions and enforces ALLOWED_EXPORT_DIRS', async () => {
    const tmpAllowed = await fs.mkdtemp(path.join(os.tmpdir(), 'the-booth-allowed-'));
    tempDirs.push(tmpAllowed);
    const { outDir, service, project } = await setup([tmpAllowed]);

    // Non-audio extension blocked (never clobbers .env / .json / .ts)
    await expect(
      service.mixProject(project.id, {
        outputPath: path.join(tmpAllowed, 'hack.json'),
      }),
    ).rejects.toThrow(/Unsupported outputPath extension/i);

    // Mismatched extension vs explicit format blocked
    await expect(
      service.mixProject(project.id, {
        format: 'ogg',
        outputPath: path.join(tmpAllowed, 'wrong.wav'),
      }),
    ).rejects.toThrow(/does not match requested format/i);

    // Path outside ALLOWED_EXPORT_DIRS blocked with 403
    await expect(
      service.mixProject(project.id, {
        outputPath: path.join(outDir, 'escaped.ogg'),
      }),
    ).rejects.toThrow(/outside ALLOWED_EXPORT_DIRS/i);

    // Path inside ALLOWED_EXPORT_DIRS succeeds
    const okDest = path.join(tmpAllowed, 'approved_master.ogg');
    const ok = await service.mixProject(project.id, { outputPath: okDest });
    expect(ok.deliveredPath).toBe(path.resolve(okDest));
    await expect(fs.access(ok.deliveredPath!)).resolves.toBeUndefined();
  });

  it('exposes outputPath and deliveredPath cleanly over REST and MCP', async () => {
    const { outDir, service, project } = await setup();

    // REST POST /projects/:id/mix
    const app = await buildServer({ service });
    try {
      const restDest = path.join(outDir, 'rest_master.ogg');
      const res = await app.inject({
        method: 'POST',
        url: `/projects/${project.id}/mix`,
        payload: { outputPath: restDest },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveredPath: string; export: { format: string } };
      expect(body.export.format).toBe('ogg');
      expect(body.deliveredPath).toBe(path.resolve(restDest));
      await expect(fs.access(body.deliveredPath)).resolves.toBeUndefined();
    } finally {
      await app.close();
    }

    // MCP booth_mix
    const mcpServer = createMcpServer(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'codex-delivery-test', version: '0.1.0' });
    await client.connect(clientTransport);
    try {
      const mcpDest = path.join(outDir, 'mcp_master.wav');
      const res = await client.callTool({
        name: 'booth_mix',
        arguments: { projectId: project.id, outputPath: mcpDest },
      });
      expect(res.isError).not.toBe(true);
      const textBlock = (res.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === 'text',
      );
      const payload = JSON.parse(textBlock!.text!) as {
        deliveredPath: string;
        export: { format: string };
      };
      expect(payload.export.format).toBe('wav');
      expect(payload.deliveredPath).toBe(path.resolve(mcpDest));
      await expect(fs.access(payload.deliveredPath)).resolves.toBeUndefined();
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });
});
