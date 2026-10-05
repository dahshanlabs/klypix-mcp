// agent-card-style — P0 agent parity: an AI tool's cards are readable and
// attributed, and land where the person organised the canvas.
//
//   • add_to_canvas cards are bordered, text #e8e8ed on the brain_note fill
//     rgba(18,18,26,0.85) when no colour is given (readable on KLYPIX's dark
//     default AND on Paper, in every build); a given colour is kept, unfilled.
//   • create_canvas text defaults to #e8e8ed (the old #1a1a1f was near-black on
//     the dark default).
//   • both writers stamp createdVia — KLYPIX shows it as the card's chip.
//   • `group` puts a card in the titled box of that name, creating it if missing.
//   • a `group` naming a box a person locked from AI tools is refused
//     (SCOPE_LOCKED); one naming a box a person froze — or a box inside a frozen
//     one — is refused (FROZEN). Either way the file's bytes are unchanged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-agent-style-'));
const home = path.join(tmp, 'home');
const vault = path.join(tmp, 'vault');
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.KLYPIX_APP_BRIDGE_DIR = path.join(tmp, 'bridge');

const { buildPlainCanvas } = await import('./_parity-fixture.mjs');
const { appendToKlypix, parseKlypix, buildKlypix } = await import('../src/klypix-format.mjs');
const { opAddToCanvas, opCreateCanvas } = await import('../src/klypix-core.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const itemsOf = async (buf) => (await parseKlypix(buf)).items;
const posOf = async (buf) => (await parseKlypix(buf)).canvas.positions;

const canvas = await buildPlainCanvas(vault);

// ── the look ─────────────────────────────────────────────────────────────────
{
  const r = await opAddToCanvas({ vault, canvas: 'Plain board', cards: [{ text: 'Agent idea, no colour' }, { text: 'Risk!', color: '#ef4444' }], via: 'codex' });
  ok(!r.isError && r.structured?.card_ids?.length === 2, 'add_to_canvas adds two cards and returns their ids');
  const items = await itemsOf(fs.readFileSync(canvas));
  const [plain, red] = r.structured.card_ids.map(id => items[id]);
  ok(plain.border === true && plain.color === '#e8e8ed' && plain.fillColor === 'rgba(18,18,26,0.85)', 'no colour → bordered, #e8e8ed on rgba(18,18,26,0.85) (the brain_note look)');
  ok(red.border === true && red.color === '#ef4444' && red.fillColor === undefined, 'a given colour is kept, bordered, with no fill');
  ok(plain.createdVia === 'codex' && red.createdVia === 'codex' && plain.createdBy === 'agent', 'add_to_canvas stamps createdVia (the chip) and createdBy agent');
  const unbordered = await appendToKlypix(fs.readFileSync(canvas), { cards: [{ text: 'cli card', border: false }] });
  const u = Object.values(await itemsOf(unbordered)).find(i => i.content === 'cli card');
  ok(u.border === false && typeof u.authoredWidth === 'number', 'a card that says border:false (the CLI) stays unbordered, with its wrap width pinned');
}
{
  const c = await opCreateCanvas({ vault, title: 'Made by an agent', cards: [{ text: 'First' }, { text: 'Second', color: '#3b82f6' }], via: 'claude-code' });
  const items = Object.values(await itemsOf(c.file.buffer)).filter(i => i.type === 'text');
  ok(!c.isError && items.find(i => i.content === 'First')?.color === '#e8e8ed', 'create_canvas defaults card text to #e8e8ed');
  ok(items.find(i => i.content === 'Second')?.color === '#3b82f6', 'create_canvas keeps a given colour');
  ok(items.every(i => i.createdVia === 'claude-code'), 'create_canvas stamps createdVia on every card');
  const bare = Object.values(await itemsOf(await buildKlypix({ title: 'x', cards: [{ text: 'y' }] }))).find(i => i.type === 'text');
  ok(bare.color === '#e8e8ed' && bare.createdVia === undefined, 'buildKlypix alone (klypix-write) uses the same colour and stamps nothing it was not given');
}

// ── group ────────────────────────────────────────────────────────────────────
{
  const r = await opAddToCanvas({ vault, canvas: 'Plain board', cards: [
    { text: 'Goes into Ideas', group: 'ideas' },
    { text: 'Goes into a new box', group: 'Next steps' },
    { text: 'Second in the new box', group: 'Next steps' },
  ], via: 'codex' });
  ok(!r.isError, 'add_to_canvas with groups succeeds');
  const buf = fs.readFileSync(canvas);
  const items = await itemsOf(buf);
  const pos = await posOf(buf);
  const byText = (t) => Object.entries(items).find(([, i]) => i.content === t)?.[0];
  ok(pos[byText('Goes into Ideas')]?.parentId === 'ctn_ideas', 'a group naming an existing box (case-insensitively) puts the card in it');
  const boxId = Object.entries(items).find(([, i]) => i.type === 'container' && i.title === 'Next steps')?.[0];
  ok(boxId && pos[byText('Goes into a new box')]?.parentId === boxId && pos[byText('Second in the new box')]?.parentId === boxId, 'a missing group is created once, and both cards go in it');
  ok(items[boxId]?.createdVia === 'codex' && items[boxId]?.scopeLocked === false, 'the new box is stamped with the tool and is not locked');
  const a = pos[byText('Goes into a new box')], b = pos[byText('Second in the new box')], box = pos[boxId];
  ok(b.y >= a.y + a.h && box.y + box.h >= b.y + b.h, 'cards stack inside the new box and the box grows to hold them');
  ok(r.structured?.box_ids?.includes(boxId), 'the new box id is returned as box_ids');
}

// ── refusals: scope-locked and frozen boxes ─────────────────────────────────
{
  for (const [group, code, sentence] of [
    ['Private', 'SCOPE_LOCKED', 'Tell the user: Those cards are inside a box you locked from AI tools in KLYPIX.'],
    ['Frozen box', 'FROZEN', 'Tell the user: Some cards are frozen in KLYPIX, so I left them as they are.'],
    ['Under frozen', 'FROZEN', 'Tell the user: Some cards are frozen in KLYPIX, so I left them as they are.'],
  ]) {
    const before = fs.readFileSync(canvas);
    const r = await opAddToCanvas({ vault, canvas: 'Plain board', cards: [{ text: 'fine card' }, { text: 'into ' + group, group }], via: 'codex' });
    ok(r.isError === true && r.structured?.code === code && r.blocks.at(-1).text === sentence, `a group naming "${group}" is refused with ${code} and KLYPIX's sentence`);
    ok(fs.readFileSync(canvas).equals(before), `…and the file's bytes are unchanged (not even the ungrouped card landed)`);
  }
  // A connection can never reach a card inside a locked box, even by its title.
  const r = await opAddToCanvas({ vault, canvas: 'Plain board', cards: [{ text: 'Linker' }], connections: [{ from: 0, to: 'private note' }] });
  const { struct } = await parseKlypix(fs.readFileSync(canvas));
  ok(!r.isError && !struct.connections.some(c => c.toId === 'txt_private'), 'a connection to a card inside a locked box is not drawn');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ agent-card-style: all assertions passed');
process.exit(failures ? 1 : 0);
