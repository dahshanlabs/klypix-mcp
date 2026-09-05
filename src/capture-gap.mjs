// Uncaptured-work detection — ONE implementation, every host.
//
// Capture is opt-in: something has to CHOOSE to emit a 🧠 marker or call
// brain_note. That fails hardest exactly where it matters most — a long, loaded
// session is both the least likely to remember and the most likely to have
// produced something worth keeping. The 2026-08-16 field report is the canonical
// instance: a multi-session workstream took a file format to a REGISTERED IANA
// media type (spec written, 8 schema-drift bugs fixed, PR merged, registration
// landed) and the brain recorded NONE of it — the agent had been writing to its
// own private per-project memory dir the whole time, which no peer can read.
//
// This module holds the parts that must behave identically whether the caller is
// the Claude Code Stop hook (which can REFUSE the stop) or an MCP host calling
// brain_sync(phase:"complete") (which can only advise). Both ask the same
// question of the same facts and hand back the same drafted card.
//
// Three deliberate properties, each learned the hard way:
//
//   • A DRAFT, NOT AN ASSIGNMENT. Asking a drained session to "record the
//     decision" buys a one-line receipt ("merged PR #406") — the event, never
//     the reasoning, which is the half that was actually lost. So the draft
//     pre-fills every mechanical fact from the artifacts themselves (ship, commit
//     subjects, files, area) and leaves exactly ONE slot: why it matters. The
//     agent supplies the only sentence it alone knows, or discards the card.
//
//   • PER-SESSION PROVENANCE, NOT FILE MTIME. The first cut stayed silent when
//     brain.klypix changed during the session — which, on a shared brain with
//     ten live sessions, means a PEER's card silences the session that shipped
//     and recorded nothing. That is backwards: it goes quiet exactly in the
//     multi-agent case. Silence requires THIS session to have captured the current outcome.
//
//   • NARROW ON PURPOSE. A nudge that cries wolf gets ignored, then disabled.
//     It needs a real artifact and a total absence of recorded rationale — a
//     good commit body IS capture and buys silence.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
const MAX_RECEIPTS = 300;
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const projectKey = (project) => {
    const resolved = project ? path.resolve(project).replace(/\\/g, '/').replace(/\/$/, '') : '';
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const scopeKey = (sessionId, project) => hash(JSON.stringify([String(sessionId), projectKey(project)]));
const bounded = (rows) => Object.fromEntries(Object.entries(rows).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0)).slice(0, MAX_RECEIPTS));

// Shared sidecar: bounded outcome reminders, capture checkpoints and transcript
// cursors. Legacy per-session fields remain readable during staged upgrades. Lives
// beside the other brain-home state; the Claude Code session id and the MCP
// presence session id are the SAME id space (the hook and the server share one
// lane), so a brain_note through MCP correctly silences the Stop hook.
export function captureGapStatePath(home = os.homedir()) {
    return path.join(home, '.claude', 'project-brain', '.capture-gap.json');
}

export function readCaptureGapState(file = captureGapStatePath()) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            nudged: Array.isArray(j?.nudged) ? j.nudged.map(String) : [],
            captured: (j && typeof j.captured === 'object' && !Array.isArray(j.captured)) ? j.captured : {},
            baselines: (j && typeof j.baselines === 'object' && !Array.isArray(j.baselines)) ? j.baselines : {},
            receipts: (j && typeof j.receipts === 'object' && !Array.isArray(j.receipts)) ? j.receipts : {},
            windows: (j && typeof j.windows === 'object' && !Array.isArray(j.windows)) ? j.windows : {},
        };
    } catch { return { nudged: [], captured: {}, baselines: {}, receipts: {}, windows: {} }; }
}

// Best-effort, never throws. A torn write only loses the memo — `stop_hook_active`
// remains the primary loop guard. These receipts never substitute for brain data.
function writeCaptureGapState(state, file) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state));
    } catch { /* best-effort */ }
}

export function recordCaptureGapNudge(sessionId, file = captureGapStatePath(), outcome = '') {
    const sid = String(sessionId || ''); if (!sid) return;
    const state = readCaptureGapState(file);
    const key = outcome ? sid + ':' + hash(outcome) : sid;
    state.nudged = [...state.nudged.filter(s => s !== key), key].slice(-MAX_RECEIPTS);
    writeCaptureGapState(state, file);
}

// Called by EVERY capture path that knows its session: the Stop hook after an
// authored capture, and the brain_note MCP verb. This is what makes the silence
// rule per-session and per-project instead of per-file.
export function recordSessionCapture(sessionId, file = captureGapStatePath(), now = Date.now(), { project = '', head } = {}) {
    const sid = String(sessionId || ''); if (!sid) return;
    const state = readCaptureGapState(file);
    state.captured[sid] = now;
    // A note at HEAD A covers A; commits B/C written later remain nudgeable.
    project ||= state.baselines[sid]?.project || '';
    if (project) {
        if (head === undefined) {
            try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).trim(); }
            catch { head = ''; }
        }
        state.receipts[scopeKey(sid, project)] = { at: now, head: String(head || ''), project: projectKey(project) };
        state.receipts = bounded(state.receipts);
    }
    // Bound the map: keep the 300 most recent sessions.
    const entries = Object.entries(state.captured).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 300);
    state.captured = Object.fromEntries(entries);
    writeCaptureGapState(state, file);
}

export function sessionHasCaptured(sessionId, file = captureGapStatePath()) {
    const sid = String(sessionId || ''); if (!sid) return false;
    return Boolean(readCaptureGapState(file).captured[sid]);
}

export function sessionCaptureReceipt(sessionId, project, file = captureGapStatePath()) {
    if (!sessionId || !project) return null;
    return readCaptureGapState(file).receipts[scopeKey(sessionId, project)] || null;
}
export function outcomeWasNudged(sessionId, outcome, file = captureGapStatePath()) {
    return Boolean(sessionId && outcome && readCaptureGapState(file).nudged.includes(sessionId + ':' + hash(outcome)));
}
// Full marker capture still scans history; this cursor is only reminder accounting.
// A changed/truncated transcript starts a fresh window. No transcript text is kept.
export function captureTranscriptWindow(sessionId, project, lines, file = captureGapStatePath(), now = Date.now()) {
    const state = readCaptureGapState(file);
    const key = scopeKey(sessionId, project);
    const previous = state.windows[key];
    const count = Number(previous?.count || 0);
    const start = count > 0 && count <= lines.length && hash(lines.slice(0, count).join('\n')) === previous?.digest ? count : 0;
    const digest = hash(lines.join('\n'));
    return { start, outcome: key + ':' + digest, at: now, count: lines.length, digest };
}
export function recordTranscriptWindow(sessionId, project, window, file = captureGapStatePath()) {
    if (!sessionId || !project) return;
    const state = readCaptureGapState(file);
    state.windows[scopeKey(sessionId, project)] = { count: window.count, digest: window.digest, at: window.at };
    state.windows = bounded(state.windows);
    writeCaptureGapState(state, file);
}

// ── Task baseline, for hosts with no lifecycle hook ──────────────────────────
// The Stop hook gets its commit window from the hook's own per-project baseline.
// An MCP host has no such thing, so brain_sync stamps the git HEAD at phase
// "start" and reads it back at phase "complete" — the same "what landed during
// this task" question, answered from the only two calls every host makes. Kept
// in the same sidecar so there is one file to reason about.
export function recordTaskBaseline(sessionId, { head = '', project = '' } = {}, file = captureGapStatePath(), now = Date.now()) {
    const sid = String(sessionId || ''); if (!sid || !head) return;
    const state = readCaptureGapState(file);
    state.baselines = (state.baselines && typeof state.baselines === 'object' && !Array.isArray(state.baselines)) ? state.baselines : {};
    state.baselines[sid] = { head: String(head), project: String(project || ''), at: now };
    const entries = Object.entries(state.baselines).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0)).slice(0, 300);
    state.baselines = Object.fromEntries(entries);
    writeCaptureGapState(state, file);
}

export function readTaskBaseline(sessionId, file = captureGapStatePath()) {
    const sid = String(sessionId || ''); if (!sid) return null;
    const b = readCaptureGapState(file).baselines?.[sid];
    return (b && b.head) ? b : null;
}

export function clearTaskBaseline(sessionId, file = captureGapStatePath()) {
    const sid = String(sessionId || ''); if (!sid) return;
    const state = readCaptureGapState(file);
    if (state.baselines?.[sid]) { delete state.baselines[sid]; writeCaptureGapState(state, file); }
}

// ── The decision ─────────────────────────────────────────────────────────────
// Returns null to stay silent, or the observed evidence. Pure: every input is
// supplied by the caller, so the Stop hook (transcript + git) and brain_sync
// (git + presence) can answer the same question from what each can see.
export function captureGapDecision({
    authored = 0, commitTotal = 0, commitCards = 0, shipped = [], pushed = false,
    filesTouched = 0, sessionCaptured = false, stopHookActive = false,
    alreadyNudged = false, env = process.env,
} = {}) {
    if (String(env.KLYPIX_BRAIN_NUDGE || '').toLowerCase() === 'off') return null;
    if (stopHookActive || alreadyNudged) return null;
    if (authored > 0) return null;                         // rationale in THIS outcome
    if (sessionCaptured) return null;                      // the caller proved capture covers THIS outcome
    const undocumented = Math.max(0, commitTotal - commitCards);
    if (commitCards > 0 && undocumented === 0) return null; // rationale covers this commit outcome
    const significant = shipped.length > 0 || undocumented >= 2
        || (pushed && undocumented >= 1) || filesTouched >= 6;
    if (!significant) return null;
    const evidence = [];
    if (shipped.length) evidence.push(shipped.slice(0, 3).join(' · '));
    if (commitTotal) evidence.push(`${commitTotal} new commit${commitTotal === 1 ? '' : 's'}${undocumented === commitTotal ? ' (no rationale body on any of them)' : ''}`);
    else if (pushed) evidence.push('pushed to a remote');
    if (filesTouched) evidence.push(`${filesTouched} file${filesTouched === 1 ? '' : 's'} edited`);
    return evidence.length ? { evidence } : null;
}

// ── The draft ────────────────────────────────────────────────────────────────
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const CC_SCOPE = /^(?:feat|fix|perf|refactor|chore|docs|test|build|ci)(?:\(([^)]+)\))?!?:\s*(.+)$/i;

// The area a drafted card should land in, inferred from what the session
// actually touched: a conventional-commit scope first (the author's own label),
// then the dominant source directory, then a neutral fallback. Never invents a
// topic — an area guessed from prose is worse than "Ship".
export function inferArea({ commits = [], filesTouched = [] } = {}) {
    for (const c of commits) {
        const m = CC_SCOPE.exec(String(c?.subject || ''));
        if (m && m[1] && m[1].trim()) return m[1].trim();
    }
    const counts = new Map();
    for (const p of filesTouched) {
        const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
        // Skip a leading src/lib/app wrapper — "src" is never a useful area.
        const seg = parts.length >= 2
            ? (/^(src|lib|app|packages|apps)$/i.test(parts[0]) ? parts[1] : parts[0])
            : '';
        if (seg && !/\./.test(seg)) counts.set(seg, (counts.get(seg) || 0) + 1);
    }
    let best = '', n = 0;
    for (const [k, v] of counts) if (v > n) { best = k; n = v; }
    return best || 'Ship';
}

const factText = (value) => String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 240);
const shortFileList = (files, max = 3) => {
    const uniq = [...new Set(files.map(f => factText(String(f).replace(/\\/g, '/').split('/').pop())).filter(Boolean))];
    if (!uniq.length) return '';
    const head = uniq.slice(0, max).join(', ');
    return uniq.length > max ? `${head} (+${uniq.length - max} more)` : head;
};

// Build the ready-to-emit marker. Everything mechanical is filled in from the
// artifacts; the ONE thing left blank is the sentence only the session can
// supply. That asymmetry is the whole design — a fully pre-written card would
// just be approved, and we would be back to capturing the event without the why.
export const WHY_SLOT = '<one sentence or a few concise clauses: the decision and why; for a solved problem include the cause, attempts rejected, working solution, verification, and when it applies ONLY where observed — omit unknown parts; if nothing durable remains, discard this>';
// A draft pasted back with the slot STILL IN IT is a placeholder wearing a
// card's clothes: it would sit in the brain reading, to every future session, as
// though the reasoning had been recorded. That is strictly worse than no card,
// so the marker guard refuses it and says why. The sentinel deliberately matches
// the head of WHY_SLOT above — test/capture-gap.mjs asserts the two agree, so
// they cannot drift apart in silence.
export const UNFILLED_DRAFT_RE = /WHY THIS MATTERS:\s*<\s*one sentence/i;
export const looksLikeUnfilledDraft = (text) => UNFILLED_DRAFT_RE.test(String(text || ''));
export function draftCaptureMarker({ shipped = [], commits = [], filesTouched = [], area = '' } = {}) {
    const resolvedArea = factText(area || inferArea({ commits, filesTouched })).replace(/[\[\]]/g, '').slice(0, 80) || 'Ship';
    const facts = [];
    if (shipped.length) facts.push(shipped.slice(0, 2).map(factText).join(' · '));
    const subjects = commits
        .map(c => { const m = CC_SCOPE.exec(String(c?.subject || '')); return factText(m ? m[2] : c?.subject); })
        .filter(Boolean).slice(0, 3);
    if (subjects.length) facts.push(subjects.map(s => `"${s}"`).join('; '));
    const files = shortFileList(filesTouched);
    if (files) facts.push(files);
    // A ship with no subjects and no files still deserves a draft — the marker
    // shape matters more than the richness of the pre-fill.
    const head = facts.length ? facts.join(' — ') : 'work completed this session';
    const marker = shipped.length ? '!' : '';           // a ship is a milestone; everything else a decision
    return {
        area: resolvedArea,
        marker,
        text: `${head}. WHY THIS MATTERS: ${WHY_SLOT}`,
        line: `🧠 BRAIN [${resolvedArea}]${marker ? ' ' + marker : ''}: ${head}. WHY THIS MATTERS: ${WHY_SLOT}`,
        tags: [`#${slug(resolvedArea)}`].filter(Boolean),
    };
}

// ── The message ──────────────────────────────────────────────────────────────
// `mode` picks the register: 'refuse' is the Stop hook, which has just declined
// to end the turn; 'advise' is brain_sync(complete) on a host with no lifecycle
// hook, where this is the only channel available and nothing is being blocked.
export function captureGapReason({ evidence = [], draft = null, mode = 'refuse' } = {}) {
    const lead = mode === 'refuse'
        ? '[brain] 🧠 UNCAPTURED WORK — this outcome produced durable artifacts without captured reasoning.'
        : '🧠 UNCAPTURED WORK — this task has new durable artifacts without captured reasoning.';
    const out = [
        lead,
        `  Observed: ${evidence.join(' · ')}.`,
        '  Earlier notes do not cover later work. Review this outcome for reasoning worth sharing.',
    ];
    if (draft) {
        out.push(
            '',
            '  A card is DRAFTED from what this session actually did. The facts are filled in; supply the one',
            '  explanation from observed work, then review and emit the completed marker:',
            '  For a solved problem, retain the cause, attempts that failed, working solution, verification,',
            '  and applicability when known. Omit unknown details; never invent a test result or rationale.',
            '',
            `    ${draft.line}`,
            '',
            mode === 'refuse'
                ? '  Emitting that line in your reply is all it takes — the Stop hook harvests it. Or call brain_note.'
                : '  Pass it to brain_note (text + area), or emit it as a marker if your host harvests them.',
        );
    } else {
        out.push(
            '  Record it now — one line in your reply:',
            '    🧠 BRAIN [Area]: <the decision and why>      (`!` milestone · `?` open question · `+` reusable rule)',
            '  — or call the brain_note MCP verb.',
        );
    }
    out.push(
        mode === 'refuse'
            ? '  If there is genuinely nothing durable to keep, say so in one sentence and stop; this will not ask again for this outcome.'
            : '  If there is genuinely nothing durable to keep, ignore this; it will not be raised again for this outcome.',
        '  NOTE: your own memory directory (~/.claude/projects/<project>/memory/) is NOT the project brain. Writing',
        '  there is private to this host — no other session, agent, or human can read it. Only brain.klypix is shared.',
    );
    return out.join('\n') + '\n';
}
