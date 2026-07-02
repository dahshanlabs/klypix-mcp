// agent-rules — make a project's brain.klypix AUTOMATIC for EVERY agent tool, not
// just Claude Code. Claude Code gets the brain via hooks (settings.json, see
// klypix-install). Other agents (Cursor, Cline, Windsurf, Copilot/VS Code, Gemini
// CLI, Aider, and the AGENTS.md cross-tool standard) have no hook system — so we
// drop their NATIVE files:
//
//   • an MCP server config  → the agent CAN reach the brain's tools
//   • a rules / instructions → the agent is TOLD to read the brain at task start and
//                              capture decisions, on every session, automatically
//
// Agent-neutral by construction: the brain DATA is one shared brain.klypix; this just
// teaches each tool to use it. Idempotent — owned files are rewritten wholesale; shared
// files (AGENTS.md, copilot-instructions.md, GEMINI.md) get a fenced block merged in
// place, never clobbering the user's own content. Pure fs/path; never throws for one bad
// target.
//
// DRIFT-AWARE (added 1.13.0): the managed fence now carries `v=<brainVersion>` +
// `hash=<contentHash>` so a projected block is CLASSIFIABLE without re-writing it —
// ok / stale (older brain) / hand-edited (content changed inside the block) / missing.
// `linkProject(dir, { check:true })` returns that audit without touching disk; it's what
// `npx klypix-mcp link --check` and `brain_doctor`'s harness layer read. Closes the
// audited "harness projection is write-once, drift is undetectable" gap.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha8 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
const cmpSemver = (a, b) => { const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); } return 0; };

// The klypix-mcp version this projection was written from — stamped into the fence so a
// later session can tell a stale block (older brain) from a hand-edited one. Read from
// package.json walking up from this file (the flat ~/.claude runtime has no versioned
// package.json, but `link` always runs from the npm package, where it does). Overridable
// via linkProject(dir, { version }).
export function resolveVersion() {
  let dir = HERE;
  for (; ;) {
    try { const v = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; if (v) return v; } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return '0.0.0';
    dir = parent;
  }
}

// The one canonical instruction every agent gets. Tool-and-CLI dual so it works whether
// or not the agent has the klypix-canvas MCP wired.
const BRAIN_INSTRUCTIONS = `## KLYPIX project brain

This project has a **spatial brain** at \`./brain.klypix\` — the living memory of its
decisions, open questions, and findings (the shared human↔agent memory for this repo).
Treat it as authoritative project context, and as **the place project knowledge lives** so it
survives across sessions, agents, and context resets.

**At the start of a task — read it** so you know the project's state and past decisions:
- if \`.claude/brain-brief.md\` exists, read it — it is the full session brief the brain hook regenerates at every session start (Focus, open questions, skills, recent decisions).
- with the \`klypix-canvas\` MCP server: call \`search_canvases\` / \`read_canvas\` (canvas: \`"brain"\`), or \`brain_insights\` for the load-bearing cards.
- or via CLI: \`npx klypix-read brain.klypix\`

**When you make a real decision, finding, or milestone — capture it HERE** so it persists for the next session/agent:
- with MCP: call \`brain_note\` with a one-line decision, or
- emit a marker line in your output: \`🧠 BRAIN [Area]: <one-line decision>\`, or
- via CLI: \`echo "🧠 BRAIN [Area]: <decision>" | npx klypix-append brain.klypix\`

Capture **sparingly** — real decisions / milestones / open questions / reusable gotchas, not routine
steps — and capture it **at the moment you decide** (a one-line marker inline), not batched or left in
a scratch file to rot. Link related cards with \`[[other-card]]\`. To **correct a stale card**, include
the word \`CORRECTION\` (or "was WRONG" / "OBSOLETE") in the decision — capture then supersedes the
stale card across ALL areas (archived with an arrow + a receipt, restorable if wrong). Suspect stale
facts survive somewhere? Run \`brain_reconcile\` — it surfaces contradiction candidates to confirm.

**Memory routing (important).** If your host has its OWN memory/notes store, that is for *user*
preferences and how to work with this person — keep using it for that. But **project** knowledge
(decisions, milestones, open questions, gotchas) belongs in THIS brain: it is the shared, portable
memory the whole team and every agent reads, not a private scratchpad only you can see. Never let a
project decision live *only* in your host's memory or a scratch file — put it here so the next
session/agent has it.

**Working alongside other live sessions?** Send a one-time coordination note with the
\`brain_message\` MCP tool ("merged the hook refactor — rebase before you commit"); hook-wired peer
sessions (Claude Code) see it at their next prompt. Any client can SEND; only hook-wired sessions
receive, so don't rely on it to reach a hookless peer. Notes are ephemeral (24h), NOT brain cards —
durable decisions still go through \`brain_note\`.

**Don't** hand-edit \`brain.klypix\` (it's a packaged canvas — use the tools) or dump file contents into it; capture the *decision*, not the file.`;

// Content fingerprint of the canonical instructions — stamped into the fence so a
// hand-edit INSIDE the block (body != what its hash claims) is detectable.
const INSTRUCTIONS_HASH = sha8(BRAIN_INSTRUCTIONS);

const FENCE_END = '<!-- klypix-brain:end -->';
// Versioned + hashed start marker. The attrs are between `start` and the closing `-->`,
// so the BROAD FENCE_RE (which matches any start…end) still replaces an OLD unstamped
// block on the next `link` — the upgrade is idempotent.
const fenceStart = (ver) => `<!-- klypix-brain:start v=${ver} hash=${INSTRUCTIONS_HASH} (managed by klypix-mcp — re-run \`npx klypix-mcp link\`) -->`;
const FENCE_RE = /<!--\s*klypix-brain:start[\s\S]*?klypix-brain:end\s*-->/;
// Capturing parse: v=(group1) hash=(group2) inner-body(group3). Attrs optional so a
// legacy unstamped block parses too (version/hash come back undefined → treated as stale).
const FENCE_PARSE_RE = /<!--\s*klypix-brain:start(?:\s+v=([0-9][0-9.]*))?(?:\s+hash=([0-9a-f]+))?[\s\S]*?-->([\s\S]*?)<!--\s*klypix-brain:end\s*-->/;

const fencedBlock = (ver) => `${fenceStart(ver)}\n${BRAIN_INSTRUCTIONS}\n${FENCE_END}`;

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const ensureDir = (p) => fs.mkdirSync(path.dirname(p), { recursive: true });

// Parse a managed block out of arbitrary file text → { version, hash, body } | null.
function parseFence(text) {
  const m = String(text || '').match(FENCE_PARSE_RE);
  if (!m) return null;
  return { version: m[1] || null, hash: m[2] || null, body: m[3] || '' };
}

// Classify a projected fenced file WITHOUT writing (the drift audit). THE single
// source of truth for both check AND write: fenceMerge/writeDedicated skip a file
// IFF this says 'ok', so classify-ok ⇔ link-unchanged can never disagree (the 1.16
// adversarial review found three ways they used to: an unrepairable hand-edited
// stamp, an invisible frontmatter strip, and a check-ok-but-link-downgrades skew).
//   missing      — file absent, or present but carries no managed block
//   hand-edited  — block body no longer matches the hash it was stamped with; or
//                   (owned dedicated files) anything OUTSIDE the fence drifted —
//                   e.g. a stripped `alwaysApply:`/`trigger:` frontmatter, which
//                   silently disables the rule in Cursor/Windsurf
//   ok           — block body is EXACTLY what we'd project today AND the stamp is
//                   consistent with it — regardless of the stamped version. CONTENT
//                   is the contract, the stamp is provenance: a version-only bump
//                   must NOT re-drift every adopter into a re-link treadmill. A
//                   self-consistent block stamped NEWER than the running brain is
//                   also 'ok' (and link leaves it alone — never downgrade).
//   stale        — block body differs from today's instructions AND was stamped from
//                   an older brain (or is a legacy unstamped block) → re-link refreshes
const STAMP_RE = /<!--\s*klypix-brain:start[\s\S]*?-->/;
function classifyFenced(file, version, frontmatter = null) {
  if (!exists(file)) return { status: 'missing' };
  const raw = fs.readFileSync(file, 'utf8');
  const fence = parseFence(raw);
  if (!fence) return { status: 'missing' };
  if (fence.hash && sha8(fence.body.trim()) !== fence.hash) return { status: 'hand-edited', stampedVersion: fence.version };
  const bodyCurrent = sha8(fence.body.trim()) === INSTRUCTIONS_HASH;
  const stampConsistent = !fence.hash || fence.hash === INSTRUCTIONS_HASH;
  if (bodyCurrent && stampConsistent) {
    // Owned dedicated files are OURS wholesale — frontmatter included. Compare the
    // whole file modulo the stamp line so a frontmatter strip/flip reads as drift.
    if (frontmatter !== null) {
      const norm = (s) => String(s).replace(STAMP_RE, '<STAMP>').replace(/\r\n/g, '\n').trim();
      const expected = (frontmatter ? frontmatter + '\n' : '') + fencedBlock(version) + '\n';
      if (norm(raw) !== norm(expected)) return { status: 'hand-edited', stampedVersion: fence.version || null, why: 'frontmatter/layout drifted' };
    }
    return { status: 'ok', stampedVersion: fence.version || null };
  }
  if (!fence.version) return { status: 'stale', stampedVersion: null };
  if (cmpSemver(fence.version, version) < 0) return { status: 'stale', stampedVersion: fence.version };
  return { status: 'ok', stampedVersion: fence.version };
}

// Shared markdown (AGENTS.md, copilot-instructions.md, GEMINI.md): merge our fenced
// block in place, preserving the user's own prose outside the fence.
function fenceMerge(file, version) {
  // Zero-touch IFF the audit says 'ok' (same classifier, so check and write can
  // never disagree): current+consistent block → byte-identical file, no stamp-only
  // churn; a hand-edited stamp or stale body falls through and gets rebuilt.
  if (classifyFenced(file, version).status === 'ok') return { action: 'unchanged' };
  let cur = '';
  let had = false;
  if (exists(file)) { cur = fs.readFileSync(file, 'utf8'); had = true; }
  const block = fencedBlock(version);
  let next;
  let action;
  if (FENCE_RE.test(cur)) { next = cur.replace(FENCE_RE, block); action = 'updated'; }
  else if (cur.trim()) { next = cur.replace(/\s*$/, '') + '\n\n' + block + '\n'; action = 'merged'; }
  else { next = block + '\n'; action = had ? 'merged' : 'created'; }
  if (next === cur) return { action: 'unchanged' };
  ensureDir(file); fs.writeFileSync(file, next, 'utf8');
  return { action };
}

// Owned dedicated rules file: rewrite wholesale (optional frontmatter for always-apply).
function writeDedicated(file, frontmatter, version) {
  // Zero-touch IFF the audit says 'ok' — which for owned dedicated files includes
  // the frontmatter (a stripped alwaysApply/trigger MUST be repaired, not skipped).
  if (classifyFenced(file, version, frontmatter || '').status === 'ok') return { action: 'unchanged' };
  const had = exists(file);
  const body = (frontmatter ? frontmatter + '\n' : '') + fencedBlock(version) + '\n';
  ensureDir(file); fs.writeFileSync(file, body, 'utf8');
  return { action: had ? 'updated' : 'created' };
}

// Project-level MCP config: add the klypix-canvas server, preserving any sibling servers.
// wrapKey differs by tool: Cursor/Claude use "mcpServers"; VS Code uses "servers".
function mergeMcpJson(file, wrapKey, withType) {
  const entry = withType
    ? { type: 'stdio', command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '.'] }
    : { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '.'] };
  let cfg = {};
  if (exists(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim()) { try { cfg = JSON.parse(raw); } catch { return { action: 'skipped', why: 'invalid JSON — left untouched' }; } }
  }
  if (!cfg[wrapKey] || typeof cfg[wrapKey] !== 'object' || Array.isArray(cfg[wrapKey])) cfg[wrapKey] = {};
  const before = JSON.stringify(cfg[wrapKey]['klypix-canvas']);
  cfg[wrapKey]['klypix-canvas'] = entry;
  if (JSON.stringify(cfg[wrapKey]['klypix-canvas']) === before) return { action: 'unchanged' };
  ensureDir(file); fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { action: before === undefined ? 'created' : 'updated' };
}

// Check-only classifier for an MCP json: is the klypix-canvas server wired AND does
// its entry still actually launch klypix-mcp? Presence alone isn't enough — a hand-edit
// that mangles the command/args (so the server never starts) reads as "wired" but is
// broken. We DON'T strict-hash the entry: a customized `--vault <path>` is legitimate,
// so only the invocation (npx/node … klypix-mcp …) must survive; if it doesn't, that's
// drift the user needs to re-`link`.
function classifyMcp(file, wrapKey) {
  if (!exists(file)) return { status: 'missing' };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); }
  catch { return { status: 'hand-edited', why: 'invalid JSON' }; }
  const entry = cfg?.[wrapKey]?.['klypix-canvas'];
  if (!entry) return { status: 'missing' };
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const launches = (entry.command === 'npx' || entry.command === 'node') && args.some(a => a.includes('klypix-mcp'));
  return launches ? { status: 'ok' } : { status: 'hand-edited', why: 'entry no longer launches klypix-mcp' };
}

// The projection map — the single source of truth shared by WRITE (linkProject) and
// CHECK (auditProject), so the two can never disagree about what's projected where.
function targets(projectDir) {
  const j = (...p) => path.join(projectDir, ...p);
  return {
    rules: [
      { tool: 'AGENTS.md (cross-tool standard)', file: j('AGENTS.md'), kind: 'merge' },
      { tool: 'Cursor', file: j('.cursor', 'rules', 'klypix-brain.mdc'), kind: 'dedicated', frontmatter: '---\ndescription: KLYPIX project brain — read at task start, capture decisions\nalwaysApply: true\n---' },
      { tool: 'Windsurf', file: j('.windsurf', 'rules', 'klypix-brain.md'), kind: 'dedicated', frontmatter: '---\ntrigger: always_on\n---' },
      { tool: 'Cline', file: j('.clinerules', 'klypix-brain.md'), kind: 'dedicated', frontmatter: '' },
      { tool: 'GitHub Copilot', file: j('.github', 'copilot-instructions.md'), kind: 'merge' },
      // Added 1.13.0 — close the "not generated at all" coverage gap the audit flagged.
      { tool: 'Gemini CLI', file: j('GEMINI.md'), kind: 'merge' },
      { tool: 'Aider', file: j('CONVENTIONS.md'), kind: 'dedicated', frontmatter: '' },
    ],
    mcp: [
      { tool: 'Cursor', file: j('.cursor', 'mcp.json'), wrapKey: 'mcpServers', withType: false },
      { tool: 'VS Code (Copilot/Continue)', file: j('.vscode', 'mcp.json'), wrapKey: 'servers', withType: true },
    ],
  };
}

const relFile = (projectDir, abs) => path.relative(projectDir, abs).replace(/\\/g, '/');

/**
 * Wire a project so EVERY agent tool reads + captures its brain automatically — or,
 * with { check:true }, AUDIT the projection without touching disk.
 * @param {string} projectDir absolute project root (holds ./brain.klypix)
 * @param {{ version?: string, check?: boolean }} [opts]
 * @returns {{ rules: Array, mcp: Array, hasBrain: boolean, version: string, check: boolean }}
 */
export function linkProject(projectDir, opts = {}) {
  const version = opts.version || resolveVersion();
  const check = !!opts.check;
  const t = targets(projectDir);
  const hasBrain = exists(path.join(projectDir, 'brain.klypix')) || exists(path.join(projectDir, 'brain.any'));

  const rules = t.rules.map((r) => {
    const file = relFile(projectDir, r.file);
    if (check) return { tool: r.tool, file, ...classifyFenced(r.file, version, r.kind === 'dedicated' ? (r.frontmatter || '') : null) };
    const res = r.kind === 'merge' ? fenceMerge(r.file, version) : writeDedicated(r.file, r.frontmatter, version);
    return { tool: r.tool, file, ...res };
  });

  // Project-level MCP files only; Claude Code is covered by `install` (hooks + bundled
  // MCP), so we skip .mcp.json to avoid double-registering its server.
  const mcp = t.mcp.map((m) => {
    const file = relFile(projectDir, m.file);
    if (check) return { tool: m.tool, file, ...classifyMcp(m.file, m.wrapKey) };
    return { tool: m.tool, file, ...mergeMcpJson(m.file, m.wrapKey, m.withType) };
  });

  return { rules, mcp, hasBrain, version, check };
}

/**
 * Check-only harness audit (no writes) — the harness layer of brain_doctor / the body
 * of `npx klypix-mcp link --check`. Rolls the per-file classification into drift sets.
 * @returns {{ files, drift, unprojected, ok, version }}
 */
export function auditProject(projectDir, opts = {}) {
  const { rules, mcp, version } = linkProject(projectDir, { ...opts, check: true });
  const files = [...rules, ...mcp];
  const ACTIONABLE = new Set(['missing', 'stale', 'hand-edited']);
  const drift = files.filter((f) => ACTIONABLE.has(f.status));
  return { files, drift, ok: drift.length === 0, version };
}

export { BRAIN_INSTRUCTIONS, INSTRUCTIONS_HASH, FENCE_RE, parseFence, cmpSemver };
