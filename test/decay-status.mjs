// Decay-aware status — regression suite for the 2026-07-28 post-mortem (3rd
// stale-"what is remaining" incident: a ~12h-old peer message "no TestFlight
// upload triggered yet" was relayed as the top remaining item while build 26
// was already installed on the founder's phone).
//
// The brain is a MEMORY, not a SENSOR: for fast-decay facts its job is to
// carry WHERE to look, never assert WHAT is currently true. Locked here:
//   C   classifyDecay precision table — completed-status verb+release-noun
//       pairing, negative-pending assertions, ev: run-id receipts; and the
//       deliberate NON-matches (process/architecture prose about releases).
//   R1  statusContextToMarkdown renders a >6h fast-decay claim as
//       "⏱️ LAST KNOWN (<age>): <claim> — VERIFY: <probe>", never as current.
//   R2  The stamp survives the char budget the way post-1.32.0 overflow
//       notices do: claim text may be width-cut, the warning may not.
//   R3  verify: suffix precedence over the per-area default probe map, and the
//       per-area defaults themselves (PS-5.1-safe, no '&&').
//   R4  verify: threads through parseKlypix (machine field first, prose
//       fallback) and the append/capture write path.
//   M   decayMessageStamp emits the exact engine-owned message wording.
//
// Run:  node test/decay-status.mjs      (exit 0 = pass, 1 = fail)
import {
  buildKlypix, parseKlypix, appendIntoContainers, statusContextToMarkdown,
  classifyDecay, isFastDecayCard, parseVerifySuffix, decayVerifyProbe,
  decayMessageStamp, formatDecayAge, DECAY_STALE_MS,
} from '../src/klypix-format.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '✓' : '✗'} ${label}`); if (!cond) failures++; };

console.log('\n── C · classifier precision table ──');
const MUST_MATCH = [
  // The real incident text — a NEGATIVE-pending assertion decays just as fast.
  'ready for next TestFlight build; no upload/tag triggered yet',
  'iOS: 🏁 Build 26 uploaded to TestFlight and installed on the founder phone',
  'v1.40.2 published to npm',
  'rollout flipped to 50% for the stable channel',
  'release draft staged for v1.3.36',
  'iOS: submitted to App Store, awaiting review',
  'CI green on build 214',
  'brain bundle 1.3.28 live on the desktop channel',
  // ev: run-id receipt — a machine receipt is a point-in-time observation.
  'ev: gh run 16204339183',
  'not yet published — the npm release waits on the founder',
];
const MUST_NOT_MATCH = [
  // Architecture decision ABOUT the release process — the required non-match.
  'Decided: releases go through GitHub Actions OIDC — npm publish is tokenless',
  'Architecture: the release process uses a staged rollout with manual approval',
  'The release pipeline: build → sign → notarize → upload',
  '❓ should we upload nightly builds to TestFlight?',
  'building the decay-aware status feature for the next release',
  'installed the new VS Code extension for the founder',
  'live-verified the reply language fix on an Arabic YouTube page',
  'shipped the garden fix',   // durable milestone, no release noun — not build status
];
for (const t of MUST_MATCH) ok(classifyDecay(t) === true, `MATCH: ${t.slice(0, 72)}`);
for (const t of MUST_NOT_MATCH) ok(classifyDecay(t) === false, `no match: ${t.slice(0, 72)}`);
// Machine evidence carries the run-id when the prose suffix was stripped at capture.
ok(isFastDecayCard({ text: '🏁 iOS build shipped to testers', evidence: [{ ref: 'gh run 16204339183', kind: 'pr' }] }),
  'isFastDecayCard: machine ev run-id classifies even when prose alone would not');

console.log('\n── R1 · renderer: >6h fast-decay claims are LAST KNOWN, never current ──');
const NOW = Date.parse('2026-07-29T12:00:00Z');
const H = 3_600_000;
const mkStruct = (cards) => ({ cards, connections: [] });
// Extract one section: lines under `headingRe` up to the next heading. The
// area digest above the sections QUOTES milestone headlines inside its own
// `last 🏁 <date> "…"` framing (already last-known by construction, so it is
// deliberately unstamped) — assertions must target the claim's OWN bullet.
const section = (text, headingRe) => {
  const lines = String(text).split('\n');
  const i = lines.findIndex(l => headingRe.test(l));
  if (i < 0) return '';
  const rest = lines.slice(i + 1);
  const end = rest.findIndex(l => /^#{1,3} /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
};
{
  const struct = mkStruct([
    { id: 'm1', type: 'text', area: 'iOS', createdAt: NOW - 20 * H, text: 'iOS: 🏁 Build 26 uploaded to TestFlight and installed on the founder phone' },
    { id: 'o1', type: 'text', area: 'iOS', createdAt: NOW - 20 * H, text: '❓ check: build 26 uploaded to TestFlight; founder phone install unconfirmed since last session' },
    { id: 'o2', type: 'text', area: 'Notes', createdAt: NOW - 20 * H, text: '❓ decide the settings panel layout for the next design pass' },
    { id: 'f1', type: 'text', area: 'iOS', createdAt: NOW - 2 * H, text: 'iOS: 🏁 Build 27 uploaded to TestFlight minutes ago' },
  ]);
  const md = statusContextToMarkdown(struct, { now: NOW });
  const inSec = (headingRe, re) => section(md, headingRe).split('\n').find(l => re.test(l)) || '';
  const mileLine = (re) => inSec(/^## Newest milestones/, re);
  const openLine = (re) => inSec(/^## Open \(/, re);
  ok(/⏱️ LAST KNOWN \(20h\):/.test(mileLine(/Build 26 uploaded/)), 'stale milestone renders as ⏱️ LAST KNOWN (20h)');
  ok(/— VERIFY: /.test(mileLine(/Build 26 uploaded/)), '…with a VERIFY probe appended');
  ok(/⏱️ LAST KNOWN \(20h\):/.test(openLine(/install unconfirmed/)), 'stale fast-decay OPEN item is stamped too');
  ok(openLine(/settings panel layout/) !== '' && !/LAST KNOWN/.test(openLine(/settings panel layout/)), 'a stale NON-decay open is NOT stamped (precision)');
  ok(mileLine(/Build 27 uploaded/) !== '' && !/LAST KNOWN/.test(mileLine(/Build 27 uploaded/)), 'a FRESH (<6h) decay claim is NOT stamped');
  ok(mileLine(/Build 26 uploaded/).includes('gh run list --limit 5; gh release list --limit 5'),
    'iOS-area default probe is the gh run/release pair (PS-5.1-safe ";" chaining)');
  ok(!/&&/.test(md), 'no emitted probe uses "&&" (PS 5.1 host)');
}
{
  // 3d-age formatting + per-area default probes + generic fallback.
  const struct = mkStruct([
    { id: 'd1', type: 'text', area: 'drive', createdAt: NOW - 3 * 24 * H, text: 'drive: 🏁 v1.3.48 rollout flipped to 100%' },
    { id: 'g1', type: 'text', area: 'Notes', createdAt: NOW - 3 * 24 * H, text: 'Notes: 🏁 v1.2.9 published to npm' },
  ]);
  const md = statusContextToMarkdown(struct, { now: NOW });
  const mileLine = (re) => section(md, /^## Newest milestones/).split('\n').find(l => re.test(l)) || '';
  ok(/LAST KNOWN \(3d\):/.test(mileLine(/rollout flipped/)), 'multi-day age renders in days (3d)');
  ok(mileLine(/rollout flipped/).includes('probe the live prod endpoint (HTTP) before reporting'), 'drive/admin area gets the prod HTTP probe hint');
  ok(mileLine(/published to npm/).includes('re-verify live before reporting this as current'), 'unmapped area falls back to the generic re-verify line');
}

console.log('\n── R2 · the stamp survives the budget (v1.32.0 law) ──');
{
  const LOREM = ' this filler text exists purely to spend the character budget so the per-card width collapses toward its 60-char floor and the claim body is really cut.';
  const cards = [
    { id: 's1', type: 'text', area: 'iOS', createdAt: NOW - 20 * H, text: `❓ check: build 26 uploaded to TestFlight; founder phone install unconfirmed.${LOREM}` },
  ];
  for (let i = 0; i < 9; i++) cards.push({ id: `p${i}`, type: 'text', area: 'Misc', createdAt: NOW - 20 * H, text: `❓ plain open item number ${i} with no decay claim at all.${LOREM}` });
  const struct = mkStruct(cards);
  for (const budget of [300, 500, 900, 2000]) {
    const md = statusContextToMarkdown(struct, { budgetChars: budget, now: NOW });
    const claimLines = md.split('\n').filter(l => /build 26/.test(l));
    if (!claimLines.length) { ok(true, `budget ${budget}: claim not shown at all (acceptable — no unstamped exposure)`); continue; }
    ok(claimLines.every(l => /⏱️ LAST KNOWN/.test(l) && /— VERIFY: /.test(l)),
      `budget ${budget}: every rendered decay-claim line carries stamp + probe`);
  }
  // And the claim body really is width-cut at a tight budget while the stamp is whole.
  const tight = statusContextToMarkdown(struct, { budgetChars: 900, now: NOW });
  const l = tight.split('\n').find(x => /build 26/.test(x));
  if (l) ok(/…/.test(l) && /— VERIFY: /.test(l), 'tight budget: claim truncated (…) yet VERIFY tail intact (stamp outside cut)');
  else ok(true, 'tight budget: claim dropped entirely (no unstamped exposure)');
}

console.log('\n── R3 · verify: suffix precedence over the area default ──');
{
  const struct = mkStruct([
    { id: 'v1', type: 'text', area: 'iOS', createdAt: NOW - 20 * H, verify: 'gh run list --workflow ios.yml --limit 3', text: 'iOS: 🏁 Build 26 uploaded to TestFlight' },
  ]);
  const md = statusContextToMarkdown(struct, { now: NOW });
  const l = section(md, /^## Newest milestones/).split('\n').find(x => /Build 26 uploaded/.test(x)) || '';
  ok(l.includes('— VERIFY: gh run list --workflow ios.yml --limit 3'), 'card verify: command wins over the iOS-area default');
  ok(!l.includes('gh release list'), '…and the area default is not appended alongside it');
  ok(decayVerifyProbe({ area: 'Release train' }) === 'gh run list --limit 5; gh release list --limit 5', 'decayVerifyProbe: release-area default');
  ok(decayVerifyProbe({ area: 'admin' }).includes('prod endpoint'), 'decayVerifyProbe: admin-area default');
  ok(decayVerifyProbe({ area: 'canvas ux' }) === 're-verify live before reporting this as current', 'decayVerifyProbe: generic fallback');
}

console.log('\n── R4 · verify: threads through parse + append (machine first, prose fallback) ──');
{
  ok(parseVerifySuffix('🏁 build 26 uploaded verify: gh run list --limit 5 ev: PR #855') === 'gh run list --limit 5',
    'parseVerifySuffix stops at the next marker key (ev:)');
  ok(parseVerifySuffix('a card with no probe at all') === null, 'parseVerifySuffix: absent → null');

  const buf = await buildKlypix({
    title: 'decay-fixture', cards: [
      { text: 'iOS: 🏁 Build 27 uploaded to TestFlight verify: gh run list --workflow ios.yml --limit 3' },
      { text: 'Notes: a plain card with no probe' },
    ],
  });
  const { struct } = await parseKlypix(buf);
  const [withProse, plain] = struct.cards.filter(c => c.type !== 'container');
  ok(withProse.verify === 'gh run list --workflow ios.yml --limit 3', 'parseKlypix: prose verify: suffix threads onto the struct card');
  ok(plain.verify === null, 'parseKlypix: no suffix → verify null');

  // Machine field (capture path) persists and WINS over prose.
  const buf2 = await appendIntoContainers(buf, {
    cards: [{ text: 'iOS: 🏁 build 28 uploaded to TestFlight verify: WRONG-prose-probe', area: 'iOS', verify: 'gh run list --limit 2' }],
  });
  const { struct: s2 } = await parseKlypix(buf2);
  const appended = s2.cards.find(c => /build 28/.test(c.text || ''));
  ok(!!appended && appended.verify === 'gh run list --limit 2', 'append/capture path: machine verify field persists and wins over prose');
}

console.log('\n── M · message stamp: engine-owned exact wording ──');
{
  ok(decayMessageStamp(20 * H) === '⏱️ This message is 20h old and contains build/deploy status — treat as LAST KNOWN, verify live before reporting it.',
    'decayMessageStamp emits the exact brief wording with hour-form age');
  ok(decayMessageStamp(3 * 24 * H).includes('is 3d old'), 'message stamp uses day-form age past 48h');
  ok(formatDecayAge(30 * 60_000) === '30m', 'sub-hour ages render in minutes');
  ok(DECAY_STALE_MS === 6 * H, 'staleness threshold is 6h');
}

console.log(`\n${failures ? `✗ ${failures} FAILED` : '✓ decay-status: all assertions passed'}`);
process.exit(failures ? 1 : 0);
