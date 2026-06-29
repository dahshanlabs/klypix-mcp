// agent-rules — make a project's brain.klypix AUTOMATIC for EVERY agent tool, not
// just Claude Code. Claude Code gets the brain via hooks (settings.json, see
// klypix-install). Other agents (Cursor, Cline, Windsurf, Copilot/VS Code, and the
// AGENTS.md cross-tool standard) have no hook system — so we drop their NATIVE files:
//
//   • an MCP server config  → the agent CAN reach the brain's tools
//   • a rules / instructions → the agent is TOLD to read the brain at task start and
//                              capture decisions, on every session, automatically
//
// Agent-neutral by construction: the brain DATA is one shared brain.klypix; this just
// teaches each tool to use it. Idempotent — owned files are rewritten wholesale; shared
// files (AGENTS.md, copilot-instructions.md) get a fenced block merged in place, never
// clobbering the user's own content. Pure fs/path; never throws for one bad target.
import fs from 'fs';
import path from 'path';

const FENCE_START = '<!-- klypix-brain:start (managed by klypix-mcp — re-run `npx klypix-mcp link`) -->';
const FENCE_END = '<!-- klypix-brain:end -->';
const FENCE_RE = /<!--\s*klypix-brain:start[\s\S]*?klypix-brain:end\s*-->/;

// The one canonical instruction every agent gets. Tool-and-CLI dual so it works whether
// or not the agent has the klypix-canvas MCP wired.
const BRAIN_INSTRUCTIONS = `## KLYPIX project brain

This project has a **spatial brain** at \`./brain.klypix\` — the living memory of its
decisions, open questions, and findings (the shared human↔agent memory for this repo).
Treat it as authoritative project context.

**At the start of a task — read it** so you know the project's state and past decisions:
- with the \`klypix-canvas\` MCP server: call \`search_canvases\` / \`read_canvas\` (canvas: \`"brain"\`), or \`brain_insights\` for the load-bearing cards.
- or via CLI: \`npx klypix-read brain.klypix\`

**When you make a real decision, finding, or milestone — capture it** so it persists for the next session/agent:
- with MCP: call \`brain_note\` with a one-line decision, or
- emit a marker line in your output: \`🧠 BRAIN [Area]: <one-line decision>\`, or
- via CLI: \`echo "🧠 BRAIN [Area]: <decision>" | npx klypix-append brain.klypix\`

Capture **sparingly** — real decisions/milestones, not routine steps. Link related cards with \`[[other-card]]\`.

**Don't** hand-edit \`brain.klypix\` (it's a packaged canvas — use the tools) or dump file contents into it; capture the *decision*, not the file.`;

const fencedBlock = () => `${FENCE_START}\n${BRAIN_INSTRUCTIONS}\n${FENCE_END}`;

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const ensureDir = (p) => fs.mkdirSync(path.dirname(p), { recursive: true });

// Shared markdown (AGENTS.md, copilot-instructions.md): merge our fenced block in place.
function fenceMerge(file) {
  let cur = '';
  let had = false;
  if (exists(file)) { cur = fs.readFileSync(file, 'utf8'); had = true; }
  const block = fencedBlock();
  let next;
  let action;
  if (FENCE_RE.test(cur)) { next = cur.replace(FENCE_RE, block); action = 'updated'; }
  else if (cur.trim()) { next = cur.replace(/\s*$/, '') + '\n\n' + block + '\n'; action = 'merged'; }
  else { next = block + '\n'; action = had ? 'merged' : 'created'; }
  if (next === cur) return { action: 'unchanged' };
  ensureDir(file); fs.writeFileSync(file, next, 'utf8');
  return { action };
}

// Owned dedicated rules file: rewrite wholesale (optional frontmatter for always-apply).
function writeDedicated(file, frontmatter) {
  const body = (frontmatter ? frontmatter + '\n' : '') + fencedBlock() + '\n';
  if (exists(file) && fs.readFileSync(file, 'utf8') === body) return { action: 'unchanged' };
  ensureDir(file); fs.writeFileSync(file, body, 'utf8');
  return { action: exists(file) ? 'updated' : 'created' };
}

// Project-level MCP config: add the klypix-canvas server, preserving any sibling servers.
// wrapKey differs by tool: Cursor/Claude use "mcpServers"; VS Code uses "servers".
function mergeMcpJson(file, wrapKey, withType) {
  const entry = withType
    ? { type: 'stdio', command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '.'] }
    : { command: 'npx', args: ['-y', 'klypix-mcp', '--vault', '.'] };
  let cfg = {};
  if (exists(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim()) { try { cfg = JSON.parse(raw); } catch { return { action: 'skipped', why: 'invalid JSON — left untouched' }; } }
  }
  if (!cfg[wrapKey] || typeof cfg[wrapKey] !== 'object' || Array.isArray(cfg[wrapKey])) cfg[wrapKey] = {};
  const before = JSON.stringify(cfg[wrapKey]['klypix-canvas']);
  cfg[wrapKey]['klypix-canvas'] = entry;
  if (JSON.stringify(cfg[wrapKey]['klypix-canvas']) === before) return { action: 'unchanged' };
  ensureDir(file); fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { action: before === undefined ? 'created' : 'updated' };
}

/**
 * Wire a project so EVERY agent tool reads + captures its brain automatically.
 * @param {string} projectDir absolute project root (holds ./brain.klypix)
 * @returns {{ rules: Array, mcp: Array, hasBrain: boolean }}
 */
export function linkProject(projectDir) {
  const j = (...p) => path.join(projectDir, ...p);
  const hasBrain = exists(j('brain.klypix')) || exists(j('brain.any'));

  // ── Rules / instructions (the "automatically use the brain" half) ──────────────
  const rules = [
    // AGENTS.md — the emerging cross-tool standard (Codex, Jules, Zed, Cursor-also-reads…)
    { tool: 'AGENTS.md (cross-tool standard)', file: 'AGENTS.md', ...fenceMerge(j('AGENTS.md')) },
    // Cursor — dedicated always-applied rule
    { tool: 'Cursor', file: '.cursor/rules/klypix-brain.mdc', ...writeDedicated(j('.cursor', 'rules', 'klypix-brain.mdc'),
      '---\ndescription: KLYPIX project brain — read at task start, capture decisions\nalwaysApply: true\n---') },
    // Windsurf — dedicated always-on rule
    { tool: 'Windsurf', file: '.windsurf/rules/klypix-brain.md', ...writeDedicated(j('.windsurf', 'rules', 'klypix-brain.md'),
      '---\ntrigger: always_on\n---') },
    // Cline — drops a file in .clinerules/ (Cline reads every file there)
    { tool: 'Cline', file: '.clinerules/klypix-brain.md', ...writeDedicated(j('.clinerules', 'klypix-brain.md'), '') },
    // GitHub Copilot — repo-wide custom instructions
    { tool: 'GitHub Copilot', file: '.github/copilot-instructions.md', ...fenceMerge(j('.github', 'copilot-instructions.md')) },
  ];

  // ── MCP server config (the "can reach the brain's tools" half) ─────────────────
  // Project-level files only; Claude Code is covered by `install` (hooks + bundled MCP),
  // so we skip .mcp.json to avoid double-registering its server.
  const mcp = [
    { tool: 'Cursor', file: '.cursor/mcp.json', ...mergeMcpJson(j('.cursor', 'mcp.json'), 'mcpServers', false) },
    { tool: 'VS Code (Copilot/Continue)', file: '.vscode/mcp.json', ...mergeMcpJson(j('.vscode', 'mcp.json'), 'servers', true) },
  ];

  return { rules, mcp, hasBrain };
}

export { BRAIN_INSTRUCTIONS };
