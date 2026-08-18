# klypix-mcp Threat Model

Written 2026-08-18 as part of the security wave, from adversarially-verified
audit findings. Companion to the summary in [../SECURITY.md](../SECURITY.md).
Every mitigation cites the real file that implements it; if a cited mechanism
disappears, the claim it backs is dead and must be removed too.

klypix-mcp is deliberately **local-first**: the valuable data (the brain, the
repos) lives in plain files under the user's own OS account, and the network
surface is narrow (npm registry reads, plus an opt-in presence relay whose
transport lives in the desktop app). The model below is therefore mostly about
**what executes on the machine** and **what leaves it**.

---

## 1. Assets

| Asset | Why it matters | Where it lives |
|---|---|---|
| **The brain file** (`brain.klypix` / legacy `brain.any`) | Durable project memory: decisions, evidence, corrections. Often git-committed and pushed; sometimes cloud-synced by the desktop app. It is read into *every* future agent session's context, so corrupting or poisoning it poisons all downstream work — and anything pasted into it travels wherever the repo travels. | Each project root |
| **The user's repositories** | We write into them: managed fenced blocks in `AGENTS.md`/host MCP configs, and a chainable git hook. A hostile write here would execute in the user's dev loop. | Each project root, `.git/hooks` |
| **`~/.claude/project-brain` (the installed runtime)** | The engine every MCP session and lifecycle hook executes. Whoever controls these files controls every future agent session on the machine. Also holds the machine's project registry and per-brain coordination lanes. | `~/.claude/project-brain` |
| **`~/.claude/settings.json`** | Hook wiring — commands Claude Code runs at session lifecycle events. | `~/.claude` |
| **Presence metadata** (cross-PC, consented) | Session identity, declared intent, expected files, note text — low-sensitivity by design, but user-visible privacy surface. | Supabase Realtime channel (desktop-app-owned transport) |

## 2. Trust boundaries

### B1 — the npm supply chain (highest-consequence boundary)

The auto-updater (`src/mcp-auto-update.mjs`) will download and execute the
next published version on every adopter machine within ~24h. Whoever can
publish `klypix-mcp` to npm can run code on every adopter machine.

**Shipped mitigations:**

- **Tokenless publish with provenance** — GitHub Actions OIDC trusted
  publishing; the workflow refuses to go green unless the registry document
  carries `dist.attestations.provenance`, and re-verifies integrity before
  ever waiving an "already published" state
  (`.github/workflows/publish.yml`).
- **Client-side verify-before-install** (`src/update-provenance.mjs`, wired
  in `src/mcp-auto-update.mjs`): tarball hash must match the exact-version
  `dist.integrity`; `dist.tarball` must stay on `registry.npmjs.org`; the npm
  attestation must exist and its SLSA provenance predicate must bind this
  exact artifact (sha512 subject digest) to
  `github.com/dahshanlabs/klypix-mcp`. **Fails closed** with a durable
  `verification-refused` receipt rendered loudly by `brain_doctor`
  (`src/brain-doctor.mjs`). Escape hatch `KLYPIX_UPDATE_VERIFY=off` is
  documented as dangerous and leaves an auditable `SKIPPED` receipt.
- **Exact-version, same-major, forward-only installs** — no dist-tag
  following, no major jumps, never a downgrade
  (`src/mcp-auto-update.mjs` `runAutoUpdateCheck`, `src/install-version.mjs`
  never-downgrade gate).
- **No shell concatenation in the installer spawn** — strict `x.y.z` semver
  gate before any process creation; Windows path invokes npm's JS entry with
  the exact node binary, no shell (`src/mcp-auto-update.mjs`
  `installExactRuntime`; locked by `test/mcp-auto-update.mjs`).
- **Runtime integrity manifest** — the installer stamps a sha256 per staged
  file into `.mcp-runtime.json` (`bin/klypix-install.mjs`) and the supervisor
  refuses to hot-swap a worker whose files don't match
  (`src/mcp-supervisor.mjs`, "runtime integrity mismatch").
- **Released-tag deploy guard** — deploying from an untagged/dirty source
  tree requires explicit `--allow-untagged` acknowledgement and stamps the
  install `dev`, which the updater then refuses to silently overwrite
  (`bin/klypix-install.mjs`, `src/repo-state.mjs`,
  `test/released-tag-guard.mjs`).

**Accepted residual risks:** (a) attestation verification checks existence,
artifact binding, and source repo — not the sigstore certificate chain; a
forged attestation *document* served by a fully compromised registry
endpoint could pass (raising the bar to "compromise npm's registry serving",
not "steal a token"). (b) A compromise of the real repo's GitHub Actions
pipeline produces *genuine* provenance and defeats all of this — the CI is
inside the trust base. (c) The ~24h check cadence means a malicious version
that somehow passes verification propagates before humans react.

### B2 — the MCP host (and the agents it runs)

The host (Claude Code, Codex, Cursor, …) launches the server and calls tools
on behalf of a model. We **trust the host**: there is no authentication
between host and server over stdio, by MCP design. The interesting threat is
the *content* flowing through: brain text is written by past agents and
humans, then rendered into future agents' context — a prompt-injection
channel with persistence.

**Shipped mitigations:**

- Brain writes are **additive and recoverable**: locked, atomic writes
  (`src/brain-write-lock.mjs`), a no-loss merge invariant
  (`src/merge-brains.mjs`), deletions parked in a graveyard rather than
  destroyed (`src/brain-graveyard.mjs`), and restore points
  (`src/brain-history.mjs`) — a poisoned or destructive write session cannot
  silently erase history.
- Peer-authored coordination text is **marker-neutralized** before it is
  rendered into another session's context, so a note cannot impersonate the
  engine's own directive markers (`src/agent-presence.mjs`
  `neutralizeMarkers`, exercised throughout `src/mcp-presence.mjs`).
- The doctor reports **provenance per card** (`createdBy`, channels) and the
  PRIVACY scan (`src/brain-sanitize.mjs`) surfaces secrets/PII that an agent
  (or human) pasted into the brain — counts + kinds with redacted previews,
  never auto-edited.
- The server itself exposes **no arbitrary-shell tool**; its verbs operate on
  brain/canvas files and git metadata.

**Accepted residual risks:** a malicious or confused *model* with tool access
can still write misleading (non-destructive) content into the brain; brain
text remains untrusted natural language to whoever reads it. Neutralization
covers the engine's own marker vocabulary, not every conceivable injection
phrasing. A hostile MCP host owns the session outright — out of scope.

### B3 — other local processes (same OS user)

Everything we store is plain files under the user's account: the brain, the
runtime, lane files, the A2A bearer token. The OS user boundary is the real
boundary; any same-user process can read or tamper with all of it.

**Shipped mitigations:** the A2A HTTP face **refuses non-loopback binds**
outright and gates writes behind a per-start bearer token stored under
`~/.claude/project-brain` — loopback TCP is machine-local, not user-local, so
the token restores the OS-user boundary (`bin/klypix-a2a.mjs`). Lock files
carry pid+token and go stale rather than wedging (`src/install-lock.mjs`,
`src/mcp-auto-update.mjs` `acquireLock`). Hook installation refuses invalid
JSON, backs up, writes atomically, and never edits a foreign git hook
(`bin/klypix-install.mjs`, `src/git-capture-install.mjs`).

**Accepted residual risks:** no OS-level integrity protection of the runtime
directory between the supervisor's manifest checks; a same-user malware
process can modify anything we own. This is the platform's boundary to
enforce, not an application's — stated, not solved.

### B4 — the cloud relay (presence)

Cross-PC presence frames ride one Supabase Realtime channel per shared brain.
The transport is **owned by the KLYPIX desktop app**; this package only
builds, validates, and merges frames.

**Shipped mitigations:** default-off, versioned, revocable consent gating
**both** directions (`src/presence-relay.mjs` `presenceConsentAllows`);
payloads built by **whitelist** (session id, hashed machine id, host label,
client, surface, branch, one-line intent, repo-relative expected-file keys,
send time; message frames add the explicit note text — nothing else can be
copied in); receiver-clock freshness so a wrong clock can't fake liveness;
unknown wire versions rejected silently; v3 message frames carry a
receiver-enforced recipient-machine allowlist so older clients fail closed on
scoped retries. The module imports only `node:crypto` — no fs, no network —
and `test/presence-relay.mjs` asserts it.

**Accepted residual risks:** a consenting user can type sensitive material
into a note body — that is user content, not metadata, and no consent copy
may claim otherwise. Channel access control (who may join a brain's channel)
is the desktop app's responsibility and is documented in the app's own
security records, not here.

### B5 — the npm registry as a *read* dependency

Version-currency checks (`src/global-brain-hook.mjs` `httpsFetchLatest`,
`src/mcp-auto-update.mjs` `fetchLatestStableVersion`, doctor `--npm`) read
`registry.npmjs.org` and nothing else. Responses are size-capped, parsed
defensively, and a lying "latest" can at worst cause a skipped or refused
update — the verification in B1 decides what actually installs.

## 3. What each shipped mechanism buys — quick index

| Mechanism | File(s) | Defends |
|---|---|---|
| OIDC publish + provenance read-back | `.github/workflows/publish.yml` | B1 |
| Verify-before-install (fail closed) | `src/update-provenance.mjs`, `src/mcp-auto-update.mjs` | B1 |
| Exact/same-major/forward-only updates | `src/mcp-auto-update.mjs`, `src/install-version.mjs` | B1 |
| Shell-free exact-semver installer spawn | `src/mcp-auto-update.mjs` | B1 |
| Runtime sha256 manifest + swap gate | `bin/klypix-install.mjs`, `src/mcp-supervisor.mjs` | B1, B3 |
| Released-tag deploy guard (`dev` stamping) | `bin/klypix-install.mjs`, `src/repo-state.mjs` | B1 |
| Locked/atomic/no-loss brain writes + history + graveyard | `src/brain-write-lock.mjs`, `src/merge-brains.mjs`, `src/brain-history.mjs`, `src/brain-graveyard.mjs` | B2 |
| Marker neutralization of peer text | `src/agent-presence.mjs`, `src/mcp-presence.mjs` | B2 |
| PII/secret scan, report-only | `src/brain-sanitize.mjs`, `src/brain-doctor.mjs` | B2 (and the leak class in Assets) |
| A2A loopback-only + per-start bearer token | `bin/klypix-a2a.mjs` | B3 |
| Foreign-hook / invalid-JSON refusal, atomic config writes | `bin/klypix-install.mjs`, `src/git-capture-install.mjs`, `src/agent-rules.mjs` | B3, Assets |
| Consent-gated whitelisted presence frames | `src/presence-relay.mjs` | B4 |

## 4. Known accepted risks (the honest list)

1. **Attestation verification is document-level, not sigstore-chain-level**
   (B1). Deliberate dependency-weight tradeoff, stated in
   `src/update-provenance.mjs`.
2. **CI compromise of the real repo defeats provenance** (B1). The GitHub
   Actions pipeline is inside the trust base.
3. **Brain text is persistent untrusted input to future agents** (B2).
   Mitigated for the engine's own marker vocabulary; not eliminable in
   general.
4. **Same-user local processes can read/tamper everything** (B3). The OS
   boundary is the boundary.
5. **Note bodies in presence messages are arbitrary user text** (B4).
6. **The 24h update cadence is a propagation window** (B1) — chosen over
   per-session registry traffic.
7. **Lane/registry JSON under `~/.claude/project-brain` is not
   integrity-protected** between supervisor checks (B3); a corrupt file
   degrades to a reported fact, not silent adoption
   (`src/brain-doctor.mjs` doctrine: "an absent seam is a fact to report").

When one of these stops being acceptable, it moves from this list into a
wave — the same way this wave retired "the updater trusts npm blindly".
