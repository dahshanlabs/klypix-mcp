// Live projection (1.104.0) — the machine-local half of "project the brain
// into the file the agent obeys".
//
// WHY. The coordination bench (rounds 2 and 3, 2026-10-12/13) showed that an
// agent trusts the instruction file it was launched with more than anything a
// tool or hook tells it: a two-day-old "keep off this file" line in AGENTS.md
// beat KLYPIX's lane in 14 of 15 runs, and the hosts read different surfaces
// (Claude the JSON, Codex the text, both the files). The brain-derived half —
// standing rules, corrections, handoff cards — already lives in the committed
// `<!-- klypix-brain-brief -->` block of AGENTS.md (refreshAgentsBrief). The
// LIVE half — which sessions are on this PC right now and what files they
// hold, what work a stopped session left, and the evidence beside every
// keep-off note — reached the agent only through hook output and brain_sync,
// never through a file. This module writes that half into the two files the
// hosts load by themselves and never commit:
//
//   • `CLAUDE.local.md` at the project root — Claude Code loads it beside
//     CLAUDE.md ("personal project-specific preferences; add to .gitignore");
//     its HTML comments are stripped before injection, so the markers cost
//     nothing. KLYPIX keeps it out of git through `.git/info/exclude` (local
//     to this clone, never a committed file).
//   • the Codex global instructions file — `~/.codex/AGENTS.override.md` when
//     the person has one, else `~/.codex/AGENTS.md`, the file klypix-mcp
//     already manages. Codex loads the global file first, then one file per
//     directory from the project root down, so a project-level override would
//     HIDE the project's AGENTS.md: never written. One section per project,
//     keyed by the project's path, pruned when stale.
//
// CONTRACT. Snapshot semantics, said in the text: written at session start and
// stop, not live, not shared, brain_sync is the live source. Bounded (budget
// below), deterministic for one input, rewritten only when the non-volatile
// content changed (the time stamp alone never causes a write). Never throws:
// every writer returns an action word and swallows its own errors, because it
// runs inside hooks that must exit 0.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LIVE_PROJECTION_VERSION = 1;
export const LIVE_BUDGET_CHARS = 2400;
export const LIVE_STALE_MS = 24 * 60 * 60 * 1000;
export const LIVE_PROJECT_CAP = 8;
export const CLAUDE_LOCAL_FILE = 'CLAUDE.local.md';
export const LIVE_END = '<!-- klypix-live:end -->';

const flat = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const minuteIso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';
const CLIENT_WORDS = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', cline: 'Cline', windsurf: 'Windsurf', copilot: 'Copilot', gemini: 'Gemini CLI', aider: 'Aider', antigravity: 'Antigravity' };
const clientWord = (c) => CLIENT_WORDS[String(c || '').toLowerCase()] || (c ? String(c) : 'agent');

/** Stable key for a project path: same spelling rules as the presence lane. */
export function liveKey(projectDir) {
  const norm = path.resolve(String(projectDir || '.')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

export function liveStart(key, { at = Date.now(), projectDir = '' } = {}) {
  const where = projectDir ? ` project=${JSON.stringify(path.resolve(projectDir).replace(/\\/g, '/'))}` : '';
  return `<!-- klypix-live:start key=${key} at=${new Date(at).toISOString()}${where} (machine-local; written by klypix-mcp at session start and stop; do not edit; never commit) -->`;
}

// One regex per key; the marker's attributes are free text up to `-->`.
const blockRe = (key) => new RegExp(`<!-- klypix-live:start key=${key}[^\\n]*-->[\\s\\S]*?<!-- klypix-live:end -->\\r?\\n?`);
const ANY_BLOCK_RE = /<!-- klypix-live:start key=([0-9a-f]{16}) at=([^ \n]+)[^\n]*-->[\s\S]*?<!-- klypix-live:end -->\r?\n?/g;

/** Everything in a block that may change without the content changing. */
function stable(text) {
  return String(text || '')
    .replace(/<!-- klypix-live:start key=[0-9a-f]{16} at=[^ \n]+/g, '<!-- klypix-live:start')
    .replace(/· as of [0-9T:-]+Z/g, '· as of')
    .replace(/\r\n/g, '\n').trim();
}

function peerLine(p) {
  const files = [...new Set([...(Array.isArray(p.files) ? p.files : []), ...(Array.isArray(p.observedFiles) ? p.observedFiles : [])])].filter(Boolean);
  const bits = [`${clientWord(p.client)} ${String(p.id || '').slice(0, 8)}`];
  if (p.intent) bits.push(`“${flat(p.intent).slice(0, 70)}”`);
  if (files.length) bits.push(`files: ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` +${files.length - 4}` : ''}`);
  return bits.join(' · ');
}

function clip(text, max) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 60)).replace(/\s+\S*$/, '') + '\n  … (cut for size — brain_sync has the rest)';
}

/**
 * The block body. Pure: same inputs, same text (the "as of" minute aside).
 * `peers` are presence-lane rows OTHER than the writing session; `unfinishedText`
 * and `lockNotesText` are the engine's own blocks (formatUnfinishedWork,
 * formatLockNotes), passed through so this file never re-derives a verdict.
 */
export function renderLiveProjection({ projectDir, now = Date.now(), version = '', peers = [], unfinishedText = '', lockNotesText = '', budgetChars = LIVE_BUDGET_CHARS } = {}) {
  const name = path.basename(path.resolve(projectDir || '.')) || 'project';
  const budget = Math.max(800, Math.min(8000, Number(budgetChars) || LIVE_BUDGET_CHARS));
  const head = [
    `## KLYPIX live — ${name} on this PC · as of ${minuteIso(now)}`,
    `Snapshot written by klypix-mcp${version ? ` ${version}` : ''} at session start and stop: this PC only, not committed, not shared. The decisions and corrections are in the AGENTS.md brain block; \`brain_sync\` for this project is the live source and must be called before acting on anything below.`,
  ];
  const rows = (Array.isArray(peers) ? peers : []).filter((p) => p && p.id);
  const peersText = rows.length
    ? `👥 ${rows.length} other live session(s) on this PC right now (a snapshot — re-query brain_sync before reporting them): ${rows.slice(0, 6).map(peerLine).join(' | ')}${rows.length > 6 ? ` | …and ${rows.length - 6} more` : ''}. A file two sessions both hold is a warning, not a lock: coordinate with brain_message.`
    : '👥 No other live session on this PC at the time of writing.';
  const lock = String(lockNotesText || '').trim();
  const unfinished = String(unfinishedText || '').trim();
  // Priority when the budget bites: the keep-off evidence first (it is what the
  // bench lost on), then who is live, then the unfinished work.
  const fixed = head.join('\n').length + 2;
  let left = budget - fixed;
  const lockPart = lock ? clip(lock, Math.max(600, Math.floor(left * 0.6))) : '';
  left -= lockPart.length + 2;
  const peersPart = clip(peersText, Math.max(200, Math.min(700, left)));
  left -= peersPart.length + 2;
  const unfinishedPart = unfinished ? clip(unfinished, Math.max(240, left)) : '⏸️ No unfinished work recorded from a stopped session.';
  return [...head, '', peersPart, '', lockPart || '📌 No keep-off note in this project\'s instruction files named a file with a verdict to report.', '', unfinishedPart].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function wrapLiveBlock(key, body, opts = {}) {
  return `${liveStart(key, opts)}\n${body}\n${LIVE_END}`;
}

/** Replace the block with this key in `raw`, or append it. */
export function upsertLiveBlock(raw, key, block) {
  const text = String(raw || '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const b = block.replace(/\r?\n/g, eol);
  const re = blockRe(key);
  if (re.test(text)) return text.replace(re, b + eol);
  const base = text.trim() ? text.replace(/\s*$/, '') + eol + eol : '';
  return base + b + eol;
}

export function stripLiveBlocks(raw, key = null) {
  const text = String(raw || '');
  const next = key ? text.replace(blockRe(key), '') : text.replace(ANY_BLOCK_RE, '');
  return next.replace(/^\s+/, '').replace(/\s+$/, (m) => (m.includes('\n') ? '\n' : ''));
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.klypix-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function git(cwd, args, timeout = 1500) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
}

/**
 * Keep CLAUDE.local.md out of this clone's git status without touching a
 * committed file: `.git/info/exclude` (the worktree-aware git-path form). A
 * project that already ignores it, or is not a repository, is left alone.
 */
export function ensureLocalExcluded(projectDir, { rel = CLAUDE_LOCAL_FILE } = {}) {
  const root = path.resolve(projectDir);
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: root, timeout: 1500, stdio: 'ignore', windowsHide: true });
    return 'already-ignored';
  } catch (e) {
    if (e && e.status !== 1) return 'not-a-repo';
  }
  try {
    const excludeRel = git(root, ['rev-parse', '--git-path', 'info/exclude']);
    const exclude = path.isAbsolute(excludeRel) ? excludeRel : path.join(root, excludeRel);
    let raw = '';
    try { raw = fs.readFileSync(exclude, 'utf8'); } catch { /* fresh */ }
    if (raw.split(/\r?\n/).some((l) => l.trim() === rel || l.trim() === `/${rel}`)) return 'already-excluded';
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${raw && !raw.endsWith('\n') ? '\n' : ''}# KLYPIX live projection (machine-local; written by klypix-mcp)\n${rel}\n`, 'utf8');
    return 'excluded';
  } catch {
    return 'exclude-failed';
  }
}

export function writeClaudeLocal(projectDir, body, { now = Date.now(), file = null } = {}) {
  const root = path.resolve(projectDir);
  const target = file || path.join(root, CLAUDE_LOCAL_FILE);
  try {
    const key = liveKey(root);
    let raw = '';
    try { raw = fs.readFileSync(target, 'utf8'); } catch { /* fresh */ }
    const block = wrapLiveBlock(key, body, { at: now, projectDir: root });
    const next = upsertLiveBlock(raw, key, block);
    if (stable(next) === stable(raw)) return { path: target, action: 'unchanged', excluded: ensureLocalExcluded(root) };
    atomicWrite(target, next);
    return { path: target, action: raw ? 'updated' : 'created', excluded: ensureLocalExcluded(root) };
  } catch (e) {
    return { path: target, action: 'failed', error: e?.message || String(e) };
  }
}

/** The one global instruction file Codex actually loads. */
export function codexGlobalInstructionFile(home = os.homedir()) {
  const dir = path.join(process.env.CODEX_HOME || path.join(home, '.codex'));
  const override = path.join(dir, 'AGENTS.override.md');
  try { if (fs.statSync(override).isFile()) return override; } catch { /* no override */ }
  return path.join(dir, 'AGENTS.md');
}

/** Drop other projects' sections that are stale or beyond the cap (oldest first). */
export function pruneLiveSections(raw, { keep = null, now = Date.now(), staleMs = LIVE_STALE_MS, cap = LIVE_PROJECT_CAP } = {}) {
  const text = String(raw || '');
  const found = [];
  for (const m of text.matchAll(ANY_BLOCK_RE)) found.push({ key: m[1], at: Date.parse(m[2]) || 0, text: m[0] });
  const others = found.filter((f) => f.key !== keep).sort((a, b) => a.at - b.at);
  const drop = new Set();
  for (const f of others) if (now - f.at > staleMs) drop.add(f.text);
  const fresh = others.filter((f) => !drop.has(f.text));
  const room = Math.max(0, cap - (keep ? 1 : 0));
  for (const f of fresh.slice(0, Math.max(0, fresh.length - room))) drop.add(f.text);
  let next = text;
  for (const t of drop) next = next.replace(t, '');
  return { text: next, dropped: drop.size };
}

export function writeCodexGlobal(projectDir, body, { now = Date.now(), home = os.homedir(), file = null } = {}) {
  const root = path.resolve(projectDir);
  const target = file || codexGlobalInstructionFile(home);
  try {
    const key = liveKey(root);
    let raw = '';
    try { raw = fs.readFileSync(target, 'utf8'); } catch { /* fresh */ }
    const pruned = pruneLiveSections(raw, { keep: key, now });
    const block = wrapLiveBlock(key, body, { at: now, projectDir: root });
    const next = upsertLiveBlock(pruned.text, key, block);
    if (stable(next) === stable(raw)) return { path: target, action: 'unchanged', dropped: pruned.dropped };
    atomicWrite(target, next);
    return { path: target, action: raw ? 'updated' : 'created', dropped: pruned.dropped };
  } catch (e) {
    return { path: target, action: 'failed', error: e?.message || String(e) };
  }
}

/** Both files, never throws. The caller supplies what the hook already computed. */
export function projectLive({ projectDir, now = Date.now(), home = os.homedir(), version = '', peers = [], unfinishedText = '', lockNotesText = '', claudeFile = null, codexFile = null } = {}) {
  const body = renderLiveProjection({ projectDir, now, version, peers, unfinishedText, lockNotesText });
  return {
    claude: writeClaudeLocal(projectDir, body, { now, file: claudeFile }),
    codex: writeCodexGlobal(projectDir, body, { now, home, file: codexFile }),
    bytes: Buffer.byteLength(body),
  };
}

/** Uninstall / unlink: remove this project's block from both files; delete CLAUDE.local.md only if nothing else is in it. */
export function removeLiveProjection(projectDir, { home = os.homedir(), claudeFile = null } = {}) {
  const root = path.resolve(projectDir);
  const key = liveKey(root);
  const out = { claude: 'unchanged', codex: 'unchanged' };
  const local = claudeFile || path.join(root, CLAUDE_LOCAL_FILE);
  try {
    const raw = fs.readFileSync(local, 'utf8');
    if (blockRe(key).test(raw)) {
      const rest = stripLiveBlocks(raw, key);
      if (rest.trim()) { atomicWrite(local, rest); out.claude = 'block-removed'; } else { fs.unlinkSync(local); out.claude = 'file-removed'; }
    }
  } catch { /* absent */ }
  const dir = path.join(process.env.CODEX_HOME || path.join(home, '.codex'));
  for (const f of [path.join(dir, 'AGENTS.override.md'), path.join(dir, 'AGENTS.md')]) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      if (!blockRe(key).test(raw)) continue;
      atomicWrite(f, stripLiveBlocks(raw, key));
      out.codex = 'section-removed';
    } catch { /* absent */ }
  }
  return out;
}

/** Does `raw` carry this project's live block? (uninstall planning, read-only) */
export function hasLiveBlock(raw, projectDir) {
  return blockRe(liveKey(projectDir)).test(String(raw || ''));
}

/** Every live section in the Codex global file (for doctor and uninstall). */
export function listLiveSections(raw) {
  const text = String(raw || '');
  return [...text.matchAll(ANY_BLOCK_RE)].map((m) => {
    const project = /project="([^"]*)"/.exec(m[0]);
    return { key: m[1], at: Date.parse(m[2]) || 0, project: project ? project[1] : '' };
  });
}
