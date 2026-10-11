// Conditions: how (and whether) the other session's facts reach the agent.
//
// Every condition gets the same repo, task and facts. What differs is only
// the channel. A condition that cannot be run honestly on this machine is
// listed with runnable:false and the exact reason — never silently skipped
// and never simulated.
//
// prepare(ctx) returns:
//   promptAddendum  extra prompt text (only the human-relay condition uses it)
//   mcpServers      { name: { command, args, env } } the agent is started with
//   relays          how many facts a human had to carry by hand
//   delivered       fact ids the channel demonstrably holds (read back, not assumed)
//   heartbeat()     keep a scripted live peer fresh during a long agent run
//   cleanup()       remove anything written outside the temp repo
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKlypixMap, addBrainConnections, parseKlypix } from '../../src/klypix-format.mjs';
import { laneFileFor, listActiveSessions, upsertSession } from '../../src/agent-presence.mjs';
import { linkProject } from '../../src/agent-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KLYPIX_BIN = path.join(ROOT, 'bin', 'klypix-mcp.mjs');

const writeInstructions = (repo, text) => {
  // Claude Code reads CLAUDE.md natively; Codex and most others read AGENTS.md.
  // The "kept instructions file" conditions write both, identically.
  repo.write('AGENTS.md', text);
  repo.write('CLAUDE.md', text);
};

const none = {
  id: 'none',
  label: 'No shared channel',
  runnable: true,
  async prepare() { return { relays: 0, delivered: [] }; },
};

const relay = {
  id: 'relay',
  label: 'Human copy-paste (upper bound)',
  runnable: true,
  async prepare({ scenario }) {
    const lines = scenario.facts.map((f) => `- ${f.text}`).join('\n');
    return {
      promptAddendum: `A teammate pasted this from another agent session:\n${lines}`,
      relays: scenario.facts.length,
      delivered: scenario.facts.map((f) => f.id),
    };
  },
};

const notesSection = (scenario) => `## Current notes from other sessions\n${scenario.facts.map((f) => `- ${f.text}`).join('\n')}\n`;

const agentsMdKept = {
  id: 'agents-md-kept',
  label: 'AGENTS.md / CLAUDE.md, kept tidy (stale line replaced)',
  runnable: true,
  async prepare({ repo, scenario }) {
    let text = repo.read('AGENTS.md') || '# Project notes\n';
    for (const f of scenario.facts) if (f.staleLine) text = text.replace(`${f.staleLine}\n`, '');
    text = `${text.trimEnd()}\n\n${notesSection(scenario)}`;
    writeInstructions(repo, text);
    repo.commitAll('notes: other session updated the project notes');
    return { relays: 0, delivered: scenario.facts.map((f) => f.id) };
  },
};

const agentsMdAppended = {
  id: 'agents-md-appended',
  label: 'AGENTS.md / CLAUDE.md, appended (stale line kept)',
  runnable: true,
  async prepare({ repo, scenario }) {
    const text = `${(repo.read('AGENTS.md') || '# Project notes\n').trimEnd()}\n\n${notesSection(scenario)}`;
    writeInstructions(repo, text);
    repo.commitAll('notes: other session appended to the project notes');
    return { relays: 0, delivered: scenario.facts.map((f) => f.id) };
  },
};

// ── KLYPIX (MCP only) ────────────────────────────────────────────────────────
// The other session's knowledge lives where a real session using KLYPIX puts
// it: decisions and findings as brain cards (a replaced decision archived with
// a 'superseded by' edge), and live work as a lane presence row. A session that
// has ended leaves its finding as a card too: the mailbox reaches only a session
// the sender already knew, and the agent under test is a brand-new session (on
// Codex its server even takes Codex's own thread id). The agent gets the klypix-mcp server from
// THIS checkout in plugin mode (no self-update, no settings writes) and the
// project rules `klypix link` writes. Hooks are NOT installed: this is the
// MCP-only path every MCP host gets — conservative for Claude Code, where the
// hooks would also inject the brief.
const klypix = {
  id: 'klypix',
  label: 'KLYPIX (brain + lane, MCP only)',
  runnable: true,
  async prepare({ repo, scenario, sessionIds, benchHome = null }) {
    const brainPath = path.join(repo.dir, 'brain.klypix');
    // The lane, the project registry and every other KLYPIX file of this run
    // live under ONE home: the run's throwaway folder (live runs) or the
    // process home (the self-test sandboxes it). The server below gets the
    // same folder, so what the actor writes is exactly what the agent reads,
    // and a live run never registers temp projects in the user's own KLYPIX.
    const home = benchHome || os.homedir();
    const facts = scenario.facts;
    const areas = [{ title: 'Project', cards: facts.map((f) => ({ text: f.text })) }];
    const stale = facts.filter((f) => f.staleLine);
    if (stale.length) areas.push({ title: 'Archive', cards: stale.map((f) => ({ text: `↩︎ superseded ${new Date().toISOString().slice(0, 10)}\n${f.staleLine.replace(/^- /, '')}` })) });
    let buf = await buildKlypixMap({ title: 'brain', kind: 'brain', areas });
    if (stale.length) {
      const { struct } = await parseKlypix(buf);
      const edges = stale.map((f) => {
        const oldCard = struct.cards.find((c) => (c.text || '').includes(f.staleLine.replace(/^- /, '')));
        const newCard = struct.cards.find((c) => (c.text || '').startsWith(f.text.slice(0, 40)));
        return oldCard && newCard ? { fromId: oldCard.id, toId: newCard.id, label: 'superseded by' } : null;
      }).filter(Boolean);
      if (edges.length) buf = (await addBrainConnections(buf, edges)).buffer;
    }
    fs.writeFileSync(brainPath, buf);
    // The project rules `klypix link` writes, but NOT its MCP configs: those
    // point at the machine's own global install, so an agent that read
    // .mcp.json could start the user's installed server against this temp repo
    // (Codex did, 2026-10-11). The harness's server is the only channel.
    try {
      linkProject(repo.dir, { editors: new Set(['claude-code', 'codex']), exclude: new Set(['.mcp.json', '.codex/config.toml']) });
    } catch { /* rules are a convenience; the MCP server instructions still apply */ }
    repo.commitAll('klypix: project brain and rules');

    const actor = scenario.actor || {};
    const touchActor = () => upsertSession({
      brainPath, home, now: Date.now(), id: actor.id, client: actor.client || 'claude-code',
      branch: actor.branch || null, intent: actor.intent || '', files: actor.files || [],
    });
    let liveActor = false;
    if (actor.files && actor.files.length && !actor.closed) { touchActor(); liveActor = true; }

    // Read back what the channel actually holds (a broken write must show up
    // as "not delivered", not be assumed delivered).
    const delivered = new Set();
    const { struct } = await parseKlypix(fs.readFileSync(brainPath));
    for (const f of facts) if (struct.cards.some((c) => (c.text || '').replace(/\s+/g, ' ').includes(f.text.slice(0, 40)))) delivered.add(f.id);
    // A live actor that is not on the lane delivers nothing: its work in
    // progress is what the agent most needs to see.
    if (liveActor && !listActiveSessions({ brainPath, home }).some((s) => s.id === actor.id)) delivered.clear();

    return {
      relays: 0,
      delivered: [...delivered],
      // Same name `klypix link` writes, so an agent that also reads the
      // project's config never ends up with a second (published) copy.
      mcpServers: {
        'klypix-canvas': {
          command: process.execPath,
          args: [KLYPIX_BIN, '--vault', repo.dir],
          env: {
            KLYPIX_PLUGIN: '1', KLYPIX_SESSION_ID: sessionIds.agent, KLYPIX_AUTO_UPDATE: '0',
            HOME: home, USERPROFILE: home, KLYPIX_BRAIN_DIR: path.join(home, '.claude', 'project-brain'),
          },
        },
      },
      heartbeat: liveActor ? touchActor : null,
      cleanup() {
        const lane = laneFileFor(brainPath, home);
        for (const f of [lane, `${lane}.lock`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
      },
    };
  },
};

// Planned conditions: listed with the reason they are not run yet, so a
// report can never imply they were measured.
const planned = [
  { id: 'klypix-hooks', label: 'KLYPIX with Claude Code hooks', reason: 'needs project-scoped hook settings pointed at this checkout; MCP-only KLYPIX is measured instead (conservative)' },
  { id: 'claude-messaging', label: 'Claude Code cross-session messaging', reason: 'needs two LIVE Claude sessions; cannot reach a closed session or another vendor, so S3/S4 do not apply by design' },
  { id: 'agent-mail', label: 'MCP Agent Mail', reason: 'third-party server not installed here; adapter must be verified against a pinned version before any result is published' },
  { id: 'concord', label: 'Concord MCP', reason: 'third-party server not installed here; adapter must be verified against a pinned version before any result is published' },
  { id: 'openmemory', label: 'Memory tool (OpenMemory MCP)', reason: 'third-party server not installed here; adapter must be verified against a pinned version before any result is published' },
].map((p) => ({ ...p, runnable: false }));

export const CONDITIONS = [none, relay, agentsMdKept, agentsMdAppended, klypix, ...planned];
export const conditionById = (id) => CONDITIONS.find((c) => c.id === id) || null;
