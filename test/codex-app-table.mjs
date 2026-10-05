// codex-app-table — `npx klypix-mcp install` must not delete the Codex table
// KLYPIX's own Settings → Codex button wrote.
//
// install removes the pre-1.35 GLOBAL KLYPIX table whose `--vault "."` a global
// Codex process resolves from its own install folder (the wrong brain). It used
// to remove EVERY KLYPIX table in ~/.codex/config.toml, including the one the
// desktop app writes with an absolute vault — and the app's Codex button went
// grey. Only relative-vault tables go now; uninstall still removes them all.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { disconnectCodexMcpServer, safeReadCodexConfig } from '../src/agent-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-codex-table-'));
const file = path.join(tmp, 'config.toml');
const BS = String.fromCharCode(92);
const winVault = ['C:', 'Users', 'Sara', 'Desktop'].join(BS + BS); // TOML-escaped backslashes

const config = [
  'model = "gpt-test"',
  '',
  '[mcp_servers.klypix-canvas]',
  'command = "node"',
  `args = ["C:/Users/Sara/.claude/project-brain/klypix-mcp-server.mjs", "--vault", "${winVault}"]`,
  'startup_timeout_sec = 120',
  '',
  '[mcp_servers.klypix-legacy]',
  'command = "npx"',
  'args = ["-y", "klypix-mcp", "--vault", "."]',
  '',
  '[mcp_servers.klypix-posix]',
  'command = "npx"',
  'args = ["-y", "klypix-mcp", "--vault", "/home/sara/canvases"]',
  '',
  '[mcp_servers.docs]',
  'url = "https://docs.example.test/mcp"',
  '',
].join('\n');
fs.writeFileSync(file, config);

const r = disconnectCodexMcpServer({ configPath: file, onlyRelativeVault: true });
const after = safeReadCodexConfig(file);
ok(r.ok && r.action === 'disconnected', 'install-mode disconnect ran');
ok(!after.servers['klypix-legacy'], 'the relative --vault "." table is removed');
ok(after.servers['klypix-canvas']?.launchesKlypix === true, 'the app button\'s absolute Windows vault table is kept');
ok(after.servers['klypix-posix']?.launchesKlypix === true, 'an absolute POSIX vault table is kept');
ok(Boolean(after.servers.docs) && fs.readFileSync(file, 'utf8').includes('model = "gpt-test"'), 'unrelated settings and servers are untouched');
const again = disconnectCodexMcpServer({ configPath: file, onlyRelativeVault: true });
ok(again.ok && again.action === 'unchanged', 'a second install-mode pass changes nothing');
const all = disconnectCodexMcpServer({ configPath: file });
ok(all.ok && !Object.keys(safeReadCodexConfig(file).servers).some(k => /klypix/i.test(k)), 'the full disconnect (uninstall) still removes every KLYPIX table');

// The installer really uses the install mode.
const install = fs.readFileSync(path.join(__dirname, '..', 'bin', 'klypix-install.mjs'), 'utf8').replace(/\r/g, '');
ok(/disconnectCodexMcpServer\(\{ configPath: CODEX_CONFIG, onlyRelativeVault: true \}\)/.test(install), 'bin/klypix-install.mjs removes only relative-vault global tables');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ codex-app-table: all assertions passed');
process.exit(failures ? 1 : 0);
