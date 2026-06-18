# KLYPIX speaks A2A

KLYPIX is the **shared, human-owned memory node** for a multi-agent stack.
**A2A moves the messages between agents; `.klypix` holds the context they read
and write.** The two are complementary layers, not competitors:

| Layer | Protocol | KLYPIX's role |
|---|---|---|
| Agent ↔ tools / context | **MCP** (`klypix-mcp`) | one agent reaches your canvases as tools |
| Agent ↔ agent | **A2A** (`klypix-a2a`) | KLYPIX is a discoverable peer other agents delegate memory tasks to |
| The owned substrate | **`.klypix`** file | the portable, multimodal board *both* layers write to |

What makes this best-in-class for A2A specifically: most A2A agents return
**text**. KLYPIX returns a portable, multimodal **`.klypix` artifact** — the
spatial board itself, as a `FilePart` the human owns and any model can re-open.

## Run it

```bash
npx -p klypix-mcp klypix-a2a --vault ./canvases          # default 127.0.0.1:41241
# or
KLYPIX_VAULT=./canvases KLYPIX_A2A_PORT=41241 npx -p klypix-mcp klypix-a2a
```

Flags / env: `--vault` (`KLYPIX_VAULT`), `--port` (`KLYPIX_A2A_PORT`, default
`41241`), `--host` (`KLYPIX_A2A_HOST`, default `127.0.0.1`).

It is **local-first**: it binds loopback and needs no auth, because the file
lives on your disk. To expose it, set `--host 0.0.0.0` behind a reverse proxy
that terminates TLS and adds authentication.

## Discover it

The Agent Card is published at the standard well-known path (RFC 8615):

```
GET http://127.0.0.1:41241/.well-known/agent-card.json
```

It advertises the `url` of the JSON-RPC endpoint, `capabilities.streaming`, and
the skills below.

## Skills

| Skill `id` | Does | Returns |
|---|---|---|
| `make_board` | Create a new `.klypix` from cards + connections | a `.klypix` **FilePart** + summary |
| `remember` | Append cards/decisions to an existing canvas (positions preserved) | the updated `.klypix` |
| `recall` | Search card text/titles/`#tags` across the vault | matching cards (text) |
| `read_canvas` | Read one canvas (cards, graph, `[[links]]`) + its images | markdown + image FileParts |
| `list_canvases` | List canvases with counts | text |
| `brain_insights` | Hubs / orphans / stale questions in a brain | text |
| `search_all_brains` | Cross-project memory search (semantic + lexical) | text |

## Talk to it (JSON-RPC 2.0)

Methods: `message/send`, `message/stream` (SSE), `tasks/get`, `tasks/cancel`.

**Deterministic invocation** — an orchestrator sends a `DataPart` naming the
skill and its args (this is the reliable contract):

```jsonc
POST /
{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": {
    "message": {
      "kind": "message", "role": "user", "messageId": "1",
      "parts": [{
        "kind": "data",
        "data": {
          "skill": "make_board",
          "args": {
            "title": "Launch plan",
            "cards": [{ "text": "Ship A2A face" }, { "text": "Seed MCP directory" }],
            "connections": [{ "from": 0, "to": 1, "relationship": "leads_to" }]
          }
        }
      }]
    }
  }
}
```

The result is an A2A `Task` whose `artifacts[0].parts` contains a
`{ kind: "file", file: { mimeType: "application/vnd.klypix+zip", bytes } }` — the
board itself.

**Free-text invocation** — a plain message is routed by intent (a convenience
for chat-style callers):

- *"What do we know about auth?"* → `recall`
- *"What's in the roadmap canvas?"* → `read_canvas` (a named canvas reads, not lists)
- *"Remember that we chose Postgres."* → `remember` (one card on the brain)
- *"Summarize the canvas roadmap."* → `read_canvas`
- *"Make a board: Alpha; Beta; Gamma"* → `make_board` (a free-text brief is split
  into one card per line/item; structured `cards` via a `DataPart` is preferred and
  lossless). With neither, it returns `input-required` with the exact `DataPart` to send.

If a write (`make_board`/`remember`) returns `input-required`, reply with a message
carrying the same `taskId` plus the missing input to **continue that task** (the
server resumes it with a stable id and accumulated history).

## Notes

- Tasks complete synchronously (the work is local file I/O), so `message/send`
  returns a terminal `Task`. `message/stream` emits a **monotonic** lifecycle in
  one burst — a non-terminal `Task` (`submitted`), then (for completed work) an
  `artifact-update`, then exactly one terminal `status-update` with `final:true`.
- The server binds loopback and exposes no auth; the A2A face additionally
  refuses any `canvas` reference that resolves **outside the vault** (absolute or
  `..` paths), even though the underlying engine would allow it for the trusted
  MCP/stdio caller.
- Provenance: writes are stamped with the calling agent's name when supplied via
  `message.metadata.agentName` (or a `DataPart` `agentName`), else `a2a`.
- The A2A and MCP faces share one engine (`src/klypix-core.mjs`); neither can
  corrupt the other, and both operate only on the `.klypix` files in the vault.
