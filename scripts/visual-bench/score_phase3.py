#!/usr/bin/env python3
"""
Visual-Audio Psychophysics & Anti-Placebo Study — Automated Phase 3 (Battery 4) Scorer

Grades blinded Battery 4 predictions (Ears-Only vs Eyes-Only + Prosody Probe vs Multimodal Both)
against phase3_answer_key.json and generates a Markdown division-of-labor report.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def find_flawed_id(pair_gt: dict[str, Any]) -> str:
    for m in pair_gt["mixes"]:
        if not m["isClean"]:
            return str(m["mixId"])
    return ""


def get_flaws(pair_gt: dict[str, Any]) -> list[dict[str, Any]]:
    for m in pair_gt["mixes"]:
        if not m["isClean"]:
            return list(m.get("flaws", []))
    return []


def match_flaw(gt_flaw: dict[str, Any], pred_flaws: list[dict[str, Any]]) -> dict[str, Any] | None:
    gt_type = gt_flaw["type"].lower()
    aliases = {
        "wrong_pan": {"wrong_pan", "pan", "pan_error", "stereo_pan", "pan_flip", "pan_swap"},
        "dropout": {"dropout", "dead_air", "silence", "room_tone_dropout"},
        "under_leveled": {"under_leveled", "loudness", "level", "gain", "loudness_dip", "quiet"},
        "overlap_collision": {"overlap_collision", "overlap", "collision", "timing"},
        "sibilance": {"sibilance", "harsh_sibilance", "eq"},
        "click": {"click", "pop", "transient", "micro_click"},
        "delivery_mismatch": {"delivery_mismatch", "delivery", "acting", "tone_mismatch", "mood_mismatch", "performance"},
    }
    valid = aliases.get(gt_type, {gt_type})

    for pf in pred_flaws:
        pt = str(pf.get("type", "")).strip().lower().replace("-", "_").replace(" ", "_")
        if pt in valid or any(v in pt for v in valid):
            # Optional cue check if both specify cueId
            if gt_flaw.get("cueId") and pf.get("cueId"):
                if str(pf["cueId"]).strip().lower() != str(gt_flaw["cueId"]).strip().lower():
                    continue
            return pf
    return None


def build_report(key: dict[str, Any], preds: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"# Visual-Audio Psychophysics Scorecard — Phase 3 / Battery 4 (seed `{key.get('seed')}`)\n")

    for pair_key, label in [
        ("pair1", "Pair 1 — Ears-Only (`.ogg` only)"),
        ("pair2", "Pair 2 — Eyes-Only (`.png` only)"),
        ("pair3", "Pair 3 — Multimodal (`.ogg` + `.png`)"),
    ]:
        gt = key[pair_key]
        pr = preds.get(pair_key)
        if not pr:
            continue

        gt_flawed = find_flawed_id(gt)
        pr_flawed = str(pr.get("flawedMixId", "")).strip()
        ab_ok = pr_flawed == gt_flawed

        lines.append(f"## {label}\n")
        lines.append(f"- **Clean vs. Flawed Identification:** GT=`{gt_flawed}` | Pred=`{pr_flawed}` -> **{'PASS' if ab_ok else 'FAIL'}**")

        gt_flaws = get_flaws(gt)
        pr_flaws = pr.get("flaws", [])
        hits = 0

        lines.append("\n| Ground-Truth Flaw | Target / Time | Caught? | Pred Detail / Modality | Timestamp Err |")
        lines.append("| :--- | :--- | :---: | :--- | :---: |")
        for gf in gt_flaws:
            m = match_flaw(gf, pr_flaws)
            target_desc = gf.get("cueId") or (" & ".join(gf.get("between", []))) or "-"
            gt_ts = gf.get("timestampSec") or gf.get("startSec")
            if gt_ts is not None:
                target_desc = f"{target_desc} @ {float(gt_ts):.2f}s"
            if m:
                hits += 1
                p_ts = m.get("timestampSec")
                err_s = f"{abs(float(p_ts) - float(gt_ts)):.2f}s" if (p_ts is not None and gt_ts is not None) else "-"
                mod = m.get("caughtBy") or m.get("modality") or "-"
                note = str(m.get("note") or m.get("evidenceNote") or m.get("type"))[:90]
                lines.append(f"| `{gf['type']}` | {target_desc} | **YES** | `{mod}`: {note} | {err_s} |")
            else:
                lines.append(f"| `{gf['type']}` | {target_desc} | NO | — | — |")

        lines.append(f"\n- **Flaw Recall:** **{hits}/{len(gt_flaws)}** ({(hits/max(len(gt_flaws),1))*100:.0f}%)")
        if pr.get("blindSpotsNote"):
            lines.append(f"- **Self-Reported Blind Spots:** {pr['blindSpotsNote']}")
        lines.append("")

        # Prosody bonus probe on Pair 2
        if pair_key == "pair2" and pr.get("prosodyProbe"):
            lines.append("### Exploratory Prosody Bonus Probe (Eyes-Only — Zero Audio, Zero Transcript)\n")
            pgt = gt.get("prosodyGroundTruth", {})
            ppr = pr["prosodyProbe"]
            lines.append("| Prosody Feature | GT Cue & Time | Pred Cue & Time | Cue Match | Abs Time Err |")
            lines.append("| :--- | :--- | :--- | :---: | :---: |")
            p_hits = 0
            for role, nice in [
                ("rising_question", "Rising-Pitch Question"),
                ("audible_sigh", "Sharpest Audible Sigh / Breath"),
                ("highest_intensity", "Highest Vocal Intensity / Attack"),
            ]:
                g = pgt.get(role, {})
                p = ppr.get(role, {})
                g_cue = g.get("cueId", "?")
                p_cue = p.get("cueId", "?")
                ok = str(p_cue).lower() == str(g_cue).lower()
                if ok:
                    p_hits += 1
                g_t = g.get("approxTimestampSec")
                p_t = p.get("timestampSec")
                t_err = f"{abs(float(p_t) - float(g_t)):.2f}s" if (g_t is not None and p_t is not None) else "-"
                lines.append(
                    f"| {nice} | `{g_cue}` (~{g_t}s) | `{p_cue}` ({'-' if p_t is None else f'{float(p_t):.2f}s'}) | "
                    f"**{'HIT' if ok else 'MISS'}** | {t_err} |"
                )
            lines.append(f"\n- **Eyes-Only Prosody Cue Score:** **{p_hits}/3**\n")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Score blinded Phase 3 (Battery 4) studio synergy predictions.")
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--preds", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    key = json.loads(args.key.read_text(encoding="utf-8"))
    preds = json.loads(args.preds.read_text(encoding="utf-8"))
    report = build_report(key, preds)
    print(report)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report, encoding="utf-8")


if __name__ == "__main__":
    main()
