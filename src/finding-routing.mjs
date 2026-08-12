// Finding routing — DETECT → ROUTE → DELIVER, the ROUTE half.
//
// When a session VERIFIES something broken or false that lives OUTSIDE its own
// declared scope, that finding today dies in a chat log. The lane already stores
// every session's declared `files` + `intent`, and nothing reads them for this.
// This module works out WHOSE LANE a finding belongs to and drafts the note; a
// human or agent sends it with one paste.
//
// ── The three laws this file exists to obey ────────────────────────────────
// 1. ROUTING IS A SUGGESTION, NEVER AN ASSERTION. A wrong guess costs a peer
//    their whole turn, so every route carries the REASON it was picked
//    ("declared src/foo.ts", "same branch + area") — a human rejects it in one
//    glance. Below the confidence floor we route to NOBODY: silence beats a
//    wrong guess.
// 2. NEVER AUTO-SEND. The anti-noise rule that bans blind auto-capture governs
//    this identically — a lane people learn to ignore stops delivering the
//    overlap warning that actually prevents damage. Draft automatically, send
//    deliberately.
// 3. METADATA ONLY. Routing reads declared file keys, intents, branches and
//    timestamps. It never reads a peer's card text, file contents, or diffs.
//
// PURITY CONTRACT (asserted structurally by test/finding-routing.mjs): this
// module imports `node:crypto` and NOTHING else. No fs, no net, no child_process,
// no brain API. It cannot write the brain, cannot send a message, and cannot
// block anything — its worst failure is a missing or misaddressed SUGGESTION.
import crypto from 'crypto';

export const sha16 = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);

// ── Tunables ────────────────────────────────────────────────────────────────
// Freshness gate for routing TARGETS (R6). A lane row is pruned at 10min but a
// row can still be present-and-stale inside that window; routing uses the SAME
// gate peers are gated by, so we never route into the void. Callers pass the
// canonical SESSION_FRESH_MS from agent-presence.mjs; this default only exists
// so the module is usable standalone (and equals it).
export const ROUTE_FRESH_MS = 10 * 60 * 1000;
// Confidence floor. Below this we route to NOBODY and say why. Calibrated so
// that an exact declared-file match (1.0) and a declared-directory match (0.6)
// route, while branch/area coincidence alone (≤0.35) never does.
export const ROUTE_CONFIDENCE_FLOOR = 0.6;
// A finding draft that is never approved ages out exactly like a rule draft.
export const FINDING_DRAFT_TTL_MS = 21 * 24 * 60 * 60 * 1000;
export const FINDING_DRAFTS_MAX = 40;
export const FINDING_DRAFTS_PER_SESSION = 2;
export const FINDING_DRAFT_MAX_SURFACINGS = 5;

// ── Path normalization ──────────────────────────────────────────────────────
// Byte-identical to mcp-presence.mjs's normalizeFileKey (which now imports this
// one — single definition, so exact-overlap matching and routing can never
// drift apart). Lowercased, forward-slashed, project-root-relative when a root
// is supplied. test/finding-routing.mjs pins the two against a shared table.
export const normalizeFileKey = (value, root) => {
  const raw = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
    .toLowerCase();
  if (!raw || !root) return raw;
  const rootKey = String(root)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase();
  if (!rootKey || raw === rootKey) return raw;
  return raw.startsWith(`${rootKey}/`) ? raw.slice(rootKey.length + 1) : raw;
};

const dirKey = (key) => {
  const i = String(key).lastIndexOf('/');
  return i > 0 ? String(key).slice(0, i) : '';
};

// ── What counts as a routable finding (decision 2) ──────────────────────────
// Deliberately NARROW. Three gates, all required:
//   (a) the session VERIFIED something this turn (ran/built/tested/committed a
//       fix) — a hunch is not routable;
//   (b) the finding text names a CONCRETE ARTIFACT — a path with an extension,
//       optionally with :line — not a vague area;
//   (c) at least one named artifact lies OUTSIDE the session's own scope (its
//       declared lane `files` plus everything it actually touched this turn).
// (c) is what filters R4 (a finding about the sender's own file) AT THE SOURCE:
// an own-scope path is stripped before a draft can ever exist, not suppressed at
// send time.

// A concrete artifact reference: an optional dir chain + a filename with a real
// extension, optionally suffixed :123 or #L123. Rejects prose, bare words, URLs
// (an http(s) scheme is excluded by the leading-boundary test), and version
// strings like "1.49.2" (a leading digit-only "dir" segment cannot start a path
// here because the extension must be alphabetic and ≥2 chars).
const ARTIFACT_RE = /(?:^|[\s(`'"[<])((?:[\w.@-]+\/)*[\w.@-]+\.[a-z]{2,5})(?::(\d+)|#L(\d+))?/gi;
// Extensions we accept as "a real artifact". A closed list beats an open one:
// "e.g." and "vs." and "1.49.2" are all shaped like a dotted token.
const ARTIFACT_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'yml', 'yaml', 'toml',
  'css', 'scss', 'html', 'sql', 'sh', 'ps1', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'swift', 'c', 'h', 'cpp', 'cs', 'php', 'lock', 'env', 'txt', 'csv', 'xml', 'svg',
  'klypix', 'any',
]);

// Every concrete artifact reference in a block of text, normalized + deduped,
// each with the line number it was cited at (null when none).
export function extractArtifactRefs(text, root) {
  const out = new Map();
  const raw = String(text || '');
  ARTIFACT_RE.lastIndex = 0;
  for (;;) {
    const m = ARTIFACT_RE.exec(raw);
    if (!m) break;
    const ref = m[1];
    const ext = ref.slice(ref.lastIndexOf('.') + 1).toLowerCase();
    if (!ARTIFACT_EXT.has(ext)) continue;
    const key = normalizeFileKey(ref, root);
    if (!key || key.includes('://')) continue;
    const line = m[2] || m[3] ? Number(m[2] || m[3]) : null;
    // First citation wins the line number; a later bare mention must not erase it.
    if (!out.has(key)) out.set(key, { key, ref: ref.replace(/\\/g, '/'), line });
    else if (line && out.get(key).line == null) out.get(key).line = line;
  }
  return [...out.values()];
}

// A HEDGE. "CLAUDE.md might be wrong" is a hunch wearing a filename, and the
// founder's rule is explicit: a hunch is not routable. Cheapest reliable test —
// the language people actually use when they have not checked.
const HEDGE_RE = /\b(?:maybe|might|may\s+be|probably|possibly|perhaps|seems?|appears?|i\s+(?:think|suspect|bet)|suspect(?:ed)?|unclear|not\s+sure|worth\s+(?:checking|a\s+look)|should\s+probably|could\s+be|guess|hunch|presumably|needs?\s+(?:investigation|a\s+repro))\b/i;
// A DEFECT CLAIM. Verified + names a foreign file is not enough: "moved
// docs/foo.md into place" passes both and is not a finding. The text must
// actually ASSERT that something is broken, false, dead, or lying.
const DEFECT_RE = /\b(?:is|are|still|was|were)\s+(?:broken|wrong|false|dead|unreachable|stale|missing|outdated|obsolete|a\s+no-?op|generated)\b|\bnever\s+(?:fires?|runs?|awaits?|persists?|matches?|called|read|used|reached|happens?)\b|\bdoes\s+not\s+(?:exist|match|fire|run|persist|restrict|await|apply|ship)\b|\bthrows?\b|\bcrash\w*|\bhangs?\b|\bdead\s+code\b|\bsilently\s+(?:drops?|swallows?|no-?ops?|fails?|ignores?)\b|\breturns?\s+(?:undefined|null|the\s+wrong)\b|\boff[-\s]?by[-\s]?one\b|\brace\s+condition\b|\bdead\s?lock\w*|\bleaks?\b|\bcorrupt\w*|\b(?:claims?|says?|names?|documents?|instructs?|orders?|advertis\w+|promises?)\b[^.]{0,80}\b(?:but|however|yet)\b|\bcontradict\w*|\bfalse\s+(?:since|claim)\b|\bbreaks?\s+(?:the\s+)?(?:build|prebuild|install|release)\b|\bpinned\s+\w*\s*behind\b|\bbehind\b[^.]{0,20}\bversions?\b/i;
// A card's own tag line (#file-… #dir-…) is SLUGS, not paths, and the same is
// true of a URL — neither is an artifact this repo can route to.
// A trailing run of hash tokens — the whole tag line, INCLUDING the leading
// #area slug. Anchored to the end so a "#" inside real prose is untouched.
const TAGLINE_RE = /(?:\s*#[\w./-]+)+\s*$/;
const URL_RE = /\bhttps?:\/\/\S+/gi;

// The claim: the finding text with its tag line and area prefix removed. This is
// what the finding IDENTITY hashes on, so re-wording the surrounding sentence
// does not mint a second draft for the same defect.
export function findingClaim(text) {
  return String(text || '')
    .replace(TAGLINE_RE, '')
    .replace(/^[^:\n]{1,30}:\s*/, '')
    .replace(/^[🏁🛠️❓🎯✅📬↩︎·\s]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The routable-finding predicate. Returns a verdict object rather than a bare
// boolean so the caller can render WHY something was rejected (observability
// beats a silent no-op — the whole feature is invisible when it under-fires).
export function classifyFinding({ text, verified, ownedPaths = [], root = null } = {}) {
  const claim = findingClaim(text);
  const body = claim.replace(URL_RE, ' ');
  const empty = { refs: [], foreign: [], claim };
  if (!claim) return { routable: false, reason: 'empty', ...empty };
  if (!verified) return { routable: false, reason: 'unverified', ...empty };
  if (HEDGE_RE.test(claim)) return { routable: false, reason: 'hedged', ...empty };
  if (!DEFECT_RE.test(claim)) return { routable: false, reason: 'no-defect-claim', ...empty };
  const refs = extractArtifactRefs(body, root);
  if (!refs.length) return { routable: false, reason: 'no-artifact', ...empty };
  // Trailing slashes are stripped so a declared directory ("docs/") and its key
  // form ("docs") are the same claim — otherwise `docs/` never matched anything
  // and every file under it looked foreign.
  const owned = new Set(ownedPaths.map((p) => normalizeFileKey(p, root).replace(/\/+$/, '')).filter(Boolean));
  // Own scope is the file AND its directory: a session that declared
  // src/canvas/KlypixCanvas.tsx owns findings about that file, not about the
  // whole repo — but a session that declared a DIRECTORY key owns files under it.
  // "Directory" = a key whose LAST segment has no extension, so `src/a.ts` never
  // swallows `src/a.ts.map` and `docs` correctly swallows `docs/anything.md`.
  const isDir = (o) => !/\.[a-z0-9]{1,5}$/i.test(o);
  const isOwn = (key) => owned.has(key)
    || [...owned].some((o) => isDir(o) && key.startsWith(`${o}/`));
  const foreign = refs.filter((r) => !isOwn(r.key));
  if (!foreign.length) return { routable: false, reason: 'own-scope', refs, foreign: [], claim };
  return { routable: true, reason: 'verified-foreign-artifact', refs, foreign, claim };
}

// ── Routing (decision 1) ────────────────────────────────────────────────────
// Ownership signals, strongest first. Each contributes a confidence; the
// STRONGEST matching signal decides (they do not sum — two weak coincidences
// must never add up to a confident route).
//
//  1.00  declared-file   peer's lane `files` contains this exact path
//  0.60  declared-dir    peer declared another file in the same directory
//  0.35  branch+area     same branch, and the peer's intent shares a rare token
//  0.00  nothing
//
// A recent COMMITTER of the path (git log -1 --format=%an) was considered and
// deliberately REJECTED as a routing signal: it yields a human NAME, and the
// lane identifies sessions by id/branch/client with no name field anywhere —
// so it cannot address a message. It survives only as OPTIONAL corroborating
// text a caller may pass in (`committerHint`), rendered in the reason line, and
// it never changes the target or the confidence.
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'fix', 'fixes',
  'add', 'adds', 'update', 'updates', 'make', 'work', 'working', 'session', 'file', 'files', 'code',
  'build', 'test', 'tests', 'run', 'new', 'not', 'was', 'are', 'its', 'via', 'per', 'all', 'one']);
const intentTokens = (value) => new Set(String(value || '').toLowerCase()
  .match(/[a-z][a-z0-9-]{3,}/g)?.filter((t) => !STOPWORDS.has(t)) || []);

// Candidate targets: live, fresh, not me, not my own twin row. `isTwin` is
// injected (mcp-presence.isSuspectedTwin) so this module stays a pure leaf; with
// no injection every row is treated as a distinct peer, which is today's
// behaviour everywhere else.
export function routingCandidates({ sessions, selfId, now = Date.now(), freshMs = ROUTE_FRESH_MS, isTwin = null } = {}) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const me = rows.find((s) => s?.id === selfId) || null;
  return rows.filter((s) => s?.id
    && s.id !== selfId
    && now - Number(s.lastSeen || 0) < freshMs        // R6: freshness-gate, or route into the void
    && !(typeof isTwin === 'function' && me && isTwin(s, me)));
}

// Route ONE finding. Returns a verdict — never throws, never sends.
//   verdict: 'routed'    → targets[0] is the owner
//            'contested' → 2+ equally-strong owners; targets lists them all
//            'nobody'    → no candidate cleared the floor
export function routeFinding({
  finding,
  sessions,
  selfId,
  root = null,
  now = Date.now(),
  freshMs = ROUTE_FRESH_MS,
  floor = ROUTE_CONFIDENCE_FLOOR,
  isTwin = null,
  committerHint = null,
} = {}) {
  const path = String(finding?.path || '');
  const key = normalizeFileKey(path, root);
  const base = { path, key, committerHint: committerHint || null };
  if (!key) return { ...base, verdict: 'nobody', confidence: 0, targets: [], reason: 'no path in the finding' };

  const candidates = routingCandidates({ sessions, selfId, now, freshMs, isTwin });
  if (!candidates.length) return { ...base, verdict: 'nobody', confidence: 0, targets: [], reason: 'no live session declared any scope' };

  const myTokens = intentTokens(finding?.text);
  const myBranch = (sessions || []).find((s) => s?.id === selfId)?.branch || null;
  const scored = [];
  for (const peer of candidates) {
    const files = (Array.isArray(peer.files) ? peer.files : []).map((f) => normalizeFileKey(f, root)).filter(Boolean);
    if (files.includes(key)) {
      scored.push({ peer, score: 1, signal: 'declared-file', evidence: key });
      continue;
    }
    const dir = dirKey(key);
    const sibling = dir && files.find((f) => dirKey(f) === dir);
    if (sibling) {
      scored.push({ peer, score: 0.6, signal: 'declared-dir', evidence: sibling });
      continue;
    }
    if (myBranch && peer.branch && peer.branch === myBranch) {
      const shared = [...intentTokens(peer.intent)].filter((t) => myTokens.has(t));
      if (shared.length) scored.push({ peer, score: 0.35, signal: 'branch-intent', evidence: shared.slice(0, 3).join(', ') });
    }
  }
  if (!scored.length) {
    return { ...base, verdict: 'nobody', confidence: 0, targets: [], reason: `no live session declared ${key} or anything beside it` };
  }
  scored.sort((a, b) => b.score - a.score || Number(b.peer.lastSeen || 0) - Number(a.peer.lastSeen || 0));
  const best = scored[0].score;
  if (best < floor) {
    // Deliberate silence, but NOT a silent one: say what was rejected so a human
    // can override. This is the "silence beats a wrong guess" branch.
    return {
      ...base,
      verdict: 'nobody',
      confidence: best,
      targets: [],
      reason: `closest match was only ${scored[0].signal} (${best.toFixed(2)} < ${floor.toFixed(2)} floor) — too weak to address`,
    };
  }
  const tied = scored.filter((s) => s.score === best);
  const targets = tied.map((s) => ({
    id: s.peer.id,
    client: s.peer.client || 'unknown',
    branch: s.peer.branch || null,
    intent: String(s.peer.intent || '').slice(0, 90),
    signal: s.signal,
    evidence: s.evidence,
    lastSeenMs: Math.max(0, now - Number(s.peer.lastSeen || now)),
  }));
  // R2: two sessions both declare the file → route to BOTH, marked contested.
  // Never silently pick one; the human decides, and the draft says so.
  return {
    ...base,
    verdict: tied.length > 1 ? 'contested' : 'routed',
    confidence: best,
    targets,
    reason: reasonLine(targets, best, committerHint),
  };
}

// The "why this session" line — the single thing that turns a wrong route into a
// 2-second dismissal instead of a lost turn (R8). Always rendered, never omitted.
export function reasonLine(targets, confidence, committerHint = null) {
  const one = (t) => {
    const age = t.lastSeenMs < 60_000 ? 'active now' : `active ${Math.round(t.lastSeenMs / 60_000)}m ago`;
    const why = t.signal === 'declared-file' ? `declared \`${t.evidence}\``
      : t.signal === 'declared-dir' ? `declared \`${t.evidence}\` in the same directory`
        : `same branch, intent shares “${t.evidence}”`;
    return `${String(t.id).slice(0, 8)} — ${why}; ${age}`;
  };
  const head = targets.length > 1
    ? `CONTESTED, ${targets.length} sessions match equally: ${targets.map(one).join(' · ')}`
    : (targets[0] ? one(targets[0]) : 'no owner');
  const hint = committerHint ? ` (last committed by ${committerHint})` : '';
  return `${head}${hint} · confidence ${Number(confidence).toFixed(2)}`;
}

// ── Dedupe (R5) ─────────────────────────────────────────────────────────────
// Same finding detected across turns must not become five notes. Keyed on the
// NORMALIZED path + the normalized finding text — the same discipline the
// message layer already uses cross-PC (sha16(originSid|text)), applied one layer
// earlier so the duplicate never reaches the message lane at all.
export function findingKey({ path, text, claim, line = null, root = null } = {}) {
  const p = normalizeFileKey(path, root);
  // Hash the CLAIM, not the whole card: the same defect re-worded next session
  // ("…names a GENERATED file" vs "…points at a generated file") must bump the
  // existing draft, not mint a second note for the peer.
  const t = String(claim ?? findingClaim(text)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // The LINE NUMBER is deliberately excluded from identity. The same defect
  // cited once as `file.ts` and once as `file.ts:135` is one finding for the
  // peer who must act on it; including the line minted two drafts telling the
  // same story twice — the exact duplication the claim-hash above prevents for
  // re-wordings. Line still rides the draft as evidence, it just is not identity.
  return sha16(`${p}|${t}`);
}

// ── Draft construction ──────────────────────────────────────────────────────
// One draft per (finding, path). Storage-shaped, so the caller can persist it in
// the SAME sidecar the rule drafts already live in — no new store, no brain write.
export function buildFindingDrafts({
  cards,
  verified,
  ownedPaths = [],
  sessions = [],
  selfId,
  root = null,
  now = Date.now(),
  freshMs = ROUTE_FRESH_MS,
  isTwin = null,
} = {}) {
  const drafts = [];
  const rejected = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const text = String(card?.text || '');
    const verdict = classifyFinding({ text, verified, ownedPaths, root });
    if (!verdict.routable) { rejected.push({ area: card?.area || '', reason: verdict.reason }); continue; }
    // ONE DRAFT PER FINDING, not per path. A real finding cites its subject AND
    // its context ("CLAUDE.md:135 names global-brain-hook.mjs as source of
    // truth") — drafting both would send the same story twice, which is exactly
    // the noise that kills the lane. The SUBJECT is the foreign artifact with the
    // strongest route; ties break toward the one cited with a line number, then
    // the one cited first. The rest ride along as `mentions` so the recipient
    // sees the whole finding without a second note.
    const routed = verdict.foreign.map((ref, i) => ({
      ref, i,
      route: routeFinding({ finding: { path: ref.ref, text }, sessions, selfId, root, now, freshMs, isTwin }),
    }));
    routed.sort((a, b) => (b.route.confidence || 0) - (a.route.confidence || 0)
      || (b.ref.line ? 1 : 0) - (a.ref.line ? 1 : 0)
      || a.i - b.i);
    const { ref, route } = routed[0];
    drafts.push({
      id: findingKey({ path: ref.ref, claim: verdict.claim, line: ref.line ?? null, root }),
      path: ref.ref,
      key: ref.key,
      line: ref.line ?? null,
      mentions: routed.slice(1).map((r) => r.ref.ref),
      area: card?.area || '',
      // The finding text is OUR OWN card text (this session wrote it) — never a
      // peer's. Stored as the CLAIM (area prefix and #file- tag line stripped) so
      // the peer reads the defect, not our filing metadata. Capped: a draft is a
      // pointer, not a payload.
      text: verdict.claim.slice(0, 320),
      verdict: route.verdict,
      confidence: route.confidence,
      targets: route.targets,
      reason: route.reason,
      firstSeen: now,
      lastSeen: now,
      seenCount: 1,
      shownSessions: [],
    });
  }
  return { drafts, rejected };
}

// Merge freshly-built drafts into the persisted set: TTL-prune, recurrence-bump
// instead of stacking (R5), cap NEW drafts per session, and RE-ROUTE a held
// draft every time (R1 → the 3am finding that had no owner is re-offered the
// moment a matching session appears; R3 → a target that went offline is replaced
// or downgraded to 'nobody' rather than silently kept).
export function mergeFindingDrafts(existing, incoming, {
  now = Date.now(),
  ttlMs = FINDING_DRAFT_TTL_MS,
  max = FINDING_DRAFTS_MAX,
  perSession = FINDING_DRAFTS_PER_SESSION,
  reroute = null,
} = {}) {
  const alive = (Array.isArray(existing) ? existing : [])
    .filter((d) => d && d.id && d.text && now - Number(d.lastSeen || d.firstSeen || 0) < ttlMs);
  const byId = new Map(alive.map((d) => [d.id, d]));
  let added = 0;
  for (const draft of Array.isArray(incoming) ? incoming : []) {
    const prior = byId.get(draft.id);
    if (prior) {
      prior.seenCount = (prior.seenCount || 1) + 1;
      prior.lastSeen = now;
      // Re-route on recurrence: the owner may have changed since the first sight.
      prior.verdict = draft.verdict; prior.confidence = draft.confidence;
      prior.targets = draft.targets; prior.reason = draft.reason;
      continue;
    }
    if (added >= perSession) continue;   // cap NEW drafts only — a bump is free
    byId.set(draft.id, draft);
    added++;
  }
  // Re-route every SURVIVING draft the caller did not just refresh, so a held
  // no-owner draft finds its owner and a stale target is never rendered as live.
  if (typeof reroute === 'function') {
    for (const draft of byId.values()) {
      if (draft.lastSeen === now) continue;
      try {
        const next = reroute(draft);
        if (next) { draft.verdict = next.verdict; draft.confidence = next.confidence; draft.targets = next.targets; draft.reason = next.reason; }
      } catch { /* re-routing is best-effort — a bad row must not drop the set */ }
    }
  }
  return { drafts: [...byId.values()].slice(-max), added };
}

// Pending drafts for a surface: TTL-fresh and not yet decayed. `sid` filters out
// drafts THIS session has already been shown (so one session is nagged once per
// draft, while a NEW session still sees it) — matching the rule-draft contract.
export function pendingFindingDrafts(drafts, {
  sid = null,
  now = Date.now(),
  ttlMs = FINDING_DRAFT_TTL_MS,
  maxSurfacings = FINDING_DRAFT_MAX_SURFACINGS,
} = {}) {
  return (Array.isArray(drafts) ? drafts : [])
    .filter((d) => d && d.id && d.text
      && now - Number(d.lastSeen || d.firstSeen || 0) < ttlMs
      && (Array.isArray(d.shownSessions) ? d.shownSessions.length : 0) < maxSurfacings
      && !(sid && Array.isArray(d.shownSessions) && d.shownSessions.includes(sid)))
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0)
      || (b.seenCount || 1) - (a.seenCount || 1)
      || Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
}

// ── Render (decision 3) ─────────────────────────────────────────────────────
// The approval is ONE PASTE, mirroring the rule-draft `promote → …` line exactly,
// because that line is the pattern agents in this repo already know.
export function renderFindingDrafts(drafts, { limit = 3, total = null } = {}) {
  const list = Array.isArray(drafts) ? drafts.slice(0, limit) : [];
  if (!list.length) return '';
  const lines = ['', '---',
    '## 📬 Finding(s) you verified that belong to SOMEONE ELSE\'S lane — approve to send',
    'You verified something about a file outside your declared scope. The lane knows who declared it; nothing has been sent. '
    + 'Check the “why this session” line — if it is not theirs, skip it (a wrong note costs a peer their whole turn). '
    + 'This is a DRAFT: nothing was written to the brain and no message exists yet.',
    'To send, emit the marker on ITS OWN line WITHOUT the surrounding backticks — a backticked marker is read as a documentation example and is deliberately never sent, so a verbatim paste of the line below does nothing.'];
  for (const draft of list) {
    const where = draft.line ? `${draft.path}:${draft.line}` : draft.path;
    const rec = (draft.seenCount || 1) >= 2 ? `  ⭐ seen ${draft.seenCount}× — still unsent` : '';
    lines.push(`- finding: \`${where}\` — ${String(draft.text).slice(0, 160)}${rec}`);
    lines.push(`  why: ${draft.reason}`);
    if (draft.verdict === 'nobody') {
      lines.push('  → no live session owns this path. It is HELD and re-offered when one appears; if it should outlive that, '
        + `record it instead → \`🧠 BRAIN [${draft.area || 'Docs'}]: ${String(draft.text).slice(0, 120)}\``);
    } else if (draft.verdict === 'contested') {
      lines.push(`  ⚠️ CONTESTED — ${draft.targets.length} sessions match equally; send to both or neither, do not guess:`);
      for (const t of draft.targets) lines.push(`  send → \`🧠 MSG [${String(t.id).slice(0, 8)}]: ${sendBody(draft)}\``);
    } else {
      lines.push(`  send → \`🧠 MSG [${String(draft.targets[0].id).slice(0, 8)}]: ${sendBody(draft)}\``);
    }
  }
  if (total && total > list.length) lines.push(`- …and ${total - list.length} more routed finding(s) in \`.claude/brain-rule-drafts.json\`.`);
  return '\n' + lines.join('\n') + '\n';
}

// The message body a peer will actually receive. It leads with the ARTIFACT so a
// wrong recipient dismisses it in two seconds (R8), and it says it was verified.
export function sendBody(draft) {
  const where = draft?.line ? `${draft.path}:${draft.line}` : draft?.path;
  return `${where} — ${String(draft?.text || '').replace(/\s+/g, ' ').trim().slice(0, 300)} (verified in another session; routed to you because you ${draft?.targets?.[0]?.signal === 'declared-file' ? 'declared this file' : 'declared work beside it'} — not yours? ignore.)`;
}

// ── The receipt (decision 4) ────────────────────────────────────────────────
// v3 delivery records distinguish offered, later-action acknowledgement, and
// explicit agent consumption. Legacy seen[] is untrusted offer evidence and
// never inflates acknowledgement or consumption.
//
// Honesty rules baked in, because each is a way to lie:
//  • the denominator is the peers that were live AT SEND TIME and are still
//    within the message TTL — a peer that started afterwards was never a
//    candidate and must not inflate "pending";
//  • acknowledgement means a later supported action confirmed an earlier
//    model-context offer; consumption is a token-bound explicit agent receipt;
//    neither means that a human read it;
//  • a message with no live peer at send time reports "nobody was live",
//    never "0 of 0 read", which reads as a delivery failure.
const receiptRecordMap = (message) => {
  const records = new Map();
  for (const raw of Array.isArray(message?.deliveries) ? message.deliveries : []) {
    const id = String(raw?.recipientId || raw?.id || '').trim();
    if (!id) continue;
    records.set(id, {
      state: ['pending', 'offered', 'acknowledged', 'consumed', 'failed'].includes(raw?.state)
        ? raw.state : 'offered',
      reason: raw?.reason ? String(raw.reason) : null,
    });
  }
  // Historical `seen` was stamped before output transport/model injection. It
  // is intentionally only OFFERED during migration, never acknowledged.
  for (const legacyId of Array.isArray(message?.seen) ? message.seen : []) {
    const id = String(legacyId || '').trim();
    if (id && !records.has(id)) records.set(id, { state: 'offered', reason: 'legacy-seen-unverified' });
  }
  return records;
};

export function summarizeReceipts({ messages, sessions, selfId, now = Date.now(), ttlMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const mine = (Array.isArray(messages) ? messages : [])
    .filter((m) => m?.id && m.from === selfId && now - Number(m.ts || 0) < ttlMs)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  if (!mine.length) return { sent: 0, receipts: [] };
  const rows = Array.isArray(sessions) ? sessions : [];
  const receipts = mine.map((m) => {
    const target = String(m.to || 'all').trim().toLowerCase();
    const directed = target && target !== 'all' && target !== '*';
    // New messages snapshot the actual live audience at SEND time. Older rows
    // reconstruct it from surviving session rows for backward compatibility.
    // The numerator is intersected with that same audience: a later-arriving
    // session may see a broadcast, but must never produce "acknowledged 3 of 2".
    const reconstructed = rows.filter((s) => s?.id
      && s.id !== selfId
      && Number(s.startedAt || 0) <= Number(m.ts || 0)
      && (!directed || [s.id, String(s.id).slice(0, 8), s.branch, s.client, s.surface]
        .filter(Boolean).join(' ').toLowerCase().includes(target)))
      .map((s) => String(s.id));
    const candidateIds = [...new Set((Array.isArray(m.candidateIds) ? m.candidateIds : reconstructed)
      .filter((id) => id && id !== selfId).map(String))];
    const records = receiptRecordMap(m);
    const stateIds = (state) => candidateIds.filter((id) => records.get(id)?.state === state);
    const acknowledged = stateIds('acknowledged');
    const consumed = stateIds('consumed');
    const offered = stateIds('offered');
    const failed = stateIds('failed');
    const pending = candidateIds.filter((id) => !records.has(id) || records.get(id)?.state === 'pending');
    const unresolved = [...pending, ...offered, ...acknowledged].map((id) => String(id).slice(0, 8));
    return {
      id: m.id,
      to: m.to || 'all',
      directed,
      ts: m.ts,
      ageMs: Math.max(0, now - Number(m.ts || 0)),
      text: String(m.text || '').slice(0, 120),
      acknowledged: acknowledged.length,
      consumed: consumed.length,
      // Compatibility alias for programmatic consumers. It now means a later
      // model-context acknowledgement milestone (including subsequently
      // consumed deliveries), never `seen` and never human-read.
      read: acknowledged.length + consumed.length,
      offered: offered.length,
      failed: failed.length,
      candidates: candidateIds.length,
      pendingIds: unresolved,
      offeredIds: offered.map((id) => String(id).slice(0, 8)),
      acknowledgedIds: acknowledged.map((id) => String(id).slice(0, 8)),
      consumedIds: consumed.map((id) => String(id).slice(0, 8)),
      failedIds: failed.map((id) => String(id).slice(0, 8)),
      deadLetterReason: m.deadLetter?.reason ? String(m.deadLetter.reason) : null,
    };
  });
  return { sent: receipts.length, receipts };
}

// One honest line per receipt. `pending` is listed by id-prefix up to 4 — a name
// you can chase beats a number you can't.
export function renderReceipt(receipt) {
  if (!receipt) return '';
  const age = receipt.ageMs < 60_000 ? 'just now' : `${Math.round(receipt.ageMs / 60_000)}m ago`;
  const who = receipt.directed ? `to ${receipt.to}` : 'broadcast';
  const failure = receipt.deadLetterReason ? receipt.deadLetterReason.replace(/-/g, ' ') : null;
  if (!receipt.candidates) {
    if (failure) return `- ${who}, ${age}: delivery failed (${failure}); no target consumed it. “${receipt.text}”`;
    return `- ${who}, ${age}: queued with no live local target snapshot; no local delivery is claimed. “${receipt.text}”`;
  }
  if (receipt.consumed === receipt.candidates && !receipt.failed) {
    return `- ${who}, ${age}: explicitly consumed by all ${receipt.candidates} target peer(s) after model-context delivery (not human-read). “${receipt.text}”`;
  }
  const pending = receipt.pendingIds.slice(0, 4).join(', ');
  const more = receipt.pendingIds.length > 4 ? ` +${receipt.pendingIds.length - 4} more` : '';
  const offered = receipt.offered ? ` · offered ${receipt.offered}, awaiting later-action ack` : '';
  const acknowledged = receipt.acknowledged ? ` · acknowledged ${receipt.acknowledged}, awaiting explicit consumption` : '';
  const failed = receipt.failed ? ` · failed ${receipt.failed}${failure ? ` (${failure})` : ''}` : '';
  return `- ${who}, ${age}: consumed ${receipt.consumed} of ${receipt.candidates}${offered}${acknowledged}${failed}${pending ? ` · unresolved ${pending}${more}` : ''}. “${receipt.text}”`;
}

// Compact, text-free receipt for surfaces that must stay cheap (SessionStart
// and brain_doctor). The detailed renderer below remains available for an
// explicit audit, but the automatic surface never repeats message content.
export function renderReceiptSummary(summary) {
  const receipt = summary?.receipts?.[0];
  if (!receipt) return '';
  const age = receipt.ageMs < 60_000 ? 'just now' : `${Math.round(receipt.ageMs / 60_000)}m ago`;
  const target = receipt.directed ? ` to ${receipt.to}` : '';
  const failure = receipt.deadLetterReason ? receipt.deadLetterReason.replace(/-/g, ' ') : null;
  if (!receipt.candidates) {
    return failure
      ? `📬 Your last note${target} (${age}): delivery failed (${failure}); no target consumed it.`
      : `📬 Your last note${target} (${age}): queued with no live local target snapshot; no local delivery claimed.`;
  }
  if (receipt.consumed === receipt.candidates && !receipt.failed) {
    return `📬 Your last note${target} (${age}): explicitly consumed by all ${receipt.candidates} target peer(s) after model-context delivery (not human-read).`;
  }
  const pending = receipt.pendingIds.slice(0, 4).join(', ');
  const more = receipt.pendingIds.length > 4 ? ` +${receipt.pendingIds.length - 4} more` : '';
  const offered = receipt.offered ? ` · offered ${receipt.offered}, awaiting ack` : '';
  const acknowledged = receipt.acknowledged ? ` · acknowledged ${receipt.acknowledged}, awaiting explicit consumption` : '';
  const failed = receipt.failed ? ` · failed ${receipt.failed}${failure ? ` (${failure})` : ''}` : '';
  return `📬 Your last note${target} (${age}): consumed ${receipt.consumed} of ${receipt.candidates}${offered}${acknowledged}${failed}${pending ? ` · unresolved ${pending}${more}` : ''}.`;
}

export function renderReceipts(summary, { limit = 3 } = {}) {
  if (!summary?.sent) return '';
  const lines = ['📬 Your notes to other sessions (acknowledged = later model-context action; consumed = explicit agent receipt; neither means human-read):'];
  for (const receipt of summary.receipts.slice(0, limit)) lines.push(renderReceipt(receipt));
  if (summary.sent > limit) lines.push(`- …and ${summary.sent - limit} more sent note(s).`);
  return lines.join('\n');
}
