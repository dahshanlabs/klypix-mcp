# klypix-mcp

**An open, local-first, agent-neutral canvas file your AI reads and writes over MCP — works with Claude, Cursor, Cline, any model.**

Your AI forgets everything between sessions, and you can't hand it your *whole*
messy project at once. `klypix-mcp` fixes that with a single portable file:

- **`.klypix`** is one file that holds your whole project spatially — text, PDFs,
  screenshots, audio, code, links — arranged and connected on an infinite canvas.
- This package is an **MCP server**: any MCP-capable agent (Claude Desktop,
  Cursor, Cline, …) can **list, read, search, create, and append** to your
  `.klypix` canvases — so your agent gets durable, multimodal, *spatial* memory.
- **Local-first + agent-neutral.** The file lives on *your* disk. No lab is in
  the loop — read it with Claude today, GPT tomorrow, a local model next week.
  No vendor can take it away.

> **The shared memory layer for your multi-agent stack.** A2A moves the messages
> between agents; MCP connects an agent to its tools; **`.klypix` is the owned,
> multimodal context both layers read and write.** KLYPIX ships *two* faces over
> one engine — an **MCP server** (`klypix-mcp`) and an **A2A agent**
> (`klypix-a2a`) — so whichever protocol your stack speaks, the memory node is
> the same portable file you own. See **[A2A.md](A2A.md)**.

## Quick start (60 seconds)

```bash
# point it at any folder of .klypix files (a "vault")
npx klypix-mcp --vault ./canvases
```

Then add it to your MCP client. For **Claude Desktop**, in
`claude_desktop_config.json`:

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

Now ask your agent things like *"summarize the canvas `roadmap`,"* *"turn these
notes into a board,"* or *"add a card with the decision we just made."*

## Tools the server exposes

| Tool | What it does |
|---|---|
| `list_canvases` | List every `.klypix` in the vault |
| `read_canvas` | Read a canvas as markdown (cards, the connection graph, `[[links]]`, `#tags`) |
| `search_canvases` | Search across canvases by name + content |
| `search_all_brains` | Cross-project memory search across every registered brain |
| `brain_insights` | Hubs, orphaned decisions, stale questions, area sizes |
| `brain_connect` | Find + draw related-but-unlinked cards (densify the graph) |
| `brain_reconcile` | Flag committed-but-unrecorded DB migrations (the brain can't see prod) |
| `create_canvas` | Create a new `.klypix` from cards + connections |
| `add_to_canvas` | Append cards/connections to an existing canvas (positions preserved) |

### Tools vs. the *automatic* brain

This package is the **agent-neutral read/write surface** — any MCP client (Claude
Code, Claude Desktop, Cursor, Cline, Windsurf…) gets the **tools** above and can
read, search, and write canvases on demand (*pull*). That works in any agent, in
any project.

The **automatic** brain — auto-capturing decisions from your work, injecting the
relevant cards into each prompt, and coordinating across concurrent sessions
(*push*) — runs in a host **hook**, which is a Claude Code / KLYPIX-desktop
feature, not part of this npm package. So `npx klypix-mcp` gives you the tools
everywhere; the hands-free brain comes with the [KLYPIX desktop app](https://klypix.com)
or the Claude Code project-brain hook. (`search_all_brains` is also hook-fed — it
reads the cross-project registry the hook writes, so it stays empty until a hook
has registered at least one brain.)

### Updates — the propagation contract

`npx klypix-mcp install` lays the whole brain (hooks + engine + local MCP server)
into `~/.claude/project-brain`, and the emitted MCP config runs the server **from
that installed bundle** (no npx cache to go stale). From then on updates are
automatic: at session start the hook checks npm (≤ once/24h, fail-open, disable
with `KLYPIX_AUTO_UPDATE=0`) and self-installs a newer release, so a publish
reaches every machine by its **next session**.

One honest caveat: a running stdio MCP server can't hot-swap, and **resuming a
session (or opening a new chat in the same app) does not respawn it** — only a
full app quit + reopen (or `/mcp` reconnect after the old process exits) starts
the new binary. `brain_doctor` tells you when that's needed: its RUNNING line
compares the *live server's* self-reported version against the installed bundle
and npm, and reads `DRIFTED → /mcp reconnect` instead of pretending a stale
server is current.

## Also speaks A2A (Agent-to-Agent)

The same engine is exposed as an **A2A agent** so other agents and orchestrators
can delegate memory tasks to KLYPIX as a discoverable peer:

```bash
npx -p klypix-mcp klypix-a2a --vault ./canvases     # 127.0.0.1:41241
# Agent Card: http://127.0.0.1:41241/.well-known/agent-card.json
```

Skills: `make_board`, `remember`, `recall`, `read_canvas`, `list_canvases`,
`brain_insights`, `search_all_brains`. Unlike a typical A2A agent that returns
text, KLYPIX returns the **`.klypix` board itself** as a multimodal artifact.
Full protocol details (JSON-RPC methods, message shapes, streaming) in
**[A2A.md](A2A.md)**.

## Use it as a library

```js
import { parseKlypix, buildKlypix, appendToKlypix, structToMarkdown } from 'klypix-mcp';
```

…or read/write from the shell:

```bash
npx -p klypix-mcp klypix-read   path/to/board.klypix      # → markdown brief
echo '{ "title": "Plan", "cards": [{ "text": "kickoff" }] }' \
  | npx -p klypix-mcp klypix-write --out plan.klypix
```

## The `.klypix` format

A `.klypix` is just a **ZIP** of JSON + assets — open, inspectable, versioned.
Full spec in [FORMAT.md](FORMAT.md). The point: *you own the file, and any agent
can drive it.*

## Why this exists

Frontier labs are racing to put your context inside *their* canvas — a roach
motel your work checks into and never leaves for a competitor. `klypix-mcp` is
the opposite: **your project, your file, any model, offline.** That's the one
thing a lab is structurally disincentivized to build.

MIT licensed. Built by [Dahshan Labs](https://klypix.com). The KLYPIX desktop
app is the spatial editor for these files — but the file and this server are
fully open and work without it.
