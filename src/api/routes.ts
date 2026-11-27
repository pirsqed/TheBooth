import * as fs from 'node:fs';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BedDuckingSchema,
  CueMixSchema,
  CueTimingSchema,
  EqPresetSchema,
  ExportFormatSchema,
  ProjectAudioSettingsSchema,
  RoomToneStyleSchema,
  SafeIdSchema,
  SfxAnchorSchema,
} from '../types/project.js';
import { StudioService } from '../studio/service.js';
import { StoreError } from '../studio/store.js';
import type { VisualMode, VisualPanel, VisualPreset } from '../audio/visualize.js';

const CreateProjectBodySchema = z.object({
  id: SafeIdSchema.optional(),
  name: z.string().min(1),
  audio: ProjectAudioSettingsSchema.partial().optional(),
  includeDefaultRoomTone: z.boolean().optional(),
});

const UpdateProjectBodySchema = z.object({
  name: z.string().min(1).optional(),
  audio: ProjectAudioSettingsSchema.partial().optional(),
});

const UpsertVoiceBodySchema = z.object({
  label: z.string().min(1),
  provider: z.string().min(1).default('gemini'),
  providerVoiceId: z.string().min(1),
  defaultDirection: z.string().optional(),
  defaultEqPreset: EqPresetSchema.optional(),
  defaultPan: z.number().min(-1).max(1).optional(),
  notes: z.string().optional(),
});

const ImportScriptBodySchema = z.object({
  script: z.string().min(1),
  mode: z.enum(['replace', 'append']).default('replace'),
  defaultSpeaker: z.string().min(1).optional(),
  maxChunkBytes: z.number().int().min(200).max(32000).optional(),
});

const AddCueBodySchema = z.object({
  id: SafeIdSchema.optional(),
  speaker: z.string().min(1),
  text: z.string().min(1),
  direction: z.string().nullable().optional(),
  timing: CueTimingSchema.partial().optional(),
  mix: CueMixSchema.partial().optional(),
  insertAtIndex: z.number().int().min(0).optional(),
});

const UpdateCueBodySchema = z.object({
  speaker: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  direction: z.string().nullable().optional(),
  timing: CueTimingSchema.partial().optional(),
  mix: CueMixSchema.partial().optional(),
  activeTakeId: z.string().nullable().optional(),
});

const RenderTakeBodySchema = z
  .object({
    activate: z.boolean().optional(),
    model: z.string().min(1).optional(),
  })
  .optional();

const RenderAllBodySchema = z
  .object({
    concurrency: z.number().int().min(1).max(8).optional(),
    force: z.boolean().optional(),
    wait: z.boolean().optional(),
  })
  .optional();

const UpsertBedBodySchema = z.object({
  label: z.string().min(1),
  kind: z.enum(['synthetic_room_tone', 'asset_file']),
  roomToneStyle: RoomToneStyleSchema.optional(),
  assetPath: z.string().min(1).optional(),
  gainDb: z.number().min(-80).max(12),
  loop: z.boolean().default(true),
  startMs: z.number().int().min(0).optional(),
  endMs: z.number().int().min(0).nullable().optional(),
  startCueId: z.string().nullable().optional(),
  startEdge: z.enum(['start', 'end']).optional(),
  startOffsetMs: z.number().int().optional(),
  endCueId: z.string().nullable().optional(),
  endEdge: z.enum(['start', 'end']).optional(),
  endOffsetMs: z.number().int().optional(),
  clipStartMs: z.number().int().min(0).optional(),
  clipDurationMs: z.number().int().positive().optional(),
  fadeInMs: z.number().int().min(0).max(30000).default(1500),
  fadeOutMs: z.number().int().min(0).max(30000).default(3000),
  ducking: BedDuckingSchema.default({
    enabled: true,
    amountDb: -6,
    attackMs: 100,
    releaseMs: 800,
  }),
});

const UpsertSfxBodySchema = z.object({
  label: z.string().min(1),
  assetPath: z.string().min(1),
  anchor: SfxAnchorSchema.default({ edge: 'end', offsetMs: 0 }),
  gainDb: z.number().min(-48).max(12).default(-6),
  pan: z.number().min(-1).max(1).default(0),
  clipStartMs: z.number().int().min(0).optional(),
  clipDurationMs: z.number().int().positive().optional(),
  fadeInMs: z.number().int().min(0).max(5000).default(15),
  fadeOutMs: z.number().int().min(0).max(5000).default(40),
});

const IndexAssetsBodySchema = z
  .object({
    mounts: z.array(z.string().min(1)).optional(),
    forceReprobe: z.boolean().optional(),
    concurrency: z.number().int().min(1).max(16).optional(),
    enrichCaptions: z.boolean().optional(),
    maxCaptionCount: z.number().int().min(1).max(500).optional(),
    onlyMissingDescriptions: z.boolean().optional(),
    enrichEmbeddings: z.boolean().optional(),
    wait: z.boolean().optional(),
  })
  .optional();

const MixBodySchema = z
  .object({
    format: ExportFormatSchema.optional(),
    outputPath: z.string().min(1).optional(),
    fromCueId: SafeIdSchema.optional(),
    toCueId: SafeIdSchema.optional(),
    startSec: z.number().min(0).optional(),
    endSec: z.number().positive().optional(),
  })
  .optional();

const UploadAssetBodySchema = z.object({
  assetPath: z.string().min(1),
  dataBase64: z.string().min(1),
});

const VoiceGenderSchema = z.enum(['female', 'male', 'neutral']);
const VoicePitchSchema = z.enum(['low', 'medium', 'high']);

const DesignVoiceBodySchema = z.object({
  provider: z.string().min(1).optional(),
  displayName: z.string().min(1),
  prompt: z.string().min(5),
  description: z.string().min(1).optional(),
  gender: VoiceGenderSchema.optional(),
  languageCode: z.string().min(2).optional(),
  regionCode: z.string().min(2).optional(),
  accent: z.string().min(1).optional(),
  pitch: VoicePitchSchema.optional(),
  persona: z.string().min(1).optional(),
  context: z.string().min(1).optional(),
  baseVoice: z.string().min(1).optional(),
  store: z.boolean().optional(),
  model: z.string().min(1).optional(),
  includeSampleAudioBase64: z.boolean().optional(),
});

function parseQueryStringArray(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const raw = Array.isArray(val) ? val : [val];
  const items = raw
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

const AuditionVoiceBodySchema = z.object({
  candidateVoiceIds: z.array(z.string().min(1)).min(1).max(10),
  sampleText: z.string().min(1),
  direction: z.string().nullable().optional(),
  notes: z.string().optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  renderReel: z.boolean().optional(),
  reelFormat: ExportFormatSchema.optional(),
  reelOutputPath: z.string().min(1).optional(),
});

const DirectCueBodySchema = z
  .object({
    persona: z.string().nullable().optional(),
    extraInstructions: z.string().nullable().optional(),
    maxRetakes: z.number().int().min(0).max(5).optional(),
    allowMixAdjustments: z.boolean().optional(),
    allowTextTagTweaks: z.boolean().optional(),
    ttsModel: z.string().min(1).optional(),
  })
  .optional();

const DirectProjectBodySchema = z
  .object({
    cueIds: z.array(SafeIdSchema).optional(),
    persona: z.string().nullable().optional(),
    extraInstructions: z.string().nullable().optional(),
    maxRetakes: z.number().int().min(0).max(5).optional(),
    maxTotalRetakes: z.number().int().min(0).max(100).optional(),
    allowMixAdjustments: z.boolean().optional(),
    allowTextTagTweaks: z.boolean().optional(),
    ttsModel: z.string().min(1).optional(),
    wait: z.boolean().optional(),
  })
  .optional();

function contentTypeForFormat(format: string): string {
  switch (format) {
    case 'wav':
      return 'audio/wav';
    case 'ogg':
      return 'audio/ogg';
    case 'mp3':
      return 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
}

export function registerRoutes(app: FastifyInstance, service: StudioService): void {
  app.get('/', async () => ({
    service: 'the-booth',
    version: '0.1.0',
    status: 'ok',
    endpoints: {
      health: 'GET /health',
      projects: 'GET /projects | POST /projects | GET /projects/:id | PATCH /projects/:id | DELETE /projects/:id',
      voices: 'PUT /projects/:id/voices/:voiceId',
      importScript: 'POST /projects/:id/import-script',
      cues: 'POST /projects/:id/cues | PATCH /projects/:id/cues/:cueId | DELETE /projects/:id/cues/:cueId',
      render: 'POST /projects/:id/cues/:cueId/render | POST /projects/:id/render-all | GET /jobs/:jobId',
      takeAudio: 'GET /projects/:id/cues/:cueId/takes/:takeId/audio',
      beds: 'PUT /projects/:id/beds/:bedId | DELETE /projects/:id/beds/:bedId',
      sfx: 'PUT /projects/:id/sfx/:sfxId | DELETE /projects/:id/sfx/:sfxId',
      mix: 'POST /projects/:id/mix | GET /projects/:id/exports/:exportId/audio',
      assets:
        'GET /assets | POST /assets | PUT /assets/* | DELETE /assets/* | POST /assets/index | GET /assets/search | GET /assets/audio',
      casting:
        'GET /providers/:provider/voices | GET /providers/:provider/voices/:voiceId | GET /providers/:provider/voices/:voiceId/preview | DELETE /providers/:provider/voices/:voiceId | POST /voices/design | POST /projects/:id/voices/:voiceId/audition | POST /projects/:id/voices/:voiceId/auditions/:auditionId/select',
      director:
        'GET /director/personas | POST /projects/:id/cues/:cueId/direct | POST /projects/:id/direct',
    },
  }));

  app.get('/health', async () => ({
    status: 'ok',
    service: 'the-booth',
    version: '0.1.0',
  }));

  // --- Projects ---
  app.post('/projects', async (req, reply) => {
    const body = CreateProjectBodySchema.parse(req.body);
    const project = await service.createProject(body);
    return reply.code(201).send(project);
  });

  app.get('/projects', async () => {
    const projects = await service.listProjects();
    return { projects };
  });

  app.get<{ Params: { id: string } }>('/projects/:id', async (req) => {
    return service.getProject(req.params.id);
  });

  app.patch<{ Params: { id: string } }>('/projects/:id', async (req) => {
    const body = UpdateProjectBodySchema.parse(req.body);
    return service.updateProject(req.params.id, body);
  });

  app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    await service.deleteProject(req.params.id);
    return reply.code(204).send();
  });

  // --- Voices ---
  app.put<{ Params: { id: string; voiceId: string } }>(
    '/projects/:id/voices/:voiceId',
    async (req) => {
      const body = UpsertVoiceBodySchema.parse(req.body);
      return service.upsertVoice(req.params.id, req.params.voiceId, body);
    },
  );

  // --- Script Import ---
  app.post<{ Params: { id: string } }>(
    '/projects/:id/import-script',
    async (req) => {
      const body = ImportScriptBodySchema.parse(req.body);
      return service.importScript(req.params.id, body);
    },
  );

  // --- Cues ---
  app.post<{ Params: { id: string } }>('/projects/:id/cues', async (req, reply) => {
    const body = AddCueBodySchema.parse(req.body);
    const result = await service.addCue(req.params.id, body);
    return reply.code(201).send(result);
  });

  app.patch<{ Params: { id: string; cueId: string } }>(
    '/projects/:id/cues/:cueId',
    async (req) => {
      const body = UpdateCueBodySchema.parse(req.body);
      return service.updateCue(req.params.id, req.params.cueId, body);
    },
  );

  app.delete<{ Params: { id: string; cueId: string } }>(
    '/projects/:id/cues/:cueId',
    async (req) => {
      return service.deleteCue(req.params.id, req.params.cueId);
    },
  );

  const SplitCueBodySchema = z.object({
    atMs: z.number().int().min(50),
    gapMs: z.number().int().min(-5000).max(60000).optional(),
    secondCueId: SafeIdSchema.optional(),
    textBefore: z.string().min(1).optional(),
    textAfter: z.string().min(1).optional(),
  });

  app.post<{ Params: { id: string; cueId: string } }>(
    '/projects/:id/cues/:cueId/split',
    async (req, reply) => {
      const body = SplitCueBodySchema.parse(req.body);
      const result = await service.splitCue(req.params.id, req.params.cueId, body);
      return reply.code(201).send(result);
    },
  );

  // --- Synthesis (Stage 1) ---
  app.post<{ Params: { id: string; cueId: string } }>(
    '/projects/:id/cues/:cueId/render',
    async (req, reply) => {
      const body = RenderTakeBodySchema.parse(req.body);
      const result = await service.renderTake(req.params.id, req.params.cueId, body ?? {});
      return reply.code(201).send(result);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/projects/:id/render-all',
    async (req, reply) => {
      const body = RenderAllBodySchema.parse(req.body) ?? {};
      const { job, done } = await service.startRenderAll(req.params.id, {
        concurrency: body.concurrency,
        force: body.force,
      });
      if (body.wait) {
        const finalJob = await done;
        return reply.code(200).send({ jobId: finalJob.id, job: finalJob });
      }
      // Keep background promise rejection-safe (errors are recorded on job)
      done.catch(() => {});
      return reply.code(202).send({ jobId: job.id, job });
    },
  );

  app.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (req) => {
    const job = service.getJob(req.params.jobId);
    if (!job) {
      throw new StoreError(`Job not found: ${req.params.jobId}`, 404);
    }
    return job;
  });

  app.get<{ Params: { id: string; cueId: string; takeId: string } }>(
    '/projects/:id/cues/:cueId/takes/:takeId/audio',
    async (req, reply) => {
      const { filePath, take } = await service.getTakeAudioFile(
        req.params.id,
        req.params.cueId,
        req.params.takeId,
      );
      if (!fs.existsSync(filePath)) {
        throw new StoreError(`Take audio file missing on disk: ${take.audioPath}`, 404);
      }
      reply.header('Content-Type', 'audio/wav');
      reply.header('Content-Disposition', `inline; filename="${take.id}.wav"`);
      return reply.send(fs.createReadStream(filePath));
    },
  );

  // --- Beds ---
  app.put<{ Params: { id: string; bedId: string } }>(
    '/projects/:id/beds/:bedId',
    async (req) => {
      const body = UpsertBedBodySchema.parse(req.body);
      return service.upsertBed(req.params.id, req.params.bedId, body);
    },
  );

  app.delete<{ Params: { id: string; bedId: string } }>(
    '/projects/:id/beds/:bedId',
    async (req) => {
      return service.deleteBed(req.params.id, req.params.bedId);
    },
  );

  // --- SFX ---
  app.put<{ Params: { id: string; sfxId: string } }>(
    '/projects/:id/sfx/:sfxId',
    async (req) => {
      const body = UpsertSfxBodySchema.parse(req.body);
      return service.upsertSfx(req.params.id, req.params.sfxId, body);
    },
  );

  app.delete<{ Params: { id: string; sfxId: string } }>(
    '/projects/:id/sfx/:sfxId',
    async (req) => {
      return service.deleteSfx(req.params.id, req.params.sfxId);
    },
  );

  // --- Mixdown (Stage 2) ---
  app.post<{ Params: { id: string } }>('/projects/:id/mix', async (req) => {
    const body = MixBodySchema.parse(req.body) ?? {};
    const { exportRecord, telemetry, deliveredPath } = await service.mixProject(
      req.params.id,
      {
        format: body.format,
        outputPath: body.outputPath,
        fromCueId: body.fromCueId,
        toCueId: body.toCueId,
        startSec: body.startSec,
        endSec: body.endSec,
      },
    );
    return {
      export: exportRecord,
      telemetry,
      ...(deliveredPath ? { deliveredPath } : {}),
    };
  });

  app.get<{ Params: { id: string; exportId: string } }>(
    '/projects/:id/exports/:exportId/audio',
    async (req, reply) => {
      const { filePath, exportRecord } = await service.getExportAudioFile(
        req.params.id,
        req.params.exportId,
      );
      if (!fs.existsSync(filePath)) {
        throw new StoreError(
          `Export audio file missing on disk: ${exportRecord.audioPath}`,
          404,
        );
      }
      reply.header('Content-Type', contentTypeForFormat(exportRecord.format));
      reply.header(
        'Content-Disposition',
        `inline; filename="${exportRecord.id}.${exportRecord.format}"`,
      );
      return reply.send(fs.createReadStream(filePath));
    },
  );

  // --- Visual-Audio Inspection (Stage 2 Eyes) ---
  const parseVisualQuery = (q: Record<string, unknown>) => {
    const presetRaw = typeof q.preset === 'string' ? q.preset.trim() : undefined;
    const preset: VisualPreset | undefined =
      presetRaw === 'master' || presetRaw === 'fast' ? presetRaw : undefined;
    if (presetRaw && !preset) {
      throw new StoreError(`Invalid preset "${presetRaw}". Expected "master" or "fast".`, 400);
    }

    const modeRaw = typeof q.mode === 'string' ? q.mode.trim() : undefined;
    const mode: VisualMode | undefined =
      modeRaw === 'zoom' || modeRaw === 'overview' ? modeRaw : undefined;
    if (modeRaw && !mode) {
      throw new StoreError(`Invalid mode "${modeRaw}". Expected "zoom" or "overview".`, 400);
    }

    const parseOptNum = (v: unknown, name: string): number | undefined => {
      if (v === undefined || v === '') return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new StoreError(`Invalid ${name}: ${String(v)}`, 400);
      }
      return n;
    };

    const allowedPanels = new Set<VisualPanel>(['cues', 'waveform', 'rms', 'spectrogram']);
    let panels: VisualPanel[] | undefined;
    if (typeof q.panels === 'string' && q.panels.trim()) {
      const parsed = q.panels
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const p of parsed) {
        if (!allowedPanels.has(p as VisualPanel)) {
          throw new StoreError(
            `Invalid panel "${p}". Allowed: cues, waveform, rms, spectrogram.`,
            400,
          );
        }
      }
      panels = parsed as VisualPanel[];
    }

    const format: 'png' | 'json' = q.format === 'json' ? 'json' : 'png';
    return {
      preset,
      mode,
      startSec: parseOptNum(q.startSec, 'startSec'),
      endSec: parseOptNum(q.endSec, 'endSec'),
      panels,
      format,
    };
  };

  const sendVisualReply = (
    reply: import('fastify').FastifyReply,
    res: Awaited<ReturnType<StudioService['inspectVisual']>>,
    format: 'png' | 'json',
    filename: string,
  ) => {
    if (format === 'json') {
      const { pngBuffer, ...meta } = res;
      return {
        ...meta,
        sizeBytes: pngBuffer.length,
        imageBase64: pngBuffer.toString('base64'),
      };
    }
    reply.header('Content-Type', 'image/png');
    reply.header('Content-Disposition', `inline; filename="${filename}.png"`);
    reply.header('X-Booth-Window', `${res.startSec}-${res.endSec}`);
    reply.header('X-Booth-Px-Per-Sec', String(res.pxPerSec));
    if (res.warnings.length > 0) {
      reply.header('X-Booth-Warnings', res.warnings.join(' | '));
    }
    return reply.send(res.pngBuffer);
  };

  app.get<{
    Params: { id: string; exportId: string };
    Querystring: Record<string, unknown>;
  }>('/projects/:id/exports/:exportId/visual', async (req, reply) => {
    const opts = parseVisualQuery(req.query ?? {});
    const res = await service.inspectVisual({
      projectId: req.params.id,
      target: { type: 'export', exportId: req.params.exportId },
      preset: opts.preset,
      mode: opts.mode,
      startSec: opts.startSec,
      endSec: opts.endSec,
      panels: opts.panels,
    });
    return sendVisualReply(reply, res, opts.format, `${req.params.exportId}_${res.preset}`);
  });

  app.get<{
    Params: { id: string; cueId: string; takeId: string };
    Querystring: Record<string, unknown>;
  }>('/projects/:id/cues/:cueId/takes/:takeId/visual', async (req, reply) => {
    const opts = parseVisualQuery(req.query ?? {});
    const res = await service.inspectVisual({
      projectId: req.params.id,
      target: { type: 'take', cueId: req.params.cueId, takeId: req.params.takeId },
      preset: opts.preset,
      mode: opts.mode,
      startSec: opts.startSec,
      endSec: opts.endSec,
      panels: opts.panels,
    });
    return sendVisualReply(reply, res, opts.format, `${req.params.takeId}_${res.preset}`);
  });

  app.get<{
    Params: { id: string; voiceId: string; auditionId: string };
    Querystring: Record<string, unknown>;
  }>('/projects/:id/voices/:voiceId/auditions/:auditionId/visual', async (req, reply) => {
    const opts = parseVisualQuery(req.query ?? {});
    const res = await service.inspectVisual({
      projectId: req.params.id,
      target: {
        type: 'audition',
        voiceId: req.params.voiceId,
        auditionId: req.params.auditionId,
      },
      preset: opts.preset,
      mode: opts.mode,
      startSec: opts.startSec,
      endSec: opts.endSec,
      panels: opts.panels,
    });
    return sendVisualReply(reply, res, opts.format, `${req.params.auditionId}_${res.preset}`);
  });

  // --- Shared Asset Library ---
  app.get('/assets', async () => {
    const [assets, mounts] = await Promise.all([
      service.listAssets(),
      service.listAssetMountsSummary(),
    ]);
    return { assets, mounts };
  });

  app.post('/assets/index', async (req, reply) => {
    const body = IndexAssetsBodySchema.parse(req.body) ?? {};
    const { wait, ...opts } = body;
    const { job, done } = await service.startIndexAssets(opts);
    if (wait === false) {
      done.catch(() => {});
      return reply.code(202).send({ jobId: job.id, job });
    }
    const finished = await done;
    return reply.code(200).send({
      jobId: finished.job.id,
      job: finished.job,
      summary: finished.summary,
    });
  });

  app.get<{ Querystring: Record<string, unknown> }>('/assets/search', async (req) => {
    const q = req.query ?? {};
    const query = typeof (q.query ?? q.q) === 'string' ? String(q.query ?? q.q) : '';
    const rawKind = typeof q.kind === 'string' ? q.kind.toLowerCase() : 'any';
    if (rawKind !== 'sfx' && rawKind !== 'bed' && rawKind !== 'any') {
      throw new StoreError(`Invalid kind "${rawKind}" (expected sfx, bed, or any)`, 400);
    }
    const parseOptNum = (v: unknown, label: string): number | undefined => {
      if (v === undefined || v === null || v === '') return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new StoreError(`Invalid ${label}: "${v}"`, 400);
      }
      return n;
    };
    const stereoOnly =
      q.stereoOnly === true || q.stereoOnly === 'true' || q.stereoOnly === '1';

    return service.searchAssets({
      query,
      kind: rawKind,
      mount: typeof q.mount === 'string' && q.mount.trim() ? q.mount.trim() : undefined,
      minDurationSec: parseOptNum(q.minDurationSec, 'minDurationSec'),
      maxDurationSec: parseOptNum(q.maxDurationSec, 'maxDurationSec'),
      stereoOnly: stereoOnly || undefined,
      limit: parseOptNum(q.limit, 'limit'),
    });
  });

  app.get<{ Querystring: Record<string, unknown> }>('/assets/audio', async (req, reply) => {
    const q = req.query ?? {};
    const assetPath = typeof q.assetPath === 'string' ? q.assetPath.trim() : '';
    if (!assetPath) {
      throw new StoreError('Query parameter "assetPath" is required', 400);
    }
    const startSec =
      q.startSec !== undefined && q.startSec !== '' ? Number(q.startSec) : undefined;
    const maxDurationSec =
      q.maxDurationSec !== undefined && q.maxDurationSec !== ''
        ? Number(q.maxDurationSec)
        : undefined;
    if (startSec !== undefined && (!Number.isFinite(startSec) || startSec < 0)) {
      throw new StoreError(`Invalid startSec: "${q.startSec}"`, 400);
    }
    if (
      maxDurationSec !== undefined &&
      (!Number.isFinite(maxDurationSec) || maxDurationSec <= 0)
    ) {
      throw new StoreError(`Invalid maxDurationSec: "${q.maxDurationSec}"`, 400);
    }

    const preview = await service.getAssetAudio({
      assetPath,
      startSec,
      maxDurationSec,
    });

    if (q.format === 'json') {
      const { audioBuffer, ...meta } = preview;
      return {
        ...meta,
        audioBase64: audioBuffer.toString('base64'),
      };
    }

    reply.header('Content-Type', preview.mimeType);
    reply.header('X-Booth-Asset-Path', preview.assetPath);
    reply.header('X-Booth-Total-Duration-Sec', String(preview.totalDurationSec));
    reply.header('X-Booth-Preview-Start-Sec', String(preview.previewStartSec));
    reply.header('X-Booth-Preview-Duration-Sec', String(preview.previewDurationSec));
    return reply.send(preview.audioBuffer);
  });

  app.post('/assets', async (req, reply) => {
    const body = UploadAssetBodySchema.parse(req.body);
    const buffer = Buffer.from(body.dataBase64, 'base64');
    const uploaded = await service.uploadAsset({
      assetPath: body.assetPath,
      buffer,
    });
    return reply.code(201).send(uploaded);
  });

  app.put<{ Params: { '*': string } }>('/assets/*', async (req, reply) => {
    const assetPath = req.params['*'];
    if (!Buffer.isBuffer(req.body)) {
      throw new StoreError(
        'Expected raw audio binary body (set Content-Type: audio/wav or application/octet-stream)',
        400,
      );
    }
    const uploaded = await service.uploadAsset({
      assetPath,
      buffer: req.body,
    });
    return reply.code(201).send(uploaded);
  });

  app.delete<{ Params: { '*': string } }>('/assets/*', async (req, reply) => {
    await service.deleteAsset(req.params['*']);
    return reply.code(204).send();
  });

  // --- Voice Catalog, Design & Auditioning (Milestone 4) ---
  app.get<{
    Params: { provider: string };
    Querystring: Record<string, unknown>;
  }>('/providers/:provider/voices', async (req) => {
    const q = req.query ?? {};
    const pageSizeRaw =
      q.pageSize !== undefined ? Number(q.pageSize) : undefined;
    const pageSize =
      pageSizeRaw !== undefined && Number.isFinite(pageSizeRaw)
        ? Math.max(1, Math.min(1000, Math.floor(pageSizeRaw)))
        : undefined;
    return service.listProviderVoices(req.params.provider, {
      type: parseQueryStringArray(q.type),
      languageCode: parseQueryStringArray(q.languageCode ?? q.language_code),
      regionCode: parseQueryStringArray(q.regionCode ?? q.region_code),
      accent: parseQueryStringArray(q.accent),
      gender: parseQueryStringArray(q.gender),
      pitch: parseQueryStringArray(q.pitch),
      persona: parseQueryStringArray(q.persona),
      contexts: parseQueryStringArray(q.contexts ?? q.context),
      search: typeof q.search === 'string' && q.search.trim() ? q.search.trim() : undefined,
      pageSize,
      pageToken:
        typeof (q.pageToken ?? q.page_token) === 'string'
          ? String(q.pageToken ?? q.page_token)
          : undefined,
    });
  });

  app.get<{ Params: { provider: string; voiceId: string } }>(
    '/providers/:provider/voices/:voiceId',
    async (req) => {
      const { voice } = await service.getProviderVoice(
        req.params.voiceId,
        req.params.provider,
      );
      return {
        ...voice,
        previewAudioAvailable: Boolean(voice.previewAudioPath),
        ...(voice.previewAudioPath
          ? {
              previewAudioUrl: `/providers/${encodeURIComponent(voice.provider)}/voices/${encodeURIComponent(voice.id)}/preview`,
            }
          : {}),
      };
    },
  );

  app.get<{ Params: { provider: string; voiceId: string } }>(
    '/providers/:provider/voices/:voiceId/preview',
    async (req, reply) => {
      const { filePath, voiceId } = await service.getVoicePreviewAudioFile(
        req.params.voiceId,
        req.params.provider,
      );
      if (!fs.existsSync(filePath)) {
        throw new StoreError(`Voice preview WAV missing on disk: ${voiceId}`, 404);
      }
      reply.header('Content-Type', 'audio/wav');
      reply.header('Content-Disposition', `inline; filename="${voiceId}.wav"`);
      return reply.send(fs.createReadStream(filePath));
    },
  );

  app.delete<{ Params: { provider: string; voiceId: string } }>(
    '/providers/:provider/voices/:voiceId',
    async (req) => {
      return service.deleteProviderVoice(req.params.voiceId, req.params.provider);
    },
  );

  app.post('/voices/design', async (req, reply) => {
    const { includeSampleAudioBase64, ...designInput } = DesignVoiceBodySchema.parse(req.body);
    const { voice, sampleWavBuffer } = await service.designVoice(designInput);
    const previewAvailable = Boolean(voice.previewAudioPath);
    return reply.code(201).send({
      ...voice,
      previewAudioAvailable: previewAvailable,
      ...(previewAvailable
        ? {
            previewAudioUrl: `/providers/${encodeURIComponent(voice.provider)}/voices/${encodeURIComponent(voice.voiceId)}/preview`,
          }
        : {}),
      ...(includeSampleAudioBase64 && sampleWavBuffer
        ? { sampleAudioBase64: sampleWavBuffer.toString('base64') }
        : {}),
    });
  });

  app.post<{ Params: { id: string; voiceId: string } }>(
    '/projects/:id/voices/:voiceId/audition',
    async (req, reply) => {
      const body = AuditionVoiceBodySchema.parse(req.body);
      const result = await service.auditionVoice(
        req.params.id,
        req.params.voiceId,
        body,
      );
      return reply.code(201).send(result);
    },
  );

  app.get<{ Params: { id: string; voiceId: string; auditionId: string } }>(
    '/projects/:id/voices/:voiceId/auditions/:auditionId/audio',
    async (req, reply) => {
      const { filePath, audition } = await service.getAuditionAudioFile(
        req.params.id,
        req.params.voiceId,
        req.params.auditionId,
      );
      if (!fs.existsSync(filePath)) {
        throw new StoreError(
          `Audition audio file missing on disk: ${audition.audioPath}`,
          404,
        );
      }
      reply.header('Content-Type', 'audio/wav');
      reply.header('Content-Disposition', `inline; filename="${audition.id}.wav"`);
      return reply.send(fs.createReadStream(filePath));
    },
  );

  app.post<{ Params: { id: string; voiceId: string; auditionId: string } }>(
    '/projects/:id/voices/:voiceId/auditions/:auditionId/select',
    async (req) => {
      const voice = await service.selectAudition(
        req.params.id,
        req.params.voiceId,
        req.params.auditionId,
      );
      return { voice };
    },
  );

  const AuditionReelBodySchema = z
    .object({
      auditionIds: z.array(SafeIdSchema).min(1).max(10).optional(),
      format: ExportFormatSchema.optional(),
      outputPath: z.string().min(1).optional(),
    })
    .optional();

  app.post<{ Params: { id: string; voiceId: string } }>(
    '/projects/:id/voices/:voiceId/auditions/reel',
    async (req, reply) => {
      const body = AuditionReelBodySchema.parse(req.body) ?? {};
      const reel = await service.renderAuditionReel(
        req.params.id,
        req.params.voiceId,
        body,
      );
      return reply.code(201).send(reel);
    },
  );

  const TakeAbReelBodySchema = z
    .object({
      takeIds: z.array(SafeIdSchema).min(1).max(6).optional(),
      contextBeforeCues: z.number().int().min(0).max(3).optional(),
      contextAfterCues: z.number().int().min(0).max(2).optional(),
      format: ExportFormatSchema.optional(),
      outputPath: z.string().min(1).optional(),
    })
    .optional();

  app.post<{ Params: { id: string; cueId: string } }>(
    '/projects/:id/cues/:cueId/ab-reel',
    async (req, reply) => {
      const body = TakeAbReelBodySchema.parse(req.body) ?? {};
      const reel = await service.renderTakeComparisonReel(
        req.params.id,
        req.params.cueId,
        body,
      );
      return reply.code(201).send(reel);
    },
  );

  // --- Director's Chair (Milestone 4) ---
  app.get('/director/personas', async () => ({
    personas: service.listDirectorPersonas(),
  }));

  app.post<{ Params: { id: string; cueId: string } }>(
    '/projects/:id/cues/:cueId/direct',
    async (req) => {
      const body = DirectCueBodySchema.parse(req.body) ?? {};
      return service.directCue(req.params.id, req.params.cueId, body);
    },
  );

  app.post<{ Params: { id: string } }>('/projects/:id/direct', async (req, reply) => {
    const body = DirectProjectBodySchema.parse(req.body) ?? {};
    const { wait, ...directOpts } = body;
    const { job, done } = await service.startDirectProject(req.params.id, directOpts);
    if (wait) {
      const finished = await done;
      return reply.code(200).send({ jobId: finished.job.id, ...finished });
    }
    done.catch(() => {});
    return reply.code(202).send({ jobId: job.id, job });
  });
}
