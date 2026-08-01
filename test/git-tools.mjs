// git-tools — the GitHub lane's proof: git-driver / diff / pr-brief against a
// REAL temp git repo, with the driver runtime provisioned into a FAKE brain
// dir (KLYPIX_BRAIN_DIR) — the npx-stranger path end to end, including the
// crown assertion: a genuine `git merge` that unions two sides' brain cards
// through the provisioned driver.
//
// SAFETY: every write lands in os.tmpdir() (repo + brain dir + HOME-ish bits);
// the real ~/.claude/project-brain and the real project are never touched.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildKlypixMap, appendToKlypix, parseKlypix } from '../src/klypix-format.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'bin', 'klypix-mcp.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-git-tools-'));
const REPO = path.join(TMP, 'repo');
const FAKE_BRAIN_DIR = path.join(TMP, 'brain-runtime');

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? '[ok]' : '[x]'} ${label}`);
  if (!cond) failures++;
};

const ENV = { ...process.env, KLYPIX_BRAIN_DIR: FAKE_BRAIN_DIR };
const run = (args, opts = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [MCP, ...args], { cwd: REPO, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ── fixture repo: a brain with a tagged card, committed ─────────────────────
fs.mkdirSync(REPO, { recursive: true });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'tools@test.local');
git('config', 'user.name', 'git tools test');
const base = await buildKlypixMap({
  title: 'tools brain', kind: 'brain',
  areas: [{ title: 'Area', cards: [
    { text: 'Decision about the app shell — never remove the always-mount. #file-appmain #dir-src' },
    { text: 'Unrelated note with a LONGER tag #file-appmain-extra' },
  ] }],
});
fs.writeFileSync(path.join(REPO, 'brain.klypix'), base);
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'src', 'AppMain.ts'), 'export const x = 1;\n');
git('add', '-A');
git('commit', '-qm', 'base');

console.log('\n— git-driver install (stranger repo, empty runtime) —');
{
  const r = run(['git-driver', 'install']);
  ok(r.code === 0, 'exits 0');
  ok(/Registered the \.klypix merge driver/.test(r.out), 'reports registration');
  ok(/provisioned/.test(r.out), 'provisioned the runtime into the empty brain dir');
  const cfg = git('config', '--get', 'merge.klypix.driver');
  ok(cfg.includes('klypix-merge-driver.mjs') && cfg.includes(FAKE_BRAIN_DIR.replace(/\\/g, '/')), 'git config points at the installed runtime');
  ok(/merge=klypix/.test(fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8')), '.gitattributes rule written');
  for (const f of ['klypix-merge-driver.mjs', 'merge-brains.mjs', 'klypix-format.mjs']) {
    ok(fs.existsSync(path.join(FAKE_BRAIN_DIR, f)), `runtime has ${f}`);
  }
  ok(fs.existsSync(path.join(FAKE_BRAIN_DIR, 'node_modules', 'jszip')), 'runtime has jszip dep');
  const again = run(['git-driver', 'install']);
  ok(/Already registered/.test(again.out), 'second run is idempotent');
  const status = run(['git-driver', 'status']);
  ok(status.code === 0, 'status exits 0 when fully registered');
}
git('add', '-A');
git('commit', '-qm', 'driver attributes');

console.log('\n— crown assertion: real git merge unions through the provisioned runtime —');
{
  git('checkout', '-qb', 'dev-b');
  const b = await appendToKlypix(fs.readFileSync(path.join(REPO, 'brain.klypix')), { cards: [{ text: 'CARD FROM B side' }] });
  fs.writeFileSync(path.join(REPO, 'brain.klypix'), b);
  git('commit', '-qam', 'b card');
  git('checkout', '-q', 'main');
  const a = await appendToKlypix(fs.readFileSync(path.join(REPO, 'brain.klypix')), { cards: [{ text: 'CARD FROM A side' }] });
  fs.writeFileSync(path.join(REPO, 'brain.klypix'), a);
  git('commit', '-qam', 'a card');
  execFileSync('git', ['merge', 'dev-b', '-m', 'merged'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const { struct } = await parseKlypix(fs.readFileSync(path.join(REPO, 'brain.klypix')));
  const titles = struct.cards.map(c => (c.title || c.text || '').split('\n')[0]);
  ok(titles.some(t => t.startsWith('CARD FROM A')) && titles.some(t => t.startsWith('CARD FROM B')),
    'both sides survive a real git merge in a stranger repo');
}

console.log('\n— diff: semantic, prose titles, truthful counts —');
{
  const r = run(['diff', 'HEAD~2']);
  ok(r.code === 0, 'exits 0');
  ok(/Brain diff/.test(r.out), 'has the header');
  ok(/CARD FROM A/.test(r.out) && /CARD FROM B/.test(r.out), 'lists both added cards');
  const m = r.out.match(/(\d+) added · (\d+) updated/);
  ok(!!m && Number(m[1]) >= 2, 'added count includes the new cards');
  ok(!!m && Number(m[2]) <= 2, `updated count is semantic, not byte-noise (got ${m && m[2]})`);
}

console.log('\n— pr-brief: tag-matched context, boundary-safe —');
{
  fs.appendFileSync(path.join(REPO, 'src', 'AppMain.ts'), 'export const y = 2;\n');
  git('commit', '-qam', 'touch AppMain');
  const r = run(['pr-brief', 'HEAD~1']);
  ok(r.code === 0, 'exits 0');
  ok(/Brain context for this PR/.test(r.out), 'has the header');
  ok(/src\/AppMain\.ts/.test(r.out), 'names the changed file');
  ok(/never remove the always-mount/.test(r.out), 'surfaces the tagged decision');
  ok(!/LONGER tag/.test(r.out), 'tag boundary holds — #file-appmain-extra does not match AppMain.ts');
}
{
  fs.writeFileSync(path.join(REPO, 'untagged.md'), 'nothing references this\n');
  git('add', '-A');
  git('commit', '-qm', 'untagged file');
  const r = run(['pr-brief', 'HEAD~1']);
  ok(/No brain cards reference/.test(r.out), 'no-match path says so honestly');
}

console.log(`\n${failures ? `[x] ${failures} assertion(s) failed` : '[ok] git-tools: all assertions passed'}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
