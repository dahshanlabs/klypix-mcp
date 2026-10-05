// Regression test for brain_doctor + the harness-drift audit (1.13.0/1.13.1).
//   PART A — pure audit logic (no server, no ~/.claude): linkProject writes the
//            versioned/hashed managed blocks; auditProject classifies ok/stale/
//            hand-edited/missing without writing. Fails if the fence loses its
//            v=/hash stamp, if drift detection regresses, or if classifyMcp goes
//            back to presence-only.
//   PART B — brain_doctor as an MCP verb: boot the real stdio server, list tools
//            (must be 12 incl. brain_doctor), and CALL brain_doctor — proving a
//            non-hook MCP client gets the verdict. Fails if the tool is unregistered.
//
// Run:  node test/brain-doctor.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  auditProject,
  connectCodexMcpServer,
  disconnectCodexMcpServer,
  linkProject,
  safeReadCodexConfig,
} from '../src/agent-rules.mjs';
import { driftLine, inspect, render, structuredReport } from '../src/brain-doctor.mjs';
import { laneFileFor } from '../src/agent-presence.mjs';
import { wakeBlock } from '../src/runtime-inspector.mjs';
import { AUTO_UPDATE_TTL_MS } from '../src/mcp-auto-update.mjs';
import { makeVault, seedBrain } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'klypix-mcp.mjs');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const statusOf = (audit, file) => (audit.files.find(f => f.file === file) || {}).status;

// ── PART A — pure audit logic ────────────────────────────────────────────────
{
  const proj = path.join(os.tmpdir(), 'klypix-doctor-test-proj');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(proj, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.codex', 'config.toml'),
    'model = "gpt-test"\n\n# user-owned docs server\n[mcp_servers.docs]\nurl = "https://example.test/mcp"\n');
  fs.writeFileSync(path.join(proj, 'brain.klypix'), 'stub');   // hasBrain → projection makes sense

  linkProject(proj, { version: '1.2.3' });
  let a = auditProject(proj, { version: '1.2.3' });
  ok(a.ok && a.drift.length === 0, `fresh link → all ${a.files.length} files ok`);
  ok(a.files.length === 14, 'projects exactly 14 targets (8 rules + 6 project-bound MCP configs)');
  ok(statusOf(a, '.codex/config.toml') === 'ok', 'Codex project MCP config generated + audited');
  for (const file of ['.mcp.json', '.cursor/mcp.json', '.cline/mcp.json', '.gemini/settings.json', '.vscode/mcp.json']) {
    ok(statusOf(a, file) === 'ok', `${file} has a safe project-local binding`);
  }
  const codexRaw = fs.readFileSync(path.join(proj, '.codex', 'config.toml'), 'utf8');
  ok(codexRaw.includes('model = "gpt-test"') && codexRaw.includes('[mcp_servers.docs]'), 'Codex merge preserves unrelated settings, comments, and MCP servers');
  ok(codexRaw.includes(proj.replace(/\\/g, '/')), 'Codex binds both cwd/vault to the exact project root');
  fs.writeFileSync(path.join(proj, '.codex', 'config.toml'), codexRaw.replace(/^cwd = .*$/m, 'cwd = ".."'));
  a = auditProject(proj, { version: '1.2.3' });
  const legacyCodex = a.files.find(f => f.file === '.codex/config.toml');
  ok(legacyCodex?.status === 'hand-edited' && /not explicitly bound/.test(legacyCodex?.why || ''),
    'doctor flags a Codex cwd that is not bound to this project');
  linkProject(proj, { version: '1.2.3' });
  ok(fs.readFileSync(path.join(proj, '.codex', 'config.toml'), 'utf8').includes(`cwd = ${JSON.stringify(proj.replace(/\\/g, '/'))}`),
    're-link repairs Codex to the exact project root');
  a = auditProject(proj, { version: '1.2.3' });
  ok(statusOf(a, 'GEMINI.md') === 'ok' && statusOf(a, 'CONVENTIONS.md') === 'ok', 'GEMINI.md + CONVENTIONS.md generated (were "not generated")');

  // ZERO-TOUCH — newer current version but IDENTICAL content → still ok (a version-
  // only bump must not re-drift every adopter project into a re-link treadmill).
  a = auditProject(proj, { version: '2.0.0' });
  ok(statusOf(a, 'AGENTS.md') === 'ok', 'older stamp + content-identical block → ok (zero-touch patch release)');
  ok(statusOf(a, '.cursor/mcp.json') === 'ok', 'mcp.json is version-agnostic → ok');
  ok(statusOf(a, '.codex/config.toml') === 'ok', 'Codex TOML is version-agnostic → ok');

  // STALE — a block whose CONTENT differs from today's instructions (a real older
  // release), internally consistent (body matches its own stamp → not hand-edited).
  {
    const sha8 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
    const oldBody = '## KLYPIX project brain\n\n(older instructions from a previous release)';
    fs.writeFileSync(path.join(proj, 'AGENTS.md'),
      `<!-- klypix-brain:start v=1.0.0 hash=${sha8(oldBody)} (managed by klypix-mcp — re-run \`npx klypix-mcp link\`) -->\n${oldBody}\n<!-- klypix-brain:end -->\n`);
    a = auditProject(proj, { version: '1.2.3' });
    ok(statusOf(a, 'AGENTS.md') === 'stale', 'older CONTENT (self-consistent stamp) → stale');
    const relink = linkProject(proj, { version: '1.2.3' });
    ok(relink.rules.find(r => r.file === 'AGENTS.md').action === 'updated', 're-link refreshes the stale block');
    ok(linkProject(proj, { version: '9.9.9' }).rules.every(r => r.action === 'unchanged'),
      'link with a newer version + identical content → all unchanged (no stamp-only churn)');
  }

  // HAND-EDITED — mutate inside the managed block → stamped hash no longer matches.
  const agents = path.join(proj, 'AGENTS.md');
  fs.writeFileSync(agents, fs.readFileSync(agents, 'utf8').replace('spatial brain', 'spatial brain (TAMPERED)'));
  a = auditProject(proj, { version: '1.2.3' });
  ok(statusOf(a, 'AGENTS.md') === 'hand-edited', 'edit inside the fence → hand-edited');

  // MISSING — delete a projected file.
  fs.rmSync(path.join(proj, '.clinerules', 'klypix-brain.md'), { force: true });
  a = auditProject(proj, { version: '1.2.3' });
  ok(statusOf(a, '.clinerules/klypix-brain.md') === 'missing', 'deleted projected file → missing');

  // classifyMcp — a hand-edit that breaks the launch is drift, not "ok" (P1b).
  const cur = path.join(proj, '.cursor', 'mcp.json');
  const cfg = JSON.parse(fs.readFileSync(cur, 'utf8'));
  cfg.mcpServers['klypix-canvas'] = { command: 'echo', args: ['nope'] };   // no longer launches klypix-mcp
  fs.writeFileSync(cur, JSON.stringify(cfg, null, 2));
  a = auditProject(proj, { version: '1.2.3' });
  ok(statusOf(a, '.cursor/mcp.json') === 'hand-edited', 'mcp.json that no longer launches klypix-mcp → hand-edited (not presence-only)');

  // A foreign/custom vault is unsafe for a managed project config.
  cfg.mcpServers['klypix-canvas'] = { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '/some/custom/path'] };
  fs.writeFileSync(cur, JSON.stringify(cfg, null, 2));
  a = auditProject(proj, { version: '1.2.3' });
  ok(statusOf(a, '.cursor/mcp.json') === 'hand-edited', 'foreign --vault path is flagged instead of cross-project routing');

  // Codex TOML is section-edited, never wholesale serialized. A broken KLYPIX
  // launch is drift, while connect/disconnect preserve user-owned tables.
  {
    const codexFile = path.join(proj, '.codex', 'config.toml');
    fs.writeFileSync(codexFile, fs.readFileSync(codexFile, 'utf8')
      .replace(/command = "[^"]+"/, 'command = "echo"'));
    a = auditProject(proj, { version: '1.2.3' });
    ok(statusOf(a, '.codex/config.toml') === 'hand-edited', 'Codex entry that no longer launches klypix-mcp → hand-edited');
    const repaired = connectCodexMcpServer({
      configPath: codexFile,
      entry: { command: 'node', args: ['/runtime/klypix-mcp-server.mjs', '--vault', proj.replace(/\\/g, '/')] },
      cwd: proj.replace(/\\/g, '/'),
    });
    ok(repaired.ok && safeReadCodexConfig(codexFile).servers['klypix-canvas'].launchesKlypix, 'Codex reconnect repairs only the KLYPIX table');
    const removed = disconnectCodexMcpServer({ configPath: codexFile });
    const afterRemove = fs.readFileSync(codexFile, 'utf8');
    ok(removed.ok && !/mcp_servers\.klypix-canvas/.test(afterRemove), 'Codex disconnect removes the KLYPIX table');
    ok(afterRemove.includes('model = "gpt-test"') && afterRemove.includes('[mcp_servers.docs]'), 'Codex disconnect preserves every unrelated setting/server');
    ok(fs.existsSync(codexFile + '.klypix-bak'), 'Codex config changes create a rollback backup');
    linkProject(proj, { version: '1.2.3' });
  }

  const sha8t = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
  const resetAgents = () => { fs.writeFileSync(path.join(proj, 'AGENTS.md'), ''); linkProject(proj, { version: '1.2.3' }); };

  // FRONTMATTER is part of the owned dedicated files: stripping it silently disables
  // the rule in Cursor/Windsurf, so it must read as drift AND be repaired by link.
  {
    resetAgents();
    const mdc = path.join(proj, '.cursor', 'rules', 'klypix-brain.mdc');
    fs.writeFileSync(mdc, fs.readFileSync(mdc, 'utf8').replace(/^---[\s\S]*?---\r?\n/, ''));
    a = auditProject(proj, { version: '1.2.3' });
    ok(statusOf(a, '.cursor/rules/klypix-brain.mdc') === 'hand-edited', 'stripped frontmatter → drift (not silently ok)');
    const r = linkProject(proj, { version: '1.2.3' });
    ok(r.rules.find(x => x.file === '.cursor/rules/klypix-brain.mdc').action === 'updated', 'link repairs the stripped frontmatter');
    a = auditProject(proj, { version: '1.2.3' });
    ok(statusOf(a, '.cursor/rules/klypix-brain.mdc') === 'ok', 'repaired dedicated file audits ok again');
  }

  // STAMP-MISMATCH (a merge kept an old marker line + the new body): audit says
  // hand-edited and link MUST repair it — check and write can never disagree.
  {
    resetAgents();
    const agentsFile = path.join(proj, 'AGENTS.md');
    fs.writeFileSync(agentsFile, fs.readFileSync(agentsFile, 'utf8')
      .replace(/<!--\s*klypix-brain:start[\s\S]*?-->/, '<!-- klypix-brain:start v=0.9.0 hash=deadbeef (managed by klypix-mcp — re-run `npx klypix-mcp link`) -->'));
    a = auditProject(proj, { version: '1.2.3' });
    ok(statusOf(a, 'AGENTS.md') === 'hand-edited', 'current body under a wrong stamp → hand-edited');
    linkProject(proj, { version: '1.2.3' });
    a = auditProject(proj, { version: '1.2.3' });
    ok(statusOf(a, 'AGENTS.md') === 'ok', 'link repairs the wrong stamp (no permanent-drift loop)');
  }

  // NEWER self-consistent stamp (project linked by a future release): check says ok
  // AND link leaves it alone — an older install must never silently downgrade it.
  {
    const futureBody = '## KLYPIX project brain\n\n(instructions from a FUTURE release)';
    const agentsFile = path.join(proj, 'AGENTS.md');
    fs.writeFileSync(agentsFile, `<!-- klypix-brain:start v=99.0.0 hash=${sha8t(futureBody)} (managed by klypix-mcp — re-run \`npx klypix-mcp link\`) -->\n${futureBody}\n<!-- klypix-brain:end -->\n`);
    a = auditProject(proj, { version: '1.2.3' });
    ok(statusOf(a, 'AGENTS.md') === 'ok', 'newer self-consistent stamp → ok');
    const r = linkProject(proj, { version: '1.2.3' });
    ok(r.rules.find(x => x.file === 'AGENTS.md').action === 'unchanged', 'link does NOT downgrade a newer projection');
  }

  fs.rmSync(proj, { recursive: true, force: true });
}

// Readiness counts use logical sessions, while connection topology remains
// visible. A lifecycle + MCP row for one exact thread must not produce an
// impossible "2 scoped of 1 logical" denominator.
{
  const home = path.join(os.tmpdir(), `klypix-doctor-logical-count-${process.pid}`);
  const project = path.join(home, 'project');
  const brain = path.join(project, 'brain.klypix');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(brain, 'logical-count fixture');
  const lane = laneFileFor(brain, home);
  fs.mkdirSync(path.dirname(lane), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(lane, JSON.stringify({
    version: 1,
    sessions: [{
      id: 'connection-lifecycle', logicalSessionId: 'thread-exact', client: 'codex',
      intent: 'verify one logical scope', files: ['src/exact.mjs'],
      lastSeen: now, channelSeen: { lifecycle: now }, activityAt: now,
    }, {
      id: 'connection-mcp', logicalSessionId: 'thread-exact', client: 'codex',
      intent: '', files: [], lastSeen: now, channelSeen: { mcp: now },
    }],
    messages: [],
  }));
  const report = inspect({ home, projectDir: project, now });
  const text = render(report, { color: false });
  ok(report.sessions.logicalSessionCount === 1
    && report.sessions.connectionCount === 2
    && report.sessions.syncedCount === 1
    && report.sessions.activeUnscopedCount === 0
    && report.sessions.idleUnscopedCount === 0
    && /1 logical session · 2 live connections · 1 with declared task scope/.test(text),
  'doctor uses one logical-session denominator while retaining both live connections');
  fs.rmSync(home, { recursive: true, force: true });
}

// Third review, 2026-09-18 (R1): every install before 1.86.2 wired SessionStart
// for "startup|resume", so a /clear started a conversation with no brain brief
// — and a RUNTIME-only auto-update never rewrites settings.json, so those
// installs stay that way until someone runs `npx klypix-mcp install` again.
// Doctor says so; it is informational and never changes the verdict.
{
  const home = path.join(os.tmpdir(), `klypix-doctor-clear-${process.pid}`);
  const project = path.join(home, 'project');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const brainCmd = 'node "C:/Users/x/.claude/project-brain/global-brain-hook.mjs"';
  const settingsWith = (matcher) => ({
    hooks: {
      SessionStart: [{ matcher, hooks: [{ type: 'command', command: brainCmd }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${brainCmd} --prompt` }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${brainCmd} --capture` }] }],
      PostToolUse: [{ matcher: 'Bash|PowerShell|Edit|Write', hooks: [{ type: 'command', command: `${brainCmd} --live` }] }],
      PreToolUse: [{ matcher: 'Bash|PowerShell|Edit|Write', hooks: [{ type: 'command', command: `${brainCmd} --guard` }] }],
    },
  });
  const settingsPath = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settingsWith('startup|resume')));
  const old = inspect({ home, projectDir: project, fmtLib: null });
  const oldText = render(old, { color: false });
  ok(old.hooks.sessionStartMissesClear === true && old.hooks.missing.length === 0
    && /SessionStart is not wired for \/clear/.test(oldText) && /capture path intact/.test(oldText),
  'doctor flags a pre-1.86.2 SessionStart matcher that leaves /clear out, without calling the install broken');
  fs.writeFileSync(settingsPath, JSON.stringify(settingsWith('startup|resume|clear')));
  const fixed = inspect({ home, projectDir: project, fmtLib: null });
  ok(fixed.hooks.sessionStartMissesClear === false && !/SessionStart is not wired for \/clear/.test(render(fixed, { color: false })),
    'doctor stays quiet once the matcher covers /clear');
  fs.rmSync(home, { recursive: true, force: true });
}

// A deliberately hibernated supervisor has released its worker but still owns
// a healthy pull-only connection. Doctor must use the sleeping target for
// version alignment and must not call the expected worker absence an outage.
{
  const home = path.join(os.tmpdir(), `klypix-doctor-hibernation-${process.pid}`);
  const project = path.join(home, 'project');
  const brainDir = path.join(home, '.claude', 'project-brain');
  const supervisorsDir = path.join(brainDir, '.supervisors');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(supervisorsDir, { recursive: true });
  fs.writeFileSync(path.join(brainDir, 'klypix-mcp-server.mjs'), "const PKG_VERSION = '1.65.0';\nrunMcpSupervisor();\n");
  fs.writeFileSync(path.join(brainDir, 'mcp-supervisor.mjs'), '// supervisor fixture');
  const stateFile = path.join(supervisorsDir, `${process.pid}.json`);
  const sleepingState = {
    pid: process.pid,
    status: 'hibernated',
    active: null,
    hibernation: {
      hibernated: true,
      target: { version: '1.65.0', path: 'C:/runtime/klypix-mcp-worker.mjs', source: 'managed' },
    },
    transport: { host: 'connected', delivery: 'pull-only' },
  };
  // supervisorVersion marks supervisor code carrying the 2026-10-03 fix
  // (hibernation that stays asleep): only those may claim a RAM release.
  fs.writeFileSync(stateFile, JSON.stringify({ ...sleepingState, supervisorVersion: '1.65.0' }));
  const sleeping = inspect({ home, projectDir: project, fmtLib: null });
  const sleepingText = render(sleeping, { color: false });
  ok(sleeping.layers.supervisor === 'ok'
    && sleeping.supervisors.impaired.length === 0
    && sleeping.supervisors.matchesInstalled === true
    && sleeping.supervisors.live[0]?.activeVersion === '1.65.0'
    && /hibernated \(worker released, presence held, wakes on the next request\)/.test(sleepingText),
  'doctor treats intentional pull-only hibernation as healthy and version-aligned');
  // C4: pre-fix supervisor code re-woke an idle pair ~1 s after it hibernated
  // (750-800 worker spawns an hour on the founder's PC). A pre-fix pair caught
  // asleep is still healthy, but must not be credited with releasing RAM.
  fs.writeFileSync(stateFile, JSON.stringify(sleepingState));
  const napping = inspect({ home, projectDir: project, fmtLib: null });
  const nappingText = render(napping, { color: false });
  ok(napping.layers.supervisor === 'ok'
    && napping.supervisors.preFix.length === 1
    && !/worker released/.test(nappingText)
    && /1 of 1 connection\(s\) still run pre-fix supervisor code — \/mcp reconnect to apply/.test(nappingText)
    && /pre-fix pair\(s\) asleep at this instant — that code re-wakes an idle worker within seconds, so no RAM release is claimed/.test(nappingText),
  'C4: a pre-fix supervisor caught hibernated is healthy but never credited with a RAM release; pre-fix code is named with /mcp reconnect');

  fs.writeFileSync(stateFile, JSON.stringify({
    pid: process.pid,
    status: 'recovery-failed',
    active: null,
    hibernation: { hibernated: false, target: null },
    transport: { host: 'impaired', delivery: 'impaired' },
    lastError: 'worker could not restart',
  }));
  const failed = inspect({ home, projectDir: project, fmtLib: null });
  ok(failed.layers.supervisor === 'drift'
    && failed.supervisors.impaired.length === 1
    && failed.supervisors.impaired[0].workerImpaired === true,
  'doctor still marks a terminal worker/transport failure as impaired');

  fs.writeFileSync(stateFile, JSON.stringify({
    pid: process.pid,
    status: 'ready',
    active: { pid: process.pid, path: 'C:/runtime/klypix-mcp-worker.mjs' },
    transport: { host: 'connected', delivery: 'connected' },
  }));
  const unversioned = inspect({ home, projectDir: project, fmtLib: null });
  ok(unversioned.layers.supervisor === 'drift'
    && unversioned.supervisors.matchesInstalled === false,
  'doctor does not call a live worker healthy when its deployed version is unknown');

  fs.writeFileSync(stateFile, JSON.stringify({
    pid: process.pid,
    status: 'ready',
    active: { pid: process.pid, version: '1.65.0', path: 'C:/runtime/klypix-mcp-worker.mjs' },
    transport: { host: 'connected', delivery: 'backpressured' },
  }));
  const backpressured = inspect({ home, projectDir: project, fmtLib: null });
  const backpressuredText = render(backpressured, { color: false });
  ok(backpressured.layers.supervisor === 'drift'
    && /0 healthy .* 1 delivery-backpressured/.test(backpressuredText),
  'doctor excludes a backpressured transport from the healthy supervisor count');
  fs.rmSync(home, { recursive: true, force: true });
}

// MERGE ENGINE (Stage 2): an engine or git driver OLDER than the brain is
// drift with a fix named — it runs 1.86 rules, so a card deleted here comes
// back from another copy. Read from the deployed text, never imported.
{
  const home = path.join(os.tmpdir(), `klypix-doctor-merge-${process.pid}`);
  const project = path.join(home, 'project');
  const brainDir = path.join(home, '.claude', 'project-brain');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(brainDir, { recursive: true });
  const SRC = path.join(__dirname, '..', 'src');
  const OLD = path.join(__dirname, 'fixtures', 'engine-1.86.3');
  const put = (file, from) => fs.copyFileSync(from, path.join(brainDir, file));
  const baked = (v) => fs.writeFileSync(path.join(brainDir, 'klypix-mcp-server.mjs'), `const PKG_VERSION = '${v}';\n`);
  const at = () => inspect({ home, projectDir: project, fmtLib: null });

  baked('1.89.0');
  put('merge-brains.mjs', path.join(SRC, 'merge-brains.mjs'));
  put('klypix-merge-driver.mjs', path.join(SRC, 'klypix-merge-driver.mjs'));
  let r = at();
  ok(r.layers.mergeEngine === 'ok' && r.mergeEngine.engine.api >= 2 && r.mergeEngine.driver.api >= 2
    && /MERGE\s+engine api \d+ · git driver api \d+/.test(render(r, { color: false })),
  'MERGE: a current engine and driver under a 1.89 brain read ok, with their api levels');

  put('merge-brains.mjs', path.join(OLD, 'merge-brains.mjs'));
  r = at();
  ok(r.layers.mergeEngine === 'drift' && r.mergeEngine.engine.api === 1 && r.verdict === 'DRIFTED'
    && r.actions.some((a) => a.startsWith('npx klypix-mcp install') && a.includes('merge-brains.mjs predates brain v1.89.0'))
    && /merge engine older than the brain/.test(driftLine(r)),
  'MERGE: a 1.86 engine under a 1.89 brain is drift, and the fix is named');

  put('merge-brains.mjs', path.join(SRC, 'merge-brains.mjs'));
  fs.writeFileSync(path.join(brainDir, 'klypix-merge-driver.mjs'), "import * as engine from './merge-brains.mjs';\n// a 1.86 driver: no options constant\n");
  r = at();
  ok(r.layers.mergeEngine === 'drift' && r.mergeEngine.driver.api === 1
    && r.actions.some((a) => a.includes('klypix-merge-driver.mjs predates')),
  'MERGE: a 1.86 git driver beside a current engine is drift too');

  baked('1.86.3');
  r = at();
  ok(r.layers.mergeEngine === 'n/a' && !/MERGE\s/.test(render(r, { color: false })),
    'MERGE: an older brain is not judged against the new engine');
  // 1.87.0 shipped with the api-1 engine: an install of it must not read as
  // drifted (the Stage 2 engine first ships in 1.89.0).
  put('merge-brains.mjs', path.join(OLD, 'merge-brains.mjs'));
  baked('1.87.0');
  r = at();
  ok(r.layers.mergeEngine === 'n/a', 'MERGE: a 1.87.0 brain with its own api-1 engine is not drift');
  // ...nor 1.88.0, the session mailbox alone (review 14: the boundary itself).
  baked('1.88.0');
  r = at();
  ok(r.layers.mergeEngine === 'n/a', 'MERGE: a 1.88.0 brain (the mailbox release) with its api-1 engine is not drift');
  put('merge-brains.mjs', path.join(SRC, 'merge-brains.mjs'));

  baked('1.89.0');
  fs.rmSync(path.join(brainDir, 'merge-brains.mjs'));
  fs.rmSync(path.join(brainDir, 'klypix-merge-driver.mjs'));
  r = at();
  ok(r.layers.mergeEngine === 'absent' && r.drifted === 0 && /MERGE\s+engine missing/.test(render(r, { color: false })),
    'MERGE: a missing engine is shown, not counted as drift');
  fs.rmSync(home, { recursive: true, force: true });
}

// ── 2026-10-03 fixtures: an npm install of THIS package's version ────────────
// Literal JSON in temp homes only — never the developer's ~/.claude. The baked
// version equals the doctor's own (package.json), so no version-skew caveat
// changes what the doctor may judge.
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
const [PKG_MAJOR, PKG_MINOR] = PKG_VERSION.split('.').map(Number);
const NEXT = `${PKG_MAJOR}.${PKG_MINOR + 1}.0`;
const NEXT_MAJOR = `${PKG_MAJOR + 1}.0.0`;
const DEAD_PID = 2147483646;          // a pid that does not exist
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const doctorHome = (tag) => {
  const home = path.join(os.tmpdir(), `klypix-doctor-${tag}-${process.pid}`);
  fs.rmSync(home, { recursive: true, force: true });
  const brainDir = path.join(home, '.claude', 'project-brain');
  fs.mkdirSync(path.join(brainDir, '.supervisors'), { recursive: true });
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  return { home, brainDir, project };
};
// Receipts exactly as bin/klypix-install.mjs writes them, `files` covering every
// module present (so ENGINE stays quiet unless a case adds one on purpose).
const installNpm = (brainDir, { version = PKG_VERSION, dev = false, installedAt } = {}) => {
  fs.writeFileSync(path.join(brainDir, 'klypix-mcp-server.mjs'), `const PKG_VERSION = '${version}';\nrunMcpSupervisor();\n`);
  fs.writeFileSync(path.join(brainDir, 'mcp-supervisor.mjs'), '// supervisor fixture\n');
  const files = Object.fromEntries(fs.readdirSync(brainDir).filter((f) => f.endsWith('.mjs'))
    .map((f) => [f, sha256(path.join(brainDir, f))]));
  const channel = dev ? 'dev' : 'npm';
  fs.writeFileSync(path.join(brainDir, '.mcp-runtime.json'), JSON.stringify({
    protocol: 1, version, worker: 'klypix-mcp-worker.mjs', channel, ...(dev ? { dev: true } : {}), installedAt, files,
  }));
  fs.writeFileSync(path.join(brainDir, '.brain-version.json'), JSON.stringify({
    brainVersion: version, via: channel, dirty: false, ...(dev ? { dev: true } : {}), installedAt,
  }));
};
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const supervisorReceipt = (brainDir, name, state) => writeJson(path.join(brainDir, '.supervisors', `${name}.json`), {
  protocol: 1, pid: process.pid, parentPid: process.pid, status: 'ready',
  transport: { host: 'connected', delivery: 'connected' }, hotReloads: 0, ...state,
});

// SUPERVISOR truth (C2/C3, 2026-10-03). 921 samples on the founder's PC: every
// IMPAIRED reading was a pair mid-wake, and a dead receipt whose pid Windows had
// reused (ChatGPT.exe) kept the verdict DRIFTED on a version nothing ran.
{
  const NOW = Date.now();
  const { home, brainDir, project } = doctorHome('supervisor-truth');
  installNpm(brainDir, { installedAt: iso(NOW - HOUR) });
  const at = (agoMs) => iso(NOW - agoMs);
  const run = () => inspect({ home, projectDir: project, now: NOW, fmtLib: null, env: { KLYPIX_AUTO_UPDATE: '0' } });
  const clear = () => { for (const f of fs.readdirSync(path.join(brainDir, '.supervisors'))) fs.rmSync(path.join(brainDir, '.supervisors', f)); };
  const phantom = {
    parentPid: DEAD_PID, updatedAt: at(10 * 60_000), status: 'hibernated', active: null, supervisorVersion: PKG_VERSION,
    hibernation: { hibernated: true, target: { version: '1.86.0' } }, transport: { host: 'connected', delivery: 'pull-only' },
  };

  supervisorReceipt(brainDir, 'phantom', phantom);
  let r = run();
  let text = render(r, { color: false });
  ok(r.supervisors.count === 0 && r.supervisors.deadReceipts === 1
    && r.layers.supervisor !== 'drift' && /1 dead supervisor receipt\(s\) ignored/.test(text),
  'S1: a receipt whose host is gone and that has been silent > 120 s is dead — not counted, not drift, reported as ignored');

  supervisorReceipt(brainDir, 'phantom', { ...phantom, updatedAt: at(10_000) });
  r = run();
  ok(r.supervisors.count === 1 && r.supervisors.deadReceipts === 0,
    'S2: the same receipt written 10 s ago still counts (a live supervisor needs up to 30 s to notice its host died)');

  clear();
  supervisorReceipt(brainDir, 'gone', { pid: DEAD_PID, status: 'ready', active: { pid: DEAD_PID, version: '1.86.0' } });
  r = run();
  ok(r.supervisors.count === 0 && r.supervisors.deadReceipts === 1,
    'S3: a receipt whose own pid is dead is counted as an ignored dead receipt');

  clear();
  const waking = {
    status: 'recovering', active: null, updatedAt: at(3_000), lastError: null,
    candidate: { pid: process.pid, version: PKG_VERSION, path: 'C:/runtime/klypix-mcp-worker.mjs' },
    transport: { host: 'connected', delivery: 'impaired' }, supervisorVersion: PKG_VERSION,
  };
  supervisorReceipt(brainDir, 'waking', waking);
  r = run();
  text = render(r, { color: false });
  let s = r.supervisors.live[0];
  ok(s && !s.impaired && s.transition === 'waking' && s.deliveryStatus === 'queued'
    && r.layers.supervisor === 'ok' && r.verdict !== 'DRIFTED'
    && /SUPERVISOR\s+0 healthy · 1 transitioning/.test(text)
    && new RegExp(`pid ${process.pid} waking into v${PKG_VERSION.replace(/\./g, '\\.')} — requests are queued`).test(text)
    && !/IMPAIRED/.test(text),
  'S4: a pair mid-wake (no active worker, live candidate, fresh receipt) is transitioning with queued delivery, never IMPAIRED');

  supervisorReceipt(brainDir, 'waking', { ...waking, lastError: 'active worker exited (3221225794)' });
  ok(/recovering after a worker exit into v/.test(render(run(), { color: false })),
    'S4b: a crash recovery in the same window is labelled as a recovery, never as a wake');

  supervisorReceipt(brainDir, 'waking', { ...waking, updatedAt: at(2 * 60_000) });
  r = run();
  ok(r.supervisors.impaired.length === 1 && r.layers.supervisor === 'drift',
    'S5: the same receipt silent for 2 min is stuck, not transitioning — IMPAIRED as before');

  clear();
  supervisorReceipt(brainDir, 'swap', {
    status: 'validating-update', updatedAt: at(2_000),
    active: { pid: process.pid, version: '1.88.0' }, candidate: { pid: process.pid, version: PKG_VERSION },
    supervisorVersion: PKG_VERSION,
  });
  r = run();
  text = render(r, { color: false });
  ok(r.supervisors.live[0]?.transition === 'swapping' && r.supervisors.matchesInstalled === true
    && r.layers.supervisor === 'ok' && /swapping to v\S+ \(from v1\.88\.0\)/.test(text),
  'S6: a hot-swap to the installed version is transitioning and aligned, not drift');

  clear();
  supervisorReceipt(brainDir, 'stale', { active: { pid: process.pid, version: '1.88.0' }, updatedAt: at(5 * 60_000), supervisorVersion: PKG_VERSION });
  r = run();
  text = render(r, { color: false });
  ok(r.layers.supervisor === 'drift' && /\[!\] SUPERVISOR/.test(text)
    && /ready on v1\.88\.0 — installed v/.test(text)
    && r.actions.some((a) => a.startsWith('/mcp reconnect if it persists') && a.includes('serves v1.88.0'))
    && /1 connection\(s\) serve a version ≠ installed v/.test(driftLine(r)),
  'S7: a pair serving an old version is drift, and the SUPERVISOR mark and the drift line say so (it printed [ok] beside DRIFTED)');

  clear();
  supervisorReceipt(brainDir, 'rr', {
    status: 'restart-required', active: null, updatedAt: at(60_000),
    lastError: `major upgrade v${PKG_VERSION} → v${NEXT_MAJOR} requires reconnect`,
    transport: { host: 'connected', delivery: 'impaired' }, supervisorVersion: PKG_VERSION,
  });
  r = run();
  text = render(r, { color: false });
  ok(r.supervisors.impaired.length === 1 && r.layers.supervisor === 'drift'
    && /restart-required: major upgrade .* requires reconnect — \/mcp reconnect/.test(text)
    && r.actions.some((a) => a.startsWith('/mcp reconnect') && /restart-required: major upgrade/.test(a)),
  'S8: a pair that refused an incompatible core while idle is restart-required with its reason and a reconnect action');

  supervisorReceipt(brainDir, 'rr', {
    status: 'restart-required', active: { pid: process.pid, version: '1.88.0' }, updatedAt: at(60_000),
    lastError: 'breaking tool manifest requires reconnect (removed tools: brain_lens)', supervisorVersion: PKG_VERSION,
  });
  r = run();
  text = render(r, { color: false });
  ok(r.supervisors.impaired.length === 0
    && /restart-required: breaking tool manifest .* — \/mcp reconnect \(still serving v1\.88\.0\)/.test(text)
    && r.actions.some((a) => /restart-required: kept v1\.88\.0/.test(a)),
  'S9: a rejected update with the old worker still serving is listed with a reconnect action (it had none)');
  // F11 (2026-10-03 review): that pair is not "healthy", and zero-restart
  // activation is exactly what failed for it.
  ok(/SUPERVISOR\s+0 healthy · 1 need \/mcp reconnect/.test(text) && !/zero-restart core activation ready/.test(text),
    'F11: the header counts a restart-required pair as needing a reconnect, not as healthy "zero-restart … ready"');

  // F5 (2026-10-03 review): a recorded wake target in a new MAJOR is refused by
  // the wake's own gate; it read "[ok] ALIGNED … wakes into vN on the next request".
  clear();
  installNpm(brainDir, { version: NEXT_MAJOR, installedAt: iso(NOW - HOUR) });
  supervisorReceipt(brainDir, 'major', {
    status: 'hibernated', active: null, updatedAt: at(20 * 60_000), supervisorVersion: PKG_VERSION,
    transport: { host: 'connected', delivery: 'pull-only' },
    hibernation: { hibernated: true, target: { version: PKG_VERSION }, pendingWakeTarget: { version: NEXT_MAJOR, validated: false } },
  });
  r = run();
  text = render(r, { color: false });
  ok(r.supervisors.live[0]?.alignment === 'reconnect-on-wake' && r.layers.supervisor === 'drift' && r.verdict === 'DRIFTED'
    && new RegExp(`hibernated v${PKG_VERSION.replace(/\./g, '\\.')} — the installed v${NEXT_MAJOR.replace(/\./g, '\\.')} is a new major: its next request answers "core changed incompatibly" — /mcp reconnect`).test(text)
    && /RUNNING\s+all 1 connection hibernated; 1 cannot wake as installed/.test(text)
    && /SUPERVISOR\s+0 healthy · 1 need \/mcp reconnect/.test(text)
    && r.actions.some((a) => a.startsWith('/mcp reconnect') && /is a new major, which its next request would refuse/.test(a)),
  'F5: a hibernated pair whose wake target is a new major needs /mcp reconnect — never ALIGNED "wakes into" it');
  installNpm(brainDir, { installedAt: iso(NOW - HOUR) });

  // F6 (2026-10-03 review): a pair whose wake was refused because the core files
  // do not verify answers every request with an error until they do.
  clear();
  const deferredPair = {
    status: 'hibernated', active: null, updatedAt: at(10_000), supervisorVersion: PKG_VERSION,
    lastError: 'runtime integrity mismatch: worker.mjs', transport: { host: 'connected', delivery: 'pull-only' },
    hibernation: {
      hibernated: true, target: { version: PKG_VERSION },
      wakeDeferred: { reason: 'runtime integrity mismatch: worker.mjs', count: 2, since: at(5 * 60_000), lastAt: at(10_000) },
    },
  };
  supervisorReceipt(brainDir, 'deferred', deferredPair);
  r = run();
  text = render(r, { color: false });
  ok(r.supervisors.live[0]?.wakeBlocked === true && r.supervisors.impaired.length === 1 && r.layers.supervisor === 'drift'
    && /hibernated: its last wake found no consistent core to boot \(runtime integrity mismatch: worker\.mjs, 2 attempts since \S+\) — requests fail until they verify; npx -y klypix-mcp@latest install --force/.test(text)
    && /RUNNING\s+all 1 connection hibernated; 1 cannot wake as installed/.test(text)
    && !/wakes on the next request/.test(text)
    && r.actions.some((a) => a.startsWith('npx -y klypix-mcp@latest install --force') && /cannot wake/.test(a))
    && /cannot wake — the core files do not verify/.test(driftLine(r)),
  'F6: a refused wake is IMPAIRED with the reinstall named — never "wakes on the next request"');
  ok(wakeBlock(deferredPair)?.reason === 'wake-deferred',
    'F6/K4: `klypix-mcp runtime` reads the same refused wake as unable to wake');
  // K1-DOCTOR-WAKEBLOCKED-FALSE (2026-10-03 review): an integrity error the
  // receipt merely carries is no refused wake. K1 boots .prev when a fresh
  // connection meets a failing install and records the error in its very first
  // receipt; hibernated, the pair wakes from that same .prev (B3). The doctor
  // printed it IMPAIRED ("requests fail until they verify") while the runtime
  // report (K4) said it wakes — and it does.
  const fromPrev = {
    ...deferredPair,
    updatedAt: at(2 * 60_000),
    hibernation: {
      hibernated: true, wakeDeferred: null,
      target: { version: PKG_VERSION, source: 'rollback', path: path.join(brainDir, '.prev', 'klypix-mcp-worker.mjs') },
    },
  };
  supervisorReceipt(brainDir, 'deferred', fromPrev);
  r = run();
  text = render(r, { color: false });
  ok(r.supervisors.live[0]?.wakeBlocked === false && r.supervisors.impaired.length === 0
    && !/IMPAIRED|requests fail until they verify|cannot wake/.test(text)
    && !/cannot wake/.test(driftLine(r))
    && /pid \d+ hibernated: runtime integrity mismatch: worker\.mjs/.test(text)
    && wakeBlock(fromPrev) === null,
  `K1: a pair booted from .prev that carries the integrity error but has refused no wake is not IMPAIRED — it wakes from .prev, as \`klypix-mcp runtime\` says; the error is still shown (${text.split('\n').filter((line) => /SUPERVISOR|pid \d+/.test(line)).join(' | ')})`);
  supervisorReceipt(brainDir, 'deferred', { ...fromPrev, updatedAt: at(10_000) });
  ok(run().supervisors.live[0]?.wakeBlocked === false,
    'F6: a fresh integrity error (an install mid-flight) is not a blocked wake either');
  supervisorReceipt(brainDir, 'deferred', { ...fromPrev, hibernation: { ...fromPrev.hibernation, wakeDeferred: deferredPair.hibernation.wakeDeferred } });
  ok(run().supervisors.live[0]?.wakeBlocked === true,
    'K1: an actual refused wake overrides a previously working snapshot');

  clear();
  supervisorReceipt(brainDir, 'pending', {
    status: 'hibernated', active: null, updatedAt: at(20 * 60_000), supervisorVersion: PKG_VERSION,
    transport: { host: 'connected', delivery: 'pull-only' },
    hibernation: { hibernated: true, target: { version: '1.88.0' }, pendingWakeTarget: { version: PKG_VERSION, validated: false } },
  });
  r = run();
  text = render(r, { color: false });
  ok(r.supervisors.live[0]?.alignment === 'pending-wake' && r.layers.supervisor === 'ok'
    && new RegExp(`hibernated v1\\.88\\.0 — wakes into v${PKG_VERSION.replace(/\./g, '\\.')} on next request \\(not yet validated\\)`).test(text),
  'S10: a hibernated pair whose recorded wake target is the installed version is benign, and says it is not yet validated');
  ok(r.running.allHibernated === 1 && r.layers.running === 'unknown'
    && new RegExp(`RUNNING\\s+all 1 connection hibernated; it wakes into v${PKG_VERSION.replace(/\./g, '\\.')} on the next request`).test(text)
    && !/reconnect to populate/.test(text),
  'C3: with every pair asleep, RUNNING says so instead of "unknown … /mcp reconnect to populate"');

  supervisorReceipt(brainDir, 'pre-fix', {
    status: 'hibernated', active: null, updatedAt: at(20 * 60_000),
    transport: { host: 'connected', delivery: 'pull-only' },
    hibernation: { hibernated: true, target: { version: PKG_VERSION } },
  });
  r = run();
  text = render(r, { color: false });
  ok(r.supervisors.preFix.length === 1
    && /1 of 2 connection\(s\) still run pre-fix supervisor code — \/mcp reconnect to apply/.test(text)
    && /· 1 hibernated \(worker released, presence held, wakes on the next request\)/.test(text)
    && /1 pre-fix pair\(s\) asleep at this instant/.test(text)
    && /all 2 connections hibernated; they wake into v/.test(text),
  'C2/C4: pre-fix supervisor code is counted with /mcp reconnect, and only the fixed pair is credited with a RAM release');
  fs.rmSync(home, { recursive: true, force: true });
}

// AUTO-UPDATE truth (C1, 2026-10-03). The old line said '[ok] … machine-wide 24h
// check · last result dev-owned v1.86.0' next to an npm-owned v1.88.0 runtime.
{
  const NOW = Date.now();
  const ON = { KLYPIX_AUTO_UPDATE: '' };
  const OFF = { KLYPIX_AUTO_UPDATE: '0' };
  const { home, brainDir, project } = doctorHome('auto-update-truth');
  const files = {
    stamp: path.join(brainDir, '.autoupdate-check.json'),
    status: path.join(brainDir, '.autoupdate-status.json'),
    lock: path.join(brainDir, '.autoupdate.lock'),
    cache: path.join(brainDir, '.npm-currency.json'),
  };
  const reset = (installOptions = {}) => {
    for (const f of [...Object.values(files), ...fs.readdirSync(path.join(brainDir, '.supervisors')).map((f) => path.join(brainDir, '.supervisors', f))]) {
      fs.rmSync(f, { force: true });
    }
    installNpm(brainDir, { installedAt: iso(NOW - 9 * HOUR), ...installOptions });
  };
  const npmIdentity = { version: PKG_VERSION, managed: true, dev: false };
  const run = (extra = {}) => inspect({ home, projectDir: project, now: NOW, fmtLib: null, env: ON, ...extra });
  const textOf = (r) => render(r, { color: false });
  const auLine = (text) => text.split('\n').find((line) => /AUTO-UPDATE/.test(line)) || '';
  // A live supervisor that polled the update schedule 5 min ago: since K3 its
  // receipt's lastPollAt is the evidence that a session was there to run a due
  // check (F9's "open since" no longer counts on its own).
  const liveSupervisor = (extra = {}) => supervisorReceipt(brainDir, 'live', {
    bootedAt: iso(NOW - 10 * HOUR), updatedAt: iso(NOW - 30_000), active: { pid: process.pid, version: PKG_VERSION },
    autoUpdate: { enabled: true, lastPollAt: iso(NOW - 5 * 60_000) }, supervisorVersion: PKG_VERSION, ...extra,
  });
  const current = (checkedAgo, extra = {}) => ({
    protocol: 1, result: 'current', checkedAt: iso(NOW - checkedAgo),
    currentVersion: PKG_VERSION, latestVersion: PKG_VERSION, identity: npmIdentity, ...extra,
  });
  const ttlHours = AUTO_UPDATE_TTL_MS / HOUR;

  // A1 — fresh current result: cadence from the updater's own constant, the
  // result with its time and age, and the next check with its ETA.
  reset();
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 2 * HOUR, failures: 0, nextCheckAt: NOW + 4 * HOUR, identity: npmIdentity });
  writeJson(files.status, current(2 * HOUR));
  let r = run();
  let line = auLine(textOf(r));
  ok(new RegExp(`^\\[ok\\] AUTO-UPDATE  enabled · checks every ${ttlHours}h · last result current — npm v${PKG_VERSION.replace(/\./g, '\\.')} \\(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z, 2h ago\\) · next check \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z \\(in 4h\\)$`).test(line)
    && !/24h/.test(line) && r.layers.autoUpdate === 'ok' && r.verdict === 'ALIGNED',
  `A1: a fresh result renders cadence, result time + age and the next check ETA (${line})`);

  // TQ-4 (2026-10-03 review): the first state of every npm machine after this
  // release lands, written by the 1.89.0 helper that installed it: 'updated',
  // no identity, currentVersion = the old version, installedVersion = this one.
  reset();
  const PREV = `${PKG_MAJOR}.${Math.max(0, PKG_MINOR - 1)}.0`;
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 2 * HOUR, checkedAt: iso(NOW - 2 * HOUR) });
  writeJson(files.status, {
    protocol: 1, result: 'updated', checkedAt: iso(NOW - 2 * HOUR), currentVersion: PREV,
    latestVersion: PKG_VERSION, installedVersion: PKG_VERSION, lastUpdatedAt: iso(NOW - 2 * HOUR),
  });
  r = run();
  line = auLine(textOf(r));
  ok(r.autoUpdate.stale === false
    && new RegExp(`last result updated — installed v${PKG_VERSION.replace(/\./g, '\\.')} \\(from v${PREV.replace(/\./g, '\\.')}\\) \\(\\S+, 2h ago\\) · next check \\S+ \\(in 4h\\)`).test(line),
  `TQ-4: a legacy "updated" result describes the installed version, with its origin (${line})`);

  // A2 — the founder's case: a legacy dev-owned result, then an npm install.
  reset();
  writeJson(files.stamp, { lastCheck: NOW - 15 * HOUR });
  writeJson(files.status, { protocol: 1, result: 'dev-owned', checkedAt: iso(NOW - 15 * HOUR), currentVersion: '1.86.0' });
  r = run();
  line = auLine(textOf(r));
  ok(r.autoUpdate.stale === true
    && /the last result \(dev-owned v1\.86\.0, \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\) describes the previous install — this npm v\S+ install has not been checked yet · check due now — runs within 10 min while any KLYPIX session is open, or 2 s after the next one starts/.test(line)
    && !/last result dev-owned/.test(line) && r.verdict === 'ALIGNED',
  `A2: a result recorded for a previous install is named as such, never as this install's result (${line})`);

  // A2b — the same, with a live connection that should have run it. The
  // schedule re-opened when the receipts changed (9 h ago), not at the old
  // lastCheck + 5 min (15 h ago).
  liveSupervisor();
  r = run();
  line = auLine(textOf(r));
  ok(r.autoUpdate.overdue === true && /^\[!\] AUTO-UPDATE/.test(line)
    && /check overdue by 9h — no running session performed the check/.test(line)
    && r.verdict === 'PARTIAL' && r.readinessWarnings.some((w) => /automatic update check overdue by 9h/.test(w))
    && r.actions.some((a) => a.startsWith('/mcp reconnect one KLYPIX session')),
  `A2b: overdue while a live connection exists is a warning that makes the verdict PARTIAL (${line})`);

  // A2c — a doctor of another version computes the schedule with ITS rules.
  r = run({ doctorVersion: '0.0.1' });
  ok(r.autoUpdate.overdue === false && r.autoUpdate.overdueSuppressed === 'version-skew'
    && /these times follow this doctor's v0\.0\.1 rules; the installed updater is v\S+, so overdue is not judged/.test(textOf(r))
    && !r.readinessWarnings.some((w) => /overdue/.test(w)),
  'A2c: a doctor whose version differs from the installed updater never claims overdue');

  // A3 — failed once: a warning mark with the error, attempt and retry time;
  // one failure is a 15-min retry, not a readiness gap.
  reset();
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 5 * 60_000, failures: 1, nextCheckAt: NOW + 10 * 60_000, identity: npmIdentity });
  writeJson(files.status, {
    protocol: 1, result: 'failed', checkedAt: iso(NOW - 5 * 60_000), currentVersion: PKG_VERSION,
    identity: npmIdentity, attempt: 1, nextRetryAt: iso(NOW + 10 * 60_000), error: 'npm registry timed out after 8000ms',
  });
  r = run();
  line = auLine(textOf(r));
  ok(/^\[!\] AUTO-UPDATE/.test(line)
    && /last attempt failed safely \(\S+, 5m ago\): npm registry timed out after 8000ms · attempt 1 · next retry \S+ \(in 10m\)/.test(line)
    && r.layers.autoUpdate === 'warning' && r.verdict === 'ALIGNED',
  `A3: one failed attempt is a warning with the error, attempt and retry time — the verdict is unchanged (${line})`);

  // A4 — failed twice in a row: a readiness warning, PARTIAL (exit 0).
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 5 * 60_000, failures: 2, nextCheckAt: NOW + 55 * 60_000, identity: npmIdentity });
  writeJson(files.status, {
    protocol: 1, result: 'failed', checkedAt: iso(NOW - 5 * 60_000), currentVersion: PKG_VERSION,
    identity: npmIdentity, attempt: 2, error: 'EPERM: operation not permitted, rename',
  });
  r = run();
  ok(r.verdict === 'PARTIAL' && r.drifted === 0
    && r.readinessWarnings.some((w) => /automatic update check failed 2 times in a row \(last: EPERM/.test(w))
    && /brain PARTIAL: .*failed 2 times in a row/.test(driftLine(r)),
  'A4: two consecutive failures make the verdict PARTIAL, never DRIFTED');

  // A5 — overdue needs a live connection with updates on; none → just "due now".
  reset();
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 8 * HOUR, failures: 0, nextCheckAt: NOW - 2 * HOUR, identity: npmIdentity });
  writeJson(files.status, current(8 * HOUR));
  r = run();
  ok(r.autoUpdate.overdue === false && r.verdict === 'ALIGNED' && /check due now — runs within 10 min/.test(auLine(textOf(r))),
    'A5: a due check with no live connection is due, not overdue');
  liveSupervisor();
  r = run();
  ok(r.autoUpdate.overdue === true && /check overdue by 2h — no running session performed the check/.test(auLine(textOf(r)))
    && r.verdict === 'PARTIAL' && r.autoUpdate.overdueEvidence?.lastPollAt === iso(NOW - 5 * 60_000),
  'A5: the same check, polled by a live connection since it fell due, is overdue by 2h → PARTIAL');
  // K3 (2026-10-03): the evidence is a POLL after the check fell due, never a
  // session merely open since before it.
  liveSupervisor({ autoUpdate: { enabled: true, lastPollAt: iso(NOW - 2 * HOUR - 20 * 60_000) } });
  r = run();
  // TR-1 (2026-10-03 review): not judged, but not "due now — runs within
  // 10 min" either: the line says how long the check has been due and why it is
  // not called overdue.
  const dueSince = `${iso(NOW - 2 * HOUR).slice(0, 16)}Z`;   // the doctor's minute-precision UTC
  ok(r.autoUpdate.overdue === false && r.autoUpdate.overdueSuppressed === 'no-poll-evidence'
    && r.verdict === 'ALIGNED'
    && auLine(textOf(r)).includes(`check due since ${dueSince} (2h) — no open session has polled since then; it runs within 10 min while one is open`),
  `K3/TR-1: a machine that slept across the due time (last poll before it) is not overdue on waking — though its session has been open 10 h — and the line says how long it has been due (${auLine(textOf(r))})`);
  supervisorReceipt(brainDir, 'live', {
    bootedAt: iso(NOW - 10 * HOUR), updatedAt: iso(NOW - 30_000), active: { pid: process.pid, version: PKG_VERSION },
    autoUpdate: { enabled: true },
  });
  r = run();
  ok(r.supervisors.preFix.length === 1 && r.autoUpdate.overdue === false && r.autoUpdate.overdueSuppressed === 'no-poll-evidence'
    && r.verdict === 'ALIGNED',
  'K3: only pre-fix receipts (no lastPollAt) → overdue is not judged');
  ok(r.autoUpdate.dueForMs === 2 * HOUR && r.autoUpdate.unpolledSessions === 1
    && auLine(textOf(r)).includes(`check due since ${dueSince} (2h) — overdue is not judged: no open session has recorded a poll since then — 1 connection on pre-fix supervisor code records none (/mcp reconnect)`)
    && !/check due now|runs within/.test(auLine(textOf(r))),
  `TR-1: with only pre-fix receipts the line says the check has been due 2h and why it is not judged — never "due now — runs within 10 min" (${auLine(textOf(r))})`);
  // A FIXED supervisor that has not polled yet (it polls 2 s after it starts)
  // is not called pre-fix code.
  liveSupervisor({ bootedAt: iso(NOW - 1_000), autoUpdate: { enabled: true } });
  r = run();
  ok(r.autoUpdate.unpolledSessions === 0 && !/pre-fix/.test(auLine(textOf(r)))
    && auLine(textOf(r)).includes(`check due since ${dueSince} (2h) — no open session has polled since then; it runs within 10 min while one is open`),
  `TR-1: a fixed supervisor that has not polled yet is not counted as pre-fix code (${auLine(textOf(r))})`);
  // F9 (2026-10-03 review): a session that opened seconds ago — the first
  // SessionStart after an idle night — has polled, but the helper its poll
  // launched has not taken the lock yet. That poll is no evidence yet.
  liveSupervisor({ bootedAt: iso(NOW - 4_000), autoUpdate: { enabled: true, lastPollAt: iso(NOW - 2_000) } });
  r = run();
  ok(r.autoUpdate.overdue === false && r.autoUpdate.overdueSuppressed === 'no-poll-evidence'
    && r.verdict === 'ALIGNED'
    && /check due since \S+ \(2h\) — the latest poll on record \(\S+, <1m ago\) is too recent, or too close to the due time, to judge it overdue yet/.test(auLine(textOf(r))),
  `K3/F9: a check due 2 h ago with only a session that polled seconds ago is not overdue yet, and says why (${auLine(textOf(r))})`);
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 6 * HOUR - 30 * 60_000, failures: 0, nextCheckAt: NOW - 30 * 60_000, identity: npmIdentity });
  liveSupervisor({ autoUpdate: { enabled: true, lastPollAt: iso(NOW - 25 * 60_000) } });
  r = run();
  ok(r.autoUpdate.overdue === true && /check overdue by 30m — no running session performed the check/.test(auLine(textOf(r))),
    'K3: a tick 5 min after the check fell due that left the stamp unmoved → overdue once it is 30 min past due');
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 6 * HOUR - 29 * 60_000, failures: 0, nextCheckAt: NOW - 29 * 60_000, identity: npmIdentity });
  liveSupervisor({ autoUpdate: { enabled: true, lastPollAt: iso(NOW - 24 * 60_000) } });
  r = run();
  ok(r.autoUpdate.overdue === false && /check due now/.test(auLine(textOf(r))), 'K3: … and not a minute sooner');
  liveSupervisor({ autoUpdate: { enabled: false } });
  r = run();
  ok(r.autoUpdate.overdue === false && r.layers.autoUpdate === 'off'
    && /AUTO-UPDATE  off by KLYPIX_AUTO_UPDATE in all 1 live connection/.test(textOf(r)),
  'A5: a host that runs with KLYPIX_AUTO_UPDATE=0 is off — the doctor reads the host\'s recorded setting, not its own shell');

  // A6 — a newer npm version this machine already knows (no network), from
  // the freshest local source, with its age and what the updater will do.
  reset();
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 2 * HOUR, failures: 0, nextCheckAt: NOW + 4 * HOUR, identity: npmIdentity });
  writeJson(files.status, current(2 * HOUR));
  writeJson(files.cache, { pkg: 'klypix-mcp', latest: NEXT, checkedAt: NOW - HOUR, latestAt: NOW - HOUR });
  r = run();
  let text = textOf(r);
  ok(new RegExp(`· npm v${NEXT.replace(/\./g, '\\.')} known locally \\(session-end npm cache, 1h ago\\) — installs at the next check`).test(text)
    && r.autoUpdate.knownDecision === 'install' && r.layers.autoUpdate === 'ok',
  'A6: a newer cached npm version is shown with its age and "installs at the next check"');
  // A failed refresh stamps checkedAt but not latestAt: its age is unknown and
  // it never outranks the updater's own fresh fetch.
  writeJson(files.cache, { pkg: 'klypix-mcp', latest: NEXT, checkedAt: NOW - 60_000, lastError: 'timeout' });
  r = run();
  ok(r.autoUpdate.knownLatest?.version === PKG_VERSION && r.autoUpdate.knownLatest?.source === 'last update check'
    && !/known locally/.test(textOf(r)),
  'A6: a cache whose last refresh FAILED is not treated as fresh (latestAt rule)');

  // A7 — what the updater will NOT do, and why.
  reset({ dev: true });
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - HOUR, failures: 0, nextCheckAt: NOW + 5 * HOUR, identity: { ...npmIdentity, dev: true } });
  writeJson(files.status, { protocol: 1, result: 'dev-owned', checkedAt: iso(NOW - HOUR), currentVersion: PKG_VERSION, identity: { ...npmIdentity, dev: true } });
  writeJson(files.cache, { pkg: 'klypix-mcp', latest: NEXT, checkedAt: NOW - HOUR, latestAt: NOW - HOUR });
  r = run();
  text = textOf(r);
  ok(/^\[!\] AUTO-UPDATE/.test(auLine(text)) && /last result dev-owned — v\S+ at check time/.test(text)
    && /will NOT install automatically: developer-owned/.test(text)
    && r.layers.autoUpdate === 'warning' && r.verdict === 'ALIGNED',
  'A7: a developer-owned install with a newer release says it will NOT install automatically (warning mark, no verdict change)');
  reset();
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - HOUR, failures: 0, nextCheckAt: NOW + 5 * HOUR, identity: npmIdentity });
  writeJson(files.status, current(HOUR));
  writeJson(files.cache, { pkg: 'klypix-mcp', latest: NEXT_MAJOR, checkedAt: NOW - 30 * 60_000, latestAt: NOW - 30 * 60_000 });
  ok(/will NOT install automatically: new major/.test(textOf(run())), 'A7: a new major is never installed automatically, and the doctor says so');
  writeJson(files.status, current(HOUR, { result: 'held', latestVersion: NEXT, hold: { version: NEXT, since: iso(NOW - HOUR) } }));
  writeJson(files.cache, { pkg: 'klypix-mcp', latest: NEXT, checkedAt: NOW - 30 * 60_000, latestAt: NOW - 30 * 60_000 });
  ok(new RegExp(`will NOT install automatically: held after a manual downgrade to v${PKG_VERSION.replace(/\./g, '\\.')}`).test(textOf(run())),
    'A7: a recorded downgrade hold is named');
  // Before the helper records the hold, a --force downgrade shows only as a
  // stale manual-downgrade result; the decision must already account for it.
  writeJson(files.status, current(HOUR, { latestVersion: NEXT, currentVersion: NEXT, identity: { version: NEXT, managed: true, dev: false } }));
  r = run();
  ok(r.autoUpdate.staleReason === 'manual-downgrade' && r.autoUpdate.knownDecision === 'held'
    && !/installs at the next check/.test(textOf(r)),
  'A7: a deliberate downgrade is predicted as held — the doctor never promises to re-install the version the owner left');
  // A7b (2026-10-03 integration review) — a runtime no receipt names. The
  // helper decides with the version its spawner passes (the baked one), and so
  // does the SessionStart notice; the doctor promised an install the helper
  // refuses.
  reset();
  fs.rmSync(path.join(brainDir, '.mcp-runtime.json'), { force: true });
  fs.rmSync(path.join(brainDir, '.brain-version.json'), { force: true });
  writeJson(files.cache, { pkg: 'klypix-mcp', latest: NEXT_MAJOR, checkedAt: NOW - 30 * 60_000, latestAt: NOW - 30 * 60_000 });
  r = run();
  ok(r.autoUpdate.installedIdentity?.version === null && r.autoUpdate.knownDecision === 'major-blocked'
    && /will NOT install automatically: new major/.test(textOf(r)) && !/installs at the next check/.test(textOf(r)),
  'A7b: a receipt-less runtime with a new major known locally → "will NOT install automatically: new major", as the helper decides');
  reset();
  writeJson(files.cache, { pkg: 'klypix-mcp', latest: NEXT, checkedAt: NOW - HOUR, latestAt: NOW - HOUR });
  r = run({ env: OFF });
  ok(r.layers.autoUpdate === 'off' && /will NOT install automatically: disabled/.test(textOf(r)),
    'A7: auto-update off + a newer release known → "will NOT install automatically: disabled"');

  // A8 — `--npm` keeps its DRIFTED verdict but names the automatic path.
  reset();
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 2 * HOUR, failures: 0, nextCheckAt: NOW + 4 * HOUR, identity: npmIdentity });
  writeJson(files.status, current(2 * HOUR));
  r = run({ npmLatest: NEXT });
  ok(r.verdict === 'DRIFTED' && r.actions.some((a) => a.startsWith('npx klypix-mcp install')
    && /— or wait: auto-update installs it at the next check \(due \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z, in 4h\)/.test(a)),
  'A8: behind npm stays DRIFTED, and the action adds "or wait: auto-update installs it at the next check (due …)"');
  reset({ dev: true });
  r = run({ npmLatest: NEXT });
  ok(r.actions.some((a) => a.startsWith('npx klypix-mcp install')) && !r.actions.some((a) => /or wait/.test(a)),
    'A8: no "or wait" when the updater will not take the release (developer-owned)');

  // A9 — a running check, a never-run check, an attempt that recorded nothing.
  reset();
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 60_000, failures: 1, nextCheckAt: NOW + 14 * 60_000, identity: npmIdentity, inProgress: { pid: process.pid, startedAt: iso(NOW - 60_000) } });
  writeJson(files.status, current(7 * HOUR));
  writeJson(files.lock, { protocol: 1, token: `${process.pid}-fixture`, pid: process.pid, acquiredAt: NOW - 60_000 });
  r = run();
  line = auLine(textOf(r));
  ok(new RegExp(`check in progress since \\S+ \\(pid ${process.pid}\\)`).test(line)
    && r.autoUpdate.consecutiveFailures === 0 && /^\[ok\]/.test(line),
  `A9: a check in progress is shown as such, and its pessimistic pre-stamp is not a failure yet (${line})`);
  reset();
  liveSupervisor({ bootedAt: iso(NOW - 40_000), autoUpdate: { enabled: true, lastPollAt: iso(NOW - 38_000) } });
  r = run();
  ok(r.autoUpdate.overdue === false && /no check recorded yet · check due now/.test(auLine(textOf(r))),
    'A9: never checked, with a session whose first poll is seconds old, is "due now"');
  // F9 (2026-10-03 review): never-checked is due "now" by construction, so it
  // could never read overdue — a helper that never starts sat at "check due
  // now" forever. A session that polled 5 min ago and left no stamp is evidence.
  liveSupervisor();
  r = run();
  ok(r.autoUpdate.overdue === true && /no check recorded yet · check overdue by 10h — no running session performed the check/.test(auLine(textOf(r)))
    && r.verdict === 'PARTIAL',
  'F9/K3: never checked, though a session open 10 h polled 5 min ago, is overdue by 10h (measured from that session\'s start)');
  // TQ-2 (2026-10-03 review): the same never-checked install, no stamp at all,
  // with only a pre-fix receipt (no lastPollAt): nothing is evidence, and no
  // poll "in 1970" is invented from the missing one.
  supervisorReceipt(brainDir, 'live', {
    bootedAt: iso(NOW - 10 * HOUR), updatedAt: iso(NOW - 30_000), active: { pid: process.pid, version: PKG_VERSION },
    autoUpdate: { enabled: true },
  });
  r = run();
  ok(r.autoUpdate.overdue === false && r.autoUpdate.overdueSuppressed === 'no-poll-evidence' && r.verdict === 'ALIGNED'
    && !/overdue|1970/.test(auLine(textOf(r))),
  `TQ-2: never checked, no stamp, only a pre-fix receipt → overdue is not judged (${auLine(textOf(r))})`);
  reset();
  writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 30 * 60_000, failures: 1, nextCheckAt: NOW - 15 * 60_000, identity: npmIdentity });
  writeJson(files.status, current(7 * HOUR));
  ok(/last attempt \(\S+, 30m ago\) stopped before recording a result — counted as failed · attempt 1/.test(auLine(textOf(run()))),
    'A9: an attempt that recorded no result (helper killed) is shown as a failed attempt, not hidden behind the older result');

  // A10 — corrupt state never breaks the doctor (inspect + render are total).
  reset();
  writeJson(files.stamp, { lastCheck: 1e20, nextCheckAt: 'x', failures: -1, identity: null });
  fs.writeFileSync(files.status, '[]');
  let threw = null;
  try { r = run(); text = textOf(r); } catch (error) { threw = error; }
  ok(!threw && /AUTO-UPDATE/.test(text), `A10: a corrupt stamp/status renders instead of throwing (${threw?.message || 'ok'})`);

  // A11 — the harness pass reports WHY it skipped projects (stale registrations).
  reset();
  writeJson(files.status, current(HOUR, { harness: { checked: 5, updated: 1, unchanged: 1, failed: 0, skipped: 3, skippedReasons: { 'stale-registration': 3 }, projects: [] } }));
  ok(/AUTO-HARNESS\s+5 registered project\(s\) checked · 1 refreshed · 1 current · 0 partial · 3 skipped \(3 stale-registration\)/.test(textOf(run())),
    'A11: skipped harness projects are reported with their reason');
  fs.rmSync(home, { recursive: true, force: true });
}

// K2 (2026-10-03) — ONE overdue rule. The doctor and the SessionStart notice used
// to compute "overdue" separately, with different conditions. Both now ask the
// updater's autoUpdateOverdue; neither keeps a private grace or session clock.
// (CR stripped: Windows checkouts are CRLF.)
{
  const src = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8').replace(/\r/g, '');
  const doctor = src('brain-doctor.mjs');
  const hook = src('global-brain-hook.mjs');
  ok(/autoUpdateLib\.autoUpdateOverdue\(/.test(doctor) && /updater\.autoUpdateOverdue\(/.test(hook),
    'K2: the doctor and the SessionStart notice both judge overdue with the updater\'s autoUpdateOverdue');
  ok(!/OVERDUE_(GRACE_)?MS\s*=/.test(doctor) && !/OVERDUE_(GRACE_)?MS\s*=/.test(hook)
    && !/timeOf\(state\.bootedAt\)/.test(doctor) && !/supervisorOpenSince/.test(hook),
  'K2: neither keeps a private copy of the rule (no grace constant of its own, no session clock)');
}

// C6 — the doctor names its own engine version and warns when it is older
// than the brain it is judging (a pinned devDependency copy, 2026-10-03).
{
  const { home, brainDir, project } = doctorHome('doctor-version');
  installNpm(brainDir, { version: '99.0.0', installedAt: iso(Date.now() - HOUR) });
  let r = inspect({ home, projectDir: project, fmtLib: null, env: { KLYPIX_AUTO_UPDATE: '0' } });
  let text = render(r, { color: false });
  ok(r.doctor.version === PKG_VERSION && r.doctor.olderThanInstalled === true
    && text.split('\n')[0].includes(`(doctor engine v${PKG_VERSION})`)
    && new RegExp(`this doctor \\(v${PKG_VERSION.replace(/\./g, '\\.')}\\) is older than the installed brain v99\\.0\\.0 — .*run npx -y klypix-mcp@latest doctor`).test(text),
  'C6: the header names the doctor engine version and an older doctor says to run npx -y klypix-mcp@latest doctor');
  installNpm(brainDir, { version: PKG_VERSION, installedAt: iso(Date.now() - HOUR) });
  r = inspect({ home, projectDir: project, fmtLib: null, env: { KLYPIX_AUTO_UPDATE: '0' } });
  ok(r.doctor.olderThanInstalled === false && !/is older than the installed brain/.test(render(r, { color: false })),
    'C6: a doctor matching the installed brain does not warn');
  fs.rmSync(home, { recursive: true, force: true });
}

// MV-2/F1 (2026-10-03 review) — the AUTO-UPDATE line follows the INSTALLED
// updater's rules (AUTO_UPDATE_API in <brainDir>/mcp-auto-update.mjs), not this
// doctor's sibling module: after `npx klypix-mcp@<pre-hold> install --force` the
// installed helper is that release's, which has no hold and re-installs.
{
  const NOW = Date.now();
  const { home, brainDir, project } = doctorHome('installed-updater-rules');
  const files = {
    stamp: path.join(brainDir, '.autoupdate-check.json'),
    status: path.join(brainDir, '.autoupdate-status.json'),
    cache: path.join(brainDir, '.npm-currency.json'),
  };
  const esc = (value) => value.replace(/\./g, '\\.');
  const install = (updaterText) => {
    fs.writeFileSync(path.join(brainDir, 'mcp-auto-update.mjs'), updaterText);   // receipted with the rest
    installNpm(brainDir, { installedAt: iso(NOW - 9 * HOUR) });
  };
  // A --force downgrade from NEXT to this version that no check has seen yet.
  const downgraded = () => {
    writeJson(files.stamp, { protocol: 1, lastCheck: NOW - 2 * HOUR, checkedAt: iso(NOW - 2 * HOUR) });
    writeJson(files.status, {
      protocol: 1, result: 'current', checkedAt: iso(NOW - 2 * HOUR), currentVersion: NEXT, latestVersion: NEXT,
      identity: { version: NEXT, managed: true, dev: false },
    });
    writeJson(files.cache, { pkg: 'klypix-mcp', latest: NEXT, checkedAt: NOW - HOUR, latestAt: NOW - HOUR });
  };
  const run = () => inspect({ home, projectDir: project, now: NOW, fmtLib: null, env: {} });

  install('// a 1.89.0-era updater: 24 h stamp, no hold\nexport const AUTO_UPDATE_TTL_MS = 24 * 60 * 60 * 1000;\nexport async function runAutoUpdateCheck() {}\n');
  downgraded();
  let r = run();
  let text = render(r, { color: false });
  ok(r.autoUpdate.updaterRules === 'older' && r.autoUpdate.holdIgnored?.version === NEXT && r.autoUpdate.knownDecision === 'install'
    && /\[!\] AUTO-UPDATE  enabled · checks every 24h/.test(text)
    && new RegExp(`the downgrade to v${esc(PKG_VERSION)} is NOT held: the installed v${esc(PKG_VERSION)} updater predates the hold and re-installs v${esc(NEXT)} at its next check`).test(text)
    && !/will NOT install automatically: held/.test(text)
    && r.verdict === 'PARTIAL' && r.readinessWarnings.some((w) => /is not held: the installed .* updater predates the hold/.test(w))
    && r.actions.some((a) => a.startsWith('set KLYPIX_AUTO_UPDATE=0')),
  'MV-2/F1: with a pre-hold updater installed, the doctor never promises a hold — it says the downgrade will be re-installed and how to stay');
  ok(r.autoUpdate.dueAt === iso(NOW - 2 * HOUR + 24 * HOUR)
    && /these times and decisions follow the installed v\S+ updater's rules \(checks every 24h, no downgrade hold\), so overdue is not judged/.test(text),
  'F1: the next check and the cadence follow the installed api-1 rules (lastCheck + 24 h)');

  install(fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-auto-update.mjs'), 'utf8'));
  downgraded();
  r = run();
  text = render(r, { color: false });
  ok(r.autoUpdate.updaterRules === 'own' && r.autoUpdate.knownDecision === 'held' && !r.autoUpdate.holdIgnored
    && /will NOT install automatically: held after a manual downgrade/.test(text) && !/these times/.test(text),
  'F1: an installed updater with this doctor\'s rules (same AUTO_UPDATE_API) is judged by them — the hold stands');

  install('export const AUTO_UPDATE_API = 99;\nexport async function runAutoUpdateCheck() {}\n');
  downgraded();
  r = run();
  text = render(r, { color: false });
  ok(r.autoUpdate.updaterRules === 'newer' && r.autoUpdate.knownDecision === 'unknown' && r.autoUpdate.cadenceMs === null
    && /newer than this doctor: its schedule and decisions are not shown — run npx -y klypix-mcp@latest doctor/.test(text)
    && /next check unknown/.test(text) && !/checks every/.test(text.split('\n').find((l) => /AUTO-UPDATE/.test(l)) || ''),
  'F1: an installed updater newer than this doctor gets no schedule or decision from it');
  fs.rmSync(home, { recursive: true, force: true });
}

// F4 (2026-10-03 review) — the Claude Code SessionStart hook launches the
// updater with ITS environment. With the opt-out only in the MCP entries,
// brain-project sessions still update; the doctor said "off … disabled".
{
  const NOW = Date.now();
  const { home, brainDir, project } = doctorHome('hooks-only');
  installNpm(brainDir, { installedAt: iso(NOW - HOUR) });
  writeJson(path.join(home, '.claude', 'settings.json'), {
    hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse', 'PreToolUse']
      .map((event) => [event, [{ hooks: [{ type: 'command', command: 'node ~/.claude/project-brain/global-brain-hook.mjs' }] }]])),
  });
  supervisorReceipt(brainDir, 'off', {
    bootedAt: iso(NOW - HOUR), updatedAt: iso(NOW - 30_000), active: { pid: process.pid, version: PKG_VERSION },
    autoUpdate: { enabled: false }, supervisorVersion: PKG_VERSION,
  });
  writeJson(path.join(brainDir, '.npm-currency.json'), { pkg: 'klypix-mcp', latest: NEXT, checkedAt: NOW - HOUR, latestAt: NOW - HOUR });
  let r = inspect({ home, projectDir: project, now: NOW, fmtLib: null, env: {} });
  let text = render(r, { color: false });
  ok(r.autoUpdate.hooksOnly === true && r.layers.autoUpdate !== 'off' && r.autoUpdate.knownDecision === 'install'
    && /AUTO-UPDATE  enabled for Claude Code sessions in brain projects only — off by KLYPIX_AUTO_UPDATE in all 1 live MCP connection/.test(text)
    && !/will NOT install automatically: disabled/.test(text),
  'F4: MCP connections off but the Claude Code hooks on → updates still run there; never "will NOT install: disabled"');
  r = inspect({ home, projectDir: project, now: NOW, fmtLib: null, env: { KLYPIX_AUTO_UPDATE: '0' } });
  text = render(r, { color: false });
  ok(r.layers.autoUpdate === 'off' && /off by KLYPIX_AUTO_UPDATE in all 1 live connection \(the Claude Code hooks read their own environment\)/.test(text),
    'F4: with this environment off too it reads off — and says the hooks read their own environment');
  fs.rmSync(home, { recursive: true, force: true });
}

// C7 — unreceipted engine code: a module in the managed directory that no
// install receipt covers is a readiness warning naming the merge-driver risk.
{
  const { home, brainDir, project } = doctorHome('engine-code');
  installNpm(brainDir, { installedAt: iso(Date.now() - HOUR) });
  const run = () => inspect({ home, projectDir: project, fmtLib: null, env: { KLYPIX_AUTO_UPDATE: '0' } });
  let r = run();
  ok(r.engineCode.checked && r.engineCode.unreceipted.length === 0 && r.layers.engineCode === 'ok'
    && /ENGINE\s+all 2 engine module\(s\) covered by the v\S+ install receipt/.test(render(r, { color: false })),
  'C7: a fully receipted directory reads ok');
  fs.writeFileSync(path.join(brainDir, 'stray-helper.mjs'), '// added by hand\n');
  fs.writeFileSync(path.join(brainDir, 'klypix-brain.mjs'), '// the desktop installer adds this one\n');
  r = run();
  let text = render(r, { color: false });
  ok(r.engineCode.unreceipted.join(',') === 'stray-helper.mjs' && r.engineCode.desktopExtras.join(',') === 'klypix-brain.mjs'
    && r.layers.engineCode === 'warning' && r.verdict === 'PARTIAL' && r.drifted === 0
    && r.readinessWarnings.some((w) => /^1 unreceipted engine file in the managed directory \(stray-helper\.mjs\) — no installer vouches for it$/.test(w))
    && /\[!\] ENGINE\s+1 module\(s\) outside the v\S+ install receipt: stray-helper\.mjs — no installer vouches for this code$/m.test(text)
    && r.actions.some((a) => a.startsWith('review, then remove stray-helper.mjs')),
  'C7: an unreceipted module is PARTIAL; a desktop-installed script is allowlisted');
  ok(!r.readinessWarnings.some((w) => /merge driver/.test(w)) && !/merge driver/.test(text.split('\n').find((line) => /ENGINE/.test(line)) || ''),
    'F7: the git merge-driver risk is not claimed for a file the driver never loads');
  // F7 (2026-10-03 review): a module a release staged and a later one dropped
  // without deleting. remote-client.mjs sits on every machine that ever ran
  // v1.66.1–v1.72.0; as an "unreceipted engine file" it read PARTIAL forever.
  fs.rmSync(path.join(brainDir, 'stray-helper.mjs'));
  fs.writeFileSync(path.join(brainDir, 'remote-client.mjs'), '// left by v1.66.1–v1.72.0\n');
  r = run();
  text = render(r, { color: false });
  ok(r.engineCode.unreceipted.length === 0 && r.engineCode.retired.map((item) => item.name).join(',') === 'remote-client.mjs'
    && r.layers.engineCode === 'ok' && !r.readinessWarnings.some((w) => /unreceipted/.test(w))
    && /remote-client\.mjs: retired \(KLYPIX Remote, staged by v1\.66\.1–v1\.72\.0\); nothing imports it — safe to delete/.test(text),
  'F7: a retired module is a leftover to delete, never a permanent readiness warning');
  fs.writeFileSync(path.join(brainDir, 'klypix-merge-driver.mjs'), '// a driver no receipt covers\n');
  fs.writeFileSync(path.join(brainDir, 'merge-brains.mjs'), '// its engine\n');
  r = run();
  text = render(r, { color: false });
  ok(r.engineCode.mergeDriverFiles.join(',') === 'klypix-merge-driver.mjs,merge-brains.mjs'
    && /including the git merge driver's own code \(klypix-merge-driver\.mjs, merge-brains\.mjs\), which runs on every brain merge/.test(text)
    && r.readinessWarnings.some((w) => /the KLYPIX git merge driver runs klypix-merge-driver\.mjs, merge-brains\.mjs on every brain merge/.test(w)),
  'C7: an unreceipted git merge driver is called out by name');
  ok(r.actions.some((a) => a.startsWith('npx -y klypix-mcp@latest install --force') && /git merge driver's own code/.test(a))
    && !r.actions.some((a) => /remove [^#]*(klypix-merge-driver|merge-brains)\.mjs/.test(a)),
  'F7: the driver\'s own files get a reinstall (which receipts them), never "remove" — merge.klypix.driver runs them');
  fs.rmSync(path.join(brainDir, '.mcp-runtime.json'));
  r = run();
  ok(!r.engineCode.checked && r.layers.engineCode === 'n/a' && !r.readinessWarnings.some((w) => /unreceipted/.test(w)),
    'C7: without a receipt there is nothing to compare — no warning');
  fs.rmSync(home, { recursive: true, force: true });
}

// The doctor diagnoses half-applied installs (renames land one file at a time),
// so it must load and render beside a MISSING mcp-auto-update.mjs. It imported
// that module by name, which fails the whole doctor at link time.
{
  const flat = path.join(os.tmpdir(), `klypix-doctor-flat-${process.pid}`);
  fs.rmSync(flat, { recursive: true, force: true });
  fs.mkdirSync(flat, { recursive: true });
  const srcDir = path.join(__dirname, '..', 'src');
  for (const f of fs.readdirSync(srcDir).filter((name) => name.endsWith('.mjs') && name !== 'mcp-auto-update.mjs')) {
    fs.copyFileSync(path.join(srcDir, f), path.join(flat, f));
  }
  const { home, brainDir, project } = doctorHome('flat-no-updater');
  installNpm(brainDir, { installedAt: iso(Date.now() - HOUR) });
  let report = null;
  let text = '';
  let threw = null;
  try {
    const flatDoctor = await import(pathToFileURL(path.join(flat, 'brain-doctor.mjs')).href);
    report = flatDoctor.inspect({ home, projectDir: project, fmtLib: null, env: { KLYPIX_AUTO_UPDATE: '' } });
    text = flatDoctor.render(report, { color: false });
  } catch (error) { threw = error; }
  ok(!threw && report?.autoUpdate?.moduleUnavailable === true && report.layers.autoUpdate === 'warning'
    && /AUTO-UPDATE\s+state unknown — mcp-auto-update\.mjs could not be loaded/.test(text)
    && report.actions.some((a) => /mcp-auto-update\.mjs could not be loaded/.test(a)),
  `the doctor loads and renders beside a missing mcp-auto-update.mjs (${threw?.message || 'ok'})`);
  fs.rmSync(flat, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

// ── E1 — the structured result brain_doctor returns next to its text ─────────
// (2026-10-03) The same verdict as data. A projection, not the report: the
// harness pass drops its per-project list and the supervisor sub-lists are pids
// into `live`, so a host that hands structuredContent to the model pays little.
{
  const NOW = Date.now();
  const { home, brainDir, project } = doctorHome('structured');
  installNpm(brainDir, { installedAt: iso(NOW - 2 * HOUR) });
  writeJson(path.join(brainDir, '.autoupdate-check.json'), {
    protocol: 1, lastCheck: NOW - HOUR, failures: 0, nextCheckAt: NOW - HOUR + AUTO_UPDATE_TTL_MS,
  });
  writeJson(path.join(brainDir, '.autoupdate-status.json'), {
    protocol: 1, result: 'current', checkedAt: iso(NOW - HOUR), currentVersion: PKG_VERSION, latestVersion: PKG_VERSION,
    identity: { version: PKG_VERSION, managed: true, dev: false },
    harness: {
      checked: 2, updated: 0, unchanged: 2, failed: 0, skipped: 0, checkedAt: iso(NOW - HOUR),
      projects: [{ project: 'E:/a', status: 'unchanged' }, { project: 'E:/b', status: 'unchanged' }],
    },
  });
  // One fixed pair asleep on the installed version, one pre-fix pair serving it.
  supervisorReceipt(brainDir, 'sleeping', {
    status: 'hibernated', active: null, updatedAt: iso(NOW - 5_000), supervisorVersion: PKG_VERSION,
    hibernation: { hibernated: true, target: { version: PKG_VERSION, path: 'C:/runtime/klypix-mcp-worker.mjs' } },
    transport: { host: 'connected', delivery: 'pull-only' }, autoUpdate: { enabled: true },
  });
  supervisorReceipt(brainDir, 'prefix', {
    pid: process.ppid, updatedAt: iso(NOW - 5_000),
    active: { pid: process.ppid, version: PKG_VERSION, path: 'C:/runtime/klypix-mcp-worker.mjs' },
    hibernation: { hibernated: false },
  });
  const r = inspect({ home, projectDir: project, now: NOW, fmtLib: null, env: {} });
  const s = structuredReport(r);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok(same(Object.keys(s).sort(), ['actions', 'autoUpdate', 'layers', 'readinessWarnings', 'schemaVersion', 'supervisors', 'verdict', 'version']),
    `E1: structuredContent carries exactly {schemaVersion, verdict, layers, version, autoUpdate, supervisors, readinessWarnings, actions} (got ${Object.keys(s).join(', ')})`);
  ok(s.schemaVersion === 1 && s.verdict === r.verdict && same(s.layers, r.layers)
    && same(s.readinessWarnings, r.readinessWarnings) && same(s.actions, r.actions),
  'E1: the verdict, layers, readiness warnings and actions are the report\'s own');
  ok(s.version.baked === PKG_VERSION && s.version.channel === 'npm' && s.version.installed === true
    && s.version.doctor?.version === r.doctor.version && s.version.running?.known === r.running.known,
  'E1: version names the installed core, the doctor engine and the running server');
  ok(s.autoUpdate.result === 'current' && s.autoUpdate.dueAt === r.autoUpdate.dueAt
    && s.autoUpdate.cadenceMs === AUTO_UPDATE_TTL_MS && s.autoUpdate.effectiveEnabled === true
    && s.autoUpdate.decision === r.autoUpdate.decision && s.autoUpdate.overdue === false
    && s.autoUpdate.harness?.checked === 2 && !('projects' in s.autoUpdate.harness),
  'E1: autoUpdate carries the schedule and decision; the harness keeps its counts, not its per-project list');
  const pair = (pid) => s.supervisors.live.find((item) => item.pid === pid);
  ok(s.supervisors.count === 2 && s.supervisors.live.length === 2
    && s.supervisors.live.every((item) => !('hibernation' in item) && !('transport' in item))
    && pair(process.pid)?.status === 'hibernated' && pair(process.pid)?.supervisorVersion === PKG_VERSION
    && pair(process.ppid)?.preFix === true
    && same(s.supervisors.hibernated, [process.pid]) && same(s.supervisors.preFix, [process.ppid])
    && same(s.supervisors.impaired, []),
  'E1: supervisors list each live pair compactly; sub-lists are pids into live');
  ok(same(JSON.parse(JSON.stringify(s)), s), 'E1: the structured result survives a JSON round trip unchanged');
  let threw = null;
  let minimal = null;
  let hostile = null;
  try {
    minimal = structuredReport(null);
    hostile = structuredReport({ verdict: 'ALIGNED', get layers() { throw new Error('boom'); } });
  } catch (error) { threw = error; }
  ok(!threw && minimal?.schemaVersion === 1 && minimal.verdict === null
    && hostile?.verdict === 'ALIGNED' && hostile?.error === 'boom',
  `E1: structuredReport is total — a missing or hostile report yields a minimal result, never a throw (${threw?.message || 'ok'})`);
  fs.rmSync(home, { recursive: true, force: true });
}

// ── PART B — brain_doctor as a real MCP verb ─────────────────────────────────
{
  const vault = makeVault();
  await seedBrain(vault);
  const isolatedHome = path.join(vault, '.test-home');
  fs.mkdirSync(isolatedHome, { recursive: true });
  const client = new Client({ name: 'doctor-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, '--vault', vault],
    env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, KLYPIX_AUTO_UPDATE: '0' },
  });
  await client.connect(transport);

  const names = (await client.listTools()).tools.map(t => t.name);
  ok(client.getInstructions()?.includes('call brain_sync'),
    'MCP initialize response carries the portable smart-awareness instructions');
  ok(names.includes('brain_doctor'), 'brain_doctor is a registered MCP tool');
  ok(names.includes('brain_message'), 'brain_message is a registered MCP tool');
  ok(names.includes('brain_message_receipt'), 'brain_message_receipt is a registered MCP tool');
  ok(names.includes('brain_sync'), 'brain_sync is a registered MCP tool');
  ok(names.includes('brain_ask'), 'brain_ask is a registered MCP tool');
  ok(names.includes('brain_challenge'), 'brain_challenge is a registered MCP tool');
  ok(names.includes('canvas_view'), 'canvas_view is a registered MCP tool');
  ok(names.includes('brain_lens'), 'brain_lens is a registered MCP tool');
  ok(names.includes('project_map_scan'), 'project_map_scan is a registered MCP tool');
  ok(names.includes('project_map_drift'), 'project_map_drift is a registered MCP tool');
  ok(names.includes('brain_reopen'), 'brain_reopen is a registered MCP tool');
  ok(names.includes('klypix_status'), 'klypix_status is a registered MCP tool');
  ok(names.includes('read_card_contents'), 'read_card_contents is a registered MCP tool');
  // show_in_klypix (agent parity P1) is app-only: registered where a KLYPIX app
  // can run — Windows, or KLYPIX_APP_TOOLS=on. 25 on the Ubuntu CI, 26 on Windows.
  const appToolsHere = process.platform === 'win32' || process.env.KLYPIX_APP_TOOLS === 'on';
  const expectedTools = 25 + (appToolsHere ? 1 : 0);
  ok(names.includes('show_in_klypix') === appToolsHere, `show_in_klypix is registered exactly where a KLYPIX app can run (${appToolsHere ? 'here' : 'not here'})`);
  ok(names.length === expectedTools, `tool manifest is ${expectedTools} verbs on ${process.platform} (got ${names.length})`);
  // Doctor's TOOLS line counts by a static scan; the app tools register from
  // app-tools.mjs beside the worker, so the scan must read that file too, and
  // apply the same platform rule to show_in_klypix.
  {
    const emptyHome = path.join(vault, '.doctor-tools-home');
    fs.mkdirSync(emptyHome, { recursive: true });
    const scanned = inspect({ home: emptyHome, projectDir: vault, fmtLib: null });
    const rendered = render(scanned, { color: false }).split('\n');
    const toolsLine = rendered.find(l => /TOOLS/.test(l)) || '';
    ok(scanned.tools.source === 'package' && scanned.tools.count === expectedTools
      && scanned.tools.names.includes('klypix_status') && scanned.tools.names.includes('read_card_contents')
      && scanned.tools.names.includes('show_in_klypix') === appToolsHere,
    `doctor's static tool scan counts ${expectedTools} and includes the app tools this platform registers (got ${scanned.tools.count} from ${scanned.tools.source})`);
    ok(toolsLine.includes('klypix_status') && toolsLine.includes('read_card_contents'), 'doctor\'s TOOLS line lists klypix_status and read_card_contents');
    // The App bridge line: running, access, protocol — from endpoint.json only,
    // never the token or the pipe name.
    const prevBridge = process.env.KLYPIX_APP_BRIDGE_DIR;
    const bridgeDir = path.join(vault, '.doctor-bridge');
    fs.mkdirSync(bridgeDir, { recursive: true });
    process.env.KLYPIX_APP_BRIDGE_DIR = bridgeDir;
    const pipeName = 'klypix-agent-SECRETPIPE0123456789';
    const tokenValue = 'ab'.repeat(32);
    fs.writeFileSync(path.join(bridgeDir, 'endpoint.json'), JSON.stringify({ v: 1, protocol: 'klypix-app-bridge/1', pid: process.pid, appVersion: '1.3.200', startedAt: new Date().toISOString(), access: 'on', pipe: pipeName, openFiles: [] }));
    fs.writeFileSync(path.join(bridgeDir, 'token'), tokenValue);
    const live = inspect({ home: emptyHome, projectDir: vault, fmtLib: null });
    const liveText = render(live, { color: false });
    const bridgeLine = liveText.split('\n').find(l => /App bridge/.test(l)) || '';
    const structured = JSON.stringify(structuredReport(live));
    ok(/KLYPIX v1\.3\.200 running · access for AI tools on · protocol klypix-app-bridge\/1/.test(bridgeLine), `doctor prints an App bridge line: running, access, protocol (${bridgeLine.trim()})`);
    ok(live.appBridge?.running === true && live.appBridge.access === 'on' && live.appBridge.protocolSupported === true, 'the report carries appBridge (the E1 structured projection is unchanged)');
    ok(![liveText, structured, JSON.stringify(live.appBridge)].some(s => s.includes(pipeName) || s.includes(tokenValue)), 'the token and the pipe name appear nowhere in doctor\'s output');
    fs.rmSync(path.join(bridgeDir, 'endpoint.json'));
    const closed = render(inspect({ home: emptyHome, projectDir: vault, fmtLib: null }), { color: false }).split('\n').find(l => /App bridge/.test(l)) || '';
    ok(/file mode/.test(closed), `with KLYPIX closed the App bridge line says file mode (${closed.trim()})`);
    if (prevBridge === undefined) delete process.env.KLYPIX_APP_BRIDGE_DIR; else process.env.KLYPIX_APP_BRIDGE_DIR = prevBridge;
  }
  // KLYPIX Remote was dropped from the product; its four verbs went with it.
  // Assert their ABSENCE so the removal cannot silently regress — a brain that
  // still advertises them promises a relay that can only fail.
  for (const remoteTool of ['remote_status', 'remote_sessions', 'remote_actions', 'remote_command']) {
    ok(!names.includes(remoteTool), `${remoteTool} is gone with KLYPIX Remote`);
  }

  // Seed one real lane receipt for THIS MCP session. The doctor must use the
  // adopted session id passed by the running worker, not guess a sender.
  const lane = laneFileFor(path.join(vault, 'brain.klypix'), isolatedHome);
  const laneData = JSON.parse(fs.readFileSync(lane, 'utf8'));
  const self = laneData.sessions?.[0];
  const receiptNow = Date.now();
  laneData.sessions.push({
    id: 'doctor-peer', client: 'codex', branch: 'master', intent: 'receipt test',
    files: ['src/receipt-peer.mjs'], startedAt: receiptNow - 60_000,
    lastSeen: receiptNow, channelSeen: {},
  });
  laneData.messages.push({
    id: 'doctor-receipt', from: self.id, to: 'all', text: 'verified doctor receipt',
    ts: receiptNow - 1_000,
    candidateIds: ['doctor-peer'],
    deliveryVersion: 3,
    deliveries: [{
      recipientId: 'doctor-peer',
      state: 'consumed',
      attempts: 1,
      offeredAt: receiptNow - 900,
      acknowledgedAt: receiptNow - 500,
      consumedAt: receiptNow - 250,
      consumedVia: 'receipt',
      offerToken: 'doctor-test-offer-token',
    }],
    seen: ['doctor-peer'],
  });
  fs.writeFileSync(lane, JSON.stringify(laneData, null, 2));

  const r = await client.callTool({ name: 'brain_doctor', arguments: { project: vault } });
  const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  ok(r.isError !== true, 'brain_doctor call is not an error');
  ok(/brain_doctor/.test(text) && /VERSION/.test(text) && /CLAUDE/.test(text)
    && /CODEX/.test(text) && /SESSIONS/.test(text),
  'brain_doctor returns the host-neutral layered verdict');
  ok(/2 logical sessions · 2 live connections/.test(text),
    'the MCP connection and synthetic live peer are counted separately without hooks');
  ok(/your last note \(just now\): explicitly consumed by all 1 target peer\(s\) via receipt \(not human-read\)\./.test(text),
    'brain_doctor renders a real explicit consumption receipt without claiming a human read it');
  // E1 (2026-10-03): the same verdict as data, over real MCP, next to the text.
  const sc = r.structuredContent;
  const head = text.split('\n')[0] || '';
  ok(sc && sc.schemaVersion === 1
    && ['verdict', 'layers', 'version', 'autoUpdate', 'supervisors', 'readinessWarnings', 'actions'].every((key) => key in sc)
    && typeof sc.verdict === 'string' && head.includes(sc.verdict.replace('-', ' '))
    && Array.isArray(sc.actions) && Array.isArray(sc.readinessWarnings) && Array.isArray(sc.supervisors?.live)
    && typeof sc.layers?.autoUpdate === 'string' && 'dueAt' in (sc.autoUpdate || {}),
  `E1: brain_doctor returns structuredContent whose verdict matches its text (${sc ? sc.verdict : 'none'} vs "${head}")`);

  const synced = await client.callTool({
    name: 'brain_sync',
    arguments: { phase: 'start', intent: 'verify shared klypix-core MCP protocol awareness', files: ['test/brain-doctor.mjs'] },
  });
  const syncedText = (synced.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  ok(/phase start/.test(syncedText)
    && /No exact file overlap/.test(syncedText)
    && /Compact task context/.test(syncedText)
    && synced.structuredContent?.context?.mode === 'lexical-fast'
    && Number.isFinite(synced.structuredContent?.timingMs?.total),
  'brain_sync returns structured coordination + bounded task memory end-to-end over plain MCP');

  const runningRegistry = path.join(isolatedHome, '.claude', 'project-brain', '.running-servers.json');
  const during = JSON.parse(fs.readFileSync(runningRegistry, 'utf8'));
  ok(during.servers?.some(server => server.lastSeenAt),
    'the live MCP worker publishes a renewable registry heartbeat');

  await client.close();
  let stoppedReport = null;
  for (let i = 0; i < 20; i++) {
    stoppedReport = inspect({ home: isolatedHome, projectDir: vault });
    if (!stoppedReport.running?.servers?.length) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  ok(!stoppedReport?.running?.servers?.length,
    'doctor ignores a stopped MCP worker even if forced host shutdown interrupts registry cleanup');
  fs.rmSync(vault, { recursive: true, force: true });
}

// ── PART F — write and audit share ONE editor filter (1.82.1) ────────────────
// Field finding 2026-09-01 (install-smoke on clean ubuntu + macos runners): `install`
// projected 3 files for the 2 hosts present, then `doctor` audited all 14 and printed
// "11 of 14 drifted — MISSING" for editors nobody had, exiting 1 on a new user's first
// command. auditProject must accept the same `editors` set linkProject wrote with, and
// inspect() must pass the detected set (opts.editors is the test seam).
{
  const proj = path.join(os.tmpdir(), 'klypix-doctor-test-editors');
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'brain.klypix'), 'stub');
  const present = new Set(['claude-code', 'codex']);          // what a fresh CI runner has after install
  const wrote = linkProject(proj, { version: '1.2.3', editors: present });
  const written = [...wrote.rules, ...wrote.mcp].map((f) => f.file).sort();
  ok(written.join(',') === ['.codex/config.toml', '.mcp.json', 'AGENTS.md'].join(','),
    `F1 install-style link for {claude-code, codex} writes exactly 3 files (${written.join(', ')})`);

  const unfiltered = auditProject(proj, { version: '1.2.3' });
  ok(!unfiltered.ok && unfiltered.drift.length === 11,
    `F2 the OLD unfiltered audit of that project reports 11 MISSING (the bug: ${unfiltered.drift.length})`);

  const filtered = auditProject(proj, { version: '1.2.3', editors: present });
  ok(filtered.ok && filtered.drift.length === 0 && filtered.files.length === 3,
    `F3 auditing with the same editor set is clean: ${filtered.files.length} files, ${filtered.drift.length} drift`);
  const notHere = (filtered.skipped || []).filter((x) => /not installed/.test(x.why || ''));
  ok(notHere.length === 11, `F4 the 11 not-applicable targets are REPORTED as skipped, not silently dropped (${notHere.length})`);

  // A file a teammate committed stays audited even though this machine lacks that editor.
  fs.mkdirSync(path.join(proj, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.cursor', 'rules', 'klypix-brain.mdc'), 'hand-written, no fence');
  const teammate = auditProject(proj, { version: '1.2.3', editors: present });
  ok(teammate.files.some((f) => f.file === '.cursor/rules/klypix-brain.mdc') && !teammate.ok,
    'F5 a committed Cursor rule is still audited (and its missing fence is real drift) without Cursor installed');
  fs.rmSync(path.join(proj, '.cursor'), { recursive: true, force: true });

  // inspect(): the seam pins the set; null forces the legacy unfiltered audit.
  const home = path.join(os.tmpdir(), 'klypix-doctor-test-editors-home');
  fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
  const rFiltered = inspect({ home, projectDir: proj, editors: present });
  ok(rFiltered.harness.ok && rFiltered.layers.harness === 'ok',
    `F6 doctor with the detected-editor set → HARNESS ok (${rFiltered.harness.files.length} audited)`);
  const rLegacy = inspect({ home, projectDir: proj, editors: null });
  ok(!rLegacy.harness.ok && rLegacy.layers.harness === 'drift',
    'F7 doctor with editors:null reproduces the old all-14 verdict (seam works both ways)');
  const text = render(rFiltered);
  ok(/HARNESS.*all 3 projected file\(s\) in sync/.test(text) && /11 host file\(s\) not audited/.test(text),
    'F8 the rendered HARNESS line says what was audited AND what was not applicable');
  fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
}


console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ brain-doctor: all assertions passed');
process.exit(failures ? 1 : 0);
