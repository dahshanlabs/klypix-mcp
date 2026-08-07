// Safe ownership-scoped merger for ~/.codex/hooks.json.
//
// KLYPIX owns only command handlers that launch codex-brain-hook.mjs. Existing
// hooks, top-level settings, ordering, and unrelated event groups are preserved.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { sweepStaleTmpFiles } from './agent-presence.mjs';

export const CODEX_PRESENCE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Stop',
  'PostToolUse',
  'SessionEnd',
];

const HOOK_MARK = 'codex-brain-hook.mjs';
const EXECUTION_FRESH_MS = 24 * 60 * 60 * 1000;
const RECEIPT_FILE = 'codex-hook-execution.json';

const fingerprint = (value) => crypto.createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex')
  .slice(0, 24);

export function resolveCodexHooksPath(home = os.homedir()) {
  return path.join(home, '.codex', 'hooks.json');
}

export function codexPresenceGroups(command) {
  const handler = (timeout = 5, statusMessage) => ({
    type: 'command',
    command,
    timeout,
    ...(statusMessage ? { statusMessage } : {}),
  });
  return {
    SessionStart: [{ hooks: [handler(5, 'Loading KLYPIX project awareness')] }],
    UserPromptSubmit: [{ hooks: [handler(5, 'Syncing KLYPIX task context')] }],
    PreToolUse: [{
      matcher: 'apply_patch|Edit|Write',
      hooks: [handler(5, 'Checking KLYPIX file ownership')],
    }],
    Stop: [{ hooks: [handler()] }],
    PostToolUse: [{ hooks: [handler()] }],
    SessionEnd: [{ hooks: [handler(3)] }],
  };
}

function readHooks(file) {
  if (!fs.existsSync(file)) return { ok: true, raw: '', data: {} };
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { return { ok: false, raw: '', data: null, error: `Can't read ${file}: ${error?.message || error}` }; }
  if (!raw.trim()) return { ok: true, raw, data: {} };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('root must be an object');
    return { ok: true, raw, data };
  } catch (error) {
    return { ok: false, raw, data: null, error: `${path.basename(file)} is invalid JSON (${error?.message || error}). KLYPIX left it untouched.` };
  }
}

function stripOwned(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((group) => {
      if (!group || !Array.isArray(group.hooks)) return group;
      return {
        ...group,
        hooks: group.hooks.filter((hook) => !(typeof hook?.command === 'string' && hook.command.includes(HOOK_MARK))),
      };
    })
    .filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);
}

function writeHooks(file, raw, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let backup;
    if (raw) {
      backup = file + '.klypix-bak';
      try { fs.writeFileSync(backup, raw, 'utf8'); }
      catch { backup = undefined; }
    }
    const temp = file + '.klypix-tmp';
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    JSON.parse(fs.readFileSync(temp, 'utf8'));
    try { fs.renameSync(temp, file); }
    catch (err) { try { fs.unlinkSync(temp); } catch { /* */ } throw err; }
    return { ok: true, backup };
  } catch (error) {
    return { ok: false, error: `Couldn't write ${file}: ${error?.message || error}` };
  }
}

export function codexPresenceHookStatus(home = os.homedir()) {
  const file = resolveCodexHooksPath(home);
  const parsed = readHooks(file);
  if (!parsed.ok) return {
    installed: false,
    file,
    error: parsed.error,
    wired: [],
    missing: CODEX_PRESENCE_EVENTS.slice(),
    executionStatus: 'unknown',
    lastExecutedAt: null,
  };
  const hooks = parsed.data?.hooks && typeof parsed.data.hooks === 'object' && !Array.isArray(parsed.data.hooks)
    ? parsed.data.hooks
    : {};
  const wired = CODEX_PRESENCE_EVENTS.filter((event) =>
    Array.isArray(hooks[event])
    && hooks[event].some((group) => Array.isArray(group?.hooks)
      && group.hooks.some((hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_MARK))));
  const owned = Object.fromEntries(CODEX_PRESENCE_EVENTS.map((event) => [
    event,
    (Array.isArray(hooks[event]) ? hooks[event] : [])
      .flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
      .filter((hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_MARK)),
  ]));
  const hookFingerprint = fingerprint(owned);
  const receiptPath = path.join(home, '.claude', 'project-brain', RECEIPT_FILE);
  const receipt = (() => {
    try { return JSON.parse(fs.readFileSync(receiptPath, 'utf8')); }
    catch { return null; }
  })();
  const executedAt = Date.parse(receipt?.executedAt || '');
  const executionObserved = wired.length === CODEX_PRESENCE_EVENTS.length
    && parsed.data?.disableAllHooks !== true
    && receipt?.fingerprint === hookFingerprint
    && Number.isFinite(executedAt)
    && Date.now() - executedAt < EXECUTION_FRESH_MS;
  return {
    installed: wired.length === CODEX_PRESENCE_EVENTS.length,
    file,
    error: null,
    wired,
    missing: CODEX_PRESENCE_EVENTS.filter((event) => !wired.includes(event)),
    executionStatus: wired.length !== CODEX_PRESENCE_EVENTS.length
      ? 'off'
      : (parsed.data?.disableAllHooks === true
        ? 'disabled'
        : (executionObserved ? 'observed' : 'unverified')),
    lastExecutedAt: receipt?.fingerprint === hookFingerprint ? receipt?.executedAt || null : null,
    fingerprint: hookFingerprint,
    receiptPath,
  };
}

export function recordCodexHookExecution({
  home = os.homedir(),
  event = null,
  sessionId = null,
} = {}) {
  try {
    const status = codexPresenceHookStatus(home);
    if (!status.installed || !status.fingerprint) return { ok: false, reason: 'not-configured' };
    const receipt = {
      fingerprint: status.fingerprint,
      executedAt: new Date().toISOString(),
      event: event || null,
      sessionId: sessionId ? String(sessionId).slice(0, 32) : null,
    };
    fs.mkdirSync(path.dirname(status.receiptPath), { recursive: true });
    const temp = status.receiptPath + `.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(receipt, null, 2), 'utf8');
    // Windows rename-over-open-destination throws EPERM (concurrent hook
    // processes race on this receipt constantly): retry once, and never leave
    // the tmp behind — the field found ~35 orphans from this exact line
    // (2026-08-07). A losing racer's receipt is disposable; the winner's stands.
    try { fs.renameSync(temp, status.receiptPath); }
    catch {
      try { fs.renameSync(temp, status.receiptPath); }
      catch { try { fs.unlinkSync(temp); } catch { /* */ } return { ok: false, reason: 'rename-raced' }; }
    }
    sweepStaleTmpFiles(path.dirname(status.receiptPath));
    return { ok: true, path: status.receiptPath };
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
}

export function mergeCodexPresenceHooks({ home = os.homedir(), command } = {}) {
  if (!command || !String(command).includes(HOOK_MARK)) {
    return { ok: false, error: `Codex presence hook command must launch ${HOOK_MARK}.` };
  }
  const file = resolveCodexHooksPath(home);
  const parsed = readHooks(file);
  if (!parsed.ok) return { ok: false, error: parsed.error, path: file };
  const data = structuredClone(parsed.data || {});
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) data.hooks = {};
  const groups = codexPresenceGroups(String(command));
  for (const event of CODEX_PRESENCE_EVENTS) {
    data.hooks[event] = [...stripOwned(data.hooks[event]), ...groups[event]];
  }
  const next = JSON.stringify(data, null, 2) + '\n';
  if (next === parsed.raw) return { ok: true, action: 'unchanged', path: file };
  const written = writeHooks(file, parsed.raw, data);
  if (!written.ok) return { ...written, path: file };
  return { ok: true, action: parsed.raw ? 'updated' : 'connected', path: file, backup: written.backup };
}

export function removeCodexPresenceHooks(home = os.homedir()) {
  const file = resolveCodexHooksPath(home);
  const parsed = readHooks(file);
  if (!parsed.ok) return { ok: false, error: parsed.error, path: file };
  if (!parsed.raw) return { ok: true, action: 'unchanged', path: file };
  const data = structuredClone(parsed.data || {});
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    return { ok: true, action: 'unchanged', path: file };
  }
  let changed = false;
  for (const event of CODEX_PRESENCE_EVENTS) {
    const before = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
    const after = stripOwned(before);
    if (JSON.stringify(after) !== JSON.stringify(before)) changed = true;
    if (after.length) data.hooks[event] = after;
    else delete data.hooks[event];
  }
  if (!Object.keys(data.hooks).length) delete data.hooks;
  if (!changed) return { ok: true, action: 'unchanged', path: file };
  const written = writeHooks(file, parsed.raw, data);
  if (!written.ok) return { ...written, path: file };
  return { ok: true, action: 'disconnected', path: file, backup: written.backup };
}
