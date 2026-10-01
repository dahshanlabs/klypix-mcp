// Judgment provenance — every human-adjacent yes/no about the brain, recorded
// where it can train a judge instead of evaporating.
//
// The brain already collects VERDICTS: a ✓ marker retires a card, brain_reconcile
// confirm/dismiss settles a fulfillment hint, brain_connect draws a not_fulfilled
// / not_contradiction dismissal, a captured 🛠️ skill retires the draft rule it
// fulfils, and (2026-09-29) a full resolve settles its unambiguous 'likely
// closed by' hint. Until now each verdict changed the brain and threw away WHO
// decided and THROUGH WHICH SURFACE — the 19 dismissal edges accumulated over
// the brains' whole lifetime carry no actor, no session, no timestamp. This
// sidecar shadows each verdict with an attributable record.
//
// SIDECAR, DELIBERATELY (same doctrine as enrichment.mjs, its sibling): card and
// connection shape changes are the expensive kind (merge driver, sync, renderer,
// read_canvas all must learn them), and judgments are a machine-local training /
// audit signal. Same keying (sha16 of the resolved brain path), same atomic
// tmp+rename write, same corrupt-starts-empty rule — additive signal, never
// load-bearing state.
//
// NO TTL, DELIBERATELY — the one place this file diverges from enrichment.
// Enrichment's 60-day TTL serves a rolling retrieval-quality window on a hot
// embed path; judgments are scarce ground-truth labels whose value GROWS with
// age, and their read path is a training script, not the embedder. Bounded by
// count instead (oldest-by-lastTs pruned past the cap).
//
// PROVENANCE HONESTY is the schema's whole point: a terminal marker can be
// emitted by any agent, so the strongest attainable actor classes today are
// 'agent-listing-bound' (brain_reconcile structurally accepts only pairs its
// own listing served) and 'agent-human-adjacent' (a machine-turn-guarded human
// prompt sat above the marker). 'human-ui' is RESERVED for a future app-side
// confirm surface — nothing may write it until a human can actually click one.
// Never describe any current record as "human-confirmed" in product copy.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { enrichmentKeyFor, normalizeForKey } from './enrichment.mjs';

export const PROVENANCE_VERSION = 1;
export const PROVENANCE_MAX_JUDGMENTS = 4096;
export const PROVENANCE_MAX_REJECTED = 2048;
export const PROVENANCE_MIN_KEY_CHARS = 24;   // enrichment's own minimum-body bar
export const PROVENANCE_REJECTED_TEXT_CHARS = 240;

export const PROVENANCE_KINDS = new Set(['pair', 'rule', 'prompt']);
export const PROVENANCE_DIRECTIONS = new Set(['fulfills', 'contradicts', 'closes', 'rule-covers', 'silence']);
export const PROVENANCE_VERDICTS = new Set(['yes', 'no']);
export const PROVENANCE_SOURCES = new Set([
  'reconcile-confirm', 'reconcile-dismiss', 'connect-dismiss',
  'marker-resolve', 'marker-closes', 'hint-settle',
  'draft-promotion', 'draft-decay',
  'app-ui',        // reserved: future desktop confirm affordance
  'legacy-edge',   // reserved: one-shot backfill of pre-provenance dismissal edges
]);
export const PROVENANCE_ACTORS = new Set([
  'human-ui',              // reserved — no writer may claim it today
  'agent-listing-bound',   // brain_reconcile: structurally bound to the served listing
  'agent-human-adjacent',  // a machine-turn-guarded human prompt sat above the marker
  'agent',                 // agent-asserted, nothing stronger provable
  'legacy-edge',           // reserved for the backfill
]);

const sha16 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);

// The engine version stamped on every record. Both layouts are probed because
// the deployed bundle is FLAT (~/.claude/project-brain/package.json sits beside
// this file) while the repo keeps src/ one level below package.json.
const ENGINE_VERSION = (() => {
  for (const rel of ['../package.json', './package.json']) {
    try {
      const v = JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8')).version;
      if (v) return String(v);
    } catch { /* try the other layout */ }
  }
  return '';
})();

export function provenanceFileFor(brainPath, home = os.homedir()) {
  const key = sha16(path.resolve(String(brainPath || '')).replace(/\\/g, '/').toLowerCase());
  return path.join(home, '.claude', 'project-brain', 'provenance', `${key}.json`);
}

export function rejectedFileFor(brainPath, home = os.homedir()) {
  const key = sha16(path.resolve(String(brainPath || '')).replace(/\\/g, '/').toLowerCase());
  return path.join(home, '.claude', 'project-brain', 'provenance', `${key}.rejected.json`);
}

// Corrupt or absent both start empty: judgments are an additive signal, never
// load-bearing state — losing the sidecar costs training data, not brain truth.
function readJsonFile(file, field) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.v !== PROVENANCE_VERSION || typeof parsed[field] !== 'object' || !parsed[field]) {
      return { v: PROVENANCE_VERSION, [field]: {} };
    }
    return parsed;
  } catch {
    return { v: PROVENANCE_VERSION, [field]: {} };
  }
}

// ── Cross-process write safety (2026-09-29 review) ───────────────────────────
// Judgments are NO-TTL ground truth: a lost read-modify-write here silently
// wipes labels that can never be re-derived. Enrichment shares the tmp+rename
// shape but tolerates loss (its rolling TTL window refills); this file does
// not — and multiple agent Stop hooks writing one sidecar is the product's
// core scenario, not a corner. So every RMW runs under the same wx-open
// lockfile idiom the hook uses for its pending-captures queue, and the final
// rename retries the Windows sharing-violation codes with backoff instead of
// throwing into a caller that swallows everything. The probe that forced
// this: two 200-judgment writers interleaving lost roughly half of all records,
// leaked tmp files, and once left the sidecar entirely absent.
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* */ } };
const LOCK_STALE_MS = 10_000;   // a sidecar RMW is sub-second; ten seconds = a dead holder
const heldLockTokens = new Map();
function acquireLock(lockPath, { tries = 40, waitMs = 25 } = {}) {
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* */ }
  for (let i = 0; i < tries; i++) {
    try {
      const token = `${process.pid} ${crypto.randomBytes(6).toString('hex')}`;
      const fd = fs.openSync(lockPath, 'wx'); fs.writeSync(fd, token); fs.closeSync(fd);
      heldLockTokens.set(lockPath, token);
      return true;
    } catch (e) {
      if (e && e.code !== 'EEXIST') return false;   // unexpected FS error → caller writes best-effort
      try { if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lockPath); } catch { /* raced — retry */ }
      sleepSync(waitMs);
    }
  }
  return false;   // contended past ~1s → the caller still writes (never block a Stop hook on a stuck peer)
}
function releaseLock(lockPath) {
  const token = heldLockTokens.get(lockPath);
  heldLockTokens.delete(lockPath);
  try {
    // Never remove a lock this process no longer owns (broken as stale and re-taken).
    if (token !== undefined && fs.readFileSync(lockPath, 'utf8') !== token) return;
    fs.unlinkSync(lockPath);
  } catch { /* */ }
}
function withFileLock(file, fn) {
  const lockPath = `${file}.lock`;
  const got = acquireLock(lockPath);
  try { return fn(); }
  finally { if (got) releaseLock(lockPath); }
}
// Abandoned tmp files (a killed process, a thrown rename) are swept once they
// are unambiguously stale — the hook's 15-minute sweep idiom.
function sweepStaleTmp(file) {
  try {
    const dir = path.dirname(file), prefix = `${path.basename(file)}.tmp-`;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(dir, name);
      try { if (now - fs.statSync(full).mtimeMs > 15 * 60 * 1000) fs.unlinkSync(full); } catch { /* next sweep */ }
    }
  } catch { /* dir unreadable — best-effort */ }
}
const RENAME_BACKOFF_MS = [15, 40, 100, 250];
function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); break; }
      catch (e) {
        // EPERM/EACCES/EBUSY: Windows sharing violations from a concurrent
        // reader (or AV) — transient, worth the bounded backoff. Anything
        // else propagates to the caller's guard.
        if (attempt >= RENAME_BACKOFF_MS.length || !['EPERM', 'EACCES', 'EBUSY'].includes(e?.code)) throw e;
        sleepSync(RENAME_BACKOFF_MS[attempt]);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  sweepStaleTmp(file);
}

// One side of a judgment: { id?, text? } in → { id?, key? } stored. The key is
// enrichment's normalized 160-char body prefix, so judgments survive merge-twin
// id churn exactly the way enrichment entries do.
function normalizeSide(side) {
  if (!side || typeof side !== 'object') return null;
  const id = String(side.id || '').trim();
  const key = enrichmentKeyFor(side.text || '');
  const out = {};
  if (id) out.id = id;
  if (key) out.key = key;
  return (out.id || out.key) ? out : null;
}

const sideAnchored = (side) => !!side && (!!side.id || String(side.key || '').length >= PROVENANCE_MIN_KEY_CHARS);

/**
 * Validate one judgment entry; returns the storable form or null. Quality gates
 * are enum-strict (a typo'd source must never mint a new category silently) and
 * refuse a side that is neither id-addressed nor carrying a joinable key.
 */
export function validateJudgment(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  const { kind, direction, verdict, source } = entry;
  const actor = entry.actor;
  if (!PROVENANCE_KINDS.has(kind) || !PROVENANCE_DIRECTIONS.has(direction)) return null;
  if (!PROVENANCE_VERDICTS.has(verdict) || !PROVENANCE_SOURCES.has(source)) return null;
  if (!PROVENANCE_ACTORS.has(actor)) return null;
  const from = normalizeSide(entry.from);
  const to = normalizeSide(entry.to);
  if (!sideAnchored(from)) return null;
  if (kind === 'pair' && !sideAnchored(to)) return null;
  const out = { kind, direction, verdict, source, actor, from, ...(to ? { to } : {}) };
  // Hash-only adjacency: the prompt TEXT already flows to enrichment under its
  // own quality gate; here only the fingerprint that ties records to one
  // prompt is kept — never the words.
  const promptText = String(entry.humanPromptText || '').trim();
  if (promptText) out.humanPrompt = sha16(promptText);
  const client = String(entry.client || '').trim().slice(0, 60);
  if (client) out.client = client;
  const session = String(entry.session || '').trim().slice(0, 80);
  if (session) out.session = session;
  out.engine = ENGINE_VERSION;
  out.firstTs = now;
  out.lastTs = now;
  out.count = 1;
  return out;
}

// JSON-array encoding, NOT '|'.join: normalizeForKey keeps pipes, so a key
// containing ' | ' could alias two DISTINCT tuples onto one jid and silently
// absorb the second judgment as a repeat of the first (2026-09-29 review).
// JSON.stringify escapes every delimiter, so the encoding is unambiguous.
const jidOf = (entry) => sha16(JSON.stringify([
  entry.kind, entry.direction,
  entry.from.id || entry.from.key || '',
  entry.to ? (entry.to.id || entry.to.key || '') : '',
  entry.verdict, entry.source,
]));

/**
 * Record judgment entries for a brain. Repeats of the same verdict through the
 * same surface dedup into count++ / lastTs — a re-observed decay or a re-run
 * capture never doubles the record. Returns { recorded, repeated, refused }.
 */
export function recordJudgments(brainPath, entries, { home = os.homedir(), now = Date.now() } = {}) {
  let recorded = 0, repeated = 0, refused = 0;
  const valid = [];
  for (const raw of (Array.isArray(entries) ? entries : [])) {
    const entry = validateJudgment(raw, now);
    if (!entry) { refused++; continue; }
    valid.push(entry);
  }
  if (!valid.length) return { recorded, repeated, refused };
  const file = provenanceFileFor(brainPath, home);
  // Locked RMW: a concurrent Stop hook's records must merge, never vanish
  // under a read-modify-write interleave (see the lock header above).
  return withFileLock(file, () => {
    const data = readJsonFile(file, 'judgments');
    for (const entry of valid) {
      const jid = jidOf(entry);
      const existing = data.judgments[jid];
      if (existing) {
        existing.count = Number(existing.count || 1) + 1;
        existing.lastTs = now;
        // Adjacency can only strengthen a repeat, never weaken the original.
        if (entry.humanPrompt && !existing.humanPrompt) existing.humanPrompt = entry.humanPrompt;
        repeated++;
      } else {
        data.judgments[jid] = entry;
        recorded++;
      }
    }
    // Count-bounded, NO TTL (see the header). Oldest-by-lastTs pruned first.
    const jids = Object.keys(data.judgments);
    if (jids.length > PROVENANCE_MAX_JUDGMENTS) {
      jids.sort((a, b) => Number(data.judgments[a].lastTs || 0) - Number(data.judgments[b].lastTs || 0));
      for (const jid of jids.slice(0, jids.length - PROVENANCE_MAX_JUDGMENTS)) delete data.judgments[jid];
    }
    atomicWriteJson(file, data);
    return { recorded, repeated, refused };
  });
}

// Memoized on mtime AND size (enrichment's EN2 lesson: two writes can land in
// one mtime tick, and mtime alone then serves the pre-rewrite parse).
const judgeMemo = new Map();   // file -> { stamp, entries }
export function readJudgments(brainPath, { home = os.homedir() } = {}) {
  const file = provenanceFileFor(brainPath, home);
  let stamp = '';
  try { const st = fs.statSync(file); stamp = `${st.mtimeMs}|${st.size}`; } catch { stamp = ''; }
  const memo = judgeMemo.get(file);
  if (memo && memo.stamp === stamp) return memo.entries;
  const data = stamp ? readJsonFile(file, 'judgments') : { judgments: {} };
  const entries = Object.entries(data.judgments).map(([jid, entry]) => ({ jid, ...entry }));
  judgeMemo.set(file, { stamp, entries });
  if (judgeMemo.size > 8) judgeMemo.delete(judgeMemo.keys().next().value);
  return entries;
}

// ── Rejected-prompt pool ─────────────────────────────────────────────────────
// The 1.86 enrichment quality gate computes a refusal reason and throws the
// text away. Those refusals are the acknowledgement-class NEGATIVES a judge
// study needs, so recordEnrichment forwards its discards here (zero call-site
// changes — both writers already funnel through it). Privacy screen: the
// machine / console / pasted-doc classes can embed secrets and pasted private
// material, so they store hash+length ONLY; low-content / too-short texts are
// by construction under 4 content tokens (the acknowledgement class) and are
// kept verbatim — unless they look credential-shaped, which demotes them to
// hash-only too ("key is hunter2" is 3 content tokens).
const REJECTED_TEXT_REASONS = new Set(['low-content', 'too-short']);
const CREDENTIAL_SHAPE_RE = /\b(?:key|token|secret|password|passwd|pwd|bearer|credential|api[_-]?key|otp|pin)\b\s*(?:[:=]|is\b)|[A-Za-z0-9+/=_-]{24,}/i;

export function recordRejectedEnrichment(brainPath, items, { home = os.homedir(), now = Date.now() } = {}) {
  let recorded = 0, repeated = 0;
  const list = [];
  for (const item of (Array.isArray(items) ? items : [])) {
    const reason = String(item?.reason || '').trim();
    const text = String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, PROVENANCE_REJECTED_TEXT_CHARS);
    if (!reason || !text) continue;
    const keepText = REJECTED_TEXT_REASONS.has(reason) && !CREDENTIAL_SHAPE_RE.test(text);
    const rid = sha16(`${reason}|${normalizeForKey(text)}`);
    list.push({ rid, entry: keepText ? { t: text, reason } : { h: sha16(text), reason, len: text.length } });
  }
  if (!list.length) return { recorded, repeated };
  const file = rejectedFileFor(brainPath, home);
  // Same locked RMW as the judgments (the pool shares the no-TTL scarcity argument).
  return withFileLock(file, () => {
    const data = readJsonFile(file, 'entries');
    for (const { rid, entry } of list) {
      const existing = data.entries[rid];
      if (existing) { existing.count = Number(existing.count || 1) + 1; existing.ts = now; repeated++; continue; }
      data.entries[rid] = { ...entry, ts: now, count: 1 };
      recorded++;
    }
    // Same scarcity argument as judgments: NO TTL, count-bounded, oldest pruned.
    const rids = Object.keys(data.entries);
    if (rids.length > PROVENANCE_MAX_REJECTED) {
      rids.sort((a, b) => Number(data.entries[a].ts || 0) - Number(data.entries[b].ts || 0));
      for (const rid of rids.slice(0, rids.length - PROVENANCE_MAX_REJECTED)) delete data.entries[rid];
    }
    atomicWriteJson(file, data);
    return { recorded, repeated };
  });
}

export function readRejected(brainPath, { home = os.homedir() } = {}) {
  // Rejected reads are rare (doctor / training script) — no memo needed.
  const file = rejectedFileFor(brainPath, home);
  if (!fs.existsSync(file)) return [];
  const data = readJsonFile(file, 'entries');
  return Object.entries(data.entries).map(([rid, entry]) => ({ rid, ...entry }));
}

/**
 * Join recorded judgments back to live card text — the labelled-pairs shape a
 * judge-training script consumes: [{ textA, textB, direction, label, actor,
 * source, ts }], label 1 = yes, 0 = no.
 *
 * Resolution is id-first, then key-substring against normalizeForKey(card
 * text) — the same join rule enrichment uses, so merge-twin id churn degrades
 * to the key path instead of dropping the row. `textA` must resolve to a real
 * card (a judgment about nothing trainable is dropped and counted); `textB`
 * may fall back to the recorded key itself — for a bare ✓ resolve the "closer"
 * is the resolve prose, which never was a card.
 */
export function judgeTrainingRows(brainPath, parsedCards, { home = os.homedir() } = {}) {
  const judgments = readJudgments(brainPath, { home });
  const cards = (Array.isArray(parsedCards) ? parsedCards : [])
    .filter((c) => c && c.type !== 'container' && String(c.text || '').trim());
  const byId = new Map(cards.map((c) => [c.id, c]));
  const norm = cards.map((c) => ({ c, n: normalizeForKey(c.text) }));
  const cardTextFor = (side) => {
    if (!side) return null;
    if (side.id && byId.has(side.id)) return String(byId.get(side.id).text || '');
    const key = String(side.key || '');
    if (key.length >= PROVENANCE_MIN_KEY_CHARS) {
      const hit = norm.find((x) => x.n.includes(key));
      if (hit) return String(hit.c.text || '');
    }
    return null;
  };
  const rows = [];
  let dropped = 0;
  for (const j of judgments) {
    const textA = cardTextFor(j.from);
    if (!textA) { dropped++; continue; }
    let textB = cardTextFor(j.to);
    if (!textB) {
      const fallback = String(j.to?.key || '');
      if (j.kind === 'pair' && fallback.length < PROVENANCE_MIN_KEY_CHARS) { dropped++; continue; }
      textB = fallback;
    }
    rows.push({
      textA, textB,
      direction: j.direction,
      label: j.verdict === 'yes' ? 1 : 0,
      actor: j.actor,
      source: j.source,
      ts: Number(j.lastTs || j.firstTs || 0),
    });
  }
  return { rows, total: judgments.length, dropped };
}

/**
 * Read-only counts for surfacing (brain-doctor). Absence is NEVER drift — a
 * brand-new brain has no judgments, and that is a fact, not a defect.
 */
export function provenanceCounts(brainPath, { home = os.homedir() } = {}) {
  const judgments = readJudgments(brainPath, { home });
  const rejected = readRejected(brainPath, { home });
  const byVerdict = {}, bySource = {}, byActor = {};
  let firstTs = null;
  for (const j of judgments) {
    byVerdict[j.verdict] = (byVerdict[j.verdict] || 0) + 1;
    bySource[j.source] = (bySource[j.source] || 0) + 1;
    byActor[j.actor] = (byActor[j.actor] || 0) + 1;
    const ts = Number(j.firstTs || 0);
    if (ts && (firstTs === null || ts < firstTs)) firstTs = ts;
  }
  let rejectedFirstTs = null;
  for (const r of rejected) {
    const ts = Number(r.ts || 0);
    if (ts && (rejectedFirstTs === null || ts < rejectedFirstTs)) rejectedFirstTs = ts;
  }
  return {
    judgments: { total: judgments.length, byVerdict, bySource, byActor, firstTs },
    rejected: { total: rejected.length, firstTs: rejectedFirstTs },
  };
}
