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
  receiveMessages,
  removeSession,
  upsertSession,
} from './agent-presence.mjs';
import { recordCodexHookExecution } from './codex-hooks.mjs';

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
  const files = event === 'PostToolUse' ? touchedFiles(input, projectDir) : undefined;
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
    event,
    channel: 'lifecycle',
    cwd,
  });

  const ignored = event === 'PostToolUse' ? ownBrainMessageText(input) : [];
  const messages = receiveMessages({ brainPath, sessionId, ignoreTexts: ignored });
  if (event === 'SessionStart') {
    emitSystemMessage([
      formatPresenceMessage(sessions, sessionId, { includeSolo: true }),
      formatReceivedMessages(messages),
    ]);
    return;
  }
  if (event === 'UserPromptSubmit') {
    emitSystemMessage([
      formatPresenceMessage(sessions, sessionId),
      formatReceivedMessages(messages),
    ]);
    return;
  }
  if (messages.length) emitSystemMessage([formatReceivedMessages(messages)]);
}

main().catch(() => {}).finally(() => process.exit(0));
