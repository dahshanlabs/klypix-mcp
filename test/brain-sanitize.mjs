// Unit tests for the PII/secret scanner. Locked doctrine: prefer MISSES over
// false positives (a scanner that cries wolf on git SHAs gets turned off and
// then catches nothing), redacted previews only (a scan report must never
// itself become the leak), and detection never edits — redaction is a separate
// explicit call. Includes the three historical incident classes: an Apple cert
// SHA1 fingerprint, a personal hotmail address, and a Windows home path.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { redactText, scanBrainStruct, scanText } from '../src/brain-sanitize.mjs';
import { inspect, inspectPrivacy, render } from '../src/brain-doctor.mjs';
import { buildKlypixMap } from '../src/klypix-format.mjs';

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log(`✓ ${message}`); }
  else { fail++; console.error(`✗ ${message}`); }
};
const kinds = (text) => scanText(text).map((f) => f.kind);
const flags = (text, kind) => scanText(text).filter((f) => f.kind === kind);
const clean = (text, message) => ok(scanText(text).length === 0, message);

// ── historical incidents (the reason this module exists) ─────────────────────
{
  const appleColon = 'Distribution cert — SHA1 Fingerprint: A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4 expires 2027';
  ok(flags(appleColon, 'hex-fingerprint').length === 1, 'INCIDENT: Apple cert SHA1 fingerprint (colon form) is detected');

  const appleContiguous = 'cert fingerprint a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4 for the iOS build';
  ok(flags(appleContiguous, 'hex-fingerprint').length === 1, 'INCIDENT: labeled contiguous SHA1 fingerprint is detected via context');

  const hotmail = 'fallback contact is sam.deshan1988@hotmail.com if the relay is down';
  const emailFinding = flags(hotmail, 'email')[0];
  ok(!!emailFinding, 'INCIDENT: a personal hotmail address is detected');
  ok(emailFinding && emailFinding.match === 'sam.…' && !emailFinding.match.includes('@'),
    'the finding preview is first-4-chars + ellipsis — the report never contains the full address');

  const homePath = String.raw`evidence at C:\Users\Ahmed\Documents\passport-scan.pdf (do not share)`;
  ok(flags(homePath, 'home-path').length === 1, 'INCIDENT: a Windows home path with a real username is detected');
}

// ── secrets ──────────────────────────────────────────────────────────────────
{
  ok(kinds('-----BEGIN RSA PRIVATE KEY-----\nMIIE...').includes('private-key'), 'private-key PEM header is detected');
  ok(kinds('-----BEGIN OPENSSH PRIVATE KEY-----').includes('private-key'), 'OpenSSH private-key header is detected');
  clean('-----BEGIN CERTIFICATE----- ... -----BEGIN PUBLIC KEY-----', 'certificates and public keys are NOT findings');

  ok(kinds('key sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34').includes('api-token'), 'sk- style API key is detected');
  ok(kinds('token ghp_AbCd1234EfGh5678IjKl9012MnOp3456').includes('api-token'), 'GitHub PAT (ghp_) is detected');
  ok(kinds('AKIAIOSFODNN7EXAMPLE is in the doc').includes('api-token'), 'AWS access key id shape is detected');
  ok(kinds('slack xoxb-123456789012-abcdefghijkl').includes('api-token'), 'Slack token is detected');
  clean('set OPENAI_API_KEY=sk-YOUR_KEY_HERE and restart', 'sk-YOUR_KEY_HERE placeholder is allowlisted');
  clean('use sk-xxxxxxxxxxxxxxxxxxxxxxxx as a stand-in', 'sk-xxxx… placeholder is allowlisted');

  const jwt = 'bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
  ok(kinds(jwt).includes('jwt'), 'JWT-looking triple is detected');
  clean('the file eyJournal.md was renamed', 'a word starting with eyJ is not a JWT');
}

// ── emails: conservative allowlist ───────────────────────────────────────────
{
  clean('write to hello@klypix.com or support@klypix.com', '*@klypix.com product aliases are allowlisted');
  clean('from noreply@github.com and no-reply@accounts.google.com', 'noreply/no-reply senders are allowlisted');
  clean('e.g. user@example.com, admin@example.org, a@example.test', 'example.* documentation domains are allowlisted');
  ok(flags('CC dr.karim.hassan@gmail.com on the invoice', 'email').length === 1, 'a real personal gmail is detected');
}

// ── hex: git SHAs must never be flagged ──────────────────────────────────────
{
  clean('fixed in 1779b95, full sha 1779b95aabbccddeeff00112233445566778899a on master',
    'a bare git SHA (contiguous 40-hex, no cert context) is NOT flagged');
  clean('mac aa:bb:cc:dd:ee:ff on the office AP', 'a MAC address (6 pairs) stays under the fingerprint bar');
  clean('sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 of the tarball',
    'a bare content hash without certificate context is NOT flagged');
}

// ── home paths ───────────────────────────────────────────────────────────────
{
  ok(flags(String.raw`logs in C:/Users/JSmith/AppData/Roaming/klypix`, 'home-path').length === 1, 'forward-slash Windows home path is detected');
  ok(flags('backup at /Users/alice/Desktop/notes.md', 'home-path').length === 1, 'macOS home path is detected');
  ok(flags('cron writes /home/pavel/brain.klypix', 'home-path').length === 1, 'Linux home path is detected');
  clean(String.raw`install to C:\Users\<name>\AppData as documented`, 'placeholder <name> home path is allowlisted');
  clean(String.raw`expand C:\Users\%USERNAME%\Downloads first`, '%USERNAME% home path is allowlisted');
  clean('CI puts artifacts in /home/runner/work/klypix-mcp', 'CI runner home is allowlisted');
  clean(String.raw`C:\Users\Public\Desktop shortcut`, 'the shared Public profile is not a person');
}

// ── phones: unambiguous shapes only ──────────────────────────────────────────
{
  ok(flags('call +966 50 123 4567 after 10am', 'phone').length === 1, 'international +CC phone is detected');
  ok(flags('hotline (555) 867-5309 ext 2', 'phone').length === 1, '(xxx) xxx-xxxx phone is detected');
  ok(flags('fax 020-7946-0958 works too', 'phone').length >= 0 && flags('cell 555-867-5309', 'phone').length === 1,
    'xxx-xxx-xxxx phone is detected');
  clean('released 2026-08-18 at 12:30, v1.77.0, then 1.2.3-rc.4', 'dates, times, and versions are never phones');
  clean('ISBN 978-0-13-468599-1 covers it', 'ISBN grouping is not a phone');
}

// ── redaction ────────────────────────────────────────────────────────────────
{
  const source = 'mail dr.karim.hassan@gmail.com or +966501234567; key sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12 stays here';
  const redacted = redactText(source);
  ok(!redacted.includes('dr.karim.hassan@gmail.com') && !redacted.includes('sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12'),
    'redactText removes every detected value');
  ok(redacted.includes('[REDACTED:email]') && redacted.includes('[REDACTED:api-token]') && redacted.includes('[REDACTED:phone]'),
    'redaction is kind-labeled so a human can see what was there');
  ok(redacted.startsWith('mail ') && redacted.endsWith(' stays here'), 'prose around findings is untouched');
  const benign = 'Decision: ship v1.77.0 from commit 1779b95 — see brain.klypix, hello@klypix.com';
  ok(redactText(benign) === benign, 'text with no findings round-trips byte-identical (no prose mangling)');
}

// ── scanBrainStruct (the brain_doctor seam) ──────────────────────────────────
{
  const struct = {
    title: 'brain', format: 'klypix', counts: { cards: 3, connections: 0 },
    cards: [
      { id: 'c1', title: 'Contacts', text: 'escalate to dr.karim.hassan@gmail.com', area: 'Ops' },
      { id: 'c2', title: 'Release', text: 'shipped 1.77.0 from commit 1779b95aabbccddeeff00112233445566778899a', area: 'Release' },
      { id: 'c3', title: String.raw`Evidence at C:\Users\Ahmed\scan.pdf`, text: null, area: 'Docs' },
    ],
    connections: [],
  };
  const report = scanBrainStruct(struct);
  ok(report.scanned && report.cards === 3, 'scanBrainStruct scans every card');
  ok(report.total === 2 && report.kinds.email === 1 && report.kinds['home-path'] === 1 && !report.kinds['hex-fingerprint'],
    'struct scan counts by kind — and the git SHA card stays clean');
  ok(report.findings.every((f) => f.cardId && f.match.endsWith('…')),
    'struct findings carry the card id and only redacted previews');
  const empty = scanBrainStruct(null);
  ok(empty.scanned && empty.total === 0, 'a missing/garbage struct scans as empty, never throws');
}

// ── brain_doctor wiring: PRIVACY is a reported finding category ──────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-sanitize-doctor-'));
  try {
    const home = path.join(root, 'home');
    const dirty = path.join(root, 'dirty-project');
    const cleanProj = path.join(root, 'clean-project');
    fs.mkdirSync(path.join(home, '.claude', 'project-brain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'project-brain', '.brain-version.json'),
      JSON.stringify({ brainVersion: '1.77.0', via: 'npm' }));
    fs.mkdirSync(dirty, { recursive: true });
    fs.mkdirSync(cleanProj, { recursive: true });
    fs.writeFileSync(path.join(dirty, 'brain.klypix'), await buildKlypixMap({
      title: 'brain',
      areas: [{
        title: 'Ops',
        cards: [
          { text: String.raw`Escalation: dr.karim.hassan@gmail.com — evidence at C:\Users\Ahmed\scan.pdf` },
          { text: 'Shipped 1.77.0 from commit 1779b95aabbccddeeff00112233445566778899a.' },
        ],
      }],
    }));
    fs.writeFileSync(path.join(cleanProj, 'brain.klypix'), await buildKlypixMap({
      title: 'brain',
      areas: [{ title: 'Ops', cards: [{ text: 'Decision: ship v1.77.0 — contact hello@klypix.com.' }] }],
    }));

    const dirtyPrivacy = await inspectPrivacy(dirty);
    const cleanPrivacy = await inspectPrivacy(cleanProj);
    ok(dirtyPrivacy?.scanned && dirtyPrivacy.total === 2 && dirtyPrivacy.kinds.email === 1 && dirtyPrivacy.kinds['home-path'] === 1,
      'inspectPrivacy parses a REAL .klypix and finds exactly the planted PII');
    ok(cleanPrivacy?.scanned && cleanPrivacy.total === 0, 'a clean brain scans clean (git SHA + product alias never flag)');
    ok(await inspectPrivacy(path.join(root, 'no-brain')) === null, 'no brain.klypix → no privacy layer (null, not a fake clean)');

    const dirtyReport = inspect({ home, projectDir: dirty, privacy: dirtyPrivacy, env: {} });
    const dirtyText = render(dirtyReport, { color: false });
    ok(dirtyReport.layers.privacy === 'warning'
      && dirtyReport.readinessWarnings.some((w) => /secret\/PII/.test(w)),
    'PII findings surface as a PRIVACY readiness warning in the doctor verdict');
    ok(/PRIVACY/.test(dirtyText) && /email×1/.test(dirtyText) && /never edits the brain/.test(dirtyText),
      'the doctor renders count + kinds and says it never auto-edits');
    ok(!dirtyText.includes('dr.karim.hassan@gmail.com') && !dirtyText.includes(String.raw`C:\Users\Ahmed`),
      'the rendered report contains only redacted previews — the report is not the leak');

    const cleanReport = inspect({ home, projectDir: cleanProj, privacy: cleanPrivacy, env: {} });
    ok(cleanReport.layers.privacy === 'ok' && /no secrets\/PII detected/.test(render(cleanReport, { color: false })),
      'a clean brain renders an explicit PRIVACY ok line');
    const unscanned = inspect({ home, projectDir: dirty, env: {} });
    ok(unscanned.layers.privacy === 'n/a' && !/PRIVACY/.test(render(unscanned, { color: false })),
      'a run without a scan renders NO privacy line — absence of a scan never reads as clean');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (fail) {
  console.error(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n✓ brain-sanitize: ${pass} assertions passed`);
