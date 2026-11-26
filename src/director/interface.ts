import { z } from 'zod';
import { Cue, EqPresetSchema, Take } from '../types/project.js';

export const DirectorMixPatchSchema = z.object({
  gainDb: z.number().min(-24).max(12).optional(),
  eqPreset: EqPresetSchema.optional(),
});

export const DirectorReviewVerdictSchema = z.object({
  approved: z.boolean(),
  score: z.number().min(1).max(10),
  feedback: z.string().min(1),
  suggestedDirection: z.string().nullable().optional(),
  suggestedText: z.string().nullable().optional(),
  suggestedMixPatch: DirectorMixPatchSchema.nullable().optional(),
});
export type DirectorReviewVerdict = z.infer<typeof DirectorReviewVerdictSchema>;

export interface DirectorReviewRequest {
  projectName: string;
  cue: Cue;
  take: Take;
  voiceLabel: string;
  wavBuffer: Buffer;
  persona?: string | null;
  extraInstructions?: string | null;
  attempt: number;
  maxRetakes: number;
  previousFeedback: string[];
}

export interface DirectorReviewer {
  readonly name: string;
  reviewTake(req: DirectorReviewRequest): Promise<DirectorReviewVerdict>;
}

export interface CueDirectOptions {
  /** Built-in persona preset ID (e.g. "intimate_sleep") OR custom persona instructions */
  persona?: string | null;
  /** Optional extra session-specific directing notes */
  extraInstructions?: string | null;
  /** Strict per-cue retake cap (clamped to 0..5, default 2) */
  maxRetakes?: number;
  /** Allow applying Director's suggestedMixPatch (gainDb / eqPreset) on approval (default true) */
  allowMixAdjustments?: boolean;
  /** Allow applying Director's suggestedText inline vocal-tag tweaks on retake (default false) */
  allowTextTagTweaks?: boolean;
  /** Model override for the TTS render step */
  ttsModel?: string;
}

export interface CueDirectAttempt {
  attempt: number;
  takeId: string;
  directionUsed: string | null;
  verdict: DirectorReviewVerdict;
}

export interface CueDirectResult {
  cueId: string;
  approved: boolean;
  selectedTakeId: string;
  bestScore: number;
  retakesUsed: number;
  personaUsed: string;
  attempts: CueDirectAttempt[];
}

export interface ProjectDirectOptions extends CueDirectOptions {
  /** Optional subset of cue IDs to direct (defaults to all cues in project) */
  cueIds?: string[];
  /** Hard cap on total retakes spent across the entire project run */
  maxTotalRetakes?: number;
}

export interface ProjectDirectResult {
  projectId: string;
  personaUsed: string;
  totalCuesReviewed: number;
  approvedCount: number;
  totalRetakesUsed: number;
  results: CueDirectResult[];
}
