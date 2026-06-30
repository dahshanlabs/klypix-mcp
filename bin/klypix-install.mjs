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
//
// Never-throws-silently: it's an explicit CLI, so it reports what it did and exits
// non-zero on a real failure. Never wires a broken settings.json (refuse + restore).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(PKG_ROOT, 'src');
const BIN = path.join(PKG_ROOT, 'bin');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || ''; } catch { return ''; } })();
const FORCE = process.argv.includes('--force');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const BRAIN_DIR = path.join(CLAUDE_DIR, 'project-brain');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_MARK = 'global-brain-hook';
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const fwd = (p) => p.replace(/\\/g, '/');
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name), d = path.join(dest, e.name);
        if (e.isDirectory()) copyDir(s, d); else if (e.isFile()) fs.copyFileSync(s, d);
    }
}

// ── Never-downgrade gate ─────────────────────────────────────────────────────
// The brain version is a UNIFIED namespace = the klypix-mcp version, stamped by BOTH
// the npm install (here) and the desktop bundle, so the two channels compare cleanly.
// A dev deploy ({dev:true}) is authoritative; a strictly-newer install is not
// downgraded. --force overrides both.
const cmpSemver = (a, b) => { const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); } return 0; };
const cur = (() => { try { return JSON.parse(fs.readFileSync(path.join(BRAIN_DIR, '.brain-version.json'), 'utf8')); } catch { return null; } })();
if (!FORCE && cur) {
    if (cur.dev === true) { console.log(`• A dev deploy owns ${BRAIN_DIR} (dev:true) — leaving it untouched. Re-run with --force to override.`); process.exit(0); }
    if (cur.brainVersion && cmpSemver(cur.brainVersion, VERSION) > 0) { console.log(`• Installed brain v${cur.brainVersion} is newer than this package v${VERSION} — not downgrading. Re-run with --force to override.`); process.exit(0); }
}

// ── Flatten: the repo's bin servers import '../src/…'; the flat runtime layout needs
// './…'. Also bake the version (the flat layout has no ../package.json). Mirrors
// scripts/sync-bundled-mcp.mjs in the KLYPIX repo. ──────────────────────────────
const flatten = (code) => code
    .replace(/from '\.\.\/src\/klypix-core\.mjs'/g, "from './klypix-core.mjs'")
    .replace(/from '\.\.\/src\/klypix-format\.mjs'/g, "from './klypix-format.mjs'")
    .replace(/\.\.\/src\/klypix-(core|format)\.mjs/g, './klypix-$1.mjs')
    .replace(/const PKG_VERSION = \(\(\) => \{[\s\S]*?\}\)\(\);/, `const PKG_VERSION = '${VERSION}'; // baked at install (flat layout has no package.json)`);

try {
    fs.mkdirSync(BRAIN_DIR, { recursive: true });
    // 1) flat engine + hook scripts (their imports are already './…' → verbatim)
    let n = 0;
    for (const f of ['global-brain-hook.mjs', 'brain-semantic.mjs', 'brain-note.mjs', 'brain-git-hook.mjs', 'klypix-format.mjs', 'klypix-core.mjs']) {
        const s = path.join(SRC, f); if (exists(s)) { fs.writeFileSync(path.join(BRAIN_DIR, f), fs.readFileSync(s, 'utf8')); n++; }
    }
    // 2) the two servers, flattened to the *-server.mjs names the runtime/config expect
    for (const [src, dst] of [['klypix-mcp.mjs', 'klypix-mcp-server.mjs'], ['klypix-a2a.mjs', 'klypix-a2a-server.mjs']]) {
        const s = path.join(BIN, src); if (exists(s)) { fs.writeFileSync(path.join(BRAIN_DIR, dst), flatten(fs.readFileSync(s, 'utf8'))); n++; }
    }
    // 3) runtime dependency CLOSURE (jszip+fractional-indexing for the hook/engine,
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
        let dir = fromDir;
        for (; ;) {
            const cand = path.join(dir, 'node_modules', ...name.split('/'));
            if (exists(path.join(cand, 'package.json'))) return cand;
            const parent = path.dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    };
    const seen = new Set();
    const queue = ['jszip', 'fractional-indexing', '@modelcontextprotocol/sdk', 'zod'].map(name => ({ name, fromDir: PKG_ROOT }));
    let deps = 0; const missing = [];
    while (queue.length) {
        const { name, fromDir } = queue.shift();
        if (seen.has(name)) continue; seen.add(name);
        const dir = findPkgDir(name, fromDir);
        if (!dir) { missing.push(name); continue; }
        if (!exists(path.join(destMods, name))) { copyDir(dir, path.join(destMods, name)); deps++; }
        try { const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); for (const d of Object.keys(pj?.dependencies || {})) queue.push({ name: d, fromDir: dir }); } catch { /* no readable package.json */ }
    }
    if (missing.length) { console.error(`✗ could not resolve required dep(s): ${missing.join(', ')} — aborting (the brain hook needs them).`); process.exit(1); }
    // 4) mark the dir an ESM package
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
            catch (e) { console.error(`✗ ${SETTINGS} is invalid JSON (${e.message}). Fix it and re-run — refusing to overwrite a broken config.`); process.exit(1); }
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

    // 7) READINESS check — re-read what we just wrote and confirm all 4 hooks actually
    //    took (a malformed pre-existing group, a partial merge, or a later hand-edit can
    //    leave the brain LIVE but not LEARNING — liveness ≠ readiness). Warn, don't fail.
    const verify = (() => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return null; } })();
    const wiredFor = (evt) => Array.isArray(verify?.hooks?.[evt]) && verify.hooks[evt].some(g => Array.isArray(g?.hooks) && g.hooks.some(h => typeof h?.command === 'string' && h.command.includes(HOOK_MARK)));
    const notWired = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse'].filter(e => !wiredFor(e));

    console.log(`✓ installed klypix brain v${VERSION} → ${BRAIN_DIR}  (${n} scripts, ${deps} dep packages)`);
    if (!notWired.length) console.log('✓ wired 4 hooks: SessionStart · UserPromptSubmit (--prompt) · Stop (--capture) · PostToolUse (--live) → settings.json');
    else console.error(`⚠ readiness: ${notWired.length} hook(s) did NOT take (${notWired.join(', ')}) — the brain will read but not capture/sync. Re-run \`npx klypix-mcp install --force\` or check ${SETTINGS}.`);
    console.log('  Every project with a ./brain.klypix now auto-reads its brief + captures decisions. Restart open Claude Code sessions to load the hooks.');
    console.log('  Verify anytime: `npx klypix-mcp doctor` (is the brain current + wired + in sync, who else is live).');
} catch (e) {
    console.error(`✗ install failed: ${e?.message || e}`);
    process.exit(1);
}
