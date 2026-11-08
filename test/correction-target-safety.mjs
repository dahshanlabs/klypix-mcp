// Correction targeting is a destructive lifecycle decision, not a search hit.
// Brains are fresh in-memory or isolated temporary fixtures; no project brain
// or real host configuration is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    buildKlypixMap, parseKlypix, captureIntoBrain, correctionOverlaysFor,
    formatCaptureReceipts,
} from '../src/klypix-format.mjs';

const textCards = struct => struct.cards.filter(c => c.type !== 'container');
const archived = c => /^archive$/i.test(c.area || '');
async function correct(areas, text, area = 'Runtime') {
    const before = await buildKlypixMap({ title: 'brain', areas });
    const original = (await parseKlypix(before)).struct;
    const result = await captureIntoBrain(before, { cards: [{ text, area }] });
    return { ...result, original, struct: (await parseKlypix(result.buffer)).struct };
}

// Actual November 8 incident. "release" and "auto" in a strategy review were
// enough to retire the tiny unrelated tagged-release record across areas.
const incident = `Strategy: CORRECTION to this chat's 8 Nov strategy-review recommendation: broad test-first advice was too broad. Current bf118fa includes the full November competitor run, not only the earlier single-run Concord pilot. Critical review found a concrete completion gap: mcp-presence skips merge-conflict checks on completion; saved Codex S10 transcripts show known unresolved branch conflicts omitted from final answers despite peer messages. Recommended first fix: release active task scope normally while retaining/rechecking unresolved integration findings and surfacing them in the final handoff; never auto-merge or keep ghost reservations. An isolated current-source fixture also proves diff hides changed decision bodies behind unchanged headings, supporting a bounded before/after+ID improvement. A generic commit hook is not the proven overlap remedy; October installed-hook S10 passes still had conflicts. Defer another broad paid benchmark; verify only the changed behaviors. Recommendation awaits founder decision; no product edits or paid runs made.
#strategy`;
{
    const result = await correct([{ title: 'Release', cards: [{ text: 'Release: 🏁 tagged v1.64.0\n#release #auto' }] }], incident, 'Strategy');
    const releaseId = textCards(result.original)[0].id;
    const release = result.struct.cards.find(c => c.id === releaseId);
    assert.equal(result.stats.superseded, 0);
    assert.ok(!archived(release) && !/↩/.test(release.text));
    assert.equal(textCards(result.struct).length, 2, 'the correction still lands');
    assert.ok(!result.struct.connections.some(e => e.fromId === releaseId && e.label === 'superseded by'));
    assert.equal(result.stats.correctionRefused[0].reason, 'weak-subject');
    assert.ok(formatCaptureReceipts(result.stats).some(s => /no card was archived/.test(s) && s.includes(releaseId)));
}

// Shared lifecycle/routing words must not rescue a weak ordinary card either.
{
    const result = await correct([{ title: 'Planning', cards: [{ text: 'Planning: project state updated; final task ready.\n#project #state #auto' }] }],
        'Runtime: CORRECTION: project state updated; final task ready means the export pipeline remains unverified.\n#project #state #auto');
    assert.equal(result.stats.superseded, 0);
    assert.ok(textCards(result.struct).every(c => !archived(c)));
}

// Intended cross-area corrections retain history and the explicit successor.
const stale = 'Off-cloud skill/brain EXECUTION deferred ON PURPOSE 2026-06-16 — agents run skills only in-session for now, executor postponed until real demand shows.';
const current = 'Runtime: CORRECTION (stale note resolved): off-cloud skill/brain execution is now WIRED, not deferred — the runner executes skills off-cloud since the connectivity arc.';
{
    const result = await correct([{ title: 'Strategy', cards: [{ text: stale }] }], current);
    const old = result.struct.cards.find(c => c.id === textCards(result.original)[0].id);
    assert.equal(result.stats.superseded, 1);
    assert.ok(archived(old) && /deferred ON PURPOSE/.test(old.text));
    assert.match(correctionOverlaysFor(result.struct, [old]).get(old.id)?.by.text || '', /WIRED/);
}
// The established terse correction still has three real subject anchors.
{
    const result = await correct([{ title: 'Config', cards: [{ text: 'Config: the vault default resolution uses the global folder setting always for brains' }] }],
        'Runtime: CORRECTION: the vault default resolution was WRONG — use cwd\n#runtime');
    assert.equal(result.stats.superseded, 1);
}

// A tied match is not an identity. Both iteration orders must keep both cards.
const rivals = [
    { title: 'Desktop', cards: [{ text: 'Desktop: session token refresh interval uses a periodic timer for browser authentication.' }] },
    { title: 'Phone', cards: [{ text: 'Phone: session token refresh interval uses a periodic timer for mobile authentication.' }] },
];
for (const areas of [rivals, [...rivals].reverse()]) {
    const result = await correct(areas, 'Auth: CORRECTION: session token refresh interval no longer uses a periodic timer; authentication refresh happens at startup.', 'Auth');
    assert.equal(result.stats.superseded, 0);
    assert.ok(textCards(result.struct).every(c => !archived(c)));
    assert.equal(result.stats.correctionRefused[0].reason, 'ambiguous');
    assert.equal(result.stats.correctionRefused[0].candidates.length, 2);
    assert.ok(formatCaptureReceipts(result.stats).some(s => /several cards match too closely/.test(s) && /not confirmed targets/.test(s)));
}

// A clearly better target still wins when an unrelated card shares a few words.
{
    const result = await correct([
        { title: 'Config', cards: [{ text: 'Config: vault default resolution selects the global folder setting for project brains.' }] },
        { title: 'Media', cards: [{ text: 'Media: image resolution default applies to gallery preview thumbnails and export quality controls in the global folder.' }] },
    ], 'Runtime: CORRECTION: vault default resolution selects the project folder instead of the global folder setting for project brains.');
    assert.equal(result.stats.superseded, 1);
    assert.ok(archived(result.struct.cards.find(c => c.id === textCards(result.original)[0].id)));
    assert.ok(!archived(result.struct.cards.find(c => c.id === textCards(result.original)[1].id)));
}

// A short intended target must not disappear from the ambiguity check merely
// because it lacks enough words to archive safely. Incidental "do not change"
// prose can cover a richer rival completely; that is not target identity.
for (const billing of ['Billing: payment transaction history retained', 'Billing: payment transaction history']) {
    const result = await correct([
        { title: 'Config', cards: [{ text: 'Config: default store SQLite' }] },
        { title: 'Billing', cards: [{ text: billing }] },
    ], 'Config: CORRECTION: default store is Postgres; do not change payment transaction history.', 'Config');
    assert.equal(result.stats.superseded, 0);
    assert.ok(textCards(result.struct).every(c => !archived(c)));
    assert.equal(result.stats.correctionRefused[0].reason, 'ambiguous');
    assert.equal(result.stats.correctionRefused[0].candidates.length, 2);
}
// Even one real anchor can identify a plausible short target when its raw
// match outranks the incidental rival. Rejecting it must not authorize fallback.
{
    const result = await correct([
        { title: 'Runtime', cards: [{ text: 'Runtime: database SQLite' }] },
        { title: 'Billing', cards: [{ text: 'Billing: transaction history auditing retained' }] },
    ], 'Runtime: CORRECTION: database Postgres; transaction history auditing must remain unchanged.');
    assert.equal(result.stats.superseded, 0);
    assert.ok(textCards(result.struct).every(c => !archived(c)));
    assert.equal(result.stats.correctionRefused[0].reason, 'ambiguous');
}

// Milestones retain their event identity: a correction to another version must
// not retire this release, while a substantial correction naming it still can.
const milestone = 'Release: 🏁 tagged v1.64.0 with signed desktop binaries and verified updater checksums.';
for (const version of ['1.65.0', '1.64.0']) {
    const result = await correct([{ title: 'Release', cards: [{ text: milestone }] }],
        `Security: CORRECTION: v${version} desktop binaries are unsigned; updater checksums were not verified.`, 'Security');
    assert.equal(result.stats.superseded, version === '1.64.0' ? 1 : 0);
}

// Standing skills are protected even if the correction has a strong subject.
{
    const result = await correct([{ title: 'Auth', cards: [{ text: 'Auth: 🛠 session token refresh interval uses a periodic timer for browser authentication.' }] }],
        'Auth: CORRECTION: session token refresh interval no longer uses a periodic timer for browser authentication.', 'Auth');
    assert.equal(result.stats.superseded, 0);
    assert.ok(textCards(result.struct).some(c => /🛠/.test(c.text) && !archived(c)));
}

// A safe refusal must reach both MCP callers and Claude's next prompt. The
// hook selects receipt fields explicitly, so testing the formatter alone would
// miss a dropped field between capture and the model-visible sidecar.
{
    const tempBase = path.resolve(os.tmpdir());
    const fixtureRoot = fs.mkdtempSync(path.join(tempBase, 'klypix-correction-receipts-'));
    const repo = fileURLToPath(new URL('../', import.meta.url));
    const fixtureHome = path.join(fixtureRoot, 'home');
    const hookVault = path.join(fixtureRoot, 'hook');
    const mcpVault = path.join(fixtureRoot, 'mcp');
    const brainHome = path.join(fixtureHome, '.claude', 'project-brain');
    try {
        for (const dir of [brainHome, hookVault, mcpVault]) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(brainHome, '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest: 'test', checkedAt: Date.now() }));
        const seed = await buildKlypixMap({ title: 'brain', areas: rivals });
        const ambiguous = 'CORRECTION: session token refresh interval no longer uses a periodic timer; authentication refresh happens at startup.';
        fs.writeFileSync(path.join(hookVault, 'brain.klypix'), seed);
        fs.writeFileSync(path.join(mcpVault, 'brain.klypix'), seed);
        const transcript = path.join(fixtureRoot, 'transcript.jsonl');
        fs.writeFileSync(transcript, JSON.stringify({ message: { role: 'assistant', content: `🧠 BRAIN [Auth]: ${ambiguous}` } }) + '\n');
        const env = { ...process.env, HOME: fixtureHome, USERPROFILE: fixtureHome, APPDATA: fixtureHome, LOCALAPPDATA: fixtureHome, TEMP: fixtureRoot, TMP: fixtureRoot, KLYPIX_BRAIN_DIR: brainHome, KLYPIX_AUTHOR: 'correction-test' };
        delete env.KLYPIX_BRAIN_NO_MAIN;
        const hook = spawnSync(process.execPath, [path.join(repo, 'src/global-brain-hook.mjs'), '--capture'], {
            cwd: hookVault, env, encoding: 'utf8', timeout: 30000,
            input: JSON.stringify({ session_id: 'correction-target-test', transcript_path: transcript }),
        });
        assert.equal(hook.status, 0, hook.stderr);
        assert.match(hook.stderr, /several cards match too closely/);
        const sidecar = JSON.parse(fs.readFileSync(path.join(hookVault, '.claude/brain-rule-drafts.json'), 'utf8'));
        assert.ok(sidecar.captureReceipts.some(r => r.sid === 'correction-target-test' && !r.shown && /several cards match too closely/.test(r.line)));
        const hookBrain = (await parseKlypix(fs.readFileSync(path.join(hookVault, 'brain.klypix')))).struct;
        assert.ok(textCards(hookBrain).every(c => !archived(c)));

        const coreUrl = new URL('../src/klypix-core.mjs', import.meta.url).href;
        const script = `import { opBrainNote } from ${JSON.stringify(coreUrl)};
            const result = await opBrainNote({ vault: process.cwd(), canvas: 'brain', area: 'Auth', text: ${JSON.stringify(ambiguous)}, via: 'test' });
            console.log((result.blocks || []).map(b => b.text || '').join('\\n'));
            if (result.isError) process.exitCode = 1;`;
        const mcp = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: mcpVault, env, encoding: 'utf8', timeout: 30000 });
        assert.equal(mcp.status, 0, mcp.stderr);
        assert.match(mcp.stdout, /several cards match too closely/);
    } finally {
        // Delete only the fresh fixture we created under the resolved temp root.
        assert.equal(path.dirname(path.resolve(fixtureRoot)), tempBase);
        assert.ok(path.basename(fixtureRoot).startsWith('klypix-correction-receipts-'));
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

console.log('correction-target-safety: all checks passed');
