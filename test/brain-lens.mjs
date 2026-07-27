// brain_lens — pure engine assertions on a time-varied fixture + a real MCP
// client end-to-end call. Run: node test/brain-lens.mjs (exit 0 = pass).
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { buildKlypixMap, parseKlypix, shard, brainLensData, lensToMarkdown } from '../src/klypix-format.mjs';
import { makeVault } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'klypix-mcp.mjs');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };

// ── Fixture: a brain whose cards span 100 days, with channels + an old ❓ ────
const NOW = Date.now();
const DAY = 86_400_000;
async function makeFixture() {
    const buf = await buildKlypixMap({
        title: 'lens-fixture',
        areas: [
            { title: '📌 Focus', cards: [{ text: 'Ship the lens.' }] },
            { title: 'Engineering', cards: [
                { text: 'Decision: keep the merge byte-conservative.' },
                { text: '❓ Should replay pace by events or wall-clock? Open question.' },
                { text: 'Decision: ring-cap the orrery so it can never hairball.' },
            ] },
            { title: 'Archive', cards: [{ text: '↩ superseded: old plan.' }] },
        ],
        connections: [
            { from: 'Decision: keep the merge byte-conservative.', to: 'Ship the lens.', relationship: 'supports' },
            { from: '❓ Should replay pace by events or wall-clock? Open question.', to: 'Decision: ring-cap the orrery so it can never hairball.', relationship: 'questions' },
            { from: 'Decision: ring-cap the orrery so it can never hairball.', to: 'Ship the lens.', relationship: 'leads_to' },
        ],
    });
    // Re-stamp ages + provenance directly in the item files (deterministic).
    const parsed = await parseKlypix(buf);
    const { zip, struct } = parsed;
    const stamp = async (matcher, patch) => {
        const c = struct.cards.find(x => x.type === 'text' && matcher(x.text || ''));
        const ip = `items/${shard(c.id)}/${c.id}.json`;
        const j = JSON.parse(await zip.file(ip).async('string'));
        Object.assign(j, patch);
        zip.file(ip, JSON.stringify(j));
        return c.id;
    };
    await stamp(t => /merge byte-conservative/.test(t), { createdAt: NOW - 45 * DAY, createdVia: 'claude-code' });
    const qId = await stamp(t => /Should replay pace/.test(t), { createdAt: NOW - 30 * DAY });
    await stamp(t => /ring-cap the orrery/.test(t), { createdAt: NOW - 2 * DAY, createdVia: 'git-commit' });
    await stamp(t => /superseded: old plan/.test(t), { createdAt: NOW - 100 * DAY });
    await stamp(t => /Ship the lens/.test(t), { createdBy: 'user', createdAt: NOW - 1 * DAY });
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { buf: out, qId };
}

console.log('L1 pure lens data:');
const { buf } = await makeFixture();
const { struct } = await parseKlypix(buf);
const d = brainLensData(struct, { now: NOW });
{
    const f = d.freshness;
    ok(f.fresh7d === 2, `fresh7d = 2 (got ${f.fresh7d})`);                     // hub card + ring-cap card
    ok(f.days30 === 1 && f.days90 === 1, `30d/90d buckets = 1/1 (got ${f.days30}/${f.days90})`);
    ok(f.archived === 1, `archived = 1 (got ${f.archived})`);
    ok(f.staleQuestions.length === 1 && f.staleQuestions[0].ageDays === 30, `stale ❓ detected at 30d (got ${JSON.stringify(f.staleQuestions.map(q => q.ageDays))})`);
    ok(d.provenance.channels.claude === 1 && d.provenance.channels.git === 1 && d.provenance.channels.you === 1, `channels claude/git/you = 1/1/1 (got ${JSON.stringify(d.provenance.channels)})`);
    ok(d.activity.days.length === 7, '7 activity days');
    ok(d.activity.recent.length === 2, `2 recent (7d) cards (got ${d.activity.recent.length})`);
    ok(d.timeline.total === 5 && d.timeline.events.every((e, i) => i === 0 || d.timeline.events[i - 1].t <= e.t), 'timeline complete + ordered');
    ok(d.orrery && d.orrery.rootTitle.includes('Ship the lens'), `orrery defaults to hub (got "${d.orrery?.rootTitle}")`);
    ok(d.orrery.nodes.every(n => [1, 2, 3].includes(n.hop)), 'orrery hops in 1..3');
    ok(d.unresolved.length === 1 && /Should replay pace/.test(d.unresolved[0].title), 'unresolved finds exactly the open ❓');
    ok(d.unresolved[0].evidence.length >= 1, 'unresolved carries typed evidence');
}
{
    const rooted = brainLensData(struct, { now: NOW, root: '❓ Should replay pace' });
    ok(rooted.orrery.rootTitle.includes('Should replay pace'), 'orrery root resolves by title prefix');
    const md = lensToMarkdown(d, 'all');
    ok(/## Freshness/.test(md) && /## Who wrote it/.test(md) && /## Unresolved/.test(md) && /## Orrery/.test(md), 'markdown renders all sections');
    const mdU = lensToMarkdown(d, 'unresolved');
    ok(!/## Freshness/.test(mdU) && /## Unresolved/.test(mdU), 'single-view markdown scopes to the view');
}

console.log('\nL2 resolved/superseded ❓ never counts as unresolved:');
{
    const s2 = JSON.parse(JSON.stringify(struct));
    const q = s2.cards.find(c => /Should replay pace/.test(c.text || ''));
    q.text = '✅ 2026-07-01: resolved.\n' + q.text;
    const d2 = brainLensData(s2, { now: NOW });
    ok(d2.unresolved.length === 0, `✅-stamped question excluded (got ${d2.unresolved.length})`);
    ok(d2.freshness.staleQuestions.length === 0, 'and not counted stale');
}

console.log('\nL3 end-to-end via MCP client (brain_lens registered + returns):');
{
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'brain.klypix'), buf);
    const client = new Client({ name: 'lens-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, KLYPIX_VAULT: vault, KLYPIX_AUTO_UPDATE: '0' } }));
    try {
        const tools = await client.listTools();
        ok(tools.tools.some(t => t.name === 'brain_lens'), 'brain_lens listed');
        const res = await client.callTool({ name: 'brain_lens', arguments: { view: 'all' } });
        const body = (res.content || []).map(c => c.text || '').join('\n');
        ok(/Brain lens — lens-fixture/.test(body), 'markdown header present');
        ok(/## Unresolved/.test(body) && /Should replay pace/.test(body), 'unresolved section rendered end-to-end');
        const resT = await client.callTool({ name: 'brain_lens', arguments: { view: 'timeline' } });
        const bodyT = (resT.content || []).map(c => c.text || '').join('\n');
        ok(/## Timeline/.test(bodyT), 'timeline view renders');
    } finally {
        await client.close();
    }
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
