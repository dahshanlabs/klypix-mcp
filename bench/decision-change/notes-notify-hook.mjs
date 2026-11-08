import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const NOTES_NOTICE = 'Project notes changed. Re-read CLAUDE.md and AGENTS.md and check whether the current task needs an adjustment.';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// Deliberately ordinary whole-file notification: no card IDs, semantic
// relevance, fixture policy, role filtering or special treatment of own edits.
export function checkNotes({ repoDir, stateDir, event }) {
  const session = String(event.session_id || '');
  if (!session || !['SessionStart', 'PreToolUse', 'PostToolUse'].includes(event.hook_event_name)) return { status: 'ignored' };
  const notes = ['CLAUDE.md', 'AGENTS.md'].map(file => {
    try { return `${file}\0${fs.readFileSync(path.join(repoDir, file), 'utf8')}`; }
    catch (error) { if (error.code === 'ENOENT') return `${file}\0[MISSING]`; throw error; }
  });
  const revision = hash(notes.join('\0'));
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, `${hash(session)}.json`);
  let prior;
  try { prior = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first observation */ }
  if (prior?.revision === revision) return { status: 'unchanged', revision };
  fs.writeFileSync(stateFile, JSON.stringify({ revision }));
  if (!prior || event.hook_event_name === 'SessionStart') return { status: 'baseline', revision };
  return { status: 'changed', revision, output: { hookSpecificOutput: {
    hookEventName: event.hook_event_name, additionalContext: NOTES_NOTICE,
  } } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const result = checkNotes({ stateDir: process.argv[2], repoDir: process.argv[3], event });
    if (result.output) process.stdout.write(JSON.stringify(result.output));
  } catch (error) { process.stderr.write(`Notes notification unavailable: ${error.message}\n`); process.exitCode = 1; }
}
