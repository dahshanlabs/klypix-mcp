// brain-rules — deterministic project rules made from the brain's own lessons.
//
// A project brain collects the lessons agents and people record while they
// work: "every new App.tsx route must also be in PRIVATE_ROUTES, or a direct
// link 404s", "a new *.test.ts must be listed in package.json or CI never runs
// it", "this file is mixed CRLF/LF and a test pins its bytes". Some lessons can
// be checked mechanically in a diff. This module turns exactly those into
// rules and enforces them BEFORE the change reaches CI, with the same engine in
// three places:
//
//   1. plan time   — brain_sync shows the rules a session's declared/observed
//                    files fall under (glob match; one bounded read for EOL);
//   2. edit time   — the Claude Code PreToolUse/PostToolUse hooks evaluate the
//                    proposed edit (deny for a forbidden line; context for the
//                    rest); Codex gets the same findings as warnings (its hook
//                    output cannot deny a tool call);
//   3. commit time — an opt-in git pre-commit / pre-push hook for every tool
//                    and every person, plus a post-commit pass that records a
//                    commit that landed WITHOUT passing (--no-verify).
//
// Zero AI at check time: string, glob and regex work over the diff, in
// milliseconds, offline. The project's own tests stay with its CI.
//
// Rules are versioned in the repo (.klypix/rules.json) so every change to them
// shows up in a pull request. Each rule cites the brain card it came from and
// moves candidate → active → retired. Promotion and retirement need the
// human's approval code (`npx klypix-mcp rules code …`), derived from the
// exact rule content — the brain_garden pattern: the agent is never shown it.
// Activation and retirement are mirrored into the brain as visible cards
// linked to the source lesson; every override and false alarm becomes a brain
// card too. Every fire and block is counted in a small machine-local ledger
// (cards per block would flood the brain), which feeds per-rule hits /
// overrides / false alarms and the "retire this rule?" suggestions.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

export const RULES_SCHEMA_VERSION = 1;
export const RULES_FILE = '.klypix/rules.json';
export const RULE_KINDS = ['listed-in', 'forbid-pattern', 'preserve-eol', 'cloud-required'];
export const SEVERITIES = ['block', 'warn', 'advise'];
export const STATUSES = ['candidate', 'active', 'retired'];
export const RULES_AREA = 'Rules';
const ALLOW_FILE = 'klypix-rules-allow.json';      // inside the git common dir — never committed
const ALLOW_TTL_MS = 60 * 60 * 1000;

const RULE_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const CARD_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{2,120}$/;
const MAX_RULES = 64;
const MAX_LINE = 2000;            // regexes only ever see bounded lines (ReDoS guard)
const MAX_BLOB = 8 * 1024 * 1024; // larger files are skipped by EOL and registry reads
const isPlainObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const sha = (s, n = 16) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);

// The markers a coding agent's host sets on every shell command it runs. The
// person's own commands (the approval code, a one-hour exception) refuse inside
// one, so an agent cannot approve its own rule or excuse its own change by
// accident. A guard, not a security boundary: an agent that strips its
// environment is working around the person on purpose, and the rules file
// still changes in review.
export const AGENT_SHELL_MARKERS = Object.freeze([
  ['CLAUDECODE', 'Claude Code'], ['CLAUDE_CODE_SESSION_ID', 'Claude Code'], ['CODEX_THREAD_ID', 'Codex'], ['CODEX_SANDBOX', 'Codex'],
  ['CURSOR_SESSION_ID', 'Cursor'], ['CLINE_SESSION_ID', 'Cline'], ['WINDSURF_SESSION_ID', 'Windsurf'],
]);
export function agentShell(env = process.env) {
  for (const [key, host] of AGENT_SHELL_MARKERS) if (env?.[key]) return host;
  return null;
}

// ── globs ────────────────────────────────────────────────────────────────────
// Repo-relative, `/`-separated. `**` spans directories, `*` and `?` stay inside
// one segment, `{a,b}` alternates. A glob without `/` matches the basename
// anywhere (like .gitignore), so `*.test.ts` means any test file.
const globCache = new Map();
export function globToRegExp(glob) {
  const key = String(glob);
  if (globCache.has(key)) return globCache.get(key);
  const g = key.replace(/\\/g, '/').replace(/^\.\//, '');
  const anywhere = !g.includes('/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{' && g.indexOf('}', i) > i) {
      const end = g.indexOf('}', i);
      re += `(?:${g.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
      i = end;
    } else re += /[.+^$(){}|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  const out = new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${re}$`);
  globCache.set(key, out);
  return out;
}
const asList = (v) => (Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v])).map(String);
const normRel = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
export function matchesGlobs(globs, file) {
  const p = normRel(file);
  return asList(globs).some((g) => globToRegExp(g).test(p));
}
const inScope = (rule, file) => matchesGlobs(rule.files, file) && !matchesGlobs(rule.exclude, file);
const compile = (rule) => new RegExp(rule.pattern, String(rule.flags || '').replace(/[^imsu]/g, ''));

// ── validation ───────────────────────────────────────────────────────────────
function checkRegex(source, flags, label, errors) {
  if (typeof source !== 'string' || !source || source.length > 400) {
    errors.push(`${label} must be a regular expression of 1-400 characters`);
    return;
  }
  try { new RegExp(source, String(flags || '').replace(/[^imsu]/g, '')); }
  catch (error) { errors.push(`${label} is not a valid regular expression: ${error.message}`); }
}

const RULE_FIELDS = new Set(['id', 'status', 'kind', 'severity', 'why', 'fix', 'source', 'files', 'exclude', 'when',
  'pattern', 'flags', 'registry', 'registryMode', 'needle', 'base', 'proposedAt', 'proposedBy', 'approvedAt',
  'approvedBy', 'retiredAt', 'retiredReason', 'mirrorCard']);

export function validateRule(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['a rule must be an object'], rule: null };
  const unknown = Object.keys(raw).filter((k) => !RULE_FIELDS.has(k));
  if (unknown.length) errors.push(`unknown rule field(s): ${unknown.sort().join(', ')}`);
  const id = String(raw.id || '').trim();
  if (!RULE_ID_RE.test(id)) errors.push('id must be a lowercase key (a-z, 0-9, . _ -; 2-64 characters)');
  const status = String(raw.status || 'candidate');
  if (!STATUSES.includes(status)) errors.push(`status must be one of ${STATUSES.join(', ')}`);
  const kind = String(raw.kind || '');
  if (!RULE_KINDS.includes(kind)) errors.push(`kind must be one of ${RULE_KINDS.join(', ')}`);
  // Warn unless a person chose block when approving the rule (promote --block).
  const severity = String(raw.severity || (kind === 'cloud-required' ? 'advise' : 'warn'));
  if (!SEVERITIES.includes(severity)) errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  const why = typeof raw.why === 'string' ? raw.why.trim() : '';
  if (!why || why.length > 300) errors.push('why is required: the lesson in one line (at most 300 characters)');
  const fix = typeof raw.fix === 'string' ? raw.fix.trim() : '';
  if (!fix || fix.length > 300) errors.push('fix is required: how to fix a finding, in one line (at most 300 characters)');
  const source = isPlainObject(raw.source) ? raw.source : null;
  if (!source || !CARD_ID_RE.test(String(source.card || ''))) errors.push('source.card must name the brain card this rule came from');
  const files = asList(raw.files).map((g) => g.trim()).filter(Boolean);
  if (!files.length || files.length > 32) errors.push('files must list 1-32 globs');
  if (files.some((g) => /<|>/.test(g))) errors.push('files still holds a placeholder (<…>) — complete the draft');
  const exclude = asList(raw.exclude).map((g) => g.trim()).filter(Boolean);
  const rule = {
    id, status, kind, severity, why, fix,
    source: source ? { card: String(source.card), ...(source.brain ? { brain: String(source.brain) } : {}) } : null,
    files,
    ...(exclude.length ? { exclude } : {}),
  };
  if (kind === 'listed-in') {
    const when = String(raw.when || 'added-files');
    if (!['added-files', 'added-lines'].includes(when)) errors.push('when must be added-files or added-lines');
    rule.when = when;
    if (when === 'added-lines') {
      checkRegex(raw.pattern, raw.flags, 'pattern', errors);
      rule.pattern = String(raw.pattern || '');
      if (raw.flags) rule.flags = String(raw.flags);
    }
    const registry = asList(raw.registry).map((r) => normRel(r.trim())).filter(Boolean);
    if (!registry.length || registry.length > 8) errors.push('registry must name 1-8 repo-relative files');
    if (registry.some((r) => r.startsWith('/') || r.split('/').includes('..') || /[*?<>]/.test(r))) errors.push('registry must hold plain repo-relative paths');
    rule.registry = registry;
    rule.registryMode = raw.registryMode === 'any' ? 'any' : 'all';
    rule.needle = String(raw.needle || (when === 'added-lines' ? '{1}' : '{basename}'));
    if (raw.base) rule.base = normRel(raw.base).replace(/\/+$/, '');
  } else if (kind === 'forbid-pattern') {
    checkRegex(raw.pattern, raw.flags, 'pattern', errors);
    rule.pattern = String(raw.pattern || '');
    if (raw.flags) rule.flags = String(raw.flags);
  }
  for (const k of ['proposedAt', 'proposedBy', 'approvedAt', 'approvedBy', 'retiredAt', 'retiredReason', 'mirrorCard']) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') rule[k] = String(raw[k]).slice(0, 300);
  }
  return errors.length ? { ok: false, errors, rule: null } : { ok: true, errors: [], rule };
}

export function validateRulesDoc(raw) {
  if (!isPlainObject(raw)) return { ok: false, errors: ['the rules file must be a JSON object'], rules: [] };
  const errors = [];
  if (raw.schemaVersion !== RULES_SCHEMA_VERSION) errors.push(`schemaVersion must be ${RULES_SCHEMA_VERSION}`);
  const list = Array.isArray(raw.rules) ? raw.rules : null;
  if (!list) errors.push('rules must be an array');
  const rules = [];
  const seen = new Set();
  for (const [i, item] of (list || []).entries()) {
    const checked = validateRule(item);
    if (!checked.ok) { errors.push(...checked.errors.map((e) => `rules[${i}]: ${e}`)); continue; }
    if (seen.has(checked.rule.id)) { errors.push(`rules[${i}]: duplicate id ${checked.rule.id}`); continue; }
    seen.add(checked.rule.id);
    rules.push(checked.rule);
  }
  if (rules.length > MAX_RULES) errors.push(`at most ${MAX_RULES} rules`);
  return { ok: errors.length === 0, errors, rules };
}

// ── rules file I/O ───────────────────────────────────────────────────────────
const docText = (rules) => `${JSON.stringify({ schemaVersion: RULES_SCHEMA_VERSION, rules: [...rules].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2)}\n`;
const loadCache = new Map();
export function rulesFilePath(projectRoot) { return path.join(projectRoot, RULES_FILE); }

/** Every rule in the file (any status). A broken file reports itself and enforces nothing. */
export function loadRulesDoc(projectRoot) {
  const file = rulesFilePath(projectRoot);
  let stat;
  try { stat = fs.statSync(file); } catch { return { ok: true, missing: true, file, rules: [], errors: [] }; }
  const cached = loadCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;
  let result;
  try { result = { ...validateRulesDoc(JSON.parse(fs.readFileSync(file, 'utf8'))), file, missing: false }; }
  catch (error) { result = { ok: false, missing: false, file, rules: [], errors: [`${RULES_FILE} is not valid JSON: ${error.message}`] }; }
  loadCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  return result;
}
export const activeRules = (doc) => (doc?.rules || []).filter((r) => r.status === 'active');

function writeRulesDoc(projectRoot, rules) {
  const file = rulesFilePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, docText(rules), 'utf8');
  fs.renameSync(tmp, file);
  loadCache.delete(file);
  return file;
}

// ── lifecycle: candidate → active → retired ──────────────────────────────────
/** The human's approval code for one lifecycle action on exactly these rules, today. */
export function lifecycleCode(action, rules, day = new Date().toISOString().slice(0, 10)) {
  const canonical = JSON.stringify([...rules].sort((a, b) => a.id.localeCompare(b.id)).map((r) => {
    const { approvedAt, approvedBy, retiredAt, mirrorCard, ...content } = r;   // bookkeeping is not content
    return content;
  }));
  return crypto.createHash('sha1').update(`${action}|${canonical}|${day}`).digest('hex').slice(0, 8);
}

/** Add or replace CANDIDATE rules. Active and retired rules are never edited here. */
export function addCandidates(projectRoot, proposed, { cardExists = null, proposedBy = '', now = new Date() } = {}) {
  const list = Array.isArray(proposed) ? proposed : [];
  if (!list.length) return { ok: false, errors: ['give 1 or more rules'] };
  const doc = loadRulesDoc(projectRoot);
  if (!doc.ok) return { ok: false, errors: doc.errors };
  const byId = new Map(doc.rules.map((r) => [r.id, r]));
  const errors = [];
  const added = [];
  for (const [i, raw] of list.entries()) {
    // A candidate never blocks: whether a rule stops work is the person's choice at approval.
    const severity = raw?.severity === 'block' ? 'warn' : raw?.severity;
    const checked = validateRule({ ...raw, ...(severity ? { severity } : {}), status: 'candidate', proposedAt: now.toISOString(), ...(proposedBy ? { proposedBy } : {}) });
    if (!checked.ok) { errors.push(...checked.errors.map((e) => `rules[${i}]: ${e}`)); continue; }
    const prior = byId.get(checked.rule.id);
    if (prior && prior.status !== 'candidate') { errors.push(`rules[${i}]: ${checked.rule.id} is ${prior.status}; propose a new id and retire the old rule instead`); continue; }
    if (cardExists && !cardExists(checked.rule.source.card)) { errors.push(`rules[${i}]: source card ${checked.rule.source.card} is not in the brain`); continue; }
    added.push(checked.rule);
  }
  if (errors.length) return { ok: false, errors };
  for (const r of added) byId.set(r.id, r);
  if (byId.size > MAX_RULES) return { ok: false, errors: [`at most ${MAX_RULES} rules`] };
  const file = writeRulesDoc(projectRoot, [...byId.values()]);
  return { ok: true, file, added: added.map((r) => r.id) };
}

function pick(doc, ids, statuses) {
  const want = [...new Set(asList(ids))];
  const found = doc.rules.filter((r) => want.includes(r.id));
  const missing = want.filter((id) => !found.some((r) => r.id === id));
  const wrong = found.filter((r) => !statuses.includes(r.status));
  return { want, found, missing, wrong };
}

/**
 * What the human reviews before approving: the rules and the code for exactly
 * them. `block` (promote only) is the person's choice to make the rules stop an
 * edit or a commit instead of warning; it is part of what the code covers.
 */
export function lifecycleReview(projectRoot, action, ids, { now = new Date(), block = false } = {}) {
  const doc = loadRulesDoc(projectRoot);
  if (!doc.ok) return { ok: false, message: doc.errors.join('; ') };
  const statuses = action === 'promote' ? ['candidate'] : ['candidate', 'active'];
  const { found, missing, wrong } = pick(doc, ids, statuses);
  if (!found.length || missing.length || wrong.length) {
    return { ok: false, message: [missing.length ? `not found: ${missing.join(', ')}` : '', wrong.length ? `cannot ${action}: ${wrong.map((r) => `${r.id} is ${r.status}`).join(', ')}` : '', !found.length ? 'name at least one rule' : ''].filter(Boolean).join('; ') };
  }
  const rules = action === 'promote' && block ? found.map((r) => (r.kind === 'cloud-required' ? r : { ...r, severity: 'block' })) : found;
  return { ok: true, rules, code: lifecycleCode(action, rules, now.toISOString().slice(0, 10)) };
}

/** candidate → active, only with the human's code. Mirrors each rule into the brain. */
export async function promoteRules(projectRoot, ids, code, { approvedBy = 'human (approval code)', now = new Date(), brainPath = null, block = false } = {}) {
  const review = lifecycleReview(projectRoot, 'promote', ids, { now, block });
  if (!review.ok) return { ok: false, reason: 'invalid', message: review.message };
  if (String(code || '').trim() !== review.code) {
    return { ok: false, reason: 'code', message: `Refused: activating a rule needs the human's approval code. Show the human the rule(s) and ask them to run \`npx klypix-mcp rules code promote ${review.rules.map((r) => r.id).join(' ')}${block ? ' --block' : ''}\` in this project, then pass the 8-character code they paste. The code is tied to the exact rule text, to whether the rules block, and to today; it is never shown to you.` };
  }
  const doc = loadRulesDoc(projectRoot);
  const stamp = now.toISOString();
  const promoted = review.rules.map((r) => ({ ...r, status: 'active', approvedAt: stamp, approvedBy }));
  const mirror = await mirrorToBrain(projectRoot, promoted.map((r) => ({ rule: r, text: ruleCardText(r), link: r.source.card, label: 'became rule' })), { brainPath });
  for (const r of promoted) if (mirror.ids?.[r.id]) r.mirrorCard = mirror.ids[r.id];
  const byId = new Map(doc.rules.map((r) => [r.id, r]));
  for (const r of promoted) byId.set(r.id, r);
  const file = writeRulesDoc(projectRoot, [...byId.values()]);
  appendEvents(projectRoot, promoted.map((r) => ({ rule: r.id, event: 'promoted', layer: 'lifecycle' })));
  return { ok: true, file, promoted: promoted.map((r) => r.id), mirrored: mirror.ok, mirrorNote: mirror.note || '' };
}

/** candidate/active → retired, only with the human's code (a blocked agent must not lift its own block). */
export async function retireRules(projectRoot, ids, code, { reason = '', now = new Date(), brainPath = null } = {}) {
  const review = lifecycleReview(projectRoot, 'retire', ids, { now });
  if (!review.ok) return { ok: false, reason: 'invalid', message: review.message };
  if (String(code || '').trim() !== review.code) {
    return { ok: false, reason: 'code', message: `Refused: retiring a rule needs the human's approval code — a session a rule blocks must not be able to lift the block itself. Ask the human to run \`npx klypix-mcp rules code retire ${review.rules.map((r) => r.id).join(' ')}\` and paste the code.` };
  }
  const doc = loadRulesDoc(projectRoot);
  const stamp = now.toISOString();
  const why = String(reason || '').trim().slice(0, 300) || 'retired by the human';
  const retired = review.rules.map((r) => ({ ...r, status: 'retired', retiredAt: stamp, retiredReason: why }));
  const mirror = await mirrorToBrain(projectRoot, retired.map((r) => ({
    rule: r,
    text: `${RULES_AREA}: ↩︎ Retired rule \`${r.id}\` (${stamp.slice(0, 10)}): ${why}. It no longer blocks or warns; its lesson stays in card ${r.source.card}.`,
    link: r.mirrorCard || r.source.card, label: 'retired',
  })), { brainPath });
  const byId = new Map(doc.rules.map((r) => [r.id, r]));
  for (const r of retired) byId.set(r.id, r);
  const file = writeRulesDoc(projectRoot, [...byId.values()]);
  appendEvents(projectRoot, retired.map((r) => ({ rule: r.id, event: 'retired', layer: 'lifecycle', reason: why })));
  return { ok: true, file, retired: retired.map((r) => r.id), mirrored: mirror.ok, mirrorNote: mirror.note || '' };
}

const sentence = (s) => { const t = String(s || '').trim(); return /[.!?]$/.test(t) ? t : `${t}.`; };
export function ruleCardText(rule) {
  const where = rule.kind === 'listed-in' ? `Checked: new ${rule.files.join(', ')} must appear in ${rule.registry.join(', ')}.`
    : `Files: ${rule.files.join(', ')}.`;
  return `${RULES_AREA}: 📏 Rule \`${rule.id}\` is active (${rule.severity}, ${rule.kind}). Why: ${sentence(rule.why)} Fix: ${sentence(rule.fix)} ${where} ${rule.severity === 'block' ? 'Blocks: it stops an edit (Claude Code; Codex is warned) and a commit (git hook) until the change is fixed or a person allows it.' : 'Warns when a session declares these files (brain_sync), on each edit and at commit; it never stops the work.'} From lesson ${rule.source.card}; versioned in ${RULES_FILE}.`;
}

// ── brain writes (cards for lifecycle, overrides and false alarms) ──────────
/**
 * Append cards to the project brain under the shared write lock, each linked
 * to an existing card. Plain append (no supersede/resolve heuristics), so a
 * rule card can never retire the lesson it was made from. Never throws.
 */
export async function mirrorToBrain(projectRoot, entries, { brainPath = null } = {}) {
  const brain = brainPath || path.join(projectRoot, 'brain.klypix');
  if (!entries.length) return { ok: true, ids: {} };
  if (!fs.existsSync(brain)) return { ok: false, ids: {}, note: 'no brain.klypix in this project — rule status lives only in .klypix/rules.json' };
  try {
    const lib = await import(new URL('./klypix-format.mjs', import.meta.url).href);
    const lockLib = await import(new URL('./brain-write-lock.mjs', import.meta.url).href);
    let result = { ok: false, ids: {}, note: 'the brain is busy (another writer holds its lock); the rule file is updated and the card will be added on the next rules action' };
    await lockLib.withAdvisoryWriteLock(lockLib.brainCaptureLockPath(brain), async (locked) => {
      if (!locked) return;
      const before = fs.readFileSync(brain);
      const known = new Set((await lib.parseKlypix(before)).struct.cards.map((c) => c.id));
      const cards = entries.map((e) => ({ text: e.text, group: RULES_AREA, createdVia: 'klypix-rules', borderColor: 'rgba(245,158,11,0.7)' }));
      const connections = entries.map((e, i) => (e.link && known.has(e.link) ? { from: e.link, to: i, label: e.label || '' } : null)).filter(Boolean);
      const out = await lib.appendToKlypix(before, { cards, connections });
      await lib.atomicWrite(brain, out);
      // appendToKlypix adds the cards in order (plus, at most, the Rules box).
      const fresh = (await lib.parseKlypix(out)).struct.cards.filter((c) => !known.has(c.id) && c.type !== 'container');
      const ids = {};
      entries.forEach((e, i) => { if (e.rule?.id && fresh[i]) ids[e.rule.id] = fresh[i].id; });
      result = { ok: true, ids };
    }, { tries: 40, waitMs: 50 });
    if (!result.ok) queuePendingCards(projectRoot, entries);
    return result;
  } catch (error) {
    queuePendingCards(projectRoot, entries);
    return { ok: false, ids: {}, note: `brain card not written (${String(error?.message || error).slice(0, 120)}); queued for the next rules action` };
  }
}

// ── the machine-local ledger (fires, blocks, overrides, false alarms) ────────
export function ledgerDir(home = os.homedir()) { return path.join(home, '.claude', 'project-brain', 'rules'); }
const projectKey = (projectRoot) => {
  let p = path.resolve(projectRoot);
  try { p = fs.realpathSync.native(p); } catch { /* keep resolved */ }
  p = p.replace(/\\/g, '/');
  return sha(process.platform === 'win32' ? p.toLowerCase() : p);
};
export function ledgerFile(projectRoot, home = os.homedir()) { return path.join(ledgerDir(home), `${projectKey(projectRoot)}.jsonl`); }
const pendingCardsFile = (projectRoot, home = os.homedir()) => path.join(ledgerDir(home), `${projectKey(projectRoot)}.pending-cards.json`);

/** Append events; never throws, never slows a commit by more than a write. */
export function appendEvents(projectRoot, events, { home = os.homedir(), now = Date.now() } = {}) {
  if (!events?.length) return;
  try {
    const file = ledgerFile(projectRoot, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* first write */ }
    fs.appendFileSync(file, events.map((e) => JSON.stringify({ ts: now, ...e })).join('\n') + '\n', 'utf8');
  } catch { /* the ledger is best-effort; enforcement never depends on it */ }
}

export function readEvents(projectRoot, { home = os.homedir() } = {}) {
  const out = [];
  for (const f of [`${ledgerFile(projectRoot, home)}.1`, ledgerFile(projectRoot, home)]) {
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* torn line */ } }
  }
  return out;
}

function queuePendingCards(projectRoot, entries, { home = os.homedir() } = {}) {
  try {
    const file = pendingCardsFile(projectRoot, home);
    let pending = [];
    try { pending = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { pending = []; }
    pending.push(...entries.map((e) => ({ text: e.text, link: e.link || null, label: e.label || '', ruleId: e.rule?.id || null })));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pending.slice(-200)), 'utf8');
  } catch { /* best-effort */ }
}

/** Write cards that could not be written earlier (the brain was locked). */
export async function flushPendingCards(projectRoot, { home = os.homedir(), brainPath = null } = {}) {
  const file = pendingCardsFile(projectRoot, home);
  let pending = [];
  try { pending = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { flushed: 0 }; }
  if (!pending.length) return { flushed: 0 };
  try { fs.unlinkSync(file); } catch { return { flushed: 0 }; }
  const res = await mirrorToBrain(projectRoot, pending.map((p) => ({ text: p.text, link: p.link, label: p.label, rule: p.ruleId ? { id: p.ruleId } : null })), { brainPath });
  return { flushed: res.ok ? pending.length : 0 };
}

/** Per-rule counts and the "retire it?" suggestions. */
export function ruleStats(projectRoot, { home = os.homedir(), now = Date.now(), quietDays = 30 } = {}) {
  const doc = loadRulesDoc(projectRoot);
  const events = readEvents(projectRoot, { home });
  const stats = {};
  for (const r of doc.rules) stats[r.id] = { id: r.id, status: r.status, severity: r.severity, fires: 0, blocks: 0, overrides: 0, falseAlarms: 0, lastFiredAt: null, byLayer: {} };
  for (const e of events) {
    const s = stats[e.rule];
    if (!s) continue;
    if (e.event === 'fire' || e.event === 'block') {
      s.fires++;
      s.byLayer[e.layer || 'unknown'] = (s.byLayer[e.layer || 'unknown'] || 0) + 1;
      if (!s.lastFiredAt || e.ts > s.lastFiredAt) s.lastFiredAt = e.ts;
    }
    if (e.event === 'block') s.blocks++;
    if (e.event === 'override') s.overrides++;
    if (e.event === 'false-alarm') s.falseAlarms++;
  }
  const suggestions = [];
  for (const r of activeRules(doc)) {
    const s = stats[r.id];
    const since = Date.parse(r.approvedAt || '') || now;
    const ageDays = (now - since) / 86_400_000;
    const quiet = !s.lastFiredAt || (now - s.lastFiredAt) / 86_400_000 >= quietDays;
    if (ageDays >= quietDays && quiet) suggestions.push({ id: r.id, why: `has not fired in ${quietDays} days on this machine — the mistake may be gone (or the files moved). Consider retiring it.` });
    const pushback = s.overrides + s.falseAlarms;
    if (pushback >= 3 && pushback >= 0.5 * Math.max(1, s.blocks)) suggestions.push({ id: r.id, why: `overridden or marked a false alarm ${pushback} time(s) against ${s.blocks} block(s) — narrow its files/pattern, lower it to warn, or retire it.` });
  }
  return { stats: Object.values(stats), suggestions, ledger: ledgerFile(projectRoot, home), machineLocal: true };
}

// ── human allowances (explicit, recorded, one hour) ──────────────────────────
function gitCommonDir(repo) {
  const out = gitTry(repo, ['rev-parse', '--git-common-dir']);
  return out ? path.resolve(repo, String(out).trim()) : null;
}
export function readAllowances(repo, { now = Date.now() } = {}) {
  const dir = gitCommonDir(repo);
  if (!dir) return [];
  try { return (JSON.parse(fs.readFileSync(path.join(dir, ALLOW_FILE), 'utf8')) || []).filter((a) => a && a.expiresAt > now); }
  catch { return []; }
}
export function addAllowance(repo, { rule, reason, file = null, by = os.userInfo().username, now = Date.now() }) {
  const dir = gitCommonDir(repo);
  if (!dir) return { ok: false, message: 'not a git repository' };
  if (!String(reason || '').trim()) return { ok: false, message: 'an override needs a reason' };
  const list = readAllowances(repo, { now });
  list.push({ rule, reason: String(reason).trim().slice(0, 300), file: file ? normRel(file) : null, by, at: now, expiresAt: now + ALLOW_TTL_MS });
  fs.writeFileSync(path.join(dir, ALLOW_FILE), JSON.stringify(list), 'utf8');
  return { ok: true, expiresAt: now + ALLOW_TTL_MS };
}
const allowanceFor = (allowances, ruleId, file) => allowances.find((a) => a.rule === ruleId && (!a.file || !file || a.file === normRel(file)));
export function clearAllowances(repo) { const dir = gitCommonDir(repo); if (dir) { try { fs.unlinkSync(path.join(dir, ALLOW_FILE)); } catch { /* none */ } } }

// ── diff sources (git, diff-only) ────────────────────────────────────────────
const ZERO_SHA = /^0+$/;
function git(repo, args, { buffer = false, input, maxBuffer = 256 * 1024 * 1024 } = {}) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repo, encoding: buffer ? null : 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    maxBuffer, timeout: 30_000, windowsHide: true, ...(input !== undefined ? { input } : {}),
  });
}
const gitTry = (repo, args, opts) => { try { return git(repo, args, opts); } catch { return null; } };

/**
 * File statuses from the same `git diff -U0 -M` output the added lines come
 * from (one git process instead of two — a spawn costs 100+ ms on a busy
 * Windows machine). Reads the per-file header lines git always prints.
 */
export function parsePatchFiles(diffText) {
  const files = [];
  let cur = null;
  const done = () => { if (cur && cur.path) files.push({ status: cur.status, path: cur.path, ...(cur.status === 'R' ? { oldPath: cur.oldPath } : {}) }); cur = null; };
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      done();
      const rest = line.slice(11);
      const same = /^a\/(.+) b\/\1$/.exec(rest);
      const split = same ? null : /^a\/(.+?) b\/(.+)$/.exec(rest);
      cur = { status: 'M', oldPath: same ? same[1] : split?.[1] || '', path: same ? same[1] : split?.[2] || '' };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'A';
    else if (line.startsWith('deleted file mode')) cur.status = 'D';
    else if (line.startsWith('rename from ')) { cur.status = 'R'; cur.oldPath = line.slice(12); }
    else if (line.startsWith('rename to ')) cur.path = line.slice(10);
    else if (line.startsWith('copy to ')) { cur.status = 'A'; cur.path = line.slice(8); }
    else if (line.startsWith('+++ b/')) cur.path = line.slice(6).replace(/\t.*$/, '');
    else if (line.startsWith('--- a/') && cur.status === 'D') cur.path = line.slice(6).replace(/\t.*$/, '');
  }
  done();
  return files;
}

/** Added lines per file from `git diff -U0` output: Map(path → [{line, text}]). */
export function parseAddedLines(diffText) {
  const added = new Map();
  let file = null; let lineNo = 0;
  for (const raw of String(diffText || '').split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/\t.*$/, '');
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && !added.has(file)) added.set(file, []);
      continue;
    }
    if (raw.startsWith('@@')) { const m = /\+(\d+)(?:,(\d+))?/.exec(raw); lineNo = m ? Number(m[1]) : 0; continue; }
    if (!file || raw.startsWith('---') || raw.startsWith('diff --git') || raw.startsWith('index ')) continue;
    if (raw.startsWith('+')) { added.get(file).push({ line: lineNo, text: raw.slice(1).replace(/\r$/, '').slice(0, MAX_LINE) }); lineNo++; }
  }
  return added;
}

/**
 * A diff to check. mode:
 *   'staged'   — the index against HEAD (pre-commit);
 *   'range'    — base..head commits (pre-push, a PR, a backtest);
 *   'worktree' — the working tree (tracked + untracked) against HEAD.
 */
/**
 * Old-file line numbers whose ONLY change is the line ending: lines the plain
 * diff reports that `--ignore-cr-at-eol` does not. Catches a mixed CRLF/LF file
 * whose overall style survives while untouched lines flip. Null when git cannot say.
 */
function eolOnlyChangedLines(repo, revArgs, file) {
  const args = ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv'];
  const plain = gitTry(repo, [...args, ...revArgs, '--', file]);
  const loose = plain === null ? null : gitTry(repo, [...args, '--ignore-cr-at-eol', ...revArgs, '--', file]);
  if (plain === null || loose === null) return null;
  const removed = (text) => {
    const lines = new Set();
    for (const m of String(text).matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < count; i++) lines.add(start + i);
    }
    return lines;
  };
  const content = removed(loose);
  return [...removed(plain)].filter((n) => !content.has(n)).sort((a, b) => a - b);
}

export function gitDiffSource(repo, { mode = 'worktree', base = null, head = null } = {}) {
  if (mode === 'range' && (!base || !head)) throw new Error('range mode needs base and head');
  const patchArgs = ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/'];
  let hasHead = true;
  let patch;
  if (mode === 'range') patch = git(repo, [...patchArgs, base, head]);
  else {
    // Try against HEAD first (the common case); a repo with no commit yet has none.
    patch = gitTry(repo, [...patchArgs, ...(mode === 'staged' ? ['--cached'] : []), 'HEAD']);
    if (patch === null) { hasHead = false; patch = git(repo, [...patchArgs, ...(mode === 'staged' ? ['--cached'] : [])]); }
  }
  const files = parsePatchFiles(patch);
  const added = parseAddedLines(patch);
  if (mode === 'worktree') {
    for (const p of String(gitTry(repo, ['ls-files', '--others', '--exclude-standard', '-z']) || '').split('\0').filter(Boolean)) {
      files.push({ status: 'A', path: p });
      let text = '';
      try { const f = path.join(repo, p); if (fs.statSync(f).size <= MAX_BLOB) text = fs.readFileSync(f, 'utf8'); } catch { /* unreadable */ }
      if (!text.includes('\0')) added.set(p, text.split('\n').map((t, i) => ({ line: i + 1, text: t.replace(/\r$/, '').slice(0, MAX_LINE) })));
    }
  }
  const oldRev = mode === 'range' ? base : (hasHead ? 'HEAD' : null);
  // Committed bytes for staged/range (what CI checks out on Linux). For the
  // working tree, the OLD side goes through git's own checkout conversion
  // (`cat-file --filters`), so a core.autocrlf=true checkout is compared
  // like with like and an untouched file never reads as an EOL change.
  const cache = new Map();
  const oldFilters = mode === 'worktree';
  const specOf = (side, p) => (side === 'old' ? (oldRev === null ? null : `${oldRev}:${p}`) : mode === 'range' ? `${head}:${p}` : mode === 'staged' ? `:${p}` : null);
  const one = (spec, filters) => {
    if (spec === null) return null;
    if (cache.has(spec)) return cache.get(spec);
    const out = gitTry(repo, ['cat-file', filters ? '--filters' : 'blob', spec], { buffer: true, maxBuffer: MAX_BLOB + 1 });
    cache.set(spec, out);
    return out;
  };
  const fromDisk = (p) => { try { const f = path.join(repo, p); return fs.statSync(f).size > MAX_BLOB ? null : fs.readFileSync(f); } catch { return null; } };
  return {
    mode, files, added,
    readOld: (p) => one(specOf('old', p), oldFilters),
    readNew: (p) => (mode === 'worktree' ? fromDisk(p) : one(specOf('new', p), false)),
    eolOnlyLines: (p) => eolOnlyChangedLines(repo, mode === 'range' ? [base, head] : mode === 'staged' ? ['--cached', ...(hasHead ? ['HEAD'] : [])] : (hasHead ? ['HEAD'] : []), p),
    /** Read many blobs with ONE git process (`cat-file --batch`) before the checks ask for them. */
    prefetch: (requests) => {
      const groups = new Map();
      for (const { side, path: p } of requests) {
        if (side === 'new' && mode === 'worktree') continue;
        const spec = specOf(side, p);
        if (spec === null || cache.has(spec)) continue;
        const filters = side === 'old' && oldFilters;
        if (!groups.has(filters)) groups.set(filters, new Set());
        groups.get(filters).add(spec);
      }
      for (const [filters, specs] of groups) {
        const list = [...specs];
        const out = gitTry(repo, ['cat-file', '--batch', ...(filters ? ['--filters'] : [])], { buffer: true, input: `${list.join('\n')}\n` });
        if (!out) continue;
        let at = 0;
        for (const spec of list) {
          const nl = out.indexOf(10, at);
          if (nl < 0) break;
          const header = out.subarray(at, nl).toString('utf8');
          const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
          if (!m) { cache.set(spec, null); at = nl + 1; continue; }   // "<spec> missing"
          const size = Number(m[2]);
          cache.set(spec, m[1] === 'blob' && size <= MAX_BLOB ? Buffer.from(out.subarray(nl + 1, nl + 1 + size)) : null);
          at = nl + 1 + size + 1;
        }
      }
    },
  };
}

// ── EOL style ────────────────────────────────────────────────────────────────
export function eolStyle(buf) {
  if (!buf || !buf.length) return 'none';
  // git's own test: a NUL in the first 8000 bytes means binary. A NUL further in
  // (a raw "\0" inside a string literal) leaves the file text, as it does for git.
  if (buf.subarray(0, 8000).includes(0)) return 'binary';
  let crlf = 0; let lf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) { if (i > 0 && buf[i - 1] === 13) crlf++; else lf++; }
  }
  if (crlf && lf) return 'mixed';
  return crlf ? 'crlf' : (lf ? 'lf' : 'none');
}

// ── the checks ───────────────────────────────────────────────────────────────
function expandTemplate(template, vars) {
  return String(template).replace(/\{(path|file|basename|name|relpath|line|needle|registry|match|1)\}/g, (_, k) => String(vars[k === 'path' ? 'file' : k] ?? ''));
}
function fileVars(rule, file) {
  const p = normRel(file);
  const basename = path.posix.basename(p);
  return {
    file: p, basename,
    name: basename.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, ''),
    relpath: rule.base && p.startsWith(`${rule.base}/`) ? p.slice(rule.base.length + 1) : p,
  };
}

function checkListedIn(rule, diff, cache) {
  const registryText = (reg) => {
    if (!cache.has(reg)) { const buf = diff.readNew(reg); cache.set(reg, buf ? buf.toString('utf8') : null); }
    return cache.get(reg);
  };
  const candidates = [];
  if (rule.when === 'added-files') {
    for (const f of diff.files) {
      if ((f.status === 'A' || (f.status === 'R' && f.oldPath !== f.path)) && inScope(rule, f.path)) {
        const vars = fileVars(rule, f.path);
        candidates.push({ vars: { ...vars, line: '' }, needle: expandTemplate(rule.needle, vars) });
      }
    }
  } else {
    const re = compile(rule);
    for (const [file, lines] of diff.added) {
      if (!inScope(rule, file)) continue;
      for (const { line, text } of lines) {
        const m = re.exec(text);
        if (!m) continue;
        const vars = { ...fileVars(rule, file), line, match: m[0], 1: m[1] ?? m[0] };
        candidates.push({ vars, needle: expandTemplate(rule.needle, vars) });
      }
    }
  }
  const findings = [];
  for (const c of candidates) {
    const results = rule.registry.map((reg) => { const t = registryText(reg); return { reg, present: t !== null && t.includes(c.needle), missing: t === null }; });
    const ok = rule.registryMode === 'any' ? results.some((r) => r.present) : results.every((r) => r.present);
    if (ok) continue;
    const lacking = results.filter((r) => !r.present);
    const registry = lacking.map((r) => r.reg).join(', ');
    const vars = { ...c.vars, needle: c.needle, registry };
    findings.push({
      file: c.vars.file, line: c.vars.line || null,
      found: `${c.vars.line ? `adds \`${String(c.vars.match || c.needle).slice(0, 120)}\`` : 'is a new file'}, but \`${c.needle}\` is not in ${lacking.map((r) => (r.missing ? `${r.reg} (that file is missing)` : r.reg)).join(', ')}`,
      fix: expandTemplate(rule.fix, vars),
    });
  }
  return findings;
}

function checkForbid(rule, diff) {
  const re = compile(rule);
  const findings = [];
  for (const [file, lines] of diff.added) {
    if (!inScope(rule, file)) continue;
    for (const { line, text } of lines) {
      const m = re.exec(text);
      if (m) findings.push({ file, line, found: `adds \`${text.trim().slice(0, 140)}\``, fix: expandTemplate(rule.fix, { ...fileVars(rule, file), line, match: m[0], 1: m[1] ?? m[0] }) });
    }
  }
  return findings;
}

function checkEol(rule, diff) {
  const findings = [];
  for (const f of diff.files) {
    if (f.status !== 'M' || !inScope(rule, f.path)) continue;
    const before = eolStyle(diff.readOld(f.path));
    if (before === 'none' || before === 'binary') continue;
    const after = eolStyle(diff.readNew(f.path));
    if (after === 'binary' || after === 'none') continue;
    if (after !== before) {
      findings.push({ file: f.path, line: null, found: `changes its line endings from ${before} to ${after}`, fix: expandTemplate(rule.fix, fileVars(rule, f.path)) });
      continue;
    }
    // The overall style survived, but lines the change does not otherwise touch
    // had their endings flipped (an editor or script normalised part of a mixed file).
    const flipped = typeof diff.eolOnlyLines === 'function' ? diff.eolOnlyLines(f.path) : null;
    if (flipped?.length) findings.push({ file: f.path, line: null, found: `changes the line ending of ${flipped.length} line${flipped.length === 1 ? '' : 's'} it does not otherwise change (line${flipped.length === 1 ? '' : 's'} ${flipped.slice(0, 5).join(', ')}${flipped.length > 5 ? ', …' : ''} of the committed file)`, fix: expandTemplate(rule.fix, fileVars(rule, f.path)) });
  }
  return findings;
}

function checkCloud(rule, diff) {
  return diff.files.filter((f) => inScope(rule, f.path) || (f.oldPath && inScope(rule, f.oldPath)))
    .map((f) => ({ file: f.path, line: null, found: 'touches a path that needs the full cloud CI', fix: expandTemplate(rule.fix, fileVars(rule, f.path)) }));
}

/** Run rules against one diff. Never throws: a broken rule reports itself. */
export function runRules(rules, diff, { allowances = [] } = {}) {
  const cache = new Map();
  if (typeof diff.prefetch === 'function') {
    const requests = [];
    for (const rule of rules) {
      if (rule.kind === 'preserve-eol') {
        for (const f of diff.files) if (f.status === 'M' && inScope(rule, f.path)) requests.push({ side: 'old', path: f.path }, { side: 'new', path: f.path });
      } else if (rule.kind === 'listed-in' && diff.files.some((f) => inScope(rule, f.path))) {
        for (const reg of rule.registry) requests.push({ side: 'new', path: reg });
      }
    }
    if (requests.length) { try { diff.prefetch(requests); } catch { /* the lazy reads still work */ } }
  }
  return rules.map((rule) => {
    let findings;
    try {
      findings = rule.kind === 'listed-in' ? checkListedIn(rule, diff, cache)
        : rule.kind === 'forbid-pattern' ? checkForbid(rule, diff)
          : rule.kind === 'preserve-eol' ? checkEol(rule, diff)
            : checkCloud(rule, diff);
    } catch (error) {
      return { rule, status: 'error', findings: [{ file: '', line: null, found: `the rule could not run: ${error.message}`, fix: `fix the rule in ${RULES_FILE}` }], allowed: [] };
    }
    const allowed = [];
    const remaining = [];
    for (const f of findings) { const a = allowanceFor(allowances, rule.id, f.file); (a ? allowed : remaining).push(a ? { ...f, allowance: a } : f); }
    const status = !remaining.length ? 'pass' : rule.severity === 'advise' ? 'advise' : rule.severity === 'warn' ? 'warn' : 'fail';
    return { rule, status, findings: remaining, allowed };
  });
}

/** A finding as an agent should read it: what, where, why, how to fix, where it came from. */
export function formatFinding(rule, f, { verdict } = {}) {
  const head = verdict || (rule.severity === 'block' ? '✗ BLOCKED' : rule.severity === 'warn' ? '⚠ WARNING' : 'ℹ NOTE');
  return [
    `${head} — project rule \`${rule.id}\` (lesson ${rule.source.card})`,
    `  Found: ${f.file}${f.line ? `:${f.line}` : ''} ${f.found}`,
    `  Why:   ${rule.why}`,
    `  Fix:   ${f.fix || rule.fix}`,
  ].join('\n');
}

export function summarizeResults(results, { strict = false } = {}) {
  const isBlock = (r) => r.status === 'fail' || (strict && r.status === 'warn');
  const blocking = results.filter(isBlock);
  const warnings = results.filter((r) => r.status === 'warn' && !strict);
  const advisories = results.filter((r) => r.status === 'advise');
  const errors = results.filter((r) => r.status === 'error');
  const render = (r) => [
    ...r.findings.slice(0, 10).map((f) => formatFinding(r.rule, f, { verdict: isBlock(r) ? '✗ BLOCKED' : undefined })),
    ...(r.findings.length > 10 ? [`  …and ${r.findings.length - 10} more for rule ${r.rule.id}`] : []),
  ].join('\n');
  const text = [...blocking, ...warnings, ...advisories, ...errors].map(render).join('\n\n');
  return { ok: blocking.length === 0, blocking: blocking.length, warnings: warnings.length, advisories: advisories.length, errors: errors.length, text };
}

// ── plan time: brain_sync ────────────────────────────────────────────────────
/** Rules the session's declared/observed files fall under. Cheap: glob work + one bounded read for EOL. */
export function rulesForFiles(projectRoot, files, { limit = 6, rules: given = null } = {}) {
  const doc = given ? { ok: true, rules: given } : loadRulesDoc(projectRoot);
  const rules = given || activeRules(doc);
  if (!rules.length) return { rules: [], problems: doc.ok ? [] : doc.errors };
  const root = String(projectRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  const rel = (f) => {
    const s = String(f || '').replace(/\\/g, '/');
    return s.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? s.slice(root.length + 1) : normRel(s);
  };
  const declared = [...new Set((files || []).map(rel).filter(Boolean))];
  const out = [];
  for (const rule of rules) {
    const hit = declared.filter((f) => inScope(rule, f));
    if (!hit.length) continue;
    let note = '';
    if (rule.kind === 'preserve-eol') {
      const mixed = hit.filter((f) => { try { const p = path.join(projectRoot, f); return fs.statSync(p).size <= MAX_BLOB && eolStyle(fs.readFileSync(p)) === 'mixed'; } catch { return false; } });
      if (!mixed.length) continue;
      note = ` (mixed CRLF/LF today: ${mixed.slice(0, 3).join(', ')})`;
    }
    // Before any edit there is no finding to fill the fix template from: name the
    // file and registry, and say "the new entry" for the value the edit will add.
    const vars = { ...fileVars(rule, hit[0]), registry: (rule.registry || []).join(', '), line: '', match: 'the new entry', 1: 'the new entry' };
    vars.needle = rule.kind === 'listed-in' && rule.when === 'added-files' ? expandTemplate(rule.needle || '{basename}', vars) : 'the new entry';
    out.push({ id: rule.id, kind: rule.kind, severity: rule.severity, why: rule.why + note, fix: expandTemplate(rule.fix, vars), card: rule.source.card, files: hit.slice(0, 5) });
    if (out.length >= limit) break;
  }
  return { rules: out, problems: doc.ok ? [] : doc.errors };
}

export function formatRulesNotice(matched) {
  if (!matched?.length) return '';
  return [
    'KLYPIX project rules for the files in your scope (from this brain\'s lessons; checked again on each edit and before commit):',
    ...matched.map((r) => `- ${r.severity === 'block' ? '⛔' : r.severity === 'warn' ? '⚠' : 'ℹ'} ${r.files.join(', ')}: ${r.why} Fix: ${r.fix} (rule ${r.id}, lesson ${r.card})`),
  ].join('\n');
}

// ── edit time: a proposed edit (Claude Code Edit/Write/MultiEdit, Codex apply_patch) ──
const splitLines = (s) => String(s ?? '').replace(/\r\n/g, '\n').split('\n');
function linesNotIn(newText, oldText) {
  const bag = new Map();
  for (const l of splitLines(oldText)) bag.set(l, (bag.get(l) || 0) + 1);
  const out = [];
  splitLines(newText).forEach((l, i) => { const n = bag.get(l) || 0; if (n) bag.set(l, n - 1); else out.push({ idx: i, text: l.slice(0, MAX_LINE) }); });
  return out;
}
const lineOf = (content, index) => (index < 0 ? 1 : String(content).slice(0, index).split('\n').length);

/**
 * The added lines and added files a proposed edit would create, without
 * writing anything: { files: [{status, path}], added: Map(path → [{line, text}]) }.
 */
export function proposedEditDiff(projectRoot, toolName, toolInput) {
  const files = []; const added = new Map();
  const read = (rel) => { try { return fs.readFileSync(path.join(projectRoot, rel), 'utf8'); } catch { return null; } };
  const relOf = (p) => {
    if (typeof p !== 'string' || !p) return null;
    const abs = path.resolve(projectRoot, p);
    const r = path.relative(projectRoot, abs).replace(/\\/g, '/');
    return !r || r.startsWith('../') || path.isAbsolute(r) ? null : r;
  };
  const push = (rel, status, lines) => { files.push({ status, path: rel }); added.set(rel, [...(added.get(rel) || []), ...lines]); };
  const ti = isPlainObject(toolInput) ? toolInput : {};
  const tool = String(toolName || '');
  if (/^(Write|Edit|MultiEdit)$/.test(tool)) {
    const rel = relOf(ti.file_path || ti.path);
    if (!rel) return { files, added };
    const current = read(rel);
    if (tool === 'Write') {
      const content = String(ti.content ?? '');
      const lines = current === null ? splitLines(content).map((t, i) => ({ idx: i, text: t })) : linesNotIn(content, current);
      push(rel, current === null ? 'A' : 'M', lines.map((l) => ({ line: l.idx + 1, text: l.text })));
    } else {
      const edits = tool === 'MultiEdit' ? (Array.isArray(ti.edits) ? ti.edits : []) : [ti];
      const lines = [];
      for (const e of edits) {
        const oldS = String(e?.old_string ?? ''); const newS = String(e?.new_string ?? '');
        const at = current === null ? -1 : current.indexOf(oldS);
        const start = current === null ? 1 : lineOf(current, at);
        for (const l of linesNotIn(newS, oldS)) lines.push({ line: start + l.idx, text: l.text });
      }
      push(rel, current === null ? 'A' : 'M', lines);
    }
    return { files, added };
  }
  // Codex apply_patch: '+' lines inside Add File / Update File sections.
  const patch = [ti.command, ti.patch, ti.input, ti.content, typeof toolInput === 'string' ? toolInput : null].flat()
    .find((v) => typeof v === 'string' && v.includes('*** '));
  if (!patch) return { files, added };
  let cur = null; let mode = null; let n = 0;
  for (const raw of String(patch).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const header = /^\s*\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      cur = relOf(header[2]); mode = header[1]; n = 0;
      if (cur && mode !== 'Delete') { files.push({ status: mode === 'Add' ? 'A' : 'M', path: cur }); if (!added.has(cur)) added.set(cur, []); }
      continue;
    }
    if (!cur || mode === 'Delete' || /^\s*\*\*\* (End Patch|Begin Patch|Move to:)/.test(line)) continue;
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) added.get(cur).push({ line: mode === 'Add' ? ++n : null, text: line.slice(1).slice(0, MAX_LINE) });
  }
  return { files, added };
}

/**
 * Evaluate a proposed edit. Returns { deny: findings[], context: findings[] }:
 * a forbidden line in a block rule is denied now (it is wrong as written);
 * a missing registry entry is context (the next edit may add it — the commit
 * hook enforces it); EOL is checked after the edit (evaluateEditResult).
 */
export function evaluateProposedEdit(projectRoot, toolName, toolInput) {
  const rules = activeRules(loadRulesDoc(projectRoot)).filter((r) => r.kind !== 'preserve-eol');
  if (!rules.length) return { deny: [], context: [], rules: 0 };
  const proposed = proposedEditDiff(projectRoot, toolName, toolInput);
  if (!proposed.files.length) return { deny: [], context: [], rules: rules.length };
  const relevant = rules.filter((r) => proposed.files.some((f) => inScope(r, f.path)));
  if (!relevant.length) return { deny: [], context: [], rules: rules.length };
  const diff = {
    files: proposed.files, added: proposed.added,
    readOld: () => null,
    readNew: (rel) => { try { return fs.readFileSync(path.join(projectRoot, rel)); } catch { return null; } },
  };
  const allowances = readAllowances(projectRoot);
  const results = runRules(relevant, diff, { allowances });
  const deny = []; const context = [];
  for (const r of results) {
    for (const f of r.findings) {
      const item = { rule: r.rule, finding: f };
      if (r.rule.kind === 'forbid-pattern' && r.rule.severity === 'block') deny.push(item);
      else if (r.status !== 'pass') context.push(item);
    }
  }
  return { deny, context, rules: rules.length };
}

/** After an edit landed: did it change a protected file's line-ending style? */
export function evaluateEditResult(projectRoot, filePath) {
  const rules = activeRules(loadRulesDoc(projectRoot)).filter((r) => r.kind === 'preserve-eol');
  if (!rules.length || !filePath) return [];
  const rel = path.relative(projectRoot, path.resolve(projectRoot, filePath)).replace(/\\/g, '/');
  if (!rel || rel.startsWith('../')) return [];
  const hit = rules.filter((r) => inScope(r, rel));
  if (!hit.length) return [];
  const diff = {
    files: [{ status: 'M', path: rel }], added: new Map(),
    // The working-tree form of HEAD's copy (checkout filters + EOL conversion), compared with the file on disk.
    readOld: (p) => { const s = Number(String(gitTry(projectRoot, ['cat-file', '-s', `HEAD:${p}`]) || '').trim()); return Number.isFinite(s) && s > 0 && s <= MAX_BLOB ? gitTry(projectRoot, ['cat-file', '--filters', `HEAD:${p}`], { buffer: true }) : null; },
    readNew: (p) => { try { return fs.readFileSync(path.join(projectRoot, p)); } catch { return null; } },
    eolOnlyLines: (p) => eolOnlyChangedLines(projectRoot, ['HEAD'], p),
  };
  return runRules(hit, diff, { allowances: readAllowances(projectRoot) }).flatMap((r) => r.findings.map((f) => ({ rule: r.rule, finding: f })));
}

export function formatEditMessage(items, { blocking }) {
  const body = items.slice(0, 6).map(({ rule, finding }) => formatFinding(rule, finding, { verdict: blocking ? '✗ BLOCKED' : undefined })).join('\n\n');
  const tail = blocking
    ? `\n\nRewrite the change so it follows the rule. If the person decides this is a real exception, they allow it for one hour from their own terminal: npx klypix-mcp rules allow ${items[0].rule.id} --reason "<why>" (recorded in the brain). If the rule itself is wrong: npx klypix-mcp rules false-alarm ${items[0].rule.id} --reason "<why>".`
    : '';
  return `${body}${tail}`;
}

// ── hook entry points (Claude Code, Codex) ───────────────────────────────────
const seenFile = (projectRoot, home = os.homedir()) => path.join(ledgerDir(home), `${projectKey(projectRoot)}.seen.json`);
/** Once per session per finding, for warnings (a deny is never deduplicated). */
function firstTimeForSession(projectRoot, sessionId, keys, { home = os.homedir(), now = Date.now() } = {}) {
  if (!sessionId) return keys;
  const file = seenFile(projectRoot, home);
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { seen = {}; }
  const mine = isPlainObject(seen[sessionId]) ? seen[sessionId] : {};
  const fresh = keys.filter((k) => !mine[k]);
  if (!fresh.length) return [];
  for (const k of fresh) mine[k] = now;
  const pruned = {};
  for (const [sid, v] of Object.entries({ ...seen, [sessionId]: mine })) {
    if (Math.max(0, ...Object.values(isPlainObject(v) ? v : {})) > now - 86_400_000) pruned[sid] = v;
  }
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(pruned)); } catch { /* best-effort */ }
  return fresh;
}
const findingKey = ({ rule, finding }) => `${rule.id}|${finding.file}|${finding.found}`;

/**
 * Before an edit runs. Returns { deny: text } (a block-severity forbidden line),
 * { context: text } (everything else, once per session), or null. Records the
 * fires and blocks in the ledger. Never throws.
 */
export function preToolUseDecision(projectRoot, toolName, toolInput, { sessionId = '', host = 'claude-code' } = {}) {
  try {
    const r = evaluateProposedEdit(projectRoot, toolName, toolInput);
    if (!r.deny.length && !r.context.length) return null;
    appendEvents(projectRoot, [
      ...r.deny.map(({ rule, finding }) => ({ rule: rule.id, event: 'block', layer: 'edit', host, file: finding.file, line: finding.line || null })),
      ...r.context.map(({ rule, finding }) => ({ rule: rule.id, event: 'fire', layer: 'edit', host, file: finding.file, line: finding.line || null })),
    ]);
    if (r.deny.length) return { deny: formatEditMessage(r.deny, { blocking: true }) };
    const fresh = new Set(firstTimeForSession(projectRoot, sessionId, r.context.map(findingKey)));
    const show = r.context.filter((item) => fresh.has(findingKey(item)));
    if (!show.length) return null;
    return { context: `${formatEditMessage(show, { blocking: false })}\nThe pre-commit check enforces ${show.some((i) => i.rule.severity === 'block') ? 'the block rules among these' : 'nothing here (warnings only)'} — fix it in this change.` };
  } catch { return null; }
}

/** After an edit landed: a protected file's line endings changed. Returns { block: text } | { context: text } | null. */
export function postToolUseDecision(projectRoot, toolName, toolInput, { sessionId = '', host = 'claude-code' } = {}) {
  try {
    if (!/^(Edit|Write|MultiEdit)$/.test(String(toolName || ''))) return null;
    const ti = isPlainObject(toolInput) ? toolInput : {};
    const items = evaluateEditResult(projectRoot, ti.file_path || ti.path);
    if (!items.length) return null;
    const blocking = items.filter((i) => i.rule.severity === 'block');
    appendEvents(projectRoot, items.map(({ rule, finding }) => ({ rule: rule.id, event: rule.severity === 'block' ? 'block' : 'fire', layer: 'edit-result', host, file: finding.file })));
    const text = `${formatEditMessage(items, { blocking: Boolean(blocking.length) })}\nThe edit already happened — restore the line endings before you continue.`;
    if (blocking.length) return { block: text };
    return firstTimeForSession(projectRoot, sessionId, items.map(findingKey)).length ? { context: text } : null;
  } catch { return null; }
}

// ── lessons → rules, instructions, notes (proposals) ─────────────────────────
const LESSON_RE = /🛠️|\b(must|never|always|don't|do not|gotcha|or (?:CI|the build|it) (?:fails|never)|404s?|silently|caught (?:that|it)|forgot|not wired|enumerated|breaks?|rule)\b/i;
const IMPERATIVE_RE = /\b(must|never|always|don't|do not|make sure|keep|avoid|only)\b/i;
const CODE_RE = /`([^`\n]{2,100})`/g;
// A bare file name in prose ("frontend-fallback.ts must list it"): a word with a source extension.
const SOURCE_EXT = '(?:[cm]?[jt]sx?|json5?|ya?ml|md|mdx|css|scss|less|html?|py|rs|go|java|kts?|swift|sh|ps1|bat|toml|lock|sql|xml|gradle|cs|cpp|cc|c|h|hpp|rb|php|vue|svelte|klypix|plist|txt|ini|cfg|conf|proto|graphql|prisma)';
const BARE_PATH_RE = new RegExp(`(?:^|[\\s(,'"])((?:[\\w@.*{}-]+/)*[\\w@*{}-][\\w@.*{}-]*\\.${SOURCE_EXT})(?=[\\s),.;:'"]|$)`, 'g');
const SOURCE_EXT_RE = new RegExp(`\\.${SOURCE_EXT}$`, 'i');
const BRANCHISH_RE = /^(?:feat|fix|chore|hotfix|wip|refs|origin|heads|remotes)\//i;
// Without a repository to ask, a token is a path only by its shape: a source
// extension, or slash-separated segments — never a URL, a branch, an npm scope,
// a dotted identifier (`secrets.NPM_TOKEN`) or a domain (`gmail.com`).
const PATH_SHAPED = (t) => !/\s/.test(t) && !/^[a-z]+:\/\//i.test(t) && !t.startsWith('@') && !BRANCHISH_RE.test(t)
  && (SOURCE_EXT_RE.test(t) || /^\.?[\w.-]+(?:\/[\w.*{},-]+)+\/?$/.test(t));
// A lesson states a constraint; history ("shipped", "merged") does not. A rule
// draft needs one of these words in the sentence that names the kind (or a 🛠️
// skill card), so a long release note that mentions a lockfile stays a note.
const CONSTRAINT_RE = /\b(must|never|always|only|do not|don't|cannot|can't|needs? to|has to|have to|requires?|required|otherwise|gotcha)\b|\bor (?:CI|it|the build|a direct link)\b/i;
// Sentence boundaries in a whitespace-normalised card: end punctuation, or a spaced dash.
const SENTENCE_END_RE = /[.!?](?=\s+[A-Z0-9`"'(#~\u2600-\u27BF\uD83C-\uDBFF])|\s[—–]\s/g;
function sentenceWindow(text, at) {
  const ends = [...text.matchAll(SENTENCE_END_RE)].map((m) => m.index + m[0].length);
  const starts = [0, ...ends];
  let i = 0;
  while (i + 1 < starts.length && starts[i + 1] <= at) i++;
  // The sentence that names the kind, and the one after it ("…runner-impacting. Touching `artifacts/runtime`…").
  return { from: starts[i], to: i + 2 < starts.length ? starts[i + 2] : text.length };
}
const ROUTES = [
  { kind: 'listed-in', re: /must (?:also )?be (?:added|listed|registered|wired|enumerated)|(?:added|listed|registered|enumerated) (?:to|in) `[^`]+`|not (?:wired|listed|enumerated) (?:into|in)|enumerated in|copy lists?|or (?:CI|it) never runs/i },
  { kind: 'preserve-eol', re: /CRLF|line.endings?|\bEOL\b|mixed (?:CRLF|line)/i },
  { kind: 'forbid-pattern', re: /never (?:use|set|import|call|write|add)\b|must not (?:use|import|call|set)|do not (?:use|import|set)|import (?:it |them )?relatively|has no `?@\/`? alias|is (?:banned|forbidden)/i },
  { kind: 'cloud-required', re: /runner-impacting|lockfile|pnpm-workspace|\.github\/workflows|supply.chain|full (?:cloud )?CI|full desktop matrix/i },
];

/**
 * What a lesson's file token names in this repository: a tracked file, a
 * tracked folder (as `dir/**`), a glob that matches something,
 * a bare file name with at most three matches, or a path relative to a
 * sub-package. Empty when it names nothing that exists. One git call.
 */
export function repoPathResolver(root, { ref = null } = {}) {
  // Tracked files only: untracked scratch trees (nested worktrees, .tmp copies) would
  // resolve a bare name to a copy that is not the project's file. `ref` reads a
  // commit's tree instead of the index (a backtest against the default branch).
  const out = gitTry(root, ref ? ['ls-tree', '-r', '-z', '--name-only', ref] : ['ls-files', '-z']);
  if (out === null) return null;
  const files = [...new Set(String(out).split('\0').filter(Boolean))];
  const fileSet = new Set(files);
  const dirSet = new Set();
  const byBase = new Map();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join('/'));
    const base = parts[parts.length - 1];
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(f);
  }
  const memo = new Map();
  return (token) => {
    const t = String(token || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/[)\]},;:]+$/, '').replace(/\/+$/, '');
    if (memo.has(t)) return memo.get(t);
    let hit = [];
    if (t && !/\s/.test(t) && !/^[a-z]+:\/\//i.test(t) && t.replace(/[*?{},/.]/g, '').length >= 3) {
      if (fileSet.has(t)) hit = [t];
      else if (dirSet.has(t)) hit = [`${t}/**`];
      else if (/[*?{]/.test(t)) { const re = globToRegExp(t); if (files.some((f) => re.test(f))) hit = [t]; }
      else if (!t.includes('/')) { const b = byBase.get(t) || []; if (b.length && b.length <= 3) hit = b; }
      else {
        const f = files.filter((x) => x.endsWith(`/${t}`));
        if (f.length && f.length <= 3) hit = f;
        else { const d = [...dirSet].filter((x) => x.endsWith(`/${t}`)); if (d.length && d.length <= 3) hit = d.map((x) => `${x}/**`); }
      }
    }
    memo.set(t, hit);
    return hit;
  };
}

/**
 * Route each lesson in the brain: a mechanically checkable one → a draft rule
 * (the agent completes it, the human approves it); an imperative that a diff
 * cannot check → an instruction (it already resurfaces as a standing rule);
 * anything else → a note. A rule route needs a path that exists in the
 * repository (`pathResolver`, from repoPathResolver) — or, with no repository
 * to ask, a token shaped like a source path — and, for forbid-pattern, a
 * quoted code fragment next to the prohibition. Heuristic, transparent, and
 * never stored by itself.
 */
export function proposeFromCards(cards, { limit = 30, query = '', existing = [], pathResolver = null } = {}) {
  const q = String(query || '').toLowerCase();
  const usedCards = new Set(existing.map((r) => r.source?.card));
  const resolvePath = (t) => (pathResolver ? pathResolver(t) : (PATH_SHAPED(t) ? [t] : []));
  const uniq = (xs) => [...new Set(xs)];
  const seen = new Set();
  const out = [];
  const counts = { rule: 0, instruction: 0, note: 0 };
  for (const card of cards || []) {
    const id = String(card?.id || '');
    if (!id || id.includes('__agconf_') || card.area === 'Archive' || card.area === RULES_AREA) continue;
    const text = String(card.text || '').replace(/\s+/g, ' ').trim();
    // Open questions are not lessons; superseded and resolved cards are history.
    if (!text || /^↩︎ superseded|^✓|resolved/i.test(text.slice(0, 40)) || /❓/.test(text.slice(0, 60)) || !LESSON_RE.test(text)) continue;
    if (q && !text.toLowerCase().includes(q)) continue;
    const key = text.slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    const codes = [...text.matchAll(CODE_RE)].map((m) => ({ t: m[1].trim(), at: m.index }));
    const bare = [...text.matchAll(BARE_PATH_RE)].map((m) => ({ t: m[1], at: m.index + m[0].indexOf(m[1]) }))
      .filter((b) => !codes.some((c) => b.at > c.at && b.at < c.at + c.t.length + 2));
    const paths = [...codes, ...bare].map((x) => ({ ...x, paths: resolvePath(x.t) })).filter((x) => x.paths.length).sort((a, b) => a.at - b.at);
    const fragments = codes.filter((c) => !paths.some((p) => p.at === c.at));
    const kindHit = ROUTES.find((r) => r.re.test(text));
    const phraseAt = kindHit ? text.search(kindHit.re) : -1;
    // Only what the lesson's own sentence names counts, not every path a long card mentions.
    const win = kindHit ? sentenceWindow(text, phraseAt) : { from: 0, to: 0 };
    const inWin = (x) => x.at >= win.from && x.at < win.to;
    const lessonShaped = /🛠️/.test(text) || CONSTRAINT_RE.test(text.slice(win.from, win.to));
    let route; let reason; let draft = null;
    if (usedCards.has(id)) {
      route = 'rule (already in rules.json)';
      reason = 'a rule in .klypix/rules.json already cites this lesson';
    } else if (kindHit && lessonShaped) {
      const near = paths.filter(inWin);
      const nearFragments = fragments.filter(inWin);
      // The value a forbid-pattern draft forbids: the code fragment right after the prohibition, else just before it.
      const pattern = kindHit.kind === 'forbid-pattern'
        ? (nearFragments.find((c) => c.at >= phraseAt && c.at - phraseAt <= 150) || [...nearFragments].reverse().find((c) => c.at < phraseAt && phraseAt - c.at <= 60))?.t
        : null;
      const filePaths = uniq(near.flatMap((p) => p.paths));
      // listed-in: paths named after "must be added to / listed in" are the registry; the ones before it trigger the rule.
      const registry = kindHit.kind === 'listed-in' ? uniq(near.filter((p) => p.at > phraseAt).flatMap((p) => p.paths)).filter((p) => !p.endsWith('/**')) : [];
      const triggers = kindHit.kind === 'listed-in' ? uniq(near.filter((p) => p.at <= phraseAt).flatMap((p) => p.paths)) : filePaths;
      const exact = filePaths.filter((f) => !f.includes('*'));
      const checkable = kindHit.kind === 'forbid-pattern' ? Boolean(pattern) : kindHit.kind === 'preserve-eol' ? exact.length > 0 : filePaths.length > 0;
      if (checkable) {
        route = 'rule';
        reason = kindHit.kind === 'forbid-pattern'
          ? `forbid-pattern: the lesson forbids \`${pattern}\`${filePaths.length ? ` in ${filePaths.slice(0, 3).join(', ')}` : ''} — a diff can check it`
          : `${kindHit.kind}: the lesson names ${filePaths.slice(0, 3).join(', ')}${pathResolver ? ' (in this repository)' : ''} — a diff can check it`;
        draft = {
          id: `${kindHit.kind.split('-')[0]}-${id.replace(/^txt_/, '').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`,
          kind: kindHit.kind,
          severity: kindHit.kind === 'cloud-required' ? 'advise' : 'warn',
          why: '<the lesson in one line>',
          fix: '<how to fix a finding, in one line>',
          source: { card: id },
          files: kindHit.kind === 'preserve-eol' ? exact.slice(0, 3) : (triggers.length ? triggers.slice(0, 3) : ['<glob>']),
          ...(kindHit.kind === 'listed-in' ? { when: 'added-files', registry: registry.length ? registry.slice(0, 4) : ['<the file that must list it>'], needle: '{basename}' } : {}),
          ...(kindHit.kind === 'forbid-pattern' ? { pattern: pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } : {}),
        };
      } else {
        route = IMPERATIVE_RE.test(text) ? 'instruction' : 'note';
        reason = `${kindHit.kind}-shaped, but its sentence names ${kindHit.kind === 'forbid-pattern' ? 'no code to forbid' : `no path that exists${pathResolver ? ' in this repository' : ''}`} — a diff cannot test it as written`;
      }
    } else if (kindHit) {
      route = 'note';
      reason = `${kindHit.kind}-shaped words in a record of what happened, not a constraint — stays a note`;
    } else if (IMPERATIVE_RE.test(text)) {
      route = 'instruction';
      reason = 'a standing instruction, not something a diff can test (it already resurfaces in session briefs)';
    } else {
      route = 'note';
      reason = 'judgement or history — stays a note';
    }
    counts[route.startsWith('rule') ? 'rule' : route]++;
    out.push({ card: id, area: card.area || null, excerpt: text.slice(0, 320), route, reason, codeTokens: codes.map((c) => c.t).slice(0, 8), draft });
    if (out.length >= limit) break;
  }
  return { proposals: out, counts };
}

// ── git hooks (opt-in, explicit) ─────────────────────────────────────────────
const RULE_HOOKS = ['pre-commit', 'pre-push', 'post-commit'];
const HOOK_START = '# >>> klypix-brain rules >>>';
const HOOK_END = '# <<< klypix-brain rules <<<';
const EPHEMERAL_RE = /[\\/](_npx|_cacache|npm-cache[\\/]_)/i;
const shq = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;

export function resolveRulesScript(home = os.homedir()) {
  const deployed = path.join(home, '.claude', 'project-brain', 'brain-rules.mjs');
  if (fs.existsSync(deployed)) return deployed;
  const self = fileURLToPath(import.meta.url);
  return fs.existsSync(self) && !EPHEMERAL_RE.test(self) ? self : null;
}

function hookBlock(script, name) {
  // A missing engine or node never blocks; a failed rule does (pre-commit /
  // pre-push). post-commit only records, so it never fails.
  const run = `node ${shq(script)} --hook ${name} "$@"`;
  return [
    `${HOOK_START} (managed by klypix-mcp — remove: npx klypix-mcp check --remove-hook)`,
    name === 'post-commit'
      ? `if [ -f ${shq(script)} ] && command -v node >/dev/null 2>&1; then ${run} || true; fi`
      : `if [ -f ${shq(script)} ] && command -v node >/dev/null 2>&1; then ${run} || exit 1; fi`,
    HOOK_END,
  ].join('\n');
}

export function rulesHookStatus(repo, { home = os.homedir() } = {}) {
  const common = gitCommonDir(repo);
  if (!common) return { state: 'no-git', hooks: {} };
  if (String(gitTry(repo, ['config', 'core.hooksPath']) || '').trim()) return { state: 'custom-hookspath', hooks: {} };
  const hooksDir = path.join(common, 'hooks');
  const script = resolveRulesScript(home);
  if (!script) return { state: 'no-engine', hooksDir, hooks: {} };
  const hooks = {};
  for (const name of RULE_HOOKS) {
    let raw = null;
    try { raw = fs.readFileSync(path.join(hooksDir, name), 'utf8'); } catch { hooks[name] = 'absent'; continue; }
    if (raw.includes(HOOK_START)) hooks[name] = raw.includes(hookBlock(script, name)) ? 'ours' : 'ours-stale';
    else { const first = raw.split('\n', 1)[0] || ''; hooks[name] = !first.startsWith('#!') || /\b(sh|bash|dash|zsh)\b/.test(first) ? 'foreign-sh' : 'foreign'; }
  }
  const states = Object.values(hooks);
  const state = states.every((s) => s === 'ours') ? 'installed' : states.every((s) => s === 'absent') ? 'absent' : 'partial';
  return { state, hooksDir, script, hooks };
}

export function installRulesHooks(repo, { home = os.homedir() } = {}) {
  const status = rulesHookStatus(repo, { home });
  if (!status.hooksDir || status.state === 'no-engine') return { ok: false, reason: status.state, changed: [], skipped: [] };
  fs.mkdirSync(status.hooksDir, { recursive: true });
  const changed = []; const skipped = [];
  for (const name of RULE_HOOKS) {
    const file = path.join(status.hooksDir, name);
    const block = hookBlock(status.script, name);
    const state = status.hooks[name];
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
    let next = null;
    if (state === 'absent') next = `#!/bin/sh\n${block}\n`;
    else if (state === 'ours-stale') next = raw.replace(new RegExp(`${HOOK_START}[\\s\\S]*?${HOOK_END}`), block);
    else if (state === 'foreign-sh') next = `${raw.replace(/\n*$/, '\n')}${block}\n`;
    else if (state === 'foreign') { skipped.push(name); continue; }
    if (next === null) continue;
    fs.writeFileSync(file, next.replace(/\r\n/g, '\n'), 'utf8');     // sh rejects CRLF shebangs
    try { fs.chmodSync(file, 0o755); } catch { /* Windows */ }
    changed.push(name);
  }
  return { ok: true, changed, skipped, hooksDir: status.hooksDir };
}

export function removeRulesHooks(repo, { home = os.homedir() } = {}) {
  const status = rulesHookStatus(repo, { home });
  if (!status.hooksDir) return { ok: false, reason: status.state, changed: [] };
  const changed = [];
  for (const name of RULE_HOOKS) {
    const file = path.join(status.hooksDir, name);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!raw.includes(HOOK_START)) continue;
    const stripped = raw.replace(new RegExp(`\\n?${HOOK_START}[\\s\\S]*?${HOOK_END}\\n?`), '\n');
    if (stripped.replace(/^#!\/bin\/sh\n?/, '').trim()) fs.writeFileSync(file, stripped, 'utf8');
    else fs.unlinkSync(file);
    changed.push(name);
  }
  return { ok: true, changed };
}

// ── commit-time checks (the hooks and `klypix-mcp check`) ────────────────────
function repoTop(cwd) {
  const top = gitTry(cwd, ['rev-parse', '--show-toplevel']);
  return top ? path.resolve(String(top).trim()) : null;
}
function prePushRanges(repo, stdinText) {
  const ranges = [];
  for (const line of String(stdinText || '').split('\n')) {
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || ZERO_SHA.test(localSha)) continue;   // a branch deletion
    let base = remoteSha && !ZERO_SHA.test(remoteSha) ? remoteSha : null;
    if (base && gitTry(repo, ['cat-file', '-e', `${base}^{commit}`]) === null) base = null;
    if (!base) {
      const upstream = String(gitTry(repo, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']) || '').trim() || 'origin/HEAD';
      base = String(gitTry(repo, ['merge-base', localSha, upstream]) || '').trim() || null;
    }
    if (base) ranges.push({ base, head: localSha });
  }
  return ranges;
}

/** Record what a check found, and write the override cards a human or a bypass produced. */
async function recordOutcome(repo, results, layer, { sha7 = '' } = {}) {
  const events = [];
  const overrideCards = [];
  for (const r of results) {
    for (const f of r.findings) events.push({ rule: r.rule.id, event: r.status === 'fail' ? 'block' : 'fire', layer, file: f.file, line: f.line || null });
    for (const f of r.allowed || []) {
      events.push({ rule: r.rule.id, event: 'override', layer, file: f.file, line: f.line || null, reason: f.allowance.reason, by: f.allowance.by });
      overrideCards.push({
        rule: r.rule,
        text: `${RULES_AREA}: ⚠ Override of rule \`${r.rule.id}\` at ${layer}${sha7 ? ` (commit ${sha7})` : ''}: ${f.file}${f.line ? `:${f.line}` : ''} ${f.found}. Reason given by ${f.allowance.by}: ${f.allowance.reason}`,
        link: r.rule.mirrorCard || r.rule.source.card, label: 'overridden',
      });
    }
  }
  appendEvents(repo, events);
  if (overrideCards.length) await mirrorToBrain(repo, overrideCards);
}

/** `klypix-mcp check …`, the git hook entry and `klypix-mcp rules …`. Returns an exit code. */
export async function runRulesCli(argv, { cwd = process.cwd(), env = process.env, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), stdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } } } = {}) {
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = repoTop(cwd);
  if (!repo) { stderr('klypix-mcp: not inside a git repository.\n'); return 2; }
  if (argv[0] === 'rules') return rulesCommand(repo, argv.slice(1), { stdout, stderr, env });
  if (has('--install-hook')) {
    const r = installRulesHooks(repo);
    if (!r.ok && r.reason === 'custom-hookspath') {
      // A hook manager (husky, lefthook, …) owns core.hooksPath: say what to add, write nothing.
      const engine = '"$HOME/.claude/project-brain/brain-rules.mjs"';
      const line = (name) => `if [ -f ${engine} ]; then node ${engine} --hook ${name} "$@"${name === 'post-commit' ? ' || true' : ' || exit 1'}; fi`;
      stdout(`This repository runs its git hooks from core.hooksPath (${String(gitTry(repo, ['config', 'core.hooksPath']) || '').trim()}), which a hook manager owns, so KLYPIX writes nothing there. Add one line to each of these hooks:\n${RULE_HOOKS.map((name) => `  ${name}:\n    ${line(name)}`).join('\n')}\n`);
      return 1;
    }
    stdout(r.ok ? `KLYPIX rule check wired into ${r.changed.join(', ') || 'nothing new (already current)'}${r.skipped.length ? `; left non-shell hook(s) alone: ${r.skipped.join(', ')}` : ''}. Bypass one commit: git commit --no-verify (recorded as an override).\n` : `Could not install: ${r.reason}.\n`);
    return r.ok ? 0 : 1;
  }
  if (has('--remove-hook')) { const r = removeRulesHooks(repo); stdout(`Removed from: ${r.changed.join(', ') || 'none'}.\n`); return 0; }
  const hook = val('--hook');
  // KLYPIX_RULES=0 skips the check, never the record: post-commit still notes a
  // commit that landed while a block rule fails on it.
  if (hook !== 'post-commit' && /^(0|false|off|no)$/i.test(String(env.KLYPIX_RULES || ''))) return 0;
  const doc = loadRulesDoc(repo);
  if (!doc.ok) { stderr(`KLYPIX rules: ${RULES_FILE} is invalid — ${doc.errors.join('; ')}\n`); return hook ? 0 : 2; }
  const rules = activeRules(doc);
  if (!rules.length) { if (!hook) stdout(`No active rules in ${RULES_FILE}.\n`); return 0; }
  const strict = has('--strict');
  let allowances = readAllowances(repo);
  const envOverride = String(env.KLYPIX_RULES_OVERRIDE || '').trim();
  if (envOverride) {
    const [id, ...rest] = envOverride.split(':');
    if (rest.join(':').trim()) allowances = [...allowances, { rule: id.trim(), reason: rest.join(':').trim(), file: null, by: `${os.userInfo().username} (KLYPIX_RULES_OVERRIDE${agentShell(env) ? `, set in a ${agentShell(env)} agent's shell` : ''})`, expiresAt: Date.now() + 60_000 }];
  }
  if (hook === 'post-commit') {
    // A commit that landed while an active block rule fails on it skipped the
    // pre-commit check (--no-verify, KLYPIX_RULES=0, or no hook then). Record it.
    const head = String(gitTry(repo, ['rev-parse', 'HEAD']) || '').trim();
    const parent = String(gitTry(repo, ['rev-parse', '--verify', '-q', 'HEAD~1']) || '').trim();
    if (!head || !parent) return 0;
    // A merge brings in other people's already-checked commits: not a bypass.
    if (String(gitTry(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']) || '').trim().split(/\s+/).length > 2) return 0;
    const results = runRules(rules, gitDiffSource(repo, { mode: 'range', base: parent, head }), { allowances });
    const bypassed = results.filter((r) => r.status === 'fail');
    const sha7 = head.slice(0, 7);
    if (bypassed.length) {
      appendEvents(repo, bypassed.flatMap((r) => r.findings.map((f) => ({ rule: r.rule.id, event: 'override', layer: 'post-commit', file: f.file, line: f.line || null, reason: 'committed without passing the rule (git commit --no-verify, KLYPIX_RULES=0, or the hook was not installed)', sha: sha7 }))));
      await mirrorToBrain(repo, bypassed.map((r) => ({
        rule: r.rule,
        text: `${RULES_AREA}: ⚠ Commit ${sha7} landed although rule \`${r.rule.id}\` fails on it (${r.findings.slice(0, 3).map((f) => `${f.file}${f.line ? `:${f.line}` : ''}`).join(', ')}) — the check was skipped (--no-verify, KLYPIX_RULES=0, or no hook). Why the rule exists: ${r.rule.why}`,
        link: r.rule.mirrorCard || r.rule.source.card, label: 'bypassed',
      })));
    }
    await recordOutcome(repo, results.map((r) => ({ ...r, findings: [] })), 'commit', { sha7 });   // allowances used by this commit
    if (results.some((r) => r.allowed?.length)) clearAllowances(repo);
    return 0;
  }
  const diffs = [];
  try {
    if (hook === 'pre-commit' || has('--staged')) diffs.push(gitDiffSource(repo, { mode: 'staged' }));
    else if (hook === 'pre-push') for (const r of prePushRanges(repo, stdin())) diffs.push(gitDiffSource(repo, { mode: 'range', ...r }));
    else if (val('--range')) { const [base, head] = String(val('--range')).split('..'); diffs.push(gitDiffSource(repo, { mode: 'range', base, head: head || 'HEAD' })); }
    else if (val('--base')) {
      const head = val('--head') || 'HEAD';
      const base = String(gitTry(repo, ['merge-base', val('--base'), head]) || '').trim() || val('--base');
      diffs.push(gitDiffSource(repo, { mode: 'range', base, head }));
    } else diffs.push(gitDiffSource(repo, { mode: 'worktree' }));
  } catch (error) {
    stderr(`KLYPIX rules: could not read the diff (${error.message}); not blocking.\n`);
    return 0;
  }
  const results = diffs.flatMap((d) => runRules(rules, d, { allowances }));
  const layer = hook === 'pre-push' ? 'push' : hook === 'pre-commit' ? 'commit' : 'check';
  // The allowance-based overrides are recorded by post-commit (the commit then
  // really happened); everything else is recorded now.
  await recordOutcome(repo, hook === 'pre-commit' ? results.map((r) => ({ ...r, allowed: [] })) : results, layer);
  const summary = summarizeResults(results, { strict });
  if (has('--json')) {
    stdout(`${JSON.stringify({ ok: summary.ok, results: results.map((r) => ({ id: r.rule.id, status: r.status, severity: r.rule.severity, card: r.rule.source.card, why: r.rule.why, findings: r.findings, overridden: (r.allowed || []).map((f) => ({ file: f.file, line: f.line, reason: f.allowance.reason })) })) }, null, 2)}\n`);
  } else if (summary.text) {
    (summary.ok ? stdout : stderr)(`KLYPIX project rules (${RULES_FILE}):\n${summary.text}\n`);
    if (!summary.ok && hook) stderr(`\nBlocked by ${summary.blocking} rule(s) made from this project's lessons. Fix the change. If a person decides this is a real exception, they run in their own terminal: npx klypix-mcp rules allow <rule> --reason "<why>" (one hour, recorded in the brain), or git ${hook === 'pre-push' ? 'push' : 'commit'} --no-verify (recorded as a bypass).\n`);
  } else if (!hook) stdout('KLYPIX project rules: all pass.\n');
  return summary.ok ? 0 : 1;
}

async function rulesCommand(repo, args, { stdout, stderr, env = process.env }) {
  const sub = args[0] || 'list';
  const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const VALUE_FLAGS = new Set(['--code', '--reason', '--file']);
  const positional = args.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(arr[i - 1])));
  const block = args.includes('--block');
  if (sub === 'code') {
    const action = positional[0];
    if (!['promote', 'retire'].includes(action)) { stderr('usage: klypix-mcp rules code promote|retire <rule-id>…\n'); return 2; }
    const agent = agentShell(env);
    if (agent) {
      stderr(`\`rules code\` prints the approval code that makes rules active or retires them, so it is the person's to run in their own terminal; it does not run inside an agent's shell (${agent}). Show the person the rules, then ask them to run: npx klypix-mcp rules code ${action} ${positional.slice(1).join(' ')}\n`);
      return 1;
    }
    const review = lifecycleReview(repo, action, positional.slice(1), { block });
    if (!review.ok) { stderr(`${review.message}\n`); return 1; }
    stderr(`You are approving: ${action} ${review.rules.length} rule(s):\n`);
    if (action === 'promote') stderr(block ? 'They will BLOCK: stop an edit (Claude Code) and a commit until the change is fixed or a person allows it.\n' : 'They will WARN: shown before and during the work and at commit, never stopping it. To make them block, run this again with --block.\n');
    for (const r of review.rules) stderr(`  ${r.id} (${r.kind}, ${r.severity}) — ${r.why}\n    fix: ${r.fix}\n    files: ${r.files.join(', ')}${r.registry ? ` → ${r.registry.join(', ')}` : ''}${r.pattern ? `\n    pattern: ${r.pattern}` : ''}\n    from lesson ${r.source.card}\n`);
    stderr('If that is what you want, paste this code into the chat (valid today, for exactly these rules):\n');
    stdout(`${review.code}\n`);
    return 0;
  }
  if (sub === 'promote' || sub === 'retire') {
    const ids = positional; const code = flag('--code');
    if (!ids.length || !code) { stderr(`usage: klypix-mcp rules ${sub} <rule-id>… --code <code from \`rules code ${sub} …\`>${sub === 'retire' ? ' [--reason "<why>"]' : ''}
`); return 2; }
    const res = sub === 'promote' ? await promoteRules(repo, ids, code, { approvedBy: `${os.userInfo().username} (terminal)`, block }) : await retireRules(repo, ids, code, { reason: flag('--reason') || '' });
    if (!res.ok) { stderr(`${res.message}
`); return 1; }
    stdout(`${sub === 'promote' ? 'Active' : 'Retired'}: ${(res.promoted || res.retired).join(', ')}.${res.mirrored ? ' Mirrored into the brain.' : ` ${res.mirrorNote}`}
`);
    return 0;
  }
  if (sub === 'allow' || sub === 'false-alarm') {
    const id = positional[0]; const reason = flag('--reason');
    if (!id || !reason) { stderr(`usage: klypix-mcp rules ${sub} <rule-id> --reason "<why>"${sub === 'allow' ? ' [--file <path>]' : ''}\n`); return 2; }
    const agent = agentShell(env);
    if (sub === 'allow' && agent) {
      stderr(`A one-hour exception to a project rule is the person's decision, so \`rules allow\` does not run inside an agent's shell (${agent}). Fix the change, or show the person the finding and ask them to run: npx klypix-mcp rules allow ${id} --reason "<why>"\n`);
      return 1;
    }
    const rule = loadRulesDoc(repo).rules.find((r) => r.id === id);
    if (!rule) { stderr(`No rule ${id} in ${RULES_FILE}.\n`); return 1; }
    if (sub === 'allow') {
      const res = addAllowance(repo, { rule: id, reason, file: flag('--file') || null });
      if (!res.ok) { stderr(`${res.message}\n`); return 1; }
      stdout(`Allowed ${id}${flag('--file') ? ` for ${flag('--file')}` : ''} for one hour. The override and your reason are recorded in the brain when the commit lands.\n`);
      return 0;
    }
    appendEvents(repo, [{ rule: id, event: 'false-alarm', layer: agent ? 'agent' : 'human', reason }]);
    const res = await mirrorToBrain(repo, [{ rule, text: `${RULES_AREA}: ✗ False alarm reported for rule \`${id}\`${agent ? ` (from a ${agent} agent's shell)` : ''}: ${String(reason).slice(0, 300)}`, link: rule.mirrorCard || rule.source.card, label: 'false alarm' }]);
    stdout(`Recorded a false alarm for ${id}${res.ok ? ' in the brain' : ` (${res.note})`}. Repeated false alarms make \`rules\` suggest narrowing or retiring it.\n`);
    return 0;
  }
  // list / status
  await flushPendingCards(repo);
  const doc = loadRulesDoc(repo);
  if (!doc.ok) { stderr(`${RULES_FILE} is invalid — ${doc.errors.join('; ')}\n`); return 2; }
  const { stats, suggestions } = ruleStats(repo);
  const hookState = rulesHookStatus(repo).state;
  stdout(`${RULES_FILE}: ${doc.rules.length} rule(s) · git hooks: ${hookState}\n`);
  for (const r of doc.rules) {
    const s = stats.find((x) => x.id === r.id) || {};
    stdout(`  [${r.status}] ${r.id} (${r.kind}, ${r.severity}) — fires ${s.fires || 0}, blocks ${s.blocks || 0}, overrides ${s.overrides || 0}, false alarms ${s.falseAlarms || 0} · lesson ${r.source.card}\n`);
  }
  for (const s of suggestions) stdout(`  → ${s.id} ${s.why}\n`);
  return 0;
}

// ── the brain_rules MCP tool ─────────────────────────────────────────────────
const textResult = (text, structured = null, isError = false) => ({ blocks: [{ kind: 'text', text }], ...(structured ? { structured } : {}), ...(isError ? { isError: true } : {}) });

async function brainCards(brainPath) {
  const lib = await import(new URL('./klypix-format.mjs', import.meta.url).href);
  return (await lib.parseKlypix(fs.readFileSync(brainPath))).struct.cards || [];
}

/**
 * brain_rules: propose | add | check | status | promote | retire | false_alarm.
 * Returns { blocks, structured, isError } for the worker's toContent.
 */
export async function brainRulesTool({ projectRoot, brainPath = null, action = 'status', query = '', limit = 30, rules = [], ids = [], approve = '', reason = '', mode = 'worktree', base = '', head = '', files = [], includeCandidates = false, pluginMode = false, proposedBy = '', block = false } = {}) {
  const root = path.resolve(projectRoot);
  const brain = brainPath || path.join(root, 'brain.klypix');
  const writes = ['add', 'promote', 'retire'];
  if (pluginMode && writes.includes(action)) {
    return textResult(`brain_rules ${action} is off in plugin mode: it writes ${RULES_FILE}, a project file, and the plugin promises no project writes. Use the standalone klypix-mcp (npx klypix-mcp install) to manage rules; propose, check and status still work here.`, { ok: false, reason: 'plugin-mode' }, true);
  }
  const doc = loadRulesDoc(root);
  if (!doc.ok && action !== 'propose') return textResult(`${RULES_FILE} is invalid, so no rule is enforced until it is fixed:\n- ${doc.errors.join('\n- ')}`, { ok: false, errors: doc.errors }, true);

  if (action === 'propose') {
    if (!fs.existsSync(brain)) return textResult(`No brain at ${brain}.`, { ok: false }, true);
    const { proposals, counts } = proposeFromCards(await brainCards(brain), { query, limit, existing: doc.rules, pathResolver: repoPathResolver(root) });
    const lines = proposals.map((p) => [
      `- [${p.route}] ${p.card}${p.area ? ` (${p.area})` : ''}: ${p.excerpt.slice(0, 220)}${p.excerpt.length > 220 ? '…' : ''}`,
      `    why this route: ${p.reason}`,
      ...(p.draft ? [`    draft: ${JSON.stringify(p.draft)}`] : []),
    ].join('\n'));
    return textResult([
      `# Lessons in this brain, routed (${proposals.length} shown: ${counts.rule} rule · ${counts.instruction} instruction · ${counts.note} note)`,
      'A lesson becomes a RULE only when a diff can check it with no judgement (a missing list entry, a forbidden line, changed line endings, a path that needs the full cloud CI). An INSTRUCTION is a standing rule a diff cannot test — it already resurfaces in every session brief. A NOTE is judgement or history.',
      'For each rule worth enforcing: complete the draft (why = the lesson in one line; fix = what to do, may use {file} {line} {needle} {registry} {1}; files = globs; registry / pattern as the kind needs), test it with brain_rules {action:"check", include_candidates:true, mode:"range", base:"<old commit>"} if you can, then brain_rules {action:"add", rules:[…]}. Added rules are CANDIDATES — inert until the human approves them.',
      '',
      ...lines,
    ].join('\n'), { ok: true, counts, proposals });
  }

  if (action === 'add') {
    if (!fs.existsSync(brain)) return textResult(`No brain at ${brain} — a rule must cite the brain card it came from.`, { ok: false }, true);
    const known = new Set((await brainCards(brain)).map((c) => c.id));
    const res = addCandidates(root, rules, { cardExists: (id) => known.has(id), proposedBy });
    if (!res.ok) return textResult(`Nothing was written:\n- ${res.errors.join('\n- ')}`, { ok: false, errors: res.errors }, true);
    return textResult([
      `Added ${res.added.length} candidate rule(s) to ${RULES_FILE}: ${res.added.join(', ')}. Candidates enforce nothing.`,
      'To activate them, show the human each rule (why, fix, files, registry/pattern) and ask them to run, in this project:',
      `  npx klypix-mcp rules code promote ${res.added.join(' ')}`,
      'Approved rules WARN. If the human wants them to stop an edit or a commit, they add --block to that command.',
      'They will paste an 8-character code if they approve; then call brain_rules {action:"promote", ids:[…], approve:"<code>"} (with block:true if they used --block). Never guess the code.',
      `Commit ${RULES_FILE} so the rules travel with the repo and every change to them is reviewed in a PR.`,
    ].join('\n'), { ok: true, added: res.added, file: res.file });
  }

  if (action === 'promote' || action === 'retire') {
    const res = action === 'promote' ? await promoteRules(root, ids, approve, { brainPath: brain, block: block === true }) : await retireRules(root, ids, approve, { reason, brainPath: brain });
    if (!res.ok) return textResult(res.message, { ok: false, reason: res.reason }, true);
    const done = res.promoted || res.retired;
    const hookState = rulesHookStatus(root).state;
    return textResult([
      `${action === 'promote' ? 'Active' : 'Retired'}: ${done.join(', ')}. ${res.mirrored ? 'Mirrored into the brain (area Rules), linked to the source lesson.' : res.mirrorNote}`,
      action === 'promote' && hookState !== 'installed'
        ? `The git hooks are ${hookState}: brain_sync and the Claude Code edit hook enforce the rules now; for commits from every tool and person, the human can run: npx klypix-mcp check --install-hook`
        : '',
      `Commit ${RULES_FILE}.`,
    ].filter(Boolean).join('\n'), { ok: true, [action === 'promote' ? 'promoted' : 'retired']: done });
  }

  if (action === 'false_alarm') {
    const id = asList(ids)[0];
    const rule = doc.rules.find((r) => r.id === id);
    if (!rule || !String(reason || '').trim()) return textResult('false_alarm needs ids:[<rule id>] and a reason.', { ok: false }, true);
    appendEvents(root, [{ rule: id, event: 'false-alarm', layer: 'agent', reason: String(reason).slice(0, 300) }]);
    const res = await mirrorToBrain(root, [{ rule, text: `${RULES_AREA}: ✗ False alarm reported for rule \`${id}\` (by an agent, through brain_rules): ${String(reason).slice(0, 300)}`, link: rule.mirrorCard || rule.source.card, label: 'false alarm' }], { brainPath: brain });
    return textResult(`Recorded a false alarm for ${id}${res.ok ? ' in the brain' : ` (${res.note})`}. It does not lift the rule; repeated false alarms make status suggest narrowing or retiring it — the human decides.`, { ok: true });
  }

  if (action === 'check') {
    const pool = includeCandidates ? doc.rules.filter((r) => r.status !== 'retired') : activeRules(doc);
    if (!pool.length) return textResult(`No ${includeCandidates ? 'active or candidate' : 'active'} rules in ${RULES_FILE}.`, { ok: true, results: [] });
    if (asList(files).length && !base && mode === 'worktree') {
      const matched = rulesForFiles(root, files, { limit: 20, rules: pool }).rules;
      return textResult(matched.length ? formatRulesNotice(matched) : 'No rule covers these files.', { ok: true, rules: matched });
    }
    let diff;
    try {
      if (mode === 'range' || base) {
        const h = head || 'HEAD';
        const mb = String(gitTry(root, ['merge-base', base, h]) || '').trim() || base;
        diff = gitDiffSource(root, { mode: 'range', base: mb, head: h });
      } else diff = gitDiffSource(root, { mode: mode === 'staged' ? 'staged' : 'worktree' });
    } catch (error) { return textResult(`Could not read the diff: ${error.message}`, { ok: false }, true); }
    const results = runRules(pool, diff, { allowances: readAllowances(root) });
    const summary = summarizeResults(results);
    appendEvents(root, results.flatMap((r) => (r.rule.status === 'active' ? r.findings.map((f) => ({ rule: r.rule.id, event: 'fire', layer: 'check', file: f.file, line: f.line || null })) : [])));
    return textResult(summary.text ? `${summary.ok ? 'No blocking finding.' : `${summary.blocking} rule(s) would block this change.`}\n\n${summary.text}` : `All ${pool.length} rule(s) pass on this ${diff.mode} diff (${diff.files.length} file(s)).`, {
      ok: summary.ok,
      results: results.map((r) => ({ id: r.rule.id, status: r.status, ruleStatus: r.rule.status, severity: r.rule.severity, card: r.rule.source.card, findings: r.findings })),
    });
  }

  // status
  await flushPendingCards(root, { brainPath: brain });
  const { stats, suggestions, ledger } = ruleStats(root);
  const hooks = rulesHookStatus(root);
  const byStatus = (s) => doc.rules.filter((r) => r.status === s);
  const line = (r) => {
    const st = stats.find((x) => x.id === r.id) || {};
    return `- ${r.id} (${r.kind}, ${r.severity}) — fires ${st.fires || 0} · blocks ${st.blocks || 0} · overrides ${st.overrides || 0} · false alarms ${st.falseAlarms || 0}${st.lastFiredAt ? ` · last ${new Date(st.lastFiredAt).toISOString().slice(0, 10)}` : ''} · lesson ${r.source.card}: ${r.why}`;
  };
  return textResult([
    `# Project rules (${RULES_FILE}) — ${byStatus('active').length} active · ${byStatus('candidate').length} candidate · ${byStatus('retired').length} retired`,
    `Enforced at: brain_sync (plan) · Claude Code edit hook (blocks a forbidden line; context otherwise) · Codex edit hook (warnings) · git hooks: ${hooks.state}${hooks.state !== 'installed' ? ' (npx klypix-mcp check --install-hook)' : ''}.`,
    ...(byStatus('active').length ? ['', '## Active', ...byStatus('active').map(line)] : []),
    ...(byStatus('candidate').length ? ['', '## Candidates (inert until the human approves)', ...byStatus('candidate').map(line)] : []),
    ...(byStatus('retired').length ? ['', '## Retired', ...byStatus('retired').map((r) => `- ${r.id}: ${r.retiredReason || ''}`)] : []),
    ...(suggestions.length ? ['', '## Suggestions (the human decides)', ...suggestions.map((s) => `- ${s.id} ${s.why}`)] : []),
    '',
    `Counts come from this machine's ledger (${ledger}).`,
  ].join('\n'), { ok: true, rules: doc.rules, stats, suggestions, hooks: hooks.state });
}

// Hooks run this file directly: `node brain-rules.mjs --hook pre-commit`.
const invokedDirectly = (() => {
  try { return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (invokedDirectly) process.exit(await runRulesCli(process.argv.slice(2)));
