import * as crypto from 'node:crypto';
import {
  AutoLevelMode,
  AutoLevelModeSchema,
  BedTrack,
  Cue,
  EqPreset,
  EqPresetSchema,
  RoomToneStyleSchema,
  SfxEvent,
  VoiceProfile,
} from '../types/project.js';

export class ScriptParseError extends Error {
  constructor(
    message: string,
    public readonly lineNumber?: number,
    public readonly statusCode: number = 400,
  ) {
    super(lineNumber ? `Line ${lineNumber}: ${message}` : message);
    this.name = 'ScriptParseError';
  }
}

export interface ParseScriptOptions {
  /** Registered voices for screenplay-style `SPEAKER: text` matching & defaults */
  voices?: Record<string, VoiceProfile>;
  /** Fallback speaker ID when no [[voice:...]] or screenplay prefix has appeared yet */
  defaultSpeaker?: string;
  /** Maximum UTF-8 bytes per auto-split cue chunk (default 6000) */
  maxChunkBytes?: number;
  /** Deterministic ID prefix/factory for testing */
  idFactory?: (prefix: 'cue' | 'bed' | 'sfx', index: number) => string;
}

export interface ParsedScript {
  cues: Cue[];
  beds: BedTrack[];
  sfx: SfxEvent[];
  warnings: string[];
}

const PAN_PRESETS: Record<string, number> = {
  center: 0,
  left: -0.65,
  right: 0.65,
  'hard-left': -0.9,
  'hard-right': 0.9,
};

function defaultIdFactory(prefix: 'cue' | 'bed' | 'sfx', index: number): string {
  const rand = crypto.randomBytes(3).toString('hex');
  return `${prefix}_${String(index).padStart(3, '0')}_${rand}`;
}

function parsePanValue(raw: string, lineNumber: number): number {
  const normalized = raw.trim().toLowerCase();
  if (normalized in PAN_PRESETS) {
    return PAN_PRESETS[normalized]!;
  }
  const num = Number(normalized);
  if (!Number.isFinite(num) || num < -1 || num > 1) {
    throw new ScriptParseError(
      `Invalid pan value "${raw}" (expected -1.0..+1.0 or left|right|center|hard-left|hard-right)`,
      lineNumber,
    );
  }
  return num;
}

function parseGainDb(raw: string, lineNumber: number, min = -24, max = 12): number {
  const match = raw.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*(?:db)?$/i);
  if (!match) {
    throw new ScriptParseError(`Invalid gain value "${raw}"`, lineNumber);
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ScriptParseError(
      `Gain ${value} dB out of range [${min}, ${max}]`,
      lineNumber,
    );
  }
  return value;
}

function parseDurationMs(
  raw: string,
  defaultUnit: 's' | 'ms',
  lineNumber: number,
): number {
  const match = raw.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*(ms|s)?$/i);
  if (!match) {
    throw new ScriptParseError(`Invalid duration "${raw}"`, lineNumber);
  }
  const num = Number(match[1]);
  const unit = (match[2]?.toLowerCase() ?? defaultUnit) as 's' | 'ms';
  if (!Number.isFinite(num)) {
    throw new ScriptParseError(`Invalid duration "${raw}"`, lineNumber);
  }
  return Math.round(unit === 's' ? num * 1000 : num);
}

function parseKeyValueArgs(rawArgs: string): Record<string, string> {
  const result: Record<string, string> = {};
  const tokenRegex = /([a-zA-Z_][a-zA-Z0-9_-]*)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(rawArgs)) !== null) {
    const key = match[1]!.toLowerCase();
    const val = match[3] ?? match[4] ?? match[5] ?? '';
    result[key] = val;
  }
  return result;
}

/**
 * Parses a directive target (unquoted token or single/double-quoted path supporting spaces)
 * followed by optional key=value arguments.
 */
function parseTargetAndArgs(
  value: string,
  directiveLabel: string,
  lineNumber: number,
): { target: string; rawArgs: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ScriptParseError(`[[${directiveLabel}:...]] requires an asset name`, lineNumber);
  }
  const match = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(.*))?$/);
  if (!match) {
    throw new ScriptParseError(
      `Invalid target in [[${directiveLabel}:...]]`,
      lineNumber,
    );
  }
  const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  if (!target) {
    throw new ScriptParseError(`[[${directiveLabel}:...]] requires an asset name`, lineNumber);
  }
  return { target, rawArgs: match[4] ?? '' };
}

/**
 * Splits long text into chunks <= maxBytes UTF-8 without ever bisecting
 * inline angle-bracket tags like `<sigh>` or `<short pause>`.
 */
export function splitTextSafely(text: string, maxBytes = 6000): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) {
    return [trimmed];
  }

  // Tokenize into indivisible segments: either an <inline tag> or normal text
  // Then split normal text at sentence boundaries, falling back to word boundaries.
  const sentences: string[] = [];
  let current = '';
  let inTag = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    current += ch;
    if (ch === '<') {
      inTag = true;
    } else if (ch === '>') {
      inTag = false;
    } else if (!inTag && (ch === '.' || ch === '!' || ch === '?')) {
      const next = trimmed[i + 1];
      if (!next || /\s/.test(next)) {
        sentences.push(current.trim());
        current = '';
      }
    }
  }
  if (current.trim()) {
    sentences.push(current.trim());
  }

  // Further break any single sentence that still exceeds maxBytes at whitespace outside <...>
  const atoms: string[] = [];
  for (const sentence of sentences) {
    if (Buffer.byteLength(sentence, 'utf8') <= maxBytes) {
      atoms.push(sentence);
      continue;
    }
    const words: string[] = [];
    let token = '';
    let insideAngle = false;
    for (let i = 0; i < sentence.length; i++) {
      const ch = sentence[i]!;
      if (ch === '<') {
        insideAngle = true;
        token += ch;
      } else if (ch === '>') {
        insideAngle = false;
        token += ch;
      } else if (!insideAngle && /\s/.test(ch)) {
        if (token) {
          words.push(token);
          token = '';
        }
      } else {
        token += ch;
      }
    }
    if (token) words.push(token);

    let sub = '';
    for (const word of words) {
      const candidate = sub ? `${sub} ${word}` : word;
      if (sub && Buffer.byteLength(candidate, 'utf8') > maxBytes) {
        atoms.push(sub);
        sub = word;
      } else {
        sub = candidate;
      }
    }
    if (sub) atoms.push(sub);
  }

  const chunks: string[] = [];
  let acc = '';
  for (const atom of atoms) {
    const candidate = acc ? `${acc} ${atom}` : atom;
    if (acc && Buffer.byteLength(candidate, 'utf8') > maxBytes) {
      chunks.push(acc);
      acc = atom;
    } else {
      acc = candidate;
    }
  }
  if (acc) chunks.push(acc);

  return chunks;
}

interface PendingSfxNext {
  event: SfxEvent;
  lineNumber: number;
}

export function parseScript(
  script: string,
  options: ParseScriptOptions = {},
): ParsedScript {
  const voices = options.voices ?? {};
  const maxChunkBytes = options.maxChunkBytes ?? 6000;
  const makeId = options.idFactory ?? defaultIdFactory;

  // Build case-insensitive lookup for voice IDs and labels
  const voiceLookup = new Map<string, VoiceProfile>();
  for (const [id, profile] of Object.entries(voices)) {
    voiceLookup.set(id.toLowerCase(), profile);
    voiceLookup.set(profile.label.toLowerCase(), profile);
  }

  const cues: Cue[] = [];
  const beds: BedTrack[] = [];
  const sfx: SfxEvent[] = [];
  const warnings: string[] = [];

  let cueCounter = 0;
  let bedCounter = 0;
  let sfxCounter = 0;

  // Sticky state
  let currentSpeaker =
    options.defaultSpeaker ?? Object.keys(voices)[0] ?? 'narrator';
  let stickyDir: string | null | undefined = undefined; // undefined = inherit voice default
  let stickyGainDb = 0;
  let stickyPan: number | undefined = undefined; // undefined = inherit voice default
  let stickyEq: EqPreset | undefined = undefined; // undefined = inherit voice default
  let stickyAutoLevel: AutoLevelMode | undefined = undefined;

  // Next-cue state
  let pendingOffsetMs = 0;
  const pendingNextSfx: PendingSfxNext[] = [];

  // Current text buffer
  let textLines: string[] = [];

  const resolveVoice = (name: string): VoiceProfile | undefined =>
    voiceLookup.get(name.trim().toLowerCase());

  const flushText = () => {
    if (textLines.length === 0) return;
    const rawText = textLines.join(' ').trim();
    textLines = [];
    if (!rawText) return;

    const chunks = splitTextSafely(rawText, maxChunkBytes);
    const voiceProfile = resolveVoice(currentSpeaker);
    const resolvedSpeaker = voiceProfile?.id ?? currentSpeaker;

    chunks.forEach((chunkText, chunkIdx) => {
      cueCounter += 1;
      const cueId = makeId('cue', cueCounter);
      const offsetMs = chunkIdx === 0 ? pendingOffsetMs : 0;
      if (chunkIdx === 0) {
        pendingOffsetMs = 0;
      }

      const direction =
        stickyDir !== undefined
          ? stickyDir
          : voiceProfile?.defaultDirection ?? null;

      const pan = stickyPan !== undefined ? stickyPan : voiceProfile?.defaultPan ?? 0;
      const eqPreset: EqPreset =
        stickyEq !== undefined ? stickyEq : voiceProfile?.defaultEqPreset ?? 'neutral';

      const cue: Cue = {
        id: cueId,
        speaker: resolvedSpeaker,
        text: chunkText,
        direction,
        timing: {
          offsetMs,
        },
        mix: {
          ...(stickyAutoLevel !== undefined ? { autoLevel: stickyAutoLevel } : {}),
          gainDb: stickyGainDb,
          pan,
          eqPreset,
          fadeInMs: 20,
          fadeOutMs: 30,
        },
        activeTakeId: null,
        takes: [],
      };
      cues.push(cue);

      // Attach any pending anchor=next SFX to the first emitted chunk
      if (chunkIdx === 0 && pendingNextSfx.length > 0) {
        for (const item of pendingNextSfx) {
          item.event.anchor.cueId = cue.id;
          item.event.anchor.edge = 'start';
          sfx.push(item.event);
        }
        pendingNextSfx.length = 0;
      }
    });
  };

  const handleDirective = (body: string, lineNumber: number) => {
    const colonIdx = body.indexOf(':');
    if (colonIdx === -1) {
      throw new ScriptParseError(`Malformed directive "[[${body}]]"`, lineNumber);
    }
    const key = body.slice(0, colonIdx).trim().toLowerCase();
    const value = body.slice(colonIdx + 1).trim();

    switch (key) {
      case 'pause': {
        const ms = parseDurationMs(value, 's', lineNumber);
        if (ms < 0) {
          throw new ScriptParseError(
            `[[pause:...]] must be non-negative; use [[overlap:...]] for negative offsets`,
            lineNumber,
          );
        }
        pendingOffsetMs += ms;
        break;
      }
      case 'overlap': {
        const ms = parseDurationMs(value, 'ms', lineNumber);
        if (ms < 0) {
          throw new ScriptParseError(
            `[[overlap:...]] expects a positive millisecond duration (e.g. [[overlap:350]])`,
            lineNumber,
          );
        }
        pendingOffsetMs = -ms;
        break;
      }
      case 'dir': {
        if (!value || value.toLowerCase() === 'reset') {
          stickyDir = undefined;
        } else {
          stickyDir = value;
        }
        break;
      }
      case 'gain': {
        if (value.toLowerCase() === 'reset') {
          stickyGainDb = 0;
        } else {
          stickyGainDb = parseGainDb(value, lineNumber, -24, 12);
        }
        break;
      }
      case 'pan': {
        if (value.toLowerCase() === 'reset') {
          stickyPan = undefined;
        } else {
          stickyPan = parsePanValue(value, lineNumber);
        }
        break;
      }
      case 'eq': {
        if (value.toLowerCase() === 'reset') {
          stickyEq = undefined;
        } else {
          const parsed = EqPresetSchema.safeParse(value.toLowerCase());
          if (!parsed.success) {
            throw new ScriptParseError(
              `Invalid EQ preset "${value}" (expected neutral|intimate|whisper|phone|radio|distant)`,
              lineNumber,
            );
          }
          stickyEq = parsed.data;
        }
        break;
      }
      case 'autolevel': {
        if (value.toLowerCase() === 'reset') {
          stickyAutoLevel = undefined;
        } else {
          const parsed = AutoLevelModeSchema.safeParse(value.toLowerCase());
          if (!parsed.success) {
            throw new ScriptParseError(
              `Invalid autoLevel "${value}" (expected gentle|match|off)`,
              lineNumber,
            );
          }
          stickyAutoLevel = parsed.data;
        }
        break;
      }
      case 'voice': {
        if (!value) {
          throw new ScriptParseError(`[[voice:...]] requires a voice ID`, lineNumber);
        }
        const matched = resolveVoice(value);
        currentSpeaker = matched ? matched.id : value.trim().toLowerCase();
        break;
      }
      case 'bed': {
        const { target, rawArgs } = parseTargetAndArgs(value, 'bed', lineNumber);
        const kv = parseKeyValueArgs(rawArgs);
        bedCounter += 1;
        const bedId = makeId('bed', bedCounter);

        const isRoomTone =
          target.toLowerCase() === 'room_tone' ||
          target.toLowerCase() === 'roomtone';

        const gainDb = kv.gain
          ? parseGainDb(kv.gain, lineNumber, -80, 12)
          : isRoomTone
            ? -54
            : -24;

        let duckEnabled = !isRoomTone;
        let duckAmountDb = isRoomTone ? 0 : -6;
        if (kv.duck !== undefined) {
          if (kv.duck.toLowerCase() === 'off' || kv.duck.toLowerCase() === 'false') {
            duckEnabled = false;
            duckAmountDb = 0;
          } else {
            const parsedDuck = parseGainDb(kv.duck, lineNumber, -24, 0);
            duckEnabled = parsedDuck < 0;
            duckAmountDb = parsedDuck;
          }
        }

        const attackMs = kv.attack
          ? parseDurationMs(kv.attack, 'ms', lineNumber)
          : 100;
        const releaseMs = kv.release
          ? parseDurationMs(kv.release, 'ms', lineNumber)
          : 800;
        const fadeInMs = kv.fadein
          ? parseDurationMs(kv.fadein, 'ms', lineNumber)
          : 1500;
        const fadeOutMs = kv.fadeout
          ? parseDurationMs(kv.fadeout, 'ms', lineNumber)
          : 3000;
        const loop = kv.loop ? kv.loop.toLowerCase() !== 'false' : true;

        let clipStartMs: number | undefined;
        if (kv.clipstart !== undefined) {
          clipStartMs = parseDurationMs(kv.clipstart, 's', lineNumber);
          if (clipStartMs < 0) {
            throw new ScriptParseError(`[[bed:...]] clipStart must be non-negative`, lineNumber);
          }
        }
        let clipDurationMs: number | undefined;
        if (kv.clipdur !== undefined) {
          clipDurationMs = parseDurationMs(kv.clipdur, 's', lineNumber);
          if (clipDurationMs <= 0) {
            throw new ScriptParseError(`[[bed:...]] clipDur must be positive`, lineNumber);
          }
        }

        if (isRoomTone) {
          const styleResult = RoomToneStyleSchema.safeParse(
            (kv.style ?? 'warm_dark').toLowerCase(),
          );
          if (!styleResult.success) {
            throw new ScriptParseError(
              `Invalid room tone style "${kv.style}"`,
              lineNumber,
            );
          }
          beds.push({
            id: bedId,
            label: `Room Tone (${styleResult.data})`,
            kind: 'synthetic_room_tone',
            roomToneStyle: styleResult.data,
            gainDb,
            loop,
            startMs: 0,
            endMs: null,
            fadeInMs,
            fadeOutMs,
            ducking: {
              enabled: duckEnabled,
              amountDb: duckAmountDb,
              attackMs,
              releaseMs,
            },
          });
        } else {
          beds.push({
            id: bedId,
            label: target,
            kind: 'asset_file',
            assetPath: target,
            gainDb,
            loop,
            startMs: 0,
            endMs: null,
            ...(clipStartMs !== undefined ? { clipStartMs } : {}),
            ...(clipDurationMs !== undefined ? { clipDurationMs } : {}),
            fadeInMs,
            fadeOutMs,
            ducking: {
              enabled: duckEnabled,
              amountDb: duckAmountDb,
              attackMs,
              releaseMs,
            },
          });
        }
        break;
      }
      case 'sfx': {
        const { target, rawArgs } = parseTargetAndArgs(value, 'sfx', lineNumber);
        const kv = parseKeyValueArgs(rawArgs);
        sfxCounter += 1;
        const sfxId = makeId('sfx', sfxCounter);

        const gainDb = kv.gain ? parseGainDb(kv.gain, lineNumber, -48, 12) : -6;
        const pan = kv.pan ? parsePanValue(kv.pan, lineNumber) : 0;
        const offsetMs = kv.offset
          ? parseDurationMs(kv.offset, 'ms', lineNumber)
          : 0;
        const fadeInMs = kv.fadein
          ? parseDurationMs(kv.fadein, 'ms', lineNumber)
          : 15;
        const fadeOutMs = kv.fadeout
          ? parseDurationMs(kv.fadeout, 'ms', lineNumber)
          : 40;
        const anchorMode = (kv.anchor ?? 'prev').toLowerCase();

        let clipStartMs: number | undefined;
        if (kv.clipstart !== undefined) {
          clipStartMs = parseDurationMs(kv.clipstart, 's', lineNumber);
          if (clipStartMs < 0) {
            throw new ScriptParseError(`[[sfx:...]] clipStart must be non-negative`, lineNumber);
          }
        }
        let clipDurationMs: number | undefined;
        if (kv.clipdur !== undefined) {
          clipDurationMs = parseDurationMs(kv.clipdur, 's', lineNumber);
          if (clipDurationMs <= 0) {
            throw new ScriptParseError(`[[sfx:...]] clipDur must be positive`, lineNumber);
          }
        }

        if (anchorMode !== 'prev' && anchorMode !== 'next') {
          throw new ScriptParseError(
            `Invalid SFX anchor "${anchorMode}" (expected prev or next)`,
            lineNumber,
          );
        }

        if (anchorMode === 'next') {
          pendingNextSfx.push({
            lineNumber,
            event: {
              id: sfxId,
              label: target,
              assetPath: target,
              anchor: {
                cueId: null, // populated when next cue is emitted
                edge: 'start',
                offsetMs,
              },
              gainDb,
              pan,
              ...(clipStartMs !== undefined ? { clipStartMs } : {}),
              ...(clipDurationMs !== undefined ? { clipDurationMs } : {}),
              fadeInMs,
              fadeOutMs,
            },
          });
        } else {
          const prevCue = cues[cues.length - 1];
          sfx.push({
            id: sfxId,
            label: target,
            assetPath: target,
            anchor: {
              cueId: prevCue ? prevCue.id : null,
              edge: prevCue ? 'end' : 'start',
              offsetMs,
            },
            gainDb,
            pan,
            ...(clipStartMs !== undefined ? { clipStartMs } : {}),
            ...(clipDurationMs !== undefined ? { clipDurationMs } : {}),
            fadeInMs,
            fadeOutMs,
          });
        }
        break;
      }
      default:
        throw new ScriptParseError(`Unknown directive "[[${key}:...]]"`, lineNumber);
    }
  };

  const lines = script.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    if (!trimmed) {
      flushText();
      continue;
    }

    // Check if the line consists exclusively of one or more [[...]] directives
    const directiveOnlyCheck = trimmed.replace(/\[\[[^\]]+\]\]/g, '').trim();
    if (directiveOnlyCheck === '' && trimmed.includes('[[')) {
      flushText();
      const dirRegex = /\[\[([^\]]+)\]\]/g;
      let match: RegExpExecArray | null;
      while ((match = dirRegex.exec(trimmed)) !== null) {
        handleDirective(match[1]!, lineNumber);
      }
      continue;
    }

    // Check screenplay-style speaker prefix: `SPEAKER: Spoken line...`
    // Matches registered voice IDs or labels case-insensitively.
    const speakerMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9 _-]{0,40}):\s*(.*)$/);
    if (speakerMatch) {
      const candidate = speakerMatch[1]!.trim();
      const matchedVoice = resolveVoice(candidate);
      if (matchedVoice) {
        flushText();
        currentSpeaker = matchedVoice.id;
        const remainder = speakerMatch[2]!.trim();
        if (remainder) {
          textLines.push(remainder);
        }
        continue;
      }
    }

    textLines.push(trimmed);
  }

  flushText();

  // Handle any trailing anchor=next SFX that had no following cue
  for (const dangling of pendingNextSfx) {
    const lastCue = cues[cues.length - 1];
    dangling.event.anchor.cueId = lastCue ? lastCue.id : null;
    dangling.event.anchor.edge = lastCue ? 'end' : 'start';
    sfx.push(dangling.event);
    warnings.push(
      `Line ${dangling.lineNumber}: SFX "${dangling.event.label}" used anchor=next with no following cue; anchored to ${lastCue ? `end of ${lastCue.id}` : 't=0'} instead.`,
    );
  }

  return { cues, beds, sfx, warnings };
}
