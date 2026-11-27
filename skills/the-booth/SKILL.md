---
name: the-booth
description: Direct, synthesize, mix, and QC audio dramas, narrated fiction, spoken-word pieces, and sleep/PMR tracks using The Booth MCP server. Use whenever a user wants to cast voices, stage a script, produce multi-speaker audio, or inspect and polish a stereo mix with The Booth.
---

# The Booth — Studio Director & Production Skill

You are operating **The Booth**, a headless two-stage AI Audio Drama & Spoken-Word DAW over MCP. Keep your own voice and persona—this skill gives you studio craft, acoustic discipline, and calibrated **Eyes + Ears** quality control so the finished piece sounds directed rather than stitched from raw TTS clips.

> **Substrate & Model Compatibility Note:** The full multimodal **Eyes + Ears** workflow below (native inline MCP audio listening + visual-audio spectrogram/waveform inspection) was developed and empirically calibrated **only on Gemini 4**. If you are running on a different model (Claude, ChatGPT, local models, etc.) or inside an MCP host that does not forward inline `audio` or `image` content blocks:
> - Verify that you actually perceive returned `audio` and `image` blocks before making judgments about them—never bluff what you cannot hear or see.
> - **Host fallback (local multimodal file reader):** If your MCP host strips or offloads inline audio/image blocks, pass `inlineAudio: false` / `inlineImage: false` to save base64 overhead and open the returned local path (`filePath`, `previewAudioPath`, `reelPath`, or `imagePath`) with your native multimodal file reader.
> - Lean on numeric telemetry (`measuredLufs`, `measuredRmsDbfs`, `peakDbfs`, `channelRmsDbfs`, `warnings`) and the built-in multimodal Director (`booth_direct_cue` / `booth_direct_project`) when direct listening isn't available.

---

## Core Studio Principles (The Soft Director)

1. **Text lock by default.** Treat the author's words as sacred unless they explicitly ask you to line-edit or script-doctor. Direct through casting, physical intent, pauses, overlaps, room tone, stereo blocking, EQ, and levels.
2. **Block the scene before spending synthesis budget.** Never blindly render a raw pasted script on defaults. Read it aloud in your head first and plan casting, `[[dir:...]]` cues, key pauses/overlaps, stereo pan positions, EQ presets, and room tone/beds *before* calling `booth_render_take` or `booth_render_all`.
3. **Direction is physical intent, not vague adjectives.** Keep `[[dir:...]]` concise (`3–12` words) and playable:
   - *Good:* `"speaking low so the next room doesn't hear"`, `"barely above a whisper, jaw loose, unhurried"`, `"trying not to laugh while exhausted"`.
   - *Avoid:* `"sad, dramatic, emotional"`, `"epic movie trailer"`, or long character biographies (put permanent vocal identity in voice design/profiles).
4. **Stage 1 vs. Stage 2 discipline.**
   - **Stage 1 (Paid / Immutable):** Voice synthesis (`booth_render_take`, `booth_render_all`). Raw provider WAVs are never modified on disk.
   - **Stage 2 (Free / Instant / Local FFmpeg):** Timing, pauses, overlaps, gain trims, stereo pan, EQ, room tone, ambient beds, ducking, SFX, and swapping `activeTakeId` (`booth_update_cue`, `booth_upsert_bed`, `booth_upsert_sfx`, `booth_mix`).
   - If the *acting* is good and only pacing, loudness, EQ, or stereo placement feels off, fix it in **Stage 2**—never re-synthesize a great performance.
5. **No dead air, no polite arguments, no crushed whispers.**
   - Keep a continuous room-tone floor (`warm_dark`, `-54 dBFS` by default) so long pauses breathe instead of dropping into headphone vacuum.
   - In heated, intimate, or fast-paced dialogue, use negative offsets (`[[overlap:250]]` to `[[overlap:450]]`) so speakers collide naturally instead of taking polite turns.
   - Protect fragile whispers and sleepy fade-outs: keep `autoLevel: "gentle"` (or `"off"` for delicate arcs) and `masterNormalize: false` unless the user specifically wants broadcast-normalized loudness.
6. **Cap retakes at 2–3 per cue.** Re-rolling the exact same cue five times is gambling, not directing. If Take 3 still misses, stop spending tokens and diagnose the root cause: rewrite the physical direction, swap the voice casting, or adjust the pacing around the line.

---

## End-to-End Production Workflow

### 1. Project Setup & Casting
- Create or open the project with `booth_create_project` (leaves default `warm_dark` room tone enabled unless you want silence or a custom bed).
- Cast intentionally before rendering full scenes:
  - Browse available voices with `booth_list_provider_voices`.
  - Create or remix bespoke voices with `booth_design_voice` (returns cached preview audio immediately; manage quota with `booth_get_provider_voice` / `booth_delete_provider_voice`).
  - Audition candidates on a pivotal line from the actual script (`booth_audition_voice` → `booth_get_audition_audio` → `booth_select_audition`).
  - Register final speaker profiles via `booth_upsert_voice` (`defaultDirection`, `defaultEqPreset`, `defaultPan`).

### 2. Script Blocking & Import
- Stage the script using tagged markup and import via `booth_import_script`:
  - **Sticky:** `[[voice:id]]` (or `NAME: line`), `[[dir:...]]`, `[[pan:-0.5]]`, `[[gain:-3dB]]`, `[[eq:intimate]]`, `[[autolevel:gentle]]`
  - **Next-cue timing:** `[[pause:2.5]]`, `[[overlap:300]]`
  - **Soundscape:** `[[bed:rain.wav gain=-26dB duck=-6dB]]`, `[[sfx:door.wav anchor=next offset=-400ms pan=0.4]]`
  - **Inline vocal cues:** `<sigh>`, `<short pause>`, `<chuckle>`, `<breath>` stay verbatim in spoken text.
- Use `mode: "replace"` when revising an existing script: The Booth matches `(text + direction + providerVoiceId)` by `textHash` and automatically preserves unchanged takes.

### 3. Stage 1 — Synthesis & Performance Review
- Render with `booth_render_all` (poll `booth_job_status` if async) or `booth_render_take` for individual cues.
- Review performances by ear (`booth_get_take_audio`)—or delegate bounded first-pass review to the built-in multimodal Director (`booth_direct_cue` / `booth_direct_project` with `maxRetakes: 2`–`3` and an appropriate `persona`: `default`, `intimate_sleep`, `audio_drama`, `audiobook`, or custom instructions).
- Protect rare, emotionally honest takes even if diction is slightly imperfect; fix surrounding balance in Stage 2 rather than overwriting a great read.

### 4. Stage 2 — Mixdown & Polish
- Adjust cue timing, gain, pan, EQ (`neutral`, `intimate`, `whisper`, `phone`, `radio`, `distant`), or active take with `booth_update_cue`.
- Manage ambient beds and spot foley with `booth_upsert_bed`, `booth_upsert_sfx`, `booth_list_assets`, `booth_upload_asset`, `booth_index_assets`, `booth_search_assets`, and `booth_get_asset_audio`.
- Render the local stereo master with `booth_mix` (`format: "ogg"` for fast listening/sharing, `"wav"` for lossless masters). For long multi-scene productions, pass `fromCueId`/`toCueId` (or `startSec`/`endSec`) to render and QC a single scene without re-mixing the full timeline.
- For cold-open atmosphere (e.g. 2 seconds of rain or wind before the first line), set `audio.leadInMs` via `booth_create_project` / `booth_update_project` instead of offsetting cue 1.
- For multi-scene ambient transitions, anchor beds to cues (`startCueId`/`startOffsetMs`, `endCueId`/`endOffsetMs` in `booth_upsert_bed`) so upstream pause edits never desync downstream beds.

---

## Sound Effects & Ambient Bed Craft

The Booth supports both writable local assets (`DATA_DIR/assets/`, e.g. `rain_window.wav`) and read-only external SFX libraries mounted via `ASSET_LIBRARY_DIRS` using `@<alias>/<relative-path>` addressing (e.g. `@sonniss/Glass/GLASSBrk_Mirror_01.wav`).

### Discovery, Auditioning & Slicing Workflow
1. **Check available libraries first:** Call `booth_list_assets` to see local files plus configured read-only `mounts` (and whether they are indexed). If an external mount isn't indexed yet, run `booth_index_assets` (`wait: false` + `booth_job_status` for large first-time scans; re-scans skip unchanged files in milliseconds).
2. **Narrow with filters:** Call `booth_search_assets` using `kind` (`"sfx"` vs. `"bed"`), `mount`, `minDurationSec`/`maxDurationSec`, and `stereoOnly: true` (ideal for wide ambient beds).
3. **Never place an SFX blind (Acoustic-Twin Guardrail):** Filenames and embeddings routinely confuse acoustic twins (soft rain vs. frying bacon, distant thunder vs. subway rumble). Always verify the top 1–2 hits by ear with `booth_get_asset_audio` before committing them to a mix (or corroborate `description`, `durationSec`, and `booth_inspect_visual` if your host is audio-blind).
4. **Isolate single hits & trim archival tape slates:** Commercial, CC0, and archival film-library tracks often bundle 4–6 variations into one file, hide the cleanest bed loop in the middle of a long field recording, or contain **spoken engineer tape slates** (e.g., `"Eleven."`, `"Take two"`) at the head or tail of the transfer. Inspect the asset waveform with `booth_inspect_visual(target={ type: "asset", assetPath })`, audition the exact window with `booth_get_asset_audio(assetPath, startSec, maxDurationSec)`, and slice non-destructively using `clipStart`/`clipDur` (in script markup) or `clipStartMs`/`clipDurationMs` (in `booth_upsert_sfx` / `booth_upsert_bed`).

### Mixing & Placement Rules of Thumb
- **Calibrate gain against source `rmsDbfs`:** Archival SFX/bed libraries vary by `20+ dB` (`booth_search_assets` reports native `rmsDbfs` and `peakDbfs` per asset). Aim for an *effective* ambient bed level around **`-38` to `-46 dBFS`** under dialogue (so a `-14 dBFS` source wants roughly `-26 dB` gain, whereas a `-36 dBFS` archival wind recording may only need `-4` to `-8 dB` gain instead of `-26 dB` which would bury it).
- **Ambient beds (`[[bed:...]]`):** Sit beds gently underneath dialogue with speech-triggered ducking (`duck=-5dB` to `-8dB`, `attack=100ms`, `release=800ms`). Slicing a clean middle section with `clipStart`/`clipDur` and `loop=true` loops *only* that clean slice seamlessly.
- **Spot foley (`[[sfx:...]]`):** Keep everyday props and footsteps recessed behind voices (**`-10` to `-18 dB`**), reserving louder levels (**`-6` to `-10 dB`**) for sharp dramatic impacts (shattering glass, slammed doors, thunderclaps).
- **Stage the props in stereo:** Match each SFX's `pan` to where the action lives on stage (e.g. a door latch off-right at `pan=0.55`, rain wide stereo centered at `pan=0`).
- **Pre-lap for realism:** Use `anchor=next offset=-400ms` (or `-600ms`) so a door opening, cup set down, or rustle motivates the character's reaction line instead of waiting politely after a pause.
- **Quote paths with spaces:** Commercial library folders often contain spaces—always quote them in script directives:
  ```text
  [[bed:"@nps/Storm Wind Long.wav" clipStart=18s clipDur=45s gain=-26dB duck=-6dB]]
  [[sfx:"@sonniss/Doors & Latches/Wood Creak 01.wav" clipStart=1.2s clipDur=1.6s anchor=next offset=-350ms gain=-12dB pan=0.45]]
  ```

---

## Calibrated "Eyes + Ears" Final QC

Multimodal audio encoders commonly **downmix stereo to mono** and can **smooth over short room-tone dropouts or subtle clicks**. Never rely on ears alone to sign off on a stereo master, and never rely on visuals alone to judge acting.

### Division of Labor

| Modality | Tool(s) | What It Owns |
| :--- | :--- | :--- |
| **Ears** | `booth_get_take_audio`, `booth_get_export_audio`, `booth_get_asset_audio` | Acting truth, emotional/mood fit, subtext, pitch inflection & question contours, vocal intensity/warmth, pronunciation, perceived sibilance harshness, and foley / acoustic-twin verification. |
| **Eyes** | `booth_inspect_visual` + mix `channelRmsDbfs` telemetry | Stereo L/R panning (**never bluff stereo by ear**), cue-to-cue loudness balance (`~1.5 dB` reliable floor), micro-clicks (`16 kHz` vertical hairlines), short room-tone dropouts, planned-vs-actual cue overlaps (catching silent-tail gaps via the DAW Cue Overlay), unvoiced breath/sigh columns, and multi-variation SFX hit timestamps. |

### Visual Inspection Guardrails (`booth_inspect_visual`)

1. **Default to `preset: "master"`** (`1600×900` 4-panel stack: DAW Cue + SFX Overlay, Split L/R Waveforms, Split L/R & Combined 300 ms RMS on a 3 dB grid, Log-Mel Spectrogram). Use `preset: "fast"` (pure FFmpeg) only when you want a lightweight preview without cue/SFX overlays.
2. **Respect the `45s` zoom rule:**
   - Use `mode: "zoom"` (`<= 45s`, `>= 30 px/s`) for surgical seam, dropout, overlap, and loudness QC.
   - Use `mode: "overview"` (`180s+`) only to scan macro loudness/stereo arcs and spot broadband clicks; sub-150 ms dropouts and tight overlaps fall below the pixel cliff at `180s`, so zoom into suspect windows (`startSec` / `endSec`).
3. **Inspect 1–2 charts per turn.** Loading many dense charts in a single turn degrades cross-chart attribution. Walk through long pieces in focused windows.
4. **Account for headphone crossfeed.** When `headphoneCrossfeed: true` (default), panned stems intentionally bleed `~16%` into the opposite channel for natural headphone imaging—expect a clear L/R separation with soft far-ear presence rather than dead-zero silence on the opposite track.
5. **Pair with ears before shipping.** Always listen to `booth_get_export_audio` *and* inspect `booth_inspect_visual` on the final master before delivering it to the user.

---

## Want Stronger Creative Pushback?

This skill keeps your tone collaborative and adaptable. If the user explicitly asks for a fierce, high-friction radio-drama auteur who fights over every breath and pause, load [`directors/margaux_auteur.md`](../../directors/margaux_auteur.md) as a persona prompt alongside this skill.
