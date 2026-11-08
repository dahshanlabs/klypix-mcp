// Pinned competitor integration. This module never installs globally and never
// starts an observer until start() is called by the paid-run guard.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freshEnvironment } from './isolation.mjs';

const execFileAsync = promisify(execFile);
export const CLAUDE_MEM_VERSION = '15.12.0';
export const OBSERVER_MODEL = 'claude-haiku-5-5';
export const OBSERVER_MODEL_ALIASES = Object.freeze({ haiku: OBSERVER_MODEL, sonnet: 'claude-sonnet-5-5' });
export const OBSERVER_ENVELOPE = Object.freeze({
  model: OBSERVER_MODEL, contextTokens: 1_000_000, maxOutputTokens: 128_000,
  worstInputUsdPerMillion: 1, outputUsdPerMillion: 2.5,
  // Includes the costliest documented cache write and the higher long-context
  // output rate. The safety margin does NOT rely on the smaller output env cap.
  geographyMultiplier: 1.1, oneCallUsd: 1.452, verifiedAt: '2026-11-08',
  pricingSource: 'https://platform.claude.com/docs/en/about-claude/pricing',
  limitsSource: 'https://platform.claude.com/docs/en/models/overview',
});
export const OBSERVER_ENVELOPES = Object.freeze({
  [OBSERVER_MODEL]: OBSERVER_ENVELOPE,
  'claude-sonnet-5-5': Object.freeze({ ...OBSERVER_ENVELOPE, model: 'claude-sonnet-5-5',
    worstInputUsdPerMillion: 4, outputUsdPerMillion: 10, oneCallUsd: 5.808 }),
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const roundUp = n => Math.ceil((n - 1e-9) * 100) / 100;
const positive = (n, name) => { if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be positive`); return n; };
const DEFAULT_EMBEDDING_ASSETS = ['config.json', 'model.onnx', 'special_tokens_map.json', 'tokenizer_config.json', 'tokenizer.json', 'vocab.txt'];

// Seed only the vendor's default pretrained files. Never copy a Chroma index,
// collection, database, observation, or session between benchmark profiles.
export function seedDefaultEmbeddingCache(home, dependencyHome) {
  const suffix = '.cache/chroma/onnx_models/all-MiniLM-L6-v2/onnx';
  const source = path.join(dependencyHome, suffix), target = path.join(home, suffix);
  if (path.resolve(source) === path.resolve(target)) return { seeded: false, reason: 'Same dependency and profile home' };
  if (!DEFAULT_EMBEDDING_ASSETS.every(name => {
    try { return fs.lstatSync(path.join(source, name)).isFile(); } catch { return false; }
  })) return { seeded: false, reason: 'Default model cache absent or incomplete; native download remains enabled' };
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const assets = {};
  for (const name of DEFAULT_EMBEDDING_ASSETS) {
    fs.copyFileSync(path.join(source, name), path.join(target, name), fs.constants.COPYFILE_EXCL);
    assets[name] = createHash('sha256').update(fs.readFileSync(path.join(target, name))).digest('hex');
  }
  return { seeded: true, model: 'all-MiniLM-L6-v2', assets };
}

export function observerReservationUsd(processCapUsd, model = OBSERVER_MODEL) {
  const envelope = OBSERVER_ENVELOPES[OBSERVER_MODEL_ALIASES[model] || model];
  if (!envelope) throw new Error('Unpriced observer model refused');
  return roundUp(positive(processCapUsd, 'Observer process cap') + envelope.oneCallUsd);
}

export function isolatedEnvironment(home, env = process.env, dependencyHome = home) {
  if (!path.isAbsolute(dependencyHome)) throw new Error('Dependency cache home must be absolute');
  const isolated = freshEnvironment(home, env);
  for (const key of Object.keys(isolated)) if (/^(?:UV_|PYTHON|CONDA|HF_|TRANSFORMERS_)/i.test(key)) delete isolated[key];
  return { ...isolated,
    UV_CACHE_DIR: path.join(dependencyHome, '.cache/uv'), UV_PYTHON_INSTALL_DIR: path.join(dependencyHome, '.local/share/uv/python'),
    UV_TOOL_DIR: path.join(dependencyHome, '.local/share/uv/tools'), HF_HOME: path.join(dependencyHome, '.cache/huggingface'),
    // The Windows Store alias can point into the remapped LOCALAPPDATA and
    // produce a broken trampoline. Use the same Python version, installed only
    // in this benchmark's dependency directory, without host registration.
    UV_MANAGED_PYTHON: '1', UV_PYTHON_NO_REGISTRY: '1',
    UV_PYTHON_INSTALL_REGISTRY: 'false', UV_PYTHON_INSTALL_BIN: 'false', UV_NO_MODIFY_PATH: '1',
  };
}

export function claudeMemSettings({ dataDir, observerProfile, workerPort, observerExecutable }) {
  return {
    CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_WORKER_PORT: String(workerPort),
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_RUNTIME: 'worker',
    CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription',
    CLAUDE_MEM_CLAUDE_CONFIG_DIR: observerProfile, CLAUDE_CODE_PATH: observerExecutable,
    // Preserve the published defaults, including the distinct smart tier.
    // Only alias resolution in the accounting proxy is pinned for reproducibility.
    CLAUDE_MEM_MODEL: 'haiku', CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',
    CLAUDE_MEM_TIER_SIMPLE_MODEL: 'haiku', CLAUDE_MEM_TIER_SUMMARY_MODEL: '',
    CLAUDE_MEM_TIER_FAST_MODEL: 'haiku', CLAUDE_MEM_TIER_SMART_MODEL: 'sonnet',
    CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: 'true',
    CLAUDE_MEM_CONTEXT_PROJECTS: 'current', CLAUDE_MEM_OBSERVER_ENABLED: 'true',
    CLAUDE_MEM_MAX_CONCURRENT_AGENTS: '2',
    CLAUDE_MEM_ONLINE_OPTIN: 'false',
  };
}

// The published hook handlers stay unchanged. Resolve their launcher to the
// pinned local CLI instead of relying on a global PATH installation. Setup's
// installer and ensure-launcher are unnecessary: this adapter supplies both.
export function nativeHookSettings(manifest, cliPath, pluginRoot, nodePath = process.execPath, { auditWrapper, bunPath, workerScript } = {}) {
  const hooks = {};
  for (const [event, entries] of Object.entries(manifest.hooks || {})) {
    if (event === 'Setup') continue;
    const mapped = entries.map(entry => ({ ...entry, hooks: entry.hooks.flatMap(hook => {
      if (hook.command === 'claude-mem' && hook.args?.[0] === 'start' && bunPath && workerScript) return [{ ...hook, command: bunPath, args: [workerScript, 'start'] }];
      if (hook.command === 'claude-mem') return [{ ...hook, command: nodePath,
        args: [...(auditWrapper && hook.args?.[0] === 'hook' ? [auditWrapper] : []), cliPath, ...(hook.args || [])] }];
      if (hook.args?.some(arg => arg.includes('ensure-launcher.cjs'))) return [];
      throw new Error(`Unreviewed ${CLAUDE_MEM_VERSION} hook launcher in ${event}`);
    }) })).filter(entry => entry.hooks.length);
    if (mapped.length) hooks[event] = mapped;
  }
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']) {
    if (!hooks[event]?.length) throw new Error(`Missing native capture hook ${event}`);
  }
  return { hooks, env: { CLAUDE_PLUGIN_ROOT: pluginRoot } };
}

export function hookAuditSource(auditFile) {
  return `import fs from 'node:fs';import {spawn} from 'node:child_process';
const [cli,...args]=process.argv.slice(2);const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const input=Buffer.concat(chunks);let event={};try{event=JSON.parse(input.toString());}catch{}
const child=spawn(process.execPath,[cli,...args],{env:process.env,stdio:['pipe','pipe','pipe'],windowsHide:true});let output='',truncated=false;
child.stdout.on('data',chunk=>{process.stdout.write(chunk);if(output.length+chunk.length<=4194304)output+=chunk.toString();else truncated=true;});child.stderr.pipe(process.stderr);
child.on('error',()=>process.exit(1));child.on('close',code=>{if(code===0&&['SessionStart','UserPromptSubmit','PreToolUse'].includes(event.hook_event_name)){try{fs.appendFileSync(${JSON.stringify(auditFile)},JSON.stringify({sessionId:event.session_id,hookEvent:event.hook_event_name,role:process.env.BENCH_DECISION_ROLE||null,exitCode:code,stdout:output,truncated,at:new Date().toISOString()})+'\\n',{mode:0o600});}catch{process.stderr.write('Benchmark hook exposure audit could not be written.\\n');}}process.exit(code??1);});child.stdin.end(input);
`;
}

/** One loopback broker shares the parent's durable ledger with native children. */
export async function createObserverBudgetBroker({ ledger, totalBudgetUsd, processCapUsd = 0.5, enabled = true }) {
  positive(totalBudgetUsd, 'Observer total budget');
  positive(processCapUsd, 'Observer process cap');
  const token = randomBytes(24).toString('hex');
  const records = new Map();
  const refusals = [];
  let spent = 0, reserved = 0, accepting = enabled, stopping = false;
  const server = http.createServer(async (req, res) => {
    const answer = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) return answer(403, { error: 'Denied' });
    let raw = '';
    try {
      for await (const chunk of req) { raw += chunk; if (raw.length > 16_384) throw new Error('Oversized observer accounting request'); }
      const body = JSON.parse(raw || '{}');
      if (req.url === '/reserve') {
        const model = OBSERVER_MODEL_ALIASES[body.model] || body.model || OBSERVER_MODEL;
        const reserveUsd = observerReservationUsd(processCapUsd, model);
        if (!accepting) throw new Error('Observer model calls are not enabled');
        if (spent + reserved + reserveUsd > totalBudgetUsd + 1e-9) {
          refusals.push({ model, reserveUsd, reason: 'Observer arm envelope exhausted', at: new Date().toISOString() });
          throw new Error('Observer envelope exhausted');
        }
        const id = `claude-mem-observer-${randomUUID()}`;
        try {
          ledger.reserve({ id, kind: 'observer', maxUsd: reserveUsd,
            meta: { version: CLAUDE_MEM_VERSION, model, processCapUsd, oneCallMarginUsd: OBSERVER_ENVELOPES[model].oneCallUsd } });
        } catch (error) {
          refusals.push({ model, reserveUsd, reason: String(error.message).slice(0, 250), at: new Date().toISOString() });
          throw error;
        }
        reserved += reserveUsd;
        records.set(id, { id, model, reserveUsd, status: 'reserved', cost: null, inFlight: true, pid: body.pid, childPid: null, capped: false });
        return answer(200, { id, processCapUsd, reservedUsd: reserveUsd });
      }
      const record = records.get(body.id);
      if (!record || record.status !== 'reserved') throw new Error('No open observer reservation');
      if (req.url === '/heartbeat') return answer(200, { stop: stopping });
      if (req.url === '/progress') {
        if (typeof body.inFlight !== 'boolean') throw new Error('Missing observer flight state');
        if (body.cost !== undefined) {
          if (!Number.isFinite(body.cost) || body.cost < 0 || (record.cost !== null && body.cost < record.cost)) throw new Error('Invalid cumulative observer cost');
          record.cost = body.cost;
        }
        record.inFlight = body.inFlight;
        if (body.capped === true) record.capped = true;
        if (Number.isSafeInteger(body.childPid)) record.childPid = body.childPid;
        return answer(200, { ok: true });
      }
      if (req.url === '/settle') {
        settle(record, body.known === true && !record.inFlight && record.cost !== null);
        return answer(200, { ok: true });
      }
      answer(404, { error: 'Unknown operation' });
    } catch (error) { answer(409, { error: String(error.message).slice(0, 250) }); }
  });
  function settle(record, known) {
    const reserveUsd = record.reserveUsd;
    record.status = known ? 'settled' : 'unknown'; reserved -= reserveUsd;
    spent += known ? roundUp(record.cost) : reserveUsd;
    if (known) ledger.settle(record.id, { actualUsd: record.cost, usage: { model: record.model, capped: record.capped, accounting: 'CLI-reported API-equivalent', version: CLAUDE_MEM_VERSION } });
    else { accepting = false; ledger.unknown(record.id, { reason: 'Observer exited without a finalized, idle cost receipt' }); }
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`, token,
    enable() { if (stopping) throw new Error('Observer broker is closing'); accepting = true; },
    snapshot: () => ({ spentUsd: spent, reservedUsd: reserved, records: [...records.values()].map(r => ({ ...r })), refusals: [...refusals] }),
    async drain({ deadlineMs = 10_000 } = {}) {
      accepting = false; stopping = true;
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline && [...records.values()].some(r => r.status === 'reserved')) await sleep(100);
      return ![...records.values()].some(r => r.status === 'reserved');
    },
    async close() {
      accepting = false;
      // The caller stops the worker/process trees first. A missing child receipt
      // is uncertainty, not zero spend; never infer success from an empty queue.
      for (const record of records.values()) if (record.status === 'reserved') settle(record, false);
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/** Compile this unchanged protocol proxy as a native executable on Windows. */
export function observerWrapperSource(config) {
  return `import { spawn } from 'node:child_process';
const config=${JSON.stringify({ ...config, aliases: OBSERVER_MODEL_ALIASES, pricedModels: Object.keys(OBSERVER_ENVELOPES), fastModel: OBSERVER_MODEL })};
const args=process.argv.slice(2);
const probe=(args.length===1&&['--version','-v','--help','-h'].includes(args[0]))||(JSON.stringify(args)===JSON.stringify(['--permission-mode','dontAsk','--version']))||(args[0]==='auth'&&args[1]==='status'&&args.slice(2).every(a=>a==='--json'));
async function post(route,body){const r=await fetch(config.brokerUrl+route,{method:'POST',headers:{authorization:'Bearer '+config.brokerToken,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const v=await r.json();if(!r.ok)throw Error(v.error||'Observer budget denied');return v;}
let child,grant,known=false,cost=null,inFlight=true,chain=Promise.resolve(),lastResult=false,accountingFailed=false;
try {
 if(probe){child=spawn(config.command,[...(config.prefixArgs||[]),...args],{env:process.env,stdio:'inherit',windowsHide:true});child.on('error',()=>process.exit(1));child.on('close',code=>process.exit(code??1));}
 else {
  const modelIndex=args.indexOf('--model');
  const requestedModel=args[modelIndex+1], model=config.aliases[requestedModel]||requestedModel;
  if(modelIndex<0||!config.pricedModels.includes(model))throw Error('Unpriced observer model refused');
  const allowedModels=[model,config.fastModel];
  if(args.some(a=>a==='--max-budget-usd'||a.startsWith('--max-budget-usd=')))throw Error('Unexpected observer budget flag');
  if(!args.includes('stream-json'))throw Error('Observer requires stream-json cost receipts');
  grant=await post('/reserve',{pid:process.pid,model});
  const childEnv={...process.env,ANTHROPIC_DEFAULT_HAIKU_MODEL:config.aliases.haiku,ANTHROPIC_DEFAULT_SONNET_MODEL:config.aliases.sonnet,ANTHROPIC_SMALL_FAST_MODEL:config.fastModel};
  delete childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  child=spawn(config.command,[...(config.prefixArgs||[]),...args,'--max-budget-usd',String(grant.processCapUsd)],{env:childEnv,stdio:['pipe','pipe','pipe'],windowsHide:true});
  await post('/progress',{id:grant.id,inFlight:true,childPid:child.pid});
  child.stderr.pipe(process.stderr);
  let input='',output='';
  const queue=fn=>{chain=chain.then(fn).catch(error=>{accountingFailed=true;known=false;child.kill();process.stderr.write('Observer accounting stopped: '+error.message+'\\n');});};
  const heartbeat=setInterval(()=>queue(async()=>{const control=await post('/heartbeat',{id:grant.id});if(control.stop&&!inFlight){child.stdin.end();}}),300);
  process.stdin.on('data',chunk=>{input+=chunk.toString();let i;while((i=input.indexOf('\\n'))>=0){const line=input.slice(0,i);input=input.slice(i+1);queue(async()=>{let frame;try{frame=JSON.parse(line);}catch{}if(frame?.type==='user'){inFlight=true;lastResult=false;await post('/progress',{id:grant.id,inFlight:true});}child.stdin.write(line+'\\n');});}});
  process.stdin.on('end',()=>queue(async()=>{if(input)child.stdin.write(input);child.stdin.end();}));
  child.stdout.on('data',chunk=>{process.stdout.write(chunk);output+=chunk.toString();let i;while((i=output.indexOf('\\n'))>=0){const line=output.slice(0,i);output=output.slice(i+1);let frame;try{frame=JSON.parse(line);}catch{}if(frame?.type==='result'){if(Object.keys(frame.modelUsage||{}).some(used=>!allowedModels.includes(used))){accountingFailed=true;known=false;lastResult=false;child.kill();continue;}if(Number.isFinite(frame.total_cost_usd)&&frame.total_cost_usd>=0&&!(frame.is_error&&frame.total_cost_usd===0)&&(cost===null||frame.total_cost_usd>=cost)){cost=frame.total_cost_usd;inFlight=false;known=true;lastResult=true;const receipt={id:grant.id,inFlight:false,cost,capped:frame.subtype==='error_max_budget_usd'};queue(()=>post('/progress',receipt));}else{accountingFailed=true;known=false;lastResult=false;child.kill();}}}});
  child.on('error',()=>{known=false;});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
  child.on('close',async code=>{clearInterval(heartbeat);process.stdin.pause();await chain;const settledKnown=!accountingFailed&&known&&lastResult&&!inFlight;try{await post('/settle',{id:grant.id,known:settledKnown});}catch{process.exitCode=1;}if(!settledKnown)process.stderr.write('Observer final cost unavailable; full reservation charged and ledger halted.\\n');process.exit(process.exitCode||code||(settledKnown?0:1));});
 }
}catch(error){process.stderr.write('Observer launch refused: '+error.message+'\\n');if(grant)try{await post('/settle',{id:grant.id,known:false});}catch{}process.exit(1);}
`;
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve)); return port;
}
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }

export async function prepareClaudeMem({ repoDir, home, ledger, observerBudgetUsd, env = process.env,
  packageDir = env.KLYPIX_BENCH_CLAUDE_MEM_PACKAGE, bunPath = env.KLYPIX_BENCH_BUN,
  claudePath = env.KLYPIX_BENCH_CLAUDE_EXE, credentialFile,
  processCapUsd = 0.5, dependencyHome = home } = {}) {
  const metadata = { paidReady: false, version: CLAUDE_MEM_VERSION, observerEnvelope: OBSERVER_ENVELOPE,
    observerEnvelopes: OBSERVER_ENVELOPES, observerAliases: OBSERVER_MODEL_ALIASES,
    source: `https://github.com/thedotmack/claude-mem/tree/v${CLAUDE_MEM_VERSION}`,
    readme: `https://github.com/thedotmack/claude-mem/blob/v${CLAUDE_MEM_VERSION}/README.md#quick-start`,
    defaultsSource: `https://github.com/thedotmack/claude-mem/blob/v${CLAUDE_MEM_VERSION}/src/shared/SettingsDefaultsManager.ts`,
    runtime: 'worker', configuration: 'README-supported Claude subscription provider; native handlers and shipped memory-search skill; isolated worker',
    deviations: ['Absolute pinned CLI replaces global hook launcher; installer-only hooks omitted',
      'README-supported no-sign-in Claude subscription path selected; hosted trial/account not used',
      'Haiku/Sonnet aliases resolved to verified current IDs; default tier routing, capture, recall, Chroma and My Work retained',
      'Include all sources enabled using the README documented cross-host option; telemetry disabled',
      'Observer CLI dollar cap plus worst-one-call reservation; cap-hit runs invalid, API-equivalent cost, subscription invoice unknown'] };
  const unavailable = reason => ({ id: 'claude-mem', label: `claude-mem ${CLAUDE_MEM_VERSION}`, version: CLAUDE_MEM_VERSION,
    agentConfig: null, metadata: { ...metadata, reason },
    start: async () => { throw new Error(reason); }, flush: async () => ({ ok: false, details: reason }), close: async () => {} });
  if (!home || !repoDir || !path.isAbsolute(home) || !path.isAbsolute(repoDir)) throw new Error('Absolute fresh home and repository required');
  for (const [name, file] of Object.entries({ packageDir, bunPath, claudePath })) {
    if (!file || !path.isAbsolute(file) || !fs.existsSync(file)) return unavailable(`Missing explicit isolated prerequisite: ${name}`);
  }
  if (!ledger || !observerBudgetUsd || observerBudgetUsd < observerReservationUsd(processCapUsd, 'sonnet')) return unavailable('No sufficient shared observer budget envelope for the default Haiku and Sonnet tiers');
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (pkg.name !== 'claude-mem' || pkg.version !== CLAUDE_MEM_VERSION) throw new Error('claude-mem package must be pinned to 15.12.0');
  const credentialSource = credentialFile || path.join(home, '.claude', '.credentials.json');
  if (!fs.existsSync(credentialSource)) return unavailable('No authorized Claude OAuth credential file available');
  const credentials = JSON.parse(fs.readFileSync(credentialSource, 'utf8'));
  const oauth = credentials.claudeAiOauth;
  if (!oauth?.accessToken || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= Date.now() + 5 * 60_000) return unavailable('Claude OAuth credential unavailable or near expiry; no interactive login attempted');
  const root = path.join(fs.realpathSync(home), '.claude-mem-benchmark');
  if (fs.existsSync(root)) throw new Error('Refusing to reuse a claude-mem benchmark profile');
  fs.mkdirSync(root, { mode: 0o700 });
  const observerProfile = path.join(root, 'observer-profile'), dataDir = path.join(root, 'data'), binDir = path.join(root, 'bin');
  for (const dir of [observerProfile, dataDir, binDir, path.join(home, 'tmp')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const authCopy = path.join(observerProfile, '.credentials.json');
  // Only the OAuth credential is copied; no MCP tokens, settings, memory or projects.
  writeJson(authCopy, { claudeAiOauth: oauth });
  let broker;
  try {
  if (process.platform === 'win32') {
    const principal = `${env.USERDOMAIN ? `${env.USERDOMAIN}\\` : ''}${env.USERNAME}`;
    if (!env.USERNAME) throw new Error('Cannot restrict temporary credential ACL without the Windows account name');
    await execFileAsync('icacls.exe', [observerProfile, '/inheritance:r', '/grant:r', `${principal}:(OI)(CI)F`], { windowsHide: true });
    await execFileAsync('icacls.exe', [authCopy, '/inheritance:r', '/grant:r', `${principal}:F`], { windowsHide: true });
  }
  const vendor = path.join(root, 'vendor'); fs.cpSync(packageDir, vendor, { recursive: true });
  const pluginRoot = path.join(vendor, 'plugin'), cli = path.join(vendor, 'dist/npx-cli/index.js');
  // Load the shipped skill text through a local plugin; hooks/MCP are supplied
  // explicitly below so they run once, with absolute pinned launchers.
  const skillPlugin = path.join(root, 'skill-plugin');
  fs.mkdirSync(path.join(skillPlugin, '.claude-plugin'), { recursive: true });
  fs.copyFileSync(path.join(pluginRoot, '.claude-plugin/plugin.json'), path.join(skillPlugin, '.claude-plugin/plugin.json'));
  fs.cpSync(path.join(pluginRoot, 'skills'), path.join(skillPlugin, 'skills'), { recursive: true });
  const isolatedEnv = isolatedEnvironment(home, env, dependencyHome);
  metadata.defaultEmbeddingCache = seedDefaultEmbeddingCache(home, dependencyHome);
  const port = await freePort();
  broker = await createObserverBudgetBroker({ ledger, totalBudgetUsd: observerBudgetUsd, processCapUsd, enabled: false });
  const wrapperJs = path.join(binDir, 'observer-wrapper.js');
  const wrapperExe = path.join(binDir, process.platform === 'win32' ? 'observer-wrapper.exe' : 'observer-wrapper');
  fs.writeFileSync(wrapperJs, observerWrapperSource({ command: claudePath, model: OBSERVER_MODEL,
    brokerUrl: broker.url, brokerToken: broker.token }), { mode: 0o600 });
  await execFileAsync(bunPath, ['build', '--compile', wrapperJs, '--outfile', wrapperExe], { cwd: root, env: isolatedEnv, windowsHide: true, timeout: 180_000 });
  const help = await execFileAsync(wrapperExe, ['--help'], { env: isolatedEnv, windowsHide: true, timeout: 15_000 });
  if (!help.stdout.includes('--max-budget-usd')) throw new Error('Observer Claude CLI has no dollar-cap flag');
  const settings = claudeMemSettings({ dataDir, observerProfile, workerPort: port, observerExecutable: wrapperExe });
  writeJson(path.join(dataDir, 'settings.json'), settings);
  const runEnv = { ...isolatedEnv, ...settings, CLAUDE_PLUGIN_ROOT: pluginRoot,
    BUN_INSTALL: path.dirname(path.dirname(bunPath)), PATH: `${path.dirname(bunPath)}${path.delimiter}${isolatedEnv.PATH || isolatedEnv.Path || ''}` };
  const hookAuditFile = path.join(root, 'hook-exposure.jsonl'), hookAuditWrapper = path.join(binDir, 'hook-audit.mjs');
  fs.writeFileSync(hookAuditWrapper, hookAuditSource(hookAuditFile), { mode: 0o600 });
  const workerScript = path.join(pluginRoot, 'scripts/worker-service.cjs');
  const nativeSettings = nativeHookSettings(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks/hooks.json'), 'utf8')), cli, pluginRoot, process.execPath,
    { auditWrapper: hookAuditWrapper, bunPath, workerScript });
  let started = false, closed = false;
  Object.assign(metadata, { paidReady: true, workerPort: port, sourceHashes: {
    cli: sha256(cli), hooks: sha256(path.join(pluginRoot, 'hooks/hooks.json')),
    worker: sha256(path.join(pluginRoot, 'scripts/worker-service.cjs')), nativeClaude: sha256(claudePath) },
    observerProcessCapUsd: processCapUsd, observerReservationUsd: observerReservationUsd(processCapUsd),
    observerReservationsUsd: Object.fromEntries(Object.keys(OBSERVER_ENVELOPES).map(model => [model, observerReservationUsd(processCapUsd, model)])), observerBudgetUsd,
    dependencyHome, semanticReadiness: { ok: false, reason: 'Not yet checked through native search' } });
  // Same worker entry point as the package's worker:start/worker:stop scripts;
  // the npx start alias otherwise requires a global install receipt.
  const runCli = args => execFileAsync(bunPath, [workerScript, ...args], { cwd: repoDir, env: runEnv, windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  return {
    id: 'claude-mem', label: `claude-mem ${CLAUDE_MEM_VERSION}`, version: CLAUDE_MEM_VERSION, metadata,
    accounting: () => broker.snapshot(),
    agentConfig: { env: runEnv, settings: nativeSettings, claudeArgs: ['--plugin-dir', skillPlugin], mcpServers: {
      'mcp-search': { command: process.execPath, args: [path.join(pluginRoot, 'scripts/mcp-server.cjs')], env: runEnv },
    } },
    exposureEvidence({ sessionId } = {}) {
      if (!sessionId || !fs.existsSync(hookAuditFile)) return [];
      return fs.readFileSync(hookAuditFile, 'utf8').split('\n').filter(Boolean).flatMap(line => {
        try { const record = JSON.parse(line); return record.sessionId === sessionId && record.exitCode === 0 && !record.truncated ? [record] : []; }
        catch { return []; }
      });
    },
    async start({ allowPaid = false } = {}) {
      if (closed) throw new Error('Adapter closed');
      started = true; // close() must stop a partially initialized worker too.
      // The vendor start command can hit its own readiness deadline while a
      // fresh Windows database is still initializing. Check our isolated port
      // rather than restart the daemon or count this as a memory failure.
      const deadline = Date.now() + 120_000;
      let coreReady = false;
      try { await runCli(['start']); } catch { metadata.startCommandNeededReadinessWait = true; }
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
          const health = await r.json();
          const ready = await fetch(`http://127.0.0.1:${port}/api/readiness`, { signal: AbortSignal.timeout(3000) });
          if (r.ok && health.version === CLAUDE_MEM_VERSION && ready.ok) { coreReady = true; break; }
        } catch { /* Cold-start readiness is bounded by the outer deadline. */ }
        await sleep(300);
      }
      if (!coreReady) throw new Error('Pinned claude-mem worker did not become ready within 120 seconds');
      // Empty-project search starts the native lazy Chroma dependency path.
      // A silent FTS fallback must never become a measured competitor loss.
      try {
        const search = await fetch(`http://127.0.0.1:${port}/api/search?query=benchmark%20dependency%20readiness&project=_benchmark_setup_`, { signal: AbortSignal.timeout(150_000) });
        await search.text();
        const doctor = await (await fetch(`http://127.0.0.1:${port}/api/admin/doctor`, { signal: AbortSignal.timeout(3000) })).json();
        const semanticOk = search.ok && doctor.health?.dependencies?.degraded === false && doctor.processes?.some(p => p.id === 'chroma-mcp' && p.status === 'alive');
        metadata.semanticReadiness = { ok: Boolean(semanticOk), dependencies: doctor.health?.dependencies, chroma: doctor.health?.chroma };
        if (!semanticOk) throw new Error('Native Chroma search is not ready; refusing a degraded benchmark');
      } catch (error) {
        metadata.paidReady = false;
        metadata.reason = `Native semantic setup failed: ${error.message}`;
        throw new Error(metadata.reason);
      }
      if (allowPaid) broker.enable();
    },
    async flush({ deadlineMs = 60_000 } = {}) {
      if (!started) return { ok: false, details: 'Worker not started through the paid-run guard' };
      const deadline = Date.now() + Math.min(deadlineMs, 120_000); let consecutive = 0, last = null;
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/processing-status`, { signal: AbortSignal.timeout(3000) });
          last = await r.json();
          if (broker.snapshot().records.some(record => record.status === 'unknown')) return { ok: false, details: 'Observer accounting uncertain; ledger halted' };
          if (broker.snapshot().refusals.length || broker.snapshot().records.some(record => record.capped)) return { ok: false, isBudgetLimited: true, details: 'Observer dollar cap or reservation refusal interrupted native processing; trial is budget-limited, not a product failure', accounting: broker.snapshot() };
          const health = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) })).json();
          if (health.dependencies?.degraded) return { ok: false, isSetupFailure: true, details: 'Native claude-mem dependency degraded during capture', dependencies: health.dependencies, accounting: broker.snapshot() };
          if (r.ok && last.isProcessing === false && Number(last.queueDepth) === 0) consecutive++; else consecutive = 0;
          if (consecutive >= 3) return { ok: true, details: last, accounting: broker.snapshot() };
        } catch { consecutive = 0; }
        await sleep(300);
      }
      return { ok: false, details: { reason: 'Observer did not drain before deadline', last }, accounting: broker.snapshot() };
    },
    async close() {
      if (closed) return; closed = true;
      try { await broker.drain(); if (started) await runCli(['stop']); }
      finally { await broker.close(); fs.rmSync(authCopy, { force: true }); }
    },
  };
  } catch (error) {
    if (broker) await broker.close();
    fs.rmSync(authCopy, { force: true });
    throw error;
  }
}
