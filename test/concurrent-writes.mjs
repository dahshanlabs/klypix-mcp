// Real multi-PROCESS proof for G5. In-process Promise chains are insufficient:
// separate MCP/A2A servers and lifecycle hooks share one brain on disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildKlypixMap,
  parseKlypix,
  selectGardenCandidates,
} from '../src/klypix-format.mjs';
import { gardenApprovalCode } from '../src/klypix-core.mjs';
import { brainCaptureLockPath } from '../src/brain-write-lock.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const flatText = (card) => String(card?.text || '').replace(/\s+/g, ' ').trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (condition, timeoutMs = 20_000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (condition()) return true;
    await delay(10);
  }
  return false;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-cross-process-'));
const coreUrl = pathToFileURL(path.resolve('src/klypix-core.mjs')).href;

const childSource = String.raw`
  import fs from 'node:fs';
  import path from 'node:path';
  const [coreUrl, mode, target, ready, barrier, payloadJson] = process.argv.slice(1);
  const payload = JSON.parse(payloadJson);
  const { opBrainConnect, opBrainGarden, opBrainNote, opCreateCanvas } = await import(coreUrl);
  fs.writeFileSync(ready, 'ready');
  while (!fs.existsSync(barrier)) await new Promise(r => setTimeout(r, 5));
  let result;
  if (mode === 'note') {
    result = await opBrainNote({
      vault: path.dirname(target), canvas: target,
      text: 'concurrent note ' + payload.label, area: 'Concurrency', via: 'process-test',
    });
  } else if (mode === 'connect') {
    result = await opBrainConnect({
      vault: path.dirname(target), canvas: target, apply: true,
      pairs: [payload.pair], relationship: 'relates_to', label: 'parallel-test',
    });
  } else if (mode === 'garden') {
    result = await opBrainGarden({
      vault: path.dirname(target), canvas: target, apply: true,
      syntheses: [{ title: payload.title, synthesis: payload.synthesis }], approve: payload.approve,
    });
  } else {
    result = await opCreateCanvas({
      vault: target, title: 'Parallel canvas',
      cards: [{ text: 'created by ' + payload.label }], connections: [],
    });
  }
  if (result?.isError) { console.error(result.blocks?.[0]?.text || 'write failed'); process.exit(2); }
`;

let waveId = 0;
const runWave = async (target, cases) => {
  const wave = `wave-${waveId++}`;
  const barrier = path.join(root, `${wave}.go`);
  const children = [];
  const exits = [];
  for (let i = 0; i < cases.length; i++) {
    const { mode, payload } = cases[i];
    const ready = path.join(root, `${wave}.${i}.ready`);
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', childSource,
      coreUrl, mode, target, ready, barrier, JSON.stringify(payload),
    ], { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    exits.push(new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr }))));
    children.push({ child, ready });
  }
  const ready = await waitFor(() => children.every((entry) => fs.existsSync(entry.ready)));
  if (!ready) {
    for (const { child } of children) child.kill();
    throw new Error(`${wave} children did not reach the barrier`);
  }
  fs.writeFileSync(barrier, 'go');
  return Promise.all(exits);
};

try {
  const brain = path.join(root, 'brain.klypix');
  fs.writeFileSync(brain, await buildKlypixMap({
    title: 'concurrent brain', kind: 'brain',
    areas: [{
      title: 'Base',
      cards: Array.from({ length: 12 }, (_, i) => ({ text: `base card ${i}` })),
    }],
  }));

  ok(brainCaptureLockPath(brain) === path.join(root, '.claude', 'brain-capture.lock'),
    'brain writers use the lifecycle/app capture-lock path');

  const noteResults = await runWave(brain, Array.from({ length: 5 }, (_, i) => ({
    mode: 'note', payload: { label: i },
  })));
  ok(noteResults.every((result) => result.code === 0),
    `five independent brain_note writers all report success (${noteResults.map((r) => r.code).join(',')})`);
  let { struct } = await parseKlypix(fs.readFileSync(brain));
  for (let i = 0; i < 5; i++) {
    ok(struct.cards.filter((card) => flatText(card).includes(`concurrent note ${i}`)).length === 1,
      `cross-process brain_note ${i} survives exactly once`);
  }
  ok(!fs.existsSync(brainCaptureLockPath(brain)), 'capture lock is released after the write wave');

  const baseIds = struct.cards
    .filter((card) => /^base card \d+$/.test(String(card.text || '')))
    .sort((a, b) => Number(a.text.match(/\d+/)[0]) - Number(b.text.match(/\d+/)[0]))
    .map((card) => card.id);
  const connectResults = await runWave(brain, [0, 2, 4].map((i) => ({
    mode: 'connect', payload: { pair: { fromId: baseIds[i], toId: baseIds[i + 1] } },
  })));
  ok(connectResults.every((result) => result.code === 0),
    `three independent brain_connect writers all report success (${connectResults.map((r) => r.code).join(',')})`);
  ({ struct } = await parseKlypix(fs.readFileSync(brain)));
  ok(struct.connections.filter((connection) => connection.label === 'parallel-test').length === 3,
    'cross-process brain_connect preserves all three distinct edges');

  // Make the four oldest Base cards eligible for garden (12 total, newest 8
  // protected). Race that destructive rewrite against a normal note: both must
  // survive, proving brain_garden joins the same cross-process critical section.
  const parsed = await parseKlypix(fs.readFileSync(brain));
  const old = Date.now() - 30 * 86_400_000;
  for (const card of parsed.struct.cards.filter((entry) => /^base card \d+$/.test(String(entry.text || '')))) {
    const itemPath = Object.keys(parsed.zip.files).find((name) => name.endsWith(`/${card.id}.json`));
    const item = JSON.parse(await parsed.zip.file(itemPath).async('string'));
    item.createdAt = old;
    parsed.zip.file(itemPath, JSON.stringify(item));
  }
  fs.writeFileSync(brain, await parsed.zip.generateAsync({ type: 'nodebuffer' }));
  ({ struct } = await parseKlypix(fs.readFileSync(brain)));
  const gardenAreas = selectGardenCandidates(struct);
  ok(gardenAreas.length === 1 && gardenAreas[0].candidates.length === 4,
    'garden fixture has exactly four deterministic dormant candidates');
  const synthesis = 'The earliest base records were consolidated after concurrency verification; all durable facts remain represented by this deliberately long synthesis.';
  const gardenResults = await runWave(brain, [
    {
      mode: 'garden', payload: {
        title: gardenAreas[0].title, synthesis, approve: gardenApprovalCode(gardenAreas),
      },
    },
    { mode: 'note', payload: { label: 'during-garden' } },
  ]);
  ok(gardenResults.every((result) => result.code === 0),
    `brain_garden and brain_note both report success (${gardenResults.map((r) => r.code).join(',')})`);
  ({ struct } = await parseKlypix(fs.readFileSync(brain)));
  ok(struct.cards.some((card) => flatText(card).includes('concurrent note during-garden')),
    'brain_note survives a simultaneous brain_garden rewrite');
  ok(struct.cards.filter((card) => flatText(card).includes('earliest base records were consolidated')).length === 1,
    'brain_garden synthesis survives a simultaneous brain_note rewrite');

  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault);
  const createResults = await runWave(vault, Array.from({ length: 4 }, (_, i) => ({
    mode: 'create', payload: { label: i },
  })));
  ok(createResults.every((result) => result.code === 0),
    `four independent create_canvas writers all report success (${createResults.map((r) => r.code).join(',')})`);
  const created = fs.readdirSync(vault).filter((name) => /^Parallel canvas(?: \d+)?\.klypix$/i.test(name));
  ok(created.length === 4, `cross-process create_canvas keeps four distinct files (got ${created.length})`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] concurrent-writes: all assertions passed');
process.exit(failures ? 1 : 0);
