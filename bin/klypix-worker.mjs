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
  resolveVault, getEmbedder, buildKlypixMap, cardSchema, connSchema,
  opListCanvases, opReadCanvas, opSearchCanvases, opSearchAllBrains,
  opBrainInsights, opBrainConnect, opBrainReconcile, opBrainGarden, opCreateCanvas, opAddToCanvas, opBrainNote, opBrainMessage, opBrainAsk, opBrainChallenge, opCanvasView, opBrainLens,
  opBrainTaskContext,
} from '../src/klypix-core.mjs';
import { mcpServerEntry } from '../src/agent-rules.mjs';
import { createMcpPresence, KLYPIX_MCP_INSTRUCTIONS } from '../src/mcp-presence.mjs';
import { spawnAutoUpdateHelper } from '../src/mcp-auto-update.mjs';
// Namespace import (already in-process via the klypix-core chain, so zero added
// load cost) so a bundle whose klypix-format predates classifyDecay degrades
// gracefully — a named import of a missing export would kill the whole server.
import * as brainFormat from '../src/klypix-format.mjs';

// Real package version for the MCP handshake (was hardcoded '1.0.0', which
// misled every client/version diagnosis — it could never reflect the true release).
const PKG_VERSION = (() => { try { return createRequire(import.meta.url)('../package.json').version; } catch { return '0.0.0'; } })();

// IMPORTANT: stdout is the JSON-RPC channel. Never console.log — only stderr.
const log = (...a) => console.error('[klypix-mcp]', ...a);

// `npx klypix-mcp install` — lay the WHOLE brain (hook + engine + local servers)
// into ~/.claude/project-brain and wire the Claude Code hooks. This is the single
// agent-neutral installer, so a brain release reaches every machine via one npm
// publish + this command (the global brain serves every project). Runs before any
// server setup; delegates to the dedicated bin so `npx klypix-install` also works.
if (process.argv[2] === 'install') { await import('./klypix-install.mjs'); process.exit(0); }

// `npx klypix-mcp link` — make THIS project's brain automatic for EVERY agent tool,
// not just Claude Code: drop each tool's native MCP config + rules file (Cursor, Cline,
// Windsurf, Copilot/VS Code, AGENTS.md) so any agent opened here reads + captures the
// brain on its own. Project-scoped (cwd); idempotent. Runs before any server setup.
if (process.argv[2] === 'link') { await import('./klypix-link.mjs'); process.exit(0); }

// `npx klypix-mcp doctor` — the brain's READ-ONLY self-check: is this machine's brain
// current, are the 4 hooks wired, what verbs does it expose, who's live, is the harness
// projection in sync? One verdict, one reconcile block. Exits 1 on drift (CI gate).
if (process.argv[2] === 'doctor') { await import('./klypix-doctor.mjs'); process.exit(0); }

// `npx klypix-mcp conformance` — launch two real, isolated MCP clients against
// this exact installed server and verify task memory, truthful peers, blocking
// overlap detection, proactive logging, and guaranteed next-action delivery.
if (process.argv[2] === 'conformance') { await import('./klypix-conformance.mjs'); process.exit(0); }

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

// Map a protocol-neutral core result → an MCP tool result.
const toContent = (r) => {
  const content = r.blocks.map(b => b.kind === 'image'
    ? { type: 'image', data: b.data, mimeType: b.mime }
    : { type: 'text', text: b.text });
  const result = r.isError ? { content, isError: true } : { content };
  return mcpPresence.decorateToolResult(result);
};

server.registerTool('list_canvases', {
  title: 'List KLYPIX canvases',
  description: 'List all .klypix / .any canvas files in the vault, with card and connection counts.',
  inputSchema: {},
}, async () => toContent(await opListCanvases({ vault: mcpPresence.vault })));

server.registerTool('read_canvas', {
  title: 'Read a KLYPIX canvas',
  description: 'Read a canvas as structured markdown (every card, the connection graph, [[wikilinks]], #tags) AND return its images so you can SEE them, not just their filenames. Pass the canvas TITLE directly (e.g. "SS2") — a filename, vault-relative path, or absolute path also work; you do NOT need to list or search first.',
  inputSchema: { canvas: z.string().describe('Canvas title or filename (e.g. "SS2"), vault-relative path, or absolute path.') },
}, async ({ canvas }) => toContent(await opReadCanvas({ vault: mcpPresence.vault, canvas })));

server.registerTool('search_canvases', {
  title: 'Search inside all canvases',
  description: 'Search card text, titles, and #tags across every canvas in the vault. Returns the canvases and the matching cards.',
  inputSchema: { query: z.string().describe('Text or #tag to find inside canvases.') },
}, async ({ query }) => toContent(await opSearchCanvases({ vault: mcpPresence.vault, query })));

server.registerTool('search_all_brains', {
  title: 'Search every project brain on this machine',
  description: 'Cross-project memory search: looks through every brain.klypix this machine has worked with (auto-registered by the brain hook), not just the current vault. Semantic (on-device) + lexical hybrid ranking. Use when the answer may live in ANOTHER project\'s decisions. Optional as_of (YYYY-MM-DD) answers "what was true then" — superseded cards count as live if they were current at that date.',
  inputSchema: {
    query: z.string().describe('What to find across all project brains.'),
    as_of: z.string().optional().describe('Optional YYYY-MM-DD: rank what was TRUE at that date (time-travel query).'),
  },
}, async ({ query, as_of }) => toContent(await opSearchAllBrains({ vault: mcpPresence.vault, query, as_of, log })));

server.registerTool('brain_ask', {
  title: 'Ask the project brain a question (whole-brain, correction-aware answer)',
  description: 'Answer a natural-language question from the WHOLE project brain — "what did we decide about X?", "where did the auth work land?", "why did we drop Y?". Ranks every card (semantic on-device + lexical hybrid), INCLUDES superseded/archived history (flagged, so you can see how a decision changed), and attaches each stale card\'s live CORRECTION so the answer reflects the current truth, not an outdated card. Returns a synthesis-ready context (full cards + provenance + lifecycle) for you to turn into a direct, cited answer — it does not itself write prose. Prefer this over search_canvases when the user asks a QUESTION (not a keyword lookup). Optional as_of (YYYY-MM-DD) answers "what was true then". Defaults to the project brain ("brain").',
  inputSchema: {
    question: z.string().describe('The natural-language question to answer from the brain.'),
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
    as_of: z.string().optional().describe('Optional YYYY-MM-DD: answer as of that date (superseded cards count as live if they were current then).'),
    k: z.number().optional().describe('Max cards to surface for synthesis (default 10, capped 20).'),
  },
}, async ({ question, canvas, as_of, k }) => toContent(await opBrainAsk({ vault: mcpPresence.vault, canvas, question, as_of, k, log })));

server.registerTool('brain_challenge', {
  title: 'Challenge a decision against the brain (argue back with receipts)',
  description: 'BEFORE committing to a significant decision, ask the brain to ARGUE BACK: prior decisions that deterministically contradict the claim (correction-cue / opposite-polarity evidence — never mere topical similarity), 🛠 standing rules that dispute it, approaches tried before and REVERSED (with the correction/successor as the receipt), and open questions it collides with. Candidates, not verdicts — silence means "no deterministic contradiction signal", not verified consistency. Cards captured by a DIFFERENT agent are flagged so you coordinate instead of overriding. Dismiss a confirmed-false pair (after capturing the claim) with brain_connect pairs + relationship:"not_contradiction". Defaults to the project brain ("brain").',
  inputSchema: {
    claim: z.string().describe('The proposed decision/claim to argue against — one concise statement.'),
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
    k: z.number().optional().describe('Max contradiction candidates to surface (default 8, capped 20).'),
  },
}, async ({ claim, canvas, k }) => {
  let via; try { via = server.server.getClientVersion()?.name; } catch { /* optional */ }
  return toContent(await opBrainChallenge({ vault: mcpPresence.vault, canvas, claim, k, via, log }));
});

server.registerTool('brain_insights', {
  title: 'What matters in a brain — hubs, orphans, stale questions',
  description: 'Structural read of a brain.klypix: the most-connected "hub" cards (load-bearing decisions), orphaned decisions (no connections — maybe forgotten), stale open questions (aging & unresolved), and area sizes. Use to answer "what matters here / what am I forgetting / what should I review?" — read it at the start of a planning session, or before tidying.',
  inputSchema: {
    canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
    staleDays: z.number().optional().describe('Open questions older than this many days count as stale (default 21).'),
  },
}, async ({ canvas, staleDays }) => toContent(await opBrainInsights({ vault: mcpPresence.vault, canvas, staleDays })));

server.registerTool('brain_lens', {
  title: 'Brain lens — machine-readable views of a brain (freshness · provenance · activity · timeline · orrery · unresolved)',
  description: 'The data twin of the desktop app\'s Brain Lenses: ONE structured payload any surface (agent, web viewer, iOS) can render. Views: freshness (age buckets + stale open ❓), provenance (who wrote the brain, by channel: you/claude/cursor/git/gardener/…), activity (last 7 days), timeline (birth-order events — the Replay spine; events included only for view:"timeline"), orrery (focus+context neighborhood of one card: 1/2/3-hop ring-capped nodes + typed edges — pass root as a card title prefix or id, defaults to the most-connected hub), unresolved (open-❓ triage, oldest first, with typed evidence). Read-only by construction — it never writes. Use it to answer "what\'s rotting / who wrote this / what happened this week / what\'s around X / what\'s undecided" with receipts, or to feed a UI.',
  inputSchema: {
    canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
    view: z.enum(['all', 'freshness', 'provenance', 'activity', 'timeline', 'orrery', 'unresolved']).optional().describe('Which lens to compute (default "all" — every section, timeline events omitted from structured output unless view is "timeline").'),
    root: z.string().optional().describe('Orrery center: a card title prefix or id. Default: the most-connected hub card.'),
    staleDays: z.number().optional().describe('Open questions older than this count as stale (default 21).'),
    limit: z.number().optional().describe('Cap for recent-activity entries (default 30).'),
  },
}, async ({ canvas, view, root, staleDays, limit }) => toContent(await opBrainLens({ vault: mcpPresence.vault, canvas, view, root, staleDays, limit })));

server.registerTool('brain_connect', {
  title: 'Connect related-but-unlinked brain cards (densify the graph)',
  description: 'Finds genuinely related cards that AREN\'T linked yet and proposes connections — semantic similarity when the on-device model is installed, else shared tags + [[mentions]]. Dry-run by default (review the suggestions); pass apply:true to draw them (ADDITIVE — never deletes; the human can remove any arrow). Use after brain_insights flags many orphans, to turn a flat list into a real knowledge graph. To DISMISS a brain_reconcile false-positive contradiction, pass pairs:[{fromId,toId}] (the ids are in the reconcile output) with relationship:"not_contradiction" — a persisted dismissal that stops that pair ever resurfacing as a candidate.',
  inputSchema: {
    canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
    apply: z.boolean().optional().describe('false (default) = suggest only; true = draw the connections.'),
    max: z.number().optional().describe('Max connections to propose/draw (default 24).'),
    threshold: z.number().optional().describe('Min semantic similarity 0–1 to link (default 0.45). Higher = fewer, tighter links.'),
    pairs: z.array(z.object({ fromId: z.string(), toId: z.string() })).optional().describe('Explicit card-id pairs to connect (bypasses auto-proposal). Use to dismiss a reconcile false-positive: pass the two card ids with relationship:"not_contradiction".'),
    relationship: z.string().optional().describe('Relationship for explicit `pairs` (e.g. "not_contradiction" to permanently dismiss a contradiction candidate, or "relates_to", "depends_on", "supports").'),
  },
}, async ({ canvas, apply, max, threshold, pairs, relationship }) => toContent(await opBrainConnect({ vault: mcpPresence.vault, canvas, apply, max, threshold, pairs, relationship, log })));

server.registerTool('brain_reconcile', {
  title: 'Reconcile the brain — contradictions between cards + unrecorded migrations',
  description: 'Truth maintenance. (1) CONTRADICTIONS: finds same-subject live card pairs where one carries an explicit correction cue (uppercase "CORRECTION", "was WRONG", "OBSOLETE" — that side is the presumed truth, UNLESS the cue predates its counterpart: then the pair is marked "presumed superseded" and the newer card is presumed current — verify before retiring) or the two use opposite polarity words (deferred↔wired, broken↔fixed, dead↔live), i.e. stale facts whose correction never got linked — candidates only, YOU confirm each: retire the stale card via brain_note ✓. Dismiss a FALSE positive (either kind) by connecting the two ids with brain_connect pairs + relationship:"not_contradiction" — persisted, so it never resurfaces (and its cue stops overlaying recall/ask for that pair). (2) MIGRATIONS: lists committed migration files (Supabase / Rails / Prisma / Knex / generic) that NO brain card references, so an applied-but-unnarrated rollout can be recorded. (3) LEGACY: pre-v1.15 raw-bash ship cards to tidy. Reads ONLY the filesystem — never the database, never the network — and changes nothing. Run it periodically, or when recall surfaces something you believe is stale.',
  inputSchema: {
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
    root: z.string().optional().describe("Project root holding the migrations dir (default: the brain file's folder)."),
    mode: z.enum(['all', 'contradictions', 'migrations', 'legacy', 'claims']).optional().describe('Which pass to run (default "all"): contradictions · migrations · legacy (pre-v1.15 raw-bash ship cards to tidy) · claims (open "remaining:/next:" clauses a later milestone likely fulfilled — receipts + ✓ markers, never auto-archived).'),
  },
}, async ({ canvas, root, mode }) => toContent(await opBrainReconcile({ vault: mcpPresence.vault, canvas, root, mode })));

server.registerTool('brain_garden', {
  title: 'Garden the brain — consolidate over-grown areas (sleep-time compute)',
  description: 'Tidy an over-grown brain WITHOUT losing anything — SMART and non-invasive: it only consolidates DORMANT cards (old + peripheral), never load-bearing ones. Two phases: call it with no apply to get the areas that have accumulated forgotten cards (deterministic: >3 cards that are older than 14 days, beyond the area\'s newest 8, AND have ≤1 connection — so hubs and still-referenced decisions are left untouched; Focus/Instructions/Archive/Open-questions areas protected) plus their card text; YOU write one tight synthesis per area; then call again with apply:true and syntheses:[{title, synthesis}]. Each area gets a 🌿 synthesis card, the originals are stamped "⤵ consolidated", moved to Archive, and arrowed to the synthesis — nothing is deleted, and one undo un-gardens. Run it when brain_insights or the brief shows an area has grown noisy.',
  inputSchema: {
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
    apply: z.boolean().optional().describe('false (default) = list over-grown areas + cards to synthesize; true = consolidate using the supplied syntheses.'),
    syntheses: z.array(z.object({
      title: z.string().describe('Area title EXACTLY as returned by the dry run.'),
      synthesis: z.string().describe('3-6 sentence prose synthesis preserving every still-relevant fact/decision/number.'),
    })).optional().describe('Required when apply:true — one entry per area you want consolidated.'),
    approve: z.string().optional().describe('Required when apply:true — the 8-char human-approval code. You are never shown it: the human runs `npx klypix-mcp garden-code` and pastes the code into chat after reviewing your plan. Never guess or fabricate it.'),
  },
}, async ({ canvas, apply, syntheses, approve }) => toContent(await opBrainGarden({ vault: mcpPresence.vault, canvas, apply, syntheses, approve })));

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
}, async ({ canvas, cards, connections }) => {
  // Provenance: stamp WHICH agent wrote these cards (from the MCP client's
  // initialize handshake — cursor / claude / cline).
  let via; try { via = server.server.getClientVersion()?.name; } catch { /* optional */ }
  return toContent(await opAddToCanvas({ vault: mcpPresence.vault, canvas, cards, connections, via }));
});

server.registerTool('brain_note', {
  title: 'Write a deliberate note to the project brain (decision / question / milestone / skill / resolve / update)',
  description: 'Record something in the project brain ON DEMAND — the agent-neutral twin of the Claude-Code capture hook, so any client (Cursor / Cline / Desktop) can write the brain, not just read it. Unlike add_to_canvas (a flat append), this routes through the brain\'s capture engine, so a new decision SUPERSEDES a heavily-overlapping older one, ✓ RESOLVES/archives a matching card, closes: resolves the strategy/question a milestone fulfils, and ~ UPDATES a card in place — the full decision lifecycle, with dedup. Use marker "+" to record a 🛠️ SKILL — a reusable how-to/gotcha/convention ("always dedup zKeys before REORDER") that should resurface every session and never age out, distinct from a one-time decision. Use it to remember a decision, ask an open question, mark a milestone, log a skill, resolve a finished item, or correct a card. Defaults to the project brain ("brain").',
  inputSchema: {
    text: z.string().describe('The note — one concise idea; the first line becomes the card title.'),
    marker: z.enum(['', '?', '!', '+', '✓', '~']).optional().describe('(none)=decision · ?=open question · !=milestone · +=🛠️ skill (reusable how-to/gotcha; always resurfaces, never ages out) · ✓=resolve+archive the best-matching card · ~=update the matching card in place. Default: decision.'),
    area: z.string().optional().describe('Area/topic — routes the card into that titled container and becomes a #tag (e.g. "Auth", "Release").'),
    closes: z.string().optional().describe('Title or [[wikilink]] of a strategy/question card this note fulfils — resolves+archives it and draws a "closed by" arrow.'),
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
  },
}, async ({ text, marker, area, closes, canvas }) => {
  let via; try { via = server.server.getClientVersion()?.name; } catch { /* optional */ }
  return toContent(await opBrainNote({ vault: mcpPresence.vault, canvas, text, area, marker: marker || '', closes, via }));
});

server.registerTool('brain_message', {
  title: 'Message the other live agent sessions on this project (one-time note, not a brain card)',
  description: 'Leave a DELIBERATE, targeted note for the OTHER active agent sessions working on this project right now ("merged the hook refactor — rebase before you commit", "don\'t touch canvasStore, mid-refactor"). Any MCP client can send and receive through the shared presence lane. Hookless MCP peers receive each note once on their next KLYPIX tool call (and may also see a host logging notification); lifecycle hooks provide more proactive delivery. Ephemeral (expires in 24h) and NOT persisted to the brain — for a durable decision use brain_note instead.',
  inputSchema: {
    text: z.string().describe('The note to deliver (kept to 400 chars).'),
    to: z.string().optional().describe('Target hint — a peer session id-prefix or branch name; omit or "all" for every live session.'),
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
  },
}, async ({ text, to, canvas }) => {
  let via; try { via = server.server.getClientVersion()?.name; } catch { /* optional */ }
  mcpPresence.noteSent(text);
  return toContent(await opBrainMessage({ vault: mcpPresence.vault, canvas, text, to, via }));
});

server.registerTool('brain_sync', {
  title: 'KLYPIX Context Gateway — synchronize task, peers, conflicts, and relevant memory',
  description: 'APPROVAL-FREE task gateway over the authorized MCP connection. Call FIRST with a concise intent and expected files, again when scope changes, and with phase:"complete" before the final response. One bounded response returns compact task-relevant brain context, active TASK peers (idle connections hidden), one-time messages, structured exact-file conflicts, and automatic late-arrival overlap alerts. Portable across Codex/Antigravity and every MCP host; native hooks are optional.',
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    project: z.string().optional().describe('Absolute current project root containing brain.klypix. Supply it on phase "start" so routing stays correct even when the MCP host launches from its own install directory.'),
    intent: z.string().max(160).optional().describe('One sentence describing the current task. Supply for start/checkpoint; completion clears it.'),
    files: z.array(z.string()).max(20).optional().describe('Project-relative files you expect to touch or have touched. Exact overlaps with peers are flagged.'),
    phase: z.enum(['start', 'checkpoint', 'complete']).optional().describe('start replaces prior task scope; checkpoint merges changed scope; complete clears task intent/files. Default: checkpoint.'),
    include_context: z.boolean().optional().describe('Include fast task-relevant brain cards in the same response. Defaults true; ignored for phase complete.'),
  },
}, async ({ project, intent, files, phase, include_context }) => {
  const totalStartedAt = Date.now();
  const report = mcpPresence.sync({ project, intent, files, phase });
  // Class-C ship observation, host-neutral: brain_sync is the ONE surface every
  // MCP host calls at task start, so an MCP-only project (no Claude/Codex hook)
  // still notices a release nobody narrated. Queued here, drained at the next
  // brain write. Zero network, ~2 cheap git/fs reads, never throws.
  let shipNotice = '';
  if (phase === 'start') {
    try {
      const dir = project ? path.resolve(project) : mcpPresence.vault;
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
  let taskContext = null;
  if (phase !== 'complete' && include_context !== false && (intent || files?.length)) {
    taskContext = await opBrainTaskContext({
      vault: mcpPresence.vault,
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
  };
  const timingText = `Context Gateway total: ${totalMs}ms`
    + (taskContext?.context ? ` (memory ${taskContext.context.durationMs}ms)` : '') + '.';
  return {
    content: [{
      type: 'text',
      text: [report.text, shipNotice, contextText, timingText].filter(Boolean).join('\n\n'),
    }],
    structuredContent,
  };
});

server.registerTool('brain_doctor', {
  title: 'Brain doctor — is this brain current, wired, and in sync?',
  description: 'Read-only self-check of the installed klypix brain, as ONE verdict: VERSION (deployed brain-core + optional npm currency), CLAUDE (existing 4-hook capture readiness), CODEX (automatic MCP presence plus optional enhanced-hook status), TOOLS (discoverable MCP verbs), SESSIONS (all active presence-adapter sessions across hosts, never recent-chat history), and HARNESS (projection drift). Use to answer "is my brain current, correctly installed, in sync, and who is actually live?" without file-spelunking. Never writes. The MCP-callable twin of `npx klypix-mcp doctor`.',
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
    const report = inspect({ projectDir: project ? path.resolve(project) : mcpPresence.vault, npmLatest, self: { pid: process.pid, version: PKG_VERSION } });
    return mcpPresence.decorateToolResult({ content: [{ type: 'text', text: render(report, { color: false }) }] });
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
const CANVAS_VIEW_DESC = 'Render a KLYPIX canvas/brain as a SPATIAL BOARD. In an MCP Apps host (Claude, VS Code, Goose) this opens an interactive read-only whiteboard — cards, containers, connection arrows, pan/zoom — of any .klypix canvas (defaults to the project brain). In hosts without the apps extension it returns a text summary of the board. Use when the user asks to SEE the canvas/brain/board, not just query it.';
const canvasViewHandler = async ({ canvas }) => {
  const r = await opCanvasView({ vault: mcpPresence.vault, canvas });
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
server.server.oninitialized = () => {
  mcpPresence.start(VAULT);
  recordRunningServer();
  runningHeartbeat = setInterval(() => recordRunningServer(), 30_000);
  runningHeartbeat.unref?.();
  // The worker mirrors the supervisor's host-neutral scheduler. This lets an
  // older stable supervisor acquire the updater immediately after hot-swapping
  // to a compatible new worker; no extra host reconnect is needed for the
  // scheduler itself. Stamp + lock make the duplicate trigger effectively free.
  const autoUpdateDir = path.dirname(
    process.env.KLYPIX_MCP_RUNTIME_MANIFEST
    || path.join(os.homedir(), '.claude', 'project-brain', '.mcp-runtime.json'),
  );
  const checkForCoreUpdate = () => spawnAutoUpdateHelper({
    brainDir: autoUpdateDir,
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
// Pre-warm the on-device embedder in the BACKGROUND so the first cross-project
// search of a session is already semantic, not a lexical fallback.
getEmbedder(log).then(p => log(p ? 'semantic ready (pre-warmed)' : 'semantic unavailable — lexical only')).catch(() => {});
