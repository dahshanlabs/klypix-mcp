// brain_review — the opt-in independent first pass (crowd safeguards), plus
// the crowd block brain_sync adds. Kept out of klypix-core (which the crowd
// module is imported by) so the dependency only runs one way.
import fs from 'node:fs';
import path from 'node:path';
import { brainTarget, opBrainNote } from './klypix-core.mjs';
import { parseKlypix } from './klypix-format.mjs';
import { inspectCardEvidence } from './brain-evidence.mjs';
import {
  INDEPENDENT_LIMIT, crowdSyncBlock, independentPass, isPeerOpinionOnTopic, markAssessed, startIndependentPass,
} from './crowd-safeguards.mjs';

const text = (t) => ({ kind: 'text', text: t });
const err = (t) => ({ blocks: [text(t)], isError: true });
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const evidenceStatusFor = (brainPath) => {
  const cache = new Map();
  return (card) => {
    const s = inspectCardEvidence(card, { projectRoot: path.dirname(brainPath), cache }).sources.map((x) => `${x.status} (${x.ref})`);
    return s.length ? s.join(', ') : null;
  };
};

/**
 * brain_sync's crowd block: lineage of the context hits, open objections, an
 * open pass. `hitLineage` maps a context hit's id to the lineage line that
 * rides ON that hit in structuredContent. Never throws.
 */
export async function crowdSyncText({ brainPath, sessionId, intent = '', files = [], hitIds = [] }) {
  try {
    if (!brainPath || !fs.existsSync(brainPath)) return { text: '', data: null, hitLineage: {} };
    const { struct } = await parseKlypix(fs.readFileSync(brainPath));
    const byId = new Map(struct.cards.map((c) => [c.id, c]));
    // In the order the task context ranked them.
    const hitCards = [...new Set(hitIds)].map((id) => byId.get(id)).filter(Boolean);
    const out = crowdSyncBlock(struct, { brainPath, sessionId, intent, files, hitCards, evidenceStatus: evidenceStatusFor(brainPath) });
    return { text: out.text, data: Object.keys(out.data).length ? out.data : null, hitLineage: out.hitLineage || {} };
  } catch { return { text: '', data: null, hitLineage: {} }; }
}

// Crowd safeguards: a restated claim's lineage line rides ON the context hit
// it belongs to (right after its text). Hosts that show the model only
// structuredContent (Claude Code) never see the text block, so a line printed
// only there never reached the agent (crowd bench round 1, 2026-10-30).
export function withHitLineage(context, hitLineage) {
  if (!context || !Array.isArray(context.hits) || !hitLineage || !Object.keys(hitLineage).length) return context;
  return {
    ...context,
    hits: context.hits.map((h) => {
      const line = h && hitLineage[h.id];
      if (!line) return h;
      const out = {};
      for (const [k, v] of Object.entries(h)) { out[k] = v; if (k === 'text') out.lineage = line; }
      if (!('lineage' in out)) out.lineage = line;
      return out;
    }),
  };
}

export async function opBrainReview({ vault, canvas, action = 'status', topic = '', assessment = '', area = '', sessionId, via }) {
  const t = brainTarget(vault, canvas);
  if (t.ambiguous) return err('More than one brain matches; pass canvas.');
  if (!t.file) return err(`No brain found — looked for ./brain.klypix in the project, then ${vault}.`);
  if (!sessionId) return err('brain_review needs a session identity; call brain_sync first.');
  let struct;
  try { ({ struct } = await parseKlypix(fs.readFileSync(t.file))); } catch (e) { return err(`Read failed: ${e.message}`); }
  const live = (c) => c && c.type !== 'container' && !/^archive$/i.test(c.area || '') && String(c.text || '').trim();
  const opinions = (tp) => struct.cards.filter((c) => live(c) && isPeerOpinionOnTopic(c, tp));

  if (action === 'start') {
    const tp = flat(topic);
    if (tp.split(' ').length < 2) return err('brain_review start needs a topic of a few words (what you are reviewing or deciding).');
    startIndependentPass(t.file, sessionId, tp);
    const held = opinions(tp).length;
    return { blocks: [text([
      `🔒 Independent first pass started on "${tp}".`,
      `${held} peer assessment/objection card${held === 1 ? '' : 's'} on this topic ${held === 1 ? 'is' : 'are'} now withheld from brain_sync and brain_ask for this session. Facts, decisions and evidence stay visible.`,
      'Form your own view from the code and evidence, then record it with brain_review {action:"submit", assessment:"…"}; the withheld cards are shown to you right after.',
      INDEPENDENT_LIMIT,
    ].join('\n'))], structured: { started: true, topic: tp, withheld: held } };
  }

  if (action === 'submit') {
    const pass = independentPass(t.file, sessionId);
    const body = flat(assessment);
    if (!body) return err('brain_review submit needs your assessment text.');
    const note = await opBrainNote({ vault, canvas, text: `ASSESSMENT: ${body}`, area: area || 'Review', via });
    if (note.isError) return note;
    const tp = pass?.topic || body;
    if (pass) markAssessed(t.file, sessionId);
    // Re-read: the brain now holds this session's own assessment too.
    try { ({ struct } = await parseKlypix(fs.readFileSync(t.file))); } catch { /* keep the old read */ }
    const own = flat(`🔎 ASSESSMENT: ${body}`).slice(0, 60);
    const peers = opinions(tp).filter((c) => !flat(c.text).includes(own));
    const lines = [
      `✓ Your assessment is recorded (independently${pass ? '' : ' — but no pass was open, so it was not shielded from peer opinions'}).`,
      peers.length ? `Peer assessments and objections on "${tp}" (${peers.length}), shown now:` : `No peer assessments or objections on "${tp}".`,
      ...peers.slice(0, 8).map((c) => `- [${c.id}] ${flat(c.text).slice(0, 360)}`),
    ];
    if (peers.length) lines.push('Where they differ from yours, change your view only for evidence you can check — not because more cards say otherwise.');
    return { blocks: [text(lines.join('\n'))], structured: { submitted: true, topic: tp, peers: peers.map((c) => c.id) } };
  }

  const pass = independentPass(t.file, sessionId);
  if (!pass) return { blocks: [text('No independent first pass is open for this session. Start one with brain_review {action:"start", topic:"…"} before you read other sessions\' conclusions.')], structured: { open: false } };
  return { blocks: [text(pass.assessedAt
    ? `Independent first pass on "${pass.topic}" is finished: your assessment was recorded, peer opinions are visible.`
    : `Independent first pass open on "${pass.topic}": ${opinions(pass.topic).length} peer opinion card(s) withheld until you submit.`)], structured: { open: !pass.assessedAt, topic: pass.topic } };
}
