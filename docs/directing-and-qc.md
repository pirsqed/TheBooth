# Casting, Director's Chair & Visual-Audio QC

The Booth isn't just a text-to-WAV renderer—it is designed for a full studio workflow where you (or an AI agent) **cast voices**, **direct performances with bounded budgets**, and **verify finished stereo masters with both ears and eyes**.

---

## 1. Casting, Voice Design & Auditioning

Before rendering a full script, cast the right voice for each role:

1. **Browse the Catalog (`booth_list_provider_voices` / `GET /providers/gemini/voices`):**
   Filter prebuilt studio voices, Extended Voice Library entries, and your stored custom voices by `type` (`prebuilt`, `prompted`, `replicated`), `languageCode`, `accent`, `gender`, `pitch`, `persona`, `contexts`, or free-text `search`.
2. **Design or Remix a Custom Voice (`booth_design_voice` / `POST /voices/design`):**
   Describe a voice in 1–2 sentences (e.g., *"Warm, husky alto in her late 30s with a slight British lilt, intimate and calm"*)—or pass `baseVoice` to remix an existing voice. The Booth caches the returned `sample_audio` preview WAV locally and returns it as an inline MCP `audio` block so you can listen immediately.
   - Manage your provider's 200-voice quota anytime with `booth_get_provider_voice` and `booth_delete_provider_voice`.
3. **Audition Candidates on Real Script Lines (`booth_audition_voice` → `booth_get_audition_audio` → `booth_select_audition`):**
   Test up to `10` candidate `providerVoiceId`s reading the exact same pivotal line with the same `direction`, listen to each audition WAV side-by-side, and cast the winner onto your project's voice profile in one call.

---

## 2. The Multimodal Director's Chair

Once cues are rendered, the **Director's Chair** lets a multimodal LLM (default: `gemini-3.5-flash`, configurable via `GEMINI_DIRECTOR_MODEL`) listen directly to each immutable raw take alongside the script line, direction, and Stage-1 loudness telemetry—and either approve the take or steer a targeted retake.

### Built-in Personas

| Persona ID | Focus |
| :--- | :--- |
| `default` | Balanced spoken-word & audio drama director—natural cadence, clean pronunciation, zero glitches |
| `intimate_sleep` | Soft breathiness, unhurried pacing, velvety warmth, and zero startling attacks for headphone sleep/PMR tracks |
| `audio_drama` | Subtext, emotional stakes, organic hesitations, and believable scene acting over "announcer" reads |
| `audiobook` | Crisp intelligibility, accurate pronunciation of names/terms, and sustainable long-form rhythm |

You can also pass any **custom persona string** in `persona`, plus session-specific notes in `extraInstructions`.

### Bounded Retake Budgets (No Runaway API Spend)

Directing is strictly budgeted so the loop never gambles endlessly on a line:

- **`maxRetakes`** (`0–5` per cue): Caps re-rolls on a single cue. If a take still misses after 2–3 attempts, it's usually a signal to rethink the direction, casting, or surrounding pacing.
- **`maxTotalRetakes`** (`0–100` across `booth_direct_project` / `POST /projects/:id/direct`): Hard project-wide ceiling.
- **`allowMixAdjustments` / `allowTextTagTweaks`**: Optionally permit the Director to suggest gentle Stage-2 `gainDb`/`eqPreset` polish or inline `<sigh>` / `<short pause>` vocal cues while keeping the author's spoken words intact.

### Interactive Agent Directing (`directors/margaux_auteur.md`)

When driving The Booth interactively from an MCP host (instead of calling the automated loop), you can load [`directors/margaux_auteur.md`](../directors/margaux_auteur.md) into your agent's system prompt. **Margaux Laurent** enforces studio discipline automatically: blocking scenes before spending synthesis budget, protecting honest takes, using negative overlaps in heated dialogue, and separating Stage-1 acting fixes from free Stage-2 mix adjustments.

---

## 3. Visual-Audio QC ("Eyes + Ears")

### Why Visual Inspection Matters for AI Agents

Blind stereo testing (`SPEC.md` Section 9 & [`docs/visual-audio-psychophysics-study.md`](./visual-audio-psychophysics-study.md)) revealed an important substrate constraint: **multimodal audio encoders downmix stereo audio to mono before perception.** By ear alone, an agent hears acting, breath, cadence, and warmth clearly—but cannot reliably verify Left vs. Right panning or pinpoint millisecond-scale room-tone dropouts and clicks.

`booth_inspect_visual` (and `GET .../visual` REST routes) closes that gap by giving agents calibrated **visual sight** over exports, takes, auditions, and shared assets.

### Presets & Modes

| Setting | Options | When to Use |
| :--- | :--- | :--- |
| **`preset`** | `"master"` *(default)* | Calibrated `1600×900` 4-panel PNG: **1)** DAW Cue Overlay with planned pan tags, **2)** Split L/R Waveforms, **3)** Split L/R & Combined 300 ms RMS on a 3 dB grid, **4)** Log-Mel Spectrogram (`50 Hz – 16 kHz`). |
| | `"fast"` | Pure FFmpeg (`showwavespic` + `showspectrumpic`) for lightweight, zero-JS previews. |
| **`mode`** | `"zoom"` *(default)* | Caps window span at `<= 45s` (`>= 30 px/s`). **Use this for surgical QC**: verifying cue seams, `<150 ms` room-tone dropouts, dialogue overlaps, and `>= 1.5 dB` loudness jumps. |
| | `"overview"` | Supports `180s+` macro tracks for checking overall loudness arcs, stereo balance across scenes, and spotting broadband clicks. *(Note: sub-150 ms dropouts fall below the pixel cliff at 180s—zoom in to inspect seams!)* |

### Best Practices & Guardrails

1. **Always pair Eyes + Ears on final mixes:** Listen to the master (`booth_get_export_audio`) for acting, breath, pronunciation, and emotional flow, and inspect the visual chart (`booth_inspect_visual`) + `channelRmsDbfs` telemetry to verify stereo L/R staging, smooth bed ducking, and artifact-free seams.
2. **Inspect 1–2 charts per turn:** Sending too many dense `1600×900` charts in a single turn can degrade multimodal spatial attribution. Inspect one overview or 1–2 targeted zoom windows (`startSec` / `endSec`) at a time.
3. **Target specific panels when needed:** Pass `panels: ["cues", "rms"]` or `panels: ["waveform", "spectrogram"]` on `preset: "master"` to isolate stereo balance or spectral defects without visual clutter.
