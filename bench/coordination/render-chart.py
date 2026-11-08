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
    def at(p):
        try:
            with open(p, encoding="utf-8") as f:
                return str(json.load(f).get("generatedAt") or "")
        except Exception:
            return ""
    # Newest = the latest generatedAt inside the file; a checkout gives every
    # file the same mtime, and names do not sort by date.
    files = sorted(glob.glob(os.path.join(RESULTS, "*.summary.json")), key=lambda p: (at(p), p))
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


SHORT = {"none": "No shared channel", "agents-md-kept": "Notes file, kept tidy", "klypix": "KLYPIX",
         "concord": "Concord MCP", "agent-mail": "MCP Agent Mail"}


def short_version(v):
    v = str(v or "")
    for tok in v.replace("@", " ").split():
        if tok[:1].isdigit() and "." in tok:
            return tok
    return ""


AGENT_LABELS = {"claude": "Claude Code", "codex": "Codex"}


def for_agent(summary, agent):
    """Keep one agent's cells (a summary can pool Claude and Codex rows)."""
    scen = []
    for s in summary["scenarios"]:
        cells = [c for c in s["cells"] if c.get("agent") in (None, agent)]
        if cells:
            scen.append({**s, "cells": cells})
    keys = {c["condition"] for s in scen for c in s["cells"]}
    conds = [c for c in summary["conditions"] if c["key"] in keys]
    return conds, scen


def build(summary, out_gif=None, out_png=None, frames=36, hold=30, agent=None):
    agents = summary.get("agents") or []
    agent = agent or (agents[0] if agents and isinstance(agents[0], str) else None)
    conds, scen = for_agent(summary, agent) if agent else (summary["conditions"], summary["scenarios"])
    colours = colour_for(conds)
    ncond, nscen = len(conds), len(scen)
    ns = [c.get("n") or 0 for s in scen for c in s["cells"] if (c.get("n") or 0) > 0]
    small = sum(1 for n in ns if n < 5)
    lo_n, hi_n = (min(ns), max(ns)) if ns else (0, 0)

    fig_w = max(10.0, 1.55 * nscen + 2.0)
    fig, ax = plt.subplots(figsize=(fig_w, 6.6), dpi=100)
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
                t = ax.text(x, 0.02, "n/a" if (cell or {}).get("notApplicable") else "not\nrun", ha="center", va="bottom", color=MUTED, fontsize=7.5,
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
    runs = sum((c.get("n") or 0) + (c.get("invalid") or 0) for s in scen for c in s["cells"]) or summary.get("runs")
    agents = AGENT_LABELS.get(agent, agent) if agent else ", ".join(str(a) for a in agents)
    fig.text(0.04, 0.95, "Does the agent act on what another session knew?", color=INK, fontsize=15,
             fontweight="bold", ha="left")
    sub = f"Real agents, hidden tests, no LLM judge · {date}"
    if runs:
        sub += f" · {runs} graded runs"
    if agents:
        sub += f" · {agents}"
    fig.text(0.04, 0.905, sub, color=MUTED, fontsize=9.5, ha="left")

    handles = [plt.Rectangle((0, 0), 1, 1, color=colours[c["key"]]) for c in conds]
    names = []
    for c in conds:
        nm = SHORT.get(c["key"], c["label"].split(" (")[0])
        ver = short_version(c.get("version"))
        names.append(f"{nm} {ver}" if ver else nm)
    leg = ax.legend(handles, names, loc="lower left", ncol=min(ncond, 5), frameon=False, fontsize=10,
                    bbox_to_anchor=(0.0, 1.0), handlelength=1.2, columnspacing=1.6)
    for t in leg.get_texts():
        t.set_color(INK)

    foot = "Bar = pass rate · line = 95% interval · every row is published, including the ones KLYPIX loses"
    if small and lo_n <= 2:
        foot = f"⚠ {small} cell{'s' if small != 1 else ''} with fewer than 3 runs: a pilot, not a ranking.   " + foot
    elif small:
        per = f"{lo_n}" if lo_n == hi_n else f"{lo_n}–{hi_n}"
        foot = f"{per} runs per cell, so intervals are wide: a difference counts only where the lines do not overlap.   " + foot
    fig.text(0.04, 0.05, foot, color=MUTED if not (small and lo_n <= 2) else "#f5c451", fontsize=8.5, ha="left")
    nm = summary.get("notMeasured") or []
    if nm:
        fig.text(0.04, 0.012, "Not measured: " + ", ".join(x["name"].split(" (")[0] for x in nm),
                 color=MUTED, fontsize=8, ha="left", va="bottom")
    fig.subplots_adjust(left=0.05, right=0.99, top=0.80, bottom=0.2)

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


def build_rows(summary, out_png, agent=None):
    """Still, phone-readable scoreboard: one row per scenario, one column per
    tool, pass/n in each cell, shaded by pass rate (never by vendor). Same data
    and rules as build()."""
    from matplotlib.patches import FancyBboxPatch
    agents = summary.get("agents") or []
    agent = agent or (agents[0] if agents and isinstance(agents[0], str) else None)
    conds, scen = for_agent(summary, agent) if agent else (summary["conditions"], summary["scenarios"])
    ncond, nscen = len(conds), len(scen)
    ns = [c.get("n") or 0 for s in scen for c in s["cells"] if (c.get("n") or 0) > 0]
    small = sum(1 for n in ns if n < 5)
    lo_n, hi_n = (min(ns), max(ns)) if ns else (0, 0)

    label_w, cell_w, cell_h = 4.3, 1.5, 0.62
    top_h, bottom_h = 2.45, 1.3
    fig_w = label_w + ncond * cell_w + 0.4
    fig_h = top_h + nscen * cell_h + bottom_h
    fig = plt.figure(figsize=(fig_w, fig_h), dpi=120)
    fig.patch.set_facecolor(BG)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, fig_w)
    ax.set_ylim(fig_h, 0)
    ax.axis("off")

    def shade(rate):
        # dark slate at 0%, brand emerald at 100%, linear in between
        a, b = (0x1f, 0x29, 0x25), (0x10, 0xb9, 0x81)
        return "#%02x%02x%02x" % tuple(round(a[i] + (b[i] - a[i]) * rate) for i in range(3))

    date = str(summary.get("generatedAt", ""))[:10]
    runs = sum((c.get("n") or 0) + (c.get("invalid") or 0) for s in scen for c in s["cells"])
    who = AGENT_LABELS.get(agent, agent) if agent else ""
    ax.text(0.35, 0.55, "Does the agent act on what another session knew?", color=INK, fontsize=21,
            fontweight="bold", va="center")
    ax.text(0.35, 1.0, f"Real agents, hidden tests, no LLM judge · {date} · {runs} graded runs · {who}",
            color=MUTED, fontsize=12.5, va="center")

    hy = top_h - 0.42
    for j, c in enumerate(conds):
        x = label_w + j * cell_w + cell_w / 2
        nm = SHORT.get(c["key"], c["label"].split(" (")[0])
        ver = short_version(c.get("version"))
        is_k = c["key"] == "klypix"
        ax.text(x, hy - 0.12, wrap_label(nm, 12), color=EMERALD if is_k else INK, fontsize=13,
                fontweight="bold" if is_k else "normal", ha="center", va="bottom")
        if ver:
            ax.text(x, hy + 0.06, ver, color=MUTED, fontsize=10.5, ha="center", va="top")

    for i, s in enumerate(scen):
        y = top_h + i * cell_h
        ax.text(label_w - 0.2, y + cell_h / 2, wrap_label(s["label"], 30), color=INK, fontsize=13,
                ha="right", va="center", linespacing=1.15)
        for j, cond in enumerate(conds):
            x = label_w + j * cell_w
            cell = next((c for c in s["cells"] if c["condition"] == cond["key"]), None)
            n = (cell or {}).get("n") or 0
            pad = 0.07
            if n:
                rate = cell["pass"] / n
                ax.add_patch(FancyBboxPatch((x + pad, y + pad), cell_w - 2 * pad, cell_h - 2 * pad,
                                            boxstyle="round,pad=0,rounding_size=0.08", linewidth=0,
                                            facecolor=shade(rate), zorder=2))
                ax.text(x + cell_w / 2, y + cell_h / 2, f"{cell['pass']}/{n}", color="#ffffff" if rate >= 0.5 else INK,
                        fontsize=16, fontweight="bold", ha="center", va="center", zorder=3)
            else:
                ax.add_patch(FancyBboxPatch((x + pad, y + pad), cell_w - 2 * pad, cell_h - 2 * pad,
                                            boxstyle="round,pad=0,rounding_size=0.08", linewidth=1,
                                            edgecolor=GRID, facecolor=BG, zorder=2))
                ax.text(x + cell_w / 2, y + cell_h / 2,
                        "n/a" if (cell or {}).get("notApplicable") else "not run",
                        color=MUTED, fontsize=12, ha="center", va="center", zorder=3)
        kx = next((label_w + j * cell_w for j, c in enumerate(conds) if c["key"] == "klypix"), None)
    if kx is not None:
        ax.add_patch(FancyBboxPatch((kx + 0.02, top_h - 0.02), cell_w - 0.04, nscen * cell_h + 0.04,
                                    boxstyle="round,pad=0,rounding_size=0.1", linewidth=1.6,
                                    edgecolor=EMERALD, facecolor="none", zorder=4))

    per = f"{lo_n}" if lo_n == hi_n else f"{lo_n}-{hi_n}"
    by = top_h + nscen * cell_h + 0.38
    note = (f"Passes out of {per} runs per test. With so few runs, only big gaps (like 4/4 against 0/4) are real differences."
            if small else "Passes out of runs per test.")
    ax.text(0.35, by, note, color=MUTED, fontsize=11.5, va="center")
    nm = summary.get("notMeasured") or []
    tail = "Every row is published, including the one KLYPIX loses."
    if nm:
        tail = "Not measured: " + ", ".join(x["name"].split(" (")[0] for x in nm) + ".  " + tail
    ax.text(0.35, by + 0.34, tail, color=MUTED, fontsize=11.5, va="center")
    caveats = [x for x in (summary.get("caveats") or []) if isinstance(x, str)]
    if any(c["key"] == "concord" for c in conds):
        caveats = caveats or ["Concord's live-delivery plugin was not enabled in this run."]
    for k, line in enumerate(caveats[:2]):
        ax.text(0.35, by + 0.68 + 0.34 * k, line, color=MUTED, fontsize=11.5, va="center")
    fig.savefig(out_png, facecolor=BG)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("summary", nargs="?")
    ap.add_argument("-o", "--out", default=None)
    ap.add_argument("--png", default=None)
    ap.add_argument("--agent", default=None, help="claude or codex (default: the first agent in the file)")
    ap.add_argument("--rows", default=None, help="also write the still, phone-readable row chart (PNG) here")
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
    out = a.out if (a.out or a.png or a.rows) else os.path.join(HERE, "..", "..", "docs", "demo", "bench-chart.gif")
    if a.rows:
        build_rows(summary, a.rows, agent=a.agent)
    if a.out or a.png or not a.rows:
        build(summary, out_gif=out, out_png=a.png, agent=a.agent)
    print(f"render-chart: {path} -> {out or ''} {a.png or ''}".strip())


if __name__ == "__main__":
    main()
