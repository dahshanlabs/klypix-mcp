// Live state stays in its own project (round-4 fix of the 2026-10-30
// continuity test).
//
// The field shape: a Claude Code session in project A wrote its project's
// live block (live peers, unfinished work) into the machine-wide
// ~/.codex/AGENTS.md. Codex sessions in project B load that file too, and two
// of three of them first tried to take project A's stopped session.
//   S1  sessions in project A — through the real Claude and Codex hooks —
//       write A's live state only into A's CLAUDE.local.md; no global,
//       non-project instruction file (~/.codex/AGENTS.md, AGENTS.override.md,
//       ~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md) gains a byte of it;
//   S2  a Codex session in project B sees none of A's sessions or handoffs:
//       not in what its hook prints, not in B's own files, not in what Codex
//       loads globally;
//   S3  a global file an older version polluted is cleaned on the next write.
//
// Run:  node test/live-scope.mjs        (exit 0 = pass, 1 = fail)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import { laneFileFor } from '../src/agent-presence.mjs';
import { liveKey, wrapLiveBlock, listLiveSections } from '../src/live-projection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, '..', 'src', 'global-brain-hook.mjs');
const CODEX_HOOK = path.join(__dirname, '..', 'src', 'codex-brain-hook.mjs');
let checks = 0;
const ok = (c, label, detail) => { checks++; if (!c && detail !== undefined) console.log(String(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1)).slice(0, 3000)); assert.ok(c, label); console.log(`[ok] ${label}`); };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-live-scope-'));
const home = path.join(root, 'home');
const globals = {
  codex: path.join(home, '.codex', 'AGENTS.md'),
  claude: path.join(home, '.claude', 'CLAUDE.md'),
  gemini: path.join(home, '.gemini', 'GEMINI.md'),
};
const GLOBAL_TEXT = {
  codex: '# my codex rules\n\n<!-- klypix-codex:start (managed by klypix-mcp) -->\n## KLYPIX project brains\ncall brain_sync\n<!-- klypix-codex:end -->\n',
  claude: '# my claude rules\n- be brief\n',
  gemini: '# my gemini rules\n',
};
for (const [k, f] of Object.entries(globals)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, GLOBAL_TEXT[k]); }

const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_BRAIN_DIR: path.join(home, '.claude', 'project-brain'), KLYPIX_AUTO_UPDATE: '0' };
for (const k of Object.keys(env)) if (/^(CLAUDE|CODEX|KLYPIX_(SESSION|WHOSE|HOST))/.test(k)) delete env[k];

const makeRepo = async (name) => {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const git = (...args) => String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const app = 1;\n');
  fs.writeFileSync(path.join(dir, 'brain.klypix'), await buildKlypixMap({ title: name, kind: 'brain', areas: [{ title: 'Core', cards: [{ text: `Core: ${name} decision` }] }] }));
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return dir;
};

try {
  const A = await makeRepo('proj-alpha');
  const B = await makeRepo('proj-beta');
  // Project A: a stopped Codex session that left unfinished work (with a
  // distinctive id and intent), as the lane records it.
  const A_SESSION = '0a1fa000-dead-7000-8000-00000000a11a';
  const t = Date.now();
  const laneA = laneFileFor(path.join(A, 'brain.klypix'), home);
  fs.mkdirSync(path.dirname(laneA), { recursive: true });
  fs.writeFileSync(laneA, JSON.stringify({ sessions: [], messages: [], endedSessions: [], directory: [
    { id: A_SESSION, client: 'codex', branch: 'main', intent: 'ALPHA-ONLY task: rewrite the alpha billing module', files: ['src/app.ts'], cwd: A, aliases: [], firstSeen: t - 3_600_000, lastSeen: t - 1_800_000, endedAt: null, intentAt: t - 3_600_000, work: { declaredAt: t - 3_600_000, lastWords: 'Halfway through alpha billing.', commits: [{ sha: 'abc1234', subject: 'feat(alpha): billing part 1' }] } },
  ] }));

  // S1: sessions in A, through the real hooks.
  const claudeA = execFileSync(process.execPath, [HOOK, ''], { cwd: A, env: { ...env, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(process.ppid) }, encoding: 'utf8', input: JSON.stringify({ cwd: A, session_id: 'c1a0de00-aaaa-bbbb-cccc-000000000001', hook_event_name: 'SessionStart', source: 'startup' }), stdio: ['pipe', 'pipe', 'pipe'] });
  ok(claudeA.includes('Codex 0a1fa000') && claudeA.includes('ALPHA-ONLY'), 'S1 precondition: a Claude session in A is shown A\'s unfinished work');
  execFileSync(process.execPath, [CODEX_HOOK], { cwd: A, env, encoding: 'utf8', input: JSON.stringify({ cwd: A, session_id: 'c0de0000-aaaa-bbbb-cccc-000000000002', hook_event_name: 'SessionStart' }), stdio: ['pipe', 'pipe', 'pipe'] });
  const localA = read(path.join(A, 'CLAUDE.local.md')) || '';
  ok(localA.includes('ALPHA-ONLY') && localA.includes('0a1fa000'), 'S1 A\'s live state is in A\'s own CLAUDE.local.md');
  for (const [k, f] of Object.entries(globals)) {
    ok(read(f) === GLOBAL_TEXT[k], `S1 the global ${path.relative(home, f).replace(/\\/g, '/')} is byte-for-byte unchanged (no live state of any project)`, read(f));
  }
  ok(!fs.existsSync(path.join(home, '.codex', 'AGENTS.override.md')), 'S1 no Codex override file is created');

  // S2: a Codex session in B.
  const codexB = execFileSync(process.execPath, [CODEX_HOOK], { cwd: B, env, encoding: 'utf8', input: JSON.stringify({ cwd: B, session_id: 'c0de0000-bbbb-bbbb-cccc-000000000003', hook_event_name: 'SessionStart' }), stdio: ['pipe', 'pipe', 'pipe'] });
  ok(!/0a1fa000|ALPHA-ONLY|alpha billing|proj-alpha/i.test(codexB), 'S2 the Codex hook in B prints none of A\'s sessions or handoffs', codexB.slice(0, 3000));
  const localB = read(path.join(B, 'CLAUDE.local.md')) || '';
  ok(!/0a1fa000|ALPHA-ONLY|proj-alpha/i.test(localB), 'S2 B\'s own CLAUDE.local.md names nothing from A', localB);
  const codexLoads = [globals.codex, path.join(home, '.codex', 'AGENTS.override.md'), path.join(B, 'AGENTS.md'), path.join(B, 'AGENTS.override.md')].map(read).filter(Boolean).join('\n');
  ok(!/0a1fa000|ALPHA-ONLY|proj-alpha/i.test(codexLoads), 'S2 nothing Codex loads as instructions in B (global file, override, B\'s AGENTS.md) names A\'s state', codexLoads);

  // S3: a global file polluted by 1.104–1.109 is cleaned on the next write.
  fs.writeFileSync(globals.codex, GLOBAL_TEXT.codex + '\n' + wrapLiveBlock(liveKey(A), '## KLYPIX live — proj-alpha\nCodex 0a1fa000 ALPHA-ONLY', { at: t, projectDir: A }) + '\n');
  ok(listLiveSections(read(globals.codex)).length === 1, 'S3 setup: a global Codex file carrying project A\'s section, as 1.104–1.109 left it');
  execFileSync(process.execPath, [CODEX_HOOK], { cwd: B, env, encoding: 'utf8', input: JSON.stringify({ cwd: B, session_id: 'c0de0000-bbbb-bbbb-cccc-000000000003', hook_event_name: 'Stop', last_assistant_message: 'ok' }), stdio: ['pipe', 'pipe', 'pipe'] });
  ok(read(globals.codex) === GLOBAL_TEXT.codex, 'S3 the next KLYPIX write (a Codex Stop in B) removes A\'s section and keeps everything else byte for byte', read(globals.codex));
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\nlive-scope: ${checks} checks passed`);
