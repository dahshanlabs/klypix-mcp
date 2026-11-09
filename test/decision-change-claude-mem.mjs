// No credentials, model calls, worker installs, or live profiles are used here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { BudgetLedger } from '../bench/decision-change/ledger.mjs';
import { createObserverBudgetBroker, observerWrapperSource, isolatedEnvironment,
  observerReservationUsd, OBSERVER_MODEL, claudeMemSettings, prepareClaudeMem, seedDefaultEmbeddingCache } from '../bench/decision-change/claude-mem.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-cmem-adapter-test-'));
let index = 0;
async function runWrapper({ body, limit = 10, armBudget = 5, model = OBSERVER_MODEL, args, bunPath, authMethod, apiKey }) {
  const dir = path.join(root, String(++index)); fs.mkdirSync(dir);
  const ledger = new BudgetLedger(path.join(dir, 'ledger.jsonl'), { limitUsd: limit });
  const broker = await createObserverBudgetBroker({ ledger, totalBudgetUsd: armBudget });
  const fake = path.join(dir, 'fake-cli.mjs'), wrapper = path.join(dir, 'wrapper.mjs');
  const marker = path.join(dir, 'argv.json');
  fs.writeFileSync(fake, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),outputCap:process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,haiku:process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,sonnet:process.env.ANTHROPIC_DEFAULT_SONNET_MODEL}));\n${body}`);
  fs.writeFileSync(wrapper, observerWrapperSource({ command: process.execPath, prefixArgs: [fake], model: OBSERVER_MODEL,
    brokerUrl: broker.url, brokerToken: broker.token, authMethod }));
  let command = process.execPath, prefix = [wrapper];
  if (bunPath) {
    command = path.join(dir, process.platform === 'win32' ? 'wrapper.exe' : 'wrapper'); prefix = [];
    const build = spawnSync(bunPath, ['build', '--compile', wrapper, '--outfile', command], {
      cwd: dir, env: isolatedEnvironment(dir), encoding: 'utf8', windowsHide: true, timeout: 180_000,
    });
    assert.equal(build.status, 0, 'Explicit test-only Bun must compile the fake observer proxy');
  }
  const output = await new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...(args || ['--model', model, '--output-format', 'stream-json'])], {
      env: { ...isolatedEnvironment(dir), ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fake observer timed out')); }, 12_000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end();
  });
  await broker.close();
  return { ...output, ledger: ledger.snapshot(), accounting: broker.snapshot(), marker: fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker)) : null };
}

try {
  const depHome = path.join(root, 'dependencies'), profileHome = path.join(root, 'profile');
  const suffix = '.cache/chroma/onnx_models/all-MiniLM-L6-v2/onnx';
  fs.mkdirSync(path.join(depHome, suffix), { recursive: true });
  assert.equal(seedDefaultEmbeddingCache(profileHome, depHome).seeded, false);
  for (const name of ['config.json', 'model.onnx', 'special_tokens_map.json', 'tokenizer_config.json', 'tokenizer.json', 'vocab.txt']) fs.writeFileSync(path.join(depHome, suffix, name), `synthetic ${name}`);
  fs.writeFileSync(path.join(depHome, suffix, 'claude-mem.db'), 'must not copy');
  const seeded = seedDefaultEmbeddingCache(profileHome, depHome);
  assert.equal(seeded.seeded, true);
  assert.equal(Object.keys(seeded.assets).length, 6);
  assert.equal(fs.existsSync(path.join(profileHome, suffix, 'claude-mem.db')), false, 'Only the six pretrained assets may cross trial profiles');
  assert.throws(() => seedDefaultEmbeddingCache(profileHome, depHome), /exist/i, 'Never overwrite an existing profile cache');
  assert.equal(observerReservationUsd(0.5), 1.96);
  assert.equal(observerReservationUsd(0.5, 'sonnet'), 6.31);
  const settings = claudeMemSettings({ dataDir: root, observerProfile: root, workerPort: 1234, observerExecutable: 'fixture' });
  assert.equal(settings.CLAUDE_MEM_MODEL, 'haiku');
  assert.equal(settings.CLAUDE_MEM_TIER_SMART_MODEL, 'sonnet');
  assert.equal(settings.CLAUDE_MEM_TIER_SUMMARY_MODEL, '');
  const apiSettings = claudeMemSettings({ dataDir: root, observerProfile: root, workerPort: 1234, observerExecutable: 'fixture', authMethod: 'api-key' });
  assert.deepEqual(apiSettings, { ...settings, CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'api-key' }, 'Billing changes only authentication; all native model/tier/feature settings remain equal');
  for (const key of ['CLAUDE_MEM_WORK_VIEW_AGENT', 'CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER', 'CLAUDE_MEM_CHROMA_ENABLED', 'CLAUDE_MEM_SEMANTIC_INJECT', 'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER']) assert.equal(settings[key], undefined, `${key} must inherit the pinned product default`);
  const env = isolatedEnvironment(root, { HOME: 'do-not-use', USERPROFILE: 'do-not-use', PATH: process.env.PATH,
    CLAUDE_MEM_DATA_DIR: 'live-memory', CLAUDE_CONFIG_DIR: 'live-settings', ANTHROPIC_API_KEY: 'synthetic-secret',
    OPENROUTER_API_KEY: 'synthetic-secret', KLYPIX_BRAIN_DIR: 'live-brain', GIT_DIR: 'live-git', GIT_WORK_TREE: 'live-tree',
    NODE_OPTIONS: '--require=live-hooks', NODE_PATH: 'live-packages', npm_config_userconfig: 'live-npm',
    UV_PYTHON: 'live-python', UV_INDEX_URL: 'live-index', PYTHONPATH: 'live-modules' });
  assert.equal(env.HOME, root); assert.equal(env.USERPROFILE, root);
  for (const key of ['CLAUDE_MEM_DATA_DIR', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'KLYPIX_BRAIN_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'NODE_OPTIONS', 'NODE_PATH', 'npm_config_userconfig', 'UV_PYTHON', 'UV_INDEX_URL', 'PYTHONPATH']) assert.equal(env[key], undefined);
  assert.equal(env.NPM_CONFIG_USERCONFIG, path.join(root, 'empty.npmrc'));
  assert.equal(env.GIT_CONFIG_GLOBAL, path.join(root, 'empty.gitconfig'));
  assert.equal(env.UV_MANAGED_PYTHON, '1');
  assert.equal(env.UV_PYTHON_INSTALL_REGISTRY, 'false');

  const success = await runWrapper({ body: `console.log(JSON.stringify({type:'result',total_cost_usd:0.12}));` });
  assert.equal(success.code, 0, success.stderr);
  assert.equal(success.ledger.spentCents, 12);
  assert.equal(success.ledger.reservedCents, 0);
  assert.equal(success.ledger.halted, false);
  assert.deepEqual(success.marker.args.slice(-2), ['--max-budget-usd', '0.5']);
  assert.equal(success.marker.outputCap, undefined, 'Preserve native SDK output settings; envelope reserves the full supported output');
  assert.equal(success.marker.haiku, 'claude-haiku-5-5');
  assert.equal(success.marker.sonnet, 'claude-sonnet-5-5');
  assert.equal(JSON.parse(success.stdout).total_cost_usd, 0.12, 'The SDK stream remains unchanged');

  const apiKey = `sk-ant-${'OFFLINE_CANARY_'.repeat(4)}`;
  const missingApi = await runWrapper({ authMethod: 'api-key', body: `throw Error('must not launch');` });
  assert.notEqual(missingApi.code, 0); assert.equal(missingApi.marker, null);
  assert.equal(missingApi.ledger.reservations.length, 0, 'Missing native API credentials refuse before reserve or OAuth fallback');
  const apiBody = `const key=process.env.ANTHROPIC_API_KEY; process.stdout.write(JSON.stringify({type:'system',echo:key}).slice(0,35)); process.stderr.write(key.slice(0,20)); setTimeout(()=>{process.stdout.write(JSON.stringify({type:'system',echo:key}).slice(35)+'\\n');process.stderr.write(key.slice(20)); console.log(JSON.stringify({type:'result',total_cost_usd:0.12,modelUsage:{'claude-haiku-5-5':{}}}));},20);`;
  const api = await runWrapper({ authMethod: 'api-key', apiKey, body: apiBody, bunPath: process.env.KLYPIX_TEST_BUN });
  assert.equal(api.code, 0, api.stderr); assert.equal(api.ledger.spentCents, 12);
  assert.equal(api.stdout.includes(apiKey) || api.stderr.includes(apiKey), false, 'Observer key never enters forwarded stdout/stderr');
  assert.ok(api.stdout.includes('[REDACTED_API_KEY]')); assert.equal(api.stderr, '[REDACTED_API_KEY]');
  assert.equal(JSON.stringify(api.marker).includes(apiKey), false, 'Observer argv and model receipts contain no credential');

  // The pinned SDK emits --model=haiku (Mr at bundle offset 4011693),
  // while its base format flags remain split tokens. Keep its argv intact.
  const sdkArgs = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--model=haiku'];
  const sdk = await runWrapper({ args: sdkArgs, body: `console.log(JSON.stringify({type:'result',total_cost_usd:0.12,modelUsage:{'claude-haiku-5-5':{}}}));` });
  assert.equal(sdk.code, 0, sdk.stderr); assert.equal(sdk.ledger.spentCents, 12);
  assert.deepEqual(sdk.marker.args.slice(0, sdkArgs.length), sdkArgs, 'Native SDK argument form is forwarded unchanged');
  const equals = await runWrapper({ args: ['--model=haiku', '--output-format=stream-json'],
    body: `console.log(JSON.stringify({type:'result',total_cost_usd:0.12}));` });
  assert.equal(equals.code, 0, equals.stderr);
  for (const args of [
    ['--output-format=stream-json'], ['--model=', '--output-format=stream-json'],
    ['--model', '--output-format=stream-json'], ['--model=unknown-model', '--output-format=stream-json'],
    ['--model=haiku', '--model=haiku', '--output-format=stream-json'],
    ['--model=haiku', '--model', 'sonnet', '--output-format=stream-json'],
    ['--model', 'haiku', '--model', 'sonnet', '--output-format', 'stream-json'],
    ['--model=haiku', '--input-format=stream-json'],
    ['--model=haiku', '--output-format=json', '--input-format=stream-json'],
    ['--model=haiku', '--output-format=stream-json', '--output-format', 'stream-json'],
    [...sdkArgs, '--max-budget-usd=999'], [...sdkArgs, '--max-budget-usd', '999'],
    ['--', ...sdkArgs],
  ]) {
    const rejected = await runWrapper({ args, body: `console.log('must not run');` });
    assert.notEqual(rejected.code, 0); assert.equal(rejected.marker, null);
    assert.equal(rejected.ledger.reservations.length, 0, 'Invalid/ambiguous options are refused before any reservation or child');
  }
  if (process.env.KLYPIX_TEST_BUN) {
    const compiled = await runWrapper({ args: sdkArgs, bunPath: process.env.KLYPIX_TEST_BUN,
      body: `console.log(JSON.stringify({type:'result',total_cost_usd:0.12,modelUsage:{'claude-haiku-5-5':{}}}));` });
    assert.equal(compiled.code, 0, compiled.stderr); assert.equal(compiled.ledger.spentCents, 12);
    assert.deepEqual(compiled.marker.args.slice(0, sdkArgs.length), sdkArgs, 'Actual Bun-compiled proxy accepts the pinned SDK form');
    const rejected = await runWrapper({ args: [...sdkArgs, '--model=sonnet'], bunPath: process.env.KLYPIX_TEST_BUN,
      body: `console.log('must not run');` });
    assert.notEqual(rejected.code, 0); assert.equal(rejected.marker, null);
    assert.equal(rejected.ledger.reservations.length, 0, 'Compiled proxy rejects ambiguous models before reserving');
  }

  const exhausted = await runWrapper({ limit: 1, body: `console.log(JSON.stringify({type:'result',total_cost_usd:0}));` });
  assert.notEqual(exhausted.code, 0); assert.equal(exhausted.marker, null, 'No child runs before reservation');
  assert.equal(exhausted.ledger.spentCents, 0);
  assert.equal(exhausted.accounting.refusals.length, 1, 'Global budget refusal must survive an empty native queue');

  const unpriced = await runWrapper({ model: 'some-other-model', body: `console.log('must not run');` });
  assert.notEqual(unpriced.code, 0); assert.equal(unpriced.marker, null);
  assert.equal(unpriced.ledger.reservations.length, 0);

  const smart = await runWrapper({ model: 'sonnet', armBudget: 8, body: `console.log(JSON.stringify({type:'result',total_cost_usd:0.23,modelUsage:{'claude-sonnet-5-5':{},'claude-haiku-5-5':{}}}));` });
  assert.equal(smart.code, 0, smart.stderr);
  assert.equal(smart.ledger.spentCents, 23, 'Default smart tier and native Haiku helper are metered');
  const noSmartHeadroom = await runWrapper({ model: 'sonnet', armBudget: 6, body: `console.log('must not run');` });
  assert.equal(noSmartHeadroom.marker, null, 'Sonnet needs its own worst-call envelope before it runs');
  assert.equal(noSmartHeadroom.accounting.refusals.length, 1, 'Arm budget refusal is visible to flush');

  const capped = await runWrapper({ body: `console.log(JSON.stringify({type:'result',subtype:'error_max_budget_usd',is_error:true,total_cost_usd:0.51}));` });
  assert.equal(capped.accounting.records[0].capped, true, 'Cap hits invalidate the trial while retaining real cost');
  assert.equal(capped.ledger.spentCents, 51);

  const unknown = await runWrapper({ body: `console.log(JSON.stringify({type:'result'}));` });
  assert.notEqual(unknown.code, 0);
  assert.equal(unknown.ledger.spentCents, 196, 'Missing receipt charges full cap plus overshoot margin');
  assert.equal(unknown.ledger.halted, true);

  const cumulative = await runWrapper({ body: `console.log(JSON.stringify({type:'result',total_cost_usd:0.04})); console.log(JSON.stringify({type:'result',total_cost_usd:0.13}));` });
  assert.equal(cumulative.ledger.spentCents, 13, 'Cumulative SDK costs must not be added twice');

  const regressed = await runWrapper({ body: `console.log(JSON.stringify({type:'result',total_cost_usd:0.13})); console.log(JSON.stringify({type:'result',total_cost_usd:0.01})); console.log(JSON.stringify({type:'result',total_cost_usd:0.14}));` });
  assert.equal(regressed.ledger.halted, true, 'A later valid result cannot erase a cost-counter reset');
  assert.equal(regressed.ledger.spentCents, 196);

  const unexpectedModel = await runWrapper({ body: `console.log(JSON.stringify({type:'result',total_cost_usd:0.01,modelUsage:{'unpriced-model':{}}}));` });
  assert.equal(unexpectedModel.ledger.halted, true, 'An unexpected observer model halts the shared budget');
  assert.equal(unexpectedModel.ledger.spentCents, 196, 'Unpriced output consumes the full reserved envelope');

  const brokerDir = path.join(root, 'broker'); fs.mkdirSync(brokerDir);
  const ledger = new BudgetLedger(path.join(brokerDir, 'ledger.jsonl'));
  const broker = await createObserverBudgetBroker({ ledger, totalBudgetUsd: 2 });
  const send = token => fetch(`${broker.url}/reserve`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: '{}' });
  assert.equal((await send('wrong')).status, 403);
  assert.equal((await send(broker.token)).status, 200);
  assert.equal((await send(broker.token)).status, 409, 'Arm envelope includes open child reservations');
  await broker.close(); assert.equal(ledger.snapshot().halted, true);

  const notReady = await prepareClaudeMem({ home: root, repoDir: root, env: {} });
  assert.equal(notReady.metadata.paidReady, false);
  await assert.rejects(notReady.start, /Missing explicit isolated prerequisite/);
  assert.equal(fs.existsSync(path.join(root, '.claude-mem-benchmark')), false, 'Unavailable adapter writes no profile');
  console.log('decision-change claude-mem adapter: isolated cap, receipts, refusal and accounting checks passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
