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
//   npx klypix-mcp install --allow-untagged  # acknowledge deploying an UNTAGGED source checkout
//                                            # (dev deploy; also KLYPIX_MCP_ALLOW_UNTAGGED=1)
//
// Never-throws-silently: it's an explicit CLI, so it reports what it did and exits
// non-zero on a real failure. Never wires a broken settings.json (refuse + restore).
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
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
import { brainInstallDecision, deploySourceDecision } from '../src/install-version.mjs';
import { acquireInstallLockSync, releaseInstallLockSync } from '../src/install-lock.mjs';
import { collectRepoState } from '../src/repo-state.mjs';
import { runSetup, renderBrief } from '../src/setup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(PKG_ROOT, 'src');
const BIN = path.join(PKG_ROOT, 'bin');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || ''; } catch { return ''; } })();
// ARGV: flag lookup is position-independent, so this file is correct for both
// `klypix-install --force` and `klypix-mcp install --force` (the dispatcher splices
// its verb out before importing — see bin/klypix-worker.mjs runVerb). It takes no
// positional argument; if one is ever added, read process.argv.slice(2) so both
// invocation shapes stay identical (locked by test/cli-args.mjs).
const FORCE = process.argv.includes('--force');
const CODEX_HOOKS = process.argv.includes('--codex-hooks');
const RUNTIME_ONLY = process.argv.includes('--runtime-only');
// Project wiring is the default because it is the step users did not know
// existed. These opt OUT for the cases that genuinely want machine-only:
// CI images, scripted provisioning, and anyone wiring the project by hand.
const NO_PROJECT = process.argv.includes('--no-project');
const VERIFY_ALL = process.argv.includes('--verify-all');
const SETUP_JSON = process.argv.includes('--json');
// Released-tag deploy-guard acknowledgement. Deliberately a SEPARATE axis from
// --force: --force is destination authority (overwrite what is installed),
// this is source authority (knowingly deploy an untagged working tree).
const ALLOW_UNTAGGED = process.argv.includes('--allow-untagged')
    || process.env.KLYPIX_MCP_ALLOW_UNTAGGED === '1';

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const BRAIN_DIR = process.env.KLYPIX_MCP_INSTALL_DIR
    ? path.resolve(process.env.KLYPIX_MCP_INSTALL_DIR)
    : path.join(CLAUDE_DIR, 'project-brain');
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
    const boundProject = projectDir.replace(/\\/g, '/');
    const mcp = hasProjectBrain
        ? connectCodexMcpServer({
            configPath: projectConfig,
            // Codex app/extension hosts do not consistently resolve a relative
            // project `cwd` from the active chat workspace. Bind both the
            // process and KLYPIX vault to this exact project on this machine.
            entry: mcpServerEntry({ vault: boundProject }),
            cwd: boundProject,
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

// ── Install lock (auto-propagation, part D — concurrency) ─────────────────────
// npm and desktop use this exact token-owned lock. The version decision is made
// only AFTER acquisition, so an older queued installer re-reads and preserves a
// newer runtime that committed while it waited.

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
    .replace(/\.\.\/src\/(bench|brain-doctor|agent-presence|agent-rules|finding-routing|mcp-presence|mcp-supervisor|mcp-auto-update|presence-relay|semantic-memory|runtime-inspector|project-graph|git-capture-install|remote-client)\.mjs/g, './$1.mjs')
    .replace(/klypix-worker\.mjs/g, 'klypix-mcp-worker.mjs')
    .replace(/const PKG_VERSION = \(\(\) => \{[\s\S]*?\}\)\(\);/, `const PKG_VERSION = '${VERSION}'; // baked at install (flat layout has no package.json)`);

const installLock = acquireInstallLockSync(BRAIN_DIR);
if (!installLock) {
    console.error(`✗ another KLYPIX install still owns ${path.join(BRAIN_DIR, '.install.lock')}; no files were changed`);
    process.exit(1);
}
try {
    // Never-downgrade gate: Brain Core semver is the unified payload identity.
    // Read both receipts under the shared lock and conservatively keep the
    // highest valid committed/recorded version. appVersion is provenance only.
    const stamp = (() => { try { return JSON.parse(fs.readFileSync(path.join(BRAIN_DIR, '.brain-version.json'), 'utf8')); } catch { return null; } })();
    const runtimeReceipt = (() => { try { return JSON.parse(fs.readFileSync(path.join(BRAIN_DIR, '.mcp-runtime.json'), 'utf8')); } catch { return null; } })();
    const decision = brainInstallDecision({ candidateVersion: VERSION, stamp, runtime: runtimeReceipt, force: FORCE });
    if (decision.action === 'refuse') {
        releaseInstallLockSync(installLock);
        console.error(`✗ package Brain Core version ${JSON.stringify(VERSION)} is invalid; refusing to install unidentified runtime files`);
        process.exit(1);
    }
    if (decision.action === 'preserve') {
        releaseInstallLockSync(installLock);
        if (decision.reason === 'dev-owned') {
            console.log(`• A dev deploy owns ${BRAIN_DIR} (dev:true) — leaving it untouched. Re-run with --force to override.`);
        } else {
            console.log(`• Installed brain v${decision.installedVersion} is newer than this package v${VERSION} — not downgrading. Re-run with --force to override.`);
        }
        if (!RUNTIME_ONLY) reportCodex(wireCodex());
        process.exit(0);
    }

    // ── Released-tag deploy guard (2026-08-14 bundle-currency incident) ──────
    // A source checkout whose HEAD does not carry the release tag for its own
    // package version is UNRELEASED code, yet this installer used to lay it
    // down machine-globally with receipts claiming a clean npm delivery — the
    // exact twin of the desktop near-miss that shipped this wave. Only
    // PKG_ROOT's own git state is interrogated (never process.cwd(): the
    // auto-update child runs the installer with the PROJECT as cwd), and only
    // when PKG_ROOT itself contains a .git entry — an npm/npx tarball install
    // has none and IS the released artifact, so it stays exempt; the registry
    // channel is already tag-bound by publish.yml. The tag must point at HEAD
    // (`git tag --points-at HEAD` semantics inside collectRepoState): the
    // release tag names the exact evidence commit, so any non-HEAD comparison
    // would certify code the tag never covered.
    const checkout = exists(path.join(PKG_ROOT, '.git')) ? collectRepoState(PKG_ROOT) : null;
    const sourceDecision = deploySourceDecision({ checkout, allowUntagged: ALLOW_UNTAGGED });
    const checkoutLabel = `v${VERSION}, branch ${checkout?.branch || '(detached)'}, head ${checkout?.headShort || '?'}`;
    if (sourceDecision.action === 'refuse') {
        releaseInstallLockSync(installLock);
        console.error(`✗ refusing to deploy an UNRELEASED source checkout machine-globally: ${checkoutLabel} — no release tag v${VERSION} at HEAD; no files were changed.`);
        console.error('  Released installs come from the registry: npx -y klypix-mcp@latest install');
        console.error('  To deliberately deploy this working tree (a dev deploy), acknowledge it: re-run with --allow-untagged or KLYPIX_MCP_ALLOW_UNTAGGED=1.');
        console.error('  An acknowledged dev deploy is stamped dev-owned, so brain_doctor shows it and auto-update will not silently replace it.');
        process.exit(1);
    }
    const untaggedSource = sourceDecision.source === 'untagged-working-tree';
    // Deploy-time snapshot for ANY git-checkout deploy (tagged or acknowledged-
    // untagged): the release tag certifies HEAD's bytes, not the working
    // tree's, so uncommitted changes make even a TAGGED deploy differ from
    // what was released — a clean `dirty:false` stamp would lie about exactly
    // that (the receipt-honesty defect this wave exists to kill). An
    // unreadable status degrades to false rather than inventing a DIRTY nag
    // in every session brief. Tarball installs (checkout null) skip the spawn.
    const sourceDirty = Boolean(checkout) && (() => {
        try {
            return execFileSync('git', ['status', '--porcelain'], {
                cwd: PKG_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500,
            }).trim().length > 0;
        } catch { return false; }
    })();
    if (untaggedSource) {
        console.log(`• untagged source deploy acknowledged: ${checkoutLabel}${sourceDirty ? ' (working tree DIRTY)' : ''} — receipts record a dev-owned install; a later released install needs --force.`);
    } else if (sourceDirty) {
        console.log(`⚠ release-tagged checkout has uncommitted changes (${checkoutLabel}) — deployed bytes differ from the release; stamping dirty:true so brain_doctor surfaces it.`);
    }

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
    if (missing.length) { releaseInstallLockSync(installLock); console.error(`✗ could not resolve required dep(s): ${missing.join(', ')} — aborting (the brain hook needs them).`); process.exit(1); }

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
    for (const f of ['global-brain-hook.mjs', 'brain-semantic.mjs', 'semantic-memory.mjs', 'brain-note.mjs', 'brain-git-hook.mjs', 'git-capture-install.mjs', 'brain-history.mjs', 'brain-graveyard.mjs', 'klypix-format.mjs', 'klypix-core.mjs', 'brain-write-lock.mjs', 'agent-rules.mjs', 'brain-doctor.mjs', 'agent-presence.mjs', 'mcp-presence.mjs', 'repo-state.mjs', 'result-reconcile.mjs', 'finding-routing.mjs', 'presence-relay.mjs', 'mcp-supervisor.mjs', 'mcp-auto-update.mjs', 'runtime-inspector.mjs', 'project-graph.mjs', 'remote-client.mjs', 'bench.mjs', 'codex-brain-hook.mjs', 'codex-hooks.mjs', 'canvas-view-app.html']) {
        const s = path.join(SRC, f); if (exists(s)) staged.push({ dst: f, content: fs.readFileSync(s, 'utf8') });
    }
    for (const [src, dst] of [
        ['klypix-mcp.mjs', 'klypix-mcp-server.mjs'],
        ['klypix-worker.mjs', 'klypix-mcp-worker.mjs'],
        ['klypix-a2a.mjs', 'klypix-a2a-server.mjs'],
        ['klypix-conformance.mjs', 'klypix-conformance.mjs'],
        ['klypix-runtime.mjs', 'klypix-runtime.mjs'],
        ['klypix-semantic-warm.mjs', 'klypix-semantic-warm.mjs'],
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

    // 5) wire the 4 hooks into settings.json (refuse on invalid JSON; back up;
    // atomic). A background runtime-only update refreshes the scripts while
    // deliberately preserving every host/project config byte.
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
    if (!RUNTIME_ONLY && exists(SETTINGS)) {
        rawSettings = fs.readFileSync(SETTINGS, 'utf8');
        if (rawSettings.trim()) {
            try { settings = JSON.parse(rawSettings); }
            catch (e) { releaseInstallLockSync(installLock); console.error(`✗ ${SETTINGS} is invalid JSON (${e.message}). Fix it and re-run — refusing to overwrite a broken config.`); process.exit(1); }
        }
    }
    if (!RUNTIME_ONLY) {
        if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
        for (const [evt, entry] of GROUPS) { const cleaned = stripOurs(settings.hooks[evt]); cleaned.push(JSON.parse(JSON.stringify(entry))); settings.hooks[evt] = cleaned; }
        fs.mkdirSync(CLAUDE_DIR, { recursive: true });
        if (rawSettings) { try { fs.writeFileSync(SETTINGS + '.klypix-bak', rawSettings, 'utf8'); } catch { /* best-effort backup */ } }
        const tmp = SETTINGS + '.klypix-tmp';
        fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
        JSON.parse(fs.readFileSync(tmp, 'utf8'));   // verify before swap
        fs.renameSync(tmp, SETTINGS);
    }

    // 6) Commit the runtime pointer and version receipt atomically while the
    // shared cross-channel lock is still held. The runtime receipt goes first;
    // a crash between receipts remains recoverable because the next installer
    // compares both and keeps the highest valid Brain Core version.
    const installedAt = new Date().toISOString();
    // Receipt honesty (2026-08-14): an acknowledged untagged source deploy is
    // a DEV delivery — stamping it 'npm'/dirty:false made unreleased code
    // byte-for-byte indistinguishable from a released install. 'dev' is
    // existing receipt vocabulary (brainInstallDecision's dev-owned preserve,
    // auto-update's dev skip, doctor's channel/dev/dirty rendering all consume
    // it); sourceSha/branch are additive fields for post-hoc audit. dev:true
    // goes in BOTH receipts because the runtime receipt commits first — a
    // crash between the two writes must not leave a dev deploy unmarked.
    const runtime = {
        protocol: 1,
        version: VERSION,
        worker: 'klypix-mcp-worker.mjs',
        channel: untaggedSource ? 'dev' : 'npm',
        ...(untaggedSource ? { dev: true, sourceSha: checkout?.headShort || null, branch: checkout?.branch || null } : {}),
        installedAt,
        files: Object.fromEntries(staged.map(st => [st.dst, crypto.createHash('sha256').update(st.content).digest('hex')])),
    };
    const runtimePath = path.join(BRAIN_DIR, '.mcp-runtime.json');
    fs.writeFileSync(runtimePath + '.klypix-new', JSON.stringify(runtime, null, 2) + '\n', 'utf8');
    fs.renameSync(runtimePath + '.klypix-new', runtimePath);
    // A tagged-but-DIRTY checkout keeps via:'npm' (the tag still names the
    // payload identity, and dev:true would stop auto-update from healing the
    // machine back to clean released bytes) but stamps dirty:true + the audit
    // fields — doctor's DIRTY line and the hook's dirty nag both read the
    // stamp. The clean released path stays byte-identical to pre-guard.
    const versionStamp = untaggedSource
        ? { brainVersion: VERSION, via: 'dev', dev: true, dirty: sourceDirty, sourceSha: checkout?.headShort || null, branch: checkout?.branch || null, installedAt }
        : sourceDirty
            ? { brainVersion: VERSION, via: 'npm', dirty: true, sourceSha: checkout?.headShort || null, branch: checkout?.branch || null, installedAt }
            : { brainVersion: VERSION, via: 'npm', dirty: false, installedAt };
    const versionPath = path.join(BRAIN_DIR, '.brain-version.json');
    fs.writeFileSync(versionPath + '.klypix-new', JSON.stringify(versionStamp, null, 2), 'utf8');
    fs.renameSync(versionPath + '.klypix-new', versionPath);

    // 7) migrate THIS project's .mcp.json off npx onto the now-installed local bundle
    //    (heals an existing stale config so the next MCP server spawn runs current).
    const migrated = RUNTIME_ONLY ? null : migrateProjectMcpConfig();

    // Codex needs native MCP tools, conditional guidance, and lifecycle presence.
    const codex = RUNTIME_ONLY ? null : wireCodex();

    // 8) READINESS check — re-read what we just wrote and confirm all 4 hooks actually
    //    took (a malformed pre-existing group, a partial merge, or a later hand-edit can
    //    leave the brain LIVE but not LEARNING — liveness ≠ readiness). Warn, don't fail.
    const verify = RUNTIME_ONLY ? null : (() => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return null; } })();
    const wiredFor = (evt) => Array.isArray(verify?.hooks?.[evt]) && verify.hooks[evt].some(g => Array.isArray(g?.hooks) && g.hooks.some(h => typeof h?.command === 'string' && h.command.includes(HOOK_MARK)));
    const notWired = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse'].filter(e => !wiredFor(e));

    releaseInstallLockSync(installLock);
    // Users who already enabled the optional local semantic runtime should not
    // pay a multi-minute first question after a model/cache contract upgrade.
    // Migrate registered brains once in a detached process after the atomic
    // runtime commit. Fresh lexical-only installs download nothing.
    let semanticWarm = 'not-enabled';
    const semanticRuntime = path.join(BRAIN_DIR, 'semantic', 'node_modules', '@huggingface', 'transformers');
    if (process.env.KLYPIX_SEMANTIC_WARM_ON_UPDATE !== '0' && exists(semanticRuntime)) {
        try {
            const warmArgs = [path.join(BRAIN_DIR, 'klypix-semantic-warm.mjs'), '--brain-dir', BRAIN_DIR];
            const currentBrain = ['brain.klypix', 'brain.any'].map(name => path.join(process.cwd(), name)).find(exists);
            if (currentBrain) warmArgs.push('--brain', currentBrain);
            const warm = spawn(process.execPath, warmArgs, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                env: { ...process.env, KLYPIX_SEMANTIC_WARM_ON_UPDATE: '1' },
            });
            warm.unref();
            semanticWarm = 'scheduled';
        } catch { semanticWarm = 'deferred'; }
    }
    if (!RUNTIME_ONLY) reportCodex(codex);
    console.log(`✓ installed klypix brain v${VERSION} → ${BRAIN_DIR}  (${n} scripts, ${deps} dep packages)`);
    if (RUNTIME_ONLY) console.log('✓ runtime-only update: host settings and project files were preserved');
    else if (!notWired.length) console.log('✓ wired 4 hooks: SessionStart · UserPromptSubmit (--prompt) · Stop (--capture) · PostToolUse (--live) → settings.json');
    else console.error(`⚠ readiness: ${notWired.length} hook(s) did NOT take (${notWired.join(', ')}) — the brain will read but not capture/sync. Re-run \`npx klypix-mcp install --force\` or check ${SETTINGS}.`);
    console.log(`✓ MCP supervisor runs from the local bundle (node ${fwd(path.join(BRAIN_DIR, 'klypix-mcp-server.mjs'))}) — compatible core updates activate without restarting the host.`);
    if (migrated) console.log(`✓ migrated ${migrated.file} klypix-canvas server: ${migrated.from} → ${migrated.to} (backup: .mcp.json.klypix-bak). Reconnect (/mcp) or restart to pick it up.`);
    if (!RUNTIME_ONLY) {
        console.log('  Claude Code keeps its existing auto-brief/capture hooks; Codex gets the brain_sync Context Gateway (compact task memory + clean peers + proactive/guaranteed conflict alerts) with no hook trust prompt.');
        console.log('  Enhanced Codex auto-context + pre-edit overlap guard: re-run with `--codex-hooks`, then approve/review KLYPIX once in a Codex surface that supports hook trust.');
    }
    console.log('  Compatible brain-core updates hot-swap behind the same MCP connection. Only the one-time legacy→supervisor migration, a supervisor change, or an intentionally breaking tool/protocol change needs reconnect.');

    // 9) PROJECT setup (1.71.0) — the step users never knew they had to take.
    //    `install` wired the machine; without this it wired nothing a Cursor,
    //    Antigravity, Codex, Cline or Copilot user could see, and the failure
    //    was silent. A runtime-only refresh deliberately skips it: that path
    //    exists to preserve every host/project config byte.
    if (!RUNTIME_ONLY && !NO_PROJECT) {
        try {
            const report = await runSetup({ verifyAll: VERIFY_ALL });
            if (SETUP_JSON) console.log(JSON.stringify(report, null, 2));
            else console.log(renderBrief(report));
        } catch (e) {
            // The machine install already succeeded and is independently
            // useful; a project-wiring failure must report itself, not undo it.
            console.error(`⚠ project setup could not finish: ${e?.message || e}`);
            console.error('  The machine install is intact — re-run inside your project, or use `npx klypix-mcp link`.');
        }
    }
    console.log('  Verify anytime: `npx klypix-mcp doctor`; prove two-client behavior with `npx klypix-mcp conformance`.');
} catch (e) {
    releaseInstallLockSync(installLock);
    console.error(`✗ install failed: ${e?.message || e}`);
    process.exit(1);
}
