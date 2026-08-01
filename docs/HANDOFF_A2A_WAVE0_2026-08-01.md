# Handoff — A2A Wave 0 hardening (for Codex)

Written 2026-08-01 by the session that ran the 12-agent A2A review.
Full analysis: `e:\ANTIGRAVITY\KLYPIX\docs\A2A_REVIEW_2026-08-01.md` — read §3 (sequenced plan)
before starting. This file is the *executable* subset.

**Repo for everything below: `e:\ANTIGRAVITY\klypix-mcp` (NOT the KLYPIX desktop repo).**

## Completion receipt — 2026-08-01

The required Wave 0/1 work is complete and proven. The numbered sections below are preserved as the
original executable handoff; their `DONE` / `NOT DONE` labels describe the state when it was written
and are superseded by this receipt.

| Result | Receipt |
|---|---|
| In-process write serialization | `09a1629 fix(core): serialize canvas writes in-process` |
| A2A protocol boundary hardening + adversarial suite | `1d4fe71 fix(a2a): harden the local protocol boundary` |
| Cross-process brain-write protocol + real process races | `4df940e fix(core): serialize project brain writes across processes` |
| Desktop launcher, truthful Settings copy, i18n, claims matrix | KLYPIX desktop `8951c2c fix(a2a): secure the desktop launcher` |
| Published standalone runtime | `b3c4e2c release: klypix-mcp 1.50.1` — registry artifact boot-probed successfully |
| Generated desktop bundle | KLYPIX desktop `0fc7d5a chore(brain): bundle klypix-mcp 1.50.1` |

Independent canonical verification after `4df940e`: `npm test` passed all 1,353 assertions in
112.2 seconds. That run includes the installer/flat-runtime boot gate, 40/40 in-process writes,
separate-process note/connect/garden/create races, and the adversarial A2A HTTP suite.

Final release verification was repeated from the `1.50.1` source and generated desktop artifact:
the full standalone suite passed; `verify:mcp` reported an exact current bundle; the bundled package
suite passed; desktop prebuild security/recovery/runtime gates passed; app and Electron TypeScript
checks passed; and Vitest passed 76/76 files and 680/680 tests. An isolated
`npx -y klypix-mcp@1.50.1 --help` also proved that the published registry package boots.
After clean deployment and project linking, a live MCP `brain_doctor` check with npm currency enabled
reported `ALIGNED`: core, installed runtime, running server, and npm were all `1.50.1`, with all 14
projected harness files in sync.

The A2A face now binds only to loopback, validates Host/Origin/content type/body size, confines the
effective canvas target (including symlinks and text-part references), hides vault paths, disables
machine-wide search by default, bounds requests/tasks/concurrency/provenance, honors output-mode
negotiation, and guarantees terminal stream failures. The desktop launcher requires an explicit safe
vault, launches with the correct cwd/environment, and surfaces bounded crash diagnostics.

The shared engine now joins the same `.claude/brain-capture.lock` used by the desktop and lifecycle
hook, while retaining the in-process per-path promise chain. Lock exhaustion fails closed: the write
is refused with a retry message instead of overwriting a concurrent writer.

The stale marketing coordination claim was corrected in the project brain: A2A is an experimental
local protocol face and does not provide presence, messaging, or agent coordination. Optional Wave 2
remains deliberately unbuilt per this handoff's strategic stop rule; it requires a named third-party
caller before further A2A investment.

---

## 0. STOP AND READ — two things that are true right now

**(a) `npm test` currently exits 1, and it is NOT the A2A work.** A peer session has uncommitted
work in this repo that breaks the flat bundle:

- `src/finding-routing.mjs` and `test/finding-routing.mjs` are **untracked** (new).
- `src/mcp-presence.mjs` is **modified** to `import { normalizeFileKey } from './finding-routing.mjs'` (line 29).
- `bin/klypix-install.mjs:295` stages a hardcoded file list into the flat bundle, and
  **`finding-routing.mjs` is not in it**.

Result: `test/cli-args.mjs` → `✗ G: a verb absent from the flat bundle fails with a real message
and exit 2` — the bundle dies with `ERR_MODULE_NOT_FOUND: finding-routing.mjs` instead.

**Proven, not guessed:** copying `src/finding-routing.mjs` into the staged bundle dir makes that
exact assertion pass (exit 0, correct message). **Fix = add `'finding-routing.mjs'` to the array at
`bin/klypix-install.mjs:295`**, and check `scripts/sync-bundled-mcp.mjs` for the same gap before the
desktop bundle is cut — otherwise v1.3.74 ships a bundled MCP that cannot boot.

*This is the peer's lane; coordinate before editing `mcp-presence.mjs` or `klypix-install.mjs`.*

**(b) Do NOT use `git stash` to get a baseline in this repo.** Multiple sessions hold uncommitted
work here. `git stash` takes *their* modified tracked files too, which silently changed the test
result and cost me a wrong diagnosis. Compare against `git show HEAD:<file>` instead.

---

## 1. DONE — Wave 0.1, write serialization (`src/klypix-core.mjs`)

**Status: implemented, reproduced, fixed, re-verified. Uncommitted.**

### The defect (measured, not inferred)

Every write op is read-modify-write: `fs.readFileSync` → append/merge/tidy → `atomicWrite`. The
`await` between read and write yields the event loop, so two concurrent callers read the same
pre-write bytes and the second rename wins. `atomicWrite` is rename-atomic — it prevents a *torn*
file, never a *lost update*.

Measured on the shipped code:

```
addToCanvas: 5 parallel calls → 5 reported success → 1 card on disk   ❌ LOST 4
brainNote:   5 parallel calls → 5 reported success → 3 cards on disk  ❌ LOST 2
sequential control: 5 serial calls → 5 cards on disk   (so it is concurrency, not dedup)
```

The A2A face made it reachable (`node:http` serves concurrently); the MCP stdio loop hid it. **The
defect is in the engine, so the MCP server and every CLI bin inherit both the bug and the fix.**

### The fix

Added `withWriteLock` / `withCanvasWriteLock` / `withVaultCreateLock` (a per-path promise chain,
self-pruning) immediately above `opBrainGarden`, and wrapped **all six** `atomicWrite` sites with
the read moved **inside** the critical section:

| Function | Lock |
|---|---|
| `opBrainGarden` (apply) | canvas |
| `opBrainConnect` (explicit-pairs apply) | canvas |
| `opBrainConnect` (semantic apply) | canvas |
| `opCreateCanvas` | **vault** — `safeName` probes the dir, so two concurrent creates of one title both see the name free |
| `opAddToCanvas` | canvas |
| `opBrainNote` | canvas — lock starts **before** the pending-ships drain, or two notes drain the same queue and one batch is lost |

Two implementation details worth preserving:
- `prev.then(() => fn(), () => fn())` — two separate callbacks, deliberately **not** `.then(fn, fn)`,
  which would pass the predecessor's result/error in as `fn`'s first argument.
- The stored tail is `run.then(() => {}, () => {})` so a rejection is never unhandled, and it prunes
  itself from the Map only if it is still the last link — otherwise a long-lived server retains one
  entry per canvas path forever.

### Verification

Harness: `C:\Users\HP\AppData\Local\Temp\claude\e--ANTIGRAVITY-KLYPIX\960f976f-b91d-447e-8ca6-e564a3b7e1fd\scratchpad\repro-concurrency.mjs`
(**move this into `test/` as a permanent regression gate — see Wave 1**).

```
N=5  → addToCanvas 5/5, brainNote 7 (≥5; capture adds area containers)  ✅
N=20 → 20/20, 22                                                        ✅
N=40 → 40/40, 42                                                        ✅
```

**Scope, stated honestly in the code comment:** this is an **in-process** lock. It does not
coordinate with the desktop app or the Claude Stop hook, which are separate processes with their own
advisory `.claude/brain-capture.lock` that this engine still does not honour. Do not let anyone
describe writes as "safe from every direction" on the strength of this commit.

### Before committing

1. Re-run `npm test` **after** the peer's `finding-routing.mjs` staging fix lands; expect green.
2. Commit **only** `src/klypix-core.mjs`. Use a plain `git commit` — **never `git commit --only <paths>`**,
   which re-reads the full working copy and would sweep in the peer's in-flight lines.

---

## 2. NOT DONE — Wave 0.2, the browser-reachable write (`bin/klypix-a2a.mjs`)

**Highest remaining priority. Measured on the shipped server:**

- A `text/plain` POST carrying `Origin: https://evil.example` returned **HTTP 200**, `state: completed`,
  and **persisted a 🛠️ skill card into `brain.klypix`** — a card kind whose own description says it
  resurfaces every session and never ages out, in a file the SessionStart hook injects into every
  future agent session. A POST with no `Content-Type` at all was also accepted.
- `search_all_brains` from a hostile origin returned 1,394 hits across 3 brains, including one
  outside the served vault.

**Unverified (be precise when writing this up):** every *server-side* link is proven with a raw Node
client. The final step — that a real browser would issue and expose that request — is inferred from
CORS rules, not observed. Phrase it as "the server-side preconditions for a drive-by are all
present." It does not change the fix.

**Fix (~15 lines):** delete the three `Access-Control-Allow-Origin: '*'` sites (`:387`, `:416`, `:425`);
reject any request carrying a non-allow-listed `Origin`; allow-list `Host` against
`127.0.0.1`/`localhost`/`[::1]` (DNS-rebind guard); require `Content-Type: application/json` on POST.
**A2A is server-to-server — real clients never send `Origin`, so this costs conformance nothing.**

---

## 3. NOT DONE — Wave 0.3, remaining unauthenticated reach

**Vault escape — blocker, confirmed.**
`parts:[{kind:'data',data:{skill:'read_canvas',args:{}}},{kind:'text',text:'<absolute path outside the vault>'}]`
returned `state: completed` and the full contents of a canvas outside the vault. A DataPart naming
the skill bypasses `routeIntent` entirely.
**Fix:** resolve the effective canvas ref **once**, then validate *that* — ideally via a
`resolveTarget(vault, ref, {confine}) → {file, how, kind, writable}` in `klypix-core`, which also
closes the fuzzy-first-brain write, the marker/re-flow hazard, and the legacy `.any` write surprise.
**Same commit: `A2A.md`'s Notes currently claim the face "refuses any `canvas` reference that
resolves outside the vault." That is a false documented security guarantee — fix the doc with the code.**

Also in this wave:
- `via = 'a2a:' + slug.slice(0,24)` — today `via` is taken verbatim from `metadata.agentName` and
  stamped as `createdVia` (the provenance lens renders it). Measured: an anonymous write produced
  `createdVia: "claude-code"`, and a 100,000-char `agentName` was stored verbatim on every card.
- `search_all_brains` off the default Agent Card, behind `--allow-cross-project`. It reads
  `~/.claude/project-brain/registry.json` machine-wide by design — no vault guard can cover it.
- Bounds: `z.array(cardSchema).min(1).max(500)`, `text: z.string().max(20_000)`, clamp
  `brain_connect` (`threshold` → `[0.3,1]`, `max` ≤ 200 — `{apply:true,threshold:-1,max:100000}`
  currently defeats the similarity gate in one unauthenticated call with no undo verb), body cap
  50MB → 1MB, `server.maxConnections = 16`, in-flight cap ~4 → JSON-RPC busy, LRU the `tasks` Map
  (it never evicts and retains base64 artifacts for the process lifetime).

---

## 4. NOT DONE — Wave 0.4, desktop launcher (`e:\ANTIGRAVITY\KLYPIX\electron\main.ts`, ~2980)

- **Pass `cwd`** (or `KLYPIX_BRAIN`) on the spawn. Without it `resolveDefaultBrain`'s project step
  finds nothing, so **the brain half of A2A is broken under the desktop toggle today**.
- Pass the vault explicitly from Settings and **refuse to start when it resolves to home or Desktop**
  — `a2a.start()` with no args falls through `getVaultPath()` → `app.getPath('desktop')` →
  `os.homedir()`, so the button makes the most dangerous configuration the easiest to reach.
- Drop `vault` from the `/health` body (it returns the absolute path, i.e. the Windows username).
- Capture the child's stderr into `a2a:status` — `stdio:['ignore','ignore','ignore']` discards the
  only channel `log()` writes to, so a crash reads as "Stopped" with no reason.

---

## 5. NOT DONE — Wave 1, make the honesty checkable

**Fix `test/a2a-smoke.mjs` BEFORE chaining it.** It passes clean (29 assertions, exit 0) while
**asserting around three of the defects**: it re-sends `"skill":"make_board"` on continuation
(masking the resume bug), never sends `configuration` (masking output-modes), never streams a
failing case, sends only the *guarded* traversal variant, and has **zero coverage of a normal-canvas
append**. Chaining it unchanged banks false confidence. It is absent from all 34 files in the chain.

Add these failing assertions first, then chain it:
- N parallel writes → N cards on disk (**port the repro harness above — this gates the engine, so it protects MCP too**)
- a canvas ref in a **text part** outside the vault is refused
- a POST carrying a foreign `Origin` is rejected
- a normal-canvas append round-trips
- a plain-text continuation resolves to the *original* skill
- `acceptedOutputModes: ['text/plain']` yields no `.klypix` FilePart
- a forced mid-stream throw still emits a `final: true` terminal event

Plus two drift gates: every `case` in `runSkill` is advertised or in a documented `ALIASES` map
(`search_canvases`, `create_canvas`, `add_to_canvas` are accepted today and appear on no card), and
every `klypix-core` export is either wired or in a `DELIBERATELY_UNWIRED` table with a reason.

**Copy fixes (four surfaces):** Settings caption → "exposes this vault's canvases and the project
brain", keeping the experimental caveat **verbatim**. Claims matrix — **drop the stale "README lists
seven of the nine skills" clause** (README now lists all nine). `A2A.md`'s `remember`/`learn_skill`
rows promise "the updated `.klypix`" that `opBrainNote` does not return. State **"A2A protocol
v0.3.0"** in all four places. Add the missing `settings.a2a.*` i18n keys (Arabic currently falls back
to English). Delete the `--host 0.0.0.0` recommendation from `A2A.md`.

**Time-sensitive, do this first:** strike "a2a" from marketing piece #2's coordination claim. The
brain card reads *"hooks+live-ledger+a2a makes them coordinate/message/share memory."* **A2A has zero
presence participation** — no `brain_sync`, no session registration, no heartbeat. One copy edit now
or a retraction after the video ships.

---

## 6. Wave 2 (optional, ~1 day) — the dual-mode fix

Answers the founder's actual question. `blocksToParts` must emit `result.structured`/`result.context`
as DataParts first (~4 lines; it currently maps only `blocks` and `file`). Then: `resolveTarget` +
**split the dispatcher, not the Agent Card** (two skill tables in one `runSkill`, so no canvas verb
has a reachable `case` touching `opBrainNote`/`tidyBrain`). Delete both `?? 'brain'` write defaults —
an unresolved write returns `input-required` listing the vault's canvases. Wire `canvas_view` (the
one canvas-general op; `test/canvas-view.mjs` is already in the chain).

**Why it matters:** markers currently route through `opBrainNote` → `tidyBrain` against *any* target.
Measured: one `!` marker on a 9-card project board **re-laid out all nine cards**. It can fire with no
caller intent via the implicit `looksLikeSkill` → `'+'` promotion at `:217`.

---

## 7. Do NOT build

- **Presence/`brain_sync` over A2A.** Correctness rests on `removeSession` firing on connection
  close; HTTP has no such event; a ghost peer makes `findPresenceConflicts` stamp
  `severity: 'blocking'` against a session that no longer exists. **A false blocking warning is worse
  than no presence.** Record this in `A2A.md` so it is not re-proposed.
- **`brain_garden` apply — ever.** Its 8-char approval code is obtained out-of-band by a human
  (`npx klypix-mcp garden-code`); a remote agent has no shell to close that loop. Do not weaken a
  human gate for face symmetry.
- **`brain_message`** (send-only megaphone, unreceivable half) or **`brain_reconcile` with a
  wire-supplied `root`** (feeds `readdirSync` across five dirs under an arbitrary absolute path).
- **Anything toward `0.0.0.0`.** Needs auth + TLS + a cross-process lock + a real identity model
  simultaneously.
- **Update/move/delete for A2A's sake.** Note the real ceiling: the engine exports 17 ops and **none
  updates, moves or deletes a card**; `cardSchema` is `{text, heading?, color?}` and zod strips
  `x`/`y`/`parentId`; `appendToKlypix` hardcodes one vertical column. That gap belongs to
  `klypix-core` and should be justified on MCP's user base, not A2A's.

---

## 8. The one thing worth more than all of the above

**Port `withBrainLock` into `klypix-core` as a cross-process lock.** The house already has an
advisory-lock protocol — `<realpath(brainDir)>/.claude/brain-capture.lock`, written *twice*
(`KLYPIX/electron/canvas/brainLock.ts`, `global-brain-hook.mjs`) — and the shared engine honours
**none** of it. So the desktop app refuses to save rather than overwrite an agent's card, while the
CLI engine overwrites the app's and the hook's work silently. `mergeBrains` already ships here with
37 assertions across 13 scenarios.

Four writers converging on one protocol instead of two-of-four. **Worth days, and none of them are
A2A days.** The Wave 0.1 in-process lock is a strict subset of this and is superseded by it.

---

## 9. Strategic frame (so effort lands proportionally)

Waves 0 and 1 are ~1.5 days and are worth doing **regardless of what you think of A2A** — neither is
an A2A feature. The write loss is a `klypix-core` defect shipped in the free CLI; the unauthenticated
write is a persistent prompt-injection surface; the false containment sentence in `A2A.md` is an
untrue security claim.

Past Wave 2, do not invest. Bound to `127.0.0.1`, A2A's only structural advantage over MCP — remote,
registry-discoverable delegation — is cancelled, and no registry can list `http://127.0.0.1:41241`.
MCP reaches 18 tools on the same machine; A2A reaches 9. The stated wedge (Claude Code, Cursor,
Copilot, Codex) speaks MCP and shows no A2A client support. **A2A is a credibility asset, not a
distribution channel** — buy the credibility with correctness, cheaply, then stop. Trigger to resume:
one named third-party caller.
