// klypix-format — the single source of truth for reading & writing .klypix
// (and legacy .any) canvas files. Shared by read-klypix.mjs, write-klypix.mjs,
// and klypix-mcp-server.mjs so the format logic lives in exactly one place.
//
// .klypix v4 ZIP layout: manifest.json · canvas.json · items/<prefix>/<id>.json
// · assets/<assetId>. Legacy .any (v1–v3) keeps an inline items array in
// canvas.json at the root — handled by parseKlypix too.

import JSZip from 'jszip';
import path from 'path';
import fs from 'fs';
import { generateKeyBetween } from 'fractional-indexing';

// Valid fractional-indexing z-keys. Hand-rolled keys (e.g. 'a0000' / 'z00013')
// are REJECTED by the fractional-indexing lib the KLYPIX app uses and crash it
// the moment you edit such a canvas — so the writer MUST emit lib-valid keys.
// makeZKeyGen() returns an increasing-key generator starting just above `after`
// (or from the bottom if `after` is null/invalid).
const isValidZKey = (k) => { try { generateKeyBetween(k, null); return true; } catch { return false; } };
function makeZKeyGen(after = null) {
    let last = (after && isValidZKey(after)) ? after : null;
    return () => (last = generateKeyBetween(last, null));
}

export const WIKILINK = /\[\[([^[\]]+)\]\]/g;
export const TAG = /(^|\s)(#[a-zA-Z][\w-]*)/g;

export function extractLinks(text) {
    const out = []; WIKILINK.lastIndex = 0; let m;
    while ((m = WIKILINK.exec(text || '')) !== null) out.push(m[1].trim());
    return out;
}
export function extractTags(text) {
    const out = []; TAG.lastIndex = 0; let m;
    while ((m = TAG.exec(text || '')) !== null) out.push(m[2].slice(1));
    return out;
}
export function cardTitle(item) {
    if (item?.type === 'container') return item.title || null;
    if (item?.type !== 'text') return null;
    for (const line of String(item.content ?? '').split('\n')) {
        const t = line.trim();
        if (t) return t.replace(/^([#>\-*•]+\s+|\d+\.\s+)/, '').trim() || t;
    }
    return null;
}
// v4 shards item files by the first 2 hex chars of the id's random part.
export const shard = (id) => id.replace(/^[a-z]+[_:]/i, '').toLowerCase().slice(0, 2).padStart(2, '_');

/**
 * Atomically persist a .klypix buffer: verify it round-trips, write a sibling
 * .tmp, then rename over the target. A concurrent reader (e.g. the shared-brain
 * watcher) therefore never parses a half-written ZIP, and a failed/garbage
 * write leaves the previous good file intact. Use this for ALL brain writes
 * instead of fs.writeFileSync.
 */
export async function atomicWrite(filePath, buf) {
    try { await parseKlypix(buf); }
    catch (e) { throw new Error('refusing to write an unparseable .klypix (' + path.basename(filePath) + '): ' + (e?.message || e)); }
    const tmp = filePath + '.tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    fs.writeFileSync(tmp, buf);
    try { fs.renameSync(tmp, filePath); }    // Node uses MoveFileEx(REPLACE_EXISTING) on Windows → overwrites atomically
    catch (e) { try { fs.rmSync(tmp); } catch { /* */ } throw e; }
}

/**
 * Parse a .klypix/.any buffer into a structured object + the loaded zip (so
 * callers can extract binary assets). Throws on a non-canvas file.
 */
export async function parseKlypix(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const readText = async (p) => { const e = zip.file(p); return e ? e.async('string') : null; };

    const manifestRaw = await readText('manifest.json');
    const canvasRaw = await readText('canvas.json');
    if (!canvasRaw) throw new Error('Not a valid .klypix/.any — no canvas.json inside.');

    const manifest = manifestRaw ? JSON.parse(manifestRaw) : null;
    const canvas = JSON.parse(canvasRaw);
    // v4 manifests are {format:"klypix", version:4}; positions presence is the
    // robust fallback (legacy .any keeps an inline items array, no positions).
    const isV4 = (!!manifest && manifest.format === 'klypix' && manifest.version >= 4) || !!canvas.positions;

    const order = Array.isArray(canvas.order) ? canvas.order : [];
    const items = {};
    if (isV4 && canvas.positions) {
        for (const id of order) {
            const raw = await readText(`items/${shard(id)}/${id}.json`);
            if (!raw) continue;
            items[id] = { id, ...(canvas.positions[id] || {}), ...JSON.parse(raw) };
        }
    } else if (Array.isArray(canvas.items)) {
        for (const it of canvas.items) items[it.id] = it;
    }

    const connections = Array.isArray(canvas.connections) ? canvas.connections : [];
    const titleOf = (id) => cardTitle(items[id]) || (items[id]?.type ? `${items[id].type} ${String(id).slice(0, 8)}` : String(id).slice(0, 8));
    const assetPaths = Object.keys(zip.files).filter(p => p.startsWith('assets/') && !zip.files[p].dir);
    const cards = order.length ? order.map(id => items[id]).filter(Boolean) : Object.values(items);

    const struct = {
        title: manifest?.title || canvas.title || 'Untitled',
        format: isV4 ? 'klypix-v4' : `legacy-v${canvas.version ?? '?'}`,
        counts: { cards: cards.length, connections: connections.length, assets: assetPaths.length },
        cards: cards.map(it => ({
            id: it.id, type: it.type,
            title: cardTitle(it),
            text: it.type === 'text' ? it.content : (it.name || it.title || it.url || null),
            links: it.type === 'text' ? extractLinks(it.content) : [],
            tags: it.type === 'text' ? extractTags(it.content) : [],
            pos: { x: it.x, y: it.y },
            createdAt: Number(it.createdAt) || 0,
            parentId: it.parentId ?? null,
            // Parent container's title — the card's "area" in brain terms.
            area: it.parentId ? (cardTitle(items[it.parentId]) || null) : null,
            // Evidence anchors (file:line / PR#) with the git blob OID stamped at
            // capture-time — lets the hook flag a card whose cited code drifted.
            evidence: Array.isArray(it.evidence) && it.evidence.length ? it.evidence : null,
        })),
        connections: connections.map(c => ({
            from: titleOf(c.fromId), to: titleOf(c.toId),
            fromId: c.fromId, toId: c.toId,        // raw ids — for graph analysis (brainInsights)
            relationship: c.relationship || null, label: c.label || null,
        })),
        assets: assetPaths.map(p => path.basename(p)),
    };
    return { struct, zip, assetPaths, isV4, canvas, manifest };
}

const REL = new Set(['leads_to', 'depends_on', 'relates_to', 'conflicts_with', 'supports', 'questions', 'costs', 'blocks']);

/**
 * Build a real .klypix v4 file (nodebuffer) from a simple spec:
 *   { title, cards: [{id?, type?, text, heading?, color?, x?, y?, w?}], connections: [{from, to, relationship?, label?}] }
 * from/to reference a card by INDEX, generated id, or its title (first line).
 * Cards are content-sized and laid out on a BFS-ordered grid so linked cards
 * land near each other.
 */
export async function buildKlypix(spec) {
    if (!spec || !Array.isArray(spec.cards) || spec.cards.length === 0) {
        throw new Error('spec needs a non-empty "cards" array');
    }
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const rand = () => Math.random().toString(36).slice(2, 10);

    const cards = spec.cards.map((c, i) => {
        const type = c.type || 'text';
        const prefix = type === 'text' ? 'txt' : type === 'image' ? 'img' : type === 'container' ? 'ctn' : 'itm';
        return { ...c, type, _id: c.id || `${prefix}_${rand()}_${i}` };
    });
    const idByIndex = cards.map(c => c._id);
    const firstLine = (t) => String(t ?? '').split('\n').map(s => s.trim()).find(Boolean) || '';
    const idByTitle = new Map(cards.map(c => [firstLine(c.text).toLowerCase(), c._id]));
    const resolveRef = (ref) => {
        if (typeof ref === 'number') return idByIndex[ref] ?? null;
        if (typeof ref === 'string') { if (idByIndex.includes(ref)) return ref; return idByTitle.get(ref.trim().toLowerCase()) ?? null; }
        return null;
    };

    const connections = (Array.isArray(spec.connections) ? spec.connections : []).map((c, i) => {
        const fromId = resolveRef(c.from), toId = resolveRef(c.to);
        if (!fromId || !toId || fromId === toId) return null;
        return {
            id: `con_${rand()}_${i}`, fromId, toId,
            relationship: REL.has(c.relationship) ? c.relationship : undefined,
            label: typeof c.label === 'string' ? c.label : undefined,
            arrowHead: true, width: 2, color: '#10b981', style: 'solid',
        };
    }).filter(Boolean);

    // BFS order so connected cards land near each other.
    const adj = new Map(idByIndex.map(id => [id, []]));
    for (const c of connections) { adj.get(c.fromId)?.push(c.toId); adj.get(c.toId)?.push(c.fromId); }
    const indeg = new Map(idByIndex.map(id => [id, 0]));
    for (const c of connections) indeg.set(c.toId, (indeg.get(c.toId) || 0) + 1);
    const visited = new Set();
    const order = [];
    const starts = [...idByIndex].sort((a, b) => (indeg.get(a) - indeg.get(b)) || (idByIndex.indexOf(a) - idByIndex.indexOf(b)));
    for (const s of starts) {
        if (visited.has(s)) continue;
        const q = [s];
        while (q.length) {
            const id = q.shift();
            if (visited.has(id)) continue;
            visited.add(id); order.push(id);
            for (const n of (adj.get(id) || [])) if (!visited.has(n)) q.push(n);
        }
    }

    const FONT = 20, PAD = 28, LINE_H = FONT * 1.35;
    const sizeFor = (card) => {
        if (card.x != null && card.w != null) return { w: card.w, h: card.h ?? 40 };
        const lines = String(card.text ?? '').split('\n');
        const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
        const w = Math.max(160, Math.min(360, Math.round(longest * (FONT * 0.55)) + PAD));
        const h = Math.max(40, Math.round(lines.length * LINE_H) + 14);
        return { w, h };
    };
    const cols = Math.max(1, Math.ceil(Math.sqrt(order.length)));
    const COL_W = 380, GAP_Y = 70, START = 80;
    const positions = {};
    let zi = 0;
    const nextZKey = makeZKeyGen();
    order.forEach((id, idx) => {
        const card = cards[idByIndex.indexOf(id)];
        const { w, h } = sizeFor(card);
        const col = idx % cols, row = Math.floor(idx / cols);
        positions[id] = {
            x: card.x ?? (START + col * COL_W),
            y: card.y ?? (START + row * (180 + GAP_Y) + (col % 2) * 12),
            w, h, zKey: nextZKey(), zIndex: zi++, parentId: null,
        };
    });

    const itemJson = (card) => {
        if (card.type === 'text') {
            return {
                type: 'text', locked: false, createdAt: now, createdBy: 'agent',
                content: String(card.text ?? ''), fontSize: FONT,
                color: card.color || '#1a1a1f', border: !!card.border, borderColor: '#1e1e2e',
                heading: !!card.heading, fontFamily: 'Thmanyah Sans',
                fontWeight: card.heading ? 'bold' : 'normal', fontStyle: 'normal',
                textDecoration: 'none', textAlign: 'left', verticalAlign: 'top',
            };
        }
        return { type: card.type, locked: false, createdAt: now, createdBy: 'agent', ...(card._raw || {}) };
    };

    const zip = new JSZip();
    const manifest = {
        format: 'klypix', version: 4, schemaVersion: 4,
        createdAt: nowIso, updatedAt: nowIso,
        title: spec.title || 'Untitled',
        stats: { itemCount: order.length, assetCount: 0, totalBytes: 0 },
        sync: { enabled: false, lastSyncRev: null, lastSyncAt: null, deviceId: `dev_${rand()}${rand()}` },
    };
    const xs = Object.values(positions);
    const minX = Math.min(...xs.map(p => p.x)), minY = Math.min(...xs.map(p => p.y));
    const canvasJson = {
        version: 4,
        view: { panX: 120 - minX * 0.7, panY: 120 - minY * 0.7, zoom: 0.7 },
        order, connections, lines: [], strokes: [], nextGroupNumber: 1,
        positions, settings: { background: '#0a0a0f' },
    };
    zip.file('manifest.json', JSON.stringify(manifest));
    zip.file('canvas.json', JSON.stringify(canvasJson));
    for (const id of order) {
        const card = cards[idByIndex.indexOf(id)];
        zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify(itemJson(card)));
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Append cards (+ optional connections) to an EXISTING v4 .klypix, preserving
 * every existing item and its position. New cards are placed in a column just
 * to the right of the current content and stacked on top (z above existing).
 * connection from/to may reference a NEW card by index/title, or an EXISTING
 * card by its title. Returns a nodebuffer of the updated file.
 */
export async function appendToKlypix(buffer, addition) {
    const { zip, canvas, manifest, isV4, struct } = await parseKlypix(buffer);
    if (!isV4 || !canvas.positions) {
        throw new Error('append supports v4 .klypix only; for a legacy .any, create a new canvas instead');
    }
    const newCards = (addition?.cards || []).filter(c => c && typeof c.text === 'string' && c.text.trim());
    if (newCards.length === 0) throw new Error('nothing to add — provide cards[] with text');

    const now = Date.now();
    const rand = () => Math.random().toString(36).slice(2, 10);
    const FONT = 20, LINE_H = FONT * 1.35;

    const ex = Object.values(canvas.positions);
    const maxX = ex.length ? Math.max(...ex.map(p => p.x + (p.w || 160))) : 80;
    const minY = ex.length ? Math.min(...ex.map(p => p.y)) : 80;
    const startX = maxX + 80;

    const titleToId = new Map();
    for (const c of struct.cards) { const t = (c.title || '').toLowerCase(); if (t && !titleToId.has(t)) titleToId.set(t, c.id); }

    let zTop = Array.isArray(canvas.order) ? canvas.order.length : 0;
    const added = newCards.map((c, i) => {
        const lines = String(c.text).split('\n');
        const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
        const w = Math.max(160, Math.min(360, Math.round(longest * (FONT * 0.55)) + 28));
        const h = Math.max(40, Math.round(lines.length * LINE_H) + 14);
        return { id: `txt_${rand()}_${i}`, card: c, x: startX, y: minY + i * 160, w, h, z: zTop + i };
    });

    const addedTitle = new Map(added.map(a => [String(a.card.text).split('\n').map(s => s.trim()).find(Boolean)?.toLowerCase() || '', a.id]));
    const resolve = (ref) => {
        if (typeof ref === 'number') return added[ref]?.id ?? null;
        if (typeof ref === 'string') {
            const k = ref.trim().toLowerCase();
            return addedTitle.get(k) || titleToId.get(k) || (canvas.positions[ref] ? ref : null);
        }
        return null;
    };

    canvas.order = Array.isArray(canvas.order) ? canvas.order : [];
    // New cards go above the existing top — generate valid keys starting just
    // above the highest existing VALID key (ignoring any legacy bad keys).
    const existingTop = Object.values(canvas.positions || {}).map(p => p && p.zKey).filter(k => k && isValidZKey(k)).sort().pop() || null;
    const nextZKey = makeZKeyGen(existingTop);
    for (const a of added) {
        zip.file(`items/${shard(a.id)}/${a.id}.json`, JSON.stringify({
            type: 'text', locked: false, createdAt: now, createdBy: 'agent',
            ...(a.card.createdVia ? { createdVia: String(a.card.createdVia) } : {}),
            content: String(a.card.text), fontSize: FONT,
            color: a.card.color || '#1a1a1f', border: !!a.card.border, borderColor: '#1e1e2e',
            heading: !!a.card.heading, fontFamily: 'Thmanyah Sans',
            fontWeight: a.card.heading ? 'bold' : 'normal', fontStyle: 'normal',
            textDecoration: 'none', textAlign: 'left', verticalAlign: 'top',
        }));
        canvas.positions[a.id] = { x: a.x, y: a.y, w: a.w, h: a.h, zKey: nextZKey(), zIndex: a.z, parentId: null };
        canvas.order.push(a.id);
    }

    canvas.connections = Array.isArray(canvas.connections) ? canvas.connections : [];
    (addition?.connections || []).forEach((cn, i) => {
        const fromId = resolve(cn.from), toId = resolve(cn.to);
        if (!fromId || !toId || fromId === toId) return;
        canvas.connections.push({
            id: `con_${rand()}_${i}`, fromId, toId,
            relationship: REL.has(cn.relationship) ? cn.relationship : undefined,
            label: typeof cn.label === 'string' ? cn.label : undefined,
            arrowHead: true, width: 2, color: '#10b981', style: 'solid',
        });
    });

    if (manifest) {
        manifest.updatedAt = new Date(now).toISOString();
        manifest.stats = manifest.stats || {};
        manifest.stats.itemCount = canvas.order.length;
        zip.file('manifest.json', JSON.stringify(manifest));
    }
    zip.file('canvas.json', JSON.stringify(canvas));
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    // Parse-resilience: never return a buffer that doesn't round-trip — the
    // caller keeps the last-known-good file rather than writing corruption.
    try { await parseKlypix(out); }
    catch (e) { throw new Error('append produced an unparseable .klypix — aborting to protect the brain: ' + (e?.message || e)); }
    return out;
}

// ── Area-grouped layout (project brain) ──────────────────────────────────────
// Captured decisions carry an [Area]; these route cards INTO titled area
// containers (find-or-create) so the brain stays a clean areas-as-containers map
// instead of a rightward strip. Non-destructive, valid z-keys, atomic round-trip.
const BRAIN_GEOM = { TITLE_BAR: 40, PAD: 14, CARD_GAP: 10, CARD_W: 300, FONT: 12, LINE_H: 17, START: 80, COL_GAP: 44 };
BRAIN_GEOM.AREA_W = BRAIN_GEOM.CARD_W + BRAIN_GEOM.PAD * 2;

// Chars that fit on one rendered line. The bordered card has 10px L/R padding,
// so the text area is CARD_W-20; use a conservative char width (font*0.62) so a
// wrapped line never RE-wraps in-app (which would double a card's height).
function brainCPL() { return Math.max(8, Math.floor((BRAIN_GEOM.CARD_W - 24) / (BRAIN_GEOM.FONT * 0.62))); }

// Hard-wrap text to ~CARD_W by inserting newlines at word boundaries. KLYPIX text
// cards show a long SINGLE line as-typed (no auto-wrap until you resize), so a
// captured decision with no newlines runs off the box. Baking in line breaks
// makes brain cards render as tidy multi-line blocks regardless of that.
function wrapText(text, cpl = brainCPL()) {
    const out = [];
    for (const para of String(text ?? '').split('\n')) {
        if (para.length <= cpl) { out.push(para); continue; }
        let line = '';
        for (const tok of para.split(/(\s+)/)) {
            if (line && (line + tok).trimEnd().length > cpl) { out.push(line.trimEnd()); line = tok.replace(/^\s+/, ''); }
            else line += tok;
            while (line.length > cpl) { out.push(line.slice(0, cpl)); line = line.slice(cpl); } // break an over-long word
        }
        if (line.trim()) out.push(line.trimEnd());
    }
    return out.join('\n');
}

function measureCardH(text) {
    // text is hard-wrapped to ≤CPL, so the \n-line count is the rendered line
    // count. Match the bordered card (lineHeight 1.35*font + 8/8 vertical padding
    // + border) and over-estimate slightly → small gaps, never overlap.
    const lines = Math.max(1, String(text ?? '').split('\n').length);
    return Math.max(40, Math.ceil(lines * BRAIN_GEOM.FONT * 1.45) + 26);
}
// Container the next NEW area goes to the right of the rightmost item.
function nextContainerX(canvas) {
    const all = Object.values(canvas.positions);
    return all.length ? Math.max(...all.map(p => (p.x || 0) + (p.w || BRAIN_GEOM.AREA_W))) + BRAIN_GEOM.COL_GAP : BRAIN_GEOM.START;
}
// Bottom y of a container's current children (where the next card stacks).
function containerChildBottom(canvas, ctnId) {
    const ctn = canvas.positions[ctnId];
    let cy = ctn.y + BRAIN_GEOM.TITLE_BAR + BRAIN_GEOM.PAD;
    for (const id of canvas.order) {
        const p = canvas.positions[id];
        if (p && p.parentId === ctnId) cy = Math.max(cy, p.y + (p.h || 40) + BRAIN_GEOM.CARD_GAP);
    }
    return cy;
}
// Best-effort area name for a card: "Area: …" first-line prefix → first #tag → 'Notes'.
function areaOfCard(card) {
    const line1 = String(card.text || '').split('\n')[0].trim();
    const m = line1.match(/^([^:\n]{1,40}):\s+\S/);
    if (m) return m[1].trim();
    if (Array.isArray(card.tags) && card.tags[0]) return String(card.tags[0]);
    return 'Notes';
}
async function finalizeBrainZip(zip, canvas, manifest, now) {
    if (manifest) {
        manifest.updatedAt = new Date(now).toISOString();
        manifest.stats = manifest.stats || {};
        manifest.stats.itemCount = canvas.order.length;
        zip.file('manifest.json', JSON.stringify(manifest));
    }
    zip.file('canvas.json', JSON.stringify(canvas));
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    try { await parseKlypix(out); }
    catch (e) { throw new Error('brain write produced an unparseable .klypix — aborting to protect the brain: ' + (e?.message || e)); }
    return out;
}

// Append cards routed INTO their [Area] container (find-or-create), so captures
// self-organize. addition.cards = [{ text, color?, area? }]. Non-destructive to
// existing items. Falls back to the flat appender for legacy/no-positions files.
export async function appendIntoContainers(buffer, addition) {
    const { zip, canvas, manifest, isV4, struct } = await parseKlypix(buffer);
    if (!isV4 || !canvas.positions) return appendToKlypix(buffer, addition);
    const newCards = (addition?.cards || []).filter(c => c && typeof c.text === 'string' && c.text.trim());
    if (newCards.length === 0) throw new Error('nothing to add — provide cards[] with text');

    const now = Date.now();
    const rand = () => Math.random().toString(36).slice(2, 10);
    const G = BRAIN_GEOM;
    canvas.order = Array.isArray(canvas.order) ? canvas.order : [];
    const existingTop = Object.values(canvas.positions).map(p => p && p.zKey).filter(k => k && isValidZKey(k)).sort().pop() || null;
    const nextZKey = makeZKeyGen(existingTop);

    const byTitle = new Map();
    for (const c of struct.cards) if (c.type === 'container') { const t = (c.title || '').trim().toLowerCase(); if (t && !byTitle.has(t)) byTitle.set(t, c.id); }
    let ctnX = nextContainerX(canvas);
    const ensureContainer = (area) => {
        const key = area.toLowerCase();
        let id = byTitle.get(key);
        if (id) return id;
        id = `ctn_${rand()}`;
        zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify({
            type: 'container', locked: false, createdAt: now, createdBy: 'agent',
            title: area, collapsed: false, scopeLocked: false, borderColor: '#10b981',
        }));
        canvas.positions[id] = { x: ctnX, y: G.START, w: G.AREA_W, h: G.TITLE_BAR + G.PAD * 2, zKey: nextZKey(), zIndex: canvas.order.length, parentId: null };
        canvas.order.push(id);
        byTitle.set(key, id);
        ctnX += G.AREA_W + G.COL_GAP;
        return id;
    };

    for (const card of newCards) {
        const area = (card.area || areaOfCard(card)).toString().trim() || 'Notes';
        const ctnId = ensureContainer(area);
        const ctn = canvas.positions[ctnId];
        const wrapped = wrapText(String(card.text));
        const h = measureCardH(wrapped);
        const cy = containerChildBottom(canvas, ctnId);
        const id = `txt_${rand()}`;
        zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify({
            type: 'text', locked: false, createdAt: now, createdBy: 'agent',
            // Provenance: WHICH agent remembered this (claude-code / cursor /
            // cline / …) — additive field, ignored by older readers.
            ...(card.createdVia ? { createdVia: String(card.createdVia) } : {}),
            // Evidence anchors (file:line / PR#) — additive, ignored by older readers.
            ...(Array.isArray(card.evidence) && card.evidence.length ? { evidence: card.evidence } : {}),
            content: wrapped, fontSize: G.FONT,
            color: card.color || '#e8e8ed', border: true, borderColor: card.borderColor || card.color || 'rgba(16,185,129,0.45)',
            fillColor: 'rgba(18,18,26,0.85)', heading: !!card.heading, fontFamily: 'Thmanyah Sans',
            fontWeight: card.heading ? 'bold' : 'normal', fontStyle: 'normal',
            textDecoration: 'none', textAlign: 'left', verticalAlign: 'top',
        }));
        canvas.positions[id] = { x: ctn.x + G.PAD, y: cy, w: G.CARD_W, h, zKey: nextZKey(), zIndex: canvas.order.length, parentId: ctnId };
        canvas.order.push(id);
        ctn.h = (cy + h + G.PAD) - ctn.y;
    }
    return finalizeBrainZip(zip, canvas, manifest, now);
}

// Tidy an EXISTING brain: re-parent every root-level text card into its [Area]
// container (find-or-create), grouping the messy strip into clean areas. Moves
// cards (keeps their ids → connections preserved); never drops a card. Caller
// should back up first; this round-trip-verifies before returning.
export async function tidyBrain(buffer) {
    const { zip, canvas, manifest, isV4, struct } = await parseKlypix(buffer);
    if (!isV4 || !canvas.positions) throw new Error('tidy supports v4 .klypix only');
    const now = Date.now();
    const rand = () => Math.random().toString(36).slice(2, 10);
    const G = BRAIN_GEOM;
    canvas.order = Array.isArray(canvas.order) ? canvas.order : [];
    const top = Object.values(canvas.positions).map(p => p && p.zKey).filter(k => k && isValidZKey(k)).sort().pop() || null;
    const nextZKey = makeZKeyGen(top);

    // Normalize every text card to the compact brain font (so the render matches
    // our height measure → no overlap) + cache each card's measured height.
    const meta = new Map(); // id -> { h }
    for (const c of struct.cards) {
        if (c.type === 'container') continue;
        const wrapped = wrapText(String(c.text ?? ''));
        let createdAt = 0;
        const ip = `items/${shard(c.id)}/${c.id}.json`;
        try { const f = zip.file(ip); if (f) { const j = JSON.parse(await f.async('string')); createdAt = Number(j.createdAt) || 0; j.fontSize = G.FONT; j.content = wrapped; zip.file(ip, JSON.stringify(j)); } } catch { /* leave as-is */ }
        meta.set(c.id, { h: measureCardH(wrapped), createdAt });
    }

    const containerIds = new Set(struct.cards.filter(c => c.type === 'container').map(c => c.id));
    const byTitle = new Map();
    for (const c of struct.cards) if (c.type === 'container') { const t = (c.title || '').trim().toLowerCase(); if (t && !byTitle.has(t)) byTitle.set(t, c.id); }

    // Group ROOT text cards by [Area].
    const rootText = struct.cards.filter(c => c.type !== 'container' && canvas.positions[c.id] && canvas.positions[c.id].parentId == null);
    const groups = new Map(); // key -> { title, ids: [] }
    for (const c of rootText) { const a = areaOfCard(c); const k = a.toLowerCase(); if (!groups.has(k)) groups.set(k, { title: a, ids: [] }); groups.get(k).ids.push(c.id); }

    let moved = 0;
    const createdNow = new Set();   // containers born in THIS pass have no meaningful previous position
    const assignTo = (ctnId, ids) => { for (const id of ids) { const p = canvas.positions[id]; canvas.positions[id] = { ...p, parentId: ctnId, zKey: (p && p.zKey && isValidZKey(p.zKey)) ? p.zKey : nextZKey() }; moved++; } };
    // Ensure a container exists for each area (create if missing); route root cards in.
    for (const grp of groups.values()) {
        const key = grp.title.toLowerCase();
        let ctnId = byTitle.get(key);
        if (!ctnId) {
            ctnId = `ctn_${rand()}`;
            createdNow.add(ctnId);
            zip.file(`items/${shard(ctnId)}/${ctnId}.json`, JSON.stringify({ type: 'container', locked: false, createdAt: now, createdBy: 'agent', title: grp.title, collapsed: false, scopeLocked: false, borderColor: '#10b981' }));
            canvas.order.push(ctnId);
            canvas.positions[ctnId] = { x: G.START, y: G.START, w: G.AREA_W, h: G.TITLE_BAR + G.PAD * 2, zKey: nextZKey(), zIndex: canvas.order.length, parentId: null };
            byTitle.set(key, ctnId); containerIds.add(ctnId);
        }
        assignTo(ctnId, grp.ids);
    }

    // ── CLUSTER LAYOUT ────────────────────────────────────────────────────────
    // The old shelf-grid stacked every area's cards in ONE column and packed
    // containers in creation order — at 400+ cards the brain rendered as an
    // unreadable strip and position encoded nothing. Now:
    //   • MASONRY inside each container: cards flow into 1-5 balanced columns
    //     targeting a ~1.15 height/width ratio → areas are squarish tiles.
    //   • CLUSTERS across containers: each area is placed greedily beside the
    //     already-placed area it shares the most connections with — related
    //     knowledge is literally near, cross-area arrows stay short.
    //   • 📌 Focus (the human steering surface) anchors the map center; Archive
    //     is pinned to the cold rim (its supersede/close arrows touch every
    //     area, so edge weights would otherwise drag it central).
    // Deterministic (no RNG, stable ordering): the same brain always maps the
    // same way, and one new card nudges its own cluster instead of reshuffling
    // the world. At map zoom the app's capsule/dot tiers render this as the
    // cluster-galaxy view; membership steering (dragging a card into an area)
    // is preserved — tidy re-flows coordinates, never parentage.
    // Containers are never masonry "kids" — a nested container would otherwise
    // be committed twice (as its parent's 300×40 pseudo-card AND as its own
    // box), stranding its children at abandoned coordinates.
    const childrenOf = (cid) => canvas.order
        .filter(id => !containerIds.has(id) && canvas.positions[id] && canvas.positions[id].parentId === cid)
        .sort((a, b) => (meta.get(a)?.createdAt || 0) - (meta.get(b)?.createdAt || 0));
    const orderedCtns = canvas.order.filter(id => containerIds.has(id) && canvas.positions[id]);
    const ctnTitle = new Map();
    for (const c of struct.cards) if (c.type === 'container') ctnTitle.set(c.id, c.title || '');
    for (const [t, id] of byTitle) if (!ctnTitle.has(id)) ctnTitle.set(id, t);
    const isArchiveCtn = (cid) => /^archive$/i.test(String(ctnTitle.get(cid) || '').trim());
    const isFocusCtn = (cid) => /(^|\s)focus\b/i.test(String(ctnTitle.get(cid) || ''));

    if (orderedCtns.length) {
        // 0. Flatten human-nested containers to root. The capture toolchain
        // never nests; a hand-nested area would be committed twice (as its
        // parent's 300×40 pseudo-card AND as its own box), stranding its
        // children. Promoted areas keep their absolute spot via the
        // incremental anchor below, so visually nothing jumps.
        for (const cid of orderedCtns) {
            const p = canvas.positions[cid];
            if (p && p.parentId != null && containerIds.has(p.parentId)) canvas.positions[cid] = { ...p, parentId: null };
        }

        // 1. Masonry plan per container: pick the column count whose resulting
        // box is closest to the target aspect, then flow cards (chronological)
        // into the currently-shortest column.
        const plans = new Map(); // cid -> { w, h, kids: [{id, dx, dy, h}] }
        for (const cid of orderedCtns) {
            const kids = childrenOf(cid);
            const totalH = kids.reduce((s, id) => s + (meta.get(id)?.h || 40) + G.CARD_GAP, 0);
            let k = 1, best = Infinity;
            for (let n = 1; n <= 5 && n <= Math.max(1, kids.length); n++) {
                const w = G.PAD * 2 + n * G.CARD_W + (n - 1) * G.CARD_GAP;
                const h = G.TITLE_BAR + G.PAD * 2 + Math.max(40, totalH / n);
                const score = Math.abs((h / w) - 1.15);
                if (score < best) { best = score; k = n; }
            }
            const colY = new Array(k).fill(G.TITLE_BAR + G.PAD);
            const placedKids = [];
            for (const id of kids) {
                const h = meta.get(id)?.h || 40;
                let col = 0; for (let c = 1; c < k; c++) if (colY[c] < colY[col]) col = c;
                placedKids.push({ id, dx: G.PAD + col * (G.CARD_W + G.CARD_GAP), dy: colY[col], h });
                colY[col] += h + G.CARD_GAP;
            }
            plans.set(cid, {
                w: G.PAD * 2 + k * G.CARD_W + (k - 1) * G.CARD_GAP,
                h: Math.max(G.TITLE_BAR + G.PAD * 2, Math.max(...colY) + G.PAD),
                kids: placedKids,
            });
        }

        // 2. Inter-area connection weights (Archive excluded — rim-pinned).
        const parentOf = (id) => canvas.positions[id]?.parentId ?? null;
        const weights = new Map();
        for (const cn of (canvas.connections || [])) {
            const pa = parentOf(cn.fromId), pb = parentOf(cn.toId);
            if (!pa || !pb || pa === pb || !plans.has(pa) || !plans.has(pb)) continue;
            if (isArchiveCtn(pa) || isArchiveCtn(pb)) continue;
            const key = pa < pb ? pa + '|' + pb : pb + '|' + pa;
            weights.set(key, (weights.get(key) || 0) + 1);
        }
        const wOf = (a, b) => weights.get(a < b ? a + '|' + b : b + '|' + a) || 0;
        const degree = new Map(orderedCtns.map(cid => [cid, 0]));
        for (const [key, n] of weights) { const [a, b] = key.split('|'); degree.set(a, (degree.get(a) || 0) + n); degree.set(b, (degree.get(b) || 0) + n); }

        // 3. INCREMENTAL by default, full cluster pass only on migration.
        // The full pass orders by (mutable) connectivity — running it per
        // capture reshuffled the entire map the moment one cross-area arrow
        // landed (field-measured: 45/45 containers teleported ~4.4k px on one
        // wikilink). A memory's map must be as stable as the memory: normally
        // every container ANCHORS to its previous spot (taken verbatim when
        // nothing grew into it), so a capture moves at most the areas whose
        // size actually changed. The full pass runs only when the previous
        // layout isn't this engine's (legacy strip, foreign grid, degenerate
        // aspect) — detected via the settings stamp + geometry heuristics.
        const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // code-unit compare — locale-independent, unlike bare localeCompare
        const prev = new Map();
        for (const cid of orderedCtns) {
            if (createdNow.has(cid)) continue;
            const p = canvas.positions[cid];
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) prev.set(cid, { x: p.x, y: p.y, w: p.w || 0, h: p.h || 0 });
        }
        let fullPass = !(canvas.settings && canvas.settings.brainLayout === 'cluster-v1');
        if (fullPass && prev.size >= 2 && [...prev.values()].some(b => b.w > 400)) fullPass = false; // stamp lost (e.g. app re-save) but geometry is clearly cluster-made
        if (!fullPass && prev.size >= 2) {
            const xs = [...prev.values()];
            const w = Math.max(...xs.map(b => b.x + b.w)) - Math.min(...xs.map(b => b.x));
            const h = Math.max(...xs.map(b => b.y + b.h)) - Math.min(...xs.map(b => b.y));
            const aspect = h / Math.max(1, w);
            if (aspect > 4 || aspect < 0.1) fullPass = true;   // degenerate strip → re-map
        }
        if (prev.size < 2) fullPass = true;

        const focusCtns = orderedCtns.filter(isFocusCtn);
        const isRim = (c) => !isFocusCtn(c) && isArchiveCtn(c);
        let placeOrder, rimCtns;
        if (fullPass) {
            // Hubs early so satellites attach to them; Focus anchors the map.
            rimCtns = orderedCtns.filter(isRim);
            const middle = orderedCtns.filter(c => !isFocusCtn(c) && !isRim(c))
                .sort((a, b) => ((degree.get(b) || 0) - (degree.get(a) || 0))
                    || (plans.get(b).kids.length - plans.get(a).kids.length)
                    || cmp(String(ctnTitle.get(a) || ''), String(ctnTitle.get(b) || ''))
                    || cmp(a, b));
            placeOrder = [...focusCtns, ...middle];
        } else {
            // Previous spatial order (top-left claims its spot first) — an
            // IMMUTABLE ordering, so new arrows can't reshuffle the queue.
            const anchored = orderedCtns.filter(c => prev.has(c))
                .sort((a, b) => (prev.get(a).y - prev.get(b).y) || (prev.get(a).x - prev.get(b).x) || cmp(a, b));
            const fresh = orderedCtns.filter(c => !prev.has(c) && !isRim(c))
                .sort((a, b) => ((degree.get(b) || 0) - (degree.get(a) || 0)) || cmp(a, b));
            rimCtns = orderedCtns.filter(c => !prev.has(c) && isRim(c));
            placeOrder = [...anchored, ...fresh];
        }

        // 4. Greedy placement. Anchored containers try their previous spot
        // verbatim first (zero movement when nothing grew into it), else the
        // nearest free side/corner slot. Unanchored ones score by
        // connection-weighted distance + a gentle compactness pull.
        const GAP = G.COL_GAP;
        const boxes = new Map();
        const overlapsAny = (b) => { for (const o of boxes.values()) if (b.x < o.x + o.w + GAP && o.x < b.x + b.w + GAP && b.y < o.y + o.h + GAP && o.y < b.y + b.h + GAP) return true; return false; };
        const cxOf = (b) => b.x + b.w / 2, cyOf = (b) => b.y + b.h / 2;
        const distC = (a, b) => Math.hypot(cxOf(a) - cxOf(b), cyOf(a) - cyOf(b));
        for (const cid of placeOrder) {
            const plan = plans.get(cid);
            const anchor = !fullPass && prev.has(cid) ? prev.get(cid) : null;
            if (anchor) {
                const b0 = { x: anchor.x, y: anchor.y, w: plan.w, h: plan.h };
                if (!overlapsAny(b0)) { boxes.set(cid, b0); continue; }
            }
            if (!boxes.size) { boxes.set(cid, { x: anchor ? anchor.x : 0, y: anchor ? anchor.y : 0, w: plan.w, h: plan.h }); continue; }
            let mx = 0, my = 0;
            for (const b of boxes.values()) { mx += cxOf(b); my += cyOf(b); }
            mx /= boxes.size; my /= boxes.size;
            const anchorBox = anchor ? { x: anchor.x, y: anchor.y, w: plan.w, h: plan.h } : null;
            let bestPos = null, bestScore = Infinity;
            for (const o of boxes.values()) {
                const cands = [
                    { x: o.x + o.w + GAP, y: o.y }, { x: o.x, y: o.y + o.h + GAP },
                    { x: o.x - GAP - plan.w, y: o.y }, { x: o.x, y: o.y - GAP - plan.h },
                    { x: o.x + o.w + GAP, y: o.y + o.h + GAP }, { x: o.x - GAP - plan.w, y: o.y + o.h + GAP },
                    { x: o.x + o.w + GAP, y: o.y - GAP - plan.h }, { x: o.x - GAP - plan.w, y: o.y - GAP - plan.h },
                ];
                for (const c of cands) {
                    const b = { x: c.x, y: c.y, w: plan.w, h: plan.h };
                    if (overlapsAny(b)) continue;
                    let score;
                    if (anchorBox) {
                        score = distC(b, anchorBox);            // reclaim the old neighborhood
                    } else {
                        let pull = 0, wsum = 0;
                        for (const [pid, pb] of boxes) { const w = wOf(cid, pid); if (w) { pull += w * distC(b, pb); wsum += w; } }
                        const toCentroid = Math.hypot(cxOf(b) - mx, cyOf(b) - my);
                        score = (wsum ? pull / wsum : toCentroid) + 0.05 * toCentroid;
                    }
                    if (score < bestScore) { bestScore = score; bestPos = b; }
                }
            }
            boxes.set(cid, bestPos || { x: 0, y: Math.max(...[...boxes.values()].map(b => b.y + b.h)) + GAP, w: plan.w, h: plan.h });
        }
        // Rim containers (Archive without a previous spot / full pass): the
        // cold right edge, each right of the last so they never stack.
        for (const cid of rimCtns) {
            const plan = plans.get(cid);
            const maxX = boxes.size ? Math.max(...[...boxes.values()].map(b => b.x + b.w)) : 0;
            const topY = boxes.size ? Math.min(...[...boxes.values()].map(b => b.y)) : 0;
            boxes.set(cid, { x: maxX + GAP * 3, y: topY, w: plan.w, h: plan.h });
        }

        // 5. Commit: normalize to START only when the map would drift off-origin
        // (incremental runs keep absolute coordinates → anchored spots stay
        // byte-identical), write containers + kids, stamp the layout engine.
        const minX = Math.min(...[...boxes.values()].map(b => b.x));
        const minY = Math.min(...[...boxes.values()].map(b => b.y));
        const dx = (fullPass || minX < 0) ? G.START - minX : 0;
        const dy = (fullPass || minY < 0) ? G.START - minY : 0;
        for (const [cid, b] of boxes) {
            const x = b.x + dx, y = b.y + dy;
            canvas.positions[cid] = { ...canvas.positions[cid], x, y, w: b.w, h: b.h };
            for (const kid of plans.get(cid).kids) {
                canvas.positions[kid.id] = { ...canvas.positions[kid.id], x: x + kid.dx, y: y + kid.dy, w: G.CARD_W, h: kid.h };
            }
        }
        canvas.settings = { ...(canvas.settings || {}), brainLayout: 'cluster-v1' };
    }

    const out = await finalizeBrainZip(zip, canvas, manifest, now);
    return { buffer: out, moved, containers: byTitle.size };
}

// ── Tiered brain brief ───────────────────────────────────────────────────────
// A compact, token-bounded session brief: area map + open questions + recent
// decisions + milestones. Everything older stays in the file, reachable via the
// klypix-canvas MCP search or `--full`. Keeps the session-start cost flat as
// the brain grows (the full markdown scales with history; this doesn't).
export function structToBrief(struct, { recentDays = 14, maxRecent = 40, maxMilestones = 8, maxConnections = 30, maxSkills = 24, detailRecent = 8, freshness = null } = {}) {
    const cutoff = Date.now() - recentDays * 86_400_000;
    const texts = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim());
    const containers = struct.cards.filter(c => c.type === 'container');
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    // 📌 FOCUS — the human steers agent attention SPATIALLY: any card dragged
    // into a container titled "Focus" (any decoration: "📌 Focus", "Focus
    // (drag cards here)") leads every brief, full text, regardless of age.
    const isFocus = (c) => /(^|\s)focus\b/i.test(c.area || '');
    const live = texts.filter(c => !isArchived(c));
    const focus = live.filter(isFocus);
    const rest = live.filter(c => !isFocus(c));
    // 🎯 (goal/target) reads as an OPEN item alongside ❓ — a goal card is
    // still-to-do until a ✓/closes: or a covering milestone closes it (so it
    // must NOT masquerade as a plain decision that quietly ages out of view).
    // 🛠️ Skills — reusable how-tos / gotchas / procedures (the '+' marker).
    // Standing reference, NOT a point-in-time event: always shown, never
    // recency-decayed, and excluded from open/milestones/recent so a skill never
    // masquerades as (or ages out like) a decision.
    const skills = rest.filter(c => /🛠/.test(c.text));
    const open = rest.filter(c => /❓|🎯/.test(c.text) && !/🛠/.test(c.text));
    const miles = rest.filter(c => /🏁/.test(c.text) && !/❓|🎯|🛠/.test(c.text));
    const plain = rest.filter(c => !open.includes(c) && !miles.includes(c) && !skills.includes(c));
    const recent = plain.filter(c => c.createdAt >= cutoff).sort((a, b) => b.createdAt - a.createdAt).slice(0, maxRecent);
    const archivedCount = texts.length - live.length;

    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    // Freshness badge (✅ verified / ⚠️ drifted / 🌱 unverified) for code-anchored
    // cards — supplied by the git-aware hook; absent → no badge. Trust at a glance.
    const fr = (c) => (freshness && freshness[c.id]) ? freshness[c.id] + ' ' : '';
    // HEADLINE = first sentence-ish, hard-capped — the brief is a scannable
    // changelog; the agent pulls any card's full text via the MCP when needed.
    // Hard cuts must not split a UTF-16 surrogate pair (an emoji straddling the cap
    // would serialize as U+FFFD in the brief / AGENTS.md).
    const safeCut = (t, n) => { let s = t.slice(0, n); if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1); return s.trimEnd() + '…'; };
    const headline = (c, max = 160) => {
        const t = flat(c.text);
        const stop = t.search(/(?<=[.!?])\s/);
        const h = stop > 40 && stop < max ? t.slice(0, stop) : t;
        return h.length > max ? safeCut(h, max - 1) : h;
    };
    // EXCERPT = the first few sentences, cut at the last sentence boundary under the
    // cap. The newest `detailRecent` decisions get this instead of a headline: the
    // recall eval showed detail questions about the freshest cards are exactly what a
    // 160-char headline loses (status, resolution, the "what exactly shipped").
    const excerpt = (c, max = 420) => {
        const t = flat(c.text);
        if (t.length <= max) return t;
        let cut = -1;
        const re = /(?<=[.!?])\s/g; let m;
        while ((m = re.exec(t)) && m.index < max) cut = m.index;
        return cut > 120 ? t.slice(0, cut) : safeCut(t, max - 1);
    };
    const day = (ts) => ts ? new Date(ts).toISOString().slice(0, 10) : '';

    // TOKEN BUDGET (≈ chars/4): sections are added in priority order — Focus,
    // Open, Areas, Milestones, Recent, Connections — and Recent stops when the
    // budget is hit. The brief stays ~flat forever no matter how active a week.
    const BUDGET_CHARS = 13_500; // ≈ 3.3k tokens (raised for the detailed-newest tier; still hard-capped/flat)
    let used = 0;
    const out = [];
    const push = (...lines) => { for (const l of lines) { out.push(l); used += l.length + 1; } };

    push(`# ${struct.title} — brain brief`);
    push(`*${struct.format} · ${struct.counts.cards} cards · ${struct.counts.connections} connections · tiered brief (focus + open + last ${recentDays}d headlines); full cards via klypix-canvas MCP search*`);
    if (focus.length) {
        push('', '## 📌 Human focus (cards the human placed here — act on these first)');
        for (const c of focus) push(`- ${fr(c)}${flat(c.text)}`);
    }
    if (open.length) { push('', '## Open questions & goals'); for (const c of open) push(`- ${fr(c)}${flat(c.text)}`); }
    if (skills.length) {
        push('', '## 🛠️ Skills — how we do things here (reusable; applies every session)');
        for (const c of skills.slice(0, maxSkills)) push(`- ${fr(c)}${flat(c.text)}`);
        if (skills.length > maxSkills) push(`- …and ${skills.length - maxSkills} more skill(s) — search the brain.`);
    }
    // ⚠️ Conflicts — pairs flagged conflicts_with (e.g. by parallel sessions);
    // surfaced HIGH so the next session reconciles them, not buries them.
    const conflicts = (struct.connections || []).filter(c => c.relationship === 'conflicts_with');
    if (conflicts.length) { push('', '## ⚠️ Conflicts to reconcile (parallel decisions that may disagree)'); for (const c of conflicts.slice(0, 10)) push(`- ${flat(c.from)}  ⚔️  ${flat(c.to)}`); }
    const areaCounts = containers
        .filter(c => !/^archive$/i.test(c.title || ''))
        .map(c => `${flat(c.title)} (${texts.filter(t => t.parentId === c.id).length})`);
    if (areaCounts.length) { push('', '## Areas', areaCounts.join(' · ')); }
    if (miles.length) {
        push('', '## Milestones');
        for (const c of miles.sort((a, b) => b.createdAt - a.createdAt).slice(0, maxMilestones)) push(`- ${fr(c)}${headline(c)}`);
    }
    let shownRecent = 0;
    if (recent.length) {
        push('', `## Recent decisions (last ${recentDays}d — newest first in detail, rest headlines)`);
        // Detail tier FIRST (recent is newest-first), so the budget can never be
        // eaten by older headlines before the cards the header promises in detail.
        const detail = recent.slice(0, detailRecent);
        for (const c of detail) {
            if (used > BUDGET_CHARS) break;
            push(`- ${fr(c)}[${flat(c.area) || 'Notes'}] ${day(c.createdAt)} ${excerpt(c)}`);
            shownRecent++;
        }
        const rest = recent.slice(detailRecent);
        const byArea = new Map();
        for (const c of rest) { const a = flat(c.area) || 'Notes'; if (!byArea.has(a)) byArea.set(a, []); byArea.get(a).push(c); }
        outer: for (const [a, cs] of byArea) {
            if (used > BUDGET_CHARS) break;
            push(`### ${a}`);
            for (const c of cs) {
                if (used > BUDGET_CHARS) break outer;
                push(`- ${fr(c)}${day(c.createdAt)} ${headline(c)}`);
                shownRecent++;
            }
        }
    }
    if (struct.connections.length && used <= BUDGET_CHARS) {
        push('', '## Connections');
        for (const cn of struct.connections.slice(0, maxConnections)) push(`- ${cn.from} → ${cn.to}${cn.label || cn.relationship ? ` (${cn.label || cn.relationship})` : ''}`);
    }
    const hidden = [];
    const unshown = plain.length - shownRecent;
    if (unshown > 0) hidden.push(`${unshown} older/over-budget decision${unshown === 1 ? '' : 's'}`);
    if (archivedCount > 0) hidden.push(`${archivedCount} archived/superseded`);
    if (hidden.length) push('', `*${hidden.join(' + ')} not shown — search the full brain via the klypix-canvas MCP (search/read tools) or \`node ~/.claude/project-brain/global-brain-hook.mjs --full\`.*`);
    // Graph health, ambient: when a third of the live brain is unlinked, say so
    // once (brain_insights has the detail; auto-linking at capture works the
    // backlog down going forward).
    const degIds = new Set();
    for (const cn of struct.connections || []) { if (cn.fromId) degIds.add(cn.fromId); if (cn.toId) degIds.add(cn.toId); }
    const orphanN = live.filter(c => !degIds.has(c.id)).length;
    if (live.length >= 10 && orphanN / live.length > 0.3) push('', `*graph: ${orphanN}/${live.length} live cards have no connections — \`brain_connect\` (or capturing with [[wikilinks]]) densifies the graph.*`);
    return out.join('\n') + '\n';
}

// ── Ultra brief (SessionStart stdout tier) ───────────────────────────────────
// The harness persists hook stdout to a file and shows the agent only a ~2KB
// PREVIEW — a 13.5KB brief was mostly invisible (everything after Focus/open
// questions reached the agent only if it chose to open the file; it usually
// didn't). This tier is sized to fit that preview WHOLE: Focus + conflicts +
// open questions + a pointer to the FULL brief file the hook writes alongside.
// The pointer + marker legend are reserved OUT of the budget so they always fit.
export const ULTRA_BUDGET_CHARS = 1_800;   // sibling of BUDGET_CHARS above — sized for the harness preview, not token cost
export function structToUltraBrief(struct, { freshness = null, briefPath = '.claude/brain-brief.md', budgetChars = ULTRA_BUDGET_CHARS } = {}) {
    const texts = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim());
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const isFocus = (c) => /(^|\s)focus\b/i.test(c.area || '');
    const live = texts.filter(c => !isArchived(c));
    const focus = live.filter(isFocus);
    const open = live.filter(c => /❓|🎯/.test(c.text) && !/🛠/.test(c.text) && !isFocus(c));
    const skills = live.filter(c => /🛠/.test(c.text) && !isFocus(c));
    const conflicts = (struct.connections || []).filter(c => c.relationship === 'conflicts_with');
    const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const fr = (c) => (freshness && freshness[c.id]) ? freshness[c.id] + ' ' : '';
    const safeCut = (t, n) => { let s = t.slice(0, n); if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1); return s.trimEnd() + '…'; };
    const head = (c, max = 150) => { const t = flat(c.text); return t.length > max ? safeCut(t, max - 1) : t; };
    const out = [];
    let used = 0;
    const push = (...ls) => { for (const l of ls) { out.push(l); used += l.length + 1; } };
    // Length-aware guard: a line only lands if it FITS — one long focus card
    // must not blow the tier past the preview it exists to fit inside.
    const pushIf = (l) => { if (used + l.length + 1 > budget) return false; out.push(l); used += l.length + 1; return true; };
    const tail = [
        '',
        `📖 **Full brief: \`${briefPath}\`** — skills (${skills.length}), milestones, recent decisions, connections, self-heal detail. READ IT before planning non-trivial work.`,
        '🧠 Capture: `🧠 BRAIN [Area]: <decision>` · `?` question · `!` milestone · `+` skill · `✓` resolve · `~` update · a "CORRECTION: …" decision supersedes its stale card across areas · suffixes `closes:` / `ev:` (full legend in the brief file).',
    ];
    const budget = Math.max(400, budgetChars - tail.reduce((s, l) => s + l.length + 1, 0));
    push(`# ${struct.title} — brain (ultra brief)`);
    push(`*${struct.counts.cards} cards · ${struct.counts.connections} connections — this is the preview tier; the full brief is one Read away (below)*`);
    // clip = surrogate-safe truncation for arbitrary strings (head() covers cards).
    const clip = (s, n) => { const t = flat(s); return t.length > n ? safeCut(t, n - 1) : t; };
    if (focus.length && pushIf('') && pushIf('## 📌 Human focus (act on these first)')) {
        let shown = 0;
        for (const c of focus) { if (!pushIf(`- ${fr(c)}${head(c, 400)}`)) break; shown++; }
        // Never present a truncated "act on these first" list as complete.
        if (shown < focus.length) push(`- ⚠️ …and ${focus.length - shown} MORE focus card(s) — read the full brief before acting.`);
    }
    if (conflicts.length && pushIf('') && pushIf('## ⚠️ Conflicts to reconcile')) {
        let shown = 0;
        for (const c of conflicts.slice(0, 4)) { if (!pushIf(`- ${clip(c.from, 70)} ⚔️ ${clip(c.to, 70)}`)) break; shown++; }
        if (shown < conflicts.length) pushIf(`- …and ${conflicts.length - shown} more conflict(s) — in the full brief.`);
    }
    if (open.length && pushIf('') && pushIf(`## Open questions & goals (${open.length})`)) {
        let shown = 0;
        for (const c of open) { if (!pushIf(`- ${fr(c)}${head(c)}`)) break; shown++; }
        if (shown < open.length) pushIf(`- …and ${open.length - shown} more — in the full brief.`);
    }
    const areas = struct.cards.filter(c => c.type === 'container' && !/^archive$/i.test(c.title || ''))
        .map(c => `${flat(c.title)} (${texts.filter(t => t.parentId === c.id).length})`);
    if (areas.length) { pushIf(''); pushIf(clip('Areas: ' + areas.join(' · '), 240)); }
    push(...tail);
    return out.join('\n') + '\n';
}

// ── Relevance ranking ─────────────────────────────────────────────────────
// ONE shared lexical ranker so the per-prompt retrieval hook (and, later, the
// MCP search) rank cards the SAME way — no third divergent scorer. Weights
// mirror the MCP convention: title 3, tag 2, body 1, plus a gentle recency
// tiebreak. Pure + node-runnable (no embeddings / network) so the Stop/prompt
// hooks can call it with zero extra deps. `#file-…`/`#dir-…` tags (added at
// capture) are what make a git-diff token match a card precisely.
const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'was', 'were', 'are', 'you', 'your', 'not', 'but', 'its', 'into', 'out', 'can', 'will', 'use', 'using', 'about', 'what', 'when', 'why', 'how', 'add', 'fix', 'make', 'need', 'want', 'let', 'see', 'get', 'got', 'now', 'all', 'any', 'via', 'per', 'etc', 'should', 'could', 'would', 'does', 'did', 'still', 'just', 'like', 'also', 'then', 'than', 'them', 'they']);
export function queryTokens(s) {
    return [...new Set(String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || [])].filter(t => !STOPWORDS.has(t));
}
const wordsOf = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || []);
export function scoreCardsAgainstQuery(struct, query, { topK = 6, minScore = 2, recentDays = 30 } = {}) {
    const tokens = Array.isArray(query) ? query.filter(Boolean) : queryTokens(query);
    if (!tokens.length || !struct || !Array.isArray(struct.cards)) return [];
    const cutoff = Date.now() - recentDays * 86_400_000;
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const scored = [];
    for (const c of struct.cards) {
        if (c.type === 'container' || isArchived(c) || !(c.text || '').trim()) continue;
        // WORD-level matching (not substring) so "app" can't hit "append-klypix"
        // and "main" can't hit "domain". Tag match is on the tag's STEM (the
        // slug after #file-/#dir-/#) so a git-diff token (slugify(basename))
        // lands EXACTLY on its #file- anchor — the precise signal, weighted = a
        // title hit so ONE anchored file match (3 + 0.5 recency) clears minScore.
        const titleW = wordsOf(c.title);
        const bodyW = wordsOf(c.text);
        const tagStems = new Set((c.tags || []).map(t => String(t).toLowerCase().replace(/^#/, '').replace(/^(file|dir)-/, '')).filter(Boolean));
        // Log-length normalization: a flat 1pt/word-hit made LONG cards outrank
        // short ones purely by having more vocabulary to hit (one ~600-word card
        // was re-injected into 3 prompts on those cheap hits). Body hits are
        // scaled by log2 of the body's distinct-word count — ≤64 words is EXACTLY
        // unpenalized (log2(64)=6), a 600-word card scores ~0.65/hit, so a
        // body-only match on a big card needs 5 distinct hits to clear the recall
        // minScore of 3 — by design. Title/tag hits (the precise signals) are
        // untouched.
        const lenNorm = Math.min(1, 6 / Math.max(6, Math.log2(bodyW.size || 1)));
        let score = 0;
        for (const tok of tokens) {
            if (titleW.has(tok)) score += 3;
            else if (tagStems.has(tok)) score += 3;
            else if (bodyW.has(tok)) score += lenNorm;
        }
        if (score <= 0) continue;
        if ((c.createdAt || 0) >= cutoff) score += 0.5; // gentle recency tiebreak, never dominant
        if (/🛠/.test(c.text)) score += 1; // 🛠️ skills are standing how-tos — surface them when relevant, regardless of age
        scored.push({ card: c, score });
    }
    scored.sort((a, b) => b.score - a.score || (b.card.createdAt || 0) - (a.card.createdAt || 0));
    return scored.filter(s => s.score >= minScore).slice(0, topK);
}

// ── External-state reconcile — migration omission tripwire ───────────────────
// The brain is a NARRATION-capture system: a fact exists only if someone wrote a
// 🧠 marker or a rationale-bearing commit body. Applying a DB migration to prod
// is an OBSERVED side-effect that narrates nothing, so it silently never lands —
// and the brain can't tell a *committed* migration from an *applied* one. These
// two pure functions are the portable seam that closes that blind spot WITHOUT
// making the brain omniscient: no I/O, no DB probe, no network, no credentials. A
// collector (the Claude-Code hook, or the brain_reconcile MCP tool) hands them
// the migration FILES found on disk; they return the ones NO LIVE card references,
// so the surface can PROMPT the human to confirm the rollout — never assert it.
// Recall-first by design: ANY plausible hit counts as "recorded", erring toward
// silence over a false nag.
const MIG_STOP = new Set(['migration', 'migrations', 'sql', 'create', 'alter', 'table', 'drop', 'add', 'update', 'init', 'schema', 'public', 'new', 'fix', 'set', 'col', 'column', 'index']);
// Split on EVERY non-alphanumeric (unlike the shared wordsOf, which keeps _- glued)
// so `20260620000000_canvas_blob_size_limit` and the `#file-…` tag both tokenize
// into the same words a card's prose carries — the precise match signal.
const migWords = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean));
export function migrationSignature(file) {
    const orig = String(file || '').replace(/\\/g, '/');
    const base = orig.split('/').pop() || '';
    const stem = base.replace(/\.[a-z0-9]+$/i, '');
    const ts = (stem.match(/^\d{8,}/) || [''])[0];                      // leading timestamp id (Supabase/Prisma/Knex)
    const distinctive = stem.replace(/^\d{8,}[_-]?/, '')               // drop the timestamp prefix → the descriptive name
        .split(/[^a-z0-9]+/i).map(t => t.toLowerCase())
        .filter(t => t.length >= 3 && !MIG_STOP.has(t));
    return { path: orig, file: base, ts, distinctive };
}
// A migration is "recorded" if some LIVE (non-archived) card mentions its timestamp
// id OR every distinctive word of its name (so "canvas" alone never claims to record
// canvas_blob_size_limit, but a card carrying the #file-<stem> tag or the applied-
// marker prose does). Returns the UNrecorded ones (capped); [] when there are no
// migrations (plain projects stay silent).
export function findUnrecordedMigrations(struct, files, { max = 6 } = {}) {
    const empty = { gaps: [], total: 0, scanned: 0 };
    const sigs = (files || []).map(migrationSignature).filter(s => s.ts || s.distinctive.length);
    if (!sigs.length || !struct || !Array.isArray(struct.cards)) return empty;
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const cardWords = struct.cards
        .filter(c => c && c.type !== 'container' && !isArchived(c))
        .map(c => migWords(String(c.text || '') + ' ' + (c.tags || []).join(' ')));
    const recorded = (sig) => cardWords.some(ws =>
        (sig.ts && ws.has(sig.ts))
        || (sig.distinctive.length > 0 && sig.distinctive.every(t => ws.has(t))));
    const unrecorded = sigs.filter(s => !recorded(s));
    return { gaps: unrecorded.slice(0, max).map(s => ({ file: s.file, path: s.path, ts: s.ts })), total: unrecorded.length, scanned: sigs.length };
}

// ── Repeat / redundancy detection ("you already did this in another session") ─
// The PRECISION-first sibling of scoreCardsAgainstQuery. Instead of "related
// context" it answers a sharper question: is the user about to REDO work that's
// already DONE? It scans COMPLETED-work cards ONLY — 🏁 shipped, ✅ resolved,
// ↩︎ superseded — and INCLUDES the Archive (resolved/superseded cards live there,
// which the relevance ranker deliberately skips). Deliberately strict: a high
// score floor + ≥2 distinct query-token hits, because for a NUDGE a false "you
// already did this" is costly (erodes trust) while a miss is cheap (the loose
// recall list still shows below). Returns each card's `kind` so the caller can
// say "reuse it" (shipped/resolved) vs "see what replaced it" (superseded).
// Pure + node-runnable; reuses the one shared tokenizer — no divergent scorer.
// Generic work-verbs establish that a prompt is WORK, not WHICH work — two of
// them shared with a 🏁 ship-card title used to clear the floor ("deploy it"
// flagged two unrelated PR-merge cards; zero true positives all session).
// Excluded from repeat scoring entirely; the loose recall list still sees them.
const REPEAT_VERB_STOP = new Set([
    'deploy', 'deployed', 'deploying', 'deploys', 'ship', 'shipped', 'shipping', 'ships',
    'merge', 'merged', 'merges', 'merging', 'release', 'released', 'releases', 'releasing',
    'publish', 'published', 'publishes', 'publishing', 'push', 'pushed', 'land', 'landed',
    'build', 'builds', 'building', 'built', 'check', 'checked', 'checking', 'checks',
    'plan', 'planned', 'planning', 'plans', 'best', 'class', 'cut', 'hand', 'handoff',
    'report', 'reports', 'live', 'latest', 'done', 'complete', 'completed', 'finish', 'finished',
    'work', 'task', 'feature',
]);
// Entity-shaped token — the kind that pins WHICH work: carries a digit (version,
// PR#), or a kebab/snake identifier. A #file-/#dir- tag-stem match counts as an
// entity at match time regardless of shape (tags are capture-stamped anchors).
const isEntityToken = (t) => /\d/.test(t) || t.includes('-') || t.includes('_');
export function detectRepeatWork(struct, query, { topK = 2, minScore = 5, minTokens = 2 } = {}) {
    const tokens = Array.isArray(query) ? query.filter(Boolean) : queryTokens(query);
    if (tokens.length < minTokens || !struct || !Array.isArray(struct.cards)) return [];
    const kindOf = (t) => /🏁/.test(t) ? 'shipped' : /✅/.test(t) ? 'resolved' : /↩/.test(t) ? 'superseded' : null;
    const rank = { shipped: 2, resolved: 2, superseded: 1 };
    const out = [];
    for (const c of struct.cards) {
        if (c.type === 'container' || !(c.text || '').trim()) continue;
        const kind = kindOf(c.text);
        if (!kind) continue;                          // only COMPLETED-work cards qualify
        // Score the first MEANINGFUL line, not a marker stamp: supersede/resolve
        // prepend "↩︎ superseded <date>" / lead with "✅ …", which would otherwise
        // become the title and hide the real content from title-weighted matching.
        const firstMeaningful = String(c.text).split('\n').map(s => s.trim()).filter(Boolean).find(l => !/^[↩✅🏁]/u.test(l));
        const titleW = wordsOf(firstMeaningful || c.title);
        const bodyW = wordsOf(c.text);
        const tagStems = new Set((c.tags || []).map(t => String(t).toLowerCase().replace(/^#/, '').replace(/^(file|dir)-/, '')).filter(Boolean));
        // Auto-harvested ship cards (#auto, one-line merge/release events) are
        // dense with exactly the verbs above — they additionally need ≥1 ENTITY
        // token matched before a nudge is worth showing.
        const isAuto = (c.tags || []).some(t => String(t).toLowerCase().replace(/^#/, '') === 'auto');
        let score = 0, matched = 0, entities = 0;
        for (const tok of tokens) {
            if (REPEAT_VERB_STOP.has(tok)) continue;  // "that it's work" ≠ "which work"
            if (titleW.has(tok)) { score += 3; matched++; if (isEntityToken(tok)) entities++; }
            else if (tagStems.has(tok)) { score += 3; matched++; entities++; }
            else if (bodyW.has(tok)) { score += 1; matched++; if (isEntityToken(tok)) entities++; }
        }
        if (matched < minTokens || score < minScore) continue;   // precision-first floor
        if (isAuto && entities < 1) continue;                    // auto cards: entity anchor required
        out.push({ card: c, score, kind });
    }
    out.sort((a, b) => b.score - a.score || (rank[b.kind] - rank[a.kind]) || (b.card.createdAt || 0) - (a.card.createdAt || 0));
    return out.slice(0, topK);
}

// ── Conflict candidate detection ───────────────────────────────────────────
// REAL conflicts only — a conflict is two decisions that genuinely CONTRADICT
// (you can't honor both about the same thing). Topical similarity, duplication,
// and sequential supersession are explicitly NOT conflicts and must never be
// flagged (no false-conflict dump). This is a cheap LEXICAL pre-filter that
// returns CANDIDATES only — same-subject, not-already-connected pairs where at
// least one card uses explicit REVERSAL language. Candidates mean nothing on
// their own: the caller (brain-conflicts.mjs) confirms each with an LLM
// contradiction-check before anything is ever drawn or surfaced. No verifier →
// nothing surfaces. Pure + node-runnable.
// Strong reversal/contradiction terms ONLY — deliberately NOT bare "not"/"don't"
// (too common → false positives). A candidate still has to clear the LLM gate.
const OPPOSITION_RE = /\b(instead of|reverted?|no longer|dropp(?:ed|ing)?|deprecat\w*|abandon\w*|replaced?\b|supersed\w*|changed from|switch(?:ed)? (?:from|to)|rolled? back|overrod|overrides?|contradic\w*|disagree\w*|conflicts? with|reversed?\b)/i;
export function detectConflicts(struct, { minOverlap = 0.45, topK = 12 } = {}) {
    if (!struct || !Array.isArray(struct.cards)) return [];
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const live = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !isArchived(c));
    const wset = new Map(live.map(c => [c.id, new Set(queryTokens(c.text))]));
    const connected = new Set();
    for (const e of struct.connections || []) { connected.add(e.fromId + '|' + e.toId); connected.add(e.toId + '|' + e.fromId); }
    const out = [];
    for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
            const a = live[i], b = live[j];
            if (connected.has(a.id + '|' + b.id)) continue;
            const A = wset.get(a.id), B = wset.get(b.id);
            if (A.size < 4 || B.size < 4) continue;
            let inter = 0; for (const t of A) if (B.has(t)) inter++;
            const overlap = inter / Math.min(A.size, B.size); // overlap coefficient — same subject?
            // Must be same-subject AND carry an explicit reversal signal. Pure
            // similarity / duplication is NOT a candidate (that was the dump).
            if (overlap < minOverlap) continue;
            if (!(OPPOSITION_RE.test(a.text) || OPPOSITION_RE.test(b.text))) continue;
            out.push({ aId: a.id, bId: b.id, a: a.text, b: b.text, area: a.area, overlap: Math.round(overlap * 100) / 100 });
        }
    }
    out.sort((x, y) => y.overlap - x.overlap);
    return out.slice(0, topK);
}

// ── Contradiction candidates (reconcile-proper) ──────────────────────────────
// The retroactive cleaner for stale/correction pairs that slipped past capture
// (cross-area + reworded → no supersede possible by construction). Unlike
// detectConflicts (a pre-filter for an LLM verifier), this is precision-scoped
// enough to surface DIRECTLY for human/agent confirmation: same-subject live
// pairs where (a) exactly ONE side carries an explicit correction cue
// (CORRECTION / OBSOLETE / was WRONG / stale note resolved) — that side is the
// presumed truth — or (b) the two sides use OPPOSITE polarity words about the
// same subject (deferred↔wired, broken↔fixed, dead↔live …). Pairs already
// settled by a supersede/close/conflict arrow are excluded; a plain relates_to
// arrow is NOT a settlement. Suggestion-only — never writes. Pure, node-runnable.
const POLARITY_PAIRS = [
    ['deferred', 'wired'], ['deferred', 'shipped'], ['deferred', 'live'], ['deferred', 'enabled'],
    ['broken', 'fixed'], ['broken', 'working'], ['dead', 'live'], ['dead', 'alive'],
    ['disabled', 'enabled'], ['blocked', 'unblocked'], ['wrong', 'correct'], ['removed', 'restored'],
];
// WORD-boundary matchers, precompiled — substring includes() made 'deadline'
// carry the 'dead' pole and 'delivery' carry 'live', and blocked↔unblocked
// could never fire ('unblocked' contains 'blocked').
const POLARITY_RES = POLARITY_PAIRS.map(([x, y]) => ({ x, y, rx: new RegExp(`\\b${x}\\b`), ry: new RegExp(`\\b${y}\\b`) }));
export function detectContradictions(struct, { minOverlap = 0.45, topK = 12 } = {}) {
    if (!struct || !Array.isArray(struct.cards)) return [];
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const live = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !isArchived(c));
    // Cue meta words stripped up front — same-subject matching must compare the
    // SUBJECT, not the vocabulary of the correction act (see stripCueMeta above).
    const wset = new Map(live.map(c => [c.id, stripCueMeta(new Set(queryTokens(c.text)))]));
    const lower = new Map(live.map(c => [c.id, String(c.text).toLowerCase()]));
    // settled — fully reconciled (supersede/close/conflict arrow): excludes the
    //   pair regardless of kind.
    // linked — ANY deliberate edge (label !== 'auto'): dismisses a POLARITY pair
    //   ("I looked, they relate, not a contradiction"), but never a cue pair —
    //   a correction that [[wikilinks]] its stale card must still surface until
    //   the stale card is actually retired. Auto-drawn edges dismiss nothing.
    const settled = new Set(), linked = new Set();
    for (const e of struct.connections || []) {
        const k1 = e.fromId + '|' + e.toId, k2 = e.toId + '|' + e.fromId;
        if (e.label === 'superseded by' || e.label === 'closed by' || e.relationship === 'conflicts_with') { settled.add(k1); settled.add(k2); }
        if (e.label !== 'auto') { linked.add(k1); linked.add(k2); }
    }
    const out = [];
    for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
            const a = live[i], b = live[j];
            if (settled.has(a.id + '|' + b.id)) continue;
            const A = wset.get(a.id), B = wset.get(b.id);
            if (A.size < 4 || B.size < 4) continue;
            let inter = 0; for (const t of A) if (B.has(t)) inter++;
            const overlap = inter / Math.min(A.size, B.size);           // same subject?
            const aCue = hasCorrectionCue(a.text), bCue = hasCorrectionCue(b.text);
            // Cue-asymmetric pairs may also match on absolute subject mass (long
            // cards — see cueMatch above); cue-less pairs keep the strict ratio.
            const subjectHit = overlap >= minOverlap
                || (aCue !== bCue && inter >= CUE_STRONG_SHARED && overlap >= CUE_RELAXED_COEF);
            if (!subjectHit) continue;
            let why = null, staleC = null, freshC = null;
            if (aCue !== bCue) {
                why = 'correction-cue';                                  // one side explicitly corrects — it is the presumed truth
                freshC = aCue ? a : b; staleC = aCue ? b : a;
            } else if (!aCue && !linked.has(a.id + '|' + b.id)) {
                const la = lower.get(a.id), lb = lower.get(b.id);
                for (const { x, y, rx, ry } of POLARITY_RES) {
                    // each side must carry ONE pole only (word-level) — a card
                    // narrating "from deferred to wired" holds both and
                    // contradicts neither.
                    if ((rx.test(la) && !ry.test(la) && ry.test(lb) && !rx.test(lb))
                        || (ry.test(la) && !rx.test(la) && rx.test(lb) && !ry.test(lb))) { why = `polarity: ${x} ↔ ${y}`; break; }
                }
                if (why) [staleC, freshC] = (a.createdAt || 0) <= (b.createdAt || 0) ? [a, b] : [b, a];  // later card = presumed truth
            }
            if (!why) continue;
            out.push({ stale: staleC, fresh: freshC, why, overlap: Math.round(overlap * 100) / 100, cue: aCue || bCue });
        }
    }
    out.sort((x, y) => (Number(y.cue) - Number(x.cue)) || (y.overlap - x.overlap));
    return out.slice(0, topK);
}

// ── Brain insights ───────────────────────────────────────────────────────────
// "What matters here, and what am I forgetting?" — a deterministic structural
// read of the brain (borrowed from graphify's GRAPH_REPORT, applied to the
// AUTHORED brain, not derived code). Surfaces:
//   • hubs       — the most-connected cards (load-bearing decisions)
//   • orphans    — decision/milestone cards with NO connections (isolated;
//                  maybe forgotten — link them or archive them)
//   • stale ❓   — open questions older than `staleDays` (aging unknowns)
//   • areas      — live-card count per area (what's growing / dormant)
// Pure + node-runnable: no LLM, no network. The agent renders/acts on it.
export function brainInsights(struct, { staleDays = 21, topHubs = 6 } = {}) {
    const cutoff = Date.now() - staleDays * 86_400_000;
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const cards = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim());
    const live = cards.filter(c => !isArchived(c));
    const deg = new Map();
    for (const cn of struct.connections) {
        if (cn.fromId) deg.set(cn.fromId, (deg.get(cn.fromId) || 0) + 1);
        if (cn.toId) deg.set(cn.toId, (deg.get(cn.toId) || 0) + 1);
    }
    const headline = (c) => String(c.text || '').replace(/\s+/g, ' ').trim().replace(/^(.*?)([.!?](\s|$)|$)/, '$1').slice(0, 120);
    const isQuestion = (c) => /❓|🎯/.test(c.text); // ❓ open question + 🎯 goal both read as "open"
    const hubs = live
        .map(c => ({ id: c.id, area: c.area, degree: deg.get(c.id) || 0, headline: headline(c) }))
        .filter(x => x.degree > 0)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, topHubs);
    const orphans = live
        .filter(c => !isQuestion(c) && !/🌿|⤵/.test(c.text) && !(deg.get(c.id) > 0))
        .map(c => ({ id: c.id, area: c.area, headline: headline(c), age: c.createdAt }));
    const staleQuestions = live
        .filter(c => isQuestion(c) && (c.createdAt || 0) < cutoff)
        .map(c => ({ id: c.id, area: c.area, headline: headline(c), age: c.createdAt }))
        .sort((a, b) => (a.age || 0) - (b.age || 0));
    const areas = struct.cards
        .filter(c => c.type === 'container' && !/^archive$/i.test(c.title || ''))
        .map(c => ({ title: c.title, count: cards.filter(t => t.parentId === c.id).length }))
        .sort((a, b) => b.count - a.count);
    return {
        hubs, orphans, staleQuestions, areas,
        totals: { live: live.length, archived: cards.length - live.length, connections: struct.connections.length },
    };
}

// Render brainInsights as a compact markdown report (used by the MCP tool).
export function insightsToMarkdown(ins, title = 'brain') {
    const out = [`# ${title} — insights`, `*${ins.totals.live} live cards · ${ins.totals.archived} archived · ${ins.totals.connections} connections*`];
    if (ins.hubs.length) { out.push('', '## 🪢 Hubs (most-connected — the load-bearing cards)'); for (const h of ins.hubs) out.push(`- (${h.degree}) [${h.area || '?'}] ${h.headline}`); }
    if (ins.orphans.length) { out.push('', `## 🔌 Orphaned decisions (${ins.orphans.length} — no connections; link them or archive)`); for (const o of ins.orphans.slice(0, 12)) out.push(`- [${o.area || '?'}] ${o.headline}`); if (ins.orphans.length > 12) out.push(`- …and ${ins.orphans.length - 12} more`); }
    if (ins.staleQuestions.length) { out.push('', `## ⏳ Stale open questions (${ins.staleQuestions.length} — unresolved & aging)`); for (const q of ins.staleQuestions.slice(0, 12)) out.push(`- [${q.area || '?'}] ${q.headline}`); }
    out.push('', '## 📍 Areas (by live cards)', ins.areas.map(a => `${a.title} (${a.count})`).join(' · ') || '(none)');
    if (!ins.hubs.length && !ins.orphans.length && !ins.staleQuestions.length) out.push('', '_Brain is small/tidy — no hubs, orphans, or stale questions to flag yet._');
    return out.join('\n') + '\n';
}

// Append raw connections (by id) to a brain — additive, never deletes, skips
// self-links / duplicates / dangling ids, verifies a round-trip parse. Used by
// the brain_connect tool to densify a sparse brain into a real graph.
export async function addBrainConnections(buffer, edges) {
    const { zip, canvas, manifest, isV4 } = await parseKlypix(buffer);
    if (!isV4 || !canvas.positions) throw new Error('connections need a v4 .klypix');
    canvas.connections = Array.isArray(canvas.connections) ? canvas.connections : [];
    const linked = (a, b) => canvas.connections.some(c => (c.fromId === a && c.toId === b) || (c.fromId === b && c.toId === a));
    const rand = () => Math.random().toString(36).slice(2, 10);
    let added = 0;
    for (const e of edges || []) {
        if (!e.fromId || !e.toId || e.fromId === e.toId) continue;
        if (!canvas.positions[e.fromId] || !canvas.positions[e.toId]) continue; // both must exist
        if (linked(e.fromId, e.toId)) continue;
        canvas.connections.push({
            id: `con_${rand()}`, fromId: e.fromId, toId: e.toId,
            relationship: REL.has(e.relationship) ? e.relationship : 'relates_to',
            label: typeof e.label === 'string' ? e.label : undefined,
            arrowHead: true, width: 2, color: typeof e.color === 'string' ? e.color : '#10b981', style: 'solid',
        });
        added++;
    }
    if (!added) return { buffer, added: 0 };
    const out = await finalizeBrainZip(zip, canvas, manifest, Date.now());
    return { buffer: out, added };
}

// Structural connection suggestions — pure, no embeddings (the fallback when
// the on-device model isn't installed, and the twin of the in-app Connect
// button). Signals, strongest first: an unlinked [[title]] mention (3), a
// shared topical tag ACROSS areas (2), a shared tag within an area (1). The
// area-name tag is dropped (redundant with containment), and — crucially —
// each card keeps at most `maxPerCard` links, so a tag shared by ten cards
// can't explode into a 45-edge clique. Mirrors the semantic pass's discipline.
export function proposeStructuralConnections(struct, { maxPerCard = 2 } = {}) {
    const live = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !/^archive$/i.test(c.area || ''));
    const linked = new Set(struct.connections.map(c => [c.fromId, c.toId].sort().join('|')));
    const titleIx = live.filter(c => (c.title || '').trim()).map(c => ({ id: c.id, t: c.title.trim().toLowerCase() }));
    // 'auto' is PROVENANCE, not topic — as a shared tag it would link every
    // harvested ship card to every other one (junk edges that then push their
    // degree past the garden's dormancy guard).
    const tagsOf = (c) => (c.tags || [])
        .map(t => String(t).toLowerCase().replace(/^#/, ''))
        .filter(t => t && t !== 'area' && t !== 'auto' && t !== String(c.area || '').toLowerCase());
    const cand = [];
    for (const c of live) {
        for (const link of (c.links || [])) {
            const want = String(link).trim().toLowerCase();
            const tgt = titleIx.find(e => e.id !== c.id && (e.t === want || e.t.startsWith(want)));
            if (tgt) cand.push({ a: c.id, b: tgt.id, score: 3, why: 'mention' });
        }
        const ct = tagsOf(c);
        if (!ct.length) continue;
        for (const d of live) {
            if (d.id <= c.id) continue;
            if (tagsOf(d).some(t => ct.includes(t))) cand.push({ a: c.id, b: d.id, score: c.area !== d.area ? 2 : 1, why: 'shared tag' });
        }
    }
    cand.sort((x, y) => y.score - x.score);
    const per = new Map();
    const edges = [];
    for (const e of cand) {
        if (e.a === e.b) continue;
        const key = [e.a, e.b].sort().join('|');
        if (linked.has(key)) continue;
        if ((per.get(e.a) || 0) >= maxPerCard || (per.get(e.b) || 0) >= maxPerCard) continue;
        linked.add(key);
        per.set(e.a, (per.get(e.a) || 0) + 1);
        per.set(e.b, (per.get(e.b) || 0) + 1);
        edges.push({ fromId: e.a, toId: e.b, why: e.why });
    }
    return edges;
}

// ── Atomic brain capture: supersede + append + resolve + auto-link ──────────
// One verified write per capture batch. Beyond appendIntoContainers it adds:
//   • SUPERSEDE — a new decision that heavily overlaps an existing live card in
//     the same area archives the old one (↩︎ prefix, gray, → Archive) and draws
//     an old→new "superseded by" arrow, instead of stacking a contradiction.
//   • RESOLVE — resolutions[] (the ✓ marker) finds the best-matching live card
//     in the area, stamps "✅ <date>: <note>" onto it and archives it; if no
//     match, the note lands as a 🏁 milestone so nothing is lost.
//   • AUTO-LINK — [[Title]] in a new card's text becomes a real connection to
//     the card/container whose title matches (the graph stops being decorative).
const tokenSet = (s) => new Set(String(s || '').toLowerCase().replace(/\[\[|\]\]/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4));
const overlapScore = (a, b) => {
    if (a.size < 4 || b.size < 4) return 0;            // too short to judge
    let hit = 0; for (const w of a) if (b.has(w)) hit++;
    return hit / Math.min(a.size, b.size);
};
// Fraction of the TARGET set present in `hay` — the right metric for "is this the
// card the user named in `closes:`?". Unlike overlapScore it has NO ≥4-token
// floor, because a close-target is a deliberate, often-short title/phrase (a
// subset of the card), not an accidental same-size similarity. (That floor was why
// a real `closes: v1.2.0 staged as a github draft` — only 3 long tokens — silently
// failed to fire.)
const coverageOf = (target, hay) => { if (!target.size) return 0; let h = 0; for (const w of target) if (hay.has(w)) h++; return h / target.size; };

// ── Truth decay (P1) — corrections must never lose to the cards they correct ─
// A correction-cue note explicitly declares an older fact stale ("CORRECTION:",
// "was WRONG", "OBSOLETE", "stale note resolved"). The same-area ≥0.6 supersede
// can miss it BY CONSTRUCTION (the correction often lands in a different area,
// reworded) — the stale card then stays live and recall serves it alone. Shared
// by: the capture-side widened supersede, the recall-side overlay below, and
// detectContradictions.
// DELIBERATE cue only: the uppercase forms are the documented convention, and
// case-sensitivity is what keeps casual prose ("the floor calc was wrong",
// "remove obsolete helper", "color-correction") from firing a cross-area
// supersede on an innocent card. "stale note resolved" is the one
// natural-language phrase, accepted in any case (it is never incidental).
export const CORRECTION_RE = /\bCORRECTIONS?\b|\bOBSOLETE\b|\bwas WRONG\b/;
const CORRECTION_PHRASE_RE = /\bstale note (?:is )?resolved\b/i;
export const hasCorrectionCue = (t) => CORRECTION_RE.test(String(t || '')) || CORRECTION_PHRASE_RE.test(String(t || ''));
export const CORRECTION_SUPERSEDE_AT = 0.4;   // widened cross-area bar (vs same-area SUPERSEDE_AT 0.6)
// Cue META words describe the act of correcting, not the subject — left in, they
// dilute the overlap denominator and push real correction pairs just under the
// bar (the field fixture lands at 0.375 with them, 0.5 without). Stripped before
// every correction-overlap comparison.
const CORRECTION_META = new Set(['correction', 'corrections', 'obsolete', 'stale', 'note', 'notes', 'resolved', 'wrong']);
const stripCueMeta = (set) => { const out = new Set(); for (const w of set) if (!CORRECTION_META.has(w)) out.add(w); return out; };
// Long-card reality: a correction's SUBJECT is a fraction of each card — the
// overlap COEFFICIENT alone punishes long↔long pairs (the real field pair
// measures 0.33 with 17 shared subject tokens, under every per-ratio bar). A
// cue-gated match therefore also fires on ABSOLUTE subject mass: ≥10 shared
// meaningful tokens at ≥0.25 coefficient. Cue-gated ONLY — plain supersede and
// polarity pairs keep their strict ratio bars (no cue prior to lean on).
const CUE_STRONG_SHARED = 10, CUE_RELAXED_COEF = 0.25;
// Floor 3 (not overlapScore's 4): after stripCueMeta a terse deliberate
// correction ("CORRECTION: the vault default was WRONG — use cwd") keeps only
// 3-ish subject tokens; at 4 it silently no-oped. ≤2-token corrections still
// no-op (too little signal to archive on) — they land as a new card; use ~ to
// edit a card in place instead.
const cueMatch = (a, b, bar) => {
    if (a.size < 3 || b.size < 3) return 0;
    let inter = 0; for (const w of a) if (b.has(w)) inter++;
    const coef = inter / Math.min(a.size, b.size);
    return (coef >= bar || (inter >= CUE_STRONG_SHARED && coef >= CUE_RELAXED_COEF)) ? coef : 0;
};

// Recall-side guard: given the cards recall is about to inject, return for each
// one the card that CORRECTS it, found two ways:
//   • edge — an outgoing "superseded by"/"closed by" arrow (drawn by capture or
//     a confirmed reconcile) whose successor still has text;
//   • cue  — a LIVE correction-cue card that lexically overlaps it ≥ `at`, ANY
//     area (the un-edged pair the capture-time supersede missed).
// The caller injects the corrector FIRST (labeled) and reduces the stale hit to
// a headline — the stale text never stands alone. Pure + cheap: correction-cue
// cards are rare and the hit list is ≤topK.
export function correctionOverlaysFor(struct, cards, { at = CORRECTION_SUPERSEDE_AT } = {}) {
    const out = new Map();
    if (!struct || !Array.isArray(struct.cards) || !Array.isArray(cards) || !cards.length) return out;
    const byId = new Map(struct.cards.map(c => [c.id, c]));
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const successorOf = new Map();
    for (const cn of struct.connections || []) {
        if (cn.label === 'superseded by' || cn.label === 'closed by') successorOf.set(cn.fromId, cn.toId);
    }
    const cues = struct.cards.filter(c => c.type !== 'container' && !isArchived(c) && (c.text || '').trim() && hasCorrectionCue(c.text));
    for (const card of cards) {
        if (!card || !card.id) continue;
        const succ = successorOf.has(card.id) ? byId.get(successorOf.get(card.id)) : null;
        if (succ && (succ.text || '').trim()) { out.set(card.id, { kind: 'edge', by: succ }); continue; }
        if (hasCorrectionCue(card.text)) continue;   // the hit IS a correction — nothing to overlay
        const cTok = tokenSet(card.text);
        let best = null, bestS = 0;
        for (const cue of cues) {
            if (cue.id === card.id) continue;
            const s = cueMatch(cTok, stripCueMeta(tokenSet(cue.text)), at);
            if (s > bestS) { bestS = s; best = cue; }
        }
        if (best && bestS > 0) out.set(card.id, { kind: 'cue', by: best, overlap: Math.round(bestS * 100) / 100 });
    }
    return out;
}

// ── Auto-skill classifier (skills emerge from the flow, not just the '+' marker) ─
// A REUSABLE skill (how-to / gotcha / convention) reads as a GENERAL RULE that
// applies next time — distinct from a one-time decision ("we shipped X"). This is
// the high-precision signal the capture path uses to AUTO-promote a plain decision
// or a rationale-bearing commit into a 🛠️ skill, so the brain learns "how we work
// here" without anyone remembering to type '+'. Deliberately conservative: STRONG
// rule cues only, and NOT pinned to a one-time event (a version/PR#/date/ship verb
// makes it "what happened", not "how to do it"). The explicit '+' marker always
// wins and covers everything this misses; a false miss is cheap, a false skill is
// noisy — so this errs toward silence.
const STRONG_SKILL_CUES = /(\balways\b|\bnever\b|\bmust\s+(?:not|always)\b|\bdon'?t\s+(?:ever|forget)\b|\bgotcha\b|\bwatch\s+out\b|\bthe\s+trick\s+is\b|\brule\s+of\s+thumb\b|\bby\s+convention\b|\bpitfall\b|\bfootgun\b|\bremember\s+to\b|\bbe\s+sure\s+to\b)/i;
const SKILL_EVENT_PINS = /(\bv?\d+\.\d+\.\d+\b|\bPR\s*#?\d+\b|#\d{2,}\b|\b20\d{2}-\d{2}-\d{2}\b|\bshipped\b|\breleased\b|\bpublished\b|\bmerged\b|\bdeployed\b)/i;
export function looksLikeSkill(text) {
    const t = String(text || '');
    if (/🛠|❓|🎯|🏁/.test(t)) return false;      // already glyphed (skill/question/goal/milestone) — don't reclassify
    return STRONG_SKILL_CUES.test(t) && !SKILL_EVENT_PINS.test(t);
}

export async function captureIntoBrain(buffer, { cards = [], resolutions = [], updates = [] } = {}) {
    const SUPERSEDE_AT = 0.6, RESOLVE_AT = 0.3, UPDATE_AT = 0.45, CLOSE_COVER_AT = 0.6, QUESTION_MERGE_AT = 0.6;
    let work = buffer;
    // corrections[] lists cross-area/low-bar supersedes driven by a correction
    // cue, so the surface (brain_note result / capture stderr) can say WHAT was
    // archived and how to undo — the confirmation channel for the widened match.
    const stats = { added: 0, superseded: 0, resolved: 0, linked: 0, updated: 0, closed: 0, merged: 0, corrections: [] };

    // Pass 1 — resolutions + supersede marking operate on EXISTING cards.
    if (resolutions.length || cards.length || updates.length) {
        const { zip, canvas, manifest, isV4, struct } = await parseKlypix(work);
        if (!isV4 || !canvas.positions) {
            // Legacy file — no surgery possible; degrade to plain append.
            return { buffer: await appendToKlypix(work, { cards }), stats };
        }
        const now = Date.now();
        const today = new Date(now).toISOString().slice(0, 10);
        const rand = () => Math.random().toString(36).slice(2, 10);
        const top = Object.values(canvas.positions).map(p => p && p.zKey).filter(k => k && isValidZKey(k)).sort().pop() || null;
        const nextZKey = makeZKeyGen(top);
        const byTitle = new Map();
        for (const c of struct.cards) if (c.type === 'container') { const t = (c.title || '').trim().toLowerCase(); if (t && !byTitle.has(t)) byTitle.set(t, c.id); }
        const ensureArchive = () => {
            let id = byTitle.get('archive');
            if (id) return id;
            id = `ctn_${rand()}`;
            const G = BRAIN_GEOM;
            zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify({ type: 'container', locked: false, createdAt: now, createdBy: 'agent', title: 'Archive', collapsed: false, scopeLocked: false, borderColor: 'rgba(120,120,135,0.6)' }));
            canvas.positions[id] = { x: nextContainerX(canvas), y: G.START, w: G.AREA_W, h: G.TITLE_BAR + G.PAD * 2, zKey: nextZKey(), zIndex: canvas.order.length, parentId: null };
            canvas.order.push(id);
            byTitle.set('archive', id);
            return id;
        };
        const liveTextCards = () => struct.cards.filter(c =>
            c.type !== 'container' && (c.text || '').trim()
            && !/^archive$/i.test(c.area || '')
            && !/↩|✅/.test(c.text));
        const rewriteCard = async (id, mutate) => {
            const ip = `items/${shard(id)}/${id}.json`;
            const f = zip.file(ip); if (!f) return false;
            const j = JSON.parse(await f.async('string'));
            mutate(j);
            j.content = wrapText(String(j.content || ''));
            zip.file(ip, JSON.stringify(j));
            const pos = canvas.positions[id];
            if (pos) canvas.positions[id] = { ...pos, h: measureCardH(j.content) };
            return true;
        };
        const archiveCard = async (id) => {
            const arc = ensureArchive();
            // The Archive is readable STORAGE, not a vector-scaled layout: un-bake
            // any group-shrink (font/width baked tiny) by restoring the frozen
            // authored baseline and dropping it, so the card sits in the Archive
            // at full readable size and re-seeds cleanly if the Archive is resized.
            let authoredW = null;
            const ip = `items/${shard(id)}/${id}.json`;
            const f = zip.file(ip);
            if (f) {
                const j = JSON.parse(await f.async('string'));
                const a = j.authoredInParent;
                if (a) {
                    if (j.type === 'text' && a.fontSize) j.fontSize = a.fontSize;
                    if (a.authoredWidth != null) j.authoredWidth = a.authoredWidth;
                    authoredW = a.w || null;
                    delete j.authoredInParent;
                    zip.file(ip, JSON.stringify(j));
                }
            }
            const pos = canvas.positions[id];
            if (pos) canvas.positions[id] = { ...pos, parentId: arc, ...(authoredW ? { w: authoredW } : {}) };
        };
        canvas.connections = Array.isArray(canvas.connections) ? canvas.connections : [];

        // RESOLVE (✓ markers) — best live match in the area, PLUS its near-tie
        // twins: a rephrased duplicate ❓ scores within a hair of its sibling, and
        // resolving only the first left the twin open forever (it kept surfacing
        // in every brief as still-to-do). Precision-kept: the set is the best
        // match ± 0.1, never everything above the loose 0.3 floor. ❓ preferred.
        const milestonesFallback = [];
        for (const r of resolutions) {
            const rTok = tokenSet(r.text);
            const cands = [];
            for (const c of liveTextCards()) {
                if (r.area && (c.area || '').toLowerCase() !== r.area.toLowerCase()) continue;
                if (/🛠/.test(c.text)) continue; // skills are standing reference — a ✓ must never archive one (mirror the supersede guard)
                const s = overlapScore(rTok, tokenSet(c.text)) + (/❓|🎯/.test(c.text) ? 0.15 : 0);
                if (s > 0) cands.push({ c, s });
            }
            cands.sort((a, b) => b.s - a.s);
            const bestScore = cands.length ? cands[0].s : 0;
            const set = bestScore >= RESOLVE_AT
                ? cands.filter(x => x.s >= Math.max(RESOLVE_AT, bestScore - 0.1)).slice(0, 3)
                : [];
            if (set.length) {
                for (const { c: best } of set) {
                    await rewriteCard(best.id, j => {
                        j.content = `${j.content}\n✅ ${today}: ${r.text}`;
                        j.borderColor = 'rgba(16,185,129,0.35)';
                    });
                    await archiveCard(best.id);
                    best.text += ` ✅ ${r.text}`; // keep in-memory struct honest for later matching
                    stats.resolved++;
                }
            } else {
                milestonesFallback.push({ text: (r.area ? `${r.area}: ` : '') + `🏁 ${r.text}`, area: r.area, borderColor: 'rgba(59,130,246,0.8)' });
            }
        }

        // UPDATE (~ markers) — rewrite a matching card IN PLACE: for small
        // corrections that don't deserve supersession history. Content is
        // replaced (area prefix + tag preserved), createdAt bumped so the
        // brief treats it as fresh. No match → falls through as a new card.
        for (const u of updates) {
            const uTok = tokenSet(u.text);
            let best = null, bestScore = 0;
            for (const c of liveTextCards()) {
                if (u.area && (c.area || '').toLowerCase() !== u.area.toLowerCase()) continue;
                const s = overlapScore(uTok, tokenSet(c.text));
                if (s > bestScore) { bestScore = s; best = c; }
            }
            if (best && bestScore >= UPDATE_AT) {
                const tag = u.area ? `\n#${u.area.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
                await rewriteCard(best.id, j => {
                    j.content = (u.area ? `${u.area}: ` : '') + u.text + tag;
                    j.createdAt = now;
                    j.borderColor = 'rgba(16,185,129,0.6)';
                    if (u.createdVia) j.createdVia = String(u.createdVia);
                    // Self-heal: a ~ update re-stamps the evidence (fresh OID +
                    // verifiedAt), so confirming/correcting a drifted fact marks it ✅.
                    if (Array.isArray(u.evidence) && u.evidence.length) j.evidence = u.evidence;
                });
                best.text = u.text;
                stats.updated++;
            } else {
                cards.push({ text: (u.area ? `${u.area}: ` : '') + u.text + (u.area ? `\n#${u.area.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''), area: u.area, createdVia: u.createdVia, ...(Array.isArray(u.evidence) && u.evidence.length ? { evidence: u.evidence } : {}) });
            }
        }

        // MERGE-ON-CAPTURE for duplicate open questions — a rephrased ❓ that
        // heavily overlaps an EXISTING live ❓ updates that card in place (fresh
        // wording + createdAt) instead of stacking a twin the close-pass would
        // later miss. (Supersede deliberately skips ? cards, so without this
        // twins could never merge at capture at all.)
        for (let i = cards.length - 1; i >= 0; i--) {
            const card = cards[i];
            if (!/❓/.test(card.text) || /🏁|🛠/.test(card.text)) continue;
            const nTok = tokenSet(card.text);
            let best = null, bestScore = 0;
            for (const c of liveTextCards()) {
                if (!/❓/.test(c.text)) continue;
                const s = overlapScore(nTok, tokenSet(c.text));
                if (s > bestScore) { bestScore = s; best = c; }
            }
            if (best && bestScore >= QUESTION_MERGE_AT) {
                await rewriteCard(best.id, j => {
                    j.content = String(card.text);
                    j.createdAt = now;
                    if (card.createdVia) j.createdVia = String(card.createdVia);
                    if (Array.isArray(card.evidence) && card.evidence.length) j.evidence = card.evidence;
                });
                best.text = String(card.text);
                cards.splice(i, 1);
                stats.merged++;
            }
        }

        // SUPERSEDE — pre-mark old cards that a NEW decision replaces. The arrow
        // to the new card is drawn in pass 2 (after the new ids exist), matched
        // back by remembering which old card each new card displaced.
        for (const card of cards) {
            if (/❓|🎯|🏁|🛠/.test(card.text)) continue; // only plain decisions supersede (not questions/goals/milestones/skills)
            const nTok = tokenSet(card.text);
            const area = (card.area || '').toLowerCase();
            // A correction-cue note ("CORRECTION: … was WRONG") declares it
            // replaces something — widen the search to ALL areas and lower the
            // bar: a cross-area reworded correction could never fire the
            // same-area 0.6 path by construction, which is exactly how stale
            // cards outlived their corrections in the field.
            const isCorrection = hasCorrectionCue(card.text);
            const nTokCmp = isCorrection ? stripCueMeta(nTok) : nTok;   // cue meta words dilute the denominator
            let best = null, bestScore = 0;
            for (const c of liveTextCards()) {
                if (!isCorrection && area && (c.area || '').toLowerCase() !== area) continue;
                if (/🛠/.test(c.text)) continue; // never auto-archive a 🛠️ skill via a decision's supersede — skills are standing reference (correct with ~)
                // cueMatch returns 0 unless it clears the widened bar (ratio OR
                // absolute subject mass) — so for corrections, any non-zero fires.
                const s = isCorrection ? cueMatch(nTokCmp, tokenSet(c.text), CORRECTION_SUPERSEDE_AT) : overlapScore(nTok, tokenSet(c.text));
                if (s > bestScore) { bestScore = s; best = c; }
            }
            if (best && (isCorrection ? bestScore > 0 : bestScore >= SUPERSEDE_AT)) {
                await rewriteCard(best.id, j => {
                    j.content = `↩︎ superseded ${today}\n${j.content}`;
                    j.borderColor = 'rgba(120,120,135,0.5)';
                });
                await archiveCard(best.id);
                const wasCross = isCorrection && (bestScore < SUPERSEDE_AT || (area && (best.area || '').toLowerCase() !== area));
                best.text = `↩︎ ${best.text}`;
                card.__supersedes = best.id;
                stats.superseded++;
                // Surface the widened match for confirmation: the caller tells the
                // agent what was archived and how to undo (restore from Archive /
                // re-run with ~) — the widened bar acts WITH a visible receipt.
                if (wasCross) stats.corrections.push({ old: (best.title || String(best.text).replace(/^↩︎\s*/, '').slice(0, 80)), area: best.area || null, overlap: Math.round(bestScore * 100) / 100 });
            }
        }

        // CLOSE-LINK — a card carrying `closes` resolves the (often cross-area)
        // strategy/question card that SPAWNED it: stamp ✅, archive it, and draw a
        // "closed by" arrow in pass 2. Unlike supersede (same-area, high lexical
        // overlap), a shipped milestone rarely echoes the strategy's prose — so
        // this matches across ALL areas, prefers an explicit [[wikilink]]/title
        // hit, and otherwise fires on only a low overlap. This is the fix for
        // "strategy cards never get closed out when their feature actually ships".
        for (const card of cards) {
            const target = (card.closes || '').toString().trim();
            if (!target) continue;
            const wantTitle = target.replace(/^\[\[/, '').replace(/\]\]$/, '').trim().toLowerCase();
            const tTok = tokenSet(target);
            // Collect EVERY live card the close-target covers — near-duplicate ❓
            // twins score together, and the old first-match-and-break resolved one
            // while its twin stayed "open" in every brief forever. Capped for
            // safety: a close-target is deliberate, so >4 matches means it was too
            // generic to trust beyond the strongest few.
            const matches = [];
            for (const c of liveTextCards()) {
                if (/🛠/.test(c.text)) continue; // skills are standing reference — a closes: must never archive one (mirror the supersede guard)
                const ct = (c.title || '').trim().toLowerCase();
                // Title fast-path: exact / prefix (≥6 chars), or the card title
                // CONTAINS the target — the contains variant needs a LONGER target
                // (≥10) because a short generic word ("sandbox") appears in many
                // unrelated titles and the multi-close below would sweep them all.
                if (ct && wantTitle.length >= 6 && (ct === wantTitle || ct.startsWith(wantTitle) || wantTitle.startsWith(ct))) { matches.push({ c, cov: 1 }); continue; }
                if (ct && wantTitle.length >= 10 && ct.includes(wantTitle)) { matches.push({ c, cov: 1 }); continue; }
                // Else target-coverage (≥2 tokens, no floor): a short deliberate
                // close-target whose tokens are present in a card is a precise hit.
                if (tTok.size >= 2) { const cov = coverageOf(tTok, tokenSet(c.text)); if (cov >= CLOSE_COVER_AT) matches.push({ c, cov }); }
            }
            matches.sort((a, b) => b.cov - a.cov);
            // >4 matches means the target was too GENERIC to trust a sweep —
            // fall back to the single best match (the pre-1.17 behavior) rather
            // than archive four semi-related cards in iteration order.
            const chosen = matches.length > 4 ? matches.slice(0, 1) : matches;
            if (!chosen.length) continue;
            const ship = String(card.text).replace(/\s+/g, ' ').replace(/^[^:\n]{1,40}:\s*/, '').replace(/^🏁\s*/, '').trim().slice(0, 80);
            card.__closesIds = [];
            for (const { c: best } of chosen) {
                await rewriteCard(best.id, j => {
                    j.content = `${j.content}\n✅ ${today}: closed by → ${ship}`;
                    j.borderColor = 'rgba(16,185,129,0.35)';
                });
                await archiveCard(best.id);
                best.text = `✅ ${best.text}`;
                card.__closesIds.push(best.id);
                stats.closed++;
            }
        }

        cards.push(...milestonesFallback);
        work = await finalizeBrainZip(zip, canvas, manifest, now);
    }

    // Pass 2 — append the new cards (existing self-organizing path), then wire
    // connections: supersede arrows + [[wikilink]] auto-links.
    if (cards.length) {
        work = await appendIntoContainers(work, { cards });
        stats.added = cards.length;
        const { zip, canvas, manifest, struct } = await parseKlypix(work);
        const now = Date.now();
        const rand = () => Math.random().toString(36).slice(2, 10);
        canvas.connections = Array.isArray(canvas.connections) ? canvas.connections : [];
        const hasConn = (a, b) => canvas.connections.some(cn => (cn.fromId === a && cn.toId === b) || (cn.fromId === b && cn.toId === a));
        const addConn = (fromId, toId, label, relationship) => {
            if (!fromId || !toId || fromId === toId || hasConn(fromId, toId)) return;
            canvas.connections.push({ id: `con_${rand()}`, fromId, toId, relationship, label, arrowHead: true, width: 2, color: '#10b981', style: 'solid' });
            stats.linked++;
        };
        // Locate each appended card by exact text match (newest first wins).
        const findNew = (text) => {
            const flatT = wrapText(String(text));
            for (let i = struct.cards.length - 1; i >= 0; i--) {
                const c = struct.cards[i];
                if (c.type !== 'container' && (c.text || '') === flatT) return c;
            }
            return null;
        };
        const titleIndex = struct.cards
            .filter(c => (c.title || '').trim())
            .map(c => ({ id: c.id, t: c.title.trim().toLowerCase() }));
        const newIds = new Set();
        for (const card of cards) {
            const created = findNew(card.text);
            if (!created) continue;
            newIds.add(created.id);
            if (card.__supersedes) addConn(card.__supersedes, created.id, 'superseded by', undefined);
            for (const cid of (card.__closesIds || [])) addConn(cid, created.id, 'closed by', undefined);
            for (const link of (created.links || [])) {
                const want = String(link).trim().toLowerCase();
                if (!want) continue;
                const target = titleIndex.find(e => e.id !== created.id && (e.t === want || e.t.startsWith(want)));
                if (target) addConn(created.id, target.id, undefined, 'relates_to');
            }
        }
        // Structural auto-link for the NEW cards — the graph used to form only
        // when someone explicitly ran brain_connect (never, in practice: 66%
        // orphans in the field). Run the cheap tag/[[title]] proposer over the
        // post-append struct and keep only edges touching a just-added card
        // (≤2 per card via the proposer's own cap), labeled 'auto' so they're
        // distinguishable from deliberate arrows. Best-effort: an auto-link
        // failure must never fail a capture.
        if (newIds.size) {
            try {
                for (const e of proposeStructuralConnections(struct, { maxPerCard: 2 })) {
                    if (!newIds.has(e.fromId) && !newIds.has(e.toId)) continue;
                    addConn(e.fromId, e.toId, 'auto', 'relates_to');
                }
            } catch { /* auto-linking is opportunistic */ }
        }
        work = await finalizeBrainZip(zip, canvas, manifest, now);
    }

    return { buffer: work, stats };
}

// ── Brain gardener — sleep-time consolidation with a visible audit trail ─────
// The portable engine twin of the in-app /garden (so ANY agent can run it over
// MCP, not just the KLYPIX canvas). Two phases, like brain_connect: the engine
// SELECTS deterministically (the model never decides WHAT merges, only writes the
// prose), the agent writes one synthesis per area, then the engine APPLIES — each
// area gets a 🌿 synthesis card; the originals are stamped "⤵ consolidated", moved
// to Archive, and arrowed → the synthesis. Nothing is deleted (archived verbatim).
const GARDEN_KEEP_NEWEST = 8;       // per area, never consolidate the newest N
const GARDEN_MIN_AGE_DAYS = 14;     // only cards older than this are candidates
const GARDEN_AUTO_MIN_AGE_DAYS = 7; // #auto ship-event cards age out sooner — the durable fact usually also exists as a hand-written milestone
const GARDEN_MIN_CANDIDATES = 3;    // don't bother merging fewer than this
const GARDEN_MAX_DEGREE = 1;        // SMART guard: protect load-bearing cards —
//   only consolidate cards with ≤ this many connections (orphans + leaves). A
//   card the graph leans on (degree ≥ 2) is signal, not noise, and is left alone.
// Areas the gardener must never touch: human steering + config + its own output.
const GARDEN_PROTECTED = /^(archive|📌?\s*focus|(🤖\s*)?(agent\s+)?instructions|open questions|pending)/i;
// Faithfulness guard: a synthesis shorter than this (after whitespace-collapse)
// is treated as degenerate (model returned a stub) and its area is skipped.
const MIN_SYNTHESIS_CHARS = 60;
// Distinct "figures" worth never losing — tokens carrying ≥2 digits (versions
// 1.3.7, dates 2026-06-24, sizes 50mb, counts 326, migration ids). Trivial single
// digits (1, 3) are ignored. Used to append any prose-dropped figure verbatim.
const figuresIn = (text) => {
    const out = new Set();
    for (const m of String(text || '').matchAll(/[0-9][0-9a-zA-Z._:-]*/g)) {
        const tok = m[0].replace(/[._:-]+$/, '').toLowerCase();
        if ((tok.match(/\d/g) || []).length >= 2) out.add(tok);
    }
    return out;
};

// Deterministic candidate selection — PURE, so the model never chooses WHAT to
// merge. SMART + non-invasive: a card is a candidate only if it's DORMANT —
// old (> minAgeDays), beyond the area's newest N, AND peripheral (connection
// degree ≤ maxDegree). That protects hubs and still-referenced cards (the spine
// of the brain), so consolidation hits forgotten noise — the same cards
// brain_insights flags as orphaned — never load-bearing decisions. Returns each
// over-grown area with its dormant cards (oldest first), each tagged with degree.
export function selectGardenCandidates(struct, { keepNewest = GARDEN_KEEP_NEWEST, minAgeDays = GARDEN_MIN_AGE_DAYS, minCandidates = GARDEN_MIN_CANDIDATES, maxDegree = GARDEN_MAX_DEGREE, now = Date.now() } = {}) {
    if (!struct || !Array.isArray(struct.cards)) return [];
    const cutoff = now - minAgeDays * 86_400_000;
    // Connection degree per card — both ends of every edge. A card that is linked
    // to (or links out to) the rest of the graph is structurally load-bearing.
    const degree = new Map();
    for (const cn of (struct.connections || [])) {
        if (cn.fromId) degree.set(cn.fromId, (degree.get(cn.fromId) || 0) + 1);
        if (cn.toId) degree.set(cn.toId, (degree.get(cn.toId) || 0) + 1);
    }
    const out = [];
    for (const ctn of struct.cards) {
        if (ctn.type !== 'container') continue;
        const title = (ctn.title || '').trim();
        if (!title || GARDEN_PROTECTED.test(title)) continue;
        const children = struct.cards
            .filter(c => c.type === 'text' && c.parentId === ctn.id && (c.text || '').trim() && !/⤵|↩|✅|🛠/.test(c.text))  // 🛠️ skills are standing reference — never consolidate them away
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const autoCutoff = now - GARDEN_AUTO_MIN_AGE_DAYS * 86_400_000;
        const isAuto = (c) => (c.tags || []).some(t => String(t).toLowerCase().replace(/^#/, '') === 'auto');
        const old = children
            .slice(0, Math.max(0, children.length - keepNewest))
            .filter(c => (c.createdAt || 0) < (isAuto(c) ? autoCutoff : cutoff) && (degree.get(c.id) || 0) <= maxDegree);  // dormant: old AND peripheral (#auto ages faster)
        if (old.length >= minCandidates) out.push({ containerId: ctn.id, title, candidates: old.map(c => ({ id: c.id, text: c.text, createdAt: c.createdAt || 0, degree: degree.get(c.id) || 0 })) });
    }
    return out;
}

// Apply: re-selects deterministically (robust to drift since the dry-run) and,
// for each area the agent supplied a synthesis for, adds the 🌿 card + archives
// the originals with audit arrows. `syntheses`: [{ title, synthesis }].
export async function applyGarden(buffer, { syntheses = [] } = {}) {
    const stats = { areas: 0, archived: 0, synthCards: 0, skipped: [] };
    const { zip, canvas, manifest, isV4, struct } = await parseKlypix(buffer);
    if (!isV4 || !canvas.positions) throw new Error('garden needs a v4 .klypix');
    const areas = selectGardenCandidates(struct);
    const synthByTitle = new Map();
    for (const s of syntheses || []) { const t = String(s?.title || '').trim().toLowerCase(); const txt = String(s?.synthesis || '').trim(); if (t && txt) synthByTitle.set(t, txt); }
    if (!areas.length || !synthByTitle.size) return { buffer, stats };

    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const rand = () => Math.random().toString(36).slice(2, 10);
    const top = Object.values(canvas.positions).map(p => p && p.zKey).filter(k => k && isValidZKey(k)).sort().pop() || null;
    const nextZKey = makeZKeyGen(top);
    canvas.connections = Array.isArray(canvas.connections) ? canvas.connections : [];
    const byTitle = new Map();
    for (const c of struct.cards) if (c.type === 'container') { const t = (c.title || '').trim().toLowerCase(); if (t && !byTitle.has(t)) byTitle.set(t, c.id); }
    // Archive primitives (mirror captureIntoBrain): find-or-create Archive, move a
    // card into it un-baking any group-shrink, and rewrite a card's text in place.
    const ensureArchive = () => {
        let id = byTitle.get('archive');
        if (id) return id;
        id = `ctn_${rand()}`;
        const G = BRAIN_GEOM;
        zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify({ type: 'container', locked: false, createdAt: now, createdBy: 'agent', title: 'Archive', collapsed: false, scopeLocked: false, borderColor: 'rgba(120,120,135,0.6)' }));
        canvas.positions[id] = { x: nextContainerX(canvas), y: G.START, w: G.AREA_W, h: G.TITLE_BAR + G.PAD * 2, zKey: nextZKey(), zIndex: canvas.order.length, parentId: null };
        canvas.order.push(id);
        byTitle.set('archive', id);
        return id;
    };
    const rewriteCard = async (id, mutate) => {
        const ip = `items/${shard(id)}/${id}.json`;
        const f = zip.file(ip); if (!f) return false;
        const j = JSON.parse(await f.async('string'));
        mutate(j);
        j.content = wrapText(String(j.content || ''));
        zip.file(ip, JSON.stringify(j));
        const pos = canvas.positions[id];
        if (pos) canvas.positions[id] = { ...pos, h: measureCardH(j.content) };
        return true;
    };
    const archiveCard = async (id) => {
        const arc = ensureArchive();
        let authoredW = null;
        const ip = `items/${shard(id)}/${id}.json`;
        const f = zip.file(ip);
        if (f) {
            const j = JSON.parse(await f.async('string'));
            const a = j.authoredInParent;
            if (a) {
                if (j.type === 'text' && a.fontSize) j.fontSize = a.fontSize;
                if (a.authoredWidth != null) j.authoredWidth = a.authoredWidth;
                authoredW = a.w || null;
                delete j.authoredInParent;
                zip.file(ip, JSON.stringify(j));
            }
        }
        const pos = canvas.positions[id];
        if (pos) canvas.positions[id] = { ...pos, parentId: arc, ...(authoredW ? { w: authoredW } : {}) };
    };

    for (const area of areas) {
        const synthesis = synthByTitle.get(area.title.trim().toLowerCase());
        if (!synthesis) continue;                          // model skipped this area — leave it untouched
        const ctnPos = canvas.positions[area.containerId];
        if (!ctnPos) continue;
        // FAITHFULNESS GUARD (1) — degeneracy: a synthesis far too thin for the
        // cards it replaces is rejected; that area is left untouched + reported,
        // so a one-word "done" can't bury real history. (Originals stay put.)
        const collapsed = synthesis.replace(/\s+/g, ' ').trim();
        if (collapsed.length < MIN_SYNTHESIS_CHARS) {
            stats.skipped.push({ title: area.title, reason: `synthesis too thin (${collapsed.length} chars, need ${MIN_SYNTHESIS_CHARS}) — revise and re-apply` });
            continue;
        }
        // FAITHFULNESS GUARD (2) — figures net: any distinct number (version /
        // size / date / count) in the originals that the prose dropped is appended
        // verbatim, so the crispest facts survive on the visible card even if the
        // synthesis missed them. The originals are archived verbatim regardless.
        const origFigs = new Set();
        for (const c of area.candidates) for (const f of figuresIn(c.text)) origFigs.add(f);
        const synLower = synthesis.toLowerCase();
        const missing = [...origFigs].filter(f => !synLower.includes(f));
        const finalSynth = missing.length ? `${synthesis}\n↳ figures: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}` : synthesis;
        const span = `${new Date(area.candidates[0].createdAt || now).toISOString().slice(0, 10)} → ${new Date(area.candidates[area.candidates.length - 1].createdAt || now).toISOString().slice(0, 10)}`;
        const content = wrapText(`${area.title}: 🌿 Consolidated history (${span}, ${area.candidates.length} cards)\n${finalSynth}`);
        const sid = `txt_${rand()}`;
        zip.file(`items/${shard(sid)}/${sid}.json`, JSON.stringify({ type: 'text', locked: false, createdAt: now, createdBy: 'agent', createdVia: 'gardener', content, fontSize: 12, color: '#e8e8ed', border: true, borderColor: 'rgba(59,130,246,0.6)', heading: false }));
        canvas.positions[sid] = { x: ctnPos.x + 20, y: ctnPos.y + (ctnPos.h || 0) + 10, w: 300, h: measureCardH(content), zKey: nextZKey(), zIndex: canvas.order.length, parentId: area.containerId };
        canvas.order.push(sid);
        stats.synthCards++;
        for (const cand of area.candidates) {
            await rewriteCard(cand.id, j => { j.content = `⤵ consolidated ${today}\n${j.content}`; j.borderColor = 'rgba(120,120,135,0.5)'; });
            await archiveCard(cand.id);
            canvas.connections.push({ id: `con_${rand()}`, fromId: cand.id, toId: sid, relationship: 'relates_to', label: 'consolidated into', arrowHead: true, width: 1.5, color: 'rgba(120,120,135,0.7)', style: 'solid' });
            stats.archived++;
        }
        stats.areas++;
    }
    if (!stats.synthCards) return { buffer, stats };
    const out = await finalizeBrainZip(zip, canvas, manifest, now);
    return { buffer: out, stats };
}

// ── Stale-open reconcile ("marked open, but a milestone says it's done") ─────
// The READ-side twin of the closes: write path. An open ❓/🎯 card lingers as
// "still to do" forever unless someone emits a ✓/closes: for it — so a goal that
// quietly SHIPPED keeps surfacing in recall as a "next move". This pure pass
// finds open cards a LATER live 🏁 milestone appears to fulfil (its text COVERS
// the open card's distinctive tokens) and returns them so the surface can PROMPT
// the human to close them — never auto-archives (precision-first, suggestion-only,
// like the migration tripwire). Requires the milestone to post-date the goal so a
// pre-existing milestone can't "fulfil" a newer goal. No I/O, node-runnable.
export function findStaleOpenCards(struct, { coverAt = 0.6, max = 5 } = {}) {
    const empty = { gaps: [], total: 0 };
    if (!struct || !Array.isArray(struct.cards)) return empty;
    const isArchived = (c) => /^archive$/i.test(c.area || '');
    const isOpen = (c) => /❓|🎯/.test(c.text);
    const live = struct.cards.filter(c => c.type !== 'container' && (c.text || '').trim() && !isArchived(c) && !/↩|✅/.test(c.text));
    const opens = live.filter(isOpen);
    const miles = live.filter(c => /🏁/.test(c.text) && !isOpen(c));
    if (!opens.length || !miles.length) return empty;
    const out = [];
    for (const o of opens) {
        const oTok = tokenSet(o.text);
        if (oTok.size < 3) continue;                       // too vague to match safely → leave it
        let best = null, bestCov = 0;
        for (const m of miles) {
            if ((m.createdAt || 0) <= (o.createdAt || 0)) continue; // only a milestone shipped AFTER the goal
            const cov = coverageOf(oTok, tokenSet(m.text));          // how much of the goal the milestone covers
            if (cov > bestCov) { bestCov = cov; best = m; }
        }
        if (best && bestCov >= coverAt) out.push({ open: o, by: best, cov: Math.round(bestCov * 100) / 100 });
    }
    out.sort((a, b) => b.cov - a.cov);
    return { gaps: out.slice(0, max), total: out.length };
}

// ── Deliberate note → capture input ──────────────────────────────────────────
// Turn ONE structured note into captureIntoBrain's input shape — the deliberate
// twin of the Stop hook's transcript marker parser. This is what lets an ON-DEMAND
// write (the brain_note MCP tool, the brain-note CLI — any agent, not just the
// Claude-Code hook) get IDENTICAL supersede / resolve / close / dedup semantics as
// a harvested 🧠 marker. marker ∈ '' (decision) | '?' (open question) | '!'
// (milestone) | '✓' (resolve+archive a match) | '~' (update a match in place) |
// '+' (skill — a REUSABLE how-to/gotcha/procedure, standing reference that always
// surfaces and never ages out, distinct from a point-in-time decision).
export function noteToCaptureInput({ text = '', area = '', marker = '', closes = '', evidence = null, createdVia = 'mcp' } = {}) {
    const body = String(text).trim();
    if (!body) return { cards: [], resolutions: [], updates: [] };
    const a = String(area || '').trim();
    if (marker === '✓') return { cards: [], resolutions: [{ area: a, text: body }], updates: [] };
    if (marker === '~') return { cards: [], resolutions: [], updates: [{ area: a, text: body, createdVia, ...(evidence ? { evidence } : {}) }] };
    const prefix = marker === '?' ? '❓ ' : marker === '!' ? '🏁 ' : marker === '+' ? '🛠️ ' : '';
    const borderColor = marker === '?' ? 'rgba(245,166,35,0.8)' : marker === '!' ? 'rgba(59,130,246,0.8)' : marker === '+' ? 'rgba(139,92,246,0.85)' : 'rgba(16,185,129,0.6)';
    const tag = a ? `\n#${a.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
    const cardText = (a ? `${a}: ${prefix}${body}` : `${prefix}${body}`) + tag;
    return { cards: [{ text: cardText, area: a, color: '#e8e8ed', borderColor, createdVia, ...(closes ? { closes } : {}), ...(evidence ? { evidence } : {}) }], resolutions: [], updates: [] };
}

/**
 * Build a RICH "map" .klypix: areas become titled containers, their cards
 * stack inside, connections draw across. Produces a real spatial board (used by
 * the project brain) rather than a flat grid. Spec:
 *   { title, areas: [{ title, color?, cards: [{text, heading?, color?}] }],
 *     connections: [{ from, to, relationship?, label? }] }   // from/to by card title
 */
export async function buildKlypixMap(spec) {
    if (!spec || !Array.isArray(spec.areas) || spec.areas.length === 0) {
        throw new Error('map spec needs a non-empty "areas" array');
    }
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const rand = () => Math.random().toString(36).slice(2, 10);

    const TITLE_BAR = 44, PAD = 16, CARD_GAP = 12, CARD_W = 280, FONT = 15, LINE_H = FONT * 1.4;
    const AREA_W = CARD_W + PAD * 2;
    const COL_GAP = 48, ROW_GAP = 48, START = 80;
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(spec.areas.length))));

    const positions = {};
    const order = [];
    const items = {}; // id -> json
    const titleToId = new Map(); // card title -> id (for connections)
    const firstLine = (t) => String(t ?? '').split('\n').map(s => s.trim()).find(Boolean) || '';
    let z = 0;
    const nextZKey = makeZKeyGen();

    // Shelf-pack areas into rows of `cols`; each row's height = tallest area.
    let rowTopY = START, rowMaxH = 0, colX = START, colIdx = 0;
    spec.areas.forEach((area, ai) => {
        const cards = (area.cards || []).filter(c => c && typeof c.text === 'string' && c.text.trim());
        // measure card heights
        const measured = cards.map(c => {
            const lines = String(c.text).split('\n').length;
            return Math.max(40, Math.round(lines * LINE_H) + 18);
        });
        const innerH = measured.reduce((s, h) => s + h + CARD_GAP, 0);
        const areaH = TITLE_BAR + PAD + innerH + PAD;

        if (colIdx >= cols) { // new row
            rowTopY += rowMaxH + ROW_GAP;
            rowMaxH = 0; colIdx = 0; colX = START;
        }
        const ax = colX, ay = rowTopY;

        const ctnId = `ctn_${rand()}_${ai}`;
        items[ctnId] = {
            type: 'container', locked: false, createdAt: now, createdBy: 'agent',
            title: area.title || `Area ${ai + 1}`, collapsed: false, scopeLocked: false,
            borderColor: area.color || '#10b981',
        };
        positions[ctnId] = { x: ax, y: ay, w: AREA_W, h: areaH, zKey: nextZKey(), zIndex: z, parentId: null };
        order.push(ctnId); z++;

        let cy = ay + TITLE_BAR + PAD;
        cards.forEach((c, ci) => {
            const id = `txt_${rand()}_${ai}_${ci}`;
            const h = measured[ci];
            items[id] = {
                type: 'text', locked: false, createdAt: now, createdBy: 'agent',
                content: String(c.text), fontSize: FONT,
                color: c.color || '#e8e8ed', border: true,
                borderColor: c.color || 'rgba(16,185,129,0.35)',
                fillColor: 'rgba(18,18,26,0.85)',
                heading: !!c.heading,
                fontWeight: c.heading ? 'bold' : 'normal', fontStyle: 'normal',
                textDecoration: 'none', textAlign: 'left', verticalAlign: 'top',
                fontFamily: 'Thmanyah Sans',
            };
            positions[id] = { x: ax + PAD, y: cy, w: CARD_W, h, zKey: nextZKey(), zIndex: z, parentId: ctnId };
            order.push(id); z++;
            const t = firstLine(c.text).toLowerCase();
            if (t && !titleToId.has(t)) titleToId.set(t, id);
            cy += h + CARD_GAP;
        });

        rowMaxH = Math.max(rowMaxH, areaH);
        colX += AREA_W + COL_GAP;
        colIdx++;
    });

    // Connections (by card title, across all areas).
    const REL = new Set(['leads_to', 'depends_on', 'relates_to', 'conflicts_with', 'supports', 'questions', 'costs', 'blocks']);
    const resolve = (ref) => {
        if (typeof ref === 'string') return titleToId.get(ref.trim().toLowerCase()) || null;
        return null;
    };
    const connections = (Array.isArray(spec.connections) ? spec.connections : []).map((c, i) => {
        const fromId = resolve(c.from), toId = resolve(c.to);
        if (!fromId || !toId || fromId === toId) return null;
        return {
            id: `con_${rand()}_${i}`, fromId, toId,
            relationship: REL.has(c.relationship) ? c.relationship : undefined,
            label: typeof c.label === 'string' ? c.label : undefined,
            arrowHead: true, width: 2, color: '#10b981', style: 'solid',
        };
    }).filter(Boolean);

    const zip = new JSZip();
    const manifest = {
        format: 'klypix', version: 4, schemaVersion: 4, createdAt: nowIso, updatedAt: nowIso,
        title: spec.title || 'Brain', stats: { itemCount: order.length, assetCount: 0, totalBytes: 0 },
        sync: { enabled: false, lastSyncRev: null, lastSyncAt: null, deviceId: `dev_${rand()}${rand()}` },
    };
    const xs = Object.values(positions);
    const minX = Math.min(...xs.map(p => p.x)), minY = Math.min(...xs.map(p => p.y));
    const canvasJson = {
        version: 4, view: { panX: 120 - minX * 0.55, panY: 120 - minY * 0.55, zoom: 0.55 },
        order, connections, lines: [], strokes: [], nextGroupNumber: spec.areas.length + 1,
        positions, settings: { background: '#0a0a0f' },
    };
    zip.file('manifest.json', JSON.stringify(manifest));
    zip.file('canvas.json', JSON.stringify(canvasJson));
    for (const id of order) zip.file(`items/${shard(id)}/${id}.json`, JSON.stringify(items[id]));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Render a parsed struct to the markdown brief (shared by read-klypix + MCP). */
export function structToMarkdown(struct, { assetsDir } = {}) {
    const L = [];
    L.push(`# ${struct.title}`);
    L.push(`*${struct.format} · ${struct.counts.cards} cards · ${struct.counts.connections} connections · ${struct.counts.assets} assets*\n`);
    L.push(`## Cards`);
    for (const c of struct.cards) {
        L.push(`### ${c.title || `(${c.type})`}  \`${c.type}\``);
        if (c.text) L.push(c.type === 'text' ? String(c.text).trim() : `→ ${c.text}`);
        const meta = [];
        if (c.links?.length) meta.push(`links: ${c.links.map(t => `[[${t}]]`).join(', ')}`);
        if (c.tags?.length) meta.push(`tags: ${c.tags.map(t => `#${t}`).join(' ')}`);
        if (meta.length) L.push(`\n_${meta.join(' · ')}_`);
        L.push('');
    }
    if (struct.connections.length) {
        L.push(`## Connection graph`);
        for (const e of struct.connections) {
            const rel = e.relationship ? ` —(${e.relationship})→ ` : ' → ';
            L.push(`- ${e.from}${rel}${e.to}${e.label ? `  (${e.label})` : ''}`);
        }
        L.push('');
    }
    if (struct.assets.length) {
        L.push(`## Assets (images / files)`);
        L.push(assetsDir
            ? `Extracted to \`${assetsDir}\` — open them to read images with vision:`
            : `Re-run with \`--assets <dir>\` to extract these for reading:`);
        for (const a of struct.assets) L.push(`- ${a}`);
        L.push('');
    }
    return L.join('\n');
}
