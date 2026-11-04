// A delegated assignment is a complete saved brief, even while its writer
// continues other work. Exercise the card through the actual packaged format.
import assert from 'node:assert/strict';
import { buildKlypixMap, parseKlypix, rewriteCardById } from '../src/klypix-format.mjs';
import {
  HANDOFF_LIMITS, normalizeHandoffInput, renderHandoffCard,
  handoffMachineField, parseHandoffCard, formatHandoffCards, assignmentInstructionsDigest,
} from '../src/session-handoff.mjs';

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const instructions = [
  '  Research natural Saudi sales calls and preserve exact pronunciation.  ',
  'فَهْدٌ: أَنَا مُسَاعِدٌ بِالذَّكَاءِ الاِصْطِنَاعِيِّ.\r\n',
  'Task: use actual timestamped audio, with short attributed excerpts.',
  'Next: preserve uncertainty; do not certify unheard pronunciation.',
  'From: this is a quoted prompt label, not a card author.',
  'Instructions: preserve all requested output sections.',
  'End instructions: this quoted example must not close the brief.',
  'Taken: do not turn this line into a takeover stamp.',
  'Finished: do not mark the assignment done.',
  'Resume the session that left it: this is quoted example text.',
  '#example-tag inside the brief',
  '\tOutput six dialogues and a structured lexicon with reviewed forms. '.repeat(8),
  '',
].join('\n');
const base = {
  title: 'Saudi speech research for Codex',
  task: 'Research actual Saudi sales speech.',
  next: ['Read the complete brief.', 'Collect and verify the evidence.'],
  for: 'Codex', reason: 'assignment', instructions,
  verify: 'Every pronunciation has timestamped evidence or a stated uncertainty.',
};
const from = { client: 'claude-code', sessionId: 'claude-sender-12345678', role: 'builder' };
const now = Date.now();
const normalized = normalizeHandoffInput(base);
check(normalized.ok, 'a complete assignment is accepted');
check(instructions.length > 400, 'fixture exceeds the old task summary limit');
check(normalized.value.instructions === instructions, 'normalization preserves exact Unicode and whitespace');
check(normalized.value.reason === 'assignment', 'assignment is a recognized reason');
const text = renderHandoffCard(normalized.value, { from, at: now });
check(text.includes('Instructions:\n') && text.includes('فَهْدٌ'), 'the full brief is human-visible on the card');
check(text.includes('Next∶ preserve uncertainty') && text.includes('Taken∶ do not'), 'prompt labels cannot forge card sections');
check(text.includes('End instructions∶ this quoted example'), 'an end marker inside the prompt is sanitized');
check(text.includes('Resume∶ the session that left it'), 'legacy resume syntax inside the brief cannot open a new section');
const machine = handoffMachineField(normalized.value, { from, at: now });
check(machine.instructions === instructions, 'the machine twin retains the original brief exactly');
const unstamped = parseHandoffCard({ id: 'assignment', text: `Handoff: ❓ ${text}`, handoff: machine });
check(!unstamped.instructionsCurrent, 'an assignment without a saved visible-section digest is unverified');
machine.savedInstructionsDigest = assignmentInstructionsDigest(unstamped.visibleInstructions);
const direct = parseHandoffCard({ id: 'assignment', text: `Handoff: ❓ ${text}`, handoff: machine });
check(direct.instructions === instructions, 'the parsed card returns the complete exact brief');
check(direct.instructionsCurrent, 'the exact brief is current when its saved visible section matches');
check(direct.task === base.task && direct.next.length === 2 && direct.next[1] === base.next[1], 'brief section labels do not alter task or next steps');
check(!direct.taken && !direct.finished && direct.state === 'open', 'brief text cannot forge lifecycle stamps');
const prose = parseHandoffCard({ id: 'prose', text: `Handoff: ❓ ${text}` });
check(prose.instructions.includes('Next∶ preserve uncertainty') && !prose.taken && !prose.finished, 'human-visible prose remains readable and safely parseable without machine metadata');
check(!prose.instructionsCurrent, 'visible prose alone cannot claim exact saved instructions');
check(direct.visibleInstructions.includes('#example-tag inside the brief') && direct.visibleInstructions.includes('\n\n'), 'visible capture includes headings and blank lines');
for (const changed of [
  text.replace('actual timestamped audio', 'invented audio'),
  text.replace('#example-tag', '#changed-heading'),
  text.replace('Instructions:\n', 'Instructions:\n\n'),
  text.replace('\nEnd instructions:\n', '\n'),
  `${text}\nInstructions:\nnew instructions\nEnd instructions:`,
]) {
  const edited = parseHandoffCard({ id: 'assignment', text: `Handoff: ❓ ${changed}`, handoff: machine });
  check(!edited.instructionsCurrent, 'a visible edit, missing boundary, or duplicate section invalidates the saved exact brief');
}
const taken = parseHandoffCard({ id: 'assignment', text: `Handoff: ❓ ${text}\nTaken: Codex receiver-12345678 · 2026-11-04 12:00 UTC`, handoff: machine });
check(taken.instructionsCurrent && taken.state === 'taken', 'a lifecycle takeover outside Instructions keeps the brief current');
const finished = parseHandoffCard({ id: 'assignment', text: `Handoff: ❓ ${text}\nFinished: Codex receiver-12345678 · 2026-11-04 12:01 UTC`, handoff: machine });
check(finished.instructionsCurrent && finished.state === 'done', 'a completion stamp outside Instructions keeps the brief current');

let buffer = await buildKlypixMap({ title: 'Assignment fixture', kind: 'brain', areas: [{ title: 'Handoff', cards: [{ text: `Handoff: ❓ ${text}` }] }] });
let parsed = await parseKlypix(buffer);
let card = parsed.struct.cards.find(c => c.type !== 'container' && c.text.includes('🤝 HANDOFF'));
check(Boolean(card), 'the actual card format stores the visible assignment');
// buildKlypixMap is an import builder and leaves text unwrapped. Normal writes
// through the capture engine have already applied this same by-id hard wrap.
buffer = (await rewriteCardById(buffer, card.id, () => {})).buffer;
parsed = await parseKlypix(buffer);
card = parsed.struct.cards.find(c => c.id === card.id);
const packagedMachine = { ...machine, savedInstructionsDigest: assignmentInstructionsDigest(parseHandoffCard(card).visibleInstructions) };
const stamped = await rewriteCardById(buffer, card.id, j => { j.handoff = packagedMachine; });
check(stamped.changed, 'the exact machine brief is stamped into the packaged card');
parsed = await parseKlypix(stamped.buffer);
const roundTrip = parseHandoffCard(parsed.struct.cards.find(c => c.id === card.id));
check(roundTrip.instructions === instructions, 'packaged round-trip preserves Arabic tashkeel, CRLF, newlines, tabs, and spaces exactly');
check(roundTrip.instructionsCurrent, 'the digest is computed from the actual hard-wrapped section and survives packaging');
const takenBuffer = await rewriteCardById(stamped.buffer, card.id, j => { j.content += '\nTaken: Codex receiver-12345678 · 2026-11-04 12:00 UTC'; });
const takenPackage = await parseKlypix(takenBuffer.buffer);
check(parseHandoffCard(takenPackage.struct.cards.find(c => c.id === card.id)).instructionsCurrent, 'a packaged takeover rewrite preserves the visible-section digest');
check(roundTrip.reason === 'assignment' && roundTrip.forRole === 'Codex', 'assignment reason and recipient survive the packaged format');
check(roundTrip.next.length === 2 && !roundTrip.taken && !roundTrip.finished, 'hard wrapping does not create instructions, steps, or lifecycle stamps');

for (const bad of [undefined, '', ' \n\t ', null, 12, { text: 'do research' }]) {
  check(!normalizeHandoffInput({ ...base, instructions: bad }).ok, 'missing, empty, or non-string assignment instructions are refused');
}
check(normalizeHandoffInput({ ...base, instructions: 'x'.repeat(HANDOFF_LIMITS.instructions) }).ok, 'the exact instruction size limit is accepted');
const tooLong = normalizeHandoffInput({ ...base, instructions: 'x'.repeat(HANDOFF_LIMITS.instructions + 1) });
check(!tooLong.ok && /nothing was truncated/.test(tooLong.error), 'oversized instructions fail loudly instead of being truncated');
for (const recipient of [undefined, '', ' \n ', 42, {}, 'x'.repeat(41)]) {
  check(!normalizeHandoffInput({ ...base, for: recipient }).ok, 'assignments require a nonempty bounded string recipient');
}

const ordinary = normalizeHandoffInput({ title: 'Continue upload work', task: 'Finish the chooser.', next: ['Run its test.'], reason: 'usage_limit' });
check(ordinary.ok && ordinary.value.instructions === '' && ordinary.value.forRole === '', 'ordinary handoffs keep their previous optional-field behavior');
const old = parseHandoffCard({ id: 'old', text: 'Handoff: ❓ 🤝 HANDOFF — Old work\nFrom: Codex old-12345678\nTask: finish it\nNext:\n1. run tests\n#handoff' });
check(old.instructions === '' && old.task === 'finish it' && old.next[0] === 'run tests', 'old cards without instructions parse unchanged');
check(old.visibleInstructions === '' && !old.instructionsCurrent, 'old ordinary handoffs have no exact-assignment assertion');
check(!Object.hasOwn(handoffMachineField(ordinary.value, { from, at: now }), 'instructions'), 'ordinary machine metadata stays additive');

const newer = Array.from({ length: 12 }, (_, i) => ({ ...old, id: `newer-${i}`, title: `Unrelated ${i}`, at: now + i + 1 }));
const records = [...newer, { ...direct, id: 'assigned-codex', at: now - 1000 }];
const summary = formatHandoffCards(records, { now, max: 5, client: 'codex' });
check(summary.indexOf('[assigned-codex]') < summary.indexOf('[newer-0]'), 'the addressed assignment outranks many newer unrelated cards');
check(summary.includes('(assignment)') && summary.includes('for: Codex (your agent)'), 'the summary identifies the assignment and recipient match');
check(summary.includes('brain_handoff {action:"read", id:"assigned-codex"}'), 'the summary points to the complete brief');
check(!summary.includes('فَهْدٌ') && !summary.includes('preserve uncertainty'), 'summaries do not dump the complete instructions');
check(!formatHandoffCards(records, { now, max: 5, client: 'claude-code' }).includes('[assigned-codex]'), 'a different client does not get recipient priority');
for (const [recipient, client] of [['Claude', 'claude-code'], ['Claude Code', 'claude'], ['claude-code', 'Claude Code'], ['Codex', 'CODEX']]) {
  const addressed = { ...direct, id: 'addressed', forRole: recipient };
  check(formatHandoffCards([...newer, addressed], { now, max: 1, client }).includes('[addressed]'), 'client aliases match the intended recipient');
}
const reviewer = { ...direct, id: 'reviewer', forRole: 'Reviewer' };
const roleSummary = formatHandoffCards([...newer, reviewer], { now, max: 1, role: 'reviewer' });
check(roleSummary.includes('[reviewer]') && roleSummary.includes('for: Reviewer (your role)') && roleSummary.includes('addressed to your role "reviewer" first'), 'existing declared-role priority and wording remain compatible');

console.log(`PASS assignment card: ${checks} checks`);
