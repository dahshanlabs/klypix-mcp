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
import https from 'https';
import { execFileSync, execSync, spawn } from 'child_process';

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
//                · verify: <command> — the exact live-probe for a fast-decay
//                  status claim (build/deploy/release state). Once the claim is
//                  stale, the status renderer re-prints it as "VERIFY: <cmd>"
//                  instead of asserting the claim as current. Emit PS-5.1-safe
//                  commands (no && chaining; use `;` or separate lines).
const MARKER = /🧠\s*BRAIN\s*(?:\[([^\]]+)\])?\s*([?!✓~+]?)\s*:\s*(.+)$/i;
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
// Numeric semver compare (major.minor.patch; pre-release tags ignored). <0 if
// a<b, 0 equal, >0 if a>b. Shared by the version-currency footer below.
const cmpSemver = (a, b) => { const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); } return 0; };

// ── Evidence anchors + close-links (decision lifecycle) ──────────────────────
// `git rev-parse HEAD:<path>` → the file's blob OID at HEAD (stable across
// uncommitted edits; changes only when the committed content does). Used to
// STAMP a card's evidence at capture and to DETECT drift at read. Best-effort.
// Evidence refs may carry :line/:column or #Lline suffixes, and Codex commonly
// emits absolute Windows paths. Normalize those without splitting the drive
// colon, reject paths outside this repository, and pass argv directly to git so
// an evidence string can never become shell syntax.
function evidenceGitPath(ref) {
    let clean = String(ref || '').trim().replace(/^`|`$/g, '');
    clean = clean.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '').trim();
    if (!clean) return null;
    if (path.isAbsolute(clean)) {
        const rel = path.relative(CWD, path.resolve(clean));
        if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
        clean = rel;
    }
    clean = clean.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!clean || clean === '..' || clean.startsWith('../')) return null;
    return clean;
}
function gitBlobOid(relPath) {
    try {
        const clean = evidenceGitPath(relPath);
        if (!clean) return null;
        const oid = execFileSync('git', ['rev-parse', `HEAD:${clean}`], { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).trim();
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
// Pull optional `closes:` / `ev:` / `verify:` suffixes off the END of a marker
// body (any order), returning the cleaned body + parsed extras. The suffix
// region starts at the first known key, so a decision can carry none, any, or
// all without the keywords leaking into the card text. The three value regexes
// must stay in LOCKSTEP: each value ends at the NEXT known key (or end of
// line), so omitting a key from one lookahead silently folds "verify: …" into
// that key's value — parseEvidence would mint junk file refs from it.
function splitMarkerSuffixes(body) {
    const m = body.match(/\s+(?:closes|ev|verify):/i);
    if (!m) return { body, closes: '', evidence: null, verify: '' };
    const suffix = body.slice(m.index);
    const closesM = suffix.match(/\bcloses:\s*(.+?)\s*(?=\s+\bev:|\s+\bverify:|$)/i);
    const evM = suffix.match(/\bev:\s*(.+?)\s*(?=\s+\bcloses:|\s+\bverify:|$)/i);
    const verifyM = suffix.match(/\bverify:\s*(.+?)\s*(?=\s+\bcloses:|\s+\bev:|$)/i);
    return {
        body: body.slice(0, m.index).trim(),
        closes: closesM ? closesM[1].trim() : '',
        evidence: evM ? parseEvidence(evM[1].trim()) : null,
        verify: verifyM ? verifyM[1].trim().slice(0, 200) : '',
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
            const missingRefs = [];
            for (const ev of fileRefs) {
                const clean = evidenceGitPath(ev.ref);
                const cacheKey = clean || `invalid:${ev.ref}`;
                if (!oidCache.has(cacheKey)) oidCache.set(cacheKey, clean ? gitBlobOid(clean) : null);
                const cur = oidCache.get(cacheKey);
                if (!cur) { isDrift = true; missingRefs.push(ev.ref); }
                else if (cur !== ev.oid) isDrift = true;
            }
            if (isDrift) {
                freshness[c.id] = missingRefs.length ? '⚠️ missing' : '⚠️';
                drifted.push({ area: c.area, text: c.text, refs: fileRefs.map(e => e.ref), missingRefs });
            }
            else freshness[c.id] = '✅';
        }
    } catch { /* best-effort */ }
    return { freshness, drifted };
}
function selfHealFooter(drifted) {
    if (!drifted || !drifted.length) return '';
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const lines = ['', '---',
        `## 🔧 Self-heal — ${drifted.length} fact(s) cite code that CHANGED or went MISSING; re-verify before trusting them`,
        `For each below: re-read the cited file, decide, then emit ONE marker (the human approves the change in chat):`,
        '· still true → `🧠 BRAIN [Area] ~: <same claim> ev: <file>` — re-stamps it ✅ fresh',
        '· now wrong → `🧠 BRAIN [Area] ~: <corrected claim> ev: <file>` — rewrites + re-stamps',
        '· obsolete → `🧠 BRAIN [Area] ✓: <what it resolved to>` — closes + archives',
    ];
    for (const d of drifted.slice(0, 8)) lines.push(`- ⚠️${d.missingRefs?.length ? ' missing' : ''} [${d.area || '?'}] ${flat(d.text).slice(0, 110)}  ·  cites \`${d.refs.join(', ')}\``);
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
// npm-currency cache — the Stop hook refreshes this at most once/day (best-effort,
// failure-silent); the SessionStart footer reads ONLY this file (zero network) to
// surface a stale install. {pkg, latest, checkedAt, lastError?}.
const NPM_CURRENCY = path.join(os.homedir(), '.claude', 'project-brain', '.npm-currency.json');
const NPM_CURRENCY_TTL = 24 * 60 * 60 * 1000;   // ≤ once/day refresh throttle
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
// Lane key: canonicalize (on-disk casing + symlinks) BEFORE hashing, so an MCP
// server that resolved the SAME brain via a differently-cased cwd / KLYPIX_BRAIN
// lands in the SAME lane file — klypix-core.mjs laneFileFor mirrors this exactly.
const laneCanon = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const SESSIONS_FILE = path.join(SESSIONS_DIR, `${sha(normBrainPath(laneCanon(BRAIN)))}.json`); // one lane-file per PROJECT (shared by its concurrent sessions)
const SESSIONS_LOCK = SESSIONS_FILE + '.lock';
// tmp+rename: lock-free readers must never parse a torn lane as an empty one.
// Windows rename-over-open-destination throws EPERM (AV / a concurrent reader):
// one immediate retry wins the race; on final failure the tmp is removed before
// rethrowing so failures can't litter the sessions dir (field: dozens of
// orphaned tmp files, 2026-08-07). A throttled janitor sweeps pre-fix orphans.
function writeLaneAtomic(payload) {
    const tmp = SESSIONS_FILE + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(tmp, payload);
    try { fs.renameSync(tmp, SESSIONS_FILE); }
    catch (err) {
        try { fs.renameSync(tmp, SESSIONS_FILE); }
        catch { try { fs.unlinkSync(tmp); } catch { /* best-effort */ } throw err; }
    }
    sweepStaleTmp(SESSIONS_DIR);
}
// PARITY: same throttle/age/pattern contract as agent-presence.mjs
// sweepStaleTmpFiles() — duplicated because this hook stays free of sibling
// static imports by design (a broken sibling must never kill the brief).
let lastTmpSweep = 0;
function sweepStaleTmp(dir) {
    const now = Date.now();
    if (now - lastTmpSweep < 10 * 60 * 1000) return;
    lastTmpSweep = now;
    try {
        for (const name of fs.readdirSync(dir)) {
            if (!/\.tmp-\d+(?:-[a-z0-9]+)?$|\.\d+\.tmp$/.test(name)) continue;
            const full = path.join(dir, name);
            try { if (now - fs.statSync(full).mtimeMs > 15 * 60 * 1000) fs.unlinkSync(full); }
            catch { /* raced or locked — next sweep */ }
        }
    } catch { /* dir unreadable — best-effort */ }
}
// Pending-captures queue: when the BRAIN lock cannot be acquired, the batch is
// queued here durably instead of written from a stale base (a best-effort write
// could erase a peer's or the desktop app's just-merged cards — the exact lost
// update this lock exists to prevent). Drained under the lock by the NEXT
// capture in this project, from any session. Ids let a re-refused capture
// replace only what it drained, so a batch a peer queued meanwhile survives.
const PENDING_CAPTURES_FILE = path.join(os.homedir(), '.claude', 'project-brain', 'pending', `${sha(normBrainPath(laneCanon(BRAIN)))}.captures.json`);
const PENDING_CAPTURES_LOCK = PENDING_CAPTURES_FILE + '.lock';
function readPendingCaptures() {
    try { const d = JSON.parse(fs.readFileSync(PENDING_CAPTURES_FILE, 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; }
}
function updatePendingCaptures(mutate) {
    const got = acquireLock(PENDING_CAPTURES_LOCK, { tries: 20, waitMs: 25 });
    try {
        const next = mutate(readPendingCaptures());
        fs.mkdirSync(path.dirname(PENDING_CAPTURES_FILE), { recursive: true });
        const tmp = PENDING_CAPTURES_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(next));
        fs.renameSync(tmp, PENDING_CAPTURES_FILE);
    } catch { /* never break the session; the transcript markers remain the fallback */ }
    finally { if (got) releaseLock(PENDING_CAPTURES_LOCK); }
}
const SESSION_FRESH_MS = 10 * 60 * 1000;   // a lane unseen for 10min is treated as ended
const MCP_SESSION_FRESH_MS = 3 * 60 * 1000; // an mcp-channel heartbeat is dead after 3min (matches agent-presence)
// The host CLI's pid (Claude Code exports CLAUDE_PID to every child, including
// this hook AND the MCP server it spawns): the correlation key that lets the two
// halves of ONE logical session — the lifecycle row and the mcp row — recognize
// each other instead of rendering as independent peers (2026-07-29 audit).
const HOST_PID = Number(process.env.CLAUDE_PID || 0) > 0 ? Number(process.env.CLAUDE_PID) : null;
// NOTE: deliberately NOT *.json — several consumers glob the sessions dir for
// lane files and would choke on a hostmap's different shape (same convention
// as the .lock sibling).
const HOSTMAP_FILE = SESSIONS_FILE.replace(/\.json$/, '.hostmap');
const safeGit = (args, timeout = 1500) => { try { return execSync(`git ${args}`, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }); } catch { return ''; } };
const gitBranch = () => { const b = safeGit('rev-parse --abbrev-ref HEAD', 1000).trim(); return b && b !== 'HEAD' ? b : null; };
const gitChangedPaths = () => safeGit('diff --name-only HEAD').split('\n').map(s => s.trim()).filter(Boolean);
const fileSlug = (p) => slugify(String(p).replace(/\\/g, '/').split('/').pop().replace(/\.[a-z0-9]+$/i, ''));
const changedToSlugs = (paths) => [...new Set(paths.map(fileSlug).filter(s => s.length >= 3))].slice(0, 12);
// A tool-touched path → project-relative form (forward slashes), or null when it
// falls outside this project. The lane's files[] carries THESE (interoperable
// with Codex/brain_sync overlap detection) — slugs are only for card #file- tags.
const projRelPath = (p) => {
    try {
        const abs = path.resolve(CWD, String(p || ''));
        const rel = path.relative(CWD, abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
        return rel.replace(/\\/g, '/');
    } catch { return null; }
};
const readSessions = () => { try { const d = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); return Array.isArray(d.sessions) ? d.sessions : []; } catch { return []; } };
// Channel-aware prune, mirroring agent-presence.mjs pruneSessions: an mcp-only
// row whose heartbeat stopped 3min ago is DEAD even though the flat 10-minute
// window would keep it — the hook, brain_sync, and doctor previously disagreed
// on what "live" means (three different counts for one lane).
const freshChannelSeen = (channelSeen, now) => {
    if (!channelSeen || typeof channelSeen !== 'object' || Array.isArray(channelSeen)) return {};
    return Object.fromEntries(Object.entries(channelSeen)
        .filter(([ch, seen]) => ch && now - Number(seen || 0) < (ch === 'mcp' ? MCP_SESSION_FRESH_MS : SESSION_FRESH_MS)));
};
const pruneSessions = (list, now) => {
    const out = [];
    for (const s of (Array.isArray(list) ? list : [])) {
        if (!s || !s.id) continue;
        const hadChannels = s.channelSeen && typeof s.channelSeen === 'object' && !Array.isArray(s.channelSeen) && Object.keys(s.channelSeen).length > 0;
        const channelSeen = freshChannelSeen(s.channelSeen, now);
        const seenValues = Object.values(channelSeen).map(Number).filter(Number.isFinite);
        const lastSeen = seenValues.length ? Math.max(...seenValues) : Number(s.lastSeen || 0);
        if ((hadChannels && !seenValues.length) || now - lastSeen >= SESSION_FRESH_MS) continue;
        out.push({ ...s, ...(hadChannels ? { channelSeen, channels: Object.keys(channelSeen) } : {}), lastSeen });
    }
    return out;
};
// Upsert THIS session's lane. Best-effort + never-throw: a missing session_id, a
// lock-timeout, or a write error just skips coordination for this turn (a dropped
// heartbeat is harmless — the next event re-registers it).
// SCHEMA PARITY: this writer and agent-presence.mjs upsertSession() write the
// SAME row shape (client/surface/cwd/hostPid/channelSeen/intentAt/intentSource) —
// `...prev` first so either writer's fields survive the other's touch (T8 class).

// ── Machine-turn intent guard (BEHAVIOR PARITY with agent-presence.mjs
// deriveIntentFromPrompt — duplicated because this hook stays free of sibling
// static imports; test/intent-guard.mjs asserts both stay identical) ─────────
// UserPromptSubmit is not only human-typed text: harnesses inject task
// notifications, system reminders and slash-command wrappers as "user" prompts,
// and one stored verbatim became a session's declared intent
// ("<task-notification> <task-id>…" — 2026-08-07 AgentLit field incident).
// null ⇒ the turn is machine-generated: KEEP the previous intent (still stamp
// activity), never store the junk, never clear a good intent.
const MACHINE_TAGS = 'task-notification|system-reminder|system-warning|local-command-caveat'
    + '|command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr'
    + '|ide_selection|ide_opened_file|ide_diagnostics|persisted-output|tool-use-error'
    + '|session-start-hook|user-prompt-submit-hook|post-tool-use-hook|hook-[a-z0-9-]+';
const MACHINE_BLOCK_RE = new RegExp(
    '^(?:<(' + MACHINE_TAGS + ')\\b[^>]*>[\\s\\S]*?(?:</\\1>|$)|\\[SYSTEM NOTIFICATION[^\\]]*\\])\\s*', 'i');
const TAG_SHAPED_RE = /^<[a-z][\w.:-]*(?:\s|\/?>)/i;
function deriveIntentFromPrompt(raw) {
    let text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    // A "[SYSTEM NOTIFICATION …]"-led turn is machine end to end — the prose
    // after the bracket header is harness narration, never the user's intent.
    if (/^\[SYSTEM NOTIFICATION/i.test(text)) return null;
    for (let hops = 0; hops < 12; hops++) {
        const m = MACHINE_BLOCK_RE.exec(text);
        if (!m) break;
        text = text.slice(m[0].length).trim();
    }
    if (!text || TAG_SHAPED_RE.test(text)) return null;
    return text;
}

function touchSession(sid, patch = {}) {
    if (!sid) return;
    try {
        const now = Date.now();
        const got = acquireLock(SESSIONS_LOCK, { tries: 20, waitMs: 25 });   // ~0.5s budget
        // Lock timeout → SKIP, never write: an unlocked read-modify-write of the
        // whole lane can erase a peer's just-posted message or just-refreshed
        // heartbeat (review-caught). A dropped touch is harmless — the next
        // event re-registers it; a stale full-file snapshot is data loss.
        if (!got) return;
        try {
            let data0 = {}; try { data0 = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { /* fresh */ }
            const all = pruneSessions(Array.isArray(data0.sessions) ? data0.sessions : [], now);
            const prev = all.find(s => s.id === sid) || {};
            const list = all.filter(s => s.id !== sid);
            const channelSeen = freshChannelSeen(prev.channelSeen, now);
            channelSeen.lifecycle = now;   // this writer IS the lifecycle channel
            // Intent provenance + no-clobber: the per-prompt intent is the user's RAW
            // prompt (a fallback description), and it must not overwrite a FRESH
            // intent the session DECLARED via brain_sync on a merged row. A declared
            // EMPTY intent (brain_sync phase "complete" clears it) never blocks the
            // fallback — there is nothing to protect (review-caught).
            const declaredFresh = prev.intentSource === 'declared' && String(prev.intent || '').trim()
                && prev.intentAt && (now - prev.intentAt) < 10 * 60 * 1000;
            const wantsIntent = patch.intent !== undefined && !declaredFresh;
            const nextIntent = wantsIntent ? patch.intent : (prev.intent ?? '');
            const intentChanged = wantsIntent && nextIntent !== (prev.intent ?? '');
            // `activity: true` records a work-shaped turn WITHOUT an intent
            // update — a machine-generated prompt (task notification landing in
            // a working session) proves the session is active, but its text
            // must never become the declared intent.
            const recordsActivity = patch.intent !== undefined
                || patch.addFiles !== undefined
                || patch.files !== undefined
                || patch.ships !== undefined
                || patch.activity === true;
            list.push({
                ...prev,   // unknown/foreign keys (an MCP writer's, a future field) survive this touch
                id: sid, pid: process.pid, project: path.basename(CWD),
                client: 'claude-code', surface: prev.surface || 'claude-code',
                cwd: prev.cwd || CWD,
                ...(HOST_PID ? { hostPid: HOST_PID } : {}),
                branch: patch.branch !== undefined ? patch.branch : (prev.branch ?? null),
                intent: nextIntent,
                ...(intentChanged ? { intentAt: now, intentSource: 'prompt' } : {}),
                // addFiles UNIONS under the lane lock (live observed scope);
                // files REPLACES (Stop rewrites the session's full set).
                files: patch.addFiles !== undefined
                    ? [...new Set([...(prev.files || []), ...patch.addFiles])].slice(-20)
                    : (patch.files !== undefined ? patch.files : (prev.files ?? [])),
                // ships ACCUMULATE across turns (deduped, last 5) so a peer sees the
                // session's recent ship-events, not just the latest turn's.
                ships: patch.ships !== undefined ? [...new Set([...(prev.ships || []), ...patch.ships])].slice(-5) : (prev.ships ?? []),
                // Card ids already injected full-text into THIS session's prompts —
                // the per-prompt recall renders a re-hit as one headline instead of
                // re-paying the full card (a ~600-word card was injected 3× before).
                injected: patch.injected !== undefined ? patch.injected : (prev.injected ?? []),
                // Sibling ledger for LARGE cards (>1KB) with a much deeper cap: the
                // 100-entry `injected` set evicts old ids in a long session, so a big
                // card injected early could re-inflate full-text after ~100 other
                // cards scrolled it out. Big cards are rare, so this cap effectively
                // never evicts one — enforcing "no >1KB card full-text twice".
                injectedBig: patch.injectedBig !== undefined ? patch.injectedBig : (prev.injectedBig ?? []),
                // Per-session status-digest dedup hash (T8) — the fixed field
                // list silently dropped unknown patch keys, which made the
                // dedup dead code (review-caught).
                statusDigestHash: patch.statusDigestHash !== undefined ? patch.statusDigestHash : (prev.statusDigestHash ?? null),
                ...(recordsActivity
                    ? { activityAt: now, activityKind: patch.intent !== undefined ? 'UserPromptSubmit' : 'ObservedWork' }
                    : (prev.activityAt ? { activityAt: prev.activityAt, activityKind: prev.activityKind || null } : {})),
                channels: Object.keys(channelSeen), channelSeen,
                startedAt: prev.startedAt || now, lastSeen: now,
            });
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
            // Preserve the messages lane — touchSession runs AFTER postMessages in a
            // capture, and dropping the field here would clobber a just-posted note.
            // Cap 40 (was 20 — the MCP writer caps 40; a lower cap here could evict
            // MCP-written rows on every heartbeat). Message eviction prefers
            // delivered notes (capMsgs) so an unseen note is never silently lost.
            const keptMsgs = maintainMsgs(data0.messages, now);
            writeLaneAtomic(JSON.stringify({ ...data0, sessions: list.slice(-40), messages: keptMsgs }));
            // Hostmap: host-pid → CURRENT session id, re-read by the MCP server on
            // every touch so its lane row follows /clear + resume id rotation. The
            // file is per-PROJECT (all host pids write it), so its read-modify-write
            // runs INSIDE the same lane lock, and the write is atomic (temp+rename) —
            // an unlocked plain write let host B revert host A's fresh rotation and a
            // torn read wiped every other host's mapping (review-caught).
            if (HOST_PID) {
                try {
                    let map = {}; try { const m0 = JSON.parse(fs.readFileSync(HOSTMAP_FILE, 'utf8')); if (m0 && typeof m0 === 'object') map = m0; } catch { /* fresh */ }
                    const kept = {};
                    for (const [k, v] of Object.entries(map)) if (v && now - Number(v.ts || 0) < SESSION_FRESH_MS) kept[k] = v;
                    kept[String(HOST_PID)] = { sessionId: sid, ts: now };
                    const tmp = HOSTMAP_FILE + '.' + process.pid + '.tmp';
                    fs.writeFileSync(tmp, JSON.stringify(kept));
                    try { fs.renameSync(tmp, HOSTMAP_FILE); }
                    catch (err) { try { fs.unlinkSync(tmp); } catch { /* */ } throw err; }
                } catch { /* best-effort */ }
            }
        } finally { if (got) releaseLock(SESSIONS_LOCK); }
    } catch { /* coordination is best-effort */ }
}
// Other live lanes in THIS project (exclude me by session id, pid, AND host pid).
// Own-twin = an MCP-CHANNEL-ONLY row sharing this host's pid — that is this
// host's own MCP server half, which must never render as a phantom peer. A
// same-hostPid row with a LIFECYCLE channel is NOT excluded (a /clear
// predecessor is a real, aging-out session — hiding it would lie).
const isOwnTwin = (s) => Boolean(HOST_PID && s && s.hostPid === HOST_PID
    && Array.isArray(s.channels) && s.channels.length && s.channels.every(ch => ch === 'mcp'));
function livePeers(sid) {
    try { return pruneSessions(readSessions(), Date.now()).filter(s => s.id !== sid && s.pid !== process.pid && !isOwnTwin(s)); }
    catch { return []; }
}
// Zero-cost-UNLESS-a-peer-exists footer: lists other live sessions and ESCALATES
// when one shares your branch or is editing files you changed. Empty string when
// you're solo (the common case) — preserves the per-prompt "nothing → zero tokens"
// contract, so it only ever speaks up when there's a real collision to avoid.
function peerFooter(sid) {
    if (!sid) return '';
    const now = Date.now();
    let raw, list;
    try { raw = readSessions(); list = pruneSessions(raw, now); } catch { return ''; }
    const peers = list.filter(s => s.id !== sid && s.pid !== process.pid && !isOwnTwin(s));
    if (!peers.length) return '';
    // Honest hiding: rows pruned as inactive are DISCLOSED as a count, matching
    // the MCP side's "(N background/idle)" wording — a filtered list must never
    // read as the whole lane (2026-07-29 field incident: 13 live, 4 rendered).
    const hiddenIdle = Math.max(0, raw.filter(s => s && s.id).length - list.length);
    // "My files" = what THIS session edited (live-observed per tool call + set at
    // Stop from its own transcript), NOT the shared working-tree diff (identical
    // for two sessions in one repo).
    const me = list.find(s => s.id === sid);
    // Normalize like the MCP detector's normalizeFileKey (slashes, ./ prefix,
    // case) so hook-observed and brain_sync-declared spellings cross-match.
    const fileKey = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase();
    const myFiles = new Set(((me && Array.isArray(me.files)) ? me.files : []).map(fileKey));
    const myBranch = me && me.branch;
    const ago = (ts) => { const m = Math.max(0, Math.round((now - (ts || now)) / 60000)); return m <= 0 ? 'just now' : `${m}m ago`; };
    const asOf = new Date(now).toISOString().slice(11, 16) + 'Z';
    const lines = ['', `## ⚠️ Other live session(s) in this project — ${peers.length} total, as of ${asOf}${hiddenIdle ? ` (+${hiddenIdle} inactive not shown)` : ''} — coordinate (the brain is shared, NOT live-merged)`];
    for (const p of peers.slice(0, 4)) {
        const bits = [];
        if (p.branch) bits.push(`branch \`${p.branch}\``);
        bits.push(`active ${ago(p.lastSeen)}`);
        if (p.intent) {
            // A heartbeat refreshes lastSeen while carrying the old intent — show the
            // intent's OWN age when it lags, so it can't read as "doing this right now".
            const iAgeMin = p.intentAt ? Math.max(0, Math.round((now - p.intentAt) / 60000)) : null;
            const hAgeMin = Math.max(0, Math.round((now - (p.lastSeen || now)) / 60000));
            const iAge = iAgeMin !== null && iAgeMin - hAgeMin > 3 ? ` (set ${iAgeMin}m ago)` : '';
            bits.push(`“${String(p.intent).replace(/\s+/g, ' ').trim().slice(0, 60)}”${iAge}`);
        }
        const ships = Array.isArray(p.ships) ? p.ships : [];
        if (ships.length) bits.push(`🏁 shipped: ${ships.slice(-3).join('; ')}`);
        if (Array.isArray(p.files) && p.files.length) bits.push(`✏️ ${p.files.slice(-4).join(', ')}${p.files.length > 4 ? ` (+${p.files.length - 4})` : ''}`);
        const shared = (Array.isArray(p.files) ? p.files : []).filter(f => myFiles.has(fileKey(f)));
        let warn = '';
        if (shared.length) warn = `  · ⚠️ both edited: ${shared.slice(0, 5).join(', ')} — expect a conflict, KEEP BOTH`;
        else if (p.branch && myBranch && p.branch === myBranch) warn = '  · ⚠️ same branch — pull/rebase before you commit';
        lines.push(`- session ${String(p.id).slice(0, 8)} · ${bits.join(' · ')}${warn}`);
    }
    // v1.32.0 law: a truncated list must never render as a complete one. This
    // overflow line is unconditional — never subject to any budget.
    if (peers.length > 4) lines.push(`- …and ${peers.length - 4} more live session(s) not shown — \`npx klypix-mcp doctor\` or brain_sync lists all.`);
    lines.push('Coordinate BEFORE touching shared files: reply with `🧠 MSG [<their id-prefix or branch>]: <text>` (or call `brain_message`). KLYPIX queues it for a supported lifecycle/MCP action and replays it until a later action acknowledges model-context delivery. Check the brain for durable decisions/ships.');
    return lines.join('\n');
}

// ── Brain messaging — async agent↔agent notes via the shared per-project lane ─
// The COMPLEMENT to the live-ledger: the ledger surfaces a peer's AUTOMATIC high-
// signal events (ships, version bumps); this lets a session leave a DELIBERATE,
// TARGETED note for another ("merged the hook refactor — rebase your PR first").
// SEND by emitting `🧠 MSG [<to>]: <text>` in a reply (to = a peer's id-prefix or
// branch, omitted = all); the Stop hook posts it to the lane, and the recipient's
// next model-context hook offers it and a later action confirms that offer.
// Unacknowledged notes replay; delivery remains asynchronous, not real-time.
const MSG_RE = /🧠\s*MSG\s*(?:\[([^\]]*)\])?\s*:\s*(.+)$/i;
const MSG_FRESH_MS = 24 * 60 * 60 * 1000;
const MSG_RECEIPT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const MSG_DELIVERY_VERSION = 2;
const MSG_RECEIPT_CAP = 100;
const MSG_OUTBOX_FILE = path.join(os.homedir(), '.claude', 'project-brain', 'pending', `${sha(normBrainPath(laneCanon(BRAIN)))}.messages`);
const MSG_OUTBOX_LOCK = MSG_OUTBOX_FILE + '.lock';
// Cap active work WITHOUT silently destroying undelivered notes (mirrors
// agent-presence.mjs capMessages): overflow becomes a retained failed receipt.
const msgRecipientKey = (value) => String(value || '').trim().slice(0, 160);
const msgDeliveryStates = new Set(['offered', 'acknowledged', 'failed']);
function normalizeMsg(m, now = Date.now()) {
    if (!m || !m.id) return null;
    const next = { ...m };
    const records = new Map();
    for (const raw of Array.isArray(m.deliveries) ? m.deliveries : []) {
        const recipientId = msgRecipientKey(raw?.recipientId || raw?.id);
        if (!recipientId) continue;
        records.set(recipientId, {
            recipientId,
            state: msgDeliveryStates.has(raw.state) ? raw.state : 'offered',
            attempts: Math.max(0, Number(raw.attempts || 0)),
            ...(raw.offeredAt ? { offeredAt: Number(raw.offeredAt) } : {}),
            ...(raw.acknowledgedAt ? { acknowledgedAt: Number(raw.acknowledgedAt) } : {}),
            ...(raw.failedAt ? { failedAt: Number(raw.failedAt) } : {}),
            ...(raw.offeredActionId ? { offeredActionId: String(raw.offeredActionId).slice(0, 160) } : {}),
            ...(raw.acknowledgedActionId ? { acknowledgedActionId: String(raw.acknowledgedActionId).slice(0, 160) } : {}),
            ...(raw.reason ? { reason: String(raw.reason).slice(0, 120) } : {}),
            ...(raw.legacySeen ? { legacySeen: true } : {}),
        });
    }
    // CRITICAL migration law: legacy seen was recorded before stdout/model
    // delivery, so it is only an offer and must replay once on the v2 hook.
    for (const legacy of Array.isArray(m.seen) ? m.seen : []) {
        const recipientId = msgRecipientKey(legacy);
        if (!recipientId || records.has(recipientId)) continue;
        records.set(recipientId, { recipientId, state: 'offered', attempts: 1, offeredAt: Number(m.ts || now), legacySeen: true });
    }
    next.deliveryVersion = MSG_DELIVERY_VERSION;
    next.deliveries = [...records.values()];
    if (!Array.isArray(next.seen)) next.seen = [];
    return next;
}
function msgDeliveryState(m, sid) {
    const id = msgRecipientKey(sid);
    const record = (Array.isArray(m?.deliveries) ? m.deliveries : []).find(r => msgRecipientKey(r?.recipientId || r?.id) === id);
    if (record && msgDeliveryStates.has(record.state)) return record.state;
    if (Array.isArray(m?.seen) && m.seen.map(msgRecipientKey).includes(id)) return 'offered';
    return 'pending';
}
function setMsgDelivery(m, sid, state, now, reason = null) {
    const recipientId = msgRecipientKey(sid);
    if (!recipientId) return;
    if (!Array.isArray(m.deliveries)) m.deliveries = [];
    let r = m.deliveries.find(x => msgRecipientKey(x?.recipientId || x?.id) === recipientId);
    if (!r) { r = { recipientId, state: 'offered', attempts: 0 }; m.deliveries.push(r); }
    r.recipientId = recipientId; r.state = state;
    if (state === 'offered') {
        r.attempts = Math.max(0, Number(r.attempts || 0)) + 1; r.offeredAt = now;
        delete r.acknowledgedAt; delete r.failedAt; delete r.reason;
    } else if (state === 'acknowledged') {
        r.acknowledgedAt = now; delete r.failedAt; delete r.reason;
        if (!Array.isArray(m.seen)) m.seen = [];
        if (!m.seen.includes(recipientId)) m.seen.push(recipientId);
    } else if (state === 'failed') {
        r.failedAt = now; r.reason = String(reason || 'delivery-failed').slice(0, 120);
    }
}
function terminalizeMsg(m, now, reason) {
    const next = normalizeMsg(m, now);
    const known = new Set([...(Array.isArray(next.candidateIds) ? next.candidateIds : []), ...next.deliveries.map(r => r.recipientId)].map(msgRecipientKey).filter(Boolean));
    let failed = known.size === 0;
    for (const id of known) {
        if (msgDeliveryState(next, id) === 'acknowledged') continue;
        failed = true; setMsgDelivery(next, id, 'failed', now, reason);
    }
    if (failed) next.deadLetter = { state: 'failed', reason, at: now };
    else next.retiredAt = now;
    return next;
}
const msgTerminal = (m) => Boolean(m?.deadLetter || m?.retiredAt);
function retireFullyAckedMsg(m, now) {
    if (!m || msgTerminal(m)) return m;
    const candidates = [...new Set([
        ...(Array.isArray(m.candidateIds) ? m.candidateIds : []),
        ...(Array.isArray(m.deliveries) ? m.deliveries.map(r => r?.recipientId || r?.id) : []),
    ].map(msgRecipientKey).filter(Boolean))];
    if (candidates.length && candidates.every(id => msgDeliveryState(m, id) === 'acknowledged')) m.retiredAt = now;
    return m;
}
function maintainMsgs(list, now = Date.now()) {
    const normalized = [];
    for (const raw of Array.isArray(list) ? list : []) {
        let m = normalizeMsg(raw, now);
        if (!m) continue;
        const terminalAt = Number(m.deadLetter?.at || m.retiredAt || 0);
        if (terminalAt && now - terminalAt >= MSG_RECEIPT_FRESH_MS) continue;
        if (!terminalAt && now - Number(m.ts || 0) >= MSG_FRESH_MS) m = terminalizeMsg(m, now, 'expired-before-acknowledgement');
        normalized.push(m);
    }
    return capMsgs(normalized, 30, now);
}

function capMsgs(list, cap = 30, now = Date.now()) {
    const msgs = (Array.isArray(list) ? list : []).map(m => retireFullyAckedMsg(normalizeMsg(m, now), now)).filter(Boolean);
    const active = msgs.filter(m => !msgTerminal(m));
    const excess = Math.max(0, active.length - Math.max(0, Number(cap) || 0));
    const overflow = new Set(active.slice(0, excess).map(m => m.id));
    const terminalized = msgs.map(m => overflow.has(m.id) ? terminalizeMsg(m, now, 'lane-capacity-overflow') : m);
    const terminal = terminalized.filter(msgTerminal);
    const keep = new Set(terminal.slice(-MSG_RECEIPT_CAP).map(m => m.id));
    return terminalized.filter(m => !msgTerminal(m) || keep.has(m.id));
}

function readMsgOutbox() {
    try { const rows = JSON.parse(fs.readFileSync(MSG_OUTBOX_FILE, 'utf8')); return Array.isArray(rows) ? rows : []; }
    catch { return []; }
}
function updateMsgOutbox(mutate) {
    const got = acquireLock(MSG_OUTBOX_LOCK, { tries: 20, waitMs: 25 });
    if (!got) return { ok: false, rows: [] };
    try {
        const current = readMsgOutbox();
        const next = mutate(current);
        fs.mkdirSync(path.dirname(MSG_OUTBOX_FILE), { recursive: true });
        fs.writeFileSync(MSG_OUTBOX_FILE, JSON.stringify(Array.isArray(next) ? next : current));
        return { ok: true, rows: Array.isArray(next) ? next : current };
    } catch (error) { return { ok: false, rows: [], error: String(error?.message || error) }; }
    finally { releaseLock(MSG_OUTBOX_LOCK); }
}

function postMessages(msgs) {
    // Stage first in an independent durable outbox. A busy/broken lane writer
    // can no longer make the transcript marker disappear; any later project
    // hook drains the stable id, and lane-side id dedupe makes retry harmless.
    const incoming = (Array.isArray(msgs) ? msgs : []).map(m => normalizeMsg(m)).filter(Boolean);
    const staged = updateMsgOutbox((current) => {
        const byId = new Map(current.filter(m => m?.id).map(m => [String(m.id), m]));
        for (const message of incoming) if (!byId.has(String(message.id))) byId.set(String(message.id), message);
        return [...byId.values()];
    });
    if (!staged.ok) return { ok: false, durable: false, posted: 0, pending: incoming.length, reason: 'outbox-write-failed' };
    if (!staged.rows.length) return { ok: true, durable: true, posted: 0, pending: 0 };
    const got = acquireLock(SESSIONS_LOCK, { tries: 20, waitMs: 25 });
    if (!got) return { ok: false, durable: true, posted: 0, pending: staged.rows.length, reason: 'lane-lock-timeout' };
    let posted = 0;
    const drainedIds = new Set();
    try {
        let data = {}; try { data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { /* fresh */ }
        const sessions = Array.isArray(data.sessions) ? data.sessions : [];
        const now = Date.now();
        const live = pruneSessions(sessions, now);
        const kept = maintainMsgs(data.messages, now);
        const existingIds = new Set(kept.map(m => String(m?.id || '')).filter(Boolean));
        for (const raw of staged.rows) {
            const m = normalizeMsg(raw, now);
            if (!m?.id) continue;
            drainedIds.add(String(m.id));
            if (existingIds.has(String(m.id))) continue;
            m.deliveryVersion = MSG_DELIVERY_VERSION;
            if (!Array.isArray(m.deliveries)) m.deliveries = [];
            if (!Array.isArray(m.seen)) m.seen = [];
            // Snapshot the SEND-time audience so the receipt remains truthful
            // after a peer exits, and so a later viewer never inflates X of Y.
            // This is lane metadata only; no card or message text is copied.
            if (!Array.isArray(m.candidateIds)) {
                m.candidateIds = live
                    .filter(s => s?.id && s.id !== m.from && msgTargetsMe(m, s, s.id))
                    .map(s => String(s.id).slice(0, 160));
            }
            kept.push(m);
            existingIds.add(String(m.id));
            posted++;
        }
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        writeLaneAtomic(JSON.stringify({ ...data, sessions, messages: capMsgs(kept, 30, now) }));
    } catch (error) {
        return { ok: false, durable: true, posted: 0, pending: staged.rows.length, reason: String(error?.message || error) };
    } finally { releaseLock(SESSIONS_LOCK); }
    const cleared = updateMsgOutbox((current) => current.filter(m => !drainedIds.has(String(m?.id || ''))));
    return { ok: true, durable: true, posted, pending: cleared.ok ? cleared.rows.length : staged.rows.length };
}
// to==='all'/'' → everyone; otherwise mirror agent-presence's full matcher.
function msgTargetsMe(m, me, sid) {
    const to = String(m.to || '').trim().toLowerCase();
    if (!to || to === 'all' || to === '*') return true;
    return [String(sid || ''), String(sid || '').slice(0, 8), me?.branch || '', me?.intent || '', me?.client || '', me?.surface || '']
        .join(' ').toLowerCase().includes(to);
}
// ── Decay-aware message stamps (2026-07-28 post-mortem, class B) ─────────────
// A delivered inter-session message is MEMORY, not a SENSOR: a peer's "no
// TestFlight upload triggered yet" relayed ~12h later read as CURRENT state and
// produced the third stale-"what is remaining" incident. The ENGINE stamps any
// delivered message older than 6h whose text asserts fast-decay build/deploy
// status — the discipline lives in the output contract, never in the reading
// model's judgment. The classifier lives ONCE in klypix-format.mjs
// (lib.classifyDecay), consumed behind a typeof guard so an older bundled lib
// degrades to no stamp — never a throw. The stamp is its OWN line appended
// AFTER the 400-char render slice (the v1.32.0 law: a warning is never subject
// to the budget/cut it warns about) and lives in render output only — the lane
// file is never mutated (dedup + ack key on the RAW message text).
const MSG_DECAY_STAMP_MS = 6 * 60 * 60 * 1000;
// classifyDecay is precision-first; mirror that here — only an explicit `true`
// or an explicitly fast-shaped object stamps. Anything ambiguous does NOT
// (a false stamp erodes trust in every stamp).
const isFastDecayResult = (r) => r === true || r === 'fast'
    || (!!r && typeof r === 'object' && (r.fast === true || r.fastDecay === true || r.decay === 'fast' || r.class === 'fast' || r.kind === 'fast'));
const msgAgeLabel = (ms) => { const h = Math.floor(ms / 3_600_000); return h >= 48 ? `${Math.floor(h / 24)}d` : `${Math.max(1, h)}h`; };
function decayStampForMessage(text, ts, now, lib) {
    try {
        if (!lib || typeof lib.classifyDecay !== 'function') return '';   // old bundled lib → no stamp, never a throw
        const t = Number(ts) || 0;
        const staleMs = Number(lib.DECAY_STALE_MS) > 0 ? Number(lib.DECAY_STALE_MS) : MSG_DECAY_STAMP_MS;   // threshold single-sourced in the engine
        if (!t || now - t < staleMs) return '';
        if (!isFastDecayResult(lib.classifyDecay(String(text || '')))) return '';
        // Wording single-sourced in the engine (lib.decayMessageStamp) so the
        // renderers can never drift apart; local fallback only for a lib old
        // enough to have the classifier but not the stamp builder.
        return typeof lib.decayMessageStamp === 'function'
            ? lib.decayMessageStamp(now - t)
            : `⏱️ This message is ${msgAgeLabel(now - t)} old and contains build/deploy status — treat as LAST KNOWN, verify live before reporting it.`;
    } catch { return ''; }   // stamping is best-effort — a classifier bug must never break delivery
}
function messageFooter(sid, tp, lib) {
    if (!sid) return '';
    postMessages([]);   // drain any durable marker outbox before reading this inbox
    const now = Date.now();
    const got = acquireLock(SESSIONS_LOCK, { tries: 15, waitMs: 25 });
    if (!got) return '';
    let delivered = [];
    let overflow = 0;
    try {
        let data = {}; try { data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return ''; }
        const messages = maintainMsgs(data.messages, now);
        const sessions = pruneSessions(data.sessions, now);
        const me = sessions.find(s => s.id === sid);
        const due = messages.filter(m => m && !msgTerminal(m) && m.from !== sid
            && ['pending', 'offered'].includes(msgDeliveryState(m, sid)) && msgTargetsMe(m, me, sid));
        // Stable v2 sender ids make self-exclusion exact (`m.from !== sid`). Do
        // not infer identity from transcript text: two sessions can send the
        // same words, and the old whole-transcript filter suppressed the peer's
        // real note forever. A pre-v2 generic-sender self-echo is safer than a
        // false delivery receipt for somebody else's message.
        const show = due;
        const norm = (m) => String(m.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const deliveryKey = (m) => `${msgRecipientKey(m?.from)}\u0000${norm(m)}`;
        const seenText = new Set(); const dupes = new Map(); const unique = [];
        for (const m of show) {
            const key = deliveryKey(m);
            if (!key) continue;
            if (seenText.has(key)) { if (!dupes.has(key)) dupes.set(key, []); dupes.get(key).push(m); continue; }
            seenText.add(key); unique.push(m);
        }
        delivered = unique.slice(0, 6);
        overflow = unique.length - delivered.length;
        const advance = new Set();
        for (const m of delivered) {
            advance.add(m.id);
            for (const d of (dupes.get(deliveryKey(m)) || [])) advance.add(d.id);
        }
        for (const m of due) {
            // A transcript text match suppresses only this response. It cannot
            // acknowledge/fail a genuine peer note with identical wording.
            if (!advance.has(m.id)) continue;
            const prior = msgDeliveryState(m, sid);
            if (prior === 'offered') setMsgDelivery(m, sid, 'acknowledged', now);
            else if (prior === 'pending') setMsgDelivery(m, sid, 'offered', now);
            retireFullyAckedMsg(m, now);
        }
        writeLaneAtomic(JSON.stringify({ ...data, sessions, messages }));
    } catch { return ''; }
    finally { releaseLock(SESSIONS_LOCK); }
    if (!delivered.length) return '';
    const ago = (ts) => { const mm = Math.max(0, Math.round((now - (ts || now)) / 60000)); return mm <= 0 ? 'just now' : `${mm}m ago`; };
    const out = ['', '## 📨 Message(s) from another session in this project (replayed until a later action acknowledges model-context delivery)'];
    const neutral = (s) => String(s).replace(/🧠(\s*)(BRAIN|MSG)/gi, '🧠·$2');
    for (const m of delivered) {
        out.push(`- from ${String(m.from || '?').slice(0, 8)} · ${ago(m.ts)}: ${neutral(String(m.text)).replace(/\s+/g, ' ').trim().slice(0, 400)}`);
        const stamp = decayStampForMessage(m.text, m.ts, now, lib);
        if (stamp) out.push(`  ${stamp}`);
    }
    if (overflow > 0) out.push(`- …${overflow} more message(s) waiting — acknowledged/replayed messages clear first.`);
    out.push('Reply with `🧠 MSG [<their-id or all>]: <text>`; KLYPIX queues the reply for a supported lifecycle/MCP action. A delivery acknowledgement is not proof a human read it.');
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
// One membership test for "is this tool a shell?" across every host the brain
// rides in: Claude Code (Bash, PowerShell), Codex CLI (shell, local_shell),
// Gemini CLI (run_shell_command), Cursor (run_terminal_cmd), Cline/Roo
// (execute_command), VS Code Copilot (run_in_terminal), plus generic bridge
// names. Compared case-insensitively — hosts disagree on casing before they
// disagree on names. 2026-07-29 field hole: this Stop-side set lacked
// 'PowerShell' while the live detector included it, so on Windows a
// `gh release create` run through the PowerShell tool produced NO ship card —
// the v1.3.69 ship triggered no claim reconciliation at all.
const SHELL_TOOL_NAMES = new Set([
    'bash', 'powershell', 'shell', 'local_shell', 'run_shell', 'run_shell_command',
    'run_terminal_cmd', 'execute_command', 'run_in_terminal', 'run_command', 'terminal', 'exec',
]);
const isShellTool = (name) => SHELL_TOOL_NAMES.has(String(name || '').toLowerCase());
const SHIP_PATTERNS = [
    // PR number is read ONLY from the `pr merge <n>` argument — not "any number in the
    // command" (which grabbed a stray digit from `-R owner/repo4`, mislabeling it #4).
    { re: /\bgh\s+pr\s+merge\b/i, kind: 'merged PR', area: 'Ship', num: /\bpr\s+merge\s+#?(\d{1,6})\b/i },
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
        if (b?.type === 'tool_use' && isShellTool(b.name) && typeof b.input?.command === 'string') shellCmds.push({ id: b.id, cmd: b.input.command });
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
// The baseline is repo-writable and gets interpolated into git commands — accept
// ONLY a bare sha, or a malicious checkout gains shell execution (review-caught
// 2026-08-07). An invalid file re-baselines exactly like a missing one.
const readLastCommit = () => {
    try {
        const s = fs.readFileSync(COMMIT_STATE, 'utf8').trim();
        return /^[0-9a-f]{4,64}$/i.test(s) ? s : null;
    } catch { return null; }
};
const writeLastCommit = (s) => { try { fs.mkdirSync(path.dirname(COMMIT_STATE), { recursive: true }); fs.writeFileSync(COMMIT_STATE, String(s || '')); } catch { /* best-effort */ } };
const git = (args) => execSync(`git ${args}`, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();

// --- Out-of-session ship observation (class-C decay leg, 2026-07-29) --------
// A ship that happens with NO hooked session watching — another host, a human
// terminal, CI — used to produce no 🏁 card and trigger no claim
// reconciliation: the brain only learned what a session narrated (the v1.3.69
// ship arrived exactly this way and its resolved ❓ stayed open for a day).
// SessionStart now OBSERVES the two deterministic, zero-network ship signals —
// the newest local git tag and package.json's version — against a per-project
// sidecar, QUEUES a pending ship record, and lets the next Stop capture drain
// it through the existing lock + persistent dedup + fulfillment cross-check.
// SessionStart itself stays a no-brain-write path (the 1.41.0 print-path
// contract); first run BASELINES silently, mirroring the commit channel.
// Ship observation lives in the ENGINE (klypix-format observeShipDrift) so every
// host shares one implementation — the incident class is worst exactly where no
// Claude hook runs. These thin wrappers bind it to this hook's CWD + git runner
// and stay version-skew-safe behind typeof guards.
function observeOutOfSessionShips(lib) {
    try {
        if (typeof lib?.observeShipDrift !== 'function') return '';
        const { notice } = lib.observeShipDrift(CWD, { gitRun: git, now: nowIso });
        return notice ? `\n${notice}\n` : '';
    } catch { return ''; }
}
const advanceShipBaseline = (lib) => {
    try {
        if (typeof lib?.writeShipObsState !== 'function' || typeof lib?.readShipSignals !== 'function') return;
        lib.writeShipObsState(CWD, lib.readShipSignals(CWD, git));
    } catch { /* best-effort */ }
};
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
    // Closes:/Resolves:/Fulfils: trailer in the commit BODY → card.closes — the
    // engine's close-link pass then archives the strategy/❓ card this ship
    // fulfilled. This gives the highest-volume capture channel (and EVERY agent
    // that commits — Cursor, Cline, a human — not just hook-wired ones) real
    // resolution semantics. Before this, commit-derived 🏁 cards were
    // lifecycle-INERT: shipping produced new truth without ever touching the
    // stale "remaining:" claim it fulfilled (2026-07-23 field incident).
    // Parsed from the RAW body (trailers are line-anchored) before flattening.
    const tm = /^(?:closes|resolves|fulfils|fulfills)\s*:\s*(.+)$/im.exec(c.body);
    let closes = tm ? tm[1].trim().replace(/\.$/, '') : '';
    // URL / bare-issue-ref trailers ("Closes: https://github.com/...",
    // "Closes: #123") tokenize to pure boilerplate (https/github/<org>/issues)
    // that coverage-matches UNRELATED live cards mentioning the same host —
    // false retirement, the worst case (adversarial review reproduced it).
    // Only a prose target (a card title / claim) is a usable close-target.
    if (/^https?:\/\//i.test(closes) || /^#?\d+$/.test(closes)) closes = '';
    const body = c.body.replace(/\s+/g, ' ').trim();
    if (body.length < 12) return null;                                          // RATIONALE-bearing only — keeps it high-signal, not a dump
    const type = m[1].toLowerCase(), scope = (m[2] || '').trim(), desc = m[3].trim();
    const area = scope || (type === 'feat' ? 'Milestones' : 'Fixes');
    const prefix = type === 'feat' ? '🏁 ' : '';
    return {
        text: `${area}: ${prefix}${desc}\n\n${body.slice(0, 400)}\n#${slugify(area)} #commit-${c.hash.slice(0, 7)}`,
        area, borderColor: type === 'feat' ? 'rgba(59,130,246,0.8)' : 'rgba(16,185,129,0.6)', createdVia: 'commit',
        ...(closes ? { closes } : {}),
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
    const entries = parseCommitLog(raw);
    // Revert retraction (same batch): a "feat: X" shipped-and-reverted before
    // this hook ran must not close the open card X claimed to fulfil. Reverts
    // themselves never become cards (CC_RE skips them), so scan the raw batch
    // for Revert subjects and strip `closes` from any card whose subject was
    // reverted. Cross-batch reverts (feat captured in an earlier run) need the
    // P1 retraction machinery — consciously deferred, recorded in the plan.
    const reverted = new Set();
    for (const e of entries) { const rm = /^Revert\s+"(.+)"/.exec(e.subject); if (rm) reverted.add(rm[1].trim()); }
    const cards = entries.slice(0, 15)
        .map(e => { const card = commitToCard(e); if (card && reverted.has(e.subject)) delete card.closes; return card; })
        .filter(Boolean);
    // Ship-evidence guard: a Closes: trailer only CLOSES a live claim when the
    // commit is on the repo's DEFAULT branch — a feature-branch ship that never
    // merges must not retire an open card. Default branch is detected from
    // origin/HEAD (so trunk/develop repos work), falling back to master|main;
    // a strip leaves a HEALTH breadcrumb so the inert channel is diagnosable.
    if (cards.some(c => c.closes)) {
        let onDefault = false, branch = '';
        try {
            branch = git('rev-parse --abbrev-ref HEAD');
            let def = '';
            try { def = (git('symbolic-ref refs/remotes/origin/HEAD') || '').replace(/^refs\/remotes\/origin\//, ''); } catch { /* no origin/HEAD ref */ }
            onDefault = def ? branch === def : /^(master|main)$/.test(branch);
        } catch { onDefault = false; }
        if (!onDefault) {
            for (const c of cards) delete c.closes;
            try { appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'commit-closes', ok: true, err: `closes stripped (branch ${branch || '?'} is not default)` }, 500); } catch { /* best-effort */ }
        }
    }
    return { cards, newLastCommit: head };
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
    { re: /\bgh\s+pr\s+merge\b/i, fmt: (_m, cmd) => { const n = cmd.match(/\bpr\s+merge\s+#?(\d{1,6})\b/i); return `merged PR${n ? ' #' + n[1] : ''}`; } },
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
    if (isShellTool(tool) && typeof ti.command === 'string' && ti.command) {
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

// Live scope observation: one write-tool file path → the session lane, union
// semantics under the lane lock (touchSession addFiles). Gated on FILE_TOOLS
// (write tools only — reads would over-anchor every browsed file) and an
// unlocked pre-check so the common already-recorded edit costs one JSON read,
// no lock. Paths are project-relative (Codex/brain_sync-interoperable); a path
// outside the project is skipped. Never throws.
function observeFileScope(input, sid) {
    try {
        if (!FILE_TOOLS.has(input.tool_name)) return;
        const ti = input.tool_input || {};
        const fp = ti.file_path || ti.path || ti.notebook_path;
        if (typeof fp !== 'string' || !fp) return;
        const rel = projRelPath(fp);
        if (!rel) return;
        try {
            const me = readSessions().find(s => s.id === sid);
            if (me && Array.isArray(me.files) && me.files.includes(rel)) return;   // already recorded — skip the lock
        } catch { /* pre-check is best-effort */ }
        touchSession(sid, { addFiles: [rel] });
    } catch { /* observation is best-effort */ }
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
        // OBSERVED file scope (2026-07-29): record every write-tool touch into
        // this session's lane files[] AS IT HAPPENS — previously files were set
        // only at Stop (as slugs), so mid-session (exactly when peers need the
        // overlap signal) a Claude session always showed files=[] while Codex
        // declared full scopes via brain_sync. MUST run BEFORE the detectLiveEvent
        // early-return: ordinary edits are precisely the non-event turns.
        observeFileScope(input, sid);
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
        // v1.32.0 law: a truncated list must never render as a complete one.
        if (survivors.length > 6) lines.push(`- …and ${survivors.length - 6} more in-flight event(s) not shown.`);
        return '\n\n' + lines.join('\n');
    } catch { return ''; }
}

// ── Post-verified-fix rule DRAFTS (capture-coverage closer, 2026-07-17) ──────
// The founder-surfaced gap: the brain RECALLS solved problems well (rerank /
// brain_ask / challenge are strong), but a fix is only recallable if an agent
// remembered to emit a marker — and a trap-shaped fix that lands as a PLAIN note
// only resurfaces on a lexical phrasing match, not every session like a 🛠️ rule.
// This closes that WITHOUT blind auto-capture (noise kills recall): when a session
// MAKES and VERIFIES a fix that reads like a recurring trap, the Stop hook DRAFTS a
// candidate 🛠️ rule for human/agent approval — a draft in a per-project sidecar,
// NEVER a brain card. The read paths surface it once/session with a ready-to-emit
// `+` marker (promotion is one line); approve the real traps, ignore the rest and
// they age out. Same ~/.claude never-throw / best-effort / zero-cost-when-empty
// contract as the other sidecars. Two hard gates keep it from spamming: a VERIFY
// signal must be present (real fix work, not idle prose) and ≤2 NEW drafts per Stop.
const RULE_DRAFTS = path.resolve(CWD, '.claude', 'brain-rule-drafts.json');
const RULE_DRAFTS_LOCK = RULE_DRAFTS + '.lock';
const RULE_DRAFT_TTL_MS = 21 * 24 * 60 * 60 * 1000;   // a never-approved draft ages out in 3 weeks
const RULE_DRAFTS_MAX = 40;                            // hard cap on the per-project store
const RULE_DRAFTS_PER_SESSION = 2;                    // anti-spam: ≤ 2 NEW drafts per Stop
const RULE_DRAFT_MAX_SURFACINGS = 5;                  // ignored across this many distinct sessions → stop nagging (decay < TTL)
// A successful test / build / typecheck / lint / e2e command — the "AND verifies"
// half of the gate. Deterministic + scraped from the transcript's SUCCESSFUL shell
// calls (a fix/perf commit is also a verify — you commit verified work).
const VERIFY_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|verify|e2e)\b|\bnpm\s+ci\b|\bvitest\b|\bjest\b|\bplaywright\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+(?:test|build|check|clippy)\b|\btsc\b|\bmocha\b|\beslint\b|\bphpunit\b|\brspec\b|\bgradle\s+(?:test|build|check)\b|\bmvn\s+(?:test|verify)\b/i;
const readRuleDrafts = () => { try { const d = JSON.parse(fs.readFileSync(RULE_DRAFTS, 'utf8')); return Array.isArray(d.drafts) ? d.drafts : []; } catch { return []; } };
// PRESERVE SIBLING KEYS. This sidecar now carries a second, independent list
// (`findings` — routed cross-lane findings), and the old writer serialized a
// fresh `{ drafts }` object, so ANY rule-draft write silently destroyed every
// pending finding and vice versa. Both writers now read the file first and
// replace only their own key. Adding a third list is safe by the same rule.
const readSidecar = () => { try { const d = JSON.parse(fs.readFileSync(RULE_DRAFTS, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; } };
const writeSidecar = (patch) => { try { fs.mkdirSync(path.dirname(RULE_DRAFTS), { recursive: true }); const tmp = `${RULE_DRAFTS}.tmp-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify({ ...readSidecar(), ...patch }, null, 2)); fs.renameSync(tmp, RULE_DRAFTS); } catch { /* best-effort */ } };
const writeRuleDrafts = (drafts) => writeSidecar({ drafts: (drafts || []).slice(-RULE_DRAFTS_MAX) });
const draftKey = (area, text) => sha(((area || '') + '|' + String(text)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
// Token overlap: is a draft seed substantially covered by a (skill) card's text?
// Used to (a) retire a draft a captured 🛠️ skill fulfils and (b) NOT surface a draft
// a live skill already covers — the approval detection, via any promotion path.
function draftMatches(draft, text) {
    const a = new Set(String(draft?.text || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    if (a.size < 3) return false;
    const b = new Set(String(text || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    let hit = 0; for (const tok of a) if (b.has(tok)) hit++;
    return hit / a.size >= 0.6;
}
// A short, promotable rule seed from a trap card: first non-tag line, with a leading
// "Area: " prefix + glyphs stripped, capped. The human/agent refines it when emitting +.
function ruleSeedFrom(card) {
    const raw = String(card?.text || '').split('\n').map(s => s.trim()).filter(Boolean);
    let line = raw.find(l => !/^#/.test(l)) || raw[0] || '';
    line = line.replace(/^([^:]{1,30}):\s+/, '').replace(/^[🏁🛠️❓🎯✅↩︎·\s]+/u, '').trim();
    return line.slice(0, 200);
}
// Did this session actually VERIFY something? (the "AND verifies" gate)
function sessionVerified(shellCmds, errorIds, hadFixCommit) {
    if (hadFixCommit) return true;
    for (const { id, cmd } of shellCmds) { if (errorIds.has(id)) continue; if (VERIFY_CMD.test(cmd)) return true; }
    return false;
}
// Locked read-modify-write of the drafts sidecar (TTL-pruned on every touch). Skips
// the write entirely when the result equals what's already on disk — so a Stop that
// captures only skills (no draft to add/retire) never creates an empty {drafts:[]}
// sidecar in an adopter project, and identical rewrites cause no churn.
function persistDrafts(mutate) {
    const got = acquireLock(RULE_DRAFTS_LOCK, { tries: 20, waitMs: 25 });
    if (!got) return;   // lock timeout → SKIP: an unlocked RMW clobbers the other key's writer; a dropped bump re-detects next Stop
    try {
        const now = Date.now();
        const raw = readRuleDrafts();
        const rawJson = JSON.stringify(raw);   // SNAPSHOT before mutate: filter() shares object refs, so an in-place
        const before = raw.filter(d => d && d.id && d.text && (now - (d.lastSeen || d.firstSeen || 0)) < RULE_DRAFT_TTL_MS);
        const next = (mutate(before, now) || before).slice(-RULE_DRAFTS_MAX);   // mutation (seenCount bump / shownSessions) would else also mutate `raw` → false no-op
        if (JSON.stringify(next) === rawJson) return;   // disk already matches → no write/mkdir/churn
        writeRuleDrafts(next);
    } catch { /* best-effort */ } finally { if (got) releaseLock(RULE_DRAFTS_LOCK); }
}
// Draft trap-shaped fixes this session VERIFIED, deduped + recurrence-bumped. cards[]
// is the fully-built capture batch (markers + fix/perf commits). A candidate is a
// PLAIN decision (not already ❓/🏁/🛠️/🎯 — those are already surfaced or standing)
// that reads as a TRAP (lib.looksLikeTrap) — a finding that WILL recur but landed as
// a one-off note. NEVER writes a brain card; only the pending-draft sidecar. A 🛠️
// skill captured this same batch RETIRES a matching draft (approval). Never throws.
function draftRulesFromFixes(lib, cards, verified, sid) {
    try {
        if (typeof lib.looksLikeTrap !== 'function' || !Array.isArray(cards) || !cards.length) return { drafted: 0, approved: 0 };
        const skillCards = cards.filter(c => /🛠/.test(String(c.text || '')));
        const candidates = [];
        if (verified) {
            for (const c of cards) {
                const t = String(c.text || '');
                if (/🛠|❓|🏁|🎯/.test(t)) continue;              // only PLAIN decisions
                if (c.createdVia === 'ship-event') continue;      // a ship is not a fix
                if (!lib.looksLikeTrap(t)) continue;
                const seed = ruleSeedFrom(c);
                if (seed.length < 12) continue;                   // too thin to be a useful rule
                // Must have ≥3 distinct significant tokens — the SAME bar draftMatches uses to
                // retire a draft. A seed below it is both un-retireable (promoting it could never
                // clear the nag) and too generic to be a useful standing rule, so drop it now.
                if ((seed.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((v, i, a) => a.indexOf(v) === i).length < 3) continue;
                candidates.push({ area: c.area || '', text: seed, source: c.createdVia || 'marker' });
            }
        }
        if (!candidates.length && !skillCards.length) return { drafted: 0, approved: 0 };
        let added = 0, approved = 0;
        persistDrafts((drafts, now) => {
            if (skillCards.length) {   // approval: a captured 🛠️ skill retires the draft it fulfils
                const before = drafts.length;
                drafts = drafts.filter(d => !skillCards.some(sc => draftMatches(d, String(sc.text || ''))));
                approved = before - drafts.length;
            }
            const handled = new Set();
            for (const cand of candidates) {
                if (skillCards.some(sc => draftMatches({ text: cand.text }, String(sc.text || '')))) continue;   // already promoted to a skill THIS batch — don't also draft it
                const key = draftKey(cand.area, cand.text);
                if (handled.has(key)) continue; handled.add(key);   // collapse in-batch duplicate keys → no same-session seenCount inflation
                const existing = drafts.find(d => d.id === key);
                if (existing) { existing.seenCount = (existing.seenCount || 1) + 1; existing.lastSeen = now; continue; }   // cross-session recurrence — bump, don't stack
                if (added >= RULE_DRAFTS_PER_SESSION) continue;   // cap NEW drafts only
                drafts.push({ id: key, area: cand.area, text: cand.text, source: cand.source, firstSeen: now, lastSeen: now, seenCount: 1, shownSessions: [] });
                added++;
            }
            return drafts;
        });
        return { drafted: added, approved };
    } catch { return { drafted: 0, approved: 0 }; }
}
// Pending drafts: TTL-fresh, not already covered by a live 🛠️ skill, and NOT decayed
// (a draft surfaced-and-ignored across ≥ RULE_DRAFT_MAX_SURFACINGS distinct sessions
// stops nagging well before the TTL — that's the "no infinite nag" dismiss path).
// Read-only.
function livePendingDrafts(struct) {
    const now = Date.now();
    let drafts = readRuleDrafts().filter(d => d && d.id && d.text
        && (now - (d.lastSeen || d.firstSeen || 0)) < RULE_DRAFT_TTL_MS
        && (Array.isArray(d.shownSessions) ? d.shownSessions.length : 0) < RULE_DRAFT_MAX_SURFACINGS);
    if (!drafts.length) return [];
    let liveSkills = [];
    try { liveSkills = (struct?.cards || []).filter(c => c && c.type !== 'container' && /🛠/.test(String(c.text || '')) && !/^archive$/i.test(c.area || '')); } catch { /* */ }
    if (liveSkills.length) drafts = drafts.filter(d => !liveSkills.some(sc => draftMatches(d, sc.text)));
    return drafts;
}
// The nudge: surface pending drafts, HOTTEST first (recurring traps take the top slots
// so their escalation actually shows), each with a ready-to-emit `+` marker (promotion
// is one line). markShown=true (per-prompt path) records that THIS session surfaced the
// displayed drafts — durably, ON the draft (shownSessions) — so a NEW session re-surfaces
// (until promoted / covered / decayed) but this session won't re-nag, and the count
// doubles as the decay signal. The SessionStart file tier passes markShown=false (lists
// all, writes nothing). Empty string when nothing → zero-cost contract holds. Never throws.
function ruleDraftsFooter(sid, struct, { markShown = true } = {}) {
    try {
        if (!sid) return '';
        const all = livePendingDrafts(struct);
        if (!all.length) return '';
        all.sort((a, b) => (b.seenCount || 1) - (a.seenCount || 1) || (b.lastSeen || 0) - (a.lastSeen || 0));   // hottest / most-recent first
        const seenBy = (d) => Array.isArray(d.shownSessions) && d.shownSessions.includes(sid);
        const pending = markShown ? all.filter(d => !seenBy(d)) : all;
        if (!pending.length) return '';
        const display = pending.slice(0, 3);
        const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const lines = ['', '---',
            '## 🛠️ Draft rule(s) from a verified fix — approve to make them fire EVERY session',
            'A change you verified this session reads like a recurring trap, but it landed as a one-off note (recallable only on a phrasing match). Promote a REAL trap to a standing 🛠️ rule card — surfaces every session, like the release-naming rule — by emitting its marker; ignore the rest and they age out. This is a DRAFT: nothing was written to the brain.'];
        for (const d of display) {
            const seed = flat(d.text).slice(0, 160);
            const rec = (d.seenCount || 1) >= 2 ? `  ⭐ recurred ${d.seenCount}× — this trap keeps coming back; make it a standing rule` : '';
            lines.push(`- seed: “${seed}”${rec}`);
            lines.push(`  promote → \`🧠 BRAIN [${d.area || 'Fixes'}] +: ${seed}\``);
        }
        if (pending.length > display.length) lines.push(`- …and ${pending.length - display.length} more draft(s) in \`.claude/brain-rule-drafts.json\`.`);
        // Mark ONLY the displayed drafts surfaced-to-this-session (durable, on the draft).
        // So the next 3 can surface on a later prompt this session, and a genuinely-ignored
        // draft decays after RULE_DRAFT_MAX_SURFACINGS distinct sessions. Rare write (only
        // when a draft actually surfaces); persistDrafts no-ops if nothing changed.
        if (markShown) {
            const shownIds = new Set(display.map(d => d.id));
            persistDrafts((drafts) => {
                for (const d of drafts) {
                    if (!shownIds.has(d.id)) continue;
                    if (!Array.isArray(d.shownSessions)) d.shownSessions = [];
                    if (!d.shownSessions.includes(sid)) d.shownSessions = [...d.shownSessions, sid].slice(-RULE_DRAFT_MAX_SURFACINGS);
                }
                return drafts;
            });
        }
        return '\n' + lines.join('\n') + '\n';
    } catch { return ''; }
}

// ── Cross-lane FINDING routing (2026-08-01) ─────────────────────────────────
// The incident: an 8-agent doc audit found four real defects in OTHER sessions'
// lanes, and all four reached their owners only because the founder happened to
// say "message them". The lane already stores every session's declared `files`;
// nothing read them for this. So: when a session VERIFIES something about a file
// OUTSIDE its own scope, work out whose lane it is, DRAFT the note, and let the
// human send it with one paste. Same contract as the rule drafts above — draft
// automatically, send DELIBERATELY, never auto-send, never a brain write.
//
// The engine is src/finding-routing.mjs, imported LAZILY and fail-open: a
// deployment whose ~/.claude/project-brain predates it simply gets no finding
// drafts, exactly as before. This hook must never throw, in any project, ever.
let _routingLib = undefined;
async function routingLib() {
    if (_routingLib !== undefined) return _routingLib;
    try { _routingLib = await import(new URL('./finding-routing.mjs', import.meta.url).href); }
    catch { _routingLib = null; }   // older deployment → the feature is simply absent
    return _routingLib;
}
const readFindings = () => { const d = readSidecar(); return Array.isArray(d.findings) ? d.findings : []; };
// Locked read-modify-write of the FINDINGS half of the shared sidecar. Mirrors
// persistDrafts exactly, including the "disk already matches → no write" no-op
// that keeps an adopter project from growing an empty sidecar.
function persistFindings(mutate) {
    const got = acquireLock(RULE_DRAFTS_LOCK, { tries: 20, waitMs: 25 });
    if (!got) return;   // lock timeout → SKIP (mirrors persistDrafts): never RMW the shared sidecar unlocked
    try {
        const now = Date.now();
        const raw = readFindings();
        const rawJson = JSON.stringify(raw);
        const next = (mutate(raw, now) || raw);
        if (JSON.stringify(next) === rawJson) return;
        writeSidecar({ findings: next.slice(-40) });
    } catch { /* best-effort */ } finally { if (got) releaseLock(RULE_DRAFTS_LOCK); }
}
// Live lane rows, freshness-pruned — the routing candidate set.
const laneRows = () => { try { return pruneSessions(readSessions(), Date.now()); } catch { return []; } };

// DETECT + ROUTE + PERSIST. Called from capture() with the same `verified`
// signal that gates rule drafts. Never throws; returns a count for the ledger.
async function draftFindingsFromCards(cards, verified, sid, ownedPaths) {
    try {
        const R = await routingLib();
        if (!R || !verified || !Array.isArray(cards) || !cards.length) return 0;
        const now = Date.now();
        const sessions = laneRows();
        // Own scope = what this session DECLARED on the lane plus everything it
        // actually touched this turn. Both, because a session that edited a file
        // without declaring it still owns findings about it (R4 at the source).
        const mine = sessions.find(s => s.id === sid);
        const owned = [...new Set([...(ownedPaths || []), ...(Array.isArray(mine?.files) ? mine.files : [])])];
        const { drafts } = R.buildFindingDrafts({ cards, verified, ownedPaths: owned, sessions, selfId: sid, root: CWD, now });
        let added = 0;
        persistFindings((existing) => {
            const merged = R.mergeFindingDrafts(existing, drafts, {
                now,
                // Re-route every surviving draft: an owner may have gone offline
                // (R3) or a held no-owner finding may finally have one (R1).
                reroute: (d) => R.routeFinding({ finding: { path: d.path, text: d.text }, sessions, selfId: sid, root: CWD, now }),
            });
            added = merged.added;
            return merged.drafts;
        });
        return added;
    } catch { return 0; }
}

// DELIVER. The surface mirrors ruleDraftsFooter exactly — same shape, same
// markShown contract (per-prompt marks, SessionStart lists read-only), same
// decay — because that is the approval idiom agents in this repo already know.
async function findingDraftsFooter(sid, { markShown = true } = {}) {
    try {
        if (!sid) return '';
        const R = await routingLib();
        if (!R) return '';
        const all = R.pendingFindingDrafts(readFindings(), { sid: markShown ? sid : null });
        if (!all.length) return '';
        const display = all.slice(0, 3);
        const out = R.renderFindingDrafts(display, { limit: 3, total: all.length });
        if (markShown) {
            const shown = new Set(display.map(d => d.id));
            persistFindings((drafts) => {
                for (const d of drafts) {
                    if (!shown.has(d.id)) continue;
                    if (!Array.isArray(d.shownSessions)) d.shownSessions = [];
                    if (!d.shownSessions.includes(sid)) d.shownSessions = [...d.shownSessions, sid].slice(-5);
                }
                return drafts;
            });
        }
        return out;
    } catch { return ''; }
}

// THE RECEIPT. v2 distinguishes a model-context offer from its later-action
// acknowledgement; historical seen[] is only unverified offer evidence.
// Read-only: this surface never advances state and reports only THIS sender.
async function receiptFooter(sid) {
    try {
        if (!sid) return '';
        const R = await routingLib();
        if (!R) return '';
        let data = {}; try { data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return ''; }
        const summary = R.summarizeReceipts({
            messages: Array.isArray(data.messages) ? data.messages : [],
            sessions: Array.isArray(data.sessions) ? data.sessions : [],
            selfId: sid,
        });
        const text = R.renderReceiptSummary(summary);
        return text ? '\n' + text : '';
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
    // Path-form twin of recentTags for the LANE: the coordination row carries
    // project-relative PATHS ("src/canvas/KlypixCanvas.tsx"), not slugs
    // ("klypixcanvas") — slugs can never exact-match a Codex/brain_sync path, so
    // cross-agent file-overlap detection involving a Claude row was structurally
    // dead (2026-07-29 audit). Slugs remain for card #file- tags only.
    const recentPaths = [];
    const noteFiles = (paths) => {
        for (const p of paths) {
            const rel = projRelPath(p);
            if (rel) {
                const j = recentPaths.indexOf(rel); if (j >= 0) recentPaths.splice(j, 1);
                recentPaths.push(rel);
                while (recentPaths.length > 20) recentPaths.shift();
            }
            for (const tag of fileTagsFor(p)) {
                const i = recentTags.indexOf(tag); if (i >= 0) recentTags.splice(i, 1);
                recentTags.push(tag);
            }
        }
        while (recentTags.length > 8) recentTags.shift();
    };
    const shellCmds = [];          // shell commands seen in the transcript (ship-event capture)
    const errorIds = new Set();    // tool_use ids whose result errored — skip those ship-events
    for (let transcriptIndex = 0; transcriptIndex < lines.length; transcriptIndex++) {
        const ln = lines[transcriptIndex];
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
                if (txt && !isExample) {
                    const target = to || 'all';
                    // Stable across repeated Stop scans of the append-only
                    // transcript, but distinct for two identical notes emitted
                    // in separate assistant events.
                    const sourceEvent = String(e.uuid || e.id || e.timestamp || e.ts || transcriptIndex);
                    messages.push({
                        id: sha(`msg|${sid}|${sourceEvent}|${target}|${txt}`),
                        from: sid,
                        to: target,
                        text: txt.slice(0, 400),
                        ts: Number(new Date(e.timestamp || e.ts || 0)) || Date.now(),
                        seen: [],
                        deliveryVersion: MSG_DELIVERY_VERSION,
                        deliveries: [],
                    });
                }
                continue;
            }
            const m = MARKER.exec(trimmed); if (!m) continue;
            const area = (m[1] || '').trim(), type = m[2] || '';
            let body = m[3].trim(); if (!body) continue;
            // Strip optional `closes:` / `ev:` / `verify:` suffixes off the body so
            // they don't leak into the card text; they drive the close-link,
            // evidence, and live-probe below.
            const { body: cleanBody, closes, evidence, verify } = splitMarkerSuffixes(body);
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
            if (type === '~') { updates.push({ area, text: body, createdVia: 'claude-code', ...(evidence ? { evidence } : {}), ...(verify ? { verify } : {}) }); ledger.push({ action: 'update', area, preview, ...(evidence ? { ev: evidence.map(e => e.ref) } : {}) }); continue; }
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
            cards.push({ text: card, area, borderColor, ...(closes ? { closes } : {}), ...(evidence ? { evidence } : {}), ...(verify ? { verify } : {}) });
            ledger.push({ action: type === '?' ? 'add-question' : type === '!' ? 'add-milestone' : isSkill ? 'add-skill' : 'add-decision', area, preview, files: fileTags, ...(closes ? { closes } : {}), ...(evidence ? { ev: evidence.map(e => e.ref) } : {}) });
        }
    }
    const messagePost = postMessages(messages);   // durable outbox → shared lane
    if (messages.length && !messagePost?.ok) {
        const state = messagePost?.durable ? 'staged durably for retry' : 'could not stage durably; the transcript remains retryable';
        process.stderr.write(`[brain] message: ${messages.length} note(s) ${state} (${messagePost?.reason || 'unknown write failure'})\n`);
        appendJsonl(HEALTH, {
            ts: nowIso(), project: path.basename(CWD), mode: 'message', ok: false,
            durable: messagePost?.durable === true, pending: messagePost?.pending || messages.length,
            err: messagePost?.reason || 'message-write-failed',
        }, 500);
    }
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
            // #auto marks machine-harvested provenance: the repeat-detector demands an
            // entity-token match on these (they're dense with generic ship verbs) and
            // the gardener consolidates them at a shorter age.
            cards.push({ text: `${p.area}: 🏁 ${summary}\n#${slugify(p.area)} #auto`, area: p.area, borderColor: 'rgba(59,130,246,0.8)', createdVia: 'ship-event' });
            shipSummaries.push(summary);
            ledger.push({ action: 'ship-event', area: p.area, preview: summary });
            break;                                            // one pattern per command
        }
    }
    // Drain out-of-session ship observations queued by SessionStart (class-C
    // decay leg) — same card shape and the same persistent dedup keys as
    // in-session ship events, so a ship both narrated AND observed lands
    // exactly once. Skipped under --dry-run (an inspection must not consume
    // the queue). Queue is cleared BEFORE processing — a throwing entry must
    // not wedge the drain forever; entries lost to a crash re-observe at the
    // next SessionStart because the sidecar only advances on write.
    // The queue is NOT deleted here — it is deleted only after the brain write
    // is durable (next to writeState/writeLastCommit), mirroring the commit
    // channel's "advance the baseline only after a successful write". Deleting
    // up front meant an EBUSY/rename failure — routine on Windows when the
    // desktop app holds brain.klypix — silently destroyed the observation with
    // no card and no retry (2026-07-29 review, CONFIRMED). Per-row JSON.parse
    // already tolerates a poison row, so nothing needs the early unlink.
    let drainedShips = false;
    if (!DRY && typeof lib.readPendingShips === 'function') {
        try {
            const rows = lib.readPendingShips(CWD);
            drainedShips = rows.length > 0;
            // A version already narrated by a session (this batch or an earlier
            // one, via the persistent seen-set) is not news — see pendingShipCards.
            const priorNarrated = ['cut release v', 'tagged v', 'tagged ', 'published to npm ']
                .flatMap(p => rows.filter(r => r.version).map(r => p + r.version))
                .filter(s => seen.has(sha(('ship|release|' + s).toLowerCase())))
                .map(s => s.replace(/^[a-z ]+/, ''));
            for (const c of lib.pendingShipCards(rows, { isSeen: (k) => seen.has(k), narrated: [...shipSummaries, ...priorNarrated], sha })) {
                if (c.key) seen.add(c.key);
                cards.push({ text: `${c.area}: 🏁 ${c.summary}\n#${slugify(c.area)} #auto`, area: c.area, borderColor: 'rgba(59,130,246,0.8)', createdVia: 'ship-observed' });
                shipSummaries.push(c.summary);
                ledger.push({ action: 'ship-observed', area: c.area, preview: c.summary.slice(0, 90) });
            }
        } catch { /* pending-ship drain is best-effort */ }
    }
    // Refresh this session's lane with what it ACTUALLY did — files it EDITED this
    // session (per-session, from the transcript; NOT the shared working-tree diff,
    // which is identical for two sessions in one repo) + recent ship-events, so a
    // peer sees "merged #244, edited foo.ts", not a degenerate shared diff.
    // addFiles (union) — PATH form, never slugs: replacing would clobber the
    // live-observed scope with a truncated transcript view, and slugs can't
    // match Codex/brain_sync paths in either overlap detector.
    {
        const laneFiles = recentPaths.slice(-20);
        touchSession(input.session_id, { branch: gitBranch(), ...(laneFiles.length ? { addFiles: laneFiles } : {}), ...(shipSummaries.length ? { ships: shipSummaries } : {}) });
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
    // Post-verified-fix rule DRAFTS (see the block above). Independent of the brain
    // write — it only touches the pending-drafts sidecar, never a brain card. DRY-RUN
    // has already returned above, so this never persists during an inspection. A fix/
    // perf commit this session counts as a verify (you commit verified work).
    {
        const hadFixCommit = commitCards.some(cc => cc.createdVia === 'commit' && !/🏁/.test(String(cc.text || '')));
        const verified = sessionVerified(shellCmds, errorIds, hadFixCommit);
        draftRulesFromFixes(lib, cards, verified, sid);
        // Cross-lane FINDING routing rides the SAME verify gate: a finding this
        // session verified about a file outside its own scope is drafted and
        // routed to whoever declared that file. Nothing is sent. `recentPaths`
        // is this turn's real touch-set — the other half of "own scope".
        await draftFindingsFromCards(cards, verified, sid, recentPaths);
    }
    // A queued batch from a prior lock-refused capture counts as work to do —
    // the authoritative drain happens INSIDE the brain lock (doCapture), so two
    // concurrent sessions can never both land the same queued batch.
    if (!cards.length && !resolutions.length && !updates.length && !readPendingCaptures().length) {
        // Record the commit baseline / advance even with nothing to capture, so
        // the next run doesn't re-scan the same commits.
        if (newLastCommit && newLastCommit !== prevCommit) writeLastCommit(newLastCommit);
        // This session WAS watching, so whatever ship state it ends with is by
        // definition already observed — baseline it, or the next SessionStart
        // reports our own narrated release as a new signal.
        if (!DRY) advanceShipBaseline(lib);
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
    const doCapture = async (locked) => {
        const merged = readState(); for (const k of seen) merged.add(k);
        if (!locked) {
            // REFUSED: never write from a stale base. The batch is queued durably
            // (same home as the dedup state) and drained by the next capture in
            // this project — deferred-but-safe beats immediate-but-clobbering.
            if (cards.length || resolutions.length || updates.length) {
                updatePendingCaptures((current) => [
                    ...current,
                    { id: `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`, ts: nowIso(), cards, resolutions, updates },
                ]);
            }
            writeState(merged);
            writeLastCommit(newLastCommit); // safe: the batch itself is durably queued
            if (drainedShips && typeof lib.clearPendingShips === 'function') lib.clearPendingShips(CWD);
            advanceShipBaseline(lib);
            appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'capture', ok: false, err: 'lock-timeout — batch QUEUED for the next capture; brain untouched' }, 500);
            process.stderr.write('[brain] capture deferred: the brain lock is held (desktop save or peer capture) — batch queued durably, nothing lost\n');
            return null;
        }
        // Drain the queue UNDER the lock: read, land, clear-by-id — a peer's
        // batch queued after this read survives, and no batch lands twice.
        const pendingBatches = readPendingCaptures();
        const drainedPendingIds = new Set(pendingBatches.map(b => b && b.id).filter(Boolean));
        for (const b of pendingBatches) {
            if (!b || typeof b !== 'object') continue;
            for (const c of (Array.isArray(b.cards) ? b.cards : [])) cards.push(c);
            for (const r of (Array.isArray(b.resolutions) ? b.resolutions : [])) resolutions.push(r);
            for (const u of (Array.isArray(b.updates) ? b.updates : [])) updates.push(u);
        }
        if (!cards.length && !resolutions.length && !updates.length) return null;
        const brainBuf = fs.readFileSync(BRAIN);
        // Dual-channel commit dedup (2026-08-07): the auto-installed git
        // post-commit hook cards commits AT COMMIT TIME with a #commit-<7> tag,
        // deduping against the brain before it writes. This side must honor the
        // same contract — without it every rationale-bearing commit in a hooked
        // repo carded twice (feat → duplicate 🏁 cards; fix/perf → the git
        // hook's minutes-old card got supersede-archived by its own clone).
        // Scoped to createdVia==='commit' — cards from THIS channel only. A
        // human marker that merely cites "#commit-abc1234" must never be
        // swallowed by the auto-card that shares its hash (self-review catch:
        // filtering on the tag alone is a silent-loss bug, and silent loss is
        // the one thing the brain may never do).
        const isCommitCard = (c) => c && c.createdVia === 'commit' && /#commit-[0-9a-f]{7}/i.test(String(c.text || ''));
        let landedCards = cards;
        try {
            if (cards.some(isCommitCard)) {
                const { struct: cur } = await lib.parseKlypix(brainBuf);
                const already = new Set();
                for (const c of (cur.cards || []))
                    for (const m of String(c.text || '').matchAll(/#commit-([0-9a-f]{7})/gi)) already.add(m[1].toLowerCase());
                landedCards = cards.filter(c => {
                    if (!isCommitCard(c)) return true;
                    const m = /#commit-([0-9a-f]{7})/i.exec(String(c.text || ''));
                    return !already.has(m[1].toLowerCase());
                });
            }
        } catch { /* parse failed → land unfiltered; the supersede pass copes */ }
        if (!landedCards.length && !resolutions.length && !updates.length) {
            // Everything gathered was already in the brain (the git hook carded
            // it first). Advance every baseline exactly like a successful write —
            // the commits ARE durable — so the same range never re-scans.
            writeState(merged);
            writeLastCommit(newLastCommit);
            if (drainedPendingIds.size) updatePendingCaptures((current) => current.filter(b => b && !drainedPendingIds.has(b.id)));
            if (drainedShips && typeof lib.clearPendingShips === 'function') lib.clearPendingShips(CWD);
            advanceShipBaseline(lib);
            return null;
        }
        const res = await lib.captureIntoBrain(brainBuf, {
            cards: landedCards.map(c => ({ text: c.text, color: '#e8e8ed', borderColor: c.borderColor, area: c.area, createdVia: c.createdVia || 'claude-code', ...(c.closes ? { closes: c.closes } : {}), ...(c.evidence ? { evidence: c.evidence } : {}), ...(c.verify ? { verify: c.verify } : {}) })),
            resolutions,
            updates,
        });
        // Re-pack the whole grid so a container that grew never overlaps its neighbor.
        let out = res.buffer; try { out = (await lib.tidyBrain(res.buffer)).buffer; } catch { /* keep append result if tidy fails */ }
        await lib.atomicWrite(BRAIN, out);
        writeState(merged);
        writeLastCommit(newLastCommit); // advance the commit baseline only after a successful write
        if (drainedPendingIds.size) updatePendingCaptures((current) => current.filter(b => b && !drainedPendingIds.has(b.id)));
        // Same discipline for the two ship channels: the queue is consumed and
        // the observation baseline advances ONLY now that the cards are durable.
        if (drainedShips && typeof lib.clearPendingShips === 'function') lib.clearPendingShips(CWD);
        advanceShipBaseline(lib);
        try { await refreshAgentsBrief(lib, out); } catch { /* AGENTS.md refresh is best-effort */ }
        return res.stats;
    };
    // Canonical cross-process lock (heartbeat + token-checked release, shared
    // with the MCP engine and the desktop app). Stale bundles missing the module
    // fall back to the local lock — but ALWAYS refuse-and-queue on timeout.
    let lockLib = null;
    try { lockLib = await import(new URL('./brain-write-lock.mjs', import.meta.url).href); } catch { /* stale deployment */ }
    let stats;
    if (lockLib && typeof lockLib.withAdvisoryWriteLock === 'function') {
        stats = await lockLib.withAdvisoryWriteLock(lockLib.brainCaptureLockPath(BRAIN), doCapture, { tries: 100, waitMs: 60 });
    } else {
        const gotLock = acquireLock(LOCK);
        try { stats = await doCapture(gotLock); } finally { if (gotLock) releaseLock(LOCK); }
    }
    if (!stats) return;
    const bits = [`${stats.added} added`];
    if (stats.resolved) bits.push(`${stats.resolved} resolved`);
    if (stats.updated) bits.push(`${stats.updated} updated`);
    if (stats.merged) bits.push(`${stats.merged} merged`);
    if (stats.closed) bits.push(`${stats.closed} closed`);
    if (stats.superseded) bits.push(`${stats.superseded} superseded`);
    if (stats.linked) bits.push(`${stats.linked} linked`);
    process.stderr.write(`[brain] capture: ${bits.join(' · ')} → brain.klypix\n`);
    // Receipt for correction-driven (cross-area / low-bar) supersedes — the
    // confirmation channel: say WHAT was archived and how to undo a wrong grab.
    if (Array.isArray(stats.corrections) && stats.corrections.length) {
        process.stderr.write(`[brain] correction supersede: ${stats.corrections.map(c => `"${c.old}" (${c.overlap})`).join('; ')} — archived + arrowed; restore from Archive or ~ update if wrong\n`);
    }
    if (stats.added > 0 && !stats.linked) process.stderr.write(`[brain] note: ${stats.added} card(s) landed unlinked — \`brain_connect\` (or [[wikilinks]] next time) wires them into the graph\n`);
    // Fulfillment receipts (claim engine): a captured 🏁 that appears to cover a
    // live open claim raised a dashed hint — print the receipt with its
    // ready-to-emit ✓ marker AND the uncovered remainder (approving the covered
    // half must never silently retire the rest). Suggestion-only.
    if (Array.isArray(stats.fulfillCandidates) && stats.fulfillCandidates.length) {
        for (const f of stats.fulfillCandidates.slice(0, 4)) {
            const rest = f.uncovered && f.uncovered.length ? ` · does NOT cover: ${f.uncovered.map(u => `"${u.slice(0, 50)}"`).join(', ')}` : '';
            const act = f.marker
                ? `— if truly done, emit: ${f.marker}`
                : '— PARTIAL/short: the card stays open; no ✓ suggested (verify by hand; dismiss via brain_connect relationship:"not_fulfilled")';
            process.stderr.write(`[brain] ⏳ likely fulfilled (${f.cov}): "${f.item.slice(0, 70)}"${rest} ${act}\n`);
        }
    }
    // 🛠️ staleness receipts (2026-08-01): a captured 🏁 that appears to REMOVE a
    // limitation a standing skill still asserts. The skill is NEVER archived —
    // the receipt hands the session a ready-to-fill ~ amendment, because a rule
    // whose limitation half died usually keeps a trap half worth saving.
    if (Array.isArray(stats.skillStale) && stats.skillStale.length) {
        for (const f of stats.skillStale.slice(0, 3)) {
            process.stderr.write(`[brain] ⚠️ rule may be obsolete (${f.cov}): skill "${f.skill.slice(0, 70)}" asserts "${String(f.clause || '').slice(0, 60)}" — this ship appears to remove it. If so, amend: ${f.marker} (retire by naming it in closes:, or dismiss via brain_connect relationship:"not_fulfilled")\n`);
        }
    }
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
    if (!fs.existsSync(agentsPath)
        || (typeof lib.structToUltraBrief !== 'function' && typeof lib.structToBrief !== 'function')) return;
    const { struct } = await lib.parseKlypix(buffer);
    // detailRecent: 0 — this block is committed into adopters' AGENTS.md and read
    // by every hookless agent each session; it stays headlines-only by contract
    // (the SessionStart brief is where the detailed-newest tier lives).
    const brief = (typeof lib.structToUltraBrief === 'function'
        ? lib.structToUltraBrief(struct, { briefPath: '.claude/brain-brief.md', budgetChars: 3200 })
        : lib.structToBrief(struct, { recentDays: 7, maxRecent: 4, maxMilestones: 2, maxConnections: 3, detailRecent: 0 }).slice(0, 3200)).trim();
    const START = '<!-- klypix-brain-brief:start -->', END = '<!-- klypix-brain-brief:end -->';
    const block = `${START}\n<!-- auto-refreshed by the brain hook on capture · compact fallback only; brain_sync supplies task-ranked context -->\n${brief}\n${END}`;
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
    // Machine-turn guard: a harness-injected "user" prompt (task notification,
    // system reminder, slash-command wrapper) carries NO human intent — it must
    // neither become the lane's intent nor drive retrieval (it used to do both:
    // junk intent for peers, garbage tokens against the brain). null ⇒ machine.
    const humanText = deriveIntentFromPrompt(prompt);
    // Status-vocab quarantine (2026-07-23): "what is remaining?" must not
    // lexically retrieve the stale cards that SAY "remaining:" — status words
    // describe the question's shape, not its subject, and are anti-correlated
    // with truth. Content tokens only. A status-shaped prompt ALSO suppresses
    // the git-diff file-token fallback below: a stale "remaining:" card is
    // usually about the files being edited right now, so the fallback's
    // #file- tag hits re-serve the exact corpse the quarantine removed
    // (adversarial review traced the side door). The brief's computed "Area
    // status" section carries the current-state answer instead.
    let ptoks = lib.queryTokens(humanText || '');
    let statusShaped = false, statusStrong = false;
    if (typeof lib.splitQueryTokens === 'function') {
        const sp = lib.splitQueryTokens(humanText || '');
        ptoks = sp.content;
        statusShaped = sp.statusShaped;
        // strong = the prompt IS a status question (phrase shape / nothing but
        // status words); loose statusShaped only quarantines tokens. Only
        // STRONG may replace retrieval with the digest — "remove the TODO:
        // refactor X" is a work request (review fix). Older engine without
        // `strong` degrades to content-empty as the strong signal.
        statusStrong = sp.strong !== undefined ? sp.strong : (statusShaped && sp.content.length === 0);
    } else if (lib.STATUS_VOCAB instanceof Set) {
        const filtered = ptoks.filter(t => !lib.STATUS_VOCAB.has(t));
        statusShaped = filtered.length < ptoks.length;
        statusStrong = statusShaped && filtered.length === 0;
        ptoks = filtered;
    }
    // Git diff is the retrieval FALLBACK for a prompt too terse to rank on. It is
    // NOT used for the lane's files: two sessions in one repo share a working tree,
    // so the diff is identical for both — the lane's files come from each session's
    // OWN edits (set at Stop). Here we just refresh INTENT + branch + the heartbeat.
    const changedPaths = gitChangedPaths();
    const branch = gitBranch();
    // Human turn → latest prompt becomes the intent (80 chars). Machine turn →
    // keep the previous intent, but still stamp activity: a notification landing
    // here proves the session is mid-work, not idle.
    touchSession(sid, humanText !== null
        ? { intent: humanText.slice(0, 80), branch }
        : { activity: true, branch });
    // The git-diff fallback exists for TERSE HUMAN prompts ("go on") — a machine
    // turn must not fall through to it and retrieve against the whole diff.
    const fileToks = (ptoks.length < 2 && !statusShaped && humanText !== null) ? changedPaths.flatMap(fileQueryTokens) : [];
    const tokens = [...new Set(ptoks.concat(fileToks))];
    // Other live sessions in THIS repo — surfaced even when the prompt retrieves
    // nothing (a peer's presence/ship is itself the signal). Empty string when solo.
    const peers = peerFooter(sid);
    const messages = messageFooter(sid, input.transcript_path, lib);   // 📨 durable notes: offer, replay, later-action ack
    let hits = [], repeats = [], struct = null;
    if (tokens.length) {
        struct = await cachedStruct(lib);
        hits = lib.scoreCardsAgainstQuery(struct, tokens, { topK: 5, minScore: 3 });
        // PRECISION-first repeat nudge ("you already did this in another session"):
        // only on a do/build request, only completed-work cards, only high confidence.
        // Matched on the PROMPT's stated intent (ptoks), not the git-diff fallback. A
        // false nudge erodes trust, so it's strict; the loose recall list still shows.
        if (looksLikeWorkRequest(humanText || '') && typeof lib.detectRepeatWork === 'function') {
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
                // Embed the DERIVED human text, never the raw prompt — a mixed
                // turn's stripped machine block must not re-contaminate the
                // semantic query (parity with the lexical path above).
                const sem = await semlib.semanticVecs(BRAIN, struct, humanText || '', { timeoutMs: 1500 });
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
    // T8 STATUS-DIGEST INJECTION (2026-07-23): a status-shaped prompt gets the
    // COMPUTED current-state digest INSTEAD of card hits — so an agent that
    // never queried the brain still answers "what is remaining?" from state,
    // not from whichever stale claim happened to rank. REPLACES freshHits
    // (never additive) and is hash-deduped per session: turn 2+ of the same
    // status conversation gets a one-line pointer, not another 2KB.
    let statusMd = '';
    if (statusStrong && typeof lib.areaStatusDigest === 'function') {
        if (!struct) { try { struct = await cachedStruct(lib); } catch { struct = null; } }
        if (struct) {
            try {
                const digest = lib.areaStatusDigest(struct, { maxAreas: 12 });
                // The digest alone is per-area COUNTS ("· 8 open ·") — it never
                // names a single open card, yet this block also clears freshHits,
                // so a status prompt used to arrive with the instruction "answer
                // from THIS" and nothing to answer FROM. An agent then reports
                // whatever the session brief happened to show, which is itself a
                // truncated tier — the 2026-07-25 field incident, where 8 live
                // opens (including a founder-ranked #1 bug) were invisible on
                // both surfaces at once. Prefer the full computed view — digest
                // AND every open card, honestly overflow-marked — and keep the
                // bare digest only as the fallback for an older engine.
                let body = null;
                if (typeof lib.statusContextToMarkdown === 'function') {
                    try {
                        // Sized so a real brain fits BOTH a full area digest and
                        // every open at readable width (~140 chars) — this block
                        // IS the answer to the question that triggered it, it is
                        // hash-deduped per session, and it replaces freshHits
                        // rather than adding to them. Paying ~1.2k tokens once
                        // per status conversation beats answering it wrong.
                        const md = lib.statusContextToMarkdown(struct, { budgetChars: 5200 });
                        // Drop its own H1; the hook's stronger header replaces it.
                        if (md && md.trim()) body = md.split('\n').slice(1).join('\n').trimEnd();
                    } catch { body = null; }
                }
                const content = body || digest.join('\n');
                if (digest.length) {
                    const h = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
                    let lane = null; try { lane = readSessions().find(s => s.id === sid) || null; } catch { /* */ }
                    if (lane && lane.statusDigestHash === h) {
                        statusMd = '## 📊 Current state — unchanged since the digest shown earlier this session (`brain_ask` gives the full computed status view).';
                    } else {
                        statusMd = ['## 📊 Computed current state (status-shaped question detected — answer from THIS + `brain_ask`, never from memory of past sessions)', content].join('\n');
                        try { touchSession(sid, { statusDigestHash: h }); } catch { /* best-effort */ }
                    }
                    freshHits = [];
                }
            } catch { /* best-effort */ }
        }
    }
    // Other live sessions' in-flight events (struct may be null on a token-less
    // prompt — then representedInBrain just keeps entries; they're rarely in-brain yet).
    const inflight = inflightFooter(sid, struct);
    // Rule-draft nudge — the same-session promote-me push. Gated on struct so the
    // "already covered by a live 🛠️ skill" filter always runs (a token-less prompt
    // leaves struct null; SessionStart's own draft surface + count line cover that
    // case) and so a terse prompt pays zero extra parse cost.
    const drafts = struct ? ruleDraftsFooter(sid, struct, { markShown: true }) : '';
    // Routed cross-lane findings — NOT gated on struct: a routed finding is about
    // the LANE (who declared which path), never about brain content, so a
    // token-less prompt must still surface it. Same markShown contract as above.
    const findings = await findingDraftsFooter(sid, { markShown: true });
    if (!repeats.length && !freshHits.length && !peers && !inflight && !messages && !drafts && !findings && !statusMd) return; // nothing → zero output, zero added context
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const day = (ts) => ts ? new Date(ts).toISOString().slice(0, 10) : '';
    const head = (c, n = 120) => { const t = flat(c.text); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    const lines = [];
    if (statusMd) lines.push(statusMd);
    if (repeats.length) {
        // A nudged "already shipped" card may itself have been CORRECTED since —
        // nudging the agent to reuse a stale fact would be worse than no nudge.
        let repOverlays = new Map();
        if (struct && typeof lib.correctionOverlaysFor === 'function') {
            try { repOverlays = lib.correctionOverlaysFor(struct, repeats.map(r => r.card)); } catch { /* best-effort */ }
        }
        lines.push('## ⚠️ Possible repeat — this may already be done (reuse/supersede, don’t silently redo)');
        for (const r of repeats) {
            const verb = r.kind === 'superseded'
                ? `you moved OFF this ${day(r.card.createdAt)} — check what replaced it before redoing`
                : `already ${r.kind} ${day(r.card.createdAt)} — reuse/build on it, or supersede it deliberately`;
            const ov = repOverlays.get(r.card.id);
            const corr = ov ? `  · ⚠️ a live CORRECTION exists — read it first: “${head(ov.by, 90)}”` : '';
            lines.push(`- [${flat(r.card.area) || '?'}] ${head(r.card)}  · ${verb}${corr}`);
        }
        lines.push('Read the matching card (klypix-canvas MCP / brain) BEFORE redoing. Other project? use search_all_brains.');
    }
    if (freshHits.length) {
        // Truth-decay guard: for each hit with a supersede/close edge or an
        // overlapping live correction-cue card, inject the CORRECTOR full-text
        // FIRST and reduce the stale hit to a labeled headline — a stale card
        // must never stand alone (the worst failure mode a memory can have).
        let overlays = new Map();
        if (struct && typeof lib.correctionOverlaysFor === 'function') {
            try { overlays = lib.correctionOverlaysFor(struct, freshHits.map(h => h.card)); } catch { /* best-effort */ }
        }
        // Awaits-merge decay: a hit saying "PR #N awaits merge" gets a merged-overlay
        // when a harvested ship event already recorded #N MERGED (deterministic, no
        // retirement — the fact is right, only its status decayed).
        let mergeOv = new Map();
        if (struct && typeof lib.mergeOverlaysFor === 'function') {
            try { mergeOv = lib.mergeOverlaysFor(struct, freshHits.map(h => h.card)); } catch { /* best-effort */ }
        }
        const mergeTag = (id) => { const m = mergeOv.get(id); return m ? `\n  ↳ ⚠️ PR #${m.num} is since MERGED${m.date ? ` (ship event ${m.date})` : ''} — this "awaits merge" note is stale; nothing to do.` : ''; };
        // Per-session injection dedup: a card already shown full-text this session
        // renders as one headline, not another ~600 words of context. LARGE cards
        // (>1KB) are tracked in a separate, deep-capped ledger so the 100-entry
        // `injected` set's eviction can never re-inflate one (the observed 3× bug).
        const BIG_CHARS = 1000;
        let me = null; try { me = readSessions().find(s => s.id === sid) || null; } catch { /* */ }
        const injected = new Set((me && Array.isArray(me.injected)) ? me.injected : []);
        const injectedBig = new Set((me && Array.isArray(me.injectedBig)) ? me.injectedBig : []);
        const isBig = (c) => flat(c.text).length > BIG_CHARS;
        const wasInjected = (c) => injected.has(c.id) || (isBig(c) && injectedBig.has(c.id));
        const shownNow = new Set();
        lines.push(semMode === 'sem-hit'
            ? "# Related prior decisions (semantic match — no exact keyword overlap; full brain via the klypix-canvas MCP)"
            : "# Relevant prior decisions from this project's brain (task-matched; full brain via the klypix-canvas MCP)");
        const newlyInjected = [], newlyBig = [];
        const noteInjected = (c) => { newlyInjected.push(c.id); if (isBig(c)) newlyBig.push(c.id); };
        for (const h of freshHits) {
            if (shownNow.has(h.card.id)) continue;                      // already rendered this turn (e.g. as a corrector)
            const ov = overlays.get(h.card.id);
            if (ov) {
                // The STALE demotion is UNCONDITIONAL — even when the corrector
                // already rendered (as its own hit, or for a twin), the stale
                // card must never fall through to the plain full-text branch.
                // The corrector prints full-text at most once per session.
                let correctorLine = false;
                if (!shownNow.has(ov.by.id)) {
                    correctorLine = true;
                    if (wasInjected(ov.by)) {
                        lines.push(`- ⚠️ CORRECTED — current (already shown this session): ${head(ov.by, 110)}`);
                    } else {
                        lines.push(`- ⚠️ CORRECTED — current: ${flat(ov.by.text)}`);
                        noteInjected(ov.by);
                    }
                    shownNow.add(ov.by.id);
                }
                lines.push(`${correctorLine ? '  ↳' : '-'} ⚠️ recall matched a STALE card${ov.kind === 'edge' ? ' (superseded)' : ''}: “${head(h.card, 110)}” — do NOT act on it${correctorLine ? '' : ' (its CORRECTION is listed above)'}. Reconcile: \`brain_reconcile\` (contradictions) or a ✓/~ marker.`);
                shownNow.add(h.card.id);
                continue;
            }
            if (wasInjected(h.card)) {
                lines.push(`- (already shown this session) ${head(h.card, 110)}${mergeTag(h.card.id)}`);
                shownNow.add(h.card.id);
                continue;
            }
            lines.push(`- ${flat(h.card.text)}${mergeTag(h.card.id)}`);
            shownNow.add(h.card.id);
            noteInjected(h.card);
        }
        if (newlyInjected.length) {
            const patch = { injected: [...new Set([...injected, ...newlyInjected])].slice(-100) };
            if (newlyBig.length) patch.injectedBig = [...new Set([...injectedBig, ...newlyBig])].slice(-400);
            touchSession(sid, patch);
        }
    }
    const parts = [];
    if (lines.length) parts.push(lines.join('\n'));
    if (drafts) parts.push(drafts.replace(/^\n+/, '')); // 🛠️ pending rule drafts awaiting approval (its own block)
    if (findings) parts.push(findings.replace(/^\n+/, '')); // 📬 routed cross-lane findings awaiting a deliberate send
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
            + `Route by kind: this per-user store is for how to work with *this user* (prefs, feedback, session logs) — keep it for that. **Project** decisions, milestones & open questions belong in the brain above (shared + portable, read by the next agent), NOT here. If any project knowledge currently lives only in this store, capture it into the brain so it isn't lost on the next session. Don't duplicate the same fact into both.\n`;
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
            if (stamp && stamp.dirty) {
                // The flag is a DEPLOY-TIME snapshot — show its age and say so, so a
                // week-old DIRTY (or one whose source was since committed) reads as
                // "re-deploy to re-evaluate", not as a live fact (2026-07-29 audit).
                const dep = Date.parse(stamp.deployedAt);
                const age = Number.isFinite(dep) ? Math.round((Date.now() - dep) / 3_600_000) : null;
                const ageLabel = age === null ? '' : age >= 48 ? ` ${Math.floor(age / 24)}d ago` : ` ${Math.max(1, age)}h ago`;
                probs.push(`running a DIRTY deploy — uncommitted hook code at deploy time (source ${stamp.sourceSha || '?'}, deployed${ageLabel}; the flag is deploy-time — committing alone does NOT clear it). Re-run \`node scripts/deploy-brain.mjs\` for an auditable brain`);
            }
        } catch { /* no stamp → deployed the old way; stay silent */ }
        if (!probs.length) return '';
        return '\n\n---\n## ⚠️ Brain self-check — the brain reported a problem with ITSELF\n'
            + 'The hook exits 0 by contract, so this is otherwise invisible (you\'d only notice by missing cards):\n'
            + probs.map(p => `- ${p}`).join('\n')
            + `\n_Log: \`~/.claude/project-brain/.hook-health.jsonl\`. Re-deploy with \`node scripts/deploy-brain.mjs\`._\n`;
    } catch { return ''; }
}

// ── Version-currency — the brain surfaces its OWN staleness, ambiently ───────
// doctorFooter (below) is deliberately network-free, so a stale install never
// announced itself until someone ran `npx klypix-mcp doctor --npm` — the human was
// the drift detector (the desktop-lag incident). These two functions close that gap
// WITHOUT breaking the no-network-in-session-start rule:
//   • refreshNpmCurrency() runs on the Stop hook (post-session), ≤ once/day,
//     best-effort + failure-silent — it fetches npm `latest` into a local cache.
//   • versionCurrencyFooter() runs at SessionStart and reads ONLY that cache
//     (pure fs, NO fetcher) — so it CANNOT make a network call by construction.
// `doctor` stays the authoritative on-demand full check (unchanged).

// The ONLY network path (kept separate so the footer is fetcher-less). Resolves the
// published `latest` via the registry's lightweight per-version endpoint. Zero deps
// (node https), tight timeout, rejects on any failure. Injectable in tests.
function httpsFetchLatest(pkg = 'klypix-mcp', timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        // GET /{pkg}/latest with the DEFAULT json accept — the abbreviated
        // `vnd.npm.install-v1+json` type is only served by the full packument
        // endpoint and 406s here. This returns the latest version manifest (~few KB).
        const req = https.get(`https://registry.npmjs.org/${pkg}/latest`,
            { headers: { accept: 'application/json' } }, (res) => {
                if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode)); }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(new Error('too large')); });
                res.on('end', () => { try { const v = JSON.parse(body).version; v ? resolve(String(v)) : reject(new Error('no version')); } catch (e) { reject(e); } });
            });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    });
}

// Throttled (≤ once/day), best-effort, failure-silent refresh of the npm-latest
// cache — runs on the Stop hook only. NEVER throws. `now`/`fetcher`/`file`/`ttl`
// are injectable so tests stay hermetic (no real network). A failed fetch still
// stamps `checkedAt` (so we don't hammer when offline) and keeps a prior good
// `latest`. Returns a small status object; callers ignore it.
async function refreshNpmCurrency({ now = Date.now(), fetcher = httpsFetchLatest, file = NPM_CURRENCY, ttl = NPM_CURRENCY_TTL, pkg = 'klypix-mcp' } = {}) {
    try {
        let prev = null;
        try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no cache yet */ }
        if (prev && Number.isFinite(prev.checkedAt) && (now - prev.checkedAt) < ttl) return { skipped: 'throttled', prev };
        let latest = (prev && prev.latest) || null, lastError = null;
        try { latest = await fetcher(pkg); } catch (e) { lastError = String((e && e.message) || e).slice(0, 120); }
        const next = { pkg, latest: latest || null, checkedAt: now, ...(lastError ? { lastError } : {}) };
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(next, null, 2)); } catch { /* best-effort */ }
        return { fetched: !lastError, latest: next.latest, lastError };
    } catch { return { skipped: 'error' }; }
}

// Read the BAKED brain-core version from the deployed klypix-mcp-server.mjs — the
// channel-independent source of truth (the install stamp's version key varies by
// channel). Null when not deployed (a dev source checkout w/o a server file) → the
// footer then stays silent (nothing to compare).
function bakedBrainVersion(brainDir = path.dirname(NPM_CURRENCY)) {
    try {
        const m = fs.readFileSync(path.join(brainDir, 'klypix-mcp-server.mjs'), 'utf8').match(/const PKG_VERSION = '([^']+)'/);
        return m ? m[1] : null;
    } catch { return null; }
}

// SessionStart footer — ambient version drift. Reads ONLY the local cache (zero
// network, no fetcher) + the baked version, and emits ONE advisory line when the
// installed brain is behind npm `latest`. SILENT when current/ahead, when the cache
// is missing or unknown ("(offline)" sentinel), or when there's no baked version to
// compare against — no nag, no noise.
function versionCurrencyFooter({ file = NPM_CURRENCY, brainDir = path.dirname(NPM_CURRENCY), env = process.env } = {}) {
    try {
        let cache; try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return ''; }
        const latest = cache && cache.latest;
        // Require a well-formed semver before comparing — rejects missing, the
        // "(offline)" sentinel, and any hand-corrupted cache value (e.g. `123`,
        // `v1.14.0`) that could otherwise false-nag or false-silence. Silent.
        if (!latest || !/^\d+\.\d+\.\d+/.test(String(latest))) return '';
        const baked = bakedBrainVersion(brainDir);
        if (!baked) return '';                                           // nothing to compare → silent
        if (cmpSemver(latest, baked) <= 0) return '';                    // current or ahead → silent
        if (!autoUpdateEnabled(env)) {
            return `\n\n---\n⚠️ **Brain update available** — installed brain core \`v${baked}\` < npm latest \`v${latest}\`. Automatic updates are off; run \`npx klypix-mcp install\`.\n`;
        }
        return `\n\n---\n⬆️ **Brain update available** — installed brain core \`v${baked}\` < npm latest \`v${latest}\`. KLYPIX will install it automatically in the background; no action required.\n`;
    } catch { return ''; }
}

// ── Readiness footer — catch a HALF-WIRED install (liveness ≠ readiness) ─────
// SessionStart firing proves the brain is ALIVE; but the OTHER three hooks are what
// make it LEARN — UserPromptSubmit (recall), Stop (capture), PostToolUse (live sync).
// A settings.json edit, a partial install, or a manual hook-prune can drop any of them,
// leaving the brain reading-but-not-capturing — invisible until cards silently go
// missing. This reads settings.json and says so in ONE line when drifted. Cheap +
// namespace-safe (no version compare, no network); never throws. The full picture
// (version currency, harness-projection drift, live peers) lives in `npx klypix-mcp
// doctor` — the footer only carries the one signal worth interrupting every session for.
function doctorFooter() {
    try {
        const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
        if (!fs.existsSync(SETTINGS)) return '';
        let settings; try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return ''; }
        const wiredFor = (evt) => {
            const groups = settings?.hooks?.[evt];
            return Array.isArray(groups) && groups.some(g => Array.isArray(g?.hooks)
                && g.hooks.some(h => typeof h?.command === 'string' && h.command.includes('global-brain-hook')));
        };
        const missing = [['UserPromptSubmit', 'per-prompt recall'], ['Stop', 'decision capture'], ['PostToolUse', 'live sync']]
            .filter(([evt]) => !wiredFor(evt));
        if (!missing.length) return '';
        return '\n\n---\n## ⚠️ Brain half-wired — readiness\n'
            + `SessionStart fired (the brain is alive), but ${missing.length} hook(s) that make it LEARN are not wired: `
            + missing.map(([evt, what]) => `**${evt}** (${what})`).join(', ') + '.\n'
            + 'The brain will read but silently stop capturing/syncing decisions. Re-wire: `npx klypix-mcp install`, then restart this session.\n';
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
        + '**Correcting a stale card:** include the word `CORRECTION` (or "was WRONG" / "OBSOLETE" — UPPERCASE; casing is the deliberate-signal, casual prose never fires it) in the decision — the capture then hunts the stale card across ALL areas at a lower match bar and supersedes it (archived + arrowed, with a receipt; restore from Archive if it grabbed the wrong one). A rephrased duplicate `?` merges into the existing open question instead of stacking a twin.\n'
        + '**Verified-fix rule drafts:** when a session FIXES + VERIFIES something trap-shaped that landed as a one-off note, the Stop hook auto-DRAFTS a candidate 🛠️ rule (a per-project sidecar — never a brain card). Approve a real recurring trap with the `+` marker the nudge shows you and it becomes a standing rule that fires EVERY session (like the release-naming rule); ignore the rest and they age out. Draft-only, no blind auto-capture.\n'
        + '**Session brief:** the SessionStart hook prints a ≤2KB ultra brief and writes the FULL brief to `.claude/brain-brief.md` — read that file when planning non-trivial work.\n'
        + '**Routing:** capture project decisions / milestones / open questions / gotchas HERE, *at the moment you decide* — this brain is the shared, portable memory that survives context resets and the next agent reads. A host memory store (if any) is for *user* preferences; never leave project state only in a private scratchpad.\n'
        + 'Coordinate with a concurrent session: `🧠 MSG [<their-id or all>]: <text>` — a queued note (NOT a brain card), offered on a supported model-context action and replayed until a later action acknowledges the offer.\n';
}

// ── Self-update on SessionStart (auto-propagation, part B — the lever) ────────
// The one trigger that fires for EVERY user EVERY session. Turn the passive advisory
// ("an update is available", which is not itself delivery) into an ACTION: if a newer
// version is on npm, spawn a DETACHED, fail-open updater so the NEXT session runs it —
// "publish ⇒ everywhere, automatically." Non-negotiables, all enforced here:
//   • fail-open — any error/offline/missing-npx degrades silently to the current version;
//   • throttled — a global once/24h stamp (not per-project, not per-session);
//   • dev-safe — a dev deploy (dev:true) owns its brain and is NEVER auto-updated;
//   • zero session-path cost — spawn detached+unref, never awaited;
//   • honest — install respects never-downgrade + dev gates, so a mis-fire can't harm.
// It reads the npm-latest CACHE the Stop hook already maintains (zero network here).
const AUTOUPDATE_STAMP = path.join(os.homedir(), '.claude', 'project-brain', '.autoupdate-check.json');
const AUTOUPDATE_TTL = 24 * 60 * 60 * 1000;
function autoUpdateEnabled(env = process.env) {
    const v = String(env?.KLYPIX_AUTO_UPDATE ?? '').trim().toLowerCase();
    return !(v === '0' || v === 'off' || v === 'false' || v === 'no');   // default ON
}
function writeAutoUpdateStamp(now) { try { fs.mkdirSync(path.dirname(AUTOUPDATE_STAMP), { recursive: true }); fs.writeFileSync(AUTOUPDATE_STAMP, JSON.stringify({ lastCheck: now })); } catch { /* */ } }
// Cross-platform detached spawn: npx is npx.cmd on Windows (needs shell); detach +
// unref so it outlives this hook; swallow the 'error' event so a missing npx / offline
// resolve can never surface. Returns null on any throw.
function spawnDetached(cmd, args, options = {}) {
    try {
        const child = spawn(cmd, args, {
            cwd: options.cwd || CWD,
            env: options.env || process.env,
            detached: true,
            stdio: 'ignore',
            shell: options.shell ?? (process.platform === 'win32'),
            windowsHide: true,
        });
        child.on('error', () => { /* fail-open: npx missing / offline */ });
        child.unref();
        return child;
    } catch { return null; }
}
// PURE decision (exported for the acceptance gauntlet): given the inputs, should we
// self-update, and why? Order matters — throttle is checked first so the caller knows
// NOT to reset the window; every other negative reason is post-throttle (caller stamps).
export function shouldSelfUpdate({ enabled, now, lastCheck, ttl = AUTOUPDATE_TTL, dev, latest, installed } = {}) {
    if (!enabled) return { act: false, reason: 'disabled' };
    if (Number.isFinite(lastCheck) && (now - lastCheck) < ttl) return { act: false, reason: 'throttled' };
    if (dev) return { act: false, reason: 'dev-owned' };                                      // a dev deploy owns its brain
    if (!latest || !/^\d+\.\d+\.\d+/.test(String(latest)) || !installed) return { act: false, reason: 'unknown' };  // offline / no baked version
    if (cmpSemver(latest, installed) <= 0) return { act: false, reason: 'current' };          // current or ahead
    return { act: true, reason: 'update', latest };
}
function maybeSelfUpdate() {
    try {
        // New installations share the exact same host-neutral updater used by
        // Codex/Cursor/Cline/generic MCP supervisors. Starting it here preserves
        // Claude's bootstrap path even when no MCP connection is open, while the
        // helper's machine lock + 24h stamp prevent duplicate work.
        const brainDir = path.join(os.homedir(), '.claude', 'project-brain');
        const helper = path.join(brainDir, 'mcp-auto-update.mjs');
        if (fs.existsSync(helper)) {
            spawnDetached(process.execPath, [helper, '--klypix-auto-update-worker'], {
                cwd: os.tmpdir(),
                env: {
                    ...process.env,
                    KLYPIX_MCP_AUTO_UPDATE_DIR: brainDir,
                    KLYPIX_MCP_AUTO_UPDATE_CURRENT: bakedBrainVersion() || '',
                    KLYPIX_MCP_AUTO_UPDATE_CHILD: '1',
                },
                shell: false,
            });
            return;
        }

        // Pre-host-neutral installations retain their original cache-driven
        // updater. Its only job now is to bootstrap the release that contains
        // mcp-auto-update.mjs; subsequent checks use the shared helper above.
        const now = Date.now();
        let lastCheck = null; try { lastCheck = JSON.parse(fs.readFileSync(AUTOUPDATE_STAMP, 'utf8')).lastCheck; } catch { /* first run */ }
        let dev = false; try { dev = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'project-brain', '.brain-version.json'), 'utf8')).dev === true; } catch { /* */ }
        let latest = null; try { latest = JSON.parse(fs.readFileSync(NPM_CURRENCY, 'utf8')).latest; } catch { /* */ }
        const d = shouldSelfUpdate({ enabled: autoUpdateEnabled(), now, lastCheck, dev, latest, installed: bakedBrainVersion() });
        if (d.reason === 'throttled') return;   // keep the window — don't re-stamp
        writeAutoUpdateStamp(now);              // passed throttle → reset the 24h window regardless of outcome
        // Apply: detached, fail-open. cwd=CWD so install also migrates THIS project's
        // .mcp.json off npx. install self-enforces never-downgrade + dev gates.
        if (d.act) spawnDetached('npx', ['-y', `klypix-mcp@${d.latest}`, 'install']);
    } catch { /* self-update is best-effort — never break a session */ }
}

async function read(lib) {
    const input = readHookInput();
    // Auto-propagation lever: fire-and-forget a self-update check (detached, throttled,
    // fail-open) so a newer published brain installs itself for the next session.
    maybeSelfUpdate();
    // Register presence at session start so a peer already running sees this session
    // immediately. Files/ships come from live observation + Stop.
    touchSession(input.session_id, { branch: gitBranch() });
    // One-line presence summary — session start is exactly when an agent decides
    // whether to coordinate, and this surface previously listed ZERO peers (the
    // peer footer is prompt-path-only; 2026-07-29 audit). Count only, explicitly
    // stamped as a snapshot: the per-prompt footer carries the live detail.
    const presenceLine = (() => {
        try {
            const peerCount = livePeers(input.session_id).length;
            return peerCount ? `\n👥 ${peerCount} other live session(s) in this project right now (snapshot at session start — the per-prompt peer footer stays current; \`npx klypix-mcp doctor\` lists all).` : '';
        } catch { return ''; }
    })();
    // One compact receipt at SessionStart closes the sender's "did it surface?"
    // loop without repeating on every prompt. Full lane health remains available
    // on demand through brain_doctor; acknowledgement is never human-read proof.
    const receiptLine = await receiptFooter(input.session_id || '');
    // Class-C decay leg: notice ships that happened while no hooked session was
    // watching (tag/version drift vs the per-project sidecar) and queue them
    // for the Stop capture. The line rides BOTH emit tiers.
    const shipObsLine = observeOutOfSessionShips(lib);
    // Commit-capture completeness (2026-08-07): the Stop hook's commit walk is
    // blind to commits authored in OTHER worktrees/branches and to non-hooked
    // agents. Ensure the agent-neutral git post-commit/post-merge hook is wired
    // — writes only files we fully own (absent or marker-fenced ours), never a
    // foreign hook. Dynamic + guarded so a stale bundle degrades to a no-op.
    const gitHookNotice = await (async () => {
        try {
            const ghl = await import(new URL('./git-capture-install.mjs', import.meta.url).href);
            return typeof ghl.ensureGitCaptureHook === 'function' ? (ghl.ensureGitCaptureHook(CWD).notice || '') : '';
        } catch { return ''; }
    })();
    const { struct } = await lib.parseKlypix(fs.readFileSync(BRAIN));
    const { freshness, drifted } = computeFreshness(struct);
    // The FULL brief: tiered brief + every self-heal/health footer. Messages are
    // deliberately NOT part of it (messageFooter ACKS on read — it must only ever
    // go to stdout, where the agent actually sees it, exactly once).
    const full = ((typeof lib.structToBrief === 'function') ? lib.structToBrief(struct, { freshness }) : lib.structToMarkdown(struct))
        + inflightFooter(input.session_id, struct) + selfHealFooter(drifted) + reconcileFooter(lib, struct) + staleOpenFooter(lib, struct)
        + ruleDraftsFooter(input.session_id, struct, { markShown: false })
        + receiptLine + selfCheckFooter() + doctorFooter() + versionCurrencyFooter() + legendFooter() + memoryFooter();
    const emitFull = () => {
        process.stdout.write(full + presenceLine + shipObsLine + gitHookNotice + messageFooter(input.session_id || '', input.transcript_path, lib));
        appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'read', ok: true, briefBytes: Buffer.byteLength(full), cards: struct?.counts?.cards ?? null }, 500);
    };
    // --full = everything to stdout (manual runs); also the fallback when the
    // live klypix-format predates the ultra tier (version skew) or the brief
    // file can't be written (stdout is then the only channel).
    if (process.argv.includes('--full') || typeof lib.structToUltraBrief !== 'function') return emitFull();
    // Default = ULTRA tier. The harness persists hook stdout and shows only a
    // ~2KB preview, so a 13KB brief was mostly invisible — write the FULL brief
    // to a stable project-local file and print a tier that fits the preview
    // whole: Focus + conflicts + open questions + alerts + the file's path.
    const briefRel = '.claude/brain-brief.md';
    try {
        fs.mkdirSync(path.resolve(CWD, '.claude'), { recursive: true });
        // The absolute as-of stamp makes a stale copy self-evident: presence /
        // in-flight / session lines inside are a snapshot of THIS instant, and a
        // long-lived chat must re-query (brain_sync / doctor), not re-report them.
        fs.writeFileSync(path.resolve(CWD, briefRel),
            `<!-- auto-generated by the brain hook at session start (${nowIso()}) — read it, don't edit it; regenerated next session. Presence/in-flight/session lines are a snapshot of that instant — query brain_sync or \`npx klypix-mcp doctor\` for live peers before reporting them. -->\n` + full, 'utf8');
    } catch { return emitFull(); }
    const ultra = lib.structToUltraBrief(struct, { freshness, briefPath: briefRel });
    // Self-heal tiers compress to ONE line up here; the actionable detail (which
    // cards, which markers to emit) lives in the brief file.
    const heals = [];
    if (drifted && drifted.length) heals.push(`${drifted.length} code-anchored fact(s) DRIFTED`);
    try {
        if (typeof lib.findUnrecordedMigrations === 'function') {
            const files = collectMigrationFiles(CWD);
            if (files.length) { const { total } = lib.findUnrecordedMigrations(struct, files, { max: 6 }); if (total) heals.push(`${total} unrecorded migration(s)`); }
        }
    } catch { /* */ }
    try { if (typeof lib.findStaleOpenCards === 'function') { const { total } = lib.findStaleOpenCards(struct, { max: 5 }); if (total) heals.push(`${total} open card(s) look already done`); } } catch { /* */ }
    const healLine = heals.length ? `\n🔧 Self-heal: ${heals.join(' · ')} — detail + fix markers in ${briefRel}.` : '';
    // Rule-draft nudge (capture-coverage): a one-line count in the preview; the full
    // promote-markers live in the brief file (read-only here — no shown-mark).
    const pendingDrafts = livePendingDrafts(struct);
    const draftLine = pendingDrafts.length ? `\n🛠️ ${pendingDrafts.length} draft rule(s) from verified fixes await approval — promote-markers in ${briefRel} (turn a recurring trap into a rule that fires every session).` : '';
    // 📨 messages are delivered-ONCE (acked the moment this reads them) — they
    // go right after the ultra brief, at the top of the visible window, never
    // after a stack of footers that could push them past a preview cut.
    const messages = messageFooter(input.session_id || '', input.transcript_path, lib);
    const out = ultra + messages + presenceLine + shipObsLine + gitHookNotice + healLine + draftLine
        + receiptLine
        + inflightFooter(input.session_id, struct)
        + selfCheckFooter() + doctorFooter() + versionCurrencyFooter();
    process.stdout.write(out);
    // Heartbeat: prove the brief actually injected (and how big) so a dead or
    // stale live-copy of the hook stops being a silent no-op.
    appendJsonl(HEALTH, { ts: nowIso(), project: path.basename(CWD), mode: 'read', ok: true, briefBytes: Buffer.byteLength(out), fullBriefBytes: Buffer.byteLength(full), cards: struct?.counts?.cards ?? null }, 500);
}

// Registry of every brain this machine has touched — written on each hook run,
// read by the MCP's search_all_brains for vault-wide, cross-project memory
// ("what did I decide about auth — in ANY project?"). Zero-config data gravity:
// just having worked in a brain project makes it searchable. Never throws.
async function registerBrain() {
    // Current runtimes share the same locked+atomic registry writer as
    // brain_sync, so simultaneous Claude/Codex/other-host starts cannot lose a
    // project. Keep the legacy body below as a compatibility fallback for an
    // older flat deployment that does not contain mcp-auto-update.mjs yet.
    try {
        const registry = await import('./mcp-auto-update.mjs');
        if (typeof registry.registerProjectBrain === 'function') {
            const result = registry.registerProjectBrain({ brainPath: BRAIN });
            if (result?.registered || result?.reason === 'busy') return;
        }
    } catch { /* legacy fallback below */ }
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
    await registerBrain();
    if (process.argv.includes('--capture')) {
        // Stop = fold-in + clear: capture() writes this turn's markers/ships into the
        // brain, then we drop this session's now-durable in-flight ledger entries.
        // try/finally so the clear runs across capture()'s early returns AND a throw
        // (on throw, ship/milestone re-capture next Stop; a version is on disk — no loss).
        try { await capture(lib); } finally { clearLiveLedgerForSession(readHookInput().session_id); }
        // Ambient version-currency: piggyback the post-session Stop hook to refresh the
        // npm-latest cache (≤ once/day, best-effort, failure-silent) so the next
        // SessionStart footer can surface a stale install with ZERO network. Awaited so
        // the throttled request finishes before exit; bulletproof (never throws/blocks).
        await refreshNpmCurrency().catch(() => {});
    } else await read(lib);
}
// Run as the hook by default. The ONLY way main() is skipped is the explicit
// opt-out flag a hermetic test sets before importing this module for its pure
// exports — production never sets it, so runtime behavior is byte-identical (no
// fragile entry-point/argv path-matching in the most safety-critical hook).
if (!process.env.KLYPIX_BRAIN_NO_MAIN) {
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
}

// Exported for hermetic unit tests only (gated by KLYPIX_BRAIN_NO_MAIN above so the
// import doesn't run main()/exit the test). Not part of the runtime hook contract.
export { refreshNpmCurrency, versionCurrencyFooter, bakedBrainVersion, httpsFetchLatest, cmpSemver, decayStampForMessage, messageFooter, splitMarkerSuffixes, evidenceGitPath, gitBlobOid, computeFreshness, selfHealFooter };
// (shouldSelfUpdate is exported at its declaration above — the auto-propagation decision seam for tests)
