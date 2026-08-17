// Retrieval enrichment — the question that produced a card becomes searchable
// text for it.
//
// The measured failure of this brain's retrieval is a VOCABULARY gap inside a
// compressed cosine space: paraphrase questions ("grab-and-move navigation")
// share no words with the cards that answer them ("Pan = dedicated hand tool"),
// and the 2026-08-17 A/B falsified structural enrichment (area/tags/neighbour
// titles) a second time — prepending more project jargon compresses the space
// further (recall@5 62% → 52%). What a card is missing is the ASKER'S language,
// and the capture pipeline holds it for free: the human prompt (Claude hook,
// machine-turn-guarded) or the session's declared intent (MCP brain_note) that
// was live when the card was captured. Recording that alongside the card and
// feeding it to the embedder widens the vocabulary bridge without a model call,
// a format change, or anything new on the canvas.
//
// SIDECAR, DELIBERATELY. Card-shape changes are the expensive kind (merge
// driver, sync, renderer, read_canvas all must learn them — recorded blast-
// radius rule), and this data is a retrieval-quality signal with the same
// machine-local scope as the vector cache it feeds. It lives beside that cache
// in ~/.claude/project-brain/enrichment/, keyed per brain.
//
// KEYED BY BODY PREFIX, NOT CARD ID. Capture does not learn the id the engine
// assigns, and ids change across merge twins. The stored card TEXT always
// embeds the marker body verbatim, so a normalized body prefix is a stable,
// id-free join key: the read side substring-matches it against normalized card
// text — only for cards being (re)embedded, so the scan cost rides the
// embedding cost it amortizes into.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const ENRICHMENT_VERSION = 1;
export const ENRICHMENT_MAX_ENTRIES = 4096;
export const ENRICHMENT_MAX_QUESTIONS = 3;
export const ENRICHMENT_MAX_QUESTION_CHARS = 240;
export const ENRICHMENT_TTL_MS = 60 * 24 * 60 * 60 * 1000;   // 60 days
export const ENRICHMENT_KEY_CHARS = 160;
const ENRICHMENT_APPLY_CAP_CHARS = 400;   // max enrichment text appended per card at embed time

const sha16 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);

// One normalization for BOTH sides of the join. Lowercase + collapsed
// whitespace survives the decorations capture adds around the body (area
// prefix, emoji, #tags) because the body itself is embedded verbatim.
export const normalizeForKey = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

export const enrichmentKeyFor = (bodyText) => normalizeForKey(bodyText).slice(0, ENRICHMENT_KEY_CHARS);

export function enrichmentFileFor(brainPath, home = os.homedir()) {
  const key = sha16(path.resolve(String(brainPath || '')).replace(/\\/g, '/').toLowerCase());
  return path.join(home, '.claude', 'project-brain', 'enrichment', `${key}.json`);
}

function readFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.v !== ENRICHMENT_VERSION || typeof parsed.entries !== 'object') return { v: ENRICHMENT_VERSION, entries: {} };
    return parsed;
  } catch {
    // Corrupt or absent both start empty: enrichment is an additive quality
    // signal, never load-bearing state — losing it costs recall, not truth.
    return { v: ENRICHMENT_VERSION, entries: {} };
  }
}

const cleanQuestion = (q) => String(q || '').replace(/\s+/g, ' ').trim().slice(0, ENRICHMENT_MAX_QUESTION_CHARS);

/**
 * Record question/intent text for captured card bodies. `items` is
 * [{ body, question }]; entries merge per body key (deduped, newest kept,
 * capped). Bounded overall: past ENRICHMENT_MAX_ENTRIES the OLDEST entries are
 * pruned — enrichment is a rolling quality window, not an archive, and unlike
 * the claims lane nothing downstream depends on any single entry existing.
 */
export function recordEnrichment(brainPath, items, { home = os.homedir(), now = Date.now() } = {}) {
  const list = (Array.isArray(items) ? items : [])
    .map((item) => ({ key: enrichmentKeyFor(item?.body), q: cleanQuestion(item?.question) }))
    .filter((item) => item.key.length >= 24 && item.q.length >= 8);
  if (!list.length) return { recorded: 0 };
  const file = enrichmentFileFor(brainPath, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = readFile(file);
  let recorded = 0;
  for (const { key, q } of list) {
    const entry = data.entries[key] || { q: [], ts: 0 };
    if (!entry.q.includes(q)) {
      entry.q = [q, ...entry.q].slice(0, ENRICHMENT_MAX_QUESTIONS);
      recorded++;
    }
    entry.ts = now;
    data.entries[key] = entry;
  }
  // TTL + size prune, oldest first.
  const keys = Object.keys(data.entries);
  for (const key of keys) {
    if (now - Number(data.entries[key].ts || 0) > ENRICHMENT_TTL_MS) delete data.entries[key];
  }
  const remaining = Object.keys(data.entries);
  if (remaining.length > ENRICHMENT_MAX_ENTRIES) {
    remaining.sort((a, b) => Number(data.entries[a].ts || 0) - Number(data.entries[b].ts || 0));
    for (const key of remaining.slice(0, remaining.length - ENRICHMENT_MAX_ENTRIES)) delete data.entries[key];
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
  return { recorded };
}

/**
 * Load the enrichment map for a brain: [{ key, q: [...] }]. Memoized on the
 * file's mtime: the retrieval hot path hashes EVERY card on every call, so it
 * must reuse one parsed array (and, via the join memo below, one join result
 * per card) until the sidecar actually changes.
 */
const readMemo = new Map();   // file -> { mtimeMs, entries }
export function readEnrichment(brainPath, { home = os.homedir(), now = Date.now() } = {}) {
  const file = enrichmentFileFor(brainPath, home);
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { mtimeMs = 0; }
  const memo = readMemo.get(file);
  if (memo && memo.mtimeMs === mtimeMs) return memo.entries;
  const data = mtimeMs ? readFile(file) : { entries: {} };
  const entries = Object.entries(data.entries)
    .filter(([, entry]) => now - Number(entry.ts || 0) <= ENRICHMENT_TTL_MS)
    .map(([key, entry]) => ({ key, q: (entry.q || []).map(cleanQuestion).filter(Boolean) }));
  readMemo.set(file, { mtimeMs, entries });
  if (readMemo.size > 8) readMemo.delete(readMemo.keys().next().value);
  return entries;
}

// Join results memoized per entries-array identity (readEnrichment keeps the
// array stable until the file changes), bounded so a pathological brain cannot
// grow the memo without limit.
const joinMemo = new WeakMap();   // entries[] -> Map(memoKey -> enrichment text)

/**
 * The enrichment text to append to ONE card's embed input: the questions of
 * every entry whose body-prefix occurs in the card's normalized text. Linear
 * in enrichment entries on a memo miss; a hit is one Map lookup.
 */
export function enrichmentTextFor(entries, cardText) {
  if (!entries?.length) return '';
  const haystack = normalizeForKey(String(cardText || '').slice(0, 1500));
  if (haystack.length < 24) return '';
  let cache = joinMemo.get(entries);
  if (!cache) { cache = new Map(); joinMemo.set(entries, cache); }
  const memoKey = `${haystack.slice(0, 64)}|${haystack.length}`;
  const hit = cache.get(memoKey);
  if (hit !== undefined) return hit;
  const questions = [];
  for (const entry of entries) {
    if (haystack.includes(entry.key)) {
      for (const q of entry.q) {
        if (!questions.includes(q)) questions.push(q);
      }
    }
  }
  const result = questions.length ? questions.join('\n').slice(0, ENRICHMENT_APPLY_CAP_CHARS) : '';
  if (cache.size < 8192) cache.set(memoKey, result);
  return result;
}
