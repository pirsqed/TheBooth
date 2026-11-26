#!/usr/bin/env python3
"""
Visual-Audio Psychophysics & Anti-Placebo Study — Automated Phase 2 Scorer

Grades blinded Phase 2 JSON predictions against phase2_answer_key.json:
  - Battery 3A: Loudness direction accuracy, Δ dB MAE (overall + binned by |Δ dB|),
                and continuous pan MAE comparing Style L1 (Split L/R + RMS) vs Style L2 (Pan Ribbon + RMS).
  - Battery 3B: Compression ceiling visibility curve across 5s / 15s / 45s / 180s
                broken down by window duration AND defect class (clean / click / dropout / overlap).
  - Battery 3C: Overlap/gap timing MAE (ms) and silent-tail mismatch catch rate for
                Audio-Only (A1) vs DAW Cue-Block Overlay (A2).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_predictions(path: Path) -> dict[str, dict[str, dict[str, Any]]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, dict[str, dict[str, Any]]] = {"b3a": {}, "b3b": {}, "b3c": {}}

    def ingest(items: list[dict[str, Any]], forced: str | None = None) -> None:
        for item in items:
            tid = str(item.get("trialId", "")).strip()
            if not tid:
                continue
            bat = forced
            if bat is None:
                low = tid.lower()
                if low.startswith("b3a"):
                    bat = "b3a"
                elif low.startswith("b3b"):
                    bat = "b3b"
                elif low.startswith("b3c"):
                    bat = "b3c"
            if bat in out:
                out[bat][tid] = item

    if isinstance(data, list):
        ingest(data)
    elif isinstance(data, dict):
        for bat in ("b3a", "b3b", "b3c"):
            if isinstance(data.get(bat), list):
                ingest(data[bat], bat)
        if isinstance(data.get("trials"), list):
            ingest(data["trials"])
    return out


def fmt(v: float | None, digits: int = 2, suffix: str = "") -> str:
    return "n/a" if v is None else f"{v:.{digits}f}{suffix}"


def build_report(key: dict[str, Any], preds: dict[str, dict[str, dict[str, Any]]]) -> str:
    lines: list[str] = []
    lines.append(f"# Visual-Audio Psychophysics Scorecard — Phase 2 (seed `{key.get('seed')}`)\n")

    # --- Battery 3A ---
    if preds["b3a"]:
        lines.append("## Battery 3A — Continuous Loudness & Stereo Pan JND (with Headphone Crossfeed)\n")
        dir_ok = 0
        dir_total = 0
        db_errs: list[float] = []
        by_style: dict[str, dict[str, list[float]]] = {
            "L1": {"db": [], "pan_target": [], "pan_eidx": []},
            "L2": {"db": [], "pan_target": [], "pan_eidx": []},
        }
        rows = []

        for gt in key["b3a"]:
            tid = gt["trialId"]
            p = preds["b3a"].get(tid)
            if not p:
                continue
            st = gt["style"]
            gt_dir = gt["loudnessDirection"]
            gt_db = float(gt["realizedDeltaDb"])
            p_dir = str(p.get("loudnessDirection", "")).strip().lower()
            p_db = p.get("estimatedDeltaDb")
            dir_total += 1
            hit_dir = p_dir == gt_dir
            if hit_dir:
                dir_ok += 1

            db_err = abs(float(p_db) - gt_db) if p_db is not None else None
            if db_err is not None:
                db_errs.append(db_err)
                by_style[st]["db"].append(db_err)

            p_l1 = p.get("line1Pan")
            p_l2 = p.get("line2Pan")
            pan_errs_t = []
            pan_errs_e = []
            for p_val, g_line in [(p_l1, gt["line1"]), (p_l2, gt["line2"])]:
                if p_val is not None:
                    et = abs(float(p_val) - float(g_line["targetPan"]))
                    ee = abs(float(p_val) - float(g_line["realizedEnergyIndex"]))
                    pan_errs_t.append(et)
                    pan_errs_e.append(ee)
                    by_style[st]["pan_target"].append(et)
                    by_style[st]["pan_eidx"].append(ee)

            rows.append({
                "tid": tid, "style": st, "gtDb": gt_db, "predDb": p_db, "dbErr": db_err,
                "gtDir": gt_dir, "predDir": p_dir, "hitDir": hit_dir,
                "gtPans": f"{gt['line1']['targetPan']:+.2f} / {gt['line2']['targetPan']:+.2f}",
                "predPans": f"{'-' if p_l1 is None else f'{float(p_l1):+.2f}'} / {'-' if p_l2 is None else f'{float(p_l2):+.2f}'}",
                "panMae": (sum(pan_errs_t) / len(pan_errs_t)) if pan_errs_t else None,
            })

        lines.append(f"- **Loudness Direction Accuracy:** {dir_ok}/{dir_total} ({(dir_ok/max(dir_total,1))*100:.1f}%)")
        lines.append(f"- **Overall Loudness Δ dB MAE:** {fmt(sum(db_errs)/len(db_errs) if db_errs else None, 2, ' dB')}\n")

        lines.append("### Style Tiebreaker on Continuous Crossfed Stereo (`L1` vs `L2`)\n")
        lines.append("| Style | Δ dB MAE | Pan MAE (vs Booth pan) | Pan MAE (vs Energy Index) |")
        lines.append("| :--- | :---: | :---: | :---: |")
        for st in ("L1", "L2"):
            d = by_style[st]
            lines.append(
                f"| **{st}** | {fmt(sum(d['db'])/len(d['db']) if d['db'] else None, 2, ' dB')} | "
                f"{fmt(sum(d['pan_target'])/len(d['pan_target']) if d['pan_target'] else None, 3)} | "
                f"{fmt(sum(d['pan_eidx'])/len(d['pan_eidx']) if d['pan_eidx'] else None, 3)} |"
            )
        lines.append("")

        lines.append("### Battery 3A Trial Breakdown (Sorted by |Realized Δ dB|)\n")
        lines.append("| Trial | Style | GT Δ dB | Pred Δ dB | Abs Err | Dir (GT / Pred) | GT Pans (L1/L2) | Pred Pans (L1/L2) | Pan MAE |")
        lines.append("| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |")
        for r in sorted(rows, key=lambda x: abs(x["gtDb"])):
            pred_db_s = "-" if r["predDb"] is None else f"{float(r['predDb']):+.2f}"
            lines.append(
                f"| `{r['tid']}` | {r['style']} | {r['gtDb']:+.2f} | "
                f"{pred_db_s} | "
                f"{fmt(r['dbErr'], 2)} | {r['gtDir']} / {r['predDir']} {'OK' if r['hitDir'] else 'MISS'} | "
                f"{r['gtPans']} | {r['predPans']} | {fmt(r['panMae'], 3)} |"
            )
        lines.append("")

    # --- Battery 3B ---
    if preds["b3b"]:
        lines.append("## Battery 3B — Time-Window Compression Ceiling (5s / 15s / 45s / 180s, Pure FFmpeg)\n")
        by_win: dict[float, list[dict[str, Any]]] = {}
        for gt in key["b3b"]:
            by_win.setdefault(float(gt["windowSec"]), []).append(gt)

        lines.append("### Visibility Matrix by Window Duration\n")
        lines.append("| Window | px/sec | Clean (TN/FP) | 3ms Click | 120ms Dropout | 150ms Overlap | Defect Recall | Ts MAE |")
        lines.append("| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |")

        detail_rows = []
        for win in sorted(by_win.keys()):
            trials = by_win[win]
            px_s = trials[0]["pxPerSec"]
            cell: dict[str, str] = {}
            tp = fn = 0
            ts_errs: list[float] = []
            for gt in trials:
                tid = gt["trialId"]
                cls = gt["defectClass"]
                p = preds["b3b"].get(tid)
                if not p:
                    cell[cls] = "MISSING"
                    continue
                p_cls = str(p.get("defectClass", "clean")).strip().lower()
                p_has = bool(p.get("hasDefect")) if "hasDefect" in p else (p_cls not in ("clean", "unresolvable"))
                p_ts = p.get("timestampSec")
                gt_ts = gt.get("timestampSec")
                err = abs(float(p_ts) - float(gt_ts)) if (p_ts is not None and gt_ts is not None) else None

                # Tolerance scales modestly with window size (2% of window, min 0.25s)
                tol = max(0.25, win * 0.025)
                if cls == "clean":
                    cell[cls] = "TN" if not p_has else f"FP ({p_cls})"
                else:
                    loc_ok = (err is not None and err <= tol)
                    if p_has and p_cls == cls and loc_ok:
                        tp += 1
                        ts_errs.append(err)
                        cell[cls] = f"HIT ({err:.2f}s)"
                    elif p_has and loc_ok:
                        tp += 1
                        ts_errs.append(err)
                        cell[cls] = f"LOC-ONLY ({p_cls}, {err:.2f}s)"
                    else:
                        fn += 1
                        cell[cls] = f"MISS ({p_cls})"
                detail_rows.append((win, tid, cls, p_cls, gt_ts, p_ts, err, cell[cls]))

            rec_str = f"{tp}/{tp+fn} ({(tp/max(tp+fn,1))*100:.0f}%)"
            lines.append(
                f"| **{win:.0f}s** | {px_s:.1f} | {cell.get('clean','-')} | {cell.get('click','-')} | "
                f"{cell.get('dropout','-')} | {cell.get('overlap','-')} | {rec_str} | "
                f"{fmt(sum(ts_errs)/len(ts_errs) if ts_errs else None, 2, 's')} |"
            )
        lines.append("")

        lines.append("### Battery 3B Detailed Trial Log\n")
        lines.append("| Window | Trial | GT Class | Pred Class | GT Time | Pred Time | Abs Err | Result |")
        lines.append("| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :--- |")
        for win, tid, cls, p_cls, gt_ts, p_ts, err, res in detail_rows:
            gt_s = "-" if gt_ts is None else f"{float(gt_ts):.2f}s"
            p_s = "-" if p_ts is None else f"{float(p_ts):.2f}s"
            e_s = "-" if err is None else f"{err:.2f}s"
            lines.append(f"| {win:.0f}s | `{tid}` | `{cls}` | `{p_cls}` | {gt_s} | {p_s} | {e_s} | {res} |")
        lines.append("")

    # --- Battery 3C ---
    if preds["b3c"]:
        lines.append("## Battery 3C — Overlap & Gap Timing Precision (Audio-Only A1 vs DAW Cue Overlay A2)\n")
        by_st: dict[str, list[float]] = {"A1": [], "A2": []}
        rows_3c = []
        for gt in key["b3c"]:
            tid = gt["trialId"]
            p = preds["b3c"].get(tid)
            if not p:
                continue
            st = gt["style"]
            gt_ms = float(gt["audibleGapOrOverlapMs"])
            p_ms = p.get("audibleGapOrOverlapMs")
            err_ms = abs(float(p_ms) - gt_ms) if p_ms is not None else None
            if err_ms is not None:
                by_st[st].append(err_ms)
            rows_3c.append({
                "tid": tid, "style": st, "scenario": gt["scenarioId"],
                "plannedMs": gt["plannedGapOrOverlapMs"], "gtAudibleMs": gt_ms,
                "predAudibleMs": p_ms, "errMs": err_ms,
                "gtTrap": gt["tailMismatch"], "predTrap": p.get("tailMismatchDetected"),
            })

        lines.append("| Style | Audible Gap/Overlap MAE (ms) |")
        lines.append("| :--- | :---: |")
        for st in ("A1", "A2"):
            errs = by_st[st]
            lines.append(f"| **{st}** | {fmt(sum(errs)/len(errs) if errs else None, 1, ' ms')} |")
        lines.append("")

        lines.append("| Trial | Style | Scenario | Planned Box | GT Audible | Pred Audible | Abs Err | Tail Mismatch (GT / Pred) |")
        lines.append("| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: |")
        for r in rows_3c:
            p_str = "-" if r["predAudibleMs"] is None else f"{float(r['predAudibleMs']):+.0f} ms"
            lines.append(
                f"| `{r['tid']}` | {r['style']} | `{r['scenario']}` | {r['plannedMs']:+d} ms | "
                f"{r['gtAudibleMs']:+.0f} ms | {p_str} | {fmt(r['errMs'], 0, ' ms')} | "
                f"{r['gtTrap']} / {r['predTrap']} |"
            )
        lines.append("")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Score blinded Phase 2 visual-audio predictions.")
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--preds", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    key = json.loads(args.key.read_text(encoding="utf-8"))
    preds = load_predictions(args.preds)
    report = build_report(key, preds)
    print(report)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report, encoding="utf-8")


if __name__ == "__main__":
    main()
