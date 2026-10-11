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
// later(ctx) carries scenario.later.facts the way the channel would while the
//   agent is already working, and returns { delivered } read back the same way.
//
// Facts come in two shapes. `text` is the sentence the other session would
// write (a note line, a brain card). `text: null` is an ABSENCE: the right
// state of the channel is a stale line gone / no presence row, and there is
// nothing to write (S5). `relayText` is what a human says when pasting;
// `insertAfterLine` is where a dated log keeps the note (default: the end).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKlypixMap, addBrainConnections, parseKlypix, appendIntoContainers } from '../../src/klypix-format.mjs';
import { laneFileFor, listActiveSessions, postPresenceMessage, upsertSession } from '../../src/agent-presence.mjs';
import { linkProject } from '../../src/agent-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KLYPIX_BIN = path.join(ROOT, 'bin', 'klypix-mcp.mjs');

const writeInstructions = (repo, text) => {
  // Claude Code reads CLAUDE.md natively; Codex and most others read AGENTS.md.
  // The "kept instructions file" conditions write both, identically.
  repo.write('AGENTS.md', text);
  repo.write('CLAUDE.md', text);
};

const spoken = (f) => f.text ?? f.relayText ?? null;
const noteLine = (f) => `- ${f.text}`;
const compactText = (t) => String(t || '').replace(/\s+/g, ' ');

const none = {
  id: 'none',
  label: 'No shared channel',
  runnable: true,
  async prepare() { return { relays: 0, delivered: [] }; },
  async later() { return { delivered: [] }; },
};

const relay = {
  id: 'relay',
  label: 'Human copy-paste (upper bound)',
  runnable: true,
  async prepare({ scenario }) {
    const said = scenario.facts.filter((f) => spoken(f) != null);
    return {
      promptAddendum: said.length ? `A teammate pasted this from another agent session:\n${said.map((f) => `- ${spoken(f)}`).join('\n')}` : null,
      relays: said.length,
      delivered: said.map((f) => f.id),
    };
  },
  // A paste at start cannot carry a decision made later; scenarios that have
  // one declare relay notApplicable, and the runner never reaches this.
  async later() { return { delivered: [] }; },
};

// ── The notes file ───────────────────────────────────────────────────────────
// The other session writes the fact where it belongs: into a dated log at its
// date when the scenario names the spot, otherwise under a "current notes"
// section at the end. "Kept tidy" also removes the line the fact replaces;
// "appended" leaves it — the difference between a disciplined team and the
// usual one.
function mdApply(repo, facts, { replaceStale }) {
  let text = repo.read('AGENTS.md') || '# Project notes\n';
  const toAppend = [];
  for (const f of facts) {
    if (replaceStale && f.staleLine) text = text.replace(`${f.staleLine}\n`, '');
    if (f.text == null) continue;
    if (f.insertAfterLine && text.includes(`${f.insertAfterLine}\n`)) text = text.replace(`${f.insertAfterLine}\n`, `${f.insertAfterLine}\n${noteLine(f)}\n`);
    else toAppend.push(f);
  }
  if (toAppend.length) text = `${text.trimEnd()}\n\n## Current notes from other sessions\n${toAppend.map(noteLine).join('\n')}\n`;
  writeInstructions(repo, text);
  return text;
}
// Read back: a written fact is delivered when its words are in the file; an
// absence is delivered only when the stale line is gone.
const mdDelivered = (text, facts) => facts
  .filter((f) => (f.text == null ? !!f.staleLine && !text.includes(f.staleLine) : text.includes(f.text)))
  .map((f) => f.id);

const makeNotesCondition = (id, label, replaceStale, commitMessage) => ({
  id,
  label,
  runnable: true,
  async prepare({ repo, scenario }) {
    const text = mdApply(repo, scenario.facts, { replaceStale });
    repo.commitAll(commitMessage);
    return { relays: 0, delivered: mdDelivered(text, scenario.facts) };
  },
  // Mid-task: the file changes on disk under the agent, as it does when two
  // sessions share one checkout. Not committed — the agent owns the index.
  async later({ repo, scenario }) {
    const text = mdApply(repo, scenario.later.facts, { replaceStale });
    return { delivered: mdDelivered(text, scenario.later.facts) };
  },
});

const agentsMdKept = makeNotesCondition('agents-md-kept', 'AGENTS.md / CLAUDE.md, kept tidy (stale line replaced)', true, 'notes: other session updated the project notes');
const agentsMdAppended = makeNotesCondition('agents-md-appended', 'AGENTS.md / CLAUDE.md, appended (stale line kept)', false, 'notes: other session appended to the project notes');

// ── KLYPIX (MCP only) ────────────────────────────────────────────────────────
// The other session's knowledge lives where a real session using KLYPIX puts
// it: decisions and findings as brain cards (a replaced decision archived with
// a 'superseded by' edge; the same dated history the file has, as cards), and
// live work as a lane presence row — which ages out when the session is gone,
// so an ended session's "WIP" leaves no row (S5). A session that has ended
// leaves its finding as a card too: the mailbox reaches only a session the
// sender already knew, and the agent under test is a brand-new session (on
// Codex its server even takes Codex's own thread id). A decision made while
// the agent works (S6) becomes a card and a broadcast note that the agent's
// server hands over at its next call. The agent gets the klypix-mcp server from
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
    const written = facts.filter((f) => f.text != null);
    // A replaced DECISION is archived with a 'superseded by' edge. An absence
    // (S5) archives nothing: its stale line was a session's work in progress,
    // which in KLYPIX is presence, not a card — and that presence has aged out.
    const stale = facts.filter((f) => f.staleLine && f.text != null);
    const staleTexts = new Set(facts.filter((f) => f.staleLine).map((f) => f.staleLine));
    // The dated history the notes file carries, as cards — the stale line goes
    // to Archive with its edge instead, so it is never duplicated.
    const history = (scenario.history || []).filter((line) => !staleTexts.has(line)).map((line) => ({ text: line.replace(/^- /, '') }));
    const areas = [{ title: 'Project', cards: written.length ? written.map((f) => ({ text: f.text })) : [{ text: 'Project brain started.' }] }];
    if (history.length) areas.push({ title: 'Log', cards: history });
    if (stale.length) areas.push({ title: 'Archive', cards: stale.map((f) => ({ text: `↩︎ superseded ${new Date().toISOString().slice(0, 10)}\n${f.staleLine.replace(/^- /, '')}` })) });
    let buf = await buildKlypixMap({ title: 'brain', kind: 'brain', areas });
    const edges = [];
    if (stale.length) {
      const { struct } = await parseKlypix(buf);
      for (const f of stale) {
        if (f.text == null) continue;   // an absence has no replacement card to point at
        const oldCard = struct.cards.find((c) => (c.text || '').includes(f.staleLine.replace(/^- /, '')));
        const newCard = struct.cards.find((c) => (c.text || '').startsWith(f.text.slice(0, 40)));
        if (oldCard && newCard) edges.push({ fromId: oldCard.id, toId: newCard.id, label: 'superseded by' });
      }
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
    // A live actor is on the lane; one that ended is not (its row has aged out).
    let liveActor = false;
    if (actor.files && actor.files.length && !actor.closed) { touchActor(); liveActor = true; }

    // Read back what the channel actually holds (a broken write must show up
    // as "not delivered", not be assumed delivered).
    const delivered = new Set();
    const { struct } = await parseKlypix(fs.readFileSync(brainPath));
    const cardTexts = struct.cards.map((c) => compactText(c.text));
    const actorOnLane = listActiveSessions({ brainPath, home }).some((s) => s.id === actor.id);
    for (const f of facts) {
      if (f.text != null) { if (cardTexts.some((t) => t.includes(f.text.slice(0, 40)))) delivered.add(f.id); continue; }
      // An absence is delivered when no row and no card say otherwise.
      const staleWords = f.staleLine ? compactText(f.staleLine.replace(/^- /, '')).slice(0, 40) : null;
      if (!actorOnLane && (!staleWords || !cardTexts.some((t) => t.includes(staleWords)))) delivered.add(f.id);
    }
    // A live actor that is not on the lane delivers nothing: its work in
    // progress is what the agent most needs to see.
    if (liveActor && !actorOnLane) delivered.clear();

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
  // Mid-task: the other session captures its decision (a card) and tells the
  // live sessions (a broadcast note). The card is what is read back; the note
  // is best effort — it reaches only sessions on the lane, i.e. an agent that
  // has synced, which is the product's reality.
  async later({ repo, scenario, benchHome = null }) {
    const brainPath = path.join(repo.dir, 'brain.klypix');
    const home = benchHome || os.homedir();
    const actor = scenario.actor || {};
    const facts = scenario.later?.facts || [];
    let buf = fs.readFileSync(brainPath);
    for (const f of facts) {
      if (f.text == null) continue;
      // appendIntoContainers returns the new zip bytes (addBrainConnections
      // returns { buffer }); accept either, never fall through to the old bytes.
      const out = await appendIntoContainers(buf, { cards: [{ text: f.text }] });
      buf = Buffer.isBuffer(out) ? out : out?.buffer;
      if (!Buffer.isBuffer(buf)) throw new Error('appendIntoContainers returned no bytes');
      try { postPresenceMessage({ brainPath, home, from: actor.id || 'other-session', to: 'all', text: f.text }); } catch { /* no live recipient yet */ }
    }
    fs.writeFileSync(brainPath, buf);
    const { struct } = await parseKlypix(fs.readFileSync(brainPath));
    const cardTexts = struct.cards.map((c) => compactText(c.text));
    return { delivered: facts.filter((f) => f.text != null && cardTexts.some((t) => t.includes(f.text.slice(0, 40)))).map((f) => f.id) };
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
