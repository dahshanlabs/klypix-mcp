# KLYPIX speaks A2A protocol v0.3.0

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
`41241`), `--host` (`KLYPIX_A2A_HOST`, loopback only), and
`--allow-cross-project` (opt in to machine-wide registered-brain search).

It is **local-only and OS-user-authenticated**: it binds loopback (non-loopback
`--host` values are refused), and because loopback is *machine*-local — not
user-local — every mutating `POST /` requires a bearer token. The server writes
a fresh token per start to `~/.claude/project-brain/.a2a-token-<port>` (the same
user-ACL boundary that protects the coordination lane), so only a process
running as your OS user can read it. Clients: `GET /health` first and check
`auth.tokenFingerprint` equals `sha256(token)[:16]` from your token file —
verifying the server before sending the token, so a port-squatting impostor can
neither pass verification nor harvest it. `KLYPIX_A2A_TOKEN` sets a shared
secret instead; `--no-auth` opts out explicitly. Remote exposure remains
unsupported until TLS and a real identity model exist together.

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
| `remember` | Append cards/decisions to an existing canvas (positions preserved) | result summary; flat card appends also return a `.klypix` FilePart |
| `learn_skill` | Capture a reusable how-to / gotcha as a 🛠 skill card — resurfaces every session | result summary |
| `recall` | Search card text/titles/`#tags` across the vault | matching cards (text) |
| `read_canvas` | Read one canvas (cards, graph, `[[links]]`) + its images | markdown + image FileParts |
| `list_canvases` | List canvases with counts | text |
| `brain_insights` | Hubs / orphans / stale questions in a brain | text |
| `search_all_brains` | Cross-project memory search (semantic + lexical); advertised only with `--allow-cross-project` | text |
| `brain_connect` | Find and draw related-but-unlinked cards (proposes before it applies) | text |

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
board itself. If `configuration.acceptedOutputModes` excludes that MIME type,
the server honors the negotiation and does not send the FilePart.

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
- The server validates the request `Host`, rejects foreign browser `Origin`
  headers, accepts only `application/json` POST bodies (maximum 1 MiB), and emits
  no permissive CORS header. The Agent Card and health endpoint do not disclose
  the local vault path.
- For every caller-supplied canvas reference — including a path supplied in a
  text part — the server resolves the effective target once, follows symlinks,
  and refuses it if the resulting file is outside the configured vault. The
  project brain selected by the operator's launch `cwd` remains a separate,
  intentional default for brain-specific operations.
- Provenance is a claim, not authentication: supplied agent names are bounded,
  slugged, and stamped as `a2a:<name>` so they cannot render like an attested
  local `createdVia` identity.
- `search_all_brains` is absent from the default Agent Card and rejected unless
  the operator starts the server with `--allow-cross-project`; it intentionally
  reads the machine-wide brain registry and cannot be made vault-scoped.
- A2A writes are serialized **within the server process only**. The desktop app,
  hooks, and other processes are not coordinated by that lock. Any move off
  loopback or to concurrent multi-process callers requires the shared
  cross-process lock first. Do not describe this as conflict-free or lossless
  across processes.
- A2A does not provide `brain_sync`, presence registration, `brain_message`, or
  `brain_garden` apply. HTTP has no reliable session-close lifecycle for presence,
  messaging would be send-only, and garden's out-of-band human approval gate must
  not be weakened for protocol symmetry.
