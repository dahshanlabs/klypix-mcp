// The release handshake (1.72.0) — a lease you cannot take quietly.
//
// The ancestry gate told the DECLARING session what its release would drop.
// The founder's correction was that this is not enough: "at least the user
// should be informed/asked about it". A warning attached to a granted lease is
// one a model may relay or may not, and the failure mode of not relaying it is
// silence — the same shape as every other incident in this project.
//
// MCP has no channel to a human. The strongest honest mechanism available is
// to make silence INSUFFICIENT TO PROCEED: refuse the lease, list the commits,
// and require the retry to name each one by sha. A session that must reproduce
// the shas has, in practice, had to read and surface them.
//
//   H1  a clean release is granted immediately — the gate is invisible when
//       there is nothing to say.
//   H2  a release that would drop work is REFUSED, and nothing is mutated.
//   H3  the refusal names every commit and prints the exact retry call, so the
//       caller never has to guess the shape of the second attempt.
//   H4  acknowledging every sha grants the lease.
//   H5  a PARTIAL acknowledgement is still refused — naming one of three is
//       not informed consent.
//   H6  acknowledgement is prefix-tolerant in both directions: the short shas
//       we printed and the full ones from `git log` both work.
//   H7  an unrelated sha does not satisfy the gate.
//   H8  the HOLDER is never re-blocked. Refreshing mid-release must not become
//       an obstacle, and the natural pattern re-sends releaseIntent every
//       checkpoint.
//   H9  the acknowledge field survives the worker's Zod schema. It was stripped
//       there first time round: the validator accepted it, the schema dropped
//       it, and the second attempt was refused forever with no way through.
//   H10 the third question — a session with unpushed commits is told, while a
//       release is in flight, that its work cannot be in that build.
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { validateReleaseIntent, ancestryAcknowledged } from '../src/mcp-presence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (label, cond) => { assert.ok(cond, label); pass++; };

const ancestryWith = (shas) => ({
  trunk: 'origin/master',
  ref: 'release/9.9.9',
  isDescendant: false,
  missingCount: shas.length,
  sources: [{ ref: 'master', kind: 'trunk', missingCount: shas.length, missing: shas.map((s) => ({ sha: s, subject: 'work' })) }],
  missing: shas.map((s) => ({ sha: s, subject: 'work' })),
});

// ---- H1 — nothing to say, nothing said ---------------------------------
ok('H1 a clean ancestry needs no acknowledgement',
  ancestryAcknowledged({ isDescendant: true, sources: [] }, []) === true);
ok('H1 a null ancestry never blocks', ancestryAcknowledged(null, []) === true);
ok('H1 an explicit ok status never blocks', ancestryAcknowledged({ status: 'ok', sources: [] }, []) === true);

// ---- FAIL CLOSED — the two states that most deserve a human look --------
// Both of these used to return true: an empty list satisfied the gate, so
// "the check could not run" and "a divergence we cannot name" were the two
// conditions that passed silently.
ok('a check that could not run is REFUSED, never treated as clean',
  ancestryAcknowledged({ status: 'unknown', reason: 'target-unresolved', sources: [] }, []) === false);
ok('and it cannot be acknowledged away with arbitrary shas',
  ancestryAcknowledged({ status: 'unknown', reason: 'target-unresolved', sources: [] }, ['aaa1111', 'bbb2222']) === false);
ok('a divergence whose commits cannot be listed is REFUSED',
  ancestryAcknowledged({ status: 'unnameable', missingCount: 3, sources: [{ missing: [] }] }, []) === false);
// A project with no git, or a repo with no trunk and no peer, is not an
// unanswered question but a MEANINGLESS one — blocking there would stop a
// designer's brain in a plain folder from ever declaring a release.
ok('a project with no git at all is NOT blocked',
  ancestryAcknowledged({ status: 'unknown', reason: 'git-unavailable', sources: [] }, []) === true);
ok('a repo with nothing to compare against is NOT blocked',
  ancestryAcknowledged({ status: 'unknown', reason: 'no-comparable-refs', sources: [] }, []) === true);

// ---- H4 / H5 / H7 — what counts as acknowledgement ----------------------
const three = ancestryWith(['aaa1111', 'bbb2222', 'ccc3333']);
ok('H2/H5 no acknowledgement is refused', ancestryAcknowledged(three, []) === false);
ok('H5 acknowledging one of three is refused', ancestryAcknowledged(three, ['aaa1111']) === false);
ok('H5 acknowledging two of three is refused', ancestryAcknowledged(three, ['aaa1111', 'bbb2222']) === false);
ok('H4 acknowledging all three is accepted',
  ancestryAcknowledged(three, ['aaa1111', 'bbb2222', 'ccc3333']) === true);
ok('H7 an unrelated sha does not satisfy the gate',
  ancestryAcknowledged(three, ['aaa1111', 'bbb2222', 'deadbee']) === false);
ok('H7 padding with extra shas does not substitute for a missing one',
  ancestryAcknowledged(three, ['aaa1111', 'bbb2222', 'f00d123', '99a8b7c']) === false);

// ---- H6 — prefix tolerance both ways -----------------------------------
const full = ancestryWith(['abcdef1234567890abcdef1234567890abcdef12']);
ok('H6 a SHORT sha satisfies a long listed one', ancestryAcknowledged(full, ['abcdef1']) === true);
const short = ancestryWith(['abcdef1']);
ok('H6 a LONG sha satisfies a short listed one',
  ancestryAcknowledged(short, ['abcdef1234567890abcdef1234567890abcdef12']) === true);
ok('H6 case is irrelevant', ancestryAcknowledged(ancestryWith(['ABC1234']), ['abc1234']) === true);
ok('H6 a near-miss prefix is still refused', ancestryAcknowledged(short, ['abcdef2']) === false);

// ---- validation of the field itself ------------------------------------
const v = validateReleaseIntent({ version: '1.2.3', ref: 'release/x', acknowledge: ['AAA1111', ' bbb2222 ', 'zzz', ''] });
ok('acknowledge is accepted alongside version and ref', v.ok === true);
ok('acknowledge is normalized to lowercase', v.acknowledge.includes('aaa1111'));
ok('acknowledge is trimmed', v.acknowledge.includes('bbb2222'));
ok('non-hex entries are dropped rather than failing the call', !v.acknowledge.includes('zzz'));
ok('empty entries are dropped', !v.acknowledge.includes(''));

const bad = validateReleaseIntent({ version: '1.2.3', ref: 'release/x', acknowledge: 'aaa1111' });
ok('a non-array acknowledge is a validation error', bad.ok === false);
ok('and the error names the field', /acknowledge/.test(bad.errors.join(' ')));

const none = validateReleaseIntent({ version: '1.2.3', ref: 'release/x' });
ok('acknowledge is optional', none.ok === true && Array.isArray(none.acknowledge) && none.acknowledge.length === 0);

const flood = validateReleaseIntent({
  version: '1.2.3', ref: 'r', acknowledge: Array.from({ length: 500 }, (_, i) => `abc${String(i).padStart(4, '0')}`),
});
ok('acknowledge is bounded against a flood', flood.acknowledge.length <= 64);

// ---- H3 / H8 / H9 — the wiring, asserted against the shipping source ----
// No UI harness exists and the gateway is a 2,600-line function; these are
// grep gates on the real files, normalized for CRLF.
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const PRESENCE = read('src/mcp-presence.mjs');
const WORKER = read('bin/klypix-worker.mjs');

ok('H2 a refused lease is never declared — the refusal short-circuits the call',
  /status: 'ancestry-unacknowledged'[\s\S]{0,400}?\} else \{[\s\S]{0,200}?declareReleaseLease/.test(PRESENCE));
ok('H2 the refusal says nothing was changed', /lease was not taken. No release state changed/.test(PRESENCE));
ok('H3 the refusal carries the shas the retry must echo', /acknowledgeRequired/.test(PRESENCE));
// The first version pre-rendered a copy-pasteable retry call. An adversarial
// review named it the easiest thing on the screen: an agent could paste it and
// never say a word to anyone, which is precisely what the gate exists to
// prevent. The shas are listed; reproducing them is the work, and the work is
// the point.
ok('H3 it does NOT pre-render a copy-pasteable retry — that WAS the bypass',
  !/acknowledge: \[\$\{shas\.map/.test(PRESENCE));
ok('H3 it states how many shas the retry must carry', /naming each of the/.test(PRESENCE));
ok('H3 it requires the user to have decided first', /after the user has been told and has decided/.test(PRESENCE));
ok('H3 the refusal is blocking severity', /kind: 'release-would-leave-work-behind',\n\s+severity: 'blocking'/.test(PRESENCE));
ok('H8 the exemption is the REF, not the holder — a retarget is a new decision',
  /sameRefAsHeld[\s\S]{0,400}?if \(!sameRefAsHeld\)/.test(PRESENCE));
ok('H8 the exemption requires the ref to match what was already gated',
  /String\(existingLease\.ref \|\| ''\) === String\(releaseIntentChecked\.ref/.test(PRESENCE));
ok('H8 a throwing probe is not an all-clear either',
  /catch \{[\s\S]{0,200}?status: 'unknown', reason: 'git-unavailable'/.test(PRESENCE));

ok('H9 the worker schema declares acknowledge, or Zod silently strips it',
  /acknowledge: z\.array\(z\.string\(\)/.test(WORKER));
ok('H9 the schema is bounded like every other caller list', /\.max\(64\)/.test(WORKER));
ok('H9 the tool description tells every host how the refusal works',
  /the lease is REFUSED[\s\S]{0,200}?acknowledge/.test(WORKER));

// ---- H10 — the third question ------------------------------------------
ok('H10 unpushed work is surfaced while a release is in flight',
  /kind: 'unpushed-work-during-release'/.test(PRESENCE));
ok('H10 it uses the already-collected ahead count, costing no new git calls',
  /repoState\?\.aheadBehindOrigin\?\.ahead/.test(PRESENCE));
ok('H10 it never fires for the release holder itself', /holderIsSelf/.test(PRESENCE));
ok('H10 it only fires while a release is genuinely active — never ambient noise',
  PRESENCE.indexOf("kind: 'unpushed-work-during-release'") > PRESENCE.indexOf('if (active) {'));
ok('H10 the text names the release and the remedy',
  /cannot be in that build[\s\S]{0,160}?brain_message/.test(PRESENCE));

console.log(`✓ release handshake — ${pass}/${pass} assertions`);
