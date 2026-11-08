// tool-profile — which MCP tools this server registers.
//
// Developers told us (100 personas surveyed, 16 before them) that "25+ tools in
// every prompt with no way to trim them" was their second-biggest blocker, so
// the server has a PROFILE: a small `core` set, or `all` (everything, as before),
// or an explicit comma list of tool names. The worker registers only the
// selected tools; nothing else changes (schemas, handlers, presence).
//
// Where the selection comes from, in priority order:
//   1. the environment variable KLYPIX_TOOLS, set by the MCP server entry an
//      editor launches (`npx klypix-mcp install` writes it — see below);
//   2. the default.
// There is no per-project setting: klypix-mcp reads no project config file of
// its own (`.klypix/rules.json` holds project RULES, not server settings), and
// inventing one for a single switch was not worth a new format.
//
// THE DEFAULT RULE (two halves, both deliberate):
//   • A server started WITHOUT KLYPIX_TOOLS runs `all`. Every install that
//     exists today — hand-written .mcp.json entries, Claude Desktop entries, the
//     Claude plugin (KLYPIX_PLUGIN=1 launches the pinned package with no env of
//     its own) — keeps every tool it has; nothing existing shrinks.
//   • `npx klypix-mcp install` writes KLYPIX_TOOLS=core into every MCP server
//     entry it CREATES (an entry that was not there before), in every editor
//     config it generates. An entry that already exists keeps the KLYPIX_TOOLS
//     it has (or has none, and stays `all`). `install --tools all|core|a,b,c`
//     writes that value into every entry it touches, existing ones included.
//
// A name in the list that is not a tool is reported on stderr and ignored. A
// list that names no known tool at all would start a server with no tools —
// useless and silent — so it falls back to `core` and says so.

export const TOOLS_ENV = 'KLYPIX_TOOLS';
export const DEFAULT_PROFILE = 'all';         // a server started without KLYPIX_TOOLS
export const NEW_INSTALL_PROFILE = 'core';    // what `install` writes into a NEW entry

export const CORE_TOOLS = Object.freeze([
  'brain_sync', 'brain_note', 'brain_ask', 'brain_message', 'brain_handoff', 'brain_rules',
]);

// Every tool the worker can register (bin/klypix-worker.mjs + src/app-tools.mjs),
// in registration order. Two are conditional: prepare_video is not registered in
// plugin mode (KLYPIX_PLUGIN=1) and show_in_klypix only where a KLYPIX app can
// run (Windows, or KLYPIX_APP_TOOLS=on). test/tool-profile.mjs checks this list
// against a real stdio handshake, so it cannot drift from the worker.
export const KNOWN_TOOLS = Object.freeze([
  'list_canvases', 'read_canvas', 'search_canvases', 'search_all_brains', 'brain_ask',
  'project_map_context', 'project_map_scan', 'project_map_drift',
  'brain_challenge', 'brain_insights', 'brain_lens', 'brain_connect', 'brain_reconcile', 'brain_garden',
  'create_canvas', 'add_to_canvas', 'prepare_video',
  'brain_note', 'brain_message', 'brain_message_receipt', 'brain_reopen', 'brain_handoff', 'brain_review',
  'brain_sync', 'brain_rules', 'brain_doctor', 'canvas_view',
  'klypix_status', 'read_card_contents', 'show_in_klypix',
]);

export const PROFILES = Object.freeze({ core: CORE_TOOLS, all: KNOWN_TOOLS });
const KNOWN = new Set(KNOWN_TOOLS);

/**
 * Parse a KLYPIX_TOOLS / --tools value.
 * Tokens are separated by commas (also `;` or whitespace), case-insensitive:
 * `all` → everything (names: null); `core` → the core set; a tool name → that
 * tool; anything else → unknown. Profile names and tool names may be mixed
 * (`core,brain_doctor`).
 * @returns {{ raw: string, profile: 'all'|'core'|'custom'|'empty', names: Set<string>|null, unknown: string[] }}
 */
export function parseToolSelection(raw) {
  const text = String(raw ?? '').trim();
  const tokens = text.split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const names = new Set();
  const unknown = [];
  let all = false;
  let core = false;
  for (const token of tokens) {
    if (token === 'all') all = true;
    else if (token === 'core') { core = true; for (const n of CORE_TOOLS) names.add(n); }
    else if (KNOWN.has(token)) names.add(token);
    else unknown.push(token);
  }
  if (all) return { raw: text, profile: 'all', names: null, unknown };
  if (!names.size) return { raw: text, profile: 'empty', names, unknown };
  const isCore = core && names.size === CORE_TOOLS.length;
  return { raw: text, profile: isCore ? 'core' : 'custom', names, unknown };
}

/**
 * The profile a server process runs with, from its environment.
 * @returns {{ profile: 'all'|'core'|'custom', names: Set<string>|null, source: 'env'|'default', raw: string, unknown: string[], warnings: string[] }}
 */
export function resolveToolProfile(env = process.env) {
  const raw = env?.[TOOLS_ENV];
  if (raw == null || !String(raw).trim()) {
    return { profile: DEFAULT_PROFILE, names: null, source: 'default', raw: '', unknown: [], warnings: [] };
  }
  const parsed = parseToolSelection(raw);
  const warnings = [];
  if (parsed.unknown.length) {
    warnings.push(`${TOOLS_ENV}: ${parsed.unknown.length === 1 ? 'not a KLYPIX tool, ignored' : 'not KLYPIX tools, ignored'}: ${parsed.unknown.join(', ')} (profiles: core, all; tools: ${KNOWN_TOOLS.join(', ')})`);
  }
  if (parsed.profile === 'empty') {
    warnings.push(`${TOOLS_ENV}="${parsed.raw}" names no KLYPIX tool — a server with no tools helps nobody, so the core profile is used (${CORE_TOOLS.join(', ')})`);
    return { profile: 'core', names: new Set(CORE_TOOLS), source: 'env', raw: parsed.raw, unknown: parsed.unknown, warnings, fellBack: true };
  }
  return { profile: parsed.profile, names: parsed.names, source: 'env', raw: parsed.raw, unknown: parsed.unknown, warnings };
}

/** Does this profile register the tool? (`names: null` = everything.) */
export const toolAllowed = (profile, name) => !profile?.names || profile.names.has(name);

/** Short label: `all` · `core (6 tools)` · `custom (3 tools)`. */
export function toolProfileLabel(profile) {
  if (!profile?.names) return 'all';
  return `${profile.profile} (${profile.names.size} tool${profile.names.size === 1 ? '' : 's'})`;
}

/**
 * The sentence the server adds to its MCP instructions when it runs a reduced
 * profile, so an agent reading a project instruction block that names a tool
 * this connection does not have knows why, and what to ask for.
 */
export function toolProfileInstructions(profile) {
  if (!profile?.names) return '';
  const names = [...profile.names].join(', ');
  return `This connection runs the KLYPIX "${profile.profile}" tool profile: only ${names} ${profile.names.size === 1 ? 'is' : 'are'} registered. Other KLYPIX tools named in project instructions are not available on this connection; to use them the person runs \`npx klypix-mcp install --tools all\` (or sets ${TOOLS_ENV}=all in the server's env) and reconnects.`;
}

/**
 * The env an MCP server entry gets. An entry keeps the env it already has (a
 * re-link never changes a person's choice); `tools.value` is written when the
 * entry is new, or always when `tools.onlyNew` is false.
 * @param {object|undefined} existingEnv  the entry's current env, if any
 * @param {{ value: string, onlyNew?: boolean }|null|undefined} tools  the policy
 * @param {boolean} isNew  whether the entry did not exist before this write
 */
export function entryEnvWithTools(existingEnv, tools, isNew) {
  const env = {};
  if (existingEnv && typeof existingEnv === 'object' && !Array.isArray(existingEnv)) {
    for (const [key, value] of Object.entries(existingEnv)) if (typeof value === 'string') env[key] = value;
  }
  if (tools?.value && (!tools.onlyNew || isNew)) env[TOOLS_ENV] = String(tools.value);
  return env;
}
