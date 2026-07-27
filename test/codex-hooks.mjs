import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CODEX_PRESENCE_EVENTS,
  codexPresenceHookStatus,
  mergeCodexPresenceHooks,
  recordCodexHookExecution,
  removeCodexPresenceHooks,
  resolveCodexHooksPath,
} from '../src/codex-hooks.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};

const home = path.join(os.tmpdir(), 'klypix-codex-hooks-test');
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
const hooksFile = resolveCodexHooksPath(home);
const existing = {
  disableAllHooks: false,
  hooks: {
    SessionStart: [{
      matcher: 'startup',
      hooks: [{ type: 'command', command: 'node user-start-hook.mjs', timeout: 9 }],
    }],
    PostToolUse: [{
      matcher: 'shell_command',
      hooks: [{ type: 'command', command: 'node audit-hook.mjs' }],
    }],
  },
};
fs.writeFileSync(hooksFile, JSON.stringify(existing, null, 2) + '\n');

const command = 'node "C:/Users/test/.claude/project-brain/codex-brain-hook.mjs"';
const connected = mergeCodexPresenceHooks({ home, command });
ok(connected.ok && connected.action === 'updated', 'connect updates an existing hooks file');
ok(fs.existsSync(hooksFile + '.klypix-bak'), 'connect creates a rollback backup');

const afterConnect = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
ok(afterConnect.disableAllHooks === false, 'connect preserves unrelated top-level settings');
ok(afterConnect.hooks.SessionStart.some((group) =>
  group.hooks?.some((hook) => hook.command === 'node user-start-hook.mjs')),
'connect preserves a user SessionStart hook');
ok(afterConnect.hooks.PostToolUse.some((group) =>
  group.hooks?.some((hook) => hook.command === 'node audit-hook.mjs')),
'connect preserves a user PostToolUse hook');
ok(CODEX_PRESENCE_EVENTS.every((event) =>
  afterConnect.hooks[event].some((group) =>
    group.hooks?.some((hook) => hook.command === command))),
'connect owns one handler in every required lifecycle event');
ok(CODEX_PRESENCE_EVENTS.includes('PreToolUse')
  && afterConnect.hooks.PreToolUse.some((group) =>
    group.matcher === 'apply_patch|Edit|Write'
    && group.hooks?.some((hook) =>
      hook.command === command && /file ownership/i.test(hook.statusMessage))),
'enhanced hooks check exact file ownership before Codex edits');
ok(afterConnect.hooks.SessionStart.some((group) =>
  group.hooks?.some((hook) => /project awareness/i.test(hook.statusMessage)))
  && afterConnect.hooks.UserPromptSubmit.some((group) =>
    group.hooks?.some((hook) => /task context/i.test(hook.statusMessage))),
'automatic memory and presence hooks expose concise progress messages');

const firstBytes = fs.readFileSync(hooksFile, 'utf8');
const second = mergeCodexPresenceHooks({ home, command });
ok(second.ok && second.action === 'unchanged', 'connect is idempotent');
ok(fs.readFileSync(hooksFile, 'utf8') === firstBytes, 'idempotent connect preserves file bytes');
const status = codexPresenceHookStatus(home);
ok(status.installed && status.missing.length === 0, 'status reports all Codex presence hooks installed');
ok(status.executionStatus === 'unverified',
  'configured hook files are not falsely reported as trusted before execution');
ok(recordCodexHookExecution({ home, event: 'SessionStart', sessionId: 'test-session' }).ok,
  'a real hook invocation records a behavioral execution receipt');
const observed = codexPresenceHookStatus(home);
ok(observed.executionStatus === 'observed' && observed.lastExecutedAt,
  'status reports enhanced hooks active only after matching config actually executes');

const removed = removeCodexPresenceHooks(home);
ok(removed.ok && removed.action === 'disconnected', 'disconnect removes KLYPIX-owned handlers');
const afterRemove = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
ok(afterRemove.disableAllHooks === false, 'disconnect preserves top-level settings');
ok(afterRemove.hooks.SessionStart[0].hooks[0].command === 'node user-start-hook.mjs',
  'disconnect preserves the user SessionStart hook');
ok(afterRemove.hooks.PostToolUse[0].hooks[0].command === 'node audit-hook.mjs',
  'disconnect preserves the user PostToolUse hook');
ok(!JSON.stringify(afterRemove).includes('codex-brain-hook.mjs'),
  'disconnect removes only KLYPIX-owned handlers');

const invalid = path.join(home, '.codex-invalid');
fs.mkdirSync(path.join(invalid, '.codex'), { recursive: true });
const invalidFile = resolveCodexHooksPath(invalid);
fs.writeFileSync(invalidFile, '{ this is not json');
const invalidBytes = fs.readFileSync(invalidFile, 'utf8');
const refused = mergeCodexPresenceHooks({ home: invalid, command });
ok(!refused.ok && /invalid JSON/.test(refused.error), 'invalid hooks JSON is refused');
ok(fs.readFileSync(invalidFile, 'utf8') === invalidBytes, 'invalid hooks JSON is never overwritten');

fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] codex-hooks: all assertions passed');
process.exit(failures ? 1 : 0);
