// Hookless, agent-neutral presence over the MCP connection lifecycle.
//
// Connecting the KLYPIX MCP server is already an explicit user authorization.
// Every stdio server process therefore registers one live session, heartbeats
// while the connection is open, and removes only its own MCP channel on close.
// Host hooks may enrich the same session id with prompt/file detail, but are not
// required for truthful active-session counts or pull-based message delivery.
import crypto from 'crypto';
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import {
  codexToolActionId,
  findProjectBrain,
  formatPresenceMessage,
  formatReceivedMessages,
  laneFileFor,
  listActiveSessions,
  messageDeliveryReceipt,
  messageDecayInfo,
  peekMessages,
  pinLaneIdentity,
  postPresenceMessage,
  receiveMessages,
  rekeySessionIdentity,
  rotateEndedSessionIdentity,
  removeSession,
  sessionDeliveryReachability,
  shortestUniqueSessionPrefix,
  switchMcpSessionIdentity,
  upsertSession,
} from './agent-presence.mjs';
// ONE definition of the file key. Exact-overlap detection (here) and finding
// ROUTING (there) must agree byte for byte — a file "owned" by a peer under one
// normalizer and not the other is a route that silently never happens. The
// canonical copy lives in the pure module because that one is import-restricted
// (crypto only), so it can never grow a dependency this file would inherit.
import { normalizeFileKey } from './finding-routing.mjs';
import { collectRepoState, repoStateWarnings } from './repo-state.mjs';
import { recordResultManifests } from './result-reconcile.mjs';

export const MCP_HEARTBEAT_MS = 60_000;
export const MCP_INBOX_POLL_MS = 3_000;
// Turn-end vs task-end (2026-08-14 wave): a phase "complete" carrying no result
// evidence, landing this soon after the worker's task start with NO intervening
// checkpoint, is mechanically indistinguishable from a per-turn sign-off (the
// tool instruction reads per-turn to Codex). Such a complete is downgraded to a
// scope-preserving checkpoint instead of wiping declared intent/files mid-task.
export const PREMATURE_COMPLETE_WINDOW_MS = 3 * 60 * 1000;

// Standard MCP server instructions are the approval-free awareness path. Hosts
// that surface InitializeResult.instructions to the model learn the same
// contract as Codex's managed AGENTS.md block; neither path executes local
// commands or crosses Codex's hook-trust boundary.
export const KLYPIX_MCP_INSTRUCTIONS = [
  'KLYPIX is the shared project brain for repositories containing ./brain.klypix.',
  'At the start of each task, call brain_sync with the current project root, a one-sentence intent, and any expected files before editing; the explicit project root keeps separate repositories on separate brains even when an MCP host launches servers from its own install directory.',
  'A session that never calls brain_sync appears to every peer as a connection with no declared scope — sync early so concurrent sessions can coordinate with you.',
  'Use its active-task, message, and file-overlap report to coordinate concurrent work.',
  'A coordination note is not consumed merely because it was offered: after a later independent KLYPIX action acknowledges the offer, call brain_message_receipt with its exact message id and offer token only when you actually incorporated it into your work.',
  'Call brain_sync again when your file scope materially changes, and with phase "complete" before your final response.',
  'When a task publishes a quantified or otherwise machine-checkable claim, include its validated result manifest in the completion sync; conflicting or incomparable peer results retain the task scope until reconciled.',
  'Do not read the full brain brief unless brain_sync says its compact context is insufficient or the task asks for broad history/status; use brain_ask for deeper retrieval.',
  'Capture only durable decisions or milestones with brain_note.',
  'Never hand-edit brain.klypix. If the current project has no brain.klypix, ignore this workflow.',
].join(' ');

const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const EXACT_FILE_MAX_CHARS = 512;
const EXACT_FILE_MAX_COUNT = 20;
const GLOB_FILE_CHARS = new Set(['*', '?', '[', ']', '{', '}']);

const fileScopeError = (index, code, message, value) => ({
  index,
  code,
  message,
  ...(typeof value === 'string' ? { file: value.slice(0, EXACT_FILE_MAX_CHARS) } : {}),
});

const pathIsInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
};

// brain_sync coordinates exact FILE ownership. Accepting directories, globs,
// absolute paths, or alternate spellings (./x, x//y, x\\y) makes two sessions
// describe the same file with different keys and silently defeats the warning.
// Validate before ANY task/result/presence mutation; missing future files are
// valid, but their nearest existing parent must still resolve inside the project.
export function validateExactFileScope(files, { projectRoot } = {}) {
  if (!Array.isArray(files)) {
    return {
      ok: false,
      files: [],
      errors: [fileScopeError(null, 'files-not-array', '`files` must be an array of exact project-relative file paths')],
    };
  }
  if (files.length > EXACT_FILE_MAX_COUNT) {
    return {
      ok: false,
      files: [],
      errors: [fileScopeError(null, 'files-too-many', `\`files\` may contain at most ${EXACT_FILE_MAX_COUNT} exact paths`)],
    };
  }

  const root = path.resolve(projectRoot || process.cwd());
  let realRoot = root;
  try { realRoot = fs.realpathSync.native(root); } catch { /* a not-yet-created project has lexical containment only */ }
  const errors = [];
  const seen = new Map();

  for (let index = 0; index < files.length; index++) {
    const value = files[index];
    if (typeof value !== 'string') {
      errors.push(fileScopeError(index, 'file-not-string', `files[${index}] must be a string`, value));
      continue;
    }
    if (!value.length || !value.trim()) {
      errors.push(fileScopeError(index, 'file-empty', `files[${index}] must not be empty`, value));
      continue;
    }
    if (value.length > EXACT_FILE_MAX_CHARS) {
      errors.push(fileScopeError(index, 'file-too-long', `files[${index}] exceeds ${EXACT_FILE_MAX_CHARS} characters`, value));
      continue;
    }
    if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
      errors.push(fileScopeError(index, 'file-noncanonical', `files[${index}] must not contain surrounding whitespace or control characters`, value));
      continue;
    }
    if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
      errors.push(fileScopeError(index, 'file-absolute', `files[${index}] must be relative to the project root`, value));
      continue;
    }
    if (/^[A-Za-z]:/.test(value)) {
      errors.push(fileScopeError(index, 'file-noncanonical', `files[${index}] must not use a drive-relative path`, value));
      continue;
    }
    if (value.endsWith('/') || value.endsWith('\\')) {
      errors.push(fileScopeError(index, 'file-trailing-slash', `files[${index}] names a directory-like path; supply an exact file`, value));
      continue;
    }
    if (value.includes('\\') || value !== path.posix.normalize(value)
      || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      const escaping = value.split('/').includes('..');
      errors.push(fileScopeError(index, escaping ? 'file-escapes-project' : 'file-noncanonical',
        `files[${index}] must use canonical forward-slash project-relative form`, value));
      continue;
    }
    if ([...value].some((character) => GLOB_FILE_CHARS.has(character))) {
      errors.push(fileScopeError(index, 'file-glob-like', `files[${index}] must name one exact file, not a glob-like pattern`, value));
      continue;
    }

    const folded = value.toLowerCase();
    if (seen.has(folded)) {
      errors.push(fileScopeError(index, 'file-duplicate',
        `files[${index}] duplicates files[${seen.get(folded)}] after case folding`, value));
      continue;
    }
    seen.set(folded, index);

    const target = path.resolve(root, ...value.split('/'));
    if (!pathIsInside(root, target)) {
      errors.push(fileScopeError(index, 'file-escapes-project', `files[${index}] resolves outside the project root`, value));
      continue;
    }

    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        errors.push(fileScopeError(index, 'file-is-directory', `files[${index}] is an existing directory; supply exact files within it`, value));
        continue;
      }
      const realTarget = fs.realpathSync.native(target);
      if (!pathIsInside(realRoot, realTarget)) {
        errors.push(fileScopeError(index, 'file-escapes-project', `files[${index}] resolves through a link outside the project root`, value));
      }
      continue;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) {
        errors.push(fileScopeError(index, 'file-unverifiable', `files[${index}] could not be verified (${error?.code || 'filesystem error'})`, value));
        continue;
      }
      if (error?.code === 'ENOTDIR') {
        errors.push(fileScopeError(index, 'file-parent-not-directory', `files[${index}] has an existing parent that is not a directory`, value));
        continue;
      }
    }

    // The file may be created later. Resolve the nearest existing parent so an
    // existing symlink cannot turn that future path into an out-of-project file.
    let ancestor = path.dirname(target);
    while (pathIsInside(root, ancestor)) {
      try {
        const stat = fs.statSync(ancestor);
        if (!stat.isDirectory()) {
          errors.push(fileScopeError(index, 'file-parent-not-directory', `files[${index}] has an existing parent that is not a directory`, value));
        } else if (!pathIsInside(realRoot, fs.realpathSync.native(ancestor))) {
          errors.push(fileScopeError(index, 'file-escapes-project', `files[${index}] resolves through a link outside the project root`, value));
        }
        break;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) {
          errors.push(fileScopeError(index, 'file-unverifiable', `files[${index}] parent could not be verified (${error?.code || 'filesystem error'})`, value));
          break;
        }
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }

  return { ok: errors.length === 0, files: errors.length ? [] : [...files], errors };
}

const canonicalPathKey = (value) => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

// Node 18 exposes bigint dev/ino on every supported platform. Together with
// lstat identity (the junction/symlink object) and realpath identity (its
// target), this detects both a link retarget and an atomic file replacement.
// Do not include size/mtime: an in-place brain edit is not a routing change.
const filesystemIdentity = (target, { link = false } = {}) => {
  const stat = link
    ? fs.lstatSync(target, { bigint: true })
    : fs.statSync(target, { bigint: true });
  return [stat.dev, stat.ino, stat.mode, stat.birthtimeNs]
    .map((value) => String(value))
    .join(':');
};

const directProjectBrain = (projectRoot) => {
  for (const name of ['brain.klypix', 'brain.any']) {
    const candidate = path.join(projectRoot, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const realRoot = fs.realpathSync.native(projectRoot);
      const realBrain = fs.realpathSync.native(candidate);
      if (canonicalPathKey(path.dirname(realBrain)) !== canonicalPathKey(realRoot)) {
        return { ok: false, reason: 'project-brain-escapes-root', brainPath: null };
      }
      return {
        ok: true,
        brainPath: candidate,
        realRoot,
        realBrain,
        binding: Object.freeze({
          lexicalProject: path.resolve(projectRoot),
          canonicalProject: path.resolve(realRoot),
          lexicalBrain: path.resolve(candidate),
          canonicalBrain: path.resolve(realBrain),
          projectLinkIdentity: filesystemIdentity(projectRoot, { link: true }),
          projectObjectIdentity: filesystemIdentity(projectRoot),
          brainLinkIdentity: filesystemIdentity(candidate, { link: true }),
          brainObjectIdentity: filesystemIdentity(candidate),
        }),
      };
    } catch { /* try the alternate direct brain filename */ }
  }
  return { ok: false, reason: 'project-brain-missing', brainPath: null };
};

const sameProjectBinding = (binding) => {
  try {
    if (!binding || typeof binding !== 'object') return false;
    if (canonicalPathKey(fs.realpathSync.native(binding.lexicalProject))
      !== canonicalPathKey(binding.canonicalProject)) return false;
    if (canonicalPathKey(fs.realpathSync.native(binding.lexicalBrain))
      !== canonicalPathKey(binding.canonicalBrain)) return false;
    if (canonicalPathKey(path.dirname(binding.lexicalBrain))
      !== canonicalPathKey(binding.lexicalProject)) return false;
    if (canonicalPathKey(path.dirname(binding.canonicalBrain))
      !== canonicalPathKey(binding.canonicalProject)) return false;
    if (!fs.statSync(binding.lexicalProject).isDirectory()
      || !fs.statSync(binding.lexicalBrain).isFile()) return false;
    return filesystemIdentity(binding.lexicalProject, { link: true }) === binding.projectLinkIdentity
      && filesystemIdentity(binding.lexicalProject) === binding.projectObjectIdentity
      && filesystemIdentity(binding.lexicalBrain, { link: true }) === binding.brainLinkIdentity
      && filesystemIdentity(binding.lexicalBrain) === binding.brainObjectIdentity;
  } catch {
    return false;
  }
};

const syncPreflightFailure = ({ status, reason, requestedProject, errors = [] }) => {
  const invalidProject = status !== 'invalid-scope';
  const guidance = invalidProject
    ? 'Supply the nonempty absolute path of the exact existing project root that directly contains brain.klypix or brain.any.'
    : 'Use unique canonical forward-slash paths to individual files (for example `src/app.ts`); missing future files are allowed.';
  const headline = invalidProject
    ? 'KLYPIX project routing was not changed because `project` is not an exact project-brain root.'
    : 'KLYPIX task scope was not changed because `files` is not an exact-file declaration.';
  return {
    sessions: [],
    messages: [],
    notice: '',
    conflicts: [],
    resultConflicts: [],
    alertsQueued: [],
    laneWriteOk: null,
    laneWriteSkippedReason: status,
    deliveryWriteOk: null,
    deliveryWriteSkippedReason: status,
    isError: true,
    structured: {
      schemaVersion: 1,
      status,
      reason,
      requestedProject: requestedProject || null,
      ...(errors.length ? { errors } : {}),
      mutation: 'none',
      identityMutation: 'none',
      deliveryMutation: 'none',
      timingMs: { coordination: 0 },
    },
    text: [
      headline,
      ...errors.slice(0, 20).map((error) => `- ${error.message}`),
      guidance,
    ].join('\n'),
  };
};

// File-key normalization. `root` (optional) is the project root the two rows share
// — passing it folds an ABSOLUTE declaration and a REPO-RELATIVE one onto the same
// key. Without it, one session declaring "E:/repo/src/App.tsx" and another
// declaring "src/App.tsx" never matched, so the overlap warning silently never
// fired for the commonest mixed pair (2026-07-30 hardening). Defensive by design:
// a path that cannot be placed under `root` keeps the previous (absolute,
// lowercased) key, so an unrelated file still compares as itself and a
// declaration is never dropped.

// HISTORICAL RATIONALE BELOW IS SUPERSEDED by the explicit-ID rule that
// follows it; hostPid is retained only as transport ownership metadata.

// TWIN recognition: one logical session can (still) appear as two lane rows —
// its lifecycle id and an mcp-<pid> id — whenever id adoption failed. Rows that
// share a hostPid belong to ONE host process; treating the twin as a peer would
// raise a "blocking" file conflict against the session itself and queue it an
// overlap alert. Suppression is explicit (suspectedTwin), never silent.
//
// hostPid ALONE is not identity (2026-07-30 hardening). A pid number is only
// unique per machine and per moment: a lane read from a synced/shared home, or a
// recycled pid whose previous host died inside the 10-minute freshness window,
// made two UNRELATED sessions suppress each other's overlap warnings — and a
// MISSING warning is invisible, so nothing surfaced the mistake. Two extra
// discriminators are required, both drawn from fields the lane row already
// carries (see agent-presence.mjs upsertSession):
//   machine — must match when BOTH rows carry it. Absent on rows written by an
//             older build or by the lifecycle hook, so absence must not un-suppress
//             a genuine twin; it degrades to the previous behaviour.
//   client  — must match when BOTH are specifically known. 'mcp'/'unknown' are
//             placeholders (getClientVersion() is optional), so a generic value on
//             either side stays compatible. This is what separates a codex row from
//             a claude-code row that collided on one pid.
// A host pid is a process/container fact, never a logical-session identity.
// Codex intentionally runs independent threads below one desktop pid, so
// pid-based twin suppression hid real peers and real conflicts. Only an
// explicit host-provided logical id may pair otherwise-distinct rows. Missing
// ids fail open as distinct sessions.
export const isLogicalTwin = (peer, me) => Boolean(
  peer && me
  && peer.id !== me.id
  && compact(peer.logicalSessionId)
  && compact(me.logicalSessionId)
  && compact(peer.logicalSessionId) === compact(me.logicalSessionId),
);
// Compatibility export: matching hostPid/machine/client is now deliberately
// insufficient. Consumers should migrate to isLogicalTwin.
export const isSuspectedTwin = isLogicalTwin;

export function findPresenceConflicts(sessions, selfId, { projectRoot } = {}) {
  const active = Array.isArray(sessions) ? sessions : [];
  const me = active.find((session) => session.id === selfId);
  if (!me) return [];
  // The lane is per-brain, so every row in it shares one project root; this
  // session's own cwd is that root (mcp-presence sets it to dirname(brain.klypix),
  // and brain_sync's explicit `project` flows into it).
  const root = projectRoot || me.cwd || null;
  const mine = new Map((me.files || [])
    .map((file) => [normalizeFileKey(file, root), String(file || '').replace(/\\/g, '/')])
    .filter(([key]) => key));
  if (!mine.size) return [];
  const conflicts = [];
  for (const peer of active) {
    if (peer.id === selfId) continue;
    if (isSuspectedTwin(peer, me)) continue;   // own twin row — a session cannot conflict with itself
    const overlap = [...new Set((peer.files || [])
      .map((file) => normalizeFileKey(file, root))
      .filter((file) => mine.has(file))
      .map((file) => mine.get(file)))];
    if (!overlap.length) continue;
    conflicts.push({
      id: peer.id,
      client: peer.client,
      surface: peer.surface || null,
      branch: peer.branch || null,
      intent: peer.intent || '',
      files: overlap,
      kind: 'exact-file',
      severity: 'blocking',
      sameWorktree: normalizeFileKey(peer.cwd) === normalizeFileKey(me.cwd),
    });
  }
  return conflicts;
}

const isTaskSession = (session) =>
  Boolean(compact(session?.intent) || (Array.isArray(session?.files) && session.files.length));

const publicSession = (session, now) => {
  const transport = session?.transport && typeof session.transport === 'object'
    ? Object.fromEntries(Object.entries(session.transport).slice(0, 4).map(([channel, value]) => [
      String(channel).slice(0, 32),
      { status: String(value?.status || 'unknown').slice(0, 40) },
    ]))
    : {};
  return {
    id: String(session?.id || ''),
    client: session?.client || 'unknown',
    surface: session?.surface || null,
    branch: session?.branch || null,
    intent: session?.intent || '',
    intentAgeMs: session?.intentAt ? Math.max(0, now - Number(session.intentAt)) : null,
    intentSource: session?.intentSource || null,
    files: Array.isArray(session?.files) ? session.files : [],
    ageMs: Math.max(0, now - Number(session?.lastSeen || now)),
    deliveryReachability: session?.deliveryReachability || sessionDeliveryReachability(session),
    transport,
  };
};

export function buildPresenceSnapshot(sessions, selfId, { now = Date.now() } = {}) {
  const connected = Array.isArray(sessions) ? sessions : [];
  const self = connected.find((session) => session.id === selfId) || null;
  // A session's own twin rows are IT, not peers or background connections.
  const others = connected.filter((session) => session.id !== selfId && !isSuspectedTwin(session, self));
  const twinCount = connected.length - 1 - others.length;
  const tasks = others.filter(isTaskSession);
  return {
    connectionCount: connected.length - Math.max(0, twinCount),
    activeTaskCount: tasks.length + (self && isTaskSession(self) ? 1 : 0),
    // "background" here means SYNC-SILENT, not idle: a connection that never
    // declared a task may still be actively working — say so, don't bury it.
    backgroundConnectionCount: others.length - tasks.length,
    suspectedTwinCount: Math.max(0, twinCount),
    self: self ? publicSession(self, now) : null,
    peers: tasks.map((session) => publicSession(session, now)),
  };
}

function formatTaskPresence(snapshot, now = Date.now()) {
  const taskWord = snapshot.activeTaskCount === 1 ? 'task' : 'tasks';
  const connectionWord = snapshot.connectionCount === 1 ? 'connection' : 'connections';
  const lines = [
    `KLYPIX task presence: ${snapshot.activeTaskCount} active ${taskWord} across ${snapshot.connectionCount} live ${connectionWord}`
      + (snapshot.backgroundConnectionCount ? ` (${snapshot.backgroundConnectionCount} connected without a declared task — presence known, scope unknown)` : '') + '.',
  ];
  if (!snapshot.peers.length) {
    lines.push('No other DECLARED task is active; connections that never called brain_sync are not listed here — they may still be working (see the connection count above).');
    return lines.join('\n');
  }
  lines.push('Other active tasks:');
  // UUIDv7 peers started in the same window share a long time prefix — grow
  // each shown id (git short-hash style, floor 12) until it names one session.
  const prefixRows = [snapshot.self, ...snapshot.peers].filter(Boolean);
  for (const peer of snapshot.peers.slice(0, 8)) {
    const intentAgeMin = peer.intentAgeMs !== null ? Math.round(peer.intentAgeMs / 60_000) : null;
    const heartbeatMin = Math.round(peer.ageMs / 60_000);
    const intentAge = intentAgeMin !== null && intentAgeMin - heartbeatMin > 3 ? ` (intent set ${intentAgeMin}m ago)` : '';
    const details = [
      peer.client,
      peer.deliveryReachability && peer.deliveryReachability !== 'connected'
        ? `delivery ${peer.deliveryReachability}` : null,
      peer.branch ? `branch ${peer.branch}` : null,
      peer.intent ? `"${String(peer.intent).slice(0, 90)}"${intentAge}` : null,
      peer.files.length ? peer.files.slice(0, 4).join(', ') + (peer.files.length > 4 ? ` (+${peer.files.length - 4} more)` : '') : null,
    ].filter(Boolean);
    const shortId = shortestUniqueSessionPrefix(prefixRows, peer.id, 12) || String(peer.id).slice(0, 12);
    lines.push(`- ${shortId}: ${details.join(' | ')}`);
  }
  // v1.32.0 law: a truncated list must never render as a complete one.
  if (snapshot.peers.length > 8) lines.push(`- …and ${snapshot.peers.length - 8} more active task(s) not listed — brain_doctor shows all.`);
  lines.push(`Point-in-time as of ${new Date(now).toISOString().slice(11, 16)}Z — re-sync before acting on it.`);
  return lines.join('\n');
}

export function normalizeMcpClient(name) {
  const value = compact(name).toLowerCase();
  if (!value) return 'mcp';
  if (value.includes('codex')) return 'codex';
  if (value.includes('claude')) return 'claude-code';
  if (value.includes('cursor')) return 'cursor';
  if (value.includes('cline')) return 'cline';
  if (value.includes('windsurf')) return 'windsurf';
  if (value.includes('antigravity')) return 'antigravity';
  return value.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'mcp';
}

const LOGICAL_ID_MAX = 160;
const LOGICAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const boundedIdentityId = (value) => {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id.length > LOGICAL_ID_MAX || !LOGICAL_ID_RE.test(id)) return null;
  return id;
};

const requestActionId = (extra, turnMetadata, { toolName, toolInput } = {}) => {
  // A later MCP request is an independent model action even when it belongs to
  // the same Codex turn: the model received the prior tool result before it
  // chose the next call. Keep the turn id for traceability, but include the
  // request/progress id so brain_sync → brain_message_receipt can acknowledge
  // and consume in one turn. Same-call double transitions are prevented by the
  // worker's single decorator (brain_sync is never decorated a second time).
  const turnId = boundedIdentityId(turnMetadata?.turn_id);
  const sharedToolAction = codexToolActionId({
    turnId,
    toolUseId: turnMetadata?.tool_use_id,
    toolName,
    toolInput,
  });
  if (sharedToolAction) return sharedToolAction;
  const rawRequestId = extra?.requestId ?? extra?._meta?.progressToken ?? extra?.progressToken;
  const requestId = (typeof rawRequestId === 'string' || typeof rawRequestId === 'number')
    ? String(rawRequestId).trim().slice(0, LOGICAL_ID_MAX)
    : '';
  if (turnId && requestId) return `codex-turn:${turnId}:request:${requestId}`;
  if (turnId) return `codex-turn:${turnId}`;
  return requestId ? `mcp-request:${requestId}` : '';
};

const parseCodexTurnMetadata = (value) => {
  if (value === undefined) return { value: null, error: '' };
  if (value && typeof value === 'object' && !Array.isArray(value)) return { value, error: '' };
  if (typeof value !== 'string' || value.length > 16_384) {
    return { value: null, error: 'x-codex-turn-metadata is not a bounded object' };
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: 'x-codex-turn-metadata is not an object' };
    }
    return { value: parsed, error: '' };
  } catch {
    return { value: null, error: 'x-codex-turn-metadata is not valid JSON' };
  }
};

// Resolve a logical session only from Codex's host-authored MCP metadata. A
// turn_id/requestId identifies an ACTION, never a session. All independently
// supplied session candidates must agree; disagreement fails closed so a
// malformed request cannot rekey presence or consume another session's inbox.
export function resolveRequestIdentity(extra, { client, toolName, toolInput } = {}) {
  const normalizedClient = normalizeMcpClient(client);
  const meta = extra?._meta && typeof extra._meta === 'object' ? extra._meta : {};
  const parsedTurn = parseCodexTurnMetadata(meta['x-codex-turn-metadata']);
  const actionId = requestActionId(extra, parsedTurn.value, { toolName, toolInput });
  if (normalizedClient !== 'codex') {
    return { ok: true, status: 'ignored-non-codex', id: null, actionId };
  }
  if (parsedTurn.error) {
    return { ok: false, status: 'invalid', id: null, actionId, diagnostic: parsedTurn.error };
  }

  const rawCandidates = [];
  if (Object.prototype.hasOwnProperty.call(meta, 'threadId')) {
    rawCandidates.push(['threadId', meta.threadId]);
  }
  for (const key of ['session_id', 'thread_id']) {
    if (parsedTurn.value && Object.prototype.hasOwnProperty.call(parsedTurn.value, key)) {
      rawCandidates.push([`x-codex-turn-metadata.${key}`, parsedTurn.value[key]]);
    }
  }
  if (!rawCandidates.length) return { ok: true, status: 'absent', id: null, actionId };

  const candidates = rawCandidates.map(([source, value]) => ({
    source,
    id: boundedIdentityId(value),
  }));
  if (candidates.some((candidate) => !candidate.id)) {
    return {
      ok: false,
      status: 'invalid',
      id: null,
      actionId,
      diagnostic: 'Codex request identity contains an invalid or unbounded session id',
    };
  }
  const ids = new Set(candidates.map((candidate) => candidate.id));
  if (ids.size !== 1) {
    return {
      ok: false,
      status: 'mismatch',
      id: null,
      actionId,
      diagnostic: 'Codex request threadId/session_id/thread_id disagree',
    };
  }
  return {
    ok: true,
    status: 'resolved',
    id: candidates[0].id,
    actionId,
    source: 'mcp-request',
  };
}

function resolveMcpSessionSeed({
  env = process.env,
  pid = process.pid,
  nonce = crypto.randomBytes(6).toString('hex'),
} = {}) {
  const logicalEnvKeys = [
    'KLYPIX_SESSION_ID',
    'CODEX_THREAD_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_SESSION_ID',
    'CURSOR_SESSION_ID',
    'CLINE_SESSION_ID',
    'WINDSURF_SESSION_ID',
  ];
  for (const key of logicalEnvKeys) {
    const id = boundedIdentityId(env?.[key]);
    if (id) return { id, logicalSessionId: id, identitySource: 'host-env' };
  }
  const connectionId = boundedIdentityId(env?.KLYPIX_MCP_CONNECTION_ID);
  if (connectionId) return { id: connectionId, logicalSessionId: null, identitySource: null };
  return { id: `mcp-${pid}-${nonce}`, logicalSessionId: null, identitySource: null };
}

export function resolveMcpSessionId({
  env = process.env,
  pid = process.pid,
  nonce = crypto.randomBytes(6).toString('hex'),
} = {}) {
  return resolveMcpSessionSeed({ env, pid, nonce }).id;
}

// A result submission changes the completion contract for the CURRENT logical
// task: after malformed/conflicting evidence, a result-less retry must not be a
// bypass. Keep that one bit outside worker memory so hot reload, crash recovery,
// and hibernation cannot erase it. File existence is the fail-closed state; the
// payload is diagnostic only, so even a crash during the write leaves a safe
// marker. A fresh phase:start is the explicit boundary that clears it.
export function resultClaimMarkerFileFor(brainPath, sessionId, home) {
  if (!brainPath || !sessionId) return null;
  const lane = laneFileFor(brainPath, home);
  const sessionKey = crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 24);
  return lane.replace(/\.json$/, `.result-claim-${sessionKey}.pending`);
}

function readResultClaimPending({ brainPath, sessionId, home }) {
  const file = resultClaimMarkerFileFor(brainPath, sessionId, home);
  if (!file) return { ok: false, pending: true, reason: 'no-brain-or-session' };
  try {
    fs.statSync(file);
    return { ok: true, pending: true, file };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, pending: false, file };
    return { ok: false, pending: true, file, reason: error?.code || error?.message || 'marker-read-failed' };
  }
}

function markResultClaimPending({ brainPath, sessionId, home, at = Date.now() }) {
  const file = resultClaimMarkerFileFor(brainPath, sessionId, home);
  if (!file) return { ok: false, pending: true, reason: 'no-brain-or-session' };
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, JSON.stringify({ schemaVersion: 1, sessionId: String(sessionId), pendingAt: at }));
    try { fs.fsyncSync(fd); } catch { /* existence is already fail-closed */ }
    return { ok: true, pending: true, file, created: true };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      // File existence is the fail-closed semantic. Even an unusual existing
      // filesystem object at this exact private marker path preserves the
      // completion obligation; payload shape is deliberately non-authoritative.
      return { ok: true, pending: true, file, created: false };
    }
    // If creation succeeded but writing the diagnostic payload failed, the
    // marker still carries the required semantic and is therefore a success.
    try {
      if (fs.statSync(file)) return { ok: true, pending: true, file, created: true };
    } catch { /* report the original failure below */ }
    return { ok: false, pending: true, file, reason: error?.code || error?.message || 'marker-write-failed' };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* */ }
  }
}

function clearResultClaimPending({ brainPath, sessionId, home }) {
  const file = resultClaimMarkerFileFor(brainPath, sessionId, home);
  if (!file) return { ok: false, pending: true, reason: 'no-brain-or-session' };
  try {
    fs.unlinkSync(file);
    return { ok: true, pending: false, file };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, pending: false, file };
    return { ok: false, pending: true, file, reason: error?.code || error?.message || 'marker-clear-failed' };
  }
}

// The host-pid this server belongs to (Claude Code exports CLAUDE_PID to every
// child process). Used for the hostmap rotation below and for twin recognition.
export function resolveHostPid(env = process.env) {
  const pid = Number(env?.CLAUDE_PID || env?.KLYPIX_HOST_PID || 0);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

// Hostmap: the lifecycle hook writes `<lane>.hostmap.json` mapping its host
// process pid → the CURRENT session id on every prompt. A spawn-time env id
// goes stale when the MCP server outlives /clear or a resume (the server
// process persists; the session id rotates) — re-reading the hostmap on every
// touch keeps the adopted id current with zero agent cooperation.
function hostmapSessionState({ brainPath, hostPid, home, now = Date.now() } = {}) {
  if (!brainPath || !hostPid) return { status: 'absent', id: null };
  try {
    const file = laneFileFor(brainPath, home).replace(/\.json$/, '.hostmap');
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = map && typeof map === 'object' ? map[String(hostPid)] : null;
    if (!entry || !compact(entry.sessionId)) return { status: 'absent', id: null };
    if (now - Number(entry.ts || 0) > 10 * 60 * 1000) return { status: 'stale', id: null };   // stale mapping — host gone
    const mapped = compact(entry.sessionId).slice(0, 160);
    // The lifecycle writer updates hostmap + lane as two atomic files. If the
    // second rename fails, the sidecar can briefly be ahead. Adopt only once a
    // matching live lifecycle row for this host pid exists; otherwise an MCP
    // touch would create a blank B while A still owns the real lifecycle scope.
    const row = listActiveSessions({ brainPath, home, now }).find((session) => session.id === mapped);
    if (!row || !Array.isArray(row.channels) || !row.channels.includes('lifecycle')
      || Number(row.hostPid || 0) !== Number(hostPid)) {
      return { status: 'sidecar-ahead', id: mapped };
    }
    return { status: 'ready', id: mapped };
  } catch { return { status: 'unavailable', id: null }; }
}

export function hostmapSessionId(options = {}) {
  const resolved = hostmapSessionState(options);
  return resolved.status === 'ready' ? resolved.id : null;
}

function gitBranch(cwd) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1200,
    }).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

const peerFingerprint = (sessions, selfId) => (Array.isArray(sessions) ? sessions : [])
  .filter((session) => session.id !== selfId)
  .map((session) => [
    session.id,
    session.client,
    session.branch,
    session.intent,
    ...(Array.isArray(session.files) ? session.files : []),
  ].join('|'))
  .sort()
  .join('\n');

export function createMcpPresence({
  server,
  initialVault,
  env = process.env,
  home,
  heartbeatMs = MCP_HEARTBEAT_MS,
  inboxPollMs = MCP_INBOX_POLL_MS,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  // Narrow fault-injection seam for durability regressions. Production never
  // supplies it; keeping the injected surface at the semantic marker writer
  // avoids monkey-patching global fs methods in concurrent tests.
  markResultClaimPendingFn = markResultClaimPending,
  // Decay-aware LAST-KNOWN stamps (2026-07-28 post-mortem, class B): the
  // injected engine surface ({ classifyDecay, decayStaleMs, decayMessageStamp,
  // formatDecayAge } from klypix-format.mjs) that lets every MCP delivery
  // surface — pollInbox logging, touch/decorateToolResult notices, brain_sync
  // text + structured messages — stamp a stale build/deploy message as LAST
  // KNOWN. Injection (not an import) keeps this file builtin-only; absent or
  // partial (old bundle), delivery degrades to unstamped — never a throw.
  decay = {},
} = {}) {
  const seedIdentity = resolveMcpSessionSeed({ env });
  let sessionId = seedIdentity.id;
  let logicalSessionId = seedIdentity.logicalSessionId;
  let identitySource = seedIdentity.identitySource;
  const hostPid = resolveHostPid(env);
  // Best-available pid for lane-row correlation (2026-08-14 wave): a host that
  // declares no CLAUDE_PID/KLYPIX_HOST_PID (Codex today) still has a direct
  // parent, and that pid lets readers group this worker's row with its
  // lifecycle sibling. Provenance rides along: 'env' pids are host-declared and
  // safe to liveness-probe; a 'ppid' guess may be a transient wrapper, so the
  // dead-host sweep never probes it — correlation only. The hostmap path keeps
  // using ONLY the env pid (a guessed pid must never adopt a hostmap identity).
  const laneHostPid = hostPid
    || (Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null);
  const laneHostPidSource = hostPid ? 'env' : (laneHostPid ? 'ppid' : null);
  const effectiveInboxPollMs = Number(env?.KLYPIX_MCP_INBOX_POLL_MS)
    || Number(inboxPollMs)
    || MCP_INBOX_POLL_MS;
  let vault = path.resolve(initialVault || process.cwd());
  let brainPath = null;
  let brainLaneIdentity = null;
  let currentProjectBinding = null;
  let timer = null;
  let inboxTimer = null;
  let started = false;
  let lastPeers = '';
  let taskStartedAt = 0;
  // Turn-end heuristic input: has this task generation seen an explicit
  // checkpoint? A model that checkpoints treats the task as multi-step, so its
  // later complete is a deliberate task boundary, not a per-turn sign-off.
  let checkpointSinceTaskStart = false;
  let resultClaimsPending = false;
  let syncNudgeShown = false;
  let modelActionSequence = 0;
  const sentTexts = new Set();
  const notifiedConflicts = new Set();
  const announcedMessageIds = new Set();
  // Public preflight objects are capabilities, never the authority itself.
  // All trusted fields live only in these private WeakMaps so property mutation,
  // cloning, or replay cannot redirect a later sync.
  const pendingSyncPreflights = new WeakMap();
  const consumedSyncPreflights = new WeakMap();
  const authorizedSyncPreflights = new WeakMap();
  const syncInputKey = ({ project, projectProvided = project !== undefined, files, phase = 'checkpoint' } = {}) => JSON.stringify({
    projectProvided: Boolean(projectProvided),
    project: projectProvided ? project : null,
    files: files === undefined ? null : files,
    phase: ['start', 'checkpoint', 'complete'].includes(phase) ? phase : 'checkpoint',
  });

  // Semantic validation belongs before request-identity adoption. In
  // particular, an explicit project is a routing authority, not a cwd hint:
  // never resolve a relative value and never walk upward from the supplied
  // directory. The opaque token lets sync consume this exact checked snapshot
  // instead of repeating filesystem validation after identity has changed.
  const preflightSync = ({ project, projectProvided = project !== undefined, files, phase = 'checkpoint' } = {}) => {
    let requestedVault;
    let resultBrainPath;

    let projectBinding = null;
    if (projectProvided) {
      if (typeof project !== 'string' || !project.length || project.length > 4_096
        || project !== project.trim() || /[\u0000-\u001f\u007f]/.test(project)) {
        return {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-project',
            reason: 'project-empty-or-noncanonical',
            requestedProject: typeof project === 'string' ? project.slice(0, 512) : null,
          }),
        };
      }
      if (!path.isAbsolute(project)) {
        return {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-project',
            reason: 'project-not-absolute',
            requestedProject: project.slice(0, 512),
          }),
        };
      }
      requestedVault = path.resolve(project);
      try {
        if (!fs.statSync(requestedVault).isDirectory()) {
          return {
            ok: false,
            report: syncPreflightFailure({
              status: 'invalid-project',
              reason: 'project-not-directory',
              requestedProject: requestedVault,
            }),
          };
        }
      } catch {
        return {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-project',
            reason: 'project-not-existing-directory',
            requestedProject: requestedVault,
          }),
        };
      }
      const directBrain = directProjectBrain(requestedVault);
      if (!directBrain.ok) {
        return {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-project',
            reason: directBrain.reason,
            requestedProject: requestedVault,
          }),
        };
      }
      projectBinding = directBrain.binding;
      // Route only through the canonical objects captured above. A later
      // retarget of the caller's junction/symlink cannot redirect lane hashing,
      // result ledgers, registry writes, or brain reads after validation.
      requestedVault = projectBinding.canonicalProject;
      resultBrainPath = projectBinding.canonicalBrain;
    } else {
      requestedVault = vault;
      resultBrainPath = started && requestedVault === vault
        ? brainPath
        : findProjectBrain(requestedVault);
      if (resultBrainPath) {
        const directBrain = directProjectBrain(path.dirname(resultBrainPath));
        if (directBrain.ok) {
          projectBinding = directBrain.binding;
          resultBrainPath = projectBinding.canonicalBrain;
        }
      }
    }

    let declaredFiles = files;
    if (files !== undefined) {
      const checkedScope = validateExactFileScope(files, {
        projectRoot: resultBrainPath ? path.dirname(resultBrainPath) : requestedVault,
      });
      if (!checkedScope.ok) {
        return {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-scope',
            reason: 'invalid-file-scope',
            requestedProject: requestedVault,
            errors: checkedScope.errors,
          }),
        };
      }
      declaredFiles = checkedScope.files;
    }

    const capability = Object.freeze({ ok: true });
    pendingSyncPreflights.set(capability, Object.freeze({
      inputKey: syncInputKey({ project, projectProvided, files, phase }),
      projectProvided,
      requestedVault,
      resultBrainPath,
      declaredFiles: declaredFiles === undefined ? undefined : Object.freeze([...declaredFiles]),
      projectBinding,
      laneIdentity: projectBinding?.canonicalBrain || resultBrainPath || null,
      requestedProject: projectProvided ? project : requestedVault,
    }));
    return capability;
  };

  const consumeSyncPreflight = (preflight, input = {}) => {
    const snapshot = preflight && typeof preflight === 'object'
      ? pendingSyncPreflights.get(preflight)
      : null;
    if (!snapshot) {
      return {
        ok: false,
        report: syncPreflightFailure({
          status: 'invalid-preflight',
          reason: 'preflight-capability-invalid-or-replayed',
        }),
      };
    }
    pendingSyncPreflights.delete(preflight);
    if (snapshot.inputKey !== syncInputKey(input)) {
      return {
        ok: false,
        report: syncPreflightFailure({
          status: 'invalid-preflight',
          reason: 'preflight-input-changed',
          requestedProject: snapshot.requestedProject,
        }),
      };
    }
    if (snapshot.projectBinding && !sameProjectBinding(snapshot.projectBinding)) {
      return {
        ok: false,
        report: syncPreflightFailure({
          status: 'project-changed',
          reason: 'project-or-brain-identity-changed-after-preflight',
          requestedProject: snapshot.requestedProject,
        }),
      };
    }
    const consumed = Object.freeze({ ok: true });
    consumedSyncPreflights.set(consumed, snapshot);
    return consumed;
  };

  const revalidateConsumedSyncPreflight = (preflight, input = {}) => {
    const snapshot = preflight && typeof preflight === 'object'
      ? consumedSyncPreflights.get(preflight)
      : null;
    if (!snapshot || snapshot.inputKey !== syncInputKey(input)) {
      return {
        ok: false,
        report: syncPreflightFailure({
          status: 'invalid-preflight',
          reason: snapshot ? 'preflight-input-changed' : 'preflight-capability-invalid-or-replayed',
          requestedProject: snapshot?.requestedProject,
        }),
      };
    }
    consumedSyncPreflights.delete(preflight);
    if (snapshot.projectBinding && !sameProjectBinding(snapshot.projectBinding)) {
      return {
        ok: false,
        report: syncPreflightFailure({
          status: 'project-changed',
          reason: 'project-or-brain-identity-changed-after-preflight',
          requestedProject: snapshot.requestedProject,
        }),
      };
    }
    // This is the final, one-shot authorization point. The snapshot routes by
    // canonical project/brain paths, so retargeting the caller's lexical link
    // after authorization cannot redirect the operation. In particular, the
    // worker can now adopt request identity without needing an unsafe inverse
    // lane operation if a later lexical-path check observes a change.
    const authorized = Object.freeze({ ok: true });
    authorizedSyncPreflights.set(authorized, snapshot);
    return authorized;
  };

  const verifyProjectBinding = (binding) => !binding || sameProjectBinding(binding);
  const verifyCurrentProjectBinding = () => verifyProjectBinding(currentProjectBinding);
  const refreshCurrentProjectBinding = () => {
    if (!currentProjectBinding) return { ok: true, status: 'not-bound' };
    try {
      // Never start from the lexical path: if the project directory was
      // replaced with a junction, following it would "refresh" trust onto the
      // attacker-selected target. The captured canonical root itself must still
      // be the same directory object; only the direct brain file may have been
      // atomically replaced by a managed KLYPIX write.
      if (filesystemIdentity(currentProjectBinding.canonicalProject)
        !== currentProjectBinding.projectObjectIdentity) {
        return { ok: false, status: 'project-changed' };
      }
      if (canonicalPathKey(fs.realpathSync.native(currentProjectBinding.lexicalProject))
        !== canonicalPathKey(currentProjectBinding.canonicalProject)) {
        return { ok: false, status: 'project-changed' };
      }
      const refreshed = directProjectBrain(currentProjectBinding.canonicalProject);
      if (!refreshed.ok
        || canonicalPathKey(refreshed.binding.canonicalProject)
          !== canonicalPathKey(currentProjectBinding.canonicalProject)
        || path.basename(refreshed.binding.canonicalBrain)
          !== path.basename(currentProjectBinding.canonicalBrain)) {
        return { ok: false, status: 'project-changed' };
      }
      currentProjectBinding = Object.freeze({
        ...refreshed.binding,
        // Retain the caller's exact lexical root so later retargeting remains
        // observable; the refreshed brain identity comes only from canonical root.
        lexicalProject: currentProjectBinding.lexicalProject,
        lexicalBrain: path.join(
          currentProjectBinding.lexicalProject,
          path.basename(refreshed.binding.canonicalBrain),
        ),
        projectLinkIdentity: currentProjectBinding.projectLinkIdentity,
      });
      brainLaneIdentity = currentProjectBinding.canonicalBrain;
      pinLaneIdentity(brainPath, brainLaneIdentity);
      return { ok: true, status: 'refreshed' };
    } catch {
      return { ok: false, status: 'project-changed' };
    }
  };

  // Session-id rotation: the id is resolved once at spawn, but this server
  // process outlives /clear and session resume — the hook-written hostmap is
  // re-checked on every touch so the lane row follows the CURRENT session id
  // instead of silently mislabeling every later conversation (2026-07-29 audit).
  const adoptHostSession = (stamp, targetBrainPath = brainPath, {
    requireDestinationClaim = false,
    verifyBinding: verifyBindingFn = null,
  } = {}) => {
    try {
      if (!targetBrainPath || !hostPid) return { ok: true, status: 'not-applicable' };
      // Codex has many logical threads below one desktop parent. Its hostmap is
      // ambiguous by construction; only request metadata may rekey it.
      const info = clientInfo();
      if (verifyBindingFn && !verifyBindingFn()) {
        return { ok: false, status: 'project-changed', reason: 'project-or-brain-identity-changed-during-host-callback' };
      }
      if (info.client === 'codex') return { ok: true, status: 'not-applicable', clientInfo: info };
      const hostIdentity = hostmapSessionState({ brainPath: targetBrainPath, hostPid, home, now: stamp });
      if (verifyBindingFn && !verifyBindingFn()) {
        return { ok: false, status: 'project-changed', reason: 'project-or-brain-identity-changed-before-host-adoption' };
      }
      if (hostIdentity.status === 'sidecar-ahead') {
        return { ok: false, status: 'sidecar-ahead', mappedId: hostIdentity.id };
      }
      const mapped = hostIdentity.status === 'ready' ? hostIdentity.id : null;
      if (!mapped || mapped === sessionId) {
        return { ok: true, status: mapped ? 'current' : hostIdentity.status, clientInfo: info };
      }
      const previous = sessionId;
      const priorClaim = readResultClaimPending({ brainPath: targetBrainPath, sessionId: previous, home });
      const sameProject = targetBrainPath === brainPath;
      if (requireDestinationClaim
        || (sameProject && resultClaimsPending)
        || priorClaim.pending
        || !priorClaim.ok) {
        const destinationClaim = readResultClaimPending({
          brainPath: targetBrainPath,
          sessionId: mapped,
          home,
        });
        let migrated;
        try {
          migrated = markResultClaimPendingFn({ brainPath: targetBrainPath, sessionId: mapped, home, at: stamp });
        } catch (error) {
          migrated = { ok: false, reason: error?.code || error?.message || 'marker-write-threw' };
        }
        // The marker writer is an injected/fallible preparation callback. It may
        // yield to host code, so revalidate the exact project+brain objects before
        // committing either the source-marker clear or the lane identity change.
        // A marker created only for this aborted preparation is safe to unwind;
        // never attempt an inverse lane rekey after mutation has begun.
        if (verifyBindingFn && !verifyBindingFn()) {
          if (migrated?.created === true && destinationClaim.ok && !destinationClaim.pending) {
            clearResultClaimPending({ brainPath: targetBrainPath, sessionId: mapped, home });
          }
          return {
            ok: false,
            status: 'project-changed',
            mappedId: mapped,
            reason: 'project-or-brain-identity-changed-during-result-claim-preparation',
          };
        }
        if (!migrated.ok) {
          return {
            ok: false,
            status: 'result-claim-migration-failed',
            mappedId: mapped,
            reason: migrated.reason || 'marker-write-failed',
          };
        }
        if (priorClaim.ok) {
          // Destination-first: failure to clear the old marker leaves a safe
          // duplicate, never a missing obligation on the adopted identity.
          clearResultClaimPending({ brainPath: targetBrainPath, sessionId: previous, home });
        }
      }
      sessionId = mapped;
      logicalSessionId = mapped;
      identitySource = 'lifecycle-hostmap';
      // The old row's mcp channel is ours — release it so the lane never holds
      // two rows for one logical session longer than a single touch interval.
      removeSession({
        brainPath: targetBrainPath,
        id: previous,
        channel: 'mcp',
        expectedPid: process.pid,
        home,
        now: stamp,
      });
      lastPeers = '';
      return { ok: true, status: 'adopted', previous, sessionId, brainPath: targetBrainPath, clientInfo: info };
    } catch {
      // Ordinary hostmap I/O remains best-effort. A positively identified
      // sidecar-ahead state is returned above and must never be swallowed.
      return { ok: true, status: 'unavailable' };
    }
  };

  // A host can rotate its logical session id (/clear, resume) before the next
  // heartbeat. Message sending needs the current id BEFORE it snapshots target
  // recipients, so expose a read/identity refresh that does not consume inbox
  // messages or create a second delivery transition in the same tool action.
  const adoptRequestIdentity = (extra, { toolName, toolInput, verifyBinding: verifyBindingFn = null } = {}) => {
    const stamp = now();
    const hostIdentity = adoptHostSession(stamp, brainPath, { verifyBinding: verifyBindingFn });
    if (hostIdentity?.ok === false) {
      const sidecarAhead = hostIdentity.status === 'sidecar-ahead';
      return {
        ok: false,
        status: hostIdentity.status || 'hostmap-adoption-failed',
        id: null,
        actionId: codexToolActionId(extra, { toolName, toolInput }),
        sessionId,
        diagnostic: sidecarAhead
          ? `KLYPIX identity safety check deferred this action: lifecycle identity ${hostIdentity.mappedId || 'unknown'} is staged in the host sidecar but its exact live lifecycle row is not committed yet. No handler, presence identity, or queued-message delivery changed.`
          : `KLYPIX identity safety check deferred this action: durable result-claim state could not move to lifecycle identity ${hostIdentity.mappedId || 'unknown'} (${hostIdentity.reason || 'migration failed'}). No handler, presence identity, lane, or queued-message delivery changed.`,
      };
    }
    const info = hostIdentity.clientInfo || clientInfo();
    if (verifyBindingFn && !verifyBindingFn()) {
      return {
        ok: false,
        status: 'project-changed',
        id: null,
        actionId: codexToolActionId(extra, { toolName, toolInput }),
        sessionId,
        diagnostic: 'KLYPIX identity safety check deferred this action because the project or brain object changed during the host callback. No request identity or queued-message delivery changed.',
      };
    }
    const resolved = resolveRequestIdentity(extra, {
      client: info.client,
      toolName,
      toolInput,
    });
    if (!resolved.ok) {
      return {
        ...resolved,
        sessionId,
        diagnostic: `KLYPIX identity safety check deferred this action: ${resolved.diagnostic}. No presence identity or queued-message delivery changed.`,
      };
    }
    if (!resolved.id) return { ...resolved, sessionId, clientInfo: info };
    if (resolved.id === sessionId) {
      logicalSessionId = resolved.id;
      identitySource = 'mcp-request';
      return { ...resolved, status: 'current', sessionId, clientInfo: info };
    }

    const previous = sessionId;
    if (brainPath) {
      let rotation;
      try {
        rotation = rotateEndedSessionIdentity({
          brainPath,
          fromId: previous,
          toId: resolved.id,
          client: info.client,
          surface: info.surface,
          cwd: path.dirname(brainPath),
          hostPid: laneHostPid,
          hostPidSource: laneHostPidSource,
          home,
          now: stamp,
          expectedPid: process.pid,
        });
      } catch (error) {
        rotation = { ok: false, reason: error?.message || 'identity-rotation-threw' };
      }
      if (rotation?.ok === true) {
        // This is a new conversation, not a continuation of A. Leave A's
        // durable result marker keyed to A and reset only worker-local state.
        sessionId = resolved.id;
        logicalSessionId = resolved.id;
        identitySource = 'mcp-request';
        resultClaimsPending = false;
        taskStartedAt = 0;
        checkpointSinceTaskStart = false;
        lastPeers = '';
        sentTexts.clear();
        notifiedConflicts.clear();
        announcedMessageIds.clear();
        return { ...resolved, status: 'rotated-after-end', sessionId, clientInfo: info };
      }
      if (rotation?.reason !== 'source-not-ended') {
        return {
          ok: false,
          status: 'rotation-failed',
          id: null,
          actionId: resolved.actionId,
          sessionId,
          diagnostic: `KLYPIX identity safety check deferred this action: ended-session rotation could not be verified (${rotation?.reason || 'unknown error'}). No presence identity or queued-message delivery changed.`,
        };
      }

      // Once this worker already holds an exact host-authored logical id, a
      // different exact request id is a new conversation even if lifecycle
      // SessionEnd(A) is still in flight. Provisional rekey semantics would
      // incorrectly move A's scope, aliases, authorship, and message audience
      // onto B. Switch only this MCP channel under the lane lock instead.
      const previousWasExact = logicalSessionId === previous
        && ['mcp-request', 'host-env'].includes(String(identitySource || ''));
      if (previousWasExact) {
        let switched;
        try {
          switched = switchMcpSessionIdentity({
            brainPath,
            fromId: previous,
            toId: resolved.id,
            client: info.client,
            surface: info.surface,
            cwd: path.dirname(brainPath),
            hostPid: laneHostPid,
            hostPidSource: laneHostPidSource,
            home,
            now: stamp,
            expectedPid: process.pid,
          });
        } catch (error) {
          switched = { ok: false, reason: error?.message || 'identity-switch-threw' };
        }
        if (switched?.ok !== true) {
          return {
            ok: false,
            status: 'switch-failed',
            id: null,
            actionId: resolved.actionId,
            sessionId,
            diagnostic: `KLYPIX identity safety check deferred this action: the live session switch could not be recorded (${switched?.reason || 'unknown error'}). No presence identity or queued-message delivery changed.`,
          };
        }
        sessionId = resolved.id;
        logicalSessionId = resolved.id;
        identitySource = 'mcp-request';
        resultClaimsPending = false;
        taskStartedAt = 0;
        checkpointSinceTaskStart = false;
        lastPeers = '';
        sentTexts.clear();
        notifiedConflicts.clear();
        announcedMessageIds.clear();
        return { ...resolved, status: 'switched-live-session', sessionId, clientInfo: info };
      }
    }
    const priorClaim = brainPath
      ? readResultClaimPending({ brainPath, sessionId: previous, home })
      : { ok: true, pending: resultClaimsPending };
    if (brainPath && (resultClaimsPending || priorClaim.pending || !priorClaim.ok)) {
      const destinationClaim = readResultClaimPending({ brainPath, sessionId: resolved.id, home });
      let marker;
      try {
        marker = markResultClaimPendingFn({
          brainPath,
          sessionId: resolved.id,
          home,
          at: stamp,
        });
      } catch (error) {
        marker = { ok: false, reason: error?.code || error?.message || 'marker-write-threw' };
      }
      // Identity migration has a strict prepare/commit boundary: the fallible
      // destination marker completes first, then the exact binding is checked,
      // and only then may rekeySessionIdentity mutate the lane. If the callback
      // retargeted a junction, unwind only our freshly-created preparation marker.
      if (verifyBindingFn && !verifyBindingFn()) {
        if (marker?.created === true && destinationClaim.ok && !destinationClaim.pending) {
          clearResultClaimPending({ brainPath, sessionId: resolved.id, home });
        }
        return {
          ok: false,
          status: 'project-changed',
          id: null,
          actionId: resolved.actionId,
          sessionId,
          diagnostic: 'KLYPIX identity safety check deferred this action because the project or brain object changed during result-claim preparation. No presence identity, lane, or queued-message delivery changed.',
        };
      }
      if (!marker.ok) {
        return {
          ok: false,
          status: 'rekey-failed',
          id: null,
          actionId: resolved.actionId,
          sessionId,
          diagnostic: `KLYPIX identity safety check deferred this action: result-claim state could not be migrated (${marker.reason}). No presence identity or queued-message delivery changed.`,
        };
      }
    }

    if (brainPath) {
      let rekey;
      try {
        rekey = rekeySessionIdentity({
          brainPath,
          fromId: previous,
          toId: resolved.id,
          home,
          now: stamp,
          expectedPid: process.pid,
        });
      } catch (error) {
        rekey = { ok: false, reason: error?.message || 'identity-rekey-threw' };
      }
      if (rekey?.ok !== true) {
        return {
          ok: false,
          status: 'rekey-failed',
          id: null,
          actionId: resolved.actionId,
          sessionId,
          diagnostic: `KLYPIX identity safety check deferred this action: the presence lane could not be rekeyed (${rekey?.reason || 'unknown error'}). No presence identity or queued-message delivery changed.`,
        };
      }
      if ((resultClaimsPending || priorClaim.pending || !priorClaim.ok) && priorClaim.ok) {
        // Destination was written first (fail-closed); source is removed only
        // after the atomic lane rekey succeeds. A failed unlink leaves a safe,
        // stale duplicate marker rather than losing the completion obligation.
        clearResultClaimPending({ brainPath, sessionId: previous, home });
      }
    }

    sessionId = resolved.id;
    logicalSessionId = resolved.id;
    identitySource = 'mcp-request';
    lastPeers = '';
    announcedMessageIds.clear();
    return { ...resolved, status: 'adopted', sessionId, clientInfo: info };
  };

  const refreshIdentity = () => {
    adoptHostSession(now());
    return sessionId;
  };

  const clientInfo = () => {
    let version = {};
    try { version = server?.server?.getClientVersion?.() || {}; } catch { /* optional */ }
    return {
      client: normalizeMcpClient(version.name),
      surface: compact(version.name) || 'mcp',
    };
  };

  const sendNotice = (message) => {
    if (!message || typeof server?.sendLoggingMessage !== 'function') return false;
    Promise.resolve(server.sendLoggingMessage({
      level: 'info',
      logger: 'klypix-presence',
      data: message,
    })).catch(() => {});
    return true;
  };

  // Best-effort proactive path: MCP logging notifications can surface an
  // overlap while the older session is still working. This deliberately PEEKS
  // instead of acknowledging. Hosts are allowed to hide logging notifications,
  // so the same warning remains unread and is guaranteed to arrive in-band on
  // the next KLYPIX tool result / brain_sync call.
  const pollInbox = () => {
    if (!brainPath) return [];
    const identity = adoptHostSession(now());
    if (identity?.ok === false) return [];
    const pending = peekMessages({
      brainPath,
      sessionId,
      ignoreTexts: [...sentTexts],
      home,
      now: now(),
    }).filter((message) => !announcedMessageIds.has(message.id));
    if (!pending.length) return [];
    if (sendNotice(formatReceivedMessages(pending, now(), decay, sessionId))) {
      for (const message of pending) announcedMessageIds.add(message.id);
      while (announcedMessageIds.size > 100) {
        announcedMessageIds.delete(announcedMessageIds.values().next().value);
      }
    }
    return pending;
  };

  const touch = ({
    event = 'McpHeartbeat',
    includePresence = false,
    includeSolo = false,
    deliverMessages = false,
    intent,
    files,
    replaceFiles = false,
    actionId = '',
    hostIdentityPrepared = false,
    clientInfoPrepared = null,
    branchPrepared,
  } = {}) => {
    if (!brainPath) return { sessions: [], messages: [], notice: '', laneWriteOk: null, laneWriteSkippedReason: 'no-lane' };
    const stamp = now();
    const identity = hostIdentityPrepared
      ? { ok: true, status: 'prepared' }
      : adoptHostSession(stamp);
    if (identity?.ok === false) {
      return {
        sessions: listActiveSessions({ brainPath, home, now: stamp }),
        messages: [],
        notice: '',
        laneWriteOk: false,
        laneWriteSkippedReason: `identity-${identity.status || 'adoption-failed'}`,
        deliveryWriteOk: false,
        deliveryWriteSkippedReason: `identity-${identity.status || 'adoption-failed'}`,
      };
    }
    const { client, surface } = clientInfoPrepared || clientInfo();
    const sessions = upsertSession({
      brainPath,
      id: sessionId,
      client,
      surface,
      branch: branchPrepared !== undefined
        ? branchPrepared
        : gitBranch(path.dirname(brainPath)),
      intent,
      intentSource: intent !== undefined ? 'declared' : null,
      files,
      replaceFiles,
      event,
      channel: 'mcp',
      cwd: path.dirname(brainPath),
      hostPid: laneHostPid,
      hostPidSource: laneHostPidSource,
      logicalSessionId,
      identitySource,
      home,
      now: stamp,
    });
    let messages = [];
    let deliveryWriteOk = null;
    let deliveryWriteSkippedReason = null;
    if (deliverMessages && sessions?.laneWriteOk === false) {
      // Identity/presence mutation did not land, so do not advance a receipt in
      // a separate lock acquisition and pretend the overall action was durable.
      deliveryWriteOk = false;
      deliveryWriteSkippedReason = 'presence-lane-write-failed';
    } else if (deliverMessages) {
      try {
        messages = receiveMessages({
          brainPath,
          sessionId,
          ignoreTexts: [...sentTexts],
          home,
          now: stamp,
          actionId,
        });
        deliveryWriteOk = messages?.deliveryWriteOk ?? null;
        deliveryWriteSkippedReason = messages?.deliveryWriteSkippedReason ?? null;
      } catch (error) {
        messages = [];
        deliveryWriteOk = false;
        deliveryWriteSkippedReason = `write-failed:${String(error?.code || error?.message || 'unknown').slice(0, 80)}`;
      }
    }
    if (deliverMessages) sentTexts.clear();

    const nextPeers = peerFingerprint(sessions, sessionId);
    const presenceChanged = nextPeers !== lastPeers;
    lastPeers = nextPeers;
    const presence = (includePresence || presenceChanged)
      ? formatPresenceMessage(sessions, sessionId, { includeSolo, now: stamp })
      : '';
    const notice = [
      presence,
      formatReceivedMessages(messages, stamp, decay, sessionId),
    ].filter(Boolean).join('\n\n');
    if (notice) sendNotice(notice);
    // Additive, non-breaking: surface whether this touch's lane write actually
    // landed (agent-presence.mjs withWriteVerdict). A lock timeout returns a
    // read-only peer snapshot that does NOT include this heartbeat, and that used
    // to be indistinguishable from a successful write. null = unknown (an older
    // bundled agent-presence.mjs that does not stamp the verdict).
    return {
      sessions,
      messages,
      notice,
      laneWriteOk: sessions?.laneWriteOk ?? null,
      laneWriteSkippedReason: sessions?.laneWriteSkippedReason ?? null,
      deliveryWriteOk,
      deliveryWriteSkippedReason,
    };
  };

  const stop = ({ sessionId: stopSessionId = sessionId } = {}) => {
    if (timer) clearIntervalFn(timer);
    if (inboxTimer) clearIntervalFn(inboxTimer);
    timer = null;
    inboxTimer = null;
    if (brainPath) removeSession({
      brainPath,
      id: stopSessionId,
      channel: 'mcp',
      expectedPid: process.pid,
      home,
      now: now(),
    });
    brainPath = null;
    brainLaneIdentity = null;
    currentProjectBinding = null;
    started = false;
    lastPeers = '';
    announcedMessageIds.clear();
  };

  const start = (nextVault = vault, details = {}, validatedSelection = null) => {
    const resolved = path.resolve(nextVault || vault);
    const selectedBrainPath = validatedSelection && Object.prototype.hasOwnProperty.call(validatedSelection, 'brainPath')
      ? validatedSelection.brainPath
      : undefined;
    if (started && resolved === vault
      && (selectedBrainPath === undefined || selectedBrainPath === brainPath)) {
      return touch({ event: 'McpReconnect', includePresence: true });
    }
    if (started) stop({
      sessionId: validatedSelection?.sourceSessionId || sessionId,
    });
    vault = resolved;
    brainPath = selectedBrainPath === undefined ? findProjectBrain(vault) : selectedBrainPath;
    if (!brainPath) return { sessions: [], messages: [], notice: '' };
    brainLaneIdentity = validatedSelection?.laneIdentity || brainPath;
    currentProjectBinding = validatedSelection?.projectBinding || null;
    pinLaneIdentity(brainPath, brainLaneIdentity);
    started = true;
    const first = touch({
      event: details.event || 'McpInitialize',
      includePresence: true,
      includeSolo: details.includeSolo === true,
      deliverMessages: details.deliverMessages === true,
      intent: details.intent,
      files: details.files,
      replaceFiles: details.replaceFiles === true,
      hostIdentityPrepared: details.hostIdentityPrepared === true,
      clientInfoPrepared: details.clientInfoPrepared || null,
      branchPrepared: details.branchPrepared,
      // Forward the action identity (2026-08-14 review): without it, every
      // server instance's FIRST sync advanced delivery receipts with
      // actionId '' — records got no offered/acknowledgedActionId, breaking
      // same-action dedupe and the lease's third-action evidence.
      actionId: details.actionId || '',
    });
    // Consume the write verdict (1.52.0 plumbed it; nothing read it): a
    // contended lane skips the write, and ~3 skipped heartbeats in a row used
    // to make a LIVE session read as dead to every peer, silently. One
    // immediate same-tick retry clears transient contention; persistent
    // failure is surfaced through the server's logging channel.
    let missedLaneWrites = 0;
    timer = setIntervalFn(() => {
      let beat = touch();
      if (beat?.laneWriteOk === false) beat = touch();   // one quick retry
      if (beat?.laneWriteOk !== false) { missedLaneWrites = 0; return; }
      missedLaneWrites++;
      if (missedLaneWrites >= 3) {
        try { server?.server?.sendLoggingMessage?.({ level: 'warning', data: `KLYPIX presence heartbeat skipped ${missedLaneWrites}× (lane contended) — peers may briefly see this session as idle.` }); } catch { /* logging is best-effort */ }
        missedLaneWrites = 0;
      }
    }, Math.max(5_000, Number(heartbeatMs) || MCP_HEARTBEAT_MS));
    inboxTimer = setIntervalFn(
      () => pollInbox(),
      Math.max(250, effectiveInboxPollMs),
    );
    timer?.unref?.();
    inboxTimer?.unref?.();
    return first;
  };

  const sync = ({
    project,
    intent,
    files,
    phase = 'checkpoint',
    results,
    deliverMessages = true,
    include_context,
    actionId = '',
    preflight,
    requestIdentity,
  } = {}) => {
    const syncStartedAt = Date.now();
    const nextPhase = ['start', 'checkpoint', 'complete'].includes(phase) ? phase : 'checkpoint';
    const completing = nextPhase === 'complete';
    const preflightInput = {
      project,
      projectProvided: project !== undefined,
      files,
      phase: nextPhase,
    };
    let checkedPreflight = null;
    if (preflight && typeof preflight === 'object' && authorizedSyncPreflights.has(preflight)) {
      checkedPreflight = authorizedSyncPreflights.get(preflight);
      authorizedSyncPreflights.delete(preflight);
      if (checkedPreflight.inputKey !== syncInputKey(preflightInput)) {
        checkedPreflight = {
          ok: false,
          report: syncPreflightFailure({
            status: 'invalid-preflight',
            reason: 'preflight-input-changed',
          }),
        };
      } else if (checkedPreflight.projectBinding
        && !sameProjectBinding(checkedPreflight.projectBinding)) {
        checkedPreflight = {
          ok: false,
          report: syncPreflightFailure({
            status: 'project-changed',
            reason: 'project-or-brain-identity-changed-after-authorization',
            requestedProject: checkedPreflight.requestedProject,
          }),
        };
      }
    } else {
      const candidate = preflight || preflightSync(preflightInput);
      if (!candidate.ok) checkedPreflight = candidate;
      else {
        const consumed = consumedSyncPreflights.has(candidate)
          ? candidate
          : consumeSyncPreflight(candidate, preflightInput);
        if (!consumed.ok) checkedPreflight = consumed;
        else {
          const authorized = revalidateConsumedSyncPreflight(consumed, preflightInput);
          if (!authorized.ok) checkedPreflight = authorized;
          else {
            checkedPreflight = authorizedSyncPreflights.get(authorized);
            authorizedSyncPreflights.delete(authorized);
          }
        }
      }
    }
    if (!checkedPreflight || checkedPreflight.ok === false) {
      const report = checkedPreflight?.report || syncPreflightFailure({
        status: 'invalid-preflight',
        reason: 'preflight-capability-invalid-or-replayed',
      });
      report.structured.phase = nextPhase;
      report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
      return report;
    }
    const {
      requestedVault,
      resultBrainPath,
      declaredFiles,
      projectBinding,
      laneIdentity,
    } = checkedPreflight;
    if (resultBrainPath && laneIdentity) pinLaneIdentity(resultBrainPath, laneIdentity);
    const verifiedBinding = () => verifyProjectBinding(projectBinding);
    const switchingProject = Boolean(started && resultBrainPath && resultBrainPath !== brainPath);
    const bindingTargetProject = Boolean(resultBrainPath && (!started || resultBrainPath !== brainPath));
    let sourceSessionIdForStop = switchingProject ? sessionId : null;
    let targetHostIdentityAdopted = false;
    let preparedClientInfo = requestIdentity?.clientInfo || null;
    // Request metadata is resolved (purely) by the worker before this call, but
    // committed only after the exact target project capability is authorized.
    // This prevents invalid brain_sync routing from rekeying the current lane.
    if (requestIdentity?.ok === false) {
      const report = syncPreflightFailure({
        status: requestIdentity.status || 'invalid-request-identity',
        reason: requestIdentity.diagnostic || requestIdentity.status || 'invalid-request-identity',
        requestedProject: checkedPreflight.requestedProject || requestedVault,
      });
      report.structured.phase = nextPhase;
      report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
      return report;
    }
    if (requestIdentity?.id && clientInfo().client !== 'codex') {
      const report = syncPreflightFailure({
        status: 'invalid-request-identity',
        reason: 'logical request identity is accepted only from Codex host metadata',
        requestedProject: checkedPreflight.requestedProject || requestedVault,
      });
      report.structured.phase = nextPhase;
      report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
      return report;
    }
    if (started && resultBrainPath && resultBrainPath === brainPath) {
      const hostAdoption = adoptHostSession(now(), brainPath, { verifyBinding: verifiedBinding });
      if (hostAdoption?.ok === false) {
        const durationMs = Math.max(0, Date.now() - syncStartedAt);
        return {
          sessions: [],
          messages: [],
          notice: '',
          conflicts: [],
          resultConflicts: [],
          alertsQueued: [],
          laneWriteOk: null,
          laneWriteSkippedReason: `identity-${hostAdoption.status || 'adoption-failed'}`,
          deliveryWriteOk: null,
          deliveryWriteSkippedReason: `identity-${hostAdoption.status || 'adoption-failed'}`,
          isError: true,
          structured: {
            schemaVersion: 1,
            status: hostAdoption.status || 'identity-adoption-failed',
            phase: nextPhase,
            reason: hostAdoption.reason || hostAdoption.status || 'identity-adoption-failed',
            requestedProject: checkedPreflight.requestedProject || requestedVault,
            mutation: 'none',
            identityMutation: 'none',
            deliveryMutation: 'none',
            timingMs: { coordination: durationMs },
          },
          text: `KLYPIX identity safety check deferred brain_sync before task, result, lane, registry, or message mutation (${hostAdoption.reason || hostAdoption.status || 'identity adoption failed'}). Retry after the exact lifecycle identity and durable result-claim state are available.`,
        };
      }
      preparedClientInfo = hostAdoption.clientInfo || preparedClientInfo;
    }
    if (bindingTargetProject) {
      // Cross-project routing must establish the target lane's exact lifecycle
      // identity before task timestamps, result markers/ledgers, or stop(A).
      // Unlike a same-project rotation, A's worker-local result obligation does
      // not belong to B; adoptHostSession therefore consults only B's durable
      // source marker when targetBrainPath differs from the current brain.
      const hostAdoption = adoptHostSession(now(), resultBrainPath, {
        requireDestinationClaim: results !== undefined,
        verifyBinding: verifiedBinding,
      });
      if (hostAdoption?.ok === false) {
        const durationMs = Math.max(0, Date.now() - syncStartedAt);
        return {
          sessions: [], messages: [], notice: '', conflicts: [], resultConflicts: [], alertsQueued: [],
          laneWriteOk: null,
          laneWriteSkippedReason: `identity-${hostAdoption.status || 'adoption-failed'}`,
          deliveryWriteOk: null,
          deliveryWriteSkippedReason: `identity-${hostAdoption.status || 'adoption-failed'}`,
          isError: true,
          structured: {
            schemaVersion: 1,
            status: hostAdoption.status || 'identity-adoption-failed',
            phase: nextPhase,
            reason: hostAdoption.reason || hostAdoption.status || 'identity-adoption-failed',
            requestedProject: checkedPreflight.requestedProject || requestedVault,
            mutation: 'none',
            identityMutation: 'none',
            deliveryMutation: 'none',
            timingMs: { coordination: durationMs },
          },
          text: `KLYPIX identity safety check deferred brain_sync before task, result, lane, registry, or message mutation (${hostAdoption.reason || hostAdoption.status || 'identity adoption failed'}). Retry after the target project's exact lifecycle identity and durable result-claim state are available.`,
        };
      }
      targetHostIdentityAdopted = hostAdoption.status === 'adopted';
      preparedClientInfo = hostAdoption.clientInfo || preparedClientInfo;
      if (switchingProject && targetHostIdentityAdopted) {
        sourceSessionIdForStop = hostAdoption.previous;
      }
    }
    if (requestIdentity?.id && requestIdentity.id !== sessionId) {
      // After target routing is authorized, use the existing adoption machinery
      // against the still-bound lane. Codex never consults a lifecycle hostmap;
      // all fallible target-host gating has already completed above.
      const adopted = adoptRequestIdentity({
        _meta: { threadId: requestIdentity.id },
      }, {
        toolName: 'brain_sync',
        toolInput: { project, files, phase: nextPhase },
        verifyBinding: verifiedBinding,
      });
      if (adopted?.ok === false) {
        const report = syncPreflightFailure({
          status: adopted.status || 'request-identity-adoption-failed',
          reason: adopted.diagnostic || adopted.status || 'request-identity-adoption-failed',
          requestedProject: checkedPreflight.requestedProject || requestedVault,
        });
        report.structured.phase = nextPhase;
        // Adoption failure paths are designed fail-closed before lane mutation.
        report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
        return report;
      }
      if (switchingProject && !targetHostIdentityAdopted) {
        sourceSessionIdForStop = sessionId;
      }
    }
    // All host/client callbacks that can run before coordination mutation have
    // completed. Guard the exact directory+brain objects one final time here;
    // every later lane/marker/ledger lookup is pinned to laneIdentity and cannot
    // be redirected by a lexical junction retarget.
    if (!preparedClientInfo) preparedClientInfo = clientInfo();
    const preparedBranch = resultBrainPath
      ? gitBranch(path.dirname(resultBrainPath))
      : null;
    if (!verifiedBinding()) {
      const report = syncPreflightFailure({
        status: 'project-changed',
        reason: 'project-or-brain-identity-changed-before-sync-mutation',
        requestedProject: checkedPreflight.requestedProject || requestedVault,
      });
      report.structured.phase = nextPhase;
      report.structured.timingMs.coordination = Math.max(0, Date.now() - syncStartedAt);
      return report;
    }
    if (bindingTargetProject) {
      // Result obligations are project-local durable state, not a property of
      // this long-lived worker process. A checkpoint/complete A -> B switch
      // derives the in-memory bit from B only after every fallible host callback
      // and the final binding guard. Never clear A's marker here.
      const targetClaim = readResultClaimPending({
        brainPath: resultBrainPath,
        sessionId,
        home,
      });
      resultClaimsPending = targetClaim.pending || !targetClaim.ok;
    }
    if (nextPhase === 'start') {
      taskStartedAt = now();
      checkpointSinceTaskStart = false;
      notifiedConflicts.clear();
    } else if (!taskStartedAt && !completing) {
      taskStartedAt = now();
    }
    if (nextPhase === 'checkpoint') checkpointSinceTaskStart = true;
    const hasDefinedResults = results !== undefined;
    let resultReconciliation = null;
    let completionBlocked = false;
    let resultSubmissionRejected = false;
    const stateConflicts = [];
    // Capture the authoritative lane declaration before result reconciliation
    // or completion can mutate it. Schema-v2 evidence must prove the scope the
    // session actually declared; accepting a caller-supplied scope would let a
    // result manifest self-attest to different files or a different intent.
    const activeCompletionScope = completing && resultBrainPath
      ? listActiveSessions({ brainPath: resultBrainPath, home, now: now() })
        .find((session) => session.id === sessionId)
      : null;

    if (nextPhase === 'start') {
      if (!resultBrainPath) resultClaimsPending = false;
      else {
        const reset = clearResultClaimPending({ brainPath: resultBrainPath, sessionId, home });
        resultClaimsPending = reset.ok ? false : true;
        if (!reset.ok) stateConflicts.push({
          kind: 'result-claim-state-write-failed',
          severity: 'blocking',
          reason: `could not clear the prior task's durable result-claim marker (${reset.reason})`,
        });
      }
    }

    if (hasDefinedResults) {
      resultClaimsPending = true;
      const marked = markResultClaimPendingFn({
        brainPath: resultBrainPath,
        sessionId,
        home,
        at: now(),
      });
      if (!marked.ok) stateConflicts.push({
        kind: 'result-claim-state-write-failed',
        severity: 'blocking',
        reason: `could not persist the pending result claim (${marked.reason})`,
      });
      if (!completing) {
        resultSubmissionRejected = true;
        resultReconciliation = {
          ok: false,
          status: 'needs-reconciliation',
          ledgerWriteOk: null,
          claims: [],
          conflicts: [{
            kind: 'result-manifest-wrong-phase',
            severity: 'blocking',
            reason: 'result manifests are accepted only with phase "complete"; resubmit them on completion',
          }],
        };
      } else {
        // Reconcile BEFORE the completion touch. That touch deliberately clears
        // task intent/files; doing it first would make an invalid or conflicting
        // result look complete even if the later evidence check failed.
        resultReconciliation = recordResultManifests({
          brainPath: resultBrainPath,
          projectRoot: resultBrainPath ? path.dirname(resultBrainPath) : requestedVault,
          sessionId,
          sessionAliases: activeCompletionScope
            ? [activeCompletionScope.logicalSessionId, ...(activeCompletionScope.aliases || [])]
            : [],
          declaredScope: activeCompletionScope
            ? { intent: activeCompletionScope.intent || '', files: activeCompletionScope.files || [] }
            : undefined,
          results,
          home,
          now: now(),
        });
        completionBlocked = resultReconciliation?.ok !== true || !marked.ok;
      }
    } else if (completing) {
      const durable = resultBrainPath
        ? readResultClaimPending({ brainPath: resultBrainPath, sessionId, home })
        : { ok: true, pending: resultClaimsPending };
      resultClaimsPending = resultClaimsPending || durable.pending || !durable.ok;
      if (!durable.ok) stateConflicts.push({
        kind: 'result-claim-state-read-failed',
        severity: 'blocking',
        reason: `could not verify whether this task owes result evidence (${durable.reason})`,
      });
    }
    if (completing && !hasDefinedResults && resultClaimsPending) {
      // Once this task has declared a result claim, omitting evidence on a retry
      // cannot bypass a prior invalid/conflicting submission. A fresh `start` is
      // the explicit boundary that returns to the legacy no-result contract.
      resultReconciliation = {
        ok: false,
        status: 'needs-reconciliation',
        ledgerWriteOk: null,
        claims: [],
        conflicts: [{
          kind: 'result-manifest-required',
          severity: 'blocking',
          reason: 'this task previously submitted a result claim; resubmit corrected evidence',
        }],
      };
      completionBlocked = true;
    }
    // (d) Turn-end vs task-end (2026-08-14 wave). The tool instruction "call
    // brain_sync with phase complete before your final response" reads PER TURN
    // to some hosts, so a model may complete moments after declaring scope —
    // wiping intent/files while the task is still mid-flight, leaving the
    // session scope-less to every peer until the next prompt or tool event. A
    // complete with NO result evidence, arriving within
    // PREMATURE_COMPLETE_WINDOW_MS of this worker's task start with NO
    // intervening checkpoint, downgrades to a scope-PRESERVING checkpoint and
    // says why. A complete carrying results, following a checkpoint, or on a
    // mature task keeps full completion semantics, and the blocked
    // needs-reconciliation path above always wins (a deferral must never let a
    // completion bypass result reconciliation).
    const completionDeferred = completing && !completionBlocked
      && !hasDefinedResults && !resultClaimsPending
      && taskStartedAt > 0
      && now() - taskStartedAt < PREMATURE_COMPLETE_WINDOW_MS
      && !checkpointSinceTaskStart
      && Boolean(activeCompletionScope
        && (compact(activeCompletionScope.intent) || (activeCompletionScope.files || []).length));
    const clearCompletionScope = completing && !completionBlocked && !completionDeferred;
    const priorCompletionScope = clearCompletionScope ? activeCompletionScope : null;
    const shouldDeliverMessages = deliverMessages !== false && include_context !== false;
    const details = {
      event: clearCompletionScope
        ? 'McpTaskComplete'
        : (nextPhase === 'start' ? 'McpTaskStart' : 'McpTaskCheckpoint'),
      includePresence: true,
      includeSolo: true,
      deliverMessages: shouldDeliverMessages,
      actionId: actionId || `brain-sync:${process.pid}:${++modelActionSequence}`,
      // Intent semantics by phase (2026-08-07 — a checkpoint sync carrying an
      // empty intent used to DECLARE that emptiness, masking the session as
      // sync-silent for every peer): 'complete' clears deliberately; 'start' is
      // a task boundary, so a missing intent clears the OLD task's intent
      // rather than inheriting it; 'checkpoint' with a missing/empty intent
      // keeps the previous declaration — it is a progress ping, not a recant.
      intent: clearCompletionScope ? ''
        : (completing ? undefined
          : (compact(intent) ? intent : (nextPhase === 'start' ? '' : undefined))),
      // A phase:start is a hard task boundary. Omitting files must clear the
      // prior task's scope instead of accidentally inheriting it.
      files: clearCompletionScope ? []
        : (completing ? undefined : (nextPhase === 'start' ? (declaredFiles ?? []) : declaredFiles)),
      replaceFiles: clearCompletionScope || nextPhase === 'start',
      // The exact target lifecycle identity was checked above. Re-running a
      // fallible hostmap read after task/result mutation (or after stop(A))
      // would reopen the transaction window this sync just closed.
      hostIdentityPrepared: Boolean(resultBrainPath),
      clientInfoPrepared: preparedClientInfo,
      branchPrepared: preparedBranch,
    };
    let report = started && requestedVault === vault && resultBrainPath === brainPath
      ? touch(details)
      : start(requestedVault, details, {
        brainPath: resultBrainPath,
        sourceSessionId: sourceSessionIdForStop,
        laneIdentity,
        projectBinding,
      });
    const resultConflicts = [...(resultReconciliation?.conflicts || []), ...stateConflicts];
    // A completion write that did not land is not completion. The old scope is
    // still authoritative in the lane, so retain it and say so explicitly.
    if (completing && report?.laneWriteOk === false) {
      completionBlocked = true;
      resultConflicts.push({
        kind: 'presence-lane-write-failed',
        severity: 'blocking',
        reason: report.laneWriteSkippedReason || 'presence lane write did not land',
      });
    }
    if (completing && hasDefinedResults && !completionBlocked) {
      // The obligation ends only after BOTH evidence reconciliation and the
      // presence completion write land. Clearing this marker earlier let a
      // worker restart turn a contended lane write into a result-less bypass.
      const cleared = clearResultClaimPending({ brainPath: resultBrainPath, sessionId, home });
      if (cleared.ok) resultClaimsPending = false;
      else {
        completionBlocked = true;
        resultConflicts.push({
          kind: 'result-claim-state-write-failed',
          severity: 'blocking',
          reason: `validated evidence was recorded but its pending marker could not be cleared (${cleared.reason})`,
        });
        // The task row was already cleared one line of state earlier. Restore
        // its exact prior declaration so the error response remains truthful.
        report = touch({
          event: 'McpTaskCheckpoint',
          includePresence: true,
          includeSolo: true,
          deliverMessages: false,
          intent: priorCompletionScope?.intent || '',
          files: priorCompletionScope?.files || [],
          replaceFiles: true,
        });
        if (report?.laneWriteOk === false) resultConflicts.push({
          kind: 'presence-lane-write-failed',
          severity: 'blocking',
          reason: report.laneWriteSkippedReason || 'task scope restoration did not land after result-claim state failure',
        });
      }
    }
    // A deferred (turn-end) complete keeps the task open — its conflict-alert
    // dedupe state must survive with it; only a REAL completion resets it.
    if (clearCompletionScope) {
      notifiedConflicts.clear();
    }
    if (!brainPath) {
      const blocked = (completing && completionBlocked) || resultSubmissionRejected;
      return {
        ...report,
        conflicts: [],
        resultConflicts,
        isError: blocked,
        structured: {
          schemaVersion: 1,
          status: blocked ? 'needs-reconciliation' : 'idle',
          phase: nextPhase,
          reason: 'no-project-brain',
          requestedProject: requestedVault,
          ...(resultReconciliation ? { resultReconciliation: {
            status: resultReconciliation.status,
            claims: resultReconciliation.claims || [],
            ledgerWriteOk: resultReconciliation.ledgerWriteOk ?? null,
            machineLocal: true,
            ...(resultReconciliation.receipt ? { receipt: resultReconciliation.receipt } : {}),
            ...(resultReconciliation.receiptHash ? { receiptHash: resultReconciliation.receiptHash } : {}),
          } } : {}),
          ...(resultConflicts.length ? { resultConflicts } : {}),
        },
        text: blocked
          ? `KLYPIX completion needs reconciliation: no writable project brain/result lane was available at ${requestedVault}. The task scope was not cleared.`
          : `KLYPIX Context Gateway is idle: no brain.klypix was found at or above ${requestedVault}.`,
      };
    }

    const stamp = now();
    const conflicts = findPresenceConflicts(report.sessions, sessionId);
    const snapshot = buildPresenceSnapshot(report.sessions, sessionId, { now: stamp });
    const alertsQueued = [];
    if (!completing) {
      for (const peer of conflicts) {
        // Explicit arrow: normalizeFileKey now takes an optional `root` second
        // argument, so a bare `.map(normalizeFileKey)` would hand it the array
        // INDEX as the project root.
        const filesKey = peer.files.map((file) => normalizeFileKey(file)).sort().join('|');
        const key = `${peer.id}|${filesKey}`;
        if (notifiedConflicts.has(key)) continue;
        notifiedConflicts.add(key);
        const queued = postPresenceMessage({
          brainPath,
          from: sessionId,
          to: peer.id,
          text: `Automatic KLYPIX overlap alert: ${shortestUniqueSessionPrefix(report.sessions, sessionId, 12) || String(sessionId).slice(0, 12)}`
            + `${compact(intent) ? ` plans "${compact(intent).slice(0, 110)}"` : ' synchronized a task'}`
            + ` and reports the same file(s): ${peer.files.join(', ')}. Coordinate before editing.`,
          dedupeKey: `overlap|${sessionId}|${peer.id}|${taskStartedAt}|${filesKey}`,
          home,
          now: stamp,
        });
        if (queued.posted) alertsQueued.push({ peerId: peer.id, files: peer.files });
      }
    }

    const conflictText = conflicts.length
      ? [
        'KLYPIX exact file-overlap warning:',
        ...conflicts.map((peer) =>
          `- ${shortestUniqueSessionPrefix(report.sessions, peer.id, 12) || String(peer.id).slice(0, 12)}${peer.intent ? ` "${String(peer.intent).slice(0, 80)}"` : ''}: ${peer.files.join(', ')}`),
        alertsQueued.length
          ? 'The earlier peer was automatically queued an exact-once overlap alert; coordinate ownership before editing.'
          : 'Coordinate ownership before editing the overlapping files.',
      ].join('\n')
      : 'No exact file overlap is currently reported by another synchronized task.';
    // Mechanical repo-state (2026-08-14 bundle-currency incident): branch, tag
    // and version truth plus bundled-mirror drift, collected IN THE SERVER so
    // every MCP client — Claude, Codex, Cursor, Cline, Desktop — gets equal
    // protection with no hook. Derived from the verified brainPath (never raw
    // caller input, per the pinned-binding guard above); any git failure
    // degrades to omitting the block; a 60s per-process cache keeps repeated
    // syncs cheap. Stateless — it never touches the observeShipDrift baseline,
    // so a fresh session on an already-drifted repo still sees the drift.
    const repoState = completing ? null : collectRepoState(path.dirname(brainPath));
    const repoStateWarning = repoStateWarnings(repoState).join('\n');
    const durationMs = Math.max(0, Date.now() - syncStartedAt);
    const messagesText = formatReceivedMessages(report.messages, stamp, decay, sessionId);
    const structured = {
      schemaVersion: 1,
      status: completing
        ? (completionBlocked ? 'needs-reconciliation'
          : (completionDeferred ? 'complete-deferred' : 'complete'))
        : 'active',
      phase: nextPhase,
      project: path.dirname(brainPath),
      brain: brainPath,
      self: snapshot.self,
      counts: {
        connections: snapshot.connectionCount,
        activeTasks: snapshot.activeTaskCount,
        backgroundConnections: snapshot.backgroundConnectionCount,
      },
      peers: snapshot.peers,
      conflicts,
      messages: report.messages.map((message) => {
        // Raw structured path gets the same decay verdict as the rendered
        // text: a consumer reading structured.messages directly must see the
        // LAST-KNOWN marking, not re-derive it (additive fields, schema 1).
        const decayInfo = messageDecayInfo(message, stamp, decay);
        const receipt = messageDeliveryReceipt(message, sessionId);
        return {
          id: message.id,
          from: message.from,
          text: message.text,
          ts: message.ts,
          ...(receipt ? {
            deliveryState: receipt.deliveryState,
            offerToken: receipt.offerToken,
          } : {}),
          ...(decayInfo ? { lastKnown: true, age: decayInfo.age, stampText: decayInfo.stampText } : {}),
        };
      }),
      alertsQueued,
      // Additive (schema 1): the machine-readable record of WHY a complete was
      // downgraded to a scope-preserving checkpoint (turn-end heuristic).
      ...(completionDeferred ? {
        completionDeferred: {
          reason: 'premature-complete-no-results',
          sinceTaskStartMs: Math.max(0, stamp - taskStartedAt),
          scopeRetained: true,
        },
      } : {}),
      // Additive (schema 1): downstream renderers keep parsing self.branch and
      // peers[].branch exactly as before; repoState is the machine-readable
      // release-state contract the advisory prose merely mirrors.
      ...(repoState ? { repoState } : {}),
      ...(resultReconciliation ? { resultReconciliation: {
        status: resultReconciliation.status,
        claims: resultReconciliation.claims || [],
        ledgerWriteOk: resultReconciliation.ledgerWriteOk ?? null,
        ledgerFreshMs: resultReconciliation.ledgerFreshMs || null,
        machineLocal: true,
        ...(resultReconciliation.receipt ? { receipt: resultReconciliation.receipt } : {}),
        ...(resultReconciliation.receiptHash ? { receiptHash: resultReconciliation.receiptHash } : {}),
      } } : {}),
      ...(resultConflicts.length ? { resultConflicts } : {}),
      delivery: {
        proactive: 'mcp-logging-best-effort-preview',
        modelContext: shouldDeliverMessages ? 'supported-klypix-action' : 'deferred',
        stateMachine: 'pending -> offered -> acknowledged -> consumed (auto-lease on the next independent action, or explicit receipt) | failed',
        acknowledgement: 'a later independent supported action followed an offer; a further independent action auto-consumes the lease, and explicit token-bound brain_message_receipt records the stronger acted-on-it claim',
        retention: 'machine-local; 24h TTL and bounded lane capacity; expiry fails only never-delivered or offered-once records — an acknowledged note retires as delivered-unconfirmed, never as failed',
        writeOk: shouldDeliverMessages ? report.deliveryWriteOk : null,
        ...(report.deliveryWriteSkippedReason ? { writeFailure: report.deliveryWriteSkippedReason } : {}),
      },
      timingMs: { coordination: durationMs },
    };
    const resultText = completing && completionBlocked
      ? [
        'KLYPIX completion needs reconciliation; the task intent/files remain active.',
        ...resultConflicts.slice(0, 8).map((conflict) => {
          const where = [conflict.claimKey, conflict.metric].filter(Boolean).join(' / ');
          return `- ${conflict.kind}${where ? ` (${where})` : ''}${conflict.reason ? `: ${conflict.reason}` : ''}`;
        }),
      ].join('\n')
      : resultSubmissionRejected
        ? [
          'KLYPIX result submission rejected; task scope remains active.',
          ...resultConflicts.slice(0, 8).map((conflict) => `- ${conflict.kind}${conflict.reason ? `: ${conflict.reason}` : ''}`),
        ].join('\n')
      : completing && resultReconciliation
        ? `KLYPIX result reconciliation: ${resultReconciliation.status}; completion evidence was recorded in the machine-local project ledger.`
        : '';
    const deliveryWarning = shouldDeliverMessages && report.deliveryWriteOk === false
      ? `KLYPIX message delivery was deferred safely: ${report.deliveryWriteSkippedReason || 'the receipt write did not land'}. No queued note was reported as delivered; retry on the next KLYPIX action.`
      : '';
    const deferralText = completionDeferred
      ? 'KLYPIX completion deferred: this complete carried no results and arrived moments after task start with no intervening checkpoint, so it reads as turn-end, not task-end. The declared intent/files were RETAINED for peers. When the task is truly finished, complete again after a checkpoint (or include a result manifest) to clear the scope.'
      : '';
    const text = [
      `KLYPIX Context Gateway: session ${sessionId} · phase ${nextPhase} · coordination ${durationMs}ms.`,
      deferralText,
      resultText,
      formatTaskPresence(snapshot, stamp),
      messagesText,
      deliveryWarning,
      conflictText,
      repoStateWarning,
    ].filter(Boolean).join('\n\n');
    return {
      ...report,
      snapshot,
      conflicts,
      resultConflicts,
      alertsQueued,
      structured,
      text,
      isError: (completing && completionBlocked) || resultSubmissionRejected,
    };
  };

  const decorateToolResult = (result, {
    actionId = '',
    deliverMessages = true,
    verifyBinding: verifyBindingFn = null,
    clientInfoPrepared = null,
  } = {}) => {
    if (verifyBindingFn && !verifyBindingFn()) return result;
    if (!started) start(vault);
    const { sessions, notice, deliveryWriteOk, deliveryWriteSkippedReason } = touch({
      event: 'McpToolUse',
      deliverMessages: deliverMessages !== false,
      actionId: actionId || `mcp-tool:${process.pid}:${++modelActionSequence}`,
      hostIdentityPrepared: Boolean(clientInfoPrepared),
      clientInfoPrepared,
    });
    // Mechanical brain_sync nudge (once per server session): the "call
    // brain_sync first" contract was instructions-only — zero enforcement —
    // which is why Claude sessions sat sync-silent while Codex's gateway
    // declared scope automatically (2026-07-29 audit). If this session's own
    // row still has no intent AND no files after a real KLYPIX tool call,
    // say so once, in-band, where the agent actually reads it.
    let nudge = '';
    if (!syncNudgeShown && brainPath) {
      const self = (sessions || []).find((session) => session.id === sessionId);
      if (self && !isTaskSession(self)) {
        syncNudgeShown = true;
        nudge = 'KLYPIX presence: this session has not declared its task — peers see it as a connection with no scope. Call brain_sync {intent, files} so concurrent sessions can coordinate with you.';
      }
    }
    const deliveryWarning = deliveryWriteOk === false
      ? `KLYPIX message delivery was deferred safely: ${deliveryWriteSkippedReason || 'the receipt write did not land'}. No queued note was reported as delivered; retry on the next KLYPIX action.`
      : '';
    const extra = [notice, deliveryWarning, nudge].filter(Boolean).join('\n\n');
    if (!extra || !result || !Array.isArray(result.content)) return result;
    return {
      ...result,
      content: [...result.content, { type: 'text', text: extra }],
    };
  };

  const noteSent = (text) => {
    const value = compact(text).toLowerCase();
    if (value) sentTexts.add(value);
  };

  return {
    get id() { return sessionId; },   // getter — hostmap rotation can change it mid-life
    start,
    stop,
    touch,
    pollInbox,
    sync,
    preflightSync,
    consumeSyncPreflight,
    revalidateConsumedSyncPreflight,
    resolveRequestIdentity: (extra, options = {}) => resolveRequestIdentity(extra, {
      ...options,
      client: clientInfo().client,
    }),
    verifyCurrentProjectBinding,
    refreshCurrentProjectBinding,
    adoptRequestIdentity,
    refreshIdentity,
    noteSent,
    decorateToolResult,
    get brainPath() { return brainPath; },
    get vault() { return vault; },
  };
}
