# The Booth — v0.2 Roadmap

This roadmap translates the empirical lessons from our first full-hour stress test—**[Case Study & Post-Mortem: *Dracula (1938)*](./case-study-dracula-1938.md)** (59m 30s, 12 bespoke voices, 288 cues, 28 beds, 65 SFX)—plus cross-host MCP testing into a concrete, phased v0.2 plan.

---

## Strategic Principles for v0.2

1. **Markdown for Freeform Creative Memory; Engine for Enforceable Primitives:** A plain-Markdown Director's Bible survived 288 cues and context compaction cleanly. The Booth does *not* need a heavy built-in note-taking CMS—engineering effort belongs in structured, enforceable studio primitives (`sceneId`, `defaultGainDb`, async `booth_mix`, Pronunciation Lexicon, Soundscape Presets).
2. **Counter "Momentum Bias" with Workflow & Tooling Forcing Functions:** Clean baseline synthesis makes Take-1 acceptance feel effortless, which masks weak acting, tonal misses, and subtle misreads during 60-minute runs. v0.2 pairs stronger skill rules (**Hero-Line A/B Rule**) with low-friction multi-take A/B and seam-reel tooling so high taste scales with runtime.
3. **The Next Sonic Frontier Is Balance, Space & Intimacy:** Timing, stereo pan, ducking, and broadcast loudness are proven at feature length (`-20.3 LUFS`, `0.21 dB` L/R symmetry). The biggest audible upgrades for v0.2 are **voice-level loudness calibration**, **acoustic space (convolution reverb)**, and **whisper-honest leveling**.
4. **Host-Agnostic Local File Paths Are a Core Contract:** Long-form context budgets and MCP clients that strip inline media both depend on every audio/visual tool returning durable local file paths (`filePath`, `previewAudioPath`, `reelPath`, `imagePath`) alongside `inlineAudio: false` / `inlineImage: false`.

---

## Phase v0.2a — Scale, Mix Performance & Long-Form Ergonomics

*Goal: Eliminate every friction point and timeout hit during hour-long productions.*

### 1. Mixdown Engine Speedup + Async `booth_mix`
- **Fix the `O(N × totalDuration)` mixdown bottleneck (`src/audio/mixdown.ts`):**
  - Render each speech cue batch only over its own compact `[batchMinStartMs, batchMaxEndMs]` window (cutting ~12 GB of mostly-silent float32 WAV scratch I/O down to a fraction) and run cue batches with bounded parallelism.
  - Consolidate spot SFX into a compact `sfx_bus` instead of padding 1-second foley clips to 60 minutes.
  - Group beds by ducking profile or slice sidechain streams to each bed's active window instead of running dozens of full-hour `sidechaincompress` filters.
- **Async `booth_mix` (`wait: false` + `jobId`):** Mirror `booth_render_all` using the existing `JobTracker` (`'mix'` is already defined in `JobKind`) and `booth_job_status`, eliminating MCP client tool timeouts even on 90–120 minute audiobooks.

### 2. First-Class `sceneId` Grouping & Lightweight Cue Queries
- Add optional `sceneId` to `Cue` and a sticky `[[scene:<id>]]` directive in script markup (`src/script/parser.ts`).
- Allow `booth_mix(sceneId: "scene_2")` directly without manually looking up `fromCueId`/`toCueId`.
- Add `booth_list_cues` with `summaryOnly: true` and optional filters (`sceneId`, `speaker`, `unrenderedOnly`) so agents working on 200+ cue projects never have to parse massive `booth_get_project` payloads or write throwaway lookup scripts.

### 3. Transition & Seam QC Reel Helper (`booth_render_seam_reel`)
- Automatically clip and stitch `±7s` windows around every scene/bed boundary (plus cold open and outro) into one short listening montage, separated by subtle markers.
- Return a structured **seam timestamp map** (`[{ index, label, reelStartSec, reelEndSec, fromCueId, toCueId, boundaryKind }]`) alongside the audio path so any awkward cut, bed drop, or misread maps immediately to exact cue IDs.

### 4. `skills/the-booth/SKILL.md` Long-Form Playbook & Hero-Line A/B Rule
- **Long-Form Production Playbook (100+ Cues):** Codify the proven 4-phase cadence (Read & Bible → Full Ensemble Casting → Scene-by-Scene Production & QC → Full Assembly & Seam Pass).
- **Hero-Line A/B Rule:** Keep single-take efficiency for routine lines, but **mandate 2–3 competing takes** (`booth_render_ab_reel`) on the 2–3 emotional tentpole lines per scene/chapter—backed by a low-friction multi-take helper so agents don't skip retakes out of tool-call drag.
- **Beat-Level Scene Listening & Stage-Tracking Roster:** Remind directors to spot-check quiet/dramatic exchanges (not just scan full 10-minute scenes once) and maintain a quick L/C/R blocking table in dense ensemble scenes so speakers never subtly "teleport."

---

## Phase v0.2b — Sonic Craft, Loudness Balance & Timing Precision

*Goal: Deliver the biggest audible leap in realism, character consistency, and intimate dynamics.*

### 5. Voice-Level Loudness Calibration & Per-Speaker Telemetry
- Add `defaultGainDb` to `VoiceProfile` (`booth_upsert_voice`) so bespoke voices that synthesize intrinsically hotter (`-14.6 LUFS`) or quieter (`-24.4 LUFS`) are calibrated once at casting time rather than trimmed cue-by-cue across hundreds of lines.
- Extend `booth_mix` telemetry with a **per-speaker loudness summary** (`avgLufs`, `minLufs`, `maxLufs`, `minPeakDbfs`, `maxPeakDbfs`) and automatic outlier warnings (e.g., flagging when one speaker sits `> 6 dB` below adjacent dialogue, as happened across Lucy Westenra's scenes).

### 6. Acoustic Space (Convolution Reverb) & Whisper-Honest Leveling
- **Acoustic Space Presets (`space`):** Add curated spatial presets (`dry_intimate`, `wood_room`, `stone_hall`, `exterior_open`, `vintage_radio`) backed by lightweight bundled CC0 48 kHz impulse responses using FFmpeg `afir` convolution—not metallic `aecho`.
  - Route cues sharing a `space` preset through a **shared per-space reverb send bus** (faster in FFmpeg and acoustically truer, since speakers in the same chamber share one room tail).
  - Pad clip tails before trimming so reverb decay rings out naturally past `fadeOutMs`.
- **Whisper-Honest `autoLevel`:** Add a per-cue `targetLufsOffsetDb` (or cut-only `whisper` leveling mode) and audit `eq: "whisper"` makeup gain so genuinely hushed, close-mic whispers stay intimate instead of being pulled up toward `-20 LUFS` conversational loudness—essential for intimate fiction and sleep/PMR tracks.

### 7. Mid-Cue SFX Timing Ergonomics
- Improve spot-SFX placement accuracy beyond blind millisecond offsets from a long cue's `start`/`end` edge:
  - Support cleaner beat-splitting workflows (`booth_split_cue` guidance + optional fractional/progress anchors or lightweight timestamp alignment hints) so foley hits land cleanly on the intended spoken beat.
  - Pair with tighter visual-QC verification on dense foley scenes.

### 8. Project Pronunciation Lexicon (Wired into `textHash`)
- Add a project-level pronunciation map (e.g., `{ "Seward": "SYOO-erd", "Szgany": "ZIG-ah-nee" }`) that keeps canonical script text untouched while transparently applying vetted phonetic hints at Stage-1 TTS synthesis time.
- Compute `computeTakeTextHash` over the **post-lexicon synthesis text** so updating a single pronunciation entry automatically marks *only* cues containing that word stale, preserving all unrelated takes on `booth_render_all`.

### 9. Reusable Location Soundscape Presets
- Allow defining a named multi-bed acoustic environment once (e.g., `"castle_dracula"` = two calibrated wind beds + `gainDb` + ducking + fade curves) and stamping it onto recurring scenes by name or `sceneId`—expanding cleanly into standard cue-anchored beds under the hood.

---

## Phase v0.2c — Asset Library Intelligence & Audio-Blind Host Parity

*Goal: Reduce archival foley friction and bring Eyes + Ears QC to every MCP client.*

### 10. Archival Spoken-Slate & Clean-Slice Hints in Asset Indexing
- Extend `booth_index_assets` caption enrichment (`AssetCaptionResult`) and `catalog.json` sidecar schemas with `hasSpokenSlate`, `slateNotes`, `suggestedClipStartMs`, and `suggestedClipEndMs` so archival libraries (like USC CC0 foley) surface clean trim windows automatically instead of requiring manual slate hunting.
- Improve cross-folder semantic recall for archival libraries (e.g., finding doors filed under `Creaks/`) and document recommended modern stereo SFX library workflows alongside free CC0 starter packs.

### 11. Full-Mix Multimodal Director Review (`booth_review_mix`)
- Give audio-blind MCP hosts (clients without native inline audio perception) a single-call multimodal Director review on finished scene or master mixes.
- Feed the built-in multimodal Director **both** the rendered mix audio *and* the calibrated `booth_inspect_visual` PNG + per-speaker telemetry, catching acoustic twins, character loudness gaps, and timing slips with full Eyes + Ears coverage.

---

## Verification Plan for v0.2

Once v0.2a and v0.2b land, we plan to run **Production #2**—an intimate, character-driven public-domain or original multi-chapter piece—with upgraded stereo SFX libraries, comparing v0.1 vs. v0.2 head-to-head on:
- Full-hour mixdown runtime & scratch I/O
- Per-speaker loudness consistency (eliminating quiet-character drops)
- Hero-Line A/B retake rate & human-ear acting verdict
- Spatial realism from shared convolution reverb buses and whisper-honest leveling
