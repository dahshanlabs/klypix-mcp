#!/usr/bin/env python3
"""Animated bar chart of the coordination bench, drawn from a *.summary.json.

    python bench/coordination/render-chart.py [summary.json] [-o out.gif] [--png out.png]

Every bar, interval, count and label is read from the summary file that
summarize.mjs computes from a results .jsonl. Nothing is typed by hand: when the
results change, re-run this and the chart changes with them.

One group of bars per scenario, one bar per condition, height = pass rate, the
thin line = the 95% Wilson interval, the label = pass/n. A cell that was not run
is left empty and marked "not run". Any cell with n < 5 puts a visible caveat
on the chart. KLYPIX is drawn in the brand emerald; every other condition in a
neutral grey ramp, so the picture never colours a competitor as "bad".

Requires matplotlib and Pillow.
"""
import argparse
import glob
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.animation import FuncAnimation, PillowWriter  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "results")

BG = "#0f1412"
INK = "#e8efeb"
MUTED = "#8a9a92"
GRID = "#24302b"
EMERALD = "#10b981"
GREYS = ["#4b5563", "#6b7280", "#9ca3af", "#cbd5e1", "#374151"]


def newest_summary():
    files = sorted(glob.glob(os.path.join(RESULTS, "*.summary.json")), key=os.path.getmtime)
    return files[-1] if files else None


def load(path):
    with open(path, encoding="utf-8") as f:
        s = json.load(f)
    if not isinstance(s.get("scenarios"), list) or not isinstance(s.get("conditions"), list):
        raise ValueError("not a bench summary: scenarios and conditions are required")
    return s


def colour_for(conditions):
    out, g = {}, 0
    for c in conditions:
        if c["key"] == "klypix":
            out[c["key"]] = EMERALD
        else:
            out[c["key"]] = GREYS[g % len(GREYS)]
            g += 1
    return out


def wrap_label(text, width=22):
    words, lines, cur = str(text).split(), [], ""
    for w in words:
        if len(cur) + len(w) + (1 if cur else 0) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return "\n".join(lines[:3])


def build(summary, out_gif=None, out_png=None, frames=36, hold=30):
    conds = summary["conditions"]
    scen = summary["scenarios"]
    colours = colour_for(conds)
    ncond, nscen = len(conds), len(scen)
    small = sum(1 for s in scen for c in s["cells"] if 0 < (c.get("n") or 0) < 5)

    fig_w = max(10.0, 1.9 * nscen + 2.0)
    fig, ax = plt.subplots(figsize=(fig_w, 6.2), dpi=100)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)

    group_w = 0.82
    bar_w = group_w / max(ncond, 1)
    xs = list(range(nscen))
    targets, bars, whisk, texts = [], [], [], []
    for ci, cond in enumerate(conds):
        for si, s in enumerate(scen):
            cell = next((c for c in s["cells"] if c["condition"] == cond["key"]), None)
            x = xs[si] - group_w / 2 + bar_w * (ci + 0.5)
            n = (cell or {}).get("n") or 0
            rate = (cell["pass"] / n) if n else None
            b = ax.bar(x, 0, width=bar_w * 0.86, color=colours[cond["key"]], zorder=3)[0]
            bars.append(b)
            targets.append(rate)
            if n:
                lo, hi = cell.get("ci") or [None, None]
                w = ax.plot([x, x], [0, 0], color=INK, alpha=0.0, lw=1.2, zorder=4)[0]
                whisk.append((w, lo, hi))
                t = ax.text(x, 0.02, f"{cell['pass']}/{n}", ha="center", va="bottom", color=INK,
                            fontsize=8.5, alpha=0.0, zorder=5)
            else:
                whisk.append((None, None, None))
                t = ax.text(x, 0.02, "not\nrun", ha="center", va="bottom", color=MUTED, fontsize=7.5,
                            alpha=0.0, zorder=5)
            texts.append((t, rate))

    ax.set_ylim(0, 1.12)
    ax.set_xlim(-0.6, nscen - 0.4)
    ax.set_yticks([0, 0.25, 0.5, 0.75, 1.0])
    ax.set_yticklabels(["0%", "25%", "50%", "75%", "100%"], color=MUTED, fontsize=9)
    ax.set_xticks(xs)
    ax.set_xticklabels([wrap_label(s["label"]) for s in scen], color=INK, fontsize=9)
    ax.tick_params(axis="both", length=0)
    for sp in ax.spines.values():
        sp.set_visible(False)
    ax.yaxis.grid(True, color=GRID, lw=0.8, zorder=0)

    date = str(summary.get("generatedAt", ""))[:10]
    runs = summary.get("runs")
    agents = ", ".join(a.get("label") or a.get("key") or str(a) if isinstance(a, dict) else str(a)
                       for a in summary.get("agents") or [])
    fig.text(0.04, 0.95, "Does the agent act on what another session knew?", color=INK, fontsize=15,
             fontweight="bold", ha="left")
    sub = f"Real agents, hidden tests, no LLM judge · {date}"
    if runs:
        sub += f" · {runs} graded runs"
    if agents:
        sub += f" · {agents}"
    fig.text(0.04, 0.905, sub, color=MUTED, fontsize=9.5, ha="left")

    handles = [plt.Rectangle((0, 0), 1, 1, color=colours[c["key"]]) for c in conds]
    names = [f"{c['label']} {c['version']}" if c.get("version") and c["version"] != "—" else c["label"]
             for c in conds]
    leg = ax.legend(handles, names, loc="upper right", ncol=min(ncond, 5), frameon=False, fontsize=9,
                    bbox_to_anchor=(1.0, 1.10))
    for t in leg.get_texts():
        t.set_color(INK)

    foot = "Bar = pass rate · line = 95% interval · every row is published, including the ones KLYPIX loses"
    if small:
        foot = f"⚠ {small} cell{'s' if small != 1 else ''} with fewer than 5 runs: a pilot, not a ranking.   " + foot
    fig.text(0.04, 0.05, foot, color=MUTED if not small else "#f5c451", fontsize=8.5, ha="left")
    nm = summary.get("notMeasured") or []
    if nm:
        fig.text(0.04, 0.012, "Not measured: " + ", ".join(x["name"].split(" (")[0] for x in nm),
                 color=MUTED, fontsize=8, ha="left", va="bottom")
    fig.subplots_adjust(left=0.06, right=0.98, top=0.84, bottom=0.2)

    def ease(t):
        return 1 - (1 - t) ** 3

    def draw(frame):
        p = ease(min(1.0, frame / frames))
        for b, r in zip(bars, targets):
            b.set_height((r or 0) * p)
        reveal = 1.0 if frame >= frames else 0.0
        for (w, lo, hi) in whisk:
            if w is not None and lo is not None:
                w.set_data(w.get_xdata(), [lo, hi])
                w.set_alpha(0.75 * reveal)
        for (t, r) in texts:
            t.set_y(((r or 0) * p) + 0.02)
            t.set_alpha(reveal)
        return bars

    if out_png:
        draw(frames)
        fig.savefig(out_png, facecolor=BG)
    if out_gif:
        anim = FuncAnimation(fig, draw, frames=frames + hold, interval=50, blit=False)
        anim.save(out_gif, writer=PillowWriter(fps=20))
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("summary", nargs="?")
    ap.add_argument("-o", "--out", default=None)
    ap.add_argument("--png", default=None)
    a = ap.parse_args()
    path = a.summary or newest_summary()
    if not path or not os.path.exists(path):
        print("render-chart: no *.summary.json found (run summarize.mjs first)", file=sys.stderr)
        sys.exit(2)
    try:
        summary = load(path)
    except (ValueError, json.JSONDecodeError) as e:
        print(f"render-chart: {path}: {e}", file=sys.stderr)
        sys.exit(2)
    out = a.out if (a.out or a.png) else os.path.join(HERE, "..", "..", "docs", "demo", "bench-chart.gif")
    build(summary, out_gif=out, out_png=a.png)
    print(f"render-chart: {path} -> {out or ''} {a.png or ''}".strip())


if __name__ == "__main__":
    main()
