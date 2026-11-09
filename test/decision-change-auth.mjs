// Entirely offline: fake credential transport and a fake CLI; no real keys,
// provider requests, global configuration, or original budget ledger.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadBenchmarkAuthentication, authenticationMetadata, spawnEnvironment } from '../bench/decision-change/auth.mjs';
import { prepareClaudeHome, runClaudeStage } from '../bench/decision-change/agent.mjs';
import { preparePassiveAudit } from '../bench/decision-change/passive-audit.mjs';
import { BudgetLedger } from '../bench/decision-change/ledger.mjs';
import { resolveCli } from '../bench/coordination/agents.mjs';
import { auditHookSource } from '../bench/decision-change/native-hooks.mjs';
import { hookAuditSource } from '../bench/decision-change/claude-mem.mjs';

const key = `sk-ant-${'OFFLINE_SENTINEL_'.repeat(4)}`;
const pipe = String.raw`\\.\pipe\benchmark-fake-auth`;
const load = options => loadBenchmarkAuthentication({ method: 'api-key', apiKeyPipe: pipe, platform: 'win32',
  readPipe: async () => `ANTHROPIC_API_KEY=${key}\n`, ...options });
const authentication = await load();
assert.equal(authenticationMetadata(authentication).method, 'api-key');
assert.equal(JSON.stringify(authentication).includes(key), false);
assert.equal(spawnEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: 'discard', ANTHROPIC_AUTH_TOKEN: 'discard' }, authentication).ANTHROPIC_API_KEY, key);
assert.equal(spawnEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: 'discard' }, authentication).CLAUDE_CODE_OAUTH_TOKEN, undefined);
assert.throws(() => authenticationMetadata(JSON.parse(JSON.stringify(authentication))), /explicit benchmark credential loader/);
assert.throws(() => authentication.assertPublic({ nested: { key } }), /public benchmark artifact/);
assert.equal(await loadBenchmarkAuthentication(), null);
for (const options of [{ method: 'bad' }, { method: 'subscription' }, { platform: 'linux' }, { apiKeyPipe: 'C:/plaintext.env' },
  { readPipe: async () => 'ANTHROPIC_API_KEY=bad' }, { readPipe: async () => `ANTHROPIC_API_KEY=${key}\nEXTRA=bad` },
  { readPipe: async () => { throw Error(key); } }]) await assert.rejects(load(options), error => !error.message.includes(key));
const frame = `${JSON.stringify({ type: 'result', result: `x ${key} y ${key}`, total_cost_usd: 0 })}\n`;
for (let split = 0; split <= frame.length; split++) {
  const redactor = authentication.streamRedactor();
  const safe = redactor.write(Buffer.from(frame.slice(0, split))) + redactor.write(Buffer.from(frame.slice(split)));
  assert.equal(safe, frame.replaceAll(key, '[REDACTED_API_KEY]'), 'Complete result frame must pass immediately without waiting for close');
  assert.equal(redactor.end(), '');
}
const single = authentication.streamRedactor(); let safe = '';
for (const byte of Buffer.from(`é ${key} ${key} 🌲\n`)) safe += single.write(Buffer.from([byte]));
safe += single.end(); assert.equal(safe, 'é [REDACTED_API_KEY] [REDACTED_API_KEY] 🌲\n');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-decision-change-auth-test-'));
const home = path.join(root, 'home'), repoDir = path.join(root, 'repo');
fs.mkdirSync(path.join(repoDir, 'lib'), { recursive: true });
const env = prepareClaudeHome(home, { credentialFile: path.join(root, 'must-not-read-missing-oauth.json'), authentication });
assert.equal(fs.existsSync(path.join(home, '.claude/.credentials.json')), false);
assert.equal(env.ANTHROPIC_API_KEY, undefined, 'Serializable profile environment never contains the credential');
fs.writeFileSync(path.join(home, '.claude/.credentials.json'), '{}');
assert.throws(() => prepareClaudeHome(home, { authentication }), /without OAuth/);
fs.unlinkSync(path.join(home, '.claude/.credentials.json'));

const audit = preparePassiveAudit({ home, repoDir, sessionId: 'fake-audit' });
fs.writeFileSync(path.join(repoDir, 'lib/invoice.mjs'), `// ${key}`);
const hook = spawnSync(process.execPath, [fileURLToPath(new URL('../bench/decision-change/passive-audit.mjs', import.meta.url)), audit.configFile], {
  cwd: repoDir, env: spawnEnvironment(env, authentication), encoding: 'utf8', windowsHide: true,
  input: JSON.stringify({ session_id: 'fake-audit', cwd: repoDir, hook_event_name: 'PostToolUse', tool_name: 'Write',
    tool_use_id: 'fake-write', tool_input: {}, tool_response: key }),
});
assert.equal(hook.status, 0, hook.stderr);
fs.writeFileSync(path.join(repoDir, 'lib/invoice.mjs'), '// fixture');
for (const file of fs.readdirSync(audit.dir)) assert.equal(fs.readFileSync(path.join(audit.dir, file), 'utf8').includes(key), false, 'Passive receipt/snapshot redacted before persistence');
const fakeHook = path.join(root, 'fake-hook.mjs');
fs.writeFileSync(fakeHook, `process.stdout.write(process.env.ANTHROPIC_API_KEY);`);
for (const kind of ['klypix-notes', 'claude-mem']) {
  const auditFile = path.join(root, `${kind}-hook.jsonl`), wrapper = path.join(root, `${kind}-hook.mjs`);
  fs.writeFileSync(wrapper, kind === 'claude-mem' ? hookAuditSource(auditFile) : auditHookSource({ source: fakeHook, auditFile }));
  const result = spawnSync(process.execPath, [wrapper, ...(kind === 'claude-mem' ? [fakeHook] : [])], {
    env: spawnEnvironment(env, authentication), encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ session_id: 'fake-hook', hook_event_name: 'SessionStart' }),
  });
  assert.equal(result.status, 0); assert.equal(result.stdout, key, 'Native hook forwarding unchanged; stage redacts its stdout');
  assert.equal(fs.readFileSync(auditFile, 'utf8').includes(key), false);
  assert.ok(fs.readFileSync(auditFile, 'utf8').includes('[REDACTED_API_KEY]'));
}

if (process.platform === 'win32') {
  const bin = path.join(root, 'fake-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@"%dp0%\\fake-cli.cjs"');
  fs.writeFileSync(path.join(bin, 'fake-cli.cjs'), `const fs=require('node:fs');const args=process.argv.slice(2),key=process.env.ANTHROPIC_API_KEY;if(!key||process.env.CLAUDE_CODE_OAUTH_TOKEN)process.exit(17);for(const option of ['--settings','--mcp-config'])if(fs.readFileSync(args[args.indexOf(option)+1],'utf8').includes(key))process.exit(18);if(JSON.stringify(args).includes(key))process.exit(19);process.stderr.write(key.slice(0,20));process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0,modelUsage:{},result:key}).slice(0,60));setTimeout(()=>{process.stderr.write(key.slice(20));process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0,modelUsage:{},result:key}).slice(60)+'\\n');},20);`);
  const previous = process.env.PATH;
  process.env.PATH = `${bin};${path.join(process.env.SystemRoot || 'C:/Windows', 'System32')}`;
  try {
    const cli = resolveCli('claude');
    assert.equal(cli.command, process.execPath); assert.deepEqual(cli.prefix, [path.join(bin, 'fake-cli.cjs')]);
    for (const arm of ['notes-native', 'notes-notification', 'klypix-released', 'klypix-improved', 'claude-mem']) {
      const ledger = new BudgetLedger(path.join(root, `${arm}-ledger.jsonl`), { limitUsd: 2 });
      const result = await runClaudeStage({ approved: true, id: arm, role: 'fake', repoDir, home, authentication, prompt: 'fixture', sessionId: arm,
        config: { mcpServers: {} }, ledger, transcriptDir: path.join(root, 'artifacts', arm),
        limits: { model: 'fixture', stageBudgetUsd: .01, maxContextTokens: 10, maxOutputTokens: 10, inputWorstUsdPerMillion: 1, outputUsdPerMillion: 1, priceSource: 'offline-only' } });
      assert.equal(result.exitCode, 0); assert.equal(result.authentication.method, 'api-key');
      assert.equal(result.finalMessage, '[REDACTED_API_KEY]'); assert.equal(ledger.snapshot().halted, false);
    }
  } finally { process.env.PATH = previous; }
}
const scan = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  const file = path.join(dir, entry.name); if (entry.isDirectory()) scan(file);
  else assert.equal(fs.readFileSync(file).includes(Buffer.from(key)), false, `Credential leaked into artifact ${file}`);
} };
scan(root);
authentication.dispose(); assert.throws(() => authentication.applySpawnEnv({}), /disposed/);
console.log(JSON.stringify({ ok: true, modelCalls: 0, artifactRoot: root, checks: 'explicit transport, no fallback/OAuth, per-arm foreground spawn, chunk-safe immediate output, native passive receipts, artifact sentinel scan' }));
