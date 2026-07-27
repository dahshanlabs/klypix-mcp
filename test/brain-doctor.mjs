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
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  auditProject,
  connectCodexMcpServer,
  disconnectCodexMcpServer,
  linkProject,
  safeReadCodexConfig,
} from '../src/agent-rules.mjs';
import { inspect } from '../src/brain-doctor.mjs';
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
    env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
  });
  await client.connect(transport);

  const names = (await client.listTools()).tools.map(t => t.name);
  ok(client.getInstructions()?.includes('call brain_sync'),
    'MCP initialize response carries the portable smart-awareness instructions');
  ok(names.includes('brain_doctor'), 'brain_doctor is a registered MCP tool');
  ok(names.includes('brain_message'), 'brain_message is a registered MCP tool');
  ok(names.includes('brain_sync'), 'brain_sync is a registered MCP tool');
  ok(names.includes('brain_ask'), 'brain_ask is a registered MCP tool');
  ok(names.includes('brain_challenge'), 'brain_challenge is a registered MCP tool');
  ok(names.includes('canvas_view'), 'canvas_view is a registered MCP tool');
  ok(names.includes('brain_lens'), 'brain_lens is a registered MCP tool');
  ok(names.length === 18, `tool manifest is 18 verbs (got ${names.length})`);

  const r = await client.callTool({ name: 'brain_doctor', arguments: { project: vault } });
  const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  ok(r.isError !== true, 'brain_doctor call is not an error');
  ok(/brain_doctor/.test(text) && /VERSION/.test(text) && /CLAUDE/.test(text)
    && /CODEX/.test(text) && /SESSIONS/.test(text),
  'brain_doctor returns the host-neutral layered verdict');
  ok(/1 active/.test(text), 'the MCP connection itself is counted as a live session without hooks');

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

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ brain-doctor: all assertions passed');
process.exit(failures ? 1 : 0);
