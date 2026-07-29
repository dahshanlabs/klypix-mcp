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

  const entry = (id, command, tool = 'Bash') => JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: tool, id, input: { command } }] } });
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, commands.map((c, i) => (typeof c === 'string' ? entry('t' + i, c) : entry('t' + i, c.command, c.tool))).join('\n') + '\n');

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

// ── shell-tool names across hosts (2026-07-29 field hole) ────────────────────────────
// The Stop-side set lacked 'PowerShell' while the live detector included it, so on
// Windows a `gh release create` run through the PowerShell tool produced NO ship
// card — the v1.3.69 ship triggered no claim reconciliation at all. Locked for the
// Claude PowerShell tool and the Codex-style lowercase 'shell'.
const psShip = await captureBrain('pstool', [{ tool: 'PowerShell', command: 'gh release create v9.9.9 --title "t" --notes "n"' }]);
ok(/cut release v9\.9\.9/.test(psShip), 'a release cut through the PowerShell tool IS captured as a ship card');
const codexShip = await captureBrain('codextool', [{ tool: 'shell', command: 'npm publish --access public' }]);
ok(/published to npm/.test(codexShip), 'a publish through a lowercase host shell tool is captured too');

// ── out-of-session ship observation → queued at SessionStart → drained at Stop ───────
// Class-C decay leg (2026-07-29): a ship with no hooked session watching (another
// host, a human terminal, CI) must still become a 🏁 card + trigger reconciliation.
{
  const home = path.join(os.tmpdir(), 'klypix-ship-home-obs');
  const proj = path.join(os.tmpdir(), 'klypix-ship-proj-obs');
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
  const brainHome = path.join(home, '.claude', 'project-brain');
  fs.mkdirSync(brainHome, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(brainHome, '.npm-currency.json'), JSON.stringify({ pkg: 'klypix-mcp', latest: '1.15.0', checkedAt: Date.now() }));
  fs.writeFileSync(path.join(proj, 'brain.klypix'), await buildKlypixMap({ title: 'brain', areas: [{ title: 'Goal', cards: [{ text: 'seed card' }] }] }));
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'obs-fixture', version: '1.0.0' }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.KLYPIX_BRAIN_NO_MAIN;
  const readOnce = () => execFileSync(process.execPath, [HOOK], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify({ session_id: 'sess-obs', transcript_path: '' }) });
  const first = readOnce();
  ok(!/Ship signal observed/.test(first), 'first session start BASELINES silently (no observation)');
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'obs-fixture', version: '1.1.0' }));
  const second = readOnce();
  ok(/Ship signal observed/.test(second) && /1\.1\.0/.test(second), 'a version change nobody narrated is observed at the next session start');
  // The notice must NOT assert provenance it cannot know — an in-session ship
  // looks identical to this observer (2026-07-29 review, CONFIRMED).
  ok(!/outside any hooked session/.test(second), 'the notice claims only "new since last observation", never false provenance');
  const transcript = path.join(home, 'obs-transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'no ships narrated here' }] } }) + '\n');
  execFileSync(process.execPath, [HOOK, '--capture'], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify({ session_id: 'sess-obs', transcript_path: transcript }) });
  const { struct } = await parseKlypix(fs.readFileSync(path.join(proj, 'brain.klypix')));
  const flatAll = (struct.cards || []).map(c => String(c.text || '')).join('\n').replace(/\s+/g, ' ');
  ok(/version → 1\.1\.0 observed at task start/.test(flatAll), 'the queued observation drains into a durable 🏁 ship card at Stop');
  ok(!fs.existsSync(path.join(proj, '.claude', 'brain-pending-ships.jsonl')), 'the pending-ship queue is consumed by the drain');
  // BASELINE ADVANCED AT STOP: the session was watching, so the very next
  // SessionStart must NOT re-report the same state as a fresh signal. Before
  // this, every routine release produced a duplicate card with false provenance.
  const third = readOnce();
  ok(!/Ship signal observed/.test(third), 'Stop advanced the baseline — the next session start reports nothing new');
  // A narrated in-session ship must not also arrive as an observation.
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'obs-fixture', version: '1.2.0' }));
  readOnce();                                        // observes 1.2.0, queues it
  const t2 = path.join(home, 'obs-transcript-2.jsonl');
  fs.writeFileSync(t2, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'PowerShell', id: 'z1', input: { command: 'gh release create v1.2.0 --notes n' } }] } }) + '\n');
  execFileSync(process.execPath, [HOOK, '--capture'], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify({ session_id: 'sess-obs', transcript_path: t2 }) });
  const { struct: s2 } = await parseKlypix(fs.readFileSync(path.join(proj, 'brain.klypix')));
  const all2 = (s2.cards || []).map(c => String(c.text || '')).join('\n').replace(/\s+/g, ' ');
  ok(/cut release v1\.2\.0/.test(all2), 'the narrated release is captured');
  ok(!/version → 1\.2\.0 observed/.test(all2), 'the same release does NOT also land as a duplicate observed-ship card');
  for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ ship-capture: all assertions passed');
process.exit(failures ? 1 : 0);
