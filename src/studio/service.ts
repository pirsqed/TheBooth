import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BedTrack,
  Cue,
  CueMix,
  CueTiming,
  ExportFormat,
  MixExport,
  Project,
  ProjectAudioSettings,
  ProjectSummary,
  SfxEvent,
  Take,
  VoiceAudition,
  VoiceProfile,
  computeTakeTextHash,
  createDefaultProjectAudio,
  createDefaultRoomToneBed,
} from '../types/project.js';
import {
  DesignVoiceRequest,
  ListVoicesFilter,
  ProviderVoiceEntry,
  TtsProvider,
  validateWavBuffer,
} from '../providers/interface.js';
import {
  CueDirectAttempt,
  CueDirectOptions,
  CueDirectResult,
  DirectorReviewer,
  ProjectDirectOptions,
  ProjectDirectResult,
} from '../director/interface.js';
import {
  DirectorPersonaPreset,
  listDirectorPersonas,
  resolveDirectorPersona,
} from '../director/personas.js';
import { measureAudioLoudness, probeAudio, runCommand } from '../audio/ffmpeg.js';
import {
  MixdownTelemetry,
  computeEffectiveClipSpan,
  runMixdown,
} from '../audio/mixdown.js';
import {
  RenderedReelEntry,
  indexToReelLabel,
  renderComparisonReel,
} from '../audio/reel.js';
import {
  ResolvedTimeline,
  computeEffectiveTakeSpan,
  getActiveTake,
  resolveTimeline,
} from '../audio/timeline.js';
import {
  RenderVisualResult,
  VisualCueBlock,
  VisualMode,
  VisualPanel,
  VisualPreset,
  VisualSfxBlock,
  VisualValidationError,
  renderAudioVisual,
} from '../audio/visualize.js';
import { parseScript } from '../script/parser.js';
import {
  AssetEnricher,
  AssetIndexService,
  AssetSearchOptions,
  AssetSearchResult,
  IndexAssetsOptions,
  IndexAssetsSummary,
} from './assets-index.js';
import { JobTracker, StudioJob } from './jobs.js';
import { AssetFileEntry, ProjectStore, StoreError } from './store.js';

export interface StudioServiceOptions {
  store: ProjectStore;
  providers: Record<string, TtsProvider>;
  defaultProvider?: string;
  director?: DirectorReviewer;
  assetEnricher?: AssetEnricher;
  geminiEmbeddingModel?: string;
  assetEmbeddingDims?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  allowCustomFfmpegFilter?: boolean;
  allowedExportDirs?: string[];
  jobs?: JobTracker;
}

export interface AssetMountSummary {
  alias: string;
  readOnly: boolean;
  indexedCount: number | null;
}

export interface GetAssetAudioOptions {
  assetPath: string;
  startSec?: number;
  maxDurationSec?: number;
}

export interface AssetAudioPreviewResult {
  assetPath: string;
  filePath: string;
  previewAudioPath: string;
  mount: string;
  readOnly: boolean;
  totalDurationSec: number;
  previewStartSec: number;
  previewDurationSec: number;
  channels: number;
  sampleRate: number;
  sizeBytes: number;
  mimeType: string;
  transcoded: boolean;
  audioBuffer: Buffer;
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  audio?: Partial<ProjectAudioSettings>;
  includeDefaultRoomTone?: boolean;
}

export interface ImportScriptInput {
  script: string;
  mode?: 'replace' | 'append';
  defaultSpeaker?: string;
  maxChunkBytes?: number;
}

export interface ImportScriptResult {
  project: Project;
  importedCueCount: number;
  preservedTakeCount: number;
  importedBedCount: number;
  importedSfxCount: number;
  warnings: string[];
}

export interface AddCueInput {
  id?: string;
  speaker: string;
  text: string;
  direction?: string | null;
  timing?: Partial<CueTiming>;
  mix?: Partial<CueMix>;
  insertAtIndex?: number;
}

export interface UpdateCueInput {
  speaker?: string;
  text?: string;
  direction?: string | null;
  timing?: Partial<CueTiming>;
  mix?: Partial<CueMix>;
  activeTakeId?: string | null;
}

export interface RenderTakeOptions {
  activate?: boolean;
  model?: string;
}

export interface RenderAllOptions {
  concurrency?: number;
  force?: boolean;
}

export interface UploadedAssetInfo {
  path: string;
  sizeBytes: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  codecName: string;
}

export interface AuditionVoiceInput {
  candidateVoiceIds: string[];
  sampleText: string;
  direction?: string | null;
  notes?: string;
  provider?: string;
  model?: string;
  /** Render a playable labeled A/B comparison reel automatically when >= 2 candidates (default: true) */
  renderReel?: boolean;
  reelFormat?: ExportFormat;
  reelOutputPath?: string;
}

export interface ComparisonReelSummary {
  reelPath: string;
  deliveredPath: string | null;
  format: ExportFormat;
  durationSec: number;
  entries: RenderedReelEntry[];
}

export interface DesignedVoiceSummary {
  voiceId: string;
  displayName: string;
  provider: string;
  model: string;
  type?: string;
  gender?: string;
  languageCode?: string;
  regionCode?: string;
  accent?: string;
  pitch?: string;
  persona?: string;
  context?: string;
  description?: string;
  prompt?: string;
  baseVoice?: string;
  expireTime?: string;
  previewAudioPath?: string;
  previewSizeBytes?: number;
}

export interface ProviderVoiceSummary extends ProviderVoiceEntry {
  provider: string;
  previewAudioPath?: string;
  previewSizeBytes?: number;
}

export class StudioService {
  readonly store: ProjectStore;
  readonly jobs: JobTracker;
  readonly assetIndex: AssetIndexService;
  private readonly providers: Record<string, TtsProvider>;
  private readonly defaultProvider: string;
  private readonly director?: DirectorReviewer;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly allowCustomFfmpegFilter: boolean;
  private readonly allowedExportDirs?: string[];

  constructor(options: StudioServiceOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.defaultProvider =
      options.defaultProvider ?? Object.keys(options.providers)[0] ?? 'mock';
    this.director = options.director;
    this.ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
    this.ffprobePath = options.ffprobePath ?? 'ffprobe';
    this.allowCustomFfmpegFilter = options.allowCustomFfmpegFilter ?? false;
    this.allowedExportDirs = options.allowedExportDirs?.map((d) => path.resolve(d));
    this.jobs = options.jobs ?? new JobTracker();
    this.assetIndex = new AssetIndexService({
      store: this.store,
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath,
      enricher: options.assetEnricher,
      embeddingModel: options.geminiEmbeddingModel,
      embeddingDims: options.assetEmbeddingDims,
    });
  }

  private getProvider(name: string): TtsProvider {
    const provider = this.providers[name];
    if (!provider) {
      throw new StoreError(`Unknown TTS provider "${name}"`, 400);
    }
    return provider;
  }

  private resolveVoiceForCue(
    project: Project,
    cue: Cue,
  ): { providerName: string; providerVoiceId: string; effectiveDirection: string | null } {
    const profile = project.voices[cue.speaker];
    const providerName = profile?.provider ?? this.defaultProvider;
    const providerVoiceId = profile?.providerVoiceId ?? cue.speaker;
    const effectiveDirection =
      cue.direction !== undefined ? cue.direction : profile?.defaultDirection ?? null;
    return { providerName, providerVoiceId, effectiveDirection };
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const now = new Date().toISOString();
    const id = input.id ?? `proj_${crypto.randomBytes(6).toString('hex')}`;
    const audio: ProjectAudioSettings = {
      ...createDefaultProjectAudio(),
      ...(input.audio ?? {}),
    };
    const beds: BedTrack[] =
      input.includeDefaultRoomTone === false ? [] : [createDefaultRoomToneBed()];

    const project: Project = {
      schemaVersion: 1,
      id,
      name: input.name,
      createdAt: now,
      updatedAt: now,
      audio,
      voices: {},
      cues: [],
      beds,
      sfx: [],
      exports: [],
    };
    return this.store.createProject(project);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return this.store.listProjects();
  }

  async getProject(
    projectId: string,
  ): Promise<{ project: Project; timeline: ResolvedTimeline }> {
    const project = await this.store.requireProject(projectId);
    const timeline = resolveTimeline(project);
    return { project, timeline };
  }

  async updateProject(
    projectId: string,
    patch: { name?: string; audio?: Partial<ProjectAudioSettings> },
  ): Promise<Project> {
    return this.store.updateProject(projectId, (project) => {
      if (patch.name !== undefined) {
        project.name = patch.name;
      }
      if (patch.audio) {
        project.audio = { ...project.audio, ...patch.audio };
      }
      return project;
    });
  }

  async upsertVoice(
    projectId: string,
    voiceId: string,
    profile: Omit<VoiceProfile, 'id'>,
  ): Promise<Project> {
    return this.store.updateProject(projectId, (project) => {
      project.voices[voiceId] = {
        ...profile,
        id: voiceId,
      };
      return project;
    });
  }

  async importScript(
    projectId: string,
    input: ImportScriptInput,
  ): Promise<ImportScriptResult> {
    const mode = input.mode ?? 'replace';
    let importedCueCount = 0;
    let preservedTakeCount = 0;
    let importedBedCount = 0;
    let importedSfxCount = 0;
    let warnings: string[] = [];

    const project = await this.store.updateProject(projectId, (current) => {
      const parsed = parseScript(input.script, {
        voices: current.voices,
        defaultSpeaker: input.defaultSpeaker,
        maxChunkBytes: input.maxChunkBytes,
      });

      warnings = parsed.warnings;
      importedCueCount = parsed.cues.length;
      importedBedCount = parsed.beds.length;
      importedSfxCount = parsed.sfx.length;

      if (mode === 'replace') {
        // Index existing takes by textHash so unchanged lines never re-spend TTS tokens
        const takesByHash = new Map<string, { takes: Take[]; activeTakeId: string | null }>();
        for (const oldCue of current.cues) {
          for (const take of oldCue.takes) {
            const bucket = takesByHash.get(take.textHash) ?? {
              takes: [],
              activeTakeId: null,
            };
            if (!bucket.takes.some((t) => t.id === take.id)) {
              bucket.takes.push(take);
            }
            if (oldCue.activeTakeId === take.id) {
              bucket.activeTakeId = take.id;
            }
            takesByHash.set(take.textHash, bucket);
          }
        }

        for (const newCue of parsed.cues) {
          const { providerVoiceId, effectiveDirection } = this.resolveVoiceForCue(
            current,
            newCue,
          );
          const hash = computeTakeTextHash(
            newCue.text,
            effectiveDirection,
            providerVoiceId,
          );
          const preserved = takesByHash.get(hash);
          if (preserved && preserved.takes.length > 0) {
            newCue.takes = preserved.takes.map((t) => structuredClone(t));
            newCue.activeTakeId =
              preserved.activeTakeId ??
              preserved.takes[preserved.takes.length - 1]!.id;
            preservedTakeCount += 1;
          }
        }

        current.cues = parsed.cues;
        current.sfx = parsed.sfx;

        if (parsed.beds.length > 0) {
          // Per SPEC Section 4 Rule 1: replace default room tone when script supplies ambient beds
          const hasExplicitRoomTone = parsed.beds.some(
            (b) => b.kind === 'synthetic_room_tone',
          );
          const hasAssetBed = parsed.beds.some((b) => b.kind === 'asset_file');
          current.beds =
            hasExplicitRoomTone || hasAssetBed
              ? parsed.beds
              : [createDefaultRoomToneBed(), ...parsed.beds];
        }
      } else {
        // append mode
        current.cues.push(...parsed.cues);
        current.sfx.push(...parsed.sfx);
        if (parsed.beds.length > 0) {
          const hasAssetBed = parsed.beds.some((b) => b.kind === 'asset_file');
          if (hasAssetBed) {
            current.beds = current.beds.filter((b) => b.id !== 'default_room_tone');
          }
          current.beds.push(...parsed.beds);
        }
      }

      // Validate resulting timeline has no cycles or invalid anchors
      resolveTimeline(current);
      return current;
    });

    return {
      project,
      importedCueCount,
      preservedTakeCount,
      importedBedCount,
      importedSfxCount,
      warnings,
    };
  }

  async addCue(projectId: string, input: AddCueInput): Promise<{ project: Project; cue: Cue }> {
    let createdCue!: Cue;
    const project = await this.store.updateProject(projectId, (current) => {
      const voice = current.voices[input.speaker];
      const cue: Cue = {
        id: input.id ?? `cue_${crypto.randomBytes(6).toString('hex')}`,
        speaker: input.speaker,
        text: input.text,
        direction: input.direction ?? voice?.defaultDirection ?? null,
        timing: {
          afterCueId: input.timing?.afterCueId,
          offsetMs: input.timing?.offsetMs ?? 0,
        },
        mix: {
          ...(input.mix?.autoLevel !== undefined ? { autoLevel: input.mix.autoLevel } : {}),
          gainDb: input.mix?.gainDb ?? 0,
          pan: input.mix?.pan ?? voice?.defaultPan ?? 0,
          eqPreset: input.mix?.eqPreset ?? voice?.defaultEqPreset ?? 'neutral',
          fadeInMs: input.mix?.fadeInMs ?? 20,
          fadeOutMs: input.mix?.fadeOutMs ?? 30,
          ...(input.mix?.customFfmpegFilter
            ? { customFfmpegFilter: input.mix.customFfmpegFilter }
            : {}),
        },
        activeTakeId: null,
        takes: [],
      };

      if (
        input.insertAtIndex !== undefined &&
        input.insertAtIndex >= 0 &&
        input.insertAtIndex <= current.cues.length
      ) {
        current.cues.splice(input.insertAtIndex, 0, cue);
      } else {
        current.cues.push(cue);
      }

      resolveTimeline(current);
      createdCue = cue;
      return current;
    });
    return { project, cue: createdCue };
  }

  async updateCue(
    projectId: string,
    cueId: string,
    patch: UpdateCueInput,
  ): Promise<{ project: Project; cue: Cue }> {
    let updatedCue!: Cue;
    const project = await this.store.updateProject(projectId, (current) => {
      const cue = current.cues.find((c) => c.id === cueId);
      if (!cue) {
        throw new StoreError(`Cue not found: ${cueId}`, 404);
      }
      if (patch.speaker !== undefined) cue.speaker = patch.speaker;
      if (patch.text !== undefined) cue.text = patch.text;
      if (patch.direction !== undefined) cue.direction = patch.direction;
      if (patch.timing !== undefined) {
        cue.timing = { ...cue.timing, ...patch.timing };
      }
      if (patch.mix !== undefined) {
        cue.mix = { ...cue.mix, ...patch.mix };
      }
      if (patch.activeTakeId !== undefined) {
        if (
          patch.activeTakeId !== null &&
          !cue.takes.some((t) => t.id === patch.activeTakeId)
        ) {
          throw new StoreError(
            `Take "${patch.activeTakeId}" not found on cue "${cueId}"`,
            404,
          );
        }
        cue.activeTakeId = patch.activeTakeId;
      }

      resolveTimeline(current);
      updatedCue = cue;
      return current;
    });
    return { project, cue: updatedCue };
  }

  async deleteCue(projectId: string, cueId: string): Promise<Project> {
    return this.store.updateProject(projectId, (current) => {
      const idx = current.cues.findIndex((c) => c.id === cueId);
      if (idx === -1) {
        throw new StoreError(`Cue not found: ${cueId}`, 404);
      }
      const deleted = current.cues[idx]!;
      const fallbackAnchor =
        deleted.timing.afterCueId !== undefined
          ? deleted.timing.afterCueId
          : idx > 0
            ? current.cues[idx - 1]!.id
            : null;

      // Re-anchor dependent cues safely
      for (const other of current.cues) {
        if (other.id !== cueId && other.timing.afterCueId === cueId) {
          other.timing.afterCueId = fallbackAnchor;
        }
      }
      // Re-anchor dependent SFX safely
      for (const evt of current.sfx) {
        if (evt.anchor.cueId === cueId) {
          evt.anchor.cueId = fallbackAnchor;
          evt.anchor.edge = fallbackAnchor ? 'end' : 'start';
        }
      }
      // Re-anchor cue-anchored beds safely
      for (const bed of current.beds) {
        if (bed.startCueId === cueId) {
          bed.startCueId = fallbackAnchor;
        }
        if (bed.endCueId === cueId) {
          bed.endCueId = fallbackAnchor;
        }
      }

      current.cues.splice(idx, 1);
      resolveTimeline(current);
      return current;
    });
  }

  /**
   * Non-destructively splits a rendered cue at `atMs` (relative to the cue's current
   * playable start) into two sequential cues sharing the exact same immutable raw WAV take.
   * Zero TTS re-synthesis: lets directors insert or adjust pauses/beats mid-line in Stage 2.
   */
  async splitCue(
    projectId: string,
    cueId: string,
    input: {
      atMs: number;
      gapMs?: number;
      secondCueId?: string;
      textBefore?: string;
      textAfter?: string;
    },
  ): Promise<{
    project: Project;
    firstCue: Cue;
    secondCue: Cue;
    splitAtRawMs: number;
    gapMs: number;
  }> {
    const gapMs = Math.round(input.gapMs ?? 400);
    const atMs = Math.round(input.atMs);
    let firstCueOut!: Cue;
    let secondCueOut!: Cue;
    let splitAtRawMs = 0;

    const project = await this.store.updateProject(projectId, (current) => {
      const idx = current.cues.findIndex((c) => c.id === cueId);
      if (idx === -1) {
        throw new StoreError(`Cue not found: ${cueId}`, 404);
      }
      const cue = current.cues[idx]!;
      const activeTake = getActiveTake(cue);
      if (!activeTake) {
        throw new StoreError(
          `Cue "${cueId}" has no active take to split. Render a take first.`,
          400,
        );
      }

      const span = computeEffectiveTakeSpan(cue, activeTake);
      if (span.durationMs < 120) {
        throw new StoreError(
          `Cue "${cueId}" playable duration (${span.durationMs} ms) is too short to split.`,
          400,
        );
      }
      if (atMs < 50 || atMs > span.durationMs - 50) {
        throw new StoreError(
          `atMs (${atMs} ms) must be between 50 ms and ${span.durationMs - 50} ms for cue "${cueId}".`,
          400,
        );
      }

      splitAtRawMs = span.trimStartMs + atMs;

      const candidateId =
        input.secondCueId ??
        `${cue.id}_b_${crypto.randomBytes(2).toString('hex')}`;
      if (current.cues.some((c) => c.id === candidateId)) {
        throw new StoreError(`Cue ID already exists: ${candidateId}`, 409);
      }

      const origText = cue.text;
      cue.text = input.textBefore?.trim() || origText;
      cue.mix = {
        ...cue.mix,
        fadeOutMs: Math.min(cue.mix.fadeOutMs, 20),
        trim: {
          startMs: span.trimStartMs,
          endMs: splitAtRawMs,
        },
      };

      const secondCue: Cue = {
        id: candidateId,
        speaker: cue.speaker,
        text: input.textAfter?.trim() || `${origText} (cont.)`,
        direction: cue.direction,
        timing: {
          afterCueId: cue.id,
          offsetMs: gapMs,
        },
        mix: {
          ...cue.mix,
          fadeInMs: Math.min(cue.mix.fadeInMs, 20),
          fadeOutMs: 30,
          trim: {
            startMs: splitAtRawMs,
            endMs: span.trimEndMs,
          },
        },
        activeTakeId: cue.activeTakeId,
        takes: cue.takes.map((t) => ({ ...t })),
      };

      for (const other of current.cues) {
        if (other.id !== cue.id && other.timing.afterCueId === cue.id) {
          other.timing.afterCueId = secondCue.id;
        }
      }
      for (const s of current.sfx) {
        if (s.anchor.cueId === cue.id && s.anchor.edge === 'end') {
          s.anchor.cueId = secondCue.id;
        }
      }
      for (const b of current.beds) {
        if (b.endCueId === cue.id && b.endEdge !== 'start') {
          b.endCueId = secondCue.id;
        }
      }

      current.cues.splice(idx + 1, 0, secondCue);
      resolveTimeline(current);

      firstCueOut = cue;
      secondCueOut = secondCue;
      return current;
    });

    return {
      project,
      firstCue: firstCueOut,
      secondCue: secondCueOut,
      splitAtRawMs,
      gapMs,
    };
  }

  async upsertBed(
    projectId: string,
    bedId: string,
    bed: Omit<BedTrack, 'id'>,
  ): Promise<Project> {
    return this.store.updateProject(projectId, (current) => {
      const entry: BedTrack = { ...bed, id: bedId };
      const idx = current.beds.findIndex((b) => b.id === bedId);
      if (idx === -1) {
        current.beds.push(entry);
      } else {
        current.beds[idx] = entry;
      }
      resolveTimeline(current);
      return current;
    });
  }

  async deleteBed(projectId: string, bedId: string): Promise<Project> {
    return this.store.updateProject(projectId, (current) => {
      const idx = current.beds.findIndex((b) => b.id === bedId);
      if (idx === -1) {
        throw new StoreError(`Bed not found: ${bedId}`, 404);
      }
      current.beds.splice(idx, 1);
      return current;
    });
  }

  async upsertSfx(
    projectId: string,
    sfxId: string,
    sfx: Omit<SfxEvent, 'id'>,
  ): Promise<Project> {
    return this.store.updateProject(projectId, (current) => {
      const entry: SfxEvent = { ...sfx, id: sfxId };
      const idx = current.sfx.findIndex((s) => s.id === sfxId);
      if (idx === -1) {
        current.sfx.push(entry);
      } else {
        current.sfx[idx] = entry;
      }
      resolveTimeline(current);
      return current;
    });
  }

  async deleteSfx(projectId: string, sfxId: string): Promise<Project> {
    return this.store.updateProject(projectId, (current) => {
      const idx = current.sfx.findIndex((s) => s.id === sfxId);
      if (idx === -1) {
        throw new StoreError(`SFX not found: ${sfxId}`, 404);
      }
      current.sfx.splice(idx, 1);
      return current;
    });
  }

  /**
   * Stage-1 synthesis: calls TTS provider, validates raw WAV, writes immutable
   * `takes/<takeId>.wav`, measures read-only LUFS/RMS/peak telemetry, and records Take.
   */
  async renderTake(
    projectId: string,
    cueId: string,
    options: RenderTakeOptions = {},
  ): Promise<{ project: Project; take: Take }> {
    const snapshot = await this.store.requireProject(projectId);
    const cueSnapshot = snapshot.cues.find((c) => c.id === cueId);
    if (!cueSnapshot) {
      throw new StoreError(`Cue not found: ${cueId}`, 404);
    }

    const { providerName, providerVoiceId, effectiveDirection } =
      this.resolveVoiceForCue(snapshot, cueSnapshot);
    const provider = this.getProvider(providerName);

    const synth = await provider.synthesize({
      text: cueSnapshot.text,
      voiceId: providerVoiceId,
      direction: effectiveDirection,
      model: options.model,
    });

    // Validate RIFF/WAVE framing so truncated audio can never be saved
    const wavInfo = validateWavBuffer(synth.wavBuffer);

    const takeId = `take_${crypto.randomBytes(6).toString('hex')}`;
    const audioRelPath = await this.store.writeTakeWav(
      projectId,
      takeId,
      synth.wavBuffer,
    );
    const audioAbsPath = this.store.resolveProjectFile(projectId, audioRelPath);

    const [probe, loudness] = await Promise.all([
      probeAudio(audioAbsPath, this.ffprobePath),
      measureAudioLoudness(audioAbsPath, this.ffmpegPath),
    ]);

    const take: Take = {
      id: takeId,
      provider: synth.provider,
      model: synth.model,
      providerVoiceId,
      direction: effectiveDirection,
      textHash: computeTakeTextHash(
        cueSnapshot.text,
        effectiveDirection,
        providerVoiceId,
      ),
      audioPath: audioRelPath,
      durationMs: probe.durationMs || wavInfo.durationMs,
      measuredLufs: loudness.measuredLufs,
      measuredRmsDbfs: loudness.measuredRmsDbfs,
      peakDbfs: loudness.peakDbfs,
      createdAt: new Date().toISOString(),
    };

    const activate = options.activate !== false;
    const project = await this.store.updateProject(projectId, (current) => {
      const cue = current.cues.find((c) => c.id === cueId);
      if (!cue) {
        throw new StoreError(`Cue not found: ${cueId}`, 404);
      }
      cue.takes.push(take);
      if (activate) {
        cue.activeTakeId = take.id;
      }
      return current;
    });

    return { project, take };
  }

  getJob(jobId: string): StudioJob | null {
    return this.jobs.get(jobId);
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.store.requireProject(projectId);
    await this.store.deleteProject(projectId);
  }

  async getTakeAudioFile(
    projectId: string,
    cueId: string,
    takeId: string,
  ): Promise<{ filePath: string; take: Take }> {
    const project = await this.store.requireProject(projectId);
    const cue = project.cues.find((c) => c.id === cueId);
    if (!cue) {
      throw new StoreError(`Cue not found: ${cueId}`, 404);
    }
    const take = cue.takes.find((t) => t.id === takeId);
    if (!take) {
      throw new StoreError(`Take "${takeId}" not found on cue "${cueId}"`, 404);
    }
    const filePath = this.store.resolveProjectFile(projectId, take.audioPath);
    return { filePath, take };
  }

  async getExportAudioFile(
    projectId: string,
    exportId: string,
  ): Promise<{ filePath: string; exportRecord: MixExport }> {
    const project = await this.store.requireProject(projectId);
    const exportRecord = project.exports.find((e) => e.id === exportId);
    if (!exportRecord) {
      throw new StoreError(`Export not found: ${exportId}`, 404);
    }
    const filePath = this.store.resolveProjectFile(projectId, exportRecord.audioPath);
    return { filePath, exportRecord };
  }

  /**
   * Renders a calibrated visual-audio inspection chart (default 4-panel Master View:
   * DAW Cue Overlay + Split L/R Waveforms + Split L/R & Combined 300ms RMS + Log-Mel Spectrogram,
   * or pure-FFmpeg 'fast' path) for any export, take, audition, or shared asset.
   */
  async inspectVisual(input: {
    projectId?: string;
    target:
      | { type: 'export'; exportId: string }
      | { type: 'take'; cueId?: string; takeId: string }
      | { type: 'audition'; voiceId: string; auditionId: string }
      | { type: 'asset'; assetPath: string };
    preset?: VisualPreset;
    mode?: VisualMode;
    startSec?: number;
    endSec?: number;
    panels?: VisualPanel[];
    saveToDisk?: boolean;
  }): Promise<
    RenderVisualResult & {
      imagePath: string | null;
      summaryTelemetry: Record<string, unknown>;
    }
  > {
    let audioPath: string;
    let cueBlocks: VisualCueBlock[] = [];
    let sfxBlocks: VisualSfxBlock[] = [];
    let targetSlug: string;
    let titlePrefix: string;
    let summaryTelemetry: Record<string, unknown>;

    if (input.target.type === 'asset') {
      const resolvedAsset = await this.store.resolveExistingAssetFile(input.target.assetPath);
      audioPath = resolvedAsset.absPath;
      targetSlug = `asset_${crypto
        .createHash('sha1')
        .update(resolvedAsset.canonicalPath)
        .digest('hex')
        .slice(0, 10)}`;
      titlePrefix = `Asset ${resolvedAsset.canonicalPath}`;
      summaryTelemetry = {
        targetType: 'asset',
        assetPath: resolvedAsset.canonicalPath,
        mount: resolvedAsset.mount,
        readOnly: resolvedAsset.readOnly,
      };
    } else {
      if (!input.projectId) {
        throw new StoreError('projectId is required for export, take, and audition targets', 400);
      }
      const project = await this.store.requireProject(input.projectId);

      if (input.target.type === 'export') {
        const { exportId } = input.target;
        const exportRecord = project.exports.find((e) => e.id === exportId);
        if (!exportRecord) {
          throw new StoreError(`Export not found: ${exportId}`, 404);
        }
        audioPath = this.store.resolveProjectFile(input.projectId, exportRecord.audioPath);
        const sfxDurationsMs: Record<string, number> = {};
        const dummyWarnings: string[] = [];
        for (const evt of project.sfx) {
          try {
            const resolvedAsset = await this.store.resolveExistingAssetFile(evt.assetPath);
            const probed = await probeAudio(resolvedAsset.absPath, this.ffprobePath);
            const clip = computeEffectiveClipSpan(
              probed.durationMs,
              evt.clipStartMs,
              evt.clipDurationMs,
              `SFX "${evt.id}"`,
              dummyWarnings,
            );
            sfxDurationsMs[evt.id] = clip.durationMs;
          } catch {
            sfxDurationsMs[evt.id] = evt.clipDurationMs ?? 300;
          }
        }
        const timeline = resolveTimeline(project, sfxDurationsMs);
        const winStartSec = (exportRecord.window?.startMs ?? 0) / 1000;
        const winEndSec =
          exportRecord.window !== undefined
            ? exportRecord.window.endMs / 1000
            : Number.POSITIVE_INFINITY;

        cueBlocks = timeline.cues
          .map((rc) => {
            const cueObj = project.cues.find((c) => c.id === rc.cueId);
            return {
              id: rc.cueId,
              speaker: rc.speaker,
              startSec: rc.startMs / 1000,
              endSec: rc.endMs / 1000,
              plannedPan: cueObj?.mix.pan ?? 0,
              gainDb: cueObj?.mix.gainDb ?? 0,
            };
          })
          .filter((c) => c.endSec > winStartSec && c.startSec < winEndSec)
          .map((c) => ({
            ...c,
            startSec: Math.max(0, c.startSec - winStartSec),
            endSec: Math.max(0, Math.min(c.endSec, winEndSec) - winStartSec),
          }));

        sfxBlocks = timeline.sfx
          .map((rs, idx) => {
            const evt = project.sfx[idx];
            return {
              id: rs.sfxId,
              label: rs.label,
              startSec: rs.startMs / 1000,
              endSec: Math.max(rs.startMs / 1000 + 0.05, rs.endMs / 1000),
              pan: evt?.pan ?? 0,
              gainDb: evt?.gainDb ?? -6,
            };
          })
          .filter((s) => s.endSec > winStartSec && s.startSec < winEndSec)
          .map((s) => ({
            ...s,
            startSec: Math.max(0, s.startSec - winStartSec),
            endSec: Math.max(0, Math.min(s.endSec, winEndSec) - winStartSec),
          }));

        targetSlug = exportRecord.id;
        titlePrefix = `${project.id} / ${exportRecord.id}`;
        summaryTelemetry = {
          targetType: 'export',
          projectId: project.id,
          exportId: exportRecord.id,
          format: exportRecord.format,
          integratedLufs: exportRecord.integratedLufs,
          truePeakDbtp: exportRecord.truePeakDbtp,
          cueCount: cueBlocks.length,
          sfxCount: sfxBlocks.length,
          ...(exportRecord.window ? { window: exportRecord.window } : {}),
        };
      } else if (input.target.type === 'take') {
        const { cueId, takeId } = input.target;
        let matchedCue: Cue | undefined;
        let matchedTake: Take | undefined;
        if (cueId) {
          matchedCue = project.cues.find((c) => c.id === cueId);
          if (!matchedCue) {
            throw new StoreError(`Cue not found: ${cueId}`, 404);
          }
          matchedTake = matchedCue.takes.find((t) => t.id === takeId);
        } else {
          for (const c of project.cues) {
            const found = c.takes.find((t) => t.id === takeId);
            if (found) {
              matchedCue = c;
              matchedTake = found;
              break;
            }
          }
        }
        if (!matchedCue || !matchedTake) {
          throw new StoreError(`Take not found: ${takeId}`, 404);
        }
        audioPath = this.store.resolveProjectFile(input.projectId, matchedTake.audioPath);
        targetSlug = matchedTake.id;
        titlePrefix = `${project.id} / ${matchedCue.id} (${matchedCue.speaker}) / ${matchedTake.id}`;
        summaryTelemetry = {
          targetType: 'take',
          projectId: project.id,
          cueId: matchedCue.id,
          speaker: matchedCue.speaker,
          takeId: matchedTake.id,
          durationMs: matchedTake.durationMs,
          measuredLufs: matchedTake.measuredLufs,
          measuredRmsDbfs: matchedTake.measuredRmsDbfs,
          peakDbfs: matchedTake.peakDbfs,
        };
      } else {
        const { voiceId, auditionId } = input.target;
        const voice = project.voices[voiceId];
        if (!voice) {
          throw new StoreError(`Voice not found: ${voiceId}`, 404);
        }
        const audition = (voice.auditions ?? []).find((a) => a.id === auditionId);
        if (!audition) {
          throw new StoreError(`Audition "${auditionId}" not found on voice "${voiceId}"`, 404);
        }
        audioPath = this.store.resolveProjectFile(input.projectId, audition.audioPath);
        targetSlug = audition.id;
        titlePrefix = `${project.id} / voice ${voiceId} / ${audition.id}`;
        summaryTelemetry = {
          targetType: 'audition',
          projectId: project.id,
          voiceId,
          auditionId: audition.id,
          providerVoiceId: audition.providerVoiceId,
        };
      }
    }

    try {
      await fs.access(audioPath);
    } catch {
      throw new StoreError(`Audio file missing on disk for visual inspection: ${audioPath}`, 404);
    }

    const preset = input.preset ?? 'master';
    const spanTag =
      input.startSec !== undefined || input.endSec !== undefined
        ? `${(input.startSec ?? 0).toFixed(1)}s-${input.endSec !== undefined ? `${input.endSec.toFixed(1)}s` : 'end'}`
        : 'full';

    let rendered: RenderVisualResult;
    try {
      rendered = await renderAudioVisual({
        audioPath,
        ffmpegPath: this.ffmpegPath,
        ffprobePath: this.ffprobePath,
        preset,
        mode: input.mode,
        startSec: input.startSec,
        endSec: input.endSec,
        panels: input.panels,
        cueBlocks,
        sfxBlocks,
        title: `${titlePrefix} | ${spanTag} (${preset})`,
      });
    } catch (err: unknown) {
      if (err instanceof VisualValidationError) {
        throw new StoreError(err.message, err.statusCode);
      }
      throw err;
    }

    // Add cues & SFX visible inside the rendered window for quick reference
    if (cueBlocks.length > 0) {
      summaryTelemetry.cuesInWindow = cueBlocks
        .filter((c) => c.endSec > rendered.startSec && c.startSec < rendered.endSec)
        .map((c) => ({
          id: c.id,
          speaker: c.speaker,
          startSec: Number(c.startSec.toFixed(3)),
          endSec: Number(c.endSec.toFixed(3)),
          plannedPan: c.plannedPan,
          gainDb: c.gainDb ?? 0,
        }));
    }
    if (sfxBlocks.length > 0) {
      summaryTelemetry.sfxInWindow = sfxBlocks
        .filter((s) => s.endSec > rendered.startSec && s.startSec < rendered.endSec)
        .map((s) => ({
          id: s.id,
          label: s.label,
          startSec: Number(s.startSec.toFixed(3)),
          endSec: Number(s.endSec.toFixed(3)),
          pan: s.pan,
          gainDb: s.gainDb ?? -6,
        }));
    }

    let imagePath: string | null = null;
    if (input.saveToDisk !== false) {
      const optHash = crypto
        .createHash('sha1')
        .update(
          JSON.stringify({
            preset: rendered.preset,
            mode: rendered.mode,
            panels: rendered.panels,
            startSec: rendered.startSec,
            endSec: rendered.endSec,
          }),
        )
        .digest('hex')
        .slice(0, 8);
      const fileId = `${targetSlug}_${rendered.preset}_${optHash}`;
      if (input.projectId && input.target.type !== 'asset') {
        const saved = await this.store.writeVisualPng(
          input.projectId,
          fileId,
          rendered.pngBuffer,
        );
        imagePath = saved.absPath;
      } else {
        imagePath = await this.store.writeSharedVisualPng(fileId, rendered.pngBuffer);
      }
    }

    return {
      ...rendered,
      imagePath,
      summaryTelemetry,
    };
  }

  /**
   * Starts an asynchronous render-all job for all cues missing an active take
   * (or whose active take textHash is stale) with bounded concurrency.
   * Returns the initial job snapshot immediately alongside a completion promise.
   */
  async startRenderAll(
    projectId: string,
    options: RenderAllOptions = {},
  ): Promise<{ job: StudioJob; done: Promise<StudioJob> }> {
    const project = await this.store.requireProject(projectId);
    const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 2));
    const force = options.force ?? false;

    const targetCueIds: string[] = [];
    for (const cue of project.cues) {
      if (force) {
        targetCueIds.push(cue.id);
        continue;
      }
      const active = cue.activeTakeId
        ? cue.takes.find((t) => t.id === cue.activeTakeId)
        : null;
      if (!active) {
        targetCueIds.push(cue.id);
        continue;
      }
      const { providerVoiceId, effectiveDirection } = this.resolveVoiceForCue(
        project,
        cue,
      );
      const expectedHash = computeTakeTextHash(
        cue.text,
        effectiveDirection,
        providerVoiceId,
      );
      if (active.textHash !== expectedHash) {
        targetCueIds.push(cue.id);
      }
    }

    const initialJob = this.jobs.create(projectId, 'render_all', targetCueIds.length);
    const runningJob = this.jobs.update(initialJob.id, { status: 'running' });

    const done = (async (): Promise<StudioJob> => {
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= targetCueIds.length) return;
          const cueId = targetCueIds[idx]!;
          try {
            await this.renderTake(projectId, cueId, { activate: true });
            this.jobs.incrementCompleted(initialJob.id);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.jobs.recordError(initialJob.id, cueId, message);
          }
        }
      };

      const workers = Array.from(
        { length: Math.min(concurrency, Math.max(1, targetCueIds.length)) },
        () => worker(),
      );
      await Promise.all(workers);

      const latestJob = this.jobs.get(initialJob.id)!;
      const finalStatus =
        latestJob.failed > 0 && latestJob.completed === 0 && targetCueIds.length > 0
          ? 'failed'
          : 'completed';
      return this.jobs.update(initialJob.id, { status: finalStatus });
    })();

    return { job: runningJob, done };
  }

  /**
   * Renders all cues missing an active take (or whose active take textHash is stale)
   * and awaits completion.
   */
  async renderAll(
    projectId: string,
    options: RenderAllOptions = {},
  ): Promise<{ job: StudioJob; project: Project }> {
    const { done } = await this.startRenderAll(projectId, options);
    const finalJob = await done;
    const updatedProject = await this.store.requireProject(projectId);
    return { job: finalJob, project: updatedProject };
  }

  private async resolveDeliveryDestination(
    rawOutputPath: string,
    requestedFormat?: ExportFormat,
  ): Promise<{ format: ExportFormat; targetPath: string; isDirectory: boolean }> {
    const trimmed = rawOutputPath.trim();
    if (!trimmed || trimmed.includes('\0')) {
      throw new StoreError('Invalid outputPath', 400);
    }

    const trailingSep = /[\\/]$/.test(trimmed);
    const resolved = path.resolve(trimmed);

    let isDirectory = trailingSep;
    if (!isDirectory) {
      try {
        const st = await fs.stat(resolved);
        if (st.isDirectory()) {
          isDirectory = true;
        }
      } catch {
        // Does not exist yet; treat as file path unless it has a trailing separator
      }
    }

    const extMap: Record<string, ExportFormat> = {
      '.ogg': 'ogg',
      '.wav': 'wav',
      '.mp3': 'mp3',
    };

    let format: ExportFormat;
    let targetPath: string;

    if (isDirectory) {
      format = requestedFormat ?? 'ogg';
      targetPath = resolved;
    } else {
      const ext = path.extname(resolved).toLowerCase();
      if (!ext) {
        format = requestedFormat ?? 'ogg';
        targetPath = `${resolved}.${format}`;
      } else {
        const inferred = extMap[ext];
        if (!inferred) {
          throw new StoreError(
            `Unsupported outputPath extension "${ext}". Must be .ogg, .wav, .mp3, or a directory path.`,
            400,
          );
        }
        if (requestedFormat && requestedFormat !== inferred) {
          throw new StoreError(
            `outputPath extension "${ext}" does not match requested format "${requestedFormat}"`,
            400,
          );
        }
        format = requestedFormat ?? inferred;
        targetPath = resolved;
      }
    }

    if (this.allowedExportDirs && this.allowedExportDirs.length > 0) {
      const withinAllowed = this.allowedExportDirs.some((root) => {
        const rel = path.relative(root, targetPath);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      });
      if (!withinAllowed) {
        throw new StoreError(
          `outputPath "${targetPath}" is outside ALLOWED_EXPORT_DIRS`,
          403,
        );
      }
    }

    return { format, targetPath, isDirectory };
  }

  private async atomicCopyFile(srcPath: string, destPath: string): Promise<void> {
    const dir = path.dirname(destPath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(
      dir,
      `${path.basename(destPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fs.copyFile(srcPath, tmpPath);
      let lastErr: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await fs.rename(tmpPath, destPath);
          return;
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Stage-2 local deterministic mixdown.
   * Always stores the canonical export under DATA_DIR/projects/<id>/exports/,
   * and optionally delivers a ready-to-play copy to `outputPath` (file or directory).
   */
  async mixProject(
    projectId: string,
    options: {
      format?: ExportFormat;
      maxCuesPerBatch?: number;
      outputPath?: string;
      fromCueId?: string;
      toCueId?: string;
      startSec?: number;
      endSec?: number;
    } = {},
  ): Promise<{
    project: Project;
    exportRecord: MixExport;
    telemetry: MixdownTelemetry;
    deliveredPath: string | null;
  }> {
    const projectSnapshot = await this.store.requireProject(projectId);

    // Validate delivery destination BEFORE running FFmpeg so invalid/disallowed paths fail fast
    let delivery: { format: ExportFormat; targetPath: string; isDirectory: boolean } | null = null;
    if (options.outputPath !== undefined) {
      delivery = await this.resolveDeliveryDestination(options.outputPath, options.format);
    }
    const format: ExportFormat = delivery?.format ?? options.format ?? 'ogg';

    const { exportRecord, telemetry } = await runMixdown(projectSnapshot, this.store, {
      format,
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath,
      allowCustomFfmpegFilter: this.allowCustomFfmpegFilter,
      maxCuesPerBatch: options.maxCuesPerBatch,
      fromCueId: options.fromCueId,
      toCueId: options.toCueId,
      startSec: options.startSec,
      endSec: options.endSec,
    });

    let deliveredPath: string | null = null;
    if (delivery) {
      const finalDest = delivery.isDirectory
        ? path.join(delivery.targetPath, `${projectId}_${exportRecord.id}.${exportRecord.format}`)
        : delivery.targetPath;
      const canonicalAbs = this.store.resolveProjectFile(projectId, exportRecord.audioPath);
      await this.atomicCopyFile(canonicalAbs, finalDest);
      deliveredPath = finalDest;
    }

    const project = await this.store.updateProject(projectId, (current) => {
      current.exports.push(exportRecord);
      return current;
    });

    return { project, exportRecord, telemetry, deliveredPath };
  }

  // --- Shared Asset Library (beds & SFX under DATA_DIR/assets/ + external read-only mounts) ---

  async listAssets(): Promise<AssetFileEntry[]> {
    return this.store.listAssets();
  }

  async listAssetMountsSummary(): Promise<AssetMountSummary[]> {
    const indexedCounts = await this.assetIndex.getMountIndexCounts();
    return this.store.getAssetMounts().map((m) => ({
      alias: m.alias,
      readOnly: m.readOnly,
      indexedCount: indexedCounts.has(m.alias) ? indexedCounts.get(m.alias)! : null,
    }));
  }

  async startIndexAssets(
    options: Omit<IndexAssetsOptions, 'onProgress'> = {},
  ): Promise<{
    job: StudioJob;
    done: Promise<{ job: StudioJob; summary: IndexAssetsSummary }>;
  }> {
    const initialJob = this.jobs.create('_assets', 'index_assets', 0);
    const runningJob = this.jobs.update(initialJob.id, { status: 'running' });

    const done = (async () => {
      try {
        const summary = await this.assetIndex.indexAssets({
          ...options,
          onProgress: ({ completed, total }) => {
            this.jobs.update(initialJob.id, { completed, total });
          },
        });
        const finalJob = this.jobs.update(initialJob.id, {
          status: 'completed',
          total: summary.scannedFiles,
          completed: summary.scannedFiles,
          result: summary,
        });
        return { job: finalJob, summary };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.jobs.recordError(initialJob.id, '_assets', message);
        this.jobs.update(initialJob.id, { status: 'failed' });
        throw err;
      }
    })();

    return { job: runningJob, done };
  }

  async indexAssets(
    options: Omit<IndexAssetsOptions, 'onProgress'> = {},
  ): Promise<{ job: StudioJob; summary: IndexAssetsSummary }> {
    const { done } = await this.startIndexAssets(options);
    return done;
  }

  async searchAssets(options: AssetSearchOptions): Promise<AssetSearchResult> {
    return this.assetIndex.searchAssets(options);
  }

  /**
   * Auditions a local or `@alias/...` asset file (or a `[startSec, startSec + maxDurationSec]` slice).
   * Streams directly when untouched and <= 4 MB; otherwise fast-seeks (`-ss` before `-i`),
   * transcodes to compact OGG Opus 96k, and caches the slice under `DATA_DIR/asset_previews/`
   * so inline MCP audio stays well under the 10 MB cap and `previewAudioPath` is always readable on disk.
   */
  async getAssetAudio(options: GetAssetAudioOptions): Promise<AssetAudioPreviewResult> {
    const resolved = await this.store.resolveExistingAssetFile(options.assetPath);
    const probe = await probeAudio(resolved.absPath, this.ffprobePath);
    const st = await fs.stat(resolved.absPath);

    const totalDurationSec = Number((probe.durationMs / 1000).toFixed(3));
    const startSec = Math.max(0, options.startSec ?? 0);
    const maxDurationSec = Math.max(0.1, Math.min(30, options.maxDurationSec ?? 15));

    if (totalDurationSec > 0 && startSec >= totalDurationSec) {
      throw new StoreError(
        `startSec (${startSec}s) exceeds asset duration (${totalDurationSec}s) for "${resolved.canonicalPath}"`,
        400,
      );
    }

    const previewDurationSec = Number(
      Math.max(0, Math.min(maxDurationSec, Math.max(0, totalDurationSec - startSec))).toFixed(3),
    );

    const DIRECT_STREAM_LIMIT_BYTES = 4 * 1024 * 1024;
    const canStreamDirect =
      startSec === 0 &&
      totalDurationSec <= maxDurationSec + 0.05 &&
      st.size <= DIRECT_STREAM_LIMIT_BYTES;

    if (canStreamDirect) {
      const audioBuffer = await fs.readFile(resolved.absPath);
      const ext = path.extname(resolved.absPath).toLowerCase();
      const mimeByExt: Record<string, string> = {
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.mp3': 'audio/mpeg',
        '.flac': 'audio/flac',
        '.m4a': 'audio/mp4',
      };
      return {
        assetPath: resolved.canonicalPath,
        filePath: resolved.absPath,
        previewAudioPath: resolved.absPath,
        mount: resolved.mount,
        readOnly: resolved.readOnly,
        totalDurationSec,
        previewStartSec: 0,
        previewDurationSec: totalDurationSec,
        channels: probe.channels,
        sampleRate: probe.sampleRate,
        sizeBytes: audioBuffer.length,
        mimeType: mimeByExt[ext] ?? 'application/octet-stream',
        transcoded: false,
        audioBuffer,
      };
    }

    const outChannels = Math.min(2, Math.max(1, probe.channels || 1));
    const targetDurationSec = Math.max(0.1, previewDurationSec || maxDurationSec);
    const cacheHash = crypto
      .createHash('sha1')
      .update(
        JSON.stringify({
          canonicalPath: resolved.canonicalPath,
          size: st.size,
          mtimeMs: Math.round(st.mtimeMs),
          startSec: startSec.toFixed(3),
          targetDurationSec: targetDurationSec.toFixed(3),
          outChannels,
          codec: 'opus_96k_48000',
        }),
      )
      .digest('hex')
      .slice(0, 16);
    const fileId = `aprev_${cacheHash}`;
    const cachedPath = this.store.resolveAssetPreviewPath(fileId, '.ogg');

    try {
      const cachedStat = await fs.stat(cachedPath);
      if (cachedStat.isFile() && cachedStat.size > 0) {
        const audioBuffer = await fs.readFile(cachedPath);
        const previewProbe = await probeAudio(cachedPath, this.ffprobePath).catch(() => null);
        return {
          assetPath: resolved.canonicalPath,
          filePath: resolved.absPath,
          previewAudioPath: cachedPath,
          mount: resolved.mount,
          readOnly: resolved.readOnly,
          totalDurationSec,
          previewStartSec: Number(startSec.toFixed(3)),
          previewDurationSec: previewProbe
            ? Number((previewProbe.durationMs / 1000).toFixed(3))
            : previewDurationSec,
          channels: outChannels,
          sampleRate: 48000,
          sizeBytes: audioBuffer.length,
          mimeType: 'audio/ogg',
          transcoded: true,
          audioBuffer,
        };
      }
    } catch {
      // Cache miss: generate sliced preview below
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thebooth-audition-'));
    try {
      const outPath = path.join(tempDir, 'preview.ogg');
      const args = ['-hide_banner', '-y'];
      if (startSec > 0) {
        args.push('-ss', startSec.toFixed(3));
      }
      args.push(
        '-i',
        resolved.absPath,
        '-t',
        targetDurationSec.toFixed(3),
        '-c:a',
        'libopus',
        '-b:a',
        '96k',
        '-vbr',
        'on',
        '-ar',
        '48000',
        '-ac',
        String(outChannels),
        outPath,
      );
      await runCommand(this.ffmpegPath, args);
      const audioBuffer = await fs.readFile(outPath);
      const previewAudioPath = await this.store.writeAssetPreview(fileId, audioBuffer, '.ogg');
      const previewProbe = await probeAudio(previewAudioPath, this.ffprobePath).catch(() => null);
      return {
        assetPath: resolved.canonicalPath,
        filePath: resolved.absPath,
        previewAudioPath,
        mount: resolved.mount,
        readOnly: resolved.readOnly,
        totalDurationSec,
        previewStartSec: Number(startSec.toFixed(3)),
        previewDurationSec: previewProbe
          ? Number((previewProbe.durationMs / 1000).toFixed(3))
          : previewDurationSec,
        channels: outChannels,
        sampleRate: 48000,
        sizeBytes: audioBuffer.length,
        mimeType: 'audio/ogg',
        transcoded: true,
        audioBuffer,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async uploadAsset(input: {
    assetPath: string;
    buffer: Buffer;
  }): Promise<UploadedAssetInfo> {
    this.store.assertWritableAssetPath(input.assetPath);
    if (!input.buffer || input.buffer.length === 0) {
      throw new StoreError('Uploaded asset audio buffer is empty', 400);
    }
    const ext = this.store.assertValidAssetExtension(input.assetPath);
    // Validate sandbox path before touching disk
    this.store.resolveAssetPath(input.assetPath);

    // Probe in a temp file so corrupt/non-audio files never enter DATA_DIR/assets/
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thebooth-asset-'));
    try {
      const tempFile = path.join(tempDir, `probe${ext}`);
      await fs.writeFile(tempFile, input.buffer);
      let probe;
      try {
        probe = await probeAudio(tempFile, this.ffprobePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new StoreError(`Invalid or unreadable audio asset: ${msg}`, 400);
      }

      const storedPath = await this.store.writeAssetFile(
        input.assetPath,
        input.buffer,
      );
      return {
        path: storedPath,
        sizeBytes: input.buffer.length,
        durationMs: probe.durationMs,
        sampleRate: probe.sampleRate,
        channels: probe.channels,
        codecName: probe.codecName,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async deleteAsset(assetPath: string): Promise<void> {
    await this.store.deleteAssetFile(assetPath);
  }

  // --- Voice Catalog, Voice Design & Auditioning (Milestone 4) ---

  async listProviderVoices(
    providerName?: string,
    filter?: ListVoicesFilter,
  ): Promise<{ provider: string; voices: ProviderVoiceEntry[]; nextPageToken?: string }> {
    const name = providerName ?? this.defaultProvider;
    const provider = this.getProvider(name);
    if (!provider.listVoices) {
      return { provider: name, voices: [] };
    }
    const result = await provider.listVoices(filter);
    return {
      provider: name,
      voices: result.voices,
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    };
  }

  async designVoice(
    input: DesignVoiceRequest & { provider?: string },
  ): Promise<{ voice: DesignedVoiceSummary; sampleWavBuffer?: Buffer }> {
    const providerName = input.provider ?? this.defaultProvider;
    const provider = this.getProvider(providerName);
    if (!provider.designVoice) {
      throw new StoreError(
        `TTS provider "${providerName}" does not support voice design`,
        400,
      );
    }
    const designed = await provider.designVoice({
      displayName: input.displayName,
      prompt: input.prompt,
      description: input.description,
      gender: input.gender,
      languageCode: input.languageCode,
      regionCode: input.regionCode,
      accent: input.accent,
      pitch: input.pitch,
      persona: input.persona,
      context: input.context,
      baseVoice: input.baseVoice,
      store: input.store,
      model: input.model,
    });

    let previewAudioPath: string | undefined;
    let previewSizeBytes: number | undefined;
    if (designed.sampleWavBuffer) {
      validateWavBuffer(designed.sampleWavBuffer);
      previewAudioPath = await this.store.writeVoicePreviewWav(
        designed.voiceId,
        designed.sampleWavBuffer,
      );
      previewSizeBytes = designed.sampleWavBuffer.length;
    }

    const voice: DesignedVoiceSummary = {
      voiceId: designed.voiceId,
      displayName: designed.displayName,
      provider: designed.provider,
      model: designed.model,
      ...(designed.type ? { type: designed.type } : {}),
      ...(designed.gender ? { gender: designed.gender } : {}),
      ...(designed.languageCode ? { languageCode: designed.languageCode } : {}),
      ...(designed.regionCode ? { regionCode: designed.regionCode } : {}),
      ...(designed.accent ? { accent: designed.accent } : {}),
      ...(designed.pitch ? { pitch: designed.pitch } : {}),
      ...(designed.persona ? { persona: designed.persona } : {}),
      ...(designed.context ? { context: designed.context } : {}),
      ...(designed.description ? { description: designed.description } : {}),
      ...(designed.prompt ? { prompt: designed.prompt } : {}),
      ...(designed.baseVoice ? { baseVoice: designed.baseVoice } : {}),
      ...(designed.expireTime ? { expireTime: designed.expireTime } : {}),
      ...(previewAudioPath ? { previewAudioPath, previewSizeBytes } : {}),
    };

    return {
      voice,
      ...(designed.sampleWavBuffer ? { sampleWavBuffer: designed.sampleWavBuffer } : {}),
    };
  }

  async getProviderVoice(
    voiceId: string,
    providerName?: string,
  ): Promise<{ voice: ProviderVoiceSummary; sampleWavBuffer?: Buffer }> {
    const name = providerName ?? this.defaultProvider;
    const provider = this.getProvider(name);
    if (!provider.getVoice) {
      throw new StoreError(
        `TTS provider "${name}" does not support inspecting custom voices`,
        400,
      );
    }
    const details = await provider.getVoice(voiceId);
    let previewAudioPath: string | undefined;
    let previewSizeBytes: number | undefined;
    if (details.sampleWavBuffer) {
      validateWavBuffer(details.sampleWavBuffer);
      previewAudioPath = await this.store.writeVoicePreviewWav(
        details.id,
        details.sampleWavBuffer,
      );
      previewSizeBytes = details.sampleWavBuffer.length;
    }

    const { sampleWavBuffer, ...rest } = details;
    const voice: ProviderVoiceSummary = {
      ...rest,
      ...(previewAudioPath ? { previewAudioPath, previewSizeBytes } : {}),
    };
    return {
      voice,
      ...(sampleWavBuffer ? { sampleWavBuffer } : {}),
    };
  }

  async getVoicePreviewAudioFile(
    voiceId: string,
    providerName?: string,
  ): Promise<{ filePath: string; voiceId: string }> {
    const cleanId = voiceId.startsWith('voices/') ? voiceId.slice('voices/'.length) : voiceId;
    const cachedPath = this.store.resolveVoicePreviewPath(cleanId);
    try {
      await fs.access(cachedPath);
      return { filePath: cachedPath, voiceId: cleanId };
    } catch {
      // Cache miss: attempt to retrieve sample_audio from provider.getVoice()
    }

    const name = providerName ?? this.defaultProvider;
    const provider = this.getProvider(name);
    if (!provider.getVoice) {
      throw new StoreError(`Voice preview not found for "${cleanId}"`, 404);
    }
    const { voice } = await this.getProviderVoice(cleanId, name);
    if (!voice.previewAudioPath) {
      throw new StoreError(
        `No preview sample_audio available for voice "${cleanId}"`,
        404,
      );
    }
    return { filePath: voice.previewAudioPath, voiceId: voice.id };
  }

  async deleteProviderVoice(
    voiceId: string,
    providerName?: string,
  ): Promise<{ deleted: boolean; provider: string; voiceId: string }> {
    const name = providerName ?? this.defaultProvider;
    const provider = this.getProvider(name);
    if (!provider.deleteVoice) {
      throw new StoreError(
        `TTS provider "${name}" does not support deleting custom voices`,
        400,
      );
    }
    const res = await provider.deleteVoice(voiceId);
    await this.store.deleteVoicePreviewWav(res.voiceId);
    return {
      deleted: res.deleted,
      provider: name,
      voiceId: res.voiceId,
    };
  }

  async auditionVoice(
    projectId: string,
    voiceId: string,
    input: AuditionVoiceInput,
  ): Promise<{
    voice: VoiceProfile;
    auditions: VoiceAudition[];
    reel?: ComparisonReelSummary;
  }> {
    if (!input.candidateVoiceIds || input.candidateVoiceIds.length === 0) {
      throw new StoreError('At least one candidateVoiceId is required', 400);
    }
    const snapshot = await this.store.requireProject(projectId);
    const existingVoice = snapshot.voices[voiceId];
    const providerName =
      input.provider ?? existingVoice?.provider ?? this.defaultProvider;
    const provider = this.getProvider(providerName);

    const createdAuditions: VoiceAudition[] = [];
    for (let i = 0; i < input.candidateVoiceIds.length; i++) {
      const candidateVoiceId = input.candidateVoiceIds[i]!;
      const synth = await provider.synthesize({
        text: input.sampleText,
        voiceId: candidateVoiceId,
        direction: input.direction ?? existingVoice?.defaultDirection ?? null,
        model: input.model,
      });
      validateWavBuffer(synth.wavBuffer);
      const auditionId = `aud_${crypto.randomBytes(6).toString('hex')}`;
      const audioPath = await this.store.writeAuditionWav(
        projectId,
        auditionId,
        synth.wavBuffer,
      );
      createdAuditions.push({
        id: auditionId,
        label: indexToReelLabel(i),
        providerVoiceId: candidateVoiceId,
        sampleText: input.sampleText,
        audioPath,
        ...(input.notes ? { notes: input.notes } : {}),
        createdAt: new Date().toISOString(),
      });
    }

    const updated = await this.store.updateProject(projectId, (current) => {
      const voice: VoiceProfile = current.voices[voiceId] ?? {
        id: voiceId,
        label: voiceId,
        provider: providerName,
        providerVoiceId: input.candidateVoiceIds[0]!,
      };
      voice.auditions = [...(voice.auditions ?? []), ...createdAuditions];
      current.voices[voiceId] = voice;
      return current;
    });

    const shouldRenderReel =
      input.renderReel === true ||
      (input.renderReel !== false && createdAuditions.length >= 2);
    let reel: ComparisonReelSummary | undefined;
    if (shouldRenderReel) {
      reel = await this.renderAuditionReel(projectId, voiceId, {
        auditionIds: createdAuditions.map((a) => a.id),
        format: input.reelFormat,
        outputPath: input.reelOutputPath,
      });
    }

    return {
      voice: updated.voices[voiceId]!,
      auditions: createdAuditions,
      ...(reel ? { reel } : {}),
    };
  }

  /**
   * Renders a single loudness-matched, labeled A/B casting reel ("A", "B", ...)
   * from a role's audition clips, with optional direct delivery to `outputPath`.
   */
  async renderAuditionReel(
    projectId: string,
    voiceId: string,
    options: {
      auditionIds?: string[];
      format?: ExportFormat;
      outputPath?: string;
    } = {},
  ): Promise<ComparisonReelSummary> {
    const project = await this.store.requireProject(projectId);
    const voice = project.voices[voiceId];
    if (!voice) {
      throw new StoreError(`Voice not found: ${voiceId}`, 404);
    }
    const allAuditions = voice.auditions ?? [];
    if (allAuditions.length === 0) {
      throw new StoreError(`Voice "${voiceId}" has no auditions yet`, 400);
    }

    let selected: VoiceAudition[];
    if (options.auditionIds && options.auditionIds.length > 0) {
      selected = options.auditionIds.map((id) => {
        const found = allAuditions.find((a) => a.id === id);
        if (!found) {
          throw new StoreError(`Audition "${id}" not found on voice "${voiceId}"`, 404);
        }
        return found;
      });
    } else {
      selected = allAuditions;
    }

    let delivery: { format: ExportFormat; targetPath: string; isDirectory: boolean } | null = null;
    if (options.outputPath !== undefined) {
      delivery = await this.resolveDeliveryDestination(options.outputPath, options.format);
    }
    const format: ExportFormat = delivery?.format ?? options.format ?? 'ogg';

    const reelId = `audreel_${voiceId}_${crypto.randomBytes(4).toString('hex')}`;
    const reelPath = path.join(this.store.reelsDir(projectId), `${reelId}.${format}`);

    const rendered = await renderComparisonReel({
      entries: selected.map((a, idx) => ({
        label: a.label ?? indexToReelLabel(idx),
        id: a.id,
        audioPath: this.store.resolveProjectFile(projectId, a.audioPath),
        meta: {
          auditionId: a.id,
          providerVoiceId: a.providerVoiceId,
          sampleText: a.sampleText,
        },
      })),
      outputPath: reelPath,
      format,
      targetLufs: project.audio.workingTakeLufs,
      sampleRate: project.audio.sampleRate,
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath,
    });

    let deliveredPath: string | null = null;
    if (delivery) {
      const finalDest = delivery.isDirectory
        ? path.join(delivery.targetPath, `${projectId}_${reelId}.${format}`)
        : delivery.targetPath;
      await this.atomicCopyFile(reelPath, finalDest);
      deliveredPath = finalDest;
    }

    return {
      reelPath,
      deliveredPath,
      format: rendered.format,
      durationSec: rendered.durationSec,
      entries: rendered.entries,
    };
  }

  /**
   * "Play both takes in context": renders a loudness-matched labeled A/B stereo comparison reel
   * playing surrounding context cues (e.g. Dracula's lead-in) + Take A, followed by a gentle
   * studio separator and the same exchange with Take B.
   */
  async renderTakeComparisonReel(
    projectId: string,
    cueId: string,
    options: {
      takeIds?: string[];
      contextBeforeCues?: number;
      contextAfterCues?: number;
      format?: ExportFormat;
      outputPath?: string;
    } = {},
  ): Promise<ComparisonReelSummary & { cueId: string; contextCueIds: string[] }> {
    const project = await this.store.requireProject(projectId);
    const cueIdx = project.cues.findIndex((c) => c.id === cueId);
    if (cueIdx === -1) {
      throw new StoreError(`Cue not found: ${cueId}`, 404);
    }
    const targetCue = project.cues[cueIdx]!;
    if (targetCue.takes.length === 0) {
      throw new StoreError(`Cue "${cueId}" has no rendered takes to compare`, 400);
    }

    let chosenTakes: Take[];
    if (options.takeIds && options.takeIds.length > 0) {
      chosenTakes = options.takeIds.map((tid) => {
        const found = targetCue.takes.find((t) => t.id === tid);
        if (!found) {
          throw new StoreError(`Take "${tid}" not found on cue "${cueId}"`, 404);
        }
        return found;
      });
    } else {
      // Default: compare the two most recent takes (or single take if only one exists)
      chosenTakes = targetCue.takes.slice(-2);
    }

    let delivery: { format: ExportFormat; targetPath: string; isDirectory: boolean } | null = null;
    if (options.outputPath !== undefined) {
      delivery = await this.resolveDeliveryDestination(options.outputPath, options.format);
    }
    const format: ExportFormat = delivery?.format ?? options.format ?? 'ogg';

    const beforeCount = Math.max(0, Math.min(3, Math.floor(options.contextBeforeCues ?? 1)));
    const afterCount = Math.max(0, Math.min(2, Math.floor(options.contextAfterCues ?? 0)));
    const sliceStart = Math.max(0, cueIdx - beforeCount);
    const sliceEnd = Math.min(project.cues.length - 1, cueIdx + afterCount);
    const windowCues = project.cues.slice(sliceStart, sliceEnd + 1);
    const windowCueIds = new Set(windowCues.map((c) => c.id));

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'thebooth-ab-'));
    try {
      const tempStore = new ProjectStore(tempRoot);
      await tempStore.ensureDataDirs();
      const tempProjDir = tempStore.projectDir(projectId);
      await fs.mkdir(path.join(tempProjDir, 'takes'), { recursive: true });
      await fs.mkdir(path.join(tempProjDir, 'exports'), { recursive: true });

      // Copy only the raw take WAVs referenced by cues in the context window into tempStore
      const copiedTakePaths = new Set<string>();
      for (const c of windowCues) {
        const takesToCopy = c.id === cueId ? chosenTakes : getActiveTake(c) ? [getActiveTake(c)!] : [];
        for (const t of takesToCopy) {
          if (copiedTakePaths.has(t.audioPath)) continue;
          const src = this.store.resolveProjectFile(projectId, t.audioPath);
          const dst = tempStore.resolveProjectFile(projectId, t.audioPath);
          await fs.mkdir(path.dirname(dst), { recursive: true });
          await fs.copyFile(src, dst);
          copiedTakePaths.add(t.audioPath);
        }
      }

      const variantEntries: Array<{
        label: string;
        id: string;
        audioPath: string;
        meta: Record<string, unknown>;
      }> = [];

      for (let i = 0; i < chosenTakes.length; i++) {
        const take = chosenTakes[i]!;
        const label = indexToReelLabel(i);

        // Clone context window cues; anchor first cue cleanly to t=0 and swap activeTakeId on targetCue
        const clonedCues: Cue[] = windowCues.map((c, wi) => {
          const clonedTiming = { ...c.timing };
          if (wi === 0) {
            clonedTiming.afterCueId = null;
            clonedTiming.offsetMs = 0;
          } else if (
            clonedTiming.afterCueId &&
            !windowCueIds.has(clonedTiming.afterCueId)
          ) {
            clonedTiming.afterCueId = undefined;
          }
          return {
            ...c,
            timing: clonedTiming,
            mix: { ...c.mix },
            activeTakeId: c.id === cueId ? take.id : c.activeTakeId,
            takes: c.takes.map((t) => ({ ...t })),
          };
        });

        const variantProject: Project = {
          ...project,
          audio: {
            ...project.audio,
            // Shorter quiet tail inside individual A/B clips so transitions feel tight
            tailMs: 350,
          },
          cues: clonedCues,
          // Keep synthetic room tone beds cleanly; skip external asset beds if absent in tempStore
          beds: project.beds.filter((b) => b.kind === 'synthetic_room_tone'),
          sfx: [],
          exports: [],
        };

        const { exportRecord } = await runMixdown(variantProject, tempStore, {
          format: 'wav',
          ffmpegPath: this.ffmpegPath,
          ffprobePath: this.ffprobePath,
          allowCustomFfmpegFilter: this.allowCustomFfmpegFilter,
        });

        variantEntries.push({
          label,
          id: take.id,
          audioPath: tempStore.resolveProjectFile(projectId, exportRecord.audioPath),
          meta: {
            takeId: take.id,
            cueId,
            direction: take.direction,
            measuredLufs: take.measuredLufs,
            notes: take.notes ?? null,
          },
        });
      }

      const reelId = `ab_${cueId}_${crypto.randomBytes(4).toString('hex')}`;
      const reelPath = path.join(this.store.reelsDir(projectId), `${reelId}.${format}`);

      const rendered = await renderComparisonReel({
        entries: variantEntries,
        outputPath: reelPath,
        format,
        targetLufs: project.audio.workingTakeLufs,
        sampleRate: project.audio.sampleRate,
        ffmpegPath: this.ffmpegPath,
        ffprobePath: this.ffprobePath,
      });

      let deliveredPath: string | null = null;
      if (delivery) {
        const finalDest = delivery.isDirectory
          ? path.join(delivery.targetPath, `${projectId}_${reelId}.${format}`)
          : delivery.targetPath;
        await this.atomicCopyFile(reelPath, finalDest);
        deliveredPath = finalDest;
      }

      return {
        cueId,
        contextCueIds: windowCues.map((c) => c.id),
        reelPath,
        deliveredPath,
        format: rendered.format,
        durationSec: rendered.durationSec,
        entries: rendered.entries,
      };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async getAuditionAudioFile(
    projectId: string,
    voiceId: string,
    auditionId: string,
  ): Promise<{ filePath: string; audition: VoiceAudition }> {
    const project = await this.store.requireProject(projectId);
    const voice = project.voices[voiceId];
    if (!voice) {
      throw new StoreError(`Voice not found: ${voiceId}`, 404);
    }
    const audition = (voice.auditions ?? []).find((a) => a.id === auditionId);
    if (!audition) {
      throw new StoreError(
        `Audition "${auditionId}" not found on voice "${voiceId}"`,
        404,
      );
    }
    const filePath = this.store.resolveProjectFile(projectId, audition.audioPath);
    return { filePath, audition };
  }

  async selectAudition(
    projectId: string,
    voiceId: string,
    auditionIdOrLabel: string,
  ): Promise<VoiceProfile> {
    const updated = await this.store.updateProject(projectId, (current) => {
      const voice = current.voices[voiceId];
      if (!voice) {
        throw new StoreError(`Voice not found: ${voiceId}`, 404);
      }
      const auditions = voice.auditions ?? [];
      // Support direct audition ID OR friendly A/B label (resolving latest matching label)
      let audition = auditions.find((a) => a.id === auditionIdOrLabel);
      if (!audition) {
        const normLabel = auditionIdOrLabel.trim().toUpperCase();
        for (let i = auditions.length - 1; i >= 0; i--) {
          if ((auditions[i]!.label ?? '').toUpperCase() === normLabel) {
            audition = auditions[i];
            break;
          }
        }
      }
      if (!audition) {
        throw new StoreError(
          `Audition "${auditionIdOrLabel}" not found on voice "${voiceId}"`,
          404,
        );
      }
      voice.providerVoiceId = audition.providerVoiceId;
      return current;
    });
    return updated.voices[voiceId]!;
  }

  // --- Director's Chair (Milestone 4) ---

  listDirectorPersonas(): DirectorPersonaPreset[] {
    return listDirectorPersonas();
  }

  private requireDirector(): DirectorReviewer {
    if (!this.director) {
      throw new StoreError(
        'Director reviewer is not configured on this StudioService instance',
        503,
      );
    }
    return this.director;
  }

  /**
   * Multimodal Director review loop for a single cue with strict per-cue retake cap.
   * Renders an initial take if missing, listens via `DirectorReviewer` (using the
   * requested Director persona), persists feedback to `take.notes`, performs bounded
   * directed retakes on rejection, and guarantees the highest-scoring take stays active.
   */
  async directCue(
    projectId: string,
    cueId: string,
    options: CueDirectOptions = {},
  ): Promise<CueDirectResult> {
    const director = this.requireDirector();
    const maxRetakes = Math.max(0, Math.min(5, Math.floor(options.maxRetakes ?? 2)));
    const allowMixAdjustments = options.allowMixAdjustments !== false;
    const allowTextTagTweaks = options.allowTextTagTweaks === true;
    const resolvedPersona = resolveDirectorPersona(options.persona);

    let project = await this.store.requireProject(projectId);
    let cue = project.cues.find((c) => c.id === cueId);
    if (!cue) {
      throw new StoreError(`Cue not found: ${cueId}`, 404);
    }

    // Ensure an initial take exists (does not count against retake budget)
    if (!cue.activeTakeId || !cue.takes.some((t) => t.id === cue!.activeTakeId)) {
      const rendered = await this.renderTake(projectId, cueId, {
        activate: true,
        model: options.ttsModel,
      });
      project = rendered.project;
      cue = project.cues.find((c) => c.id === cueId)!;
    }

    const attempts: CueDirectAttempt[] = [];
    const previousFeedback: string[] = [];
    let retakesUsed = 0;
    let bestScore = -1;
    let bestTakeId = cue.activeTakeId!;
    let approved = false;

    for (let attempt = 0; attempt <= maxRetakes; attempt++) {
      project = await this.store.requireProject(projectId);
      cue = project.cues.find((c) => c.id === cueId)!;
      const take = cue.takes.find((t) => t.id === cue!.activeTakeId)!;
      const wavAbsPath = this.store.resolveProjectFile(projectId, take.audioPath);
      const wavBuffer = await fs.readFile(wavAbsPath);
      const voiceLabel = project.voices[cue.speaker]?.label ?? cue.speaker;

      const verdict = await director.reviewTake({
        projectName: project.name,
        cue,
        take,
        voiceLabel,
        wavBuffer,
        persona: options.persona ?? null,
        extraInstructions: options.extraInstructions ?? null,
        attempt,
        maxRetakes,
        previousFeedback: [...previousFeedback],
      });

      attempts.push({
        attempt,
        takeId: take.id,
        directionUsed: take.direction,
        verdict,
      });
      previousFeedback.push(verdict.feedback);

      if (verdict.score >= bestScore) {
        bestScore = verdict.score;
        bestTakeId = take.id;
      }

      // Persist Director review notes (with timestamped listening moments) onto the reviewed take
      const momentSummary = (verdict.moments ?? [])
        .map((m) => `@${m.timestampSec.toFixed(1)}s${m.phrase ? ` ("${m.phrase}")` : ''}: ${m.note}`)
        .join('; ');
      const notePrefix = `[Director:${resolvedPersona.presetId ?? 'custom'} ${verdict.approved ? 'APPROVED' : 'RETAKE'}]`;
      await this.store.updateProject(projectId, (current) => {
        const targetCue = current.cues.find((c) => c.id === cueId);
        const targetTake = targetCue?.takes.find((t) => t.id === take.id);
        if (targetTake) {
          targetTake.notes = momentSummary
            ? `${notePrefix} ${verdict.feedback} | ${momentSummary}`
            : `${notePrefix} ${verdict.feedback}`;
        }
        if (verdict.approved && targetCue && allowMixAdjustments && verdict.suggestedMixPatch) {
          if (verdict.suggestedMixPatch.gainDb !== undefined) {
            targetCue.mix.gainDb = verdict.suggestedMixPatch.gainDb;
          }
          if (verdict.suggestedMixPatch.eqPreset !== undefined) {
            targetCue.mix.eqPreset = verdict.suggestedMixPatch.eqPreset;
          }
        }
        return current;
      });

      if (verdict.approved) {
        approved = true;
        bestTakeId = take.id;
        bestScore = verdict.score;
        break;
      }

      if (attempt < maxRetakes) {
        // Apply Director's refined delivery cues before re-rolling
        const nextDirection = verdict.suggestedDirection?.trim();
        const nextText =
          allowTextTagTweaks && verdict.suggestedText?.trim()
            ? verdict.suggestedText.trim()
            : undefined;

        if (nextDirection || nextText) {
          await this.updateCue(projectId, cueId, {
            ...(nextDirection ? { direction: nextDirection } : {}),
            ...(nextText ? { text: nextText } : {}),
          });
        }

        await this.renderTake(projectId, cueId, {
          activate: true,
          model: options.ttsModel,
        });
        retakesUsed += 1;
      }
    }

    // If retake cap exhausted without approval, lock in the highest-scoring take
    if (!approved) {
      await this.updateCue(projectId, cueId, { activeTakeId: bestTakeId });
    }

    const selectedAttempt =
      attempts.find((a) => a.takeId === bestTakeId) ?? attempts[attempts.length - 1];
    const firstAttempt = attempts[0];
    const observation = selectedAttempt?.verdict.feedback ?? 'No review attempts recorded.';
    const changes: string[] = [];
    if (retakesUsed > 0) {
      const dirs = attempts
        .map((a) => a.verdict.suggestedDirection?.trim())
        .filter((d): d is string => Boolean(d));
      changes.push(
        dirs.length > 0
          ? `${retakesUsed} retake${retakesUsed === 1 ? '' : 's'} with adjusted direction (${dirs[dirs.length - 1]})`
          : `${retakesUsed} retake${retakesUsed === 1 ? '' : 's'} recorded`,
      );
      if (firstAttempt && firstAttempt.takeId !== bestTakeId) {
        changes.push(`switched active take from ${firstAttempt.takeId} to ${bestTakeId}`);
      } else if (!approved && firstAttempt) {
        changes.push(`kept strongest take ${bestTakeId} after retake budget`);
      }
    } else {
      changes.push(`kept initial take ${bestTakeId}`);
    }
    if (approved && allowMixAdjustments && selectedAttempt?.verdict.suggestedMixPatch) {
      const mp = selectedAttempt.verdict.suggestedMixPatch;
      const parts: string[] = [];
      if (mp.gainDb !== undefined) parts.push(`gainDb=${mp.gainDb}`);
      if (mp.eqPreset !== undefined) parts.push(`eqPreset=${mp.eqPreset}`);
      if (parts.length > 0) changes.push(`applied mix patch (${parts.join(', ')})`);
    }
    const changeSummary = changes.join('; ');

    // Surface timestamped listening moments from the selected attempt (or initial rejection if selected has none)
    const moments =
      (selectedAttempt?.verdict.moments && selectedAttempt.verdict.moments.length > 0
        ? selectedAttempt.verdict.moments
        : firstAttempt?.verdict.moments) ?? [];

    return {
      cueId,
      approved,
      selectedTakeId: bestTakeId,
      observation,
      changeSummary,
      moments,
      retakesUsed,
      personaUsed: resolvedPersona.presetId ?? resolvedPersona.label,
      bestScore,
      attempts,
    };
  }

  /**
   * Starts a bounded Director review job across a project's cues.
   */
  async startDirectProject(
    projectId: string,
    options: ProjectDirectOptions = {},
  ): Promise<{ job: StudioJob; done: Promise<{ job: StudioJob; result: ProjectDirectResult }> }> {
    this.requireDirector();
    const project = await this.store.requireProject(projectId);
    const targetCueIds =
      options.cueIds && options.cueIds.length > 0
        ? options.cueIds
        : project.cues.map((c) => c.id);

    const perCueMax = Math.max(0, Math.min(5, Math.floor(options.maxRetakes ?? 2)));
    const maxTotalRetakes = Math.max(
      0,
      options.maxTotalRetakes ?? targetCueIds.length * perCueMax,
    );
    const resolvedPersona = resolveDirectorPersona(options.persona);

    const initialJob = this.jobs.create(
      projectId,
      'direct_project',
      targetCueIds.length,
    );
    const runningJob = this.jobs.update(initialJob.id, { status: 'running' });

    const done = (async () => {
      const results: CueDirectResult[] = [];
      let totalRetakesUsed = 0;

      for (const cueId of targetCueIds) {
        const remainingBudget = Math.max(0, maxTotalRetakes - totalRetakesUsed);
        const effectiveCap = Math.min(perCueMax, remainingBudget);
        try {
          const cueResult = await this.directCue(projectId, cueId, {
            ...options,
            maxRetakes: effectiveCap,
          });
          results.push(cueResult);
          totalRetakesUsed += cueResult.retakesUsed;
          this.jobs.incrementCompleted(initialJob.id);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.jobs.recordError(initialJob.id, cueId, msg);
        }
      }

      const projectResult: ProjectDirectResult = {
        projectId,
        personaUsed: resolvedPersona.presetId ?? resolvedPersona.label,
        totalCuesReviewed: results.length,
        approvedCount: results.filter((r) => r.approved).length,
        totalRetakesUsed,
        results,
      };

      const latest = this.jobs.get(initialJob.id)!;
      const finalStatus =
        latest.failed > 0 && latest.completed === 0 && targetCueIds.length > 0
          ? 'failed'
          : 'completed';
      const finalJob = this.jobs.update(initialJob.id, {
        status: finalStatus,
        result: projectResult,
      });
      return { job: finalJob, result: projectResult };
    })();

    return { job: runningJob, done };
  }

  async directProject(
    projectId: string,
    options: ProjectDirectOptions = {},
  ): Promise<{ job: StudioJob; result: ProjectDirectResult }> {
    const { done } = await this.startDirectProject(projectId, options);
    return done;
  }
}
