// tool-profile — the MCP tool profile (KLYPIX_TOOLS): `core` (6 tools), `all`
// (everything), or a comma list of tool names (src/tool-profile.mjs).
//
// What this proves, over real processes where it matters:
//   A. parsing: core / all / lists / unknown names / an empty selection.
//   B. the env policy an MCP entry gets (keep what exists; new entries get core;
//      an explicit value overrides).
//   C. link writes and preserves KLYPIX_TOOLS in the JSON configs and the Codex
//      TOML; readLaunchSpec / readMcpEntryEnv read it back from both shapes.
//   D. the managed instruction block tells an agent what a missing tool means.
//   E. a real stdio handshake: KLYPIX_TOOLS=core → exactly the 6 core tools
//      (worker and supervisor); `brain_sync,bogus` → 1 tool and a stderr
//      warning; no KLYPIX_TOOLS → every tool (the default rule), and the known
//      list in tool-profile.mjs equals what the worker registers.
//   F. doctor's TOOLS line reports the profile the project's MCP entry launches.
//   G. `klypix-install`: a NEW entry gets KLYPIX_TOOLS=core in .mcp.json and
//      .codex/config.toml; `--tools all` rewrites both.
//
// Every process runs in a throwaway HOME / USERPROFILE / KLYPIX_MCP_INSTALL_DIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CORE_TOOLS, KNOWN_TOOLS, entryEnvWithTools, parseToolSelection, resolveToolProfile, toolProfileInstructions,
} from '../src/tool-profile.mjs';
import {
  BRAIN_INSTRUCTIONS, connectCodexMcpServer, linkProject, mcpServerEntry, readMcpEntryEnv, safeReadCodexConfig,
} from '../src/agent-rules.mjs';
import { readLaunchSpec } from '../src/mcp-verify.mjs';
import { inspect, render } from '../src/brain-doctor.mjs';
import { buildKlypixMap } from '../src/klypix-format.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-tool-profile-'));
const tmp = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };
// This process must not carry a profile into what it inspects or spawns.
delete process.env.KLYPIX_TOOLS;
delete process.env.KLYPIX_PLUGIN;

// ── A — parsing ──────────────────────────────────────────────────────────────
{
  ok(CORE_TOOLS.length === 6 && same(CORE_TOOLS, ['brain_sync', 'brain_note', 'brain_ask', 'brain_message', 'brain_handoff', 'brain_rules']),
    'A: the core profile is exactly brain_sync, brain_note, brain_ask, brain_message, brain_handoff, brain_rules');
  const core = parseToolSelection('core');
  ok(core.profile === 'core' && same(core.names, CORE_TOOLS) && core.unknown.length === 0, 'A: "core" parses to the 6 core tools');
  ok(parseToolSelection('all').names === null && parseToolSelection('ALL').profile === 'all', 'A: "all" (any case) selects everything');
  const list = parseToolSelection('brain_sync, bogus');
  ok(list.profile === 'custom' && same(list.names, ['brain_sync']) && same(list.unknown, ['bogus']), 'A: a list keeps the known names and reports the unknown ones');
  const mixed = parseToolSelection('core,brain_doctor');
  ok(mixed.profile === 'custom' && mixed.names.size === 7 && mixed.names.has('brain_doctor'), 'A: a profile name and a tool name mix ("core,brain_doctor" = 7 tools)');
  ok(parseToolSelection('bogus').profile === 'empty', 'A: a list with no known tool is "empty"');
  const none = resolveToolProfile({});
  ok(none.profile === 'all' && none.names === null && none.source === 'default' && none.warnings.length === 0, 'A: no KLYPIX_TOOLS → all (the default rule for existing installs)');
  ok(resolveToolProfile({ KLYPIX_TOOLS: '   ' }).profile === 'all', 'A: a blank KLYPIX_TOOLS is the same as none');
  const fell = resolveToolProfile({ KLYPIX_TOOLS: 'bogus' });
  ok(fell.profile === 'core' && fell.fellBack === true && fell.warnings.some((w) => /no KLYPIX tool/.test(w)) && fell.warnings.some((w) => /bogus/.test(w)),
    'A: KLYPIX_TOOLS naming no tool falls back to core and says so twice (unknown name, fallback)');
  ok(/core/.test(toolProfileInstructions(resolveToolProfile({ KLYPIX_TOOLS: 'core' }))) && /--tools all/.test(toolProfileInstructions(resolveToolProfile({ KLYPIX_TOOLS: 'core' })))
    && toolProfileInstructions(none) === '', 'A: the instructions sentence names the profile and the way to get every tool; nothing under all');
}

// ── B — the env policy for an MCP entry ──────────────────────────────────────
{
  ok(JSON.stringify(entryEnvWithTools(undefined, { value: 'core', onlyNew: true }, true)) === JSON.stringify({ KLYPIX_TOOLS: 'core' }), 'B: a NEW entry gets core under the install default');
  ok(JSON.stringify(entryEnvWithTools(undefined, { value: 'core', onlyNew: true }, false)) === '{}', 'B: an EXISTING entry without env stays without (= all) under the install default');
  ok(JSON.stringify(entryEnvWithTools({ KLYPIX_TOOLS: 'all', KLYPIX_AUTO_UPDATE: '0' }, { value: 'core', onlyNew: true }, false)) === JSON.stringify({ KLYPIX_TOOLS: 'all', KLYPIX_AUTO_UPDATE: '0' }),
    'B: an existing entry keeps its env, KLYPIX_TOOLS included, under the install default');
  ok(entryEnvWithTools({ KLYPIX_TOOLS: 'all' }, { value: 'core', onlyNew: false }, false).KLYPIX_TOOLS === 'core', 'B: an explicit --tools overrides an existing value');
  ok(JSON.stringify(entryEnvWithTools({ KLYPIX_AUTO_UPDATE: '0', bad: 1 }, null, true)) === JSON.stringify({ KLYPIX_AUTO_UPDATE: '0' }), 'B: no policy → existing string env only');
}

// ── C — link writes and preserves the profile; both config shapes read back ──
{
  const home = tmp('c-home');   // no local bundle → npx entries, which is fine here
  ok(mcpServerEntry({ vault: '/p', home }).env === undefined, 'C: an entry without env is byte-identical to before (no env key)');
  ok(mcpServerEntry({ vault: '/p', home, env: { KLYPIX_TOOLS: 'core' } }).env.KLYPIX_TOOLS === 'core', 'C: mcpServerEntry carries env');
  const proj = tmp('c-project');
  fs.writeFileSync(path.join(proj, 'brain.klypix'), await buildKlypixMap({ title: 'C', areas: [{ title: 'Brain', cards: [{ text: 'seed' }] }] }));
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(proj, rel), 'utf8'));
  // Fresh project, install's default policy: every new entry gets core.
  linkProject(proj, { tools: { value: 'core', onlyNew: true } });
  ok(readJson('.mcp.json').mcpServers['klypix-canvas'].env?.KLYPIX_TOOLS === 'core', 'C: a fresh .mcp.json entry gets KLYPIX_TOOLS=core');
  ok(readJson('.vscode/mcp.json').servers['klypix-canvas'].env?.KLYPIX_TOOLS === 'core' && readJson('.vscode/mcp.json').servers['klypix-canvas'].type === 'stdio', 'C: the VS Code `servers` shape gets it too');
  const toml = fs.readFileSync(path.join(proj, '.codex', 'config.toml'), 'utf8');
  ok(/^env = \{ KLYPIX_TOOLS = "core" \}$/m.test(toml) && /^startup_timeout_sec = 120$/m.test(toml), 'C: the Codex table carries env = { KLYPIX_TOOLS = "core" } beside its other keys');
  ok(safeReadCodexConfig(path.join(proj, '.codex', 'config.toml')).servers['klypix-canvas'].env.KLYPIX_TOOLS === 'core', 'C: safeReadCodexConfig reads the inline env table back');
  // A re-link with no policy (brain_sync, the updater, `link`) changes nothing.
  const before = fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8') + toml;
  const relink = linkProject(proj, {});
  ok(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8') + fs.readFileSync(path.join(proj, '.codex', 'config.toml'), 'utf8') === before
    && relink.mcp.every((m) => m.action === 'unchanged'), 'C: a re-link without a policy leaves every entry byte-identical (all "unchanged")');
  // The install default on an EXISTING entry: keeps what it has.
  linkProject(proj, { tools: { value: 'brain_sync', onlyNew: true } });
  ok(readJson('.mcp.json').mcpServers['klypix-canvas'].env.KLYPIX_TOOLS === 'core', 'C: the install default never rewrites an existing entry\'s profile');
  // An explicit --tools all rewrites every entry.
  linkProject(proj, { tools: { value: 'all', onlyNew: false } });
  ok(readJson('.mcp.json').mcpServers['klypix-canvas'].env.KLYPIX_TOOLS === 'all' && /KLYPIX_TOOLS = "all"/.test(fs.readFileSync(path.join(proj, '.codex', 'config.toml'), 'utf8')),
    'C: an explicit --tools all rewrites JSON and TOML entries');
  // Other env a person added survives a re-link (it used to be wiped).
  const cfg = readJson('.mcp.json');
  cfg.mcpServers['klypix-canvas'].env.KLYPIX_AUTO_UPDATE = '0';
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify(cfg, null, 2) + '\n');
  linkProject(proj, { tools: { value: 'core', onlyNew: true } });
  ok(readJson('.mcp.json').mcpServers['klypix-canvas'].env.KLYPIX_AUTO_UPDATE === '0' && readJson('.mcp.json').mcpServers['klypix-canvas'].env.KLYPIX_TOOLS === 'all',
    'C: a re-link keeps the env a person added (KLYPIX_AUTO_UPDATE=0) and their profile');
  // An existing entry WITHOUT env under the default policy: stays without.
  const bare = tmp('c-bare');
  fs.writeFileSync(path.join(bare, '.mcp.json'), JSON.stringify({ mcpServers: { 'klypix-canvas': { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '.'] } } }));
  linkProject(bare, { tools: { value: 'core', onlyNew: true } });
  ok(JSON.parse(fs.readFileSync(path.join(bare, '.mcp.json'), 'utf8')).mcpServers['klypix-canvas'].env === undefined, 'C: an existing entry without env stays without env under the install default (= all)');
  // Both readers see the env in both shapes.
  const spec = readLaunchSpec(path.join(proj, '.mcp.json'));
  ok(spec.ok && spec.env.KLYPIX_TOOLS === 'all' && spec.env.KLYPIX_AUTO_UPDATE === '0', 'C: readLaunchSpec returns the JSON entry\'s env (the verifier passes it to the child)');
  const tspec = readLaunchSpec(path.join(proj, '.codex', 'config.toml'));
  ok(tspec.ok && tspec.env.KLYPIX_TOOLS === 'all' && tspec.args.includes('--vault'), 'C: readLaunchSpec returns the TOML entry\'s env');
  ok(readMcpEntryEnv(path.join(proj, '.mcp.json')).KLYPIX_TOOLS === 'all' && readMcpEntryEnv(path.join(proj, '.codex', 'config.toml')).KLYPIX_TOOLS === 'all'
    && readMcpEntryEnv(path.join(proj, 'nope.json')) === null, 'C: readMcpEntryEnv reads both shapes and is null for a missing file');
  // A hand-written nested [mcp_servers.x.env] table is read and preserved by a reconnect.
  const nested = tmp('c-nested');
  const nestedToml = path.join(nested, 'config.toml');
  fs.writeFileSync(nestedToml, '[mcp_servers.klypix-canvas]\ncommand = "npx"\nargs = ["-y", "klypix-mcp", "--vault", "/p"]\n\n[mcp_servers.klypix-canvas.env]\nKLYPIX_TOOLS = "brain_sync,brain_note"\nOTHER = "x"\n');
  ok(safeReadCodexConfig(nestedToml).servers['klypix-canvas'].env.KLYPIX_TOOLS === 'brain_sync,brain_note', 'C: a nested [mcp_servers.<name>.env] table is read');
  const re = connectCodexMcpServer({ configPath: nestedToml, entry: mcpServerEntry({ vault: '/p', home }), cwd: '/p', tools: { value: 'core', onlyNew: true } });
  const after = fs.readFileSync(nestedToml, 'utf8');
  ok(re.ok && /env = \{ KLYPIX_TOOLS = "brain_sync,brain_note", OTHER = "x" \}/.test(after) && !/\[mcp_servers\.klypix-canvas\.env\]/.test(after),
    'C: a reconnect folds a nested env table into the server table, keeping every value');
}

// ── D — the managed instruction block explains a missing tool ────────────────
ok(/if a tool named here is not available, the install uses the `core` tool profile/.test(BRAIN_INSTRUCTIONS) && /npx klypix-mcp install --tools all/.test(BRAIN_INSTRUCTIONS),
  'D: the agent rules say a missing tool means the core profile, and how to ask for all');

// ── E — real stdio handshakes ────────────────────────────────────────────────
const appToolsHere = process.platform === 'win32' || process.env.KLYPIX_APP_TOOLS === 'on';
const EVERY_TOOL_HERE = KNOWN_TOOLS.filter((n) => appToolsHere || n !== 'show_in_klypix');
async function listTools(bin, extraEnv, label) {
  const base = tmp(`e-${label}`);
  const home = path.join(base, 'home');
  const vault = path.join(base, 'vault');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0',
    KLYPIX_VAULT: vault, KLYPIX_APP_BRIDGE_DIR: path.join(base, 'bridge'), ...extraEnv,
  };
  delete env.KLYPIX_BRAIN;
  if (!('KLYPIX_TOOLS' in extraEnv)) delete env.KLYPIX_TOOLS;
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', bin), '--vault', vault], cwd: vault, env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: `tool-profile-${label}`, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions() || '';
  await client.close();
  return { names: tools.map((t) => t.name), instructions, stderr };
}
{
  const core = await listTools('klypix-worker.mjs', { KLYPIX_TOOLS: 'core' }, 'core');
  ok(core.names.length === 6 && same(core.names, CORE_TOOLS), `E: KLYPIX_TOOLS=core → exactly the 6 core tools over stdio (got ${core.names.join(', ')})`);
  ok(/"core" tool profile/.test(core.instructions) && /npx klypix-mcp install --tools all/.test(core.instructions), 'E: under core the server instructions say which profile runs and how to get every tool');
  ok(/tools · profile core \(6 tools\) \(KLYPIX_TOOLS=core\) · 6 registered/.test(core.stderr), 'E: stderr reports the active profile and the registered count');

  const one = await listTools('klypix-worker.mjs', { KLYPIX_TOOLS: 'brain_sync,bogus' }, 'list');
  ok(one.names.length === 1 && one.names[0] === 'brain_sync', `E: KLYPIX_TOOLS=brain_sync,bogus → 1 tool (got ${one.names.join(', ')})`);
  ok(/KLYPIX_TOOLS: not a KLYPIX tool, ignored: bogus/.test(one.stderr), 'E: the unknown name is reported on stderr and ignored');

  const all = await listTools('klypix-worker.mjs', {}, 'all');
  ok(all.names.length === EVERY_TOOL_HERE.length && same(all.names, EVERY_TOOL_HERE),
    `E: no KLYPIX_TOOLS → every tool (${EVERY_TOOL_HERE.length} here), and KNOWN_TOOLS in tool-profile.mjs equals what the worker registers (got ${all.names.length})`);
  ok(!/tool profile/.test(all.instructions) && /tools · profile all \(no KLYPIX_TOOLS\)/.test(all.stderr), 'E: under all the instructions carry no profile sentence and stderr says why');

  const supervised = await listTools('klypix-mcp.mjs', { KLYPIX_TOOLS: 'core' }, 'supervisor');
  ok(supervised.names.length === 6 && same(supervised.names, CORE_TOOLS), `E: the supervisor (what hosts launch) passes KLYPIX_TOOLS to its worker: 6 tools (got ${supervised.names.length})`);
}

// ── F — doctor reports the profile a project's MCP entry launches ────────────
{
  const home = tmp('f-home');
  const proj = tmp('f-project');
  fs.writeFileSync(path.join(proj, 'brain.klypix'), await buildKlypixMap({ title: 'F', areas: [{ title: 'Brain', cards: [{ text: 'seed' }] }] }));
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'klypix-canvas': { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '.'], env: { KLYPIX_TOOLS: 'core' } } } }, null, 2));
  const r = inspect({ home, projectDir: proj, fmtLib: null });
  ok(r.tools.profile?.name === 'core' && r.tools.profile.count === 6 && same(r.tools.profile.selected, CORE_TOOLS) && r.tools.profile.source === '.mcp.json',
    `F: inspect() reports profile core, 6 tools, from .mcp.json (got ${JSON.stringify({ name: r.tools.profile?.name, count: r.tools.profile?.count, source: r.tools.profile?.source })})`);
  ok(r.tools.count === EVERY_TOOL_HERE.length && r.tools.names.length === r.tools.count, 'F: the manifest count stays the full build (profile is reported beside it, never instead of it)');
  const line = render(r, { color: false }).split('\n').find((l) => /TOOLS/.test(l)) || '';
  ok(new RegExp(`TOOLS\\s+6 of ${EVERY_TOOL_HERE.length} MCP verb\\(s\\)`).test(line) && /profile core \(KLYPIX_TOOLS=core in \.mcp\.json\)/.test(line) && /brain_sync/.test(line) && !/brain_doctor/.test(line),
    `F: doctor's TOOLS line reads "6 of N MCP verb(s) · profile core (KLYPIX_TOOLS=core in .mcp.json): …" (got: ${line.slice(0, 140)})`);
  const plain = tmp('f-plain');
  const r0 = inspect({ home, projectDir: plain, fmtLib: null });
  const line0 = render(r0, { color: false }).split('\n').find((l) => /TOOLS/.test(l)) || '';
  ok(r0.tools.profile?.name === 'all' && r0.tools.profile.source === 'default' && /profile all \(no KLYPIX_TOOLS — the default\)/.test(line0) && /klypix_status/.test(line0),
    'F: a project without a profile reports all (the default) and lists every verb');
  fs.mkdirSync(path.join(proj, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'klypix-canvas': { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '.'], env: { KLYPIX_TOOLS: 'all' } } } }));
  const rm = inspect({ home, projectDir: proj, fmtLib: null });
  ok(rm.tools.profile?.name === 'mixed' && /MCP configs disagree/.test(render(rm, { color: false })), 'F: entries that disagree are reported as mixed, with the fix');
}

// ── G — install: a new entry gets core; --tools all rewrites ─────────────────
{
  const home = tmp('g-home');
  const proj = tmp('g-project');
  fs.writeFileSync(path.join(proj, 'brain.klypix'), await buildKlypixMap({ title: 'G', areas: [{ title: 'Brain', cards: [{ text: 'seed' }] }] }));
  fs.writeFileSync(path.join(proj, '.mcp.json'), '{}\n');   // the file exists, the entry does not → NEW
  // The bundle lands in the sandbox HOME's ~/.claude/project-brain (no
  // KLYPIX_MCP_INSTALL_DIR override), which is where the written entry's
  // `node -e` launch looks — so setup's verification runs THIS build, not a cold
  // `npx klypix-mcp` fetch of the published package.
  const install = (args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'klypix-install.mjs'), ...args], {
    cwd: proj, encoding: 'utf8', timeout: 240_000, input: '',
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      KLYPIX_AUTO_UPDATE: '0', KLYPIX_SEMANTIC: '0', KLYPIX_MCP_ALLOW_UNTAGGED: '1',
    },
  });
  const first = install([]);
  const out1 = String(first.stdout || '') + String(first.stderr || '');
  const mcp1 = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
  ok(first.status === 0 && mcp1.mcpServers['klypix-canvas'].env?.KLYPIX_TOOLS === 'core', `G: a plain install writes KLYPIX_TOOLS=core into the NEW .mcp.json entry (exit ${first.status})`);
  ok(/env = \{ KLYPIX_TOOLS = "core" \}/.test(fs.readFileSync(path.join(proj, '.codex', 'config.toml'), 'utf8')), 'G: …and into the Codex table it writes');
  ok(/tools: a NEW MCP entry gets the core profile \(KLYPIX_TOOLS=core/.test(out1), 'G: install says what the default did');
  const verified = out1.split('\n').find((l) => /verified\s+[✓✗]/.test(l));
  ok(!!verified && /✓ 6 tools reachable .*KLYPIX_TOOLS=core/.test(verified), `G: setup verifies the written entry with ITS env and counts the 6 tools the editor will see (${verified ? verified.trim() : 'no verification line'})`);
  const second = install(['--tools', 'all']);
  const out2 = String(second.stdout || '') + String(second.stderr || '');
  const mcp2 = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
  ok(second.status === 0 && mcp2.mcpServers['klypix-canvas'].env?.KLYPIX_TOOLS === 'all' && /KLYPIX_TOOLS = "all"/.test(fs.readFileSync(path.join(proj, '.codex', 'config.toml'), 'utf8')),
    `G: install --tools all rewrites the existing entries to all (exit ${second.status})`);
  ok(/tools: KLYPIX_TOOLS=all is written into every MCP entry this run touches/.test(out2), 'G: install --tools reports what it wrote');
  const third = install(['--tools']);
  ok(third.status === 2 && /--tools needs a value/.test(String(third.stderr || '')), 'G: --tools without a value is refused with exit 2');
  const fourth = install(['--tools', 'bogus', '--no-project']);
  ok(fourth.status === 2 && /names no KLYPIX tool/.test(String(fourth.stderr || '')), 'G: --tools naming no tool is refused with exit 2');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* a child may still hold a handle on Windows */ }
console.log(failures ? `\n✗ ${failures} tool-profile assertion(s) failed` : '\n✓ tool-profile: all assertions passed');
process.exit(failures ? 1 : 0);
