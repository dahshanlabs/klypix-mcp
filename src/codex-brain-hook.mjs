#!/usr/bin/env node
// Codex lifecycle adapter for the agent-neutral KLYPIX presence lane.
// It never reads Codex's unstable transcript format and never modifies the brain.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  codexToolActionId,
  deriveIntentFromPrompt,
  endSession,
  findProjectBrain,
  formatPresenceMessage,
  formatReceivedMessages,
  formatUnfinishedWork,
  listUnfinishedWork,
  peekMessages,
  postPresenceMessage,
  receiveMessages,
  shortestUniqueSessionPrefix,
  upsertSession,
} from './agent-presence.mjs';
import { recordCodexHookExecution } from './codex-hooks.mjs';
import { opBrainTaskContext } from './klypix-core.mjs';
// Namespace import (already in-process via the klypix-core chain, so zero added
// load cost) so a bundle whose klypix-format predates classifyDecay degrades
// gracefully — a named import of a missing export would kill the whole hook.
import * as brainFormat from './klypix-format.mjs';
import { annotateConflictFiles, findPresenceConflicts } from './mcp-presence.mjs';

function readInput() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Best-available host pid for lane-row correlation (2026-08-14 wave). Codex
// rows previously carried no hostPid at all, so the footer/doctor could never
// group a lifecycle row with its MCP-worker sibling. KLYPIX_HOST_PID is a
// host-declared contract (provenance 'env' — safe for the dead-host liveness
// sweep); otherwise this hook's direct parent is a best-effort guess
// (provenance 'ppid' — usable for row correlation only, NEVER probed for
// liveness, because the parent may be a transient shell wrapper whose exit
// says nothing about the session).
const HOST_PID = (() => {
  const envPid = Number(process.env.KLYPIX_HOST_PID || 0);
  if (Number.isInteger(envPid) && envPid > 0) return { pid: envPid, source: 'env' };
  const ppid = Number(process.ppid);
  return Number.isInteger(ppid) && ppid > 0 ? { pid: ppid, source: 'ppid' } : { pid: null, source: null };
})();

// Thin binding of the engine's host-neutral ship observer to a Codex project
// dir. Guarded on the export so an older bundled klypix-format degrades to no
// observation rather than killing the hook.
function observeShipDrift(projectDir) {
  try {
    if (!projectDir || typeof brainFormat.observeShipDrift !== 'function') return '';
    const gitRun = (args) => execFileSync('git', String(args).split(/\s+/).filter(Boolean), {
      cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    });
    return brainFormat.observeShipDrift(projectDir, { gitRun }).notice || '';
  } catch {
    return '';
  }
}

function gitBranch(cwd) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1200,
    }).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

function toolName(input) {
  return String(input.tool_name || input.toolName || input.tool?.name || '');
}

function toolInput(input) {
  const candidate = input.tool_input || input.toolInput || input.tool?.input;
  return candidate && typeof candidate === 'object' ? candidate : {};
}

// A relative path resolves against `baseDir`, the session's working directory
// (see touchedFiles). A path outside the project returns null, including one
// on another drive, where path.relative returns an absolute path.
function projectRelative(file, projectDir, baseDir = projectDir) {
  if (!file) return null;
  const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(baseDir, file);
  const fromProject = path.relative(projectDir, absolute);
  if (path.isAbsolute(fromProject)) return null;
  const relative = fromProject.replace(/\\/g, '/');
  if (!relative || relative === '.' || relative === '..' || relative.startsWith('../')) return null;
  return relative;
}

// File paths an apply_patch body names, read the way Codex's own parser reads
// them (codex-rs/apply-patch/src/streaming_parser.rs, process_line):
// - Outside an Update hunk (right after *** Begin Patch, among an Add File's
//   '+' lines, after a Delete File) a header is matched on the line with
//   leading and trailing whitespace trimmed, so an indented header there is
//   still a header and Codex edits that file.
// - Inside an Update hunk only trailing whitespace is trimmed, so a header
//   must start at column 0 and an indented one is a context line. Hunk lines
//   that start with '+', '-' or ' ' are never headers.
// - The marker includes its one space ("*** Update File: ") and the path is
//   the rest of the line with nothing more trimmed, as Codex's PathBuf::from
//   takes it: "*** Update File:a.md" is no header, and a double space names
//   " a.md". An empty path is no header (trimming removes the space).
// - "*** Move to: " is read only on the line straight after an Update File
//   header. A move touches the old path and the new one.
const APPLY_PATCH_HEADERS = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
];
const APPLY_PATCH_MOVE = '*** Move to: ';

function applyPatchHeader(line) {
  for (const [marker, mode] of APPLY_PATCH_HEADERS) {
    if (line.startsWith(marker) && line.length > marker.length) return { mode, path: line.slice(marker.length) };
  }
  return null;
}

function applyPatchPaths(patch) {
  const paths = [];
  let mode = 'started';
  let moveAllowed = false;
  for (const line of patch.trim().split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '*** Begin Patch') { mode = 'started'; moveAllowed = false; continue; }
    if (trimmed === '*** End Patch') { mode = 'ended'; moveAllowed = false; continue; }
    if (mode === 'ended') continue;
    const candidate = mode === 'update' ? line.trimEnd() : trimmed;
    const header = applyPatchHeader(candidate);
    if (header) {
      paths.push(header.path);
      mode = header.mode;
      moveAllowed = header.mode === 'update';
      continue;
    }
    if (mode === 'update' && moveAllowed && candidate.startsWith(APPLY_PATCH_MOVE)
      && candidate.length > APPLY_PATCH_MOVE.length) {
      paths.push(candidate.slice(APPLY_PATCH_MOVE.length));
    }
    moveAllowed = false;
  }
  return paths;
}

// The apply_patch body. The official Codex hooks docs
// (https://learn.chatgpt.com/docs/hooks) say: "Bash and apply_patch use
// tool_input.command". Codex builds both PreToolUse and PostToolUse input as
// { tool_name: "apply_patch", tool_input: { command: <the raw patch> } }.
// Before 2026-10-16 only `patch`, `input` and `content` were read, so no real
// Codex edit was attributed. `command` is read first; those three stay as
// fallbacks, and a bare-string tool_input is taken as the patch itself.
function applyPatchBody(input) {
  const args = toolInput(input);
  const raw = input.tool_input ?? input.toolInput ?? input.tool?.input;
  const command = Array.isArray(args.command) ? args.command : [args.command];
  return [...command, args.patch, args.input, args.content, raw]
    .find((value) => typeof value === 'string' && value.includes('*** ')) || '';
}

// Project-relative paths this tool call names. `cwd` is the session's working
// directory: Codex applies a patch's relative paths from there, and
// findProjectBrain walks UP from it, so the brain's folder can be an ancestor.
export function touchedFiles(input, projectDir,
  cwd = typeof input?.cwd === 'string' && input.cwd ? path.resolve(input.cwd) : projectDir) {
  const name = toolName(input);
  const args = toolInput(input);
  const candidates = [];
  for (const key of ['path', 'file_path', 'filePath', 'target_file', 'targetFile']) {
    if (typeof args[key] === 'string') candidates.push(args[key]);
  }
  const patch = applyPatchBody(input);
  if (patch && /apply_patch|Edit|Write/i.test(name)) {
    candidates.push(...applyPatchPaths(patch));
  }
  return [...new Set(candidates.map((file) => projectRelative(file, projectDir, cwd)).filter(Boolean))];
}

function ownBrainMessageText(input) {
  if (!/brain_message$/i.test(toolName(input))) return [];
  const text = toolInput(input).text;
  return typeof text === 'string' && text.trim() ? [text] : [];
}

const MODEL_CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

export function hookActionId(input, event) {
  const turnId = input?.turn_id || input?.turnId;
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    return codexToolActionId({
      turnId,
      toolUseId: input?.tool_use_id || input?.toolUseId,
      toolName: toolName(input),
      toolInput: toolInput(input),
    });
  }
  const explicit = turnId || input?.action_id;
  return explicit ? `codex-turn:${String(explicit).slice(0, 144)}` : '';
}

export function buildCodexHookOutput(parts, event) {
  const systemMessage = parts.filter(Boolean).join('\n\n').trim();
  if (!systemMessage) return null;
  return {
    // Preserve the legacy common hook field for installed Codex builds while
    // adding the event-specific model-context envelope below.
    continue: true,
    systemMessage,
    ...(MODEL_CONTEXT_EVENTS.has(event) ? {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: systemMessage,
      },
    } : {}),
  };
}

function emitSystemMessage(parts, event) {
  const output = buildCodexHookOutput(parts, event);
  if (!output) return;
  process.stdout.write(JSON.stringify(output));
}

// ── Decay-aware LAST-KNOWN stamps (2026-07-28 post-mortem, class B) ──────────
// Codex-lane parity with the Claude hook's messageFooter: a delivered message
// older than 6h whose text asserts fast-decay build/deploy status must never
// read as current state — the ENGINE stamps it, never the reading model. The
// classifier lives ONCE in klypix-format (typeof-guarded: a stale bundle
// degrades to no stamp, never a throw). Stamps are appended AFTER
// formatReceivedMessages' 400-char render slice so no cut can eat them (the
// v1.32.0 law: a warning is never subject to the budget it warns about), and
// exist in render output only — the lane file, its dedup keys, and its ack
// semantics are untouched. The shared renderer (agent-presence) stamps
// internally when handed the classifier; the pass below is belt-and-braces for
// a mixed bundle whose agent-presence predates that, and its dedup is
// per-MESSAGE — a message the renderer already stamped is skipped without
// suppressing stamps the other messages still need.
const MSG_DECAY_STAMP_MS = 6 * 60 * 60 * 1000;
// Precision-first consumption (mirrors the Claude hook): only an explicit
// `true` / explicitly fast-shaped object stamps — ambiguity never does.
const isFastDecayResult = (r) => r === true || r === 'fast'
  || (!!r && typeof r === 'object' && (r.fast === true || r.fastDecay === true || r.decay === 'fast' || r.class === 'fast' || r.kind === 'fast'));
export function stampReceivedMessages(messages, now = Date.now(),
  classifier = (typeof brainFormat.classifyDecay === 'function' ? brainFormat.classifyDecay : null),
  sessionId = '') {
  const list = Array.isArray(messages) ? messages : [];
  // Thread the full engine surface through — the shared renderer stamps each
  // qualifying message internally (agent-presence stays builtin-only, so the
  // engine functions ride the same injection; guarded for a stale bundle).
  const base = classifier
    ? formatReceivedMessages(list, now, {
      classifyDecay: classifier,
      decayStaleMs: brainFormat.DECAY_STALE_MS,
      decayMessageStamp: typeof brainFormat.decayMessageStamp === 'function' ? brainFormat.decayMessageStamp : undefined,
      formatDecayAge: typeof brainFormat.formatDecayAge === 'function' ? brainFormat.formatDecayAge : undefined,
    }, sessionId)
    : formatReceivedMessages(list, now, {}, sessionId);
  if (!base || !classifier) return base;
  const staleMs = Number(brainFormat.DECAY_STALE_MS) > 0 ? Number(brainFormat.DECAY_STALE_MS) : MSG_DECAY_STAMP_MS;   // threshold single-sourced in the engine
  const stamps = list.map((m) => {
    try {
      const ts = Number(m?.ts) || 0;
      if (!ts || now - ts < staleMs) return '';
      if (!isFastDecayResult(classifier(String(m?.text || '')))) return '';
      // Wording single-sourced in the engine (decayMessageStamp) so the
      // renderers can never drift apart; local fallback for a stale bundle.
      if (typeof brainFormat.decayMessageStamp === 'function') return `  ${brainFormat.decayMessageStamp(now - ts)}`;
      const h = Math.floor((now - ts) / 3_600_000);
      const label = h >= 48 ? `${Math.floor(h / 24)}d` : `${Math.max(1, h)}h`;
      return `  ⏱️ This message is ${label} old and contains build/deploy status — treat as LAST KNOWN, verify live before reporting it.`;
    } catch { return ''; }   // best-effort — a classifier bug must never break delivery
  });
  if (!stamps.some(Boolean)) return base;
  // Per-MESSAGE dedup granularity, not whole-output: pair each `- from …`
  // render line with its message and add a stamp only when the line right
  // after it is not already a stamp. A ⏱ inside a message's own quoted text is
  // NOT a stamp and must not suppress the stamps the OTHER messages need (the
  // old whole-output includes('⏱') guard silenced them all).
  const isStampLine = (l) => /^\s*⏱/.test(String(l || ''));
  const lines = base.split('\n');
  const out = [];
  let msgIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (!lines[i].startsWith('- from ')) continue;
    msgIdx++;
    if (msgIdx >= list.length || !stamps[msgIdx]) continue;
    if (isStampLine(lines[i + 1])) { stamps[msgIdx] = ''; continue; }   // renderer already stamped this one
    out.push(stamps[msgIdx]);
    stamps[msgIdx] = '';
  }
  const leftovers = stamps.filter(Boolean);   // unknown layout → stamps still delivered at the end
  return leftovers.length ? [...out, ...leftovers].join('\n') : out.join('\n');
}

function formatConflictWarning(conflicts, event, sessions = []) {
  if (!conflicts.length) return '';
  const moment = event === 'PreToolUse' ? 'before this edit runs' : 'after this file operation';
  // Grow each shown id (floor 12) until unique — same-window UUIDv7 peers
  // otherwise render as one ambiguous prefix.
  const shortId = (id) => shortestUniqueSessionPrefix(sessions, id, 12) || String(id).slice(0, 12);
  // Claims discipline (2026-08-24 audit): this hook is ADVISORY — the output
  // envelope hardcodes `continue: true` and never denies a tool call — so the
  // banner must say WARNING, never BLOCKING. Urgency comes from the imperative
  // closing line, not from claiming a mechanism that does not exist.
  return [
    `KLYPIX ⚠️ WARNING — exact-file overlap detected ${moment}:`,
    ...conflicts.map((peer) => {
      // Observed/declared distinction (1.70.0): a `*` marks a path whose claim
      // was adopted from live edits, not declared — real overlap, unconfirmed
      // boundary; the legend renders only when a mark exists.
      const annotated = annotateConflictFiles(peer);
      return `- ${shortId(peer.id)}${peer.intent ? ` "${String(peer.intent).slice(0, 90)}"` : ''}: ${annotated.files.join(', ')}${annotated.legend}`;
    }),
    'Coordinate file ownership now. Do not continue overlapping edits until one session yields or the scopes are separated.',
  ].join('\n');
}

// Guard cards, Codex advisory tier (2026-08-24): read the compiled sidecar the
// Claude-side lanes build (one keying rule — brainFormat.guardSidecarPathFor)
// and evaluate against this tool event. Typeof-guarded so a bundle whose
// klypix-format predates guards degrades to silence, never a throw. This lane
// only ever WARNS: block-severity guards are named as such so the model treats
// them as a hard stop, but no mechanism here denies anything.
// Project rules (.klypix/rules.json, made from this brain's lessons). Codex's
// hook output cannot deny a tool call, so a block-severity finding is a warning
// that says so; the git pre-commit hook is what stops the commit.
async function ruleWarnings(projectDir, input, sessionId) {
  try {
    if (!fs.existsSync(path.join(projectDir, '.klypix', 'rules.json'))) return '';
    const lib = await import(new URL('./brain-rules.mjs', import.meta.url).href);
    if (typeof lib.preToolUseDecision !== 'function') return '';
    const r = lib.preToolUseDecision(projectDir, toolName(input), toolInput(input), { sessionId, host: 'codex' });
    if (!r) return '';
    if (r.deny) return `${r.deny}\n(Codex cannot stop this edit — the git pre-commit hook will block the commit. Fix it now.)`;
    return r.context || '';
  } catch { return ''; }
}

async function guardWarnings(projectDir, brainPath, input, cwd) {
  try {
    if (typeof brainFormat.evaluateGuards !== 'function'
      || typeof brainFormat.ensureGuardSidecar !== 'function') return '';
    // ensureGuardSidecar is currency-checked and BUILDS when absent — on a
    // Codex-only machine no Claude lane ever compiles the sidecar, and before
    // this the advisory tier was silently dead there (review 2026-08-24). This
    // hook already pays the heavy import, so the occasional rebuild is fine.
    const ensured = await brainFormat.ensureGuardSidecar(brainPath);
    const guards = Array.isArray(ensured.guards) ? ensured.guards : [];
    if (!guards.length) return '';
    const files = touchedFiles(input, projectDir, cwd);
    const cmd = toolInput(input).command;
    const needWt = guards.some((g) => g?.when?.multiWorktree);
    const fired = brainFormat.evaluateGuards(guards, {
      toolName: toolName(input),
      command: typeof cmd === 'string' ? cmd : '',
      files: files.length ? files : null,
      worktreeCount: needWt && typeof brainFormat.probeWorktreeCount === 'function'
        ? brainFormat.probeWorktreeCount(projectDir) : null,
    });
    if (!fired.length) return '';
    const lines = fired.map((f) => {
      const hard = f.guard.severity === 'block' ? ' (BLOCK-severity rule — this host cannot enforce it; treat as a hard stop)' : '';
      const note = f.unverified.length ? ` (could not verify: ${f.unverified.join(', ')})` : '';
      return `- [${f.guard.area || 'brain'}]${hard} ${f.guard.message}${note}`;
    });
    return `🛡️ KLYPIX guard — a standing rule matches this action:\n${lines.join('\n')}\nApply the rule, or proceed deliberately if it does not fit this case.`;
  } catch { return ''; }
}

function queueConflictAlerts({ brainPath, sessionId, intent, conflicts, turnId, sessions = [] }) {
  const queued = [];
  const selfShortId = shortestUniqueSessionPrefix(sessions, sessionId, 12) || String(sessionId).slice(0, 12);
  for (const peer of conflicts) {
    const filesKey = peer.files.map((file) => String(file).toLowerCase()).sort().join('|');
    const annotated = annotateConflictFiles(peer);
    const result = postPresenceMessage({
      brainPath,
      from: sessionId,
      to: peer.id,
      text: `Automatic KLYPIX pre-edit overlap alert: ${selfShortId}`
        + `${intent ? ` is working on "${String(intent).slice(0, 110)}"` : ' is editing'}`
        + ` and reports the same file(s): ${annotated.files.join(', ')}${annotated.legend}. Coordinate ownership now.`,
      dedupeKey: `hook-overlap|${sessionId}|${peer.id}|${turnId || 'turn'}|${filesKey}`,
    });
    if (result.posted) queued.push(peer.id);
  }
  return queued;
}

// ── Status digest, Codex lane (1.85.0) ───────────────────────────────────────
// Parity with the Claude hook's T8 injection: a STRONG status-shaped prompt
// ("do i need to update the desk? ios? or web?", "ما تبقى") gets the engine's
// COMPUTED current-state digest INSTEAD of card retrieval — same detector
// (splitQueryTokens), same area scoping (areaHintsFromPrompt, resolved only
// once the struct is loaded), same renderer and header, and the same
// per-session sha1 dedup (a repeat gets a one-line pointer). Every engine
// export is typeof-guarded so a stale bundle degrades to the task-context
// path below, never a throw. Returns null when the prompt is not a status
// question — the caller then runs today's retrieval unchanged.
async function statusDigestContext({ brainPath, sessionId, prompt, sessions, cwd }) {
  const lib = brainFormat;
  if (!prompt || typeof lib.splitQueryTokens !== 'function' || typeof lib.areaStatusDigest !== 'function'
    || typeof lib.parseKlypix !== 'function') return null;
  let sp = null;
  try { sp = lib.splitQueryTokens(String(prompt)); } catch { return null; }
  if (!sp || !sp.strong) return null;
  let struct = null;
  try { ({ struct } = await lib.parseKlypix(fs.readFileSync(brainPath))); } catch { return null; }
  if (!struct) return null;
  let areas = null;
  if (Array.isArray(sp.areaFamilies) && sp.areaFamilies.length && typeof lib.areaHintsFromPrompt === 'function') {
    try { areas = lib.areaHintsFromPrompt(struct, String(prompt)); } catch { areas = null; }
  }
  // ONE count (1.85.0): the same per-brain summary cache the Claude lane
  // reads (keyed on brain mtime + size, written by whichever lane misses
  // first), so both hosts print identical header numbers for one brain and a
  // status prompt pays ~0 for the detector. typeof-guarded: an older engine
  // computes nothing here and the renderers derive the summary themselves.
  let summary = null;
  try {
    if (typeof lib.cachedOpenStatusSummary === 'function') summary = lib.cachedOpenStatusSummary(struct, { brainPath }).summary;
    else if (typeof lib.openStatusSummary === 'function') summary = lib.openStatusSummary(struct);
  } catch { summary = null; }
  let digest = [];
  try { digest = lib.areaStatusDigest(struct, { maxAreas: 12, areas, summary }); } catch { return null; }
  if (!Array.isArray(digest) || !digest.length) return null;
  let body = null;
  if (typeof lib.statusContextToMarkdown === 'function') {
    try {
      const md = lib.statusContextToMarkdown(struct, { budgetChars: 5200, areas, summary });
      // Drop its own H1; the hook's stronger header replaces it (Claude-lane parity).
      if (md && md.trim()) body = md.split('\n').slice(1).join('\n').trimEnd();
    } catch { body = null; }
  }
  const content = body || digest.join('\n');
  const h = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
  const me = (Array.isArray(sessions) ? sessions : []).find((session) => session.id === sessionId);
  if (me && me.statusDigestHash === h) {
    return '## 📊 Current state — unchanged since the digest shown earlier this session (`brain_ask` gives the full computed status view).';
  }
  try { upsertSession({ brainPath, id: sessionId, client: 'codex', cwd, statusDigestHash: h }); } catch { /* best-effort */ }
  return ['## 📊 Computed current state (status-shaped question detected — answer from THIS + `brain_ask`, never from memory of past sessions)', content].join('\n');
}

// ⏸️ Unfinished work other sessions left — the engine's block (agent-presence
// listUnfinishedWork + formatUnfinishedWork), read-only, never throws.
const CONTINUE_PROMPT_RE = /\b(continue|resume|pick (it |this |that )?up|carry on|keep going|where (were|did) we|what('s| is| was) (next|left|remaining|pending)|unfinished|left off|hand[- ]?off|handed (over|off)|take over|finish (what|the work|it|this))\b/i;
const HANDOFF_ASK_PROMPT_RE = /\b(hand[- ]?off|hand (it|this|the work) (over|off)|before (we|i|you) (hit|reach|approach|run out of) (the )?(limit|context|window|quota)|(context|usage|token|rate) (limit|window|quota)|out of context|switch(ing)? to (claude|another (agent|session|tool)))\b/i;
const CODEX_HANDOFF_HINT = '🤝 KLYPIX: to hand this session\'s work to the next one (any agent — Claude Code or Codex), call brain_handoff with the task, what is done, what is next, the files and how to verify; the next session on this project sees it at its first brain_sync and takes it with {action:"take"}. Your last reply and commits are recorded automatically at each turn end regardless — but a deliberate handoff says what you know. Never make the human paste a summary into the next session.';
function unfinishedWorkBlock(brainPath, sessionId) {
  try {
    return formatUnfinishedWork(listUnfinishedWork({ brainPath, selfId: sessionId }));
  } catch {
    return '';
  }
}

// 📌 Lock notes (1.102.0): the same check brain_sync and the Claude hook run —
// a "do not touch" / hands-off / WIP line in AGENTS.md checked against live
// sessions, local branches and uncommitted changes. Dynamic import so a stale
// deployment without it no-ops; never throws.
async function lockNotesBlock(projectDir, brainPath, sessionId, sessions, { budgetMs } = {}) {
  try {
    const lib = await import(new URL('./session-handoff.mjs', import.meta.url).href);
    if (typeof lib.readLockNotes !== 'function') return '';
    let stopped = [];
    try { stopped = listUnfinishedWork({ brainPath, selfId: sessionId }); } catch { /* git still answers */ }
    // Lines naming a file a stopped session worked on ride too, whatever their wording.
    const mentions = [...new Set(stopped.flatMap((r) => (Array.isArray(r.files) ? r.files : [])))].slice(0, 20);
    const probe = lib.createLockNoteProbe(projectDir, budgetMs ? { budgetMs } : {});
    const notes = lib.readLockNotes(projectDir, { mentions, probe });
    if (!notes.length) return '';
    const assessed = notes.slice(0, 6).map((n) => lib.assessLockNote(projectDir, n, { live: sessions || [], stopped, selfId: sessionId ? [sessionId] : [], probe }));
    return lib.formatLockNotes(assessed);
  } catch {
    return '';
  }
}

// Live projection (1.104.0): the same presence / unfinished / keep-off strings
// this hook emits, written into CLAUDE.local.md and the Codex global
// instructions file for the NEXT session of any host (session start and Stop).
// Dynamic import so a stale deployment no-ops; never throws.
async function projectLiveSafe({ projectDir, sessions, sessionId, lockNotes = '', unfinished = '' }) {
  try {
    const lib = await import(new URL('./live-projection.mjs', import.meta.url).href);
    if (typeof lib.projectLive !== 'function') return null;
    const peers = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.id && s.id !== sessionId)
      .map((s) => ({ id: s.id, client: s.client, intent: s.intent, files: s.files, observedFiles: s.observedFiles }));
    return lib.projectLive({ projectDir, peers, lockNotesText: String(lockNotes || '').trim(), unfinishedText: String(unfinished || '').trim() });
  } catch {
    return null;
  }
}

// Unfinished-work patch for one Codex lifecycle event (session handoff). A
// human prompt records what was asked; a Stop records the reply tail only if
// the host put it in the payload. Null when the event carries nothing.
function codexWorkPatch({ event, humanTurn, prompt, input, rawPrompt }) {
  const patch = {};
  // 1.109: the ask is recorded at submit, with its line breaks (a step list
  // stays a list) and bounded/redacted by the engine — was the first 240
  // characters, which cut a task list inside step 1 (continuity test 2026-10-30).
  if (humanTurn && prompt) patch.addAsk = { text: deriveIntentFromPrompt(rawPrompt, { keepLines: true }) || prompt, at: Date.now() };
  if (event === 'Stop') {
    patch.replyEndedAt = Date.now();
    const words = input.last_assistant_message ?? input.lastAssistantMessage ?? input.assistant_message ?? '';
    const text = typeof words === 'string' ? words.trim() : '';
    if (text) { patch.lastWords = text.length > 700 ? '…' + text.slice(-699) : text; patch.lastWordsAt = Date.now(); }
  }
  // 1.99.1 (universal): this session's OWN commits, from the output git
  // printed for a commit it ran ("[branch abc1234] subject") — never a branch
  // range, which would credit a peer's commits in a shared checkout.
  if (event === 'PostToolUse') {
    const commits = commitsFromToolResult(input);
    if (commits.length) patch.addCommits = commits;
  }
  return Object.keys(patch).length ? patch : null;
}
function toolOutputText(input) {
  const r = input.tool_response ?? input.toolResponse ?? input.tool_output ?? input.toolOutput;
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return '';
  const parts = [r.output, r.stdout, r.aggregated_output, r.formatted_output, r.text, r.content];
  return parts.map((p) => (typeof p === 'string' ? p : Array.isArray(p) ? p.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n') : '')).filter(Boolean).join('\n');
}
export function commitsFromToolResult(input) {
  const ti = input.tool_input || input.toolInput || {};
  const cmd = typeof ti === 'string' ? ti : [ti.command, ti.cmd, Array.isArray(ti.command) ? ti.command.join(' ') : ''].filter((v) => typeof v === 'string').join(' ');
  if (!/\bgit\b[^\n]*\bcommit\b/.test(cmd)) return [];
  const out = toolOutputText(input);
  const commits = [];
  for (const m of out.matchAll(/^\[[^\]\n]{1,80}?\s([0-9a-f]{7,40})\]\s+(.+)$/gm)) commits.push({ sha: m[1].slice(0, 12), subject: m[2].trim().slice(0, 120) });
  return commits.slice(0, 6);
}

async function compactTaskContext(projectDir, prompt, files) {
  if (!prompt) return '';
  try {
    const result = await opBrainTaskContext({
      vault: projectDir,
      intent: String(prompt).slice(0, 2000),
      files,
      k: 4,
      budgetChars: 1800,
    });
    return result?.context
      ? result.blocks?.filter((block) => block.kind === 'text').map((block) => block.text).filter(Boolean).join('\n\n') || ''
      : '';
  } catch {
    return '';
  }
}

async function main() {
  const input = readInput();
  const event = String(input.hook_event_name || input.hookEventName || '');
  const sessionId = String(input.session_id || input.sessionId || '');
  const cwd = path.resolve(input.cwd || process.cwd());
  const brainPath = findProjectBrain(cwd);
  if (event && sessionId) recordCodexHookExecution({ event, sessionId });
  if (!event || !sessionId || !brainPath) return;

  if (event === 'SessionEnd') {
    // SessionEnd is the logical conversation boundary, not merely a lifecycle
    // transport disconnect. Remove every channel and tombstone the identity so
    // a late MCP heartbeat/hibernation write cannot resurrect a closed thread.
    endSession({ brainPath, id: sessionId });
    return;
  }

  const projectDir = path.dirname(brainPath);
  const rawPrompt = input.prompt || input.user_prompt || input.userPrompt;
  // Machine-turn guard: a harness-injected "user" prompt (task notification,
  // system reminder) must not become the session's declared intent — derive the
  // human text, and on a machine turn keep the previous intent (undefined).
  const prompt = rawPrompt === undefined ? undefined : (deriveIntentFromPrompt(rawPrompt) ?? undefined);
  // A HUMAN prompt is a task boundary: reset the declared file scope. A machine
  // turn is mid-task plumbing — it must keep the files exactly as it keeps the
  // intent (review-caught: the guard preserved intent but wiped files[]).
  const humanTurn = event === 'UserPromptSubmit' && prompt !== undefined;
  // Tool-touched paths are OBSERVATIONS, not declarations (automatic scope
  // adoption, 1.70.0). They used to ride the `files` param, which fabricated a
  // declared scope out of every edit; upsertSession's observed lane keeps them
  // visible to every reader (they still join files[] for pre-1.70 renderers)
  // while marking them observed, and skips any path the session's DECLARED
  // scope (brain_sync) already covers.
  const observed = event === 'PreToolUse' || event === 'PostToolUse'
    ? touchedFiles(input, projectDir, cwd)
    : undefined;
  // Whose is this? (1.104.0): remember the bytes Codex's edits left, so a Claude
  // session's sweeping git command can name this session as the owner.
  if (event === 'PostToolUse' && Array.isArray(observed) && observed.length) {
    try {
      const whose = await import(new URL('./whose.mjs', import.meta.url).href);
      await whose.recordEdits({ brainPath, sid: sessionId, client: 'codex', cwd: projectDir, files: observed });
    } catch { /* attribution is best-effort */ }
  }
  const files = humanTurn ? [] : undefined;
  const workPatch = codexWorkPatch({ event, humanTurn, prompt, input, rawPrompt }) || {};
  // Where it works (1.103.0): the directory a tool call ran in (Codex's exec
  // carries `workdir`; a command may `cd` or `git -C` elsewhere). Dynamic +
  // guarded so a stale bundle without the helper still records the rest.
  let whereLib = null;
  if (event === 'PostToolUse' || event === 'Stop') {
    try { whereLib = await import(new URL('./session-handoff.mjs', import.meta.url).href); } catch { whereLib = null; }
  }
  if (event === 'PostToolUse' && typeof whereLib?.workdirsFromToolInput === 'function') {
    try {
      const dirs = whereLib.workdirsFromToolInput(toolInput(input));
      if (dirs.length) workPatch.addWorkdirs = dirs;
    } catch { /* best-effort */ }
  }
  const sessions = upsertSession({
    brainPath,
    id: sessionId,
    client: 'codex',
    surface: input.surface || 'local',
    model: input.model || null,
    // Codex sends the model with every hook event, so this report is current
    // for the event; the source lets MCP-written stamps use it (1.109.0).
    ...(input.model ? { modelSource: 'codex-hook' } : {}),
    permissionMode: input.permission_mode || input.permissionMode || null,
    branch: gitBranch(cwd),
    intent: prompt === undefined ? undefined : prompt,
    files,
    replaceFiles: humanTurn,
    observedFiles: observed,
    event,
    channel: 'lifecycle',
    ...(HOST_PID.pid ? { hostPid: HOST_PID.pid, hostPidSource: HOST_PID.source } : {}),
    logicalSessionId: sessionId,
    identitySource: 'codex-lifecycle',
    cwd,
    // Unfinished-work state (session handoff, 1.99.0), host-neutral: the last
    // human prompt on a human turn, and at Stop the reply tail WHEN the host
    // hands it over (Codex's Stop payload may carry `last_assistant_message`;
    // this adapter never reads Codex's transcript). Absent = keep the known.
    ...(Object.keys(workPatch).length ? { work: workPatch } : {}),
  });
  // At Stop, a bounded git status of every checkout this session worked in
  // (cwd first, then the workdirs its tool calls recorded) — the fix left
  // uncommitted in a side checkout is what the 2026-10-15 field case lost.
  // A second touch, so it sees the workdirs the first one merged.
  if (event === 'Stop' && typeof whereLib?.snapshotCheckouts === 'function') {
    try {
      const me = sessions.find((session) => session.id === sessionId);
      const checkouts = whereLib.snapshotCheckouts({
        dirs: [cwd, ...(Array.isArray(me?.work?.workdirs) ? me.work.workdirs : [])],
        projectDir,
        sessionFiles: [...new Set([...(me?.files || []), ...(me?.observedFiles || [])])],
      });
      if (checkouts.length) {
        upsertSession({
          brainPath, id: sessionId, client: 'codex', event, channel: 'lifecycle', cwd,
          ...(HOST_PID.pid ? { hostPid: HOST_PID.pid, hostPidSource: HOST_PID.source } : {}),
          logicalSessionId: sessionId, identitySource: 'codex-lifecycle', work: { checkouts },
        });
      }
    } catch { /* best-effort */ }
  }

  const ignored = event === 'PostToolUse' ? ownBrainMessageText(input) : [];
  // Stop can show a UI warning but cannot add model context. Never advance a
  // durable delivery receipt on that event; the next context-capable action
  // still replays the note. Context-capable events advance one v2 delivery step.
  const messages = MODEL_CONTEXT_EVENTS.has(event)
    ? receiveMessages({ brainPath, sessionId, ignoreTexts: ignored, actionId: hookActionId(input, event) })
    : peekMessages({ brainPath, sessionId, ignoreTexts: ignored });
  const conflicts = (event === 'PreToolUse' || event === 'PostToolUse')
    ? findPresenceConflicts(sessions, sessionId)
    : [];
  if (conflicts.length) {
    const me = sessions.find((session) => session.id === sessionId);
    queueConflictAlerts({
      brainPath,
      sessionId,
      intent: me?.intent || '',
      conflicts,
      turnId: input.turn_id || input.turnId || '',
      sessions,
    });
  }
  if (event === 'SessionStart') {
    // Commit-capture completeness (2026-08-07): wire the agent-neutral git
    // post-commit/post-merge hook when the slots are absent or already ours —
    // never a foreign hook. Dynamic + guarded so a stale bundle no-ops.
    const gitHookNotice = await (async () => {
      try {
        const ghl = await import(new URL('./git-capture-install.mjs', import.meta.url).href);
        return typeof ghl.ensureGitCaptureHook === 'function' ? (ghl.ensureGitCaptureHook(projectDir).notice || '') : '';
      } catch { return ''; }
    })();
    const lockNotes = await lockNotesBlock(projectDir, brainPath, sessionId, sessions);
    const unfinished = unfinishedWorkBlock(brainPath, sessionId);
    await projectLiveSafe({ projectDir, sessions, sessionId, lockNotes, unfinished });
    emitSystemMessage([
      formatPresenceMessage(sessions, sessionId, { includeSolo: true }),
      lockNotes,
      // Class-C ship observation — the engine's, not a Claude-hook-local copy.
      // Codex-driven projects had NO out-of-session ship detection at all, which
      // is exactly where the incident class bites hardest (2026-07-29 review).
      // The queue drains at the next brain write from any host.
      observeShipDrift(projectDir),
      gitHookNotice.trim(),
      stampReceivedMessages(messages, Date.now(), undefined, sessionId),
      // ⏸️ Unfinished work other sessions left (session handoff, 1.99.0): the
      // same engine block brain_sync prints, so a Codex session asked to
      // "continue" what a Claude session stopped in starts from its record.
      unfinished,
    ], event);
    return;
  }
  if (event === 'Stop') {
    // The lane now carries this turn's files and reply tail: refresh the live
    // projection for the next session, with a short git budget (a Stop must not wait).
    const lockNotes = await lockNotesBlock(projectDir, brainPath, sessionId, sessions, { budgetMs: 1000 });
    await projectLiveSafe({ projectDir, sessions, sessionId, lockNotes, unfinished: unfinishedWorkBlock(brainPath, sessionId) });
  }
  if (event === 'UserPromptSubmit') {
    const me = sessions.find((session) => session.id === sessionId);
    // A STRONG status question is answered from computed state and REPLACES
    // card retrieval (never additive) — the Claude hook's `freshHits = []`.
    const statusMd = await statusDigestContext({ brainPath, sessionId, prompt, sessions, cwd });
    const context = statusMd ?? await compactTaskContext(projectDir, prompt,
      [...new Set([...(me?.files || []), ...(me?.observedFiles || [])])]);
    emitSystemMessage([
      context,
      formatPresenceMessage(sessions, sessionId),
      stampReceivedMessages(messages, Date.now(), undefined, sessionId),
      // Only on a continue-shaped human prompt — SessionStart printed it once.
      ...(prompt && CONTINUE_PROMPT_RE.test(prompt) ? [unfinishedWorkBlock(brainPath, sessionId)] : []),
      // The human asked for a handoff or named the limit (Codex has one too).
      ...(prompt && HANDOFF_ASK_PROMPT_RE.test(prompt) ? [CODEX_HANDOFF_HINT] : []),
    ], event);
    return;
  }
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    emitSystemMessage([
      formatConflictWarning(conflicts, event, sessions),
      // Guard cards, advisory tier (2026-08-24): this host cannot deny a tool
      // call — Codex hook output is `continue: true` by design — so a matching
      // guard renders as a warning; a block-severity guard says it should be
      // treated as a hard stop, without claiming a mechanism this lane lacks.
      ...(event === 'PreToolUse' ? [await guardWarnings(projectDir, brainPath, input, cwd)] : []),
      ...(event === 'PreToolUse' ? [await ruleWarnings(projectDir, input, sessionId)] : []),
      stampReceivedMessages(messages, Date.now(), undefined, sessionId),
    ], event);
    return;
  }
  if (messages.length) emitSystemMessage([stampReceivedMessages(messages, Date.now(), undefined, sessionId)], event);
}

// Run as the hook by default. The ONLY skip is the explicit opt-out flag a
// hermetic test sets before importing this module for its pure exports —
// production never sets it (mirrors global-brain-hook.mjs), so runtime
// behavior is byte-identical.
if (!process.env.KLYPIX_BRAIN_NO_MAIN) {
  main().catch(() => {}).finally(() => process.exit(0));
}
