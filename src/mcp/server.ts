import * as fs from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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

const MAX_INLINE_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB safety cap for JSON-RPC inline base64 audio

function jsonOk(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function toolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
  };
}

function mimeTypeForFormat(format: string): string {
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

/**
 * Creates a thin MCP server wrapping `StudioService` 1:1 with the REST API.
 * All business logic stays in `src/studio/service.ts`.
 */
export function createMcpServer(service: StudioService): McpServer {
  const server = new McpServer({
    name: 'the-booth',
    version: '0.2.0',
  });

  let activeCalls = 0;
  async function runTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
    activeCalls++;
    try {
      return await fn();
    } catch (err: unknown) {
      return toolError(err);
    } finally {
      activeCalls--;
    }
  }

  server.registerResource('studio-idle', 'booth://runtime/idle', {
    mimeType: 'application/json',
    description: 'Whether this studio process has finished its tool calls and background jobs.',
  }, uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json',
      text: JSON.stringify({ idle: activeCalls === 0 && !service.jobs.hasActiveJobs() }) }],
  }));

  // --- Projects ---
  server.registerTool(
    'booth_create_project',
    {
      description:
        'Create a new audio studio project initialized with default room tone and acoustic settings.',
      inputSchema: {
        id: SafeIdSchema.optional().describe('Optional custom project ID'),
        name: z.string().min(1).describe('Human-readable project name'),
        audio: ProjectAudioSettingsSchema.partial()
          .optional()
          .describe('Optional overrides for master audio settings'),
        includeDefaultRoomTone: z
          .boolean()
          .optional()
          .describe('Include default subtle warm_dark room tone bed (default: true)'),
      },
    },
    (args) =>
      runTool(async () => {
        const project = await service.createProject(args);
        return jsonOk(project);
      }),
  );

  server.registerTool(
    'booth_list_projects',
    {
      description: 'List all studio projects with summary metadata.',
    },
    () =>
      runTool(async () => {
        const projects = await service.listProjects();
        return jsonOk({ projects });
      }),
  );

  server.registerTool(
    'booth_get_project',
    {
      description:
        'Fetch full project manifest alongside resolved cue/SFX timeline timestamps.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
      },
    },
    ({ projectId }) =>
      runTool(async () => {
        const result = await service.getProject(projectId);
        return jsonOk(result);
      }),
  );

  server.registerTool(
    'booth_update_project',
    {
      description:
        'Update project name or Stage-2 master audio settings (autoLevel, headphoneCrossfeed, masterNormalize, leadInMs, tailMs, etc.).',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        name: z.string().min(1).optional(),
        audio: ProjectAudioSettingsSchema.partial().optional(),
      },
    },
    ({ projectId, name, audio }) =>
      runTool(async () => {
        const project = await service.updateProject(projectId, { name, audio });
        return jsonOk(project);
      }),
  );

  server.registerTool(
    'booth_delete_project',
    {
      description: 'Permanently delete a project and all of its takes and exports.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
      },
    },
    ({ projectId }) =>
      runTool(async () => {
        await service.deleteProject(projectId);
        return jsonOk({ deleted: true, projectId });
      }),
  );

  // --- Voices ---
  server.registerTool(
    'booth_upsert_voice',
    {
      description:
        'Register or update a speaker voice profile (provider, providerVoiceId, defaultDirection, defaultEqPreset, defaultPan).',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        voiceId: SafeIdSchema.describe('Logical speaker key (e.g. "mara", "narrator")'),
        label: z.string().min(1).describe('Display name'),
        provider: z.string().min(1).default('gemini').describe('TTS provider name'),
        providerVoiceId: z
          .string()
          .min(1)
          .describe('Provider voice ID (e.g. "Sulafat", "Kore", or custom "voice_...")'),
        defaultDirection: z.string().optional(),
        defaultEqPreset: EqPresetSchema.optional(),
        defaultPan: z.number().min(-1).max(1).optional(),
        notes: z.string().optional(),
      },
    },
    ({ projectId, voiceId, ...profile }) =>
      runTool(async () => {
        const project = await service.upsertVoice(projectId, voiceId, profile);
        return jsonOk(project.voices[voiceId]);
      }),
  );

  // --- Script Import ---
  server.registerTool(
    'booth_import_script',
    {
      description:
        'Parse a tagged audio script ([[pause]], [[overlap]], [[dir]], [[gain]], [[pan]], [[eq]], [[bed]], [[sfx]]) into project cues. In replace mode, matching takes are preserved by textHash.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        script: z.string().min(1).describe('Tagged script text'),
        mode: z.enum(['replace', 'append']).default('replace'),
        defaultSpeaker: z.string().min(1).optional(),
        maxChunkBytes: z.number().int().min(200).max(32000).optional(),
      },
    },
    ({ projectId, ...input }) =>
      runTool(async () => {
        const result = await service.importScript(projectId, input);
        return jsonOk(result);
      }),
  );

  // --- Cues ---
  server.registerTool(
    'booth_add_cue',
    {
      description: 'Insert a single spoken cue onto the project timeline.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        id: SafeIdSchema.optional(),
        speaker: z.string().min(1),
        text: z.string().min(1),
        direction: z.string().nullable().optional(),
        timing: CueTimingSchema.partial().optional(),
        mix: CueMixSchema.partial().optional(),
        insertAtIndex: z.number().int().min(0).optional(),
      },
    },
    ({ projectId, ...input }) =>
      runTool(async () => {
        const result = await service.addCue(projectId, input);
        return jsonOk(result.cue);
      }),
  );

  server.registerTool(
    'booth_update_cue',
    {
      description:
        'Update a cue text, delivery direction, timing (offsetMs/afterCueId), Stage-2 mix controls (gainDb, pan, eqPreset, autoLevel), or activeTakeId.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        cueId: SafeIdSchema.describe('Cue ID'),
        speaker: z.string().min(1).optional(),
        text: z.string().min(1).optional(),
        direction: z.string().nullable().optional(),
        timing: CueTimingSchema.partial().optional(),
        mix: CueMixSchema.partial().optional(),
        activeTakeId: z.string().nullable().optional(),
      },
    },
    ({ projectId, cueId, ...patch }) =>
      runTool(async () => {
        const result = await service.updateCue(projectId, cueId, patch);
        return jsonOk(result.cue);
      }),
  );

  server.registerTool(
    'booth_delete_cue',
    {
      description:
        'Delete a cue from the project, safely re-anchoring any dependent cues or SFX.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        cueId: SafeIdSchema.describe('Cue ID'),
      },
    },
    ({ projectId, cueId }) =>
      runTool(async () => {
        const project = await service.deleteCue(projectId, cueId);
        return jsonOk({ deleted: true, cueId, remainingCueCount: project.cues.length });
      }),
  );

  server.registerTool(
    'booth_split_cue',
    {
      description:
        'Non-destructively split a rendered cue at playhead timestamp `atMs` (relative to the cue start) into two sequential cues sharing the exact same immutable raw WAV take, inserting `gapMs` of warm room tone between them with zero TTS re-synthesis. Ideal for inserting or adjusting dramatic pauses mid-line after locating the exact beat with booth_inspect_visual.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        cueId: SafeIdSchema.describe('Rendered cue ID to split'),
        atMs: z
          .number()
          .int()
          .min(50)
          .describe('Split playhead offset in milliseconds from the start of this cue'),
        gapMs: z
          .number()
          .int()
          .min(-5000)
          .max(60000)
          .optional()
          .describe('Pause inserted between the two halves in milliseconds (default: 400)'),
        secondCueId: SafeIdSchema.optional().describe('Optional custom ID for the second half'),
        textBefore: z.string().min(1).optional().describe('Optional transcript label for part 1'),
        textAfter: z.string().min(1).optional().describe('Optional transcript label for part 2'),
      },
    },
    ({ projectId, cueId, ...input }) =>
      runTool(async () => {
        const { firstCue, secondCue, splitAtRawMs, gapMs } = await service.splitCue(
          projectId,
          cueId,
          input,
        );
        return jsonOk({ firstCue, secondCue, splitAtRawMs, gapMs });
      }),
  );

  // --- Stage 1 Synthesis ---
  server.registerTool(
    'booth_render_take',
    {
      description:
        'Synthesize a new immutable raw WAV take for a single cue via its TTS provider and measure Stage-1 loudness telemetry.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        cueId: SafeIdSchema.describe('Cue ID'),
        activate: z
          .boolean()
          .optional()
          .describe('Set newly rendered take as activeTakeId (default: true)'),
        model: z.string().min(1).optional(),
      },
    },
    ({ projectId, cueId, activate, model }) =>
      runTool(async () => {
        const { take } = await service.renderTake(projectId, cueId, { activate, model });
        return jsonOk(take);
      }),
  );

  server.registerTool(
    'booth_render_all',
    {
      description:
        'Synthesize all cues missing an active take (or whose textHash is stale). Returns a jobId immediately unless wait=true.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        concurrency: z.number().int().min(1).max(8).optional(),
        force: z.boolean().optional(),
        wait: z
          .boolean()
          .optional()
          .describe('If true, wait for all renders to complete before returning'),
      },
    },
    ({ projectId, concurrency, force, wait }) =>
      runTool(async () => {
        const { job, done } = await service.startRenderAll(projectId, {
          concurrency,
          force,
        });
        if (wait) {
          const finalJob = await done;
          return jsonOk({ jobId: finalJob.id, job: finalJob });
        }
        done.catch(() => {});
        return jsonOk({ jobId: job.id, job });
      }),
  );

  server.registerTool(
    'booth_job_status',
    {
      description: 'Poll status, progress counts, and errors for an async studio job.',
      inputSchema: {
        jobId: z.string().min(1).describe('Job ID returned by booth_render_all'),
      },
    },
    ({ jobId }) =>
      runTool(async () => {
        const job = service.getJob(jobId);
        if (!job) {
          throw new StoreError(`Job not found: ${jobId}`, 404);
        }
        return jsonOk(job);
      }),
  );

  server.registerTool(
    'booth_get_take_audio',
    {
      description:
        'Retrieve a single take immutable raw WAV for multimodal ear review (returns inline audio block + metadata).',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        cueId: SafeIdSchema.describe('Cue ID'),
        takeId: SafeIdSchema.describe('Take ID'),
        inlineAudio: z
          .boolean()
          .optional()
          .describe('Include base64 audio content block (default: true when <= 10 MB)'),
      },
    },
    ({ projectId, cueId, takeId, inlineAudio }) =>
      runTool(async () => {
        const { filePath, take } = await service.getTakeAudioFile(
          projectId,
          cueId,
          takeId,
        );
        const bytes = await fs.readFile(filePath);
        const includeInline =
          inlineAudio !== false && bytes.length <= MAX_INLINE_AUDIO_BYTES;

        const content: CallToolResult['content'] = [
          {
            type: 'text',
            text: JSON.stringify(
              {
                take,
                filePath,
                sizeBytes: bytes.length,
                inlineAudioIncluded: includeInline,
              },
              null,
              2,
            ),
          },
        ];

        if (includeInline) {
          content.push({
            type: 'audio',
            data: bytes.toString('base64'),
            mimeType: 'audio/wav',
          });
        }
        return { content };
      }),
  );

  // --- Beds ---
  server.registerTool(
    'booth_upsert_bed',
    {
      description:
        'Add or update a continuous background bed track (synthetic_room_tone or looped asset_file with optional speech ducking and raw-ms or cue-anchored startCueId/endCueId boundaries).',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        bedId: SafeIdSchema.describe('Bed ID'),
        label: z.string().min(1),
        kind: z.enum(['synthetic_room_tone', 'asset_file']),
        roomToneStyle: RoomToneStyleSchema.optional(),
        assetPath: z.string().min(1).optional(),
        gainDb: z.number().min(-80).max(12),
        loop: z.boolean().default(true),
        startMs: z.number().int().min(0).optional(),
        endMs: z.number().int().min(0).nullable().optional(),
        startCueId: z
          .string()
          .nullable()
          .optional()
          .describe('Optional cue ID anchoring when this bed enters (overrides startMs; survives upstream pause edits)'),
        startEdge: z
          .enum(['start', 'end'])
          .optional()
          .describe('Edge of startCueId to anchor to (default: "start")'),
        startOffsetMs: z
          .number()
          .int()
          .optional()
          .describe('Millisecond offset relative to startCueId edge (e.g. -1000 to fade in 1s early; default: 0)'),
        endCueId: z
          .string()
          .nullable()
          .optional()
          .describe('Optional cue ID anchoring when this bed exits (overrides endMs; survives upstream pause edits)'),
        endEdge: z
          .enum(['start', 'end'])
          .optional()
          .describe('Edge of endCueId to anchor to (default: "end")'),
        endOffsetMs: z
          .number()
          .int()
          .optional()
          .describe('Millisecond offset relative to endCueId edge (e.g. +1500 to trail past the final line; default: 0)'),
        clipStartMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Optional source-file start offset in milliseconds for non-destructive slicing'),
        clipDurationMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional source-file clip duration in milliseconds (looped if loop=true)'),
        fadeInMs: z.number().int().min(0).max(30000).default(1500),
        fadeOutMs: z.number().int().min(0).max(30000).default(3000),
        ducking: BedDuckingSchema.default({
          enabled: true,
          amountDb: -6,
          attackMs: 100,
          releaseMs: 800,
        }),
      },
    },
    ({ projectId, bedId, ...bed }) =>
      runTool(async () => {
        const project = await service.upsertBed(projectId, bedId, bed);
        return jsonOk(project.beds.find((b) => b.id === bedId));
      }),
  );

  server.registerTool(
    'booth_delete_bed',
    {
      description: 'Remove a background bed track from a project.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        bedId: SafeIdSchema.describe('Bed ID'),
      },
    },
    ({ projectId, bedId }) =>
      runTool(async () => {
        const project = await service.deleteBed(projectId, bedId);
        return jsonOk({ deleted: true, bedId, remainingBedCount: project.beds.length });
      }),
  );

  // --- SFX ---
  server.registerTool(
    'booth_upsert_sfx',
    {
      description: 'Add or update a spot sound effect anchored to a cue or absolute time.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        sfxId: SafeIdSchema.describe('SFX event ID'),
        label: z.string().min(1),
        assetPath: z.string().min(1),
        anchor: SfxAnchorSchema.default({ edge: 'end', offsetMs: 0 }),
        gainDb: z.number().min(-48).max(12).default(-6),
        pan: z.number().min(-1).max(1).default(0),
        clipStartMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Optional source-file start offset in milliseconds (for slicing single hits from multi-variation WAVs)'),
        clipDurationMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional source-file clip duration in milliseconds'),
        fadeInMs: z.number().int().min(0).max(5000).default(15),
        fadeOutMs: z.number().int().min(0).max(5000).default(40),
      },
    },
    ({ projectId, sfxId, ...sfx }) =>
      runTool(async () => {
        const project = await service.upsertSfx(projectId, sfxId, sfx);
        return jsonOk(project.sfx.find((s) => s.id === sfxId));
      }),
  );

  server.registerTool(
    'booth_delete_sfx',
    {
      description: 'Remove a spot SFX event from a project.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        sfxId: SafeIdSchema.describe('SFX event ID'),
      },
    },
    ({ projectId, sfxId }) =>
      runTool(async () => {
        const project = await service.deleteSfx(projectId, sfxId);
        return jsonOk({ deleted: true, sfxId, remainingSfxCount: project.sfx.length });
      }),
  );

  // --- Stage 2 Mixdown ---
  server.registerTool(
    'booth_mix',
    {
      description:
        'Run Stage-2 local deterministic stereo mixdown (zero API cost) and return the export record and loudness/channel telemetry. Pass optional outputPath to deliver a playable master copy directly into your workspace, or optional fromCueId/toCueId (or startSec/endSec) for a fast scene-scoped partial mixdown.',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        format: ExportFormatSchema.optional().describe(
          'Output format: ogg, wav, or mp3 (defaults to ogg, or inferred from outputPath extension if provided)',
        ),
        outputPath: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Optional delivery file path (e.g. "/path/to/scene_master.ogg") or destination directory; atomically writes a ready-to-play copy alongside the canonical project export',
          ),
        fromCueId: SafeIdSchema.optional().describe(
          'Optional first cue ID for a scene-scoped partial mixdown (mutually exclusive with startSec/endSec)',
        ),
        toCueId: SafeIdSchema.optional().describe(
          'Optional last cue ID for a scene-scoped partial mixdown (mutually exclusive with startSec/endSec)',
        ),
        startSec: z
          .number()
          .min(0)
          .optional()
          .describe(
            'Optional start timestamp in seconds on the full timeline for a partial mixdown',
          ),
        endSec: z
          .number()
          .positive()
          .optional()
          .describe(
            'Optional end timestamp in seconds on the full timeline for a partial mixdown',
          ),
      },
    },
    ({ projectId, format, outputPath, fromCueId, toCueId, startSec, endSec }) =>
      runTool(async () => {
        const { exportRecord, telemetry, deliveredPath } = await service.mixProject(
          projectId,
          {
            format,
            outputPath,
            fromCueId,
            toCueId,
            startSec,
            endSec,
          },
        );
        return jsonOk({
          export: exportRecord,
          telemetry,
          ...(deliveredPath ? { deliveredPath } : {}),
        });
      }),
  );

  server.registerTool(
    'booth_get_export_audio',
    {
      description:
        'Retrieve a rendered master export for listening (returns metadata + inline audio block when <= 10 MB).',
      inputSchema: {
        projectId: SafeIdSchema.describe('Project ID'),
        exportId: SafeIdSchema.describe('Export ID returned by booth_mix'),
        inlineAudio: z
          .boolean()
          .optional()
          .describe('Include base64 audio content block (default: true when <= 10 MB)'),
      },
    },
    ({ projectId, exportId, inlineAudio }) =>
      runTool(async () => {
        const { filePath, exportRecord } = await service.getExportAudioFile(
          projectId,
          exportId,
        );
        const bytes = await fs.readFile(filePath);
        const includeInline =
          inlineAudio !== false && bytes.length <= MAX_INLINE_AUDIO_BYTES;

        const content: CallToolResult['content'] = [
          {
            type: 'text',
            text: JSON.stringify(
              {
                export: exportRecord,
                filePath,
                sizeBytes: bytes.length,
                inlineAudioIncluded: includeInline,
              },
              null,
              2,
            ),
          },
        ];

        if (includeInline) {
          content.push({
            type: 'audio',
            data: bytes.toString('base64'),
            mimeType: mimeTypeForFormat(exportRecord.format),
          });
        }
        return { content };
      }),
  );

  server.registerTool(
    'booth_inspect_visual',
    {
      description:
        'Render a calibrated visual-audio inspection chart (1600x900 PNG + metadata) for an export, take, audition, or asset so multimodal agents can see stereo L/R panning, room-tone dropouts, broadband clicks, loudness jumps (>= 1.5 dB), overlaps, SFX sync alignment, and silent-tail mismatches. Default preset "master" renders the 4-panel stack: DAW Cue + SFX Overlay + Split L/R Waveforms + Split L/R & Combined 300ms RMS (3 dB grid) + Log-Mel Spectrogram; preset "fast" uses zero-JS pure FFmpeg (showwavespic + showspectrumpic). Windowing: default zoom <= 45s (>= 30 px/s) for seam/dropout/overlap QC; use mode "overview" for macro arcs & click spotting on 180s+ tracks (<150 ms dropouts/overlaps fall below the pixel cliff at 180s). USAGE GUARDRAIL: Inspect 1-2 charts per turn to prevent multi-image batch swaps, and always pair ears (booth_get_export_audio / booth_get_take_audio) + eyes (booth_inspect_visual) on final mixes.',
      inputSchema: {
        projectId: SafeIdSchema.optional().describe(
          'Project ID (required for export, take, and audition targets; omit for shared asset targets)',
        ),
        target: z.discriminatedUnion('type', [
          z.object({
            type: z.literal('export'),
            exportId: SafeIdSchema.describe('Export ID returned by booth_mix'),
          }),
          z.object({
            type: z.literal('take'),
            cueId: SafeIdSchema.optional().describe('Optional cue ID (auto-resolved from takeId if omitted)'),
            takeId: SafeIdSchema.describe('Take ID to inspect'),
          }),
          z.object({
            type: z.literal('audition'),
            voiceId: SafeIdSchema.describe('Project voice ID'),
            auditionId: SafeIdSchema.describe('Audition ID to inspect'),
          }),
          z.object({
            type: z.literal('asset'),
            assetPath: z
              .string()
              .min(1)
              .describe('Relative path under DATA_DIR/assets/ or "@<alias>/<path>" in a mounted external library'),
          }),
        ]),
        preset: z
          .enum(['master', 'fast'])
          .optional()
          .describe('"master" (default 4-panel DAW+S1+L1+Log-Mel stack) or "fast" (pure FFmpeg showwavespic+showspectrumpic)'),
        mode: z
          .enum(['zoom', 'overview'])
          .optional()
          .describe('"zoom" (capped at <= 45s, >= 30 px/s for surgical seam QC) or "overview" (180s+ macro arcs + broadband clicks)'),
        startSec: z.number().min(0).optional().describe('Optional window start time in seconds'),
        endSec: z.number().min(0).optional().describe('Optional window end time in seconds'),
        panels: z
          .array(z.enum(['cues', 'waveform', 'rms', 'spectrogram']))
          .min(1)
          .max(4)
          .optional()
          .describe('Optional subset of panels for preset="master"'),
        inlineImage: z
          .boolean()
          .optional()
          .describe('Include PNG as inline MCP image content block (default: true)'),
      },
    },
    ({ inlineImage, ...args }) =>
      runTool(async () => {
        const res = await service.inspectVisual(args);
        const { pngBuffer, ...meta } = res;
        const includeInline = inlineImage !== false;

        const content: CallToolResult['content'] = [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ...meta,
                sizeBytes: pngBuffer.length,
                inlineImageIncluded: includeInline,
              },
              null,
              2,
            ),
          },
        ];

        if (includeInline) {
          content.push({
            type: 'image',
            data: pngBuffer.toString('base64'),
            mimeType: 'image/png',
          });
        }
        return { content };
      }),
  );

  // --- Shared Asset Library ---
  server.registerTool(
    'booth_list_assets',
    {
      description:
        'List reusable ambient beds and sound effects stored in the writable local asset library (DATA_DIR/assets/), along with a summary of configured read-only external library mounts (use booth_search_assets to search external libraries).',
    },
    () =>
      runTool(async () => {
        const [assets, mounts] = await Promise.all([
          service.listAssets(),
          service.listAssetMountsSummary(),
        ]);
        return jsonOk({ assets, mounts });
      }),
  );

  server.registerTool(
    'booth_index_assets',
    {
      description:
        'Incrementally scan and index DATA_DIR/assets/ plus configured read-only ASSET_LIBRARY_DIRS mounts into a zero-DB local manifest (ffprobe duration/channels + astats rmsDbfs/peakDbfs loudness telemetry + BWF/INFO/ID3/Vorbis tags + UCS tokenization + catalog.json sidecars). Optionally runs bounded Gemini audio captioning and/or gemini-embedding-2 semantic embeddings (cached forever). Set wait=false for large first-time scans and poll booth_job_status.',
      inputSchema: {
        mounts: z
          .array(z.string().min(1))
          .optional()
          .describe('Optional subset of mount aliases to scan (e.g. ["local", "sonniss"]); omit to scan all'),
        forceReprobe: z
          .boolean()
          .optional()
          .describe('Re-probe all files even if size and mtime are unchanged (default: false)'),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(16)
          .optional()
          .describe('Bounded ffprobe concurrency (default: 6)'),
        enrichCaptions: z
          .boolean()
          .optional()
          .describe('Opt-in Gemini audio auto-captioning for assets missing descriptions (default: false)'),
        maxCaptionCount: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Maximum number of assets to caption in one run (default: 50)'),
        onlyMissingDescriptions: z
          .boolean()
          .optional()
          .describe('When enrichCaptions=true, skip assets that already have BWF or catalog.json descriptions (default: true)'),
        enrichEmbeddings: z
          .boolean()
          .optional()
          .describe('Opt-in gemini-embedding-2 semantic vector generation into flat assets_embeddings.f32 (default: false)'),
        wait: z
          .boolean()
          .optional()
          .describe('Wait for indexing to finish before returning (default: true); pass false to return a jobId immediately'),
      },
    },
    ({ wait, ...opts }) =>
      runTool(async () => {
        const { job, done } = await service.startIndexAssets(opts);
        if (wait === false) {
          done.catch(() => {});
          return jsonOk({ jobId: job.id, job });
        }
        const finished = await done;
        return jsonOk({
          jobId: finished.job.id,
          job: finished.job,
          summary: finished.summary,
        });
      }),
  );

  server.registerTool(
    'booth_search_assets',
    {
      description:
        'Fast zero-DB BM25 / hybrid semantic search across indexed local assets and read-only external SFX/bed mounts. Narrow candidates with kind, mount, duration, and stereoOnly filters, then audition top hits with booth_get_asset_audio before committing them to a mix.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Natural-language or keyword query (e.g. "sharp mirror glass shatter", "howling castle wind")'),
        kind: z
          .enum(['sfx', 'bed', 'any'])
          .optional()
          .describe('Filter by spot foley ("sfx"), continuous ambient bed ("bed"), or "any" (default)'),
        mount: z
          .string()
          .min(1)
          .optional()
          .describe('Restrict to "local" or an external mount alias (e.g. "sonniss")'),
        minDurationSec: z
          .number()
          .min(0)
          .optional()
          .describe('Minimum asset duration in seconds'),
        maxDurationSec: z
          .number()
          .min(0)
          .optional()
          .describe('Maximum asset duration in seconds'),
        stereoOnly: z
          .boolean()
          .optional()
          .describe('Only return stereo (2+ channel) assets'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Maximum results to return (default: 8, max: 25)'),
      },
    },
    (args) =>
      runTool(async () => {
        return jsonOk(await service.searchAssets(args));
      }),
  );

  server.registerTool(
    'booth_get_asset_audio',
    {
      description:
        'Audition a local or "@<alias>/..." external asset (or a [startSec, startSec+maxDurationSec] slice) via inline MCP audio block plus local filePath and cached previewAudioPath metadata so you can verify foley and rule out acoustic twins before placing it in a mix.',
      inputSchema: {
        assetPath: z
          .string()
          .min(1)
          .describe('Local asset path (e.g. "rain_window.wav") or external mount path (e.g. "@sonniss/Glass/GLASSBrk_Mirror_01.wav")'),
        startSec: z
          .number()
          .min(0)
          .optional()
          .describe('Optional start offset in seconds for auditioning inside long or multi-variation files (default: 0)'),
        maxDurationSec: z
          .number()
          .positive()
          .max(30)
          .optional()
          .describe('Maximum preview clip length in seconds (default: 15, max: 30)'),
        inlineAudio: z
          .boolean()
          .optional()
          .describe('Include base64 audio block in MCP response (default: true when <= 10 MB)'),
      },
    },
    ({ assetPath, startSec, maxDurationSec, inlineAudio }) =>
      runTool(async () => {
        const preview = await service.getAssetAudio({
          assetPath,
          startSec,
          maxDurationSec,
        });
        const includeInline =
          inlineAudio !== false && preview.audioBuffer.length <= MAX_INLINE_AUDIO_BYTES;
        const { audioBuffer, ...meta } = preview;
        const content: CallToolResult['content'] = [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ...meta,
                inlineAudioIncluded: includeInline,
              },
              null,
              2,
            ),
          },
        ];
        if (includeInline) {
          content.push({
            type: 'audio',
            data: audioBuffer.toString('base64'),
            mimeType: preview.mimeType,
          });
        }
        return { content };
      }),
  );

  server.registerTool(
    'booth_upload_asset',
    {
      description:
        'Upload a reusable ambient bed or SFX audio file (base64-encoded WAV/OGG/MP3/FLAC/M4A) into DATA_DIR/assets/. Validated via ffprobe before saving.',
      inputSchema: {
        assetPath: z
          .string()
          .min(1)
          .describe('Relative path under assets/, e.g. "rain_window.wav" or "foley/sheets.ogg"'),
        dataBase64: z.string().min(1).describe('Base64-encoded audio file bytes'),
      },
    },
    ({ assetPath, dataBase64 }) =>
      runTool(async () => {
        const uploaded = await service.uploadAsset({
          assetPath,
          buffer: Buffer.from(dataBase64, 'base64'),
        });
        return jsonOk(uploaded);
      }),
  );

  server.registerTool(
    'booth_delete_asset',
    {
      description: 'Delete an audio file from the shared studio asset library.',
      inputSchema: {
        assetPath: z.string().min(1).describe('Relative path under assets/'),
      },
    },
    ({ assetPath }) =>
      runTool(async () => {
        await service.deleteAsset(assetPath);
        return jsonOk({ deleted: true, assetPath });
      }),
  );

  // --- Voice Catalog, Design & Auditioning (Milestone 4) ---
  server.registerTool(
    'booth_list_provider_voices',
    {
      description:
        'List and filter custom stored voices and prebuilt/Extended Voice Library voices for a TTS provider (e.g. "gemini" or "mock").',
      inputSchema: {
        provider: z.string().min(1).optional(),
        type: z
          .array(z.enum(['prebuilt', 'prompted', 'replicated']))
          .optional()
          .describe('Filter by voice type (OR within list)'),
        languageCode: z
          .array(z.string().min(2))
          .optional()
          .describe('BCP-47 language tags, e.g. ["en-US", "en-GB"]'),
        regionCode: z
          .array(z.string().min(2))
          .optional()
          .describe('ISO 3166-1 alpha-2 or UN M.49 region codes, e.g. ["US", "GB"]'),
        accent: z
          .array(z.string().min(1))
          .optional()
          .describe('Regional accents, e.g. ["American", "British"]'),
        gender: z
          .array(z.enum(['female', 'male', 'neutral']))
          .optional()
          .describe('Perceived gender filter'),
        pitch: z
          .array(z.enum(['low', 'medium', 'high']))
          .optional()
          .describe('Vocal pitch filter'),
        persona: z
          .array(z.string().min(1))
          .optional()
          .describe('Character archetypes, e.g. ["Warm, Friendly", "Narrator"]'),
        contexts: z
          .array(z.string().min(1))
          .optional()
          .describe('Usage domains, e.g. ["Audiobook", "Conversational"]'),
        search: z
          .string()
          .min(1)
          .optional()
          .describe('Case-insensitive substring search across display_name and description'),
        pageSize: z.number().int().min(1).max(1000).optional(),
        pageToken: z.string().min(1).optional(),
      },
    },
    ({ provider, ...filter }) =>
      runTool(async () => {
        return jsonOk(await service.listProviderVoices(provider, filter));
      }),
  );

  server.registerTool(
    'booth_design_voice',
    {
      description:
        'Design a new persistent custom voice (or remix an existing baseVoice) via the provider Voices API. Saves sample_audio preview to disk and returns it as an inline MCP audio block for immediate listening.',
      inputSchema: {
        provider: z.string().min(1).optional(),
        displayName: z.string().min(1),
        prompt: z.string().min(5).describe('Concise 1–2 sentence voice description or relative remix instruction'),
        description: z.string().min(1).optional().describe('Optional discovery description of timbre/tone'),
        gender: z.enum(['female', 'male', 'neutral']).optional(),
        languageCode: z.string().min(2).optional().describe('Primary BCP-47 language tag (default: "en-US")'),
        regionCode: z.string().min(2).optional(),
        accent: z.string().min(1).optional(),
        pitch: z.enum(['low', 'medium', 'high']).optional(),
        persona: z.string().min(1).optional(),
        context: z.string().min(1).optional(),
        baseVoice: z.string().min(1).optional().describe('Existing voice ID or prebuilt name to remix'),
        model: z.string().min(1).optional(),
        inlineAudio: z
          .boolean()
          .optional()
          .describe('Include sample_audio preview as inline MCP audio block (default: true when <= 10 MB)'),
      },
    },
    ({ inlineAudio, ...designArgs }) =>
      runTool(async () => {
        const { voice, sampleWavBuffer } = await service.designVoice(designArgs);
        const includeInline =
          inlineAudio !== false &&
          Boolean(sampleWavBuffer) &&
          (sampleWavBuffer?.length ?? 0) <= MAX_INLINE_AUDIO_BYTES;

        const content: CallToolResult['content'] = [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ...voice,
                inlineAudioIncluded: includeInline,
              },
              null,
              2,
            ),
          },
        ];

        if (includeInline && sampleWavBuffer) {
          content.push({
            type: 'audio',
            data: sampleWavBuffer.toString('base64'),
            mimeType: 'audio/wav',
          });
        }
        return { content };
      }),
  );

  server.registerTool(
    'booth_get_provider_voice',
    {
      description:
        'Inspect metadata and listen to the sample_audio preview of a stored custom voice (e.g. voice_...). Returns clean JSON metadata plus an inline MCP audio block when sample_audio is present.',
      inputSchema: {
        provider: z.string().min(1).optional(),
        voiceId: z.string().min(1).describe('Stored custom voice ID (e.g. "voice_abc123...")'),
        inlineAudio: z
          .boolean()
          .optional()
          .describe('Include sample_audio preview as inline MCP audio block (default: true when <= 10 MB)'),
      },
    },
    ({ provider, voiceId, inlineAudio }) =>
      runTool(async () => {
        const { voice, sampleWavBuffer } = await service.getProviderVoice(voiceId, provider);
        const includeInline =
          inlineAudio !== false &&
          Boolean(sampleWavBuffer) &&
          (sampleWavBuffer?.length ?? 0) <= MAX_INLINE_AUDIO_BYTES;

        const content: CallToolResult['content'] = [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ...voice,
                inlineAudioIncluded: includeInline,
              },
              null,
              2,
            ),
          },
        ];

        if (includeInline && sampleWavBuffer) {
          content.push({
            type: 'audio',
            data: sampleWavBuffer.toString('base64'),
            mimeType: 'audio/wav',
          });
        }
        return { content };
      }),
  );

  server.registerTool(
    'booth_delete_provider_voice',
    {
      description:
        'Permanently delete a stored custom voice from the TTS provider (freeing a slot against the 200-voice Gemini project quota) and remove its cached local preview.',
      inputSchema: {
        provider: z.string().min(1).optional(),
        voiceId: z.string().min(1).describe('Stored custom voice ID to delete (e.g. "voice_abc123...")'),
      },
    },
    ({ provider, voiceId }) =>
      runTool(async () => {
        return jsonOk(await service.deleteProviderVoice(voiceId, provider));
      }),
  );

  server.registerTool(
    'booth_audition_voice',
    {
      description:
        'Generate labeled audition clips ("A", "B", ...) for candidate providerVoiceIds on a project voice role. When 2+ candidates are supplied, automatically renders a single loudness-matched playable A/B comparison reel (set reelOutputPath to deliver it straight to your workspace) so you can compare candidates in one file and select by "A" or "B".',
      inputSchema: {
        projectId: SafeIdSchema,
        voiceId: SafeIdSchema,
        candidateVoiceIds: z.array(z.string().min(1)).min(1).max(10),
        sampleText: z.string().min(1),
        direction: z.string().nullable().optional(),
        notes: z.string().optional(),
        provider: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        renderReel: z
          .boolean()
          .optional()
          .describe('Render a loudness-matched labeled A/B audition reel (default: true when >= 2 candidates)'),
        reelFormat: ExportFormatSchema.optional(),
        reelOutputPath: z
          .string()
          .min(1)
          .optional()
          .describe('Optional delivery file path or directory for the A/B audition reel'),
      },
    },
    ({ projectId, voiceId, ...input }) =>
      runTool(async () => {
        return jsonOk(await service.auditionVoice(projectId, voiceId, input));
      }),
  );

  server.registerTool(
    'booth_render_audition_reel',
    {
      description:
        'Stitch a role\'s voice auditions into a single loudness-matched labeled A/B comparison reel ("A", "B", ...) with soft musical cue pips and warm room tone. Supports direct delivery via outputPath and optional inline MCP audio.',
      inputSchema: {
        projectId: SafeIdSchema,
        voiceId: SafeIdSchema,
        auditionIds: z.array(SafeIdSchema).min(1).max(10).optional(),
        format: ExportFormatSchema.optional(),
        outputPath: z
          .string()
          .min(1)
          .optional()
          .describe('Optional delivery file path or directory for the playable reel'),
        inlineAudio: z
          .boolean()
          .optional()
          .describe('Include base64 audio block in MCP response (default: true when <= 10 MB)'),
      },
    },
    ({ projectId, voiceId, inlineAudio, ...opts }) =>
      runTool(async () => {
        const reel = await service.renderAuditionReel(projectId, voiceId, opts);
        const bytes = await fs.readFile(reel.reelPath);
        const includeInline =
          inlineAudio !== false && bytes.length <= MAX_INLINE_AUDIO_BYTES;
        const content: CallToolResult['content'] = [
          {
            type: 'text',
            text: JSON.stringify(
              { ...reel, sizeBytes: bytes.length, inlineAudioIncluded: includeInline },
              null,
              2,
            ),
          },
        ];
        if (includeInline) {
          content.push({
            type: 'audio',
            data: bytes.toString('base64'),
            mimeType: mimeTypeForFormat(reel.format),
          });
        }
        return { content };
      }),
  );

  server.registerTool(
    'booth_render_ab_reel',
    {
      description:
        'Play multiple takes of a cue IN CONTEXT as a single loudness-matched, labeled A/B stereo comparison reel (e.g. preceding lead-in cue + Take A, gentle separator chime, same lead-in + Take B). Ideal for comparing retakes in scene context and sharing a single playable file across any MCP host.',
      inputSchema: {
        projectId: SafeIdSchema,
        cueId: SafeIdSchema,
        takeIds: z
          .array(SafeIdSchema)
          .min(1)
          .max(6)
          .optional()
          .describe('Take IDs to compare (defaults to the 2 most recent takes on this cue)'),
        contextBeforeCues: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe('Number of preceding cues to include as lead-in context (default: 1)'),
        contextAfterCues: z
          .number()
          .int()
          .min(0)
          .max(2)
          .optional()
          .describe('Number of following cues to include as reaction context (default: 0)'),
        format: ExportFormatSchema.optional(),
        outputPath: z
          .string()
          .min(1)
          .optional()
          .describe('Optional delivery file path or directory for the playable A/B reel'),
        inlineAudio: z
          .boolean()
          .optional()
          .describe('Include base64 audio block in MCP response (default: true when <= 10 MB)'),
      },
    },
    ({ projectId, cueId, inlineAudio, ...opts }) =>
      runTool(async () => {
        const reel = await service.renderTakeComparisonReel(projectId, cueId, opts);
        const bytes = await fs.readFile(reel.reelPath);
        const includeInline =
          inlineAudio !== false && bytes.length <= MAX_INLINE_AUDIO_BYTES;
        const content: CallToolResult['content'] = [
          {
            type: 'text',
            text: JSON.stringify(
              { ...reel, sizeBytes: bytes.length, inlineAudioIncluded: includeInline },
              null,
              2,
            ),
          },
        ];
        if (includeInline) {
          content.push({
            type: 'audio',
            data: bytes.toString('base64'),
            mimeType: mimeTypeForFormat(reel.format),
          });
        }
        return { content };
      }),
  );

  server.registerTool(
    'booth_get_audition_audio',
    {
      description:
        'Retrieve a voice audition WAV clip for multimodal ear review.',
      inputSchema: {
        projectId: SafeIdSchema,
        voiceId: SafeIdSchema,
        auditionId: SafeIdSchema,
        inlineAudio: z.boolean().optional(),
      },
    },
    ({ projectId, voiceId, auditionId, inlineAudio }) =>
      runTool(async () => {
        const { filePath, audition } = await service.getAuditionAudioFile(
          projectId,
          voiceId,
          auditionId,
        );
        const bytes = await fs.readFile(filePath);
        const includeInline =
          inlineAudio !== false && bytes.length <= MAX_INLINE_AUDIO_BYTES;
        const content: CallToolResult['content'] = [
          {
            type: 'text',
            text: JSON.stringify(
              { audition, filePath, sizeBytes: bytes.length, inlineAudioIncluded: includeInline },
              null,
              2,
            ),
          },
        ];
        if (includeInline) {
          content.push({
            type: 'audio',
            data: bytes.toString('base64'),
            mimeType: 'audio/wav',
          });
        }
        return { content };
      }),
  );

  server.registerTool(
    'booth_select_audition',
    {
      description:
        'Cast an auditioned candidate voice onto a project voice profile (updates providerVoiceId). Accepts either a friendly reel label ("A", "B", ...) from the latest audition batch OR an exact audition ID.',
      inputSchema: {
        projectId: SafeIdSchema,
        voiceId: SafeIdSchema,
        auditionId: z
          .string()
          .min(1)
          .describe('Audition ID (e.g. "aud_...") OR friendly reel label (e.g. "A", "B")'),
      },
    },
    ({ projectId, voiceId, auditionId }) =>
      runTool(async () => {
        const voice = await service.selectAudition(projectId, voiceId, auditionId);
        return jsonOk({ voice });
      }),
  );

  // --- Director's Chair (Milestone 4) ---
  server.registerTool(
    'booth_list_director_personas',
    {
      description:
        'List built-in Director personas (e.g. default, intimate_sleep, audio_drama, audiobook) that shape multimodal review taste.',
    },
    () =>
      runTool(async () => {
        return jsonOk({ personas: service.listDirectorPersonas() });
      }),
  );

  const formatDirectCueForMcp = (
    res: Awaited<ReturnType<StudioService['directCue']>>,
    includeScores = false,
  ) => {
    if (includeScores) return res;
    const { bestScore: _omitBest, attempts, ...rest } = res;
    return {
      ...rest,
      attempts: attempts.map((a) => {
        const { score: _omitScore, ...verdictRest } = a.verdict;
        return { ...a, verdict: verdictRest };
      }),
    };
  };

  server.registerTool(
    'booth_direct_cue',
    {
      description:
        'Run the multimodal Director review & bounded retake loop on a single cue, steered by a built-in or custom Director persona. Returns decision-first observation, changeSummary, and timestamped listening moments at the top (numeric /10 scores are hidden by default unless includeScores=true).',
      inputSchema: {
        projectId: SafeIdSchema,
        cueId: SafeIdSchema,
        persona: z
          .string()
          .nullable()
          .optional()
          .describe('Built-in persona ID (default, intimate_sleep, audio_drama, audiobook) or custom persona instructions'),
        extraInstructions: z.string().nullable().optional(),
        maxRetakes: z.number().int().min(0).max(5).optional(),
        allowMixAdjustments: z.boolean().optional(),
        allowTextTagTweaks: z.boolean().optional(),
        ttsModel: z.string().min(1).optional(),
        includeScores: z
          .boolean()
          .optional()
          .describe('Include internal numeric 1-10 scores (default: false — prioritizes concrete observations and timestamped moments)'),
      },
    },
    ({ projectId, cueId, includeScores, ...opts }) =>
      runTool(async () => {
        const res = await service.directCue(projectId, cueId, opts);
        return jsonOk(formatDirectCueForMcp(res, includeScores === true));
      }),
  );

  server.registerTool(
    'booth_direct_project',
    {
      description:
        'Run the bounded multimodal Director review loop across project cues with strict per-cue and project-wide retake budgets.',
      inputSchema: {
        projectId: SafeIdSchema,
        cueIds: z.array(SafeIdSchema).optional(),
        persona: z
          .string()
          .nullable()
          .optional()
          .describe('Built-in persona ID or custom persona instructions'),
        extraInstructions: z.string().nullable().optional(),
        maxRetakes: z.number().int().min(0).max(5).optional(),
        maxTotalRetakes: z.number().int().min(0).max(100).optional(),
        allowMixAdjustments: z.boolean().optional(),
        allowTextTagTweaks: z.boolean().optional(),
        ttsModel: z.string().min(1).optional(),
        includeScores: z
          .boolean()
          .optional()
          .describe('Include internal numeric 1-10 scores in results (default: false)'),
        wait: z.boolean().optional(),
      },
    },
    ({ projectId, wait, includeScores, ...opts }) =>
      runTool(async () => {
        const { job, done } = await service.startDirectProject(projectId, opts);
        if (wait) {
          const finished = await done;
          return jsonOk({
            jobId: finished.job.id,
            job: finished.job,
            result: {
              ...finished.result,
              results: finished.result.results.map((r) =>
                formatDirectCueForMcp(r, includeScores === true),
              ),
            },
          });
        }
        done.catch(() => {});
        return jsonOk({ jobId: job.id, job });
      }),
  );

  return server;
}
