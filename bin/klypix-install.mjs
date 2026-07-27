#!/usr/bin/env node
// klypix-install — lay the project-brain down into ~/.claude/project-brain from THIS
// package and wire the 4 Claude Code hooks into ~/.claude/settings.json. This makes
// npm the SINGLE delivery for the WHOLE brain (hook + engine + local MCP/A2A
// servers), so one `gh release create` (OIDC auto-publish) + `npx klypix-mcp install`
// updates every brain on a machine — the global ~/.claude/project-brain copy serves
// EVERY project (each project just needs a ./brain.klypix). The desktop app installs
// the SAME flat layout, so the two delivery channels converge on one install.
//
//   npx klypix-mcp install            # install / update the brain on this machine
//   npx klypix-mcp install --force    # overwrite even a newer / dev-deployed brain
//   npx klypix-mcp install --codex-hooks  # optional prompt/file awareness; Codex asks for trust
//
// Never-throws-silently: it's an explicit CLI, so it reports what it did and exits
// non-zero on a real failure. Never wires a broken settings.json (refuse + restore).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    connectCodexMcpServer,
    disconnectCodexMcpServer,
    mcpServerEntry,
    mergeCodexGlobalInstructions,
} from '../src/agent-rules.mjs';
import {
    codexPresenceHookStatus,
    mergeCodexPresenceHooks,
} from '../src/codex-hooks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(PKG_ROOT, 'src');
const BIN = path.join(PKG_ROOT, 'bin');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || ''; } catch { return ''; } })();
const FORCE = process.argv.includes('--force');
const CODEX_HOOKS = process.argv.includes('--codex-hooks');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const BRAIN_DIR = path.join(CLAUDE_DIR, 'project-brain');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CODEX_CONFIG = path.join(HOME, '.codex', 'config.toml');
const HOOK_MARK = 'global-brain-hook';
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const fwd = (p) => p.replace(/\\/g, '/');
const copyRetrySleepSync = (ms) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch { /* best effort */ }
};
function copyFileRobust(src, dest, tries = 8) {
    for (let attempt = 1; attempt <= tries; attempt++) {
        try { fs.copyFileSync(src, dest); return; }
        catch (error) {
            const retryable = ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code);
            if (!retryable || attempt === tries) throw error;
            copyRetrySleepSync(20 * attempt);
        }
    }
}
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name), d = path.join(dest, e.name);
        if (e.isDirectory()) copyDir(s, d); else if (e.isFile()) copyFileRobust(s, d);
    }
}

// Codex has two approval-free layers and one optional native layer:
// project-scoped MCP gives it tools + live presence + brain_sync, while the
// conditional ~/.codex/AGENTS.md block makes the Context Gateway workflow
// automatic on every task. Native lifecycle hooks add mechanical prompt/file
// capture only when the user explicitly asks for --codex-hooks and approves them
// in a Codex surface that exposes trust review.
function wireCodex() {
    const projectDir = process.cwd();
    const hasProjectBrain = exists(path.join(projectDir, 'brain.klypix'))
        || exists(path.join(projectDir, 'brain.any'));
    const projectConfig = path.join(projectDir, '.codex', 'config.toml');
    const mcp = hasProjectBrain
        ? connectCodexMcpServer({
            configPath: projectConfig,
            // Project config is commonly committed. Keep it portable: the
            // package invocation that is running this installer is exactly the
            // version the project asked for, while an absolute home path would
            // dirty the repo and break it on every other machine.
            entry: { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '.'] },
            cwd: '..',
        })
        : { ok: true, action: 'skipped-no-project-brain', path: projectConfig };
    // Pre-1.35 installed a global `--vault "."` entry. A global Codex process
    // resolves that dot from the app install directory, not the user's project,
    // so it can silently bind the wrong brain and override the correct project
    // table. Remove only KLYPIX-owned global tables; preserve every other server.
    const globalMcp = disconnectCodexMcpServer({ configPath: CODEX_CONFIG });
    const instructions = mergeCodexGlobalInstructions(HOME);
    const hookScript = path.join(BRAIN_DIR, 'codex-brain-hook.mjs');
    const presence = CODEX_HOOKS && exists(hookScript)
        ? mergeCodexPresenceHooks({
            home: HOME,
            command: `node "${fwd(hookScript)}"`,
        })
        : {
            ok: true,
            action: codexPresenceHookStatus(HOME).installed ? 'existing' : 'off',
            ...codexPresenceHookStatus(HOME),
        };
    return {
        mcp,
        globalMcp,
        instructions,
        presence,
        ok: mcp.ok && globalMcp.ok && instructions.ok && presence.ok,
    };
}

function reportCodex(result) {
    if (result.ok) {
        const mcp = result.mcp.action === 'skipped-no-project-brain'
            ? 'project MCP skipped (run `npx klypix-mcp link` inside a brain project)'
            : `project MCP + automatic presence/Context Gateway (${result.mcp.action})`;
        const enhanced = result.presence.action === 'off'
            ? 'enhanced hooks off (optional)'
            : result.presence.action === 'existing'
                ? `enhanced hooks already configured (${result.presence.executionStatus || 'unverified'})`
                : `enhanced hooks ${result.presence.action} — approve/review them in Codex /hooks`;
        console.log(`✓ wired Codex: ${mcp} + approval-free task guidance (${result.instructions.action}) + ${enhanced}`);
        if (result.globalMcp.action === 'disconnected') {
            console.log('✓ removed obsolete global Codex KLYPIX MCP entry (it could resolve "." outside the project); other MCP servers were preserved');
        }
        return;
    }
    if (!result.mcp.ok) console.error(`⚠ Codex MCP was not changed: ${result.mcp.error}`);
    if (!result.globalMcp.ok) console.error(`⚠ obsolete global Codex MCP entry was not removed: ${result.globalMcp.error}`);
    if (!result.instructions.ok) console.error(`⚠ Codex guidance was not changed: ${result.instructions.error}`);
    if (!result.presence.ok) console.error(`⚠ Codex enhanced hooks were not changed: ${result.presence.error}`);
    console.error('  Claude Code installation is intact. Fix the Codex warning, then re-run this command.');
}

// ── Never-downgrade gate ─────────────────────────────────────────────────────
// The brain version is a UNIFIED namespace = the klypix-mcp version, stamped by BOTH
// the npm install (here) and the desktop bundle, so the two channels compare cleanly.
// A dev deploy ({dev:true}) is authoritative; a strictly-newer install is not
// downgraded. --force overrides both.
const cmpSemver = (a, b) => { const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); } return 0; };
const cur = (() => { try { return JSON.parse(fs.readFileSync(path.join(BRAIN_DIR, '.brain-version.json'), 'utf8')); } catch { return null; } })();
if (!FORCE && cur) {
    if (cur.dev === true) {
        console.log(`• A dev deploy owns ${BRAIN_DIR} (dev:true) — leaving it untouched. Re-run with --force to override.`);
        reportCodex(wireCodex());
        process.exit(0);
    }
    if (cur.brainVersion && cmpSemver(cur.brainVersion, VERSION) > 0) {
        console.log(`• Installed brain v${cur.brainVersion} is newer than this package v${VERSION} — not downgrading. Re-run with --force to override.`);
        reportCodex(wireCodex());
        process.exit(0);
    }
}

// ── Install lock (auto-propagation, part D — concurrency) ─────────────────────
// Two sessions can self-update at the same moment; serialize so their writes never
// tear. O_EXCL create wins; a lock older than 60s (a sub-second install should never
// take that) is stolen so a crashed installer can't wedge every future update.
const LOCK = path.join(BRAIN_DIR, '.install.lock');
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* */ } };
function acquireLock() {
    try { fs.mkdirSync(BRAIN_DIR, { recursive: true }); } catch { /* */ }
    for (let i = 0; i < 120; i++) {
        try { const fd = fs.openSync(LOCK, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
        catch (e) {
            if (e && e.code !== 'EEXIST') return false;
            try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 60000) { fs.unlinkSync(LOCK); continue; } } catch { /* raced on the stale file — retry */ }
            sleepSync(50);
        }
    }
    return false;
}
const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch { /* */ } };

// Migrate THIS project's .mcp.json klypix-canvas entry off `npx` onto the local
// bundle now that it's installed — the desync fix for EXISTING configs (the self-
// update hook runs install per project, so every project heals once). Only the
// known npx/node launch is migrated; a hand-customized command / invalid JSON is
// left untouched, and the original is backed up. Best-effort, never throws.
function migrateProjectMcpConfig() {
    try {
        const file = path.join(process.cwd(), '.mcp.json');
        if (!exists(file)) return null;
        const raw = fs.readFileSync(file, 'utf8'); if (!raw.trim()) return null;
        let cfg; try { cfg = JSON.parse(raw); } catch { return null; }   // never touch invalid JSON
        const servers = cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : null;
        const entry = servers && servers['klypix-canvas'];
        if (!entry || (entry.command !== 'npx' && entry.command !== 'node')) return null;   // absent / hand-customized → leave it
        const args = Array.isArray(entry.args) ? entry.args : [];
        // A repo-relative node launch (for example scripts/klypix-mcp-server.mjs)
        // is deliberately portable and often tracks a project-owned bundle.
        // Never replace it with a machine-specific ~/.claude path.
        if (entry.command === 'node' && args[0] && !path.isAbsolute(String(args[0]))) return null;
        const vi = args.indexOf('--vault');
        const vault = vi >= 0 && args[vi + 1] ? args[vi + 1] : '.';
        const next = mcpServerEntry({ vault });   // local now that the bundle is installed
        if (JSON.stringify(entry) === JSON.stringify(next)) return null;   // already correct
        servers['klypix-canvas'] = next;
        try { fs.writeFileSync(file + '.klypix-bak', raw, 'utf8'); } catch { /* best-effort backup */ }
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        return { file, from: entry.command, to: next.command };
    } catch { return null; }
}

// ── Flatten: the repo's bin servers import '../src/…'; the flat runtime layout needs
// './…'. Also bake the version (the flat layout has no ../package.json). Mirrors
// scripts/sync-bundled-mcp.mjs in the KLYPIX repo. ──────────────────────────────
const flatten = (code) => code
    .replace(/from '\.\.\/src\/klypix-core\.mjs'/g, "from './klypix-core.mjs'")
    .replace(/from '\.\.\/src\/klypix-format\.mjs'/g, "from './klypix-format.mjs'")
    .replace(/\.\.\/src\/klypix-(core|format)\.mjs/g, './klypix-$1.mjs')
    // brain-doctor + agent-rules (the server's lazy `import('../src/brain-doctor.mjs')`
    // for the brain_doctor tool) → flat sibling refs in the runtime layout.
    .replace(/\.\.\/src\/(brain-doctor|agent-rules|mcp-presence)\.mjs/g, './$1.mjs')
    .replace(/const PKG_VERSION = \(\(\) => \{[\s\S]*?\}\)\(\);/, `const PKG_VERSION = '${VERSION}'; // baked at install (flat layout has no package.json)`);

const gotLock = acquireLock();
try {
    fs.mkdirSync(BRAIN_DIR, { recursive: true });
    // 1) runtime dependency CLOSURE (jszip+fractional-indexing for the hook/engine,
    //    @modelcontextprotocol/sdk+zod for the local MCP server). Resolve each via
    //    createRequire so it's found wherever the package manager put it — CRITICAL
    //    for `npx`, which HOISTS deps to its cache root (not PKG_ROOT/node_modules).
    //    Walk transitive deps resolved FROM each package's own context (handles
    //    nesting). @huggingface/transformers (optional, huge) is intentionally
    //    skipped — semantic recall degrades to lexical until the host warms it.
    // Resolve a package DIR by walking node_modules upward (Node-style): checks
    // fromDir/node_modules/<name>, then each parent — so it finds hoisted deps under
    // npx AND nested ones. fs-based on purpose: require.resolve('<name>/package.json')
    // is blocked by restrictive "exports" (e.g. fractional-indexing v3) and would
    // silently drop a dep the hook needs.
    const destMods = path.join(BRAIN_DIR, 'node_modules');
    const findPkgDir = (name, fromDir) => {
        // Follow linked/isolated package roots before walking upward. A host
        // can have AJV 6 at its app root while the linked MCP SDK resolves AJV
        // 8 beside its real package location; starting from the symlink path
        // would silently select the wrong major for the flat runtime.
        let dir;
        try { dir = fs.realpathSync(fromDir); } catch { dir = path.resolve(fromDir); }
        for (; ;) {
            const cand = path.join(dir, 'node_modules', ...name.split('/'));
            if (exists(path.join(cand, 'package.json'))) return cand;
            const parent = path.dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    };
    const seen = new Set();
    // @modelcontextprotocol/ext-apps powers the canvas_view MCP App; the server
    // treats it as OPTIONAL (lazy import, degrades to a text-only tool), so a
    // resolve failure here must NOT abort — it's queued but tolerated if missing.
    const OPTIONAL_DEPS = new Set(['@modelcontextprotocol/ext-apps']);
    const queue = ['jszip', 'fractional-indexing', '@modelcontextprotocol/sdk', 'zod', '@modelcontextprotocol/ext-apps'].map(name => ({ name, fromDir: PKG_ROOT }));
    let deps = 0; const missing = [];
    while (queue.length) {
        const { name, fromDir } = queue.shift();
        if (seen.has(name)) continue; seen.add(name);
        const dir = findPkgDir(name, fromDir);
        if (!dir) { if (!OPTIONAL_DEPS.has(name)) missing.push(name); continue; }
        if (!exists(path.join(destMods, name))) { copyDir(dir, path.join(destMods, name)); deps++; }
        try { const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); for (const d of Object.keys(pj?.dependencies || {})) queue.push({ name: d, fromDir: dir }); } catch { /* no readable package.json */ }
    }
    if (missing.length) { if (gotLock) releaseLock(); console.error(`✗ could not resolve required dep(s): ${missing.join(', ')} — aborting (the brain hook needs them).`); process.exit(1); }

    // 2) STAGE the scripts (engine + hook + flattened servers), write each to
    //    `<name>.klypix-new`, back up the current copy to .prev/, then atomically
    //    rename them into place — global-brain-hook.mjs LAST, so its engine + deps
    //    are already present the instant the entry point flips. Each file is always
    //    fully-old-or-fully-new (rename is atomic); a crash mid-pass leaves a
    //    version-skew-safe brain (the hook guards on missing engine exports), never
    //    a truncated hook. Deps (step 1) are additive and already in place.
    const staged = [];
    // canvas-view-app.html is the canvas_view MCP App UI — staged raw (an HTML
    // file must never get a JS-comment banner) beside the flat server, which
    // resolves it via its ./canvas-view-app.html candidate path.
    for (const f of ['global-brain-hook.mjs', 'brain-semantic.mjs', 'brain-note.mjs', 'brain-git-hook.mjs', 'klypix-format.mjs', 'klypix-core.mjs', 'agent-rules.mjs', 'brain-doctor.mjs', 'agent-presence.mjs', 'mcp-presence.mjs', 'codex-brain-hook.mjs', 'codex-hooks.mjs', 'canvas-view-app.html']) {
        const s = path.join(SRC, f); if (exists(s)) staged.push({ dst: f, content: fs.readFileSync(s, 'utf8') });
    }
    for (const [src, dst] of [
        ['klypix-mcp.mjs', 'klypix-mcp-server.mjs'],
        ['klypix-a2a.mjs', 'klypix-a2a-server.mjs'],
        ['klypix-conformance.mjs', 'klypix-conformance.mjs'],
    ]) {
        const s = path.join(BIN, src); if (exists(s)) staged.push({ dst, content: flatten(fs.readFileSync(s, 'utf8')) });
    }
    for (const st of staged) fs.writeFileSync(path.join(BRAIN_DIR, st.dst + '.klypix-new'), st.content);
    try {
        const prevDir = path.join(BRAIN_DIR, '.prev'); fs.mkdirSync(prevDir, { recursive: true });
        for (const st of staged) { const live = path.join(BRAIN_DIR, st.dst); if (exists(live)) fs.copyFileSync(live, path.join(prevDir, st.dst)); }
    } catch { /* .prev rollback snapshot is best-effort */ }
    const renameOrder = staged.slice().sort((a, b) => (a.dst === 'global-brain-hook.mjs' ? 1 : 0) - (b.dst === 'global-brain-hook.mjs' ? 1 : 0));
    let n = 0;
    for (const st of renameOrder) { fs.renameSync(path.join(BRAIN_DIR, st.dst + '.klypix-new'), path.join(BRAIN_DIR, st.dst)); n++; }

    // 3) mark the dir an ESM package
    fs.writeFileSync(path.join(BRAIN_DIR, 'package.json'), JSON.stringify({ name: 'klypix-project-brain', private: true, type: 'module' }, null, 2));

    // 5) wire the 4 hooks into settings.json (refuse on invalid JSON; back up; atomic)
    const brainCmd = (arg) => `node "${fwd(path.join(BRAIN_DIR, 'global-brain-hook.mjs'))}"${arg ? ' ' + arg : ''}`;
    const GROUPS = [
        ['SessionStart', { matcher: 'startup|resume', hooks: [{ type: 'command', command: brainCmd('') }] }],
        ['UserPromptSubmit', { hooks: [{ type: 'command', command: brainCmd('--prompt'), timeout: 10 }] }],
        ['Stop', { hooks: [{ type: 'command', command: brainCmd('--capture') }] }],
        ['PostToolUse', { matcher: 'Bash|PowerShell|Edit|Write', hooks: [{ type: 'command', command: brainCmd('--live'), timeout: 10 }] }],
    ];
    const stripOurs = (arr) => (Array.isArray(arr) ? arr : [])
        .map(g => (g && Array.isArray(g.hooks)) ? { ...g, hooks: g.hooks.filter(h => !(typeof h?.command === 'string' && h.command.includes(HOOK_MARK))) } : g)
        .filter(g => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
    let settings = {};
    let rawSettings = '';
    if (exists(SETTINGS)) {
        rawSettings = fs.readFileSync(SETTINGS, 'utf8');
        if (rawSettings.trim()) {
            try { settings = JSON.parse(rawSettings); }
            catch (e) { if (gotLock) releaseLock(); console.error(`✗ ${SETTINGS} is invalid JSON (${e.message}). Fix it and re-run — refusing to overwrite a broken config.`); process.exit(1); }
        }
    }
    if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
    for (const [evt, entry] of GROUPS) { const cleaned = stripOurs(settings.hooks[evt]); cleaned.push(JSON.parse(JSON.stringify(entry))); settings.hooks[evt] = cleaned; }
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    if (rawSettings) { try { fs.writeFileSync(SETTINGS + '.klypix-bak', rawSettings, 'utf8'); } catch { /* best-effort backup */ } }
    const tmp = SETTINGS + '.klypix-tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    JSON.parse(fs.readFileSync(tmp, 'utf8'));   // verify before swap
    fs.renameSync(tmp, SETTINGS);

    // 6) stamp the install (unified brain version → never-downgrade across channels)
    fs.writeFileSync(path.join(BRAIN_DIR, '.brain-version.json'), JSON.stringify({ brainVersion: VERSION, via: 'npm', dirty: false, installedAt: new Date().toISOString() }, null, 2));

    // 7) migrate THIS project's .mcp.json off npx onto the now-installed local bundle
    //    (heals an existing stale config so the next MCP server spawn runs current).
    const migrated = migrateProjectMcpConfig();

    // Codex needs native MCP tools, conditional guidance, and lifecycle presence.
    const codex = wireCodex();

    // 8) READINESS check — re-read what we just wrote and confirm all 4 hooks actually
    //    took (a malformed pre-existing group, a partial merge, or a later hand-edit can
    //    leave the brain LIVE but not LEARNING — liveness ≠ readiness). Warn, don't fail.
    const verify = (() => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return null; } })();
    const wiredFor = (evt) => Array.isArray(verify?.hooks?.[evt]) && verify.hooks[evt].some(g => Array.isArray(g?.hooks) && g.hooks.some(h => typeof h?.command === 'string' && h.command.includes(HOOK_MARK)));
    const notWired = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse'].filter(e => !wiredFor(e));

    if (gotLock) releaseLock();
    reportCodex(codex);
    console.log(`✓ installed klypix brain v${VERSION} → ${BRAIN_DIR}  (${n} scripts, ${deps} dep packages)`);
    if (!notWired.length) console.log('✓ wired 4 hooks: SessionStart · UserPromptSubmit (--prompt) · Stop (--capture) · PostToolUse (--live) → settings.json');
    else console.error(`⚠ readiness: ${notWired.length} hook(s) did NOT take (${notWired.join(', ')}) — the brain will read but not capture/sync. Re-run \`npx klypix-mcp install --force\` or check ${SETTINGS}.`);
    console.log(`✓ MCP server runs from the local bundle (node ${fwd(path.join(BRAIN_DIR, 'klypix-mcp-server.mjs'))}) — no npx cache, works offline, always the installed version.`);
    if (migrated) console.log(`✓ migrated ${migrated.file} klypix-canvas server: ${migrated.from} → ${migrated.to} (backup: .mcp.json.klypix-bak). Reconnect (/mcp) or restart to pick it up.`);
    console.log('  Claude Code keeps its existing auto-brief/capture hooks; Codex gets the brain_sync Context Gateway (compact task memory + clean peers + proactive/guaranteed conflict alerts) with no hook trust prompt.');
    console.log('  Enhanced Codex auto-context + pre-edit overlap guard: re-run with `--codex-hooks`, then approve/review KLYPIX once in a Codex surface that supports hook trust.');
    console.log('  ⚠ Open sessions keep their OLD server until relaunched: fully quit & reopen the app (a session resume / new chat does NOT respawn the MCP server). `brain_doctor`\'s RUNNING line confirms when you\'re current.');
    console.log('  Verify anytime: `npx klypix-mcp doctor`; prove two-client behavior with `npx klypix-mcp conformance`.');
} catch (e) {
    if (gotLock) releaseLock();
    console.error(`✗ install failed: ${e?.message || e}`);
    process.exit(1);
}
