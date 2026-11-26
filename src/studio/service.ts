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
import { measureAudioLoudness, probeAudio } from '../audio/ffmpeg.js';
import { MixdownTelemetry, runMixdown } from '../audio/mixdown.js';
import { ResolvedTimeline, resolveTimeline } from '../audio/timeline.js';
import {
  RenderVisualResult,
  VisualCueBlock,
  VisualMode,
  VisualPanel,
  VisualPreset,
  VisualValidationError,
  renderAudioVisual,
} from '../audio/visualize.js';
import { parseScript } from '../script/parser.js';
import { JobTracker, StudioJob } from './jobs.js';
import { AssetFileEntry, ProjectStore, StoreError } from './store.js';

export interface StudioServiceOptions {
  store: ProjectStore;
  providers: Record<string, TtsProvider>;
  defaultProvider?: string;
  director?: DirectorReviewer;
  ffmpegPath?: string;
  ffprobePath?: string;
  allowCustomFfmpegFilter?: boolean;
  jobs?: JobTracker;
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
  private readonly providers: Record<string, TtsProvider>;
  private readonly defaultProvider: string;
  private readonly director?: DirectorReviewer;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly allowCustomFfmpegFilter: boolean;

  constructor(options: StudioServiceOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.defaultProvider =
      options.defaultProvider ?? Object.keys(options.providers)[0] ?? 'mock';
    this.director = options.director;
    this.ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
    this.ffprobePath = options.ffprobePath ?? 'ffprobe';
    this.allowCustomFfmpegFilter = options.allowCustomFfmpegFilter ?? false;
    this.jobs = options.jobs ?? new JobTracker();
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

      current.cues.splice(idx, 1);
      resolveTimeline(current);
      return current;
    });
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
    let targetSlug: string;
    let titlePrefix: string;
    let summaryTelemetry: Record<string, unknown>;

    if (input.target.type === 'asset') {
      audioPath = this.store.resolveAssetPath(input.target.assetPath);
      try {
        await fs.access(audioPath);
      } catch {
        throw new StoreError(`Asset not found: ${input.target.assetPath}`, 404);
      }
      targetSlug = `asset_${crypto
        .createHash('sha1')
        .update(input.target.assetPath)
        .digest('hex')
        .slice(0, 10)}`;
      titlePrefix = `Asset ${input.target.assetPath}`;
      summaryTelemetry = { targetType: 'asset', assetPath: input.target.assetPath };
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
        const timeline = resolveTimeline(project);
        cueBlocks = timeline.cues.map((rc) => {
          const cueObj = project.cues.find((c) => c.id === rc.cueId);
          return {
            id: rc.cueId,
            speaker: rc.speaker,
            startSec: rc.startMs / 1000,
            endSec: rc.endMs / 1000,
            plannedPan: cueObj?.mix.pan ?? 0,
            gainDb: cueObj?.mix.gainDb ?? 0,
          };
        });
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
        title: `${titlePrefix} | ${spanTag} (${preset})`,
      });
    } catch (err: unknown) {
      if (err instanceof VisualValidationError) {
        throw new StoreError(err.message, err.statusCode);
      }
      throw err;
    }

    // Add cues visible inside the rendered window for quick reference
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

  /**
   * Stage-2 local deterministic mixdown.
   */
  async mixProject(
    projectId: string,
    options: { format?: ExportFormat; maxCuesPerBatch?: number } = {},
  ): Promise<{ project: Project; exportRecord: MixExport; telemetry: MixdownTelemetry }> {
    const projectSnapshot = await this.store.requireProject(projectId);
    const { exportRecord, telemetry } = await runMixdown(projectSnapshot, this.store, {
      format: options.format ?? 'ogg',
      ffmpegPath: this.ffmpegPath,
      ffprobePath: this.ffprobePath,
      allowCustomFfmpegFilter: this.allowCustomFfmpegFilter,
      maxCuesPerBatch: options.maxCuesPerBatch,
    });

    const project = await this.store.updateProject(projectId, (current) => {
      current.exports.push(exportRecord);
      return current;
    });

    return { project, exportRecord, telemetry };
  }

  // --- Shared Asset Library (beds & SFX under DATA_DIR/assets/) ---

  async listAssets(): Promise<AssetFileEntry[]> {
    return this.store.listAssets();
  }

  async uploadAsset(input: {
    assetPath: string;
    buffer: Buffer;
  }): Promise<UploadedAssetInfo> {
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
  ): Promise<{ voice: VoiceProfile; auditions: VoiceAudition[] }> {
    if (!input.candidateVoiceIds || input.candidateVoiceIds.length === 0) {
      throw new StoreError('At least one candidateVoiceId is required', 400);
    }
    const snapshot = await this.store.requireProject(projectId);
    const existingVoice = snapshot.voices[voiceId];
    const providerName =
      input.provider ?? existingVoice?.provider ?? this.defaultProvider;
    const provider = this.getProvider(providerName);

    const createdAuditions: VoiceAudition[] = [];
    for (const candidateVoiceId of input.candidateVoiceIds) {
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

    return {
      voice: updated.voices[voiceId]!,
      auditions: createdAuditions,
    };
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
    auditionId: string,
  ): Promise<VoiceProfile> {
    const updated = await this.store.updateProject(projectId, (current) => {
      const voice = current.voices[voiceId];
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

      // Persist Director review notes onto the reviewed take
      const notePrefix = `[Director:${resolvedPersona.presetId ?? 'custom'} score=${verdict.score}/10 ${verdict.approved ? 'APPROVED' : 'RETAKE'}]`;
      await this.store.updateProject(projectId, (current) => {
        const targetCue = current.cues.find((c) => c.id === cueId);
        const targetTake = targetCue?.takes.find((t) => t.id === take.id);
        if (targetTake) {
          targetTake.notes = `${notePrefix} ${verdict.feedback}`;
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

    return {
      cueId,
      approved,
      selectedTakeId: bestTakeId,
      bestScore,
      retakesUsed,
      personaUsed: resolvedPersona.presetId ?? resolvedPersona.label,
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
