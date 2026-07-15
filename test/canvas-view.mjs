// Acceptance suite for canvas_view — the whiteboard-in-chat MCP App.
//   V1  buildRenderSpec merges geometry (canvas.positions w/h/zIndex/parentId)
//       with item visuals (heading/colors) from the zip item JSON
//   V2  createdVia/createdBy pass through (authorship badges)
//   V3  connection defaults survive (arrowHead true, width 2) + dangling dropped
//   V4  the spec is BUDGETED: per-card trim + truncated count (context safety)
//   V5  the app HTML is fully self-contained: zero external-origin references
//   V6  the app HTML stays under the resources/read size budget (<300KB)
//   V7  the bin's ext-apps usage is inside try/catch with a plain-tool fallback
//       (a missing optional dep must cost one tool's UI, never the server)
//
// Run:  node test/canvas-view.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildKlypixMap, parseKlypix, buildRenderSpec } from '../src/klypix-format.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

// ── V1-V3: spec correctness on a real parsed fixture ──────────────────────────
{
    const buf = await buildKlypixMap({
        title: 'view-fixture',
        areas: [
            { title: 'Alpha', cards: [{ text: 'First decision card with some body text.' }, { text: 'Second card 🛠 skill-ish.' }] },
            { title: 'Beta', cards: [{ text: 'Third card in the second area.' }] },
        ],
    });
    const { struct, canvas, zip } = await parseKlypix(buf);
    // Draw one real connection + one dangling one.
    const [a, b] = struct.cards.filter(c => c.type !== 'container');
    canvas.connections = [
        { id: 'c1', fromId: a.id, toId: b.id, relationship: 'supports', label: null },
        { id: 'c2', fromId: a.id, toId: 'ghost_missing', relationship: null, label: null },
    ];
    struct.cards.find(c => c.id === a.id); // keep ids stable
    const spec = await buildRenderSpec({ struct, canvas, zip });
    ok(spec.items.length === struct.cards.length, `V1: every card is in the spec (${spec.items.length})`);
    const item = spec.items.find(i => i.id === a.id);
    ok(item && item.w > 0 && item.h > 0 && Number.isFinite(item.x), 'V1: geometry merged from canvas.positions (w/h present)');
    ok(item && typeof item.text === 'string' && /First decision/.test(item.text), 'V1: text carried from the zip item JSON');
    const ctn = spec.items.find(i => i.type === 'container');
    ok(ctn && typeof ctn.title === 'string', 'V1: containers carry their title');
    ok(spec.items.every(i => i.parentId !== undefined), 'V1: parentId present (containment renders)');
    ok(spec.connections.length === 1, 'V3: dangling connection dropped, real one kept');
    ok(spec.connections[0].arrowHead === true && spec.connections[0].width === 2, 'V3: connection defaults (arrowHead true, width 2)');
}

// ── V2: provenance passthrough ────────────────────────────────────────────────
{
    const buf = await buildKlypixMap({ title: 'prov', areas: [{ title: 'A', cards: [{ text: 'agent-made card body.' }] }] });
    const parsed = await parseKlypix(buf);
    // Simulate a capture-written card: patch the raw item JSON inside the zip.
    const card = parsed.struct.cards.find(c => c.type !== 'container');
    const p = `items/${card.id.replace(/^[a-z]+[_:]/i, '').toLowerCase().slice(0, 2).padStart(2, '_')}/${card.id}.json`;
    const raw = JSON.parse(await parsed.zip.file(p).async('string'));
    raw.createdBy = 'agent'; raw.createdVia = 'cursor';
    parsed.zip.file(p, JSON.stringify(raw));
    const spec = await buildRenderSpec({ struct: parsed.struct, canvas: parsed.canvas, zip: parsed.zip });
    const it = spec.items.find(i => i.id === card.id);
    ok(it && it.createdBy === 'agent' && it.createdVia === 'cursor', 'V2: createdBy/createdVia pass through for authorship badges');
}

// ── V4: budget — per-card trim + truncated count ─────────────────────────────
{
    const big = 'x'.repeat(3000);
    const buf = await buildKlypixMap({ title: 'budget', areas: [{ title: 'A', cards: [{ text: big }, { text: 'small.' }] }] });
    const { struct, canvas, zip } = await parseKlypix(buf);
    const spec = await buildRenderSpec({ struct, canvas, zip }, { perCardChars: 800 });
    const trimmed = spec.items.find(i => i.text && i.text.length > 700 && i.text.endsWith('…'));
    ok(!!trimmed && trimmed.text.length <= 801, 'V4: oversized card text trimmed to the per-card cap');
    ok(spec.counts.truncated >= 1, 'V4: truncated count reported (the iframe displays it)');
}

// ── V5-V6: the app HTML is self-contained + budgeted ─────────────────────────
{
    const htmlPath = path.join(__dirname, '..', 'src', 'canvas-view-app.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    ok(!/(?:src|href)\s*=\s*["']https?:\/\//i.test(html) && !/fetch\s*\(\s*["']https?:/i.test(html)
        && !/@import|url\(\s*["']?https?:/i.test(html), 'V5: zero external-origin references (Apps CSP is deny-by-default)');
    ok(Buffer.byteLength(html, 'utf8') < 300 * 1024, `V6: HTML under the 300KB resources/read budget (${Math.round(Buffer.byteLength(html, 'utf8') / 1024)}KB)`);
    ok(/ui\/notifications\/tool-result/.test(html) && /ui\/initialize/.test(html), 'V5: the postMessage bridge speaks the 2026-01-26 methods');
}

// ── V7: bin degrades without ext-apps (structural check) ─────────────────────
{
    const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'klypix-mcp.mjs'), 'utf8');
    const block = bin.slice(bin.indexOf('canvas_view'));
    ok(/try\s*\{[\s\S]*?await import\('@modelcontextprotocol\/ext-apps\/server'\)/.test(bin), 'V7: ext-apps import is lazy + inside try');
    ok(/if\s*\(!canvasViewAsApp\)\s*\{[\s\S]*?server\.registerTool\('canvas_view'/.test(bin), 'V7: plain-tool fallback registers when the App path fails');
    ok(!/^import .*ext-apps/m.test(bin), 'V7: no top-level ext-apps import (a missing dep can never brick the server)');
    void block;
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
