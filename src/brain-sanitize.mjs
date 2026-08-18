// brain-sanitize — conservative PII/secret detection for brain text.
// ============================================================================
// The brain is a durable, often git-committed, sometimes cloud-synced artifact
// that agents write into automatically. Real incidents have put an Apple
// certificate SHA1 fingerprint, a personal hotmail address, and a Windows home
// path (username and all) into brains that were later shared. This module is
// the detector: pure functions over text, no I/O, no network, no dependencies —
// callable from brain_doctor, hooks, or any future gate.
//
// DOCTRINE — prefer misses over false positives. A scanner that mangles prose
// or cries wolf on every git SHA gets turned off, and then catches nothing.
// Concretely:
//   - contiguous 40+ hex is flagged ONLY near certificate/fingerprint context
//     (bare git SHAs are everywhere in a brain and are not secrets);
//   - phone detection requires unambiguous phone shapes (+CC…, (xxx) xxx-xxxx,
//     xxx-xxx-xxxx) so dates/versions/ISBNs never match;
//   - obvious placeholders are allowlisted (example.com, noreply@,
//     *@klypix.com, YOUR_KEY_HERE / XXXX-style stand-ins, <name> path stubs).
//
// This module DETECTS and (on explicit request) REDACTS. It never edits a
// brain by itself — brain_doctor only reports counts and kinds.
//
// Finding shape: { kind, match, index }
//   kind  — 'email' | 'private-key' | 'api-token' | 'jwt' | 'hex-fingerprint'
//           | 'home-path' | 'phone'
//   match — REDACTED preview: first 4 chars + '…' (never the full value; a
//           scan report must not itself become the leak)
//   index — character offset of the match in the scanned text

const PLACEHOLDER = /YOUR_|_HERE|XXXX|xxxx|\.\.\.|<[^>]*>|\$\{|%[A-Za-z_]+%/;

const EMAIL_ALLOW_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.test', 'example.invalid',
  'klypix.com',           // product aliases (hello@, support@) ship in package.json
  'localhost',
]);
const EMAIL_ALLOW_LOCAL = /^(?:noreply|no-reply|do-not-reply|donotreply)$/i;

// Home-directory segments that are NOT a person: OS defaults, CI runners, and
// documentation stand-ins.
const HOME_ALLOW = new Set([
  'public', 'default', 'default user', 'all users', 'defaultapppool',
  'you', 'user', 'users', 'username', 'yourname', 'someone', 'name',
  'runner', 'runneradmin', 'administrator', 'contoso', 'example',
]);
const isPlaceholderSegment = (segment) => {
  const s = String(segment || '').trim();
  if (!s) return true;
  if (HOME_ALLOW.has(s.toLowerCase())) return true;
  return /^<.*>$/.test(s) || /^%.*%$/.test(s) || /^\$/.test(s) || /^\{.*\}$/.test(s);
};

// Each rule yields raw spans; scan() dedupes overlaps afterwards.
const RULES = [
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    keep: () => true,
  },
  {
    kind: 'api-token',
    // OpenAI/Anthropic sk-…, GitHub ghp_/gho_/ghu_/ghs_/ghr_ + fine-grained
    // github_pat_, AWS AKIA…, Slack xox[abprs]-…
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
    keep: (raw) => !PLACEHOLDER.test(raw),
  },
  {
    kind: 'jwt',
    // header.payload.signature, each base64url; eyJ is base64 of '{"'.
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    keep: () => true,
  },
  {
    kind: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    keep: (raw) => {
      const at = raw.lastIndexOf('@');
      const local = raw.slice(0, at);
      const domain = raw.slice(at + 1).toLowerCase();
      if (EMAIL_ALLOW_DOMAINS.has(domain)) return false;
      if (EMAIL_ALLOW_LOCAL.test(local)) return false;
      if (PLACEHOLDER.test(raw)) return false;
      return true;
    },
  },
  {
    kind: 'hex-fingerprint',
    // Colon-separated hex pairs (10+ pairs: MD5=16, SHA1=20, SHA256=32; MAC
    // addresses at 6 pairs stay under the bar). Colon-joined ONLY — space-
    // separated pairs would false-positive on ordinary numeric tables, and the
    // doctrine is to prefer misses.
    re: /\b(?:[0-9A-Fa-f]{2}:){9,}[0-9A-Fa-f]{2}\b/g,
    keep: () => true,
  },
  {
    kind: 'hex-fingerprint',
    // Contiguous 40+ hex ONLY near certificate context — a bare git SHA is
    // routine brain content and must never be flagged.
    re: /\b[0-9A-Fa-f]{40,}\b/g,
    keep: (raw, text, start) => /fingerprint|certificat|thumbprint|\bcert\b|sha-?1\s*[:=]|serial\s*(?:number|no\.?)/i
      .test(text.slice(Math.max(0, start - 64), start)),
  },
  {
    kind: 'home-path',
    // Windows: C:\Users\<name> (either slash style).
    re: /\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]([^\\/\s"'<>|]+)/g,
    keep: (raw, text, start, groups) => !isPlaceholderSegment(groups[0]),
  },
  {
    kind: 'home-path',
    // POSIX: /home/<name> or /Users/<name> at a plausible path boundary.
    re: /(?:^|[\s"'`(=])(\/(?:home|Users)\/([^\\/\s"'<>|]+))/g,
    // group 1 is the path (the span to report), group 2 the username segment.
    span: 1,
    keep: (raw, text, start, groups) => !isPlaceholderSegment(groups[1]),
  },
  {
    kind: 'phone',
    // International: +CC then 7–12 more digits with optional single separators.
    re: /\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d(?:[ .-]?\d){6,11}\b/g,
    keep: () => true,
  },
  {
    kind: 'phone',
    // US-shaped: (xxx) xxx-xxxx and xxx-xxx-xxxx. Dates group as xxxx-xx-xx
    // and never match; times use colons.
    re: /(?:\(\d{3}\)[ .-]?\d{3}[.-]\d{4}|\b\d{3}[.-]\d{3}[.-]\d{4})\b/g,
    keep: () => true,
  },
];

/** Internal: full spans, deduped (earlier start wins; longer span wins ties). */
function scanSpans(text) {
  const input = String(text ?? '');
  const spans = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(input))) {
      const raw = rule.span != null ? m[rule.span] : m[0];
      const start = rule.span != null ? m.index + m[0].indexOf(raw) : m.index;
      // Zero-width safety: a regex that can match empty would loop forever.
      if (!raw) { rule.re.lastIndex = m.index + 1; continue; }
      if (!rule.keep(raw, input, start, m.slice(1))) continue;
      spans.push({ kind: rule.kind, start, end: start + raw.length, raw });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let coveredTo = -1;
  for (const span of spans) {
    if (span.start < coveredTo) continue;   // overlaps a prior finding
    out.push(span);
    coveredTo = span.end;
  }
  return out;
}

/**
 * Scan text for probable secrets/PII.
 * @returns {Array<{kind: string, match: string, index: number}>} — match is a
 * redacted preview (first 4 chars + '…'), never the full value.
 */
export function scanText(text) {
  return scanSpans(text).map((span) => ({
    kind: span.kind,
    match: `${span.raw.slice(0, 4)}…`,
    index: span.start,
  }));
}

/** Replace every finding with [REDACTED:<kind>]. Non-findings are untouched. */
export function redactText(text) {
  const input = String(text ?? '');
  const spans = scanSpans(input);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += input.slice(cursor, span.start) + `[REDACTED:${span.kind}]`;
    cursor = span.end;
  }
  return out + input.slice(cursor);
}

/**
 * Scan a parsed brain struct (klypix-format parseKlypix shape) — pure, no I/O.
 * Scans card titles + text; reports per-kind counts and redacted previews.
 * The caller (brain_doctor) reports; nothing here edits the brain.
 */
export function scanBrainStruct(struct, { maxFindings = 200 } = {}) {
  const cards = Array.isArray(struct?.cards) ? struct.cards : [];
  const findings = [];
  let scannedCards = 0;
  for (const card of cards) {
    scannedCards++;
    // Text cards mirror title === text (the title is a derived preview);
    // scanning both would double-count every finding.
    const fields = card?.title === card?.text ? ['text'] : ['title', 'text'];
    for (const field of fields) {
      const value = card?.[field];
      if (typeof value !== 'string' || !value) continue;
      for (const finding of scanText(value)) {
        findings.push({ ...finding, cardId: card?.id || null, field });
      }
    }
  }
  const kinds = {};
  for (const finding of findings) kinds[finding.kind] = (kinds[finding.kind] || 0) + 1;
  return {
    scanned: true,
    cards: scannedCards,
    total: findings.length,
    kinds,
    findings: findings.slice(0, maxFindings),
  };
}
