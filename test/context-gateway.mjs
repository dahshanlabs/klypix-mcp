import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import { opBrainTaskContext } from '../src/klypix-core.mjs';
import { createMcpPresence } from '../src/mcp-presence.mjs';
import { compactAgentsBrief } from '../src/agent-rules.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
  if (!condition) failures++;
};
const percentile = (values, p) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] || 0;
};

const home = path.join(os.tmpdir(), 'klypix-context-gateway-home');
const project = path.join(os.tmpdir(), 'klypix-context-gateway-project');
for (const target of [home, project]) {
  if (!path.resolve(target).startsWith(path.resolve(os.tmpdir()))) throw new Error(`Unsafe test target: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(project, { recursive: true });

const brain = await buildKlypixMap({
  title: 'context gateway fixture',
  areas: [
    {
      title: 'Brain',
      cards: [
        { text: 'Codex Context Gateway uses brain_sync to coordinate active tasks and return compact relevant memory.' },
        { text: 'Exact file overlap alerts are delivered automatically to the earlier session on its next KLYPIX action.' },
      ],
    },
    {
      title: 'Unrelated',
      cards: [
        { text: 'The mobile clipboard uses encrypted device relay transport for phone delivery.' },
      ],
    },
  ],
});
fs.writeFileSync(path.join(project, 'brain.klypix'), brain);
fs.writeFileSync(path.join(project, 'AGENTS.md'),
  `# User instructions\n\n<!-- klypix-brain-brief:start -->\n${'oversized stale context '.repeat(1000)}\n<!-- klypix-brain-brief:end -->\n`);

const compacted = await compactAgentsBrief(project);
const compactedAgents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
ok(compacted.action === 'updated' && compactedAgents.length < 6000,
  'link-time compaction removes oversized query-blind AGENTS.md context');
const compactCheck = await compactAgentsBrief(project, { check: true });
ok(compactCheck.status === 'ok',
  'AGENTS.md compact fallback is deterministic and audits cleanly');

const contextStart = performance.now();
const context = await opBrainTaskContext({
  vault: project,
  intent: 'Improve Codex Context Gateway brain_sync coordination',
  files: ['src/mcp-presence.mjs'],
});
const contextElapsed = performance.now() - contextStart;
const contextText = context.blocks?.map((block) => block.text || '').join('\n') || '';
ok(context.context?.mode === 'lexical-fast'
  && context.context?.hits?.some((hit) => /Context Gateway/.test(hit.text)),
'task intent retrieves the relevant brain card without loading semantic models');
ok(!/mobile clipboard/i.test(contextText),
  'bounded task context excludes an unrelated brain card');
ok(contextText.length <= 2800,
  'task context respects the default 2,800-character output budget');
ok(contextElapsed < 1000,
  `task context stays on the fast path (${contextElapsed.toFixed(1)}ms < 1000ms)`);

const fakeServer = {
  server: { getClientVersion: () => ({ name: 'codex-context-perf', version: 'test' }) },
  sendLoggingMessage: () => {},
};
const timer = () => ({ unref() {} });
const presence = createMcpPresence({
  server: fakeServer,
  initialVault: project,
  env: { KLYPIX_SESSION_ID: 'context-perf-session' },
  home,
  setIntervalFn: timer,
  clearIntervalFn: () => {},
});
presence.sync({
  phase: 'start',
  intent: 'measure Context Gateway coordination',
  files: ['src/mcp-presence.mjs'],
});
const samples = [];
for (let i = 0; i < 30; i++) {
  const started = performance.now();
  presence.sync({
    phase: 'checkpoint',
    intent: 'measure Context Gateway coordination',
    files: ['src/mcp-presence.mjs'],
  });
  samples.push(performance.now() - started);
}
const p95 = percentile(samples, 0.95);
ok(p95 < 500, `coordination p95 stays below 500ms (${p95.toFixed(1)}ms)`);
presence.sync({ phase: 'complete' });
presence.stop();

for (const target of [home, project]) fs.rmSync(target, { recursive: true, force: true });
console.log(failures
  ? `\n[x] ${failures} context-gateway assertion(s) failed`
  : `\n[ok] context-gateway: all assertions passed · memory ${contextElapsed.toFixed(1)}ms · coordination p95 ${p95.toFixed(1)}ms`);
process.exit(failures ? 1 : 0);
