// Prove the config we just wrote actually starts a server.
//
// The recorded lesson this exists to enforce: CONFIG WHOSE BREAKAGE MODE IS
// SILENCE NEEDS A GATE, NOT VIGILANCE. When a klypix entry is wrong the MCP
// server simply does not start — no error, no warning; the agent quietly loses
// every brain verb and degrades to whatever static context it already had. A
// project once lost all 17 verbs for five days that way, and the only thing
// that ever proved it was driving a REAL stdio handshake from the config
// file's own values (broken config: dead in 101ms; fixed: ~1s, 17 tools).
//
// So this module never trusts what the writer believes it wrote. It re-reads
// the file from disk, extracts the command and args the EDITOR will use, and
// speaks JSON-RPC to whatever that launches. A pass means a real client would
// connect; anything else is reported with the reason rather than swallowed.
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { safeReadCodexConfig } from './agent-rules.mjs';

const isKlypix = (name) => /klypix/i.test(String(name || ''));

/** Pull a TOML array-of-strings value (args = ["a", "b"]) out of a table block. */
function parseTomlArgs(block) {
  const m = String(block || '').match(/^[ \t]*args[ \t]*=[ \t]*\[([\s\S]*?)\]/m);
  if (!m) return [];
  const out = [];
  const re = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
  let hit;
  while ((hit = re.exec(m[1]))) out.push(hit[2].replace(/\\(["'\\])/g, '$1'));
  return out;
}

/**
 * Read a written MCP config and return the launch spec an editor would use.
 * @returns {{ ok: boolean, command?: string, args?: string[], cwd?: string, why?: string }}
 */
export function readLaunchSpec(file) {
  if (!fs.existsSync(file)) return { ok: false, why: 'config file not written' };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, why: `unreadable: ${e?.message || e}` }; }

  if (/\.toml$/i.test(file)) {
    const parsed = safeReadCodexConfig(file);
    if (!parsed.ok) return { ok: false, why: parsed.error };
    const name = Object.keys(parsed.servers).find(isKlypix);
    if (!name) return { ok: false, why: 'no klypix server entry' };
    const entry = parsed.servers[name];
    if (!entry.command) return { ok: false, why: 'entry has no command' };
    return { ok: true, command: entry.command, args: parseTomlArgs(entry.raw), cwd: entry.cwd || undefined };
  }

  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) { return { ok: false, why: `invalid JSON: ${e?.message || e}` }; }
  // `.vscode/mcp.json` uses `servers`; everyone else uses `mcpServers`.
  const bag = (cfg && typeof cfg === 'object')
    ? (cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers
      : cfg.servers && typeof cfg.servers === 'object' ? cfg.servers : null)
    : null;
  if (!bag) return { ok: false, why: 'no mcpServers/servers block' };
  const name = Object.keys(bag).find(isKlypix);
  if (!name) return { ok: false, why: 'no klypix server entry' };
  const entry = bag[name] || {};
  if (!entry.command) return { ok: false, why: 'entry has no command' };
  return {
    ok: true,
    command: String(entry.command),
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    cwd: entry.cwd ? String(entry.cwd) : undefined,
  };
}

/**
 * Launch the server exactly as the editor would and count the tools it offers.
 *
 * `cwd` defaults to the project root because several hosts resolve a relative
 * `--vault .` against the session's working directory, not the config file's
 * location — verifying from anywhere else would test a path no editor uses.
 *
 * @param {{ file: string, projectDir: string, timeoutMs?: number, env?: object }} opts
 * @returns {Promise<{ ok: boolean, toolCount?: number, ms?: number, why?: string, hasBrainSync?: boolean }>}
 */
export async function verifyMcpConfig({ file, projectDir, timeoutMs = 25_000, env = process.env }) {
  const spec = readLaunchSpec(file);
  if (!spec.ok) return { ok: false, why: spec.why };

  const started = Date.now();
  let client = null;
  try {
    const childEnv = Object.fromEntries(
      Object.entries({ ...env, KLYPIX_AUTO_UPDATE: '0', KLYPIX_RERANK: '0' })
        .filter(([, v]) => typeof v === 'string'),
    );
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd || projectDir,
      env: childEnv,
      stderr: 'pipe',
    });
    client = new Client({ name: 'klypix-setup-verify', version: '1.0.0' });

    // A hung child must not hang setup. The race leaves the transport to the
    // finally block, which closes it either way.
    const connected = await Promise.race([
      client.connect(transport).then(() => 'ok'),
      new Promise((r) => setTimeout(() => r('timeout'), timeoutMs)),
    ]);
    if (connected === 'timeout') return { ok: false, why: `no response within ${Math.round(timeoutMs / 1000)}s` };

    const listed = await Promise.race([
      client.listTools().then((t) => t),
      new Promise((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
    if (!listed) return { ok: false, why: 'connected but never listed its tools' };

    const tools = Array.isArray(listed.tools) ? listed.tools : [];
    return {
      ok: tools.length > 0,
      toolCount: tools.length,
      hasBrainSync: tools.some((t) => t?.name === 'brain_sync'),
      ms: Date.now() - started,
      ...(tools.length ? {} : { why: 'server started but offered no tools' }),
    };
  } catch (e) {
    // The classic broken-config signature is an immediate "Connection closed".
    const why = String(e?.message || e).replace(/\s+/g, ' ').slice(0, 200);
    return { ok: false, why, ms: Date.now() - started };
  } finally {
    try { await client?.close(); } catch { /* the child is exiting anyway */ }
  }
}

export { parseTomlArgs };
