#!/usr/bin/env node
// Codex lifecycle adapter for the agent-neutral KLYPIX presence lane.
// It never reads Codex's unstable transcript format and never modifies the brain.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  codexToolActionId,
  deriveIntentFromPrompt,
  endSession,
  findProjectBrain,
  formatPresenceMessage,
  formatReceivedMessages,
  peekMessages,
  postPresenceMessage,
  receiveMessages,
  shortestUniqueSessionPrefix,
  upsertSession,
} from './agent-presence.mjs';
import { recordCodexHookExecution } from './codex-hooks.mjs';
import { opBrainTaskContext } from './klypix-core.mjs';
// Namespace import (already in-process via the klypix-core chain, so zero added
// load cost) so a bundle whose klypix-format predates classifyDecay degrades
// gracefully — a named import of a missing export would kill the whole hook.
import * as brainFormat from './klypix-format.mjs';
import { annotateConflictFiles, findPresenceConflicts } from './mcp-presence.mjs';

function readInput() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Best-available host pid for lane-row correlation (2026-08-14 wave). Codex
// rows previously carried no hostPid at all, so the footer/doctor could never
// group a lifecycle row with its MCP-worker sibling. KLYPIX_HOST_PID is a
// host-declared contract (provenance 'env' — safe for the dead-host liveness
// sweep); otherwise this hook's direct parent is a best-effort guess
// (provenance 'ppid' — usable for row correlation only, NEVER probed for
// liveness, because the parent may be a transient shell wrapper whose exit
// says nothing about the session).
const HOST_PID = (() => {
  const envPid = Number(process.env.KLYPIX_HOST_PID || 0);
  if (Number.isInteger(envPid) && envPid > 0) return { pid: envPid, source: 'env' };
  const ppid = Number(process.ppid);
  return Number.isInteger(ppid) && ppid > 0 ? { pid: ppid, source: 'ppid' } : { pid: null, source: null };
})();

// Thin binding of the engine's host-neutral ship observer to a Codex project
// dir. Guarded on the export so an older bundled klypix-format degrades to no
// observation rather than killing the hook.
function observeShipDrift(projectDir) {
  try {
    if (!projectDir || typeof brainFormat.observeShipDrift !== 'function') return '';
    const gitRun = (args) => execFileSync('git', String(args).split(/\s+/).filter(Boolean), {
      cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    });
    return brainFormat.observeShipDrift(projectDir, { gitRun }).notice || '';
  } catch {
    return '';
  }
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

function toolName(input) {
  return String(input.tool_name || input.toolName || input.tool?.name || '');
}

function toolInput(input) {
  const candidate = input.tool_input || input.toolInput || input.tool?.input;
  return candidate && typeof candidate === 'object' ? candidate : {};
}

function projectRelative(file, projectDir) {
  if (!file) return null;
  const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(projectDir, file);
  const relative = path.relative(projectDir, absolute).replace(/\\/g, '/');
  if (!relative || relative === '.' || relative === '..' || relative.startsWith('../')) return null;
  return relative;
}

function touchedFiles(input, projectDir) {
  const name = toolName(input);
  const args = toolInput(input);
  const candidates = [];
  for (const key of ['path', 'file_path', 'filePath', 'target_file', 'targetFile']) {
    if (typeof args[key] === 'string') candidates.push(args[key]);
  }
  const patch = [args.patch, args.input, args.content]
    .find((value) => typeof value === 'string' && value.includes('*** '));
  if (patch && /apply_patch|Edit|Write/i.test(name)) {
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
      candidates.push(match[1].trim());
    }
  }
  return [...new Set(candidates.map((file) => projectRelative(file, projectDir)).filter(Boolean))];
}

function ownBrainMessageText(input) {
  if (!/brain_message$/i.test(toolName(input))) return [];
  const text = toolInput(input).text;
  return typeof text === 'string' && text.trim() ? [text] : [];
}

const MODEL_CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

export function hookActionId(input, event) {
  const turnId = input?.turn_id || input?.turnId;
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    return codexToolActionId({
      turnId,
      toolUseId: input?.tool_use_id || input?.toolUseId,
      toolName: toolName(input),
      toolInput: toolInput(input),
    });
  }
  const explicit = turnId || input?.action_id;
  return explicit ? `codex-turn:${String(explicit).slice(0, 144)}` : '';
}

export function buildCodexHookOutput(parts, event) {
  const systemMessage = parts.filter(Boolean).join('\n\n').trim();
  if (!systemMessage) return null;
  return {
    // Preserve the legacy common hook field for installed Codex builds while
    // adding the event-specific model-context envelope below.
    continue: true,
    systemMessage,
    ...(MODEL_CONTEXT_EVENTS.has(event) ? {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: systemMessage,
      },
    } : {}),
  };
}

function emitSystemMessage(parts, event) {
  const output = buildCodexHookOutput(parts, event);
  if (!output) return;
  process.stdout.write(JSON.stringify(output));
}

// ── Decay-aware LAST-KNOWN stamps (2026-07-28 post-mortem, class B) ──────────
// Codex-lane parity with the Claude hook's messageFooter: a delivered message
// older than 6h whose text asserts fast-decay build/deploy status must never
// read as current state — the ENGINE stamps it, never the reading model. The
// classifier lives ONCE in klypix-format (typeof-guarded: a stale bundle
// degrades to no stamp, never a throw). Stamps are appended AFTER
// formatReceivedMessages' 400-char render slice so no cut can eat them (the
// v1.32.0 law: a warning is never subject to the budget it warns about), and
// exist in render output only — the lane file, its dedup keys, and its ack
// semantics are untouched. The shared renderer (agent-presence) stamps
// internally when handed the classifier; the pass below is belt-and-braces for
// a mixed bundle whose agent-presence predates that, and its dedup is
// per-MESSAGE — a message the renderer already stamped is skipped without
// suppressing stamps the other messages still need.
const MSG_DECAY_STAMP_MS = 6 * 60 * 60 * 1000;
// Precision-first consumption (mirrors the Claude hook): only an explicit
// `true` / explicitly fast-shaped object stamps — ambiguity never does.
const isFastDecayResult = (r) => r === true || r === 'fast'
  || (!!r && typeof r === 'object' && (r.fast === true || r.fastDecay === true || r.decay === 'fast' || r.class === 'fast' || r.kind === 'fast'));
export function stampReceivedMessages(messages, now = Date.now(),
  classifier = (typeof brainFormat.classifyDecay === 'function' ? brainFormat.classifyDecay : null),
  sessionId = '') {
  const list = Array.isArray(messages) ? messages : [];
  // Thread the full engine surface through — the shared renderer stamps each
  // qualifying message internally (agent-presence stays builtin-only, so the
  // engine functions ride the same injection; guarded for a stale bundle).
  const base = classifier
    ? formatReceivedMessages(list, now, {
      classifyDecay: classifier,
      decayStaleMs: brainFormat.DECAY_STALE_MS,
      decayMessageStamp: typeof brainFormat.decayMessageStamp === 'function' ? brainFormat.decayMessageStamp : undefined,
      formatDecayAge: typeof brainFormat.formatDecayAge === 'function' ? brainFormat.formatDecayAge : undefined,
    }, sessionId)
    : formatReceivedMessages(list, now, {}, sessionId);
  if (!base || !classifier) return base;
  const staleMs = Number(brainFormat.DECAY_STALE_MS) > 0 ? Number(brainFormat.DECAY_STALE_MS) : MSG_DECAY_STAMP_MS;   // threshold single-sourced in the engine
  const stamps = list.map((m) => {
    try {
      const ts = Number(m?.ts) || 0;
      if (!ts || now - ts < staleMs) return '';
      if (!isFastDecayResult(classifier(String(m?.text || '')))) return '';
      // Wording single-sourced in the engine (decayMessageStamp) so the
      // renderers can never drift apart; local fallback for a stale bundle.
      if (typeof brainFormat.decayMessageStamp === 'function') return `  ${brainFormat.decayMessageStamp(now - ts)}`;
      const h = Math.floor((now - ts) / 3_600_000);
      const label = h >= 48 ? `${Math.floor(h / 24)}d` : `${Math.max(1, h)}h`;
      return `  ⏱️ This message is ${label} old and contains build/deploy status — treat as LAST KNOWN, verify live before reporting it.`;
    } catch { return ''; }   // best-effort — a classifier bug must never break delivery
  });
  if (!stamps.some(Boolean)) return base;
  // Per-MESSAGE dedup granularity, not whole-output: pair each `- from …`
  // render line with its message and add a stamp only when the line right
  // after it is not already a stamp. A ⏱ inside a message's own quoted text is
  // NOT a stamp and must not suppress the stamps the OTHER messages need (the
  // old whole-output includes('⏱') guard silenced them all).
  const isStampLine = (l) => /^\s*⏱/.test(String(l || ''));
  const lines = base.split('\n');
  const out = [];
  let msgIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (!lines[i].startsWith('- from ')) continue;
    msgIdx++;
    if (msgIdx >= list.length || !stamps[msgIdx]) continue;
    if (isStampLine(lines[i + 1])) { stamps[msgIdx] = ''; continue; }   // renderer already stamped this one
    out.push(stamps[msgIdx]);
    stamps[msgIdx] = '';
  }
  const leftovers = stamps.filter(Boolean);   // unknown layout → stamps still delivered at the end
  return leftovers.length ? [...out, ...leftovers].join('\n') : out.join('\n');
}

function formatConflictWarning(conflicts, event, sessions = []) {
  if (!conflicts.length) return '';
  const moment = event === 'PreToolUse' ? 'before this edit runs' : 'after this file operation';
  // Grow each shown id (floor 12) until unique — same-window UUIDv7 peers
  // otherwise render as one ambiguous prefix.
  const shortId = (id) => shortestUniqueSessionPrefix(sessions, id, 12) || String(id).slice(0, 12);
  // Claims discipline (2026-08-24 audit): this hook is ADVISORY — the output
  // envelope hardcodes `continue: true` and never denies a tool call — so the
  // banner must say WARNING, never BLOCKING. Urgency comes from the imperative
  // closing line, not from claiming a mechanism that does not exist.
  return [
    `KLYPIX ⚠️ WARNING — exact-file overlap detected ${moment}:`,
    ...conflicts.map((peer) => {
      // Observed/declared distinction (1.70.0): a `*` marks a path whose claim
      // was adopted from live edits, not declared — real overlap, unconfirmed
      // boundary; the legend renders only when a mark exists.
      const annotated = annotateConflictFiles(peer);
      return `- ${shortId(peer.id)}${peer.intent ? ` "${String(peer.intent).slice(0, 90)}"` : ''}: ${annotated.files.join(', ')}${annotated.legend}`;
    }),
    'Coordinate file ownership now. Do not continue overlapping edits until one session yields or the scopes are separated.',
  ].join('\n');
}

function queueConflictAlerts({ brainPath, sessionId, intent, conflicts, turnId, sessions = [] }) {
  const queued = [];
  const selfShortId = shortestUniqueSessionPrefix(sessions, sessionId, 12) || String(sessionId).slice(0, 12);
  for (const peer of conflicts) {
    const filesKey = peer.files.map((file) => String(file).toLowerCase()).sort().join('|');
    const annotated = annotateConflictFiles(peer);
    const result = postPresenceMessage({
      brainPath,
      from: sessionId,
      to: peer.id,
      text: `Automatic KLYPIX pre-edit overlap alert: ${selfShortId}`
        + `${intent ? ` is working on "${String(intent).slice(0, 110)}"` : ' is editing'}`
        + ` and reports the same file(s): ${annotated.files.join(', ')}${annotated.legend}. Coordinate ownership now.`,
      dedupeKey: `hook-overlap|${sessionId}|${peer.id}|${turnId || 'turn'}|${filesKey}`,
    });
    if (result.posted) queued.push(peer.id);
  }
  return queued;
}

async function compactTaskContext(projectDir, prompt, files) {
  if (!prompt) return '';
  try {
    const result = await opBrainTaskContext({
      vault: projectDir,
      intent: String(prompt).slice(0, 2000),
      files,
      k: 4,
      budgetChars: 1800,
    });
    return result?.context
      ? result.blocks?.filter((block) => block.kind === 'text').map((block) => block.text).filter(Boolean).join('\n\n') || ''
      : '';
  } catch {
    return '';
  }
}

async function main() {
  const input = readInput();
  const event = String(input.hook_event_name || input.hookEventName || '');
  const sessionId = String(input.session_id || input.sessionId || '');
  const cwd = path.resolve(input.cwd || process.cwd());
  const brainPath = findProjectBrain(cwd);
  if (event && sessionId) recordCodexHookExecution({ event, sessionId });
  if (!event || !sessionId || !brainPath) return;

  if (event === 'SessionEnd') {
    // SessionEnd is the logical conversation boundary, not merely a lifecycle
    // transport disconnect. Remove every channel and tombstone the identity so
    // a late MCP heartbeat/hibernation write cannot resurrect a closed thread.
    endSession({ brainPath, id: sessionId });
    return;
  }

  const projectDir = path.dirname(brainPath);
  const rawPrompt = input.prompt || input.user_prompt || input.userPrompt;
  // Machine-turn guard: a harness-injected "user" prompt (task notification,
  // system reminder) must not become the session's declared intent — derive the
  // human text, and on a machine turn keep the previous intent (undefined).
  const prompt = rawPrompt === undefined ? undefined : (deriveIntentFromPrompt(rawPrompt) ?? undefined);
  // A HUMAN prompt is a task boundary: reset the declared file scope. A machine
  // turn is mid-task plumbing — it must keep the files exactly as it keeps the
  // intent (review-caught: the guard preserved intent but wiped files[]).
  const humanTurn = event === 'UserPromptSubmit' && prompt !== undefined;
  // Tool-touched paths are OBSERVATIONS, not declarations (automatic scope
  // adoption, 1.70.0). They used to ride the `files` param, which fabricated a
  // declared scope out of every edit; upsertSession's observed lane keeps them
  // visible to every reader (they still join files[] for pre-1.70 renderers)
  // while marking them observed, and skips any path the session's DECLARED
  // scope (brain_sync) already covers.
  const observed = event === 'PreToolUse' || event === 'PostToolUse'
    ? touchedFiles(input, projectDir)
    : undefined;
  const files = humanTurn ? [] : undefined;
  const sessions = upsertSession({
    brainPath,
    id: sessionId,
    client: 'codex',
    surface: input.surface || 'local',
    model: input.model || null,
    permissionMode: input.permission_mode || input.permissionMode || null,
    branch: gitBranch(cwd),
    intent: prompt === undefined ? undefined : prompt,
    files,
    replaceFiles: humanTurn,
    observedFiles: observed,
    event,
    channel: 'lifecycle',
    ...(HOST_PID.pid ? { hostPid: HOST_PID.pid, hostPidSource: HOST_PID.source } : {}),
    logicalSessionId: sessionId,
    identitySource: 'codex-lifecycle',
    cwd,
  });

  const ignored = event === 'PostToolUse' ? ownBrainMessageText(input) : [];
  // Stop can show a UI warning but cannot add model context. Never advance a
  // durable delivery receipt on that event; the next context-capable action
  // still replays the note. Context-capable events advance one v2 delivery step.
  const messages = MODEL_CONTEXT_EVENTS.has(event)
    ? receiveMessages({ brainPath, sessionId, ignoreTexts: ignored, actionId: hookActionId(input, event) })
    : peekMessages({ brainPath, sessionId, ignoreTexts: ignored });
  const conflicts = (event === 'PreToolUse' || event === 'PostToolUse')
    ? findPresenceConflicts(sessions, sessionId)
    : [];
  if (conflicts.length) {
    const me = sessions.find((session) => session.id === sessionId);
    queueConflictAlerts({
      brainPath,
      sessionId,
      intent: me?.intent || '',
      conflicts,
      turnId: input.turn_id || input.turnId || '',
      sessions,
    });
  }
  if (event === 'SessionStart') {
    // Commit-capture completeness (2026-08-07): wire the agent-neutral git
    // post-commit/post-merge hook when the slots are absent or already ours —
    // never a foreign hook. Dynamic + guarded so a stale bundle no-ops.
    const gitHookNotice = await (async () => {
      try {
        const ghl = await import(new URL('./git-capture-install.mjs', import.meta.url).href);
        return typeof ghl.ensureGitCaptureHook === 'function' ? (ghl.ensureGitCaptureHook(projectDir).notice || '') : '';
      } catch { return ''; }
    })();
    emitSystemMessage([
      formatPresenceMessage(sessions, sessionId, { includeSolo: true }),
      // Class-C ship observation — the engine's, not a Claude-hook-local copy.
      // Codex-driven projects had NO out-of-session ship detection at all, which
      // is exactly where the incident class bites hardest (2026-07-29 review).
      // The queue drains at the next brain write from any host.
      observeShipDrift(projectDir),
      gitHookNotice.trim(),
      stampReceivedMessages(messages, Date.now(), undefined, sessionId),
    ], event);
    return;
  }
  if (event === 'UserPromptSubmit') {
    const me = sessions.find((session) => session.id === sessionId);
    const context = await compactTaskContext(projectDir, prompt,
      [...new Set([...(me?.files || []), ...(me?.observedFiles || [])])]);
    emitSystemMessage([
      context,
      formatPresenceMessage(sessions, sessionId),
      stampReceivedMessages(messages, Date.now(), undefined, sessionId),
    ], event);
    return;
  }
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    emitSystemMessage([
      formatConflictWarning(conflicts, event, sessions),
      stampReceivedMessages(messages, Date.now(), undefined, sessionId),
    ], event);
    return;
  }
  if (messages.length) emitSystemMessage([stampReceivedMessages(messages, Date.now(), undefined, sessionId)], event);
}

// Run as the hook by default. The ONLY skip is the explicit opt-out flag a
// hermetic test sets before importing this module for its pure exports —
// production never sets it (mirrors global-brain-hook.mjs), so runtime
// behavior is byte-identical.
if (!process.env.KLYPIX_BRAIN_NO_MAIN) {
  main().catch(() => {}).finally(() => process.exit(0));
}
