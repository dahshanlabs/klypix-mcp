// "Whose is this?" (1.104.0) — the decision a risky git command gets when other
// sessions' uncommitted work is in the checkout.
//
// Real reports this answers (verified 2026-10-16): anthropics/claude-code#88862
// ("a warning at `git add`/`git commit` time when another session has
// uncommitted edits to files in your index … would have prevented all three
// incidents"), openai/codex#6022 (forbidden git commands run despite AGENTS.md),
// claude-code#50909 / #95355 (uncommitted work wiped by another session).
//
// Pieces: whose-classify (what the command does), whose-ledger (who left the
// current bytes of each file), whose-rescue (a copy of the bytes before a
// destructive command). This module joins them for the hooks:
//   · recordEdits()  — PostToolUse: remember the bytes an edit left.
//   · decide()       — PreToolUse: deny / ask / context / nothing.
// KLYPIX warns, asks or blocks ONE command and names whose work is at stake. It
// never edits files on its own and never claims to prevent data loss. When
// anything is uncertain it gives context only — it never denies on a guess.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const STATUS_TIMEOUT_MS = 1500;
const MAX_DIRTY = 2000;
const HUMAN_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit_file', 'write_file']);

/** Walk up from dir to the project's brain.klypix / brain.any (the hook cwd may be a subfolder). */
export function findProjectBrainLocal(dir = process.cwd()) {
  let cur = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    for (const name of ['brain.klypix', 'brain.any']) {
      try { if (fs.statSync(path.join(cur, name)).isFile()) return path.join(cur, name); } catch { /* keep walking */ }
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

const brainDir = () => process.env.KLYPIX_BRAIN_DIR || path.join(os.homedir(), '.claude', 'project-brain');

/** off | shadow | enforce — env KLYPIX_WHOSE wins, then whose.json, default enforce. */
export function whoseMode() {
  const env = String(process.env.KLYPIX_WHOSE || '').trim().toLowerCase();
  if (['off', 'shadow', 'enforce'].includes(env)) return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(brainDir(), 'whose.json'), 'utf8'));
    const m = String(cfg?.mode || '').toLowerCase();
    if (['off', 'shadow', 'enforce'].includes(m)) return m;
  } catch { /* absent → default */ }
  return 'enforce';
}

const clientWord = (c) => (c === 'claude-code' ? 'Claude Code' : c === 'codex' ? 'Codex' : c ? String(c) : 'another session');
const agoWord = (ms) => {
  const m = Math.round(Math.max(0, ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

/** PostToolUse: record the bytes each edited file now holds. Never throws. */
export async function recordEdits({ brainPath, sid, client, cwd, files, home } = {}) {
  try {
    if (!brainPath || !sid || !Array.isArray(files) || !files.length) return 0;
    const ledger = await import(new URL('./whose-ledger.mjs', import.meta.url).href);
    const base = cwd || path.dirname(brainPath);
    const root = ledger.findRepoRoot(base) || path.dirname(brainPath);
    let n = 0;
    for (const f of files.slice(0, 50)) {
      const abs = path.isAbsolute(f) ? f : path.join(base, f);
      if (ledger.recordEdit({ brainPath, home, sid, client, repoRoot: root, absPath: abs })) n++;
    }
    try { ledger.rotateLedgerIfLarge({ brainPath, home }); } catch { /* best effort */ }
    return n;
  } catch { return 0; }
}

/** Claude PostToolUse payload → recordEdits. */
export async function recordFromClaudeHook(input, { findProjectBrain } = {}) {
  try {
    if (!input || !EDIT_TOOLS.has(input.tool_name) || !input.session_id) return 0;
    const ti = input.tool_input || {};
    const fp = ti.file_path || ti.notebook_path || ti.path;
    if (typeof fp !== 'string' || !fp) return 0;
    const cwd = input.cwd || process.cwd();
    const brainPath = (findProjectBrain || findProjectBrainLocal)(cwd);
    if (!brainPath) return 0;
    return await recordEdits({ brainPath, sid: input.session_id, client: 'claude-code', cwd, files: [fp] });
  } catch { return 0; }
}

// `git status --porcelain=v1 -z --untracked-files=all` → [{ path, x, y }]
function gitStatus(root) {
  const out = execFileSync('git', ['-C', root, '--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'utf8', timeout: STATUS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const parts = out.split('\0');
  const list = [];
  for (let i = 0; i < parts.length && list.length < MAX_DIRTY; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    const x = e[0]; const y = e[1]; const p = e.slice(3);
    list.push({ path: p, x, y });
    if (x === 'R' || x === 'C') i++;           // the next entry is the old name
  }
  return list;
}

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

// Which dirty entries a step would change.
function affectedBy(step, dirty, stagedBefore, cwdRel) {
  const tracked = (d) => d.x !== '?';
  const staged = (d) => d.x !== ' ' && d.x !== '?';
  const under = (d, p) => {
    const want = norm(cwdRel ? path.posix.join(cwdRel, norm(p)) : p);
    if (!want || want === '.') return true;
    return d.path === want || d.path.startsWith(want + '/');
  };
  const byPaths = (list, paths) => list.filter((d) => (paths || []).some((p) => under(d, p)));
  let base = dirty;
  if (step.scope === 'tracked') base = dirty.filter(tracked);
  else if (step.scope === 'untracked') base = dirty.filter((d) => !tracked(d));
  else if (step.scope === 'index') base = dirty.filter(staged);
  if (step.paths && step.paths.length) base = byPaths(step.scope === 'index' ? dirty : base, step.paths);
  if (step.sub === 'commit') base = [...new Set([...base, ...byPaths(dirty, stagedBefore || [])])];
  if (!['SWEEP', 'EXPLICIT', 'DISCARD', 'PARK', 'MOVE'].includes(step.tier) && step.sub !== 'commit') return [];
  return base;
}

/**
 * PreToolUse decision for a Bash / PowerShell tool call.
 * → null (nothing to say) | { decision: 'deny'|'ask'|'context', text, shadow?, log }
 */
export async function decide(input, { findProjectBrain, listActiveSessions, home, now = Date.now() } = {}) {
  const mode = whoseMode();
  if (mode === 'off') return null;
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !command) return null;
  const C = await import(new URL('./whose-classify.mjs', import.meta.url).href);
  if (!C.mentionsGit(command)) return null;                           // fast path: no git, no cost
  const cwd = input.cwd || process.cwd();
  const brainPath = (findProjectBrain || findProjectBrainLocal)(cwd);
  if (!brainPath) return null;
  const cls = C.classifyCommand(command, { dialect: tool === 'PowerShell' ? 'powershell' : 'posix' });
  const risky = cls.steps.filter((s) => s.git && s.tier !== 'SAFE');
  if (!risky.length) return null;
  const L = await import(new URL('./whose-ledger.mjs', import.meta.url).href);
  const ledger = L.readLedger({ brainPath, home, now });
  const self = String(input.session_id || '').toLowerCase();
  let others = false;
  for (const recs of ledger.values()) if (recs.some((r) => r.sid && String(r.sid).toLowerCase() !== self)) { others = true; break; }
  if (!others) return null;                                           // fast path: nobody else left edits

  const root = L.findRepoRoot(cwd);
  if (!root) return null;
  let dirty;
  try { dirty = gitStatus(root); } catch { return { decision: 'context', text: 'KLYPIX could not read `git status` in time, so it could not check whose uncommitted work this command touches.', log: { why: 'status-failed' } }; }
  if (!dirty.length) return null;

  // Who else is the same window (after /clear) or taken over by me.
  const selfIds = [input.session_id].filter(Boolean);
  const sameHostIds = [];
  const adoptedIds = [];
  // Live owners only block commits (round-4 bench, 2026-10-20): a session asked
  // to CONTINUE a stopped session's work must be able to finish and commit it;
  // KLYPIX blocking that turned a 8/11 handoff into 3/10. A stopped session's
  // leftovers still get ask + rescue before anything DISCARDS them.
  const liveKeys = new Set();
  let liveKnown = false;
  try {
    const list = listActiveSessions || (await import(new URL('./agent-presence.mjs', import.meta.url).href)).listActiveSessions;
    const live = list({ brainPath, home, now });
    liveKnown = true;
    for (const r of live) for (const k of [r.id, r.logicalSessionId, ...(Array.isArray(r.aliases) ? r.aliases : [])]) if (k) liveKeys.add(String(k).toLowerCase());
    const mine = live.find((r) => String(r.id || '').toLowerCase() === self);
    if (mine && mine.hostPid && mine.hostPidSource === 'env') {
      for (const r of live) if (r !== mine && r.hostPid === mine.hostPid && r.hostPidSource === 'env' && r.machine === mine.machine) sameHostIds.push(r.id);
    }
    for (const r of live) if (r?.work?.takenBy?.id && String(r.work.takenBy.id).toLowerCase() === self) adoptedIds.push(r.id);
  } catch { /* identity extras are best-effort */ }

  const dirtyEntries = dirty.map((d) => {
    let hash;
    if (d.y === 'D' || (d.x === 'D' && d.y === ' ')) hash = null;
    else {
      try {
        const abs = path.join(root, d.path);
        const st = fs.statSync(abs);
        hash = st.isFile() && st.size <= (L.LEDGER_HASH_MAX_BYTES || 8 << 20) ? L.hashBytes(fs.readFileSync(abs)) : undefined;
      } catch { hash = undefined; }
    }
    return { key: L.fileKey(root, d.path), hash, d };
  }).filter((e) => e.key);
  const own = L.ownership({ ledger, dirty: dirtyEntries.map(({ key, hash }) => ({ key, hash })), selfIds, adoptedIds, sameHostIds });
  const info = new Map(dirtyEntries.map((e) => [e.d.path, { ...(own.get(e.key) || { cls: 'UNATTRIBUTED', owners: [] }), entry: e.d }]));

  // Opportunistic clean records: ledger keys no longer dirty are committed or discarded.
  try {
    const dirtyKeys = new Set(dirtyEntries.map((e) => e.key));
    const stale = [...ledger.keys()].filter((k) => !dirtyKeys.has(k)).slice(0, 200);
    if (stale.length) L.recordClean({ brainPath, home, keys: stale, now });
  } catch { /* best effort */ }

  const cwdRel = norm(path.relative(root, cwd));
  let strongest = null;
  const foreign = new Map();
  const shared = new Map();
  for (const step of risky) {
    const stepCwd = step.cwd ? norm(path.relative(root, path.resolve(cwd, step.cwd))) : cwdRel;
    const hit = affectedBy(step, dirty, cls.stagedBeforeCommit?.[step.index], stepCwd && !stepCwd.startsWith('..') ? stepCwd : '');
    for (const d of hit) {
      const o = info.get(d.path);
      if (!o) continue;
      const ownerLive = !liveKnown || (o.owners || []).some((w) => liveKeys.has(String(w.sid || '').toLowerCase()));
      if (o.cls === 'FOREIGN' && (ownerLive || step.tier === 'DISCARD' || step.tier === 'PARK')) foreign.set(d.path, { o, step });
      else if (o.cls === 'FOREIGN') shared.set(d.path, { o: { ...o, stopped: true }, step });
      else if (o.cls === 'SHARED') shared.set(d.path, { o, step });
    }
    if (hit.some((d) => ['FOREIGN', 'SHARED'].includes(info.get(d.path)?.cls))) {
      if (!strongest || C.tierRank(step.tier) > C.tierRank(strongest.tier)) strongest = step;
    }
  }
  const mineList = [...info.entries()].filter(([, o]) => o.cls === 'MINE').map(([p]) => p);
  const ownerLine = ([p, { o }]) => {
    const w = o.owners?.[0];
    return `- ${p} — ${w ? `${clientWord(w.client)} session ${String(w.sid).slice(0, 8)}, edited ${agoWord(now - Number(w.at || now))}` : 'another session'}${o.label ? ` (${o.label})` : ''}`;
  };

  if (!strongest) {
    const readOnly = risky.every((s) => s.tier === 'READ');
    const theirs = [...info.entries()].filter(([, o]) => o.cls === 'FOREIGN').map(([p, o]) => [p, { o }]);
    if (readOnly && theirs.length) {
      return {
        decision: 'context',
        text: `KLYPIX: some uncommitted files here are another session's work — leave them alone and commit only your own:\n${theirs.slice(0, 12).map(ownerLine).join('\n')}${mineList.length ? `\nYours: ${mineList.slice(0, 12).join(', ')}` : ''}`,
        log: { tier: 'READ', foreign: theirs.length },
      };
    }
    return null;
  }

  const human = HUMAN_MODES.has(String(input.permission_mode || 'default'));
  const tier = strongest.tier;
  const isMove = tier === 'MOVE';
  const isSweep = tier === 'SWEEP' || tier === 'EXPLICIT' || (strongest.sub === 'commit');
  const isDiscard = tier === 'DISCARD' || tier === 'PARK';
  const fList = [...foreign.entries()];
  const sList = [...shared.entries()];
  const log = { tier, sub: strongest.sub, foreign: fList.length, shared: sList.length, human, mode };

  if (isMove) {
    if (!fList.length) return null;
    return { decision: 'context', text: `KLYPIX: another session has uncommitted work in this checkout; switching branch or rebasing moves the files under it:\n${fList.slice(0, 12).map(ownerLine).join('\n')}`, log };
  }
  if (isSweep) {
    if (!fList.length) {
      if (!sList.length) return null;
      const stoppedOnly = sList.every(([, { o }]) => o.stopped);
      return { decision: 'context', text: stoppedOnly
        ? `KLYPIX: these uncommitted files were left by a session that has stopped:\n${sList.slice(0, 12).map(ownerLine).join('\n')}\nIf you are continuing that session's work, they are yours to finish and commit. If not, leave them out of your commit.`
        : `KLYPIX: these files also contain uncommitted edits by another session since the last commit — check the diff before you commit them:\n${sList.slice(0, 12).map(ownerLine).join('\n')}`, log };
    }
    const narrow = mineList.length ? `git add -- ${mineList.slice(0, 12).map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')} && git commit -m "<message>"` : 'git add -- <only the files you changed> && git commit -m "<message>"';
    const text = `KLYPIX stopped this command: it would ${tier === 'SWEEP' ? 'sweep' : 'commit'} another session's uncommitted work into your commit:\n${fList.slice(0, 12).map(ownerLine).join('\n')}\nCommit only your own files instead:\n  ${narrow}\nLeave the other session's files as they are. If the human wants them included, ask the human.`;
    return { decision: 'deny', text, log };
  }
  if (isDiscard) {
    const atRisk = [...fList, ...sList];
    if (!atRisk.length) return null;
    let rescue = null;
    try {
      const R = await import(new URL('./whose-rescue.mjs', import.meta.url).href);
      rescue = R.createRescue({ repoRoot: root, paths: atRisk.map(([p]) => p), sid: input.session_id || 'unknown', reason: `before: ${command.slice(0, 120)}`, now });
      if (rescue && rescue.ok) rescue.restore = R.rescueRestoreCommand(rescue.id);
    } catch { rescue = null; }
    const saved = rescue && rescue.ok ? `A rescue copy of those files was saved first: ${rescue.id} (restore: ${rescue.restore}).` : 'KLYPIX could not save a rescue copy of those files.';
    const head = `KLYPIX: this command would ${tier === 'PARK' ? 'stash away' : 'discard'} another session's uncommitted work:\n${atRisk.slice(0, 12).map(ownerLine).join('\n')}\n${saved}`;
    log.rescue = rescue && rescue.ok ? rescue.id : null;
    if (human) return { decision: 'ask', text: `${head}\nRun it only if the human confirms.`, log };
    return { decision: 'deny', text: `${head}\nDo not run it yourself: tell the human what it would do and let them decide.`, log };
  }
  return null;
}

/** Shadow mode wrapper: log what would have happened, show it as context only. */
export function shadowOf(result) {
  if (!result) return null;
  try {
    fs.mkdirSync(brainDir(), { recursive: true });
    fs.appendFileSync(path.join(brainDir(), 'whose-decisions.jsonl'), JSON.stringify({ at: new Date().toISOString(), decision: result.decision, ...result.log }) + '\n');
  } catch { /* best effort */ }
  if (result.decision === 'context') return result;
  return { ...result, decision: 'context', text: `(KLYPIX shadow mode — not enforced) ${result.decision === 'deny' ? 'would block' : 'would ask about'} this command:\n${result.text}` };
}
