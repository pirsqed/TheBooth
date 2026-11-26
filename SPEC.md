# The Booth — Technical Specification (v0.1)

**The Booth** is a headless, open-source **AI Audio Drama & Spoken-Word Studio** built in TypeScript/Node. It starts as a clean local **REST API** designed 1:1 to be wrapped as an **MCP server** and integrated into MCP-enabled agent platforms.

Most weekend TTS wrappers stitch raw API chunks directly to digital silence. **The Booth** bakes acoustic taste into the engine itself: non-destructive takes, per-cue delivery direction, consistent loudness staging, headphone-friendly stereo panning, negative-offset dialogue overlaps, continuous room tone, and instant local re-mixing without re-spending TTS tokens.

---

## 1. Design Principles & Scope

### Core Architecture: Two-Stage Pipeline
1. **Stage 1 — Synthesis (Paid / Slow / Immutable):**
   - Calls a `TtsProvider` only for cues that are new or explicitly re-rolled.
   - Validates the returned WAV and stores **only the untouched, immutable raw provider WAV** in `cue.takes[]`, alongside read-only loudness telemetry (`durationMs`, `measuredLufs`, `peakDbfs`) recorded in `project.json`. No audio modification or normalization is baked onto disk at ingest.
2. **Stage 2 — Mixdown (Local / Deterministic / Instant):**
   - Reads immutable raw takes and applies non-destructive loudness leveling (`autoLevel`), edge de-click fades, timing offsets (including overlaps), artistic gain trims, stereo pan, EQ presets, sound effects, and ducked background beds via `ffmpeg` in seconds with **zero API cost**.
   - Editing pauses, leveling curves, volume, panning, EQ, background beds, or swapping `activeTakeId` only triggers Stage 2.

### Scope Boundaries
- **In Scope (v0.1):**
  - TypeScript/Node service (Fastify + Zod) with filesystem-backed project storage (human-inspectable JSON + WAV/OGG assets).
  - Provider-agnostic `TtsProvider` interface with **`GeminiTtsProvider`** (`gemini-3.8-flash-tts` via the **Interactions API**, supporting prebuilt/library/custom voices and `speech_metadata.style` annotations) as the reference adapter.
  - Tagged script importer supporting sticky per-cue direction, pauses, overlaps, gain, pan, EQ, SFX, and beds.
  - High-taste `ffmpeg` stereo mixdown engine (room tone floor, loudness discipline, constant-power / headphone-friendly panning, curated EQ presets, bed ducking).
  - REST API with direct audio inspection endpoints so multimodal agents can *listen* to individual takes or full mixes.
- **Deferred (v0.2+):**
  - Thin MCP server wrapper (shares the exact service layer with REST—see Section 7).
  - Voice auditioning & casting workflows (schema slots are reserved in v0.1).
  - Director AI agent orchestration loop (automated multimodal take review with bounded retake budgets).
  - Web UI / timeline editor.

---

## 2. Project Storage Layout

Each project lives in a self-contained directory under `DATA_DIR/projects/<projectId>/` so projects are portable, inspectable, and easy to back up or version:

```text
data/
  assets/                      # Shared reusable beds & SFX (rain, fireplace, foley)
  projects/
    <projectId>/
      project.json             # Canonical manifest (atomic temp-file + rename writes)
      takes/
        <takeId>.wav           # Immutable raw validated provider output (flat layout for textHash reuse)
      exports/
        <exportId>.ogg         # Rendered stereo master (Opus / WAV / MP3)
        <exportId>.json        # Render telemetry (duration, integrated LUFS, true peak, warnings)
```

---

## 3. Core Data Model

### 3.1 `Project`
```ts
export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;

  /** Master DSP settings */
  audio: {
    sampleRate: 48000;          // Internal DSP rate (all stems resampled cleanly during Stage-2 mix)
    channels: 2;                // Always stereo master
    autoLevel: 'gentle' | 'match' | 'off'; // Default: "gentle" (non-destructive Stage-2 loudness leveling)
    workingTakeLufs: -20;       // Stage-2 reference loudness for autoLevel
    masterNormalize: boolean;   // Default: false (preserves artistic fade-outs/quiet bedtime mixes)
    masterTargetLufs: number;   // Default: -18 (applied only when masterNormalize is true)
    truePeakCeilingDb: number;  // Default: -1.5 dBTP
    headphoneCrossfeed: boolean;// Default: true (prevents clinical hard-L/R split in headphones)
  };

  /** Cast & voice registry (extensible for v0.2+ voice auditioning) */
  voices: Record<string, VoiceProfile>;

  /** Ordered timeline cues (narration, meditation, dialogue) */
  cues: Cue[];

  /** Continuous ambient layers (room tone, rain, music beds) */
  beds: BedTrack[];

  /** Spot sound effects anchored to cues or absolute timestamps */
  sfx: SfxEvent[];

  /** History of rendered masters */
  exports: MixExport[];
}
```

### 3.2 `VoiceProfile`
```ts
export interface VoiceProfile {
  id: string;                   // Logical speaker key, e.g. "mara", "narrator", "lina"
  label: string;                // Display name
  provider: string;             // e.g. "gemini"
  providerVoiceId: string;      // e.g. "voice_abc123def456" or "Kore"
  defaultDirection?: string;    // Fallback style metadata if cue.direction is omitted
  defaultEqPreset?: EqPreset;   // Default: "neutral"
  defaultPan?: number;          // Optional stage blocking (-1.0..+1.0), default 0
  notes?: string;               // Casting notes for human/director use
  /** Reserved for v0.2+ auditioning */
  auditions?: Array<{
    id: string;
    providerVoiceId: string;
    sampleText: string;
    audioPath: string;
    notes?: string;
    createdAt: string;
  }>;
}
```

### 3.3 `Cue` & `Take`
```ts
export type EqPreset =
  | 'neutral'   // Clean 70 Hz HPF only
  | 'intimate'  // Warm close-mic proximity lift + gentle de-harsh + soft air
  | 'whisper'   // Velvety low-pass rolloff + gentle compression/de-ess
  | 'phone'     // 300–3400 Hz narrowband telephone filter
  | 'radio'     // Band-limited comms + subtle grit
  | 'distant';  // High-frequency rolloff + gentle attenuation

export interface Cue {
  id: string;
  speaker: string;              // Key in project.voices
  text: string;                 // Exact spoken text (may include provider vocal tags like <sigh>)
  direction?: string | null;    // Per-cue style metadata; overrides voice.defaultDirection

  /** Relative timeline placement */
  timing: {
    /**
     * Cue ID this cue follows.
     * - undefined / omitted: follows the immediately preceding cue in project.cues (or t=0 if first)
     * - null: anchored directly to t=0
     * - string: anchored to the END of the referenced cue
     */
    afterCueId?: string | null;
    /**
     * Milliseconds relative to anchor end:
     * - positive: pause / meditation silence (e.g. +30000 for 30s)
     * - 0: natural beat
     * - negative: dialogue overlap / interruption (e.g. -400)
     */
    offsetMs: number;
  };

  /** Artistic mix overrides applied in Stage 2 (on top of immutable raw take + autoLevel) */
  mix: {
    autoLevel?: 'gentle' | 'match' | 'off'; // Optional per-cue override of project.audio.autoLevel
    gainDb: number;             // Default: 0 (range -24..+12)
    pan: number;                // Default: voice.defaultPan ?? 0 (range -1.0 left .. +1.0 right)
    eqPreset: EqPreset;         // Default: voice.defaultEqPreset ?? "neutral"
    fadeInMs: number;           // Default: 20 (micro de-click; increase for dreamy entry)
    fadeOutMs: number;          // Default: 30
    customFfmpegFilter?: string;// Optional advanced power-user filter (validated/opt-in)
  };

  activeTakeId: string | null;
  takes: Take[];
}

export interface Take {
  id: string;
  provider: string;
  model: string;
  providerVoiceId: string;
  direction: string | null;
  textHash: string;             // SHA-256 of (text + direction + providerVoiceId) for staleness detection
  audioPath: string;            // Immutable raw validated provider WAV (takes/<takeId>.wav)
  durationMs: number;
  measuredLufs: number | null;  // Read-only Stage-1 ebur128 integrated loudness (null if sub-second/-inf)
  measuredRmsDbfs: number;      // Read-only Stage-1 RMS fallback for sub-second clips/sighs
  peakDbfs: number;             // Read-only Stage-1 sample/true peak of raw WAV
  createdAt: string;
  notes?: string;               // Director / human feedback on this take
}
```

### 3.4 `BedTrack` & `SfxEvent`
```ts
export interface BedTrack {
  id: string;
  label: string;
  kind: 'synthetic_room_tone' | 'asset_file';
  /** For synthetic_room_tone */
  roomToneStyle?: 'warm_dark' | 'soft_pink';
  /** For asset_file */
  assetPath?: string;
  gainDb: number;               // e.g. -54 for room tone, -24 for gentle rain
  loop: boolean;                // Default: true
  startMs?: number;             // Default: 0
  endMs?: number | null;        // Default: null (full project duration + tail)
  fadeInMs: number;             // Default: 1500
  fadeOutMs: number;            // Default: 3000
  ducking: {
    enabled: boolean;           // Default: true for asset_file, false for room tone
    amountDb: number;           // e.g. -6 dB under speech
    attackMs: number;           // Default: 100
    releaseMs: number;          // Default: 800
  };
}

export interface SfxEvent {
  id: string;
  label: string;
  assetPath: string;
  anchor: {
    cueId?: string | null;      // null = absolute t=0
    edge: 'start' | 'end';      // Relative to cue start or cue end
    offsetMs: number;           // Can be negative (pre-lap) or positive
  };
  gainDb: number;               // Default: -6
  pan: number;                  // Default: 0
  fadeInMs: number;             // Default: 15
  fadeOutMs: number;            // Default: 40
}
```

---

## 4. Acoustic Taste Rules (Non-Negotiable Defaults)

These rules exist specifically to eliminate the jarring artifacts common to stitched TTS audio:

1. **No Digital Vacuum (Default Room Tone):**
   - New projects automatically include a subtle `synthetic_room_tone` bed (`warm_dark`, filtered brown/pink noise shaped below ~3 kHz at `-54 dBFS`) unless the user disables it or supplies an ambient bed (`rain`, etc.).
   - Pauses (`offsetMs > 0`) never cut to `-inf dBFS` dead silence, eliminating the headphone "unplugged" sensation.
2. **Immutable Raw Takes + Non-Destructive Mixdown Leveling:**
   - **Stage 1 (Measure Only):** Every take is saved untouched as its raw validated WAV (`takes/<takeId>.wav`) and measured once via `ffmpeg` (`ebur128` for `measuredLufs`—stored as `null` if sub-second/`-inf`—plus `measuredRmsDbfs` and `peakDbfs`). Baking hard normalization into disk files is forbidden—it destroys dynamics and can accidentally crank an intentional `-29 LUFS` whisper up by `+9 dB` into harsh breath hiss.
   - **Stage 2 (Non-Destructive `autoLevel`):** During mixdown, linear `volume` gain leveling is computed dynamically from `take.measuredLufs` (falling back to `take.measuredRmsDbfs` when `measuredLufs` is `null` or `durationMs < 800`, with a conservative boost cap so short sighs/breaths never jump-scare the listener) against `project.audio.workingTakeLufs` (`-20 LUFS`):
     - `gentle` *(default)*: Pulls `50%` of the delta toward `workingTakeLufs`, clamped to `[-6 dB, +4 dB]` (tames jarring API loudness spikes across pauses while preserving delicate whispers and expressive dynamics).
     - `match`: Full pull toward `workingTakeLufs`, clamped to `[-12 dB, +12 dB]` (ideal for consistent narration/audiobooks).
     - `off`: `0 dB` leveling correction (uses raw provider loudness directly).
   - **Calibrated Master Bus & Optional Master Normalization:** `cue.mix.gainDb` is summed cleanly on top of the `autoLevel` gain—so tapering a bedtime script down to `[[gain:-6dB]]` produces a genuinely softer whisper arc. By default (`masterNormalize: false`), Stage 2 uses calibrated gain staging + a gentle true-peak limiter (`alimiter`, ceiling `-1.5 dBTP`) so overlapping cues (`offsetMs < 0`) and SFX never clip without lifting intentional quiet fade-outs back up. When `masterNormalize: true`, an explicit master loudness pass targets `masterTargetLufs` (`-18`). In both modes, integrated LUFS and true peak are always measured and recorded in `<exportId>.json`.
3. **Edge De-Clicking & Breath-Safe Padding:**
   - Do not aggressively gate or strip leading/trailing silence (which clips soft consonants and inhales). Apply gentle cosine fades (`fadeInMs: 20`, `fadeOutMs: 30` by default) to every cue stem so boundaries are seamless.
4. **Headphone-Friendly Stereo Panning:**
   - Use **constant-power panning** (`L = cos(theta)`, `R = sin(theta)` where `theta = (pan + 1) * pi / 4`) so centered and panned voices keep equal perceived volume.
   - When `audio.headphoneCrossfeed` is `true`, non-zero pans blend a subtle opposite-ear acoustic crossfeed (`~12–18%` level, `~0.25–0.45 ms` interaural delay, gentle `4 kHz` head-shadow low-pass). Leaning to `pan: -0.7` feels naturally close to the left ear instead of unnaturally isolated in one headphone driver.
5. **Smooth Speech-Triggered Bed Ducking:**
   - Build a unified speech bus first, then use it as the sidechain trigger (`sidechaincompress` or smooth envelope follower) for ducking-enabled beds (`attackMs ~ 100`, `releaseMs ~ 800`), so rain or ambience blooms softly during pauses and tucks underneath speech without pumping.
6. **Cycle-Free Timeline Resolution & Windows/Scale `ffmpeg` Hygiene:**
   - Before mixing, resolve every cue's `(startMs, endMs)` via topological check on `timing.afterCueId`. Reject cyclic dependencies with `400 Bad Request`. Clamp resolved `startMs >= 0`.
   - Always append a configurable quiet tail (default `2000 ms`) after the final cue/SFX so the room tone/bed fades out gracefully.
   - Always write complex filtergraphs to a temporary file and invoke `ffmpeg` via `-filter_complex_script` (avoiding Windows command-line length limits on 80–150+ cue sleep scripts).
   - Always pass `normalize=0:dropout_transition=0` to `amix` so adding cues never attenuates bus volume or causes gain-step clicks. For large cue counts (e.g. `>32` cues), batch speech stems cleanly into intermediate bus sums or sequential groups to keep file handles and memory bounded.

---

## 5. Script Markup Importer

To keep authoring effortless for both humans and LLMs, `POST /projects/:id/import-script` parses plain text containing **sticky directives** into structured cues, SFX, and beds.

### Syntax
- **Backward-compatible pause:** `[[pause:20]]` → sets `offsetMs: 20000` on the *next* cue.
- **Dialogue overlap:** `[[overlap:350]]` → sets `offsetMs: -350` on the *next* cue.
- **Sticky delivery direction:** `[[dir:softer, slower, barely above a whisper]]` → applies to subsequent cues until changed (`[[dir:reset]]` reverts to voice default).
- **Sticky mix controls:**
  - `[[gain:-4dB]]` (or `[[gain:0]]`)
  - `[[pan:-0.6]]` (also accepts `left` = `-0.65`, `right` = `0.65`, `center` = `0`, `hard-left` = `-0.9`, `hard-right` = `0.9`)
  - `[[eq:intimate]]` (`neutral | intimate | whisper | phone | radio | distant`)
- **Speaker switching:**
  - Either `[[voice:mara]]` (sticky) or screenplay-style prefix `MARA: Goodnight, everyone.` (matches case-insensitive voice ID/label when registered).
- **Beds & SFX:**
  - `[[bed:rain_window gain=-24dB duck=-6dB]]`
  - `[[sfx:sheets_rustle gain=-12dB pan=0.3 offset=-200ms]]` — supports `anchor=prev` *(default: anchors to the end of the previous cue, or `t=0` if first)* or `anchor=next` *(anchors to the start of the upcoming cue—great for pre-laps like `[[sfx:sheets_rustle anchor=next offset=-500ms]]` right before a voice returns after a long pause)*.
- **Take Preservation on Re-Import (`mode: 'replace'`):** Because raw takes live flat at `takes/<takeId>.wav` and record `textHash = SHA-256(text + direction + providerVoiceId)`, re-importing an edited script in `replace` mode preserves and re-attaches matching takes by `textHash` (keeping their `activeTakeId` when matched) so fixing a typo or pause never wastes TTS spend on unchanged cues.
- **Provider inline vocal tags preserved verbatim:** Angle-bracket cues like `<sigh>`, `<chuckle>`, `<short pause>` are never stripped and never bisected if a long monologue is auto-split (default chunk limit `6000` UTF-8 bytes at paragraph/sentence boundaries).

### Example Script
```text
[[voice:mara]]
[[bed:rain_window gain=-26dB duck=-6dB]]
[[dir:warm, unhurried, gentle, intimate]]
[[eq:intimate]]

Take a slow breath. <short pause> Tonight, let everything settle.

[[pause:8]]
[[pan:-0.55]]
[[dir:closer, softer, barely above a whisper]]
[[gain:-3dB]]

Let your shoulders drop all the way into the mattress.

[[pause:25]]
[[pan:0.55]]
[[gain:-5dB]]

Rest easy. <sigh> Goodnight.
```

---

## 6. TTS Provider Interface (`TtsProvider`)

```ts
export interface SynthesizeRequest {
  text: string;
  voiceId: string;
  direction?: string | null;
  model?: string;
}

export interface SynthesizeResult {
  wavBuffer: Buffer;            // Validated RIFF/WAVE PCM
  sampleRate: number;
  channels: number;
  provider: string;
  model: string;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(req: SynthesizeRequest): Promise<SynthesizeResult>;
  listVoices?(): Promise<Array<{ id: string; label: string }>>;
}
```

### Reference Adapter: `GeminiTtsProvider` (v0.1 — Interactions API)
- Uses `@google/genai` (`>= 3.5.0`) initialized with `httpOptions: { apiVersion: 'v1beta' }` (required for Gemini 3.8 TTS and `/v1beta/voices`), calling `client.interactions.create(...)` with default model `gemini-3.8-flash-tts` (overrideable per request/env, e.g., `gemini-3.8-flash-lite-tts`).
- Sends each cue as a structured `user_input` text content item (`input: [{ type: 'user_input', content: [{ type: 'text', text, annotations }] }]`) and passes `direction` strictly via a `speech_metadata` annotation (`{ type: 'speech_metadata', style }`, omitted when `direction` is empty/null)—never concatenated into spoken text.
- Passes `voiceId` via `generation_config: { speech_config: [{ voice: voiceId }] }` (supporting prebuilt studio voices like `Kore`, Extended Voice Library IDs, designed/remixed `voice_...` IDs, and replicated `voice_...` / `voicekey_...` IDs). Synthesizing cues individually also avoids the single-request multi-speaker limit (2 prebuilt voices only).
- Sets `response_format: { type: 'audio' }` (unary default returns complete 24 kHz, 16-bit signed LE mono `audio/wav` with RIFF header), `store: false` for stateless take rendering (no unnecessary server-side retention), and configurable `safety_settings` (lowercase `harassment`, `hate_speech`, `sexually_explicit`, `dangerous_content` set to `'block_none'`/`'off'` for creative/mature audio drama, configurable via env).
- Decodes `interaction.output_audio.data` (base64) and validates RIFF/WAV framing (or wraps verified `audio/l16` 16-bit LE PCM cleanly) so truncated or malformed audio can never be saved as a valid take.
- Handles retryable transient errors with bounded backoff; surfaces HTTP `400` safety blocks (`error.code`) and token-limit errors (`8,192` input / `16,384` output tokens) cleanly.
- Reference docs: `docs/gemini-tts.md` and `docs/gemini-interactions-api.md`.

---

## 7. REST API Surface (v0.1) & 1:1 MCP Mapping

All endpoints accept and return JSON (except audio streaming routes). Business logic lives in `src/studio/` service functions so REST routes and future MCP tool handlers are both thin wrappers over the same core.

| REST Endpoint | Purpose | Future MCP Tool |
|---|---|---|
| `POST /projects` | Create project (initializes default room tone + audio settings) | `booth_create_project` |
| `GET /projects` | List projects (summary metadata) | `booth_list_projects` |
| `GET /projects/:id` | Fetch full project manifest + resolved timeline timestamps | `booth_get_project` |
| `PATCH /projects/:id` | Update project name or master audio settings | `booth_update_project` |
| `PUT /projects/:id/voices/:voiceId` | Register or update a voice profile | `booth_upsert_voice` |
| `POST /projects/:id/import-script` | Parse tagged script into cues/beds/sfx (`mode: 'replace' \| 'append'`) | `booth_import_script` |
| `POST /projects/:id/cues` | Insert a single cue | `booth_add_cue` |
| `PATCH /projects/:id/cues/:cueId` | Edit text, direction, timing (`offsetMs`, `afterCueId`), mix (`gainDb`, `pan`, `eqPreset`), or `activeTakeId` | `booth_update_cue` |
| `DELETE /projects/:id/cues/:cueId` | Delete a cue (safely re-anchoring dependent cues if needed) | `booth_delete_cue` |
| `POST /projects/:id/cues/:cueId/render` | Synthesize a new take for one cue (auto-sets `activeTakeId` unless `activate: false`) | `booth_render_take` |
| `POST /projects/:id/render-all` | Async job: synthesize all cues missing an active take (or stale `textHash`); returns `jobId` | `booth_render_all` |
| `GET /jobs/:jobId` | Poll progress/errors for async render or mix jobs | `booth_job_status` |
| `GET /projects/:id/cues/:cueId/takes/:takeId/audio` | Stream immutable raw WAV of a single take for ear review | `booth_get_take_audio` |
| `PUT /projects/:id/beds/:bedId` / `DELETE ...` | Add, update, or remove a room-tone / ambient bed track | `booth_upsert_bed` |
| `PUT /projects/:id/sfx/:sfxId` / `DELETE ...` | Add, update, or remove an anchored SFX event | `booth_upsert_sfx` |
| `POST /projects/:id/mix` | Run Stage-2 local mixdown (`format: 'ogg' \| 'wav' \| 'mp3'`), returning export ID + loudness telemetry | `booth_mix` |
| `GET /projects/:id/exports/:exportId/audio` | Stream or download the finished master audio | `booth_get_export_audio` |

### Concurrency & Safety Notes
- Serialize mutations to `project.json` per project ID (in-process mutex + atomic write-temp-and-rename) so concurrent renders never corrupt the manifest.
- `render-all` supports bounded concurrency (default `2` concurrent TTS calls) and resumability: completed takes are already persisted on disk.
- Keep `sfx` and `beds` asset paths strictly sandboxed under `DATA_DIR/assets/` (no path traversal).

---

## 8. Suggested Repo Structure

```text
TheBooth/
  SPEC.md
  docs/
    gemini-tts.md              # Gemini 3.8 TTS reference, prompting guide, Voices API
    gemini-interactions-api.md # General Interactions API reference & schema notes
  package.json
  tsconfig.json
  .env.example                 # GEMINI_API_KEY, DATA_DIR, PORT, FFMPEG_PATH
  src/
    index.ts                   # Server entrypoint
    config.ts                  # Env validation (Zod)
    types/
      project.ts               # Core schemas & Zod validators
    providers/
      interface.ts             # TtsProvider contract
      gemini.ts                # Gemini 3.8 Flash TTS adapter
      mock.ts                  # Deterministic sine/speech-burst test provider (zero API cost in tests!)
    audio/
      ffmpeg.ts                # Subprocess runner, ffprobe, duration & ebur128 measurement
      leveling.ts              # Stage-2 non-destructive autoLevel gain calculation (gentle/match/off)
      roomtone.ts              # Synthetic warm_dark / soft_pink room tone generator
      eq.ts                    # Curated EQ preset filter builders
      pan.ts                   # Constant-power + headphone crossfeed filter builder
      mixdown.ts               # Stage-2 timeline resolver + ffmpeg complex filtergraph mixer
    script/
      parser.ts                # Tagged script -> cues / beds / sfx compiler
    studio/
      store.ts                 # Atomic per-project JSON store + mutex
      jobs.ts                  # In-memory/disk-backed async job tracker
      service.ts               # Pure studio operations (shared by REST now, MCP in v0.2)
    api/
      server.ts                # Fastify app + error handling
      routes.ts                # Thin REST bindings to studio/service.ts
  tests/
    parser.test.ts             # Sticky directives, overlaps, vocal-tag preservation
    timeline.test.ts           # Positive/negative offsets, cycle detection
    mixdown.test.ts            # End-to-end mix with MockTtsProvider + ffprobe/LUFS assertions
    api.test.ts                # Full REST lifecycle integration tests
```

---

## 9. Implementation Milestones

- **Milestone 1 (Core Engine + Mock Tests):** Project store, Zod schemas, script parser, timeline resolver, `MockTtsProvider`, and Stage-1/Stage-2 `ffmpeg` pipeline verified by automated `ffprobe` + LUFS + stereo-balance tests (no API key required to run `npm test`).
- **Milestone 2 (Gemini Adapter + REST API):** `GeminiTtsProvider` wired up, full Fastify REST surface, async `render-all` jobs, and real headphone listening test on a multi-section PMR + stereo whisper script.
- **Milestone 3 (v0.2 MCP Server & Asset Library):** Thin `@modelcontextprotocol/sdk` wrapper over `src/studio/service.ts`, plus asset upload/library listing.
- **Milestone 4 (v0.3 Director's Chair):** Voice auditioning endpoints + multimodal Director review loop with strict per-cue retake caps.
  - *Empirical Multimodal Note (v0.1 blind stereo test):* Gemini 4's multimodal audio input downmixes stereo to mono before perception, so a Director AI cannot directly distinguish Left vs. Right panning from a standard stereo master alone. For Milestone 4 Director review, pair per-channel RMS telemetry (`channelRmsDbfs`) with optional split Left-only / Right-only mono export stems so the Director can still audit spatial blocking accurately.
