import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildKlypixMap, captureIntoBrain, parseKlypix,
  scoreCardsAgainstQuery, splitQueryTokens,
} from '../src/klypix-format.mjs';
import { opBrainTaskContext } from '../src/klypix-core.mjs';
import { createMcpPresence } from '../src/mcp-presence.mjs';
import { laneFileFor } from '../src/agent-presence.mjs';
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
const snapshotTree = (root) => {
  const rows = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        rows.push([`${relative}/`, null]);
        visit(full);
      } else if (entry.isFile()) {
        rows.push([relative, fs.readFileSync(full).toString('base64')]);
      }
    }
  };
  visit(root);
  return JSON.stringify(rows);
};

// PID-scoped fixtures keep independent test workers/sessions from racing over
// the same presence files and producing false latency/cleanup failures.
const home = path.join(os.tmpdir(), `klypix-context-gateway-home-${process.pid}`);
const project = path.join(os.tmpdir(), `klypix-context-gateway-project-${process.pid}`);
const gapProject = path.join(os.tmpdir(), `klypix-context-gap-project-${process.pid}`);
const workerHome = path.join(os.tmpdir(), `klypix-context-worker-home-${process.pid}`);
const foreignProject = path.join(os.tmpdir(), `klypix-context-worker-foreign-${process.pid}`);
for (const target of [home, project, gapProject, workerHome, foreignProject]) {
  if (!path.resolve(target).startsWith(path.resolve(os.tmpdir()))) throw new Error(`Unsafe test target: ${target}`);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(gapProject, { recursive: true });
fs.mkdirSync(foreignProject, { recursive: true });

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
const foreignBrain = await buildKlypixMap({
  title: 'foreign launch brain',
  areas: [{
    title: 'Foreign',
    cards: [{ text: 'FOREIGN_LAUNCH_CONTEXT must never appear for an explicitly bound target project.' }],
  }],
});
fs.writeFileSync(path.join(foreignProject, 'brain.klypix'), foreignBrain);
fs.writeFileSync(path.join(foreignProject, 'AGENTS.md'), '# foreign project sentinel\n');

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
  canvas: path.join(project, 'brain.klypix'),
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
  canvas: path.join(gapProject, 'brain.klypix'),
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
  canvas: path.join(gapProject, 'brain.klypix'),
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

// Production boundary: project/files preflight must run before the universal
// request-identity gate and before the real brain_sync handler. Launch from a
// foreign project brain, send an exact Codex thread id with each invalid call,
// and prove every durable surface stays byte-identical. Then a valid explicit
// root must adopt that id and query only the selected project's brain.
const workerPath = fileURLToPath(new URL('../bin/klypix-worker.mjs', import.meta.url));
const nestedWithoutBrain = path.join(project, 'nested-without-direct-brain');
fs.mkdirSync(nestedWithoutBrain, { recursive: true });
const workerClient = new Client({ name: 'OpenAI Codex', version: 'context-preflight-test' }, { capabilities: {} });
const workerTransport = new StdioClientTransport({
  command: process.execPath,
  args: [workerPath, '--vault', foreignProject],
  cwd: foreignProject,
  env: {
    ...process.env,
    HOME: workerHome,
    USERPROFILE: workerHome,
    KLYPIX_SESSION_ID: 'preflight-worker-seed',
    KLYPIX_AUTO_UPDATE: '0',
    KLYPIX_MCP_INBOX_POLL_MS: '60000',
  },
  stderr: 'pipe',
});
const requestMeta = (sessionId, turnId) => ({
  threadId: sessionId,
  'x-codex-turn-metadata': {
    session_id: sessionId,
    thread_id: sessionId,
    turn_id: turnId,
  },
});
try {
  await workerClient.connect(workerTransport);
  const foreignLane = laneFileFor(path.join(foreignProject, 'brain.klypix'), workerHome);
  const targetLane = laneFileFor(path.join(project, 'brain.klypix'), workerHome);
  const registryFile = path.join(workerHome, '.claude', 'project-brain', 'registry.json');
  for (let attempt = 0; attempt < 100 && !fs.existsSync(foreignLane); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const baselineForeignLane = fs.readFileSync(foreignLane, 'utf8');
  const baselineForeignProject = snapshotTree(foreignProject);
  const baselineTargetProject = snapshotTree(project);
  const invalidSession = 'codex-invalid-preflight-thread';
  const invalidRequests = [
    {
      label: 'empty explicit project',
      status: 'invalid-project',
      args: { project: '', phase: 'start', intent: 'must not route an empty root', files: ['empty.mjs'] },
    },
    {
      label: 'relative explicit project',
      status: 'invalid-project',
      args: { project: '.', phase: 'start', intent: 'must not route relatively', files: ['relative.mjs'] },
    },
    {
      label: 'nested project that only has an ancestor brain',
      status: 'invalid-project',
      args: { project: nestedWithoutBrain, phase: 'start', intent: 'must not walk upward', files: ['nested.mjs'] },
    },
    {
      label: 'nonexistent absolute project',
      status: 'invalid-project',
      args: { project: path.join(os.tmpdir(), `klypix-context-missing-${process.pid}`), phase: 'start', intent: 'must exist', files: ['missing.mjs'] },
    },
    {
      label: 'brain file supplied instead of its project root',
      status: 'invalid-project',
      args: { project: path.join(project, 'brain.klypix'), phase: 'start', intent: 'must be an exact root', files: ['file-root.mjs'] },
    },
    {
      label: 'invalid exact-file scope',
      status: 'invalid-scope',
      args: { project, phase: 'start', intent: 'must not adopt before scope validation', files: ['../escape.mjs'] },
    },
  ];
  for (let index = 0; index < invalidRequests.length; index++) {
    const fixture = invalidRequests[index];
    const rejected = await workerClient.callTool({
      name: 'brain_sync',
      arguments: { ...fixture.args, include_context: true },
      _meta: requestMeta(invalidSession, `invalid-preflight-turn-${index}`),
    });
    ok(rejected.isError === true
      && rejected.structuredContent?.status === fixture.status
      && rejected.structuredContent?.mutation === 'none'
      && rejected.structuredContent?.identityMutation === 'none'
      && rejected.structuredContent?.deliveryMutation === 'none'
      && rejected.structuredContent?.context?.mode === 'not-requested'
      && !Object.prototype.hasOwnProperty.call(rejected.structuredContent || {}, 'registration')
      && !Object.prototype.hasOwnProperty.call(rejected.structuredContent || {}, 'harness'),
    `real worker rejects ${fixture.label} before identity, handler, or context side effects`);
    ok(fs.readFileSync(foreignLane, 'utf8') === baselineForeignLane
      && !fs.existsSync(targetLane)
      && !fs.existsSync(registryFile)
      && snapshotTree(foreignProject) === baselineForeignProject
      && snapshotTree(project) === baselineTargetProject,
    `real worker ${fixture.label} rejection leaves lane, registry, and both projects byte-identical`);
  }

  const validSession = 'codex-valid-preflight-thread';
  const selected = await workerClient.callTool({
    name: 'brain_sync',
    arguments: {
      project,
      phase: 'checkpoint',
      intent: 'Improve Codex Context Gateway brain_sync coordination',
      files: ['src/future-worker-context.mjs'],
      include_context: true,
    },
    _meta: requestMeta(validSession, 'valid-preflight-turn'),
  });
  const selectedText = selected.content?.map((block) => block.text || '').join('\n') || '';
  const selectedLane = JSON.parse(fs.readFileSync(targetLane, 'utf8'));
  ok(selected.isError !== true
    && path.resolve(selected.structuredContent?.project || '') === path.resolve(project)
    && selectedLane.sessions?.some((session) => session.id === validSession)
    && /Context Gateway uses brain_sync/.test(selectedText)
    && !/FOREIGN_LAUNCH_CONTEXT/.test(selectedText),
  'valid real-worker preflight adopts identity and binds context to the explicit brain, never launch cwd');
  const asked = await workerClient.callTool({
    name: 'brain_ask',
    arguments: { question: 'How does the Codex Context Gateway coordinate active tasks?', k: 5 },
    _meta: requestMeta(validSession, 'valid-brain-ask-turn'),
  });
  const askedText = asked.content?.map((block) => block.text || '').join('\n') || '';
  ok(asked.isError !== true
    && /Context Gateway uses brain_sync/.test(askedText)
    && !/FOREIGN_LAUNCH_CONTEXT/.test(askedText),
  'default brain_ask stays pinned to the brain_sync project after a foreign-cwd launch');

  const targetBrainPath = path.join(project, 'brain.klypix');
  const foreignBrainPath = path.join(foreignProject, 'brain.klypix');
  const targetBeforeDefaultTools = fs.readFileSync(targetBrainPath);
  const foreignBeforeDefaultTools = fs.readFileSync(foreignBrainPath);
  const targetCards = (await parseKlypix(targetBeforeDefaultTools)).struct.cards
    .filter((card) => card.type !== 'container');
  const pinnedReadTools = [
    {
      name: 'brain_challenge',
      arguments: { claim: 'The Codex Context Gateway does not coordinate active tasks.', k: 5 },
      evidence: /context gateway fixture/i,
    },
    {
      name: 'brain_insights',
      arguments: { view: 'areas' },
      evidence: /context gateway fixture/i,
    },
    {
      name: 'brain_lens',
      arguments: { view: 'unresolved' },
      evidence: /context gateway fixture/i,
    },
    {
      name: 'brain_connect',
      arguments: {
        apply: false,
        pairs: [{ fromId: targetCards[0].id, toId: targetCards[1].id }],
        relationship: 'relates_to',
      },
      evidence: /Context Gateway uses brain_sync|Exact file overlap alerts/i,
    },
    {
      name: 'brain_reconcile',
      arguments: { mode: 'contradictions' },
      evidence: /context gateway fixture/i,
    },
    {
      name: 'brain_garden',
      arguments: { apply: false },
      evidence: /context gateway fixture/i,
    },
    {
      name: 'project_map_context',
      arguments: { question: 'How does the Codex Context Gateway coordinate active tasks?', deep_history: false },
      evidence: /Context Gateway uses brain_sync/i,
    },
    {
      name: 'canvas_view',
      arguments: {},
      evidence: /context gateway fixture/i,
    },
  ];
  for (let index = 0; index < pinnedReadTools.length; index++) {
    const fixture = pinnedReadTools[index];
    const response = await workerClient.callTool({
      name: fixture.name,
      arguments: fixture.arguments,
      _meta: requestMeta(validSession, `bound-${fixture.name}-turn-${index}`),
    });
    const responseText = response.content?.map((block) => block.text || '').join('\n') || '';
    ok(response.isError !== true
      && fixture.evidence.test(responseText)
      && !/FOREIGN_LAUNCH_CONTEXT|foreign launch brain/i.test(responseText),
    `default ${fixture.name} stays pinned to the brain_sync project`);
  }
  ok(fs.readFileSync(targetBrainPath).equals(targetBeforeDefaultTools)
    && fs.readFileSync(foreignBrainPath).equals(foreignBeforeDefaultTools),
  'all bound read/dry-run Brain tools leave both brain files byte-identical');

  const noteSentinel = `BOUND_ROUTE_SENTINEL_${process.pid}`;
  const noteText = `${noteSentinel}: verify the worker's default Brain write stays in the explicit project.`;
  const noted = await workerClient.callTool({
    name: 'brain_note',
    arguments: { text: noteText, area: 'Routing', marker: '?' },
    _meta: requestMeta(validSession, 'bound-brain-note-turn'),
  });
  const targetAfterNote = (await parseKlypix(fs.readFileSync(targetBrainPath))).struct;
  const noteRecordedInTarget = targetAfterNote.cards.some((card) => (card.text || '').includes(noteSentinel));
  const foreignUnchangedByNote = fs.readFileSync(foreignBrainPath).equals(foreignBeforeDefaultTools);
  ok(noted.isError !== true && noteRecordedInTarget && foreignUnchangedByNote,
  `default brain_note writes only the brain_sync project and leaves the foreign launch brain byte-identical (tool=${noted.isError === true ? 'error' : 'ok'}, target=${noteRecordedInTarget}, foreign=${foreignUnchangedByNote})`);
  const readAfterAtomicNote = await workerClient.callTool({
    name: 'brain_ask',
    arguments: { question: `What is ${noteSentinel}?`, k: 3 },
    _meta: requestMeta(validSession, 'read-after-atomic-note-turn'),
  });
  ok(readAfterAtomicNote.isError !== true,
  'a managed brain_note atomic rewrite refreshes the bound brain identity for the next default read');

  const explicitForeign = await workerClient.callTool({
    name: 'brain_ask',
    arguments: { canvas: foreignBrainPath, question: 'What is FOREIGN_LAUNCH_CONTEXT?', k: 3 },
    _meta: requestMeta(validSession, 'explicit-foreign-canvas-turn'),
  });
  const explicitForeignText = explicitForeign.content?.map((block) => block.text || '').join('\n') || '';
  ok(explicitForeign.isError !== true && /FOREIGN_LAUNCH_CONTEXT/.test(explicitForeignText),
  'an explicit canvas still overrides the brain_sync default binding');

  // Post-sync project retargeting is rejected universally before request
  // identity, handler, Remote root access, or delivery. Keep the original
  // canonical project available at its renamed path and replace the lexical
  // project root with a junction to the foreign fixture.
  const movedTargetProject = `${project}-moved`;
  fs.rmSync(movedTargetProject, { recursive: true, force: true });
  fs.renameSync(project, movedTargetProject);
  fs.symlinkSync(foreignProject, project, process.platform === 'win32' ? 'junction' : 'dir');
  const movedTargetBrain = path.join(movedTargetProject, 'brain.klypix');
  const movedTargetBeforeRetargetTools = fs.readFileSync(movedTargetBrain);
  const foreignBeforeRetargetTools = fs.readFileSync(foreignBrainPath);
  for (const [index, call] of [
    { name: 'brain_note', arguments: { text: `MUST_NOT_WRITE_${process.pid}`, area: 'Routing' } },
    { name: 'brain_ask', arguments: { question: 'What is FOREIGN_LAUNCH_CONTEXT?', k: 3 } },
    // Was remote_status until KLYPIX Remote was removed (2026-08-15). The third
    // case only needs a read-only tool with an empty input schema, so that the
    // gate is proven on a call carrying no arguments of its own.
    { name: 'list_canvases', arguments: {} },
  ].entries()) {
    const rejected = await workerClient.callTool({
      ...call,
      _meta: requestMeta(validSession, `post-sync-retarget-${index}`),
    });
    ok(rejected.isError === true
      && rejected.structuredContent?.status === 'project-changed'
      && rejected.structuredContent?.mutation === 'none'
      && rejected.structuredContent?.identityMutation === 'none'
      && rejected.structuredContent?.deliveryMutation === 'none',
    `post-sync retarget rejects ${call.name} before identity, handler, Remote, or delivery mutation`);
    ok(fs.readFileSync(movedTargetBrain).equals(movedTargetBeforeRetargetTools)
      && fs.readFileSync(foreignBrainPath).equals(foreignBeforeRetargetTools),
    `rejected ${call.name} leaves canonical target and foreign brain byte-identical`);
  }
  fs.rmSync(project, { force: true });
  fs.renameSync(movedTargetProject, project);
} finally {
  await workerClient.close().catch(() => {});
}

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
const exactExisting = path.join(project, 'src', 'exact-existing.mjs');
fs.mkdirSync(path.dirname(exactExisting), { recursive: true });
fs.writeFileSync(exactExisting, 'export const exact = true;\n');
const validScopeStart = presence.sync({
  project,
  phase: 'start',
  intent: 'validate exact file scope before coordination',
  files: ['src/exact-existing.mjs', 'src/future/not-created-yet.mjs'],
});
ok(validScopeStart.isError !== true && validScopeStart.structured?.status === 'active',
  'exact existing and missing-future file declarations are accepted');
const presenceLane = laneFileFor(path.join(project, 'brain.klypix'), home);
const validLaneBytes = fs.readFileSync(presenceLane, 'utf8');
const validLaneRow = JSON.parse(validLaneBytes).sessions
  .find((session) => session.id === 'context-perf-session');
ok(validLaneRow?.files?.includes('src/exact-existing.mjs')
  && validLaneRow.files.includes('src/future/not-created-yet.mjs'),
  'accepted exact paths are the task scope persisted to the lane');

// The public preflight object is only a capability handle. Mutating every
// visible field cannot alter the private trusted snapshot, and changing the
// original call input causes fail-closed rejection instead of redirecting sync.
const mutableInput = {
  project,
  projectProvided: true,
  phase: 'checkpoint',
  files: ['src/mutable-preflight.mjs'],
};
const mutablePreflight = presence.preflightSync(mutableInput);
const visibleMutationResults = [
  Reflect.set(mutablePreflight, 'requestedVault', foreignProject),
  Reflect.set(mutablePreflight, 'resultBrainPath', path.join(foreignProject, 'brain.klypix')),
  Reflect.set(mutablePreflight, 'declaredFiles', ['foreign.mjs']),
  Reflect.set(mutablePreflight, 'token', {}),
];
const consumedMutable = presence.consumeSyncPreflight(mutablePreflight, mutableInput);
const mutableResult = presence.sync({
  project,
  phase: 'checkpoint',
  files: ['src/mutable-preflight.mjs'],
  preflight: consumedMutable,
});
const mutableLaneRow = JSON.parse(fs.readFileSync(presenceLane, 'utf8')).sessions
  .find((session) => session.id === 'context-perf-session');
ok(visibleMutationResults.every((changed) => changed === false)
  && mutableResult.isError !== true
  && mutableLaneRow.files?.includes('src/mutable-preflight.mjs')
  && !mutableLaneRow.files?.includes('foreign.mjs'),
'public preflight handles are immutable and cannot redirect the trusted project, brain, or file scope');
const laneBytesAfterMutableScope = fs.readFileSync(presenceLane, 'utf8');
const replayedPreflight = presence.sync({
  project,
  phase: 'checkpoint',
  files: ['src/mutable-preflight.mjs'],
  preflight: consumedMutable,
});
ok(replayedPreflight.isError === true
  && replayedPreflight.structured?.status === 'invalid-preflight'
  && replayedPreflight.structured?.mutation === 'none',
'a consumed preflight capability cannot be replayed');
const changedInputPreflight = presence.preflightSync(mutableInput);
const changedInputConsume = presence.consumeSyncPreflight(changedInputPreflight, {
  ...mutableInput,
  files: ['src/redirected-after-preflight.mjs'],
});
ok(changedInputConsume.ok === false
  && changedInputConsume.report?.structured?.status === 'invalid-preflight'
  && changedInputConsume.report?.structured?.mutation === 'none',
'changing call inputs after preflight is rejected before mutation');

// Deterministic filesystem object swaps exercise the exact preflight→consume
// window without timing races. A brain replacement and (where supported) a
// project-link retarget both invalidate the capability before any lane write.
const brainSwapProject = path.join(os.tmpdir(), `klypix-context-brain-swap-${process.pid}`);
const linkSwapTarget = path.join(os.tmpdir(), `klypix-context-link-target-${process.pid}`);
const linkSwapForeign = path.join(os.tmpdir(), `klypix-context-link-foreign-${process.pid}`);
const linkSwapPath = path.join(os.tmpdir(), `klypix-context-link-${process.pid}`);
for (const target of [brainSwapProject, linkSwapTarget, linkSwapForeign, linkSwapPath]) {
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(brainSwapProject, { recursive: true });
const swapBrainPath = path.join(brainSwapProject, 'brain.klypix');
fs.writeFileSync(swapBrainPath, brain);
const swapPresence = createMcpPresence({
  server: fakeServer,
  initialVault: project,
  env: { KLYPIX_SESSION_ID: 'context-swap-session' },
  home,
  setIntervalFn: timer,
  clearIntervalFn: () => {},
});
const brainSwapInput = {
  project: brainSwapProject,
  projectProvided: true,
  phase: 'start',
  files: ['src/swap.mjs'],
};
const brainSwapPreflight = swapPresence.preflightSync(brainSwapInput);
const originalSwapBrain = path.join(brainSwapProject, 'brain.original.klypix');
fs.renameSync(swapBrainPath, originalSwapBrain);
fs.writeFileSync(swapBrainPath, foreignBrain);
const brainSwapRejected = swapPresence.consumeSyncPreflight(brainSwapPreflight, brainSwapInput);
ok(brainSwapRejected.ok === false
  && brainSwapRejected.report?.structured?.status === 'project-changed'
  && brainSwapRejected.report?.structured?.mutation === 'none'
  && !fs.existsSync(laneFileFor(swapBrainPath, home)),
'atomic brain-file replacement after preflight is rejected before lane or identity mutation');
fs.rmSync(swapBrainPath, { force: true });
fs.renameSync(originalSwapBrain, swapBrainPath);
const authorizedBrainSwapPreflight = swapPresence.preflightSync(brainSwapInput);
const authorizedBrainSwapConsumed = swapPresence.consumeSyncPreflight(
  authorizedBrainSwapPreflight,
  brainSwapInput,
);
const authorizedBrainSwap = swapPresence.revalidateConsumedSyncPreflight(
  authorizedBrainSwapConsumed,
  brainSwapInput,
);
fs.renameSync(swapBrainPath, originalSwapBrain);
fs.writeFileSync(swapBrainPath, foreignBrain);
const postAuthorizationBrainSwap = swapPresence.sync({
  project: brainSwapProject,
  phase: 'start',
  files: ['src/swap.mjs'],
  preflight: authorizedBrainSwap,
});
ok(postAuthorizationBrainSwap.isError === true
  && postAuthorizationBrainSwap.structured?.status === 'project-changed'
  && postAuthorizationBrainSwap.structured?.mutation === 'none'
  && !fs.existsSync(laneFileFor(swapBrainPath, home)),
'atomic brain-file replacement after final authorization is rechecked at sync entry with zero mutation');

let linkSwapSupported = true;
try {
  fs.mkdirSync(linkSwapTarget, { recursive: true });
  fs.mkdirSync(linkSwapForeign, { recursive: true });
  fs.writeFileSync(path.join(linkSwapTarget, 'brain.klypix'), brain);
  fs.writeFileSync(path.join(linkSwapForeign, 'brain.klypix'), foreignBrain);
  fs.symlinkSync(linkSwapTarget, linkSwapPath, process.platform === 'win32' ? 'junction' : 'dir');
} catch {
  linkSwapSupported = false;
}
if (linkSwapSupported) {
  const linkInput = {
    project: linkSwapPath,
    projectProvided: true,
    phase: 'start',
    files: ['src/link-swap.mjs'],
  };
  const linkPreflight = swapPresence.preflightSync(linkInput);
  const targetLaneBefore = fs.existsSync(laneFileFor(path.join(linkSwapTarget, 'brain.klypix'), home));
  const foreignLaneBefore = fs.existsSync(laneFileFor(path.join(linkSwapForeign, 'brain.klypix'), home));
  fs.rmSync(linkSwapPath, { force: true });
  fs.symlinkSync(linkSwapForeign, linkSwapPath, process.platform === 'win32' ? 'junction' : 'dir');
  const linkRejected = swapPresence.consumeSyncPreflight(linkPreflight, linkInput);
  ok(linkRejected.ok === false
    && linkRejected.report?.structured?.status === 'project-changed'
    && linkRejected.report?.structured?.identityMutation === 'none'
    && fs.existsSync(laneFileFor(path.join(linkSwapTarget, 'brain.klypix'), home)) === targetLaneBefore
    && fs.existsSync(laneFileFor(path.join(linkSwapForeign, 'brain.klypix'), home)) === foreignLaneBefore,
  'junction/symlink retarget after preflight leaves target and foreign lanes unchanged');
  fs.rmSync(linkSwapPath, { force: true });
  fs.symlinkSync(linkSwapTarget, linkSwapPath, process.platform === 'win32' ? 'junction' : 'dir');
  const authorizedLinkPreflight = swapPresence.preflightSync(linkInput);
  const authorizedLinkConsumed = swapPresence.consumeSyncPreflight(authorizedLinkPreflight, linkInput);
  const authorizedLink = swapPresence.revalidateConsumedSyncPreflight(authorizedLinkConsumed, linkInput);
  fs.rmSync(linkSwapPath, { force: true });
  fs.symlinkSync(linkSwapForeign, linkSwapPath, process.platform === 'win32' ? 'junction' : 'dir');
  const postAuthorizationLinkSwap = swapPresence.sync({
    project: linkSwapPath,
    phase: 'start',
    files: ['src/link-swap.mjs'],
    preflight: authorizedLink,
  });
  ok(postAuthorizationLinkSwap.isError === true
    && postAuthorizationLinkSwap.structured?.status === 'project-changed'
    && postAuthorizationLinkSwap.structured?.mutation === 'none'
    && fs.existsSync(laneFileFor(path.join(linkSwapTarget, 'brain.klypix'), home)) === targetLaneBefore
    && fs.existsSync(laneFileFor(path.join(linkSwapForeign, 'brain.klypix'), home)) === foreignLaneBefore,
  'junction/symlink retarget after final authorization is rechecked before identity or lane mutation');
} else {
  ok(true, 'junction/symlink retarget regression skipped because this filesystem forbids link creation');
}
swapPresence.stop();
for (const target of [brainSwapProject, linkSwapTarget, linkSwapForeign, linkSwapPath]) {
  fs.rmSync(target, { recursive: true, force: true });
}

const invalidScopes = [
  { label: 'non-string entry', files: [42], code: 'file-not-string' },
  { label: 'empty entry', files: ['   '], code: 'file-empty' },
  { label: 'absolute path', files: [path.join(project, 'src', 'absolute.mjs')], code: 'file-absolute' },
  { label: 'escaping path', files: ['../outside.mjs'], code: 'file-escapes-project' },
  { label: 'leading-dot spelling', files: ['./src/example.mjs'], code: 'file-noncanonical' },
  { label: 'backslash spelling', files: ['src\\example.mjs'], code: 'file-noncanonical' },
  { label: 'trailing slash', files: ['src/nested/'], code: 'file-trailing-slash' },
  { label: 'glob-like path', files: ['src/*.mjs'], code: 'file-glob-like' },
  { label: 'case-folded duplicate', files: ['src/Example.mjs', 'SRC/example.mjs'], code: 'file-duplicate' },
  { label: 'overlong path', files: [`src/${'a'.repeat(509)}`], code: 'file-too-long' },
  { label: 'more than twenty paths', files: Array.from({ length: 21 }, (_, index) => `src/file-${index}.mjs`), code: 'files-too-many' },
  { label: 'existing directory', files: ['src/nested'], code: 'file-is-directory' },
];
for (const phase of ['start', 'checkpoint', 'complete']) {
  for (const fixture of invalidScopes) {
    const rejected = presence.sync({
      project,
      phase,
      intent: `must not persist ${fixture.label}`,
      files: fixture.files,
    });
    ok(rejected.isError === true
      && rejected.structured?.status === 'invalid-scope'
      && rejected.structured?.mutation === 'none'
      && rejected.structured?.errors?.some((error) => error.code === fixture.code),
    `${phase} rejects ${fixture.label} with an actionable invalid-scope error`);
    ok(fs.readFileSync(presenceLane, 'utf8') === laneBytesAfterMutableScope,
      `${phase} ${fixture.label} rejection leaves the lane byte-for-byte unchanged`);
  }
}

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
const completed = presence.sync({ phase: 'complete' });
ok(completed.isError !== true && completed.structured?.status === 'complete',
  'completion with no files preserves the existing completion contract');
presence.stop();

for (const target of [home, project, `${project}-moved`, gapProject, workerHome, foreignProject]) fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(failures
  ? `\n[x] ${failures} context-gateway assertion(s) failed`
  : `\n[ok] context-gateway: all assertions passed · memory ${contextElapsed.toFixed(1)}ms · coordination p95 ${p95.toFixed(1)}ms`);
process.exit(failures ? 1 : 0);
