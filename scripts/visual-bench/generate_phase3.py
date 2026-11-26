#!/usr/bin/env python3
"""
Visual-Audio Psychophysics & Anti-Placebo Study — Phase 3 (Battery 4: Real-World Studio Synergy)

Generates 3 matched real-world Booth multi-speaker mix pairs (6 mixes total, 18-24s each)
using real multi-speaker takes and exact Booth Stage-2 DSP (autoLevel gentle, curated EQ,
constant-power pan + headphoneCrossfeed, warm_dark room tone at -54 dBFS, -1.5 dBTP alimiter):

  - Pair 1 (Ears-Only):   2x .ogg ONLY in `phase3/pair1_ears_only/` (no PNGs)
                          Clean vs Flawed (wrong-side pan on Cue 3 + 150ms dead-air dropout)
  - Pair 2 (Eyes-Only):   2x 1600x900 winning-layout PNGs ONLY in `phase3/pair2_eyes_only/`
                          (backing .ogg held back in operator-only private dir until after grading!)
                          Clean vs Flawed (Cue 2 -4.5 dB under-leveled + -260ms collision + 7.5 kHz sibilance)
                          + Exploratory Prosody Bonus Probe (rising question / audible sigh / highest aggression)
  - Pair 3 (Multimodal):  2x (.ogg + winning 1600x900 PNG) in `phase3/pair3_multimodal/`
                          Clean vs Flawed (ears-best emotional delivery mismatch + eyes-best wrong-side pan,
                          -4.0 dB loudness dip, and 2.5ms micro-click).

Zero metadata leakage:
  - PNG text/EXIF chunks scrubbed via Pillow.
  - OGG files encoded cleanly with zero metadata tags (`-map_metadata -1`).
  - Clean vs Flawed slot order randomized per pair with `--seed`.
  - Operator-only ground truth written to `--key-out` (outside TheBooth/).
"""

from __future__ import annotations

import argparse
import io
import json
import math
import random
import sys
import tempfile
from pathlib import Path
from typing import Any

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate as p1
import generate_phase2 as p2

SR = p1.SR
CANVAS_W = p1.CANVAS_W
CANVAS_H = p1.CANVAS_H
DPI = p1.DPI
REPO_ROOT = p1.REPO_ROOT

BG_FIG = p1.BG_FIG
BG_AX = p1.BG_AX
FG_TEXT = p1.FG_TEXT
FG_MUTED = p1.FG_MUTED
GRID_MAJOR = p1.GRID_MAJOR
CYAN = p1.CYAN
AMBER = p1.AMBER
MAGENTA = p1.MAGENTA


# Exact paths to our real Booth takes
TAKES = {
    "speaker_a_playful_m4": REPO_ROOT / "data/projects/sample_scene_b/takes/take_73deb885a6e1.wav",
    "speaker_a_keeping":    REPO_ROOT / "data/projects/sample_scene_b/takes/take_730438f1bfe2.wav",
    "speaker_a_whisper_1":  REPO_ROOT / "data/projects/sample_scene_a/takes/take_b0cd7f10a9ec.wav",
    "speaker_a_whisper_2":  REPO_ROOT / "data/projects/sample_scene_a/takes/take_2298f11a53a9.wav",
    "speaker_a_lean":       REPO_ROOT / "data/projects/sample_scene_a/takes/take_314ade53cf26.wav",
    "margaux_print":    REPO_ROOT / "data/projects/sample_scene_a/takes/take_a82bec9c4681.wav",
    "margaux_question": REPO_ROOT / "data/projects/sample_scene_b/takes/take_a3473eda8bf2.wav",
    "margaux_cut":      REPO_ROOT / "data/projects/sample_scene_a/takes/take_afc043b7adc4.wav",
    "margaux_monolog":  REPO_ROOT / "data/projects/sample_scene_b/takes/take_8edd80efc73d.wav",
    "sulafat_sigh":     REPO_ROOT / "data/projects/sample_stereo_test/takes/take_d816066ee5e2.wav",
    "sulafat_intro":    REPO_ROOT / "data/projects/headphone_smoke_test/takes/take_8e138cc3d0c5.wav",
    "sulafat_line2":    REPO_ROOT / "data/projects/sample_stereo_test/takes/take_8f85bebf0384.wav",
}


# Booth Stage-2 EQ presets (matching src/audio/eq.ts)
EQ_FILTERS = {
    "neutral": "highpass=f=70:poles=2",
    "intimate": "highpass=f=65:poles=2,equalizer=f=180:t=q:w=0.9:g=2.0,equalizer=f=3200:t=q:w=1.8:g=-1.5,highshelf=f=9000:g=1.0",
    "whisper": "highpass=f=85:poles=2,lowpass=f=8500:poles=1,equalizer=f=220:t=q:w=0.9:g=1.5",
    "radio": "highpass=f=280:poles=2,lowpass=f=3800:poles=2,equalizer=f=1800:t=q:w=1.2:g=3.0",
}


def apply_booth_eq(mono: np.ndarray, preset: str) -> np.ndarray:
    af = EQ_FILTERS.get(preset, EQ_FILTERS["neutral"])
    pcm = p1.run_ffmpeg(
        [
            "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0",
            "-af", af,
            "-f", "f32le", "pipe:1",
        ],
        stdin_bytes=mono.astype(np.float32).tobytes(),
    )
    y = np.frombuffer(pcm, dtype=np.float32).copy()
    if len(y) < len(mono):
        y = np.pad(y, (0, len(mono) - len(y)))
    return y[: len(mono)]


def apply_booth_limiter(stereo: np.ndarray, ceiling_db: float = -1.5) -> np.ndarray:
    """Exact Stage-2 Booth alimiter (`level=disabled`, ceiling -1.5 dBTP)."""
    lin = max(0.0625, min(1.0, 10.0 ** (ceiling_db / 20.0)))
    pcm = p1.run_ffmpeg(
        [
            "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "pipe:0",
            "-af", f"alimiter=limit={lin:.6f}:attack=5:release=50:level=disabled",
            "-f", "f32le", "pipe:1",
        ],
        stdin_bytes=stereo.astype(np.float32).tobytes(),
    )
    y = np.frombuffer(pcm, dtype=np.float32).copy().reshape(-1, 2)
    return y[: stereo.shape[0]]


def export_clean_ogg(stereo: np.ndarray, out_path: Path) -> None:
    """Encode 48 kHz stereo Opus OGG with zero metadata tags (`-map_metadata -1`)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        wav_p = Path(td) / "in.wav"
        p1.write_wav_file(wav_p, stereo)
        p1.run_ffmpeg([
            "-y", "-i", str(wav_p),
            "-map_metadata", "-1",
            "-c:a", "libopus", "-b:a", "128k", "-vbr", "on", "-ar", str(SR), "-ac", "2",
            str(out_path),
        ])


def slice_take(path: Path, max_sec: float | None = None, trim_edges: bool = True) -> np.ndarray:
    arr = p1.load_take_mono_48k(path)
    if max_sec is not None:
        arr = arr[: int(round(max_sec * SR))].copy()
    if trim_edges:
        arr = p2.trim_silence_edges(arr, thresh_db=-36.0)
    return arr


def mix_booth_scene(
    cues: list[dict[str, Any]],
    rng: random.Random,
    tail_sec: float = 1.6,
    lead_sec: float = 0.65,
    post_effects: list[dict[str, Any]] | None = None,
) -> tuple[np.ndarray, list[dict[str, Any]], list[tuple[float, float]]]:
    """
    Mix a multi-cue Booth stereo scene using exact Booth Stage-2 rules:
      EQ -> active RMS leveling (-20 dBFS working target + cue gainDb) -> cosine fades ->
      constant-power pan + headphoneCrossfeed -> timeline placement -> warm_dark room tone (-54 dBFS) ->
      optional injected flaws -> -1.5 dBTP alimiter.
    Returns (stereo_48k, resolved_cues, pause_spans).
    """
    # Resolve cue timeline first
    resolved: list[dict[str, Any]] = []
    pauses: list[tuple[float, float]] = []
    cursor = lead_sec
    prepared_stems: list[tuple[dict[str, Any], np.ndarray]] = []

    for i, c in enumerate(cues):
        mono = c["audio"].copy()
        mono = apply_booth_eq(mono, c.get("eqPreset", "intimate"))
        # Working loudness target (-20 dBFS + artistic gainDb)
        target_rms = c.get("targetRmsDbfs", -20.0) + float(c.get("gainDb", 0.0))
        mono = p1.active_rms_normalize(mono, target_rms)

        # Optional per-cue sibilance defect injection BEFORE panning
        if c.get("injectSibilance"):
            t_sib = p1.find_peak_sibilance_time(mono, margin_sec=0.45)
            mono, s0, s1 = p1.inject_sibilance_spike(mono, t_sib, duration_sec=0.42, gain_db=11.0, fc=7500.0, q=4.0)
            c["_sibLocalCenterSec"] = 0.5 * (s0 + s1)

        mono = p1.apply_cosine_fades(mono, 20.0, 30.0)
        stereo_stem = p2.pan_with_headphone_crossfeed(mono, float(c["pan"]), headphone_crossfeed=True)

        offset_sec = float(c.get("offsetMs", 0.0)) / 1000.0
        start_sec = lead_sec if i == 0 else max(0.1, cursor + offset_sec)
        dur_sec = len(stereo_stem) / SR
        end_sec = start_sec + dur_sec

        if i > 0 and start_sec > cursor + 0.25:
            pauses.append((cursor, start_sec))

        info = {
            "id": c["id"],
            "speaker": c["speaker"],
            "plannedPan": c.get("plannedPan", c["pan"]),
            "actualPan": c["pan"],
            "gainDb": c.get("gainDb", 0.0),
            "startSec": round(start_sec, 3),
            "endSec": round(end_sec, 3),
            "durationSec": round(dur_sec, 3),
        }
        if "_sibLocalCenterSec" in c:
            info["sibilanceSec"] = round(start_sec + c["_sibLocalCenterSec"], 3)
        resolved.append(info)
        prepared_stems.append((info, stereo_stem))
        cursor = end_sec

    total_sec = round(max(r["endSec"] for r in resolved) + tail_sec, 2)
    n_total = int(round(total_sec * SR))
    stereo = p1.generate_warm_dark_room_tone(
        total_sec, -54.0, 2,
        rng.randint(1000, 999999), rng.randint(1000, 999999),
    )

    for info, stem in prepared_stems:
        s0 = int(round(info["startSec"] * SR))
        s1 = min(n_total, s0 + len(stem))
        stereo[s0:s1] += stem[: s1 - s0]

    # Apply post-mix defects (e.g. pause dropout, micro-click)
    for eff in (post_effects or []):
        kind = eff["kind"]
        if kind == "dropout":
            t_c = eff["timestampSec"]
            d_l, d0, d1 = p1.inject_dropout(stereo[:, 0], t_c, duration_ms=eff.get("durationMs", 150.0), edge_ms=5.0)
            d_r, _, _ = p1.inject_dropout(stereo[:, 1], t_c, duration_ms=eff.get("durationMs", 150.0), edge_ms=5.0)
            stereo[:, 0] = d_l
            stereo[:, 1] = d_r
            eff["realizedStartSec"] = round(d0, 3)
            eff["realizedEndSec"] = round(d1, 3)
        elif kind == "click":
            t_c = eff["timestampSec"]
            c_l = p1.inject_click(stereo[:, 0], t_c, peak_dbfs=eff.get("peakDbfs", -5.0), width_ms=eff.get("widthMs", 2.5), rng=rng)
            diff = c_l - stereo[:, 0]
            stereo[:, 0] = c_l
            stereo[:, 1] = np.clip(stereo[:, 1] + diff, -0.999, 0.999)

    stereo = apply_booth_limiter(stereo, ceiling_db=-1.5)
    return stereo, resolved, pauses


def render_winning_booth_visual(
    stereo: np.ndarray,
    resolved_cues: list[dict[str, Any]],
    title: str,
    out_path: Path,
) -> None:
    """
    Production-candidate 4-panel visual chart calibrated from Phases 1 & 2 (1600x900):
      1) DAW Cue-Block Track (12%) — planned timeline spans + cue IDs
      2) Split L/R Waveforms (24%) — Cyan=L, Amber=R, peak-preserving
      3) 300ms Combined RMS Contour (18%) — -48..0 dBFS, 3 dB dashed grid
      4) Log-Mel Spectrogram (46%) — 50 Hz - 16 kHz, magma, -80..0 dBFS colorbar
    Note: Cue boxes show neutral cue IDs + planned speaker/pan ONLY (zero defect leakage!).
    """
    duration = stereo.shape[0] / SR
    rm = p2.compute_short_term_rms_db(stereo, win_ms=300.0, hop_ms=20.0)

    fig = plt.figure(figsize=(CANVAS_W / DPI, CANVAS_H / DPI), dpi=DPI, facecolor=BG_FIG)
    gs = fig.add_gridspec(
        nrows=5, ncols=2,
        height_ratios=[11, 13, 13, 18, 45],
        width_ratios=[96, 2.2],
        left=0.075, right=0.935, top=0.925, bottom=0.078,
        hspace=0.08, wspace=0.015,
    )
    ax_cue = fig.add_subplot(gs[0, 0], facecolor=BG_AX)
    ax_l = fig.add_subplot(gs[1, 0], facecolor=BG_AX)
    ax_r = fig.add_subplot(gs[2, 0], facecolor=BG_AX)
    ax_rms = fig.add_subplot(gs[3, 0], facecolor=BG_AX)
    ax_s = fig.add_subplot(gs[4, 0], facecolor=BG_AX)
    ax_cb = fig.add_subplot(gs[4, 1], facecolor=BG_FIG)

    fig.suptitle(title, color=FG_TEXT, fontsize=17, fontweight="bold", y=0.972)

    # 1) DAW Cue-Block Track (2 alternating lanes so any overlap pops immediately)
    ax_cue.set_ylim(0.0, 2.2)
    ax_cue.set_yticks([0.55, 1.65])
    ax_cue.set_yticklabels(["Lane B", "Lane A"], fontsize=10, color=FG_MUTED)
    for idx, c in enumerate(resolved_cues):
        lane_y = 1.22 if idx % 2 == 0 else 0.14
        col = CYAN if c["plannedPan"] <= 0 else AMBER
        w = max(0.05, c["endSec"] - c["startSec"])
        rect = FancyBboxPatch(
            (c["startSec"], lane_y), w, 0.84,
            boxstyle="round,pad=0.02,rounding_size=0.06",
            facecolor=col, edgecolor="#f8fafc", alpha=0.35, linewidth=1.4,
        )
        ax_cue.add_patch(rect)
        ax_cue.text(
            c["startSec"] + 0.08, lane_y + 0.42,
            f"{c['id']} [{c['speaker']}]  ({c['startSec']:.2f}-{c['endSec']:.2f}s)",
            color=FG_TEXT, fontsize=9.8, fontweight="bold", va="center",
        )
    ax_cue.set_ylabel("Cues", color=FG_TEXT, fontsize=11.5, fontweight="bold")
    p1.style_time_axis(ax_cue, duration, show_xlabel=False)

    # 2) Split L/R Waveforms
    for ax, ch, col, lbl in [(ax_l, stereo[:, 0], CYAN, "Left (L)"), (ax_r, stereo[:, 1], AMBER, "Right (R)")]:
        wt, wmin, wmax = p1.compute_waveform_envelope(ch, n_bins=1600)
        ax.fill_between(wt, wmin, wmax, color=col, alpha=0.9, linewidth=0)
        ax.axhline(0.0, color="#475569", linewidth=0.7)
        ax.set_ylim(-1.05, 1.05)
        ax.set_yticks([-0.5, 0.0, 0.5])
        ax.set_yticklabels(["-0.5", "0", "+0.5"], fontsize=10, color=FG_TEXT)
        ax.set_ylabel(lbl, color=col, fontsize=11.5, fontweight="bold")
        ax.grid(True, which="major", axis="y", color=GRID_MAJOR, linewidth=0.6, alpha=0.65)
        p1.style_time_axis(ax, duration, show_xlabel=False)

    # 3) Short-Term 300ms RMS Contour (-48..0 dBFS, 3 dB dashed grid)
    t = rm["times"]
    ax_rms.fill_between(t, -48.0, np.clip(rm["total_db"], -48.0, 0.0), color=CYAN, alpha=0.14)
    ax_rms.plot(t, np.clip(rm["total_db"], -48.0, 0.0), color="#f8fafc", linewidth=2.0)
    ax_rms.set_ylim(-48.0, 0.0)
    ax_rms.set_yticks([-48, -36, -24, -12, 0])
    ax_rms.set_yticks(list(range(-45, 0, 3)), minor=True)
    ax_rms.set_yticklabels(["-48", "-36", "-24", "-12", "0 dB"], fontsize=10.5, color=FG_TEXT)
    ax_rms.set_ylabel("RMS 300ms", color=FG_TEXT, fontsize=11.5, fontweight="bold")
    ax_rms.grid(True, which="major", axis="y", color="#3b4758", linewidth=0.9, alpha=0.85)
    ax_rms.grid(True, which="minor", axis="y", color="#232c3a", linewidth=0.55, linestyle="--", alpha=0.75)
    p1.style_time_axis(ax_rms, duration, show_xlabel=False)

    # 4) Log-Mel Spectrogram
    mono = 0.5 * (stereo[:, 0] + stereo[:, 1])
    mel_db, _, mel_hz = p1.compute_log_mel_db(mono, n_fft=1024, hop=128, n_mels=128, fmin=50.0, fmax=16000.0)
    im = ax_s.imshow(
        mel_db, origin="lower", aspect="auto",
        extent=[0.0, duration, 0, len(mel_hz) - 1],
        cmap="magma", vmin=-80.0, vmax=0.0, interpolation="nearest",
    )
    freq_ticks = [100, 250, 500, 1000, 2000, 4000, 8000, 16000]
    freq_labels = ["100 Hz", "250 Hz", "500 Hz", "1 kHz", "2 kHz", "4 kHz", "8 kHz", "16 kHz"]
    ax_s.set_yticks([float(np.interp(f, mel_hz, np.arange(len(mel_hz)))) for f in freq_ticks])
    ax_s.set_yticklabels(freq_labels, fontsize=11, color=FG_TEXT)
    ax_s.set_ylabel("Log-Mel (Hz)", color=FG_TEXT, fontsize=12, fontweight="bold")
    ax_s.grid(True, which="major", axis="y", color="#ffffff", linewidth=0.45, alpha=0.22)
    p1.style_time_axis(ax_s, duration, show_xlabel=True)

    cbar = fig.colorbar(im, cax=ax_cb)
    cbar.set_ticks([-80, -60, -40, -24, -12, 0])
    cbar.set_ticklabels(["-80", "-60", "-40", "-24", "-12", "0 dB"])
    cbar.ax.tick_params(colors=FG_TEXT, labelsize=10.5)
    cbar.set_label("Level (dBFS)", color=FG_TEXT, fontsize=11.5, fontweight="bold")
    cbar.outline.set_edgecolor("#3b4758")

    p1.save_clean_png_from_figure(fig, out_path)


# ---------------------------------------------------------------------------
# Build the 3 Matched Pairs
# ---------------------------------------------------------------------------

def build_pair_1_ears_only(
    rng: random.Random,
    out_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Pair 1 (Ears-Only, .ogg ONLY):
      3-cue scene using neutral-text takes (ZERO spatial words spoken!).
      Clean mix vs Flawed mix (Cue 3 panned +0.70 Right instead of -0.50 Left + 150ms dead-air dropout).
    """
    a1 = slice_take(TAKES["speaker_a_playful_m4"], max_sec=7.5)
    a2 = slice_take(TAKES["margaux_print"], max_sec=8.5)
    a3 = slice_take(TAKES["speaker_a_keeping"], max_sec=4.2)

    def make_cues(flawed: bool) -> list[dict[str, Any]]:
        return [
            {"id": "cue_01", "speaker": "speaker_a",   "audio": a1, "offsetMs": 0,   "plannedPan": -0.50, "pan": -0.50, "gainDb": 0.0, "eqPreset": "intimate"},
            {"id": "cue_02", "speaker": "margaux", "audio": a2, "offsetMs": 900, "plannedPan": +0.55, "pan": +0.55, "gainDb": 0.0, "eqPreset": "intimate"},
            {"id": "cue_03", "speaker": "speaker_a",   "audio": a3, "offsetMs": 700, "plannedPan": -0.50, "pan": +0.70 if flawed else -0.50, "gainDb": 0.0, "eqPreset": "intimate"},
        ]

    # Randomize slot order (which mix is clean vs flawed)
    order = [False, True]
    rng.shuffle(order)

    p1_dir = out_dir / "pair1_ears_only"
    p1_dir.mkdir(parents=True, exist_ok=True)
    mixes_gt = []

    for idx, is_flawed in enumerate(order, start=1):
        mix_id = f"b4_p1_mix{idx}"
        cues = make_cues(is_flawed)
        # First pass to get exact pause midpoint between cue_01 and cue_02
        _, res_tmp, pauses_tmp = mix_booth_scene(cues, rng)
        post_effs = []
        flaws = []
        if is_flawed:
            drop_t = round(0.5 * (pauses_tmp[0][0] + pauses_tmp[0][1]), 3) if pauses_tmp else 7.8
            post_effs.append({"kind": "dropout", "timestampSec": drop_t, "durationMs": 150.0})
            flaws = [
                {"type": "wrong_pan", "cueId": "cue_03", "plannedPan": -0.50, "actualPan": +0.70, "modality": "eyes_only_due_to_mono_downmix"},
                {"type": "dropout", "timestampSec": drop_t, "durationMs": 150.0, "edgeFadeMs": 5.0, "modality": "both_subtle_by_ear"},
            ]
        stereo, resolved, _ = mix_booth_scene(cues, rng, post_effects=post_effs)
        ogg_path = p1_dir / f"{mix_id}.ogg"
        export_clean_ogg(stereo, ogg_path)
        mixes_gt.append({
            "mixId": mix_id,
            "audioFile": f"pair1_ears_only/{mix_id}.ogg",
            "isClean": not is_flawed,
            "durationSec": round(stereo.shape[0] / SR, 2),
            "cues": resolved,
            "flaws": flaws,
        })

    brief = {
        "pair": "pair1_ears_only",
        "modality": "ears_only",
        "files": [m["audioFile"] for m in mixes_gt],
        "scriptBrief": [
            {"cueId": "cue_01", "speaker": "speaker_a",   "intendedPan": -0.50, "intendedMood": "playful, bright"},
            {"cueId": "cue_02", "speaker": "margaux", "intendedPan": +0.55, "intendedMood": "hushed, impressed"},
            {"cueId": "cue_03", "speaker": "speaker_a",   "intendedPan": -0.50, "intendedMood": "amused, admiring"},
        ],
        "task": "Listen to both .ogg files ONLY. Identify which mix is clean vs flawed, list every technical or delivery flaw you can hear (with approximate timestamps), and note anything you CANNOT verify by ear.",
    }
    return {"pair": "pair1_ears_only", "mixes": mixes_gt}, brief


def build_pair_2_eyes_only(
    rng: random.Random,
    out_dir: Path,
    holdback_audio_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Pair 2 (Eyes-Only, PNG ONLY — audio held back in operator private folder!):
      3 distinct prosody-contrasting takes shuffled into cue_01..cue_03:
        - Rising-pitch question take (`margaux_question`, 7.29s: "...on the first take?")
        - Audible sigh/breath take (`sulafat_sigh`, 5.70s: "...third line. <sigh> Tell us...")
        - Highest-intensity sharp aggressive take (`margaux_cut` first 4.8s: "Cut! Darling, stop tapping...")
      Flawed mix injects:
        1) Cue 2 under-leveled by -4.5 dB
        2) Accidental -260ms overlap collision between Cue 2 and Cue 3
        3) Harsh +11 dB 7.5 kHz sibilance spike on Cue 3
    """
    prosody_items = [
        {
            "role": "rising_question",
            "speaker": "speaker_a",
            "audio": slice_take(TAKES["margaux_question"], max_sec=7.2),
            "targetRmsDbfs": -20.0,
            "eqPreset": "intimate",
            "prosodyDetail": "Rising pitch question on 'on the first take?' (~3.1-3.8s into cue)",
            "localFeatureSec": 3.45,
        },
        {
            "role": "audible_sigh",
            "speaker": "speaker_b",
            "audio": slice_take(TAKES["sulafat_sigh"], max_sec=5.7),
            "targetRmsDbfs": -21.5,
            "eqPreset": "whisper",
            "prosodyDetail": "Prominent audible <sigh> breath intake (~2.2-2.9s into cue)",
            "localFeatureSec": 2.55,
        },
        {
            "role": "highest_intensity",
            "speaker": "speaker_c",
            "audio": slice_take(TAKES["margaux_cut"], max_sec=4.6),
            "targetRmsDbfs": -17.5,  # genuinely highest vocal energy & sharpest 'Cut!' attack
            "eqPreset": "intimate",
            "prosodyDetail": "Fierce, sharp commanding attack ('Cut! Darling, stop tapping...') with highest intensity",
            "localFeatureSec": 0.30,
        },
    ]
    # Shuffle cue ordering so prosody answers aren't predictable by position!
    rng.shuffle(prosody_items)
    pans = [-0.55, +0.55, -0.45]

    def make_cues(flawed: bool) -> list[dict[str, Any]]:
        out = []
        for idx, item in enumerate(prosody_items):
            cid = f"cue_0{idx+1}"
            off_ms = 0 if idx == 0 else (750 if idx == 1 else (-260 if flawed else 750))
            gain_db = -4.5 if (flawed and idx == 1) else 0.0
            out.append({
                "id": cid,
                "speaker": item["speaker"],
                "audio": item["audio"],
                "offsetMs": off_ms,
                "plannedPan": pans[idx],
                "pan": pans[idx],
                "gainDb": gain_db,
                "targetRmsDbfs": item["targetRmsDbfs"],
                "eqPreset": item["eqPreset"],
                "injectSibilance": bool(flawed and idx == 2),
                "_prosodyRole": item["role"],
                "_prosodyDetail": item["prosodyDetail"],
                "_localFeatureSec": item["localFeatureSec"],
            })
        return out

    order = [False, True]
    rng.shuffle(order)

    p2_dir = out_dir / "pair2_eyes_only"
    p2_dir.mkdir(parents=True, exist_ok=True)
    holdback_audio_dir.mkdir(parents=True, exist_ok=True)
    mixes_gt = []
    prosody_gt = {}

    for idx, is_flawed in enumerate(order, start=1):
        mix_id = f"b4_p2_mix{idx}"
        cues = make_cues(is_flawed)
        stereo, resolved, _ = mix_booth_scene(cues, rng)

        png_path = p2_dir / f"{mix_id}.png"
        render_winning_booth_visual(stereo, resolved, f"Battery 4 — Pair 2: {mix_id.upper()}", png_path)

        # Hold back audio in private directory so the operator can verify prosody predictions after Eyes-Only!
        holdback_ogg = holdback_audio_dir / f"{mix_id}.ogg"
        export_clean_ogg(stereo, holdback_ogg)

        flaws = []
        if is_flawed:
            flaws = [
                {"type": "under_leveled", "cueId": "cue_02", "deltaDb": -4.5, "startSec": resolved[1]["startSec"], "endSec": resolved[1]["endSec"]},
                {"type": "overlap_collision", "between": ["cue_02", "cue_03"], "overlapMs": -260, "startSec": resolved[2]["startSec"], "endSec": resolved[1]["endSec"]},
                {"type": "sibilance", "cueId": "cue_03", "timestampSec": resolved[2].get("sibilanceSec"), "fcHz": 7500, "gainDb": 11.0},
            ]
        else:
            # Record clean-mix exact timestamps for the Exploratory Prosody Bonus Probe!
            for c_in, c_res in zip(cues, resolved):
                prosody_gt[c_in["_prosodyRole"]] = {
                    "cueId": c_res["id"],
                    "approxTimestampSec": round(c_res["startSec"] + c_in["_localFeatureSec"], 2),
                    "cueStartSec": c_res["startSec"],
                    "cueEndSec": c_res["endSec"],
                    "detail": c_in["_prosodyDetail"],
                }

        mixes_gt.append({
            "mixId": mix_id,
            "visualFile": f"pair2_eyes_only/{mix_id}.png",
            "holdbackAudioFile": str(holdback_ogg),
            "isClean": not is_flawed,
            "durationSec": round(stereo.shape[0] / SR, 2),
            "cues": resolved,
            "flaws": flaws,
        })

    brief = {
        "pair": "pair2_eyes_only",
        "modality": "eyes_only",
        "files": [m["visualFile"] for m in mixes_gt],
        "scriptBrief": [
            {"cueId": "cue_01", "intendedPan": pans[0], "intendedSpacing": "clean pauses (~0.75s), no overlaps, balanced levels"},
            {"cueId": "cue_02", "intendedPan": pans[1], "intendedSpacing": "clean pauses (~0.75s), no overlaps, balanced levels"},
            {"cueId": "cue_03", "intendedPan": pans[2], "intendedSpacing": "clean pauses (~0.75s), no overlaps, balanced levels"},
        ],
        "task": "Inspect BOTH PNGs ONLY (no audio). (1) Identify which mix is clean vs flawed and list every technical flaw with cue ID & timestamp. (2) Exploratory Prosody Bonus Probe on the CLEAN mix: purely from the spectrogram & waveform, predict which cue (cue_01/cue_02/cue_03) and approximate timestamp has: (a) rising-pitch question inflection, (b) sharpest audible breath/sigh intake, and (c) highest vocal intensity / fiercest attack.",
    }
    return {"pair": "pair2_eyes_only", "mixes": mixes_gt, "prosodyGroundTruth": prosody_gt}, brief


def build_pair_3_multimodal(
    rng: random.Random,
    out_dir: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Pair 3 (Multimodal — BOTH .ogg AND winning 1600x900 PNG together!):
      Tests true Eyes + Ears complementarity on a 3-cue scene (~20s):
        - Clean mix: Quiet, hushed, intimate 3-cue exchange (Sulafat calm intro L, Margaux hushed print R, Speaker A velvety whisper L)
        - Flawed mix combines:
            1) EARS-BEST acting/delivery flaw: Cue 3 swaps out the velvety hushed whisper take for a bright, chuckling playful take
               (violating the script brief's 'hushed, barely above a whisper, quiet bedtime intimacy'—trivial by ear, subtle/ambiguous by eye!)
            2) EYES-BEST flaw #1: Cue 3 panned to WRONG side (+0.65 Right instead of -0.50 Left)
            3) EYES-BEST flaw #2: Cue 2 under-leveled by -4.0 dB
            4) EYES-BEST flaw #3: Subtle 2.5ms -5 dBFS digital micro-click inside the pause between Cue 1 and Cue 2
    """
    c1_clean = slice_take(TAKES["sulafat_intro"], max_sec=6.2)
    c2_clean = slice_take(TAKES["margaux_monolog"], max_sec=6.8)
    c3_hushed = slice_take(TAKES["speaker_a_whisper_1"], max_sec=6.0)
    c3_wrong_delivery = slice_take(TAKES["speaker_a_playful_m4"], max_sec=6.0)  # bright chuckling mismatch!

    def make_cues(flawed: bool) -> list[dict[str, Any]]:
        return [
            {"id": "cue_01", "speaker": "narrator", "audio": c1_clean, "offsetMs": 0,   "plannedPan": -0.45, "pan": -0.45, "gainDb": 0.0, "eqPreset": "intimate"},
            {"id": "cue_02", "speaker": "margaux",  "audio": c2_clean, "offsetMs": 950, "plannedPan": +0.50, "pan": +0.50, "gainDb": -4.0 if flawed else 0.0, "eqPreset": "intimate"},
            {
                "id": "cue_03", "speaker": "speaker_a",
                "audio": c3_wrong_delivery if flawed else c3_hushed,
                "offsetMs": 850,
                "plannedPan": -0.50,
                "pan": +0.65 if flawed else -0.50,
                "gainDb": 0.0,
                "eqPreset": "intimate" if flawed else "whisper",
            },
        ]

    order = [False, True]
    rng.shuffle(order)

    p3_dir = out_dir / "pair3_multimodal"
    p3_dir.mkdir(parents=True, exist_ok=True)
    mixes_gt = []

    for idx, is_flawed in enumerate(order, start=1):
        mix_id = f"b4_p3_mix{idx}"
        cues = make_cues(is_flawed)
        _, _, pauses_tmp = mix_booth_scene(cues, rng)
        post_effs = []
        flaws = []
        if is_flawed:
            click_t = round(0.5 * (pauses_tmp[0][0] + pauses_tmp[0][1]), 3) if pauses_tmp else 7.2
            post_effs.append({"kind": "click", "timestampSec": click_t, "peakDbfs": -5.0, "widthMs": 2.5})
            flaws = [
                {"type": "delivery_mismatch", "cueId": "cue_03", "detail": "Bright chuckling/playful take instead of requested hushed velvety whisper", "modality": "ears_best"},
                {"type": "wrong_pan", "cueId": "cue_03", "plannedPan": -0.50, "actualPan": +0.65, "modality": "eyes_only"},
                {"type": "under_leveled", "cueId": "cue_02", "deltaDb": -4.0, "modality": "eyes_best"},
                {"type": "click", "timestampSec": click_t, "peakDbfs": -5.0, "widthMs": 2.5, "modality": "eyes_and_ears"},
            ]
        stereo, resolved, _ = mix_booth_scene(cues, rng, post_effects=post_effs)
        ogg_path = p3_dir / f"{mix_id}.ogg"
        png_path = p3_dir / f"{mix_id}.png"
        export_clean_ogg(stereo, ogg_path)
        render_winning_booth_visual(stereo, resolved, f"Battery 4 — Pair 3: {mix_id.upper()}", png_path)

        mixes_gt.append({
            "mixId": mix_id,
            "audioFile": f"pair3_multimodal/{mix_id}.ogg",
            "visualFile": f"pair3_multimodal/{mix_id}.png",
            "isClean": not is_flawed,
            "durationSec": round(stereo.shape[0] / SR, 2),
            "cues": resolved,
            "flaws": flaws,
        })

    brief = {
        "pair": "pair3_multimodal",
        "modality": "multimodal",
        "files": [{"audio": m["audioFile"], "visual": m["visualFile"]} for m in mixes_gt],
        "scriptBrief": [
            {"cueId": "cue_01", "speaker": "narrator", "intendedPan": -0.45, "intendedMood": "warm, calm, settling in"},
            {"cueId": "cue_02", "speaker": "margaux",  "intendedPan": +0.50, "intendedMood": "close, smoky, commanding intimacy, balanced level"},
            {"cueId": "cue_03", "speaker": "speaker_a",    "intendedPan": -0.50, "intendedMood": "velvety, slow, barely above a whisper, quiet intimate close"},
        ],
        "task": "Use BOTH the .ogg audio AND the .png visual chart for each mix. Identify clean vs flawed, list EVERY flaw (acting/delivery AND technical/spatial/loudness/artifacts), and tag which modality caught each flaw (`ears` | `eyes` | `both`).",
    }
    return {"pair": "pair3_multimodal", "mixes": mixes_gt}, brief


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate blinded Phase 3 (Battery 4) real-mix studio synergy stimuli.")
    parser.add_argument("--seed", type=int, default=20261128, help="Deterministic RNG seed")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=REPO_ROOT / "data" / "visual_bench" / "phase3",
        help="Subject-visible directory for Phase 3",
    )
    parser.add_argument(
        "--key-out",
        type=Path,
        default=REPO_ROOT.parent / "visual_bench_private" / "phase3_answer_key.json",
        help="Operator-only private ground-truth answer key path",
    )
    args = parser.parse_args()

    out_dir = args.out_dir.resolve()
    key_out = args.key_out.resolve()
    holdback_dir = key_out.parent / "phase3_pair2_audio_holdback"

    try:
        key_out.relative_to(out_dir)
        raise SystemExit("ERROR: --key-out must NOT be inside --out-dir.")
    except ValueError:
        pass

    out_dir.mkdir(parents=True, exist_ok=True)
    key_out.parent.mkdir(parents=True, exist_ok=True)

    rng = random.Random(args.seed)

    p1_gt, p1_brief = build_pair_1_ears_only(rng, out_dir)
    print("Generated Pair 1 (Ears-Only):  2 OGGs")
    p2_gt, p2_brief = build_pair_2_eyes_only(rng, out_dir, holdback_dir)
    print("Generated Pair 2 (Eyes-Only):  2 PNGs (+ 2 holdback OGGs outside workspace)")
    p3_gt, p3_brief = build_pair_3_multimodal(rng, out_dir)
    print("Generated Pair 3 (Multimodal): 2 OGGs + 2 PNGs")

    # Neutral studio brief (NO ground truth, NO clean/flawed labels)
    briefs_path = out_dir / "studio_briefs.json"
    briefs_path.write_text(json.dumps({
        "study": "visual-audio-psychophysics-phase3-battery4",
        "pairs": [p1_brief, p2_brief, p3_brief],
    }, indent=2), encoding="utf-8")

    # Operator-only ground-truth key
    key_out.write_text(json.dumps({
        "study": "visual-audio-psychophysics-phase3-battery4",
        "seed": args.seed,
        "stimuliDir": str(out_dir),
        "pair2HoldbackAudioDir": str(holdback_dir),
        "pair1": p1_gt,
        "pair2": p2_gt,
        "pair3": p3_gt,
    }, indent=2), encoding="utf-8")

    print(f"Wrote Phase 3 stimuli + neutral brief to: {out_dir}")
    print(f"Wrote operator-only answer key to: {key_out}")


if __name__ == "__main__":
    main()
