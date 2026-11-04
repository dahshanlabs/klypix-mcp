// Field regression: Claude delegates a complete brief while continuing its
// own task; a new Codex connection retrieves it without a copied prompt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildKlypixMap, rewriteCardById } from '../src/klypix-format.mjs';
import { laneFileFor } from '../src/agent-presence.mjs';
import { toolCompatibility } from '../src/mcp-supervisor.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-assignment-'));
const home = path.join(root, 'home');
const project = path.join(root, 'project');
const other = path.join(root, 'other');
const worker = process.env.KLYPIX_ASSIGNMENT_TEST_WORKER || fileURLToPath(new URL('../bin/klypix-worker.mjs', import.meta.url));
const clients = [];
let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks++; console.log(`[ok] ${label}`); };
for (const dir of [home, project, other]) fs.mkdirSync(dir, { recursive: true });
for (const dir of [project, other]) fs.writeFileSync(path.join(dir, 'brain.klypix'), await buildKlypixMap({ title: 'Assignment regression', kind: 'brain', areas: [{ title: 'Handoff', cards: [{ text: 'Handoff: test fixture only' }] }] }));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|KLYPIX)/.test(k)));
async function connect(name, sid, vault = project) {
  const c = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [worker, '--vault', vault], cwd: vault,
    env: { ...inherited, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0', KLYPIX_SESSION_ID: sid, KLYPIX_APP_TOOLS: 'off', KLYPIX_APP_BRIDGE_DIR: path.join(root, 'bridge') }, stderr: 'pipe' }));
  clients.push(c); return c;
}
const call = (c, name, args) => c.callTool({ name, arguments: args });
const handoff = (c, args) => call(c, 'brain_handoff', { project, ...args });
const text = r => (r.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
const laneEntry = id => JSON.parse(fs.readFileSync(laneFileFor(path.join(project, 'brain.klypix'), home), 'utf8')).directory.find(e => e.id === id);

try {
  const claude = await connect('claude-code', 'aabbccdd-1111-2222-3333-444444444444');
  const start = await call(claude, 'brain_sync', { project, phase: 'start', intent: 'Continue independent meeting-room implementation', files: ['src/room.mjs'] });
  const senderId = start.structuredContent.self.id;
  const tools = (await claude.listTools()).tools;
  const current = tools.find(t => t.name === 'brain_handoff');
  ok(current.inputSchema.properties.action.enum.includes('read') && current.inputSchema.properties.reason.enum.includes('assignment'), 'MCP advertises assignment save and direct read');
  const previous = structuredClone(current);
  delete previous.inputSchema.properties.instructions;
  previous.inputSchema.properties.action.enum = previous.inputSchema.properties.action.enum.filter(a => a !== 'read');
  previous.inputSchema.properties.reason.enum = previous.inputSchema.properties.reason.enum.filter(a => a !== 'assignment');
  ok(toolCompatibility([previous], [current]).ok, 'the additive assignment schema is compatible with the existing supervisor');

  const ordinary = await handoff(claude, { action: 'write', title: 'Separate room continuation', task: 'Finish the room implementation.', next: ['Finish the independent room work.'], reason: 'context_limit' });
  ok(!ordinary.isError && ordinary.structuredContent.id, 'ordinary session handoff still saves');
  const originalWork = structuredClone(laneEntry(senderId).work);
  const originalIntent = laneEntry(senderId).intent;
  const instructions = 'Research Saudi business calls.\r\n\r\n#research\n#handoff\n' + Array.from({ length: 65 }, (_, i) => `${i + 1}. وِشْ رَايَكْ — preserve this tashkeel and quote only verified audio.`).join('\n') + '\nNext: this belongs inside the brief, not another card section.\nFiles: outputs/evidence.md\nDo not edit room code. End with a timestamped evidence table.';
  const spec = { action: 'write', reason: 'assignment', for: 'Codex', title: 'Najdi listening assignment', task: 'Verify speech and pronunciation from public audio.', instructions, next: ['Read the saved brief.', 'Collect audible evidence and report remaining gaps.'], files: ['outputs/evidence.md'], verify: 'Every verified pronunciation has an audible source and timestamp.' };
  const missing = await handoff(claude, { ...spec, instructions: undefined });
  ok(missing.isError, 'an assignment without a complete brief fails loudly');
  const oversized = await handoff(claude, { ...spec, instructions: 'x'.repeat(24001) });
  ok(oversized.isError, 'an oversized brief is rejected instead of truncated');
  const mixed = await handoff(claude, { ...spec, continues: ordinary.structuredContent.id });
  ok(mixed.isError && text(mixed).includes('may continue only another assignment'), 'assignment updates cannot close an ordinary whole-session handoff');
  const saved = await handoff(claude, spec);
  ok(!saved.isError && saved.structuredContent.instructionsSaved === true, `assignment save is verified: ${text(saved).slice(0, 150)}`);
  const id = saved.structuredContent.id;
  assert.deepEqual(laneEntry(senderId).work, originalWork);
  ok(laneEntry(senderId).intent === originalIntent, 'saving an assignment leaves the sender task and ordinary handoff pointer unchanged');

  // More recent unrelated handoffs would previously hide this assignment in
  // the first five cards, even though the card said for: Codex.
  for (let i = 0; i < 7; i++) {
    const r = await handoff(claude, { action: 'write', reason: 'assignment', for: 'Reviewer', title: `Unrelated review ${i}`, task: `Review separate change ${i}.`, next: ['Review only this change.'], instructions: `Independent review ${i}; unrelated to the listening assignment.` });
    assert.ok(!r.isError, text(r));
  }
  const codex = await connect('codex', 'ccddeeff-1111-2222-3333-444444444444');
  const synced = await call(codex, 'brain_sync', { project, phase: 'start', intent: 'Do the task assigned to you by Claude', files: [] });
  ok(!synced.isError && text(synced).includes(id) && text(synced).includes('Najdi listening assignment'), 'a fresh Codex sync surfaces the addressed assignment ahead of seven newer unrelated cards');
  const listed = await handoff(codex, { action: 'list', for: 'Codex' });
  ok(listed.structuredContent.handoffs.length === 1 && listed.structuredContent.handoffs[0].id === id, 'recipient-filtered lookup finds the exact assignment');
  const read = await handoff(codex, { action: 'read', id });
  assert.equal(read.structuredContent.handoff.instructions, instructions);
  ok(text(read).includes(instructions), 'direct read returns the complete brief, preserving Arabic, CRLF and section-like text');
  const reviewed = await handoff(codex, { action: 'review', id });
  ok(reviewed.structuredContent.scope === 'assignment' && !reviewed.structuredContent.freshness, 'assignment review does not require unrelated sender conversation history');
  const take = await handoff(codex, { action: 'take', id });
  assert.equal(take.structuredContent.handoff.instructions, instructions);
  assert.deepEqual(laneEntry(senderId).work, originalWork);
  ok(take.structuredContent.scope === 'assignment' && laneEntry(senderId).intent === originalIntent, 'taking the assignment preserves the sender independent work');
  const reread = await handoff(codex, { action: 'read', id });
  ok(!reread.isError && reread.structuredContent.handoff.instructions === instructions, 'taking a brief with interior hashtags leaves its saved instructions readable and current');

  const intruder = await connect('codex', 'ddeeff00-1111-2222-3333-444444444444');
  const duplicate = await handoff(intruder, { action: 'take', id });
  ok(duplicate.isError && text(duplicate).includes('working now'), 'a second working session cannot silently take the same assignment');
  const isolated = await connect('codex', 'eeff0011-1111-2222-3333-444444444444', other);
  const absent = await call(isolated, 'brain_handoff', { project: other, action: 'read', id });
  ok(absent.isError, 'an assignment is not readable from a different project brain');
  const wrongProject = await call(codex, 'brain_handoff', { project: other, action: 'read', id });
  ok(wrongProject.isError, 'an explicit other project cannot reuse the connection\'s previously bound brain');

  const done = await handoff(codex, { action: 'done', id, summary: 'Regression fixture completed.' });
  assert.deepEqual(laneEntry(senderId).work, originalWork);
  ok(!done.isError && done.structuredContent.archived === true && laneEntry(senderId).intent === originalIntent, 'completion archives only the assignment and leaves sender work active');
  const remaining = await handoff(codex, { action: 'list', for: 'Codex' });
  ok(remaining.structuredContent.handoffs.length === 0, 'completed assignment no longer appears in open lookup');
  const normalReview = await handoff(codex, { action: 'review', id: ordinary.structuredContent.id });
  ok(normalReview.structuredContent.freshness?.status === 'unknown', 'ordinary session handoff still requires conversation evidence');

  await call(claude, 'brain_sync', { project, phase: 'checkpoint', intent: originalIntent, files: ['src/room.mjs'] });
  const damaged = await handoff(claude, { ...spec, title: 'Visible edit integrity fixture' });
  assert.ok(!damaged.isError, text(damaged));
  const damagedId = damaged.structuredContent.id;
  const brainFile = path.join(project, 'brain.klypix');
  const intact = fs.readFileSync(brainFile);
  const missingExact = await rewriteCardById(intact, damagedId, j => { delete j.handoff.instructions; });
  assert.ok(missingExact.changed);
  fs.writeFileSync(brainFile, missingExact.buffer);
  await call(codex, 'brain_sync', { project, phase: 'checkpoint', intent: 'Check the saved assignment', files: [] });
  const noExact = await handoff(codex, { action: 'read', id: damagedId });
  ok(noExact.isError && text(noExact).includes('instructions are missing'), 'a missing exact copy cannot silently fall back to reflowed prose');
  const edited = await rewriteCardById(intact, damagedId, j => { j.content = j.content.replace('Research Saudi', 'Research Hijazi'); });
  assert.ok(edited.changed);
  fs.writeFileSync(brainFile, edited.buffer);
  await call(codex, 'brain_sync', { project, phase: 'checkpoint', intent: 'Check the saved assignment', files: [] });
  const staleRead = await handoff(codex, { action: 'read', id: damagedId });
  const staleTake = await handoff(codex, { action: 'take', id: damagedId });
  ok(staleRead.isError && text(staleRead).includes('visible brief changed') && staleTake.isError, 'a human edit to the visible brief must be reconciled before read or take can return stale exact instructions');

  await call(claude, 'brain_sync', { project, phase: 'checkpoint', intent: originalIntent, files: ['src/room.mjs'] });
  await call(intruder, 'brain_sync', { project, phase: 'start', intent: 'Save a separate assignment', files: [] });
  const concurrentSpecs = ['alpha', 'beta'].map(label => ({ ...spec, title: 'Concurrent same-name assignment', task: `Only the ${label} task.`, instructions: `Only the ${label} instructions.\nDo not mix with the other writer.` }));
  const concurrent = await Promise.all([handoff(claude, concurrentSpecs[0]), handoff(intruder, concurrentSpecs[1])]);
  ok(concurrent.every(r => !r.isError) && concurrent[0].structuredContent.id !== concurrent[1].structuredContent.id, 'concurrent same-title saves return distinct created-card identities');
  await call(codex, 'brain_sync', { project, phase: 'checkpoint', intent: 'Inspect concurrent saved assignments', files: [] });
  for (let i = 0; i < concurrent.length; i++) {
    const r = await handoff(codex, { action: 'read', id: concurrent[i].structuredContent.id });
    assert.ok(!r.isError, text(r));
    assert.equal(r.structuredContent.handoff.task, concurrentSpecs[i].task);
    assert.equal(r.structuredContent.handoff.instructions, concurrentSpecs[i].instructions);
  }
  ok(true, 'each concurrent save keeps its own visible task and exact instructions');
} finally {
  await Promise.allSettled(clients.map(c => c.close()));
  // This exact temporary root was allocated above; no user checkout is touched.
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n✓ assignment-handoff: ${checks} checks passed`);
