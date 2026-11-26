#!/usr/bin/env python3
"""
Visual-Audio Psychophysics & Anti-Placebo Study — Automated Phase 1 Scorer

Grades blinded JSON predictions against the operator-only answer_key.json
and outputs a clean Markdown scorecard with decision-gate pass/fail badges.

Accepted prediction JSON formats:
  1) Combined object: { "b1": [...], "b2a": [...], "b2b": [...] }
  2) Flat list of trial prediction objects (auto-routed by trialId prefix `b1_`, `b2a_`, `b2b_`).
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def normalize_pan_bin(raw: str | None) -> str | None:
    if not raw:
        return None
    s = raw.strip().lower().replace("_", " ").replace("-", " ")
    mapping = {
        "hard l": "Hard L",
        "hard left": "Hard L",
        "far left": "Hard L",
        "mid l": "Mid L",
        "mid left": "Mid L",
        "left": "Mid L",
        "center": "Center",
        "centre": "Center",
        "c": "Center",
        "mid r": "Mid R",
        "mid right": "Mid R",
        "right": "Mid R",
        "hard r": "Hard R",
        "hard right": "Hard R",
        "far right": "Hard R",
    }
    return mapping.get(s, raw.strip())


def pan_to_bin(val: float) -> str:
    if val <= -0.65:
        return "Hard L"
    if val <= -0.15:
        return "Mid L"
    if val < 0.15:
        return "Center"
    if val < 0.65:
        return "Mid R"
    return "Hard R"


def load_predictions(path: Path) -> dict[str, dict[str, dict[str, Any]]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, dict[str, dict[str, Any]]] = {"b1": {}, "b2a": {}, "b2b": {}}

    def ingest(items: list[dict[str, Any]], forced_bat: str | None = None) -> None:
        for item in items:
            tid = str(item.get("trialId", "")).strip()
            if not tid:
                continue
            bat = forced_bat
            if bat is None:
                low = tid.lower()
                if low.startswith("b1"):
                    bat = "b1"
                elif low.startswith("b2a"):
                    bat = "b2a"
                elif low.startswith("b2b"):
                    bat = "b2b"
            if bat in out:
                out[bat][tid] = item

    if isinstance(data, list):
        ingest(data)
    elif isinstance(data, dict):
        for bat in ("b1", "b2a", "b2b"):
            if isinstance(data.get(bat), list):
                ingest(data[bat], bat)
        if isinstance(data.get("trials"), list):
            ingest(data["trials"])
    return out


def score_defect_battery(
    gt_trials: list[dict[str, Any]],
    preds: dict[str, dict[str, Any]],
    ts_tol_sec: float = 0.50,
) -> dict[str, Any]:
    tp = fp = tn = fn = 0
    class_correct = 0
    ts_errors: list[float] = []
    confusion: Counter[tuple[str, str]] = Counter()
    rows: list[dict[str, Any]] = []

    for gt in gt_trials:
        tid = gt["trialId"]
        p = preds.get(tid)
        gt_has = bool(gt["hasDefect"])
        gt_cls = str(gt["defectClass"])
        gt_ts = gt.get("timestampSec")

        if p is None:
            rows.append({"trialId": tid, "style": gt.get("style"), "gt": gt_cls, "pred": "MISSING", "gtTs": gt_ts, "predTs": None, "err": None, "status": "MISSING"})
            continue

        pred_cls = str(p.get("defectClass", "clean")).strip().lower()
        pred_has = bool(p.get("hasDefect")) if "hasDefect" in p else (pred_cls != "clean")
        pred_ts = p.get("timestampSec")

        confusion[(gt_cls, pred_cls)] += 1

        if gt_has and pred_has:
            tp += 1
            if pred_cls == gt_cls:
                class_correct += 1
            err = abs(float(pred_ts) - float(gt_ts)) if (pred_ts is not None and gt_ts is not None) else None
            if err is not None:
                ts_errors.append(err)
            status = "HIT" if (pred_cls == gt_cls and (err is None or err <= ts_tol_sec)) else "PARTIAL"
        elif not gt_has and not pred_has:
            tn += 1
            err = None
            status = "TN"
        elif not gt_has and pred_has:
            fp += 1
            err = None
            status = "FP (PLACEBO)"
        else:
            fn += 1
            err = None
            status = "MISS"

        rows.append({
            "trialId": tid,
            "style": gt.get("style"),
            "gt": gt_cls,
            "pred": pred_cls,
            "gtTs": gt_ts,
            "predTs": pred_ts,
            "err": round(err, 3) if err is not None else None,
            "status": status,
        })

    n_clean = tn + fp
    n_def = tp + fn
    fpr = (fp / n_clean) if n_clean else 0.0
    recall = (tp / n_def) if n_def else 0.0
    precision = (tp / (tp + fp)) if (tp + fp) else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    cls_acc = (class_correct / n_def) if n_def else 0.0
    ts_mae = (sum(ts_errors) / len(ts_errors)) if ts_errors else None

    return {
        "tp": tp, "fp": fp, "tn": tn, "fn": fn,
        "n_clean": n_clean, "n_def": n_def,
        "fpr": fpr, "recall": recall, "precision": precision, "f1": f1,
        "class_correct": class_correct, "class_acc": cls_acc,
        "ts_mae": ts_mae, "confusion": confusion, "rows": rows,
    }


def score_b2a_stereo(gt_trials: list[dict[str, Any]], preds: dict[str, dict[str, Any]]) -> dict[str, Any]:
    by_style: dict[str, dict[str, Any]] = {}
    styles = sorted({t["style"] for t in gt_trials})

    for st in styles:
        st_trials = [t for t in gt_trials if t["style"] == st]
        pan_err_target: list[float] = []
        pan_err_energy: list[float] = []
        time_err: list[float] = []
        bin_correct = 0
        bin_total = 0
        seg_count_exact = 0
        ov_tp = ov_fp = ov_fn = 0
        graded = 0

        for gt in st_trials:
            p = preds.get(gt["trialId"])
            if not p:
                continue
            graded += 1
            gt_segs = gt["segments"]
            p_segs = p.get("segments", [])
            if len(p_segs) == len(gt_segs):
                seg_count_exact += 1

            # Greedy nearest-midpoint matching between GT segments and predicted segments
            used = set()
            for g in gt_segs:
                g_mid = 0.5 * (g["startSec"] + g["endSec"])
                best_j = None
                best_dist = 1.5  # max 1.5s match radius
                for j, ps in enumerate(p_segs):
                    if j in used:
                        continue
                    ps_s = ps.get("startSec")
                    ps_e = ps.get("endSec")
                    if ps_s is None or ps_e is None:
                        continue
                    p_mid = 0.5 * (float(ps_s) + float(ps_e))
                    d = abs(p_mid - g_mid)
                    if d < best_dist:
                        best_dist = d
                        best_j = j

                bin_total += 1
                if best_j is None:
                    continue
                used.add(best_j)
                ps = p_segs[best_j]
                time_err.append(abs(float(ps["startSec"]) - g["startSec"]))
                time_err.append(abs(float(ps["endSec"]) - g["endSec"]))

                p_pan = ps.get("pan") if "pan" in ps else ps.get("estimatedPan")
                p_bin = normalize_pan_bin(ps.get("panBin") or ps.get("bin"))
                if p_pan is not None:
                    p_pan_f = float(p_pan)
                    pan_err_target.append(abs(p_pan_f - float(g["targetPan"])))
                    pan_err_energy.append(abs(p_pan_f - float(g["expectedEnergyIndex"])))
                    if p_bin is None:
                        p_bin = pan_to_bin(p_pan_f)
                if p_bin == g["panBin"]:
                    bin_correct += 1

            # Overlap detection (match within 0.6s of overlap midpoint)
            gt_ovs = gt.get("overlaps", [])
            p_ovs = p.get("overlaps", [])
            matched_p = set()
            for go in gt_ovs:
                g_mid = 0.5 * (go["startSec"] + go["endSec"])
                hit = False
                for j, po in enumerate(p_ovs):
                    if j in matched_p:
                        continue
                    if isinstance(po, dict):
                        ps_s = po.get("startSec", po.get("timestampSec"))
                        ps_e = po.get("endSec", ps_s)
                        if ps_s is not None:
                            p_mid = 0.5 * (float(ps_s) + float(ps_e))
                            if abs(p_mid - g_mid) <= 0.65:
                                matched_p.add(j)
                                hit = True
                                break
                if hit:
                    ov_tp += 1
                else:
                    ov_fn += 1
            ov_fp += max(0, len(p_ovs) - len(matched_p))

        by_style[st] = {
            "graded": graded,
            "total": len(st_trials),
            "segCountExact": seg_count_exact,
            "panMaeTarget": (sum(pan_err_target) / len(pan_err_target)) if pan_err_target else None,
            "panMaeEnergy": (sum(pan_err_energy) / len(pan_err_energy)) if pan_err_energy else None,
            "timeMae": (sum(time_err) / len(time_err)) if time_err else None,
            "binCorrect": bin_correct,
            "binTotal": bin_total,
            "binAcc": (bin_correct / bin_total) if bin_total else 0.0,
            "ovTp": ov_tp, "ovFn": ov_fn, "ovFp": ov_fp,
        }
    return by_style


def fmt_opt(val: float | None, suffix: str = "") -> str:
    return "n/a" if val is None else f"{val:.3f}{suffix}"


def build_markdown_report(key: dict[str, Any], preds: dict[str, dict[str, dict[str, Any]]]) -> str:
    lines: list[str] = []
    lines.append(f"# Visual-Audio Psychophysics Scorecard — Phase 1 (seed `{key.get('seed')}`)\n")

    # Battery 1
    if preds["b1"]:
        b1 = score_defect_battery(key["b1"], preds["b1"])
        fpr_pass = "PASS" if b1["fpr"] <= (1.0 / 6.0 + 1e-9) else "FAIL"
        rec_pass = "PASS" if b1["recall"] >= 0.80 else "FAIL"
        cls_pass = "PASS" if b1["class_acc"] >= 0.70 else "FAIL"
        ts_pass = "PASS" if (b1["ts_mae"] is not None and b1["ts_mae"] <= 0.25) else "FAIL"

        lines.append("## Battery 1 — Clean-Control Placebo Trap\n")
        lines.append("| Metric | Result | Target Gate | Status |")
        lines.append("| :--- | :---: | :---: | :---: |")
        lines.append(f"| Clean-Control FPR | {b1['fp']}/{b1['n_clean']} ({b1['fpr']*100:.1f}%) | <= 16.7% (target 0%) | **{fpr_pass}** |")
        lines.append(f"| Defect Detection Recall | {b1['tp']}/{b1['n_def']} ({b1['recall']*100:.1f}%) | >= 80% | **{rec_pass}** |")
        lines.append(f"| Defect Class Accuracy | {b1['class_correct']}/{b1['n_def']} ({b1['class_acc']*100:.1f}%) | >= 70% | **{cls_pass}** |")
        lines.append(f"| Timestamp MAE (detected) | {fmt_opt(b1['ts_mae'], 's')} | <= 0.250s | **{ts_pass}** |")
        lines.append(f"| Detection F1 | {b1['f1']:.3f} | — | — |\n")

        lines.append("### Battery 1 Trial Breakdown\n")
        lines.append("| Trial | Ground Truth | Predicted | GT Time | Pred Time | Abs Err | Outcome |")
        lines.append("| :--- | :--- | :--- | :---: | :---: | :---: | :--- |")
        for r in b1["rows"]:
            gt_ts_s = "-" if r["gtTs"] is None else f"{float(r['gtTs']):.2f}s"
            pred_ts_s = "-" if r["predTs"] is None else f"{float(r['predTs']):.2f}s"
            err_s = "-" if r["err"] is None else f"{float(r['err']):.2f}s"
            lines.append(
                f"| `{r['trialId']}` | `{r['gt']}` | `{r['pred']}` | "
                f"{gt_ts_s} | {pred_ts_s} | {err_s} | {r['status']} |"
            )
        lines.append("")

    # Battery 2A
    if preds["b2a"]:
        b2a = score_b2a_stereo(key["b2a"], preds["b2a"])
        lines.append("## Battery 2A — Stereo / Spatial Representation Bake-Off\n")
        lines.append("| Style | Graded | 5-Way Bin Acc | Pan MAE (Booth pan) | Pan MAE (Energy idx) | Edge Time MAE | Overlaps (TP/FN/FP) |")
        lines.append("| :--- | :---: | :---: | :---: | :---: | :---: | :---: |")
        for st, m in b2a.items():
            lines.append(
                f"| **{st}** | {m['graded']}/{m['total']} | {m['binCorrect']}/{m['binTotal']} ({m['binAcc']*100:.1f}%) | "
                f"{fmt_opt(m['panMaeTarget'])} | {fmt_opt(m['panMaeEnergy'])} | {fmt_opt(m['timeMae'], 's')} | "
                f"{m['ovTp']}/{m['ovFn']}/{m['ovFp']} |"
            )
        lines.append("")

    # Battery 2B
    if preds["b2b"]:
        lines.append("## Mini-2B — Custom Annotated (F1) vs Pure FFmpeg (F4)\n")
        lines.append("| Style | FPR | Recall | Class Acc | F1 | Timestamp MAE |")
        lines.append("| :--- | :---: | :---: | :---: | :---: | :---: |")
        for st in ("F1", "F4"):
            sub_gt = [t for t in key["b2b"] if t["style"] == st]
            sub_res = score_defect_battery(sub_gt, preds["b2b"])
            lines.append(
                f"| **{st}** | {sub_res['fp']}/{sub_res['n_clean']} ({sub_res['fpr']*100:.1f}%) | "
                f"{sub_res['tp']}/{sub_res['n_def']} ({sub_res['recall']*100:.1f}%) | "
                f"{sub_res['class_correct']}/{sub_res['n_def']} ({sub_res['class_acc']*100:.1f}%) | "
                f"{sub_res['f1']:.3f} | {fmt_opt(sub_res['ts_mae'], 's')} |"
            )
        lines.append("")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Score blinded Phase 1 visual-audio predictions.")
    parser.add_argument("--key", type=Path, required=True, help="Path to operator-only answer_key.json")
    parser.add_argument("--preds", type=Path, required=True, help="Path to subject predictions JSON")
    parser.add_argument("--out", type=Path, default=None, help="Optional Markdown output path")
    args = parser.parse_args()

    key = json.loads(args.key.read_text(encoding="utf-8"))
    preds = load_predictions(args.preds)
    report = build_markdown_report(key, preds)
    print(report)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report, encoding="utf-8")


if __name__ == "__main__":
    main()
