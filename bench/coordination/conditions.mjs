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
//   agent is already working, and returns { delivered, notePosted } read back
//   the same way.
//
// Facts come in two shapes. `text` is the sentence the other session would
// write (a note line, a brain card). `text: null` is an ABSENCE: the right
// state of the channel is a stale line gone / no presence row, and there is
// nothing to write (S5). `relayText` is what a human says when pasting;
// `insertAfterLine` is where a dated log keeps the note (default: the end).
//
// One rule for stale lines: the KLYPIX condition never edits the notes file.
// Whatever the file said before — a replaced decision (S1, S7) or a dead
// "WIP, do not touch" line (S5) — is still there, and KLYPIX's own signal
// (the current card first; an empty lane where the ended session's row has
// expired) has to beat it. That is conservative, and it is the one thing a
// notes file cannot do: only the tidy-file condition gets a human-cleaned
// file. (Stripping the WIP line for KLYPIX made its S5 cell the tidy cell
// plus a server — a replicate, not a measurement.)
//
// Claude Code note: `klypix link` writes its rules block into AGENTS.md (read
// by Codex) and deliberately writes no CLAUDE.md target — Claude Code's rules
// channel is hooks, which this MCP-only condition does not install. So in the
// KLYPIX condition Claude's CLAUDE.md is the same file as with no channel, and
// its only pointer to the brain is the server's own instructions.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKlypixMap, addBrainConnections, parseKlypix, appendIntoContainers } from '../../src/klypix-format.mjs';
import { laneFileFor, listActiveSessions, postPresenceMessage, upsertSession } from '../../src/agent-presence.mjs';
import { linkProject } from '../../src/agent-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KLYPIX_BIN = path.join(ROOT, 'bin', 'klypix-mcp.mjs');

/**
 * Which KLYPIX server a run talks to — its entry point, package version and
 * git commit — so every KLYPIX row names the exact build it measured. The bench
 * can be pointed at another build (`--klypix-bin`, e.g. a released tag's
 * checkout) to compare two versions on the same scenarios.
 */
export function klypixServerInfo(bin = KLYPIX_BIN) {
  const root = path.resolve(path.dirname(bin), '..');
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? null; } catch { /* */ }
  const git = (args) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); return r.status === 0 ? String(r.stdout).trim() : null; };
  const commit = git(['rev-parse', '--short', 'HEAD']);
  const dirty = commit ? (git(['status', '--porcelain', '--', 'src', 'bin', 'package.json']) || '') !== '' : null;
  return { bin, version, commit, dirty };
}

const writeInstructions = (repo, text) => {
  // Claude Code reads CLAUDE.md natively; Codex and most others read AGENTS.md.
  // The "kept instructions file" conditions write both, identically.
  repo.write('AGENTS.md', text);
  repo.write('CLAUDE.md', text);
};

const spoken = (f) => f.text ?? f.relayText ?? null;
const noteLine = (f) => `- ${f.text}`;
const compactText = (t) => String(t || '').replace(/\s+/g, ' ');
const allFacts = (scenario) => [...(scenario.facts || []), ...(scenario.later?.facts || [])];

/**
 * Where the appended-notes condition would be byte-identical to another
 * condition it is not a measurement, only a replicate at full cost:
 *   - no fact has a stale line → identical to "kept tidy";
 *   - only absences → it appends nothing → identical to "no channel".
 * Scenarios may also declare notApplicable themselves (S6 for relay).
 */
export function appendedNotApplicable(scenario) {
  const facts = allFacts(scenario);
  if (!facts.some((f) => f.staleLine)) return 'no stale line to keep — the notes file is identical to the kept-tidy condition';
  if (!facts.some((f) => f.text != null)) return 'nothing to append — the notes file is identical to the no-channel condition';
  return null;
}

const none = {
  id: 'none',
  label: 'No shared channel',
  runnable: true,
  async prepare() { return { relays: 0, delivered: [] }; },
  async later() { return { delivered: [], notePosted: null }; },
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
  async later() { return { delivered: [], notePosted: null }; },
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

const makeNotesCondition = (id, label, replaceStale) => ({
  id,
  label,
  runnable: true,
  async prepare({ repo, scenario }) {
    const text = mdApply(repo, scenario.facts, { replaceStale });
    // Commit only when the file changed, under a neutral message: git history
    // must not announce another session's activity to the agent.
    repo.commitIfChanged('notes');
    return { relays: 0, delivered: mdDelivered(text, scenario.facts) };
  },
  // Mid-task: the file changes on disk under the agent, as it does when two
  // sessions share one checkout. Not committed — the agent owns the index.
  async later({ repo, scenario }) {
    const text = mdApply(repo, scenario.later.facts, { replaceStale });
    return { delivered: mdDelivered(text, scenario.later.facts), notePosted: null };
  },
});

const agentsMdKept = makeNotesCondition('agents-md-kept', 'AGENTS.md / CLAUDE.md, kept tidy (stale line replaced)', true);
const agentsMdAppended = makeNotesCondition('agents-md-appended', 'AGENTS.md / CLAUDE.md, appended (stale line kept)', false);

// ── KLYPIX (MCP only) ────────────────────────────────────────────────────────
// The other session's knowledge lives where a real session using KLYPIX puts
// it: decisions and findings as brain cards (a replaced decision archived with
// a 'superseded by' edge; the same dated history the file has, as cards), and
// live work as a lane presence row. An ENDED session's row is written as it
// was and left to the product's own expiry (S5): the lane file still holds it,
// the active list does not. A session that has ended leaves its finding as a
// card too: the mailbox reaches only a session the sender already knew, and
// the agent under test is a brand-new session (on Codex its server even takes
// Codex's own thread id). A decision made while the agent works (S6) becomes
// a card and a broadcast note that the agent's server hands over at its next
// call. The agent gets the klypix-mcp server from THIS checkout in plugin
// mode (no self-update, no settings writes) and the project rules
// `klypix link` writes. Hooks are NOT installed: this is the MCP-only path
// every MCP host gets — conservative for Claude Code, where the hooks would
// also inject the brief.
const klypix = {
  id: 'klypix',
  label: 'KLYPIX (brain + lane, MCP only)',
  runnable: true,
  async prepare({ repo, scenario, sessionIds, benchHome = null, klypixBin = null }) {
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
    // archives nothing: its stale line was a session's work in progress, which
    // in KLYPIX is presence (a lane row that expires), not a card.
    const stale = facts.filter((f) => f.staleLine && f.text != null);
    const staleTexts = new Set(facts.filter((f) => f.staleLine).map((f) => f.staleLine));
    // The dated history the notes file carries, as cards — a stale line goes
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
    const actorRow = (now) => upsertSession({
      brainPath, home, now, id: actor.id, logicalSessionId: actor.id, client: actor.client || 'claude-code',
      branch: actor.branch || null, intent: actor.intent || '', files: actor.files || [],
    });
    const touchActor = () => actorRow(Date.now());
    // A live actor is on the lane. An ended actor's row is written AS IT WAS
    // (its last touch endedAgoMs ago) and left to the product's expiry — the
    // absence the agent sees is produced by KLYPIX, not by the bench.
    let liveActor = false;
    if (actor.files && actor.files.length && !actor.closed) { touchActor(); liveActor = true; }
    if (actor.closed && actor.endedAgoMs) actorRow(Date.now() - actor.endedAgoMs);

    // Read back what the channel actually holds (a broken write must show up
    // as "not delivered", not be assumed delivered).
    const delivered = new Set();
    const { struct } = await parseKlypix(fs.readFileSync(brainPath));
    const cardTexts = struct.cards.map((c) => compactText(c.text));
    const actorOnLane = listActiveSessions({ brainPath, home }).some((s) => s.id === actor.id);
    let actorWritten = true;
    if (actor.closed && actor.endedAgoMs) {
      try { actorWritten = JSON.parse(fs.readFileSync(laneFileFor(brainPath, home), 'utf8')).sessions.some((s) => s.id === actor.id); } catch { actorWritten = false; }
    }
    for (const f of facts) {
      if (f.text != null) { if (cardTexts.some((t) => t.includes(f.text.slice(0, 40)))) delivered.add(f.id); continue; }
      // An absence is delivered when the ended session's row was written and
      // the product's expiry hides it, and no card carries the stale words.
      // (The notes file still does — that is the stale file KLYPIX must beat.)
      const staleWords = f.staleLine ? compactText(f.staleLine.replace(/^- /, '')).slice(0, 40) : null;
      const cardFree = !staleWords || !cardTexts.some((t) => t.includes(staleWords));
      if (actorWritten && !actorOnLane && cardFree) delivered.add(f.id);
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
          args: [klypixBin || KLYPIX_BIN, '--vault', repo.dir],
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
  // reaches only sessions on the lane, i.e. an agent that has synced, which is
  // the product's reality — whether it was posted is recorded, never assumed.
  async later({ repo, scenario, benchHome = null }) {
    const brainPath = path.join(repo.dir, 'brain.klypix');
    const home = benchHome || os.homedir();
    const actor = scenario.actor || {};
    const facts = scenario.later?.facts || [];
    let buf = fs.readFileSync(brainPath);
    let notePosted = null;
    for (const f of facts) {
      if (f.text == null) continue;
      // appendIntoContainers returns the new zip bytes (addBrainConnections
      // returns { buffer }); accept either, never fall through to the old bytes.
      const out = await appendIntoContainers(buf, { cards: [{ text: f.text }] });
      buf = Buffer.isBuffer(out) ? out : out?.buffer;
      if (!Buffer.isBuffer(buf)) throw new Error('appendIntoContainers returned no bytes');
      try {
        const posted = postPresenceMessage({ brainPath, home, from: actor.id || 'other-session', to: 'all', text: f.text });
        notePosted = notePosted === false ? false : !!posted?.posted;
      } catch { notePosted = false; }
    }
    // Written the way the app writes: whole bytes to a temp name, then one
    // rename — the agent's own server never sees a half-written brain. On
    // Windows the rename can meet a sharing violation while the server reads
    // the file, so it retries with backoff (as the format module does) before
    // giving up; a failure is reported, and the runner marks the run invalid.
    const tmp = `${brainPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    let renamed = false;
    for (const wait of [0, 15, 40, 100, 250, 500]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try { fs.renameSync(tmp, brainPath); renamed = true; break; } catch (err) { if (!/EPERM|EACCES|EBUSY/.test(String(err?.code))) throw err; }
    }
    if (!renamed) { try { fs.rmSync(tmp, { force: true }); } catch { /* */ } throw new Error('brain rename kept failing (file in use)'); }
    const { struct } = await parseKlypix(fs.readFileSync(brainPath));
    const cardTexts = struct.cards.map((c) => compactText(c.text));
    return { delivered: facts.filter((f) => f.text != null && cardTexts.some((t) => t.includes(f.text.slice(0, 40)))).map((f) => f.id), notePosted };
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
