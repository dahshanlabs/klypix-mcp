// Concord MCP (@concord-ai/concord-mcp) as a coordination-bench condition.
//
// The other session's knowledge reaches the agent through Concord's own five
// tools, used the way Concord's instructions tell a session to use them:
//   - its work is a task it entered with `start_work` (title = its intent,
//     `expected_files` = the files it is on, `branch` when it has one) — so a
//     live peer is a claim the agent's own `start_work` collides with (S2, S10);
//   - a decision or finding it made is an `update_work` record on that task
//     (S1, S3, S4, S8; S6 mid-task, plus a `prompt` to the agent);
//   - a session that ENDED after finishing its work marks the task review-ready
//     with `finish_work` (S3): Concord's workspace view lists active and
//     review-ready tasks only, so a task closed as `complete` takes its notes
//     out of `inspect_work`'s view (they survive in `.concord/` artifacts and in
//     `inspect_work { task_id }`). Leaving it review-ready is the generous
//     reading, the way a session that wants its finding found would end;
//   - a session that STOPPED mid-work (S5-family, S9) leaves its claim as it
//     was. Concord has no automatic work record (no Stop hook stamps a last
//     prompt or reply), so the claim — title, files, branch, kind — is all it
//     carries, and Concord's own presence rules turn it into a STALE claim
//     ("agent away") once the owner has been gone 30 minutes.
// The scripted session acts through the real MCP server, never by writing the
// database. The ONE direct write the bench makes is backdating an ended
// session's timestamps (its `last_seen`, its task's activity) to when it
// really stopped — Concord's tools stamp "now", and the KLYPIX condition writes
// the ended session's lane row at its real age the same way. Delivery is read
// back through Concord's own view functions (`buildStatus`, the task context),
// so a broken write shows as "not delivered".
//
// What `concord setup` writes is reproduced in the run repo: `.concord/` with
// its self-ignoring `.gitignore`, and Concord's instruction block in every
// client file it targets (CLAUDE.md, AGENTS.md, .codex/concord.md, Cursor,
// Copilot, Antigravity rules — `installConcord` from the pinned package). Its
// MCP registrations are NOT written: `.mcp.json` would name a global
// `concord-mcp` command (not installed here) and `~/.codex/config.toml` is the
// user's own file. The harness supplies the server instead, under the same
// `concord` key, from the pinned install. Note Claude Code reads CLAUDE.md
// natively, so Claude sees Concord's rules without opening AGENTS.md — the
// KLYPIX condition's rules reach Claude only through AGENTS.md.
//
// Isolation: every Concord process of a run (the actor's, the agent's) gets
// the run's throwaway home as HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG_*,
// CLAUDE_CONFIG_DIR and CODEX_HOME, telemetry off (CONCORD_TELEMETRY_DISABLED=1,
// DO_NOT_TRACK=1), update checks off, `CONCORD_ALLOWED_ROOTS` pinned to the run
// repo, and a `~/.concord/config.json` with `autoAdapters: false` so Concord's
// self-heal only reports a missing harness adapter and never installs plugins
// or starts daemons from the bench. Nothing touches the user's own ~/.concord,
// ~/.claude or ~/.codex.
//
// Identity: Concord derives an agent's id from its session (CLAUDE_CODE_SESSION_ID
// for Claude Code; Codex scrubs its servers' environment and tells the model
// its id through a hook the bench does not install). To be independent of
// either, the bench names each session with the documented operator path,
// `CONCORD_AGENT_ID=<kind>:<id>` — the agent as `claude-code:<hash of its
// session id>`, the actor as `<its client>:<actor id>`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The adapter is verified against this release only; another version is not run. */
export const CONCORD_PINNED_VERSION = '0.20.0';
/** Where `npm install @concord-ai/concord-mcp@0.20.0` was run (its node_modules/ lives here). */
export const CONCORD_DIR_ENV = 'KLYPIX_BENCH_CONCORD_DIR';
export const CONCORD_DEFAULT_DIR = path.join(ROOT, 'bench', 'coordination', '.vendor', 'concord');
/** The ignore file `concord setup` writes, byte for byte. */
const CONCORD_GITIGNORE = '# Created by concord setup. Keeps the local Concord workspace untracked.\n*\n';

/** The pinned install, or why there is none to run. */
export function concordInstall(env = process.env) {
  const dir = env[CONCORD_DIR_ENV] || CONCORD_DEFAULT_DIR;
  const pkgDir = path.join(dir, 'node_modules', '@concord-ai', 'concord-mcp');
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version ?? null; } catch { /* not installed */ }
  if (version == null) {
    return { ok: false, dir, pkgDir, version: null, reason: `Concord ${CONCORD_PINNED_VERSION} is not installed at ${dir} (npm install @concord-ai/concord-mcp@${CONCORD_PINNED_VERSION} --prefix <dir>, then set ${CONCORD_DIR_ENV}=<dir>); adapter verified against ${CONCORD_PINNED_VERSION} only` };
  }
  if (version !== CONCORD_PINNED_VERSION) {
    return { ok: false, dir, pkgDir, version, reason: `Concord ${version} is installed at ${dir}; the adapter is verified against ${CONCORD_PINNED_VERSION} only and is not run against another version` };
  }
  return { ok: true, dir, pkgDir, version, server: path.join(pkgDir, 'dist', 'index.js'), cli: path.join(pkgDir, 'dist', 'cli', 'index.js') };
}

// Concord's own modules, loaded from the pinned package (its own node_modules
// resolve its zod / better-sqlite3 / SDK): the installer that `concord setup`
// runs, the store opener, and the pure view functions `inspect_work` renders.
const loaded = new Map();
async function concordModules(install) {
  if (loaded.has(install.pkgDir)) return loaded.get(install.pkgDir);
  const mod = (rel) => import(pathToFileURL(path.join(install.pkgDir, 'dist', rel)).href);
  const [installer, db, paths, view, artifacts, taskContext, identity] = await Promise.all([
    mod('install/index.js'), mod('db/index.js'), mod('config/paths.js'), mod('artifacts/work-state-view.js'),
    mod('artifacts/index.js'), mod('tools/get-task-context.js'), mod('domain/identity.js'),
  ]);
  const mods = {
    installConcord: installer.installConcord, openRepositories: db.openRepositories, databasePath: paths.databasePath,
    concordDir: paths.concordDir, buildStatus: view.buildStatus, writeArtifacts: artifacts.writeArtifacts,
    handleGetTaskContext: taskContext.handleGetTaskContext, agentIdForSession: identity.agentIdForSession,
  };
  loaded.set(install.pkgDir, mods);
  return mods;
}

/** The environment every Concord process of a run gets: pinned home, no telemetry, no update check, this repo only. */
export function concordEnv(home, repoDir, agentId) {
  return {
    CONCORD_REPO_ROOT: repoDir,
    CONCORD_ALLOWED_ROOTS: repoDir,
    CONCORD_AGENT_ID: agentId,
    CONCORD_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    CONCORD_NO_UPDATE_CHECK: '1',
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
  };
}

const KIND_FOR_AGENT = { claude: 'claude-code', codex: 'codex' };
const actorKind = (actor, agent) => (typeof actor.clientFor === 'function' ? actor.clientFor(agent) : (actor.client || 'claude-code'));
const slug = (s) => String(s || 'work').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'work';
/** The task id the other session entered its work under: TASK- plus its intent, the way Concord's examples name tasks. */
export const actorTaskId = (actor) => `TASK-${slug(actor.intent || actor.id)}`;
const compactText = (t) => String(t || '').replace(/\s+/g, ' ');
const first40 = (t) => compactText(t).slice(0, 40);

/** One actor session against the real server: connect, act, disconnect (the SDK kills the child on close). */
async function withConcordSession(install, env, cwd, fn) {
  const client = new Client({ name: 'cobench-actor', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [install.server], cwd, stderr: 'pipe', env: { ...process.env, ...env } });
  await client.connect(transport);
  // Kept only so a failing call can be explained; the SDK's child exists after connect.
  let stderr = '';
  transport.stderr?.on('data', (d) => { stderr += d; if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
  try {
    const call = async (name, args, { allowError = false } = {}) => {
      const r = await client.callTool({ name, arguments: args });
      if (r.isError && !allowError) throw new Error(`concord ${name}: ${(r.content || []).map((c) => c.text || '').join(' ').slice(0, 400)}${stderr ? ` [server: ${stderr.slice(-300)}]` : ''}`);
      return r;
    };
    return await fn(call);
  } finally {
    try { await client.close(); } catch { /* */ }
  }
}

/** Backdate an ended session's rows to when it really stopped, then regenerate Concord's artifacts from the store. */
function backdate(mods, repoDir, { agentId, taskId, at }) {
  const repos = mods.openRepositories(mods.databasePath(repoDir));
  try {
    const iso = new Date(at).toISOString();
    repos.db.prepare('UPDATE agents SET first_seen = ?, last_seen = ? WHERE agent_id = ?').run(iso, iso, agentId);
    repos.db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE task_id = ?').run(iso, iso, taskId);
    for (const table of ['task_updates', 'handoffs', 'events', 'reviews', 'task_ownership_events']) {
      try { repos.db.prepare(`UPDATE ${table} SET created_at = ? WHERE task_id = ?`).run(iso, taskId); } catch { /* table or column absent in this schema */ }
    }
    mods.writeArtifacts(mods.concordDir(repoDir), repos);
  } finally { repos.db.close(); }
}

/** What Concord's own view shows right now: the workspace snapshot `inspect_work` renders, plus one task's context. */
function readBack(mods, repoDir, taskId) {
  const repos = mods.openRepositories(mods.databasePath(repoDir));
  try {
    const status = mods.buildStatus(repos);
    let context = null;
    try { context = mods.handleGetTaskContext(repos, { task_id: taskId }); } catch { context = null; }
    return { status, context };
  } finally { repos.db.close(); }
}

const kindForFact = (f) => (f.staleLine ? 'decision' : 'finding');

export const concord = {
  id: 'concord',
  label: `Concord MCP ${CONCORD_PINNED_VERSION} (server + its instruction blocks, no plugin)`,
  mcp: true,
  get runnable() { return concordInstall().ok; },
  get reason() { const i = concordInstall(); return i.ok ? null : i.reason; },
  serverInfo() { const i = concordInstall(); return { name: 'concord', version: i.version, pinned: CONCORD_PINNED_VERSION, dir: i.dir, ok: i.ok }; },
  /** Scenarios Concord has no faithful shape for — never run, printed as n/a with the reason. */
  notApplicableFor(agent, scenario = null) {
    if (!scenario) return null;
    if (typeof scenario.klypixBrain === 'function') return "the brain is KLYPIX's own capture engine replaying brain_note calls; Concord has no equivalent of that history";
    if ((scenario.history || []).length > 20) return 'Concord keeps task-scoped context, not a dated project log; six months of notes have no faithful Concord shape (the history stays in the notes file only)';
    if (/^s9s-/.test(scenario.id)) return 'identical to S9 (only the KLYPIX work record differs; Concord records no last words)';
    return null;
  },
  async prepare({ repo, scenario, agent = null, sessionIds, benchHome = null }) {
    const install = concordInstall();
    if (!install.ok) throw new Error(install.reason);
    const mods = await concordModules(install);
    const home = benchHome || os.homedir();
    // What `concord setup` writes into the repository (minus its MCP registrations, see above).
    const concordPath = path.join(repo.dir, '.concord');
    fs.mkdirSync(concordPath, { recursive: true });
    fs.writeFileSync(path.join(concordPath, '.gitignore'), CONCORD_GITIGNORE);
    const instructionFiles = mods.installConcord(repo.dir);
    // The run's own user config: adapters are never installed from the bench.
    const userDir = path.join(home, '.concord');
    const createdUserDir = !fs.existsSync(userDir);
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'config.json'), `${JSON.stringify({ globalMode: false, autoAdapters: false }, null, 2)}\n`);
    repo.commitAll('concord: setup');

    const actor = scenario.actor || {};
    const kind = actorKind(actor, agent);
    const actorId = `${kind}:${actor.id || 'other-session'}`;
    const taskId = actorTaskId(actor);
    const agentKind = KIND_FOR_AGENT[agent?.id] || 'claude-code';
    const agentId = mods.agentIdForSession(agentKind, sessionIds.agent);
    const actorEnv = concordEnv(home, repo.dir, actorId);
    const facts = scenario.facts;
    // A fact KLYPIX carries without anyone writing it (a work record, presence)
    // is not a note here either: the claim is all a Concord session leaves.
    const written = facts.filter((f) => f.text != null && !f.klypixVia);
    const closedWithNotes = !!actor.closed && written.length > 0;

    // The other session, through Concord's own tools.
    const startArgs = {
      task_id: taskId, title: actor.intent || 'Work in progress', kind,
      ...(actor.branch ? { branch: actor.branch } : {}),
      ...(actor.files && actor.files.length ? { expected_files: actor.files } : {}),
    };
    await withConcordSession(install, actorEnv, repo.dir, async (call) => {
      await call('start_work', startArgs);
      for (const f of written) await call('update_work', { operation: 'record', task_id: taskId, kind: kindForFact(f), content: f.text });
      if (closedWithNotes) {
        // The session finished its work and left: review-ready, with the finding as evidence.
        const ctx = await call('inspect_work', { task_id: taskId });
        const version = Number(ctx.structuredContent?.task?.version);
        if (!Number.isFinite(version)) throw new Error('concord inspect_work: no task version to finish with');
        await call('finish_work', {
          task_id: taskId, expected_version: version, outcome: 'review_ready',
          what_changed: actor.intent || 'Finished the work',
          ...(actor.files && actor.files.length ? { changed_files: actor.files } : {}),
          known_risks: written.map((f) => f.text), next_steps: written.map((f) => f.text),
        });
      }
    });
    // An ended session's rows are stamped when it really stopped (the tools stamp "now").
    if (actor.closed && actor.endedAgoMs) backdate(mods, repo.dir, { agentId: actorId, taskId, at: Date.now() - actor.endedAgoMs });

    // Read back what Concord's own view holds.
    const { status, context } = readBack(mods, repo.dir, taskId);
    const onRoster = (status.presence || []).some((p) => p.agentId === actorId);
    const activeTask = (status.active || []).find((t) => t.taskId === taskId) || null;
    const reviewTask = (status.reviewReady || []).find((t) => t.taskId === taskId) || null;
    const staleClaim = (status.staleClaims || []).find((c) => c.taskId === taskId) || null;
    const listed = !!(activeTask || reviewTask);
    const updateTexts = (context?.updates || []).map((u) => compactText(u.content));
    const liveActor = !!(actor.files && actor.files.length && !actor.closed);
    const delivered = new Set();
    for (const f of facts) {
      if (f.klypixVia === 'presence') { if (onRoster && activeTask && (context?.task?.expectedFiles || []).some((x) => (actor.files || []).includes(x))) delivered.add(f.id); continue; }
      // A stopped session's work: Concord lists its claim as stale, titled with its intent. No last words exist.
      if (f.klypixVia === 'work') { if (staleClaim && context?.task?.title === (actor.intent || '')) delivered.add(f.id); continue; }
      if (f.text != null) { if (listed && updateTexts.some((t) => t.includes(first40(f.text)))) delivered.add(f.id); continue; }
      // An absence: the ended session is off the roster and Concord itself flags its claim as stale; no note carries the stale words.
      const staleWords = f.staleLine ? first40(f.staleLine.replace(/^- /, '')) : null;
      const noteFree = !staleWords || !updateTexts.some((t) => t.includes(staleWords));
      if (!onRoster && staleClaim && noteFree) delivered.add(f.id);
    }
    if (liveActor && !onRoster) delivered.clear();

    const touch = () => withConcordSession(install, actorEnv, repo.dir, (call) => call('start_work', startArgs));
    return {
      relays: 0,
      delivered: [...delivered],
      channelServer: { name: 'concord', version: install.version },
      concord: { actorId, agentId, taskId, instructionFiles, actorOnRoster: onRoster, staleClaim: !!staleClaim, listed },
      mcpServers: {
        concord: {
          command: process.execPath,
          args: [install.server],
          env: concordEnv(home, repo.dir, agentId),
        },
      },
      heartbeat: liveActor ? () => { touch().catch(() => { /* the next beat retries */ }); } : null,
      cleanup() {
        if (createdUserDir) { try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* */ } }
      },
    };
  },
  // Mid-task: the other session records its decision on its task and prompts
  // the agent through Concord's live messaging. Without Concord's harness
  // plugin the agent has no reachable endpoint, so the prompt is queued at
  // best (or refused) — whether it went out is recorded, never assumed. The
  // record is what is read back.
  async later({ repo, scenario, agent = null, sessionIds, benchHome = null, prep = null }) {
    const install = concordInstall();
    if (!install.ok) throw new Error(install.reason);
    const mods = await concordModules(install);
    const home = benchHome || os.homedir();
    const actor = scenario.actor || {};
    const kind = actorKind(actor, agent);
    const actorId = prep?.concord?.actorId || `${kind}:${actor.id || 'other-session'}`;
    const taskId = prep?.concord?.taskId || actorTaskId(actor);
    const agentId = prep?.concord?.agentId || mods.agentIdForSession(KIND_FOR_AGENT[agent?.id] || 'claude-code', sessionIds.agent);
    const facts = scenario.later?.facts || [];
    let notePosted = null;
    await withConcordSession(install, concordEnv(home, repo.dir, actorId), repo.dir, async (call) => {
      for (const f of facts) {
        if (f.text == null) continue;
        await call('update_work', { operation: 'record', task_id: taskId, kind: 'decision', content: f.text });
        try {
          const r = await call('update_work', { operation: 'prompt', task_id: taskId, to_agent_id: agentId, content: f.text, idempotency_key: crypto.randomUUID() }, { allowError: true });
          const posted = !r.isError && ['sent', 'delivered', 'read', 'replied'].includes(String(r.structuredContent?.status || ''));
          notePosted = notePosted === false ? false : posted;
        } catch { notePosted = false; }
      }
    });
    const { context } = readBack(mods, repo.dir, taskId);
    const updateTexts = (context?.updates || []).map((u) => compactText(u.content));
    return { delivered: facts.filter((f) => f.text != null && updateTexts.some((t) => t.includes(first40(f.text)))).map((f) => f.id), notePosted };
  },
};
