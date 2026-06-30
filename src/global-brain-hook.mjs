#!/usr/bin/env node
// global-brain-hook — zero-setup project brain for ANY Claude Code project.
//
// Installed to ~/.claude/project-brain/ and wired into the GLOBAL
// ~/.claude/settings.json so it runs for every project:
//   SessionStart (no arg) → if ./brain.klypix exists, print its markdown brief
//     to stdout; the harness injects that as session context.
//   Stop (--capture)      → harvest "🧠 BRAIN [Area]: …" markers from the
//     transcript (hook JSON on stdin) into ./brain.klypix, deduped.
//
// Bulletproof by contract: it runs on EVERY session/turn in EVERY project, so
// it must be an INSTANT no-op when there's no ./brain.klypix, must NEVER throw,
// and must ALWAYS exit 0. The format/IO work is lazy-imported only when a brain
// is actually present, keeping non-brain projects to a bare existsSync.
//
// This is the source-of-truth copy (lives in the KLYPIX repo, version
// controlled); it is copied to ~/.claude/project-brain/ alongside
// klypix-format.mjs (+ a node_modules with jszip) where it actually runs.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

const CWD = process.cwd();
const BRAIN = path.resolve(CWD, 'brain.klypix');
const STATE = path.resolve(CWD, '.claude', 'brain-capture-state.json');
// 🧠 BRAIN [Area]: decision  ·  [Area] ?: open question  ·  [Area] !: milestone
//                · [Area] +: 🛠️ SKILL — a reusable how-to / gotcha / convention
//                  (resurfaces every session, never ages out; a plain decision that
//                  reads as a general rule is auto-promoted to a skill too)
//                · [Area] ✓: resolves the matching existing card (archives it)
//                · [Area] ~: updates the matching card IN PLACE (small corrections)
// Optional trailing suffixes on a decision/milestone (either order, end of line):
//                · closes: <strategy/question card title or [[wikilink]]> —
//                  resolves+archives the (cross-area) card this work fulfils and
//                  draws a "closed by" arrow (the decision-lifecycle link).
//                · ev: <path[:line]>, <path>, PR#<n> — evidence anchors; file
//                  paths get their git blob OID stamped so the brief can later
//                  flag the card when that code drifts.
const MARKER = /🧠\s*BRAIN\s*(?:\[([^\]]+)\])?\s*([?!✓~+]?)\s*:\s*(.+)$/i;
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// ── Evidence anchors + close-links (decision lifecycle) ──────────────────────
// `git rev-parse HEAD:<path>` → the file's blob OID at HEAD (stable across
// uncommitted edits; changes only when the committed content does). Used to
// STAMP a card's evidence at capture and to DETECT drift at read. Best-effort.
function gitBlobOid(relPath) {
    try {
        const clean = String(relPath).split(':')[0].trim();
        if (!clean) return null;
        const oid = execSync(`git rev-parse "HEAD:${clean}"`, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).trim();
        return /^[0-9a-f]{7,40}$/.test(oid) ? oid : null;
    } catch { return null; }
}
// Parse an `ev:` value ("src/a.ts:42, src/b.ts, PR#123") into structured refs.
// File refs carry their current OID so drift is detectable later; PR/issue refs
// are recorded for display (auto-stale on PR merge would need the GitHub API).
function parseEvidence(s) {
    const refs = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const tokRaw of String(s).split(',')) {
        const ref = tokRaw.trim(); if (!ref) continue;
        if (/^(?:pr|gh|issue)?\s*#?\d+$/i.test(ref) || /\b(?:PR|GH)\s*#?\d+/i.test(ref)) { refs.push({ ref, kind: 'pr' }); continue; }
        const oid = gitBlobOid(ref);
        refs.push(oid ? { ref, kind: 'file', oid, verifiedAt: today } : { ref, kind: 'file' });
    }
    return refs.length ? refs : null;
}
// Pull optional `closes:` / `ev:` suffixes off the END of a marker body (either
// order), returning the cleaned body + parsed extras. The suffix region starts
// at the first " closes:"/" ev:" key, so a decision can carry neither, either,
// or both without the keywords leaking into the card text.
function splitMarkerSuffixes(body) {
    const m = body.match(/\s+(?:closes|ev):/i);
    if (!m) return { body, closes: '', evidence: null };
    const suffix = body.slice(m.index);
    const closesM = suffix.match(/\bcloses:\s*(.+?)\s*(?=\s+\bev:|$)/i);
    const evM = suffix.match(/\bev:\s*(.+?)\s*(?=\s+\bcloses:|$)/i);
    return {
        body: body.slice(0, m.index).trim(),
        closes: closesM ? closesM[1].trim() : '',
        evidence: evM ? parseEvidence(evM[1].trim()) : null,
    };
}
// ── Self-healing brain (decision lifecycle, part 3) ──────────────────────────
// computeFreshness() is the git-backed TRUST read: every code-anchored card gets
// ✅ verified / ⚠️ drifted / 🌱 unverified (badged inline in the brief), and the
// drifted ones become an ACTIONABLE re-verify directive — not a passive nag. The
// agent repairs each via the SAME ~ / ✓ markers, so a confirmed-or-corrected fact
// re-stamps itself fresh. The human approves the change in chat (co-owned brain).
function computeFreshness(struct) {
    const freshness = {}, drifted = [];
    try {
        const isArchived = (c) => /^archive$/i.test(c.area || '');
        const oidCache = new Map();
        for (const c of (struct?.cards || [])) {
            if (isArchived(c) || !Array.isArray(c.evidence) || !c.evidence.length) continue;
            const fileRefs = c.evidence.filter(e => e?.kind === 'file' && e.oid);
            if (!fileRefs.length) { freshness[c.id] = '🌱'; continue; }
            let isDrift = false;
            for (const ev of fileRefs) {
                const clean = String(ev.ref).split(':')[0].trim();
                if (!oidCache.has(clean)) oidCache.set(clean, gitBlobOid(clean));
                const cur = oidCache.get(clean);
                if (cur && cur !== ev.oid) isDrift = true;
            }
            if (isDrift) { freshness[c.id] = '⚠️'; drifted.push({ area: c.area, text: c.text, refs: fileRefs.map(e => e.ref) }); }
            else freshness[c.id] = '✅';
        }
    } catch { /* best-effort */ }
    return { freshness, drifted };
}
function selfHealFooter(drifted) {
    if (!drifted || !drifted.length) return '';
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const lines = ['', '---',
        `## 🔧 Self-heal — ${drifted.length} fact(s) cite code that CHANGED; re-verify before trusting them`,
        `For each below: re-read the cited file, decide, then emit ONE marker (the human approves the change in chat):`,
        '· still true → `🧠 BRAIN [Area] ~: <same claim> ev: <file>` — re-stamps it ✅ fresh',
        '· now wrong → `🧠 BRAIN [Area] ~: <corrected claim> ev: <file>` — rewrites + re-stamps',
        '· obsolete → `🧠 BRAIN [Area] ✓: <what it resolved to>` — closes + archives',
    ];
    for (const d of drifted.slice(0, 8)) lines.push(`- ⚠️ [${d.area || '?'}] ${flat(d.text).slice(0, 110)}  ·  cites \`${d.refs.join(', ')}\``);
    return '\n' + lines.join('\n') + '\n';
}
// ── External-state reconcile — migration omission tripwire (part 4) ──────────
// The brain captures NARRATED facts (markers, commit bodies); applying a DB
// migration to prod is an OBSERVED side-effect that narrates nothing, so it
// silently never lands — and the brain can't tell a *committed* migration from an
// *applied* one. This is the portable seam (the heavy lifting is the pure
// findUnrecordedMigrations() in klypix-format) that closes the blind spot WITHOUT
// a prod probe: it lists committed migration files on disk and, if any are
// unmentioned by a live card, PROMPTS the human to confirm the rollout — never
// asserts it. Pure fs, no DB, no network. Self-clears the moment a card names the
// migration (recording it — or a "committed, not applied" note — is the dismiss).
const MIGRATION_DIRS = ['supabase/migrations', 'db/migrate', 'db/migrations', 'prisma/migrations', 'migrations'];
function collectMigrationFiles(root) {
    const out = [];
    for (const rel of MIGRATION_DIRS) {
        const abs = path.join(root, ...rel.split('/'));
        let entries;
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.isFile() && /\.sql$/i.test(e.name)) out.push(rel + '/' + e.name);
            else if (e.isDirectory()) {                                   // Prisma: <dir>/migration.sql
                try { if (fs.statSync(path.join(abs, e.name, 'migration.sql')).isFile()) out.push(rel + '/' + e.name + '/migration.sql'); } catch { /* not a prisma dir */ }
            }
        }
    }
    return out;
}
function reconcileFooter(lib, struct) {
    try {
        if (typeof lib.findUnrecordedMigrations !== 'function') return '';   // version-skew guard (stale live klypix-format)
        const files = collectMigrationFiles(CWD);
        if (!files.length) return '';                                       // no migrations dir → silent
        const { gaps, total } = lib.findUnrecordedMigrations(struct, files, { max: 6 });
        if (!gaps || !gaps.length) return '';
        const lines = ['', '---',
            `## 🔧 Self-heal — ${total} migration(s) committed but NOT recorded in the brain`,
            `These .sql files are in git, but no brain card mentions them. The brain can't see prod — if one was APPLIED, record it (don't assert it if it wasn't); to dismiss, note it ("committed, not applied"):`,
            '· applied → `🧠 BRAIN [DB] !: migration <name> applied to prod ev: <path>` — captures, badges + drift-tracks it',
        ];
        for (const g of gaps) lines.push(`- ⚠️ \`${g.path}\` — committed, no card references it`);
        if (total > gaps.length) lines.push(`- …and ${total - gaps.length} more.`);
        return '\n' + lines.join('\n') + '\n';
    } catch { return ''; }
}
// Normalize a brain path so the SAME project resolves to ONE identity (registry
// entry AND cache key). On a case-insensitive FS the CWD can surface as "E:/…"
// one run and "e:/…" the next; without lowercasing the drive that split one
// project into two registry entries AND two parse-cache files.
const normBrainPath = (p) => String(p).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());

const readState = () => { try { return new Set(JSON.parse(fs.readFileSync(STATE, 'utf8')).seen || []); } catch { return new Set(); } };
const writeState = (seen) => { try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify({ seen: [...seen].slice(-2000) })); } catch { /* ignore */ } };

// The hook's stdin carries the Claude Code event JSON (session_id, cwd,
// transcript_path, prompt, …). fd 0 can be read only ONCE, so read+parse it a
// single time and memoize — every mode pulls the fields it needs from here
// (capture→transcript_path, prompt→prompt, all→session_id for live coordination).
let _hookInput;
function readHookInput() {
    if (_hookInput !== undefined) return _hookInput;
    try {
        // A manual run (e.g. `--full` in a terminal) has a TTY on fd 0 — reading it
        // would BLOCK waiting for input. Only read when stdin is piped (a real hook).
        if (process.stdin.isTTY) { _hookInput = {}; return _hookInput; }
        _hookInput = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') || {};
    } catch { _hookInput = {}; }
    return _hookInput;
}

// --- Observability (added 2026-06-15) -----------------------------------
// The hook is bulletproof-by-contract: it swallows every error and exits 0,
// and it runs from a COPIED live file. That makes silent failure (stale copy,
// missing jszip, unreadable transcript) and silent corruption (junk markers
// captured as real cards) invisible. These two append-only logs make both
// observable without breaking the never-throw contract — every write is
// wrapped and best-effort.
//   LEDGER  (per-project): every capture DECISION — added / skipped-seen /
//           skipped-example / resolve / update — so you can see exactly what
//           the harvester did (and didn't) ingest, and why.
//   HEALTH  (global): one line per hook run — mode, ok/err, brain + brief
//           bytes — so a dead/stale/unsynced live copy stops being invisible.
const LEDGER = path.resolve(CWD, '.claude', 'brain-capture-log.jsonl');
const HEALTH = path.join(os.homedir(), '.claude', 'project-brain', '.hook-health.jsonl');
const LOCK = path.resolve(CWD, '.claude', 'brain-capture.lock');   // serialize concurrent captures
const DRY = process.argv.includes('--dry-run');   // inspect a capture without writing
const nowIso = () => { try { return new Date().toISOString(); } catch { return ''; } };
const brainBytes = () => { try { return fs.statSync(BRAIN).size; } catch { return 0; } };
function appendJsonl(file, obj, maxLines = 0) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (maxLines > 0 && fs.existsSync(file)) {
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
            lines.push(JSON.stringify(obj));
            fs.writeFileSync(file, lines.slice(-maxLines).join('\n') + '\n');
        } else {
            fs.appendFileSync(file, JSON.stringify(obj) + '\n');
        }
    } catch { /* observability is best-effort — never break the session */ }
}

// Serialize concurrent captures (3 simultaneous sessions all hit Stop). atomic-
// Write stops CORRUPTION but not LOST UPDATES — each session reads the same base
// and the last writer wins, so the others' cards vanish. Advisory lockfile:
// O_EXCL create wins the lock; a held lock is waited on (sync sleep via Atomics,
// no busy-spin); a STALE lock (older than a sub-second capture should ever take)
// is stolen so a crashed session can't wedge the brain forever. Best-effort: if
// it can't get the lock within the budget it writes anyway (better than dropping
// the markers) and flags it in the health log.
const LOCK_STALE_MS = 15000;
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* */ } };
function acquireLock(lockPath, { tries = 60, waitMs = 60 } = {}) {
    try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* */ }
    for (let i = 0; i < tries; i++) {
        try { const fd = fs.openSync(lockPath, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
        catch (e) {
            if (e && e.code !== 'EEXIST') return false;  // unexpected FS error → caller writes best-effort
            try { if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; } } catch { /* lost a race on the stale file — just retry */ }
            sleepSync(waitMs);
        }
    }
    return false;  // contended past ~3.6s → write best-effort (rare; captures are sub-second)
}
function releaseLock(lockPath) { try { fs.unlinkSync(lockPath); } catch { /* */ } }

// ── Live cross-session coordination (brain.sessions heartbeat) ───────────────
// The brain is ASYNC memory — capture on Stop, recall on the next Start — so two
// sessions in the SAME repo are blind to each other's in-flight work. This is the
// cheap, no-daemon fix: every hook event UPSERTS this session's lane (id, branch,
// intent, the files it's touching, a heartbeat) into a per-PROJECT sidecar, and
// the per-prompt recall reads peers back and WARNS when another LIVE session shares
// your branch or is editing files you changed (the live hot-file signal the async
// brain can't give). Heartbeat-granularity (seconds), soft/advisory (never blocks),
// self-pruning (a lane unseen for FRESH_MS is gone). Sibling of the registry/health
// sidecars; same ~/.claude/project-brain home, same acquireLock/never-throw rules.
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'project-brain', 'sessions');
const SESSIONS_FILE = path.join(SESSIONS_DIR, `${sha(normBrainPath(BRAIN))}.json`); // one lane-file per PROJECT (shared by its concurrent sessions)
const SESSIONS_LOCK = SESSIONS_FILE + '.lock';
const SESSION_FRESH_MS = 10 * 60 * 1000;   // a lane unseen for 10min is treated as ended
const safeGit = (args, timeout = 1500) => { try { return execSync(`git ${args}`, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }); } catch { return ''; } };
const gitBranch = () => { const b = safeGit('rev-parse --abbrev-ref HEAD', 1000).trim(); return b && b !== 'HEAD' ? b : null; };
const gitChangedPaths = () => safeGit('diff --name-only HEAD').split('\n').map(s => s.trim()).filter(Boolean);
const fileSlug = (p) => slugify(String(p).replace(/\\/g, '/').split('/').pop().replace(/\.[a-z0-9]+$/i, ''));
const changedToSlugs = (paths) => [...new Set(paths.map(fileSlug).filter(s => s.length >= 3))].slice(0, 12);
const readSessions = () => { try { const d = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); return Array.isArray(d.sessions) ? d.sessions : []; } catch { return []; } };
const pruneSessions = (list, now) => list.filter(s => s && s.id && (now - (s.lastSeen || 0) < SESSION_FRESH_MS));
// Upsert THIS session's lane. Best-effort + never-throw: a missing session_id, a
// lock-timeout, or a write error just skips coordination for this turn (a dropped
// heartbeat is harmless — the next event re-registers it).
function touchSession(sid, patch = {}) {
    if (!sid) return;
    try {
        const now = Date.now();
        const got = acquireLock(SESSIONS_LOCK, { tries: 20, waitMs: 25 });   // ~0.5s budget then best-effort
        try {
            let data0 = {}; try { data0 = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { /* fresh */ }
            const all = pruneSessions(Array.isArray(data0.sessions) ? data0.sessions : [], now);
            const prev = all.find(s => s.id === sid) || {};
            const list = all.filter(s => s.id !== sid);
            list.push({
                id: sid, pid: process.pid, project: path.basename(CWD),
                branch: patch.branch !== undefined ? patch.branch : (prev.branch ?? null),
                intent: patch.intent !== undefined ? patch.intent : (prev.intent ?? ''),
                files: patch.files !== undefined ? patch.files : (prev.files ?? []),
                // ships ACCUMULATE across turns (deduped, last 5) so a peer sees the
                // session's recent ship-events, not just the latest turn's.
                ships: patch.ships !== undefined ? [...new Set([...(prev.ships || []), ...patch.ships])].slice(-5) : (prev.ships ?? []),
                startedAt: prev.startedAt || now, lastSeen: now,
            });
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
            // Preserve the messages lane — touchSession runs AFTER postMessages in a
            // capture, and dropping the field here would clobber a just-posted note.
            const keptMsgs = (Array.isArray(data0.messages) ? data0.messages : []).filter(m => m && (now - (m.ts || 0) < MSG_FRESH_MS));
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: list.slice(-20), messages: keptMsgs }));
        } finally { if (got) releaseLock(SESSIONS_LOCK); }
    } catch { /* coordination is best-effort */ }
}
// Other live lanes in THIS project (exclude me by session id AND pid).
function livePeers(sid) {
    try { return pruneSessions(readSessions(), Date.now()).filter(s => s.id !== sid && s.pid !== process.pid); }
    catch { return []; }
}
// Zero-cost-UNLESS-a-peer-exists footer: lists other live sessions and ESCALATES
// when one shares your branch or is editing files you changed. Empty string when
// you're solo (the common case) — preserves the per-prompt "nothing → zero tokens"
// contract, so it only ever speaks up when there's a real collision to avoid.
function peerFooter(sid) {
    if (!sid) return '';
    let list; try { list = pruneSessions(readSessions(), Date.now()); } catch { return ''; }
    const peers = list.filter(s => s.id !== sid && s.pid !== process.pid);
    if (!peers.length) return '';
    // "My files" = what THIS session edited (set at Stop from its own transcript),
    // NOT the shared working-tree diff (identical for two sessions in one repo).
    const me = list.find(s => s.id === sid);
    const myFiles = new Set((me && Array.isArray(me.files)) ? me.files : []);
    const myBranch = me && me.branch;
    const now = Date.now();
    const ago = (ts) => { const m = Math.max(0, Math.round((now - (ts || now)) / 60000)); return m <= 0 ? 'just now' : `${m}m ago`; };
    const lines = ['', '## ⚠️ Other live session(s) in this project — coordinate (the brain is shared, NOT live-merged)'];
    for (const p of peers.slice(0, 4)) {
        const bits = [];
        if (p.branch) bits.push(`branch \`${p.branch}\``);
        bits.push(`active ${ago(p.lastSeen)}`);
        if (p.intent) bits.push(`“${String(p.intent).replace(/\s+/g, ' ').trim().slice(0, 60)}”`);
        const ships = Array.isArray(p.ships) ? p.ships : [];
        if (ships.length) bits.push(`🏁 shipped: ${ships.slice(-3).join('; ')}`);
        const shared = (Array.isArray(p.files) ? p.files : []).filter(f => myFiles.has(f));
        let warn = '';
        if (shared.length) warn = `  · ⚠️ both edited: ${shared.slice(0, 5).join(', ')} — expect a conflict, KEEP BOTH`;
        else if (p.branch && myBranch && p.branch === myBranch) warn = '  · ⚠️ same branch — pull/rebase before you commit';
        lines.push(`- session ${String(p.id).slice(0, 8)} · ${bits.join(' · ')}${warn}`);
    }
    lines.push('Ping the other session before touching shared files; check the brain for what they decided/shipped.');
    return lines.join('\n');
}

// ── Brain messaging — async agent↔agent notes via the shared per-project lane ─
// The COMPLEMENT to the live-ledger: the ledger surfaces a peer's AUTOMATIC high-
// signal events (ships, version bumps); this lets a session leave a DELIBERATE,
// TARGETED note for another ("merged the hook refactor — rebase your PR first").
// SEND by emitting `🧠 MSG [<to>]: <text>` in a reply (to = a peer's id-prefix or
// branch, omitted = all); the Stop hook posts it to the lane, and the recipient's
// next prompt/session-start surfaces it ONCE (ack'd under the lane lock). Still
// async (delivered at the peer's next hook event), by design — not real-time.
const MSG_RE = /🧠\s*MSG\s*(?:\[([^\]]*)\])?\s*:\s*(.+)$/i;
const MSG_FRESH_MS = 24 * 60 * 60 * 1000;
function postMessages(msgs) {
    if (!msgs || !msgs.length) return;
    const got = acquireLock(SESSIONS_LOCK, { tries: 20, waitMs: 25 });
    try {
        let data = {}; try { data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { /* fresh */ }
        const sessions = Array.isArray(data.sessions) ? data.sessions : [];
        const now = Date.now();
        const kept = (Array.isArray(data.messages) ? data.messages : []).filter(m => m && (now - (m.ts || 0) < MSG_FRESH_MS));
        for (const m of msgs) kept.push(m);
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions, messages: kept.slice(-30) }));
    } catch { /* best-effort */ } finally { if (got) releaseLock(SESSIONS_LOCK); }
}
// to==='all'/'' → everyone; else the hint must appear in my id-prefix / branch / intent.
function msgTargetsMe(m, me, sid) {
    const to = String(m.to || '').trim().toLowerCase();
    if (!to || to === 'all' || to === '*') return true;
    return [String(sid || '').slice(0, 8), me?.branch || '', me?.intent || ''].join(' ').toLowerCase().includes(to);
}
// Surface unseen messages addressed to me, mark them seen (delivered once) under lock.
function messageFooter(sid) {
    if (!sid) return '';
    let data = {}; try { data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return ''; }
    const all = Array.isArray(data.messages) ? data.messages : [];
    if (!all.length) return '';
    const now = Date.now();
    const me = (Array.isArray(data.sessions) ? data.sessions : []).find(s => s.id === sid);
    const unseen = all.filter(m => m && (now - (m.ts || 0) < MSG_FRESH_MS) && m.from !== sid
        && !(Array.isArray(m.seen) && m.seen.includes(sid)) && msgTargetsMe(m, me, sid));
    if (!unseen.length) return '';
    const got = acquireLock(SESSIONS_LOCK, { tries: 15, waitMs: 25 });   // ack under lock so a peer read can't lose it
    try {
        let d2 = {}; try { d2 = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { /* */ }
        const ids = new Set(unseen.map(u => u.id));
        for (const m of (Array.isArray(d2.messages) ? d2.messages : [])) {
            if (!ids.has(m.id)) continue;
            if (!Array.isArray(m.seen)) m.seen = [];
            if (!m.seen.includes(sid)) m.seen.push(sid);
        }
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(d2));
    } catch { /* */ } finally { if (got) releaseLock(SESSIONS_LOCK); }
    const ago = (ts) => { const mm = Math.max(0, Math.round((now - (ts || now)) / 60000)); return mm <= 0 ? 'just now' : `${mm}m ago`; };
    const out = ['', '## 📨 Message(s) from another session in this project (delivered once — act on or reply to them)'];
    for (const m of unseen.slice(0, 6)) out.push(`- from ${String(m.from || '?').slice(0, 8)} · ${ago(m.ts)}: ${String(m.text).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    out.push('Reply with `🧠 MSG [<their-id or all>]: <text>` — it reaches them on their next prompt.');
    return '\n' + out.join('\n');
}

// Pull assistant text out of one transcript line (Claude Code JSONL: content is
// a string or an array of {type:'text',text}).
function textOf(entry) {
    const m = entry?.message ?? entry;
    if (m?.role !== 'assistant') return '';
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
    return '';
}

// --- File anchoring (added 2026-06-15) ----------------------------------
// Pull the file paths a transcript turn touched out of its tool_use blocks
// (Edit/Write/Read/…). textOf() above keeps only assistant TEXT and throws
// these away — but they're how we tag a captured decision to the code it's
// about, so a later git-diff token can match the card precisely (see
// scoreCardsAgainstQuery). Tags use hyphens (#file-foo, #dir-bar) so the
// existing TAG regex + brain_connect cross-linking pick them up for free.
// WRITE tools only — a decision is anchored to files it CHANGED, not files it
// merely glanced at (Read/view would over-anchor every browsed file).
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit_file', 'write_file']);
function filesInEntry(entry) {
    const c = (entry?.message ?? entry)?.content;
    if (!Array.isArray(c)) return [];
    const out = [];
    for (const p of c) {
        if (p?.type === 'tool_use' && FILE_TOOLS.has(p.name)) {
            const fp = p.input?.file_path || p.input?.path || p.input?.notebook_path;
            if (typeof fp === 'string' && fp) out.push(fp);
        }
    }
    return out;
}
// --- Ship-event auto-capture (added 2026-06-23) -------------------------
// The brain was marker-GATED: only what an agent explicitly marked (🏁/❓/…) or a
// conventional-commit BODY landed. So a session that merges PRs / cuts releases via
// `gh`/`npm` — high-signal SHIP events — captured NOTHING unless it remembered a
// marker (a real gap a concurrent session hit: 3 releases + 6 merged PRs → zero
// cards). These are DETERMINISTIC and scrapeable from the transcript's shell
// tool_use blocks, no model marker required. Only commands that SUCCEEDED (their
// tool_result wasn't an error) count, so a failed `gh pr merge` never fabricates a
// card; dedup rides the same persistent seen-set as markers.
const SHELL_TOOLS = new Set(['Bash', 'run_shell', 'shell']);
const SHIP_PATTERNS = [
    { re: /\bgh\s+pr\s+merge\b/i, kind: 'merged PR', area: 'Ship', num: /#?(\d{1,6})\b/ },
    { re: /\bgh\s+release\s+create\s+(\S+)/i, kind: 'cut release', area: 'Release' },
    { re: /\bnpm\s+publish\b/i, kind: 'published to npm', area: 'Release' },
    // CREATE only — exclude `git tag -d/-v/-l/-n` (delete/verify/list) so a tag
    // deletion isn't mis-captured as a release (mirrors LIVE_SHIP_PATTERNS).
    { re: /\bgit\s+tag\s+(?!(?:-d|--delete|-v|--verify|-l|--list|-n)\b)(?:-a\s+|-s\s+|-f\s+)?(v?\d[\w.\-]*)/i, kind: 'tagged', area: 'Release' },
];
// Walk an entry's content blocks once: collect shell COMMANDS (id+cmd) and the ids
// of tool calls that ERRORED, so a ship-event only counts if the command ran clean.
function scanToolBlocks(entry, shellCmds, errorIds) {
    const c = (entry?.message ?? entry)?.content;
    if (!Array.isArray(c)) return;
    for (const b of c) {
        if (b?.type === 'tool_use' && SHELL_TOOLS.has(b.name) && typeof b.input?.command === 'string') shellCmds.push({ id: b.id, cmd: b.input.command });
        else if (b?.type === 'tool_result' && b.is_error && b.tool_use_id) errorIds.add(b.tool_use_id);
    }
}
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function fileTagsFor(p) {
    const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
    const base = parts[parts.length - 1] || '';
    const stem = slugify(base.replace(/\.[a-z0-9]+$/i, '')); // basename minus extension
    const dir = parts.length >= 2 ? slugify(parts[parts.length - 2]) : '';
    const tags = [];
    // Gate on the SLUG length (≥3), matching the query-token threshold, so any
    // segment that becomes a tag is reproducible as a query token (the old
    // `t.length > 6` on the whole prefixed tag was asymmetric: #file- is 6,
    // #dir- is 5, so a 1-char file stem survived but a 2-char dir didn't).
    if (stem.length >= 3) tags.push('#file-' + stem);
    if (dir.length >= 3) tags.push('#dir-' + dir);
    return tags;
}

// --- Commit-body auto-capture (added 2026-06-15) ------------------------
// Turn rationale-bearing feat/fix/perf commits into cards on Stop, so the WHY
// in commit BODIES (which terse 🧠 markers often miss) lands in the brain
// automatically. HIGH-SIGNAL, not a commit-log dump: ONLY commits whose body
// carries a real rationale are taken; subject-only commits are skipped. A
// per-project last-seen sha (its OWN tiny file, so the dedup-state plumbing is
// untouched) makes it incremental + flood-proof — first run BASELINES to HEAD
// (captures nothing), later runs take only new commits (capped), and it
// re-baselines if history was rewritten (rebase/reset) so a non-ancestor range
// can never dump the whole history.
const COMMIT_STATE = path.resolve(CWD, '.claude', 'brain-last-commit');
const readLastCommit = () => { try { return fs.readFileSync(COMMIT_STATE, 'utf8').trim() || null; } catch { return null; } };
const writeLastCommit = (s) => { try { fs.mkdirSync(path.dirname(COMMIT_STATE), { recursive: true }); fs.writeFileSync(COMMIT_STATE, String(s || '')); } catch { /* best-effort */ } };
const git = (args) => execSync(`git ${args}`, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
const CC_RE = /^(feat|fix|perf)(?:\(([^)]+)\))?!?:\s*(.+)$/i;
function parseCommitLog(raw) {
    return String(raw).split('\x1e').map(s => s.trim()).filter(Boolean).map(rec => {
        const p = rec.split('\x1f');
        return { hash: (p[0] || '').trim(), subject: (p[1] || '').trim(), body: (p[2] || '').trim() };
    }).filter(c => c.hash && c.subject);
}
function commitToCard(c) {
    const m = CC_RE.exec(c.subject);
    if (!m) return null;                                                        // only feat / fix / perf
    const body = c.body.replace(/\s+/g, ' ').trim();
    if (body.length < 12) return null;                                          // RATIONALE-bearing only — keeps it high-signal, not a dump
    const type = m[1].toLowerCase(), scope = (m[2] || '').trim(), desc = m[3].trim();
    const area = scope || (type === 'feat' ? 'Milestones' : 'Fixes');
    const prefix = type === 'feat' ? '🏁 ' : '';
    return {
        text: `${area}: ${prefix}${desc}\n\n${body.slice(0, 400)}\n#${slugify(area)} #commit-${c.hash.slice(0, 7)}`,
        area, borderColor: type === 'feat' ? 'rgba(59,130,246,0.8)' : 'rgba(16,185,129,0.6)', createdVia: 'commit',
    };
}
async function gatherCommitCards(prevCommit) {
    let head = '';
    try { head = git('rev-parse HEAD'); } catch { return { cards: [], newLastCommit: prevCommit }; }
    if (!head) return { cards: [], newLastCommit: prevCommit };
    if (!prevCommit) return { cards: [], newLastCommit: head };                 // BASELINE: record HEAD, capture nothing
    if (head === prevCommit) return { cards: [], newLastCommit: head };         // no new commits
    try { execSync(`git merge-base --is-ancestor ${prevCommit} HEAD`, { cwd: CWD, stdio: 'ignore', timeout: 2000 }); }
    catch { return { cards: [], newLastCommit: head }; }                        // history rewritten → re-baseline, don't dump
    let raw = '';
    try { raw = git(`log ${prevCommit}..HEAD --no-merges --format=%x1e%H%x1f%s%x1f%b`); } catch { return { cards: [], newLastCommit: head }; }
    return { cards: parseCommitLog(raw).slice(0, 15).map(commitToCard).filter(Boolean), newLastCommit: head };
}

// ── Live cross-session ledger (in-flight ship/version/milestone, 2026-06-28) ─────
// The brain is ASYNC: a session's decisions/ships land in brain.klypix only at Stop
// (capture() below), so CONCURRENT sessions read PAST state and are BLIND to what a
// running peer just shipped — the real "reported 1.3.17 while peers had built
// 1.3.18/1.3.19" failure — and a CRASHED (never-Stopped) session loses its whole
// in-session memory. This is the SELECTIVE live layer that closes BOTH gaps without
// the noise that made batch-on-Stop the right default for the bulk: a PostToolUse
// hook (--live) appends ONLY high-signal SUCCESS events — a ship (release / merge /
// publish / tag), a package.json version bump, or a 🏁/🛠️ milestone marker — to a
// tiny append-only ledger; the read paths surface OTHER live sessions' in-flight
// entries; Stop folds THIS session's into the brain and clears them. Same
// ~/.claude/project-brain home + sha/lock/never-throw contract as the sidecars.
const LIVE_LEDGER = path.join(os.homedir(), '.claude', 'project-brain', 'live-ledger.jsonl');
const LIVE_LEDGER_LOCK = LIVE_LEDGER + '.lock';
const LIVE_PRUNE_MS = 6 * 60 * 60 * 1000;   // entries older than 6h are pruned on every append
const LIVE_MAX_LINES = 500;                 // hard cap on the (global, cross-project) file
const LIVE_WINDOW_MS = 30 * 60 * 1000;      // read window: surface only peers' events from the last ~30min

// Bounded tail read — the last `maxBytes` of a (possibly huge) transcript as a
// Buffer, so the milestone + success scans stay cheap regardless of session length.
// Returning the Buffer (not a decoded string) lets the hot milestone gate scan for
// the marker's raw bytes and SKIP the ~64KB UTF-8 decode on the common no-marker
// turn (decode only once the bytes are actually present).
function tailReadBuf(file, maxBytes) {
    try {
        const fd = fs.openSync(file, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const start = size > maxBytes ? size - maxBytes : 0;
            const len = size - start;
            if (len <= 0) return null;
            const buf = Buffer.allocUnsafe(len);
            fs.readSync(fd, buf, 0, len, start);
            return buf;
        } finally { fs.closeSync(fd); }
    } catch { return null; }
}
const MARKER_BYTES = Buffer.from('🧠');   // UTF-8 F0 9F A7 A0 — byte-scan gate, no decode

// Did the tool_result for `toolUseId` error? PostToolUse carries NO exit code for a
// shell tool (only `interrupted`), so to keep a FAILED ship from even blipping
// in-flight we mirror the Stop ship-scan's is_error gate via the transcript. Best-
// effort: if the result isn't written to the transcript yet (a race) we can't
// confirm a failure → treat as ok (the durable Stop capture re-validates is_error
// before anything reaches the brain, so a transient false blip never persists).
function toolResultErrored(tp, toolUseId) {
    try {
        if (!tp || !toolUseId || !fs.existsSync(tp)) return false;
        const buf = tailReadBuf(tp, 256 * 1024);
        if (!buf) return false;
        const tail = buf.toString('utf8');                  // rare path (only a ship candidate) → decode is fine
        if (tail.indexOf(toolUseId) === -1) return false;
        const lines = tail.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].indexOf(toolUseId) === -1) continue;
            let e; try { e = JSON.parse(lines[i]); } catch { continue; }
            const c = (e?.message ?? e)?.content;
            if (!Array.isArray(c)) continue;
            for (const b of c) if (b?.type === 'tool_result' && b.tool_use_id === toolUseId) return b.is_error === true;
        }
        return false;
    } catch { return false; }
}

// A 🧠 BRAIN milestone (🏁) / skill (🛠️) marker in THIS turn's assistant text — the
// only live-kind not derivable from the tool payload itself, so we read the
// transcript tail. Same EXAMPLE guard as capture() so quoted marker SYNTAX in
// explanatory prose can't fabricate an event. Plain decisions / ? / ✓ / ~ are
// intentionally NOT surfaced live (low-signal mid-flight); only milestones + skills.
function liveMilestoneFromTranscript(tp) {
    if (!tp) return null;                                    // (tailReadBuf returns null for a missing file — no extra existsSync stat)
    const buf = tailReadBuf(tp, 64 * 1024);
    if (!buf || buf.indexOf(MARKER_BYTES) === -1) return null;   // cheap BYTE gate — common no-marker turn stops here (no decode)
    const tail = buf.toString('utf8');
    const lines = tail.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        let e; try { e = JSON.parse(lines[i]); } catch { continue; }
        const text = textOf(e);
        if (!text || text.indexOf('🧠') === -1) continue;
        for (const raw of text.split('\n')) {
            const line = raw.trim();
            const m = MARKER.exec(line); if (!m) continue;
            const type = m[2] || '';
            const body0 = m[3].trim(); if (!body0) continue;
            const isMilestone = type === '!' || type === '+' || /🏁|🛠/.test(line);
            if (!isMilestone) continue;
            if (/<(open question|one-line decision|decision|area|placeholder|open|milestone)[^>]*>/i.test(body0) || /`[^`]*🧠/.test(raw)) continue;  // example/doc guard
            const { body } = splitMarkerSuffixes(body0);
            if (!body) continue;
            const area = (m[1] || '').trim();
            return (area ? `${area}: ` : '') + body;
        }
        return null;   // newest 🧠-bearing assistant text had no milestone marker → stop walking back
    }
    return null;
}

// Live ship detectors — the SUCCESS go-live events worth surfacing the instant they
// happen (superset of the Stop SHIP_PATTERNS: adds `gh release edit --draft=false`,
// the actual go-live flip). Each returns a terse human summary.
const LIVE_SHIP_PATTERNS = [
    { re: /\bgh\s+release\s+edit\s+(\S+)[\s\S]*?--draft\s*=?\s*false\b/i, fmt: (m) => `released ${m[1]} (draft → live)` },
    { re: /\bgh\s+release\s+create\s+(\S+)/i, fmt: (m) => `cut release ${m[1]}` },
    { re: /\bgh\s+pr\s+merge\b/i, fmt: (_m, cmd) => { const n = cmd.match(/#?(\d{1,6})\b/); return `merged PR${n ? ' #' + n[1] : ''}`; } },
    { re: /\bnpm\s+publish\b/i, fmt: () => 'published to npm' },
    // CREATE only — the negative lookahead rejects `git tag -d/-v/-l/-n …` (delete /
    // verify / list), which would otherwise false-ship a tag deletion as a release.
    { re: /\bgit\s+tag\s+(?!(?:-d|--delete|-v|--verify|-l|--list|-n)\b)(?:-a\s+|-s\s+|-f\s+)?(v?\d[\w.\-]*)/i, fmt: (m) => `tagged ${m[1]}` },
];

// The detector: the ONE high-signal event in this PostToolUse payload, or null.
// Pure payload string-work for ship/version (zero IO); the milestone branch reads a
// bounded transcript tail only when ship/version DON'T match. Order: ship → version
// → milestone. Never throws.
function detectLiveEvent(input) {
    const tool = input.tool_name || '';
    const ti = input.tool_input || {};
    // SHIP — a release/merge/publish/tag from a shell tool that wasn't interrupted/errored.
    if ((tool === 'Bash' || tool === 'PowerShell' || SHELL_TOOLS.has(tool)) && typeof ti.command === 'string' && ti.command) {
        const tr = input.tool_response;
        const interrupted = tr && typeof tr === 'object' && tr.interrupted === true;
        if (!interrupted) {
            for (const p of LIVE_SHIP_PATTERNS) {
                const mm = p.re.exec(ti.command); if (!mm) continue;
                if (toolResultErrored(input.transcript_path, input.tool_use_id)) return null;   // failed → not a ship
                return { kind: 'ship', text: p.fmt(mm, ti.command) };
            }
        }
    }
    // VERSION — an Edit/Write to package.json (NOT package-lock.json) that CHANGES the
    // semver. Comparing old vs new avoids a false bump when an unrelated edit's
    // new_string merely carries the version line for context (a Write has no old →
    // its version is the real current one). MultiEdit folds all sub-edits.
    if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
        const fp = String(ti.file_path || ti.path || '');
        if (/(^|[\\/])package\.json$/i.test(fp)) {
            const verOf = (s) => { const m = String(s || '').match(/"version"\s*:\s*"(\d+\.\d+\.\d+[\w.\-]*)"/); return m ? m[1] : null; };
            let newBlob = String(ti.new_string ?? ti.content ?? ''), oldBlob = String(ti.old_string ?? '');
            if (Array.isArray(ti.edits)) {
                newBlob += '\n' + ti.edits.map(ed => (ed && ed.new_string) || '').join('\n');
                oldBlob += '\n' + ti.edits.map(ed => (ed && ed.old_string) || '').join('\n');
            }
            const nv = verOf(newBlob), ov = verOf(oldBlob);
            if (nv && nv !== ov) return { kind: 'version', text: `version → ${nv} (${path.basename(fp)})` };
        }
    }
    // MILESTONE — a 🏁/🛠️ marker in this turn's assistant text (transcript tail).
    const milestone = liveMilestoneFromTranscript(input.transcript_path);
    if (milestone) return { kind: 'milestone', text: milestone };
    return null;
}

// --live (PostToolUse): the WRITE path. Near-zero-cost on the common non-matching
// branch (string checks → return). Appends ONE deduped line under the shared
// advisory lock; prunes >6h and caps the file on every append. No lazy lib import.
// Never throws (main() has already confirmed a brain exists for this project).
function liveCapture() {
    try {
        const input = readHookInput();
        const sid = input.session_id;
        if (!sid) return;
        const ev = detectLiveEvent(input);
        if (!ev) return;                                                        // non-matching branch — done
        const text = String(ev.text).replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!text) return;
        const opId = sha(`${sid}|${ev.kind}|${text}`);
        const got = acquireLock(LIVE_LEDGER_LOCK, { tries: 20, waitMs: 25 });   // ~0.5s budget then best-effort
        try {
            const now = Date.now();
            let lines = [];
            try { lines = fs.readFileSync(LIVE_LEDGER, 'utf8').split('\n').filter(Boolean); } catch { /* fresh */ }
            let dup = false;
            const kept = [];
            for (const ln of lines) {
                let e; try { e = JSON.parse(ln); } catch { continue; }
                if (!e || !e.ts) continue;
                if (e.opId === opId) dup = true;                                // already recorded by THIS session (idempotent)
                const t = Date.parse(e.ts);
                if (Number.isFinite(t) && (now - t) <= LIVE_PRUNE_MS) kept.push(ln);   // prune >6h on every append
            }
            if (dup) return;
            kept.push(JSON.stringify({ ts: new Date(now).toISOString(), sessionId: sid, project: path.basename(CWD), cwd: CWD, kind: ev.kind, text, opId }));
            fs.mkdirSync(path.dirname(LIVE_LEDGER), { recursive: true });
            fs.writeFileSync(LIVE_LEDGER, kept.slice(-LIVE_MAX_LINES).join('\n') + '\n');
        } finally { if (got) releaseLock(LIVE_LEDGER_LOCK); }
    } catch { /* never throw — same contract as the rest of the hook */ }
}

// Remove THIS session's ledger entries (called at Stop, AFTER fold-in: they're now
// durable in the brain — markers + ship-events captured by capture(); a version is
// on disk / in the next commit) and opportunistically prune anything past 6h.
// Crash-safety lives in the READ window, not here: a session that never reaches Stop
// leaves its entries to age out — still visible to peers for as long as they matter.
function clearLiveLedgerForSession(sid) {
    if (!sid) return;
    try {
        if (!fs.existsSync(LIVE_LEDGER)) return;
        const got = acquireLock(LIVE_LEDGER_LOCK, { tries: 20, waitMs: 25 });
        try {
            const now = Date.now();
            let lines = [];
            try { lines = fs.readFileSync(LIVE_LEDGER, 'utf8').split('\n').filter(Boolean); } catch { return; }
            const kept = lines.filter(ln => {
                let e; try { e = JSON.parse(ln); } catch { return false; }
                if (!e || !e.ts) return false;
                if (e.sessionId === sid) return false;                                  // mine → drop (folded into the brain)
                const t = Date.parse(e.ts); return Number.isFinite(t) && (now - t) <= LIVE_PRUNE_MS;
            });
            if (kept.length !== lines.length) fs.writeFileSync(LIVE_LEDGER, kept.length ? kept.join('\n') + '\n' : '');
        } finally { if (got) releaseLock(LIVE_LEDGER_LOCK); }
    } catch { /* best-effort */ }
}

// Is this in-flight text already a (recent) brain card? (A peer Stopped and folded
// it in between its append and our read — a SECONDARY safety net; clear-on-Stop is
// the primary dedup, so this favors PRECISION: a false-drop silently defeats the
// whole feature, so only drop on high confidence.) A version event keys on its exact
// semver token (the identity — "release" alone is too common to key on); everything
// else needs ≥3 distinct significant tokens at ≥70% overlap. Recent cards only —
// cheap + avoids a coincidental ancient match. Null struct → keep (don't over-drop).
function representedInBrain(text, struct, now) {
    try {
        if (!struct || !Array.isArray(struct.cards)) return false;
        const lc = String(text).toLowerCase();
        const ver = lc.match(/\d+\.\d+\.\d+[\w.\-]*/);
        const toks = [...new Set(lc.match(/[a-z0-9]{4,}/g) || [])];
        if (!ver && toks.length < 3) return false;
        const recentMs = 7 * 86_400_000;
        for (const c of struct.cards) {
            if (!c || c.type === 'container') continue;
            if (c.createdAt && (now - c.createdAt) > recentMs) continue;
            const ct = String(c.text || '').toLowerCase();
            if (!ct) continue;
            if (ver && ct.includes(ver[0])) return true;                            // version identity (high confidence)
            if (toks.length >= 3) { let hit = 0; for (const t of toks) if (ct.includes(t)) hit++; if (hit / toks.length >= 0.7) return true; }
        }
        return false;
    } catch { return false; }
}

// Read-path footer: OTHER live sessions' in-flight ship/version/milestone events
// (this project, last ~30min, not mine, not already in the brain, and — if the
// heartbeat store is readable — sender still active). Empty string when there's
// nothing, preserving the "solo session → zero added tokens" contract. Never throws.
function inflightFooter(sid, struct) {
    try {
        if (!fs.existsSync(LIVE_LEDGER)) return '';
        const raw = fs.readFileSync(LIVE_LEDGER, 'utf8');
        if (!raw) return '';
        const now = Date.now();
        const myCwd = normBrainPath(CWD);
        const seen = new Set();
        const ents = [];
        for (const ln of raw.split('\n')) {
            if (!ln) continue;
            let e; try { e = JSON.parse(ln); } catch { continue; }
            if (!e || !e.opId || !e.ts || !e.text) continue;
            if (e.sessionId === sid) continue;                                  // not mine
            if (normBrainPath(e.cwd || '') !== myCwd) continue;                  // this project only (cwd-exact, collision-proof)
            const t = Date.parse(e.ts); if (!Number.isFinite(t) || (now - t) > LIVE_WINDOW_MS) continue;
            if (seen.has(e.opId)) continue; seen.add(e.opId);                    // dedup by opId
            ents.push({ ...e, _t: t });
        }
        if (!ents.length) return '';
        // Prefer the heartbeat store (if readable) to CONFIRM the sender is still
        // active — but as a SOFT signal, never an exclusive gate: a session present
        // in the store is confirmed alive; an ABSENT one is kept while its event is
        // still fresh (< heartbeat grace). That covers both a session that shipped
        // via --live before its first heartbeat AND a recent crash (crash-safety),
        // while still dropping an absent+stale entry whose clear-on-Stop never ran.
        let activeIds = null;
        try { const alive = pruneSessions(readSessions(), now); if (alive.length) activeIds = new Set(alive.map(s => s.id)); } catch { /* unreadable → skip the liveness filter */ }
        let survivors = activeIds ? ents.filter(e => activeIds.has(e.sessionId) || (now - e._t) <= SESSION_FRESH_MS) : ents;
        survivors = survivors.filter(e => !representedInBrain(e.text, struct, now));   // drop anything a peer already folded into the brain
        if (!survivors.length) return '';
        survivors.sort((a, b) => b._t - a._t);
        const ago = (t) => { const m = Math.max(0, Math.round((now - t) / 60000)); return m <= 0 ? 'just now' : `${m}m ago`; };
        const lines = ['## ⚡ In-flight in other sessions (live — not yet in the brain)'];
        for (const e of survivors.slice(0, 6)) lines.push(`- ${ago(e._t)} · session ${String(e.sessionId).slice(0, 8)} · ${String(e.text).replace(/\s+/g, ' ').trim().slice(0, 140)}`);
        return '\n\n' + lines.join('\n');
    } catch { return ''; }
}

async function capture(lib) {
    const input = readHookInput();
    // Keep this session's coordination lane warm at every Stop (a turn ended; the
    // session lives on between turns). Files/ships are set after the transcript scan.
    touchSession(input.session_id, { branch: gitBranch() });
    const tp = input.transcript_path || '';
    if (!tp || !fs.existsSync(tp)) return;
    let lines; try { lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean); } catch { return; }
    const seen = readState();
    const cards = [];
    const resolutions = [];
    const updates = [];
    const ledger = [];   // one entry per marker decision (observability)
    const messages = [];                 // 🧠 MSG markers → posted to the per-project lane
    const sid = input.session_id || '';
    // Rolling set of the most-recently-touched file/dir tags (deduped, newest
    // last). A marker emitted after some edits gets tagged with the files that
    // work touched — captured by scanning EVERY entry's tool_use, not just the
    // marker turns (markers carry no tool_use of their own).
    const recentTags = [];
    const noteFiles = (paths) => {
        for (const p of paths) for (const tag of fileTagsFor(p)) {
            const i = recentTags.indexOf(tag); if (i >= 0) recentTags.splice(i, 1);
            recentTags.push(tag);
        }
        while (recentTags.length > 8) recentTags.shift();
    };
    const shellCmds = [];          // shell commands seen in the transcript (ship-event capture)
    const errorIds = new Set();    // tool_use ids whose result errored — skip those ship-events
    for (const ln of lines) {
        let e; try { e = JSON.parse(ln); } catch { continue; }
        noteFiles(filesInEntry(e));
        scanToolBlocks(e, shellCmds, errorIds);
        const text = textOf(e);
        if (!text.includes('🧠')) continue;
        for (const raw of text.split('\n')) {
            const trimmed = raw.trim();
            // 🧠 MSG [to]: text — an async note to another session (not a brain card).
            const mg = MSG_RE.exec(trimmed);
            if (mg) {
                const to = (mg[1] || '').trim();
                const txt = (mg[2] || '').trim();
                // Skip the feature's OWN documentation/examples, not a real note: a
                // placeholder target/text (<to>, <text>, <their-id…> — real targets are
                // id-prefixes/branches and never contain <>) or a marker quoted inside an
                // inline-code span (`…🧠 MSG…`, i.e. a backtick precedes the marker).
                const isExample = /[<>\s]/.test(to)   // real targets are ONE token (id/branch/all/*) — <>, spaces ⇒ a doc example
                    || /^\s*<[^>]+>/.test(txt)
                    || /`/.test(trimmed.slice(0, trimmed.indexOf('🧠')));
                if (txt && !isExample) messages.push({ id: sha(sid + '|' + txt + '|' + Date.now() + '|' + Math.random()), from: sid, to: to || 'all', text: txt.slice(0, 400), ts: Date.now(), seen: [] });
                continue;
            }
            const m = MARKER.exec(trimmed); if (!m) continue;
            const area = (m[1] || '').trim(), type = m[2] || '';
            let body = m[3].trim(); if (!body) continue;
            // Strip optional `closes:` / `ev:` suffixes off the body so they don't
            // leak into the card text; they drive the close-link + evidence below.
            const { body: cleanBody, closes, evidence } = splitMarkerSuffixes(body);
            body = cleanBody; if (!body) continue;
            const preview = body.slice(0, 90);
            // EXAMPLE/doc guard — rejects marker-SYNTAX documentation (which
            // once polluted the brain) WITHOUT dropping real decisions. Three
            // SHAPE tests, deliberately narrow (an over-broad "any backtick" /
            // "any <…>" rule silently ate ~12% of real code-heavy decisions —
            // names like `npm run build`, <TextItem>, Map<string,number>):
            //   • a placeholder-WORD in angle brackets (<decision>, <open question>);
            //   • the marker shown INSIDE a code span (a backtick before the 🧠);
            //   • a syntax-explanation arrow ("→ open question (amber)" etc).
            if (/<(open question|one-line decision|decision|area|placeholder|open|milestone)[^>]*>/i.test(body)
                || /`[^`]*🧠/.test(raw)
                || /→\s*\**(open question|milestone|decision|resolve|update)\b/i.test(body)) {
                ledger.push({ action: 'skipped-example', area, preview });
                continue;
            }
            // Dedup is for ADDITIVE markers only (decision / ? / !): re-capturing
            // one would stack a duplicate card. Type is in the key so a self-heal
            // ~ / ✓ on the SAME text isn't confused with the original decision.
            // The ~ (update / re-verify) and ✓ (resolve) markers are IDEMPOTENT on
            // an existing card, so they BYPASS dedup entirely — that's what lets the
            // self-heal loop re-stamp a drifted fact even when its text is unchanged.
            const additive = type !== '✓' && type !== '~';
            const key = sha((type + '|' + area + '|' + body).toLowerCase());
            if (additive) {
                if (seen.has(key)) { ledger.push({ action: 'skipped-seen', area, preview }); continue; }
                seen.add(key);
            }
            // ✓ resolves an EXISTING card (stamped ✅ + archived) — not a new card.
            if (type === '✓') { resolutions.push({ area, text: body }); ledger.push({ action: 'resolve', area, preview }); continue; }
            // ~ updates the matching card in place (small corrections).
            if (type === '~') { updates.push({ area, text: body, createdVia: 'claude-code', ...(evidence ? { evidence } : {}) }); ledger.push({ action: 'update', area, preview, ...(evidence ? { ev: evidence.map(e => e.ref) } : {}) }); continue; }
            // Type → scannable prefix + border color: ? open question (amber),
            // ! milestone (blue), + skill (violet), else decision (green). A plain
            // decision whose text reads as a reusable RULE is AUTO-promoted to a
            // 🛠️ skill — skills emerge from the project flow, not only the explicit
            // + marker. (Guarded on lib.looksLikeSkill for stale-lib safety.)
            const isSkill = type === '+' || (type === '' && typeof lib.looksLikeSkill === 'function' && lib.looksLikeSkill(body));
            const prefix = type === '?' ? '❓ ' : type === '!' ? '🏁 ' : isSkill ? '🛠️ ' : '';
            const borderColor = type === '?' ? 'rgba(245,166,35,0.8)' : type === '!' ? 'rgba(59,130,246,0.8)' : isSkill ? 'rgba(139,92,246,0.85)' : 'rgba(16,185,129,0.6)';
            // Tag line: the #area slug (existing) + up to the 4 most-recently-
            // touched #file-/#dir- tags so this decision is matchable by a later
            // git diff. Deduped against the area slug so it isn't repeated.
            const areaTag = area ? `#${slugify(area)}` : '';
            const fileTags = recentTags.slice(-4).filter(t => t !== areaTag);
            const tagLine = [areaTag, ...fileTags].filter(Boolean).join(' ');
            const card = (area ? `${area}: ${prefix}${body}` : `${prefix}${body}`) + (tagLine ? `\n${tagLine}` : '');
            cards.push({ text: card, area, borderColor, ...(closes ? { closes } : {}), ...(evidence ? { evidence } : {}) });
            ledger.push({ action: type === '?' ? 'add-question' : type === '!' ? 'add-milestone' : isSkill ? 'add-skill' : 'add-decision', area, preview, files: fileTags, ...(closes ? { closes } : {}), ...(evidence ? { ev: evidence.map(e => e.ref) } : {}) });
        }
    }
    postMessages(messages);   // deliver any 🧠 MSG notes to peers' lanes (even if no cards this turn)
    // Ship-event auto-capture: deterministic high-signal events (PR merges, releases,
    // npm publishes, tags) from SUCCESSFUL shell calls in the transcript — no marker
    // required (the gap a concurrent session hit: 3 releases + 6 PRs → zero cards).
    const shipSummaries = [];
    for (const { id, cmd } of shellCmds) {
        if (errorIds.has(id)) continue;                       // command failed → not a ship
        for (const p of SHIP_PATTERNS) {
            const mm = p.re.exec(cmd); if (!mm) continue;
            let detail = (mm[1] || '').trim();
            if (!detail && p.num) { const nm = p.num.exec(cmd); if (nm) detail = '#' + nm[1]; }   // pull the PR/issue number out separately
            const summary = `${p.kind}${detail ? ' ' + detail : ''}`;
            const key = sha(('ship|' + p.area + '|' + summary).toLowerCase());
            if (seen.has(key)) break;                         // already captured this ship
            seen.add(key);
            cards.push({ text: `${p.area}: 🏁 ${summary} — auto-captured (\`${cmd.replace(/\s+/g, ' ').trim().slice(0, 70)}\`)\n#${slugify(p.area)}`, area: p.area, borderColor: 'rgba(59,130,246,0.8)', createdVia: 'ship-event' });
            shipSummaries.push(summary);
            ledger.push({ action: 'ship-event', area: p.area, preview: summary });
            break;                                            // one pattern per command
        }
    }
    // Refresh this session's lane with what it ACTUALLY did — files it EDITED this
    // session (per-session, from the transcript; NOT the shared working-tree diff,
    // which is identical for two sessions in one repo) + recent ship-events, so a
    // peer sees "merged #244, edited foo.ts", not a degenerate shared diff.
    {
        const laneFiles = [...new Set(recentTags.filter(t => t.startsWith('#file-')).map(t => t.slice(6)))].filter(Boolean).slice(0, 12);
        touchSession(input.session_id, { branch: gitBranch(), files: laneFiles, ...(shipSummaries.length ? { ships: shipSummaries } : {}) });
    }
    // Commit-body auto-capture: rationale-bearing feat/fix/perf commits since
    // the last run (independent of markers), pushed into the SAME capture batch.
    const prevCommit = readLastCommit();
    const { cards: commitCards, newLastCommit } = await gatherCommitCards(prevCommit);
    for (const cc of commitCards) {
        // Auto-skill from the flow: a rule-stating commit ("fix: imports must stay
        // at top — TDZ") is a reusable gotcha, not a one-time event. Re-glyph it as a
        // 🛠️ skill so it resurfaces forever. Feats (🏁 milestones) are left as-is.
        if (typeof lib.looksLikeSkill === 'function' && !/🏁|🛠/.test(cc.text) && lib.looksLikeSkill(cc.text)) {
            cc.text = cc.text.replace(/^(\s*[^:\n]{1,40}:\s*)/, '$1🛠️ ');
            cc.borderColor = 'rgba(139,92,246,0.85)';
        }
        cards.push(cc);
        ledger.push({ action: /🛠/.test(cc.text) ? 'commit-skill' : 'commit', area: cc.area, preview: (cc.text.split('\n')[0] || '').slice(0, 90) });
    }
    // DRY-RUN: show exactly what WOULD be captured (and what was skipped, and
    // why) without touching the brain or the dedup state. The inspection seam
    // the audit asked for — `node global-brain-hook.mjs --capture --dry-run < hook.json`.
    if (DRY) {
        appendJsonl(LEDGER, { ts: nowIso(), mode: 'dry-run', would: { cards: cards.length, resolutions: resolutions.length, updates: updates.length }, decisions: ledger }, 1000);
        process.stderr.write(`[brain] DRY-RUN — would capture ${cards.length} card(s), ${resolutions.length} resolution(s), ${updates.length} update(s):\n`);
        for (const d of ledger) process.stderr.write(`  ${d.action}: ${d.area ? '[' + d.area + '] ' : ''}${d.preview}\n`);
        return;
    }
    if (!cards.length && !resolutions.length && !updates.length) {
        // Record the commit baseline / advance even with nothing to capture, so
        // the next run doesn't re-scan the same commits.
        if (newLastCommit && newLastCommit !== prevCommit) writeLastCommit(newLastCommit);
        // Nothing new — but if markers were SEEN-and-skipped or example-rejected,
        // record that so "the brief looks stale" has a paper trail.
        if (ledger.length) appendJsonl(LEDGER, { ts: nowIso(), mode: 'capture', stats: { added: 0 }, decisions: ledger }, 1000);
        return;
    }
    // Capture under a lock so concurrent sessions serialize. INSIDE the lock we
    // re-read the brain (build on whatever a peer just wrote, not a stale base)
    // and UNION the dedup state (don't clobber a peer's seen-set). captureInto-
    // Brain supersedes heavily-overlapping old cards, applies ✓/~, routes new
    // cards into [Area] containers, and wires [[wikilink]] connections.
    const gotLock = acquireLock(LOCK);
    let stats;
    try {
        const merged = readState(); for (const k of seen) merged.add(k);
        const res = await lib.captureIntoBrain(fs.readFileSync(BRAIN), {
            cards: cards.map(c => ({ text: c.text, color: '#e8e8ed', borderColor: c.borderColor, area: c.area, createdVia: c.createdVia || 'claude-code', ...(c.closes ? { closes: c.closes } : {}), ...(c.evidence ? { evidence: c.evidence } : {}) })),
            resolutions,
            updates,
        });
        stats = res.stats;
        // Re-pack the whole grid so a container that grew never overlaps its neighbor.
        let out = res.buffer; try { out = (await lib.tidyBrain(res.buffer)).buffer; } catch { /* keep append result if tidy fails */ }
        await lib.atomicWrite(BRAIN, out);
        writeState(merged);
        writeLastCommit(newLastCommit); // advance the commit baseline only after a successful write
        try { await refreshAgentsBrief(lib, out); } catch { /* AGENTS.md refresh is best-effort */ }
    } finally {
        if (gotLock) releaseLock(LOCK);
    }
    if (!gotLock) appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'capture', ok: false, err: 'lock-timeout — wrote best-effort' }, 500);
    const bits = [`${stats.added} added`];
    if (stats.resolved) bits.push(`${stats.resolved} resolved`);
    if (stats.updated) bits.push(`${stats.updated} updated`);
    if (stats.closed) bits.push(`${stats.closed} closed`);
    if (stats.superseded) bits.push(`${stats.superseded} superseded`);
    if (stats.linked) bits.push(`${stats.linked} linked`);
    process.stderr.write(`[brain] capture: ${bits.join(' · ')} → brain.klypix\n`);
    appendJsonl(LEDGER, { ts: nowIso(), mode: 'capture', stats, decisions: ledger }, 1000);
    appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'capture', ok: true, brainBytes: brainBytes(), added: stats.added, skipped: ledger.filter(d => d.action.startsWith('skipped')).length }, 500);
}

// Keep a compact brain-brief block inside AGENTS.md so agents that read
// AGENTS.md but run no hooks (Codex, Cursor, OpenCode, …) still get current
// project state — the ecosystem-widening half of "agent-neutral". Headlines
// only + rewritten ONLY when content actually changed, so git diffs stay
// quiet. We refresh an existing AGENTS.md, never create one (that's the
// 🧠 plug's job).
async function refreshAgentsBrief(lib, buffer) {
    const agentsPath = path.resolve(CWD, 'AGENTS.md');
    if (!fs.existsSync(agentsPath) || typeof lib.structToBrief !== 'function') return;
    const { struct } = await lib.parseKlypix(buffer);
    const brief = lib.structToBrief(struct, { recentDays: 7, maxRecent: 10, maxMilestones: 3, maxConnections: 5 }).trim();
    const START = '<!-- klypix-brain-brief:start -->', END = '<!-- klypix-brain-brief:end -->';
    const block = `${START}\n<!-- auto-refreshed by the brain hook on capture · headlines only · full cards via the klypix-canvas MCP -->\n${brief}\n${END}`;
    const txt = fs.readFileSync(agentsPath, 'utf8');
    const re = new RegExp(`${START}[\\s\\S]*?${END}`);
    const next = re.test(txt) ? txt.replace(re, block) : (txt.trimEnd() + '\n\n' + block + '\n');
    if (next !== txt) fs.writeFileSync(agentsPath, next, 'utf8');
}

// --- Task-aware retrieval (UserPromptSubmit, added 2026-06-15) -----------
// The SessionStart brief is query-blind — the same ~11KB every session. The
// ONE moment the task is actually known is the prompt; this mode reads it (+
// the current git diff), ranks the brain's cards against it with the shared
// scorer, and injects only the few that are RELEVANT (or nothing, costing zero
// tokens). That's the write→read relevance loop the audit identified as the
// real unbuilt frontier.
// Key the parse cache on the NORMALIZED path (same identity the registry uses)
// so a drive-case/separator flip reuses one cache file instead of orphaning a
// new one each run.
const CACHE = path.join(os.homedir(), '.claude', 'project-brain', `.brief-cache-${sha(normBrainPath(BRAIN))}.json`);
// Best-effort: keep the cache dir from accumulating orphaned brief-cache files
// (deleted/moved brains, old case-variants). Only runs on a cache MISS (rare),
// so it adds no per-prompt cost.
function pruneCacheDir(keep = 40) {
    try {
        const dir = path.join(os.homedir(), '.claude', 'project-brain');
        const files = fs.readdirSync(dir).filter(f => f.startsWith('.brief-cache-') && f.endsWith('.json'));
        if (files.length <= keep) return;
        files.map(f => { const p = path.join(dir, f); let m = 0; try { m = fs.statSync(p).mtimeMs; } catch { /* */ } return { p, m }; })
            .sort((a, b) => b.m - a.m).slice(keep).forEach(({ p }) => { try { fs.unlinkSync(p); } catch { /* */ } });
    } catch { /* best-effort */ }
}
// mtime-keyed parse cache so we don't unzip the brain on every prompt.
async function cachedStruct(lib) {
    let mtimeMs = 0; try { mtimeMs = fs.statSync(BRAIN).mtimeMs; } catch { /* */ }
    try { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (c && c.mtimeMs === mtimeMs && c.struct) return c.struct; } catch { /* miss */ }
    const { struct } = await lib.parseKlypix(fs.readFileSync(BRAIN));
    try { fs.writeFileSync(CACHE, JSON.stringify({ mtimeMs, struct })); pruneCacheDir(); } catch { /* cache is best-effort */ }
    return struct;
}
// Generic directory names anchor to a huge fraction of the brain, so they drown
// out the prompt's real intent — keep precise basenames, drop the generic dirs.
const GENERIC_DIRS = new Set(['src', 'app', 'lib', 'components', 'component', 'canvas', 'scripts', 'dist', 'build', 'public', 'tabs', 'interaction', 'items', 'hooks', 'utils', 'dashboard', 'core', 'api', 'test', 'tests', 'assets', 'styles', 'types', 'electron']);
// Tokens from a changed-file path, sluggified to MATCH the #file-/#dir- tag
// stems capture stamps on cards (so a git diff lands on the right decision).
function fileQueryTokens(p) {
    const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
    const base = slugify((parts.pop() || '').replace(/\.[a-z0-9]+$/i, ''));
    const dirs = parts.map(slugify).filter(s => s.length >= 3 && !GENERIC_DIRS.has(s));
    return [base, ...dirs].filter(s => s.length >= 3);
}
async function promptRetrieve(lib) {
    // Version-skew guard: if the live klypix-format.mjs is older than this hook
    // (the new exports missing), log a clean breadcrumb and no-op rather than
    // throwing into main().catch as a mislabeled failure.
    if (typeof lib.queryTokens !== 'function' || typeof lib.scoreCardsAgainstQuery !== 'function') {
        appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'prompt', ok: false, err: 'skew: missing query exports' }, 500);
        return;
    }
    const input = readHookInput();
    const sid = input.session_id;
    const prompt = input.prompt || input.user_prompt || input.userPrompt || '';
    const ptoks = lib.queryTokens(prompt);
    // Git diff is the retrieval FALLBACK for a prompt too terse to rank on. It is
    // NOT used for the lane's files: two sessions in one repo share a working tree,
    // so the diff is identical for both — the lane's files come from each session's
    // OWN edits (set at Stop). Here we just refresh INTENT + branch + the heartbeat.
    const changedPaths = gitChangedPaths();
    const branch = gitBranch();
    touchSession(sid, { intent: String(prompt).replace(/\s+/g, ' ').trim().slice(0, 80), branch });
    const fileToks = ptoks.length < 2 ? changedPaths.flatMap(fileQueryTokens) : [];
    const tokens = [...new Set(ptoks.concat(fileToks))];
    // Other live sessions in THIS repo — surfaced even when the prompt retrieves
    // nothing (a peer's presence/ship is itself the signal). Empty string when solo.
    const peers = peerFooter(sid);
    const messages = messageFooter(sid);   // 📨 deliberate notes another session left for me (delivered once)
    let hits = [], repeats = [], struct = null;
    if (tokens.length) {
        struct = await cachedStruct(lib);
        hits = lib.scoreCardsAgainstQuery(struct, tokens, { topK: 5, minScore: 3 });
        // PRECISION-first repeat nudge ("you already did this in another session"):
        // only on a do/build request, only completed-work cards, only high confidence.
        // Matched on the PROMPT's stated intent (ptoks), not the git-diff fallback. A
        // false nudge erodes trust, so it's strict; the loose recall list still shows.
        if (looksLikeWorkRequest(prompt) && typeof lib.detectRepeatWork === 'function') {
            try { repeats = lib.detectRepeatWork(struct, ptoks, { topK: 2 }); } catch { /* best-effort */ }
        }
    }
    const repeatIds = new Set(repeats.map(r => r.card.id));
    let freshHits = hits.filter(h => !repeatIds.has(h.card.id));
    // SEMANTIC fallback — runs ONLY on a lexical MISS (paraphrase / no keyword
    // overlap, where you'd otherwise get zero recall). Gated behind the OPTIONAL
    // on-device model, timeout-bounded (~1.2s), READ-ONLY (never embeds cards in
    // this one-shot process — that's a 10s–195s stall). The common lexical-HIT
    // prompt never enters this lane → zero added latency. Bulletproof: not installed
    // / timeout / any failure → stays exactly today's pure-lexical behavior. The
    // helper is optional+deploy-gated, so a missing copy degrades cleanly to lexical.
    let semMode = 'lexical';
    if (!repeats.length && !freshHits.length && tokens.length && struct) {
        try {
            const semlib = await import(new URL('./brain-semantic.mjs', import.meta.url).href);
            if (typeof semlib.semanticVecs === 'function') {
                const sem = await semlib.semanticVecs(BRAIN, struct, prompt, { timeoutMs: 1500 });
                if (!sem) semMode = 'sem-unavailable';
                else {
                    const fresh = Date.now() - 30 * 86_400_000;
                    const ranked = struct.cards
                        .filter(c => c.type !== 'container' && (c.text || '').trim() && !/^archive$/i.test(c.area || ''))
                        .map(c => { const v = sem.vecsMap.get(c.id); return { card: c, s: v ? sem.dot(sem.qv, v) : null }; })
                        .filter(x => x.s != null && x.s >= 0.30)   // miss-path floor: no lexical corroboration, so demand a real match
                        .map(x => { let score = x.s * 10; if ((x.card.createdAt || 0) >= fresh) score += 0.5; return { card: x.card, score }; })
                        .sort((a, b) => b.score - a.score).slice(0, 5);
                    freshHits = ranked;
                    semMode = ranked.length ? 'sem-hit' : 'sem-empty';
                }
            }
        } catch { semMode = 'sem-error'; }
        if (semMode !== 'lexical') { try { appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'prompt', sem: semMode, hits: freshHits.length }, 500); } catch { /* */ } }
    }
    // Other live sessions' in-flight events (struct may be null on a token-less
    // prompt — then representedInBrain just keeps entries; they're rarely in-brain yet).
    const inflight = inflightFooter(sid, struct);
    if (!repeats.length && !freshHits.length && !peers && !inflight && !messages) return; // nothing → zero output, zero added context
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const day = (ts) => ts ? new Date(ts).toISOString().slice(0, 10) : '';
    const head = (c, n = 120) => { const t = flat(c.text); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    const lines = [];
    if (repeats.length) {
        lines.push('## ⚠️ Possible repeat — this may already be done (reuse/supersede, don’t silently redo)');
        for (const r of repeats) {
            const verb = r.kind === 'superseded'
                ? `you moved OFF this ${day(r.card.createdAt)} — check what replaced it before redoing`
                : `already ${r.kind} ${day(r.card.createdAt)} — reuse/build on it, or supersede it deliberately`;
            lines.push(`- [${flat(r.card.area) || '?'}] ${head(r.card)}  · ${verb}`);
        }
        lines.push('Read the matching card (klypix-canvas MCP / brain) BEFORE redoing. Other project? use search_all_brains.');
    }
    if (freshHits.length) {
        lines.push(semMode === 'sem-hit'
            ? "# Related prior decisions (semantic match — no exact keyword overlap; full brain via the klypix-canvas MCP)"
            : "# Relevant prior decisions from this project's brain (task-matched; full brain via the klypix-canvas MCP)");
        for (const h of freshHits) lines.push(`- ${flat(h.card.text)}`);
    }
    const parts = [];
    if (lines.length) parts.push(lines.join('\n'));
    if (inflight) parts.push(inflight.replace(/^\n+/, '')); // ⚡ in-flight peers' events (its own block)
    if (peers) parts.push(peers.replace(/^\n+/, '')); // live-session presence footer (its own block)
    if (messages) parts.push(messages.replace(/^\n+/, '')); // 📨 inbound deliberate peer notes
    process.stdout.write(parts.join('\n\n') + '\n'); // UserPromptSubmit injects stdout as context
}

// Is the prompt a DO/BUILD request (worth a repeat-nudge), vs a question/chat?
// Conservative: questions and "what did we…" recall prompts are EXCLUDED (there,
// surfacing the card is the ANSWER, not a redo-warning). Fires only on a clear
// work verb. Keeping this strict is the whole point — the nudge must not cry wolf.
function looksLikeWorkRequest(p) {
    const s = String(p || '').trim().toLowerCase();
    if (!s || /\?\s*$/.test(s)) return false;
    if (/^(what|why|how|when|where|who|which|is|are|was|were|do|does|did|can|could|should|would|explain|tell me|show me|wonder|remind)\b/.test(s)) return false;
    return /\b(build|implement|add|create|make|write|fix|refactor|ship|publish|set ?up|wire|integrate|generate|design|develop|rebuild|redo|update|migrate|port|rename|delete|remove|deploy|release|do the|let'?s)\b/.test(s);
}

// Read-side cross-link to a *sibling* memory store. Claude Code keeps per-user
// project notes at ~/.claude/projects/<encoded-cwd>/memory/ (prefs, feedback,
// session logs) — a different store than this spatial brain. When that dir
// exists we surface ONE pointer in the brief so the agent treats the two as
// complementary (brain = project decisions & open questions; memory = how to
// work with THIS user) instead of duplicating one into the other. Best-effort:
// a wrong path guess simply finds nothing and emits nothing — never throws.
function memoryFooter() {
    try {
        const encoded = String(CWD).replace(/^[A-Za-z]:/, m => m.toLowerCase()).replace(/[\\/:]/g, '-');
        const dir = path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');
        if (!fs.existsSync(dir)) return '';
        const notes = fs.readdirSync(dir).filter(f => /\.md$/i.test(f) && f.toLowerCase() !== 'memory.md');
        if (!notes.length) return '';
        const hasIndex = fs.existsSync(path.join(dir, 'MEMORY.md'));
        return `\n\n---\n📎 **Sibling memory store** — ${notes.length} note(s) at \`${dir}\`${hasIndex ? ' (index: MEMORY.md)' : ''}.\n`
            + `Holds how to work with *this user* (prefs, feedback, session logs); the brain above holds *project* decisions & open questions. Reconcile across both — don't duplicate one into the other.\n`;
    } catch { return ''; }
}

// ── Brain self-check — surface the brain's OWN failures (so it's not silent) ──
// The hook is bulletproof-by-contract: it swallows every error and exits 0, so a
// genuinely broken capture / retrieval is otherwise INVISIBLE — you'd only notice
// by missing cards. This reads the HEALTH log and, if this project's most-recent
// capture / prompt / read run FAILED, says so in the brief so the next session
// knows the brain may be silently dropping work. Also flags a DIRTY deploy (the
// live hook running uncommitted code) via the deploy stamp. Best-effort, never
// throws. Closes the audited gap "silent-failure detection is pull-only".
function selfCheckFooter() {
    try {
        const probs = [];
        // (1) most-recent FAILED run per mode for THIS project, from the HEALTH log.
        if (fs.existsSync(HEALTH)) {
            const proj = path.basename(CWD);
            const mine = [];
            for (const ln of fs.readFileSync(HEALTH, 'utf8').split('\n').slice(-400)) {
                if (!ln) continue; try { const o = JSON.parse(ln); if (o.project === proj) mine.push(o); } catch { /* skip */ }
            }
            const latest = (mode) => { for (let i = mine.length - 1; i >= 0; i--) if (mine[i].mode === mode) return mine[i]; return null; };
            // Surface a mode's failure only if its latest run is ok:false AND RECENT.
            // Recency matters because some modes (notably 'prompt') never write an
            // ok:true success heartbeat — only ok:false on version-skew — so without a
            // time bound a single stale failure would cry-wolf in every future brief.
            // A still-broken mode logs a fresh ok:false each run and surfaces; a
            // long-fixed one ages out. Missing/unparseable ts → stay silent.
            const RECENT_MS = 3 * 86_400_000, nowMs = Date.now();
            for (const [mode, label] of [['capture', 'capture (decisions may be lost)'], ['prompt', 'per-prompt recall'], ['read', 'session brief']]) {
                const e = latest(mode);
                if (!e || e.ok !== false) continue;
                const ts = e.ts ? Date.parse(e.ts) : NaN;
                if (Number.isFinite(ts) && (nowMs - ts) < RECENT_MS) probs.push(`${label} FAILED — ${e.err || 'unknown'} (${e.ts})`);
            }
        }
        // (2) DIRTY deploy — the live hook is running uncommitted code (audit: the
        // dogfooding brain shouldn't run unreviewed logic). Stamped by deploy-brain.mjs.
        try {
            const stamp = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'project-brain', '.brain-version.json'), 'utf8'));
            if (stamp && stamp.dirty) probs.push(`running a DIRTY deploy — uncommitted hook code (source ${stamp.sourceSha || '?'}); commit + \`node scripts/deploy-brain.mjs\` for an auditable brain`);
        } catch { /* no stamp → deployed the old way; stay silent */ }
        if (!probs.length) return '';
        return '\n\n---\n## ⚠️ Brain self-check — the brain reported a problem with ITSELF\n'
            + 'The hook exits 0 by contract, so this is otherwise invisible (you\'d only notice by missing cards):\n'
            + probs.map(p => `- ${p}`).join('\n')
            + `\n_Log: \`~/.claude/project-brain/.hook-health.jsonl\`. Re-deploy with \`node scripts/deploy-brain.mjs\`._\n`;
    } catch { return ''; }
}

// ── Self-healing brain (decision lifecycle, part 5) ──────────────────────────
// Open ❓/🎯 cards a later shipped 🏁 milestone appears to have fulfilled —
// surfaced so the agent CLOSES them (✓ / closes:) instead of recall surfacing
// already-done goals as "next". Never auto-archives (precision-first; the human
// confirms). Version-skew guarded like the migration footer.
function staleOpenFooter(lib, struct) {
    try {
        if (typeof lib.findStaleOpenCards !== 'function') return '';   // version-skew guard (stale live klypix-format)
        const { gaps, total } = lib.findStaleOpenCards(struct, { max: 5 });
        if (!gaps || !gaps.length) return '';
        const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const lines = ['', '---',
            `## 🔧 Self-heal — ${total} open card(s) look DONE (a later milestone covers them)`,
            `These ❓/🎯 cards still read as open, but a shipped 🏁 milestone appears to fulfil them — so recall keeps surfacing already-done goals as "next". Confirm + close each:`,
            '· done → `🧠 BRAIN [Area] ✓: <what it resolved to>` — stamps ✅ + archives the open card (or add `closes: <its title>` to the milestone marker).',
        ];
        for (const g of gaps) lines.push(`- ⚠️ [${flat(g.open.area) || '?'}] ${flat(g.open.text).slice(0, 90)}  ·  likely closed by → ${flat(g.by.text).slice(0, 70)}`);
        return '\n' + lines.join('\n') + '\n';
    } catch { return ''; }
}

// The capture-marker LEGEND — surfaced in EVERY session brief so the contract is
// standing context, not tribal knowledge. The basic 🧠 BRAIN [Area]: form is in
// SKILL.md/CLAUDE.md, but the ?/!/✓/~ glyphs + closes:/ev: suffixes only reached
// the agent reactively (a self-heal footer) before this.
function legendFooter() {
    return '\n\n---\n'
        + '🧠 **Capture markers** — write these in your reply; the Stop hook harvests them into the brain (no separate log step). Use sparingly, for real decisions / milestones / discoveries:\n'
        + '`🧠 BRAIN [Area]: decision` · `[Area] ?: open question` · `[Area] !: milestone` · `[Area] +: 🛠️ skill (reusable how-to / gotcha — resurfaces every session, never ages out)` · `[Area] ✓: resolves+archives the matching card` · `[Area] ~: updates it in place` · 🎯 in text = a goal (reads as open).\n'
        + 'Optional suffixes: `closes: <card title / [[wikilink]]>` (resolve the strategy/question this fulfils) · `ev: <file[:line]>, PR#<n>` (anchor to code → auto drift-badge).\n'
        + 'Coordinate with a concurrent session: `🧠 MSG [<their-id or all>]: <text>` — a one-time note (NOT a brain card) delivered to that session on its next prompt.\n';
}

async function read(lib) {
    const input = readHookInput();
    // Register presence at session start so a peer already running sees this session
    // immediately. Files/ships come from Stop (what this session actually edits).
    touchSession(input.session_id, { branch: gitBranch() });
    const { struct } = await lib.parseKlypix(fs.readFileSync(BRAIN));
    // Default = TIERED brief (open questions + recent + area map) so the
    // session-start cost stays flat as the brain grows. --full = everything.
    const { freshness, drifted } = computeFreshness(struct);
    const outStr = (!process.argv.includes('--full') && typeof lib.structToBrief === 'function')
        ? lib.structToBrief(struct, { freshness })
        : lib.structToMarkdown(struct);
    // ⚡ In-flight footer goes RIGHT AFTER the brief (highest signal: what a peer
    // shipped seconds ago, before it's in the brain) — closes the 1.3.17-blindness gap.
    process.stdout.write(outStr + inflightFooter(input.session_id, struct) + selfHealFooter(drifted) + reconcileFooter(lib, struct) + staleOpenFooter(lib, struct) + selfCheckFooter() + messageFooter(input.session_id || '') + legendFooter() + memoryFooter());
    // Heartbeat: prove the brief actually injected (and how big) so a dead or
    // stale live-copy of the hook stops being a silent no-op.
    appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'read', ok: true, briefBytes: Buffer.byteLength(outStr), cards: struct?.counts?.cards ?? null }, 500);
}

// Registry of every brain this machine has touched — written on each hook run,
// read by the MCP's search_all_brains for vault-wide, cross-project memory
// ("what did I decide about auth — in ANY project?"). Zero-config data gravity:
// just having worked in a brain project makes it searchable. Never throws.
function registerBrain() {
    try {
        const dir = path.join(os.homedir(), '.claude', 'project-brain');
        const reg = path.join(dir, 'registry.json');
        fs.mkdirSync(dir, { recursive: true });
        let data = { brains: [] };
        try { data = JSON.parse(fs.readFileSync(reg, 'utf8')); } catch { /* fresh */ }
        if (!Array.isArray(data.brains)) data.brains = [];
        const norm = normBrainPath(BRAIN);
        // Collapse pre-existing case-variant duplicates by normalized key,
        // keeping the newest lastSeen — so the registry self-heals on next run.
        const byKey = new Map();
        for (const b of data.brains) {
            if (!b || !b.path) continue;
            const k = normBrainPath(b.path);
            const prev = byKey.get(k);
            const merged = { ...(prev || {}), ...b, path: k };
            if (!prev || (merged.lastSeen || 0) >= (prev.lastSeen || 0)) byKey.set(k, merged);
        }
        byKey.set(norm, { ...(byKey.get(norm) || {}), path: norm, project: path.basename(CWD), lastSeen: Date.now() });
        data.brains = [...byKey.values()].filter(b => { try { return fs.existsSync(b.path); } catch { return false; } }).slice(-200);
        fs.writeFileSync(reg, JSON.stringify(data, null, 2));
    } catch { /* registry is best-effort */ }
}

async function main() {
    if (!fs.existsSync(BRAIN)) return;                  // not a brain project → instant no-op
    // --live (PostToolUse) is the cheapest mode: pure payload string-work + at most
    // one tiny locked append. It must NOT pay the lazy klypix-format import, so it
    // runs BEFORE everything else and returns. (Fires on Bash|PowerShell|Edit|Write.)
    if (process.argv.includes('--live')) { liveCapture(); return; }
    const lib = await import('./klypix-format.mjs');    // lazy: only when a brain exists
    // Per-prompt retrieval runs on EVERY prompt — skip the registry write and
    // go straight to the (mtime-cached) ranked lookup to keep it cheap.
    if (process.argv.includes('--prompt')) { await promptRetrieve(lib); return; }
    registerBrain();
    if (process.argv.includes('--capture')) {
        // Stop = fold-in + clear: capture() writes this turn's markers/ships into the
        // brain, then we drop this session's now-durable in-flight ledger entries.
        // try/finally so the clear runs across capture()'s early returns AND a throw
        // (on throw, ship/milestone re-capture next Stop; a version is on disk — no loss).
        try { await capture(lib); } finally { clearLiveLedgerForSession(readHookInput().session_id); }
    } else await read(lib);
}
main().catch((e) => {
    // The whole point of the observability work: a real failure (missing jszip
    // at the live path, unreadable transcript, corrupt brain) used to vanish
    // here. Now it leaves a breadcrumb — without breaking the never-throw,
    // always-exit-0 contract.
    try {
        const mode = process.argv.includes('--prompt') ? 'prompt' : process.argv.includes('--capture') ? 'capture' : 'read';
        appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode, ok: false, err: String((e && e.message) || e).slice(0, 200) }, 500);
    } catch { /* even the breadcrumb is best-effort */ }
}).finally(() => process.exit(0));
