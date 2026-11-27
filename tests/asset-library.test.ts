import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { measureAudioLoudness, probeAudio, runCommand } from '../src/audio/ffmpeg.js';
import { computeEffectiveClipSpan } from '../src/audio/mixdown.js';
import { parseAssetLibraryDirs } from '../src/config.js';
import { createMcpServer } from '../src/mcp/server.js';
import { wrapPcm16AsWav } from '../src/providers/interface.js';
import { MockTtsProvider } from '../src/providers/mock.js';
import { parseScript, ScriptParseError } from '../src/script/parser.js';
import {
  AssetEnricher,
  cosineSimilarityRow,
  expandUcsTokens,
  l2Normalize,
  tokenizeAssetText,
} from '../src/studio/assets-index.js';
import { StudioService } from '../src/studio/service.js';
import { ProjectStore, StoreError } from '../src/studio/store.js';

function makeToneWav(
  durationMs: number,
  options: { sampleRate?: number; channels?: number; freqHz?: number; amplitude?: number } = {},
): Buffer {
  const sampleRate = options.sampleRate ?? 48000;
  const channels = options.channels ?? 1;
  const freqHz = options.freqHz ?? 440;
  const amplitude = options.amplitude ?? 0.35;
  const frames = Math.round((durationMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const val = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amplitude * 32767);
    for (let ch = 0; ch < channels; ch++) {
      pcm.writeInt16LE(val, (i * channels + ch) * 2);
    }
  }
  return wrapPcm16AsWav(pcm, sampleRate, channels);
}

/**
 * Generates a WAV with silence everywhere EXCEPT a burst window `[burstStartMs, burstEndMs]`,
 * ideal for verifying that source slicing extracts the exact requested time window.
 */
function makeWindowedBurstWav(
  totalMs: number,
  burstStartMs: number,
  burstEndMs: number,
  sampleRate = 48000,
): Buffer {
  const frames = Math.round((totalMs / 1000) * sampleRate);
  const startFrame = Math.round((burstStartMs / 1000) * sampleRate);
  const endFrame = Math.round((burstEndMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    if (i >= startFrame && i < endFrame) {
      const val = Math.round(Math.sin((2 * Math.PI * 660 * i) / sampleRate) * 0.5 * 32767);
      pcm.writeInt16LE(val, i * 2);
    }
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

describe('External Asset Library Mounts, Indexing, Search, Auditioning & Slicing', () => {
  let tempRoot: string;
  let dataDir: string;
  let sonnissDir: string;
  let npsDir: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'thebooth-assets-'));
    dataDir = path.join(tempRoot, 'data');
    sonnissDir = path.join(tempRoot, 'sonniss');
    npsDir = path.join(tempRoot, 'nps');
    await fs.mkdir(path.join(sonnissDir, 'Glass'), { recursive: true });
    await fs.mkdir(path.join(sonnissDir, 'Doors & Latches'), { recursive: true });
    await fs.mkdir(npsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('parses ASSET_LIBRARY_DIRS with explicit aliases, reserved "local" protection, and collision suffixes', () => {
    const mounts = parseAssetLibraryDirs(
      'sonniss=/sfx/Sonniss;local=/sfx/LocalPack;/sfx/PackA/Nature;/sfx/PackB/Nature;weird=dir=with=eq',
      tempRoot,
      ';',
    );
    expect(mounts.map((m) => m.alias)).toEqual([
      'sonniss',
      'local-2',
      'nature',
      'nature-2',
      'weird',
    ]);
    expect(mounts[4]!.rootDir).toBe(path.resolve(tempRoot, 'dir=with=eq'));
    expect(mounts.every((m) => m.readOnly)).toBe(true);
  });

  it('enforces @alias sandboxing, read-only write rejection (403), and unified asset resolution', async () => {
    const targetWav = path.join(sonnissDir, 'Glass', 'GLASSBrk_Mirror_01.wav');
    await fs.writeFile(targetWav, makeToneWav(400));

    const store = new ProjectStore(dataDir, {
      assetLibraryMounts: [{ alias: 'sonniss', rootDir: sonnissDir, readOnly: true }],
    });
    await store.ensureDataDirs();
    const service = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
    });

    // Direct & extensionless resolution of external read-only asset
    const resolved = await store.resolveExistingAssetFile('@sonniss/Glass/GLASSBrk_Mirror_01.wav');
    expect(resolved.absPath).toBe(targetWav);
    expect(resolved.mount).toBe('sonniss');
    expect(resolved.readOnly).toBe(true);

    const resolvedNoExt = await store.resolveExistingAssetFile('@sonniss/Glass/GLASSBrk_Mirror_01');
    expect(resolvedNoExt.canonicalPath).toBe('@sonniss/Glass/GLASSBrk_Mirror_01.wav');

    // Path traversal & unknown mount rejection
    expect(() => store.resolveAssetPath('@sonniss/../../escape.wav')).toThrow(StoreError);
    expect(() => store.resolveAssetPath('@unknown/file.wav')).toThrow(StoreError);

    // Read-only protection on upload & delete (403)
    await expect(
      service.uploadAsset({
        assetPath: '@sonniss/Glass/new.wav',
        buffer: makeToneWav(200),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      service.deleteAsset('@sonniss/Glass/GLASSBrk_Mirror_01.wav'),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Visual inspection works on mounted external assets
    const vis = await service.inspectVisual({
      target: { type: 'asset', assetPath: '@sonniss/Glass/GLASSBrk_Mirror_01.wav' },
      preset: 'fast',
      saveToDisk: false,
    });
    expect(vis.pngBuffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(vis.summaryTelemetry.mount).toBe('sonniss');
  });

  it('parses clipStart/clipDur and quoted paths with spaces in [[sfx:...]] and [[bed:...]]', () => {
    const parsed = parseScript(`
[[bed:"@nps/Storm Wind Long.wav" clipStart=18s clipDur=45s gain=-26dB duck=-6dB]]
[[sfx:"@sonniss/Doors & Latches/Wood Creak 01.wav" clipStart=1.2s clipDur=850ms anchor=next offset=-250ms pan=0.35]]

Hello in the dark.

[[sfx:@sonniss/Glass/GLASSBrk_Mirror_x4.wav clipStart=3100ms clipDur=1.4s]]
`);

    expect(parsed.beds).toHaveLength(1);
    expect(parsed.beds[0]!.assetPath).toBe('@nps/Storm Wind Long.wav');
    expect(parsed.beds[0]!.clipStartMs).toBe(18000);
    expect(parsed.beds[0]!.clipDurationMs).toBe(45000);

    expect(parsed.sfx).toHaveLength(2);
    expect(parsed.sfx[0]!.assetPath).toBe('@sonniss/Doors & Latches/Wood Creak 01.wav');
    expect(parsed.sfx[0]!.clipStartMs).toBe(1200);
    expect(parsed.sfx[0]!.clipDurationMs).toBe(850);
    expect(parsed.sfx[0]!.anchor.edge).toBe('start');
    expect(parsed.sfx[0]!.anchor.offsetMs).toBe(-250);

    expect(parsed.sfx[1]!.assetPath).toBe('@sonniss/Glass/GLASSBrk_Mirror_x4.wav');
    expect(parsed.sfx[1]!.clipStartMs).toBe(3100);
    expect(parsed.sfx[1]!.clipDurationMs).toBe(1400);

    expect(() =>
      parseScript(`[[sfx:door.wav clipStart=-1s]]`),
    ).toThrow(ScriptParseError);
    expect(() =>
      parseScript(`[[bed:rain.wav clipDur=0s]]`),
    ).toThrow(ScriptParseError);
  });

  it('indexes incrementally with BWF tags, UCS expansion, catalog.json sidecars, and offline BM25 filtering', async () => {
    // Tokenization & UCS sanity
    expect(tokenizeAssetText('Glass/GLASSBrk_Mirror_Hard_01.wav')).toEqual([
      'glass',
      'glass',
      'brk',
      'mirror',
      'hard',
    ]);
    expect(expandUcsTokens('@sonniss/Glass/GLASSBrk_Mirror_Hard_01.wav')).toContain('shatter');
    expect(expandUcsTokens('@nps/WEATRain_Castle_Storm.wav')).toContain('weather');

    // Create a WAV with embedded RIFF/BWF comment tag via FFmpeg
    const rawGlass = path.join(tempRoot, 'raw_glass.wav');
    const taggedGlass = path.join(sonnissDir, 'Glass', 'GLASSBrk_Mirror_Hard_01.wav');
    await fs.writeFile(rawGlass, makeToneWav(800, { channels: 1 }));
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i',
      rawGlass,
      '-metadata',
      'comment=Sharp antique mirror shatter on cobblestone floor',
      '-c:a',
      'copy',
      taggedGlass,
    ]);

    // A second SFX with spaces in path + catalog.json sidecar override
    await fs.writeFile(
      path.join(sonnissDir, 'Doors & Latches', 'Door Heavy 01.wav'),
      makeToneWav(1200, { channels: 2 }),
    );
    await fs.writeFile(
      path.join(sonnissDir, 'catalog.json'),
      JSON.stringify({
        'Doors & Latches/Door Heavy 01.wav': {
          description: 'Massive gothic castle oak door creaking open slowly',
          tags: ['gothic', 'castle', 'creak', 'oak', 'hinge'],
          kind: 'sfx',
          license: 'CC0',
        },
      }),
    );

    // A 13-second quiet stereo rain bed under @nps (amplitude 0.03 -> ~ -33 dBFS)
    await fs.writeFile(
      path.join(npsDir, 'WEATRain_Forest_Steady.wav'),
      makeToneWav(13000, { channels: 2, sampleRate: 48000, freqHz: 220, amplitude: 0.03 }),
    );

    const store = new ProjectStore(dataDir, {
      assetLibraryMounts: [
        { alias: 'sonniss', rootDir: sonnissDir, readOnly: true },
        { alias: 'nps', rootDir: npsDir, readOnly: true },
      ],
    });
    await store.ensureDataDirs();
    const service = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
    });

    // Before indexing with external mounts configured, search returns explicit unindexed hint
    const preSearch = await service.searchAssets({ query: 'mirror shatter' });
    expect(preSearch.indexed).toBe(false);
    expect(preSearch.hint).toMatch(/booth_index_assets/);

    // Pass 1 cold scan
    const first = await service.indexAssets();
    expect(first.summary.totalAssets).toBe(3);
    expect(first.summary.probedFiles).toBe(3);
    expect(first.summary.reusedCached).toBe(0);

    // Second scan reuses 100% cache (0 probes)
    const second = await service.indexAssets();
    expect(second.summary.reusedCached).toBe(3);
    expect(second.summary.probedFiles).toBe(0);

    // BM25 search hits BWF + UCS description and surfaces native loudness telemetry
    const mirrorHits = await service.searchAssets({
      query: 'cobblestone mirror shatter',
      kind: 'sfx',
    });
    expect(mirrorHits.indexed).toBe(true);
    expect(mirrorHits.mode).toBe('bm25');
    expect(mirrorHits.results[0]!.assetPath).toBe('@sonniss/Glass/GLASSBrk_Mirror_Hard_01.wav');
    expect(mirrorHits.results[0]!.description).toContain('cobblestone');
    expect(mirrorHits.results[0]!.rmsDbfs).toBeGreaterThan(-20);
    expect(mirrorHits.results[0]!.peakDbfs).toBeGreaterThan(-15);

    // Catalog sidecar priority & stereoOnly/duration filters
    const doorHits = await service.searchAssets({
      query: 'gothic castle oak creak',
      stereoOnly: true,
      maxDurationSec: 5,
    });
    expect(doorHits.results).toHaveLength(1);
    expect(doorHits.results[0]!.assetPath).toBe('@sonniss/Doors & Latches/Door Heavy 01.wav');
    expect(doorHits.results[0]!.license).toBe('CC0');

    // Bed duration heuristic (>= 12s -> bed)
    const bedHits = await service.searchAssets({
      query: 'rain weather forest',
      kind: 'bed',
      minDurationSec: 10,
      stereoOnly: true,
    });
    expect(bedHits.results).toHaveLength(1);
    expect(bedHits.results[0]!.assetPath).toBe('@nps/WEATRain_Forest_Steady.wav');
    expect(bedHits.results[0]!.suggestedKind).toBe('bed');
    // Quiet archival bed (~ -33 dBFS) reflects its much lower native rmsDbfs compared to loud SFX
    expect(bedHits.results[0]!.rmsDbfs).toBeLessThan(-28);
    expect(bedHits.results[0]!.rmsDbfs).toBeGreaterThan(-42);
  });

  it('supports Pass 2 captioning, flat .f32 hybrid search, compaction on delete, and mismatch fallback', async () => {
    // Pure vector math checks
    const normA = l2Normalize([3, 4, 0, 0]);
    expect(normA[0]).toBeCloseTo(0.6, 5);
    expect(normA[1]).toBeCloseTo(0.8, 5);
    const matrix = new Float32Array([0.6, 0.8, 0, 0, 0, 0, 1, 0]);
    expect(cosineSimilarityRow(matrix, 0, 4, normA)).toBeCloseTo(1.0, 5);
    expect(cosineSimilarityRow(matrix, 1, 4, normA)).toBeCloseTo(0.0, 5);

    await fs.writeFile(path.join(sonnissDir, 'mystery_clip_01.wav'), makeToneWav(700));
    await fs.writeFile(path.join(sonnissDir, 'mystery_clip_02.wav'), makeToneWav(900));

    const recordedTaskTypes: string[] = [];
    const mockEnricher: AssetEnricher = {
      async captionAudio({ assetPath }) {
        if (assetPath.includes('01')) {
          return {
            caption: 'Distant howling wolf under cold mountain wind',
            tags: ['wolf', 'howl', 'night', 'wind'],
            kind: 'sfx',
            loopable: false,
            multiVariation: true,
          };
        }
        return {
          caption: 'Crackling fireplace logs in a stone parlor',
          tags: ['fire', 'crackle', 'hearth'],
          kind: 'bed',
          loopable: true,
          multiVariation: false,
        };
      },
      async embedTexts({ texts, taskType, outputDimensionality }) {
        recordedTaskTypes.push(taskType);
        return texts.map((text) => {
          const vec = new Array<number>(outputDimensionality).fill(0);
          const lower = text.toLowerCase();
          if (lower.includes('wolf') || lower.includes('canine') || lower.includes('howl')) {
            vec[0] = 1;
          } else if (lower.includes('fire') || lower.includes('hearth') || lower.includes('flame')) {
            vec[1] = 1;
          } else {
            vec[2] = 1;
          }
          return vec;
        });
      },
    };

    const store = new ProjectStore(dataDir, {
      assetLibraryMounts: [{ alias: 'sonniss', rootDir: sonnissDir, readOnly: true }],
    });
    await store.ensureDataDirs();
    const service = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
      assetEnricher: mockEnricher,
      geminiEmbeddingModel: 'gemini-embedding-2',
      assetEmbeddingDims: 128,
    });

    const indexed = await service.indexAssets({
      enrichCaptions: true,
      enrichEmbeddings: true,
      maxCaptionCount: 10,
    });
    expect(indexed.summary.captionedCount).toBe(2);
    expect(indexed.summary.embeddedCount).toBe(2);
    expect(recordedTaskTypes).toContain('RETRIEVAL_DOCUMENT');

    const f32Stat = await fs.stat(store.assetsEmbeddingsPath);
    expect(f32Stat.size).toBe(2 * 128 * 4);

    // Semantic query ("canine") doesn't appear literally in filename or caption -> hybrid cosine finds wolf!
    const semanticRes = await service.searchAssets({ query: 'canine predator' });
    expect(semanticRes.mode).toBe('hybrid');
    expect(recordedTaskTypes).toContain('RETRIEVAL_QUERY');
    expect(semanticRes.results[0]!.assetPath).toBe('@sonniss/mystery_clip_01.wav');
    expect(semanticRes.results[0]!.multiVariation).toBe(true);

    // Deleting a file and re-indexing compacts assets_embeddings.f32 cleanly
    await fs.rm(path.join(sonnissDir, 'mystery_clip_02.wav'));
    const reindexed = await service.indexAssets({ enrichEmbeddings: true });
    expect(reindexed.summary.removedStale).toBe(1);
    expect(reindexed.summary.embeddedCount).toBe(0); // reused cached vector for clip_01!
    const compactedStat = await fs.stat(store.assetsEmbeddingsPath);
    expect(compactedStat.size).toBe(1 * 128 * 4);

    // Corrupt .f32 byte length -> graceful fallback to BM25 with warning
    await fs.writeFile(store.assetsEmbeddingsPath, Buffer.alloc(16));
    // Bump manifest mtime slightly so cache reloads
    const manifestRaw = await fs.readFile(store.assetsIndexPath, 'utf8');
    await fs.writeFile(store.assetsIndexPath, manifestRaw);
    const freshService = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
      assetEnricher: mockEnricher,
      geminiEmbeddingModel: 'gemini-embedding-2',
      assetEmbeddingDims: 128,
    });
    const fallbackRes = await freshService.searchAssets({ query: 'wolf howl' });
    expect(fallbackRes.mode).toBe('bm25');
    expect(fallbackRes.warnings?.[0]).toMatch(/mismatch/i);
    expect(fallbackRes.results[0]!.assetPath).toBe('@sonniss/mystery_clip_01.wav');
  });

  it('slices SFX hits accurately (without inflating tailMs) and loops sliced ambient beds via aloop', async () => {
    // Clamp warning unit test
    const clampWarnings: string[] = [];
    const clamped = computeEffectiveClipSpan(1000, 1500, 500, 'SFX "s1"', clampWarnings);
    expect(clamped.isSliced).toBe(true);
    expect(clamped.startMs).toBe(950);
    expect(clamped.durationMs).toBe(50);
    expect(clampWarnings.length).toBeGreaterThanOrEqual(1);

    // Multi-variation 5s SFX: silence 0..2s, loud tone burst 2.0..2.6s, silence 2.6..5.0s
    await fs.writeFile(
      path.join(sonnissDir, 'Glass', 'GLASSBrk_Multi.wav'),
      makeWindowedBurstWav(5000, 2000, 2600),
    );
    // 3s bed: silence 0..1s, steady tone 1.0..1.5s, silence 1.5..3.0s
    await fs.writeFile(
      path.join(npsDir, 'wind_segments.wav'),
      makeWindowedBurstWav(3000, 1000, 1500),
    );

    const store = new ProjectStore(dataDir, {
      assetLibraryMounts: [
        { alias: 'sonniss', rootDir: sonnissDir, readOnly: true },
        { alias: 'nps', rootDir: npsDir, readOnly: true },
      ],
    });
    await store.ensureDataDirs();
    const service = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
    });

    // 1. Sliced SFX test: 600ms slice from 2.0s..2.6s + 300ms tail -> ~900ms master (NOT 5300ms!)
    const sfxProj = await service.createProject({
      id: 'slice_sfx_test',
      name: 'Slice SFX Test',
      includeDefaultRoomTone: false,
      audio: { tailMs: 300 },
    });
    await service.upsertSfx(sfxProj.id, 'hit_2', {
      label: 'Hit 2',
      assetPath: '@sonniss/Glass/GLASSBrk_Multi.wav',
      anchor: { cueId: null, edge: 'start', offsetMs: 0 },
      gainDb: 0,
      pan: 0,
      clipStartMs: 2000,
      clipDurationMs: 600,
      fadeInMs: 15,
      fadeOutMs: 40,
    });

    const sfxMix = await service.mixProject(sfxProj.id, { format: 'wav' });
    const sfxOut = store.resolveProjectFile(sfxProj.id, sfxMix.exportRecord.audioPath);
    const sfxProbe = await probeAudio(sfxOut);
    expect(sfxProbe.durationMs).toBeGreaterThanOrEqual(820);
    expect(sfxProbe.durationMs).toBeLessThanOrEqual(1050);
    // Must contain the loud 2.0..2.6s burst (not silence from 0..0.6s!)
    expect(sfxMix.telemetry.measuredRmsDbfs).toBeGreaterThan(-25);

    // 2. Sliced looped bed test: 500ms tone window (1.0..1.5s) looped across a ~2.8s cue + tail
    const bedProj = await service.createProject({
      id: 'slice_bed_test',
      name: 'Slice Bed Test',
      includeDefaultRoomTone: false,
      audio: { tailMs: 1500 },
    });
    await service.addCue(bedProj.id, {
      id: 'c1',
      speaker: 'mara',
      text: 'Testing looped sliced bed energy across the whole tail.',
    });
    await service.renderTake(bedProj.id, 'c1');
    await service.upsertBed(bedProj.id, 'sliced_wind', {
      label: 'Sliced Wind Loop',
      kind: 'asset_file',
      assetPath: '@nps/wind_segments.wav',
      gainDb: -12,
      loop: true,
      clipStartMs: 1000,
      clipDurationMs: 500,
      fadeInMs: 50,
      fadeOutMs: 50,
      ducking: { enabled: false, amountDb: 0, attackMs: 100, releaseMs: 800 },
    });

    const bedMix = await service.mixProject(bedProj.id, { format: 'wav' });
    const bedOut = store.resolveProjectFile(bedProj.id, bedMix.exportRecord.audioPath);
    const bedProbe = await probeAudio(bedOut);
    // Slice the final tail (well past 500ms) to confirm aloop kept the 500ms tone looping!
    const tailSlice = path.join(tempRoot, 'bed_tail.wav');
    const tailStart = Math.max(0.5, (bedProbe.durationMs - 900) / 1000);
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-y',
      '-ss',
      tailStart.toFixed(3),
      '-t',
      '0.6',
      '-i',
      bedOut,
      '-c:a',
      'pcm_s16le',
      tailSlice,
    ]);
    const tailMeasure = await measureAudioLoudness(tailSlice);
    expect(tailMeasure.measuredRmsDbfs).toBeGreaterThan(-30);
  });

  it('auditions assets via REST and MCP (direct stream + fast -ss OGG slice + async index job)', async () => {
    await fs.writeFile(
      path.join(sonnissDir, 'Glass', 'GLASSBrk_Long.wav'),
      makeWindowedBurstWav(6000, 3000, 4500),
    );
    const store = new ProjectStore(dataDir, {
      assetLibraryMounts: [{ alias: 'sonniss', rootDir: sonnissDir, readOnly: true }],
    });
    await store.ensureDataDirs();
    const service = new StudioService({
      store,
      providers: { mock: new MockTtsProvider() },
      defaultProvider: 'mock',
    });

    // --- REST API ---
    const app = buildServer({ service });
    await app.ready();
    try {
      // GET /assets stays scoped to local assets + returns mounts summary
      const listRes = await app.inject({ method: 'GET', url: '/assets' });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().assets).toEqual([]);
      expect(listRes.json().mounts.map((m: { alias: string }) => m.alias)).toEqual([
        'local',
        'sonniss',
      ]);

      // Async POST /assets/index (wait: false) + poll /jobs/:jobId
      const idxRes = await app.inject({
        method: 'POST',
        url: '/assets/index',
        payload: { wait: false },
      });
      expect(idxRes.statusCode).toBe(202);
      const { jobId } = idxRes.json() as { jobId: string };
      let jobStatus = '';
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const poll = await app.inject({ method: 'GET', url: `/jobs/${jobId}` });
        jobStatus = poll.json().status;
        if (jobStatus === 'completed' || jobStatus === 'failed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(jobStatus).toBe('completed');

      // GET /assets/search
      const searchRes = await app.inject({
        method: 'GET',
        url: '/assets/search?query=glass+break&mount=sonniss',
      });
      expect(searchRes.statusCode).toBe(200);
      expect(searchRes.json().results[0].assetPath).toBe('@sonniss/Glass/GLASSBrk_Long.wav');

      // GET /assets/audio sliced via query param -> OGG Opus
      const audioRes = await app.inject({
        method: 'GET',
        url: '/assets/audio?assetPath=%40sonniss%2FGlass%2FGLASSBrk_Long.wav&startSec=3&maxDurationSec=1.5',
      });
      expect(audioRes.statusCode).toBe(200);
      expect(audioRes.headers['content-type']).toBe('audio/ogg');
      expect(audioRes.rawPayload.subarray(0, 4).toString('ascii')).toBe('OggS');

      // Out-of-bounds startSec returns 400
      const badSeek = await app.inject({
        method: 'GET',
        url: '/assets/audio?assetPath=%40sonniss%2FGlass%2FGLASSBrk_Long.wav&startSec=99',
      });
      expect(badSeek.statusCode).toBe(400);
    } finally {
      await app.close();
    }

    // --- MCP Server ---
    const mcpServer = createMcpServer(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'test-asset-mcp', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const idxTool = await client.callTool({
        name: 'booth_index_assets',
        arguments: { wait: true },
      });
      expect(idxTool.isError).not.toBe(true);
      const idxPayload = parseToolJson(idxTool) as { summary: { totalAssets: number } };
      expect(idxPayload.summary.totalAssets).toBe(1);

      const searchTool = await client.callTool({
        name: 'booth_search_assets',
        arguments: { query: 'glass shatter' },
      });
      expect(searchTool.isError).not.toBe(true);
      const searchPayload = parseToolJson(searchTool) as {
        results: Array<{ assetPath: string }>;
      };
      expect(searchPayload.results[0]!.assetPath).toBe('@sonniss/Glass/GLASSBrk_Long.wav');

      // Audition full short file (direct WAV) vs sliced OGG under 10 MB cap
      const expectedSourcePath = path.join(sonnissDir, 'Glass', 'GLASSBrk_Long.wav');
      const directAud = await client.callTool({
        name: 'booth_get_asset_audio',
        arguments: { assetPath: '@sonniss/Glass/GLASSBrk_Long.wav' },
      });
      expect(directAud.isError).not.toBe(true);
      const directMeta = parseToolJson(directAud);
      expect(directMeta.filePath).toBe(expectedSourcePath);
      expect(directMeta.previewAudioPath).toBe(expectedSourcePath);
      expect(directMeta.transcoded).toBe(false);
      const directBlocks = directAud.content as Array<{
        type: string;
        mimeType?: string;
        data?: string;
      }>;
      const directAudio = directBlocks.find((b) => b.type === 'audio');
      expect(directAudio?.mimeType).toBe('audio/wav');

      const slicedAud = await client.callTool({
        name: 'booth_get_asset_audio',
        arguments: {
          assetPath: '@sonniss/Glass/GLASSBrk_Long.wav',
          startSec: 3.0,
          maxDurationSec: 1.5,
        },
      });
      expect(slicedAud.isError).not.toBe(true);
      const slicedMeta = parseToolJson(slicedAud);
      expect(slicedMeta.transcoded).toBe(true);
      expect(slicedMeta.inlineAudioIncluded).toBe(true);
      expect(slicedMeta.filePath).toBe(expectedSourcePath);
      expect(typeof slicedMeta.previewAudioPath).toBe('string');
      expect(String(slicedMeta.previewAudioPath)).toContain(path.join(dataDir, 'asset_previews'));
      expect(String(slicedMeta.previewAudioPath).endsWith('.ogg')).toBe(true);
      const cachedPreviewBytes = await fs.readFile(String(slicedMeta.previewAudioPath));
      expect(cachedPreviewBytes.subarray(0, 4).toString('ascii')).toBe('OggS');
      expect(Number(slicedMeta.sizeBytes)).toBeLessThan(10 * 1024 * 1024);
      const slicedBlocks = slicedAud.content as Array<{
        type: string;
        mimeType?: string;
        data?: string;
      }>;
      const slicedAudio = slicedBlocks.find((b) => b.type === 'audio');
      expect(slicedAudio?.mimeType).toBe('audio/ogg');
      expect(Buffer.from(slicedAudio!.data!, 'base64').subarray(0, 4).toString('ascii')).toBe(
        'OggS',
      );

      // inlineAudio: false omits base64 block while returning cached previewAudioPath & filePath
      const noInlineAud = await client.callTool({
        name: 'booth_get_asset_audio',
        arguments: {
          assetPath: '@sonniss/Glass/GLASSBrk_Long.wav',
          startSec: 3.0,
          maxDurationSec: 1.5,
          inlineAudio: false,
        },
      });
      expect(noInlineAud.isError).not.toBe(true);
      const noInlineMeta = parseToolJson(noInlineAud);
      expect(noInlineMeta.inlineAudioIncluded).toBe(false);
      expect(noInlineMeta.filePath).toBe(expectedSourcePath);
      expect(noInlineMeta.previewAudioPath).toBe(slicedMeta.previewAudioPath);
      const noInlineBlocks = noInlineAud.content as Array<{ type: string }>;
      expect(noInlineBlocks.some((b) => b.type === 'audio')).toBe(false);
    } finally {
      await client.close();
      await mcpServer.close();
    }
  });
});
