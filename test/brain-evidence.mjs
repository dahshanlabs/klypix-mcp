// Host-neutral capture must survive the actual MCP schema, not only the core API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildKlypixMap, parseKlypix, questionContextToMarkdown } from '../src/klypix-format.mjs';
import { opBrainNote } from '../src/klypix-core.mjs';
import { prepareBrainEvidence, inspectCardEvidence, formatCardEvidence } from '../src/brain-evidence.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-evidence-parity-'));
const project = path.join(temp, 'project'), home = path.join(temp, 'home');
fs.mkdirSync(project); fs.mkdirSync(home);
const brain = path.join(project, 'brain.klypix');
const source = path.join(project, 'source.txt');
const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const note = args => opBrainNote({ vault: project, canvas: brain, ...args });
const cards = async () => (await parseKlypix(fs.readFileSync(brain))).struct.cards.filter(c => c.type !== 'container');
const find = async text => (await cards()).find(card => card.text.replace(/\s+/g, ' ').includes(text));
const inspect = card => inspectCardEvidence(card, { projectRoot: project, budgetMs: 1000 });
let assertions = 0;
const check = (condition, description) => { assert.ok(condition, description); assertions++; console.log('[ok] ' + description); };
const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0', KLYPIX_SESSION_ID: 'evidence-wire-test', KLYPIX_MCP_INBOX_POLL_MS: '60000' };
let client;
try {
  git('init', '-q'); git('config', 'user.name', 'Evidence Test'); git('config', 'user.email', 'evidence@example.test');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(source, 'first\n');
  git('add', 'source.txt'); git('commit', '-qm', 'fixture');
  const oid = git('rev-parse', 'HEAD:source.txt'), head = git('rev-parse', 'HEAD');
  fs.writeFileSync(brain, await buildKlypixMap({ title: 'brain', areas: [{ title: 'Tests', cards: [{ text: 'Evidence fixture seed.' }] }] }));
  const claim = 'Connection retry loop preserves queued writes using bounded exponential backoff';
  const verify = 'node -e "require(\'fs\').writeFileSync(\'must-not-execute\', \'bad\')"';
  const captured = await note({ text: claim, area: 'Storage', via: 'codex', evidence: [{ kind: 'file', ref: 'source.txt:2', verifiedAt: '2026-09-05' }, { kind: 'pr', ref: 'PR#24' }], verify });
  check(!captured.isError, 'core accepts supporting references and inert verification text');
  const original = await find(claim);
  check(original.evidence[0].sha256?.length === 64 && original.evidence[0].sourceBasis === 'working-tree' && original.evidence[0].headRevision === head && original.verify === verify, 'serialized brain preserves working-file fingerprint, HEAD revision and verification text');
  check(original.createdVia === 'codex' && inspect(original).recordedVia === 'codex', 'recorded provenance survives capture and inspection');
  check(inspect(original).sources[0].status === 'source-unchanged' && inspect(original).sources[1].status === 'unverified', 'only the unchanged local source is unchanged; external references remain unverified');
  const noBudget = inspectCardEvidence(original, { projectRoot: project, budgetMs: 0 });
  check(noBudget.sources[0].status === 'unverified' && noBudget.sources[0].reason === 'inspection budget exhausted' && noBudget.verify.text === verify, 'exhausted read budgets retain provenance and verification text without inspecting files');
  const multiline = formatCardEvidence({ sources: [], verify: { text: 'node test/a.mjs\nnode test/b.mjs' } });
  check(multiline.includes('> node test/a.mjs\n> node test/b.mjs'), 'multiline verification remains separate quoted lines, never a merged command');
  check(!prepareBrainEvidence({ projectRoot: project, marker: '~', verify: '', text: 'claim verify: old command' }).ok, 'clearing verification cannot silently resurrect a legacy inline suffix');
  const md = questionContextToMarkdown('How does retry work?', { hits: [{ card: original }], total: 1 }, { evidenceForCard: card => formatCardEvidence(inspect(card), { maxChars: 2000 }) });
  check(md.includes('source status is not claim verification') && md.includes('not executed') && md.includes('source.txt:2') && md.includes('caller reported verification'), 'answer renderer shows sources, provenance and inert verification without claiming factual verification');

  fs.writeFileSync(source, 'dirty working tree\n');
  check(git('rev-parse', 'HEAD') === head && inspect(original).sources[0].status === 'changed', 'uncommitted source changes are detected even when HEAD is unchanged');
  const legacy = { evidence: [{ kind: 'file', ref: 'source.txt', oid }] };
  check(inspect(legacy).sources[0].status === 'changed', 'legacy HEAD anchors also detect dirty working files');
  const originalExec = childProcess.execFileSync;
  try {
    childProcess.execFileSync = (command, args, ...rest) => {
      if (command === 'git' && args[0] === 'diff') throw Object.assign(new Error('simulated unavailable diff'), { status: null, code: 'ETIMEDOUT' });
      return originalExec(command, args, ...rest);
    };
    syncBuiltinESMExports();
    check(inspect(legacy).sources[0].status === 'unverified', 'a legacy Git check timeout is unverified, never invented source drift');
  } finally { childProcess.execFileSync = originalExec; syncBuiltinESMExports(); }
  let budgetGitCalls = 0;
  try {
    childProcess.execFileSync = (command, args, ...rest) => {
      if (command === 'git') {
        budgetGitCalls++;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
        return oid;
      }
      return originalExec(command, args, ...rest);
    };
    syncBuiltinESMExports();
    const cache = new Map();
    const slow = inspectCardEvidence(legacy, { projectRoot: project, cache, budgetMs: 5 });
    const next = inspectCardEvidence(legacy, { projectRoot: project, cache });
    check(budgetGitCalls <= 1 && slow.sources[0].status === 'unverified' && next.sources[0].status === 'unverified', 'a shared response budget prevents follow-on Git probes after one slow check');
  } finally { childProcess.execFileSync = originalExec; syncBuiltinESMExports(); }
  const updated = await note({ text: claim + ' with a three-attempt cap', area: 'Storage', marker: '~', evidence: [{ kind: 'file', ref: 'source.txt' }], verify: 'node test/retry.mjs' });
  const amended = await find(claim);
  check(!updated.isError && amended.id === original.id && amended.evidence[0].sha256 !== original.evidence[0].sha256 && inspect(amended).sources[0].status === 'source-unchanged', 'amendment preserves identity and snapshots actual dirty bytes, not HEAD bytes');
  check(amended.verify === 'node test/retry.mjs', 'amendment replaces verification text');
  await note({ text: claim + ' with a three-attempt cap', area: 'Storage', marker: '~' });
  check((await find(claim)).evidence[0].sha256 === amended.evidence[0].sha256, 'omitting amendment metadata preserves existing references');
  await note({ text: claim + ' with a three-attempt cap', area: 'Storage', marker: '~', evidence: [], verify: '' });
  const cleared = await find(claim);
  check(!cleared.evidence?.length && !cleared.verify, 'explicit empty amendment metadata clears obsolete evidence and verification');

  const beforeInvalid = fs.readFileSync(brain);
  const invalids = [
    { evidence: null }, { evidence: {} }, { evidence: [null] }, { evidence: [{ kind: 'file' }] },
    { evidence: [{ kind: 'file', ref: '../outside.txt' }] }, { evidence: [{ kind: 'file', ref: 'a/../../outside.txt' }] },
    { evidence: [{ kind: 'file', ref: source }] }, { evidence: [{ kind: 'file', ref: 'C:/outside.txt' }] },
    { evidence: [{ kind: 'file', ref: 'safe.txt:evil' }] }, { evidence: [{ kind: 'file', ref: 'source.txt', oid: 'deadbeef' }] },
    { evidence: [{ kind: 'file', ref: 'source.txt', sha256: 'a'.repeat(64) }] }, { evidence: [{ kind: 'url', ref: 'file:///secret' }] },
    { evidence: [{ kind: 'file', ref: 'source.txt', verifiedAt: '2026-02-31' }] },
    { evidence: [{ kind: 'unknown', ref: 'source.txt' }] }, { evidence: new Array(17).fill({ kind: 'pr', ref: 'PR#1' }) },
    { verify: {} }, { verify: null }, { verify: 'x'.repeat(2001) }, { marker: '✓', evidence: [{ kind: 'pr', ref: 'PR#1' }] },
  ];
  for (const metadata of invalids) {
    const result = await note({ text: 'Invalid metadata must never be silently discarded', ...metadata });
    assert.equal(result.isError, true, JSON.stringify(metadata).slice(0, 120));
    assert.ok(fs.readFileSync(brain).equals(beforeInvalid), 'invalid metadata changed brain bytes');
  }
  check(true, '19 malformed or unsupported metadata cases reject without writing brain bytes');
  const unfilled = await note({ text: 'WHY THIS MATTERS: <one sentence explaining the durable reasoning>' });
  check(unfilled.isError && fs.readFileSync(brain).equals(beforeInvalid), 'unfilled rationale drafts are rejected before mutation');
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.symlinkSync(outside, path.join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  check(!prepareBrainEvidence({ projectRoot: project, evidence: [{ kind: 'file', ref: 'escape/secret.txt' }] }).ok
    && !prepareBrainEvidence({ projectRoot: project, evidence: [{ kind: 'file', ref: 'escape/missing/deeper.txt' }] }).ok, 'existing and missing paths through escaping symlinks/junctions are rejected');
  check(inspect({ evidence: [{ kind: 'file', ref: 'escape/secret.txt', oid }] }).sources[0].status === 'unverified', 'legacy escaping paths are unverified without reading their source');
  fs.writeFileSync(path.join(project, 'large.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
  const oversized = prepareBrainEvidence({ projectRoot: project, evidence: [{ kind: 'file', ref: 'large.bin' }] });
  check(oversized.ok && !oversized.evidence[0].sha256 && inspect(oversized).sources[0].status === 'unverified', 'oversized evidence remains unverified with bounded file reads');
  const missing = prepareBrainEvidence({ projectRoot: project, evidence: [{ kind: 'file', ref: 'missing.txt' }] });
  check(missing.ok && inspect(missing).sources[0].status === 'missing', 'missing source remains visible as missing without a fabricated fingerprint');

  const cli = args => spawnSync(process.execPath, [path.join(repo, 'src/brain-note.mjs'), ...args], { cwd: project, env, encoding: 'utf8', timeout: 15_000 });
  const cliJson = spawnSync(process.execPath, [path.join(repo, 'src/brain-note.mjs')], { cwd: project, env, input: JSON.stringify({ text: 'CLI evidence JSON is durable', area: 'CLI', evidence: [{ kind: 'file', ref: 'source.txt' }], verify: 'node test/cli.mjs' }), encoding: 'utf8', timeout: 15_000 });
  check(cliJson.status === 0 && (await find('CLI evidence JSON')).evidence[0].sha256 && (await find('CLI evidence JSON')).verify === 'node test/cli.mjs', 'CLI JSON preserves supporting evidence and verification text');
  const cliFlags = cli(['CLI evidence flags are durable', '--area', 'CLI', '--evidence', JSON.stringify([{ kind: 'pr', ref: 'PR#12' }]), '--verify', 'node test/flags.mjs']);
  check(cliFlags.status === 0 && (await find('CLI evidence flags')).evidence[0].ref === 'PR#12', 'CLI flags preserve references');
  const beforeCliBad = fs.readFileSync(brain);
  check(cli(['bad CLI', '--evidence', '{bad']).status !== 0 && fs.readFileSync(brain).equals(beforeCliBad), 'malformed CLI JSON fails without writing');
  const malformedStdin = spawnSync(process.execPath, [path.join(repo, 'src/brain-note.mjs')], { cwd: project, env, input: '{"text":"bad", "evidence":', encoding: 'utf8', timeout: 15_000 });
  check(malformedStdin.status !== 0 && fs.readFileSync(brain).equals(beforeCliBad), 'malformed structured stdin is rejected instead of captured as raw prose');

  client = new Client({ name: 'evidence-test-host', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'bin/klypix-worker.mjs'), '--vault', project], cwd: project, env, stderr: 'pipe' });
  await client.connect(transport);
  const listed = await client.listTools();
  const schema = listed.tools.find(tool => tool.name === 'brain_note').inputSchema;
  check(schema.properties.evidence?.items?.additionalProperties === false && schema.properties.verify?.type === 'string', 'real MCP discovery advertises strict evidence objects and verification text');
  const wire = await client.callTool({ name: 'brain_note', arguments: { text: 'MCP wire evidence survives the schema and brain serialization', area: 'Wire', evidence: [{ kind: 'file', ref: 'source.txt#L1' }], verify } });
  const wireCard = await find('MCP wire evidence survives');
  check(!wire.isError && wireCard?.evidence?.[0]?.sha256 && wireCard.verify === verify, 'real MCP note schema, dispatcher, engine and serialized card round-trip evidence');
  for (const bad of [{ evidence: [{ kind: 'file', ref: '../outside' }] }, { evidence: [{ kind: 'file', ref: 'source.txt', unexpected: true }] }, { verify: { command: 'do not run' } }]) {
    const before = fs.readFileSync(brain);
    let rejected = false;
    try { rejected = (await client.callTool({ name: 'brain_note', arguments: { text: 'Malformed wire input', ...bad } })).isError === true; } catch { rejected = true; }
    assert.ok(rejected && fs.readFileSync(brain).equals(before), 'MCP malformed metadata was dropped or wrote');
  }
  check(true, 'real MCP rejects malformed metadata instead of dropping fields or writing');

  fs.unlinkSync(source);
  check(inspect(wireCard).sources[0].status === 'missing', 'a deleted source is missing, never source-unchanged');
  check(!fs.existsSync(path.join(project, 'must-not-execute')), 'verification text was never executed by core, CLI, renderer or MCP');

  const corrected = await note({ text: 'CORRECTION: Connection retry loop preserves queued writes using bounded exponential backoff with a five-attempt cap', area: 'Storage', evidence: [{ kind: 'run', ref: 'local regression run 2026-09-05' }], verify: 'node test/corrected.mjs' });
  const correction = await find('CORRECTION: Connection retry');
  check(!corrected.isError && correction?.evidence?.[0]?.ref.includes('regression run') && correction?.verify === 'node test/corrected.mjs', 'correction capture retains its own evidence and verification');

  console.log('[ok] brain-evidence: ' + assertions + ' assertions passed');
} finally {
  await client?.close();
  if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('unsafe cleanup');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

