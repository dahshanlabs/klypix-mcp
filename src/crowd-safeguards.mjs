// Crowd safeguards (klypix-mcp, 2026-10-30) — three small mechanisms from the
// research on how groups lose the benefit of independent judgment:
//
//   1. EVIDENCE LINEAGE (information cascades — Bikhchandani, Hirshleifer and
//      Welch 1992). A claim that later sessions repeat is still ONE claim. The
//      brain shows "1 recorded source, stated by N cards, re-checked K times"
//      instead of letting repetition read as agreement, and keeps a
//      "re-checked against code/evidence" note apart from a plain restatement.
//   2. INDEPENDENT FIRST PASS (Lorenz et al. 2011; BenchForm, Weng et al.
//      2025). Opt-in: a session doing a review or decision records its OWN
//      assessment before KLYPIX shows it other sessions' assessments and
//      objections on that topic. Facts and decisions stay visible. KLYPIX can
//      only control what IT returns — not what the agent reads elsewhere.
//   3. PRESERVED DISSENT (Nemeth et al. 2001; CONSENSAGENT, Pitre et al. 2025).
//      An objection card stays open, and is shown to later sessions touching
//      its topic, until evidence or a recorded decision that LINKS it closes
//      it. Later cards that agree with the position it objects to never close
//      it: the capture engine does not let them supersede or fuzzy-resolve it.
//
// Everything is stored as VISIBLE card text (the same choice as the
// `⚙ rule candidate:` line), so every reader, the app, git merges and older
// klypix-mcp versions carry it unchanged; old brains need nothing new.
//
//   Area: ⚖️ OBJECTION: <what is wrong and why>
//   Area: 🔎 ASSESSMENT: <this session's own view>
//   ↳ source: <file / commit / URL / earlier card the claim came from>
//   ↳ restates: <title of the earlier card this claim was taken from>
//   ✔ re-checked 2026-10-30: <what was checked against code or evidence>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const OBJECTION_GLYPH = '⚖️';
export const ASSESSMENT_GLYPH = '🔎';
const OBJECTION_RE = /⚖️?\s*OBJECTION\b/u;
const ASSESSMENT_RE = /🔎\s*ASSESSMENT\b/u;
const RESOLVED_RE = /✅|closed by →/u;
const ARCHIVE_RE = /^archive$/i;
// Lifecycle kinds that are not plain claims (questions, goals, milestones,
// skills, handoffs, objections, assessments).
const NON_CLAIM_RE = /❓|🎯|🏁|🛠|🤝|⚖|🔎/u;

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const v = flat(s); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
const today = () => new Date().toISOString().slice(0, 10);

export const isObjectionCard = (c) => OBJECTION_RE.test(String(c?.text ?? c ?? ''));
export const isAssessmentCard = (c) => ASSESSMENT_RE.test(String(c?.text ?? c ?? ''));
export const isArchivedCard = (c) => ARCHIVE_RE.test(String(c?.area || ''));
export const isOpenObjection = (c) => isObjectionCard(c) && !isArchivedCard(c) && !RESOLVED_RE.test(String(c?.text || '')) && c?.type !== 'container';
const isLiveText = (c) => c && c.type !== 'container' && String(c.text || '').trim() && !isArchivedCard(c);

// ── Writing: normalize a note's text (no new tool fields needed) ────────────
// "OBJECTION: …" / "ASSESSMENT: …" at the start becomes the glyphed kind, and
// trailing `source:` / `restates:` / `rechecked:` lines become lineage lines.
const LEAD_RE = /^\s*(?:⚖️?\s*)?(OBJECTION|ASSESSMENT)\s*[:—–-]\s*/iu;
const SUFFIX_RE = /^\s*(?:↳\s*)?(source|restates|re-?checked)\s*:\s*(.+?)\s*$/iu;
export function normalizeCrowdNote(text, { date = today() } = {}) {
  const raw = String(text ?? '');
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const suffix = [];
  while (lines.length > 1) {
    const m = SUFFIX_RE.exec(lines[lines.length - 1]);
    if (!m) { if (!lines[lines.length - 1].trim()) { lines.pop(); continue; } break; }
    lines.pop();
    suffix.unshift({ kind: m[1].toLowerCase().replace('-', ''), value: m[2] });
  }
  let body = lines.join('\n');
  let kind = null;
  const lead = LEAD_RE.exec(body);
  if (lead) {
    kind = lead[1].toUpperCase() === 'OBJECTION' ? 'objection' : 'assessment';
    body = `${kind === 'objection' ? `${OBJECTION_GLYPH} OBJECTION` : `${ASSESSMENT_GLYPH} ASSESSMENT`}: ${body.slice(lead[0].length)}`;
  }
  const out = suffix.map((s) => (s.kind === 'rechecked' ? `✔ re-checked ${date}: ${clip(s.value, 300)}` : `↳ ${s.kind}: ${clip(s.value, 300)}`));
  return {
    text: out.length ? `${body.trimEnd()}\n${out.join('\n')}` : body,
    kind,
    lineage: {
      sources: suffix.filter((s) => s.kind === 'source').map((s) => s.value),
      restates: suffix.filter((s) => s.kind === 'restates').map((s) => s.value),
      rechecks: suffix.filter((s) => s.kind === 'rechecked').map((s) => s.value),
    },
  };
}

// ── Reading lineage lines back (cards are stored hard-wrapped) ──────────────
const LINEAGE_SPLIT_RE = /(↳\s*source:|↳\s*restates:|✔\s*re-checked\s+\d{4}-\d{2}-\d{2}:)/u;
export function parseLineage(text) {
  const s = String(text ?? '');
  const out = { sources: [], restates: [], rechecks: [] };
  const parts = s.split(LINEAGE_SPLIT_RE);
  for (let i = 1; i < parts.length; i += 2) {
    const head = parts[i];
    // The value runs to the end of its segment, minus trailing #tag lines.
    const value = flat(String(parts[i + 1] || '').split(/\n\s*#[\p{L}\p{N}_-]+/u)[0]);
    if (!value) continue;
    if (/source/.test(head)) out.sources.push(value);
    else if (/restates/.test(head)) out.restates.push(value);
    else out.rechecks.push({ date: (/(\d{4}-\d{2}-\d{2})/.exec(head) || [])[1] || null, what: value });
  }
  return out;
}

// ── Claim similarity: is card B the same claim as card A? ───────────────────
const STOP = new Set(('the and for that this with from into have has had was were are not but then than them they their there here what when where which while will would should could just only also very more most some such each every both after before about over under again once since until your ours it its is be been being do does did done to of in on at by as or an a we you he she i me my our so if no yes can may might must any all per via vs etc use used using make made keep kept go going get got set flag flags note notes card cards decision decided agreed per earlier later today').split(' '));
const words = (s) => String(s || '').toLowerCase()
  .replace(/\[\[|\]\]/g, ' ')
  .replace(/^[^:\n]{1,40}:\s*/u, '')           // the "Area:" prefix
  .split(/[^\p{L}\p{N}_./-]+/u)
  .map((w) => w.replace(/^[./-]+|[./-]+$/g, ''))
  .filter((w) => w.length >= 3 && !STOP.has(w));
// Anchors: things a claim is ABOUT — paths, file names, code identifiers.
const isAnchor = (w) => /[/.]/.test(w) && /[a-z]/.test(w) || /_/.test(w) || /^[a-z]+[A-Z]/.test(w);
function claimTokens(text) {
  const s = String(text || '').split(LINEAGE_SPLIT_RE)[0];
  const raw = s.replace(/^[^:\n]{1,40}:\s*/u, '').match(/[A-Za-z_][\w./-]*[\w]|\b\w+\b/g) || [];
  const anchors = new Set(raw.filter((w) => isAnchor(w)).map((w) => w.toLowerCase()).filter((w) => w.length >= 4));
  // DEFAULTS-style constants count as anchors too.
  for (const w of raw) if (/^[A-Z][A-Z0-9_]{3,}$/.test(w)) anchors.add(w.toLowerCase());
  return { all: new Set(words(s)), anchors };
}
const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
};
// Two claims are the same when they are about the same named things (≥2
// shared anchors, or ≥1 when both name only one) and share a good part of
// their words, or when they share most of their words outright. A card that
// declares a change ("instead", "no longer", a correction) is a NEW claim.
const CHANGE_RE = /\b(instead|no longer|not anymore|replaced|replaces|switch(ed)? to|moved to|correction|was wrong|reverted|reverse[sd]?)\b/i;
export function sameClaim(a, b) {
  const A = claimTokens(a.text ?? a), B = claimTokens(b.text ?? b);
  let shared = 0; for (const w of A.anchors) if (B.anchors.has(w)) shared++;
  const minAnchors = Math.min(A.anchors.size, B.anchors.size);
  const words = overlap(A.all, B.all);
  if (CHANGE_RE.test(String(b.text ?? b))) return false;
  if (minAnchors >= 1 && (shared >= 2 || (shared >= 1 && minAnchors === 1)) && words >= 0.3) return true;
  return A.all.size >= 5 && B.all.size >= 5 && words >= 0.7;
}

const hasOwnSource = (c, lin) => (Array.isArray(c.evidence) && c.evidence.length > 0) || lin.sources.length > 0;
const sourceLabel = (c, lin) => {
  if (Array.isArray(c.evidence) && c.evidence.length) return c.evidence.slice(0, 2).map((e) => `${e.kind || 'ref'} ${e.ref}`).join(', ');
  if (lin.sources.length) return lin.sources.slice(0, 2).join(', ');
  return null;
};
// Cards are stored hard-wrapped: the claim is the first paragraph, rejoined
// (up to the lineage lines or the #tag line).
const titleOf = (c) => clip(String(c.text || '').split(LINEAGE_SPLIT_RE)[0].split(/\n\s*\n|\n\s*#[\p{L}\p{N}_-]+/u)[0].replace(/^[^:\n]{1,40}:\s*/u, ''), 90);
const dateOf = (c) => (c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : 'undated');

/**
 * Lineage of the claim a card makes: every card (live, or archived by a
 * supersede that kept the same claim) that states it, which of them name a
 * source, which only repeat it, and which re-checked it. Returns null for a
 * card that is not a plain claim or that nobody repeats.
 */
export function lineageFor(struct, card, { evidenceStatus = null } = {}) {
  if (!card || NON_CLAIM_RE.test(String(card.text || '')) || card.type === 'container') return null;
  const cards = (struct?.cards || []).filter((c) => c && c.type !== 'container' && String(c.text || '').trim() && !NON_CLAIM_RE.test(String(c.text || '')));
  const byTitle = (t) => { const k = flat(t).toLowerCase().replace(/^\[\[|\]\]$/g, ''); return cards.find((c) => titleOf(c).toLowerCase().startsWith(k.slice(0, 60)) || flat(c.text).toLowerCase().includes(k.slice(0, 60))); };
  // Group: explicit restates links both ways + same-claim similarity, one hop
  // from the card and one more hop from what that finds (bounded).
  const group = new Map([[card.id, card]]);
  const add = (c) => { if (c && !group.has(c.id)) { group.set(c.id, c); return true; } return false; };
  for (let hop = 0; hop < 2; hop++) {
    for (const g of [...group.values()]) {
      for (const t of parseLineage(g.text).restates) add(byTitle(t));
      for (const c of cards) {
        if (group.has(c.id)) continue;
        if (parseLineage(c.text).restates.some((t) => byTitle(t)?.id === g.id)) { add(c); continue; }
        // An archived card joins only as the ancestor of a supersede edge.
        if (isArchivedCard(c) && !(struct.connections || []).some((e) => e.fromId === c.id && group.has(e.toId) && /supersed/i.test(String(e.label || e.relationship || '')))) continue;
        if (sameClaim(g, c) && sameClaim(c, g)) add(c);
      }
    }
  }
  if (group.size < 2) return null;
  const members = [...group.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const rows = members.map((c) => { const lin = parseLineage(c.text); return { c, lin, sourced: hasOwnSource(c, lin), rechecked: lin.rechecks.length > 0 }; });
  const sources = [];
  for (const r of rows) { const s = sourceLabel(r.c, r.lin); if (s && !sources.includes(s)) sources.push(s); }
  const origin = rows.find((r) => r.sourced) || rows[0];
  const restatements = rows.filter((r) => r !== origin && !r.sourced && !r.rechecked);
  const rechecks = rows.flatMap((r) => r.lin.rechecks.map((x) => ({ ...x, card: r.c })));
  let originStatus = null;
  if (typeof evidenceStatus === 'function' && Array.isArray(origin.c.evidence) && origin.c.evidence.length) {
    try { originStatus = evidenceStatus(origin.c); } catch { originStatus = null; }
  }
  return {
    claim: titleOf(origin.c),
    originId: origin.c.id,
    originDate: dateOf(origin.c),
    originArchived: isArchivedCard(origin.c),
    sources,
    originStatus,
    statedBy: rows.length,
    restatements: restatements.map((r) => ({ id: r.c.id, date: dateOf(r.c), title: titleOf(r.c), live: !isArchivedCard(r.c) })),
    rechecks: rechecks.map((x) => ({ id: x.card.id, date: x.date, what: clip(x.what, 160) })),
    memberIds: rows.map((r) => r.c.id),
  };
}

export function formatLineage(l) {
  if (!l) return '';
  const src = l.sources.length
    ? `${l.sources.length} recorded source${l.sources.length > 1 ? 's' : ''} (${l.sources.map((s) => clip(s, 80)).join('; ')})`
    : 'no recorded source';
  const status = l.originStatus ? ` — that source is now: ${l.originStatus}` : '';
  const re = l.rechecks.length
    ? `re-checked against code/evidence ${l.rechecks.length}× (${l.rechecks.slice(0, 2).map((r) => `${r.date || 'undated'}: ${r.what}`).join('; ')})`
    : 're-checked against code/evidence 0×';
  return `🧬 Lineage: "${clip(l.claim, 90)}" — ${src}${status}; stated by ${l.statedBy} cards: 1 original (${l.originDate}${l.originArchived ? ', archived' : ''}) + ${l.restatements.length} restatement${l.restatements.length === 1 ? '' : 's'} with no source of their own; ${re}. Repetition is not corroboration: ${l.rechecks.length ? 'the re-check is the evidence, the restatements are not' : 'treat this as ONE unverified claim and check it against the code before acting on it'}.`;
}

/** Lineage for a set of cards, one entry per distinct claim group. */
export function lineagesFor(struct, cards, opts = {}) {
  const seen = new Set(); const out = [];
  for (const c of cards || []) {
    if (!c || seen.has(c.id)) continue;
    const l = lineageFor(struct, c, opts);
    if (!l) continue;
    for (const id of l.memberIds) seen.add(id);
    if (l.restatements.length >= 1) out.push(l);
  }
  return out;
}

// ── Preserved dissent ────────────────────────────────────────────────────────
const topicTokens = (s) => new Set(words(s));
/**
 * Open objections relevant to a topic (intent text and/or files). With no
 * topic, every open objection (newest first). Each carries how many LATER
 * live cards restate the position it objects to without linking it.
 */
export function openObjections(struct, { topic = '', files = [], limit = 5 } = {}) {
  const cards = (struct?.cards || []).filter(isLiveText);
  const open = cards.filter(isOpenObjection);
  const t = topicTokens(`${topic} ${(files || []).join(' ')}`);
  const fileBases = (files || []).map((f) => String(f).replace(/\\/g, '/').toLowerCase()).flatMap((f) => [f, f.split('/').pop()]);
  const scored = open.map((o) => {
    const ow = topicTokens(o.text);
    let hit = 0; for (const w of t) if (ow.has(w)) hit++;
    const lower = String(o.text).toLowerCase();
    const fileHit = fileBases.some((f) => f && lower.includes(f));
    return { o, score: hit + (fileHit ? 3 : 0) };
  }).filter((x) => !t.size || x.score >= 2)
    .sort((a, b) => b.score - a.score || (b.o.createdAt || 0) - (a.o.createdAt || 0))
    .slice(0, limit);
  return scored.map(({ o }) => {
    const ow = claimTokens(o.text);
    const later = cards.filter((c) => c.id !== o.id && !isObjectionCard(c) && (c.createdAt || 0) >= (o.createdAt || 0)
      && !String(c.text || '').includes(titleOf(o).slice(0, 40)) && (() => {
        const cw = claimTokens(c.text);
        let a = 0; for (const w of ow.anchors) if (cw.anchors.has(w)) a++;
        return a >= 1 && overlap(ow.all, cw.all) >= 0.2;
      })());
    return { id: o.id, area: o.area || null, date: dateOf(o), text: clip(String(o.text).replace(/^[^:\n]{1,40}:\s*/u, ''), 360), laterAgreeing: later.length, laterIds: later.slice(0, 6).map((c) => c.id) };
  });
}

export function formatObjections(list) {
  if (!list?.length) return '';
  const lines = [`⚖️ Open objection${list.length > 1 ? 's' : ''} on this topic (unresolved — still stands until evidence or a recorded decision that links it closes it):`];
  for (const o of list) {
    lines.push(`- [${o.id}] ${o.date}${o.area ? ` · ${o.area}` : ''}: ${o.text}`);
    if (o.laterAgreeing) lines.push(`  ${o.laterAgreeing} later card${o.laterAgreeing > 1 ? 's' : ''} touch the same thing without answering it. Agreement is not a resolution: a later majority does not close an objection.`);
  }
  lines.push('To act against an objection, first answer it: check its claim against code or evidence, then record the outcome with brain_note (`closes: <its title>` on a decision or milestone, with evidence).');
  return lines.join('\n');
}

// ── Independent first pass (opt-in, per session) ────────────────────────────
const stateDir = () => path.join(process.env.KLYPIX_BRAIN_DIR || path.join(os.homedir(), '.claude', 'project-brain'), 'crowd');
const stateFile = (brainPath) => path.join(stateDir(), `review-${crypto.createHash('sha256').update(path.resolve(String(brainPath || '')).toLowerCase()).digest('hex').slice(0, 16)}.json`);
function readState(brainPath) { try { return JSON.parse(fs.readFileSync(stateFile(brainPath), 'utf8')); } catch { return { sessions: {} }; } }
function writeState(brainPath, state) {
  const f = stateFile(brainPath);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // Reviews older than 7 days are dropped on every write.
  const cutoff = Date.now() - 7 * 86_400_000;
  for (const [k, v] of Object.entries(state.sessions || {})) if ((v.startedAt || 0) < cutoff) delete state.sessions[k];
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, f);
}
export function startIndependentPass(brainPath, sessionId, topic) {
  const state = readState(brainPath);
  state.sessions ||= {};
  state.sessions[String(sessionId)] = { topic: clip(topic, 300), startedAt: Date.now(), assessedAt: null };
  writeState(brainPath, state);
  return state.sessions[String(sessionId)];
}
export function independentPass(brainPath, sessionId) {
  const s = readState(brainPath).sessions?.[String(sessionId)];
  return s || null;
}
export function markAssessed(brainPath, sessionId) {
  const state = readState(brainPath);
  const s = state.sessions?.[String(sessionId)];
  if (!s) return null;
  s.assessedAt = Date.now();
  writeState(brainPath, state);
  return s;
}
/** True while the session's pass is open: peer opinions on its topic are withheld. */
export function isWithholding(brainPath, sessionId) {
  const s = independentPass(brainPath, sessionId);
  return Boolean(s && !s.assessedAt);
}
/** A peer opinion on the topic: an assessment or objection card that shares ≥2 topic words. */
export function isPeerOpinionOnTopic(card, topic) {
  if (!(isAssessmentCard(card) || isObjectionCard(card))) return false;
  const t = topicTokens(topic);
  if (!t.size) return true;
  const cw = topicTokens(card.text);
  let n = 0; for (const w of t) if (cw.has(w)) n++;
  return n >= 2;
}
/** A card filter for read paths while the session's pass is open (null = no filter). */
export function withholdFilter(brainPath, sessionId) {
  const s = independentPass(brainPath, sessionId);
  if (!s || s.assessedAt) return null;
  return (card) => !isPeerOpinionOnTopic(card, s.topic);
}
export const INDEPENDENT_LIMIT = 'KLYPIX withholds these only from what KLYPIX itself returns (brain_sync, brain_ask, brain_review). It cannot stop an agent from reading the brain file, git history, notes files or other sessions directly, so this records an independent first pass; it does not enforce one.';

/** The text block brain_sync adds: lineage of relevant restated claims, open objections, an open independent pass. */
export function crowdSyncBlock(struct, { brainPath, sessionId, intent = '', files = [], hitCards = [], evidenceStatus = null } = {}) {
  const parts = []; const data = {};
  const pass = brainPath && sessionId ? independentPass(brainPath, sessionId) : null;
  const withholding = Boolean(pass && !pass.assessedAt);
  const filter = withholding ? (c) => !isPeerOpinionOnTopic(c, pass.topic) : null;
  const visible = filter ? { ...struct, cards: struct.cards.filter(filter) } : struct;
  // Candidates: the task-context hits, plus live claims that name a declared
  // file or share at least two words with the intent (the context capsule is
  // capped at a few cards, and a restated claim is relevant when it names the
  // files the task will touch).
  const t = topicTokens(intent);
  const fileBases = (files || []).map((f) => String(f).replace(/\\/g, '/').toLowerCase()).flatMap((f) => [f, f.split('/').pop()]).filter(Boolean);
  const related = visible.cards.filter((c) => isLiveText(c) && !NON_CLAIM_RE.test(String(c.text || '')) && (() => {
    const lower = String(c.text).toLowerCase();
    if (fileBases.some((f) => lower.includes(f))) return true;
    const cw = topicTokens(c.text); let hit = 0; for (const w of t) if (cw.has(w)) hit++;
    return hit >= 2;
  })());
  const seenIds = new Set();
  const candidates = [...hitCards, ...related].filter((c) => c && !seenIds.has(c.id) && seenIds.add(c.id) && (!filter || filter(c)));
  const lin = lineagesFor(visible, candidates, { evidenceStatus }).slice(0, 3);
  if (lin.length) { parts.push(lin.map(formatLineage).join('\n')); data.lineage = lin.map(({ memberIds, ...l }) => l); }
  const all = openObjections(struct, { topic: intent, files });
  if (withholding) {
    const held = struct.cards.filter((c) => isLiveText(c) && isPeerOpinionOnTopic(c, pass.topic));
    parts.push(`🔒 Independent first pass open on "${pass.topic}": ${held.length} peer assessment/objection card${held.length === 1 ? '' : 's'} on this topic ${held.length === 1 ? 'is' : 'are'} withheld until you record your own with brain_review {action:"submit"}. Facts and decisions stay visible. ${INDEPENDENT_LIMIT}`);
    data.independent = { topic: pass.topic, withheld: held.length };
  } else if (all.length) {
    parts.push(formatObjections(all));
    data.objections = all;
  }
  return { text: parts.join('\n\n'), data };
}
