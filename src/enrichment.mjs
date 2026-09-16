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

// ── Question quality gate (1.86) ─────────────────────────────────────────────
// "The nearest human prompt" is the right SOURCE of asker language but is not
// always a question. Measured on this project's own sidecar (2026-09-16, 187
// recorded texts): 36% were question-shaped, 18% were acknowledgements ("done,
// what now", "300mb is ok", "ok do them"), and the rest included npm script
// echoes ("> klypix@1.3.127 release:register …"), hook feedback re-injected
// as a user turn, and pasted documents. Every one of those was appended to a
// card's EMBED input as if it were the words someone would ask with — pulling
// the vector toward generic chatter, the opposite of the vocabulary bridge
// enrichment exists to build. The gate rejects text that carries no askable
// vocabulary and runs on BOTH sides (record and read), so an already-recorded
// sidecar is cleaned lazily on its next read without a rewrite. A rejection
// costs nothing but recall the text never carried.
export const ENRICHMENT_MIN_CONTENT_TOKENS = 4;
const ENRICHMENT_STOPWORDS = new Set((
  'a an and are as at be been but by can could did do does for from had has have he her his how i if in is it its '
  + 'just let lets me my no nor not of ok okay on or our out she so than that the their them then there these they this '
  + 'those to up us was we were what when where which who whom why will with would you your yes yep nope sure please '
  + 'thanks thank great good fine done cool right now also very really any all both each more most some such too again '
  + 'about into over under after before while because '
  // Arabic function words and acknowledgements (folded forms; enrichment text is
  // recorded as typed, so the common unfolded spellings are listed too).
  + 'هل ما ماذا لماذا كيف اين أين وين متى من في على الى إلى عن هذا هذه ذلك تلك هو هي هم انا أنا نحن انت أنت و او أو لا نعم تمام طيب اوكي ايوه ايوا'
).split(/\s+/).filter(Boolean));
const ENRICHMENT_MACHINE_RE = /stop hook feedback|<agent-message|\[subagent hand-back\]|<task-notification|system-reminder|\[system notification|<command-(?:name|message|args)|local-command-(?:stdout|stderr)|<hook-[a-z0-9-]+|^\[image:|base directory for this skill:/i;
const ENRICHMENT_CONSOLE_RE = /^[>$]\s|(?:^|\s)npm (?:err!|warn)\b|\bexited with code \d|[✓✔]|^\s*\{"|^\s*\[\{/i;
const ENRICHMENT_PASTED_DOC_RE = /^#{1,6}\s|^```|^---\s|^(?:import|export|const|function|class)\s/;
const contentTokens = (text) => String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
  .filter((token) => token.length >= 2 && !ENRICHMENT_STOPWORDS.has(token));

/**
 * Decide whether a text carries askable vocabulary worth embedding beside a
 * card. Returns { ok, reason, text } — `text` is the cleaned form that would be
 * recorded. Reasons: too-short · machine (harness/hook output) · console (npm /
 * shell echo) · pasted-doc (markdown/code block) · low-content (fewer than
 * ENRICHMENT_MIN_CONTENT_TOKENS non-stopword tokens — the acknowledgement class).
 */
export function enrichmentQuestionQuality(question) {
  const text = cleanQuestion(question);
  if (text.length < 8) return { ok: false, reason: 'too-short', text };
  if (ENRICHMENT_MACHINE_RE.test(text)) return { ok: false, reason: 'machine', text };
  if (ENRICHMENT_CONSOLE_RE.test(text)) return { ok: false, reason: 'console', text };
  if (ENRICHMENT_PASTED_DOC_RE.test(text)) return { ok: false, reason: 'pasted-doc', text };
  if (contentTokens(text).length < ENRICHMENT_MIN_CONTENT_TOKENS) return { ok: false, reason: 'low-content', text };
  return { ok: true, reason: null, text };
}

/**
 * Record question/intent text for captured card bodies. `items` is
 * [{ body, question }]; entries merge per body key (deduped, newest kept,
 * capped). Bounded overall: past ENRICHMENT_MAX_ENTRIES the OLDEST entries are
 * pruned — enrichment is a rolling quality window, not an archive, and unlike
 * the claims lane nothing downstream depends on any single entry existing.
 * Returns { recorded, rejected } — `rejected` counts texts the quality gate
 * refused (see enrichmentQuestionQuality); they are never written.
 */
export function recordEnrichment(brainPath, items, { home = os.homedir(), now = Date.now() } = {}) {
  const list = [];
  let rejected = 0;
  for (const item of (Array.isArray(items) ? items : [])) {
    const key = enrichmentKeyFor(item?.body);
    if (key.length < 24) continue;
    const quality = enrichmentQuestionQuality(item?.question);
    if (!quality.ok) { rejected++; continue; }
    list.push({ key, q: quality.text });
  }
  if (!list.length) return { recorded: 0, rejected };
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
  return { recorded, rejected };
}

/**
 * Load the enrichment map for a brain: [{ key, q: [...] }]. Memoized on the
 * file's mtime: the retrieval hot path hashes EVERY card on every call, so it
 * must reuse one parsed array (and, via the join memo below, one join result
 * per card) until the sidecar actually changes.
 */
const readMemo = new Map();   // file -> { stamp, entries }
export function readEnrichment(brainPath, { home = os.homedir(), now = Date.now() } = {}) {
  const file = enrichmentFileFor(brainPath, home);
  // Invalidation stamp = mtime AND size. mtime alone is not enough: under load
  // two writes can land inside one mtime tick, and the memo then served the
  // PRE-rewrite parse — caught by EN2 failing in the full chain (same-tick
  // corrupt-file rewrite read back as the old healthy entries) while passing
  // standalone, where the writes never clustered.
  let stamp = '';
  try { const st = fs.statSync(file); stamp = `${st.mtimeMs}|${st.size}`; } catch { stamp = ''; }
  const memo = readMemo.get(file);
  if (memo && memo.stamp === stamp) return memo.entries;
  const data = stamp ? readFile(file) : { entries: {} };
  // The quality gate runs here too: a sidecar written before 1.86 (or by an
  // older hook) is cleaned on read, so its acknowledgements and console echoes
  // stop reaching the embedder without anyone rewriting the file. Entries left
  // with no acceptable text are dropped from the served array entirely.
  const entries = Object.entries(data.entries)
    .filter(([, entry]) => now - Number(entry.ts || 0) <= ENRICHMENT_TTL_MS)
    .map(([key, entry]) => ({ key, q: (entry.q || []).map((q) => enrichmentQuestionQuality(q)).filter((r) => r.ok).map((r) => r.text) }))
    .filter((entry) => entry.q.length > 0);
  readMemo.set(file, { stamp, entries });
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
