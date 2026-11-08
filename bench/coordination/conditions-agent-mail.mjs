// MCP Agent Mail (the maintained Rust rewrite, github.com/Dicklesworthstone/mcp_agent_mail_rust)
// as a coordination-bench condition — verified against v0.3.40 on Windows 11 x64 (2026-11-08).
//
// The other session's knowledge reaches the agent through Agent Mail's own tools,
// used the way Agent Mail's instruction blurb (`am docs insert-blurbs`, the text
// its README calls "Ready-Made Blurb for Your AGENTS.md") tells a session to:
//   - its identity is a `register_agent` row (program, model, `task_description`
//     = its intent). Agent Mail generates adjective+noun names and REFUSES any
//     other shape (`KlypixBench` → INVALID_AGENT_NAME), so the bench uses two
//     names from Agent Mail's own documentation: the other session is
//     `GreenCastle`, the agent under test is `BlueLake` (see "The seat" below);
//   - its work on files is an exclusive `file_reservation_paths` lease on exactly
//     those files, `reason` = its intent (and branch), ttl 3600 s — the README's
//     own example — so a live peer is a lease the agent's `check_file_reservation_conflicts`
//     / `file_reservation_paths` reports as a conflict with its holder (S2, S10);
//   - a decision or finding is a `send_message` to the seat's mailbox (S1, S3; S6
//     mid-task), thread id = the fact id, `ack_required: false`;
//   - a session that STOPPED while holding a lease (S5-family, S9) is left to
//     Agent Mail's own expiry: its lease is taken with the SMALLEST ttl the server
//     accepts (60 s; "TTL must be >= 60 seconds") and the bench waits until Agent
//     Mail reports the paths clear before the agent starts. Nothing is released by
//     hand, and the store is never written directly (Agent Mail keeps its own
//     certified SQLite + git archive with an integrity guard; a foreign write is
//     not a faithful "stopped session"). The ONE thing the bench cannot reproduce
//     is the session's real age: Agent Mail stamps "now", so the stopped session's
//     identity reads "last active about a minute ago", not two days or five hours
//     ago (`agentMail.endedActorAgeDistorted` on every such row). The lease
//     itself is expired, which is the state a two-day-old 3600 s lease is in.
//
// THE SEAT (the design question the skeleton left open). Agent Mail delivers to
// NAMED mailboxes (`broadcast` is rejected; the v0.3.39 `project:<slug>` mailbox
// reaches only agents registered BEFORE the send — "an agent that joins later
// is not handed the backlog", verified), and `send_message` refuses a name that
// is not registered. The agent under test has no name until it registers, and
// Agent Mail's own blurb prescribes no fixed name (it says "register an
// identity" and recommends auto-generated names; the `AGENT_NAME` env var its
// blurb mentions is read by the pre-commit guard only — `register_agent`
// ignores it, verified). So the bench pre-registers ONE mailbox for the agent's
// seat, `BlueLake`, and adds one line after Agent Mail's blurb telling the agent
// that this checkout's mailbox is `BlueLake` (register with that name, read that
// inbox). The other session addresses `BlueLake`. This is the bench's reading
// of the product — a team that gives each seat a fixed Agent Mail name — chosen
// because it is the only documented route by which a note from a session that
// has ENDED reaches a session that starts later. It is stated here and in the
// README so no number is read as "Agent Mail's only possible behaviour". The
// agent registering under that name is Agent Mail's own "reusing the same name
// updates the profile" semantics (verified: the inbox is the seat's).
//
// TRANSPORT. One `am serve-http --no-tui --no-auth` per run, on a free loopback
// port, STORAGE_ROOT inside the run's throwaway home; the actor and the agent
// are HTTP clients of it (`type: "http"` for Claude Code, `url` for Codex). This
// is the configuration Agent Mail's installer writes ("configure clients with
// the HTTP URL whenever `am` runs"). The stdio entry (`am serve-stdio`) was
// tried first and is not usable here: one stdio server owns the storage root,
// and starting a second against the same root closed the first's connection
// (verified 2026-11-08) — so a live peer or a mid-task sender could never
// coexist with the agent's own server over stdio.
//
// WHAT THE REPO GETS: Agent Mail's own blurb appended to AGENTS.md and CLAUDE.md
// by `am docs insert-blurbs` (byte for byte what the product writes, between
// `<!-- am:blurb -->` markers), plus the bench's one seat line. No MCP config is
// written into the repo (the harness supplies the server), no pre-commit guard
// is installed (it would need the `mcp-agent-mail-guard` hook and AGENT_NAME in
// the agent's shell; the blurb mentions it as a tip, not a step).
//
// Isolation: HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG_* and STORAGE_ROOT all
// inside the run's throwaway home; TUI off; the server is killed at cleanup.
// Agent Mail has no telemetry setting in its documented configuration and
// `am self-update` runs only when invoked. The `am` CLI is NOT on the agent's
// PATH: the MCP tools are the channel, as for KLYPIX and Concord.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** The adapter is verified against this release only; another version is not run. */
export const AGENT_MAIL_PINNED_VERSION = '0.3.40';
/** The folder holding the v0.3.40 release's `am` binary (Windows: `am.exe`, from the x64 zip). */
export const AGENT_MAIL_DIR_ENV = 'KLYPIX_BENCH_AGENT_MAIL_DIR';
export const AGENT_MAIL_WINDOWS_ASSET = 'mcp-agent-mail-x86_64-pc-windows-msvc.zip';
/** The agent's mailbox (the seat) and the other session's name — both from Agent Mail's own documentation. */
export const AGENT_MAIL_SEAT = 'BlueLake';
export const AGENT_MAIL_ACTOR = 'GreenCastle';
/** The smallest ttl the server accepts; a stopped session's lease is taken with it and waited out. */
export const AGENT_MAIL_ENDED_TTL_SEC = 60;
/** A live session's lease: the README's own example ttl. */
export const AGENT_MAIL_LIVE_TTL_SEC = 3600;
export const AGENT_MAIL_SERVER_NAME = 'agent-mail';
/** The bench's one addition after Agent Mail's blurb: which mailbox is this seat's. */
export const AGENT_MAIL_SEAT_LINE = [
  '<!-- bench:agent-mail-seat -->',
  `This checkout's Agent Mail mailbox is \`${AGENT_MAIL_SEAT}\`: register with \`register_agent(project_key=<this repo's absolute path>, name="${AGENT_MAIL_SEAT}", ...)\` and read your mail with \`fetch_inbox(project_key, agent_name="${AGENT_MAIL_SEAT}")\`. Other sessions of this project address you by that name.`,
  '<!-- bench:agent-mail-seat:end -->',
  '',
].join('\n');

const versionCache = new Map();
function amVersion(bin) {
  let key = bin;
  try { key = `${bin}:${fs.statSync(bin).mtimeMs}`; } catch { return null; }
  if (versionCache.has(key)) return versionCache.get(key);
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, TUI_ENABLED: 'false' } });
  const m = String(r.stdout || '').match(/\bam\s+(\d+\.\d+\.\d+)/);
  const v = r.status === 0 && m ? m[1] : null;
  versionCache.set(key, v);
  return v;
}

/** The pinned install, or why there is none to run. */
export function agentMailInstall(env = process.env, platform = process.platform) {
  const dir = env[AGENT_MAIL_DIR_ENV] || null;
  const asset = platform === 'win32' ? `the v${AGENT_MAIL_PINNED_VERSION} release's ${AGENT_MAIL_WINDOWS_ASSET}` : `the v${AGENT_MAIL_PINNED_VERSION} release binaries for this platform`;
  if (!dir) return { ok: false, dir, bin: null, version: null, reason: `Agent Mail ${AGENT_MAIL_PINNED_VERSION} is not installed for the bench (${AGENT_MAIL_DIR_ENV} unset: it names the folder holding \`am\` from ${asset}); adapter verified against ${AGENT_MAIL_PINNED_VERSION} only` };
  const bin = path.join(dir, platform === 'win32' ? 'am.exe' : 'am');
  if (!fs.existsSync(bin)) return { ok: false, dir, bin, version: null, reason: `no Agent Mail binary at ${bin} (${AGENT_MAIL_DIR_ENV} must name the folder holding \`am\` from ${asset}); adapter verified against ${AGENT_MAIL_PINNED_VERSION} only` };
  const version = amVersion(bin);
  if (version !== AGENT_MAIL_PINNED_VERSION) return { ok: false, dir, bin, version, reason: `Agent Mail ${version ?? '(unknown version)'} is installed at ${dir}; the adapter is verified against ${AGENT_MAIL_PINNED_VERSION} only and is not run against another version` };
  return { ok: true, dir, bin, version };
}

/** The environment every Agent Mail process of a run gets: pinned home, storage inside it, no TUI. */
export function agentMailEnv(home, storageRoot) {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    STORAGE_ROOT: storageRoot,
    TUI_ENABLED: 'false',
    LOG_LEVEL: 'warn',
  };
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const live = new Set();
const killTree = (child) => {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
  else { try { child.kill('SIGKILL'); } catch { /* */ } }
};
process.on('exit', () => { for (const c of live) killTree(c); });

/** One `am serve-http` for a run; resolves when its liveness endpoint answers. */
export async function startAgentMailServer({ bin, home, storageRoot, timeoutMs = 120_000 }) {
  fs.mkdirSync(storageRoot, { recursive: true });
  const port = await freePort();
  const env = { ...process.env, ...agentMailEnv(home, storageRoot) };
  const child = spawn(bin, ['serve-http', '--no-tui', '--no-auth', '--host', '127.0.0.1', '--port', String(port)], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(child);
  let log = '';
  const keep = (d) => { log += d; if (log.length > 20_000) log = log.slice(-20_000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = false;
  child.on('exit', () => { exited = true; live.delete(child); });
  const url = `http://127.0.0.1:${port}/mcp/`;
  const started = Date.now();
  let up = false;
  while (!up && Date.now() - started < timeoutMs && !exited) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health/liveness`); up = r.ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) { killTree(child); live.delete(child); throw new Error(`agent-mail: serve-http did not come up on port ${port} within ${Math.round((Date.now() - started) / 1000)} s${exited ? ' (process exited)' : ''}: ${log.slice(-600)}`); }
  return {
    url, port, pid: child.pid, startupMs: Date.now() - started,
    log: () => log,
    stop() { if (!exited) killTree(child); live.delete(child); },
  };
}

const jsonOf = (r) => { const text = (r?.content || []).map((c) => c.text || '').join('\n'); try { return JSON.parse(text); } catch { return text; } };

/** One client session against the run's server: connect, act, disconnect. */
export async function withAgentMail(url, fn, clientName = 'cobench-actor') {
  const client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const call = async (name, args, { allowError = false } = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const value = jsonOf(r);
      if (r.isError && !allowError) throw new Error(`agent-mail ${name}: ${typeof value === 'string' ? value.slice(0, 400) : JSON.stringify(value).slice(0, 400)}`);
      return { isError: !!r.isError, value, raw: r };
    };
    const read = async (uri) => {
      const r = await client.readResource({ uri });
      const text = (r.contents || []).map((c) => c.text || '').join('\n');
      try { return JSON.parse(text); } catch { return text; }
    };
    return await fn(call, read);
  } finally {
    try { await client.close(); } catch { /* */ }
  }
}

const PROGRAM_FOR_AGENT = { claude: 'claude-code', codex: 'codex-cli' };
const PROGRAM_FOR_CLIENT = { 'claude-code': 'claude-code', codex: 'codex-cli' };
const actorClient = (actor, agent) => (typeof actor.clientFor === 'function' ? actor.clientFor(agent) : (actor.client || 'claude-code'));
const compactText = (t) => String(t || '').replace(/\s+/g, ' ');
const first40 = (t) => compactText(t).slice(0, 40);
/** The lease's reason: the session's intent, and its branch when it has one (what a session would write). */
export const leaseReason = (actor) => `${actor.intent || 'Work in progress'}${actor.branch ? ` (branch ${actor.branch})` : ''}`;
const subjectFor = (actor) => String(actor.intent || 'Note from another session').slice(0, 80);

/** What the seat can see right now, read back through the server: inbox bodies, lease conflicts on the actor's files, every lease (expired included). */
async function readBack(url, { repoDir, slug, files }) {
  return withAgentMail(url, async (call, read) => {
    const inbox = (await call('fetch_inbox', { project_key: repoDir, agent_name: AGENT_MAIL_SEAT, include_bodies: true, mark_read: false, limit: 50 })).value;
    const bodies = (Array.isArray(inbox) ? inbox : []).map((m) => compactText(`${m.subject || ''} ${m.body_md || ''}`));
    let conflicts = null;
    if (files && files.length) conflicts = (await call('check_file_reservation_conflicts', { project_key: repoDir, agent_name: AGENT_MAIL_SEAT, paths: files })).value;
    const holders = new Set((conflicts?.conflicts || []).flatMap((c) => (c.holders || []).map((h) => h.agent)));
    let leases = [];
    try { const r = await read(`resource://file_reservations/${slug}?active_only=false`); leases = Array.isArray(r) ? r : (r?.reservations || []); } catch { leases = []; }
    const actorLeases = leases.filter((l) => l.agent === AGENT_MAIL_ACTOR && (files || []).includes(l.path_pattern));
    const agents = (await call('list_agents', { project_key: repoDir })).value;
    return { inbox, bodies, conflicts, actorHoldsFiles: holders.has(AGENT_MAIL_ACTOR), actorLeases, agents: Array.isArray(agents) ? agents : [] };
  }, 'cobench-readback');
}

/** Agent Mail's own instruction blurb, appended to AGENTS.md and CLAUDE.md the way `am docs insert-blurbs` does it. */
function installBlurb(install, repo, env) {
  const r = spawnSync(install.bin, ['docs', 'insert-blurbs', '--scan-dir', repo.dir, '--max-depth', '1', '--yes'], { cwd: repo.dir, encoding: 'utf8', timeout: 120_000, windowsHide: true, env: { ...process.env, ...env } });
  const files = ['AGENTS.md', 'CLAUDE.md'].filter((f) => /<!-- am:blurb -->[\s\S]*<!-- am:blurb:end -->/.test(repo.read(f) || ''));
  if (files.length !== 2) throw new Error(`agent-mail: \`am docs insert-blurbs\` did not write its blurb into both instruction files (got ${files.join(', ') || 'none'}; exit ${r.status}): ${String(r.stderr || r.stdout).slice(-400)}`);
  for (const f of files) repo.write(f, `${(repo.read(f) || '').replace(/\s*$/, '\n')}\n${AGENT_MAIL_SEAT_LINE}`);
  return files;
}

export const agentMail = {
  id: 'agent-mail',
  label: `MCP Agent Mail ${AGENT_MAIL_PINNED_VERSION} (server + its AGENTS.md blurb; a named seat mailbox)`,
  mcp: true,
  get runnable() { return agentMailInstall().ok; },
  get reason() { const i = agentMailInstall(); return i.ok ? null : i.reason; },
  serverInfo() { const i = agentMailInstall(); return { name: AGENT_MAIL_SERVER_NAME, version: i.version, pinned: AGENT_MAIL_PINNED_VERSION, dir: i.dir, ok: i.ok }; },
  /** Scenarios Agent Mail has no faithful shape for — never run, printed as n/a with the reason. */
  notApplicableFor(agent, scenario = null) {
    if (!scenario) return null;
    if (typeof scenario.klypixBrain === 'function') return "the brain is KLYPIX's own capture engine replaying brain_note calls; Agent Mail has no equivalent of that history";
    if ((scenario.history || []).length > 20) return 'Agent Mail keeps mail threads and leases, not a dated project log; six months of notes have no faithful Agent Mail shape (the history stays in the notes file only)';
    if (/^s9s-/.test(scenario.id)) return 'identical to S9 (only the KLYPIX work record differs; Agent Mail records no last words)';
    return null;
  },
  async prepare({ repo, scenario, agent = null, benchHome = null }) {
    const install = agentMailInstall();
    if (!install.ok) throw new Error(install.reason);
    const home = benchHome || os.homedir();
    const storageRoot = path.join(home, 'am');
    fs.mkdirSync(storageRoot, { recursive: true });
    const env = agentMailEnv(home, storageRoot);
    // What the product writes into the repository (before the server owns the store).
    const instructionFiles = installBlurb(install, repo, env);
    repo.commitAll('agent-mail: setup');

    const server = await startAgentMailServer({ bin: install.bin, home, storageRoot });
    const actor = scenario.actor || {};
    const program = PROGRAM_FOR_CLIENT[actorClient(actor, agent)] || 'claude-code';
    const seatProgram = PROGRAM_FOR_AGENT[agent?.id] || 'claude-code';
    const facts = scenario.facts;
    // A fact KLYPIX carries without anyone writing it (a work record, presence) is not mail here either.
    const written = facts.filter((f) => f.text != null && !f.klypixVia);
    const files = actor.files || [];
    const ended = !!(actor.closed && actor.endedAgoMs);
    const liveActor = files.length > 0 && !actor.closed;
    let slug = null; let lease = null; let waitedMs = 0;
    try {
      // The other session, through Agent Mail's own tools.
      await withAgentMail(server.url, async (call) => {
        const project = (await call('ensure_project', { human_key: repo.dir })).value;
        slug = project?.slug || null;
        if (!slug) throw new Error('agent-mail ensure_project: no slug');
        // The seat: the mailbox the agent is told to register as (see the file header).
        await call('register_agent', { project_key: repo.dir, name: AGENT_MAIL_SEAT, program: seatProgram, model: 'unknown' });
        await call('register_agent', { project_key: repo.dir, name: AGENT_MAIL_ACTOR, program, model: 'unknown', task_description: actor.intent || '' });
        if (files.length) {
          const r = (await call('file_reservation_paths', { project_key: repo.dir, agent_name: AGENT_MAIL_ACTOR, paths: files, exclusive: true, ttl_seconds: ended ? AGENT_MAIL_ENDED_TTL_SEC : AGENT_MAIL_LIVE_TTL_SEC, reason: leaseReason(actor) })).value;
          lease = { granted: (r?.granted || []).length, expiresTs: r?.granted?.[0]?.expires_ts || null, conflicts: (r?.conflicts || []).length };
          if (!lease.granted) throw new Error(`agent-mail: the other session's lease was not granted: ${JSON.stringify(r).slice(0, 300)}`);
        }
        for (const f of written) {
          await call('send_message', { project_key: repo.dir, sender_name: AGENT_MAIL_ACTOR, to: [AGENT_MAIL_SEAT], subject: subjectFor(actor), body_md: f.text, thread_id: `bench-${f.id}`, ack_required: false });
        }
        // A session that stopped holding a lease: wait for Agent Mail's own expiry to clear the paths.
        if (ended && files.length) {
          const t0 = Date.now();
          const deadline = t0 + (AGENT_MAIL_ENDED_TTL_SEC + 45) * 1000;
          for (;;) {
            const c = (await call('check_file_reservation_conflicts', { project_key: repo.dir, agent_name: AGENT_MAIL_SEAT, paths: files })).value;
            if (c?.conflict_free === true) break;
            if (Date.now() > deadline) break;
            await new Promise((r) => setTimeout(r, 2000));
          }
          waitedMs = Date.now() - t0;
        }
      });

      // Read back what the seat can see.
      const seen = await readBack(server.url, { repoDir: repo.dir, slug, files });
      const delivered = new Set();
      for (const f of facts) {
        if (f.klypixVia === 'presence') { if (seen.actorHoldsFiles) delivered.add(f.id); continue; }
        // A stopped session's work: its lease has expired by Agent Mail's rules and still names the work in its reason; no last words exist.
        if (f.klypixVia === 'work') { if (!seen.actorHoldsFiles && seen.actorLeases.some((l) => compactText(l.reason || '').includes(first40(actor.intent || '')))) delivered.add(f.id); continue; }
        if (f.text != null) { if (seen.bodies.some((b) => b.includes(first40(f.text)))) delivered.add(f.id); continue; }
        // An absence: the stopped session's lease is expired (the paths are clear) and no mail carries the stale words.
        const staleWords = f.staleLine ? first40(f.staleLine.replace(/^- /, '')) : null;
        const mailFree = !staleWords || !seen.bodies.some((b) => b.includes(staleWords));
        if (ended && seen.actorLeases.length && !seen.actorHoldsFiles && mailFree) delivered.add(f.id);
      }
      if (liveActor && !seen.actorHoldsFiles) delivered.clear();
      const actorRow = seen.agents.find((a) => a.name === AGENT_MAIL_ACTOR) || null;

      const touch = () => withAgentMail(server.url, async (call) => {
        await call('register_agent', { project_key: repo.dir, name: AGENT_MAIL_ACTOR, program, model: 'unknown', task_description: actor.intent || '' });
        if (files.length) await call('renew_file_reservations', { project_key: repo.dir, agent_name: AGENT_MAIL_ACTOR, extend_seconds: AGENT_MAIL_LIVE_TTL_SEC }, { allowError: true });
      }, 'cobench-heartbeat');
      return {
        relays: 0,
        delivered: [...delivered],
        channelServer: { name: AGENT_MAIL_SERVER_NAME, version: install.version },
        agentMail: {
          seat: AGENT_MAIL_SEAT, actor: AGENT_MAIL_ACTOR, url: server.url, slug, instructionFiles, startupMs: server.startupMs,
          lease, waitedForExpiryMs: waitedMs, actorHoldsFiles: seen.actorHoldsFiles, actorLeases: seen.actorLeases.length,
          actorLastActiveTs: actorRow?.last_active_ts || null,
          // Agent Mail stamps "now": a session that stopped endedAgoMs ago reads as active about a minute ago.
          endedActorAgeDistorted: ended ? true : null,
        },
        mcpServers: { [AGENT_MAIL_SERVER_NAME]: { type: 'http', url: server.url } },
        heartbeat: liveActor ? () => { touch().catch(() => { /* the next beat retries */ }); } : null,
        cleanup() { server.stop(); },
      };
    } catch (err) {
      server.stop();
      throw err;
    }
  },
  // Mid-task: the other session mails its decision to the seat. Agent Mail has
  // no push; the agent sees it at its next fetch_inbox (or inbox resource read).
  // The mailbox is what is read back; "posted" means the mail is in it.
  async later({ repo, scenario, agent = null, prep = null }) {
    const url = prep?.agentMail?.url;
    if (!url) throw new Error('agent-mail later(): no server url from prepare');
    const actor = scenario.actor || {};
    const program = PROGRAM_FOR_CLIENT[actorClient(actor, agent)] || 'claude-code';
    const facts = scenario.later?.facts || [];
    await withAgentMail(url, async (call) => {
      await call('register_agent', { project_key: repo.dir, name: AGENT_MAIL_ACTOR, program, model: 'unknown', task_description: actor.intent || '' });
      for (const f of facts) {
        if (f.text == null) continue;
        await call('send_message', { project_key: repo.dir, sender_name: AGENT_MAIL_ACTOR, to: [AGENT_MAIL_SEAT], subject: subjectFor(actor), body_md: f.text, thread_id: `bench-${f.id}`, ack_required: false });
      }
    }, 'cobench-later');
    const seen = await readBack(url, { repoDir: repo.dir, slug: prep.agentMail.slug, files: [] });
    const delivered = facts.filter((f) => f.text != null && seen.bodies.some((b) => b.includes(first40(f.text)))).map((f) => f.id);
    return { delivered, notePosted: facts.filter((f) => f.text != null).length ? delivered.length === facts.filter((f) => f.text != null).length : null };
  },
};
