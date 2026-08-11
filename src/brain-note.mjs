#!/usr/bin/env node
// brain-note — a DELIBERATE, marker-aware write to a .klypix brain (cwd-keyed).
//
// The Claude-Code / Codex-via-bash twin of the brain_note MCP tool: the SAME
// capture engine (supersede / resolve / close-link / update / dedup) as the Stop-
// hook harvest, but ON DEMAND — so a decision / lock-note / open question lands the
// instant you run it (and a concurrent session's next prompt can see it) instead of
// waiting for Stop. cwd-keyed: it writes ./brain.klypix in the current project, the
// SAME brain the global hook reads — no MCP vault mismatch, no session-id needed.
//
// Usage:
//   node brain-note.mjs "Auth: switch to refresh tokens — sessions don't scale"
//   node brain-note.mjs "Lock: refactoring src/auth/** for ~1h, hands off" --marker !
//   node brain-note.mjs "shipped v1.6.0" --marker resolve --closes "v1.6.0 release"
//   echo '{"text":"...","area":"Auth","marker":"?"}' | node brain-note.mjs
//
// --marker:  (none)=decision · ?/question · !/milestone · ✓/resolve · ~/update
// --area X   route into the [Area] container (also a #tag) · --closes "<title>"
// Optional trailing path picks a different .klypix (default ./brain.klypix).
import fs from 'fs';
import path from 'path';
import { captureIntoBrain, tidyBrain, atomicWrite, noteToCaptureInput, formatCaptureReceipts } from './klypix-format.mjs';
import { brainCaptureLockPath, withAdvisoryWriteLock } from './brain-write-lock.mjs';

const MARKERS = { '': '', '?': '?', '!': '!', '✓': '✓', '~': '~', question: '?', milestone: '!', resolve: '✓', update: '~', decision: '', done: '✓' };
const normMarker = (m) => MARKERS[String(m || '').toLowerCase()] ?? '';

function parseArgs(argv) {
    const out = { text: '', area: '', marker: '', closes: '', file: '' };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--area') out.area = argv[++i] || '';
        else if (a === '--marker' || a === '-m') out.marker = normMarker(argv[++i]);
        else if (a === '--closes') out.closes = argv[++i] || '';
        else rest.push(a);
    }
    // A trailing .klypix/.any token is the target file; the rest is the note text.
    if (rest.length && /\.(klypix|any)$/i.test(rest[rest.length - 1])) out.file = rest.pop();
    out.text = rest.join(' ').trim();
    return out;
}
// Read JSON or raw text from a PIPED stdin only (a TTY would block).
function readStdin() {
    try { if (process.stdin.isTTY) return ''; return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

let opts = parseArgs(process.argv.slice(2));
if (!opts.text) {
    const raw = readStdin().trim();
    if (raw) {
        try { const j = JSON.parse(raw); opts = { ...opts, ...j, marker: normMarker(j.marker ?? opts.marker) }; }
        catch { opts.text = raw; }
    }
}
const file = path.resolve(opts.file || 'brain.klypix');
if (!opts.text) { console.error('brain-note: nothing to write — pass a note as an arg, or JSON/text on stdin.'); process.exit(1); }
if (!fs.existsSync(file)) { console.error(`brain-note: no brain at ${file} (run from a project with ./brain.klypix, or pass a path).`); process.exit(1); }

const input = noteToCaptureInput({ text: opts.text, area: opts.area, marker: opts.marker, closes: opts.closes, createdVia: 'cli' });
try {
    // Same cross-process lock as the MCP engine, hooks, and desktop app: an
    // unlocked read-modify-write racing any of them is silent last-writer-wins
    // loss. On timeout we REFUSE (exit 1) — the caller just reruns the command.
    const res = await withAdvisoryWriteLock(brainCaptureLockPath(file), async (locked) => {
        if (!locked) return null;
        const captured = await captureIntoBrain(fs.readFileSync(file), input);
        let out = captured.buffer;
        try { out = (await tidyBrain(captured.buffer)).buffer; } catch { /* keep append result if tidy fails */ }
        await atomicWrite(file, out);
        return captured;
    }, { tries: 100, waitMs: 60 });
    if (!res) {
        console.error('brain-note refused (brain unchanged): the brain lock is held by another writer — retry in a moment.');
        process.exit(1);
    }
    const s = res.stats || {};
    const bits = [`${s.added || 0} added`];
    for (const k of ['resolved', 'updated', 'closed', 'superseded']) if (s[k]) bits.push(`${s[k]} ${k}`);
    if (s.reAdopted) bits.push(`${s.reAdopted} re-adopted`);
    if (s.linked) bits.push(`${s.linked} linked`);
    console.error(`✓ brain-note → ${path.basename(file)} (${bits.join(' · ')})`);
    for (const line of formatCaptureReceipts(s)) console.error(`  ${line}`);
} catch (e) {
    console.error(`brain-note failed (brain unchanged): ${e?.message || e}`);
    process.exit(1);
}
