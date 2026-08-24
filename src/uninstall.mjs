// klypix REMOVAL engine — the honest twin of install/link.
//
// Until 1.43.1 there was no way to remove klypix-mcp except by hand: edit
// ~/.claude/settings.json, ~/.codex/config.toml, ~/.codex/hooks.json and
// ~/.codex/AGENTS.md, delete ~/.claude/project-brain, then delete or un-fence 14
// per-project files. `npx klypix-mcp uninstall` printed nothing and exited 0 —
// indistinguishable from success. That is the top adoption-trust gap: a tool you
// cannot cleanly remove is a tool you do not install.
//
// DESIGN RULES (an uninstaller is the highest-blast-radius code in the package):
//   1. NEVER delete a user's brain.klypix, or ANY .klypix/.any canvas. Enforced by
//      assertRemovable() on every single filesystem mutation, not by convention.
//   2. Ownership-scoped removal ONLY. Managed fenced blocks come out of shared
//      files; the user's prose around them survives byte-for-byte. Sibling MCP
//      servers, sibling hooks and sibling TOML tables survive.
//   3. Back up any file with content before modifying OR deleting it (.klypix-bak).
//   4. Plan first, act second. The plan is computed with zero writes, printed in
//      full, and only then executed — and the apply path RE-PLANS each item from
//      disk, so what is printed is what is removed.
//   5. Idempotent: everything is expressed as "make this state absent", so a second
//      run is a clean no-op.
//   6. Never a silent partial success. A file we cannot parse is BLOCKED, reported
//      by name and reason, and makes the run exit non-zero — never overwritten.
//
// The 14-file project inventory is NOT re-derived here: it is read from
// linkProject(dir, { check: true }) — the same targets() map the writer uses — so
// the remover can never fall out of sync with the projector. A target linkProject
// reports that this module does not know how to remove is BLOCKED with a real
// message, never silently skipped.
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  linkProject,
  disconnectCodexMcpServer,
  removeCodexGlobalInstructions,
  codexGlobalInstructionsInstalled,
  safeReadCodexConfig,
  FENCE_RE,
} from './agent-rules.mjs';
import {
  codexPresenceHookStatus,
  removeCodexPresenceHooks,
  resolveCodexHooksPath,
} from './codex-hooks.mjs';

// ── the one absolute rule ────────────────────────────────────────────────────
// A canvas is USER DATA. install/link never created one and uninstall must never
// remove one. This is a hard gate in front of every write/unlink/rm in this file,
// so no future edit can route around it by forgetting.
const CANVAS_RE = /\.(klypix|any)$/i;
export function assertRemovable(file) {
  if (CANVAS_RE.test(String(file))) {
    throw new Error(`refusing to touch a canvas file (user data): ${file}`);
  }
  return file;
}

// The hook command marker install stamps into ~/.claude/settings.json.
const CLAUDE_HOOK_MARK = 'global-brain-hook';
// The in-place generated brief block inside AGENTS.md (agent-rules compactAgentsBrief).
const BRIEF_RE = /<!-- klypix-brain-brief:start -->[\s\S]*?<!-- klypix-brain-brief:end -->/;

// How each of the 14 managed project files is removed. Keyed by the SAME
// project-relative posix path linkProject reports, so a mismatch is detectable
// rather than silent. `frontmatter` mirrors targets() exactly: for a dedicated
// file it is ours too, so it is stripped along with the fence.
const CURSOR_FRONTMATTER = '---\ndescription: KLYPIX project brain — read at task start, capture decisions\nalwaysApply: true\n---';
const WINDSURF_FRONTMATTER = '---\ntrigger: always_on\n---';
export const PROJECT_TARGETS = {
  'AGENTS.md': { kind: 'fence' },
  '.cursor/rules/klypix-brain.mdc': { kind: 'dedicated', frontmatter: CURSOR_FRONTMATTER },
  '.windsurf/rules/klypix-brain.md': { kind: 'dedicated', frontmatter: WINDSURF_FRONTMATTER },
  '.clinerules/klypix-brain.md': { kind: 'dedicated', frontmatter: '' },
  '.github/copilot-instructions.md': { kind: 'fence' },
  'GEMINI.md': { kind: 'fence' },
  'CONVENTIONS.md': { kind: 'dedicated', frontmatter: '' },
  '.agents/AGENTS.md': { kind: 'fence' },
  '.codex/config.toml': { kind: 'toml' },
  '.mcp.json': { kind: 'mcpjson', wrapKey: 'mcpServers' },
  '.cursor/mcp.json': { kind: 'mcpjson', wrapKey: 'mcpServers' },
  '.cline/mcp.json': { kind: 'mcpjson', wrapKey: 'mcpServers' },
  '.gemini/settings.json': { kind: 'mcpjson', wrapKey: 'mcpServers' },
  '.vscode/mcp.json': { kind: 'mcpjson', wrapKey: 'servers' },
};

// Runtime sidecars in <project>/.claude — caches and logs, not data. Off by
// default (--sidecars). brain-capture-pending.jsonl is DELIBERATELY absent: it is
// the designed spill file for deferred captures, so removing it can lose markers
// that never reached the brain. It is reported, never removed.
export const PROJECT_SIDECARS = [
  '.claude/brain-capture.lock',
  '.claude/brain-capture-state.json',
  '.claude/brain-last-commit',
  '.claude/brain-brief.md',
];
export const PROJECT_SIDECARS_PROTECTED = ['.claude/brain-capture-pending.jsonl'];

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const lf = (s) => String(s).replace(/\r\n/g, '\n');

// ── mutation primitives (every one goes through assertRemovable) ─────────────
function backupFile(file) {
  assertRemovable(file);
  const raw = readText(file);
  if (raw === null || raw === '') return null;
  const bak = file + '.klypix-bak';
  try { fs.writeFileSync(bak, raw, 'utf8'); return bak; } catch { return null; }
}

function writeAtomic(file, next) {
  assertRemovable(file);
  const tmp = file + '.klypix-rm-tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);
}

function deleteFile(file) {
  assertRemovable(file);
  fs.rmSync(file, { force: true });
}

// Remove a directory that is entirely ours. Refuses if it contains any canvas —
// a user who saved brain.klypix inside ~/.claude/project-brain must not lose it.
function deleteDirGuarded(dir) {
  const offenders = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (CANVAS_RE.test(e.name)) offenders.push(full);
    }
  };
  walk(dir);
  if (offenders.length) {
    return { ok: false, error: `refusing to delete ${dir} — it contains ${offenders.length} canvas file(s): ${offenders.slice(0, 3).join(', ')}` };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

// Drop empty directories left behind by a removal, up to (not including) the root.
function pruneEmptyDirs(fileAbs, rootAbs) {
  let dir = path.dirname(path.resolve(fileAbs));
  const root = path.resolve(rootAbs);
  while (dir.startsWith(root) && dir !== root) {
    try { if (fs.readdirSync(dir).length) break; fs.rmdirSync(dir); } catch { break; }
    dir = path.dirname(dir);
  }
}

// Close the hole a removed block leaves WITHOUT eating the user's formatting.
// `link` merges by appending "\n\n" + block + "\n" (or prepending when it created
// the file), so exactly that padding is what must come back off — otherwise a
// linked-then-unlinked file never returns to its original bytes, and every VCS
// shows a phantom diff. Leading whitespace is only trimmed when the block was at
// the TOP of the file; trailing collapses to a single newline.
function tidyResidue(next, raw) {
  let out = next.replace(/\n{3,}/g, '\n\n');
  if (/^\s*<!--\s*klypix-brain(?::start|-brief:start)/.test(raw)) out = out.replace(/^\s+/, '');
  out = out.replace(/\s+$/, '\n');
  if (!/\n$/.test(out)) out += '\n';
  return out;
}

// ── per-kind planning (pure: reads only) ─────────────────────────────────────
function planFence(file) {
  const raw = readText(file);
  if (raw === null) return { action: 'none', why: 'not present' };
  const hadFence = FENCE_RE.test(raw);
  const hadBrief = BRIEF_RE.test(raw);
  if (!hadFence && !hadBrief) return { action: 'none', why: 'no managed block' };
  let next = raw.replace(FENCE_RE, '').replace(BRIEF_RE, '');
  const parts = [hadFence && 'instruction fence', hadBrief && 'generated brief block'].filter(Boolean);
  if (lf(next).trim() === '') {
    return { action: 'delete-file', why: `file held only the ${parts.join(' + ')}` };
  }
  next = tidyResidue(next, raw);
  return { action: 'strip-block', why: `remove the ${parts.join(' + ')}; your own content stays`, next };
}

function planDedicated(file, frontmatter) {
  const raw = readText(file);
  if (raw === null) return { action: 'none', why: 'not present' };
  if (!FENCE_RE.test(raw)) return { action: 'none', why: 'no managed block — not written by klypix' };
  let next = lf(raw).replace(FENCE_RE, '');
  const fm = lf(frontmatter || '');
  if (fm && next.trimStart().startsWith(fm)) next = next.trimStart().slice(fm.length);
  if (next.trim() === '') return { action: 'delete-file', why: 'file is wholly klypix-owned' };
  next = tidyResidue(next, raw);
  return { action: 'strip-block', why: 'remove the managed block; your own content stays', next };
}

function planMcpJson(file, wrapKey) {
  const raw = readText(file);
  if (raw === null) return { action: 'none', why: 'not present' };
  if (!raw.trim()) return { action: 'none', why: 'empty file' };
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) {
    return { action: 'blocked', why: `invalid JSON (${e?.message || e}) — left untouched; remove the klypix-canvas entry by hand` };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { action: 'none', why: 'not an MCP config object' };
  const wrap = cfg[wrapKey];
  if (!wrap || typeof wrap !== 'object' || Array.isArray(wrap) || !('klypix-canvas' in wrap)) {
    return { action: 'none', why: 'no klypix-canvas entry' };
  }
  const siblings = Object.keys(wrap).filter((k) => k !== 'klypix-canvas');
  delete wrap['klypix-canvas'];
  if (!Object.keys(wrap).length) delete cfg[wrapKey];
  if (!Object.keys(cfg).length) {
    return { action: 'delete-file', why: 'the klypix-canvas entry was the whole file' };
  }
  return {
    action: 'strip-entry',
    why: siblings.length ? `remove klypix-canvas; keep ${siblings.length} sibling server(s): ${siblings.join(', ')}` : 'remove the klypix-canvas entry',
    next: JSON.stringify(cfg, null, 2) + '\n',
  };
}

function planToml(file) {
  if (!isFile(file)) return { action: 'none', why: 'not present' };
  const parsed = safeReadCodexConfig(file);
  if (!parsed.ok) return { action: 'blocked', why: `${parsed.error} — remove the [mcp_servers.klypix-canvas] table by hand` };
  const owned = Object.keys(parsed.servers || {}).filter((k) => /klypix/i.test(k));
  if (!owned.length) return { action: 'none', why: 'no klypix mcp_servers table' };
  const siblings = Object.keys(parsed.servers).filter((k) => !/klypix/i.test(k));
  const names = `[mcp_servers.${owned.join('], [mcp_servers.')}]`;
  // Predict emptiness the SAME way disconnectCodexMcpServer performs the removal,
  // so the printed inventory matches what apply actually does (a plan that says
  // "strip" and then deletes the file is exactly the kind of surprise an
  // uninstaller must not spring on anyone).
  const ownedTables = (parsed.tables || []).filter((t) => t.parts[0] === 'mcp_servers' && t.parts.length >= 2 && /klypix/i.test(String(t.parts[1])));
  let residue = parsed.raw;
  for (const table of [...ownedTables].sort((a, b) => b.start - a.start)) {
    residue = residue.slice(0, table.start) + residue.slice(table.end);
  }
  if (residue.trim() === '') return { action: 'delete-file', why: `${names} was the whole file` };
  return {
    action: 'strip-entry',
    why: siblings.length ? `remove ${names}; keep ${siblings.length} sibling table(s)` : `remove ${names}`,
  };
}

function planOne(target) {
  const { file, kind, wrapKey, frontmatter } = target;
  if (kind === 'fence') return planFence(file);
  if (kind === 'dedicated') return planDedicated(file, frontmatter);
  if (kind === 'mcpjson') return planMcpJson(file, wrapKey);
  if (kind === 'toml') return planToml(file);
  if (kind === 'plainfile') return isFile(file) ? { action: 'delete-file', why: 'runtime sidecar (cache/log)' } : { action: 'none', why: 'not present' };
  return { action: 'blocked', why: `unknown removal kind "${kind}"` };
}

/**
 * PROJECT-LOCAL plan — the 14 managed files, computed with ZERO writes.
 * The file list comes from linkProject(check) so it can never drift from the
 * writer; a target this module has no removal recipe for is BLOCKED, not skipped.
 */
export function planUnlink(projectDir, { sidecars = false } = {}) {
  const root = path.resolve(projectDir);
  const items = [];
  const notes = [];
  let projected;
  try {
    projected = linkProject(root, { check: true });
  } catch (e) {
    return {
      scope: 'project',
      root,
      items: [{ label: 'projection map', rel: '(n/a)', file: root, kind: 'unknown', action: 'blocked', why: `could not read the projection map: ${e?.message || e}` }],
      notes,
    };
  }
  for (const r of [...projected.rules, ...projected.mcp]) {
    const rel = String(r.file).replace(/\\/g, '/');
    const meta = PROJECT_TARGETS[rel];
    const file = path.join(root, rel);
    if (!meta) {
      items.push({
        label: r.tool, rel, file, kind: 'unknown', action: 'blocked',
        why: 'this klypix-mcp projects a target this uninstaller does not know how to remove — remove it by hand and report the version',
      });
      continue;
    }
    const target = { file, kind: meta.kind, wrapKey: meta.wrapKey, frontmatter: meta.frontmatter };
    items.push({ label: r.tool, rel, file, ...target, ...planOne(target) });
  }
  if (sidecars) {
    for (const rel of PROJECT_SIDECARS) {
      const file = path.join(root, rel);
      items.push({ label: 'runtime sidecar', rel, file, kind: 'plainfile', ...planOne({ file, kind: 'plainfile' }) });
    }
  }
  for (const rel of PROJECT_SIDECARS_PROTECTED) {
    if (isFile(path.join(root, rel))) {
      notes.push(`${rel} exists and is NOT removed — it is the deferred-capture spill file. Drain it before deleting, or you lose captures that never reached the brain.`);
    }
  }
  const brain = ['brain.klypix', 'brain.any'].find((n) => isFile(path.join(root, n)));
  notes.push(brain
    ? `./${brain} is YOUR data and is never touched by this command.`
    : 'No ./brain.klypix here. Nothing in this command ever deletes a .klypix or .any canvas.');
  return { scope: 'project', root, items, notes };
}

/**
 * MACHINE-GLOBAL plan — the engine bundle, the 5 Claude Code hooks, and the
 * three Codex host files. Zero writes.
 */
export function planUninstall({ home = os.homedir(), installDir, keepRegistry = false, keepSemantic = false } = {}) {
  const HOME = path.resolve(home);
  const brainDir = installDir
    ? path.resolve(installDir)
    : (process.env.KLYPIX_MCP_INSTALL_DIR ? path.resolve(process.env.KLYPIX_MCP_INSTALL_DIR) : path.join(HOME, '.claude', 'project-brain'));
  const items = [];
  const notes = [];

  // 1) Claude Code hooks — ownership-scoped, exactly like install's stripOurs.
  const settings = path.join(HOME, '.claude', 'settings.json');
  items.push({ label: 'Claude Code hooks', rel: 'settings.json', file: settings, kind: 'claude-settings', ...planClaudeSettings(settings) });

  // 2) Codex global guidance block.
  const codexAgents = path.join(HOME, '.codex', 'AGENTS.md');
  items.push({
    label: 'Codex global guidance', rel: '.codex/AGENTS.md', file: codexAgents, kind: 'codex-agents',
    ...(codexGlobalInstructionsInstalled(HOME)
      ? { action: 'strip-block', why: 'remove the fenced KLYPIX block; your own guidance stays' }
      : { action: 'none', why: 'no managed block' }),
  });
  if (codexGlobalInstructionsInstalled(HOME)) {
    notes.push('~/.codex/AGENTS.md carries no version/hash stamp, so an edit you made INSIDE the KLYPIX block cannot be detected — the .klypix-bak backup is your only copy of it.');
  }

  // 3) Codex MCP tables (install normally removes these already).
  const codexToml = path.join(HOME, '.codex', 'config.toml');
  items.push({ label: 'Codex MCP tables', rel: '.codex/config.toml', file: codexToml, kind: 'toml', ...planToml(codexToml) });

  // 4) Codex presence hooks (only present with --codex-hooks).
  const hooksFile = resolveCodexHooksPath(HOME);
  const hookStatus = codexPresenceHookStatus(HOME);
  items.push({
    label: 'Codex presence hooks', rel: '.codex/hooks.json', file: hooksFile, kind: 'codex-hooks',
    ...(hookStatus.error
      ? { action: 'blocked', why: `${hookStatus.error} — remove the klypix handlers by hand` }
      : (hookStatus.wired?.length
        ? { action: 'strip-entry', why: `remove ${hookStatus.wired.length} klypix handler(s); sibling hooks stay` }
        : { action: 'none', why: 'no klypix handlers' })),
  });

  // 5) The engine bundle. Whole directory is ours — but surface what else lives there.
  const bundle = { label: 'engine bundle', rel: path.relative(HOME, brainDir).replace(/\\/g, '/') || brainDir, file: brainDir, kind: 'bundle' };
  if (isDir(brainDir)) {
    const keep = [];
    if (keepRegistry && isFile(path.join(brainDir, 'registry.json'))) keep.push('registry.json');
    if (keepSemantic && isDir(path.join(brainDir, 'semantic'))) keep.push('semantic/');
    // Idempotence under --keep-*: once only the retained items are left, there is
    // nothing more to remove, so a second run is a genuine no-op rather than a
    // delete-and-restore treadmill that reports "1 item still present" forever.
    const keepNames = new Set(keep.map((k) => k.replace(/\/$/, '')));
    const left = (() => { try { return fs.readdirSync(brainDir); } catch { return []; } })();
    if (keepNames.size && left.every((name) => keepNames.has(name))) {
      items.push({ ...bundle, action: 'none', why: `only the retained item(s) remain: ${keep.join(', ')}`, keep });
    } else {
      items.push({ ...bundle, action: 'delete-dir', why: keep.length ? `remove the engine, deps and manifests (keeping ${keep.join(', ')})` : 'remove the engine, dependency closure and manifests', keep });
    }
    if (isFile(path.join(brainDir, 'registry.json')) && !keepRegistry) {
      notes.push('registry.json goes with it — search_all_brains and `doctor --all` go empty until each project is worked in again. Keep it with --keep-registry.');
    }
    if (isDir(path.join(brainDir, 'semantic')) && !keepSemantic) {
      notes.push('semantic/ goes with it — on-device semantic ranking degrades to lexical, and `npx klypix-mcp install` does NOT re-download it (only the desktop app places it). Keep it with --keep-semantic.');
    }
    if (isDir(path.join(brainDir, 'sessions'))) {
      notes.push('sessions/ goes with it — presence lanes are ephemeral (they self-prune after 10 minutes), so this costs nothing.');
    }
  } else {
    items.push({ ...bundle, action: 'none', why: 'not present' });
  }

  notes.push('No .klypix or .any canvas is ever removed by this command — your brains are your data.');
  notes.push('The npm package itself is separate: `npm uninstall -g klypix-mcp` if you installed it globally, or clear the npx cache entry.');
  return { scope: 'machine', home: HOME, brainDir, items, notes };
}

// ~/.claude/settings.json — strip ONLY hook entries whose command references the
// global brain hook, drop groups that become empty, keep everything else.
function planClaudeSettings(file) {
  const raw = readText(file);
  if (raw === null) return { action: 'none', why: 'not present' };
  if (!raw.trim()) return { action: 'none', why: 'empty file' };
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) {
    return { action: 'blocked', why: `invalid JSON (${e?.message || e}) — left untouched; remove the klypix hooks by hand` };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { action: 'none', why: 'not a settings object' };
  const hooks = cfg.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { action: 'none', why: 'no hooks' };
  let removed = 0;
  const nextHooks = {};
  for (const [evt, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) { nextHooks[evt] = groups; continue; }
    const cleaned = groups
      .map((g) => {
        if (!g || !Array.isArray(g.hooks)) return g;
        const kept = g.hooks.filter((h) => !(typeof h?.command === 'string' && h.command.includes(CLAUDE_HOOK_MARK)));
        removed += g.hooks.length - kept.length;
        return { ...g, hooks: kept };
      })
      .filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (cleaned.length) nextHooks[evt] = cleaned;
  }
  if (!removed) return { action: 'none', why: 'no klypix hooks' };
  const next = { ...cfg };
  if (Object.keys(nextHooks).length) next.hooks = nextHooks; else delete next.hooks;
  const otherKeys = Object.keys(next).filter((k) => k !== 'hooks').length;
  return {
    action: 'strip-entry',
    why: `remove ${removed} klypix hook(s)${otherKeys ? '; every other setting and hook stays' : ''}`,
    next: JSON.stringify(next, null, 2) + '\n',
  };
}

// ── apply ────────────────────────────────────────────────────────────────────
// Every item is RE-PLANNED from disk before it is acted on, so what was printed
// is what is removed (and a second run finds nothing left to do).
function applyOne(item, { root } = {}) {
  const fresh = item.kind === 'claude-settings' ? planClaudeSettings(item.file)
    : item.kind === 'codex-hooks' ? null
      : item.kind === 'codex-agents' ? null
        : item.kind === 'bundle' ? null
          : planOne(item);
  try {
    if (item.kind === 'codex-agents') {
      if (!codexGlobalInstructionsInstalled(path.resolve(item.file, '..', '..'))) return { ok: true, action: 'none' };
      const res = removeCodexGlobalInstructions(path.resolve(item.file, '..', '..'));
      if (!res.ok) return { ok: false, action: 'blocked', error: res.error };
      const left = readText(item.file);
      if (left !== null && left.trim() === '') { deleteFile(item.file); return { ok: true, action: 'delete-file', backup: res.backup }; }
      return { ok: true, action: 'strip-block', backup: res.backup };
    }
    if (item.kind === 'codex-hooks') {
      const home = path.resolve(item.file, '..', '..');
      const status = codexPresenceHookStatus(home);
      if (status.error) return { ok: false, action: 'blocked', error: status.error };
      if (!status.wired?.length) return { ok: true, action: 'none' };
      const res = removeCodexPresenceHooks(home);
      if (!res.ok) return { ok: false, action: 'blocked', error: res.error };
      return { ok: true, action: res.action === 'unchanged' ? 'none' : 'strip-entry', backup: res.backup };
    }
    if (item.kind === 'bundle') {
      if (!isDir(item.file)) return { ok: true, action: 'none' };
      const keepPaths = [];
      const stash = path.join(path.dirname(item.file), '.klypix-uninstall-keep');
      for (const name of item.keep || []) {
        const from = path.join(item.file, name.replace(/\/$/, ''));
        if (!fs.existsSync(from)) continue;
        fs.mkdirSync(stash, { recursive: true });
        const to = path.join(stash, name.replace(/\/$/, ''));
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(from, to, { recursive: true });
        keepPaths.push(to);
      }
      const res = deleteDirGuarded(item.file);
      if (!res.ok) {
        for (const p of keepPaths) fs.rmSync(p, { recursive: true, force: true });
        return { ok: false, action: 'blocked', error: res.error };
      }
      if (keepPaths.length) {
        fs.mkdirSync(item.file, { recursive: true });
        for (const p of keepPaths) fs.cpSync(p, path.join(item.file, path.basename(p)), { recursive: true });
        fs.rmSync(stash, { recursive: true, force: true });
      }
      return { ok: true, action: 'delete-dir', kept: item.keep || [] };
    }
    if (item.kind === 'toml') {
      // 'strip-entry' and 'delete-file' both go through disconnectCodexMcpServer —
      // it is the ownership-scoped primitive (siblings preserved, backup written);
      // the file is only removed afterwards if nothing but whitespace was left.
      if (fresh.action !== 'strip-entry' && fresh.action !== 'delete-file') {
        return { ok: fresh.action !== 'blocked', action: fresh.action, error: fresh.action === 'blocked' ? fresh.why : undefined };
      }
      const res = disconnectCodexMcpServer({ configPath: item.file });
      if (!res.ok) return { ok: false, action: 'blocked', error: res.error };
      const left = readText(item.file);
      if (left !== null && left.trim() === '') {
        deleteFile(item.file);
        if (root) pruneEmptyDirs(item.file, root);
        return { ok: true, action: 'delete-file', backup: res.backup };
      }
      return { ok: true, action: 'strip-entry', backup: res.backup };
    }
    if (fresh.action === 'none') return { ok: true, action: 'none' };
    if (fresh.action === 'blocked') return { ok: false, action: 'blocked', error: fresh.why };
    const backup = backupFile(item.file);
    if (fresh.action === 'delete-file') {
      deleteFile(item.file);
      if (root) pruneEmptyDirs(item.file, root);
      return { ok: true, action: 'delete-file', backup };
    }
    writeAtomic(item.file, fresh.next);
    return { ok: true, action: fresh.action, backup };
  } catch (e) {
    return { ok: false, action: 'blocked', error: e?.message || String(e) };
  }
}

/**
 * Execute a plan. Returns per-item results; never throws for a single failure.
 * @param {{items:Array, root?:string}} plan
 */
export function applyPlan(plan) {
  const results = [];
  for (const item of plan.items) {
    if (item.action === 'none') { results.push({ ...item, result: { ok: true, action: 'none' } }); continue; }
    results.push({ ...item, result: applyOne(item, { root: plan.root }) });
  }
  return results;
}

/** Everything the plan still has to remove (blocked counts — it is not gone). */
export const pending = (plan) => plan.items.filter((i) => i.action !== 'none');
export const blocked = (plan) => plan.items.filter((i) => i.action === 'blocked');

/** `<file>.klypix-bak` restore points left beside managed files. Never auto-deleted. */
export function findBackups(plan) {
  const out = [];
  for (const item of plan.items) {
    if (item.kind === 'bundle') continue;
    const bak = item.file + '.klypix-bak';
    if (isFile(bak)) out.push(bak);
  }
  return out;
}

export function purgeBackups(plan) {
  const removed = [];
  for (const bak of findBackups(plan)) {
    try { assertRemovable(bak); fs.rmSync(bak, { force: true }); removed.push(bak); } catch { /* leave it */ }
  }
  // Directories that existed only to hold a managed file (and then its backup)
  // are litter once both are gone. Never touches a directory with anything in it.
  if (plan.root) for (const bak of removed) pruneEmptyDirs(bak, plan.root);
  return removed;
}
