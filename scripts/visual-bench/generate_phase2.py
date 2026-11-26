#!/usr/bin/env python3
"""
Visual-Audio Psychophysics & Anti-Placebo Study — Phase 2 (Battery 3: Upper-Bound Calibration)

Generates strictly blinded PNG stimuli to find Gemini 4 Vision's true perceptual ceilings:
  - Battery 3A (12 trials): Continuous arbitrary loudness shifts (0 to ±8 dB) + continuous arbitrary
                            stereo pans with real Booth headphone crossfeed (6x Style L1 Split L/R + RMS,
                            6x Style L2 Pan Ribbon + RMS).
  - Battery 3B (16 trials): Time-window compression ceiling ladder (5s / 15s / 45s / 180s at 1600x900)
                            across 4 conditions (clean, 3ms click, 120ms dropout, 150ms stereo overlap),
                            rendered with pure FFmpeg (`showwavespic split_channels=1` + `showspectrumpic`).
  - Battery 3C (6 trials):  Overlap & gap timing precision — Audio-Only (A1) vs DAW Cue-Block Overlay (A2),
                            including a silent-tail mismatch trap where planned box overlap != audible speech.

Zero metadata leakage:
  - Subject-visible directory receives ONLY opaque PNG files (`b3a_t01.png`, ...).
  - All PNG text/EXIF chunks are scrubbed via Pillow.
  - Operator-only ground truth written to `--key-out` (outside TheBooth/).
"""

from __future__ import annotations

import argparse
import io
import json
import math
import random
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
from matplotlib.collections import LineCollection
from matplotlib.colors import LinearSegmentedColormap, Normalize
from matplotlib.patches import FancyBboxPatch
import numpy as np
from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

# Import shared verified audio/plot primitives from Phase 1 generator
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate as p1

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
GRID_MINOR = p1.GRID_MINOR
CYAN = p1.CYAN
AMBER = p1.AMBER
GREEN = "#4ade80"


# ---------------------------------------------------------------------------
# Booth-Exact Stereo Pan with Headphone Crossfeed (matching src/audio/pan.ts)
# ---------------------------------------------------------------------------

def pan_with_headphone_crossfeed(mono: np.ndarray, pan: float, headphone_crossfeed: bool = True) -> np.ndarray:
    """
    Exact Python/FFmpeg port of src/audio/pan.ts:
      constant-power pan + optional opposite-ear crossfeed (~16%*|pan|, 0.25-0.45ms ITD, 4kHz 1-pole LPF).
    """
    clamped = max(-1.0, min(1.0, float(pan)))
    g_l, g_r = p1.constant_power_gains(clamped)
    abs_pan = abs(clamped)

    if not headphone_crossfeed or abs_pan <= 0.01:
        out = np.empty((len(mono), 2), dtype=np.float32)
        out[:, 0] = mono * np.float32(g_l)
        out[:, 1] = mono * np.float32(g_r)
        return out

    crossfeed_ratio = 0.16 * abs_pan
    itd_ms = 0.25 + 0.20 * abs_pan
    itd_samples = max(1, int(round((itd_ms / 1000.0) * SR)))
    energy_norm = 1.0 / math.sqrt(1.0 + crossfeed_ratio * crossfeed_ratio)

    dir_l = g_l * energy_norm
    dir_r = g_r * energy_norm
    xf_l = (g_r * crossfeed_ratio * energy_norm) if clamped > 0 else 0.0
    xf_r = (g_l * crossfeed_ratio * energy_norm) if clamped < 0 else 0.0

    # Simple 1-pole low-pass at 4 kHz (exact matched digital 1-pole)
    rc = 1.0 / (2.0 * math.pi * 4000.0)
    dt = 1.0 / SR
    alpha = dt / (rc + dt)
    lpf = np.empty(len(mono), dtype=np.float32)
    y_prev = 0.0
    # Vectorized via ffmpeg lowpass=f=4000:poles=1 for speed + exact Booth parity
    pcm = p1.run_ffmpeg(
        [
            "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0",
            "-af", f"lowpass=f=4000:poles=1",
            "-f", "f32le", "pipe:1",
        ],
        stdin_bytes=mono.astype(np.float32).tobytes(),
    )
    lpf = np.frombuffer(pcm, dtype=np.float32).copy()
    if len(lpf) < len(mono):
        lpf = np.pad(lpf, (0, len(mono) - len(lpf)))
    lpf = lpf[: len(mono)]

    delayed = np.zeros_like(lpf)
    if itd_samples < len(lpf):
        delayed[itd_samples:] = lpf[:-itd_samples]

    out = np.empty((len(mono), 2), dtype=np.float32)
    out[:, 0] = mono * np.float32(dir_l) + delayed * np.float32(xf_l)
    out[:, 1] = mono * np.float32(dir_r) + delayed * np.float32(xf_r)
    return out


def measure_active_rms_db(x: np.ndarray) -> float:
    """Measure active RMS dBFS of a mono or stereo signal (summed power over frames > -40 dBFS)."""
    if x.ndim == 2:
        mono_p = 0.5 * (x[:, 0].astype(np.float64) ** 2 + x[:, 1].astype(np.float64) ** 2)
    else:
        mono_p = x.astype(np.float64) ** 2
    win = int(0.05 * SR)
    nwin = len(mono_p) // win
    if nwin == 0:
        return -96.0
    fp = mono_p[: nwin * win].reshape(nwin, win).mean(axis=1)
    peak_p = float(np.max(fp) + 1e-12)
    active = fp[fp >= peak_p * (10.0 ** (-35.0 / 10.0))]
    mean_p = float(np.mean(active)) if len(active) > 0 else float(np.mean(fp))
    return 10.0 * math.log10(max(mean_p, 1e-12))


def trim_silence_edges(x: np.ndarray, thresh_db: float = -34.0) -> np.ndarray:
    """Trim leading and trailing quiet air so speech starts & ends crisply."""
    win = int(0.02 * SR)
    nwin = len(x) // win
    if nwin < 3:
        return x
    frames = x[: nwin * win].reshape(nwin, win)
    rms_db = 20.0 * np.log10(np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12))
    idx = np.where(rms_db > thresh_db)[0]
    if len(idx) == 0:
        return x
    s0 = max(0, int(idx[0]) * win - int(0.02 * SR))
    s1 = min(len(x), int(idx[-1] + 1) * win + int(0.02 * SR))
    return x[s0:s1].copy()


def build_long_speech_stream(
    takes: list[np.ndarray],
    rng: random.Random,
    target_sec: float,
    stereo_alternating: bool = False,
) -> tuple[np.ndarray, list[tuple[float, float]]]:
    """
    Build a continuous realistic speech stream of arbitrary duration (5s up to 180s)
    from real Booth takes separated by natural 0.45-1.1s pauses.
    Returns (audio_array, list_of_natural_pause_spans_sec).
    """
    n_total = int(round(target_sec * SR))
    out = np.zeros((n_total, 2), dtype=np.float32)
    pauses: list[tuple[float, float]] = []

    cursor_sec = rng.uniform(0.35, 0.70) if target_sec >= 10 else rng.uniform(0.18, 0.32)
    seg_idx = 0
    while cursor_sec < target_sec - 0.8:
        raw = rng.choice(takes)
        trimmed = trim_silence_edges(p1.active_rms_normalize(raw, -20.0), -36.0)
        # Choose a natural phrase length scaled lightly with total duration
        max_chunk = min(len(trimmed) / SR, 5.5 if target_sec >= 15 else 2.2)
        min_chunk = min(max_chunk, 1.4 if target_sec >= 15 else 0.9)
        chunk_sec = rng.uniform(min_chunk, max_chunk)
        n_chunk = min(len(trimmed), int(round(chunk_sec * SR)))
        if len(trimmed) > n_chunk + int(0.2 * SR):
            off = rng.randint(0, len(trimmed) - n_chunk)
            seg = trimmed[off : off + n_chunk].copy()
        else:
            seg = trimmed[:n_chunk].copy()
        seg = p1.apply_cosine_fades(seg, 20, 30)

        s0 = int(round(cursor_sec * SR))
        s1 = min(n_total - int(0.25 * SR), s0 + len(seg))
        if s1 - s0 < int(0.4 * SR):
            break
        seg = seg[: s1 - s0]

        if stereo_alternating:
            pan = rng.choice([-0.55, -0.35, 0.0, 0.35, 0.55]) if seg_idx % 2 == 0 else rng.choice([0.55, 0.35, 0.0, -0.35, -0.55])
        else:
            pan = 0.0
        g_l, g_r = p1.constant_power_gains(pan)
        out[s0:s1, 0] += seg * np.float32(g_l)
        out[s0:s1, 1] += seg * np.float32(g_r)

        end_sec = s1 / SR
        gap_sec = rng.uniform(0.45, 0.95) if target_sec >= 15 else rng.uniform(0.35, 0.55)
        next_start = end_sec + gap_sec
        if next_start < target_sec - 0.6 and gap_sec >= 0.32:
            pauses.append((end_sec, next_start))
        cursor_sec = next_start
        seg_idx += 1

    return out, pauses


# ---------------------------------------------------------------------------
# Phase 2 Renderers
# ---------------------------------------------------------------------------

def compute_short_term_rms_db(stereo: np.ndarray, win_ms: float = 300.0, hop_ms: float = 20.0) -> dict[str, np.ndarray]:
    """300ms sliding window RMS in dBFS (matching spec 3A) + gated pan index."""
    n = stereo.shape[0]
    win = int(round(win_ms * SR / 1000.0))
    hop = int(round(hop_ms * SR / 1000.0))
    pad = win // 2
    padded = np.pad(stereo.astype(np.float64), ((pad, pad), (0, 0)), mode="constant")
    n_frames = 1 + (len(padded) - win) // hop
    starts = np.arange(n_frames) * hop
    t = starts / SR

    e_l = np.empty(n_frames, dtype=np.float64)
    e_r = np.empty(n_frames, dtype=np.float64)
    for i, s in enumerate(starts):
        seg = padded[s : s + win]
        e_l[i] = np.mean(seg[:, 0] ** 2)
        e_r[i] = np.mean(seg[:, 1] ** 2)

    total_e = 0.5 * (e_l + e_r)
    total_db = 10.0 * np.log10(np.maximum(total_e, 1e-12))
    l_db = 10.0 * np.log10(np.maximum(e_l, 1e-12))
    r_db = 10.0 * np.log10(np.maximum(e_r, 1e-12))
    pan_idx = (e_r - e_l) / np.maximum(e_l + e_r, 1e-12)
    return {"times": t, "total_db": total_db, "l_db": l_db, "r_db": r_db, "pan_idx": pan_idx}


def render_3a_style_l1(stereo: np.ndarray, title: str, out_path: Path) -> None:
    """
    Battery 3A Style L1:
      Top (44%): Split L/R Waveforms (Cyan=L, Amber=R, stacked neatly)
      Bottom (56%): Short-Term 300ms Loudness/RMS Contour (-48 to 0 dBFS, crisp 3 dB horizontal gridlines)
                    showing Combined (White), Left (Cyan), Right (Amber).
    """
    duration = stereo.shape[0] / SR
    m = compute_short_term_rms_db(stereo, win_ms=300.0, hop_ms=20.0)

    fig = plt.figure(figsize=(CANVAS_W / DPI, CANVAS_H / DPI), dpi=DPI, facecolor=BG_FIG)
    gs = fig.add_gridspec(
        nrows=3, ncols=1, height_ratios=[22, 22, 56],
        left=0.075, right=0.965, top=0.915, bottom=0.085, hspace=0.10,
    )
    ax_l = fig.add_subplot(gs[0], facecolor=BG_AX)
    ax_r = fig.add_subplot(gs[1], facecolor=BG_AX)
    ax_rms = fig.add_subplot(gs[2], facecolor=BG_AX)
    fig.suptitle(title, color=FG_TEXT, fontsize=17, fontweight="bold", y=0.968)

    for ax, ch, col, lbl in [(ax_l, stereo[:, 0], CYAN, "Left (L)"), (ax_r, stereo[:, 1], AMBER, "Right (R)")]:
        wt, wmin, wmax = p1.compute_waveform_envelope(ch, n_bins=1600)
        ax.fill_between(wt, wmin, wmax, color=col, alpha=0.9, linewidth=0)
        ax.axhline(0.0, color="#475569", linewidth=0.7)
        ax.set_ylim(-1.05, 1.05)
        ax.set_yticks([-0.5, 0.0, 0.5])
        ax.set_yticklabels(["-0.5", "0", "+0.5"], fontsize=11, color=FG_TEXT)
        ax.set_ylabel(lbl, color=col, fontsize=12.5, fontweight="bold")
        ax.grid(True, which="major", axis="y", color=GRID_MAJOR, linewidth=0.6, alpha=0.7)
        p1.style_time_axis(ax, duration, show_xlabel=False)

    # Bottom: 300ms RMS contour with 3 dB gridlines (-48..0 dBFS)
    t = m["times"]
    ax_rms.plot(t, np.clip(m["l_db"], -52, 0), color=CYAN, linewidth=1.7, alpha=0.80, label="Left RMS (300ms)")
    ax_rms.plot(t, np.clip(m["r_db"], -52, 0), color=AMBER, linewidth=1.7, alpha=0.80, label="Right RMS (300ms)")
    ax_rms.plot(t, np.clip(m["total_db"], -52, 0), color="#f8fafc", linewidth=2.6, alpha=0.98, label="Combined Stereo RMS (300ms)")
    ax_rms.set_ylim(-48.0, 0.0)
    major_db = list(range(-48, 1, 6))
    minor_db = list(range(-45, 0, 6))
    ax_rms.set_yticks(major_db)
    ax_rms.set_yticks(minor_db, minor=True)
    ax_rms.set_yticklabels([f"{d} dB" for d in major_db], fontsize=12, color=FG_TEXT)
    ax_rms.grid(True, which="major", axis="y", color="#3b4758", linewidth=1.0, alpha=0.9)
    ax_rms.grid(True, which="minor", axis="y", color="#273140", linewidth=0.75, linestyle="--", alpha=0.85)
    ax_rms.set_ylabel("Short-Term RMS (3 dB grid)", color=FG_TEXT, fontsize=13, fontweight="bold")
    ax_rms.legend(loc="upper right", facecolor="#161b22", edgecolor="#3b4758", labelcolor=FG_TEXT, fontsize=11.5, ncol=3)
    p1.style_time_axis(ax_rms, duration, show_xlabel=True)

    p1.save_clean_png_from_figure(fig, out_path)


def render_3a_style_l2(stereo: np.ndarray, title: str, out_path: Path) -> None:
    """
    Battery 3A Style L2:
      Top (44%): Gated Pan Balance Ribbon (100ms, P(t)=(E_R-E_L)/(E_R+E_L) with crisp 0.25 ticks)
      Bottom (56%): Short-Term 300ms Loudness/RMS Contour (-48 to 0 dBFS, crisp 3 dB horizontal gridlines).
    """
    duration = stereo.shape[0] / SR
    pm = p1.compute_windowed_stereo_metrics(stereo, win_ms=100.0, hop_ms=20.0)
    rm = compute_short_term_rms_db(stereo, win_ms=300.0, hop_ms=20.0)

    fig = plt.figure(figsize=(CANVAS_W / DPI, CANVAS_H / DPI), dpi=DPI, facecolor=BG_FIG)
    gs = fig.add_gridspec(
        nrows=2, ncols=1, height_ratios=[44, 56],
        left=0.085, right=0.965, top=0.915, bottom=0.085, hspace=0.12,
    )
    ax_p = fig.add_subplot(gs[0], facecolor=BG_AX)
    ax_rms = fig.add_subplot(gs[1], facecolor=BG_AX)
    fig.suptitle(title, color=FG_TEXT, fontsize=17, fontweight="bold", y=0.968)

    # Top: Gated Pan Ribbon
    t_p, p_idx, rms_p = pm["times"], pm["pan_idx"], pm["total_rms_db"]
    pan_cmap = LinearSegmentedColormap.from_list("pan_cmap", ["#22d3ee", "#e2e8f0", "#f59e0b"])
    norm = Normalize(vmin=-1.0, vmax=1.0)
    ax_p.axhline(0.0, color="#cbd5e1", linewidth=1.2)
    for yg in (-0.75, -0.5, -0.25, 0.25, 0.5, 0.75):
        ax_p.axhline(yg, color="#475569", linewidth=0.75, linestyle="--", alpha=0.75)
    alpha_arr = np.clip((rms_p - (-45.0)) / 9.0, 0.0, 1.0)
    dt = float(t_p[1] - t_p[0]) if len(t_p) > 1 else 0.02
    for i in range(len(t_p)):
        a = float(alpha_arr[i])
        if a <= 0.02:
            continue
        col = list(pan_cmap(norm(p_idx[i])))
        col[3] = 0.55 * a
        ax_p.bar(t_p[i], p_idx[i], width=dt * 1.15, bottom=0.0, color=col, edgecolor="none", align="center")
    pts = np.array([t_p, p_idx]).T.reshape(-1, 1, 2)
    segs = np.concatenate([pts[:-1], pts[1:]], axis=1)
    sa = 0.5 * (alpha_arr[:-1] + alpha_arr[1:])
    sc = pan_cmap(norm(0.5 * (p_idx[:-1] + p_idx[1:])))
    sc[:, 3] = np.where(sa > 0.05, np.clip(sa * 1.1, 0.0, 1.0), 0.0)
    ax_p.add_collection(LineCollection(segs, colors=sc, linewidths=3.0))
    ax_p.set_ylim(-1.08, 1.08)
    ax_p.set_yticks([-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 1.0])
    ax_p.set_yticklabels(["-1.0 (L)", "-0.75", "-0.50", "-0.25", "0.0 (C)", "+0.25", "+0.50", "+0.75", "+1.0 (R)"], fontsize=11.5, color=FG_TEXT)
    ax_p.set_ylabel("Pan Index  (E_R-E_L)/(E_R+E_L)", color=FG_TEXT, fontsize=12.5, fontweight="bold")
    p1.style_time_axis(ax_p, duration, show_xlabel=False)

    # Bottom: 300ms Combined RMS contour with crisp 3 dB horizontal gridlines
    t = rm["times"]
    ax_rms.fill_between(t, -48.0, np.clip(rm["total_db"], -48.0, 0.0), color=CYAN, alpha=0.18)
    ax_rms.plot(t, np.clip(rm["total_db"], -48.0, 0.0), color="#f8fafc", linewidth=2.6, label="Combined Stereo RMS (300ms)")
    ax_rms.set_ylim(-48.0, 0.0)
    major_db = list(range(-48, 1, 6))
    minor_db = list(range(-45, 0, 6))
    ax_rms.set_yticks(major_db)
    ax_rms.set_yticks(minor_db, minor=True)
    ax_rms.set_yticklabels([f"{d} dB" for d in major_db], fontsize=12, color=FG_TEXT)
    ax_rms.grid(True, which="major", axis="y", color="#3b4758", linewidth=1.0, alpha=0.9)
    ax_rms.grid(True, which="minor", axis="y", color="#273140", linewidth=0.75, linestyle="--", alpha=0.85)
    ax_rms.set_ylabel("Short-Term RMS (3 dB grid)", color=FG_TEXT, fontsize=13, fontweight="bold")
    ax_rms.legend(loc="upper right", facecolor="#161b22", edgecolor="#3b4758", labelcolor=FG_TEXT, fontsize=11.5)
    p1.style_time_axis(ax_rms, duration, show_xlabel=True)

    p1.save_clean_png_from_figure(fig, out_path)


def render_3b_pure_ffmpeg_stereo(stereo: np.ndarray, title: str, out_path: Path) -> None:
    """
    Battery 3B Renderer: Pure FFmpeg candidate production layout (1600x900):
      Top (250px):    showwavespic split_channels=1 (L=Cyan, R=Amber, filter=peak), pixel-aligned x=142
      Bottom (650px): showspectrumpic (1316x522 + legend=1 -> 1600x650), magma, log/log, drange=100.
    """
    with tempfile.TemporaryDirectory() as td:
        wav_path = Path(td) / "input.wav"
        p1.write_wav_file(wav_path, stereo)
        fc = (
            "[0:a]asplit=2[a1][a2];"
            "[a1]showwavespic=s=1316x250:colors=#38bdf8|#fbbf24:split_channels=1:scale=lin:filter=peak[wraw];"
            "color=c=#0d1117:s=1600x250:d=1[bg];"
            "[bg][wraw]overlay=x=142:y=0:shortest=1,format=rgb24[w];"
            "[a2]showspectrumpic=s=1316x522:mode=combined:color=magma:scale=log:fscale=log:gain=1:drange=100:legend=1,format=rgb24[s];"
            "[w][s]vstack=inputs=2[out]"
        )
        png_bytes = p1.run_ffmpeg([
            "-i", str(wav_path),
            "-filter_complex", fc,
            "-map", "[out]",
            "-frames:v", "1",
            "-f", "image2pipe",
            "-vcodec", "png",
            "pipe:1",
        ])

    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    draw = ImageDraw.Draw(im)
    draw.rectangle([142, 250, 1458, 276], fill=(0, 0, 0))
    try:
        font = ImageFont.truetype("arialbd.ttf", 22)
        small = ImageFont.truetype("arial.ttf", 14)
    except Exception:
        font = ImageFont.load_default()
        small = font
    bbox = draw.textbbox((0, 0), title, font=font)
    tw = bbox[2] - bbox[0]
    draw.text(((im.width - tw) // 2, 8), title, fill=(230, 237, 243), font=font)
    draw.text((42, 55), "L (Cyan)", fill=(56, 189, 248), font=small)
    draw.text((34, 180), "R (Amber)", fill=(251, 191, 36), font=small)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_path, format="PNG", pnginfo=PngImagePlugin.PngInfo(), optimize=True)


def render_3c_transition(
    stereo: np.ndarray,
    title: str,
    out_path: Path,
    cue_boxes: list[dict[str, Any]] | None = None,
) -> None:
    """
    Battery 3C Renderer:
      - Style A1 (cue_boxes=None): Split L/R Waveform + Log-Mel Spectrogram
      - Style A2 (cue_boxes=[...]): Adds DAW Cue-Block Track overlay at top showing planned timeline.ts spans.
    """
    duration = stereo.shape[0] / SR
    fig = plt.figure(figsize=(CANVAS_W / DPI, CANVAS_H / DPI), dpi=DPI, facecolor=BG_FIG)

    if cue_boxes:
        gs = fig.add_gridspec(
            nrows=4, ncols=2,
            height_ratios=[15, 19, 19, 47],
            width_ratios=[96, 2.2],
            left=0.075, right=0.935, top=0.92, bottom=0.085,
            hspace=0.09, wspace=0.015,
        )
        ax_cue = fig.add_subplot(gs[0, 0], facecolor=BG_AX)
        ax_l = fig.add_subplot(gs[1, 0], facecolor=BG_AX)
        ax_r = fig.add_subplot(gs[2, 0], facecolor=BG_AX)
        ax_s = fig.add_subplot(gs[3, 0], facecolor=BG_AX)
        ax_cb = fig.add_subplot(gs[3, 1], facecolor=BG_FIG)

        # Draw DAW Cue-Block Track (2 lanes so overlaps are crystal clear)
        ax_cue.set_ylim(0.0, 2.2)
        ax_cue.set_yticks([0.55, 1.65])
        ax_cue.set_yticklabels(["Cue 2", "Cue 1"], fontsize=11.5, color=FG_TEXT, fontweight="bold")
        for idx, cb in enumerate(cue_boxes):
            lane_y = 1.25 if idx == 0 else 0.15
            col = CYAN if idx == 0 else AMBER
            w = max(0.05, cb["endSec"] - cb["startSec"])
            rect = FancyBboxPatch(
                (cb["startSec"], lane_y), w, 0.80,
                boxstyle="round,pad=0.02,rounding_size=0.05",
                facecolor=col, edgecolor="#f8fafc", alpha=0.35, linewidth=1.6,
            )
            ax_cue.add_patch(rect)
            ax_cue.axvline(cb["startSec"], color=col, linestyle=":", linewidth=1.2, alpha=0.8)
            ax_cue.axvline(cb["endSec"], color=col, linestyle=":", linewidth=1.2, alpha=0.8)
            ax_cue.text(
                cb["startSec"] + 0.08, lane_y + 0.40,
                f"{cb['label']}  ({cb['startSec']:.2f}s - {cb['endSec']:.2f}s)",
                color=FG_TEXT, fontsize=11, fontweight="bold", va="center",
            )
        ax_cue.set_ylabel("DAW Cues", color=FG_TEXT, fontsize=12, fontweight="bold")
        p1.style_time_axis(ax_cue, duration, show_xlabel=False)
    else:
        gs = fig.add_gridspec(
            nrows=3, ncols=2,
            height_ratios=[22, 22, 56],
            width_ratios=[96, 2.2],
            left=0.075, right=0.935, top=0.92, bottom=0.085,
            hspace=0.10, wspace=0.015,
        )
        ax_l = fig.add_subplot(gs[0, 0], facecolor=BG_AX)
        ax_r = fig.add_subplot(gs[1, 0], facecolor=BG_AX)
        ax_s = fig.add_subplot(gs[2, 0], facecolor=BG_AX)
        ax_cb = fig.add_subplot(gs[2, 1], facecolor=BG_FIG)

    fig.suptitle(title, color=FG_TEXT, fontsize=17, fontweight="bold", y=0.97)

    for ax, ch, col, lbl in [(ax_l, stereo[:, 0], CYAN, "Left (L)"), (ax_r, stereo[:, 1], AMBER, "Right (R)")]:
        wt, wmin, wmax = p1.compute_waveform_envelope(ch, n_bins=1600)
        ax.fill_between(wt, wmin, wmax, color=col, alpha=0.9, linewidth=0)
        ax.axhline(0.0, color="#475569", linewidth=0.7)
        ax.set_ylim(-1.05, 1.05)
        ax.set_yticks([-0.5, 0.0, 0.5])
        ax.set_yticklabels(["-0.5", "0", "+0.5"], fontsize=11, color=FG_TEXT)
        ax.set_ylabel(lbl, color=col, fontsize=12, fontweight="bold")
        ax.grid(True, which="major", axis="y", color=GRID_MAJOR, linewidth=0.6, alpha=0.7)
        p1.style_time_axis(ax, duration, show_xlabel=False)

    # Bottom: Log-Mel spectrogram
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
    ax_s.set_yticklabels(freq_labels, fontsize=11.5, color=FG_TEXT)
    ax_s.set_ylabel("Frequency (Log-Mel)", color=FG_TEXT, fontsize=12.5, fontweight="bold")
    ax_s.grid(True, which="major", axis="y", color="#ffffff", linewidth=0.5, alpha=0.22)
    p1.style_time_axis(ax_s, duration, show_xlabel=True)

    cbar = fig.colorbar(im, cax=ax_cb)
    cbar.set_ticks([-80, -60, -40, -24, -12, -6, 0])
    cbar.set_ticklabels(["-80", "-60", "-40", "-24", "-12", "-6", "0 dB"])
    cbar.ax.tick_params(colors=FG_TEXT, labelsize=11.5)
    cbar.set_label("Level (dBFS)", color=FG_TEXT, fontsize=12.5, fontweight="bold")
    cbar.outline.set_edgecolor("#3b4758")

    p1.save_clean_png_from_figure(fig, out_path)


# ---------------------------------------------------------------------------
# Phase 2 Battery Builders
# ---------------------------------------------------------------------------

def build_battery_3a(
    speaker_a_takes: list[tuple[str, np.ndarray]],
    margaux_takes: list[tuple[str, np.ndarray]],
    rng: random.Random,
    out_dir: Path,
) -> list[dict[str, Any]]:
    """
    Battery 3A (12 trials): Continuous arbitrary loudness shifts (0 to ±8 dB) + continuous arbitrary
    stereo pans with real Booth headphone crossfeed enabled.
    6x Style L1 (Split L/R + 300ms RMS) and 6x Style L2 (Gated Pan Ribbon + 300ms RMS).
    """
    pool = [a for _, a in speaker_a_takes] + [a for _, a in margaux_takes]

    # Non-grid continuous loudness ladder spanning 0 dB control through ±8 dB
    delta_specs = [
        0.0, 0.0,
        +0.9, -1.3,
        +1.7, -2.2,
        +2.8, -3.6,
        +4.7, -5.8,
        +6.9, -7.8,
    ]
    styles = ["L1", "L2"] * 6
    pairs = list(zip(delta_specs, styles))
    rng.shuffle(pairs)

    records: list[dict[str, Any]] = []
    duration_sec = 12.0
    n_total = int(round(duration_sec * SR))

    for idx, (delta_db, style) in enumerate(pairs, start=1):
        trial_id = f"b3a_t{idx:02d}"
        title = f"Trial B3A-{idx:02d} (Style {style})"

        # Two consecutive speech lines (~4.1s each) with natural 0.9s pause
        raw1 = p1.extract_clean_excerpt(rng.choice(pool), 4.1, rng)
        raw2 = p1.extract_clean_excerpt(rng.choice(pool), 4.1, rng)

        # Arbitrary continuous pans (avoiding round 0.25/0.50/0.85 grid values!)
        def random_continuous_pan() -> float:
            while True:
                v = round(rng.uniform(-0.88, 0.88), 2)
                if all(abs(v - g) > 0.04 for g in (-0.85, -0.50, -0.25, 0.0, 0.25, 0.50, 0.85)):
                    return v

        pan1 = random_continuous_pan()
        pan2 = random_continuous_pan()

        st1 = pan_with_headphone_crossfeed(raw1, pan1, headphone_crossfeed=True)
        st2 = pan_with_headphone_crossfeed(raw2, pan2, headphone_crossfeed=True)

        # Calibrate exact stereo active RMS AFTER panning/crossfeed so delta_db is exact to ±0.01 dB
        # Use -22.5 dBFS reference so even +8 dB shifts stay safely below 0 dBFS without peak-limiting distortion
        ref_dbfs = -22.5
        cur1 = measure_active_rms_db(st1)
        cur2 = measure_active_rms_db(st2)
        st1 = (st1 * np.float32(10.0 ** ((ref_dbfs - cur1) / 20.0))).astype(np.float32)
        st2 = (st2 * np.float32(10.0 ** (((ref_dbfs + delta_db) - cur2) / 20.0))).astype(np.float32)
        # Safety check: if combined peak exceeds 0.98, scale BOTH lines identically so delta_db stays exact!
        max_pk = max(float(np.max(np.abs(st1))), float(np.max(np.abs(st2))))
        if max_pk > 0.96:
            scale = np.float32(0.96 / max_pk)
            st1 *= scale
            st2 *= scale

        # Re-measure exact realized active stereo RMS delta & realized energy pan index
        rms1_db = measure_active_rms_db(st1)
        rms2_db = measure_active_rms_db(st2)
        realized_delta_db = round(rms2_db - rms1_db, 2)

        def realized_energy_index(st: np.ndarray) -> float:
            el = float(np.mean(st[:, 0].astype(np.float64) ** 2))
            er = float(np.mean(st[:, 1].astype(np.float64) ** 2))
            return round((er - el) / max(el + er, 1e-12), 3)

        pidx1 = realized_energy_index(st1)
        pidx2 = realized_energy_index(st2)

        stereo = p1.generate_warm_dark_room_tone(
            duration_sec, -54.0, 2,
            rng.randint(1000, 999999), rng.randint(1000, 999999),
        )
        t1_start = round(rng.uniform(0.75, 1.35), 2)
        t1_end = round(t1_start + len(st1) / SR, 2)
        t2_start = round(t1_end + rng.uniform(0.85, 1.25), 2)
        t2_end = round(min(duration_sec - 0.3, t2_start + len(st2) / SR), 2)

        s1a, s1b = int(round(t1_start * SR)), int(round(t1_start * SR)) + len(st1)
        s2a = int(round(t2_start * SR))
        s2b = min(n_total, s2a + len(st2))
        stereo[s1a:s1b] += st1
        stereo[s2a:s2b] += st2[: s2b - s2a]
        stereo = np.clip(stereo, -0.999, 0.999)

        png_path = out_dir / f"{trial_id}.png"
        if style == "L1":
            render_3a_style_l1(stereo, title, png_path)
        else:
            render_3a_style_l2(stereo, title, png_path)

        direction = "same" if abs(delta_db) < 0.05 else ("louder" if delta_db > 0 else "quieter")
        records.append({
            "trialId": trial_id,
            "battery": "b3a",
            "filename": png_path.name,
            "style": style,
            "durationSec": duration_sec,
            "headphoneCrossfeed": True,
            "targetDeltaDb": delta_db,
            "realizedDeltaDb": realized_delta_db,
            "loudnessDirection": direction,
            "line1": {
                "startSec": t1_start, "endSec": t1_end,
                "targetPan": pan1, "realizedEnergyIndex": pidx1, "rmsDbfs": round(rms1_db, 2),
            },
            "line2": {
                "startSec": t2_start, "endSec": t2_end,
                "targetPan": pan2, "realizedEnergyIndex": pidx2, "rmsDbfs": round(rms2_db, 2),
            },
        })

    return records


def build_battery_3b(
    speaker_a_takes: list[tuple[str, np.ndarray]],
    margaux_takes: list[tuple[str, np.ndarray]],
    rng: random.Random,
    out_dir: Path,
) -> list[dict[str, Any]]:
    """
    Battery 3B (16 trials): Time-Window Compression Ceiling (5s, 15s, 45s, 180s at 1600x900).
    4 conditions (clean, 3ms click, 120ms dropout, 150ms stereo overlap) x 4 window widths.
    Rendered via pure FFmpeg (split_channels=1 showwavespic + showspectrumpic).
    """
    all_arrs = [a for _, a in speaker_a_takes] + [a for _, a in margaux_takes]
    e_arrs = [a for _, a in speaker_a_takes]
    m_arrs = [a for _, a in margaux_takes]

    windows = [5.0, 15.0, 45.0, 180.0]
    conditions = ["clean", "click", "dropout", "overlap"]
    jobs = [(w, c) for w in windows for c in conditions]
    rng.shuffle(jobs)

    records: list[dict[str, Any]] = []
    for idx, (win_sec, cond) in enumerate(jobs, start=1):
        trial_id = f"b3b_t{idx:02d}"
        title = f"Trial B3B-{idx:02d}"
        n_total = int(round(win_sec * SR))

        if cond == "overlap":
            # Build clean alternating stereo speech (non-overlapping), then inject ONE crisp 150ms opposite-side overlap!
            stereo = p1.generate_warm_dark_room_tone(
                win_sec, -54.0, 2,
                rng.randint(1000, 999999), rng.randint(1000, 999999),
            )
            speech_layer, pauses = build_long_speech_stream(all_arrs, rng, win_sec, stereo_alternating=False)
            # Keep base speech centered-ish or softly alternating L/R without overlaps
            # Actually: make all normal speech clean mono-centered (0.0) EXCEPT one 2-speaker opposite-pan section with 150ms overlap?
            # Even better: make ALL speech mono-alternating with distinct pauses, and ONE unmistakable opposite-side overlap!
            # Wait: for overlap detection to be unambiguous against normal speech, build alternating L (-0.65) and R (+0.65) lines
            # separated by clean pauses, and inject ONE 150ms negative-offset overlap between an L line and an R line!
            stereo = p1.generate_warm_dark_room_tone(
                win_sec, -54.0, 2,
                rng.randint(1000, 999999), rng.randint(1000, 999999),
            )
            target_ov_t = rng.uniform(win_sec * 0.22, win_sec * 0.78)
            cursor = rng.uniform(0.25, 0.50)
            side = -1
            ov_injected = False
            ov_start = ov_end = 0.0
            while cursor < win_sec - 0.8:
                pool = e_arrs if side < 0 else m_arrs
                dur_seg = rng.uniform(1.1, 2.0) if win_sec <= 15 else rng.uniform(2.2, 4.2)
                seg = p1.extract_clean_excerpt(rng.choice(pool), dur_seg, rng)
                s0 = int(round(cursor * SR))
                s1 = min(n_total - int(0.2 * SR), s0 + len(seg))
                if s1 - s0 < int(0.5 * SR):
                    break
                seg = seg[: s1 - s0]
                pan = -0.75 if side < 0 else 0.75
                gl, gr = p1.constant_power_gains(pan)
                stereo[s0:s1, 0] += seg * np.float32(gl)
                stereo[s0:s1, 1] += seg * np.float32(gr)
                end_sec = s1 / SR

                if (not ov_injected) and end_sec >= target_ov_t and (win_sec - end_sec) > 1.2:
                    # Next line starts 150ms BEFORE this line ends -> crisp 150ms opposite-side overlap!
                    ov_start = end_sec - 0.150
                    ov_end = end_sec
                    cursor = ov_start
                    ov_injected = True
                else:
                    gap = rng.uniform(0.35, 0.65) if win_sec <= 15 else rng.uniform(0.55, 1.15)
                    cursor = end_sec + gap
                side *= -1

            stereo = np.clip(stereo, -0.999, 0.999)
            gt: dict[str, Any] = {
                "hasDefect": True,
                "defectClass": "overlap",
                "timestampSec": round(0.5 * (ov_start + ov_end), 3),
                "details": {"startSec": round(ov_start, 3), "endSec": round(ov_end, 3), "durationMs": 150.0},
            }
        else:
            rt = p1.generate_warm_dark_room_tone(
                win_sec, -54.0, 2,
                rng.randint(1000, 999999), rng.randint(1000, 999999),
            )
            speech_layer, pauses = build_long_speech_stream(all_arrs, rng, win_sec, stereo_alternating=True)
            stereo = np.clip(speech_layer + rt, -0.999, 0.999)

            # Filter interior pauses away from very edges
            interior_pauses = [p for p in pauses if p[0] > win_sec * 0.12 and p[1] < win_sec * 0.88 and (p[1] - p[0]) >= 0.30]

            if cond == "clean":
                gt = {"hasDefect": False, "defectClass": "clean", "timestampSec": None, "details": {}}
            elif cond == "click":
                if interior_pauses:
                    p_choice = rng.choice(interior_pauses)
                    t_c = round(0.5 * (p_choice[0] + p_choice[1]), 3)
                else:
                    t_c = round(rng.uniform(win_sec * 0.2, win_sec * 0.8), 3)
                # Inject identical 3ms broadband click on both L and R (-4 dBFS peak)
                c_l = p1.inject_click(stereo[:, 0], t_c, peak_dbfs=-4.0, width_ms=3.0, rng=rng)
                diff = c_l - stereo[:, 0]
                stereo[:, 0] = c_l
                stereo[:, 1] = np.clip(stereo[:, 1] + diff, -0.999, 0.999)
                gt = {
                    "hasDefect": True,
                    "defectClass": "click",
                    "timestampSec": t_c,
                    "details": {"widthMs": 3.0, "peakDbfs": -4.0},
                }
            elif cond == "dropout":
                if interior_pauses:
                    p_choice = rng.choice(interior_pauses)
                    t_c = 0.5 * (p_choice[0] + p_choice[1])
                else:
                    t_c = rng.uniform(win_sec * 0.2, win_sec * 0.8)
                d_l, d0, d1 = p1.inject_dropout(stereo[:, 0], t_c, duration_ms=120.0, edge_ms=5.0)
                d_r, _, _ = p1.inject_dropout(stereo[:, 1], t_c, duration_ms=120.0, edge_ms=5.0)
                stereo[:, 0] = d_l
                stereo[:, 1] = d_r
                gt = {
                    "hasDefect": True,
                    "defectClass": "dropout",
                    "timestampSec": round(0.5 * (d0 + d1), 3),
                    "details": {"startSec": round(d0, 3), "endSec": round(d1, 3), "durationMs": 120.0, "edgeFadeMs": 5.0},
                }
            else:
                raise ValueError(cond)

        png_path = out_dir / f"{trial_id}.png"
        render_3b_pure_ffmpeg_stereo(stereo, title, png_path)
        records.append({
            "trialId": trial_id,
            "battery": "b3b",
            "filename": png_path.name,
            "style": "F4_stereo",
            "windowSec": win_sec,
            "pxPerSec": round(1316.0 / win_sec, 2),
            **gt,
        })

    return records


def build_battery_3c(
    speaker_a_takes: list[tuple[str, np.ndarray]],
    margaux_takes: list[tuple[str, np.ndarray]],
    rng: random.Random,
    out_dir: Path,
) -> list[dict[str, Any]]:
    """
    Battery 3C (6 trials): Overlap & Gap Timing Precision — Audio-Only (A1) vs DAW Cue-Block Overlay (A2).
    3 scenarios x 2 styles = 6 shuffled trials (10.0s each):
      1) Tight planned interruption (-140ms overlap, boxes match audible speech)
      2) Heavy collision (-480ms overlap, boxes match audible speech)
      3) Silent-tail mismatch trap (Cue 1 file has 540ms quiet breath/air tail -> planned box says -360ms overlap,
         while actual audible speech has a +180ms gap!)
    """
    e_arrs = [a for _, a in speaker_a_takes]
    m_arrs = [a for _, a in margaux_takes]

    scenarios = [
        {
            "scenarioId": "tight_interruption",
            "plannedGapMs": -140,
            "cue1SilentTailMs": 0,
            "audibleGapMs": -140,
            "tailMismatch": False,
        },
        {
            "scenarioId": "heavy_collision",
            "plannedGapMs": -480,
            "cue1SilentTailMs": 0,
            "audibleGapMs": -480,
            "tailMismatch": False,
        },
        {
            "scenarioId": "silent_tail_trap",
            "plannedGapMs": -360,
            "cue1SilentTailMs": 540,
            "audibleGapMs": +180,
            "tailMismatch": True,
        },
    ]

    prepared = []
    for sc in scenarios:
        seg1 = p1.extract_clean_excerpt(rng.choice(e_arrs), 3.4, rng)
        seg2 = p1.extract_clean_excerpt(rng.choice(m_arrs), 3.4, rng)
        prepared.append({**sc, "seg1": seg1, "seg2": seg2})

    jobs = [(p, st) for p in prepared for st in ("A1", "A2")]
    rng.shuffle(jobs)

    records: list[dict[str, Any]] = []
    duration_sec = 10.0
    n_total = int(round(duration_sec * SR))

    for idx, (sc, style) in enumerate(jobs, start=1):
        trial_id = f"b3c_t{idx:02d}"
        title = f"Trial B3C-{idx:02d} (Style {style})"

        stereo = p1.generate_warm_dark_room_tone(
            duration_sec, -54.0, 2,
            rng.randint(1000, 999999), rng.randint(1000, 999999),
        )
        c1_start = round(rng.uniform(0.90, 1.55), 3)
        seg1 = sc["seg1"]
        seg2 = sc["seg2"]
        c1_speech_end = c1_start + len(seg1) / SR
        c1_box_end = c1_speech_end + sc["cue1SilentTailMs"] / 1000.0

        c2_start = c1_box_end + sc["plannedGapMs"] / 1000.0
        c2_end = c2_start + len(seg2) / SR

        # Pan Cue 1 Left (-0.65), Cue 2 Right (+0.65)
        st1 = pan_with_headphone_crossfeed(seg1, -0.65, headphone_crossfeed=False)
        st2 = pan_with_headphone_crossfeed(seg2, +0.65, headphone_crossfeed=False)

        s1a = int(round(c1_start * SR))
        s1b = min(n_total, s1a + len(st1))
        s2a = int(round(c2_start * SR))
        s2b = min(n_total, s2a + len(st2))
        stereo[s1a:s1b] += st1[: s1b - s1a]
        stereo[s2a:s2b] += st2[: s2b - s2a]
        stereo = np.clip(stereo, -0.999, 0.999)

        cue_boxes = [
            {"label": "cue_01 [Speaker A]", "startSec": round(c1_start, 3), "endSec": round(c1_box_end, 3)},
            {"label": "cue_02 [Speaker B]", "startSec": round(c2_start, 3), "endSec": round(c2_end, 3)},
        ]

        png_path = out_dir / f"{trial_id}.png"
        render_3c_transition(stereo, title, png_path, cue_boxes=cue_boxes if style == "A2" else None)

        records.append({
            "trialId": trial_id,
            "battery": "b3c",
            "filename": png_path.name,
            "scenarioId": sc["scenarioId"],
            "style": style,
            "durationSec": duration_sec,
            "cue1SpeechEndSec": round(c1_speech_end, 3),
            "cue1BoxEndSec": round(c1_box_end, 3),
            "cue2StartSec": round(c2_start, 3),
            "plannedGapOrOverlapMs": sc["plannedGapMs"],
            "audibleGapOrOverlapMs": sc["audibleGapMs"],
            "tailMismatch": sc["tailMismatch"],
        })

    return records


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate blinded Phase 2 (Battery 3) psychophysics stimuli.")
    parser.add_argument("--seed", type=int, default=20261127, help="Deterministic RNG seed")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=REPO_ROOT / "data" / "visual_bench" / "phase2",
        help="Subject-visible directory (receives ONLY opaque PNGs)",
    )
    parser.add_argument(
        "--key-out",
        type=Path,
        default=REPO_ROOT.parent / "visual_bench_private" / "phase2_answer_key.json",
        help="Operator-only private ground-truth answer key path",
    )
    args = parser.parse_args()

    out_dir = args.out_dir.resolve()
    key_out = args.key_out.resolve()

    try:
        key_out.relative_to(out_dir)
        raise SystemExit("ERROR: --key-out must NOT be inside --out-dir (anti-leak violation).")
    except ValueError:
        pass

    if out_dir.exists():
        for old in out_dir.glob("*.png"):
            old.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    key_out.parent.mkdir(parents=True, exist_ok=True)

    rng = random.Random(args.seed)
    all_takes, speaker_a_takes, margaux_takes = p1.load_corpus()
    print(f"Loaded {len(all_takes)} real speech takes ({len(speaker_a_takes)} Speaker A, {len(margaux_takes)} Margaux).")

    b3a = build_battery_3a(speaker_a_takes, margaux_takes, rng, out_dir)
    print(f"Generated Battery 3A (Continuous Loudness + Pan JND): {len(b3a)} PNGs")
    b3b = build_battery_3b(speaker_a_takes, margaux_takes, rng, out_dir)
    print(f"Generated Battery 3B (5s/15s/45s/180s Ladder):        {len(b3b)} PNGs")
    b3c = build_battery_3c(speaker_a_takes, margaux_takes, rng, out_dir)
    print(f"Generated Battery 3C (Audio-Only vs DAW Cue Overlay): {len(b3c)} PNGs")

    payload = {
        "study": "visual-audio-psychophysics-phase2",
        "seed": args.seed,
        "sampleRate": SR,
        "stimuliDir": str(out_dir),
        "counts": {"b3a": len(b3a), "b3b": len(b3b), "b3c": len(b3c), "total": len(b3a) + len(b3b) + len(b3c)},
        "b3a": b3a,
        "b3b": b3b,
        "b3c": b3c,
    }
    key_out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {payload['counts']['total']} blinded PNGs to: {out_dir}")
    print(f"Wrote operator-only answer key to: {key_out}")


if __name__ == "__main__":
    main()
