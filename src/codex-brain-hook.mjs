#!/usr/bin/env node
// Codex lifecycle adapter for the agent-neutral KLYPIX presence lane.
// It never reads Codex's unstable transcript format and never modifies the brain.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  findProjectBrain,
  formatPresenceMessage,
  formatReceivedMessages,
  postPresenceMessage,
  receiveMessages,
  removeSession,
  upsertSession,
} from './agent-presence.mjs';
import { recordCodexHookExecution } from './codex-hooks.mjs';
import { opBrainTaskContext } from './klypix-core.mjs';
import { findPresenceConflicts } from './mcp-presence.mjs';

function readInput() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
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

function emitSystemMessage(parts) {
  const systemMessage = parts.filter(Boolean).join('\n\n').trim();
  if (!systemMessage) return;
  process.stdout.write(JSON.stringify({ continue: true, systemMessage }));
}

function formatConflictWarning(conflicts, event) {
  if (!conflicts.length) return '';
  const moment = event === 'PreToolUse' ? 'before this edit runs' : 'after this file operation';
  return [
    `KLYPIX BLOCKING exact-file overlap detected ${moment}:`,
    ...conflicts.map((peer) =>
      `- ${String(peer.id).slice(0, 12)}${peer.intent ? ` "${String(peer.intent).slice(0, 90)}"` : ''}: ${peer.files.join(', ')}`),
    'Coordinate file ownership now. Do not continue overlapping edits until one session yields or the scopes are separated.',
  ].join('\n');
}

function queueConflictAlerts({ brainPath, sessionId, intent, conflicts, turnId }) {
  const queued = [];
  for (const peer of conflicts) {
    const filesKey = peer.files.map((file) => String(file).toLowerCase()).sort().join('|');
    const result = postPresenceMessage({
      brainPath,
      from: sessionId,
      to: peer.id,
      text: `Automatic KLYPIX pre-edit overlap alert: ${String(sessionId).slice(0, 12)}`
        + `${intent ? ` is working on "${String(intent).slice(0, 110)}"` : ' is editing'}`
        + ` and reports the same file(s): ${peer.files.join(', ')}. Coordinate ownership now.`,
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
    removeSession({ brainPath, id: sessionId, channel: 'lifecycle' });
    return;
  }

  const projectDir = path.dirname(brainPath);
  const prompt = input.prompt || input.user_prompt || input.userPrompt;
  const files = event === 'PreToolUse' || event === 'PostToolUse'
    ? touchedFiles(input, projectDir)
    : (event === 'UserPromptSubmit' ? [] : undefined);
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
    replaceFiles: event === 'UserPromptSubmit',
    event,
    channel: 'lifecycle',
    cwd,
  });

  const ignored = event === 'PostToolUse' ? ownBrainMessageText(input) : [];
  const messages = receiveMessages({ brainPath, sessionId, ignoreTexts: ignored });
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
    });
  }
  if (event === 'SessionStart') {
    emitSystemMessage([
      formatPresenceMessage(sessions, sessionId, { includeSolo: true }),
      formatReceivedMessages(messages),
    ]);
    return;
  }
  if (event === 'UserPromptSubmit') {
    const me = sessions.find((session) => session.id === sessionId);
    const context = await compactTaskContext(projectDir, prompt, me?.files || []);
    emitSystemMessage([
      context,
      formatPresenceMessage(sessions, sessionId),
      formatReceivedMessages(messages),
    ]);
    return;
  }
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    emitSystemMessage([
      formatConflictWarning(conflicts, event),
      formatReceivedMessages(messages),
    ]);
    return;
  }
  if (messages.length) emitSystemMessage([formatReceivedMessages(messages)]);
}

main().catch(() => {}).finally(() => process.exit(0));
