# Security Policy — klypix-mcp

klypix-mcp is a local-first MCP server: a shared, versioned project brain
(`brain.klypix`) that multiple agent sessions read and write on one machine,
with an optional (consented, default-off) cross-machine presence relay. This
document says what we protect, how updates are verified, exactly what data
goes where, and how to report a problem. The full analysis lives in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Supported versions

| Version line | Status |
|---|---|
| Latest published `1.x` on npm | Supported — security fixes ship here |
| Older `1.x` | Not patched individually; the built-in updater moves adopters to the latest same-major release within ~24h |
| Pre-`1.0` / forks / `dev`-stamped local deploys | Unsupported |

The automatic updater (`src/mcp-auto-update.mjs`) only ever moves **forward**
within the **same major** version, installs by **exact version**, and never
touches a developer-owned (`dev: true`) runtime. A new major version always
requires a deliberate manual `npx klypix-mcp install`.

## Reporting a vulnerability

Email **hello@klypix.com** (reaches the founder directly — the same contact
published in `package.json`). Please include a reproduction or a pointer to
the affected file/line if you have one.

- You should get a human acknowledgement within a few days.
- Please do not open a public GitHub issue for anything exploitable before
  it is fixed; ordinary bugs are welcome at
  https://github.com/dahshanlabs/klypix-mcp/issues.
- There is no bug bounty. Credit is given in release notes unless you ask
  otherwise.

## Threat model, in one paragraph

The assets are the **brain file** (durable, often git-committed project
memory), the **user's repositories** (we project managed config blocks and a
git hook into them), and the **`~/.claude` runtime directory** (the installed
engine every session executes). The boundaries we defend are the **npm supply
chain** (what the auto-updater will execute next), the **MCP host** (which we
must trust to call tools honestly), **other local processes** (same-user file
access is the OS's boundary, not ours), and the **cloud relay** (presence
metadata, default-off). The detailed version — per-asset, per-boundary, with
the specific shipped mechanism and the accepted residual risks — is
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Update verification (verify-before-install)

Publishing is tokenless: GitHub Actions OIDC trusted publishing, which makes
npm attach a **SLSA provenance attestation** to every release, and the publish
workflow fails unless the registry document carries it
(`.github/workflows/publish.yml`).

Since this wave, the **client verifies before installing**
(`src/update-provenance.mjs`, wired into `src/mcp-auto-update.mjs`):

1. **Artifact integrity** — the exact-version tarball is downloaded and its
   hash must match the registry metadata's `dist.integrity` (the same value
   npm re-enforces during the actual install), and `dist.tarball` must stay
   on `registry.npmjs.org` over https.
2. **Provenance** — the version's npm attestation
   (`https://registry.npmjs.org/-/npm/v1/attestations/klypix-mcp@<version>`)
   must exist, carry a SLSA provenance predicate whose in-toto subject names
   this exact package@version (sha512 subject digest cross-checked against
   the verified tarball), and whose predicate names
   **github.com/dahshanlabs/klypix-mcp** as the source repository.

**Failure fails closed**: the current version is kept and a durable
`verification-refused` receipt is written; `npx klypix-mcp doctor` (and the
`brain_doctor` MCP verb) renders it in red with hand-verification pointers,
and the verdict downgrades so the machine never reads as all-clear. Only a
registry that cannot be reached at all degrades to the pre-existing quiet
"check failed safely, retry next cycle" path.

Honesty note: this is existence + artifact-binding + source-repo verification
of the attestation document, **not** a full sigstore certificate-chain
verification (deliberate: this runtime carries no heavy dependencies). It
defeats the realistic attack — a stolen-token npm publish, which produces no
provenance or provenance naming the wrong repo. See the module header for the
full statement.

### Escape hatches (know what you are turning off)

- `KLYPIX_AUTO_UPDATE=0` — disables automatic updates entirely. Safe; you
  update manually.
- `KLYPIX_UPDATE_VERIFY=off` — **dangerous**. Installs updates without any
  client-side verification, restoring the pre-verification trust model where
  any npm publish is executed unexamined. It exists only for emergency
  recovery (e.g. the attestation endpoint changes shape and refusals block a
  legitimate security fix). Never set it ambiently; every install made with
  it leaves an auditable `SKIPPED` receipt in the update status.

## Data flow — the honest one-pager

**What the tools read:** the project directory you point them at (the brain
file, git metadata for commit capture and release state, host config files it
manages), and `~/.claude/project-brain` (the installed runtime, the machine's
project registry, and per-brain session/coordination lane files).

**What the tools write:** `brain.klypix` (locked, atomic, merge-without-loss —
`src/brain-write-lock.mjs`, `src/merge-brains.mjs`, restore points via
`src/brain-history.mjs`); managed, fenced blocks in host config files
(`AGENTS.md`, `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, … —
`src/agent-rules.mjs`; human content outside the fence is preserved); a
chainable git `post-commit`/`post-merge` hook (`src/git-capture-install.mjs`;
a foreign hook in the slot is never edited automatically); the four Claude
lifecycle hooks in `~/.claude/settings.json` (atomic, backed up, refused on
invalid JSON); and the runtime bundle + receipts under
`~/.claude/project-brain`.

**What never leaves the machine:** brain content — cards, connections, titles,
evidence, file paths, diffs, repo contents. There is **no telemetry** in this
package. The only network calls the installed runtime makes on its own are to
`registry.npmjs.org` (version check, and since this wave: metadata, tarball,
and attestation reads for update verification). `npx klypix-mcp doctor --npm`
runs one `npm view`. The A2A face (`npx klypix-a2a`) is user-started,
**refuses non-loopback binds**, and gates writes behind a per-start bearer
token under `~/.claude/project-brain`.

**What the presence relay sends, only when consented:** cross-PC presence is
**default-off, versioned, revocable consent in both directions**
(`src/presence-relay.mjs`; the transport — one Supabase Realtime channel per
shared brain — is owned by the KLYPIX desktop app). A presence frame carries a
**whitelist** and nothing else: session id, a **hashed** machine id, host
label, client name, surface, git branch, the one-line declared intent,
repo-relative expected-file keys, and a send time. Coordination-message frames
additionally carry the explicit note text. No cwd, pid, model name, file
bytes, card payloads, diffs, or screen data — nothing outside the whitelist
can be attached, because frames are built by copying named fields only. One
caveat we will not hide: a *person* can type sensitive material into a note;
the note body is user content, not metadata.

**PII/secret hygiene:** `brain_doctor` runs a conservative scanner
(`src/brain-sanitize.mjs`) over the brain's text — emails, key headers, API
tokens, JWTs, certificate fingerprints, home paths, phone numbers — and
reports **counts and kinds with redacted previews only**. It never edits the
brain; redaction is a human decision.
