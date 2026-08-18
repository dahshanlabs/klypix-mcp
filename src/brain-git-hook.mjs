#!/usr/bin/env node
// brain-git-hook — agent-NEUTRAL commit capture for ./brain.klypix.
//
// Installed by KLYPIX as a git post-commit / post-merge hook (Settings → connect
// a project's brain). It captures rationale-bearing feat/fix/perf commit BODIES
// into the project brain regardless of WHICH agent (Cursor, Cline, Codex, or a
// human) made the commit — the universal half of the Claude-Code Stop hook,
// which keys off the COMMIT rather than an agent-specific transcript.
//
// Bulletproof by contract (it runs on EVERY commit in a connected repo): instant
// no-op when there's no ./brain.klypix, NEVER throws, ALWAYS exits 0. It is the
// SAME capture rule the Claude-Code hook uses (CC_RE + body>=12 rationale gate).
// Quiet trees (KLYPIX_BRAIN_QUIET=1 / .klypix-brain-quiet) and ephemeral
// checkouts (linked worktrees, OS-temp trees) are skipped at run time — the
// hook lives in the COMMON hooks dir and used to dirty release worktrees;
// KLYPIX_BRAIN_WORKTREE_CAPTURE=1 opts a deliberate worktree back in.
//
// Two safety properties for the case where a repo ALSO runs the Claude-Code Stop
// hook (the dogfood scenario — both would otherwise capture the same commit):
//   • No double-record — captureIntoBrain does NOT dedup, so this hook reads the
//     brain inside the lock and SKIPS any commit whose `#commit-<7>` tag is
//     already present (catches both a re-run and the Claude-Code hook's copy).
//   • No lost write — it takes the SAME advisory `.claude/brain-capture.lock` the
//     Stop hook uses, so a concurrent post-commit + Stop serialize (atomicWrite
//     stops corruption, the lock stops last-writer-wins update loss).
//
// Lives in the project-brain bundle beside klypix-format.mjs (which it imports
// for parse/capture/tidy/atomic-write); a tiny per-repo last-commit file keeps it
// incremental + flood-proof (baselines to HEAD on first run, re-baselines on a
// rewritten history).
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const CWD = process.argv[2] || process.cwd();
const BRAIN = path.resolve(CWD, 'brain.klypix');
const STATE = path.resolve(CWD, '.claude', 'brain-last-commit-git');
// The SAME cross-process lock the Stop hook, MCP engine, and desktop app use —
// imported from brain-write-lock.mjs (heartbeat + token-checked release), so
// there is exactly ONE lock implementation. On timeout this hook REFUSES to
// write and leaves its commit baseline untouched, so the same commits re-scan
// on the next commit instead of clobbering a peer's just-merged cards.

const git = (a) => execSync(`git ${a}`, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const CC_RE = /^(feat|fix|perf)(?:\(([^)]+)\))?!?:\s*(.+)$/i;

function commitToCard(c) {
    const m = CC_RE.exec(c.subject);
    if (!m) return null;                                            // only feat / fix / perf
    const body = c.body.replace(/\s+/g, ' ').trim();
    if (body.length < 12) return null;                             // rationale-bearing only — not a log dump
    const type = m[1].toLowerCase(), scope = (m[2] || '').trim(), desc = m[3].trim();
    const area = scope || (type === 'feat' ? 'Milestones' : 'Fixes');
    const prefix = type === 'feat' ? '🏁 ' : '';
    return {
        text: `${area}: ${prefix}${desc}\n\n${body.slice(0, 400)}\n#${slug(area)} #commit-${c.hash.slice(0, 7)}`,
        area, borderColor: type === 'feat' ? 'rgba(59,130,246,0.8)' : 'rgba(16,185,129,0.6)', createdVia: 'git',
    };
}
function parseLog(raw) {
    return String(raw).split('\x1e').map(s => s.trim()).filter(Boolean).map(rec => {
        const p = rec.split('\x1f');
        return { hash: (p[0] || '').trim(), subject: (p[1] || '').trim(), body: (p[2] || '').trim() };
    }).filter(c => c.hash && c.subject);
}
// The baseline is repo-writable and gets interpolated into git commands — accept
// ONLY a bare sha, or a malicious checkout gains shell execution at commit time
// (review-caught 2026-08-07). An invalid file re-baselines like a missing one.
const readPrev = () => {
    try {
        const s = fs.readFileSync(STATE, 'utf8').trim();
        return /^[0-9a-f]{4,64}$/i.test(s) ? s : null;
    } catch { return null; }
};
const writePrev = (s) => { try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, String(s || '')); } catch { /* best-effort */ } };

async function main() {
    if (!fs.existsSync(BRAIN)) return;                              // not a brain project → instant no-op
    // Runtime opt-outs (2026-08-18 field incident: this hook fired in ephemeral
    // release worktrees, appending commit cards mid-build and dirtying the tree
    // — KLYPIX_GIT_CAPTURE only gates the INSTALLER, not the hook run).
    //   • quiet tree (KLYPIX_BRAIN_QUIET=1 / .klypix-brain-quiet) → no writes;
    //   • ephemeral checkout (linked worktree or OS temp dir) → no writes,
    //     unless KLYPIX_BRAIN_WORKTREE_CAPTURE=1 opts the tree back in.
    // The commit baseline is left untouched, so opting back in re-scans the
    // skipped range — nothing is lost, exactly the lock-refusal discipline.
    // Lazy + guarded: a stale bundle without the module behaves as before.
    try {
        const q = await import('./brain-quiet.mjs');
        const quiet = q.brainQuiet({ projectDir: CWD });
        const eph = quiet.quiet ? null : q.ephemeralCheckout({ projectDir: CWD });
        if (quiet.quiet || eph?.ephemeral) {
            try { process.stderr.write(q.quietSkipLine('git commit capture', quiet.quiet ? quiet.source : eph.reason)); } catch { /* */ }
            return;
        }
    } catch { /* stale bundle without brain-quiet.mjs — capture as before */ }
    let head = ''; try { head = git('rev-parse HEAD'); } catch { return; }
    if (!head) return;
    const prev = readPrev();
    if (!prev) { writePrev(head); return; }                        // BASELINE: record HEAD, capture nothing
    if (prev === head) return;                                     // nothing new
    try { execSync(`git merge-base --is-ancestor ${prev} HEAD`, { cwd: CWD, stdio: 'ignore', timeout: 2000 }); }
    catch { writePrev(head); return; }                             // history rewritten → re-baseline, don't dump
    let raw = ''; try { raw = git(`log ${prev}..HEAD --no-merges --format=%x1e%H%x1f%s%x1f%b`); } catch { writePrev(head); return; }
    const candidates = parseLog(raw).slice(0, 15)
        .map(c => ({ card: commitToCard(c), hash7: c.hash.slice(0, 7).toLowerCase() }))
        .filter(x => x.card);
    if (!candidates.length) { writePrev(head); return; }

    const lib = await import('./klypix-format.mjs');               // lazy: only when there's something to write
    let lockLib = null;
    try { lockLib = await import('./brain-write-lock.mjs'); } catch { /* stale bundle without the module */ }
    if (!lockLib || typeof lockLib.withAdvisoryWriteLock !== 'function') {
        // Fail SAFE: without the shared lock we must not read-modify-write at
        // all. The baseline stays, so these commits re-scan next commit, and the
        // Stop hook (which dedups by #commit-hash) records them meanwhile.
        try { process.stderr.write('[klypix-brain] git capture skipped: shared lock module unavailable (stale bundle) — commits re-scan on the next commit\n'); } catch { /* */ }
        return;
    }
    // Read-modify-write UNDER the shared lock so a concurrent Claude-Code Stop
    // hook or desktop save can't clobber this batch (or vice-versa). Inside the
    // lock, dedup against commits ALREADY in the brain so neither a re-run nor
    // the Stop hook double-records the same commit.
    await lockLib.withAdvisoryWriteLock(lockLib.brainCaptureLockPath(BRAIN), async (locked) => {
        if (!locked) {
            try { process.stderr.write('[klypix-brain] git capture deferred: the brain lock is held — commits re-scan on the next commit\n'); } catch { /* */ }
            return;
        }
        const buf = fs.readFileSync(BRAIN);
        const already = new Set();
        try {
            const { struct } = await lib.parseKlypix(buf);
            for (const c of (struct.cards || []))
                for (const m of String(c.text || '').matchAll(/#commit-([0-9a-f]{7})/gi)) already.add(m[1].toLowerCase());
        } catch { /* parse failed → don't dedup; atomicWrite re-verifies the result anyway */ }
        const cards = candidates.filter(x => !already.has(x.hash7)).map(x => x.card);
        if (!cards.length) { writePrev(head); return; }            // every new commit already recorded (e.g. by the Stop hook)
        const res = await lib.captureIntoBrain(buf, {
            cards: cards.map(c => ({ text: c.text, color: '#e8e8ed', borderColor: c.borderColor, area: c.area, createdVia: c.createdVia })),
        });
        let out = res.buffer; try { out = (await lib.tidyBrain(res.buffer)).buffer; } catch { /* keep append result if tidy fails */ }
        await lib.atomicWrite(BRAIN, out);
        writePrev(head);
        try { process.stderr.write(`[klypix-brain] git capture: ${res.stats?.added ?? cards.length} commit card(s) → brain.klypix\n`); } catch { /* */ }
    }, { tries: 100, waitMs: 60 });
}
main().catch(() => { /* never break a commit */ }).finally(() => process.exit(0));
