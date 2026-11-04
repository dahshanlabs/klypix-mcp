// Regression: "give ChatGPT a task" and "the task assigned by Claude" must
// offer a saved assignment path, even while the sender continues other work.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assignmentPromptKind, assignmentPromptHint, ASSIGNMENT_SAVE_GUIDANCE,
  ASSIGNMENT_PICKUP_GUIDANCE, linkProject, mergeCodexGlobalInstructions,
} from '../src/agent-rules.mjs';
import { KLYPIX_MCP_INSTRUCTIONS } from '../src/mcp-presence.mjs';
import { buildKlypixMap } from '../src/klypix-format.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-assignment-guidance-'));
const home = path.join(temp, 'home');
const project = path.join(temp, 'project');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; console.log(`[ok] ${message}`); };

try {
  const send = [
    'i added the key in railway now i want to give chatgpt actual big task to do full checking and listening etc to learn and that he selects podcasts etc, give me prompt or use mcp to tell',
    'Assign the pronunciation research to Codex while you fix the room.',
    'Write a prompt for Claude Code to review the changes.',
    'Save a brief for another agent.',
  ];
  const pickup = [
    'i want to do the task assigned to you by claude',
    'Find Claude’s assigned task.',
    'Do the research task Codex saved for me.',
    'Please find my assigned task.',
  ];
  const unrelated = [
    'Rename the README heading.',
    'Render an Assigned task button.',
    'Rename the task field in the Codex export.',
    'Write a prompt explaining how Claude works.',
    'Do not send this task to Codex.',
    "Don't start my assigned task yet.",
  ];
  for (const prompt of send) check(assignmentPromptKind(prompt) === 'send', `sender intent: ${prompt.slice(0, 70)}`);
  for (const prompt of pickup) check(assignmentPromptKind(prompt) === 'pickup', `recipient intent: ${prompt}`);
  for (const prompt of unrelated) check(assignmentPromptKind(prompt) === null && assignmentPromptHint(prompt) === '', `no assignment reminder: ${prompt}`);

  fs.writeFileSync(path.join(project, 'brain.klypix'), await buildKlypixMap({
    title: 'Assignment guidance fixture', kind: 'brain',
    areas: [{ title: 'Research', cards: [{ text: 'Research: use timestamped public recordings.' }] }],
  }));
  const userText = '# Human-owned instructions\nPreserve this paragraph.\n';
  fs.writeFileSync(path.join(project, 'AGENTS.md'), userText);
  const linked = linkProject(project, { editors: new Set(['claude', 'codex']) });
  check(!linked.rules.some(r => r.status === 'error'), 'project projections regenerate without an error');
  const projected = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
  check(projected.includes(userText.trim()) && projected.includes(ASSIGNMENT_SAVE_GUIDANCE) && projected.includes(ASSIGNMENT_PICKUP_GUIDANCE), 'managed project instructions carry both directions and preserve human text');
  const global = mergeCodexGlobalInstructions(home);
  check(global.ok && fs.readFileSync(global.path, 'utf8').includes(ASSIGNMENT_SAVE_GUIDANCE), 'global Codex instructions teach saving an assignment');
  check(KLYPIX_MCP_INSTRUCTIONS.includes(ASSIGNMENT_SAVE_GUIDANCE) && KLYPIX_MCP_INSTRUCTIONS.includes(ASSIGNMENT_PICKUP_GUIDANCE), 'hookless MCP hosts receive the same assignment contract');

  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), KLYPIX_AUTO_UPDATE: '0' };
  delete env.KLYPIX_SESSION_ID;
  delete env.KLYPIX_BRAIN_NO_MAIN;
  const run = (host, prompt) => {
    const codex = host === 'codex';
    const file = path.join(repo, 'src', codex ? 'codex-brain-hook.mjs' : 'global-brain-hook.mjs');
    const sid = codex ? '01a1a652-c065-7512-9a11-018b5cf8e368' : '6de922c9-53d7-4bd4-85d5-e7c885ef1a82';
    const raw = execFileSync(process.execPath, [file, ...(codex ? [] : ['--prompt'])], {
      cwd: project, env, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt, cwd: project }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return codex ? JSON.parse(raw || '{}').hookSpecificOutput?.additionalContext || '' : raw;
  };
  for (const host of ['claude', 'codex']) {
    const sent = run(host, send[0]);
    check(sent.includes(assignmentPromptHint(send[0])) && sent.includes('reason:"assignment"') && sent.includes('Confirm the returned card id'), `${host} live prompt hook injects save-before-send guidance for original incident`);
    const received = run(host, pickup[0]);
    check(received.includes(assignmentPromptHint(pickup[0])) && received.includes('{action:"read", id}') && received.includes('{action:"take", id}'), `${host} live prompt hook directs recipient to the full saved assignment`);
    check(!run(host, unrelated[0]).includes('KLYPIX assignment:'), `${host} ordinary work remains free of assignment reminders`);
    check(!run(host, '<task-notification>give ChatGPT a task</task-notification>').includes('KLYPIX assignment:'), `${host} machine notifications do not become assignment requests`);
  }
  console.log(`[ok] assignment-guidance: ${checks} checks passed`);
} finally {
  // This test owns only its freshly-created directory under the OS temp root.
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true });
}
