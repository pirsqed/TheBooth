import { createHash } from 'node:crypto';
import { z } from 'zod';

export const AutoLevelModeSchema = z.enum(['gentle', 'match', 'off']);
export type AutoLevelMode = z.infer<typeof AutoLevelModeSchema>;

export const EqPresetSchema = z.enum([
  'neutral',
  'intimate',
  'whisper',
  'phone',
  'radio',
  'distant',
]);
export type EqPreset = z.infer<typeof EqPresetSchema>;

export const RoomToneStyleSchema = z.enum(['warm_dark', 'soft_pink']);
export type RoomToneStyle = z.infer<typeof RoomToneStyleSchema>;

export const ExportFormatSchema = z.enum(['ogg', 'wav', 'mp3']);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

export const SafeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'ID must start with alphanumeric and contain only a-z, A-Z, 0-9, _, -');

export const ProjectAudioSettingsSchema = z.object({
  sampleRate: z.literal(48000).default(48000),
  channels: z.literal(2).default(2),
  autoLevel: AutoLevelModeSchema.default('gentle'),
  workingTakeLufs: z.number().min(-36).max(-6).default(-20),
  masterNormalize: z.boolean().default(false),
  masterTargetLufs: z.number().min(-36).max(-6).default(-18),
  truePeakCeilingDb: z.number().min(-6).max(0).default(-1.5),
  headphoneCrossfeed: z.boolean().default(true),
  leadInMs: z.number().int().min(0).max(30000).default(0),
  tailMs: z.number().int().min(0).max(30000).default(2000),
});
export type ProjectAudioSettings = z.infer<typeof ProjectAudioSettingsSchema>;

export const VoiceAuditionSchema = z.object({
  id: SafeIdSchema,
  label: z.string().min(1).optional(),
  providerVoiceId: z.string().min(1),
  sampleText: z.string().min(1),
  audioPath: z.string().min(1),
  notes: z.string().optional(),
  createdAt: z.string(),
});
export type VoiceAudition = z.infer<typeof VoiceAuditionSchema>;

export const VoiceProfileSchema = z.object({
  id: SafeIdSchema,
  label: z.string().min(1),
  provider: z.string().min(1),
  providerVoiceId: z.string().min(1),
  defaultDirection: z.string().optional(),
  defaultEqPreset: EqPresetSchema.optional(),
  defaultPan: z.number().min(-1).max(1).optional(),
  notes: z.string().optional(),
  auditions: z.array(VoiceAuditionSchema).optional(),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

export const TakeSchema = z.object({
  id: SafeIdSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  providerVoiceId: z.string().min(1),
  direction: z.string().nullable(),
  textHash: z.string().min(1),
  audioPath: z.string().min(1),
  durationMs: z.number().min(0),
  measuredLufs: z.number().nullable(),
  measuredRmsDbfs: z.number(),
  peakDbfs: z.number(),
  createdAt: z.string(),
  notes: z.string().optional(),
});
export type Take = z.infer<typeof TakeSchema>;

export const CueTimingSchema = z.object({
  afterCueId: z.string().nullable().optional(),
  offsetMs: z.number().int().default(0),
});
export type CueTiming = z.infer<typeof CueTimingSchema>;

export const CueTrimSchema = z
  .object({
    startMs: z.number().int().min(0).optional(),
    endMs: z.number().int().min(0).nullable().optional(),
  })
  .refine(
    (t) =>
      t.startMs === undefined ||
      t.endMs === undefined ||
      t.endMs === null ||
      t.endMs > t.startMs,
    { message: 'trim.endMs must be greater than trim.startMs' },
  );
export type CueTrim = z.infer<typeof CueTrimSchema>;

export const CueMixSchema = z.object({
  autoLevel: AutoLevelModeSchema.optional(),
  gainDb: z.number().min(-24).max(12).default(0),
  pan: z.number().min(-1).max(1).default(0),
  eqPreset: EqPresetSchema.default('neutral'),
  fadeInMs: z.number().int().min(0).max(10000).default(20),
  fadeOutMs: z.number().int().min(0).max(10000).default(30),
  trim: CueTrimSchema.optional(),
  customFfmpegFilter: z.string().optional(),
});
export type CueMix = z.infer<typeof CueMixSchema>;

export const CueSchema = z.object({
  id: SafeIdSchema,
  speaker: z.string().min(1),
  text: z.string().min(1),
  direction: z.string().nullable().optional(),
  timing: CueTimingSchema.default({ offsetMs: 0 }),
  mix: CueMixSchema.default({}),
  activeTakeId: z.string().nullable().default(null),
  takes: z.array(TakeSchema).default([]),
});
export type Cue = z.infer<typeof CueSchema>;

export const BedDuckingSchema = z.object({
  enabled: z.boolean().default(true),
  amountDb: z.number().min(-24).max(0).default(-6),
  attackMs: z.number().int().min(5).max(5000).default(100),
  releaseMs: z.number().int().min(20).max(10000).default(800),
});
export type BedDucking = z.infer<typeof BedDuckingSchema>;

export const BedTrackSchema = z
  .object({
    id: SafeIdSchema,
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
    ducking: BedDuckingSchema,
  })
  .superRefine((bed, ctx) => {
    if (bed.kind === 'asset_file' && !bed.assetPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assetPath is required when bed kind is asset_file',
        path: ['assetPath'],
      });
    }
  });
export type BedTrack = z.infer<typeof BedTrackSchema>;

export const SfxAnchorSchema = z.object({
  cueId: z.string().nullable().optional(),
  edge: z.enum(['start', 'end']).default('end'),
  offsetMs: z.number().int().default(0),
});
export type SfxAnchor = z.infer<typeof SfxAnchorSchema>;

export const SfxEventSchema = z.object({
  id: SafeIdSchema,
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
export type SfxEvent = z.infer<typeof SfxEventSchema>;

export const MixExportWindowSchema = z.object({
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  fromCueId: z.string().optional(),
  toCueId: z.string().optional(),
});
export type MixExportWindow = z.infer<typeof MixExportWindowSchema>;

export const MixExportSchema = z.object({
  id: SafeIdSchema,
  format: ExportFormatSchema,
  audioPath: z.string().min(1),
  telemetryPath: z.string().min(1),
  durationMs: z.number().min(0),
  integratedLufs: z.number().nullable(),
  truePeakDbtp: z.number(),
  sampleRate: z.number().int(),
  channels: z.number().int(),
  window: MixExportWindowSchema.optional(),
  warnings: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type MixExport = z.infer<typeof MixExportSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: SafeIdSchema,
  name: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  audio: ProjectAudioSettingsSchema.default({}),
  voices: z.record(z.string(), VoiceProfileSchema).default({}),
  cues: z.array(CueSchema).default([]),
  beds: z.array(BedTrackSchema).default([]),
  sfx: z.array(SfxEventSchema).default([]),
  exports: z.array(MixExportSchema).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cueCount: number;
  renderedCueCount: number;
  exportCount: number;
}

export function createDefaultProjectAudio(): ProjectAudioSettings {
  return ProjectAudioSettingsSchema.parse({});
}

export function createDefaultRoomToneBed(): BedTrack {
  return {
    id: 'default_room_tone',
    label: 'Default Room Tone (Warm Dark)',
    kind: 'synthetic_room_tone',
    roomToneStyle: 'warm_dark',
    gainDb: -54,
    loop: true,
    startMs: 0,
    endMs: null,
    fadeInMs: 1500,
    fadeOutMs: 3000,
    ducking: {
      enabled: false,
      amountDb: 0,
      attackMs: 100,
      releaseMs: 800,
    },
  };
}

/**
 * Deterministic SHA-256 hash of (text + direction + providerVoiceId)
 * used for staleness detection and take preservation across script re-imports.
 */
export function computeTakeTextHash(
  text: string,
  direction: string | null | undefined,
  providerVoiceId: string,
): string {
  const payload = JSON.stringify({
    text,
    direction: direction ?? null,
    providerVoiceId,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
