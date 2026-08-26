#!/usr/bin/env node
// One pane of the README demo: a real MCP client driving the real server.
//
// Honesty rule: this pane prints the server's OWN response text — colorized,
// never rewritten. If the server stops returning an overlap warning, the demo
// stops showing one. That is the point.
//
// Usage:
//   node docs/demo/pane.mjs --label "Session A · Claude Code" \
//     --intent "rewrite the auth token refresh" \
//     --files src/auth/token.ts [--hold] [--note "..."] [--note-after 6000] \
//     [--repo <demo repo dir>]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const label = arg('label', 'Session');
const intent = arg('intent', 'look around');
const files = (arg('files', '') || '').split(',').filter(Boolean);
const demoRepo = path.resolve(arg('repo', path.join(repoRoot, '.demo-repo')));
const note = arg('note');
const noteAfter = Number(arg('note-after', '6000'));

const RESET = '\x1b[0m';
const paint = (code, s) => `\x1b[${code}m${s}${RESET}`;
const out = (s = '') => process.stdout.write(s + '\n');

// Word-wrap to a fixed width so lines printed before a tmux split are not
// clipped when the pane narrows (tmux does not rewrap existing rows). Layout
// only — the characters are untouched.
const WRAP = Number(arg('wrap', '72'));
function wrapLine(line) {
  if (line.length <= WRAP) return [line];
  const outLines = [];
  let rest = line;
  while (rest.length > WRAP) {
    let cut = rest.lastIndexOf(' ', WRAP);
    if (cut < WRAP - 40) cut = WRAP; // no near space — hard cut
    outLines.push(rest.slice(0, cut));
    rest = '  ' + rest.slice(cut).trimStart();
  }
  outLines.push(rest);
  return outLines;
}

// Colorize the server's brief by section, without altering a single character
// of its content. Sections are recognised by their real headings.
function render(text) {
  let mode = 'plain';
  for (const raw of text.split('\n')) for (const line of wrapLine(raw)) {
    if (/^KLYPIX exact file-overlap warning/.test(line)) { mode = 'overlap'; out(paint('1;31', line)); continue; }
    if (/^KLYPIX task presence/.test(line)) { mode = 'peers'; out(paint('1', line)); continue; }
    if (/^## Compact task context/.test(line)) { mode = 'context'; out(paint('1;32', line)); continue; }
    if (/^KLYPIX Context Gateway|^Context Gateway total/.test(line)) { mode = 'plain'; out(paint('2', line)); continue; }
    if (line.trim() === '') { mode = 'plain'; out(); continue; }
    if (mode === 'overlap') { out(paint('31', line)); continue; }
    if (mode === 'peers' && line.startsWith('- ')) { out(paint('36', line)); continue; }
    if (mode === 'context' && line.startsWith('- ')) { out(paint('32', line)); continue; }
    out(line);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, 'bin', 'klypix-mcp.mjs')],
  cwd: demoRepo,
  stderr: 'ignore',
});
const client = new Client({ name: label, version: '0.0.0' });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return res?.content?.find((c) => c.type === 'text')?.text ?? '';
};

out(paint('1;36', `● ${label}`));
out(paint('2', `  declaring the task before touching code`));
out('');
for (const l of wrapLine(`▸ brain_sync ${JSON.stringify({ intent, files })}`)) out(paint('2', l));
out('');
render(await call('brain_sync', { project: demoRepo, intent, files, phase: 'start' }));

if (note) {
  await new Promise((r) => setTimeout(r, noteAfter));
  out('');
  for (const l of wrapLine(`▸ brain_note ${JSON.stringify({ text: note.slice(0, 44) + '…' })}`)) out(paint('2', l));
  out('');
  const n = await call('brain_note', { project: demoRepo, text: note });
  render(n.split('\n').slice(0, 6).join('\n'));
  out(paint('2', '  a correction supersedes its stale card — the next session inherits the fix'));
}

if (has('hold')) {
  // Stay alive so the other pane's sync sees this session as a live peer.
  await new Promise((r) => { process.on('SIGTERM', r); process.on('SIGINT', r); setTimeout(r, 120_000); });
}

await client.close();
process.exit(0);
