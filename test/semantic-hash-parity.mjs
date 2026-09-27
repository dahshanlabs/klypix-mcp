// Hash parity between the vector-cache WRITER and its two READERS.
//
// The writer (semantic-memory.vectorsForBrain) fingerprints a card's EMBED
// INPUT: the first 1,500 characters plus any question enrichment. Both readers
// (the one-shot hook's cachedCardVecs and the long-lived server's
// cachedVectorsForBrain) used to compare that fingerprint against the hash of
// the FULL card text, so every card longer than the embed cap and every
// enriched card was silently dropped to lexical matching. This suite pins the
// contract that replaced it: entries carry `t` (full-text fingerprint) beside
// `h` (embed-input fingerprint), and both readers apply one acceptance rule.
//
// "Parity" here means the same card filter and the same acceptance rule on ONE
// cache file. The readers are not equivalent beyond that: the hook reader
// stops at the first cache file variant with the current modelKey, the server
// reader merges every alias file. HP12 records that difference.
//
// Hermetic by construction: every scenario runs in spawned children whose
// HOME/USERPROFILE point into a mkdtemp directory, the child refuses to start
// anywhere else, and the embedder is a stub. No model, no network, no real
// cache. Every expectation is an explicit id set, because on the old code the
// two readers were wrong in the same way and a reader1 === reader2 check alone
// would have passed.
// Run:  node test/semantic-hash-parity.mjs        (exit 0 = pass, 1 = fail)
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { builtinModules } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

// One behaviour matrix, run through BOTH copies of the acceptance rule.
// [label, entry, fullHash, truncatedHash (value or thunk), expected, expected thunk calls]
const F = 'f'.repeat(40);
const T = 'a'.repeat(40);
const X = 'b'.repeat(40);
const V = [1, 2, 3];
const RULE_MATRIX = [
  ['t matches the full text while h covers enrichment', { h: X, t: F, v: V }, F, T, true, 0],
  ['t matches and h is absent', { t: F, v: V }, F, T, true, 0],
  ['legacy entry: h is the full-text hash', { h: F, v: V }, F, T, true, 0],
  ['legacy entry: h is the truncated-text hash', { h: T, v: V }, F, T, true, 1],
  ['legacy entry: h matches neither hash', { h: X, v: V }, F, T, false, 1],
  ['stale t does not veto a valid truncated h', { h: T, t: X, v: V }, F, T, true, 1],
  ['stale t does not veto a valid full h', { h: F, t: X, v: V }, F, T, true, 0],
  ['stale t and stale h', { h: X, t: X, v: V }, F, T, false, 1],
  ['short text has no truncated hash', { h: T, v: V }, F, null, false, 1],
  ['neither t nor h', { v: V }, F, T, false, 0],
  ['no vector', { h: F, t: F }, F, T, false, 0],
  ['numeric t falls back to h', { h: F, t: 12345, v: V }, F, T, true, 0],
  ['null t falls back to h', { h: F, t: null, v: V }, F, T, true, 0],
  ['object t falls back to h', { h: F, t: { x: 1 }, v: V }, F, T, true, 0],
  ['empty t falls back to h', { h: T, t: '', v: V }, F, T, true, 1],
  ['numeric t and no h', { t: 12345, v: V }, F, T, false, 0],
  ['numeric h', { h: 12345, v: V }, F, T, false, 0],
  ['empty h', { h: '', v: V }, F, T, false, 0],
  ['empty t, empty h, empty full hash', { h: '', t: '', v: V }, '', '', false, 0],
  ['non-string full hash', { h: F, t: F, v: V }, 12345, T, false, 0],
  ['null entry', null, F, T, false, 0],
  ['undefined entry', undefined, F, T, false, 0],
  ['primitive entry', 42, F, T, false, 0],
  ['thunk that throws', { h: T, v: V }, F, () => { throw new Error('thunk failure'); }, false, 1],
  ['thunk that returns a non-string', { h: T, v: V }, F, () => 12345, false, 1],
];

// What the stub embedder throws in the child and what the parent expects back
// from the writer: the embedder's own error, not a new one.
const EMBED_FAILURE = { code: 'KLYPIX_TEST_EMBEDDER_DOWN', message: 'stub embedder unavailable (hash-parity 7c1e)' };

if (process.env.KLYPIX_HASH_PARITY_CHILD === '1') {
  const plan = JSON.parse(fs.readFileSync(process.env.KLYPIX_HASH_PARITY_PLAN, 'utf8'));
  // Both modules derive their cache directory from os.homedir() at load, so
  // prove the home is the scenario's temp directory BEFORE importing either.
  const home = path.resolve(os.homedir());
  const fromTmp = path.relative(path.resolve(os.tmpdir()), home);
  if (!plan.home || home !== path.resolve(plan.home) || !fromTmp || fromTmp.startsWith('..') || path.isAbsolute(fromTmp)) {
    process.stderr.write(`refusing to run: home ${home} is not the hermetic scenario home`);
    process.exit(3);
  }
  let hashCalls = 0;
  const createHash = crypto.createHash;
  crypto.createHash = (...args) => { hashCalls++; return createHash.apply(crypto, args); };

  const semantic = await import(`../src/semantic-memory.mjs?child=${process.pid}`);
  const hook = await import(`../src/brain-semantic.mjs?child=${process.pid}`);
  const enrichment = await import('../src/enrichment.mjs');
  let embedCalls = 0;
  let embeddedTexts = [];
  let failEmbed = false;
  const embeddingDir = path.resolve(plan.home, '.claude', 'project-brain', 'embeddings');
  const counted = () => semantic.semanticMemorySnapshot().counters;
  const pipe = async (texts) => {
    embedCalls++;
    embeddedTexts.push(...texts);
    if (failEmbed) throw Object.assign(new Error(EMBED_FAILURE.message), { code: EMBED_FAILURE.code });
    return {
      dims: [texts.length, 3],
      data: Float32Array.from(texts.flatMap((text) => [text.length, embedCalls, 0.5])),
      dispose() {},
    };
  };
  const out = [];
  let previousMap = null;
  for (const step of plan.steps) {
    if (step.op === 'enrich') {
      out.push(enrichment.recordEnrichment(plan.brain, step.items));
    } else if (step.op === 'write') {
      embedCalls = 0;
      embeddedTexts = [];
      failEmbed = step.failEmbed === true;
      // Both modules call fs.renameSync through the shared default export, so
      // a holder on the cache file is simulated here, for cache commits only.
      const rename = fs.renameSync;
      let renameAttempts = 0;
      if (step.rename) {
        let failuresLeft = step.rename.failures;
        fs.renameSync = (from, to) => {
          const target = path.resolve(String(to));
          if (path.dirname(target) !== embeddingDir || !target.endsWith('.json')) return rename(from, to);
          renameAttempts++;
          if (failuresLeft > 0) {
            failuresLeft--;
            throw Object.assign(new Error(`${step.rename.code}: injected rename failure`), { code: step.rename.code });
          }
          return rename(from, to);
        };
      }
      const before = counted();
      let map = null;
      let threw = false;
      let error = null;
      try { map = await semantic.vectorsForBrain(pipe, plan.brain, step.cards); }
      catch (caught) { threw = true; error = { message: caught?.message, code: caught?.code }; }
      finally { fs.renameSync = rename; failEmbed = false; }
      const after = counted();
      out.push({
        ids: map instanceof Map ? [...map.keys()].sort() : null,
        threw,
        error,
        embedCalls,
        embeddedTexts,
        cacheWrites: after.cacheWrites - before.cacheWrites,
        cacheWriteFailures: after.cacheWriteFailures - before.cacheWriteFailures,
        renameAttempts,
      });
    } else if (step.op === 'read1') {
      const before = hashCalls;
      let map = null;
      let threw = false;
      try { map = hook.cachedCardVecs(plan.brain, step.cards); } catch { threw = true; }
      out.push({ ids: map instanceof Map ? [...map.keys()].sort() : null, threw, hashCalls: hashCalls - before });
    } else if (step.op === 'read2') {
      let map = null;
      let threw = false;
      try { map = semantic.cachedVectorsForBrain(plan.brain, step.cards); } catch { threw = true; }
      out.push({ ids: map instanceof Map ? [...map.keys()].sort() : null, threw, sameMap: map !== null && map === previousMap });
      previousMap = map;
    } else if (step.op === 'drop') {
      const cache = JSON.parse(fs.readFileSync(step.file, 'utf8'));
      delete cache.cards[step.id];
      fs.writeFileSync(step.file, JSON.stringify(cache));
      out.push({ dropped: step.id });
    } else if (step.op === 'rule') {
      const copies = { hook: hook.vectorEntryMatchesText, server: semantic.vectorEntryMatchesText };
      const result = { source: {}, cases: [] };
      for (const [name, fn] of Object.entries(copies)) result.source[name] = typeof fn === 'function' ? fn.toString() : null;
      for (const [, entry, full, truncated] of RULE_MATRIX) {
        const row = {};
        for (const [name, fn] of Object.entries(copies)) {
          let thunkCalls = 0;
          const thunk = () => { thunkCalls++; return typeof truncated === 'function' ? truncated() : truncated; };
          try { row[name] = typeof fn === 'function' ? fn(entry, full, thunk) : 'missing'; } catch { row[name] = 'threw'; }
          row[`${name}Thunk`] = thunkCalls;
        }
        result.cases.push(row);
      }
      out.push(result);
    }
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const okIds = (result, expected, label) => ok(
  Boolean(result) && result.threw === false && same(result.ids, [...expected].sort()),
  `${label} (got ${JSON.stringify(result?.ids)})`,
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-sem-parity-'));
const script = fileURLToPath(import.meta.url);

// One home and one brain path per scenario, one child per phase: neither the
// server reader's memo nor the enrichment memo can serve a previous phase.
function scenario(name, mode = 'bounded') {
  const home = path.join(root, name, 'home');
  const brain = path.join(root, name, 'project', 'brain.klypix');
  const embeddingDir = path.join(home, '.claude', 'project-brain', 'embeddings');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.dirname(brain), { recursive: true });
  fs.writeFileSync(brain, 'cache identity only');
  let phase = 0;
  const run = (steps) => new Promise((resolve, reject) => {
    const planFile = path.join(root, name, `plan-${++phase}.json`);
    fs.writeFileSync(planFile, JSON.stringify({ home, brain, steps }));
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        KLYPIX_HASH_PARITY_CHILD: '1',
        KLYPIX_HASH_PARITY_PLAN: planFile,
        KLYPIX_SEMANTIC_MEMORY_MODE: mode,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) return reject(new Error(`parity child exited ${code}: ${stderr || stdout}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  const cacheFiles = () => fs.readdirSync(embeddingDir).filter(file => file.endsWith('.json')).map(file => path.join(embeddingDir, file));
  const cacheFile = () => {
    const files = cacheFiles();
    if (files.length !== 1) throw new Error(`${name}: expected one cache file, found ${files.length}`);
    return files[0];
  };
  const keyFile = (key) => path.join(embeddingDir, `${sha1(key)}.json`);
  return { name, home, brain, embeddingDir, run, cacheFiles, cacheFile, keyFile };
}
const readCards = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).cards;
const editCache = (file, edit) => {
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(cache.cards);
  fs.writeFileSync(file, JSON.stringify(cache));
};
// Legacy fixtures are what the REAL writer stored with `t` removed, never
// hand-computed hashes, so they follow the writer if its embed input changes.
const stripT = (cards, ids = Object.keys(cards)) => { for (const id of ids) delete cards[id].t; };
const allCarryT = (cards, list) => list.every(card => cards[card.id]
  && typeof cards[card.id].h === 'string' && Array.isArray(cards[card.id].v) && cards[card.id].t === sha1(card.text));
const readers = async (s, cards) => {
  const [r1, r2] = await s.run([{ op: 'read1', cards }, { op: 'read2', cards }]);
  return { r1, r2 };
};
// A settled cache must be left UNWRITTEN, not merely rewritten with the same
// bytes: on a real brain a rewrite is tens of megabytes under the lock.
const settled = async (s, cards, label) => {
  const file = s.cacheFile();
  const bytes = fs.readFileSync(file);
  const stamp = fs.statSync(file).mtimeMs;
  const [again] = await s.run([{ op: 'write', cards }]);
  ok(again.threw === false && again.embedCalls === 0, `${label}: a writer run on a settled cache embeds nothing`);
  ok(bytes.equals(fs.readFileSync(file)), `${label}: and leaves the cache file byte-identical`);
  ok(again.cacheWrites === 0 && fs.statSync(file).mtimeMs === stamp,
    `${label}: and does not write the file at all (${again.cacheWrites} cache write(s))`);
};
const debris = (s) => fs.readdirSync(s.embeddingDir).filter(file => /\.(?:tmp|lock)$/.test(file));
const attempt = async (name, fn) => {
  try { await fn(); } catch (error) {
    console.error(error?.stack || error);
    ok(false, `${name}: scenario completed`);
  }
};

const SENTENCE = 'the release uploader retries a failed part before it reports the whole transfer as broken. ';
const fill = (label, length) => `${label}: ${SENTENCE.repeat(40)}`.slice(0, length);
const card = (id, text, type = 'text') => ({ id, type, text });
const SHORT = card('short', 'Release decision: the uploader retries a failed part three times.');
const LONG = card('long', fill('Long design note', 2400));
const ENRICHED = card('enriched', 'Pan = dedicated hand tool; holding space and dragging moves the canvas viewport without selecting cards.');
const QUESTION = 'how does the grab-and-move navigation gesture work on the canvas?';
const QUESTION_2 = 'which shortcut lets me scroll around the board without picking things up?';
const BOX = card('box', 'Navigation decisions container title', 'container');
const BLANK = card('blank', '   ');
const enrich = (target, question) => ({ op: 'enrich', items: [{ body: target.text, question }] });
const ids = (...cards) => cards.map(c => c.id);

try {
  // ── HP1 — long and enriched cards reach both readers ────────────────────
  await attempt('HP1', async () => {
    const s = scenario('core');
    const cards = [SHORT, LONG, ENRICHED, BOX, BLANK];
    const live = [SHORT, LONG, ENRICHED];
    const [recorded, written] = await s.run([enrich(ENRICHED, QUESTION), { op: 'write', cards }]);
    ok(recorded.recorded === 1, 'HP1: the enrichment sidecar recorded the question');
    ok(same(written.ids, ids(...live).sort()) && written.embeddedTexts.length === 3, 'HP1: the writer embeds the three live cards');
    ok(written.embeddedTexts.some(text => text.includes(QUESTION)), 'HP1: the enriched card was embedded WITH its question');
    ok(written.embeddedTexts.some(text => text.length < LONG.text.length && LONG.text.startsWith(text)), 'HP1: the long card was embedded truncated');
    const stored = readCards(s.cacheFile());
    ok(allCarryT(stored, live), 'HP1: every stored entry carries h, t = sha1(full text) and v');
    ok(stored.long?.h !== sha1(LONG.text) && stored.enriched?.h !== sha1(ENRICHED.text),
      'HP1: h is the embed-input fingerprint, so it differs from the full-text hash for long and enriched cards');
    const { r1, r2 } = await readers(s, cards);
    okIds(r1, ids(...live), 'HP1: hook reader returns short, long and enriched');
    okIds(r2, ids(...live), 'HP1: server reader returns short, long and enriched');

    await settled(s, cards, 'HP1');

    // An edit inside the first 1,500 characters invalidates the vector.
    const edited = [card('short', `${SHORT.text} Now five times.`), card('long', `Revised ${LONG.text}`), ENRICHED, BOX, BLANK];
    const [primed, e1, e2] = await s.run([{ op: 'read2', cards }, { op: 'read1', cards: edited }, { op: 'read2', cards: edited }]);
    okIds(primed, ids(...live), 'HP1: server reader primes its memo with the unedited cards');
    okIds(e1, ['enriched'], 'HP1: hook reader rejects both edited cards');
    okIds(e2, ['enriched'], 'HP1: server reader rejects both edited cards in the process that holds the memo');
    const fresh = await readers(s, edited);
    okIds(fresh.r1, ['enriched'], 'HP1: hook reader rejects both edited cards in a fresh process');
    okIds(fresh.r2, ['enriched'], 'HP1: server reader rejects both edited cards in a fresh process');
  });

  // ── HP2 — a legacy cache (h only) and the zero-embed backfill ───────────
  await attempt('HP2', async () => {
    const s = scenario('legacy-h-only');
    const cards = [SHORT, LONG, ENRICHED];
    await s.run([enrich(ENRICHED, QUESTION), { op: 'write', cards }]);
    editCache(s.cacheFile(), stripT);
    const legacy = await readers(s, cards);
    okIds(legacy.r1, ['long', 'short'], 'HP2: hook reader recovers the truncated card from an h-only cache');
    okIds(legacy.r2, ['long', 'short'], 'HP2: server reader recovers the truncated card from an h-only cache');
    const [backfill] = await s.run([{ op: 'write', cards }]);
    ok(backfill.embedCalls === 0 && backfill.ids.length === 3, 'HP2: the writer backfills t without calling the embedder');
    ok(allCarryT(readCards(s.cacheFile()), cards), 'HP2: every entry now carries t = sha1(full text)');
    const after = await readers(s, cards);
    okIds(after.r1, ids(...cards), 'HP2: hook reader returns the enriched card once t is backfilled');
    okIds(after.r2, ids(...cards), 'HP2: server reader returns the enriched card once t is backfilled');
    ok(backfill.cacheWrites === 1, 'HP2: the backfill is one cache write');
    await settled(s, cards, 'HP2');
  });

  // ── HP3 — an older writer kept the entry, so t is stale but h is valid ──
  await attempt('HP3', async () => {
    const s = scenario('stale-t');
    await s.run([{ op: 'write', cards: [SHORT, LONG] }]);
    const tailEdited = card('long', `${LONG.text.slice(0, 1800)} tail rewritten after the embed cap.`);
    const cards = [SHORT, tailEdited];
    ok(readCards(s.cacheFile()).long?.t === sha1(LONG.text), 'HP3: fixture entry carries the fingerprint of the OLD text');
    const { r1, r2 } = await readers(s, cards);
    okIds(r1, ['long', 'short'], 'HP3: hook reader accepts a tail-edited long card through h');
    okIds(r2, ['long', 'short'], 'HP3: server reader accepts a tail-edited long card through h');
    const [fixed] = await s.run([{ op: 'write', cards }]);
    ok(fixed.embedCalls === 0, 'HP3: the writer corrects t without calling the embedder');
    ok(allCarryT(readCards(s.cacheFile()), cards), 'HP3: t now fingerprints the edited text');
    await settled(s, cards, 'HP3');
  });

  // ── HP4 — a pre-1.77 entry hashed the FULL text of a long card ──────────
  await attempt('HP4', async () => {
    const s = scenario('pre-177');
    const cards = [SHORT, LONG];
    await s.run([{ op: 'write', cards }]);
    editCache(s.cacheFile(), (stored) => { stored.long = { h: sha1(LONG.text), v: stored.long.v }; });
    const { r1, r2 } = await readers(s, cards);
    okIds(r1, ['long', 'short'], 'HP4: hook reader accepts a full-text h on a long card');
    okIds(r2, ['long', 'short'], 'HP4: server reader accepts a full-text h on a long card');
    // Recorded, not endorsed: h stays the re-embed trigger, so a current
    // writer re-embeds what a 1.76 writer stored. That predates this suite.
    const [rewritten] = await s.run([{ op: 'write', cards }]);
    ok(rewritten.embedCalls === 1 && rewritten.embeddedTexts.length === 1, 'HP4: the writer re-embeds exactly that one card');
    ok(allCarryT(readCards(s.cacheFile()), cards), 'HP4: and stores it with t');
  });

  // ── HP5 — mixed fixture: explicit ids AND reader parity ─────────────────
  await attempt('HP5', async () => {
    const s = scenario('mixed');
    const enriched2 = card('enriched2', 'Zoom = pinch or ctrl-scroll; the viewport keeps the point under the cursor fixed while scaling.');
    const edited = card('edited', 'Autosave writes the recovery copy every thirty seconds.');
    const bare = card('bare', 'Tabs restore in the order they were closed, newest first.');
    const badT = card('badt', 'Dropped folders become one folder card with embedded bytes.');
    await s.run([
      enrich(ENRICHED, QUESTION),
      enrich(enriched2, 'how do I magnify part of the board while keeping my place?'),
      { op: 'write', cards: [SHORT, LONG, ENRICHED, enriched2, edited, bare, badT] },
    ]);
    editCache(s.cacheFile(), (stored) => {
      stripT(stored, ['long', 'enriched2']);
      stored.bare = { v: stored.bare.v };
      stored.badt = { h: stored.badt.h, t: 12345, v: stored.badt.v };
      stored.box = { h: sha1(BOX.text), t: sha1(BOX.text), v: [1, 2, 3] };
      stored.blank = { h: sha1(BLANK.text), t: sha1(BLANK.text), v: [1, 2, 3] };
      stored.numeric = { h: sha1('12345'), t: sha1('12345'), v: [1, 2, 3] };
    });
    const cards = [null, SHORT, LONG, ENRICHED, enriched2, card('edited', 'Autosave writes the recovery copy every ten seconds.'), bare, badT, BOX, BLANK, card('numeric', 12345)];
    const expected = ['badt', 'enriched', 'long', 'short'];
    const { r1, r2 } = await readers(s, cards);
    okIds(r1, expected, 'HP5: hook reader returns exactly the verifiable cards');
    okIds(r2, expected, 'HP5: server reader returns exactly the verifiable cards');
    ok(Array.isArray(r1.ids) && same(r1.ids, r2.ids), 'HP5: both readers return the same card ids');
  });

  // ── HP6 — the hook reader survives hostile card arrays ──────────────────
  await attempt('HP6', async () => {
    const s = scenario('hostile-cards');
    await s.run([{ op: 'write', cards: [SHORT, LONG] }]);
    const hostile = [null, { id: 'untexted' }, { id: 'numeric', text: 12345 }, 'not a card', 42, SHORT, LONG];
    const [mixed, notArray] = await s.run([{ op: 'read1', cards: hostile }, { op: 'read1', cards: null }]);
    okIds(mixed, ['long', 'short'], 'HP6: null, untexted and numeric-text cards do not empty the hook reader');
    okIds(notArray, [], 'HP6: a non-array card list yields an empty Map');
    const [server, serverNotArray] = await s.run([{ op: 'read2', cards: hostile }, { op: 'read2', cards: null }]);
    okIds(server, ['long', 'short'], 'HP6: one numeric-text card does not empty the server reader for the whole brain');
    okIds(serverNotArray, [], 'HP6: a non-array card list yields an empty Map from the server reader');
  });

  // ── HP7 — enrichment changed after the card was embedded ────────────────
  await attempt('HP7', async () => {
    const s = scenario('enrichment-changed');
    const cards = [SHORT, ENRICHED];
    await s.run([enrich(ENRICHED, QUESTION), { op: 'write', cards }]);
    const [, r1, r2] = await s.run([enrich(ENRICHED, QUESTION_2), { op: 'read1', cards }, { op: 'read2', cards }]);
    okIds(r1, ['enriched', 'short'], 'HP7: hook reader keeps a vector whose card text is unchanged');
    okIds(r2, ['enriched', 'short'], 'HP7: server reader keeps a vector whose card text is unchanged');
    const [refreshed] = await s.run([{ op: 'write', cards }]);
    ok(refreshed.embedCalls === 1 && refreshed.embeddedTexts.length === 1 && refreshed.embeddedTexts[0].includes(QUESTION_2),
      'HP7: the next writer run re-embeds exactly the card whose enrichment changed');
    ok(allCarryT(readCards(s.cacheFile()), cards), 'HP7: and stores it with h, t and v');
  });

  // ── HP8 — the unbounded (legacy mode) read path ─────────────────────────
  await attempt('HP8', async () => {
    const s = scenario('legacy-mode', 'legacy');
    const cards = [SHORT, LONG, ENRICHED];
    await s.run([enrich(ENRICHED, QUESTION), { op: 'write', cards }]);
    const warm = await readers(s, cards);
    okIds(warm.r1, ids(...cards), 'HP8: hook reader returns all three cards from a legacy-mode cache');
    okIds(warm.r2, ids(...cards), 'HP8: server reader in legacy mode returns all three cards');
    editCache(s.cacheFile(), stripT);
    const legacy = await readers(s, cards);
    okIds(legacy.r1, ['long', 'short'], 'HP8: hook reader applies the h rule to a legacy-mode h-only cache');
    okIds(legacy.r2, ['long', 'short'], 'HP8: server reader in legacy mode applies the h rule');
    const [backfill] = await s.run([{ op: 'write', cards }]);
    ok(backfill.embedCalls === 0 && allCarryT(readCards(s.cacheFile()), cards), 'HP8: the legacy-mode writer backfills t with zero embeds');
  });

  // ── HP9 — the 1,500-character boundary ──────────────────────────────────
  await attempt('HP9', async () => {
    const s = scenario('boundary');
    // The brain emoji is a surrogate pair occupying code units 1,499 and
    // 1,500, so the embed cap cuts it in half for writer and readers alike.
    const cards = [
      card('len1499', fill('Boundary below', 1499)),
      card('len1500', fill('Boundary exact', 1500)),
      card('len1501', fill('Boundary above', 1501)),
      card('emoji', `${fill('Boundary emoji', 1499)}${String.fromCodePoint(0x1F9E0)} and text after the cap.`),
    ];
    await s.run([{ op: 'write', cards }]);
    const current = await readers(s, cards);
    okIds(current.r1, ids(...cards), 'HP9: hook reader accepts every boundary card with t');
    okIds(current.r2, ids(...cards), 'HP9: server reader accepts every boundary card with t');
    editCache(s.cacheFile(), stripT);
    const legacy = await readers(s, cards);
    okIds(legacy.r1, ids(...cards), 'HP9: hook reader accepts every boundary card from an h-only cache');
    okIds(legacy.r2, ids(...cards), 'HP9: server reader accepts every boundary card from an h-only cache');
  });

  // ── HP10 — no cache, and lookup before hashing ──────────────────────────
  await attempt('HP10', async () => {
    const s = scenario('no-cache');
    const many = Array.from({ length: 50 }, (_, index) => card(`c${index}`, `Card number ${index} about the uploader retry policy.`));
    const [r1, r2] = await s.run([{ op: 'read1', cards: many }, { op: 'read2', cards: many }]);
    okIds(r1, [], 'HP10: hook reader returns an empty Map when no cache exists');
    okIds(r2, [], 'HP10: server reader returns an empty Map when no cache exists');
    ok(r1.hashCalls <= 8, `HP10: the hook reader hashes no card text without a cache (${r1.hashCalls} hash calls for 50 cards)`);
    await s.run([{ op: 'write', cards: [many[0]] }]);
    const [sparse] = await s.run([{ op: 'read1', cards: many }]);
    okIds(sparse, ['c0'], 'HP10: hook reader returns the one cached card');
    ok(sparse.hashCalls <= 8, `HP10: and hashes only cards that have a cached vector (${sparse.hashCalls} hash calls for 50 cards)`);
  });

  // ── HP11 — the server reader's memo ─────────────────────────────────────
  await attempt('HP11', async () => {
    const s = scenario('memo');
    const third = card('third', 'Share links expire after thirty days unless renewed.');
    const cards = [SHORT, LONG, third];
    await s.run([{ op: 'write', cards }]);
    const [first, second, , afterDrop] = await s.run([
      { op: 'read2', cards },
      { op: 'read2', cards },
      { op: 'drop', file: s.cacheFile(), id: 'third' },
      { op: 'read2', cards },
    ]);
    okIds(first, ids(...cards), 'HP11: first read returns all three cards');
    ok(second.sameMap === true, 'HP11: an unchanged cache serves the memoized Map');
    okIds(afterDrop, ['long', 'short'], 'HP11: a rewritten cache is read again');
    ok(afterDrop.sameMap === false, 'HP11: and does not serve the stale Map');
  });

  // ── HP12 — Windows drive-case alias files keep t ────────────────────────
  if (process.platform === 'win32') {
    await attempt('HP12', async () => {
      const cards = [SHORT, LONG, ENRICHED];
      const s = scenario('alias-only');
      await s.run([enrich(ENRICHED, QUESTION), { op: 'write', cards }]);
      const canonical = s.cacheFile();
      const alias = s.keyFile(s.brain.replace(/\\/g, '/'));
      if (alias === canonical) { ok(true, 'HP12: raw and canonical cache keys coincide here, alias scenarios skipped'); return; }
      fs.renameSync(canonical, alias);
      const { r1, r2 } = await readers(s, cards);
      okIds(r1, ids(...cards), 'HP12: hook reader returns all three cards from an alias-only cache');
      okIds(r2, ids(...cards), 'HP12: server reader returns all three cards from an alias-only cache');
      const [merged] = await s.run([{ op: 'write', cards }]);
      ok(merged.embedCalls === 0 && fs.existsSync(canonical) && allCarryT(readCards(canonical), cards),
        'HP12: the writer merges the alias into the canonical file with t and zero embeds');

      const shadow = scenario('alias-shadow');
      await shadow.run([enrich(ENRICHED, QUESTION), { op: 'write', cards }]);
      const shadowCanonical = shadow.cacheFile();
      fs.copyFileSync(shadowCanonical, shadow.keyFile(shadow.brain.replace(/\\/g, '/')));
      editCache(shadowCanonical, stripT);
      const [healed] = await shadow.run([{ op: 'write', cards }]);
      ok(healed.embedCalls === 0 && allCarryT(readCards(shadowCanonical), cards),
        'HP12: a canonical entry without t is backfilled beside an alias that has it, with zero embeds');

      // Recorded, not endorsed: the readers choose their cache FILE
      // differently. The state lasts until a writer run folds the alias in.
      const split = scenario('alias-split');
      const pair = [SHORT, LONG];
      await split.run([{ op: 'write', cards: pair }]);
      const splitCanonical = split.cacheFile();
      const splitAlias = split.keyFile(split.brain.replace(/\\/g, '/'));
      fs.copyFileSync(splitCanonical, splitAlias);
      editCache(splitCanonical, (stored) => { delete stored.long; });
      editCache(splitAlias, (stored) => { delete stored.short; });
      const apart = await readers(split, pair);
      okIds(apart.r1, ['short'], 'HP12: on a split cache the hook reader stops at the first cache file');
      okIds(apart.r2, ['long', 'short'], 'HP12: while the server reader merges the alias file');
      const [folded] = await split.run([{ op: 'write', cards: pair }]);
      ok(folded.embedCalls === 0 && allCarryT(readCards(splitCanonical), pair), 'HP12: a writer run folds the alias into the canonical file with zero embeds');
      const together = await readers(split, pair);
      okIds(together.r1, ['long', 'short'], 'HP12: after which the hook reader returns both cards');
      okIds(together.r2, ['long', 'short'], 'HP12: and so does the server reader');
    });
  } else {
    ok(true, 'HP12: Windows drive-case alias scenarios skipped on non-Windows');
  }

  // ── HP13 — one rule, two copies ─────────────────────────────────────────
  await attempt('HP13', async () => {
    const s = scenario('rule');
    const [rule] = await s.run([{ op: 'rule' }]);
    ok(typeof rule.source.hook === 'string' && typeof rule.source.server === 'string', 'HP13: both modules export vectorEntryMatchesText');
    const collapse = (source) => String(source).replace(/\s+/g, ' ').trim();
    ok(typeof rule.source.hook === 'string' && collapse(rule.source.hook) === collapse(rule.source.server),
      'HP13: the two copies are textually identical (whitespace aside)');
    ok(!/\bsha1\b|\bcrypto\b/.test(String(rule.source.hook)) && !/\bsha1\b|\bcrypto\b/.test(String(rule.source.server)),
      'HP13: the rule hashes nothing itself, so the differing sha1 helpers of the two modules cannot make the copies disagree');
    RULE_MATRIX.forEach(([label, , , , expected, thunkCalls], index) => {
      const row = rule.cases[index] || {};
      ok(row.hook === expected && row.server === expected, `HP13: ${label} → ${expected} in both copies (hook ${row.hook}, server ${row.server})`);
      ok(row.hookThunk === thunkCalls && row.serverThunk === thunkCalls, `HP13: ${label} → truncated hash computed ${thunkCalls} time(s)`);
    });
  });

  // ── HP15 — the embedder fails, the hashing-only repair still lands ──────
  for (const mode of ['bounded', 'legacy']) {
    await attempt(`HP15 ${mode}`, async () => {
      const tag = `HP15 ${mode}`;
      const s = scenario(`embed-fails-${mode}`, mode);
      const kept = card('kept', 'Undo = one step per gesture; a drag that moves forty cards is reverted by a single ctrl-z.');
      const headEdited = card('headedit', 'Exports keep the embedded fonts so a shared file renders the same elsewhere.');
      const fresh = card('fresh', 'Templates open as a new untitled space and never overwrite the template file.');
      const stored = [SHORT, LONG, ENRICHED, kept, headEdited];
      await s.run([
        enrich(ENRICHED, QUESTION),
        enrich(kept, 'how many steps back does one undo take after moving a lot of cards?'),
        { op: 'write', cards: stored },
      ]);
      editCache(s.cacheFile(), (cards) => stripT(cards, ['short', 'long', 'enriched', 'headedit']));
      const onDisk = readCards(s.cacheFile());
      // `kept` now needs a re-embed (its enrichment changed) and still carries
      // a valid t; `headedit` was edited inside the embed cap; `fresh` is new.
      await s.run([enrich(kept, 'does reverting a big move need one keypress or one per card?')]);
      const cards = [SHORT, LONG, ENRICHED, kept, card('headedit', `Revised. ${headEdited.text}`), fresh];
      const [failed] = await s.run([{ op: 'write', cards, failEmbed: true }]);
      ok(failed.threw === true && failed.embedCalls >= 1, `${tag}: the writer still reports the embed failure`);
      ok(failed.error?.message === EMBED_FAILURE.message && failed.error?.code === EMBED_FAILURE.code,
        `${tag}: and rethrows the embedder's own error, message and code intact (${failed.error?.code}: ${failed.error?.message})`);
      ok(failed.cacheWrites === 1 && failed.cacheWriteFailures === 0, `${tag}: and persists the repair once (${failed.cacheWrites} cache write(s))`);
      const after = readCards(s.cacheFile());
      ok(allCarryT(after, [SHORT, LONG, ENRICHED]), `${tag}: kept entries gained t although nothing was embedded`);
      ok(same(after.kept, onDisk.kept), `${tag}: the vector awaiting a re-embed is still on disk, untouched`);
      ok(same(after.headedit, onDisk.headedit) && after.headedit.t === undefined,
        `${tag}: an entry whose embed input changed is not stamped with the new text's fingerprint`);
      ok(after.fresh === undefined, `${tag}: no entry is invented for the card that could not be embedded`);
      ok(debris(s).length === 0, `${tag}: no lock or temp file is left behind`);
      const seen = await readers(s, cards);
      okIds(seen.r1, ['enriched', 'kept', 'long', 'short'], `${tag}: hook reader returns the repaired cards and rejects the edited one`);
      okIds(seen.r2, ['enriched', 'kept', 'long', 'short'], `${tag}: server reader returns the repaired cards and rejects the edited one`);

      const bytes = fs.readFileSync(s.cacheFile());
      const stamp = fs.statSync(s.cacheFile()).mtimeMs;
      const [failedAgain] = await s.run([{ op: 'write', cards, failEmbed: true }]);
      ok(failedAgain.threw === true && failedAgain.cacheWrites === 0
        && bytes.equals(fs.readFileSync(s.cacheFile())) && fs.statSync(s.cacheFile()).mtimeMs === stamp,
        `${tag}: a failed run with nothing left to repair does not write the file`);

      const [healed] = await s.run([{ op: 'write', cards }]);
      ok(healed.threw === false && healed.embeddedTexts.length === 3 && same(healed.ids, ids(...cards).sort()),
        `${tag}: the next healthy run embeds exactly the three cards that were waiting (${healed.embeddedTexts?.length})`);
      ok(allCarryT(readCards(s.cacheFile()), cards), `${tag}: and every entry carries h, t and v`);
      await settled(s, cards, tag);
    });
  }

  // The failure write beside a Windows drive-case alias file, as in HP12. Two
  // properties keep it safe: what the merge kept wins over what it refused,
  // and of the refused copies the canonical file's comes first.
  if (process.platform === 'win32') {
    await attempt('HP15 alias', async () => {
      const tag = 'HP15 alias';
      const s = scenario('embed-fails-alias');
      const kept = card('kept', 'Undo = one step per gesture; a drag that moves forty cards is reverted by a single ctrl-z.');
      const stale = card('stale', 'Exports keep the embedded fonts so a shared file renders the same elsewhere.');
      const tOnly = card('tonly', 'Templates open as a new untitled space and never overwrite the template file.');
      const aliasOnly = card('aliasonly', 'Share links expire after thirty days unless renewed.');
      const cards = [kept, stale, tOnly, aliasOnly];
      // Every entry comes from the REAL writer, in two generations: the
      // superseded wording first, then the current text.
      const superseded = (c) => card(c.id, `Superseded wording. ${c.text}`);
      await s.run([{ op: 'write', cards: [superseded(kept), superseded(stale), superseded(tOnly), aliasOnly] }]);
      const canonical = s.cacheFile();
      const alias = s.keyFile(s.brain.replace(/\\/g, '/'));
      if (alias === canonical) { ok(true, `${tag}: raw and canonical cache keys coincide here, alias scenario skipped`); return; }
      const old = readCards(canonical);
      await s.run([
        enrich(tOnly, 'what happens to the template file when I start a space from it?'),
        { op: 'write', cards: [kept, stale, tOnly] },
      ]);
      // `tonly` now needs a re-embed (its enrichment changed) and still
      // carries a valid t: the writer refuses it, a reader accepts it.
      await s.run([enrich(tOnly, 'does opening a template ever change the original?')]);
      fs.copyFileSync(canonical, alias);
      editCache(canonical, (stored) => { delete stored.kept.t; stored.stale = old.stale; });
      editCache(alias, (stored) => { stored.kept = old.kept; stored.tonly = old.tonly; stored.aliasonly = old.aliasonly; });
      const before = { canonical: readCards(canonical), alias: readCards(alias) };
      ok(['kept', 'stale', 'tonly'].every(id => before.canonical[id].h !== before.alias[id].h && !same(before.canonical[id].v, before.alias[id].v))
        && before.canonical.aliasonly === undefined && before.canonical.tonly.t === sha1(tOnly.text),
        `${tag}: fixture holds two different copies of kept, stale and tonly, and one entry in the alias only`);
      const seenBefore = await readers(s, cards);
      okIds(seenBefore.r1, ['kept', 'tonly'], `${tag}: before the write the hook reader returns what the canonical file proves`);
      okIds(seenBefore.r2, ['aliasonly', 'kept', 'stale', 'tonly'], `${tag}: before the write the server reader returns the merge of both files`);

      const [failed] = await s.run([{ op: 'write', cards, failEmbed: true }]);
      ok(failed.threw === true && failed.embedCalls >= 1 && failed.cacheWrites === 1 && failed.cacheWriteFailures === 0,
        `${tag}: the embed fails and the repair is persisted once (${failed.cacheWrites} cache write(s))`);
      const after = readCards(canonical);
      ok(after.kept?.h === before.canonical.kept.h && same(after.kept?.v, before.canonical.kept.v) && after.kept?.t === sha1(kept.text),
        `${tag}: the kept entry still carries the canonical vector and now has t`);
      ok(same(after.stale, before.alias.stale), `${tag}: the stale id holds the alias file's fresh copy`);
      ok(same(after.tonly, before.canonical.tonly), `${tag}: the canonical file's own refused entry is still there with its own vector`);
      ok(same(after.aliasonly, before.alias.aliasonly), `${tag}: the alias-only entry is present`);
      ok(debris(s).length === 0, `${tag}: no lock or temp file is left behind`);
      const seenAfter = await readers(s, cards);
      okIds(seenAfter.r1, ids(...cards), `${tag}: after the write the hook reader returns all four cards`);
      okIds(seenAfter.r2, ids(...cards), `${tag}: after the write the server reader returns all four cards`);
      ok(['r1', 'r2'].every(key => Array.isArray(seenBefore[key].ids) && Array.isArray(seenAfter[key].ids)
        && seenBefore[key].ids.every(id => seenAfter[key].ids.includes(id))),
        `${tag}: neither reader lost a card id it returned before the write`);
    });
  } else {
    ok(true, 'HP15 alias: Windows drive-case alias scenario skipped on non-Windows');
  }

  // ── HP16 — a reader holds the cache file while the writer commits ───────
  await attempt('HP16', async () => {
    const cards = [SHORT, LONG];
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const s = scenario(`rename-${code.toLowerCase()}`);
      const [written] = await s.run([{ op: 'write', cards, rename: { code, failures: 2 } }]);
      ok(written.threw === false && written.renameAttempts === 3, `HP16: a transient ${code} is retried until the rename succeeds (${written.renameAttempts} attempts)`);
      ok(written.cacheWrites === 1 && written.cacheWriteFailures === 0, `HP16: and ${code} counts as one write, no failure`);
      ok(allCarryT(readCards(s.cacheFile()), cards) && debris(s).length === 0, `HP16: the cache is committed after ${code}, with no temp file left`);
    }

    // The reviewed case: the one-time backfill of a legacy cache meets a reader.
    const legacy = scenario('rename-backfill');
    const enrichedCards = [SHORT, LONG, ENRICHED];
    await legacy.run([enrich(ENRICHED, QUESTION), { op: 'write', cards: enrichedCards }]);
    editCache(legacy.cacheFile(), stripT);
    const [backfill] = await legacy.run([{ op: 'write', cards: enrichedCards, rename: { code: 'EPERM', failures: 4 } }]);
    ok(backfill.embedCalls === 0 && backfill.renameAttempts === 5 && backfill.cacheWrites === 1,
      `HP16: the backfill survives four refused renames (${backfill.renameAttempts} attempts, ${backfill.cacheWrites} write)`);
    ok(allCarryT(readCards(legacy.cacheFile()), enrichedCards), 'HP16: and every entry carries t afterwards');
    const seen = await readers(legacy, enrichedCards);
    okIds(seen.r1, ids(...enrichedCards), 'HP16: hook reader returns the enriched card after that backfill');
    okIds(seen.r2, ids(...enrichedCards), 'HP16: server reader returns the enriched card after that backfill');

    const held = scenario('rename-held');
    const [refused] = await held.run([{ op: 'write', cards, rename: { code: 'EPERM', failures: 99 } }]);
    ok(refused.threw === false && same(refused.ids, ['long', 'short']), 'HP16: a holder that stays does not fail the caller, the vectors are returned');
    ok(refused.renameAttempts === 5, `HP16: the backoff is bounded at five attempts (${refused.renameAttempts})`);
    ok(refused.cacheWrites === 0 && refused.cacheWriteFailures === 1, `HP16: the lost write is counted (${refused.cacheWriteFailures} failure(s), ${refused.cacheWrites} write(s))`);
    ok(held.cacheFiles().length === 0 && debris(held).length === 0, 'HP16: nothing is left on disk, neither a cache nor a temp file');
    const [retried] = await held.run([{ op: 'write', cards }]);
    ok(retried.embedCalls === 1 && retried.cacheWrites === 1 && allCarryT(readCards(held.cacheFile()), cards),
      'HP16: the next run without a holder persists the cache');

    const fatal = scenario('rename-fatal');
    const [gaveUp] = await fatal.run([{ op: 'write', cards, rename: { code: 'ENOSPC', failures: 99 } }]);
    ok(gaveUp.threw === false && gaveUp.renameAttempts === 1 && gaveUp.cacheWriteFailures === 1,
      `HP16: an error that is not a held file is not retried (${gaveUp.renameAttempts} attempt)`);
    ok(debris(fatal).length === 0, 'HP16: and leaves no temp file');

    // Legacy mode has no lock to serialise writers, so a delayed rename could
    // commit an older snapshot after a newer one: the first refusal is final.
    const unlocked = scenario('rename-legacy-mode', 'legacy');
    const [single] = await unlocked.run([{ op: 'write', cards, rename: { code: 'EPERM', failures: 1 } }]);
    ok(single.renameAttempts === 1, `HP16: legacy mode does not retry a refused rename (${single.renameAttempts} attempt(s))`);
    ok(single.cacheWrites === 0 && single.cacheWriteFailures === 1,
      `HP16: legacy mode counts the lost write (${single.cacheWriteFailures} failure(s), ${single.cacheWrites} write(s))`);
    ok(single.threw === false && same(single.ids, ['long', 'short']), 'HP16: the legacy-mode caller still receives all vectors');
    ok(unlocked.cacheFiles().length === 0 && debris(unlocked).length === 0, 'HP16: and legacy mode leaves neither a cache nor a temp file');
  });

  // ── HP14 — the hook module stays standalone ─────────────────────────────
  const hookSource = fs.readFileSync(new URL('../src/brain-semantic.mjs', import.meta.url), 'utf8');
  const staticImports = [...hookSource.matchAll(/^\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(match => match[1]);
  ok(staticImports.length > 0 && staticImports.every(name => builtinModules.includes(name.replace(/^node:/, ''))),
    `HP14: brain-semantic.mjs statically imports Node builtins only (${staticImports.join(', ')})`);
} catch (error) {
  console.error(error?.stack || error);
  failures++;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} assertion(s) failed` : '\n✓ semantic-hash-parity: all assertions passed');
process.exit(failures ? 1 : 0);
