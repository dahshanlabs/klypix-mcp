import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handoffTranscript, inspectHandoffFreshness } from '../src/session-handoff.mjs';
import { buildKlypixMap, parseKlypix } from '../src/klypix-format.mjs';
import { opBrainHandoff } from '../src/klypix-core.mjs';
import { upsertSession } from '../src/agent-presence.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-freshness-'));
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
const sid = '0648f483-13fb-4657-ab5f-6cce94c448bd';
const now = Date.now();
const project = path.join(root, 'project');
const dir = path.join(root, '.claude', 'projects', 'example');
fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(project);
const source = path.join(dir, `${sid}.jsonl`);
const row = (role, text, at) => JSON.stringify({ type: role, timestamp: new Date(at).toISOString(), message: { role, content: [{ type: 'text', text }] } });
const lines = [row('user', 'Make the film', now - 5000), row('assistant', 'The v3 film is rendered', now - 3000), row('user', 'Compare https://lnkd.in/p/example with our idea', now - 2000), row('user', 'see', now - 1000)];
// Claude's API cache blobs duplicate messages without timestamps; they are
// not canonical turns and must not make the actual transcript unreadable.
lines.push(JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: 'cached request' }] } }));
fs.writeFileSync(source, lines.join('\n') + '\n');
process.env.HOME = root; process.env.USERPROFILE = root; process.env.CODEX_HOME = path.join(root, '.codex');
try {
  const h = { id: 'card', at: now - 4000, from: { sessionId: sid, client: 'Claude Code' } };
  let transcript = handoffTranscript(sid, 'claude-code', { home: root });
  assert.equal(transcript.status, 'available');
  let f = inspectHandoffFreshness(h, { transcript });
  assert.equal(f.status, 'needs-review');
  assert.equal(f.laterTurns, 3);
  assert.equal(f.turns.at(-1).text, 'see');
  assert.ok(f.turns.some(t => t.text.includes('lnkd.in')), 'unanswered request before final see is preserved');
  assert.ok(f.turns.some(t => t.text === 'Make the film'), 'initial review includes pre-handoff omissions');
  const reviewed = { ...h, review: { revision: f.revision, through: f.through, at: now, summary: 'Comparison still pending' } };
  assert.equal(inspectHandoffFreshness(reviewed, { transcript }).status, 'reviewed');
  fs.appendFileSync(source, row('user', 'Also check the audio', now + 1000) + '\n');
  transcript = handoffTranscript(sid, 'claude-code', { home: root });
  assert.equal(inspectHandoffFreshness(reviewed, { transcript }).status, 'needs-review');
  assert.equal(inspectHandoffFreshness(h, { cursor: 1, revision: f.revision, transcript }).status, 'unknown', 'changed source invalidates pagination');
  assert.equal(handoffTranscript('../escape', 'claude-code', { home: root }).status, 'unknown');
  assert.equal(handoffTranscript(sid, 'unsupported', { home: root }).status, 'unknown');
  assert.equal(handoffTranscript(sid, 'claude-code', { home: root, maxBytes: 2 }).status, 'unknown');
  assert.equal(handoffTranscript(sid, 'claude-code', { home: root, maxEntries: 0 }).status, 'unknown');
  fs.appendFileSync(source, '{partial');
  assert.equal(handoffTranscript(sid, 'claude-code', { home: root }).status, 'unknown');
  fs.writeFileSync(source, lines.join('\n') + '\n');
  // The real missed-request transcript exceeds 32 MiB because of image/API
  // records. Streaming must retain requests on both sides of those records.
  const blob = JSON.stringify({ type: 'api-request-blob', data: 'x'.repeat(5 * 1024 * 1024) }) + '\n';
  for (let i = 0; i < 7; i++) fs.appendFileSync(source, blob);
  fs.appendFileSync(source, row('user', 'Final unanswered request', now + 2000) + '\n');
  assert.equal(handoffTranscript(sid, 'claude-code', { home: root }).turns.at(-1).text, 'Final unanswered request');
  fs.writeFileSync(source, lines.join('\n') + '\n');
  const duplicate = path.join(root, '.claude', 'projects', 'duplicate'); fs.mkdirSync(duplicate);
  fs.copyFileSync(source, path.join(duplicate, `${sid}.jsonl`));
  assert.equal(handoffTranscript(sid, 'claude-code', { home: root }).status, 'unknown', 'ambiguous identities never choose silently');
  fs.unlinkSync(path.join(duplicate, `${sid}.jsonl`));
  const many = { ...transcript, revision: 'many', turns: Array.from({ length: 70 }, (_, i) => ({ role: 'user', at: now + i, text: `Request ${i}` })) };
  const first = inspectHandoffFreshness(h, { transcript: many });
  assert.equal(first.nextCursor, 30); assert.equal(first.reviewToken, undefined);
  const second = inspectHandoffFreshness(h, { transcript: many, cursor: 30, revision: 'many' });
  assert.equal(second.nextCursor, 60);
  const last = inspectHandoffFreshness(h, { transcript: many, cursor: 60, revision: 'many' });
  assert.equal(last.nextCursor, null); assert.ok(last.reviewToken);

  // Codex canonical messages: event_msg duplicates and tool results excluded.
  const codexDir = path.join(root, '.codex', 'sessions', '2026', '10', '24'); fs.mkdirSync(codexDir, { recursive: true });
  const codexFile = path.join(codexDir, `rollout-2026-10-24-${sid}.jsonl`);
  fs.writeFileSync(codexFile, [JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'duplicate' } }), JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect this' }, { type: 'input_image', image_url: 'data:private' }] } })].join('\n'));
  const codex = handoffTranscript(sid, 'codex', { home: root });
  assert.equal(codex.turns.length, 1); assert.match(codex.turns[0].text, /Image attachment/); assert.ok(!codex.turns[0].text.includes('data:private'));

  // Integration: claim returns review requirement, review is explicit, source
  // changes reject old acknowledgement, and acknowledging never closes work.
  const brain = path.join(project, 'brain.klypix');
  fs.writeFileSync(brain, await buildKlypixMap({ title: 'test', kind: 'brain', areas: [{ title: 'Test', cards: [{ text: 'Test seed' }] }] }));
  const orphan = '11111111-2222-3333-4444-555555555555';
  upsertSession({ brainPath: brain, id: orphan, logicalSessionId: orphan, identitySource: 'claude-lifecycle', client: 'claude-code', channel: 'mcp', event: 'McpTaskStart', intent: 'Review unfinished comparison', work: { lastWords: 'Still working', lastPrompt: 'see' } });
  fs.copyFileSync(source, path.join(dir, `${orphan}.jsonl`));
  const orphanReview = await opBrainHandoff({ vault: project, action: 'review', session: orphan, from: { sessionId: 'reviewer', client: 'codex' } });
  assert.ok(!orphanReview.isError, JSON.stringify(orphanReview));
  assert.equal(orphanReview.structured.freshness.status, 'needs-review', 'session-only review creates a draft and reads full source');
  const from = { sessionId: sid, client: 'claude-code' };
  const written = await opBrainHandoff({ vault: project, action: 'write', from, title: 'Film followups', task: 'Complete film review', next: ['Generate narration'] });
  assert.ok(!written.isError, JSON.stringify(written));
  const id = written.structured.id;
  const taker = { sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', client: 'codex' };
  const taken = await opBrainHandoff({ vault: project, action: 'take', id, from: taker });
  assert.equal(taken.structured.freshness.status, 'needs-review');
  assert.ok(!taken.blocks[0].text.includes('work the Next list in order'));
  const page = await opBrainHandoff({ vault: project, action: 'review', id, from: taker });
  const token = page.structured.freshness.reviewToken;
  assert.ok(page.blocks[0].text.includes('lnkd.in'));
  assert.ok((await opBrainHandoff({ vault: project, action: 'review', id, from: taker, reviewToken: token })).isError, 'summary required');
  fs.appendFileSync(source, row('user', 'new followup', now + 1000) + '\n');
  assert.ok((await opBrainHandoff({ vault: project, action: 'review', id, from: taker, reviewToken: token, summary: 'comparison pending' })).isError, 'stale receipt refused');
  const fresh = await opBrainHandoff({ vault: project, action: 'review', id, from: taker });
  const ack = await opBrainHandoff({ vault: project, action: 'review', id, from: taker, reviewToken: fresh.structured.freshness.reviewToken, summary: 'Film rendered; comparison and new followup pending' });
  assert.ok(!ack.isError, JSON.stringify(ack));
  const again = await opBrainHandoff({ vault: project, action: 'take', id, from: taker });
  assert.equal(again.structured.freshness.status, 'reviewed');
  const { struct } = await parseKlypix(fs.readFileSync(brain));
  assert.equal(struct.cards.find(c => c.id === id).handoff.state, 'taken');
  assert.ok(struct.cards.find(c => c.id === id).handoff.review.summary.includes('pending'));
  const client = new Client({ name: 'handoff-freshness-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/klypix-worker.mjs', import.meta.url)), '--vault', project], env: { ...process.env, KLYPIX_AUTO_UPDATE: '0', KLYPIX_APP_TOOLS: 'off' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.find(t => t.name === 'brain_handoff').inputSchema.properties.action.enum.includes('review'));
    const result = await client.callTool({ name: 'brain_handoff', arguments: { action: 'review', id, project } });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(result.content.some(c => c.text?.includes('Conversation reviewed through')), 'review works through the real MCP protocol');
  } finally { await client.close(); await transport.close(); }
  fs.unlinkSync(source);
  assert.equal((await opBrainHandoff({ vault: project, action: 'take', id, from: taker })).structured.freshness.status, 'unknown');
  console.log('PASS: source recovery, unanswered followups, full initial coverage, pagination, changed/missing evidence, Codex attachments, explicit review and stale acknowledgement rejection');
} finally {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
}
