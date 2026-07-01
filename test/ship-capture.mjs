// Regression test for ship-event auto-capture QUALITY (1.15.0). Two guarantees the
// founder asked for after the brain filled with low-signal "merged PR — auto-captured
// (`gh pr merge …`)" cards (some mislabeled "#4"/"#5"):
//   • a merged-PR card is a CLEAN fact ("Ship: 🏁 merged PR #286") — NOT a raw-bash dump.
//   • the PR number is read ONLY from the `pr merge <n>` argument, so a stray digit in an
//     unrelated flag (`-R owner/repo4`) can no longer mislabel the card "#4".
// E2E: run the REAL hook in --capture mode over a synthetic transcript (no network, no git
// repo needed), then parse the resulting brain and assert the card text.
//
// Run:  node test/ship-capture.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildKlypixMap, parseKlypix } from '../src/klypix-format.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'global-brain-hook.mjs');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

// Run the real --capture hook over `commands` (each a shell command in its own Bash
// tool_use), return the resulting brain's card text joined. Fully isolated + hermetic:
// a fresh temp HOME/project per call, and a pre-seeded npm-currency cache so the Stop
// hook's once/day currency refresh is throttled (→ zero network).
async function captureBrain(tag, commands) {
  const home = path.join(os.tmpdir(), 'klypix-ship-home-' + tag);
  const proj = path.join(os.tmpdir(), 'klypix-ship-proj-' + tag);
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
  const brainHome = path.join(home, '.claude', 'project-brain');
  fs.mkdirSync(brainHome, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  // throttle the Stop-hook npm-currency refresh so the test makes no network call.
  fs.writeFileSync(path.join(brainHome, '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest: '1.15.0', checkedAt: Date.now() }));
  // minimal valid brain in the project
  fs.writeFileSync(path.join(proj, 'brain.klypix'), await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));

  const entry = (id, command) => JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } });
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, commands.map((c, i) => entry('t' + i, c)).join('\n') + '\n');

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.KLYPIX_BRAIN_NO_MAIN;   // the subprocess MUST run main() (real Stop/--capture)
  execFileSync(process.execPath, [HOOK, '--capture'], {
    cwd: proj, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sess-' + tag, transcript_path: transcript }),
  });

  const { struct } = await parseKlypix(fs.readFileSync(path.join(proj, 'brain.klypix')));
  const all = (struct.cards || []).map(c => String(c.text || '')).join('\n');
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
  return all;
}

// ── number extracted from the `pr merge <n>` arg + the card is a clean fact ──────────
const withNum = await captureBrain('num', ['gh pr merge 286 --squash --delete-branch -R dahshanlabs/agentmug']);
ok(/merged PR #286/.test(withNum), 'merged-PR card carries the real number (#286) from the `pr merge <n>` arg');
ok(!/auto-captured/.test(withNum) && !/gh pr merge/.test(withNum), 'ship card is a clean fact — no raw-bash / "auto-captured (`…`)" dump');

// ── a stray digit in an unrelated flag must NOT become the PR number ─────────────────
const strayDigit = await captureBrain('stray', ['gh pr merge --repo octo/repo4 --admin']);
ok(/merged PR\b/.test(strayDigit), 'a numberless merge is still captured as "merged PR"');
ok(!/#4\b/.test(strayDigit), 'a stray digit in `-R …/repo4` does NOT mislabel the card "#4"');

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ ship-capture: all assertions passed');
process.exit(failures ? 1 : 0);
