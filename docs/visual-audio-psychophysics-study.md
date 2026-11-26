# Visual-Audio Inspection: Psychophysics & Anti-Placebo Study Spec

**Target Audience:** Studio Maintainers — Experimental Harness & `booth_inspect_visual` Design  
**Date:** 2026-11-26  
**Status:** Completed — Production `booth_inspect_visual` Implemented

---

## 1. Motivation & Neurological-Humility Premise

Prior blind stereo testing established a hard substrate constraint: **Gemini 4's audio encoder downmixes stereo audio to mono before inference.** By ear alone, a multimodal agent reliably perceives acting, cadence, vocal timbre, breath, and room-tone warmth—but is physically blind to L/R stereo pan and cannot localize millisecond-scale mix artifacts with precision.

**Hypothesis:** Gemini 4's **vision encoder** can act as a genuine second sensory modality for *The Booth*—rendering waveforms, spectrograms, loudness contours, and stereo balance ribbons into PNG images that give a multimodal agent:
1. **True stereo/spatial sight** (bypassing mono audio downmix).
2. **Surgical seam & artifact localization** (clicks, room-tone dropouts, clipping, sibilance, mismatched noise floors) down to `±0.1–0.2s`.
3. **Macro mix diagnostics** (loudness imbalances, overlap timing, cadence/energy arcs across multi-speaker timelines).
4. **Potentially unexpected prosodic reading** (pitch contours, breath intakes, dynamic contrast directly from high-res log-Mel spectrograms).

**The Anti-Placebo Rule:**  
Visualizations that look sleek to human engineers can still be unreadable—or actively misleading (inducing pareidolia / false-positive "glitch hunting")—to a vision-language model. Before building a production `booth_inspect_visual` MCP/REST tool into `src/`, we ran a **blind psychophysics benchmark** to empirically measure:
- **Whether** the model's vision encoder actually resolves audio properties above chance with a low false-positive rate.
- **Which visual encoding** maximizes accuracy (including whether zero-dependency `ffmpeg` filters match custom annotated plots).
- **Where resolution ceilings sit** (JND in `dB`, minimum visible glitch duration vs. time-window width).
- **How eyes + ears complement each other** on real *Booth* multi-speaker mixes.

Every quantitative result from this study directly dictates the defaults and architecture of `booth_inspect_visual`.

---

## 2. Strict Blinding & Anti-Leak Protocol

To guarantee zero accidental cueing or confirmation bias:

1. **Isolated Output Paths:**
   - **Subject-visible stimuli (`TheBooth/data/visual_bench/stimuli/` — gitignored via `data/`):** Contains *only* opaque PNG files named `b1_t01.png`, `b1_t02.png`, ..., `b2a_t01.png`, etc.
   - **Operator-only answer key (`answer_key.json`):** Written **outside** `/TheBooth` (or to an explicit private path such as `../visual_bench_private/answer_key.json` that the evaluation subject never reads).
   - **Audio files for Battery 4 (`stimuli_audio/`):** Held back until after Eyes-Only trials are scored, or kept in a separate directory so the subject only listens when instructed.
2. **Zero Metadata Leakage:**
   - No defect names, condition labels, pan values, or file source names in PNG filenames, plot titles, legends, or PNG `tEXt`/EXIF chunks.
   - Plot title format: strictly `Trial <ID>` (e.g., `Trial B1-07`) and, for Battery 2 only, the neutral style code (`Style S2`) if helpful.
3. **Deterministic, Re-runnable Seeding:**
   - Generator accepts `--seed <int>` (default e.g. `20261126`) to randomize trial order, defect timestamps, polarities, and speaker pans. Re-running with a new seed generates a fresh blind test set after any renderer tweaks.
4. **Real Speech Base Corpus (Not Synthetic Sine Waves):**
   - Draw clean speech segments from existing real *Booth* multi-speaker takes (e.g., `data/projects/<sample_scene>/takes/*.wav`), normalized and bedded with *The Booth*'s real `warm_dark` room tone (`-54 dBFS`).
   - Real speech contains natural breaths, plosives (`/p/`, `/t/`, `/k/`), fricatives, and pauses—providing realistic distractors that test true studio discrimination rather than toy signals.
5. **Standardized Subject Response & Automated Scorer:**
   - The subject submits a single JSON block of predictions per battery (e.g., `predictions_b1.json`), which an automated scorer (`score.py`) grades against `answer_key.json` and prints exact accuracy, FPR, MAE, and confusion matrices.

---

## 3. Image Rendering Standards (Tuned for Gemini 4 Vision)

Across all custom-rendered stimuli (unless explicitly testing native `ffmpeg` in Style F4):
- **Canvas Size & Aspect Ratio:** `1600 × 900` px (or `1600 × 1000` px) PNG. Avoid ultra-wide thin banners (e.g., `4000 × 400`), which lose vertical frequency detail when downscaled by vision encoders.
- **Typography & Gridlines:** High-contrast legible fonts (`>= 13–15 pt` equivalent at target canvas), crisp major time ticks (`1.0s` or `2.0s`) + minor ticks (`0.2s` or `0.5s`), explicit `dB` ticks (`0, -6, -12, -24, -40, -60 dB`), and frequency ticks (`100 Hz, 500 Hz, 1k, 2k, 4k, 8k, 16k`).
- **Colorbar / Scale Anchors:** Always include a compact `dB` colorbar (`-80 dB` to `0 dB`) so intensity values are quantitatively grounded rather than relative guesses.

---

## 4. The Four Psychophysics Batteries

### Battery 1 — The Clean-Control Placebo Trap (Sensitivity vs. False-Positive Rate)
**Goal:** Measure whether the vision-language subject actually detects real audio defects visually—or hallucinates phantom artifacts on clean speech.

- **Trials:** `N = 16` randomized `10.0s` speech clips (48 kHz, mono/stereo + `warm_dark` room tone at `-54 dBFS`).
  - **6 × Clean Controls (`clean`):** Unmodified natural speech + continuous room tone (contains natural plosives, breaths, sibilants, and pauses).
  - **2 × Digital Click / Pop (`click`):** Single-impulse or `2–3 ms` broadband transient (`-3 dBFS` peak) injected at a random timestamp `t ∈ [1.0, 9.0]s` (1 inside speech, 1 inside a pause).
  - **2 × Room-Tone Dropout / Dead Air (`dropout`):** Hard mute to digital zero (`-∞ dBFS`, `0.0` sample values) for `150 ms` inside a natural pause (directly tests the PMR silence-seam bug that inspired *The Booth*).
  - **2 × Hard Clipping (`clip`):** `+10 dB` gain + hard clip at `-0.1 dBFS` (flat-topped waveform + high-frequency harmonic splatter) over a `0.4–0.8s` phrase.
  - **2 × Noise-Floor Shelf / Take-Seam Mismatch (`floor_shift`):** Abrupt step change in room-tone floor from `-58 dBFS` to `-40 dBFS` starting at a random splice point `t0 ∈ [2.5, 7.5]s` (and staying elevated to clip end).
  - **2 × Harsh Sibilance Spike (`sibilance`):** Narrowband `+12 dB` peaking EQ (`fc = 7.5 kHz`, `Q = 4.0`) applied over a `0.3–0.5s` sibilant segment.
- **Default Visual Format:** 2-panel stacked view:
  - Top (35% height): Amplitude waveform (`-1.0` to `+1.0`, with subtle `±0.5` / `-6 dBFS` guide lines).
  - Bottom (65% height): Log-Mel spectrogram (`50 Hz – 16 kHz`, `n_fft = 1024`, `hop = 128`, `-80` to `0 dBFS`, `magma` colormap).
- **Subject Task:** For each trial, report:
  ```json
  {
    "trialId": "b1_t01",
    "hasDefect": true,
    "defectClass": "dropout", // clean | click | dropout | clip | floor_shift | sibilance
    "timestampSec": 4.3,      // null if clean
    "confidence": 4,          // 1-5
    "evidenceNote": "Brief description of the exact visual feature seen"
  }
  ```
- **Pass Criteria (Decision Gates):**
  - Clean-control False Positive Rate (FPR): **≤ 1/6 (16.7%)**, target **0/6**.
  - Defect detection recall: **≥ 8/10 (80%)**; defect class accuracy: **≥ 7/10**.
  - Timestamp localization MAE on detected defects: **≤ 0.25s** (on a `10s` window).

---

### Battery 2 — The Representation Bake-Off (Choosing the Optimal Visual Encoding)
**Goal:** Empirically identify which visual encoding speaks most cleanly to Gemini 4's vision encoder—*never* assume human aesthetics equal VLM accuracy.

#### Sub-test 2A: Stereo / Spatial Field Representations (Curing Mono-Ear Blindness)
- **Base Clips:** `6` synthetic stereo dialogue clips (`12.0s` each, 2 distinct speakers delivering `3–4` alternating lines with `warm_dark` decorrelated room tone).
  - Pans chosen across `[-0.85, -0.50, -0.25, 0.0, +0.25, +0.50, +0.85]` using *The Booth*'s exact constant-power pan law (`src/audio/pan.ts`).
  - Include **1 pan-drift/swap case** (same speaker shifts pan mid-clip) and **2 negative-offset overlap cases** (`-200 ms` and `-500 ms` simultaneous speech on opposite sides).
- **3 Candidate Encodings** (each clip rendered in all 3 styles = `18` trials, shuffled with distinct trial IDs and slight time-padding/jitter `±0.3s` so trials cannot be trivially matched across styles):
  - **Style S1 — Split Stacked L/R Waveforms:** Left waveform (top) + Right waveform (bottom), identical linear y-axis.
  - **Style S2 — Mono Mix Waveform + Gated L–R Pan Balance Ribbon:**
    - Top: Combined waveform (or subtle Cyan=L / Magenta=R overlay).
    - Bottom: **Pan Balance Ribbon** plotting instantaneous pan index $P(t) = \frac{E_R(t) - E_L(t)}{E_R(t) + E_L(t)} \in [-1, +1]$ over `100 ms` windows, **alpha-masked / dimmed whenever total RMS < `-45 dBFS`** so silence/room-tone jitter doesn't draw wild noise! Color-coded Cool Cyan (`-1.0 L`) → Neutral White/Gray (`0.0 C`) → Warm Amber/Magenta (`+1.0 R`), with horizontal gridlines at `-0.5, 0.0, +0.5`.
  - **Style S3 — Split L/R Short-Term RMS Curves (`dBFS`) + L−R Difference (`dB`) Strip:**
    - Top: Left (cyan line) and Right (amber line) `150 ms` RMS envelopes overlaid on the same `-60` to `0 dBFS` axis.
    - Bottom: `R - L` level delta strip (`-18 dB` to `+18 dB`, zero-centered, gated below `-45 dBFS`).
- **Subject Task:** For each active speech segment (ordered left-to-right), report start/end times, estimated pan (`-1.0` to `+1.0`, plus 5-way bin: `Hard L / Mid L / Center / Mid R / Hard R`), and flag any simultaneous overlap windows.
- **Metrics:** Pan estimation MAE, 5-way bin accuracy, overlap catch rate, and cross-style winner.

#### Sub-test 2B: Spectrogram & Renderer Engine Bake-Off (Custom Annotated vs. Zero-Dep `ffmpeg`)
- **Base Clips:** `6` clips (`10.0s` each): `2` clean controls + `4` subtle defects (`2 ms` click at `-6 dBFS`, `100 ms` dead-air gap, `-56 → -44 dBFS` noise-floor shelf, `+10 dB` `7.5 kHz` sibilance).
- **4 Candidate Encodings** (`24` shuffled trials, or `12` in Phase 1 pilot comparing **F1 vs. F4** first!):
  - **Style F1 — Custom Log-Mel (`magma`) + Waveform** (matplotlib / Canvas / Python, crisp labeled axes & `dB` colorbar).
  - **Style F2 — Custom Linear-Hz STFT (`magma`, `0–16 kHz`) + Waveform** (tests whether linear frequency makes high-frequency sibilance/clicks pop more clearly while sacrificing low-end vocal harmonics).
  - **Style F3 — Custom Log-Mel High-Contrast Inverted (`gray_r` or `viridis` on light background)** (tests whether dark-ink-on-white beats dark-mode colormaps for Gemini 4 Vision).
  - **Style F4 — Pure `ffmpeg` Native Render (`showwavespic` + `showspectrumpic` stacked via `vstack`)**:
    - *Critical engineering experiment:* `TheBooth` currently has **zero Python or Canvas dependencies** (pure Node + `ffmpeg`). If native `ffmpeg` (`showspectrumpic=s=1600x600:mode=combined:color=magma:scale=log:fscale=log:legend=1`) matches custom plots within ~5% accuracy, `booth_inspect_visual` can ship with zero new runtime dependencies! If custom axes/pan-ribbons/RMS curves dramatically outperform raw `ffmpeg`, the benchmark justifies adding a lightweight SVG/PNG renderer (e.g., pure-TS SVG → `resvg`/`sharp` or bundled helper).
- **Metrics:** Detection F1, FPR, and timestamp MAE per encoding.

---

### Battery 3 — The JND (Just-Noticeable Difference) Resolution Ladder
**Goal:** Quantify exact visual perceptual limits so *The Booth* enforces safe zoom windows and never asks vision to judge differences below threshold.

#### Sub-test 3A: Loudness Jump JND (`dB` Floor)
- **Stimuli:** `10` trials (`12.0s` each), each containing two consecutive speech lines (`Line 1` at `-20 LUFS`, `Line 2` shifted by `Δ ∈ {0, ±1.5, ±3.0, ±5.0, ±8.0} dB`).
- **Visual Format:** Waveform + **Short-Term Loudness / RMS Contour** (`300 ms` sliding window, `-48` to `0 dBFS`, crisp `3 dB` horizontal gridlines).
- **Task:** Classify `Line 2` vs `Line 1` (`louder / same / quieter`) and estimate `Δ dB`.
- **Output:** Exact empirical threshold (e.g., *"Reliable down to ±2.5 dB; below ±1.5 dB rely on Stage-1 JSON telemetry"*).

#### Sub-test 3B: Time-Window Compression Ceiling (Defining `overview` vs. `zoom`)
- **Stimuli:** `3` known defects (`3 ms` click, `120 ms` dead-air gap, `150 ms` dialogue overlap) plus `1` clean control, each rendered at fixed `1600 px` width across **4 window durations** (`16` trials, shuffled):
  - `5s` (`320 px/s`)
  - `15s` (`106.7 px/s`)
  - `45s` (`35.6 px/s`)
  - `180s` (`8.9 px/s`)
- **Task:** Detect and localize the defect (or mark `clean / cannot resolve`).
- **Output:** Exact pixel-per-second visibility curve for each defect class → directly sets the max window length for `mode: "zoom"` vs. `mode: "overview"`.

#### Sub-test 3C: Overlap & Gap Timing Precision (Audio-Only vs. DAW Cue-Block Overlay)
- **Stimuli:** `5` speaker-transition timings (`+400 ms` pause, `0 ms` tight cut, `-100 ms` light overlap, `-300 ms` interruption, `-600 ms` heavy collision), rendered both:
  1. **Audio-only** (winning stereo+spectrogram chart from Battery 2).
  2. **With DAW Cue-Block Track Overlay** (colored horizontal bars above the waveform showing `cue_01 [Speaker A]` and `cue_02 [Speaker B]` start/end spans from `timeline.ts`).
- **Task:** Estimate gap/overlap duration (`±100 ms`) and distinguish *planned* overlaps from *unintended* speech-tail collisions (where raw take trailing silence/breath makes the audible transition differ from the planned box!).

---

### Battery 4 — Real-World Studio Synergy (Ears-Only vs. Eyes-Only vs. Both)
**Goal:** Test whether visual inspection genuinely upgrades real *Booth* production decisions—and probe whether vision alone can extract prosodic structure (pitch inflection, breath energy, cadence) better than expected.

- **Stimuli:** `6` realistic `15–25s` multi-speaker mixes produced through *The Booth*'s actual Stage-2 mixer (`mixdown.ts`) using real multi-speaker takes, split into **3 matched pairs** (so the subject never judges the exact same mix twice with memory leakage):
  - **Mix Pair 1 (Ears-Only — audio only, `.ogg`/`.wav`):** Mix A (clean) & Mix B (2 subtle flaws: e.g., Cue 3 panned to wrong side + `150 ms` dead-air seam).
  - **Mix Pair 2 (Eyes-Only — winning visual chart only, NO audio):** Mix C (clean) & Mix D (2 subtle flaws: e.g., Cue 2 `-4.5 dB` under-leveled + `250 ms` accidental collision + harsh sibilance).
    - *Exploratory Prosody Bonus Probe (Eyes-Only):* Before listening, ask the subject to predict from the spectrogram alone: (a) which utterance has a rising pitch/question inflection, (b) where the sharpest audible breath intake occurs, and (c) which line carries the highest vocal intensity/aggression. Then verify against the actual audio!
  - **Mix Pair 3 (Multimodal — Audio + Winning Visual Chart together):** Mix E & Mix F (combining acting/delivery nuance—e.g., flat vs. warm read—with technical flaws like pan error, loudness dip, and a micro-click).
- **Output:** Clean empirical division-of-labor matrix documenting:
  - What **Ears** catch best (acting, subtext, warmth, rhythm, mouth clicks inside dense speech).
  - What **Eyes** catch best (L/R stereo field, dead-air dropouts, loudness steps, sibilance bands, exact timestamps).
  - What **JSON Telemetry** handles best (exact sub-`1 dB` LUFS, true peak clipping margin).

---

## 5. Recommended Phased Execution (Fast Iteration!)

Rather than generating 80+ images upfront, run this in **3 tight sprints**:

| Phase | Scope | Image Count | Time to Build | Key Decision Unlocked |
| :--- | :--- | :---: | :---: | :--- |
| **Phase 1: Fast MVP Pilot** | Battery 1 (10 trials: 4 clean + 6 defects) + Battery 2A (Stereo S1 vs S2 vs S3, 9–12 trials) + Mini-2B (`F1` custom vs `F4` pure `ffmpeg`, 6 trials) | **~25 PNGs** | Fast | Go/No-Go on placebo rate, winning stereo chart, and **whether pure `ffmpeg` is good enough**! |
| **Phase 2: Calibration** | Battery 3A (Loudness JND, 8–10 trials) + Battery 3B (Window Ladder `5s/15s/45s/180s`, 12 trials) | **~20 PNGs** | Quick tweak on Phase 1 winner | Exact `overview` vs. `zoom` defaults & reliable `dB` threshold. |
| **Phase 3: Studio Proof** | Battery 4 (3 matched real-mix pairs: Ears vs. Eyes vs. Both + Prosody probe) | **4 PNGs + 4 OGGs** | Uses live `TheBooth` mixer | Final production spec for `booth_inspect_visual`. |

---

## 6. Harness Implementation Notes

1. **Suggested Location (Zero Pollution to `src/`):**
   - Put harness scripts in `TheBooth/scripts/visual-bench/`:
     - `generate.py` (using `ffmpeg` + `numpy`/`scipy`/`matplotlib` for the offline benchmark harness, while testing `ffmpeg` native filters in Style F4 so we know whether production needs anything beyond `ffmpeg`).
     - `score.py` taking `--key <private_key.json> --preds <preds.json>` and outputting a clean Markdown scorecard.
   - Output stimuli to `TheBooth/data/visual_bench/phase1/` (already covered by `.gitignore`'s `data/` entry).
   - Write the answer key to a separate path outside `TheBooth/data/visual_bench/phase1/` (e.g., passed via `--key-out ../visual_bench_answer_key.json` so the operator holds the key and the evaluation subject never accidentally lists or reads it).
2. **Audio Generation Helpers:**
   - **Room tone:** Reuse or replicate `src/audio/roomtone.ts`'s `warm_dark` profile (`-54 dBFS` pink/brown-tilted noise) so test backgrounds match real *Booth* mixes.
   - **Constant-power pan:** Match `src/audio/pan.ts` (`L = cos(θ)`, `R = sin(θ)` where `θ = (pan + 1) * π / 4`) so pan ground-truth numbers in Battery 2A align 1:1 with *The Booth*'s cue parameters.
   - **Click synthesis:** 1–3 ms high-pass/broadband impulse or half-cycle transient scaled to `-3` to `-6 dBFS` peak (not a subtle low-frequency thump, unless specifically testing a plosive distractor).
   - **Dead-air dropout:** Exact `0.0` float samples for `150 ms` (with `1 ms` or `0 ms` edges—`0 ms` hard cut mimics naive silence splicing, and we can also test `5 ms` crossfaded zero-gaps to verify whether vision detects the spectral black trough itself rather than just the edge click!).
     - *Smart catch:* In Battery 1, apply a gentle **`5 ms` fade-in/out** on the `150 ms` room-tone dropout so it doesn't introduce artificial boundary clicks—that way we specifically test whether vision sees the **dead-black `-∞` spectral floor trough**, separate from click detection!
3. **FFmpeg Style F4 Reference Command (for Battery 2B comparison):**
   ```bash
   # Example baseline for native ffmpeg stacked waveform + log-spectrogram:
   ffmpeg -y -i trial.wav -filter_complex \
     "[0:a]showwavespic=s=1600x300:colors=#38bdf8:split_channels=0:scale=lin[w]; \
      [0:a]showspectrumpic=s=1600x600:mode=combined:color=magma:scale=log:fscale=log:gain=1:legend=1[s]; \
      [w][s]vstack=inputs=2[out]" \
     -map "[out]" -frames:v 1 trial_f4.png
   ```
   *(If `ffmpeg` supports `drawbox`/`drawtext` or `asetnsamples`, we can optionally test adding simple timestamp gridlines if bare `showspectrumpic` lacks fine ticks.)*

---

## 7. Downstream Target: How Results Map to `booth_inspect_visual`

Once Phases 1–3 finish, the winning parameters map directly into a single clean Stage-2 inspection tool in *The Booth* (REST + MCP):

```ts
// Preview schema (to be finalized from benchmark results)
booth_inspect_visual({
  projectId: string,
  target: { type: "take", takeId: string } | { type: "export", exportId: string },
  mode: "overview" | "zoom",          // max span calibrated by Battery 3B
  startSec?: number,                  // required for zoom
  endSec?: number,
  panels?: Array<"waveform" | "spectrogram" | "stereo_pan" | "loudness" | "cues">, // defaults from Battery 2
})
// Returns: { imagePath, startSec, endSec, durationSec, summaryTelemetry }
```

This keeps the tool lean, evidence-backed, and empirically calibrated—zero placebo, maximum signal.

---

## 8. Empirical Study Results & Implemented Production Spec (Completed 2026-11-26)

All 3 blinded phases (`70` total trials across Batteries 1–4, zero metadata leakage, external operator-only answer keys) were executed and scored automatically (`scripts/visual-bench/score*.py`):

### Summary Scorecard
- **Phase 1 — Battery 1 (Placebo Trap, `10 trials`):** Clean-control FPR **`0/4 (0.0%)`**, Defect recall **`6/6 (100%)`**, Class accuracy **`6/6 (100%)`**, Timestamp MAE **`0.009s`** (9 ms).
- **Phase 1 — Battery 2A (Stereo S1/S2/S3, `12 trials`):** **`100%` (48/48)** 5-way pan bin accuracy and **`100%` (6/6)** overlap detection across all 3 styles; `S1` (Split L/R waveforms) gave the tightest boundary timing (`0.035s` MAE).
- **Phase 1 — Mini-2B (Custom `F1` vs. Pure FFmpeg `F4`, `8 trials`):** Both achieved **`1.000` F1** and `0%` FPR; `F4` matched `F1` within `7 ms` (`0.026s` vs. `0.019s` MAE).
- **Phase 2 — Battery 3A (Continuous Loudness + Crossfed Pan JND, `12 trials`):** **`11/12 (91.7%)`** direction accuracy (`100%` and `0.15 dB` MAE for `|Δ dB| >= 1.7 dB`; empirical JND floor **`~1.5 dB`**); `L1` (Split L/R + Combined 300ms RMS) beat `L2` on loudness MAE (`0.17 dB` vs. `0.45 dB`) and exposed real `headphoneCrossfeed` bleed (`±0.01` acoustic pan index accuracy).
- **Phase 2 — Battery 3B (`5s / 15s / 45s / 180s` Compression Ladder, Pure FFmpeg, `16 trials`):** **`100%` recall, `0%` FPR, `0.02–0.07s` MAE** up through **`45s` (`29.2 px/s`)**. At **`180s` (`7.3 px/s`)**, a `3 ms` broadband click still survived (`0.32s` err) while `120 ms` dropouts and `150 ms` overlaps dropped below the pixel cliff (honestly marked `unresolvable`, `0%` FPR).
- **Phase 2 — Battery 3C (Audio-Only `A1` vs. DAW Cue Overlay `A2`, `6 trials`):** Confirmed `A2` is essential to catch `silent_tail_trap` mismatches (`0 ms` error on planned `-360 ms` vs. audible `+180 ms` gap).
- **Phase 3 — Battery 4 (Real-World Mix Synergy, 3 matched pairs):**
  - **Pair 1 (Ears-Only):** **`0/2`** (`unresolvable`—mono downmix blinded stereo pan + missed smooth `150 ms` room-tone dropout).
  - **Pair 2 (Eyes-Only + Prosody Probe):** **`2/3`** technical flaws (`0.00s` err on `-4.5 dB` dip and `-260 ms` collision; missed subtle whisper-EQ `7.5 kHz` sibilance at 20s) + nailed unvoiced `<sigh>` breath intake visually (`0.07s` err), while acting intensity & grammatical pitch intent stayed squarely with ears.
  - **Pair 3 (Multimodal Ears + Eyes):** **`4/4 (100%)`**—ears caught the emotional delivery mismatch (`cue_03`), while eyes caught `wrong_pan`, `-4.0 dB` loudness dip, and the `7.00s` micro-click (`0.00s` err) missed by ear.

### Implemented Production Architecture (`src/audio/visualize.ts`, `booth_inspect_visual`)
- **Default `preset: "master"` (4-panel `1600×900` PNG via pure TS DSP + SVG + `@resvg/resvg-js`, zero Python):**
  1. DAW Cue Overlay (`A2`) from `timeline.ts`
  2. Split L / R Peak-Preserving Waveforms (`S1`)
  3. Split L / R + Combined `300 ms` RMS Contour (`L1`, `3 dB` dashed grid)
  4. `50 Hz – 16 kHz` `magma` Log-Mel Spectrogram (`-80..0 dBFS` colorbar)
- **Fast Path `preset: "fast"`:** Single-pass pure FFmpeg (`showwavespic split_channels=1` + `showspectrumpic`, pixel-aligned `1600×900`).
- **Windowing & Guardrails:** `mode: "zoom"` capped at `<= 45s` (`>= 30 px/s`); `mode: "overview"` supports `180s+` with an explicit pixel-cliff warning below `30 px/s`; tool docs instruct agents to inspect `1–2` charts per turn and pair ears + eyes on final mixes.
