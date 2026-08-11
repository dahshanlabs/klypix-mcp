import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildKlypixMap, captureIntoBrain, parseKlypix,
  scoreCardsAgainstQuery, splitQueryTokens,
} from '../src/klypix-format.mjs';
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

// PID-scoped fixtures keep independent test workers/sessions from racing over
// the same presence files and producing false latency/cleanup failures.
const home = path.join(os.tmpdir(), `klypix-context-gateway-home-${process.pid}`);
const project = path.join(os.tmpdir(), `klypix-context-gateway-project-${process.pid}`);
const gapProject = path.join(os.tmpdir(), `klypix-context-gap-project-${process.pid}`);
for (const target of [home, project, gapProject]) {
  if (!path.resolve(target).startsWith(path.resolve(os.tmpdir()))) throw new Error(`Unsafe test target: ${target}`);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(gapProject, { recursive: true });

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

// Founder regression (2026-08-11): this open A→B→C lineage gap existed in the
// brain, but an unrelated presence-bug resolution falsely archived it. The next
// brain_sync capsule therefore hid a still-open researcher finding and the human
// had to repeat it. This is retrieval correctness, not model speed: preserve the
// open card through the unrelated resolution, then prove the compact task gateway
// can surface it on the next relevant session.
const lineageGap = `Brain: ❓ GAP surfaced by an external researcher on Reddit (2026-08-10), confirmed against code: when a reversal is itself reversed (A superseded by B, then C restores A's position), the graph correctly grows A→B→C — C supersedes B only, since liveTextCards excludes archived cards from the supersede candidate set — and recall/as_of both resolve correctly through the chain. BUT C is a fresh card dated today carrying NO marker that it re-adopts A. The re-adoption lineage exists only as a graph walk; reading C alone shows no history. brain_challenge surfaces it at query time (tier-2 "you tried this and reversed it") but nothing is written on the card. Worth considering: a "re-adopts" edge or stamp when a new card's subject tokens match an ALREADY-archived card beyond its live successor, so a returning decision carries its own round-trip receipt.\n#brain`;
// Verbatim semantic payload of the unrelated receipt that caused the real false
// closure, including its self-referential post-mortem prose. That prose shared
// enough generic "card/open/claim/fix" vocabulary to clear the old loose matcher.
const unrelatedPresenceFix = `The two silent presence bugs (isSuspectedTwin comparing hostPid ALONE; normalizeFileKey never matching an absolute path against a relative one) are FIXED and must stop being scheduled — klypix-mcp commit ab10688, 2026-07-30, "fix(cli): --check no longer writes, and two silent presence bugs". src/mcp-presence.mjs:87-92 now requires THREE conditions — matching hostPid AND sameMachine AND compatibleClient — so a coincidental pid collision no longer suppresses an unrelated peer's overlap warning, and the mixed absolute/relative overlap warning fires today. 🛠️ WHY THIS CARD SURVIVED SO LONG: the open claim text was near-verbatim the BUG DESCRIPTION from the very commit that fixed it, so every phrasing-matched recall surfaced the defect and never the fix — the same class as a 🛠️ card encoding a since-fixed limitation. When capturing a fix, never restate the bug as the card's headline.`;
let guardedBrain = await buildKlypixMap({
  title: 'brain',
  areas: [{
    title: 'Brain',
    cards: [
      { text: lineageGap },
      // More than the old 64-card candidate cap, each deliberately scoring
      // above the gap. This reproduces the actual boundary, not merely top-5.
      ...Array.from({ length: 80 }, (_, i) => ({
        text: `Harden brain core against external researcher re-adoption reversal gap with klypix-format benchmark ${i + 1}: completed historical retrospective.`,
      })),
    ],
  }],
});
({ buffer: guardedBrain } = await captureIntoBrain(guardedBrain, {
  resolutions: [{ area: 'Brain', text: unrelatedPresenceFix }],
}));
fs.writeFileSync(path.join(gapProject, 'brain.klypix'), guardedBrain);
const guardedStruct = (await parseKlypix(guardedBrain)).struct;
const gapCard = guardedStruct.cards.find(card => /external\s+researcher/.test(card.text || ''));
ok(gapCard && !/^archive$/i.test(gapCard.area || '') && !/✅/.test(gapCard.text || ''),
  'an unrelated presence fix cannot falsely close the A→B→C researcher gap');
const gapIntent = 'Harden the brain core against the external researcher re-adoption reversal gap';
const rawTop64 = scoreCardsAgainstQuery(
  guardedStruct,
  splitQueryTokens(`${gapIntent} klypix-format`).content,
  { topK: 64, minScore: 2 },
);
ok(!rawTop64.some(hit => hit.card.id === gapCard?.id),
  'fixture proves the fresh gap is outside the old 64-card candidate window');
const gapContext = await opBrainTaskContext({
  vault: gapProject,
  canvas: 'brain',
  intent: gapIntent,
  files: ['src/klypix-format.mjs'],
});
const surfacedGap = gapContext.context?.hits?.some(hit => hit.recentOpen === true && /external researcher/.test(hit.text || ''));
ok(surfacedGap,
  `the next relevant brain_sync capsule surfaces the still-open researcher gap without human repetition (hits=${(gapContext.context?.hits || []).map(hit => `${hit.id}:${hit.score}:${hit.recentOpen ? 'open' : 'ranked'}`).join(',')})`);

// A card whose first line still carries ❓ can nevertheless be explicitly
// resolved in prose. It remains live in malformed/legacy brains, so the recent
// promotion must use the canonical unresolved classifier rather than the raw
// open-glyph classifier and resurrect already-closed work.
const resolvedOpenText = 'Auth: ❓ Refresh token rotation across the session store is complete.\n✅ 2026-08-11: refresh token rotation shipped.';
const resolvedOpenBrain = await buildKlypixMap({
  title: 'brain',
  areas: [{ title: 'Auth', cards: [{ text: resolvedOpenText }] }],
});
fs.writeFileSync(path.join(gapProject, 'brain.klypix'), resolvedOpenBrain);
const resolvedOpenContext = await opBrainTaskContext({
  vault: gapProject,
  canvas: 'brain',
  intent: 'Refresh token rotation across the session store',
});
const resolvedOpenHit = resolvedOpenContext.context?.hits?.find(hit => /Refresh token rotation/.test(hit.text || ''));
ok(resolvedOpenHit && resolvedOpenHit.recentOpen !== true,
  'a fresh resolved-in-prose card is retrieved when relevant but never promoted as RECENT OPEN');

const nested = path.join(project, 'src', 'nested');
fs.mkdirSync(nested, { recursive: true });
const originalCwd = process.cwd();
let nestedContext;
try {
  process.chdir(nested);
  nestedContext = await opBrainTaskContext({
    vault: nested,
    intent: 'Resolve the project brain from a nested Codex working directory',
    files: ['src/nested/example.ts'],
  });
} finally {
  process.chdir(originalCwd);
}
ok(nestedContext?.context?.hits?.some((hit) => /Context Gateway/.test(hit.text)),
  'brain_sync walks upward from a nested Codex cwd to the project brain');

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

for (const target of [home, project, gapProject]) fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(failures
  ? `\n[x] ${failures} context-gateway assertion(s) failed`
  : `\n[ok] context-gateway: all assertions passed · memory ${contextElapsed.toFixed(1)}ms · coordination p95 ${p95.toFixed(1)}ms`);
process.exit(failures ? 1 : 0);
