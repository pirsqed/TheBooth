import { Cue, Project, SfxEvent, Take } from '../types/project.js';

export class TimelineError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'TimelineError';
  }
}

export interface ResolvedCueTiming {
  cueId: string;
  speaker: string;
  anchorCueId: string | null;
  offsetMs: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  activeTakeId: string | null;
  hasActiveTake: boolean;
}

export interface ResolvedSfxTiming {
  sfxId: string;
  label: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface ResolvedTimeline {
  cues: ResolvedCueTiming[];
  sfx: ResolvedSfxTiming[];
  contentEndMs: number;
  tailMs: number;
  totalDurationMs: number;
  warnings: string[];
}

export function getActiveTake(cue: Cue): Take | null {
  if (!cue.activeTakeId) return null;
  return cue.takes.find((t) => t.id === cue.activeTakeId) ?? null;
}

/**
 * Resolves every cue and SFX event to concrete (startMs, endMs) timestamps
 * via topological dependency resolution, rejecting cycles and missing anchors.
 */
export function resolveTimeline(
  project: Pick<Project, 'cues' | 'sfx' | 'audio'>,
  sfxDurationsMs: Record<string, number> = {},
): ResolvedTimeline {
  const warnings: string[] = [];
  const cueMap = new Map<string, Cue>();
  const cueIndexMap = new Map<string, number>();

  for (let i = 0; i < project.cues.length; i++) {
    const cue = project.cues[i]!;
    if (cueMap.has(cue.id)) {
      throw new TimelineError(`Duplicate cue ID: ${cue.id}`);
    }
    cueMap.set(cue.id, cue);
    cueIndexMap.set(cue.id, i);
  }

  // Determine effective anchor cue ID for each cue
  const anchorOf = new Map<string, string | null>();
  for (let i = 0; i < project.cues.length; i++) {
    const cue = project.cues[i]!;
    const rawAnchor = cue.timing.afterCueId;
    if (rawAnchor === undefined) {
      anchorOf.set(cue.id, i > 0 ? project.cues[i - 1]!.id : null);
    } else if (rawAnchor === null) {
      anchorOf.set(cue.id, null);
    } else {
      if (!cueMap.has(rawAnchor)) {
        throw new TimelineError(
          `Cue "${cue.id}" references unknown afterCueId "${rawAnchor}"`,
        );
      }
      anchorOf.set(cue.id, rawAnchor);
    }
  }

  // 3-color DFS cycle detection + topological evaluation
  const state = new Map<string, 'visiting' | 'visited'>();
  const resolvedMap = new Map<string, ResolvedCueTiming>();

  const visit = (cueId: string, stack: string[]): ResolvedCueTiming => {
    const existing = resolvedMap.get(cueId);
    if (existing) return existing;

    if (state.get(cueId) === 'visiting') {
      const cycleStart = stack.indexOf(cueId);
      const cyclePath = [...stack.slice(cycleStart), cueId].join(' -> ');
      throw new TimelineError(`Cyclic cue timing dependency detected: ${cyclePath}`);
    }

    state.set(cueId, 'visiting');
    const cue = cueMap.get(cueId)!;
    const anchorCueId = anchorOf.get(cueId) ?? null;

    let anchorEndMs = 0;
    if (anchorCueId !== null) {
      const anchorResolved = visit(anchorCueId, [...stack, cueId]);
      anchorEndMs = anchorResolved.endMs;
    }

    const activeTake = getActiveTake(cue);
    const durationMs = activeTake ? Math.max(0, Math.round(activeTake.durationMs)) : 0;

    const rawStartMs = anchorEndMs + cue.timing.offsetMs;
    const startMs = Math.max(0, Math.round(rawStartMs));
    if (rawStartMs < 0) {
      warnings.push(
        `Cue "${cue.id}" resolved to ${rawStartMs} ms and was clamped to 0 ms.`,
      );
    }
    const endMs = startMs + durationMs;

    const resolved: ResolvedCueTiming = {
      cueId: cue.id,
      speaker: cue.speaker,
      anchorCueId,
      offsetMs: cue.timing.offsetMs,
      startMs,
      endMs,
      durationMs,
      activeTakeId: activeTake?.id ?? null,
      hasActiveTake: activeTake !== null,
    };

    state.set(cueId, 'visited');
    resolvedMap.set(cueId, resolved);
    return resolved;
  };

  for (const cue of project.cues) {
    visit(cue.id, []);
  }

  const resolvedCues = project.cues.map((c) => resolvedMap.get(c.id)!);

  // Resolve SFX events
  const resolvedSfx: ResolvedSfxTiming[] = project.sfx.map((evt: SfxEvent) => {
    let anchorTimeMs = 0;
    if (evt.anchor.cueId != null) {
      const anchorCue = resolvedMap.get(evt.anchor.cueId);
      if (!anchorCue) {
        throw new TimelineError(
          `SFX "${evt.id}" references unknown cueId "${evt.anchor.cueId}"`,
        );
      }
      anchorTimeMs =
        evt.anchor.edge === 'start' ? anchorCue.startMs : anchorCue.endMs;
    }

    const rawStartMs = anchorTimeMs + evt.anchor.offsetMs;
    const startMs = Math.max(0, Math.round(rawStartMs));
    if (rawStartMs < 0) {
      warnings.push(
        `SFX "${evt.id}" resolved to ${rawStartMs} ms and was clamped to 0 ms.`,
      );
    }
    const durationMs = Math.max(0, Math.round(sfxDurationsMs[evt.id] ?? 0));
    return {
      sfxId: evt.id,
      label: evt.label,
      startMs,
      endMs: startMs + durationMs,
      durationMs,
    };
  });

  const contentEndMs = Math.max(
    0,
    ...resolvedCues.map((c) => c.endMs),
    ...resolvedSfx.map((s) => s.endMs),
  );
  const tailMs = project.audio.tailMs ?? 2000;
  const totalDurationMs = contentEndMs + tailMs;

  return {
    cues: resolvedCues,
    sfx: resolvedSfx,
    contentEndMs,
    tailMs,
    totalDurationMs,
    warnings,
  };
}
