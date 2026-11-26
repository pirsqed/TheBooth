#!/usr/bin/env python3
"""
Visual-Audio Psychophysics & Anti-Placebo Study — Phase 1 Stimulus Generator

Generates strictly blinded PNG stimuli for:
  - Battery 1  (10 trials): Clean-Control Placebo Trap (4 clean + 6 defects)
  - Battery 2A (12 trials): Stereo / Spatial Field Bake-Off (4 clips x 3 styles: S1, S2, S3)
  - Mini-2B    (8 trials):  Custom Annotated (F1) vs Pure FFmpeg (F4) Bake-Off (4 clips x 2 styles)

Zero metadata leakage:
  - Subject-visible directory receives ONLY opaque PNG files (`b1_t01.png`, ...).
  - All PNG text/EXIF chunks are scrubbed via Pillow before saving.
  - Plot titles are strictly neutral (`Trial B1-01`, `Trial B2A-01 (Style S2)`, `Trial B2B-01`).
  - Operator-only ground-truth `answer_key.json` is written to an external private path (`--key-out`).
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
from matplotlib.collections import LineCollection
from matplotlib.colors import LinearSegmentedColormap, Normalize
import numpy as np
from PIL import Image, PngImagePlugin

SR = 48000
CANVAS_W = 1600
CANVAS_H = 900
DPI = 100

REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS_DIRS = [
    REPO_ROOT / "data" / "projects" / "sample_scene_a" / "takes",
    REPO_ROOT / "data" / "projects" / "sample_scene_b" / "takes",
]

# Speaker mapping from project manifests (for distinct 2-speaker Battery 2A clips)
SPEAKER_BY_TAKE = {
    "take_d872d48a9ab5.wav": "speaker_a",
    "take_314ade53cf26.wav": "speaker_a",
    "take_2298f11a53a9.wav": "speaker_a",
    "take_b0cd7f10a9ec.wav": "speaker_a",
    "take_73deb885a6e1.wav": "speaker_a",
    "take_730438f1bfe2.wav": "speaker_a",
    "take_afc043b7adc4.wav": "margaux",
    "take_a82bec9c4681.wav": "margaux",
    "take_a3473eda8bf2.wav": "margaux",
    "take_8edd80efc73d.wav": "margaux",
}


# ---------------------------------------------------------------------------
# FFmpeg & Audio Utilities
# ---------------------------------------------------------------------------

def run_ffmpeg(args: list[str], stdin_bytes: bytes | None = None) -> bytes:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", *args],
        input=stdin_bytes,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {proc.stderr.decode('utf-8', 'replace')}")
    return proc.stdout


def load_take_mono_48k(path: Path) -> np.ndarray:
    """Decode any WAV take and resample cleanly to 48 kHz mono float32 via ffmpeg."""
    pcm = run_ffmpeg([
        "-i", str(path),
        "-ar", str(SR),
        "-ac", "1",
        "-f", "f32le",
        "pipe:1",
    ])
    return np.frombuffer(pcm, dtype=np.float32).copy()


def generate_warm_dark_room_tone(
    duration_sec: float,
    gain_db: float,
    channels: int,
    seed_l: int,
    seed_r: int,
) -> np.ndarray:
    """
    Replicates src/audio/roomtone.ts (`warm_dark`):
      anoisesrc brown + highpass=35:poles=1 + lowpass=2400:poles=2 + eq 160Hz +2dB
    Calibrated to exact RMS `gain_db` dBFS so floor shifts are quantitatively exact.
    """
    n_samples = int(round(duration_sec * SR))
    dur_str = f"{duration_sec + 0.15:.3f}"
    shaping = "highpass=f=35:poles=1,lowpass=f=2400:poles=2,equalizer=f=160:t=q:w=0.8:g=2"
    if channels == 1:
        fc = f"anoisesrc=d={dur_str}:c=brown:r={SR}:a=1.0:s={seed_l},{shaping}[out]"
    else:
        fc = (
            f"anoisesrc=d={dur_str}:c=brown:r={SR}:a=1.0:s={seed_l}[l];"
            f"anoisesrc=d={dur_str}:c=brown:r={SR}:a=1.0:s={seed_r}[r];"
            f"[l][r]amerge=inputs=2,{shaping}[out]"
        )
    pcm = run_ffmpeg([
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
        "-filter_complex", fc,
        "-map", "[out]",
        "-t", f"{duration_sec + 0.05:.3f}",
        "-f", "f32le",
        "pipe:1",
    ])
    arr = np.frombuffer(pcm, dtype=np.float32).copy()
    if channels == 2:
        arr = arr[: n_samples * 2].reshape(-1, 2)
    else:
        arr = arr[:n_samples]

    # Calibrate exact RMS to target gain_db
    rms = float(np.sqrt(np.mean(arr.astype(np.float64) ** 2) + 1e-18))
    target_rms = 10.0 ** (gain_db / 20.0)
    if rms > 0:
        arr *= np.float32(target_rms / rms)
    return arr


def active_rms_normalize(x: np.ndarray, target_dbfs: float = -20.0) -> np.ndarray:
    """Normalize mono speech segment using active frames (> -40 dBFS relative to peak)."""
    x = x.astype(np.float32, copy=True)
    peak = float(np.max(np.abs(x)) + 1e-9)
    win = int(0.05 * SR)
    nwin = len(x) // win
    if nwin == 0:
        return x
    frames = x[: nwin * win].reshape(nwin, win)
    frame_rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)
    thresh = peak * (10.0 ** (-35.0 / 20.0))
    active = frame_rms[frame_rms >= thresh]
    cur_rms = float(np.sqrt(np.mean(active ** 2))) if len(active) > 0 else float(np.sqrt(np.mean(frame_rms ** 2)))
    target = 10.0 ** (target_dbfs / 20.0)
    gain = min(target / max(cur_rms, 1e-9), 0.92 / peak)
    return (x * gain).astype(np.float32)


def apply_cosine_fades(x: np.ndarray, fade_in_ms: float = 20.0, fade_out_ms: float = 30.0) -> np.ndarray:
    y = x.copy()
    n = y.shape[0]
    fi = min(n // 2, int(round(fade_in_ms * SR / 1000.0)))
    fo = min(n // 2, int(round(fade_out_ms * SR / 1000.0)))
    if fi > 0:
        env = 0.5 * (1.0 - np.cos(np.linspace(0.0, math.pi, fi, dtype=np.float32)))
        y[:fi] *= env[:, None] if y.ndim == 2 else env
    if fo > 0:
        env = 0.5 * (1.0 + np.cos(np.linspace(0.0, math.pi, fo, dtype=np.float32)))
        y[-fo:] *= env[:, None] if y.ndim == 2 else env
    return y


def constant_power_gains(pan: float) -> tuple[float, float]:
    """Exact match to src/audio/pan.ts: theta = (pan + 1) * pi / 4, L = cos, R = sin."""
    clamped = max(-1.0, min(1.0, pan))
    theta = ((clamped + 1.0) * math.pi) / 4.0
    return math.cos(theta), math.sin(theta)


def pan_bin(pan: float) -> str:
    if pan <= -0.65:
        return "Hard L"
    if pan <= -0.15:
        return "Mid L"
    if pan < 0.15:
        return "Center"
    if pan < 0.65:
        return "Mid R"
    return "Hard R"


def find_speech_pauses(x: np.ndarray, min_pause_sec: float = 0.30, margin_sec: float = 1.0) -> list[tuple[float, float]]:
    win = int(0.02 * SR)
    nwin = len(x) // win
    frames = x[: nwin * win].reshape(nwin, win)
    rms_db = 20.0 * np.log10(np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12))
    quiet = rms_db < -38.0
    pauses: list[tuple[float, float]] = []
    start = None
    dur = len(x) / SR
    for i, q in enumerate(quiet):
        if q and start is None:
            start = i
        elif not q and start is not None:
            t0 = start * 0.02
            t1 = i * 0.02
            if (t1 - t0) >= min_pause_sec and t0 >= margin_sec and t1 <= dur - margin_sec:
                pauses.append((t0, t1))
            start = None
    return pauses


def find_active_speech_windows(x: np.ndarray, min_dur_sec: float = 0.7, margin_sec: float = 1.2) -> list[tuple[float, float]]:
    win = int(0.05 * SR)
    nwin = len(x) // win
    frames = x[: nwin * win].reshape(nwin, win)
    rms_db = 20.0 * np.log10(np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12))
    active = rms_db > -28.0
    spans: list[tuple[float, float]] = []
    start = None
    dur = len(x) / SR
    for i, a in enumerate(active):
        if a and start is None:
            start = i
        elif not a and start is not None:
            t0 = start * 0.05
            t1 = i * 0.05
            if (t1 - t0) >= min_dur_sec and t0 >= margin_sec and t1 <= dur - margin_sec:
                spans.append((t0, t1))
            start = None
    return spans


def find_peak_sibilance_time(x: np.ndarray, margin_sec: float = 1.2) -> float:
    """Find the timestamp with strongest 6-9.5 kHz energy inside [margin, dur-margin]."""
    n_fft = 1024
    hop = 256
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / SR)
    sib_mask = (freqs >= 6000.0) & (freqs <= 9500.0)
    win = np.hanning(n_fft).astype(np.float32)
    best_t = len(x) / (2.0 * SR)
    best_e = -1.0
    dur = len(x) / SR
    for start in range(0, len(x) - n_fft, hop):
        t = (start + n_fft / 2) / SR
        if t < margin_sec or t > dur - margin_sec:
            continue
        spec = np.abs(np.fft.rfft(x[start : start + n_fft] * win)) ** 2
        e = float(np.sum(spec[sib_mask]))
        if e > best_e:
            best_e = e
            best_t = t
    return best_t


def make_10s_speech_bed(
    takes: list[np.ndarray],
    rng: random.Random,
    target_sec: float = 10.0,
    ensure_pause_sec: float = 0.45,
) -> np.ndarray:
    """
    Build a realistic 10.0s mono speech track (without room tone yet) from real takes.
    If a take is >= 10s, slice a 10s window; if shorter, combine two excerpts separated
    by a natural 0.5-0.8s pause so there is always natural pause structure.
    """
    n_total = int(round(target_sec * SR))
    chosen = rng.choice(takes)
    if len(chosen) >= n_total + int(0.4 * SR):
        max_start = len(chosen) - n_total
        # Try to pick a slice that has an internal pause if requested
        best_slice = None
        for _ in range(12):
            s0 = rng.randint(0, max_start)
            cand = chosen[s0 : s0 + n_total].copy()
            if not ensure_pause_sec or find_speech_pauses(cand, min_pause_sec=ensure_pause_sec):
                best_slice = cand
                break
        if best_slice is None:
            s0 = rng.randint(0, max_start)
            best_slice = chosen[s0 : s0 + n_total].copy()
        return apply_cosine_fades(active_rms_normalize(best_slice, -20.0), 25, 40)

    # Combine two takes with a natural internal pause around the middle
    t_a = active_rms_normalize(chosen, -20.0)
    other = rng.choice([t for t in takes if t is not chosen] or takes)
    t_b = active_rms_normalize(other, -20.0)
    out = np.zeros(n_total, dtype=np.float32)

    lead = int(round(rng.uniform(0.25, 0.55) * SR))
    pause = int(round(rng.uniform(0.55, 0.90) * SR))
    len_a = min(len(t_a), int(round(rng.uniform(3.6, 5.2) * SR)))
    seg_a = apply_cosine_fades(t_a[:len_a], 20, 35)
    out[lead : lead + len_a] += seg_a

    start_b = lead + len_a + pause
    rem = n_total - start_b - int(0.25 * SR)
    if rem > int(1.0 * SR):
        len_b = min(len(t_b), rem)
        seg_b = apply_cosine_fades(t_b[:len_b], 20, 35)
        out[start_b : start_b + len_b] += seg_b
    return out


# ---------------------------------------------------------------------------
# Defect Injection Helpers (Battery 1 & 2B)
# ---------------------------------------------------------------------------

def inject_click(x: np.ndarray, t_sec: float, peak_dbfs: float = -3.0, width_ms: float = 2.5, rng: random.Random | None = None) -> np.ndarray:
    """Inject a crisp 2-3 ms broadband digital click/pop transient at t_sec."""
    y = x.copy()
    n_click = max(16, int(round(width_ms * SR / 1000.0)))
    idx = int(round(t_sec * SR)) - n_click // 2
    idx = max(0, min(len(y) - n_click, idx))

    np_rng = np.random.default_rng(rng.randint(0, 2**31 - 1) if rng else 42)
    # Sharp bipolar impulse + high-frequency broadband burst with rapid exponential decay
    burst = np_rng.standard_normal(n_click).astype(np.float32)
    # First-order high-pass to make it a genuine crisp digital click across upper bands
    burst[1:] = burst[1:] - 0.85 * burst[:-1]
    t_env = np.linspace(0.0, 1.0, n_click, dtype=np.float32)
    env = np.exp(-5.0 * t_env)
    burst = burst * env
    # Anchor sharp initial impulse sample
    burst[2] = np.sign(burst[2] or 1.0) * float(np.max(np.abs(burst)) * 1.35)
    burst /= float(np.max(np.abs(burst)) + 1e-9)
    amp = 10.0 ** (peak_dbfs / 20.0)
    y[idx : idx + n_click] = np.clip(y[idx : idx + n_click] + burst * amp, -0.999, 0.999)
    return y


def inject_dropout(x: np.ndarray, t_center_sec: float, duration_ms: float = 150.0, edge_ms: float = 5.0) -> tuple[np.ndarray, float, float]:
    """
    Mute audio (including room tone) to exact 0.0 (-inf dBFS) for `duration_ms`
    with gentle `edge_ms` cosine ramps so there is NO artificial boundary click.
    """
    y = x.copy()
    n_drop = int(round(duration_ms * SR / 1000.0))
    n_edge = max(1, int(round(edge_ms * SR / 1000.0)))
    start = int(round(t_center_sec * SR)) - n_drop // 2
    start = max(n_edge, min(len(y) - n_drop - n_edge, start))
    end = start + n_drop

    # Smooth fade-out into exact zero, then smooth fade-in out of exact zero
    fade_down = 0.5 * (1.0 + np.cos(np.linspace(0.0, math.pi, n_edge, dtype=np.float32)))
    fade_up = 0.5 * (1.0 - np.cos(np.linspace(0.0, math.pi, n_edge, dtype=np.float32)))
    y[start - n_edge : start] *= fade_down
    y[start:end] = 0.0
    y[end : end + n_edge] *= fade_up
    return y, start / SR, end / SR


def inject_hard_clip(x: np.ndarray, t_start_sec: float, duration_sec: float = 0.6, boost_db: float = 12.0, ceiling_dbfs: float = -0.1) -> tuple[np.ndarray, float, float]:
    """Apply heavy gain + hard digital clipping over a speech phrase."""
    y = x.copy()
    s0 = max(0, int(round(t_start_sec * SR)))
    s1 = min(len(y), s0 + int(round(duration_sec * SR)))
    gain = 10.0 ** (boost_db / 20.0)
    ceil = 10.0 ** (ceiling_dbfs / 20.0)

    seg = y[s0:s1]
    clipped = np.clip(seg * gain, -ceil, ceil)
    # Short 15ms crossfade at edges of the clipped phrase
    xf = min(len(seg) // 4, int(0.015 * SR))
    blend = np.ones(len(seg), dtype=np.float32)
    if xf > 0:
        blend[:xf] = np.linspace(0.0, 1.0, xf, dtype=np.float32)
        blend[-xf:] = np.linspace(1.0, 0.0, xf, dtype=np.float32)
    y[s0:s1] = seg * (1.0 - blend) + clipped * blend
    return y, s0 / SR, s1 / SR


def apply_peaking_eq_ffmpeg(x: np.ndarray, fc: float, q: float, gain_db: float) -> np.ndarray:
    """Apply exact FFmpeg peaking equalizer to mono float32 array."""
    pcm = run_ffmpeg(
        [
            "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0",
            "-af", f"equalizer=f={fc:.1f}:t=q:w={q:.2f}:g={gain_db:.1f}",
            "-f", "f32le", "pipe:1",
        ],
        stdin_bytes=x.astype(np.float32).tobytes(),
    )
    y = np.frombuffer(pcm, dtype=np.float32).copy()
    if len(y) < len(x):
        y = np.pad(y, (0, len(x) - len(y)))
    return y[: len(x)]


def inject_sibilance_spike(x: np.ndarray, t_center_sec: float, duration_sec: float = 0.42, gain_db: float = 12.0, fc: float = 7500.0, q: float = 4.0) -> tuple[np.ndarray, float, float]:
    """Boost narrowband 7.5 kHz sibilance smoothly over a 0.4s sibilant region."""
    eq_full = apply_peaking_eq_ffmpeg(x, fc=fc, q=q, gain_db=gain_db)
    y = x.copy()
    n_seg = int(round(duration_sec * SR))
    s0 = max(0, int(round(t_center_sec * SR)) - n_seg // 2)
    s1 = min(len(y), s0 + n_seg)
    xf = min((s1 - s0) // 4, int(0.025 * SR))
    blend = np.ones(s1 - s0, dtype=np.float32)
    if xf > 0:
        blend[:xf] = np.linspace(0.0, 1.0, xf, dtype=np.float32)
        blend[-xf:] = np.linspace(1.0, 0.0, xf, dtype=np.float32)
    y[s0:s1] = np.clip(x[s0:s1] * (1.0 - blend) + eq_full[s0:s1] * blend, -0.99, 0.99)
    return y, s0 / SR, s1 / SR


# ---------------------------------------------------------------------------
# Pure-NumPy DSP Analysis (Log-Mel Spectrogram, RMS, Pan Ribbon)
# ---------------------------------------------------------------------------

def hz_to_mel(hz: np.ndarray | float) -> np.ndarray:
    return 2595.0 * np.log10(1.0 + np.asarray(hz, dtype=np.float64) / 700.0)


def mel_to_hz(mel: np.ndarray | float) -> np.ndarray:
    return 700.0 * (10.0 ** (np.asarray(mel, dtype=np.float64) / 2595.0) - 1.0)


def build_mel_filterbank(sr: int, n_fft: int, n_mels: int = 128, fmin: float = 50.0, fmax: float = 16000.0) -> tuple[np.ndarray, np.ndarray]:
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    mel_pts = np.linspace(float(hz_to_mel(fmin)), float(hz_to_mel(fmax)), n_mels + 2)
    hz_pts = mel_to_hz(mel_pts)
    fb = np.zeros((n_mels, len(freqs)), dtype=np.float64)
    for m in range(n_mels):
        f_left, f_center, f_right = hz_pts[m], hz_pts[m + 1], hz_pts[m + 2]
        up = (freqs - f_left) / max(f_center - f_left, 1e-9)
        down = (f_right - freqs) / max(f_right - f_center, 1e-9)
        tri = np.maximum(0.0, np.minimum(up, down))
        s = np.sum(tri)
        if s > 0:
            tri /= s  # preserve dB power density across mel bands
        else:
            # Mel center fell strictly between two FFT bins at low frequency:
            # linearly interpolate between the two bracketing FFT bins.
            hi = int(np.searchsorted(freqs, f_center))
            hi = max(1, min(len(freqs) - 1, hi))
            lo = hi - 1
            alpha = (f_center - freqs[lo]) / max(freqs[hi] - freqs[lo], 1e-9)
            tri[lo] = 1.0 - alpha
            tri[hi] = alpha
        fb[m] = tri
    return fb, hz_pts[1:-1]


def compute_log_mel_db(x: np.ndarray, n_fft: int = 1024, hop: int = 128, n_mels: int = 128, fmin: float = 50.0, fmax: float = 16000.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Compute dBFS-calibrated Log-Mel spectrogram (n_mels x n_frames)."""
    if x.ndim == 2:
        mono = 0.5 * (x[:, 0] + x[:, 1])
    else:
        mono = x
    pad = n_fft // 2
    padded = np.pad(mono.astype(np.float64), (pad, pad), mode="reflect")
    n_frames = 1 + (len(padded) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + (np.arange(n_frames) * hop)[:, None]
    frames = padded[idx]
    window = np.hanning(n_fft)
    win_norm = np.sum(window) / 2.0  # coherent gain for sine wave peak=1 -> 0 dBFS
    mag = np.abs(np.fft.rfft(frames * window[None, :], axis=1)) / win_norm
    power = mag ** 2
    fb, mel_hz = build_mel_filterbank(SR, n_fft, n_mels=n_mels, fmin=fmin, fmax=fmax)
    mel_power = fb @ power.T  # (n_mels, n_frames)
    mel_db = 10.0 * np.log10(np.maximum(mel_power, 1e-12))
    times = (np.arange(n_frames) * hop) / SR
    return mel_db, times, mel_hz


def compute_waveform_envelope(x: np.ndarray, n_bins: int = 1600) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Peak-preserving min/max envelope per horizontal pixel column (never misses a 2ms click!)."""
    n = len(x)
    edges = np.linspace(0, n, n_bins + 1, dtype=np.int64)
    mins = np.empty(n_bins, dtype=np.float32)
    maxs = np.empty(n_bins, dtype=np.float32)
    for i in range(n_bins):
        a, b = int(edges[i]), int(edges[i + 1])
        if b <= a:
            b = min(n, a + 1)
        seg = x[a:b]
        mins[i] = float(np.min(seg))
        maxs[i] = float(np.max(seg))
    times = ((edges[:-1] + edges[1:]) * 0.5) / SR
    return times, mins, maxs


def compute_windowed_stereo_metrics(stereo: np.ndarray, win_ms: float = 100.0, hop_ms: float = 20.0) -> dict[str, np.ndarray]:
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

    rms_l_db = 10.0 * np.log10(np.maximum(e_l, 1e-12))
    rms_r_db = 10.0 * np.log10(np.maximum(e_r, 1e-12))
    total_e = e_l + e_r
    total_rms_db = 10.0 * np.log10(np.maximum(total_e * 0.5, 1e-12))
    pan_idx = (e_r - e_l) / np.maximum(total_e, 1e-12)
    rl_diff_db = np.clip(rms_r_db - rms_l_db, -18.0, 18.0)

    return {
        "times": t,
        "rms_l_db": rms_l_db,
        "rms_r_db": rms_r_db,
        "total_rms_db": total_rms_db,
        "pan_idx": pan_idx,
        "rl_diff_db": rl_diff_db,
    }


# ---------------------------------------------------------------------------
# PNG Saving & Metadata Scrubbing
# ---------------------------------------------------------------------------

def save_clean_png_from_figure(fig: plt.Figure, out_path: Path) -> None:
    """Render matplotlib figure to exact 1600x900 PNG with ALL metadata chunks stripped."""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=DPI, facecolor=fig.get_facecolor())
    plt.close(fig)
    buf.seek(0)
    im = Image.open(buf).convert("RGB")
    if im.size != (CANVAS_W, CANVAS_H):
        im = im.resize((CANVAS_W, CANVAS_H), Image.Resampling.LANCZOS)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_path, format="PNG", pnginfo=PngImagePlugin.PngInfo(), optimize=True)


def save_clean_png_from_bytes(png_bytes: bytes, out_path: Path) -> None:
    """Strip all PNG metadata chunks (e.g. FFmpeg encoder/title tags) via Pillow."""
    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_path, format="PNG", pnginfo=PngImagePlugin.PngInfo(), optimize=True)


def write_wav_file(path: Path, audio: np.ndarray) -> None:
    """Write float32 mono or stereo array as 16-bit PCM WAV (48 kHz)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(audio, -1.0, 1.0)
    pcm16 = (clipped * 32767.0).astype(np.int16)
    ch = 2 if audio.ndim == 2 else 1
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(ch)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm16.tobytes())


# ---------------------------------------------------------------------------
# Custom Plot Renderers (1600x900, High-Contrast Studio Theme)
# ---------------------------------------------------------------------------

BG_FIG = "#0d1117"
BG_AX = "#11161f"
FG_TEXT = "#e6edf3"
FG_MUTED = "#9ba7b4"
GRID_MAJOR = "#2e3948"
GRID_MINOR = "#1d2530"
CYAN = "#38bdf8"
AMBER = "#fbbf24"
MAGENTA = "#f472b6"


def style_time_axis(ax: plt.Axes, duration_sec: float, show_xlabel: bool = True) -> None:
    ax.set_xlim(0.0, duration_sec)
    ax.xaxis.set_major_locator(mticker.MultipleLocator(1.0))
    ax.xaxis.set_minor_locator(mticker.MultipleLocator(0.2))
    ax.grid(True, which="major", axis="x", color=GRID_MAJOR, linewidth=0.9, alpha=0.85)
    ax.grid(True, which="minor", axis="x", color=GRID_MINOR, linewidth=0.5, alpha=0.65)
    ax.tick_params(axis="x", colors=FG_TEXT, labelsize=13, which="major", length=6)
    ax.tick_params(axis="x", colors=FG_MUTED, which="minor", length=3)
    if show_xlabel:
        ax.set_xlabel("Time (seconds)", color=FG_TEXT, fontsize=14, fontweight="bold", labelpad=8)
    else:
        ax.tick_params(axis="x", labelbottom=False)
    for spine in ax.spines.values():
        spine.set_color("#3b4758")


def render_f1_waveform_logmel(audio: np.ndarray, title: str, out_path: Path) -> None:
    """Style F1 (and Battery 1 default): 35% Amplitude Waveform + 65% Log-Mel Spectrogram (50Hz-16kHz)."""
    mono = 0.5 * (audio[:, 0] + audio[:, 1]) if audio.ndim == 2 else audio
    duration = len(mono) / SR

    fig = plt.figure(figsize=(CANVAS_W / DPI, CANVAS_H / DPI), dpi=DPI, facecolor=BG_FIG)
    gs = fig.add_gridspec(
        nrows=2, ncols=2,
        height_ratios=[35, 65],
        width_ratios=[96, 2.2],
        left=0.07, right=0.935, top=0.925, bottom=0.085,
        hspace=0.10, wspace=0.015,
    )
    ax_w = fig.add_subplot(gs[0, 0], facecolor=BG_AX)
    ax_s = fig.add_subplot(gs[1, 0], facecolor=BG_AX)
    ax_cb = fig.add_subplot(gs[1, 1], facecolor=BG_FIG)

    fig.suptitle(title, color=FG_TEXT, fontsize=17, fontweight="bold", y=0.972)

    # Top panel: Peak-preserving waveform
    wt, wmin, wmax = compute_waveform_envelope(mono, n_bins=1600)
    ax_w.fill_between(wt, wmin, wmax, color=CYAN, alpha=0.92, linewidth=0)
    ax_w.axhline(0.0, color="#475569", linewidth=0.8)
    for level in (-0.5, 0.5):
        ax_w.axhline(level, color="#64748b", linewidth=0.7, linestyle="--", alpha=0.65)
    ax_w.set_ylim(-1.05, 1.05)
    ax_w.set_yticks([-1.0, -0.5, 0.0, 0.5, 1.0])
    ax_w.set_yticklabels(["-1.0", "-0.5", "0.0", "+0.5", "+1.0"], fontsize=12, color=FG_TEXT)
    ax_w.set_ylabel("Amplitude", color=FG_TEXT, fontsize=13, fontweight="bold")
    ax_w.grid(True, which="major", axis="y", color=GRID_MAJOR, linewidth=0.7, alpha=0.7)
    style_time_axis(ax_w, duration, show_xlabel=False)

    # Bottom panel: Log-Mel spectrogram
    mel_db, stimes, mel_hz = compute_log_mel_db(mono, n_fft=1024, hop=128, n_mels=128, fmin=50.0, fmax=16000.0)
    im = ax_s.imshow(
        mel_db,
        origin="lower",
        aspect="auto",
        extent=[0.0, duration, 0, len(mel_hz) - 1],
        cmap="magma",
        vmin=-80.0,
        vmax=0.0,
        interpolation="nearest",
    )

    freq_ticks_hz = [100, 250, 500, 1000, 2000, 4000, 8000, 16000]
    freq_labels = ["100 Hz", "250 Hz", "500 Hz", "1 kHz", "2 kHz", "4 kHz", "8 kHz", "16 kHz"]
    tick_positions = [float(np.interp(f, mel_hz, np.arange(len(mel_hz)))) for f in freq_ticks_hz]
    ax_s.set_yticks(tick_positions)
    ax_s.set_yticklabels(freq_labels, fontsize=12, color=FG_TEXT)
    ax_s.set_ylabel("Frequency (Log-Mel)", color=FG_TEXT, fontsize=13, fontweight="bold")
    ax_s.grid(True, which="major", axis="y", color="#ffffff", linewidth=0.5, alpha=0.22)
    style_time_axis(ax_s, duration, show_xlabel=True)

    # Colorbar
    cbar = fig.colorbar(im, cax=ax_cb)
    cbar.set_ticks([-80, -60, -40, -24, -12, -6, 0])
    cbar.set_ticklabels(["-80", "-60", "-40", "-24", "-12", "-6", "0 dB"])
    cbar.ax.tick_params(colors=FG_TEXT, labelsize=12)
    cbar.set_label("Level (dBFS)", color=FG_TEXT, fontsize=13, fontweight="bold", labelpad=8)
    cbar.outline.set_edgecolor("#3b4758")

    save_clean_png_from_figure(fig, out_path)


def render_f4_pure_ffmpeg(audio: np.ndarray, title: str, out_path: Path) -> None:
    """
    Style F4: Pure FFmpeg Native Render (`showwavespic` + `showspectrumpic` stacked via `vstack`).
    Uses an exact 1600x900 canvas with aligned time axes and zero custom matplotlib code.
    """
    mono = 0.5 * (audio[:, 0] + audio[:, 1]) if audio.ndim == 2 else audio
    with tempfile.TemporaryDirectory() as td:
        wav_path = Path(td) / "input.wav"
        write_wav_file(wav_path, mono)

        # showspectrumpic(s=1316x522, legend=1) outputs exact 1600x650 (142px left & right margins).
        # Its spectrogram plot area sits at x=[142 .. 1458] (1316px wide).
        # Align showwavespic(1316x250) inside a 1600x250 dark canvas at x=142 so time aligns pixel-for-pixel!
        fc = (
            "[0:a]asplit=2[a1][a2];"
            "[a1]showwavespic=s=1316x250:colors=#38bdf8:split_channels=0:scale=lin:filter=peak[wraw];"
            "color=c=#0d1117:s=1600x250:d=1[bg];"
            "[bg][wraw]overlay=x=142:y=0:shortest=1,format=rgb24[w];"
            "[a2]showspectrumpic=s=1316x522:mode=combined:color=magma:scale=log:fscale=log:gain=1:drange=100:legend=1,format=rgb24[s];"
            "[w][s]vstack=inputs=2[out]"
        )
        png_bytes = run_ffmpeg([
            "-i", str(wav_path),
            "-filter_complex", fc,
            "-map", "[out]",
            "-frames:v", "1",
            "-f", "image2pipe",
            "-vcodec", "png",
            "pipe:1",
        ])

    # Overlay ONLY the neutral Trial ID banner cleanly (or keep pure ffmpeg + scrubbed metadata)
    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    # Paint over the default ffmpeg filename header line at the very top of showspectrumpic legend
    # (y = 250..280) so "input.wav" isn't distracting, and write neutral title at top center
    from PIL import ImageDraw, ImageFont
    draw = ImageDraw.Draw(im)
    # Mask ffmpeg's auto-printed "input.wav ..." caption bar inside legend top if present
    draw.rectangle([142, 250, 1458, 276], fill=(0, 0, 0))
    try:
        font = ImageFont.truetype("arialbd.ttf", 22)
    except Exception:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), title, font=font)
    tw = bbox[2] - bbox[0]
    draw.text(((im.width - tw) // 2, 10), title, fill=(230, 237, 243), font=font)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_path, format="PNG", pnginfo=PngImagePlugin.PngInfo(), optimize=True)


def render_s1_split_waveforms(stereo: np.ndarray, title: str, out_path: Path) -> None:
    """Style S1: Split Stacked L/R Waveforms with identical linear y-axis."""
    duration = stereo.shape[0] / SR
    fig, (ax_l, ax_r) = plt.subplots(
        2, 1, figsize=(CANVAS_W / DPI, CANVAS_H / DPI), dpi=DPI, facecolor=BG_FIG, sharex=True
    )
    fig.subplots_adjust(left=0.075, right=0.97, top=0.915, bottom=0.09, hspace=0.14)
    fig.suptitle(title, color=FG_TEXT, fontsize=17, fontweight="bold", y=0.968)

    for ax, ch_data, color, label in [
        (ax_l, stereo[:, 0], CYAN, "Left Channel (L)"),
        (ax_r, stereo[:, 1], AMBER, "Right Channel (R)"),
    ]:
        ax.set_facecolor(BG_AX)
        wt, wmin, wmax = compute_waveform_envelope(ch_data, n_bins=1600)
        ax.fill_between(wt, wmin, wmax, color=color, alpha=0.92, linewidth=0)
        ax.axhline(0.0, color="#475569", linewidth=0.9)
        for lvl in (-0.5, 0.5):
            ax.axhline(lvl, color="#64748b", linewidth=0.7, linestyle="--", alpha=0.65)
        ax.set_ylim(-1.05, 1.05)
        ax.set_yticks([-1.0, -0.5, 0.0, 0.5, 1.0])
        ax.set_yticklabels(["-1.0", "-0.5", "0.0", "+0.5", "+1.0"], fontsize=12, color=FG_TEXT)
        ax.set_ylabel(label, color=color, fontsize=14, fontweight="bold")
        ax.grid(True, which="major", axis="y", color=GRID_MAJOR, linewidth=0.7, alpha=0.7)

    style_time_axis(ax_l, duration, show_xlabel=False)
    style_time_axis(ax_r, duration, show_xlabel=True)
    save_clean_png_from_figure(fig, out_path)


def render_s2_waveform_pan_ribbon(stereo: np.ndarray, title: str, out_path: Path) -> None:
    """
    Style S2: Top = Combined L/R Waveform (Cyan=L, Amber=R overlay)
              Bottom = Gated L-R Pan Balance Ribbon P(t) = (E_R - E_L)/(E_R + E_L) in [-1, +1]
                       alpha-masked/dimmed whenever total RMS < -45 dBFS.
    """
    duration = stereo.shape[0] / SR
    metrics = compute_windowed_stereo_metrics(stereo, win_ms=100.0, hop_ms=20.0)
    t = metrics["times"]
    p = metrics["pan_idx"]
    rms_db = metrics["total_rms_db"]

    fig = plt.figure(figsize=(CANVAS_W / DPI, CANVAS_H / DPI), dpi=DPI, facecolor=BG_FIG)
    gs = fig.add_gridspec(
        nrows=2, ncols=1, height_ratios=[36, 64],
        left=0.08, right=0.96, top=0.915, bottom=0.09, hspace=0.14,
    )
    ax_w = fig.add_subplot(gs[0], facecolor=BG_AX)
    ax_p = fig.add_subplot(gs[1], facecolor=BG_AX)
    fig.suptitle(title, color=FG_TEXT, fontsize=17, fontweight="bold", y=0.968)

    # Top: L/R overlay waveform
    wt, lmin, lmax = compute_waveform_envelope(stereo[:, 0], n_bins=1600)
    _, rmin, rmax = compute_waveform_envelope(stereo[:, 1], n_bins=1600)
    ax_w.fill_between(wt, lmin, lmax, color=CYAN, alpha=0.55, linewidth=0, label="Left (L)")
    ax_w.fill_between(wt, rmin, rmax, color=AMBER, alpha=0.55, linewidth=0, label="Right (R)")
    ax_w.axhline(0.0, color="#475569", linewidth=0.8)
    ax_w.set_ylim(-1.05, 1.05)
    ax_w.set_yticks([-1.0, -0.5, 0.0, 0.5, 1.0])
    ax_w.set_yticklabels(["-1.0", "-0.5", "0.0", "+0.5", "+1.0"], fontsize=12, color=FG_TEXT)
    ax_w.set_ylabel("L/R Waveform", color=FG_TEXT, fontsize=13, fontweight="bold")
    ax_w.legend(loc="upper right", facecolor="#161b22", edgecolor="#3b4758", labelcolor=FG_TEXT, fontsize=12, ncol=2)
    ax_w.grid(True, which="major", axis="y", color=GRID_MAJOR, linewidth=0.7, alpha=0.7)
    style_time_axis(ax_w, duration, show_xlabel=False)

    # Bottom: Gated L-R Pan Balance Ribbon
    pan_cmap = LinearSegmentedColormap.from_list("pan_cmap", ["#22d3ee", "#e2e8f0", "#f59e0b"])
    norm = Normalize(vmin=-1.0, vmax=1.0)

    # Subtle background zones
    ax_p.axhspan(-1.05, -0.65, color="#0e7490", alpha=0.10)
    ax_p.axhspan(0.65, 1.05, color="#b45309", alpha=0.10)
    ax_p.axhline(0.0, color="#cbd5e1", linewidth=1.2, linestyle="-", alpha=0.8)
    for y_g in (-0.5, 0.5):
        ax_p.axhline(y_g, color="#64748b", linewidth=0.9, linestyle="--", alpha=0.75)

    # Smooth alpha gate: 0 below -45 dBFS, 1 above -36 dBFS
    alpha_arr = np.clip((rms_db - (-45.0)) / 9.0, 0.0, 1.0)

    # Draw vertical ribbon bars from 0 -> P(t) + thick colored trace where active
    dt = float(t[1] - t[0]) if len(t) > 1 else 0.02
    for i in range(len(t)):
        a = float(alpha_arr[i])
        if a <= 0.02:
            continue
        col = list(pan_cmap(norm(p[i])))
        col[3] = 0.55 * a
        ax_p.bar(t[i], p[i], width=dt * 1.15, bottom=0.0, color=col, edgecolor="none", align="center")

    # Crisp foreground curve for active segments
    points = np.array([t, p]).T.reshape(-1, 1, 2)
    segs = np.concatenate([points[:-1], points[1:]], axis=1)
    seg_alphas = 0.5 * (alpha_arr[:-1] + alpha_arr[1:])
    seg_colors = pan_cmap(norm(0.5 * (p[:-1] + p[1:])))
    seg_colors[:, 3] = np.where(seg_alphas > 0.05, np.clip(seg_alphas * 1.1, 0.0, 1.0), 0.0)
    lc = LineCollection(segs, colors=seg_colors, linewidths=3.2)
    ax_p.add_collection(lc)

    ax_p.set_ylim(-1.08, 1.08)
    ax_p.set_yticks([-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 1.0])
    ax_p.set_yticklabels(["-1.0 (L)", "-0.75", "-0.50", "-0.25", "0.0 (C)", "+0.25", "+0.50", "+0.75", "+1.0 (R)"], fontsize=12, color=FG_TEXT)
    ax_p.set_ylabel("Pan Index  (E_R - E_L)/(E_R + E_L)", color=FG_TEXT, fontsize=13, fontweight="bold")
    ax_p.grid(True, which="major", axis="y", color=GRID_MAJOR, linewidth=0.7, alpha=0.6)
    ax_p.text(
        0.01, 0.94, "Gated below -45 dBFS  |  Cyan = Left (-1.0)   White = Center (0.0)   Amber = Right (+1.0)",
        transform=ax_p.transAxes, color=FG_MUTED, fontsize=11.5, va="top",
        bbox=dict(boxstyle="round,pad=0.3", facecolor="#0d1117", edgecolor="#3b4758", alpha=0.85),
    )
    style_time_axis(ax_p, duration, show_xlabel=True)
    save_clean_png_from_figure(fig, out_path)


def render_s3_rms_and_diff(stereo: np.ndarray, title: str, out_path: Path) -> None:
    """
    Style S3: Top = Split L/R Short-Term RMS Curves (150ms, -60..0 dBFS, Cyan=L, Amber=R)
              Bottom = R - L Level Delta Strip (-18..+18 dB, zero-centered, gated < -45 dBFS).
    """
    duration = stereo.shape[0] / SR
    metrics = compute_windowed_stereo_metrics(stereo, win_ms=150.0, hop_ms=20.0)
    t = metrics["times"]
    rms_l = np.clip(metrics["rms_l_db"], -65.0, 0.0)
    rms_r = np.clip(metrics["rms_r_db"], -65.0, 0.0)
    diff_db = metrics["rl_diff_db"]
    total_db = metrics["total_rms_db"]

    fig = plt.figure(figsize=(CANVAS_W / DPI, CANVAS_H / DPI), dpi=DPI, facecolor=BG_FIG)
    gs = fig.add_gridspec(
        nrows=2, ncols=1, height_ratios=[55, 45],
        left=0.08, right=0.96, top=0.915, bottom=0.09, hspace=0.14,
    )
    ax_rms = fig.add_subplot(gs[0], facecolor=BG_AX)
    ax_dif = fig.add_subplot(gs[1], facecolor=BG_AX)
    fig.suptitle(title, color=FG_TEXT, fontsize=17, fontweight="bold", y=0.968)

    # Top: L/R RMS curves
    ax_rms.plot(t, rms_l, color=CYAN, linewidth=2.2, label="Left RMS (dBFS)", alpha=0.95)
    ax_rms.plot(t, rms_r, color=AMBER, linewidth=2.2, label="Right RMS (dBFS)", alpha=0.95)
    ax_rms.axhline(-45.0, color="#64748b", linewidth=0.9, linestyle=":", alpha=0.8)
    ax_rms.set_ylim(-62.0, 2.0)
    ax_rms.set_yticks([-60, -48, -36, -24, -18, -12, -6, 0])
    ax_rms.set_yticklabels(["-60", "-48", "-36", "-24", "-18", "-12", "-6", "0 dB"], fontsize=12, color=FG_TEXT)
    ax_rms.set_ylabel("Short-Term RMS (150ms)", color=FG_TEXT, fontsize=13, fontweight="bold")
    ax_rms.legend(loc="upper right", facecolor="#161b22", edgecolor="#3b4758", labelcolor=FG_TEXT, fontsize=12, ncol=2)
    ax_rms.grid(True, which="major", axis="y", color=GRID_MAJOR, linewidth=0.75, alpha=0.75)
    style_time_axis(ax_rms, duration, show_xlabel=False)

    # Bottom: R - L delta (gated below -45 dBFS)
    gated_diff = np.where(total_db >= -45.0, diff_db, np.nan)
    ax_dif.axhline(0.0, color="#cbd5e1", linewidth=1.2)
    for lvl in (-12, -6, 6, 12):
        ax_dif.axhline(lvl, color="#64748b", linewidth=0.7, linestyle="--", alpha=0.65)
    ax_dif.fill_between(t, 0.0, gated_diff, where=(gated_diff >= 0.0), color=AMBER, alpha=0.45, interpolate=False)
    ax_dif.fill_between(t, 0.0, gated_diff, where=(gated_diff < 0.0), color=CYAN, alpha=0.45, interpolate=False)
    ax_dif.plot(t, gated_diff, color=FG_TEXT, linewidth=1.8)
    ax_dif.set_ylim(-19.5, 19.5)
    ax_dif.set_yticks([-18, -12, -6, 0, 6, 12, 18])
    ax_dif.set_yticklabels(["-18 dB (L)", "-12", "-6", "0 (C)", "+6", "+12", "+18 dB (R)"], fontsize=12, color=FG_TEXT)
    ax_dif.set_ylabel("R - L Delta (dB)", color=FG_TEXT, fontsize=13, fontweight="bold")
    ax_dif.grid(True, which="major", axis="y", color=GRID_MAJOR, linewidth=0.7, alpha=0.65)
    ax_dif.text(
        0.01, 0.92, "Gated below -45 dBFS  |  Negative (Cyan) = Left louder   Positive (Amber) = Right louder",
        transform=ax_dif.transAxes, color=FG_MUTED, fontsize=11.5, va="top",
        bbox=dict(boxstyle="round,pad=0.3", facecolor="#0d1117", edgecolor="#3b4758", alpha=0.85),
    )
    style_time_axis(ax_dif, duration, show_xlabel=True)
    save_clean_png_from_figure(fig, out_path)


# ---------------------------------------------------------------------------
# Phase 1 Battery Builders
# ---------------------------------------------------------------------------

def load_corpus() -> tuple[list[tuple[str, np.ndarray]], list[tuple[str, np.ndarray]], list[tuple[str, np.ndarray]]]:
    all_takes: list[tuple[str, np.ndarray]] = []
    speaker_a_takes: list[tuple[str, np.ndarray]] = []
    margaux_takes: list[tuple[str, np.ndarray]] = []
    for d in CORPUS_DIRS:
        if not d.exists():
            continue
        for p in sorted(d.glob("*.wav")):
            arr = load_take_mono_48k(p)
            all_takes.append((p.name, arr))
            sp = SPEAKER_BY_TAKE.get(p.name, "speaker_a")
            if sp == "speaker_a":
                speaker_a_takes.append((p.name, arr))
            else:
                margaux_takes.append((p.name, arr))
    if not all_takes:
        raise RuntimeError(f"No speech takes found under {CORPUS_DIRS}")
    return all_takes, speaker_a_takes, margaux_takes


def build_battery_1(
    all_takes: list[tuple[str, np.ndarray]],
    rng: random.Random,
    out_dir: Path,
    keep_wavs_dir: Path | None,
) -> list[dict[str, Any]]:
    """Battery 1 (Phase 1 Pilot): 10 trials = 4 clean + 6 defects (2 clicks, 1 dropout, 1 clip, 1 floor_shift, 1 sibilance)."""
    raw_arrays = [a for _, a in all_takes]
    specs = [
        {"kind": "clean"},
        {"kind": "clean"},
        {"kind": "clean"},
        {"kind": "clean"},
        {"kind": "click", "placement": "speech"},
        {"kind": "click", "placement": "pause"},
        {"kind": "dropout"},
        {"kind": "clip"},
        {"kind": "floor_shift"},
        {"kind": "sibilance"},
    ]
    rng.shuffle(specs)

    records: list[dict[str, Any]] = []
    for idx, spec in enumerate(specs, start=1):
        trial_id = f"b1_t{idx:02d}"
        title = f"Trial B1-{idx:02d}"
        kind = spec["kind"]

        speech = make_10s_speech_bed(raw_arrays, rng, target_sec=10.0, ensure_pause_sec=0.45)
        rt_seed_l = rng.randint(1000, 999999)
        rt_seed_r = rng.randint(1000, 999999)

        if kind == "floor_shift":
            t0 = round(rng.uniform(2.8, 7.2), 2)
            rt_low = generate_warm_dark_room_tone(10.0, -58.0, 1, rt_seed_l, rt_seed_r)
            rt_hi = generate_warm_dark_room_tone(10.0, -40.0, 1, rt_seed_l + 7, rt_seed_r + 7)
            s0 = int(round(t0 * SR))
            xf = int(0.005 * SR)
            env = np.zeros(len(speech), dtype=np.float32)
            env[s0 + xf :] = 1.0
            env[s0 : s0 + xf] = np.linspace(0.0, 1.0, xf, dtype=np.float32)
            rt = rt_low * (1.0 - env) + rt_hi * env
            audio = np.clip(speech + rt, -0.999, 0.999)
            gt: dict[str, Any] = {
                "hasDefect": True,
                "defectClass": "floor_shift",
                "timestampSec": t0,
                "details": {"fromDbfs": -58.0, "toDbfs": -40.0, "spliceSec": t0},
            }
        else:
            rt = generate_warm_dark_room_tone(10.0, -54.0, 1, rt_seed_l, rt_seed_r)
            audio = np.clip(speech + rt, -0.999, 0.999)
            if kind == "clean":
                gt = {"hasDefect": False, "defectClass": "clean", "timestampSec": None, "details": {}}
            elif kind == "click":
                placement = spec["placement"]
                if placement == "pause":
                    pauses = find_speech_pauses(speech, min_pause_sec=0.35, margin_sec=1.2)
                    t_c = round(sum(rng.choice(pauses)) / 2.0, 3) if pauses else round(rng.uniform(2.0, 8.0), 3)
                else:
                    spans = find_active_speech_windows(speech, min_dur_sec=0.6, margin_sec=1.2)
                    t_c = round(rng.uniform(*rng.choice(spans)), 3) if spans else round(rng.uniform(2.0, 8.0), 3)
                audio = inject_click(audio, t_c, peak_dbfs=-3.0, width_ms=2.5, rng=rng)
                gt = {
                    "hasDefect": True,
                    "defectClass": "click",
                    "timestampSec": round(t_c, 3),
                    "details": {"placement": placement, "peakDbfs": -3.0, "widthMs": 2.5},
                }
            elif kind == "dropout":
                pauses = find_speech_pauses(speech, min_pause_sec=0.35, margin_sec=1.2)
                t_c = sum(max(pauses, key=lambda p: p[1] - p[0])) / 2.0 if pauses else rng.uniform(2.5, 7.5)
                audio, d0, d1 = inject_dropout(audio, t_c, duration_ms=150.0, edge_ms=5.0)
                gt = {
                    "hasDefect": True,
                    "defectClass": "dropout",
                    "timestampSec": round(0.5 * (d0 + d1), 3),
                    "details": {"startSec": round(d0, 3), "endSec": round(d1, 3), "durationMs": 150.0, "edgeFadeMs": 5.0},
                }
            elif kind == "clip":
                spans = find_active_speech_windows(speech, min_dur_sec=0.65, margin_sec=1.2)
                if spans:
                    sp = max(spans, key=lambda s: s[1] - s[0])
                    t_start = rng.uniform(sp[0], max(sp[0], sp[1] - 0.6))
                else:
                    t_start = rng.uniform(2.0, 7.5)
                audio, c0, c1 = inject_hard_clip(audio, t_start, duration_sec=0.6, boost_db=12.0, ceiling_dbfs=-0.1)
                gt = {
                    "hasDefect": True,
                    "defectClass": "clip",
                    "timestampSec": round(0.5 * (c0 + c1), 3),
                    "details": {"startSec": round(c0, 3), "endSec": round(c1, 3), "boostDb": 12.0, "ceilingDbfs": -0.1},
                }
            elif kind == "sibilance":
                t_sib = find_peak_sibilance_time(speech, margin_sec=1.2)
                audio, s0, s1 = inject_sibilance_spike(audio, t_sib, duration_sec=0.42, gain_db=12.0, fc=7500.0, q=4.0)
                gt = {
                    "hasDefect": True,
                    "defectClass": "sibilance",
                    "timestampSec": round(0.5 * (s0 + s1), 3),
                    "details": {"startSec": round(s0, 3), "endSec": round(s1, 3), "fcHz": 7500, "q": 4.0, "gainDb": 12.0},
                }
            else:
                raise ValueError(kind)

        png_path = out_dir / f"{trial_id}.png"
        render_f1_waveform_logmel(audio, title, png_path)
        if keep_wavs_dir:
            write_wav_file(keep_wavs_dir / f"{trial_id}.wav", audio)

        records.append({
            "trialId": trial_id,
            "battery": "b1",
            "filename": png_path.name,
            "style": "F1",
            "durationSec": 10.0,
            **gt,
        })
    return records


def extract_clean_excerpt(take: np.ndarray, dur_sec: float, rng: random.Random) -> np.ndarray:
    """Extract an active speech excerpt of length `dur_sec` with strong speech at both edges."""
    n = int(round(dur_sec * SR))
    norm = active_rms_normalize(take, -20.0)
    if len(norm) <= n:
        return apply_cosine_fades(norm, 20, 30)
    edge = min(n // 4, int(0.35 * SR))
    best = norm[:n]
    best_score = -1.0
    for _ in range(25):
        s0 = rng.randint(0, len(norm) - n)
        cand = norm[s0 : s0 + n]
        e_start = float(np.sqrt(np.mean(cand[:edge] ** 2) + 1e-12))
        e_end = float(np.sqrt(np.mean(cand[-edge:] ** 2) + 1e-12))
        e_all = float(np.sqrt(np.mean(cand ** 2) + 1e-12))
        # Reward excerpts that have genuine audible speech at start AND end (crucial for overlaps!)
        score = min(e_start, e_end) * 2.0 + e_all
        if score > best_score:
            best_score = score
            best = cand
    return apply_cosine_fades(best.copy(), 20, 30)


def build_battery_2a(
    speaker_a_takes: list[tuple[str, np.ndarray]],
    margaux_takes: list[tuple[str, np.ndarray]],
    rng: random.Random,
    out_dir: Path,
    keep_wavs_dir: Path | None,
) -> list[dict[str, Any]]:
    """
    Battery 2A (Phase 1 Pilot): 4 stereo base clips x 3 styles (S1, S2, S3) = 12 shuffled trials.
    Includes alternating wide/mid pans, a mid-clip pan-swap case, and two opposite-side overlaps (-250ms, -500ms).
    """
    e_arrs = [a for _, a in speaker_a_takes]
    m_arrs = [a for _, a in margaux_takes]

    # Define 4 base stereo dialogue timelines (segments: speaker, dur, gap_before, pan)
    base_designs = [
        {
            "clipId": "clip_alt_1",
            "description": "Alternating clean pans [-0.85, 0.0, +0.50, -0.25]",
            "hasPanSwap": False,
            "segments": [
                {"speaker": "speaker_a",   "dur": 2.2, "gapBefore": 0.60, "pan": -0.85},
                {"speaker": "margaux", "dur": 2.1, "gapBefore": 0.45, "pan": 0.00},
                {"speaker": "speaker_a",   "dur": 2.3, "gapBefore": 0.45, "pan": 0.50},
                {"speaker": "margaux", "dur": 2.2, "gapBefore": 0.50, "pan": -0.25},
            ],
        },
        {
            "clipId": "clip_alt_2",
            "description": "Alternating clean pans [+0.85, -0.50, +0.25, 0.0]",
            "hasPanSwap": False,
            "segments": [
                {"speaker": "margaux", "dur": 2.2, "gapBefore": 0.65, "pan": 0.85},
                {"speaker": "speaker_a",   "dur": 2.2, "gapBefore": 0.45, "pan": -0.50},
                {"speaker": "margaux", "dur": 2.1, "gapBefore": 0.50, "pan": 0.25},
                {"speaker": "speaker_a",   "dur": 2.3, "gapBefore": 0.45, "pan": 0.00},
            ],
        },
        {
            "clipId": "clip_pan_swap",
            "description": "Same speaker pan-swap mid-clip (-0.50 -> +0.50 -> -0.85)",
            "hasPanSwap": True,
            "segments": [
                {"speaker": "speaker_a",   "dur": 2.1, "gapBefore": 0.65, "pan": -0.50},
                {"speaker": "margaux", "dur": 2.0, "gapBefore": 0.45, "pan": 0.85},
                {"speaker": "speaker_a",   "dur": 2.2, "gapBefore": 0.45, "pan": 0.50},
                {"speaker": "speaker_a",   "dur": 2.2, "gapBefore": 0.45, "pan": -0.85},
            ],
        },
        {
            "clipId": "clip_overlaps",
            "description": "Two opposite-side negative-offset overlaps (-250ms and -500ms)",
            "hasPanSwap": False,
            "segments": [
                {"speaker": "speaker_a",   "dur": 2.5, "gapBefore": 0.75,  "pan": -0.85},
                {"speaker": "margaux", "dur": 2.4, "gapBefore": -0.25, "pan": 0.50},
                {"speaker": "margaux", "dur": 2.4, "gapBefore": 0.70,  "pan": 0.85},
                {"speaker": "speaker_a",   "dur": 2.5, "gapBefore": -0.50, "pan": -0.50},
            ],
        },
    ]

    # Pre-slice audio excerpts per base clip so the 3 styles compare the exact same speech material
    prepared_clips: list[dict[str, Any]] = []
    for design in base_designs:
        segs_audio = []
        for seg in design["segments"]:
            pool = e_arrs if seg["speaker"] == "speaker_a" else m_arrs
            ex = extract_clean_excerpt(rng.choice(pool), seg["dur"], rng)
            segs_audio.append({**seg, "audio": ex, "actualDur": len(ex) / SR})
        prepared_clips.append({**design, "segsAudio": segs_audio})

    # Expand to 4 x 3 = 12 trials and shuffle
    trial_jobs = []
    for clip in prepared_clips:
        for style in ("S1", "S2", "S3"):
            trial_jobs.append((clip, style))
    rng.shuffle(trial_jobs)

    records: list[dict[str, Any]] = []
    duration_sec = 12.0
    n_total = int(round(duration_sec * SR))

    for idx, (clip, style) in enumerate(trial_jobs, start=1):
        trial_id = f"b2a_t{idx:02d}"
        title = f"Trial B2A-{idx:02d} (Style {style})"

        # Slight random time-shift jitter (±0.30s) so clips aren't trivially matched across styles
        jitter = round(rng.uniform(-0.30, 0.30), 3)
        stereo = generate_warm_dark_room_tone(
            duration_sec, -54.0, 2,
            rng.randint(1000, 999999), rng.randint(1000, 999999),
        )

        cursor = max(0.25, clip["segsAudio"][0]["gapBefore"] + jitter)
        gt_segments = []
        gt_overlaps = []
        prev_end = None
        prev_pan = None

        for s_i, seg in enumerate(clip["segsAudio"]):
            if s_i == 0:
                start_sec = cursor
            else:
                start_sec = max(0.1, prev_end + seg["gapBefore"])
            audio = seg["audio"]
            s0 = int(round(start_sec * SR))
            s1 = min(n_total, s0 + len(audio))
            seg_len = s1 - s0
            end_sec = s1 / SR

            g_l, g_r = constant_power_gains(seg["pan"])
            stereo[s0:s1, 0] += audio[:seg_len] * g_l
            stereo[s0:s1, 1] += audio[:seg_len] * g_r

            expected_energy_idx = math.sin(seg["pan"] * math.pi / 2.0)
            gt_segments.append({
                "index": s_i + 1,
                "speaker": seg["speaker"],
                "startSec": round(start_sec, 3),
                "endSec": round(end_sec, 3),
                "targetPan": seg["pan"],
                "expectedEnergyIndex": round(expected_energy_idx, 3),
                "panBin": pan_bin(seg["pan"]),
            })

            if prev_end is not None and start_sec < prev_end - 0.02:
                gt_overlaps.append({
                    "startSec": round(start_sec, 3),
                    "endSec": round(prev_end, 3),
                    "durationMs": round((prev_end - start_sec) * 1000.0, 1),
                    "pans": [prev_pan, seg["pan"]],
                })
            prev_end = end_sec
            prev_pan = seg["pan"]

        stereo = np.clip(stereo, -0.999, 0.999)
        png_path = out_dir / f"{trial_id}.png"
        if style == "S1":
            render_s1_split_waveforms(stereo, title, png_path)
        elif style == "S2":
            render_s2_waveform_pan_ribbon(stereo, title, png_path)
        else:
            render_s3_rms_and_diff(stereo, title, png_path)

        if keep_wavs_dir:
            write_wav_file(keep_wavs_dir / f"{trial_id}.wav", stereo)

        records.append({
            "trialId": trial_id,
            "battery": "b2a",
            "filename": png_path.name,
            "clipId": clip["clipId"],
            "style": style,
            "durationSec": duration_sec,
            "timeJitterSec": jitter,
            "hasPanSwap": clip["hasPanSwap"],
            "segments": gt_segments,
            "overlaps": gt_overlaps,
        })

    return records


def build_battery_2b_mini(
    all_takes: list[tuple[str, np.ndarray]],
    rng: random.Random,
    out_dir: Path,
    keep_wavs_dir: Path | None,
) -> list[dict[str, Any]]:
    """
    Mini-2B (Phase 1 Pilot): Custom Log-Mel (F1) vs Pure FFmpeg (F4) Bake-Off.
    4 base clips (1 clean + 3 subtle defects) x 2 styles = 8 shuffled trials.
    """
    raw_arrays = [a for _, a in all_takes]
    base_specs = [
        {"clipId": "b2b_clean", "kind": "clean"},
        {"clipId": "b2b_click_subtle", "kind": "click"},
        {"clipId": "b2b_dropout_100ms", "kind": "dropout"},
        {"clipId": "b2b_floor_subtle", "kind": "floor_shift"},
    ]

    # Build base 10.6s audio so each style can slice a 10.0s window with slight independent shift
    prepared_bases: list[dict[str, Any]] = []
    for sp in base_specs:
        kind = sp["kind"]
        speech = make_10s_speech_bed(raw_arrays, rng, target_sec=10.6, ensure_pause_sec=0.45)
        rt_sl = rng.randint(1000, 999999)
        rt_sr = rng.randint(1000, 999999)

        if kind == "floor_shift":
            t0 = round(rng.uniform(3.2, 7.2), 2)
            rt_low = generate_warm_dark_room_tone(10.6, -56.0, 1, rt_sl, rt_sr)
            rt_hi = generate_warm_dark_room_tone(10.6, -44.0, 1, rt_sl + 11, rt_sr + 11)
            s0 = int(round(t0 * SR))
            xf = int(0.005 * SR)
            env = np.zeros(len(speech), dtype=np.float32)
            env[s0 + xf :] = 1.0
            env[s0 : s0 + xf] = np.linspace(0.0, 1.0, xf, dtype=np.float32)
            audio = np.clip(speech + rt_low * (1.0 - env) + rt_hi * env, -0.999, 0.999)
            base_gt = {
                "hasDefect": True,
                "defectClass": "floor_shift",
                "baseTimestampSec": t0,
                "details": {"fromDbfs": -56.0, "toDbfs": -44.0},
            }
        else:
            rt = generate_warm_dark_room_tone(10.6, -54.0, 1, rt_sl, rt_sr)
            audio = np.clip(speech + rt, -0.999, 0.999)
            if kind == "clean":
                base_gt = {"hasDefect": False, "defectClass": "clean", "baseTimestampSec": None, "details": {}}
            elif kind == "click":
                pauses = find_speech_pauses(speech, min_pause_sec=0.35, margin_sec=1.5)
                t_c = round(sum(rng.choice(pauses)) / 2.0, 3) if pauses else round(rng.uniform(2.5, 8.0), 3)
                audio = inject_click(audio, t_c, peak_dbfs=-6.0, width_ms=2.0, rng=rng)
                base_gt = {
                    "hasDefect": True,
                    "defectClass": "click",
                    "baseTimestampSec": t_c,
                    "details": {"peakDbfs": -6.0, "widthMs": 2.0},
                }
            elif kind == "dropout":
                pauses = find_speech_pauses(speech, min_pause_sec=0.35, margin_sec=1.5)
                t_c = sum(max(pauses, key=lambda p: p[1] - p[0])) / 2.0 if pauses else rng.uniform(2.5, 8.0)
                audio, d0, d1 = inject_dropout(audio, t_c, duration_ms=100.0, edge_ms=5.0)
                base_gt = {
                    "hasDefect": True,
                    "defectClass": "dropout",
                    "baseTimestampSec": round(0.5 * (d0 + d1), 3),
                    "details": {"durationMs": 100.0, "edgeFadeMs": 5.0},
                }
            else:
                raise ValueError(kind)

        prepared_bases.append({**sp, "audio": audio, **base_gt})

    trial_jobs = []
    for base in prepared_bases:
        for style in ("F1", "F4"):
            trial_jobs.append((base, style))
    rng.shuffle(trial_jobs)

    records: list[dict[str, Any]] = []
    n_win = int(round(10.0 * SR))

    for idx, (base, style) in enumerate(trial_jobs, start=1):
        trial_id = f"b2b_t{idx:02d}"
        title = f"Trial B2B-{idx:02d}"

        # Independent crop offset [0.0 .. 0.55s] so exact defect timestamps differ across F1/F4
        crop_start = round(rng.uniform(0.05, 0.55), 3)
        c0 = int(round(crop_start * SR))
        clip_audio = base["audio"][c0 : c0 + n_win].copy()

        ts = None
        if base["baseTimestampSec"] is not None:
            ts = round(base["baseTimestampSec"] - crop_start, 3)

        png_path = out_dir / f"{trial_id}.png"
        if style == "F1":
            render_f1_waveform_logmel(clip_audio, title, png_path)
        else:
            render_f4_pure_ffmpeg(clip_audio, title, png_path)

        if keep_wavs_dir:
            write_wav_file(keep_wavs_dir / f"{trial_id}.wav", clip_audio)

        records.append({
            "trialId": trial_id,
            "battery": "b2b",
            "filename": png_path.name,
            "clipId": base["clipId"],
            "style": style,
            "durationSec": 10.0,
            "cropStartSec": crop_start,
            "hasDefect": base["hasDefect"],
            "defectClass": base["defectClass"],
            "timestampSec": ts,
            "details": base["details"],
        })

    return records


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate blinded Phase 1 visual-audio psychophysics stimuli.")
    parser.add_argument("--seed", type=int, default=20261126, help="Deterministic RNG seed")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=REPO_ROOT / "data" / "visual_bench" / "phase1",
        help="Subject-visible directory (receives ONLY opaque PNGs)",
    )
    parser.add_argument(
        "--key-out",
        type=Path,
        default=REPO_ROOT.parent / "visual_bench_private" / "phase1_answer_key.json",
        help="Operator-only private ground-truth answer key path",
    )
    parser.add_argument(
        "--keep-wavs-dir",
        type=Path,
        default=None,
        help="Optional operator-only directory to save backing WAVs for auditing",
    )
    args = parser.parse_args()

    out_dir = args.out_dir.resolve()
    key_out = args.key_out.resolve()
    keep_wavs_dir = args.keep_wavs_dir.resolve() if args.keep_wavs_dir else None

    # Safety check: refuse to put answer key inside out_dir
    try:
        key_out.relative_to(out_dir)
        raise SystemExit("ERROR: --key-out must NOT be inside --out-dir (anti-leak violation).")
    except ValueError:
        pass

    # Clean stale PNGs in out_dir so only this seed's trials exist
    if out_dir.exists():
        for old in out_dir.glob("*.png"):
            old.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    key_out.parent.mkdir(parents=True, exist_ok=True)

    rng = random.Random(args.seed)
    all_takes, speaker_a_takes, margaux_takes = load_corpus()
    print(f"Loaded {len(all_takes)} real speech takes ({len(speaker_a_takes)} Speaker A, {len(margaux_takes)} Margaux).")

    b1 = build_battery_1(all_takes, rng, out_dir, keep_wavs_dir)
    print(f"Generated Battery 1:   {len(b1)} PNGs")
    b2a = build_battery_2a(speaker_a_takes, margaux_takes, rng, out_dir, keep_wavs_dir)
    print(f"Generated Battery 2A:  {len(b2a)} PNGs")
    b2b = build_battery_2b_mini(all_takes, rng, out_dir, keep_wavs_dir)
    print(f"Generated Mini-2B:     {len(b2b)} PNGs")

    key_payload = {
        "study": "visual-audio-psychophysics-phase1",
        "seed": args.seed,
        "sampleRate": SR,
        "stimuliDir": str(out_dir),
        "counts": {"b1": len(b1), "b2a": len(b2a), "b2b": len(b2b), "total": len(b1) + len(b2a) + len(b2b)},
        "b1": b1,
        "b2a": b2a,
        "b2b": b2b,
    }
    key_out.write_text(json.dumps(key_payload, indent=2), encoding="utf-8")
    print(f"Wrote {key_payload['counts']['total']} blinded PNGs to: {out_dir}")
    print(f"Wrote operator-only answer key to: {key_out}")


if __name__ == "__main__":
    main()
