#!/usr/bin/env node
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
import path from 'path';
import { createRequire } from 'module';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  resolveVault, getEmbedder, buildKlypixMap, cardSchema, connSchema,
  opListCanvases, opReadCanvas, opSearchCanvases, opSearchAllBrains,
  opBrainInsights, opBrainConnect, opBrainReconcile, opBrainGarden, opCreateCanvas, opAddToCanvas, opBrainNote, opBrainMessage, opBrainAsk,
} from '../src/klypix-core.mjs';

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

// `npx klypix-mcp init` — 60-second onboarding: seed a starter project brain in
// the current folder so a new user's FIRST contact isn't an empty vault, then
// print a paste-ready MCP config. Runs before any server setup.
if (process.argv[2] === 'init') {
  const target = path.resolve(process.cwd(), 'brain.klypix');
  if (fs.existsSync(target)) { console.error(`brain.klypix already exists in ${process.cwd()} — not overwriting.`); process.exit(0); }
  const buf = await buildKlypixMap({
    title: 'project brain',
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
  const cfg = JSON.stringify({ mcpServers: { 'klypix-canvas': { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', process.cwd().replace(/\\/g, '/')] } } }, null, 2);
  console.error(`✓ Created ${target}\n\nAdd this to your MCP client config (.mcp.json / claude_desktop_config.json):\n\n${cfg}\n\nThen ask your agent to read the canvas "brain" — it now has a project memory.`);
  process.exit(0);
}

const vaultArgIdx = process.argv.indexOf('--vault');
const VAULT = resolveVault(vaultArgIdx >= 0 ? process.argv[vaultArgIdx + 1] : undefined);

// Map a protocol-neutral core result → an MCP tool result.
const toContent = (r) => {
  const content = r.blocks.map(b => b.kind === 'image'
    ? { type: 'image', data: b.data, mimeType: b.mime }
    : { type: 'text', text: b.text });
  return r.isError ? { content, isError: true } : { content };
};

const server = new McpServer({ name: 'klypix-canvas', version: PKG_VERSION });

server.registerTool('list_canvases', {
  title: 'List KLYPIX canvases',
  description: 'List all .klypix / .any canvas files in the vault, with card and connection counts.',
  inputSchema: {},
}, async () => toContent(await opListCanvases({ vault: VAULT })));

server.registerTool('read_canvas', {
  title: 'Read a KLYPIX canvas',
  description: 'Read a canvas as structured markdown (every card, the connection graph, [[wikilinks]], #tags) AND return its images so you can SEE them, not just their filenames. Pass the canvas TITLE directly (e.g. "SS2") — a filename, vault-relative path, or absolute path also work; you do NOT need to list or search first.',
  inputSchema: { canvas: z.string().describe('Canvas title or filename (e.g. "SS2"), vault-relative path, or absolute path.') },
}, async ({ canvas }) => toContent(await opReadCanvas({ vault: VAULT, canvas })));

server.registerTool('search_canvases', {
  title: 'Search inside all canvases',
  description: 'Search card text, titles, and #tags across every canvas in the vault. Returns the canvases and the matching cards.',
  inputSchema: { query: z.string().describe('Text or #tag to find inside canvases.') },
}, async ({ query }) => toContent(await opSearchCanvases({ vault: VAULT, query })));

server.registerTool('search_all_brains', {
  title: 'Search every project brain on this machine',
  description: 'Cross-project memory search: looks through every brain.klypix this machine has worked with (auto-registered by the brain hook), not just the current vault. Semantic (on-device) + lexical hybrid ranking. Use when the answer may live in ANOTHER project\'s decisions. Optional as_of (YYYY-MM-DD) answers "what was true then" — superseded cards count as live if they were current at that date.',
  inputSchema: {
    query: z.string().describe('What to find across all project brains.'),
    as_of: z.string().optional().describe('Optional YYYY-MM-DD: rank what was TRUE at that date (time-travel query).'),
  },
}, async ({ query, as_of }) => toContent(await opSearchAllBrains({ vault: VAULT, query, as_of, log })));

server.registerTool('brain_ask', {
  title: 'Ask the project brain a question (whole-brain, correction-aware answer)',
  description: 'Answer a natural-language question from the WHOLE project brain — "what did we decide about X?", "where did the auth work land?", "why did we drop Y?". Ranks every card (semantic on-device + lexical hybrid), INCLUDES superseded/archived history (flagged, so you can see how a decision changed), and attaches each stale card\'s live CORRECTION so the answer reflects the current truth, not an outdated card. Returns a synthesis-ready context (full cards + provenance + lifecycle) for you to turn into a direct, cited answer — it does not itself write prose. Prefer this over search_canvases when the user asks a QUESTION (not a keyword lookup). Optional as_of (YYYY-MM-DD) answers "what was true then". Defaults to the project brain ("brain").',
  inputSchema: {
    question: z.string().describe('The natural-language question to answer from the brain.'),
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
    as_of: z.string().optional().describe('Optional YYYY-MM-DD: answer as of that date (superseded cards count as live if they were current then).'),
    k: z.number().optional().describe('Max cards to surface for synthesis (default 10, capped 20).'),
  },
}, async ({ question, canvas, as_of, k }) => toContent(await opBrainAsk({ vault: VAULT, canvas, question, as_of, k, log })));

server.registerTool('brain_insights', {
  title: 'What matters in a brain — hubs, orphans, stale questions',
  description: 'Structural read of a brain.klypix: the most-connected "hub" cards (load-bearing decisions), orphaned decisions (no connections — maybe forgotten), stale open questions (aging & unresolved), and area sizes. Use to answer "what matters here / what am I forgetting / what should I review?" — read it at the start of a planning session, or before tidying.',
  inputSchema: {
    canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
    staleDays: z.number().optional().describe('Open questions older than this many days count as stale (default 21).'),
  },
}, async ({ canvas, staleDays }) => toContent(await opBrainInsights({ vault: VAULT, canvas, staleDays })));

server.registerTool('brain_connect', {
  title: 'Connect related-but-unlinked brain cards (densify the graph)',
  description: 'Finds genuinely related cards that AREN\'T linked yet and proposes connections — semantic similarity when the on-device model is installed, else shared tags + [[mentions]]. Dry-run by default (review the suggestions); pass apply:true to draw them (ADDITIVE — never deletes; the human can remove any arrow). Use after brain_insights flags many orphans, to turn a flat list into a real knowledge graph.',
  inputSchema: {
    canvas: z.string().optional().describe('Canvas filename/path. Defaults to the project brain ("brain").'),
    apply: z.boolean().optional().describe('false (default) = suggest only; true = draw the connections.'),
    max: z.number().optional().describe('Max connections to propose/draw (default 24).'),
    threshold: z.number().optional().describe('Min semantic similarity 0–1 to link (default 0.45). Higher = fewer, tighter links.'),
  },
}, async ({ canvas, apply, max, threshold }) => toContent(await opBrainConnect({ vault: VAULT, canvas, apply, max, threshold, log })));

server.registerTool('brain_reconcile', {
  title: 'Reconcile the brain — contradictions between cards + unrecorded migrations',
  description: 'Truth maintenance in two passes. (1) CONTRADICTIONS: finds same-subject live card pairs where one carries an explicit correction cue (uppercase "CORRECTION", "was WRONG", "OBSOLETE" — that side is the presumed truth) or the two use opposite polarity words (deferred↔wired, broken↔fixed, dead↔live), i.e. stale facts whose correction never got linked — candidates only, YOU confirm each: retire the stale card via brain_note ✓; a false POLARITY pair is dismissed by deliberately connecting the pair (brain_connect), while a correction-cue pair clears only when the stale card is retired. (2) MIGRATIONS: lists committed migration files (Supabase / Rails / Prisma / Knex / generic) that NO brain card references, so an applied-but-unnarrated rollout can be recorded. Reads ONLY the filesystem — never the database, never the network — and changes nothing. Run it periodically, or when recall surfaces something you believe is stale.',
  inputSchema: {
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
    root: z.string().optional().describe("Project root holding the migrations dir (default: the brain file's folder)."),
    mode: z.enum(['all', 'contradictions', 'migrations']).optional().describe('Which pass to run (default "all").'),
  },
}, async ({ canvas, root, mode }) => toContent(await opBrainReconcile({ vault: VAULT, canvas, root, mode })));

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
  },
}, async ({ canvas, apply, syntheses }) => toContent(await opBrainGarden({ vault: VAULT, canvas, apply, syntheses })));

server.registerTool('create_canvas', {
  title: 'Create a KLYPIX canvas',
  description: 'Create a new .klypix canvas from cards + connections and save it to the vault. The user opens it in the KLYPIX app (Canvas → Open). Prefer short, titled cards (one idea each) connected by meaningful arrows.',
  inputSchema: {
    title: z.string().describe('Canvas title (also the filename).'),
    cards: z.array(cardSchema).min(1).describe('The cards. 5-12 atomic cards is ideal.'),
    connections: z.array(connSchema).optional().describe('Arrows between cards.'),
    filename: z.string().optional().describe('Override the output filename (without extension).'),
  },
}, async ({ title, cards, connections, filename }) => toContent(await opCreateCanvas({ vault: VAULT, title, cards, connections, filename })));

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
  return toContent(await opAddToCanvas({ vault: VAULT, canvas, cards, connections, via }));
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
  return toContent(await opBrainNote({ vault: VAULT, canvas, text, area, marker: marker || '', closes, via }));
});

server.registerTool('brain_message', {
  title: 'Message the other live agent sessions on this project (one-time note, not a brain card)',
  description: 'Leave a DELIBERATE, targeted note for the OTHER live agent sessions working on this project right now ("merged the hook refactor — rebase before you commit", "don\'t touch canvasStore, mid-refactor"). Any MCP client can SEND (the twin of the `🧠 MSG [to]: text` marker); delivery is to HOOK-WIRED sessions (Claude Code with the brain hooks) — each sees the note once at its next prompt. A hookless peer (plain Cursor/Cline session) will NOT receive it, so don\'t rely on this to warn one. Ephemeral (expires in 24h) and NOT persisted to the brain — for a durable decision use brain_note instead.',
  inputSchema: {
    text: z.string().describe('The note to deliver (kept to 400 chars).'),
    to: z.string().optional().describe('Target hint — a peer session id-prefix or branch name; omit or "all" for every live session.'),
    canvas: z.string().optional().describe('Brain canvas filename/path. Defaults to the project brain ("brain").'),
  },
}, async ({ text, to, canvas }) => {
  let via; try { via = server.server.getClientVersion()?.name; } catch { /* optional */ }
  return toContent(await opBrainMessage({ vault: VAULT, canvas, text, to, via }));
});

server.registerTool('brain_doctor', {
  title: 'Brain doctor — is this brain current, wired, and in sync?',
  description: 'Read-only self-check of the installed klypix brain, as ONE verdict: VERSION (the deployed brain-core version + optional npm-latest currency), HOOKS (are all 4 Claude Code hooks wired — liveness vs readiness), TOOLS (the discoverable MCP verb manifest), PEERS (other live sessions on this project\'s brain right now), and HARNESS (per-file projection drift: ok/stale/hand-edited/missing). Use to answer "is my brain current + correctly installed + in sync, and who else is live?" without file-spelunking. Never writes. The MCP-callable twin of `npx klypix-mcp doctor`.',
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
    const report = inspect({ projectDir: project ? path.resolve(project) : process.cwd(), npmLatest });
    return { content: [{ type: 'text', text: render(report, { color: false }) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `brain_doctor unavailable: ${e?.message || e}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready · vault=${VAULT}`);
// Pre-warm the on-device embedder in the BACKGROUND so the first cross-project
// search of a session is already semantic, not a lexical fallback.
getEmbedder(log).then(p => log(p ? 'semantic ready (pre-warmed)' : 'semantic unavailable — lexical only')).catch(() => {});
