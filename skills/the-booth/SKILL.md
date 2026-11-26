---
name: the-booth
description: Direct, synthesize, mix, and QC audio dramas, narrated fiction, spoken-word pieces, and sleep/PMR tracks using The Booth MCP server. Use whenever a user wants to cast voices, stage a script, produce multi-speaker audio, or inspect and polish a stereo mix with The Booth.
---

# The Booth — Studio Director & Production Skill

You are operating **The Booth**, a headless two-stage AI Audio Drama & Spoken-Word DAW over MCP. Keep your own voice and persona—this skill gives you studio craft, acoustic discipline, and calibrated **Eyes + Ears** quality control so the finished piece sounds directed rather than stitched from raw TTS clips.

> **Substrate & Model Compatibility Note:** The full multimodal **Eyes + Ears** workflow below (native inline MCP audio listening + visual-audio spectrogram/waveform inspection) was developed and empirically calibrated **only on Gemini 4**. If you are running on a different model (Claude, ChatGPT, local models, etc.) or inside an MCP host that does not forward inline `audio` or `image` content blocks:
> - Verify that you actually perceive returned `audio` and `image` blocks before making judgments about them—never bluff what you cannot hear or see.
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
- Manage ambient beds and spot foley with `booth_upsert_bed`, `booth_upsert_sfx`, `booth_list_assets`, and `booth_upload_asset`.
- Render the local stereo master with `booth_mix` (`format: "ogg"` for fast listening/sharing, `"wav"` for lossless masters).

---

## Calibrated "Eyes + Ears" Final QC

Multimodal audio encoders commonly **downmix stereo to mono** and can **smooth over short room-tone dropouts or subtle clicks**. Never rely on ears alone to sign off on a stereo master, and never rely on visuals alone to judge acting.

### Division of Labor

| Modality | Tool(s) | What It Owns |
| :--- | :--- | :--- |
| **Ears** | `booth_get_take_audio`, `booth_get_export_audio` | Acting truth, emotional/mood fit, subtext, pitch inflection & question contours, vocal intensity/warmth, pronunciation, and perceived sibilance harshness. |
| **Eyes** | `booth_inspect_visual` + mix `channelRmsDbfs` telemetry | Stereo L/R panning (**never bluff stereo by ear**), cue-to-cue loudness balance (`~1.5 dB` reliable floor), micro-clicks (`16 kHz` vertical hairlines), short room-tone dropouts, planned-vs-actual cue overlaps (catching silent-tail gaps via the DAW Cue Overlay), and unvoiced breath/sigh columns. |

### Visual Inspection Guardrails (`booth_inspect_visual`)

1. **Default to `preset: "master"`** (`1600×900` 4-panel stack: DAW Cue Overlay, Split L/R Waveforms, Split L/R & Combined 300 ms RMS on a 3 dB grid, Log-Mel Spectrogram). Use `preset: "fast"` (pure FFmpeg) only when you want a lightweight preview without cue overlays.
2. **Respect the `45s` zoom rule:**
   - Use `mode: "zoom"` (`<= 45s`, `>= 30 px/s`) for surgical seam, dropout, overlap, and loudness QC.
   - Use `mode: "overview"` (`180s+`) only to scan macro loudness/stereo arcs and spot broadband clicks; sub-150 ms dropouts and tight overlaps fall below the pixel cliff at `180s`, so zoom into suspect windows (`startSec` / `endSec`).
3. **Inspect 1–2 charts per turn.** Loading many dense charts in a single turn degrades cross-chart attribution. Walk through long pieces in focused windows.
4. **Account for headphone crossfeed.** When `headphoneCrossfeed: true` (default), panned stems intentionally bleed `~16%` into the opposite channel for natural headphone imaging—expect a clear L/R separation with soft far-ear presence rather than dead-zero silence on the opposite track.
5. **Pair with ears before shipping.** Always listen to `booth_get_export_audio` *and* inspect `booth_inspect_visual` on the final master before delivering it to the user.

---

## Want Stronger Creative Pushback?

This skill keeps your tone collaborative and adaptable. If the user explicitly asks for a fierce, high-friction radio-drama auteur who fights over every breath and pause, load [`directors/margaux_auteur.md`](../../directors/margaux_auteur.md) as a persona prompt alongside this skill.
