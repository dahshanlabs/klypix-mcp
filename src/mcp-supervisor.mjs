// Stable stdio supervisor for KLYPIX MCP workers.
//
// MCP hosts own the stdio connection and commonly keep it for the full app
// lifetime. Replacing server files on disk therefore cannot update a running
// process. This supervisor keeps that host-owned connection stable while a
// replaceable worker handles the protocol behind it.
//
// Upgrade contract:
//   1. installers stage the complete worker bundle;
//   2. `.mcp-runtime.json` is atomically committed last;
//   3. the supervisor boots and initializes the candidate in parallel;
//   4. it verifies the advertised version + tool compatibility;
//   5. it replays the active brain_sync task scope;
//   6. it switches only between requests and emits tools/list_changed.
//
// A broken or incompatible candidate never replaces the live worker. The old
// worker remains warm for a short rollback grace after a successful switch.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

const INTERNAL_PREFIX = '__klypix_supervisor__';
const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ROLLBACK_GRACE_MS = 3000;

const log = (...args) => console.error('[klypix-supervisor]', ...args);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const idKey = (id) => JSON.stringify(id);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isAlivePid = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};
const within = (root, target) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
};
const atomicJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
};
const parseSemver = (value) => {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
};
const compareSemver = (a, b) => {
  const aa = parseSemver(a), bb = parseSemver(b);
  if (!aa || !bb) return null;
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
};
const readBakedVersion = (file) => {
  try {
    const source = fs.readFileSync(file, 'utf8');
    return source.match(/const PKG_VERSION = ['"]([^'"]+)['"]/)?.[1] || null;
  } catch { return null; }
};

function createLineReader(onMessage, onError) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    for (;;) {
      const index = buffered.indexOf(10);
      if (index < 0) return;
      const raw = buffered.subarray(0, index).toString('utf8').replace(/\r$/, '');
      buffered = buffered.subarray(index + 1);
      if (!raw.trim()) continue;
      try { onMessage(JSON.parse(raw)); }
      catch (error) { onError(error, raw); }
    }
  };
}

function stripSchemaDocs(value) {
  if (Array.isArray(value)) return value.map(stripSchemaDocs);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (['description', 'title', '$comment', 'examples', 'default'].includes(key)) continue;
    out[key] = stripSchemaDocs(child);
  }
  return out;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Conservative input-compatibility check. New optional fields and wider enums
// are safe; removed fields, newly-required fields, narrower enums, and semantic
// schema changes require a host reconnect instead of a transparent swap.
function schemaAcceptsPrevious(oldSchema = {}, nextSchema = {}) {
  const oldClean = stripSchemaDocs(oldSchema || {});
  const nextClean = stripSchemaDocs(nextSchema || {});
  const oldRequired = new Set(Array.isArray(oldClean.required) ? oldClean.required : []);
  const nextRequired = new Set(Array.isArray(nextClean.required) ? nextClean.required : []);
  for (const name of nextRequired) if (!oldRequired.has(name)) return false;

  const oldProps = oldClean.properties && typeof oldClean.properties === 'object' ? oldClean.properties : {};
  const nextProps = nextClean.properties && typeof nextClean.properties === 'object' ? nextClean.properties : {};
  for (const [name, oldProp] of Object.entries(oldProps)) {
    const nextProp = nextProps[name];
    if (!nextProp) return false;
    const oldEnum = Array.isArray(oldProp?.enum) ? oldProp.enum : null;
    const nextEnum = Array.isArray(nextProp?.enum) ? nextProp.enum : null;
    if (oldEnum && nextEnum) {
      if (oldEnum.some(value => !nextEnum.some(candidate => sameJson(candidate, value)))) return false;
      const oldWithout = { ...oldProp }; delete oldWithout.enum;
      const nextWithout = { ...nextProp }; delete nextWithout.enum;
      if (!sameJson(oldWithout, nextWithout)) return false;
    } else if (!sameJson(oldProp, nextProp)) {
      return false;
    }
  }

  const omitShape = (schema) => {
    const copy = { ...schema };
    delete copy.required;
    delete copy.properties;
    return copy;
  };
  return sameJson(omitShape(oldClean), omitShape(nextClean));
}

function toolCompatibility(oldTools = [], nextTools = []) {
  const oldMap = new Map(oldTools.map(tool => [tool.name, tool]));
  const nextMap = new Map(nextTools.map(tool => [tool.name, tool]));
  const removed = [];
  const changed = [];
  for (const [name, oldTool] of oldMap) {
    const nextTool = nextMap.get(name);
    if (!nextTool) {
      removed.push(name);
      continue;
    }
    if (!schemaAcceptsPrevious(oldTool.inputSchema, nextTool.inputSchema)) changed.push(name);
  }
  return {
    ok: removed.length === 0 && changed.length === 0,
    removed,
    changed,
    added: [...nextMap.keys()].filter(name => !oldMap.has(name)),
  };
}

function manifestHash(tools = []) {
  return sha256(JSON.stringify(tools));
}

export function readRuntimeTarget(manifestPath, { allowExternal = false } = {}) {
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); }
  catch { return { ok: false, absent: true, error: 'runtime manifest is absent' }; }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (error) { return { ok: false, error: `runtime manifest is invalid JSON: ${error.message}` }; }
  if (manifest?.protocol !== 1) return { ok: false, error: `unsupported runtime protocol ${manifest?.protocol ?? '(missing)'}` };
  if (!manifest.version || !manifest.worker) return { ok: false, error: 'runtime manifest must contain version and worker' };

  const root = path.dirname(path.resolve(manifestPath));
  const worker = path.resolve(root, String(manifest.worker));
  if (!allowExternal && !within(root, worker)) return { ok: false, error: 'runtime worker escapes the managed directory' };
  if (!fs.existsSync(worker)) return { ok: false, error: `runtime worker is missing: ${worker}` };

  const files = manifest.files && typeof manifest.files === 'object' ? manifest.files : {};
  for (const [relative, expected] of Object.entries(files)) {
    const file = path.resolve(root, relative);
    if (!allowExternal && !within(root, file)) return { ok: false, error: `runtime file escapes the managed directory: ${relative}` };
    let actual;
    try { actual = sha256(fs.readFileSync(file)); }
    catch { return { ok: false, error: `runtime file is missing: ${relative}` }; }
    if (actual !== expected) return { ok: false, error: `runtime integrity mismatch: ${relative}` };
  }

  return {
    ok: true,
    target: {
      path: worker,
      version: String(manifest.version),
      signature: sha256(raw),
      source: 'installed',
      dev: manifest.dev === true,
      channel: manifest.channel || manifest.via || null,
      manifestPath: path.resolve(manifestPath),
    },
  };
}

class Supervisor {
  constructor(options) {
    this.workerArgs = Array.isArray(options.workerArgs) ? options.workerArgs : [];
    this.fallbackTarget = {
      path: path.resolve(options.fallbackWorker),
      version: String(options.fallbackVersion || readBakedVersion(options.fallbackWorker) || '0.0.0'),
      signature: `fallback:${path.resolve(options.fallbackWorker)}:${options.fallbackVersion || ''}`,
      source: 'package',
      dev: false,
    };
    this.runtimeManifest = path.resolve(
      options.runtimeManifest
      || process.env.KLYPIX_MCP_RUNTIME_MANIFEST
      || path.join(os.homedir(), '.claude', 'project-brain', '.mcp-runtime.json'),
    );
    this.allowExternal = options.allowExternal === true || process.env.KLYPIX_MCP_ALLOW_EXTERNAL_WORKER === '1';
    this.pollMs = Number(options.pollMs || process.env.KLYPIX_MCP_SUPERVISOR_POLL_MS || DEFAULT_POLL_MS);
    this.timeoutMs = Number(options.timeoutMs || process.env.KLYPIX_MCP_SUPERVISOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.rollbackGraceMs = Number(options.rollbackGraceMs || process.env.KLYPIX_MCP_ROLLBACK_GRACE_MS || DEFAULT_ROLLBACK_GRACE_MS);
    this.stateDir = path.resolve(
      options.stateDir
      || process.env.KLYPIX_MCP_STATE_DIR
      || path.join(path.dirname(this.runtimeManifest), '.supervisors'),
    );
    this.stateFile = path.join(this.stateDir, `${process.pid}.json`);
    this.hostRequests = new Map();
    this.workerRequests = new Map();
    this.hostQueue = [];
    this.internalCounter = 0;
    this.active = null;
    this.candidate = null;
    this.standby = null;
    this.pendingTarget = null;
    this.rejectedSignature = null;
    this.initializeRequest = null;
    this.initializedNotification = null;
    this.taskScope = null;
    this.hostInitialized = false;
    this.closed = false;
    this.status = 'starting';
    this.lastSwapAt = null;
    this.lastError = null;
    this.hotReloads = 0;
    this.checking = false;
  }

  writeState(extra = {}) {
    try {
      atomicJson(this.stateFile, {
        protocol: 1,
        pid: process.pid,
        bootedAt: this.bootedAt,
        updatedAt: new Date().toISOString(),
        status: this.status,
        hotReloads: this.hotReloads,
        lastSwapAt: this.lastSwapAt,
        lastError: this.lastError,
        runtimeManifest: this.runtimeManifest.replace(/\\/g, '/'),
        active: this.active ? {
          pid: this.active.child.pid,
          version: this.active.version || this.active.target.version,
          path: this.active.target.path.replace(/\\/g, '/'),
          source: this.active.target.source,
        } : null,
        candidate: this.candidate ? {
          pid: this.candidate.child.pid,
          version: this.candidate.version || this.candidate.target.version,
          path: this.candidate.target.path.replace(/\\/g, '/'),
        } : null,
        ...extra,
      });
    } catch { /* diagnostics must never break the transport */ }
  }

  selectInitialTarget() {
    const runtime = readRuntimeTarget(this.runtimeManifest, { allowExternal: this.allowExternal });
    if (!runtime.ok) return this.fallbackTarget;
    const cmp = compareSemver(runtime.target.version, this.fallbackTarget.version);
    return runtime.target.dev || cmp === null || cmp >= 0 ? runtime.target : this.fallbackTarget;
  }

  spawnWorker(target, role) {
    const child = spawn(process.execPath, [target.path, ...this.workerArgs], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KLYPIX_MCP_SUPERVISED: '1',
        KLYPIX_MCP_SUPERVISOR_PID: String(process.pid),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const worker = {
      child,
      target,
      role,
      version: target.version,
      manifest: null,
      manifestHash: null,
      internal: new Map(),
      retiring: false,
      exited: false,
    };
    child.stdout.on('data', createLineReader(
      message => this.onWorkerMessage(worker, message),
      (error, raw) => this.onWorkerProtocolError(worker, error, raw),
    ));
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('error', error => this.onWorkerError(worker, error));
    child.on('exit', (code, signal) => this.onWorkerExit(worker, code, signal));
    return worker;
  }

  send(worker, message) {
    if (!worker || worker.exited || !worker.child.stdin.writable) throw new Error('worker stdin is unavailable');
    worker.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendHost(message) {
    if (!this.closed) process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendInternal(worker, method, params = {}, timeoutMs = this.timeoutMs) {
    const id = `${INTERNAL_PREFIX}${process.pid}_${++this.internalCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.internal.delete(idKey(id));
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      worker.internal.set(idKey(id), { resolve, reject, timer, method });
      try { this.send(worker, { jsonrpc: '2.0', id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        worker.internal.delete(idKey(id));
        reject(error);
      }
    });
  }

  onWorkerMessage(worker, message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = worker.internal.get(idKey(message.id));
      if (pending) {
        clearTimeout(pending.timer);
        worker.internal.delete(idKey(message.id));
        if (message.error) pending.reject(new Error(message.error.message || `${pending.method} failed`));
        else pending.resolve(message.result);
        return;
      }
    }
    if (worker !== this.active) return;

    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const key = idKey(message.id);
      this.hostRequests.delete(key);
      if (this.initializeRequest && key === idKey(this.initializeRequest.id) && message.result?.serverInfo?.version) {
        worker.version = String(message.result.serverInfo.version);
      }
    } else if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.workerRequests.set(idKey(message.id), message.id);
    }
    this.sendHost(message);
    this.maybeCommitCandidate();
  }

  onWorkerProtocolError(worker, error, raw) {
    const detail = `invalid JSON-RPC from worker v${worker.version}: ${error.message}`;
    if (worker === this.candidate) this.rejectCandidate(detail);
    else {
      this.lastError = detail;
      log(detail, raw.slice(0, 160));
      this.writeState();
    }
  }

  onWorkerError(worker, error) {
    const detail = `worker v${worker.version} error: ${error.message}`;
    if (worker === this.candidate) this.rejectCandidate(detail);
    else {
      this.lastError = detail;
      log(detail);
      this.writeState();
    }
  }

  onWorkerExit(worker, code, signal) {
    worker.exited = true;
    for (const pending of worker.internal.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`worker exited (${code ?? signal ?? 'unknown'})`));
    }
    worker.internal.clear();
    if (worker.retiring || this.closed) return;
    if (worker === this.candidate) {
      this.rejectCandidate(`candidate worker exited before activation (${code ?? signal ?? 'unknown'})`, false);
      return;
    }
    if (worker === this.standby) {
      this.standby = null;
      return;
    }
    if (worker !== this.active) return;

    const failedTarget = worker.target;
    this.active = null;
    this.failInflight(`KLYPIX worker v${worker.version} restarted unexpectedly; retry this tool call.`);
    if (this.standby && !this.standby.exited) {
      const rollback = this.standby;
      this.standby = null;
      this.rejectedSignature = failedTarget.signature;
      rollback.role = 'active';
      this.active = rollback;
      this.status = 'rolled-back';
      this.lastError = `worker v${worker.version} exited during rollback grace`;
      this.sendHost({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      this.replayTaskScope(rollback).catch(() => {});
      this.writeState();
      log(`rolled back to worker v${rollback.version}`);
      return;
    }

    this.status = 'recovering';
    this.lastError = `active worker exited (${code ?? signal ?? 'unknown'})`;
    this.writeState();
    setTimeout(() => {
      if (!this.closed && !this.active && !this.candidate) this.startCandidate(failedTarget, { recovery: true });
    }, 150).unref?.();
  }

  failInflight(message) {
    for (const id of this.hostRequests.values()) {
      this.sendHost({ jsonrpc: '2.0', id, error: { code: -32603, message } });
    }
    this.hostRequests.clear();
    this.workerRequests.clear();
  }

  captureTaskScope(message) {
    if (message?.method !== 'tools/call' || message.params?.name !== 'brain_sync') return;
    const args = message.params?.arguments || {};
    const phase = args.phase || 'checkpoint';
    if (phase === 'complete') {
      this.taskScope = null;
      return;
    }
    const nextFiles = Array.isArray(args.files) ? args.files.map(String) : [];
    if (phase === 'start' || !this.taskScope) {
      this.taskScope = {
        intent: String(args.intent || ''),
        files: [...new Set(nextFiles)],
      };
      return;
    }
    if (args.intent) this.taskScope.intent = String(args.intent);
    this.taskScope.files = [...new Set([...(this.taskScope.files || []), ...nextFiles])];
  }

  onHostMessage(message) {
    if (this.closed) return;
    if (!this.active) {
      this.hostQueue.push(message);
      return;
    }
    if (message?.method === 'initialize' && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.initializeRequest = JSON.parse(JSON.stringify(message));
    }
    if (message?.method === 'notifications/initialized') {
      this.initializedNotification = JSON.parse(JSON.stringify(message));
      this.hostInitialized = true;
    }
    this.captureTaskScope(message);

    if (message?.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.hostRequests.set(idKey(message.id), message.id);
    } else if (!message?.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
      this.workerRequests.delete(idKey(message.id));
    }
    try { this.send(this.active, message); }
    catch (error) {
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        this.hostRequests.delete(idKey(message.id));
        this.sendHost({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
      }
    }
    if (message?.method === 'notifications/initialized') {
      this.status = 'ready';
      this.writeState();
      this.loadToolManifest(this.active).catch(error => {
        this.lastError = `initial tool manifest unavailable: ${error.message}`;
        this.writeState();
      }).finally(() => this.checkForUpdate());
    }
  }

  async loadToolManifest(worker) {
    const tools = [];
    let cursor;
    do {
      const result = await this.sendInternal(worker, 'tools/list', cursor ? { cursor } : {});
      if (Array.isArray(result?.tools)) tools.push(...result.tools);
      cursor = result?.nextCursor;
    } while (cursor);
    worker.manifest = tools;
    worker.manifestHash = manifestHash(tools);
    return tools;
  }

  async replayTaskScope(worker) {
    if (!this.taskScope) return;
    await this.sendInternal(worker, 'tools/call', {
      name: 'brain_sync',
      arguments: {
        phase: 'start',
        intent: this.taskScope.intent || 'Continue the active task after a transparent KLYPIX worker upgrade.',
        files: this.taskScope.files || [],
        include_context: false,
      },
    });
  }

  async startCandidate(target, { recovery = false } = {}) {
    if (this.closed || this.candidate) {
      this.pendingTarget = target;
      return;
    }
    if (!this.initializeRequest || !this.hostInitialized) {
      this.pendingTarget = target;
      return;
    }
    this.pendingTarget = null;
    this.status = recovery ? 'recovering' : 'validating-update';
    const candidate = this.spawnWorker(target, 'candidate');
    this.candidate = candidate;
    this.writeState();
    try {
      const init = JSON.parse(JSON.stringify(this.initializeRequest));
      const initResult = await this.sendInternal(candidate, 'initialize', init.params || {});
      candidate.version = String(initResult?.serverInfo?.version || target.version);
      if (target.version && candidate.version !== target.version) {
        throw new Error(`candidate advertised v${candidate.version}, manifest says v${target.version}`);
      }
      this.send(candidate, this.initializedNotification || { jsonrpc: '2.0', method: 'notifications/initialized' });
      await this.loadToolManifest(candidate);

      const previousTools = this.active?.manifest || [];
      const compatibility = toolCompatibility(previousTools, candidate.manifest);
      const oldVersion = this.active?.version || this.active?.target?.version;
      const oldSemver = parseSemver(oldVersion);
      const nextSemver = parseSemver(candidate.version);
      if (oldSemver && nextSemver && oldSemver[0] !== nextSemver[0]) {
        throw new Error(`major upgrade v${oldVersion} → v${candidate.version} requires reconnect`);
      }
      if (!compatibility.ok) {
        const details = [
          compatibility.removed.length ? `removed tools: ${compatibility.removed.join(', ')}` : '',
          compatibility.changed.length ? `incompatible schemas: ${compatibility.changed.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        throw new Error(`breaking tool manifest requires reconnect (${details})`);
      }
      await this.replayTaskScope(candidate);
      candidate.compatibility = compatibility;
      candidate.ready = true;
      this.status = recovery ? 'recovery-ready' : 'update-ready';
      this.writeState();
      this.maybeCommitCandidate();
    } catch (error) {
      this.rejectCandidate(error.message);
      if (recovery && !this.active) this.tryPreviousWorker(target);
    }
  }

  rejectCandidate(reason, terminate = true) {
    const candidate = this.candidate;
    if (!candidate) return;
    this.candidate = null;
    this.rejectedSignature = candidate.target.signature;
    this.status = this.active ? 'restart-required' : 'recovery-failed';
    this.lastError = reason;
    if (terminate && !candidate.exited) this.retireWorker(candidate, 0);
    this.writeState({ rejectedVersion: candidate.version || candidate.target.version });
    log(`kept v${this.active?.version || 'none'}; rejected v${candidate.version || candidate.target.version}: ${reason}`);
  }

  maybeCommitCandidate() {
    if (!this.candidate?.ready) return;
    if (this.hostRequests.size || this.workerRequests.size) return;
    const next = this.candidate;
    const previous = this.active;
    this.candidate = null;
    next.role = 'active';
    this.active = next;
    this.rejectedSignature = null;
    this.status = 'ready';
    this.lastError = null;
    this.lastSwapAt = new Date().toISOString();
    if (previous) this.hotReloads++;

    if (previous) {
      previous.role = 'standby';
      this.standby = previous;
      this.sendInternal(previous, 'tools/call', {
        name: 'brain_sync',
        arguments: { phase: 'complete', include_context: false },
      }, 3000).catch(() => {});
      setTimeout(() => {
        if (this.standby === previous) {
          this.standby = null;
          this.retireWorker(previous, 250);
        }
      }, this.rollbackGraceMs).unref?.();
    }

    this.writeState();
    this.flushHostQueue();
    if (previous && previous.manifestHash !== next.manifestHash) {
      this.sendHost({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    if (previous) log(`hot-swapped worker v${previous.version} → v${next.version} without reconnect`);
    else log(`recovered worker v${next.version} without reconnect`);

    if (this.pendingTarget && this.pendingTarget.signature !== next.target.signature) {
      const pending = this.pendingTarget;
      this.pendingTarget = null;
      queueMicrotask(() => this.startCandidate(pending));
    }
  }

  retireWorker(worker, graceMs = 250) {
    if (!worker || worker.exited) return;
    worker.retiring = true;
    try { worker.child.stdin.end(); } catch { /* */ }
    if (graceMs <= 0) {
      try { worker.child.kill('SIGTERM'); } catch { /* */ }
      return;
    }
    setTimeout(() => {
      if (!worker.exited) {
        try { worker.child.kill('SIGTERM'); } catch { /* */ }
      }
    }, graceMs).unref?.();
  }

  tryPreviousWorker(target) {
    const previousPath = path.join(path.dirname(target.path), '.prev', path.basename(target.path));
    if (!fs.existsSync(previousPath)) return;
    const previousVersion = readBakedVersion(previousPath);
    if (!previousVersion) return;
    const previous = {
      path: previousPath,
      version: previousVersion,
      signature: `previous:${previousPath}:${previousVersion}`,
      source: 'rollback',
      dev: false,
    };
    setTimeout(() => {
      if (!this.closed && !this.active && !this.candidate) this.startCandidate(previous, { recovery: true });
    }, 150).unref?.();
  }

  async checkForUpdate() {
    if (this.closed || this.checking) return;
    this.checking = true;
    try {
      const runtime = readRuntimeTarget(this.runtimeManifest, { allowExternal: this.allowExternal });
      if (!runtime.ok) {
        if (!runtime.absent) {
          this.lastError = runtime.error;
          this.writeState();
        }
        return;
      }
      const target = runtime.target;
      if (target.signature === this.active?.target.signature || target.signature === this.candidate?.target.signature || target.signature === this.rejectedSignature) return;
      const cmp = compareSemver(target.version, this.active?.version || this.active?.target.version);
      if (!target.dev && cmp !== null && cmp <= 0) return;
      this.startCandidate(target);
    } finally {
      this.checking = false;
    }
  }

  flushHostQueue() {
    const queued = this.hostQueue.splice(0);
    for (const message of queued) this.onHostMessage(message);
  }

  async run() {
    this.bootedAt = new Date().toISOString();
    fs.mkdirSync(this.stateDir, { recursive: true });
    // Opportunistic cleanup of dead supervisor receipts.
    try {
      for (const name of fs.readdirSync(this.stateDir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(this.stateDir, name);
        const state = readJson(file);
        if (!state?.pid || !isAlivePid(state.pid)) {
          try { fs.unlinkSync(file); } catch { /* raced */ }
        }
      }
    } catch { /* */ }

    const initial = this.selectInitialTarget();
    this.active = this.spawnWorker(initial, 'active');
    this.status = 'awaiting-initialize';
    this.writeState();
    this.flushHostQueue();

    process.stdin.on('data', createLineReader(
      message => this.onHostMessage(message),
      (error, raw) => {
        log(`invalid JSON-RPC from host: ${error.message}`, raw.slice(0, 160));
        this.sendHost({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      },
    ));

    this.poller = setInterval(() => this.checkForUpdate(), Math.max(50, this.pollMs));
    this.poller.unref?.();

    await new Promise(resolve => {
      this.resolveRun = resolve;
      process.stdin.once('end', () => this.close());
      process.stdin.once('close', () => this.close());
      process.once('SIGINT', () => this.close());
      process.once('SIGTERM', () => this.close());
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.poller);
    for (const worker of [this.active, this.candidate, this.standby]) this.retireWorker(worker, 0);
    try { fs.unlinkSync(this.stateFile); } catch { /* */ }
    this.resolveRun?.();
  }
}

export async function runMcpSupervisor(options) {
  const supervisor = new Supervisor(options);
  await supervisor.run();
}

export const __test = {
  schemaAcceptsPrevious,
  toolCompatibility,
  compareSemver,
};
