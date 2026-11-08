// Cheap native-hook adapter. Only brain_sync creates a decision baseline.
// No transport, hook installation, permission decision or adoption inference.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DECISION_WATCH_LIMIT = 24;
export const DECISION_WATCH_BODY_LIMIT = 4000;

export function canonicalDecisionBrain(file) {
  const resolved = fs.realpathSync.native(path.resolve(file));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function decisionWatchKey(brainPath, sessionId) {
  return crypto.createHash('sha256').update(JSON.stringify([canonicalDecisionBrain(brainPath), String(sessionId)])).digest('hex');
}

export function decisionWatchPath(brainPath, sessionId, stateDir = path.join(os.homedir(), '.claude', 'project-brain')) {
  return path.join(stateDir, 'decision-watches', `${decisionWatchKey(brainPath, sessionId).slice(0, 40)}.json`);
}

export function decisionBrainSignature(brainPath) {
  const s = fs.statSync(brainPath);
  return JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
}

export function validateDecisionWatchState(state, key) {
  if (!state || state.version !== 1 || state.key !== key || !/^\d+:\d+$/.test(state.task)
    || !Array.isArray(state.watched) || state.watched.length > DECISION_WATCH_LIMIT
    || !Array.isArray(state.offered) || state.offered.length > DECISION_WATCH_LIMIT
    || !Array.isArray(state.reviews) || state.reviews.length > DECISION_WATCH_LIMIT
    || state.watched.some(s => typeof s?.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(s.id)
      || !/^[a-f0-9]{64}$/.test(s.revision) || typeof s.text !== 'string'
      || s.text.length > DECISION_WATCH_BODY_LIMIT + 30)) throw new Error('watch-state-invalid');
  return state;
}

const unknown = reason => ({ status: 'unknown', text: `Decision-change check UNKNOWN (${reason}). No decision adoption is established.` });

/** The caller supplies the exact lifecycle row, never a PID-correlated peer.
 * A missing/mismatched/completed task cannot create or reset a watch. On the
 * unchanged path only small JSON/stat reads run; the ZIP engine stays unloaded.
 * Cached output contains no card bodies or IDs. Any file change (including a
 * privacy lock) must pass the engine's current privacy filter again.
 */
export async function decisionChangesAtBoundary({ brainPath, sessionId, session, stateDir } = {}) {
  if (!brainPath || !sessionId || !session || session.id !== sessionId
    || (session.logicalSessionId && session.logicalSessionId !== sessionId)
    || session.completedAt || !(Number(session.scopeGeneration) > 0) || !(Number(session.scopeStartedAt) > 0)) {
    return { status: 'not-watching', text: '' };
  }
  let file, key, prior;
  try {
    key = decisionWatchKey(brainPath, sessionId);
    file = decisionWatchPath(brainPath, sessionId, stateDir);
    if (!fs.existsSync(file)) return { status: 'not-watching', text: '' };
    if (fs.statSync(file).size > 1024 * 1024) return unknown('watch-state-too-large');
    prior = validateDecisionWatchState(JSON.parse(fs.readFileSync(file, 'utf8')), key);
    const task = `${Number(session.scopeGeneration)}:${Number(session.scopeStartedAt)}`;
    if (prior.task !== task) return { status: 'not-watching', text: '' };
    if (!prior.watched.length) return { status: 'not-watching', text: '' };
    const cache = prior.boundary;
    if (cache?.signature === decisionBrainSignature(brainPath) && Number.isInteger(cache.pending)
      && cache.pending >= 0 && cache.pending <= DECISION_WATCH_LIMIT) {
      return cache.pending ? { status: 'pending-review', pending: cache.pending, cached: true,
        text: `Decision changes remain PENDING REVIEW (${cache.pending}). Recheck the previously offered changes with brain_sync before continuing dependent work. Reading a warning does not resolve it; reviews are agent-reported, not proof.` }
        : { status: 'unchanged', cached: true, text: '' };
    }
  } catch { return unknown('watch-state-or-brain-unreadable'); }
  try {
    const { syncDecisionWatch, formatDecisionChanges } = await import('./decision-watch.mjs');
    const report = await syncDecisionWatch({ brainPath, sessionId,
      taskGeneration: session.scopeGeneration, taskStartedAt: session.scopeStartedAt,
      stateDir, existingOnly: true });
    return { ...report, text: formatDecisionChanges(report) };
  } catch { return unknown('boundary-comparison-failed'); }
}
