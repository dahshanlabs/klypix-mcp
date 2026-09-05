// Deterministic session restart/handoff contracts; these do not measure LLM use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildKlypix, buildKlypixMap, captureIntoBrain, addBrainConnections, parseKlypix, structToBrief, structToUltraBrief } from '../src/klypix-format.mjs';
import * as format from '../src/klypix-format.mjs';
// Namespace fallback lets this same frozen fixture report behavioral failures
// against 1.82.2, before the shared overlay helper existed.
const currentGuidanceFor = format.currentGuidanceFor || (() => new Map());
import { opBrainTaskContext } from '../src/klypix-core.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/current-guidance-2026-09-05.json', import.meta.url), 'utf8'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-current-guidance-'));
const target = path.join(project, 'brain.klypix');
const textOf = result => result.blocks.map(block => block.text || '').join('\n');
const failures = [];
let assertions = 0;
const check = (condition, label) => {
  assertions++;
  if (!condition) failures.push(label);
  console.log(`${condition ? '[ok]' : '[x]'} ${label}`);
};
const oldRule = fixture.cards.find(card => /IS BROKEN/.test(card.text));
const fix = fixture.cards.find(card => /FIXED AND/.test(card.text));
const makeBrain = async (cards, connections = []) => {
  const realNow = Date.now;
  let buffer;
  try {
    // Builders author cards at capture time. Exercise those public writers at
    // the frozen timestamps instead of editing a packaged brain or its ZIP.
    Date.now = () => cards[0].createdAt;
    buffer = await buildKlypixMap({ title: 'Current guidance fixture', areas: [{ title: 'Brain', cards: [cards[0]] }] });
    for (const card of cards.slice(1)) {
      Date.now = () => card.createdAt;
      ({ buffer } = await captureIntoBrain(buffer, { cards: [{ area: 'Brain', text: card.text }] }));
    }
    if (connections.length) ({ buffer } = await addBrainConnections(buffer, connections));
  } finally { Date.now = realNow; }
  fs.writeFileSync(target, buffer);
  return (await parseKlypix(buffer)).struct;
};
const task = async (intent = 'Evaluate the eval harness numbers', options = {}) => opBrainTaskContext({ vault: project, canvas: target, intent, files: [], ...options });

try {
  // Fixture frozen BEFORE editing runtime. The repair is outside the task-hit
  // set (k=1) but it must still accompany the old skill on a fresh session.
  const struct = await makeBrain([oldRule, fix]);
  const before = fs.readFileSync(target);
  const start = performance.now();
  const context = await task('The eval harness is broken and its numbers invalid', { k: 1 });
  const rendered = textOf(context);
  check(/RULE MAY BE OBSOLETE/.test(rendered), 'task capsule qualifies the synthetic old-eval standing rule');
  check(/EVAL HARNESS FIXED/.test(rendered), 'task capsule carries the repair even outside the hit set');
  check(!/CURRENT CORRECTION/.test(rendered), 'unconfirmed candidate is never called a confirmed correction');
  check(/THE EVAL HARNESS IS BROKEN/.test(rendered), 'protected rule remains inspectable with its warning');
  check(context.context.hits.some(hit => hit.possiblyObsolete?.byId), 'task hit exposes candidate identity for a receiving host');
  check(rendered.length <= 2800, 'task output stays within the default character budget');
  check(performance.now() - start < 1000, 'task guidance remains a lexical fast path under one second');
  check(fs.readFileSync(target).equals(before), 'serving guidance leaves the synthetic-pair fixture byte-identical');

  // Standalone fallback rules, including the ultra brief written into AGENTS,
  // must apply the same warning even when the task itself is unrelated.
  const standing = await task('Paint the mobile toolbar icons');
  check(/RULE MAY BE OBSOLETE/.test(textOf(standing)), 'unconditional standing-rule tier also qualifies the old rule');
  check(standing.context.standingRules?.some(hit => hit.possiblyObsolete?.byId), 'standing-rule metadata carries the candidate identity');
  const ultra = structToUltraBrief(struct);
  check(/RULE MAY BE OBSOLETE/.test(ultra) && /EVAL HARNESS FIXED/.test(ultra), 'ultra brief prefixes the old rule with the same candidate repair');
  check(ultra.length <= 1800, 'ultra brief stays within its preview budget');
  check(/THE EVAL HARNESS IS BROKEN/.test(ultra), 'ultra preview does not silently discard the protected rule');
  check(/RULE MAY BE OBSOLETE|a newer 🏁 may have removed this limitation/.test(structToBrief(struct)), 'full brief retains existing obsolescence protection');

  // An unrelated newer milestone cannot make the actual stale rule disappear
  // or win the hint merely because it is newer and in the same area.
  const unrelated = { text: 'Brain: 🏁 mobile toolbar icon colors and rounded export buttons shipped', createdAt: fix.createdAt + 1000 };
  await makeBrain([oldRule, unrelated]);
  const untouched = await task('The eval harness is broken and its numbers invalid', { k: 1 });
  check(!/RULE MAY BE OBSOLETE|CURRENT CORRECTION/.test(textOf(untouched)), 'unrelated newer milestone does not flag the rule');
  check(/THE EVAL HARNESS IS BROKEN/.test(textOf(untouched)), 'unrelated milestone cannot hide the rule');

  const tiny = await (async () => { await makeBrain([oldRule, fix]); return task('The eval harness is broken and its numbers invalid', { k: 1, budgetChars: 800 }); })();
  check(textOf(tiny).length <= 800 && /RULE MAY BE OBSOLETE/.test(textOf(tiny)), 'tight task budget retains the warning prefix');

  // A human dismissal is honored in either direction after a serialized handoff.
  const pair = await makeBrain([oldRule, fix]);
  const oldId = pair.cards.find(c => /IS BROKEN/.test(c.text || '')).id;
  const newId = pair.cards.find(c => /FIXED AND/.test(c.text || '')).id;
  const dismissed = await addBrainConnections(fs.readFileSync(target), [{ fromId: newId, toId: oldId, relationship: 'not_fulfilled' }]);
  fs.writeFileSync(target, dismissed.buffer);
  check(!/RULE MAY BE OBSOLETE/.test(textOf(await task('The eval harness is broken and its numbers invalid', { k: 1 }))), 'restart honors a reverse-direction human dismissal');

  // Explicit edges carry identity. Keep a protected skill live and prove its
  // confirmed successor accompanies it even through the unconditional tier.
  const confirmedBuffer = await buildKlypix({ title: 'Confirmed lineage', cards: [
    { id: 'rule-old', text: '🛠️ Alpha exporter uses the old transport protocol.' },
    { id: 'rule-mid', text: 'Alpha exporter uses the intermediate protocol.' },
    { id: 'rule-current', text: 'Alpha exporter uses the corrected transport protocol.' },
  ], connections: [
    { from: 'rule-old', to: 'rule-mid', label: 'superseded by' },
    { from: 'rule-mid', to: 'rule-current', label: 'superseded by' },
  ] });
  fs.writeFileSync(target, confirmedBuffer);
  const confirmed = await task('Paint mobile toolbar icons');
  check(/CURRENT CORRECTION/.test(textOf(confirmed)) && /corrected transport/.test(textOf(confirmed)), 'standing-rule tier follows the confirmed correction chain');
  check(!/RULE MAY BE OBSOLETE/.test(textOf(confirmed)), 'confirmed correction is distinct from a candidate');
  check(confirmed.context.standingRules?.some(c => c.id === 'rule-old' && c.correctedById === 'rule-current'), 'confirmed successor identity reaches receiving host metadata');
  const confirmedStruct = (await parseKlypix(confirmedBuffer)).struct;
  check(/CURRENT CORRECTION/.test(structToUltraBrief(confirmedStruct)), 'ultra brief also follows confirmed lifecycle edges');
  check(/CURRENT CORRECTION/.test(structToBrief(confirmedStruct)), 'full brief follows confirmed lifecycle edges');
  const focused = { ...confirmedStruct, cards: confirmedStruct.cards.map(c => c.id === 'rule-old' ? { ...c, area: 'Focus' } : c) };
  check(/CURRENT CORRECTION/.test(structToUltraBrief(focused)), 'moving a corrected rule into human Focus does not bypass its warning');
  check(/CURRENT CORRECTION/.test(structToBrief(focused)), 'full human Focus retains confirmed guidance');
  check(fs.readFileSync(target).equals(confirmedBuffer), 'confirmed recall never retires or rewrites the protected rule');

  // Direct structs isolate serve-time behavior: no capture-created hint edge
  // may be doing the work, and a retracted milestone must not vouch for a rule.
  const directCards = fixture.cards.map(c => ({ ...c, type: 'text' }));
  const direct = { title: 'Direct pair', cards: directCards, connections: [], counts: { cards: 2, connections: 0 } };
  check(currentGuidanceFor(direct, [directCards[0]]).get(oldRule.id)?.obsolescence?.byId === fix.id, 'unlinked synthetic incident pair is detected without a capture-side hint');
  const archived = { ...direct, cards: directCards.map(c => c.id === fix.id ? { ...c, area: 'Archive' } : c) };
  check(!currentGuidanceFor(archived, [directCards[0]]).has(oldRule.id), 'archived repair no longer vouches for obsolete-rule guidance');
  const evergreen = { id: 'evergreen', type: 'text', area: 'Brain', createdAt: oldRule.createdAt, text: '🛠️ Always import production primitives when writing evaluation harness tests.' };
  check(!currentGuidanceFor({ ...direct, cards: [...directCards, evergreen] }, [evergreen]).has('evergreen'), 'evergreen advice remains intact despite a related newer milestone');
  const quoted = { ...directCards[1], text: '🛠️ Keep an evaluation example for reference.\n' + directCards[1].text };
  check(!currentGuidanceFor({ ...direct, cards: [directCards[0], quoted] }, [directCards[0]]).has(oldRule.id), 'quoted milestone body does not turn standing advice into a shipment');
  const mixedContext = structToUltraBrief(direct);
  check(/RULE MAY BE OBSOLETE/.test(mixedContext) && /EVAL HARNESS FIXED/.test(mixedContext), 'mixed synthetic milestone and skill remains useful in the ultra preview');

  // Evidence from the shared helper reaches startup without executing verify.
  fs.writeFileSync(path.join(project, 'proof.txt'), 'source evidence');
  fs.writeFileSync(target, await buildKlypix({ title: 'Evidence handoff', cards: [{
    text: '🛠️ Evidence handoff preserves the protocol source.',
    evidence: [{ kind: 'file', ref: 'proof.txt' }], verify: 'never execute this verification text',
  }] }));
  const evidence = await task('Evidence handoff protocol source');
  check(evidence.context.hits.some(c => c.evidence?.sources?.some(source => source.ref === 'proof.txt')), 'task capsule carries structured source evidence');
  check(/proof.txt/.test(textOf(evidence)), 'task capsule displays its source evidence');

  // Long optional evidence on unrelated standing rules cannot push the
  // relevant handoff fact out of the default capsule's text budget.
  const priorityFact = 'Zebraform parser rollback requires reason code R17 and a retained parser snapshot.';
  const crowdedRules = Array.from({ length: 3 }, (_, index) => ({
    id: 'crowded-rule-' + index, text: '🛠️ Historical policy ' + index + ' ' + 'old policy details '.repeat(20),
    evidence: [{ kind: 'pr', ref: 'PR#' + index }], verify: 'Recorded manual verification instruction '.repeat(40),
  }));
  const successors = crowdedRules.map((card, index) => ({ id: 'current-policy-' + index,
    text: 'Updated policy ' + index + ' ' + 'supported policy detail '.repeat(8) }));
  fs.writeFileSync(target, await buildKlypix({ title: 'Priority handoff',
    cards: [...crowdedRules, ...successors, { id: 'task-fact', text: priorityFact }],
    connections: crowdedRules.map((card, index) => ({ from: card.id, to: successors[index].id, label: 'superseded by' })),
  }));
  const priorityContext = await task('Zebraform parser rollback reason code', { k: 1 });
  check(textOf(priorityContext).includes(priorityFact), 'long evidence cannot starve the relevant task fact');
  check(textOf(priorityContext).length <= 2800, 'evidence appendix respects the same capsule budget');
  check(priorityContext.context.standingRules.every(card => card.evidence.verify.text.length > 100), 'omitted optional text remains available as structured evidence');

  await makeBrain([oldRule, fix]);
  // The pipeline survives a serialized brain and a fresh operation invocation.
  const restartBefore = await task('The eval harness is broken and its numbers invalid', { k: 1 });
  const restart = await task('The eval harness is broken and its numbers invalid', { k: 1 });
  check(textOf(restart) === textOf(restartBefore), 'deterministic restart serves the same current-state warning');
} finally {
  assert.ok(path.resolve(project).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(`\n${assertions - failures.length}/${assertions} current-guidance assertions passed`);
if (failures.length) process.exitCode = 1;
