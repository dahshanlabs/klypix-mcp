// npx-owned-names — every `npx` command KLYPIX tells a person or an agent to run
// must resolve to a package KLYPIX owns on npm (2026-09-27).
// klypix-mcp ships a dozen bins (klypix-read, klypix-append, klypix-project-map, …)
// but only `klypix-mcp` itself is a registered npm package. Outside a project that
// installed klypix-mcp, `npx klypix-read` asks the public registry for a package
// NAMED klypix-read — and with no TTY (every agent shell, every CI job) npx
// installs and runs it without asking (libnpmexec: `noTTY() || ciInfo.isCI` →
// warn and proceed). Whoever registers that name runs code in every repo whose
// committed rules (AGENTS.md, .cursor/rules, GEMINI.md, …) tell agents to call it.
// Proves: the agent rules and the shipped docs spell every such call
// `npx -y -p klypix-mcp <bin>`, and the scanner itself still catches the old form.
// Run:  node test/npx-owned-names.mjs      (exit 0 = pass, 1 = fail)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BRAIN_INSTRUCTIONS } from '../src/agent-rules.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OWNED = new Set([pkg.name]);

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

const bare = (name) => (name || '').replace(/^(@?[^@]+)@.*$/, '$1');

// `npx -y -p klypix-mcp klypix-read x` → [{ pkg: 'klypix-mcp', cmd: 'klypix-read' }]
function npxCalls(line) {
  const calls = [];
  for (const m of line.matchAll(/\bnpx((?:[ \t]+[^\s`'"|;&)]+)+)/g)) {
    const toks = m[1].trim().split(/\s+/);
    let from = null;
    let cmd = null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === '-p' || t === '--package') { from = toks[++i]; continue; }
      if (t.startsWith('--package=')) { from = t.slice('--package='.length); continue; }
      if (t.startsWith('-')) continue;
      cmd = t;
      break;
    }
    if (cmd) calls.push({ pkg: bare(from), cmd: bare(cmd.replace(/\\$/, '')) });
  }
  return calls;
}

// A call is unsafe when it runs a klypix-* name that is not a package we own and
// does not say which owned package provides it. A line that reads from
// node_modules/klypix-mcp runs after a local install, where npx resolves the
// project's own bin before it ever asks the registry.
function unsafe(line) {
  if (line.includes('node_modules/klypix-mcp')) return [];
  return npxCalls(line).filter((c) => /^klypix[\w-]*$/.test(c.cmd) && !OWNED.has(c.cmd) && !OWNED.has(c.pkg));
}

// The scanner must still catch the spelling this test exists to forbid.
ok(unsafe('- or via CLI: `npx klypix-read brain.klypix`').length === 1, 'scanner flags bare `npx klypix-read`');
ok(unsafe('echo "x" | npx klypix-append brain.klypix').length === 1, 'scanner flags bare `npx klypix-append` after a pipe');
ok(unsafe('npx klypix-project-map setup-github /p').length === 1, 'scanner flags bare `npx klypix-project-map`');
ok(unsafe('- or via CLI: `npx -y -p klypix-mcp klypix-read brain.klypix`').length === 0, 'scanner accepts `npx -y -p klypix-mcp klypix-read`');
ok(unsafe('npx --package=klypix-mcp@latest klypix-append b').length === 0, 'scanner accepts `--package=klypix-mcp@<version>`');
ok(unsafe('npx klypix-mcp install').length === 0 && unsafe('npx -y klypix-mcp@latest doctor').length === 0, 'scanner accepts the owned package itself');

// The agent rules — the text `install`/`link` commits into other people's repos.
const ruleCalls = BRAIN_INSTRUCTIONS.split('\n').flatMap(npxCalls).filter((c) => /^klypix/.test(c.cmd));
ok(ruleCalls.length > 0, `the agent rules still document a CLI path (${ruleCalls.length} npx call(s))`);
ok(ruleCalls.every((c) => OWNED.has(c.cmd) || OWNED.has(c.pkg)), 'every npx call in the agent rules runs a package KLYPIX owns');

// Everything the package ships or documents.
const SKIP = new Set(['node_modules', '.git', 'test']);
const EXT = /\.(mjs|cjs|js|ts|md|ya?ml|json|txt|sh|ps1)$/i;
const hits = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!EXT.test(e.name)) continue;
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      for (const c of unsafe(line)) hits.push(`${path.relative(ROOT, p)}:${i + 1} → npx ${c.cmd}`);
    });
  }
})(ROOT);
for (const h of hits) console.log(`    ${h}`);
ok(hits.length === 0, `no shipped file tells anyone to run an npm package KLYPIX does not own (${hits.length} found)`);

console.log(failures ? `\n✗ ${failures} npx-owned-names assertion(s) failed` : '\n✓ npx-owned-names: all assertions passed');
process.exit(failures ? 1 : 0);
