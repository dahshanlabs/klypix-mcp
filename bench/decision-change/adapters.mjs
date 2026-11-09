import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { klypixServerInfo } from '../coordination/conditions.mjs';
import { sourceFingerprint } from '../coordination/lib/results.mjs';
import { freshEnvironment } from './isolation.mjs';
import { prepareKlypixHooks, auditHookSource, readHookAudit, deliveredHookEvidence } from './native-hooks.mjs';

export async function prepareCondition({ id, repoDir, home, ledger, releasedRoot, improvedRoot, claudeMem = {}, protocol = 'early-boundary-v2', authentication = null }) {
  if (id === 'notes-native' || id === 'notes-notification') {
    const rule = '\n## Maintaining shared project understanding\nRead the current project decisions at task start. When a durable decision changes, update these ordinary project notes so they state the current decision and preserve unrelated guidance. Before declaring a task complete, re-read the current notes and verify the finished work against them.\n';
    fs.appendFileSync(path.join(repoDir, 'CLAUDE.md'), rule);
    fs.appendFileSync(path.join(repoDir, 'AGENTS.md'), '\nThe canonical project decisions and their maintenance rule live in CLAUDE.md. Read and maintain that file; do not duplicate the policy here.\n');
    let settings; let hookAudit; let exposureEvidence;
    if (id === 'notes-notification') {
      const source = fileURLToPath(new URL('./notes-notify-hook.mjs', import.meta.url));
      const auditFile = path.join(home, 'notes-hook-audit.jsonl');
      const wrapper = path.join(home, 'notes-source-hook.mjs');
      fs.writeFileSync(wrapper, auditHookSource({ source, auditFile }));
      const quote = value => `"${value.replace(/\\/g, '/')}"`;
      const command = `node ${quote(wrapper)} ${quote(path.join(home, 'notes-revisions'))} ${quote(repoDir)}`;
      settings = { hooks: Object.fromEntries(['SessionStart', 'PreToolUse', 'PostToolUse'].map(event =>
        [event, [{ hooks: [{ type: 'command', command, timeout: 10 }] }]])) };
      hookAudit = options => readHookAudit(auditFile, options);
      exposureEvidence = options => deliveredHookEvidence(hookAudit(options));
    }
    return {
    id, label: id === 'notes-notification' ? 'AI-maintained notes with whole-file change notification' : 'AI-maintained ordinary notes and native Claude features',
    metadata: { nativeSessionPersistence: true, paidReady: true,
      workflow: 'AI reads at start, maintains durable decisions, and re-reads notes before completion; policy text is authored only by producer',
      notification: id === 'notes-notification' ? 'Per-session SHA-256 of full CLAUDE.md + AGENTS.md at native tool boundaries; generic re-read notice, no relevance filtering' : 'none' },
    instructions: 'Maintain the current durable project decisions clearly in the one canonical ordinary notes file CLAUDE.md. AGENTS.md points to it; do not duplicate the policy there. Replace superseded current policy text while preserving unrelated project instructions.',
    agentConfig: settings ? { settings } : {}, hookAudit, exposureEvidence,
    flush: async () => ({ ok: true }), close: async () => {},
  }; }
  if (id === 'claude-mem') {
    const { prepareClaudeMem } = await import('./claude-mem.mjs');
    const adapter = await prepareClaudeMem({ repoDir, home, ledger, ...claudeMem, authentication });
    return { ...adapter, instructions: adapter.instructions || 'Use claude-mem through its supported host integration to preserve the durable project decision. Do not mirror the policy into project instruction files.' };
  }
  const root = id === 'klypix-released' ? releasedRoot : id === 'klypix-improved' ? improvedRoot : null;
  if (!root) throw new Error(`Unknown condition or missing build root: ${id}`);
  const bin = path.join(root, 'bin/klypix-mcp.mjs');
  if (!fs.existsSync(bin)) throw new Error(`KLYPIX build missing: ${bin}`);
  const { buildKlypixMap } = await import(pathToFileURL(path.join(root, 'src/klypix-format.mjs')).href);
  const { linkProject } = await import(pathToFileURL(path.join(root, 'src/agent-rules.mjs')).href);
  // Empty workspace initialization only. ALL experimental facts and changes
  // are written by the real producer through the product's public tools.
  fs.writeFileSync(path.join(repoDir, 'brain.klypix'), await buildKlypixMap({ title: 'brain', kind: 'brain', areas: [{ title: 'Project', cards: [] }] }));
  linkProject(repoDir, { editors: new Set(['claude-code', 'codex']), exclude: new Set(['.mcp.json', '.codex/config.toml']) });
  const productEnv = {
    ...freshEnvironment(home),
    KLYPIX_BRAIN_DIR: path.join(home, '.claude/project-brain'),
    KLYPIX_AUTO_UPDATE: '0', KLYPIX_APP_TOOLS: 'off', KLYPIX_APP_BRIDGE_DIR: path.join(home, 'empty-app-bridge'), KLYPIX_TOOLS: 'core',
  };
  const native = protocol === 'early-boundary-v2' ? prepareKlypixHooks({ root, home }) : null;
  const server = { command: process.execPath, args: [bin, '--vault', repoDir], env: productEnv };
  return { id, label: id === 'klypix-released' ? 'KLYPIX released baseline source' : 'KLYPIX decision-change prototype',
    instructions: 'Use KLYPIX brain_note and the normal brain_sync lifecycle to save or revise durable project decisions. Do not mirror the policy into project instruction files.',
    agentConfig: { env: productEnv, mcpServers: { 'klypix-canvas': server }, ...(native ? { settings: native.settings } : {}) },
    hookAudit: native?.hookAudit, exposureEvidence: native?.exposureEvidence,
    metadata: { ...klypixServerInfo(bin), source: sourceFingerprint(root, ['src', 'bin', 'package.json', 'package-lock.json']),
      integration: native ? 'Core MCP + generated rules + source-native Claude installer hooks, identical event configuration for both builds; desktop bridge isolated; no semantic-model installation'
        : 'Preliminary MCP-only protocol: core MCP + generated project rules; no native hooks',
      nativeHooks: native?.metadata || null, paidReady: true },
    flush: async () => ({ ok: true }), close: async () => {},
  };
}
