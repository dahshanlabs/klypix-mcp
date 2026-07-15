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
import { linkProject, auditProject } from '../src/agent-rules.mjs';
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
  fs.writeFileSync(path.join(proj, 'brain.klypix'), 'stub');   // hasBrain → projection makes sense

  linkProject(proj, { version: '1.2.3' });
  let a = auditProject(proj, { version: '1.2.3' });
  ok(a.ok && a.drift.length === 0, `fresh link → all ${a.files.length} files ok`);
  ok(a.files.length === 9, 'projects exactly 9 targets (7 rules + 2 mcp)');
  ok(statusOf(a, 'GEMINI.md') === 'ok' && statusOf(a, 'CONVENTIONS.md') === 'ok', 'GEMINI.md + CONVENTIONS.md generated (were "not generated")');

  // ZERO-TOUCH — newer current version but IDENTICAL content → still ok (a version-
  // only bump must not re-drift every adopter project into a re-link treadmill).
  a = auditProject(proj, { version: '2.0.0' });
  ok(statusOf(a, 'AGENTS.md') === 'ok', 'older stamp + content-identical block → ok (zero-touch patch release)');
  ok(statusOf(a, '.cursor/mcp.json') === 'ok', 'mcp.json is version-agnostic → ok');

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

  // a customized --vault path stays OK (we only require the invocation to survive).
  cfg.mcpServers['klypix-canvas'] = { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '/some/custom/path'] };
  fs.writeFileSync(cur, JSON.stringify(cfg, null, 2));
  a = auditProject(proj, { version: '1.2.3' });
  ok(statusOf(a, '.cursor/mcp.json') === 'ok', 'customized --vault path tolerated → ok');

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
  const client = new Client({ name: 'doctor-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, '--vault', vault] });
  await client.connect(transport);

  const names = (await client.listTools()).tools.map(t => t.name);
  ok(names.includes('brain_doctor'), 'brain_doctor is a registered MCP tool');
  ok(names.includes('brain_message'), 'brain_message is a registered MCP tool');
  ok(names.includes('brain_ask'), 'brain_ask is a registered MCP tool');
  ok(names.includes('brain_challenge'), 'brain_challenge is a registered MCP tool');
  ok(names.includes('canvas_view'), 'canvas_view is a registered MCP tool');
  ok(names.length === 16, `tool manifest is 16 verbs (got ${names.length})`);

  const r = await client.callTool({ name: 'brain_doctor', arguments: { project: vault } });
  const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  ok(r.isError !== true, 'brain_doctor call is not an error');
  ok(/brain_doctor/.test(text) && /VERSION/.test(text) && /HOOKS/.test(text), 'brain_doctor returns the layered verdict');

  await client.close();
  fs.rmSync(vault, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ brain-doctor: all assertions passed');
process.exit(failures ? 1 : 0);
