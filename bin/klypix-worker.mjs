#!/usr/bin/env node
// Replaceable worker behind the stable KLYPIX stdio supervisor.
// klypix-mcp-server — a Model Context Protocol server that gives any MCP client
// (Claude Desktop, Claude Code, "cowork", …) full READ + WRITE access to your
// .klypix canvas library. It turns the one-off read-klypix / write-klypix
// skills into a standing, tool-based connection: an outside agent can list your
// canvases, read one (cards + connection graph + [[links]] + #tags), search
// across all of them, create a new board, or add cards to an existing one.
//
// It operates on the .klypix FILES in a "vault" folder — no need for the KLYPIX
// desktop app to be running, and nothing here can corrupt a live canvas.
//
// Run (stdio):   node bin/klypix-mcp.mjs --vault "C:\\path\\to\\canvases"
//   or set env:  KLYPIX_VAULT=...   (default: ~/Documents)
//
// All vault logic lives in ../src/klypix-core.mjs — this file is the thin MCP
// FACE over that engine (the A2A face, bin/klypix-a2a.mjs, shares the same core).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  resolveVault, getEmbedder, shouldPrewarmSemantic, buildKlypixMap, cardSchema, connSchema,
  opListCanvases, opReadCanvas, opSearchCanvases, opSearchAllBrains,
  opBrainInsights, opBrainConnect, opBrainReconcile, opBrainGarden, opCreateCanvas, opAddToCanvas, opBrainNote, opBrainMessage, opBrainAsk, opBrainChallenge, opCanvasView, opBrainLens,
  opBrainTaskContext,
} from '../src/klypix-core.mjs';
import { compareProjectGraphResults, projectGraphContextMarkdown, queryProjectGraph, suggestProjectGraphBrainLinks, scanNativeProjectMap, checkBrainDrift, brainDriftMarkdown } from '../src/project-graph.mjs';
import { auditProject, compactAgentsBrief, linkProject, mcpServerEntry } from '../src/agent-rules.mjs';
import { createMcpPresence, KLYPIX_MCP_INSTRUCTIONS } from '../src/mcp-presence.mjs';
import { consumeMessageReceipt, findProjectBrain } from '../src/agent-presence.mjs';
import {
  reconcileRegisteredProjects,
  registerProjectBrain,
  spawnAutoUpdateHelper,
} from '../src/mcp-auto-update.mjs';
// Namespace import (already in-process via the klypix-core chain, so zero added
// load cost) so a bundle whose klypix-format predates classifyDecay degrades
// gracefully — a named import of a missing export would kill the whole server.
import * as brainFormat from '../src/klypix-format.mjs';

// Real package version for the MCP handshake (was hardcoded '1.0.0', which
// misled every client/version diagnosis — it could never reflect the true release).
const PKG_VERSION = (() => { try { return createRequire(import.meta.url)('../package.json').version; } catch { return '0.0.0'; } })();
const RUNTIME_BRAIN_DIR = path.dirname(
  process.env.KLYPIX_MCP_RUNTIME_MANIFEST
  || path.join(os.homedir(), '.claude', 'project-brain', '.mcp-runtime.json'),
);

// IMPORTANT: stdout is the JSON-RPC channel. Never console.log — only stderr.
const log = (...a) => console.error('[klypix-mcp]', ...a);

// ── ARGV NORMALIZATION — the ONE place the dispatcher prefix is handled ───────
// Every verb below is ALSO published as its own bin (package.json bin.klypix-link
// / klypix-doctor / klypix-install / klypix-conformance), so each of those files
// would otherwise have to satisfy TWO argv shapes:
//   dispatcher: [node, klypix-mcp.mjs, 'link', '--check']
//   standalone: [node, klypix-link.mjs, '--check']
// Instead of making every sub-bin guess, the dispatcher REMOVES its own verb token
// before handing over, so a sub-bin can unconditionally parse process.argv.slice(2)
// and both shapes are byte-identical.
//
// This closes a silent P0: klypix-link.mjs parsed slice(3), which is correct only
// via the dispatcher. Run as its own bin, `klypix-link --check` DROPPED --check,
// wrote all 14 managed project files and exited 0 — so a CI drift gate wired to
// `npx -p klypix-mcp klypix-link --check` rewrote the working tree and passed
// unconditionally, and `klypix-link <dir>` wrote into the cwd instead of <dir>.
// Regression-locked by test/cli-args.mjs (parity: bin vs dispatcher).
const runVerb = async (verb, moduleId) => {
  if (process.argv[2] !== verb) return;
  process.argv.splice(2, 1);          // sub-bins see the STANDALONE shape, always
  try {
    await import(moduleId);
  } catch (error) {
    // The flattened ~/.claude/project-brain bundle stages this worker but not the
    // link/doctor/install bins, so the import used to die with a raw
    // ERR_MODULE_NOT_FOUND stack. Say what is actually wrong instead.
    const missing = error?.code === 'ERR_MODULE_NOT_FOUND'
      && String(error?.message || '').includes(moduleId.replace('./', ''));
    if (!missing) throw error;
    console.error(`klypix: \`${verb}\` is not available in this installed bundle — run \`npx klypix-mcp ${verb}\` from the npm package instead.`);
    process.exit(2);
  }
  process.exit(0);
};

// `npx klypix-mcp install` — lay the WHOLE brain (hook + engine + local servers)
// into ~/.claude/project-brain and wire the Claude Code hooks. This is the single
// agent-neutral installer, so a brain release reaches every machine via one npm
// publish + this command (the global brain serves every project). Runs before any
// server setup; delegates to the dedicated bin so `npx klypix-install` also works.
await runVerb('install', './klypix-install.mjs');

// `npx klypix-mcp link` — make THIS project's brain automatic for EVERY agent tool,
// not just Claude Code: drop each tool's native MCP config + rules file (Cursor, Cline,
// Windsurf, Copilot/VS Code, AGENTS.md) so any agent opened here reads + captures the
// brain on its own. Project-scoped (cwd); idempotent. Runs before any server setup.
await runVerb('link', './klypix-link.mjs');

// `npx klypix-mcp doctor` — the brain's READ-ONLY self-check: is this machine's brain
// current, are the 5 hooks wired, what verbs does it expose, who's live, is the harness
// projection in sync? One verdict, one reconcile block. Exits 1 on drift (CI gate).
await runVerb('doctor', './klypix-doctor.mjs');

// `npx klypix-mcp conformance` — launch two real, isolated MCP clients against
// this exact installed server and verify task memory, truthful peers, blocking
// overlap detection, proactive logging, and guaranteed next-action delivery.
await runVerb('conformance', './klypix-conformance.mjs');

// `npx klypix-mcp git-driver | diff | pr-brief` — the GitHub lane: register the
// lossless .klypix merge driver for any repo, render a readable brain diff vs a
// git ref, and print the brain cards touching a PR's changed files. One module,
// three verbs (it reads argv[2] itself).
await runVerb('git-driver', './klypix-git-driver.mjs');
// `npx klypix-mcp git-hook` — wire the agent-neutral commit-capture hook
// (brain-git-hook.mjs) into a repo's post-commit/post-merge, so feat/fix/perf
// commits with rationale bodies card into the brain from ANY agent, branch, or
// worktree at commit time (the Stop hook alone is blind to other worktrees).
await runVerb('git-hook', './klypix-git-hook.mjs');
// `npx klypix-mcp brain-history` — list/restore the automatic restore points
// written before every brain write. The recovery path for an accidental card
// deletion, a destructive edit, a stale overwrite, or a deleted brain file.
await runVerb('brain-history', './klypix-brain-history.mjs');
// `npx klypix-mcp brain-deleted` — the brain's recycle bin. A human delete moves
// the card's bytes to graveyard/ instead of destroying them; this lists, restores
// and (permanently) purges them.
await runVerb('brain-deleted', './klypix-brain-deleted.mjs');
// `npx klypix-mcp orphans` — the orphan gardener's backfill: report how many live
// cards sit outside the graph, link the CONFIDENT subset (one unambiguous lexical
// anchor each — never a fan-out). Dry-run by default; --apply takes a forced
// restore point first, so the whole pass is one brain-history restore from undone.
await runVerb('orphans', './klypix-orphans.mjs');
await runVerb('diff', './klypix-diff.mjs');
await runVerb('pr-brief', './klypix-pr-brief.mjs');

// `npx klypix-mcp uninstall` — the machine-global removal tool. `--check` prints a full
// inventory and writes nothing; every write is backed up; a `.klypix` brain is never
// touched. Wired into the dispatcher 2026-08-01: it shipped as a bin-only verb, so
// `npx klypix-mcp uninstall` answered "unknown command" while the README (and this
// CLI's own --help) said no uninstall existed at all.
await runVerb('uninstall', './klypix-uninstall.mjs');

// `npx klypix-mcp garden-code` — the HUMAN half of the garden approval gate.
// brain_garden's apply requires an 8-char code derived from the exact dormant
// candidate set + day; the agent is deliberately never shown it. The human runs
// this after reviewing the agent's plan and pastes the code into chat — that
// paste IS the out-of-band approval. Optional arg: a brain path (default
// ./brain.klypix in the cwd).
if (process.argv[2] === 'garden-code') {
  const target = path.resolve(process.cwd(), process.argv[3] || 'brain.klypix');
  if (!fs.existsSync(target)) { console.error(`No brain at ${target} — run from the project folder (or pass a path).`); process.exit(1); }
  const { parseKlypix, selectGardenCandidates } = await import('../src/klypix-format.mjs');
  const { gardenApprovalCode } = await import('../src/klypix-core.mjs');
  const { struct } = await parseKlypix(fs.readFileSync(target));
  const areas = selectGardenCandidates(struct);
  if (!areas.length) { console.error('Nothing to garden right now — no approval needed.'); process.exit(0); }
  console.error(`Garden plan: ${areas.length} area(s) — ${areas.map(a => `${a.title} (${a.candidates.length})`).join(' · ')}`);
  console.error(`If you approve what the agent showed you, paste this code into chat (valid today, for exactly this set):`);
  console.log(gardenApprovalCode(areas));
  process.exit(0);
}

// `npx klypix-mcp init` — 60-second onboarding: seed a starter project brain in
// the current folder so a new user's FIRST contact isn't an empty vault, then
// print a paste-ready MCP config. Runs before any server setup.
if (process.argv[2] === 'init') {
  const target = path.resolve(process.cwd(), 'brain.klypix');
  if (fs.existsSync(target)) { console.error(`brain.klypix already exists in ${process.cwd()} — not overwriting.`); process.exit(0); }
  const buf = await buildKlypixMap({
    title: 'project brain',
    kind: 'brain',   // explicit flag — co-owned merge semantics survive a rename
    areas: [
      { title: 'Goal', cards: [{ text: '❓ What is this project for, and for whom?\nAgent: survey the repo on your first session and replace this with the real goal.' }] },
      { title: 'Architecture', cards: [{ text: '❓ Key components and how they fit.\nAgent: record the actual shape from the repo — only what a new session must know.' }] },
      { title: 'Decisions', cards: [{ text: 'Decisions land here automatically: agents emit `🧠 BRAIN [Area]: …` markers; a new decision that replaces an old one archives it (superseded). Resolve finished items with `✓`, correct in place with `~`. Drag any card into 📌 Focus to make it lead every session brief.' }] },
      { title: '🛠️ Skills', cards: [{ text: '🛠️ Reusable how-tos, gotchas & conventions land here — emit `🧠 BRAIN [Area] +: <skill>` (or just state a rule like "always X / never Y" and it auto-promotes). Skills resurface every session and never age out, unlike one-time decisions. This is "how we work here", inherited by every future agent.' }] },
      { title: 'Pending / next', cards: [{ text: 'What is in flight and what comes next. Close finished items with the ✓ marker.' }] },
      { title: 'Open questions', cards: [{ text: 'Unresolved questions (the ❓ marker) live here — the session brief surfaces them first.' }] },
      { title: '📌 Focus', cards: [{ text: 'Drag any card into this area to make it lead every session brief — steer your agent by moving cards.' }] },
    ],
  });
  fs.writeFileSync(target, buf);
  const cfg = JSON.stringify({ mcpServers: { 'klypix-canvas': mcpServerEntry({ vault: process.cwd().replace(/\\/g, '/') }) } }, null, 2);
  console.error(`✓ Created ${target}\n\nAdd this to your MCP client config (.mcp.json / claude_desktop_config.json):\n\n${cfg}\n\nThen ask your agent to read the canvas "brain" — it now has a project memory.`);
  process.exit(0);
}

const vaultArgIdx = process.argv.indexOf('--vault');
const VAULT = resolveVault(vaultArgIdx >= 0 ? process.argv[vaultArgIdx + 1] : undefined);
// A silent ~/Documents fallback is how idle default-root pairs hide inside the
// machine's RAM total. Say it loudly; brain_sync {project} re-routes per call.
if (vaultArgIdx < 0 && !process.env.KLYPIX_VAULT) {
  log(`DEFAULT ROOT: no --vault/KLYPIX_VAULT — vault fell back to ${VAULT}. Pass the project root via brain_sync {project} (or configure --vault) so this connection serves a real project.`);
}
const server = new McpServer(
  { name: 'klypix-canvas', version: PKG_VERSION },
  {
    instructions: KLYPIX_MCP_INSTRUCTIONS,
    capabilities: { logging: {} },
  },
);
// Decay-aware LAST-KNOWN stamps for every MCP delivery surface (2026-07-28
// post-mortem, class B): the classifier lives ONCE in klypix-format.mjs and is
// INJECTED here so mcp-presence/agent-presence stay builtin-only. The typeof
// guards let a bundle predating the feature degrade to unstamped delivery —
// no crash, no stamp, never a throw.
const mcpPresence = createMcpPresence({
  server,
  initialVault: VAULT,
  decay: typeof brainFormat.classifyDecay === 'function' ? {
    classifyDecay: brainFormat.classifyDecay,
    decayStaleMs: brainFormat.DECAY_STALE_MS,
    decayMessageStamp: typeof brainFormat.decayMessageStamp === 'function' ? brainFormat.decayMessageStamp : undefined,
    formatDecayAge: typeof brainFormat.formatDecayAge === 'function' ? brainFormat.formatDecayAge : undefined,
  } : {},
});
// Once brain_sync binds this connection to an exact project brain, all
// project-brain-default tools must use that same file. Leaving canvas undefined
// lets klypix-core's intentional cwd/env precedence substitute an ambient brain
// from the worker launch directory. Explicit caller canvas always wins.
const boundBrainCanvas = (canvas) => canvas || mcpPresence.brainPath;

const noMutationBrainSyncResult = (report, { phase, totalStartedAt = Date.now() } = {}) => {
  const totalMs = Math.max(0, Date.now() - totalStartedAt);
  return {
    content: [{
      type: 'text',
      text: report?.text || 'KLYPIX brain_sync preflight rejected this request without mutation.',
    }],
    structuredContent: {
      ...(report?.structured || {}),
      phase: phase || report?.structured?.phase || 'checkpoint',
      mutation: 'none',
      identityMutation: 'none',
      deliveryMutation: 'none',
      context: {
        mode: 'not-requested',
        hits: [],
        sufficient: false,
        durationMs: 0,
      },
      timingMs: {
        ...(report?.structured?.timingMs || {}),
        context: 0,
        total: totalMs,
      },
    },
    isError: true,
  };
};

const partialMutationBrainSyncResult = (report, { phase, totalStartedAt = Date.now() } = {}) => ({
  content: [{
    type: 'text',
    text: report?.text || 'KLYPIX stopped later brain_sync work after project routing changed.',
  }],
  structuredContent: {
    ...(report?.structured || {}),
    phase: phase || report?.structured?.phase || 'checkpoint',
    mutation: report?.structured?.mutation || 'presence-only',
    identityMutation: report?.structured?.identityMutation || 'none',
    deliveryMutation: report?.structured?.deliveryMutation || 'none',
    timingMs: {
      ...(report?.structured?.timingMs || {}),
      total: Math.max(0, Date.now() - totalStartedAt),
    },
  },
  isError: true,
});

const projectChangedToolResult = () => ({
  content: [{
    type: 'text',
    text: 'KLYPIX project routing changed after brain_sync. This tool was rejected before identity, handler, presence, or message-delivery mutation; call brain_sync again with the exact current project root.',
  }],
  structuredContent: {
    schemaVersion: 1,
    status: 'project-changed',
    mutation: 'none',
    identityMutation: 'none',
    deliveryMutation: 'none',
  },
  isError: true,
});

// Map a protocol-neutral core result → an MCP tool result.
// Every tool call carries host request metadata in the SDK callback's second
// argument. Adopt the logical Codex thread before ANY handler executes,
// including MCP Apps, so operations, messages, and delivery share one session.
// Contradictory identity fails closed: the handler does not run and no queued
// message is offered or acknowledged.
const registerToolRaw = server.registerTool.bind(server);
server.registerTool = (name, config, handler) => registerToolRaw(name, config, async (args, extra) => {
  // brain_sync's project and exact-file declarations are routing authority.
  // Validate them before generic request identity adoption so a rejected call
  // cannot rekey a session, touch a lane, register a project, self-heal a
  // harness, observe a ship, or query task context. The opaque checked snapshot
  // is consumed by sync below, avoiding a second post-adoption filesystem pass.
  let brainSyncPreflight = null;
  if (name === 'brain_sync') {
    const preflightInput = {
      project: args?.project,
      projectProvided: Object.prototype.hasOwnProperty.call(args || {}, 'project'),
      files: args?.files,
      phase: args?.phase || 'checkpoint',
    };
    brainSyncPreflight = mcpPresence.preflightSync(preflightInput);
    if (!brainSyncPreflight.ok) {
      return noMutationBrainSyncResult(brainSyncPreflight.report, { phase: args?.phase });
    }
    brainSyncPreflight = mcpPresence.consumeSyncPreflight(brainSyncPreflight, preflightInput);
    if (!brainSyncPreflight.ok) {
      return noMutationBrainSyncResult(brainSyncPreflight.report, { phase: args?.phase });
    }
    brainSyncPreflight = mcpPresence.revalidateConsumedSyncPreflight(brainSyncPreflight, preflightInput);
    if (!brainSyncPreflight.ok) {
      return noMutationBrainSyncResult(brainSyncPreflight.report, { phase: args?.phase });
    }
  }
  if (name !== 'brain_sync' && !mcpPresence.verifyCurrentProjectBinding()) {
    return projectChangedToolResult();
  }
  // brain_sync owns a target-aware identity transaction inside sync(). Running
  // the generic gate here would mutate the currently bound project A before an
  // explicit A -> B call has proven that B is safely adoptable.
  const identity = name === 'brain_sync'
    ? mcpPresence.resolveRequestIdentity(extra, { toolName: name, toolInput: args })
    : mcpPresence.adoptRequestIdentity(extra, {
      toolName: name,
      toolInput: args,
      verifyBinding: mcpPresence.verifyCurrentProjectBinding,
    });
  if (!identity.ok) {
    return {
      content: [{ type: 'text', text: identity.diagnostic }],
      structuredContent: {
        schemaVersion: 1,
        status: identity.status,
        delivery: 'deferred',
        identityMutation: 'deferred',
      },
      isError: true,
    };
  }
  if (name !== 'brain_sync' && !mcpPresence.verifyCurrentProjectBinding()) {
    return projectChangedToolResult();
  }
  const result = await handler(args, {
    ...extra,
    klypixRequestIdentity: identity,
    klypixClientName: identity.clientInfo?.surface || '',
    ...(brainSyncPreflight ? { klypixBrainSyncPreflight: brainSyncPreflight } : {}),
  });
  // brain_sync performs its own single presence/message transition. Decorating
  // it again would acknowledge in the same call a note it had only just offered.
  if (name === 'brain_sync') return result;
  if (result?.isError !== true) {
    // Managed brain writes use atomic replacement, legitimately changing the
    // brain inode captured at sync. Refresh only from the unchanged canonical
    // project root; a lexical junction retarget can never be adopted here.
    const refreshedBinding = mcpPresence.refreshCurrentProjectBinding();
    if (!refreshedBinding.ok) {
      return partialMutationBrainSyncResult({
        structured: {
          schemaVersion: 1,
          status: 'project-changed',
          mutation: 'handler-complete',
          identityMutation: identity.status === 'current' ? 'none' : identity.status,
          deliveryMutation: 'none',
        },
        text: 'KLYPIX project routing changed while the tool was running. The handler result is withheld and message delivery was not advanced; call brain_sync again.',
      });
    }
  }
  // Recheck even for failed handlers: decoration is itself a presence/delivery
  // transition and may never run against a binding that changed in the handler.
  if (!mcpPresence.verifyCurrentProjectBinding()) {
    return partialMutationBrainSyncResult({
      structured: {
        schemaVersion: 1,
        status: 'project-changed',
        mutation: result?.isError === true ? 'handler-attempted' : 'handler-complete',
        identityMutation: identity.status === 'current' ? 'none' : identity.status,
        deliveryMutation: 'none',
      },
      text: 'KLYPIX project routing changed while the tool was running. The handler result is withheld and message delivery was not advanced; call brain_sync again.',
    });
  }
  return mcpPresence.decorateToolResult(result, {
    actionId: identity.actionId,
    verifyBinding: mcpPresence.verifyCurrentProjectBinding,
    clientInfoPrepared: identity.clientInfo,
  });
});

const toContent = (r) => {
  const content = r.blocks.map(b => b.kind === 'image'
    ? { type: 'image', data: b.data, mimeType: b.mime }
    : { type: 'text', text: b.text });
  const result = r.isError ? { content, isError: true } : { content };
  if (r.structured && typeof r.structured === 'object') result.structuredContent = r.structured;
  return result;
};

server.registerTool('list_canvases', {
  title: 'List KLYPIX canvases',
  description: 'List all .klypix / .any canvas files in the vault, with card and connection counts.',
  inputSchema: {},
}, async () => toContent(await opListCanvases({ vault: mcpPresence.vault })));

server.registerTool('read_canvas', {
  title: 'Read a KLYPIX canvas',
  description: 'Read a canvas as structured markdown (every card, the connection graph, [[wikilinks]], #tags) AND attach its image assets so you can SEE them, not just their filenames (capped: the first 8 images under ~5MB each — a bigger canvas returns the rest as filenames only). Pass the canvas TITLE directly (e.g. "SS2") — a filename, vault-relative path, or absolute path also work; you do NOT need to list or search first.',
  inputSchema: { canvas: z.string().describe('Canvas title or filename (e.g. "SS2"), vault-relative path, or absolute path.') },
}, async ({ canvas }) => toContent(await opReadCanvas({ vault: mcpPresence.vault, canvas })));

server.registerTool('search_canvases', {
  title: 'Search inside all canvases',
  description: 'Search card text, titles, and #tags across every canvas in the vault. Returns the canvases and the matching cards.',
  inputSchema: { query: z.string().describe('Text or #tag to find inside canvases.') },
}, async ({ query }) => toContent(await opSearchCanvases({ vault: mcpPresence.vault, query })));

server.registerTool('search_all_brains', {
  title: 'Search every project brain on this machine',
  description: 'Cross-project memory search: looks through every brain.klypix this machine has REGISTERED, not just the current vault. Ranking is lexical, blended with on-device semantic similarity ONLY when the optional local model is installed (a fresh `npx klypix-mcp install` is lexical) — it degrades cleanly, never errors. Use when the answer may live in ANOTHER project\'s decisions. Optional as_of (YYYY-MM-DD) answers "what was true then" — superseded cards count as live if they were current at that date. The registry is populated by Claude lifecycle and by brain_sync on any MCP host; a project that has never started through either path is absent from cross-project search.',
  inputSchema: {
    query: z.string().describe('What to find across all project brains.'),
    as_of: z.string().optional().describe('Optional YYYY-MM-DD: rank what was TRUE at that date (time-travel query).'),
  },
}, async ({ query, as_of }) => toContent(await opSearchAllBrains({ vault: mcpPresence.vault, query, as_of, log })));

server.registerTool('brain_ask', {
  title: 'Ask the project brain a question (whole-brain, correction-aware answer)',
  description: 'Answer a natural-language question from the WHOLE project brain — "what did we decide about X?", "where did the auth work land?", "why did we drop Y?". Ranks every card lexically, blended with on-device semantic similarity ONLY when the optional local model is installed (a fresh install is lexical; it degrades cleanly). INCLUDES superseded/archived history (flagged, so you can see how a decision changed), and attaches each stale card\'s live CORRECTION so the answer reflects the current truth, not an outdated card. Returns a synthesis-ready context (full cards + provenance + lifecycle) for you to turn into a direct, cited answer — it does not itself write prose. Prefer this over search_canvases when the user asks a QUESTION (not a keyword lookup). Optional as_of (YYYY-MM-DD) answers "what was true then". Defaults to the project brain ("brain").',
  inputSchema: {
    question: z.string().describe('The natural-language question to answer from the brain.'),
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
    as_of: z.string().optional().describe('Optional YYYY-MM-DD: answer as of that date (superseded cards count as live if they were current then).'),
    k: z.number().optional().describe('Max cards to surface for synthesis (default 10, capped 20).'),
  },
}, async ({ question, canvas, as_of, k }) => toContent(await opBrainAsk({ vault: mcpPresence.vault, canvas: boundBrainCanvas(canvas), question, as_of, k, log })));

server.registerTool('project_map_context', {
  title: 'Project Map context - current code structure plus brain decisions',
  description: 'Read-only combined context for a coding question. It queries a provider-neutral, bounded view of the generated project graph (Graphify graphify-out/graph.json is supported first) and places that CURRENT CODE evidence beside fast, correction-aware KLYPIX brain cards (decisions and rationale). KLYPIX never installs or runs Graphify and never copies graph nodes into brain.klypix. Missing graph artifacts degrade cleanly to brain-only context. Source-file anchors are accepted only when they stay inside the declared project root. Set deep_history:true only when superseded history is genuinely needed; the default never loads the local embedding model.',
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    question: z.string().min(1).describe('Question or code concept to ground in both current structure and project memory.'),
    project: z.string().optional().describe('Absolute project root. Defaults to this MCP connection\'s configured project/vault.'),
    graph_path: z.string().optional().describe('Optional project-relative graph JSON path. Defaults to graphify-out/graph.json and may not escape the project root.'),
    compare_to: z.string().optional().describe('Optional project-relative prior graph JSON path. Adds exact total deltas plus bounded query-neighborhood changes; it may not escape the project root.'),
    depth: z.number().optional().describe('Relationship hops around the best code matches (0-3, default 1).'),
    max_nodes: z.number().optional().describe('Maximum code nodes returned (default 60, capped 200).'),
    k: z.number().optional().describe('Maximum brain cards returned (default 8; fast mode caps 8, deep history caps 20).'),
    deep_history: z.boolean().optional().describe('false (default) uses the sub-second lexical-fast correction-aware path; true opts into whole-brain semantic/history retrieval, which may cold-load the local model.'),
  },
}, async ({ question, project, graph_path, compare_to, depth, max_nodes, k, deep_history }) => {
  // One root for BOTH the graph and the brain: mixing repo-X code evidence with
  // repo-Y decisions under a combined banner is silently misleading. When the
  // caller explicitly targets another project, that project's OWN brain answers
  // (pinned via `canvas`, which beats the KLYPIX_BRAIN env override) — and when
  // it has no brain, the output says so instead of borrowing the session brain.
  const explicitProject = typeof project === 'string' && project.trim() ? path.resolve(project.trim()) : null;
  const sessionRoot = path.resolve(mcpPresence.vault);
  const foreignProject = explicitProject && path.relative(sessionRoot, explicitProject) !== '';
  const contextRoot = explicitProject || sessionRoot;
  let brainCanvas = boundBrainCanvas();
  if (foreignProject) {
    const candidate = ['brain.klypix', 'brain.any']
      .map(name => path.join(explicitProject, name))
      .find(file => fs.existsSync(file));
    brainCanvas = candidate || null;
  }
  let graphResult;
  let graphMarkdown;
  try {
    graphResult = queryProjectGraph({
      project: contextRoot,
      graphPath: graph_path,
      query: question,
      depth,
      maxNodes: max_nodes,
    });
    if (compare_to) {
      const previousGraphResult = queryProjectGraph({
        project: contextRoot,
        graphPath: compare_to,
        query: question,
        depth,
        maxNodes: max_nodes,
      });
      graphResult.change = compareProjectGraphResults(graphResult, previousGraphResult);
    }
    graphMarkdown = projectGraphContextMarkdown(graphResult);
  } catch (error) {
    graphResult = { schemaVersion: 2, status: 'invalid', error: error?.message || String(error) };
    graphMarkdown = `# Project Map\n\nThe generated graph could not be read safely: ${graphResult.error}`;
  }
  const graphFiles = Array.isArray(graphResult?.nodes)
    ? [...new Set(graphResult.nodes.map(node => node.sourceFile).filter(Boolean))].slice(0, 20)
    : [];
  const brainResult = foreignProject && brainCanvas === null
    ? {
      blocks: [{ kind: 'text', text: `No brain.klypix was found in ${contextRoot} — code evidence only. The session brain was deliberately NOT substituted, so decisions from another project can never masquerade as this one's.` }],
      context: { mode: 'lexical-fast', hits: [], sufficient: false },
    }
    : deep_history
      ? await opBrainAsk({
        vault: contextRoot,
        canvas: brainCanvas,
        question,
        k: Math.max(1, Math.min(20, Number(k) || 8)),
        log,
      })
      : await opBrainTaskContext({
        vault: contextRoot,
        canvas: brainCanvas,
        intent: question,
      files: graphFiles,
      k: Math.max(1, Math.min(8, Number(k) || 8)),
      budgetChars: 4_500,
    });
  const brainMarkdown = brainResult.blocks
    .filter(block => block.kind === 'text')
    .map(block => block.text)
    .join('\n\n');
  const evidenceLinkProposals = suggestProjectGraphBrainLinks(graphResult, brainResult.context);
  const proposalMarkdown = evidenceLinkProposals.length
    ? `\n\n## Exact-path evidence link proposals\n\n${evidenceLinkProposals.slice(0, 12).map(proposal => `- Review brain card \`${proposal.brainCardId}\` beside **${proposal.nodeLabel}** in \`${proposal.sourceFile}\`.`).join('\n')}\n\n_These are review proposals based only on an exact source-path mention. Nothing was written to the brain._`
    : '';
  return toContent({
    blocks: [{ kind: 'text', text: `${graphMarkdown}\n\n---\n\n# Project Brain - ${deep_history ? 'decisions and history' : 'current decisions and corrections'}\n\n${brainMarkdown}${proposalMarkdown}` }],
    isError: brainResult.isError,
    structured: { projectGraph: graphResult, brainContext: brainResult.context || null, evidenceLinkProposals, deepHistory: deep_history === true },
  });
});

server.registerTool('project_map_scan', {
  title: 'Scan the project natively - no-install file inventory + import map',
  description: 'KLYPIX\'s own zero-install scanner: walks the repo (gitignore-aware, junk dirs like browser profiles and build output excluded), extracts FILE-LEVEL import edges for the JS/TS family (relative, tsconfig-alias, and monorepo-workspace imports resolved), and writes klypix-map/graph.json inside the project — the only thing it ever writes. The artifact then serves project_map_context automatically when no Graphify artifact exists. It deliberately does not build a per-symbol AST graph; deeper external artifacts remain importable through the same door.',
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    project: z.string().optional().describe('Absolute project root. Defaults to this MCP connection\'s configured project/vault.'),
  },
}, async ({ project }) => {
  const root = typeof project === 'string' && project.trim() ? path.resolve(project.trim()) : path.resolve(mcpPresence.vault);
  const result = scanNativeProjectMap({ project: root });
  return toContent({
    blocks: [{ kind: 'text', text: `Native project map written to \`${result.artifactRelative}\` (${result.viaGit ? 'gitignore-aware' : 'walk fallback'}${result.truncated ? '; TRUNCATED at the file cap' : ''}).\nFiles: ${result.counts.files.toLocaleString()}; parsed code files: ${result.counts.parsedCodeFiles.toLocaleString()}; import edges: ${result.counts.importEdges.toLocaleString()}; workspace packages: ${result.counts.workspacePackages}; minified skipped: ${result.counts.skippedMinified}.` }],
    structured: result,
  });
});

server.registerTool('project_map_drift', {
  title: 'Check brain cards against the repo\'s real files (drift report)',
  description: 'Read-only drift check: every brain card that references THIS project\'s files is verified against the working tree. Reports cards whose referenced files are gone or moved (with rename candidates by unique basename), and headlines the checkout\'s own position against its origin default branch — reporting BOTH ahead and behind, so a DIVERGED checkout is named as diverged rather than merely behind. In either state a "missing" file may simply not be in this checkout. Slash-joined name enumerations and other-project paths are recognized and skipped, not reported as drift. Nothing is written; fix cards with a CORRECTION marker or by editing them in KLYPIX.',
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    project: z.string().optional().describe('Absolute project root. Defaults to this MCP connection\'s configured project/vault.'),
    brain: z.string().optional().describe('Optional brain filename/path inside the project. Defaults to brain.klypix / brain.any.'),
  },
}, async ({ project, brain }) => {
  const root = typeof project === 'string' && project.trim() ? path.resolve(project.trim()) : path.resolve(mcpPresence.vault);
  const result = await checkBrainDrift({ project: root, brain });
  return toContent({
    blocks: [{ kind: 'text', text: brainDriftMarkdown(result) }],
    structured: result,
  });
});

server.registerTool('brain_challenge', {
  title: 'Challenge a decision against the brain (argue back with receipts)',
  description: 'BEFORE committing to a significant decision, ask the brain to ARGUE BACK: prior decisions that deterministically contradict the claim (correction-cue / opposite-polarity evidence — never mere topical similarity), 🛠 standing rules that dispute it, approaches tried before and REVERSED (with the correction/successor as the receipt), and open questions it collides with. Candidates, not verdicts — silence means "no deterministic contradiction signal", not verified consistency. Cards captured by a DIFFERENT agent are flagged so you coordinate instead of overriding. Dismiss a confirmed-false pair (after capturing the claim) with brain_connect pairs + relationship:"not_contradiction". Defaults to the project brain ("brain").',
  inputSchema: {
    claim: z.string().describe('The proposed decision/claim to argue against — one concise statement.'),
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
    k: z.number().optional().describe('Max contradiction candidates to surface (default 8, capped 20).'),
  },
}, async ({ claim, canvas, k }, extra) => {
  return toContent(await opBrainChallenge({ vault: mcpPresence.vault, canvas: boundBrainCanvas(canvas), claim, k, via: extra.klypixClientName, log }));
});

server.registerTool('brain_insights', {
  title: 'What matters in a brain — hubs, orphans, stale questions',
  description: 'Structural read of a brain.klypix: the most-connected "hub" cards (load-bearing decisions), orphaned decisions (no connections — maybe forgotten), stale open questions (aging & unresolved), and area sizes. Use to answer "what matters here / what am I forgetting / what should I review?" — read it at the start of a planning session, or before tidying.',
  inputSchema: {
    canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
    staleDays: z.number().optional().describe('Open questions older than this many days count as stale (default 21).'),
    view: z.enum(['full', 'areas', 'status']).optional().describe('"areas" = a cheap category map (what sections exist + live counts) to orient BEFORE retrieving. "status" = where each active area stands (newest milestone + open count). "full" (default) = hubs, orphans, stale questions and areas.'),
  },
}, async ({ canvas, staleDays, view }) => toContent(await opBrainInsights({ vault: mcpPresence.vault, canvas: boundBrainCanvas(canvas), staleDays, view })));

server.registerTool('brain_lens', {
  title: 'Brain lens — machine-readable views of a brain (freshness · provenance · activity · timeline · orrery · unresolved)',
  description: 'The data twin of the desktop app\'s Brain Lenses: ONE structured payload any surface (agent, web viewer, iOS) can render. Views: freshness (age buckets + stale open ❓), provenance (who wrote the brain, by channel: you/claude/cursor/git/gardener/…), activity (last 7 days), timeline (birth-order events — the Replay spine; events included only for view:"timeline"), orrery (focus+context neighborhood of one card: 1/2/3-hop ring-capped nodes + typed edges — pass root as a card title prefix or id, defaults to the most-connected hub), unresolved (open-❓ triage, oldest first, with typed evidence). Read-only by construction — it never writes. Use it to answer "what\'s rotting / who wrote this / what happened this week / what\'s around X / what\'s undecided" with receipts, or to feed a UI.',
  inputSchema: {
    canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
    view: z.enum(['all', 'freshness', 'provenance', 'activity', 'timeline', 'orrery', 'unresolved']).optional().describe('Which lens to compute (default "all" — every section, timeline events omitted from structured output unless view is "timeline").'),
    root: z.string().optional().describe('Orrery center: a card title prefix or id. Default: the most-connected hub card.'),
    staleDays: z.number().optional().describe('Open questions older than this count as stale (default 21).'),
    limit: z.number().optional().describe('Cap for recent-activity entries (default 30).'),
    structured: z.boolean().optional().describe('Also return the full machine-readable lens object (large — tens of KB). Default false: the markdown answers the question, and the object was previously attached to every call whether or not anything read it.'),
  },
}, async ({ canvas, view, root, staleDays, limit, structured }) => toContent(await opBrainLens({ vault: mcpPresence.vault, canvas: boundBrainCanvas(canvas), view, root, staleDays, limit, structured })));

server.registerTool('brain_connect', {
  title: 'Connect related-but-unlinked brain cards (densify the graph)',
  description: 'Repairs orphaned decision/milestone cards first (scope:"orphans", the default) by proposing genuinely related unlinked pairs — semantic similarity at a conservative 0.55 threshold when the on-device model is installed, else shared tags + [[mentions]]. The dry run includes a before→projected orphan receipt; apply:true draws only additive, removable arrows and reports the measured after count. It NEVER archives or rewrites cards. Use scope:"all" for deliberate whole-graph densification. To DISMISS a brain_reconcile false-positive contradiction, pass pairs:[{fromId,toId}] with relationship:"not_contradiction".',
  inputSchema: {
    canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
    apply: z.boolean().optional().describe('false (default) = suggest only; true = draw the connections.'),
    max: z.number().optional().describe('Max connections to propose/draw (default 24).'),
    threshold: z.number().optional().describe('Min semantic similarity 0–1. Default 0.55 for orphan repair; 0.45 for scope:"all". Higher = fewer, tighter links.'),
    scope: z.enum(['orphans', 'all']).optional().describe('"orphans" (default) repairs isolated decision/milestone cards; "all" proposes across every live card.'),
    pairs: z.array(z.object({ fromId: z.string(), toId: z.string() })).optional().describe('Explicit card-id pairs to connect (bypasses auto-proposal). Use to dismiss a reconcile false-positive: pass the two card ids with relationship:"not_contradiction".'),
    relationship: z.string().optional().describe('Relationship for explicit `pairs` (e.g. "not_contradiction" to permanently dismiss a contradiction candidate, or "relates_to", "depends_on", "supports").'),
  },
}, async ({ canvas, apply, max, threshold, scope, pairs, relationship }) => toContent(await opBrainConnect({ vault: mcpPresence.vault, canvas: boundBrainCanvas(canvas), apply, max, threshold, scope, pairs, relationship, log })));

server.registerTool('brain_reconcile', {
  title: 'Reconcile the brain — contradictions between cards + unrecorded migrations',
  description: 'Truth maintenance. (1) CONTRADICTIONS: finds same-subject live card pairs where one carries an explicit correction cue (uppercase "CORRECTION", "was WRONG", "OBSOLETE" — that side is the presumed truth, UNLESS the cue predates its counterpart: then the pair is marked "presumed superseded" and the newer card is presumed current — verify before retiring) or the two use opposite polarity words (deferred↔wired, broken↔fixed, dead↔live), i.e. stale facts whose correction never got linked — candidates only, YOU confirm each: retire the stale card via brain_note ✓. Dismiss a FALSE positive (either kind) by connecting the two ids with brain_connect pairs + relationship:"not_contradiction" — persisted, so it never resurfaces (and its cue stops overlaying recall/ask for that pair). (2) MIGRATIONS: lists committed migration files (Supabase / Rails / Prisma / Knex / generic) that NO brain card references, so an applied-but-unnarrated rollout can be recorded. (3) LEGACY: pre-v1.15 raw-bash ship cards to tidy. Reads ONLY the filesystem — never the database, never the network — and changes nothing. Run it periodically, or when recall surfaces something you believe is stale.',
  inputSchema: {
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
    root: z.string().optional().describe("Project root holding the migrations dir (default: the brain file's folder)."),
    mode: z.enum(['all', 'contradictions', 'migrations', 'legacy', 'claims', 'plans']).optional().describe('Which pass to run (default "all"): contradictions · migrations · legacy (pre-v1.15 raw-bash ship cards to tidy) · claims (open "remaining:/next:" clauses a later milestone likely fulfilled — receipts + ✓ markers, never auto-archived) · plans (plan / proposal / "design decided" cards a LATER 🏁 appears to have built — embedding-first because the ship is usually renamed; receipts + ✓ markers, never auto-archived).'),
  },
}, async ({ canvas, root, mode }) => toContent(await opBrainReconcile({ vault: mcpPresence.vault, canvas: boundBrainCanvas(canvas), root, mode, log })));

server.registerTool('brain_garden', {
  title: 'Garden the brain — consolidate over-grown areas (sleep-time compute)',
  description: 'Tidy an over-grown brain WITHOUT losing anything — SMART and non-invasive: it only consolidates DORMANT cards (old + peripheral), never load-bearing ones. Two phases: call it with no apply to get the areas that have accumulated forgotten cards (deterministic: >3 cards that are older than 14 days, beyond the area\'s newest 8, AND have ≤1 connection — so hubs and still-referenced decisions are left untouched; Focus/Instructions/Archive/Open-questions areas protected) plus their card text; YOU write one tight synthesis per area; then call again with apply:true, syntheses:[{title, synthesis}] AND the human\'s 8-char `approve` code (apply is REFUSED without it — you are never shown the code; the human generates it with `npx klypix-mcp garden-code` after reviewing your plan). Each area gets a 🌿 synthesis card, the originals are stamped "⤵ consolidated", moved to Archive, and arrowed to the synthesis — nothing is deleted, and one undo un-gardens. Run it when brain_insights or the brief shows an area has grown noisy.',
  inputSchema: {
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
    apply: z.boolean().optional().describe('false (default) = list over-grown areas + cards to synthesize; true = consolidate using the supplied syntheses.'),
    syntheses: z.array(z.object({
      title: z.string().describe('Area title EXACTLY as returned by the dry run.'),
      synthesis: z.string().describe('3-6 sentence prose synthesis preserving every still-relevant fact/decision/number.'),
    })).optional().describe('Required when apply:true — one entry per area you want consolidated.'),
    approve: z.string().optional().describe('Required when apply:true — the 8-char human-approval code. You are never shown it: the human runs `npx klypix-mcp garden-code` and pastes the code into chat after reviewing your plan. Never guess or fabricate it.'),
  },
}, async ({ canvas, apply, syntheses, approve }) => toContent(await opBrainGarden({ vault: mcpPresence.vault, canvas: boundBrainCanvas(canvas), apply, syntheses, approve })));

server.registerTool('create_canvas', {
  title: 'Create a KLYPIX canvas',
  description: 'Create a new .klypix canvas from cards + connections and save it to the vault. The user opens it in the KLYPIX app (Canvas → Open). Prefer short, titled cards (one idea each) connected by meaningful arrows.',
  inputSchema: {
    title: z.string().describe('Canvas title (also the filename).'),
    cards: z.array(cardSchema).min(1).describe('The cards. 5-12 atomic cards is ideal.'),
    connections: z.array(connSchema).optional().describe('Arrows between cards.'),
    filename: z.string().optional().describe('Override the output filename (without extension).'),
  },
}, async ({ title, cards, connections, filename }) => toContent(await opCreateCanvas({ vault: mcpPresence.vault, title, cards, connections, filename })));

server.registerTool('add_to_canvas', {
  title: 'Add cards to an existing canvas',
  description: 'Append cards (and optional connections) to an existing v4 .klypix, preserving all existing items and their positions. New cards are placed to the right of the current content. Connections may reference new cards (by index/title) or existing cards (by title).',
  inputSchema: {
    canvas: z.string().describe('Canvas filename, vault-relative path, or absolute path.'),
    cards: z.array(cardSchema).min(1).describe('Cards to add.'),
    connections: z.array(connSchema).optional(),
  },
}, async ({ canvas, cards, connections }, extra) => {
  // Provenance: stamp WHICH agent wrote these cards (from the MCP client's
  // initialize handshake — cursor / claude / cline).
  return toContent(await opAddToCanvas({ vault: mcpPresence.vault, canvas, cards, connections, via: extra.klypixClientName }));
});

server.registerTool('brain_note', {
  title: 'Write a deliberate note to the project brain (decision / question / milestone / skill / resolve / update)',
  description: 'Record something in the project brain ON DEMAND — the agent-neutral twin of the Claude-Code capture hook, so any client (Cursor / Cline / Desktop) can write the brain, not just read it. Unlike add_to_canvas (a flat append), this routes through the brain\'s capture engine, so a new decision SUPERSEDES a heavily-overlapping older one, ✓ RESOLVES/archives a matching card, closes: resolves the strategy/question a milestone fulfils, and ~ UPDATES a card in place — the full decision lifecycle, with dedup. Use marker "+" to record a 🛠️ SKILL — a reusable how-to/gotcha/convention ("always dedup zKeys before REORDER") that should resurface every session and never age out, distinct from a one-time decision. Use it to remember a decision, ask an open question, mark a milestone, log a skill, resolve a finished item, or correct a card. Defaults to the project brain ("brain").',
  inputSchema: {
    text: z.string().describe('The note — one concise idea; the first line becomes the card title.'),
    marker: z.enum(['', '?', '!', '+', '✓', '~']).optional().describe('(none)=decision · ?=open question · !=milestone · +=🛠️ skill (reusable how-to/gotcha; always resurfaces, never ages out) · ✓=resolve+archive the best-matching card · ~=update the matching card in place. Default: decision.'),
    area: z.string().optional().describe('Area/topic — routes the card into that titled container and becomes a #tag (e.g. "Auth", "Release").'),
    closes: z.string().optional().describe('Title or [[wikilink]] of a strategy/question card this note fulfils — resolves+archives it and draws a "closed by" arrow.'),
    guard: z.object({
      when: z.object({
        tool: z.string().max(200).optional().describe('Regex matched against the tool name (e.g. "Bash", "Edit|Write").'),
        command: z.string().max(200).optional().describe('Regex matched against the command string, for shell tools (e.g. "\\\\bgit\\\\s+stash\\\\b"). Anchor deliberately — an unanchored pattern also matches the words inside echo/commit-message text.'),
        paths: z.array(z.string().max(200)).max(20).optional().describe('Path PREFIXES (forward-slash, project-relative) — the guard fires when the session\'s touched files match one. Prefixes, not regexes.'),
        multiWorktree: z.literal(true).optional().describe('Fire only when the repo has more than one git worktree (probed live when the guard is in play).'),
      }).optional().describe('When to interrupt — triggers are AND-ed; at least one required.'),
      severity: z.enum(['warn', 'block']).optional().describe("warn (default) injects the message as context and the call proceeds; block DENIES the tool call with the message. 'block' is for irreversible actions and HUMAN-DIRECTED authoring only — never author block without explicit user instruction."),
      message: z.string().max(500).optional().describe('What the interrupted session reads — say the trap and the safe alternative. Required unless remove:true.'),
      remove: z.literal(true).optional().describe("Disarm: pass exactly { remove: true } with marker '~' matching the card to delete its machine trigger while keeping the prose rule."),
    }).optional().describe("GUARD CARDS: make this '+' skill fire BEFORE a matching tool call runs (Claude Code PreToolUse denies on severity block; other hosts warn), not just resurface in briefs. The card stays a normal 🛠️ rule — ✓-resolving it retires the guard, ~ with {remove:true} disarms it."),
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
  },
}, async ({ text, marker, area, closes, guard, canvas }, extra) => {
  // Both 1.77 and 1.78 ride this call: the enrichment question (the asker's
  // vocabulary for retrieval) AND the per-session capture receipt below.
  const result = await opBrainNote({ vault: mcpPresence.vault, canvas: boundBrainCanvas(canvas), text, area, marker: marker || '', closes, guard, via: extra.klypixClientName, enrichmentQuestion: mcpPresence.declaredIntent });
  // Per-session capture receipt — this is what stops the uncaptured-work nudge
  // from firing at a session that DID record its reasoning, just through MCP
  // rather than a 🧠 marker. The Stop hook and this server share one session-id
  // space (the same presence lane), so the receipt written here is the one the
  // hook reads. Best-effort: a receipt failure must never fail the note.
  try {
    const { recordSessionCapture } = await import('../src/capture-gap.mjs');
    recordSessionCapture(extra?.klypixRequestIdentity?.sessionId || mcpPresence.id);
  } catch { /* receipt is best-effort */ }
  return toContent(result);
});

server.registerTool('brain_message', {
  title: 'Message the other live agent sessions on this project (one-time note, not a brain card)',
  description: 'Leave a DELIBERATE, targeted note for the OTHER active agent sessions working on this project right now ("merged the hook refactor — rebase before you commit", "don\'t touch canvasStore, mid-refactor"). Any MCP client can send and receive through the shared machine-local presence lane. A supported lifecycle event or KLYPIX tool result offers the note into model-visible context; a later independent supported action acknowledges that offer. Pending/offered notes replay after reconnect, while expiry or capacity loss leaves a failed per-recipient receipt instead of silently disappearing. Acknowledged means a later action followed the offer — it is NOT proof a human read it. A note then retires either by an explicit brain_message_receipt ("acted on it") or by AUTO-CONSUMPTION on a further independent action, with no receipt; your receipt line names which, and auto-consumption evidences activity, not uptake. Delivery remains OS-user-local, machine-local, bounded by a 24h TTL, and unavailable to a peer that never takes a supported action. Ephemeral and NOT persisted to the brain — for a durable decision use brain_note instead.',
  inputSchema: {
    text: z.string().describe('The note to deliver (kept to 400 chars).'),
    to: z.string().optional().describe('Target hint — a peer session id-prefix or branch name; omit or "all" for every live session.'),
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
  },
}, async ({ text, to, canvas }, extra) => {
  mcpPresence.noteSent(text);
  return toContent(await opBrainMessage({
    vault: mcpPresence.vault,
    // Bind the default message lane to the brain this worker actually joined.
    // The worker process can be launched from an IDE/install directory that has
    // a different ancestor brain; falling back to process.cwd() would split the
    // sender presence and its message across two unrelated project lanes.
    canvas: boundBrainCanvas(canvas),
    text,
    to,
    via: extra.klypixClientName,
    from: extra.klypixRequestIdentity.sessionId,
  }));
});

server.registerTool('brain_message_receipt', {
  title: 'Confirm a KLYPIX coordination note was consumed',
  description: 'Explicit durable receipt for a coordination note already offered into model-visible context and acknowledged by a later independent action. Call only after the note has actually been incorporated into the receiving agent\'s work. Requires the exact message id and one-time offer token returned with the offered note; identity, token, state, lock, and write mismatches fail closed and never silently mark consumption.',
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    project: z.string().optional().describe('Absolute project root containing brain.klypix. Defaults to this MCP connection\'s current project.'),
    message_id: z.string().min(1).max(160).describe('Exact coordination message id returned with the offered note.'),
    offer_token: z.string().min(1).max(160).describe('Exact offer token returned with the offered note.'),
  },
}, async ({ project, message_id, offer_token }, extra) => {
  const projectRoot = project ? path.resolve(project) : mcpPresence.vault;
  const brainPath = findProjectBrain(projectRoot);
  const identity = extra?.klypixRequestIdentity;
  if (!brainPath || !identity?.sessionId) {
    const reason = !brainPath ? 'no-project-brain' : 'no-logical-session';
    return {
      content: [{ type: 'text', text: `KLYPIX message receipt was not recorded: ${reason}.` }],
      structuredContent: {
        schemaVersion: 1,
        ok: false,
        changed: false,
        status: 'failed',
        reason,
        messageId: message_id,
        sessionId: identity?.sessionId || null,
      },
      isError: true,
    };
  }
  const verdict = consumeMessageReceipt({
    brainPath,
    sessionId: identity.sessionId,
    messageId: message_id,
    offerToken: offer_token,
    actionId: identity.actionId || '',
  });
  return {
    content: [{
      type: 'text',
      text: verdict.ok
        ? (verdict.changed
          ? `KLYPIX message ${message_id} consumption recorded for session ${identity.sessionId}.`
          : `KLYPIX message ${message_id} was already recorded as consumed for session ${identity.sessionId}.`)
        : `KLYPIX message receipt was not recorded: ${verdict.reason || verdict.status || 'receipt-write-failed'}.`,
    }],
    structuredContent: { schemaVersion: 1, ...verdict },
    ...(!verdict.ok ? { isError: true } : {}),
  };
});

server.registerTool('brain_sync', {
  title: 'KLYPIX Context Gateway — synchronize task, peers, conflicts, and relevant memory',
  description: 'APPROVAL-FREE task gateway over the authorized MCP connection. Call FIRST with a concise intent and expected files, again when scope changes, and with phase:"complete" before the final response. One bounded response returns compact task-relevant brain context, active TASK peers (idle connections hidden), one-time messages, structured exact-file conflicts, and late-arrival overlap alerts. A completion that supplies machine-checkable result manifests is fail-closed: invalid, conflicting, or incomparable evidence returns needs-reconciliation and retains task scope. Works on any MCP host — it needs only the authorized MCP connection, so native lifecycle hooks are optional. LIMITS: conflict matching is EXACT-PATH and both sessions must have declared their files, coordination/result reconciliation is machine-local and OS-user-local (a teammate on another machine is invisible), and file overlap remains ADVISORY.',
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    project: z.string().optional().describe('Nonempty absolute current project root that directly contains brain.klypix or brain.any. Supply it on phase "start" so routing stays correct even when the MCP host launches from its own install directory.'),
    intent: z.string().max(160).optional().describe('One sentence describing the current task. Supply for start/checkpoint; completion clears it.'),
    files: z.array(z.string()).max(20).optional().describe('Project-relative files you expect to touch or have touched. Exact overlaps with peers are flagged.'),
    phase: z.enum(['start', 'checkpoint', 'complete']).optional().describe('start replaces prior task scope; checkpoint merges changed scope; complete clears task intent/files. Default: checkpoint.'),
    include_context: z.boolean().optional().describe('Include fast task-relevant brain cards and offer queued coordination notes in the same response. Defaults true; false also defers note delivery so internal supervisor probes cannot consume model-visible messages.'),
    // Deliberately permissive at the MCP/Zod boundary. The authoritative,
    // versioned fail-closed validator lives in result-reconcile.mjs and must see
    // malformed/unknown nested fields so it can persist the evidence-required
    // marker before rejecting them. A strict transport schema rejected first,
    // allowing a later result-less completion to bypass that state entirely.
    results: z.unknown().optional().describe('On phase complete, 1-8 result manifests for stable claim keys. The in-handler versioned validator rejects malformed, empty, unknown-field, or incomparable evidence and retains task scope.'),
    releaseIntent: z.object({
      version: z.string().max(64).describe('The version this session intends to release (e.g. "1.70.0").'),
      ref: z.string().max(200).describe('The git ref (branch or tag) the release will be cut from.'),
      acknowledge: z.array(z.string().max(40)).max(1024).optional().describe('Commit shas this release DELIBERATELY leaves behind. Only needed after a refusal: if the ref would drop finished work, the lease is refused and the response names every sha. Re-declare with those shas here to proceed — and tell the user what they are first.'),
    }).optional().describe('Declare EXCLUSIVE intent to prepare a release of this project. The first declarer takes a ~2h lease (refreshed by checkpoints, freed by phase "complete", by expiry, or when the holder session ends); a second declarer gets a structured hard conflict naming the holder, version, and ref. While any lease is active every peer\'s sync gains a "release in preparation" footer line. A NEW declaration is also checked against what the release would LEAVE BEHIND: if the ref is missing commits that are on trunk or on a branch a live peer session is working on, OR commits any session STAKED a releaseClaim on (even one that has since ended), the lease is REFUSED (nothing is changed) and the response lists them — report those commits to the user, then re-declare with acknowledge:[...] naming each sha if the release should go ahead without them. Acknowledging away a claimed or live-owned commit queues its owner a notification automatically.'),
    releaseClaim: z.object({
      shas: z.array(z.string().max(40)).max(20).optional().describe('Commit shas that MUST ride the next release. Stake after committing work a user was promised — the claim OUTLIVES this session (14d), and every future releaseIntent must contain these commits or acknowledge them by name.'),
      note: z.string().max(160).optional().describe('One line of why — shown verbatim in any refusal that names this claim ("founder was told the Arrow tool ships in the next build").'),
      withdraw: z.union([z.array(z.string().max(40)).max(20), z.boolean()]).optional().describe('Shas to withdraw from this session\'s claim; [] or true withdraws the whole claim. Only the staking session (or its logical continuation) can withdraw.'),
      publish: z.boolean().optional().describe('Also write the claim as .klypix/claims/<owner>.json in the project (or delete that file when withdrawing). Commit it and the promise TRAVELS WITH THE REPO: every clone\'s release gate reads it, it is reviewable in PRs, and its history is auditable — team-wide claims over plain git, zero infrastructure.'),
    }).optional().describe('Stake a durable claim that specific commits ride the NEXT release — the promise "you\'ll see it in the next build" made machine-readable. Unlike presence rows (which age out ~10min after a session ends), a claim persists until fulfilled (the release ref contains the shas — auto-retired with a courtesy note), withdrawn, or expired (14d). A release that would drop claimed shas is REFUSED until they are acknowledged BY NAME, and acknowledging them away notifies the owner. Use exactly one of shas (stake/extend) or withdraw.'),
  },
}, async ({ project, intent, files, phase, include_context, results, releaseIntent, releaseClaim }, extra) => {
  const totalStartedAt = Date.now();
  const report = mcpPresence.sync({
    project,
    intent,
    files,
    phase,
    results,
    releaseIntent,
    releaseClaim,
    deliverMessages: include_context !== false,
    actionId: extra?.klypixRequestIdentity?.actionId || '',
    preflight: extra?.klypixBrainSyncPreflight,
    requestIdentity: extra?.klypixRequestIdentity,
  });
  if (report.isError === true && report.structured?.mutation === 'none') {
    return noMutationBrainSyncResult(report, { phase, totalStartedAt });
  }
  // Zero-manual harness convergence: brain_sync is the one project-aware
  // gateway every MCP host can call. Register MCP-only projects here (Claude's
  // lifecycle hook is no longer the sole registry writer), then reconcile only
  // KLYPIX-managed instructions/config entries before task work begins.
  let harness = null;
  let registration = null;
  if (phase === 'start' && report.structured?.brain) {
    if (!mcpPresence.verifyCurrentProjectBinding()) {
      return partialMutationBrainSyncResult({
        ...report,
        isError: true,
        structured: { ...report.structured, status: 'project-changed', mutation: 'presence-only' },
        text: 'KLYPIX project routing changed after coordination. Harness, ship observation, and context retrieval were stopped; retry brain_sync.',
      }, { phase, totalStartedAt });
    }
    registration = registerProjectBrain({
      brainPath: report.structured.brain,
      brainDir: RUNTIME_BRAIN_DIR,
    });
    if (!mcpPresence.verifyCurrentProjectBinding()) {
      return partialMutationBrainSyncResult({
        ...report,
        isError: true,
        structured: { ...report.structured, status: 'project-changed', mutation: 'presence-and-registration' },
        text: 'KLYPIX project routing changed during project registration. Later sync side effects were stopped; retry brain_sync.',
      }, { phase, totalStartedAt });
    }
    harness = await reconcileRegisteredProjects({
      brainDir: RUNTIME_BRAIN_DIR,
      version: PKG_VERSION,
      brainPaths: [report.structured.brain],
      rules: { auditProject, compactAgentsBrief, linkProject },
    });
    if (!mcpPresence.verifyCurrentProjectBinding()) {
      return partialMutationBrainSyncResult({
        ...report,
        isError: true,
        structured: { ...report.structured, status: 'project-changed', mutation: 'presence-registration-harness' },
        text: 'KLYPIX project routing changed during harness reconciliation. Ship observation and context retrieval were stopped; retry brain_sync.',
      }, { phase, totalStartedAt });
    }
  }
  // Class-C ship observation, host-neutral: brain_sync is the ONE surface every
  // MCP host calls at task start, so an MCP-only project (no Claude/Codex hook)
  // still notices a release nobody narrated. Queued here, drained at the next
  // brain write. Zero network, ~2 cheap git/fs reads, never throws.
  let shipNotice = '';
  if (phase === 'start') {
    try {
      const dir = report.structured?.project || mcpPresence.vault;
      if (typeof brainFormat.observeShipDrift === 'function' && dir) {
        const { execFileSync } = await import('child_process');
        shipNotice = brainFormat.observeShipDrift(dir, {
          gitRun: (args) => execFileSync('git', String(args).split(/\s+/).filter(Boolean), {
            cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
          }),
        }).notice || '';
      }
    } catch { /* observation is best-effort — never fail a sync */ }
  }
  // ── Uncaptured-work check, host-neutral half ────────────────────────────────
  // The Stop hook can REFUSE a stop; every other host has no lifecycle hook at
  // all, so brain_sync is the only place the same question can be asked. Stamp
  // the git HEAD at "start", and at "complete" compare it against HEAD: commits
  // that landed during this task with nothing recorded about WHY is the same gap
  // the hook catches, and it produces the same drafted card. Advisory only — it
  // never changes status/mutation, so completion semantics are untouched.
  let captureGapText = '';
  {
    const projectDir = report.structured?.project || mcpPresence.vault;
    const sid = String(extra?.klypixRequestIdentity?.sessionId || mcpPresence.id || '');
    // `require` does not exist in ESM — the child_process binding has to be
    // imported, and gitOut must stay synchronous for the ancestry/count chain.
    let execFileSync = null;
    try { ({ execFileSync } = await import('child_process')); } catch { /* no child_process → no check */ }
    const gitOut = (args) => {
      if (!execFileSync) return '';
      try {
        return String(execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 })).trim();
      } catch { return ''; }
    };
    // `git merge-base --is-ancestor` answers with its EXIT CODE and prints
    // nothing, so it must be read as ok/not-ok — an output check would treat
    // "not an ancestor" and "success" as the same empty string.
    const gitOk = (args) => {
      if (!execFileSync) return false;
      try {
        execFileSync('git', args, { cwd: projectDir, stdio: 'ignore', timeout: 4000 });
        return true;
      } catch { return false; }
    };
    try {
      const gap = await import('../src/capture-gap.mjs');
      if (phase === 'start' && projectDir && sid) {
        const head = gitOut(['rev-parse', 'HEAD']);
        if (head) gap.recordTaskBaseline(sid, { head, project: projectDir });
      } else if (phase === 'complete' && projectDir && sid) {
        const baseline = gap.readTaskBaseline(sid);
        if (baseline?.head) {
          // An ancestry check first: a rebase/reset makes the range meaningless,
          // and reporting a rewritten history as "commits you didn't record" is
          // exactly the cry-wolf that gets a nudge switched off.
          const reachable = gitOk(['merge-base', '--is-ancestor', baseline.head, 'HEAD']);
          const count = reachable ? Number(gitOut(['rev-list', '--count', '--no-merges', `${baseline.head}..HEAD`]) || 0) : 0;
          if (count > 0) {
            const subjects = gitOut(['log', '--no-merges', '--format=%s', `${baseline.head}..HEAD`])
              .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5);
            // Bodies decide whether ANY rationale was recorded — the same rule
            // the hook uses, so the two halves never disagree about one session.
            const withRationale = gitOut(['log', '--no-merges', '--format=%x1e%b', `${baseline.head}..HEAD`])
              .split('\x1e').map((b) => b.replace(/\s+/g, ' ').trim()).filter((b) => b.length >= 12).length;
            const decision = gap.captureGapDecision({
              commitTotal: count,
              commitCards: withRationale,
              sessionCaptured: gap.sessionHasCaptured(sid),
            });
            if (decision) {
              const changed = gitOut(['diff', '--name-only', `${baseline.head}..HEAD`]).split('\n').filter(Boolean).slice(0, 20);
              const draft = gap.draftCaptureMarker({
                commits: subjects.map((subject) => ({ subject })),
                filesTouched: changed,
              });
              captureGapText = gap.captureGapReason({ ...decision, draft, mode: 'advise' });
              gap.recordCaptureGapNudge(sid);
            }
          }
        }
        gap.clearTaskBaseline(sid);
      }
    } catch { /* the check never fails a sync */ }
  }
  let taskContext = null;
  if (phase !== 'complete' && include_context !== false && (intent || files?.length)) {
    taskContext = await opBrainTaskContext({
      vault: mcpPresence.vault,
      // Exact brain chosen by project preflight. Supplying the absolute canvas
      // prevents klypix-core's cwd-aware fallback from substituting a foreign
      // parent/launch brain after the routing decision has already been made.
      canvas: report.structured?.brain,
      intent,
      files,
      k: 5,
      budgetChars: 2800,
    });
  }
  const contextText = taskContext?.blocks
    ?.filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .filter(Boolean)
    .join('\n\n') || '';
  const totalMs = Math.max(0, Date.now() - totalStartedAt);
  const structuredContent = {
    ...(report.structured || {
      schemaVersion: 1,
      status: 'idle',
      phase: phase || 'checkpoint',
    }),
    context: taskContext?.context || {
      mode: 'not-requested',
      hits: [],
      sufficient: false,
      durationMs: 0,
    },
    timingMs: {
      ...(report.structured?.timingMs || {}),
      context: taskContext?.context?.durationMs || 0,
      total: totalMs,
    },
    ...(registration ? { registration } : {}),
    ...(harness ? { harness } : {}),
  };
  const harnessText = harness?.failed
    ? `KLYPIX harness self-heal needs attention: ${harness.failed} project(s) remain partially aligned; brain_doctor has the exact files.`
    : harness?.updated
      ? `KLYPIX harness self-healed automatically: ${harness.updated} project(s) refreshed; no manual link command is required.`
      : '';
  const timingText = `Context Gateway total: ${totalMs}ms`
    + (taskContext?.context ? ` (memory ${taskContext.context.durationMs}ms)` : '') + '.';
  return {
    content: [{
      type: 'text',
      text: [report.text, harnessText, shipNotice, captureGapText, contextText, timingText].filter(Boolean).join('\n\n'),
    }],
    structuredContent,
    ...(report.isError ? { isError: true } : {}),
  };
});

server.registerTool('brain_doctor', {
  title: 'Brain doctor — is this brain current, wired, and in sync?',
  description: 'Read-only self-check of the installed klypix brain, as ONE verdict: VERSION (deployed brain-core + optional npm currency), CLAUDE (existing 5-hook capture readiness), CODEX (automatic MCP presence plus optional enhanced-hook status), TOOLS (discoverable MCP verbs), SESSIONS (all active presence-adapter sessions across hosts, never recent-chat history), and HARNESS (projection drift). Use to answer "is my brain current, correctly installed, in sync, and who is actually live?" without file-spelunking. Never writes. SCOPE: only CLAUDE and CODEX get behavioural verdicts. HARNESS classifies the projected config/rules FILES on disk — a project can read fully ok while no other host has ever actually loaded them, so do not report a clean HARNESS as "Cursor/Cline/Windsurf/Copilot is working". The MCP-callable twin of `npx klypix-mcp doctor`.',
  inputSchema: {
    project: z.string().optional().describe('Project dir to audit harness + peers for. Defaults to the server\'s working directory.'),
    check_npm: z.boolean().optional().describe('Also fetch npm latest to flag a stale brain (default false — this one does a network `npm view`).'),
  },
}, async ({ project, check_npm }) => {
  try {
    // Lazy import so a flat runtime missing brain-doctor.mjs can't crash server STARTUP —
    // the tool degrades gracefully (errors only when called) instead of taking the server down.
    const { inspect, render } = await import('../src/brain-doctor.mjs');
    let npmLatest = null;
    if (check_npm) {
      try { const { execSync } = await import('child_process'); npmLatest = execSync('npm view klypix-mcp version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim(); }
      catch { npmLatest = '(offline)'; }
    }
    // self = THIS running server (the process answering this very call). Passing it
    // makes the RUNNING check report the caller's actual server version, never a
    // phantom another session's heartbeat wrote to the shared registry.
    const report = inspect({
      projectDir: project ? path.resolve(project) : mcpPresence.vault,
      npmLatest,
      self: { pid: process.pid, version: PKG_VERSION, id: mcpPresence.id },
    });
    return { content: [{ type: 'text', text: render(report, { color: false }) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `brain_doctor unavailable: ${e?.message || e}` }], isError: true };
  }
});

// ── Boot heartbeat (auto-propagation, part E) ────────────────────────────────
// Record the version THIS process actually runs into a per-pid REGISTRY at
// ~/.claude/project-brain/.running-servers.json, so brain_doctor can compare RUNNING
// vs installed(baked) vs npm — catching the "doctor says current, live server is
// stale" incident. A per-pid registry (not a single-value file) is REQUIRED because
// MCP servers are per-session: a shared single file is last-writer-wins, so it could
// report a DIFFERENT session's server version (a phantom). Each server upserts its
// own {pid, version, vault, lastSeenAt} and prunes dead/stale-heartbeat pids;
// doctor-as-tool matches its own pid. Renewable heartbeats prevent Windows PID
// reuse from making an unrelated live process look like a stale MCP server.
// Best-effort, tiny lock so concurrent sessions don't tear the file.
const RUNNING_HEARTBEAT_FRESH_MS = 2 * 60 * 1000;
const RUNNING_LEGACY_GRACE_MS = 5 * 60 * 1000;
function recordRunningServer({ remove = false } = {}) {
  const brainDir = path.join(os.homedir(), '.claude', 'project-brain');
  const REG = path.join(brainDir, '.running-servers.json');
  const LOCK = REG + '.lock';
  const LOCK_STALE_MS = 5000;   // a heartbeat critical section is ms; steal a lock older than this
  // Alive ONLY if we can actually signal it: ESRCH (dead) and EPERM (another user's
  // process — never our MCP server) both prune. This narrows the reused-PID phantom
  // window; the age ceiling below bounds the remaining same-user-reuse case.
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const fresh = (server) => {
    const heartbeat = Date.parse(server?.lastSeenAt);
    if (Number.isFinite(heartbeat)) return (Date.now() - heartbeat) < RUNNING_HEARTBEAT_FRESH_MS;
    const booted = Date.parse(server?.bootedAt);
    return Number.isFinite(booted) && (Date.now() - booted) < RUNNING_LEGACY_GRACE_MS;
  };
  const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* */ } };
  let got = false;
  try {
    fs.mkdirSync(brainDir, { recursive: true });
    for (let i = 0; i < 40 && !got; i++) {
      try { const fd = fs.openSync(LOCK, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); got = true; }
      catch (e) { if (e && e.code !== 'EEXIST') break; try { if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(LOCK); continue; } } catch { /* raced on the stale file — retry */ } sleep(25); }
    }
    // NEVER write the shared registry without the lock — a lock-free read-modify-write
    // is the last-writer-wins/torn-file corruption this per-pid registry exists to
    // avoid. A contended boot simply skips recording itself this once (self-heals on
    // the next uncontended boot; doctor's self-mode never depends on the registry).
    if (got) {
      let data = {}; try { data = JSON.parse(fs.readFileSync(REG, 'utf8')); } catch { /* fresh/corrupt → rebuild */ }
      const existing = Array.isArray(data.servers) ? data.servers : [];
      const mine = existing.find(s => s && s.pid === process.pid);
      const servers = existing
        .filter(s => s && s.pid && s.pid !== process.pid && s.version && isAlive(s.pid) && fresh(s));   // drop mine + dead + stale-heartbeat
      const stamp = new Date().toISOString();
      if (!remove) {
        servers.push({
          pid: process.pid,
          version: PKG_VERSION,
          vault: String(VAULT).replace(/\\/g, '/'),
          server: fileURLToPath(import.meta.url).replace(/\\/g, '/'),
          bootedAt: mine?.bootedAt || stamp,
          lastSeenAt: stamp,
        });
      }
      // Atomic swap (temp + rename) so a concurrent reader never observes a truncated file.
      const tmp = REG + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ servers: servers.slice(-32) }, null, 2));
      fs.renameSync(tmp, REG);
      // The per-pid registry supersedes the old single-file heartbeat — remove any
      // leftover so a dead server's stale .running-version.json can't be trusted later.
      try { fs.unlinkSync(path.join(brainDir, '.running-version.json')); } catch { /* none / raced */ }
    }
  } catch { /* heartbeat is best-effort — never break startup */ }
  finally { if (got) { try { fs.unlinkSync(LOCK); } catch { /* */ } } }
}

// ── canvas_view — the whiteboard-in-chat MCP App (SEP-1865 / ext-apps) ────────
// The ext-apps dep is OPTIONAL BY DESIGN: the flat local-bundle deploy resolves
// deps from a hardcoded queue (bin/klypix-install.mjs), so a missing module must
// cost exactly this one tool's UI, never the server. The whole App registration
// is try/caught (import, HTML load, register) and degrades to a plain text tool.
const CANVAS_VIEW_DESC = 'Read any .klypix canvas/brain as a SPATIAL BOARD (defaults to the project brain): returns a text summary plus a structured render spec of cards, containers and connection arrows. It ALSO declares an MCP Apps (SEP-1865) UI resource, so a host with that extension can render the spec as an interactive read-only whiteboard — EXPERIMENTAL: no host has been observed rendering it, so do not promise the user a visual board. Hosts without the extension get the text summary, which is the verified path. Use when the user asks to SEE the canvas/brain/board layout, not just query it.';
const canvasViewHandler = async ({ canvas }) => {
  const r = await opCanvasView({ vault: mcpPresence.vault, canvas: boundBrainCanvas(canvas) });
  const c = toContent(r);
  return r.structured ? { ...c, structuredContent: r.structured } : c;
};
const CANVAS_VIEW_SCHEMA = { canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").') };
let canvasViewAsApp = false;
try {
  const apps = await import('@modelcontextprotocol/ext-apps/server');
  // The HTML sits next to src/ siblings in the flat bundle deploy, ../src in the repo.
  let html = null;
  for (const u of [new URL('../src/canvas-view-app.html', import.meta.url), new URL('./canvas-view-app.html', import.meta.url)]) {
    try { html = fs.readFileSync(u, 'utf8'); break; } catch { /* next candidate */ }
  }
  if (html && typeof apps.registerAppTool === 'function' && typeof apps.registerAppResource === 'function') {
    const URI = 'ui://klypix/canvas-view.html';
    apps.registerAppResource(server, 'KLYPIX canvas view', URI, { mimeType: apps.RESOURCE_MIME_TYPE },
      async () => ({ contents: [{ uri: URI, mimeType: apps.RESOURCE_MIME_TYPE, text: html }] }));
    apps.registerAppTool(server, 'canvas_view', {
      title: 'View a canvas as a spatial board (whiteboard-in-chat)',
      description: CANVAS_VIEW_DESC,
      inputSchema: CANVAS_VIEW_SCHEMA,
      _meta: { ui: { resourceUri: URI } },
    }, canvasViewHandler);
    canvasViewAsApp = true;
  }
} catch { /* ext-apps absent or drifted — fall through to the plain tool */ }
if (!canvasViewAsApp) {
  server.registerTool('canvas_view', {
    title: 'View a canvas as a spatial board (summary)',
    description: CANVAS_VIEW_DESC,
    inputSchema: CANVAS_VIEW_SCHEMA,
  }, canvasViewHandler);
}

const transport = new StdioServerTransport();
let runningHeartbeat = null;
let autoUpdateStarter = null;
let autoUpdatePoller = null;
let runtimeStopped = false;
const stopRuntimePresence = () => {
  if (runtimeStopped) return;
  runtimeStopped = true;
  if (runningHeartbeat) clearInterval(runningHeartbeat);
  runningHeartbeat = null;
  if (autoUpdateStarter) clearTimeout(autoUpdateStarter);
  if (autoUpdatePoller) clearInterval(autoUpdatePoller);
  autoUpdateStarter = null;
  autoUpdatePoller = null;
  recordRunningServer({ remove: true });
  mcpPresence.stop();
};
// Supervisor watchdog: reaping is otherwise 100% stdin-EOF-dependent, so a
// supervisor that dies without closing pipes pinned this worker (and its RAM)
// forever. KLYPIX_MCP_SUPERVISOR_PID was set at spawn and read nowhere — the
// heartbeat now polls it. EPERM = alive without permission; ESRCH = gone.
const SUPERVISOR_PID = Number(process.env.KLYPIX_MCP_SUPERVISOR_PID || 0) || null;
const supervisorAlive = () => {
  if (!SUPERVISOR_PID) return true;
  try { process.kill(SUPERVISOR_PID, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
};
server.server.oninitialized = () => {
  mcpPresence.start(VAULT);
  recordRunningServer();
  runningHeartbeat = setInterval(() => {
    if (!supervisorAlive()) {
      log('supervisor process is gone — cleaning up presence and exiting');
      stopRuntimePresence();
      process.exit(0);
    }
    recordRunningServer();
  }, 30_000);
  runningHeartbeat.unref?.();
  // The worker mirrors the supervisor's host-neutral scheduler. This lets an
  // older stable supervisor acquire the updater immediately after hot-swapping
  // to a compatible new worker; no extra host reconnect is needed for the
  // scheduler itself. Stamp + lock make the duplicate trigger effectively free.
  const checkForCoreUpdate = () => spawnAutoUpdateHelper({
    brainDir: RUNTIME_BRAIN_DIR,
    currentVersion: PKG_VERSION,
  });
  autoUpdateStarter = setTimeout(checkForCoreUpdate, 2000);
  autoUpdateStarter.unref?.();
  autoUpdatePoller = setInterval(checkForCoreUpdate, 60 * 60 * 1000);
  autoUpdatePoller.unref?.();
  log(`ready · vault=${VAULT} · presence=mcp`);
};
server.server.onclose = stopRuntimePresence;
process.once('exit', stopRuntimePresence);
await server.connect(transport);
// Most sessions use brain_sync/presence and should not pay for a private model
// they never query. Legacy mode restores the old eager lifecycle immediately.
if (shouldPrewarmSemantic()) {
  getEmbedder(log).then(p => log(p ? 'semantic ready (pre-warmed)' : 'semantic unavailable — lexical only')).catch(() => {});
} else {
  log('semantic lazy · bounded memory runtime');
}
