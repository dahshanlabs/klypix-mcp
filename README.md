# Every project gets a brain.

### Not a *second* brain. A **shared** one.

You've seen the setup: point an AI at a folder of notes, watch the graph fill up, call it a brain. Look closer — **the human never touches anything.** Even the pattern's inventor says it: *"you never write the wiki yourself… I browse the results in real time."* The human is a reader. The AI is the sole writer. That's not a brain — that's an aquarium.

**`klypix-mcp` gives your project a brain you're allowed inside while it works.** One file — `brain.klypix` — in your repo, versioned with git, that your AI agents read, write, and argue from. And in the [KLYPIX app](https://klypix.com), you work *in* it while they do: your cursor typing in one card while agent decisions land beside your hands, each in its area, with an arrow explaining why — and the save refuses to write a file that lost a card.

> *Their AI keeps a diary about your project. Ours works in the same room as you — and the room remembers.*

## Quick start

**Claude Code + Codex (native, machine-wide):**

```bash
npx klypix-mcp install
```

Claude Code gets live hooks for auto-brief + auto-capture. Codex gets a native
`~/.codex/config.toml` MCP registration and conditional global guidance that activates
only when a project contains `./brain.klypix`. Existing MCP servers, Codex settings, and
personal instructions are preserved and backed up before KLYPIX-owned blocks change.
Restart Codex after installation so it loads the new server.

Give a project a brain by dropping a `brain.klypix` in it — the
[KLYPIX app](https://klypix.com) does it in one click (*Save canvas as project brain*),
or `create_canvas` makes one from any agent.

**Every other agent tool (one command per project):**

```bash
npx klypix-mcp link
```

Adds project-native config for Codex, Cursor, and VS Code/Copilot, plus rules for
Cline, Windsurf, Gemini CLI, Aider, and any AGENTS.md-reading agent. Verify all
managed files without changing them with `npx klypix-mcp link --check`.

## What a project brain does

The difference from a folder of notes is not the shape — it's that this memory is a **mechanism, not a filing convention**:

- **It briefs every session.** Each agent session starts already knowing the project's decisions, open questions, and standing rules — a compact brief (≈3–5k tokens even at 600+ cards, growing sublinearly). Measured on our own brain: **73% of past decisions recovered with one search round (55% brief-only) vs 0% cold** (n=20).
- **It argues back.** `brain_challenge`: propose a decision and the brain answers with receipts — *"you reversed this on June 12; here's the correction — captured by a different agent, coordinate before overriding."* Deterministic evidence only (correction-cues, opposite-polarity), never mere topical similarity. A memory that can't disagree with you is flattery.
- **It knows when it's stale.** Decision cards can anchor to the exact code they were decided against (git blob OID). When that code moves on, the card raises its hand in the next brief. Their notes rot silently; ours confess.
- **It answers from the past.** `brain_ask` with `as_of: 2026-03-01` answers what the project believed *then* — corrections from the future never leak backwards.
- **Position means something.** Drag a card into the 📌 Focus area and it leads every future session's brief. Layout is instruction, not decoration.
- **Many agents, no chaos.** Concurrent sessions take a capture lock (zero captures lost, tested at four simultaneous writers), tag *who* wrote each card, message each other through the brain (`brain_message`), and genuine contradictions surface as red arrows for a human to arbitrate — never auto-resolved.
- **Retrieval that's measured, failures included.** Hybrid on-device search (semantic + lexical + cross-encoder rerank, no cloud): recall@5 of the true source card went **5% → 15% → 40%** across our upgrades (n=20 frozen human-paraphrase questions) — and the experiment that *regressed* (contextual prefixes on short cards) is recorded next to the wins.

## One file you can hold

The whole brain — layout, decisions, arrows, **and the actual bytes** (images, PDFs, audio, code) — is a single `.klypix` file. Email it. Git it. Hand it to an agent. A folder of markdown points at its attachments; this file *carries* them.

And it's not a cage: everything **exports to Markdown and JSON Canvas** in one command, and **Obsidian `.canvas` files open directly** in KLYPIX. Plain markdown is the most portable text on earth — that's exactly why we export to it. Full spec: [FORMAT.md](FORMAT.md).

**"Project" means any project.** Two showcase brains ship in [`examples/`](examples/), identical in engine, different in life: [`showcase-brain.klypix`](examples/showcase-brain.klypix) is *Aurora*, a fictional weather app mid-build (radar tiles, API caps, a correction with its receipt) — and [`showcase-wedding.klypix`](examples/showcase-wedding.klypix) is *Our Wedding* (venue, vendors, guest list, the same correction machinery pointed at a caterer). Same 📌 Focus, same arrows, same brief. If it has decisions worth keeping, it gets a brain.

## Setup for plain MCP clients

Any MCP client gets the tools without the hooks. For **Claude Desktop**, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "klypix": {
      "command": "npx",
      "args": ["-y", "klypix-mcp", "--vault", "/absolute/path/to/canvases"]
    }
  }
}
```

Then ask your agent things like *"what did we decide about auth?"*, *"challenge this: let's switch to polling"*, or *"turn these notes into a board."*

## The 16 verbs

| Tool | What it does |
|---|---|
| `brain_ask` | Whole-brain question answering — correction-aware, `as_of` time-travel |
| `brain_challenge` | The brain argues back: contradictions with receipts, tried-and-reversed chains, standing rules, other-agent provenance flags |
| `brain_note` | Capture with the full lifecycle — supersede / ✓ resolve / ~ update / 🛠 skill / closes: |
| `brain_reconcile` | Find stale-vs-correction pairs + unrecorded migrations |
| `brain_insights` | Hubs, orphaned decisions, stale questions, area sizes |
| `brain_garden` | Maintenance pass over the brain |
| `brain_doctor` | Self-diagnosis: version alignment, hooks wired, projection drift |
| `brain_message` | Session-to-session coordination notes |
| `brain_connect` | Find + draw related-but-unlinked cards |
| `canvas_view` | The board as an MCP App — Apps-capable chats get an interactive spatial view; everyone else gets clean text |
| `read_canvas` | A canvas as markdown (cards, connection graph, `[[links]]`, `#tags`) |
| `search_canvases` | Search across canvases by name + content |
| `search_all_brains` | Cross-project memory search across every registered brain |
| `create_canvas` | New `.klypix` from cards + connections |
| `add_to_canvas` | Append cards/connections (positions preserved) |
| `list_canvases` | List every `.klypix` in the vault |

### Tools vs. the *automatic* brain

This package is the **agent-neutral read/write surface** — any MCP client gets the tools above on demand (*pull*), in any project. `install` wires Claude Code's live hooks and Codex's native MCP + conditional global guidance; `link` projects the repository-level MCP and instruction files used by Codex and the other coding agents. Full transcript-driven auto-capture remains a Claude Code hook capability; Codex and other hookless clients capture durable decisions through the MCP instructions and `brain_note`.

### Updates — the propagation contract

`install` lays the whole brain (hooks + engine + local MCP server) into `~/.claude/project-brain`, then points both Claude and Codex at that installed bundle so there is no npx cache to go stale. Updates are automatic through the Claude session-start hook: it checks npm (≤ once/24h, fail-open, disable with `KLYPIX_AUTO_UPDATE=0`) and self-installs newer releases, including healing the Codex registration. One honest caveat: a running stdio server can't hot-swap — a new binary loads on the next full app launch (or `/mcp` reconnect); `brain_doctor`'s RUNNING line tells you when that's needed.

## Also speaks A2A (Agent-to-Agent)

```bash
npx -p klypix-mcp klypix-a2a --vault ./canvases     # 127.0.0.1:41241
# Agent Card: http://127.0.0.1:41241/.well-known/agent-card.json
```

Skills: `make_board`, `remember`, `recall`, `read_canvas`, `list_canvases`, `brain_insights`, `search_all_brains`. Unlike a typical A2A agent that returns text, KLYPIX returns the **`.klypix` board itself** as a multimodal artifact. Details: [A2A.md](A2A.md).

## Use it as a library

```js
import { parseKlypix, buildKlypix, appendToKlypix, structToMarkdown } from 'klypix-mcp';
```

```bash
npx -p klypix-mcp klypix-read   path/to/board.klypix      # → markdown brief
echo '{ "title": "Plan", "cards": [{ "text": "kickoff" }] }' \
  | npx -p klypix-mcp klypix-write --out plan.klypix
```

## The workspace it opens in

The brain is open and free — this package, the hooks, the format. **[KLYPIX](https://klypix.com)** is the Windows app built around it: see the brain as a living spatial map, work inside it while your agents write, capture anything from anywhere, act with agents, share encrypted. Bilingual English/Arabic.

## Honesty notes

- Dogfooded hard: **KLYPIX itself is built with its own brain** — 600+ cards, multiple concurrent agent sessions, receipts in the file.
- All engine intelligence is deterministic and local — the only LLM anywhere is *your* agent. No telemetry, no cloud calls, works offline.
- Every number above is measured on our own project brain; the eval harness ships in the repo.

## Why this exists

Frontier labs are racing to put your context inside *their* memory — a roach motel your work checks into and never leaves for a competitor. `klypix-mcp` is the opposite: **your project, your file, any model, offline.** A brain that any agent reads and writes is the one thing a lab is structurally disincentivized to build.

Apache-2.0 © [Dahshan Labs](https://klypix.com). The KLYPIX desktop app is a separate, proprietary product — the file and this server are fully open and work without it.
