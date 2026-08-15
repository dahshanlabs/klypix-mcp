// Which agent tools does this machine ACTUALLY have?
//
// Before 1.71 `link` projected all 14 managed files into every project, for
// every supported host, whether or not the user had ever installed it. Those
// files get COMMITTED, so a two-person team using one editor shipped rules and
// MCP config for six they had never opened — repo clutter that reads as noise
// in review and makes the tool look presumptuous on first contact.
//
// This module answers the narrower question the projection should have been
// asking: is this host present on this machine? Detection is deliberately
// EVIDENCE-BASED and conservative — every positive names the path or variable
// that produced it (`why`), so a wrong answer is auditable rather than
// mysterious. Absence is never proof; the caller pairs this with the
// project-level signal (a target file already committed) and keeps projecting
// anything a teammate already relies on.
//
// Pure except for fs existence checks, and every environment input is
// injectable so the whole matrix is testable without touching a real home dir.
import fs from 'fs';
import path from 'path';
import os from 'os';

/** Roaming-config root per platform — where Electron editors keep their profile. */
export function appDataDir({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME || path.join(home, '.config');
}

// Extension hosts whose extension folders we scan for editor PLUGINS (Cline,
// Copilot). VS Code forks keep the same `<publisher>.<name>-<version>` layout.
const EXTENSION_ROOTS = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.vscode-oss'];

/**
 * The detection matrix. Each entry lists independent signals; ANY hit is a
 * positive, because a user may have a CLI without the GUI or vice versa.
 *  - home:  dot-dirs/files directly under the home directory
 *  - app:   profile directory names under the platform's roaming-config root
 *  - ext:   installed-extension id patterns (for plugin-shaped hosts)
 *  - env:   environment variables an editor exports into its own terminal —
 *           the strongest signal available, since it means we are running
 *           INSIDE that editor right now
 */
const EDITORS = [
  { id: 'claude-code', name: 'Claude Code', home: ['.claude'], env: ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID'] },
  { id: 'cursor', name: 'Cursor', home: ['.cursor'], app: ['Cursor'], env: ['CURSOR_SESSION_ID', 'CURSOR_TRACE_ID'] },
  { id: 'codex', name: 'Codex', home: ['.codex'], env: ['CODEX_THREAD_ID'] },
  { id: 'gemini-cli', name: 'Gemini CLI', home: ['.gemini'] },
  { id: 'antigravity', name: 'Antigravity', home: ['.antigravity'], app: ['Antigravity'] },
  { id: 'vscode', name: 'VS Code', home: ['.vscode', '.vscode-insiders'], app: ['Code', 'Code - Insiders', 'VSCodium'] },
  { id: 'windsurf', name: 'Windsurf', home: ['.windsurf'], app: ['Windsurf'], env: ['WINDSURF_SESSION_ID'] },
  { id: 'cline', name: 'Cline', ext: [/^saoudrizwan\.claude-dev/i], env: ['CLINE_SESSION_ID'] },
  { id: 'copilot', name: 'GitHub Copilot', ext: [/^github\.copilot/i] },
  { id: 'aider', name: 'Aider', home: ['.aider', '.aider.conf.yml', '.aider.model.settings.yml'] },
];

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/** Installed extension ids across every VS Code-shaped host on this machine. */
function installedExtensions(home) {
  const ids = [];
  for (const root of EXTENSION_ROOTS) {
    const dir = path.join(home, root, 'extensions');
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      ids.push({ id: e.name, from: `${root}/extensions/${e.name}` });
    }
  }
  return ids;
}

/**
 * Detect the agent tools present on this machine.
 * @param {{ home?: string, platform?: string, env?: object }} [opts]
 * @returns {{ present: Map<string,{id,name,why}>, absent: Array<{id,name}>, all: Array }}
 */
export function detectEditors(opts = {}) {
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const appRoot = appDataDir({ platform, home, env });

  // Scanned once — readdir on up to five extension roots is the only
  // non-trivial cost in this module, and most machines have one or two.
  let extensions = null;
  const getExtensions = () => (extensions ??= installedExtensions(home));

  const present = new Map();
  const absent = [];

  for (const ed of EDITORS) {
    let why = null;

    for (const key of ed.env || []) {
      if (env[key]) { why = `running inside it (${key})`; break; }
    }
    if (!why) for (const dir of ed.home || []) {
      if (exists(path.join(home, dir))) { why = `~/${dir}`; break; }
    }
    if (!why) for (const dir of ed.app || []) {
      if (exists(path.join(appRoot, dir))) { why = `${path.basename(appRoot)}/${dir}`; break; }
    }
    if (!why && ed.ext) {
      const hit = getExtensions().find((x) => ed.ext.some((re) => re.test(x.id)));
      if (hit) why = hit.from;
    }

    if (why) present.set(ed.id, { id: ed.id, name: ed.name, why });
    else absent.push({ id: ed.id, name: ed.name });
  }

  return { present, absent, all: EDITORS.map((e) => ({ id: e.id, name: e.name })) };
}

export { EDITORS };
