// Provider-neutral project-graph adapter, plus KLYPIX's own native scanner.
//
// Graphify is the first supported external producer, but callers only see the
// stable KLYPIX shape below. Since 1.61.0 the module can also PRODUCE a map
// itself — scanNativeProjectMap walks the repo and extracts file-level import
// edges with zero third-party installs, writing only into its own artifact
// dir (klypix-map/). Nothing here ever runs Graphify, edits source files, or
// writes into brain.klypix.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { parseKlypix } from './klypix-format.mjs';

export const PROJECT_GRAPH_SCHEMA_VERSION = 2;
export const DEFAULT_PROJECT_GRAPH = 'graphify-out/graph.json';
export const DEFAULT_PROJECT_GRAPH_HTML = 'graphify-out/graph.html';
export const DEFAULT_PROJECT_GRAPH_REPORT = 'graphify-out/GRAPH_REPORT.md';

const MAX_GRAPH_BYTES = 64 * 1024 * 1024;
const MAX_GRAPH_NODES = 100_000;
const MAX_GRAPH_EDGES = 500_000;
const MAX_QUERY_NODES = 200;
const MAX_QUERY_EDGES = 600;
const CACHE_TTL_MS = 60_000;

let cache = null;

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
};

const normalizedCase = (value) => process.platform === 'win32'
  ? value.toLocaleLowerCase('en-US')
  : value;

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realRoot(project) {
  const resolved = path.resolve(String(project || process.cwd()));
  const real = fs.realpathSync(resolved);
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) throw new Error(`Project root is not a directory: ${resolved}`);
  return real;
}

function resolveInsideProject(projectRoot, requested, fallback) {
  const candidate = path.resolve(projectRoot, String(requested || fallback));
  if (!isInside(normalizedCase(projectRoot), normalizedCase(candidate))) {
    throw new Error('Project graph path must stay inside the project root.');
  }
  if (!fs.existsSync(candidate)) return candidate;
  const real = fs.realpathSync(candidate);
  if (!isInside(normalizedCase(projectRoot), normalizedCase(real))) {
    throw new Error('Project graph path resolves outside the project root.');
  }
  return real;
}

function relativePortable(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function safeSourceFile(root, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const original = value.trim().replace(/\\/g, '/');
  const foreignAbsolute = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
  if (foreignAbsolute && !path.isAbsolute(value)) return null;
  const candidate = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(root, ...original.split('/'));
  if (!isInside(normalizedCase(root), normalizedCase(candidate))) return null;
  const relative = relativePortable(root, candidate);
  return relative && relative !== '.' ? relative : null;
}

function shortString(value, max = 1_000) {
  if (value == null) return '';
  // Tabs and newlines collapse to one space so a hostile graph label can never
  // break out of its one-line markdown bullet into headings of its own.
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[\t\n\r]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeConfidence(edge) {
  const raw = shortString(edge?.confidence, 32).toUpperCase();
  if (raw === 'EXTRACTED' || raw === 'INFERRED' || raw === 'AMBIGUOUS') return raw;
  return edge?.confidence_score == null ? 'EXTRACTED' : 'INFERRED';
}

function normalizeGraph(raw, projectRoot, artifact) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('graph.json must contain a JSON object.');
  }
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : null;
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : Array.isArray(raw.links) ? raw.links : null;
  if (!rawNodes || !rawEdges) {
    throw new Error('Unsupported project graph: expected NetworkX node-link arrays named nodes and edges (or links).');
  }
  if (rawNodes.length > MAX_GRAPH_NODES || rawEdges.length > MAX_GRAPH_EDGES) {
    throw new Error(`Project graph exceeds the safe in-process limit (${MAX_GRAPH_NODES.toLocaleString()} nodes / ${MAX_GRAPH_EDGES.toLocaleString()} edges).`);
  }

  const nodes = [];
  const byId = new Map();
  let unsafeSourcePaths = 0;
  let duplicateNodes = 0;
  for (const input of rawNodes) {
    if (!input || typeof input !== 'object') continue;
    const id = shortString(input.id, 512);
    if (!id) continue;
    if (byId.has(id)) { duplicateNodes++; continue; }
    const originalSource = input.source_file ?? input.path;
    const sourceFile = safeSourceFile(projectRoot, originalSource);
    if (originalSource && !sourceFile) unsafeSourcePaths++;
    const node = {
      id,
      label: shortString(input.label ?? input.name ?? id, 1_000),
      kind: shortString(input.kind ?? input.type ?? input.file_type ?? 'symbol', 120),
      sourceFile,
      sourceLocation: shortString(input.source_location ?? input.location, 240) || null,
      community: shortString(input.community, 160) || null,
      origin: shortString(input._origin ?? input.origin, 160) || null,
    };
    byId.set(id, node);
    nodes.push(node);
  }

  const edges = [];
  const adjacency = new Map(nodes.map(node => [node.id, []]));
  let danglingEdges = 0;
  for (const input of rawEdges) {
    if (!input || typeof input !== 'object') continue;
    const source = shortString(input.source, 512);
    const target = shortString(input.target, 512);
    if (!source || !target || !byId.has(source) || !byId.has(target)) {
      danglingEdges++;
      continue;
    }
    const edge = {
      source,
      target,
      relation: shortString(input.relation ?? input.type ?? 'related_to', 160),
      confidence: normalizeConfidence(input),
    };
    const index = edges.length;
    edges.push(edge);
    adjacency.get(source).push({ nodeId: target, edgeIndex: index });
    if (source !== target) adjacency.get(target).push({ nodeId: source, edgeIndex: index });
  }

  return {
    schemaVersion: PROJECT_GRAPH_SCHEMA_VERSION,
    provider: 'graphify',
    format: {
      family: 'networkx-node-link',
      sourceSchemaVersion: shortString(raw.schema_version ?? raw.schemaVersion, 80) || null,
      providerVersion: shortString(raw?.metadata?.version ?? raw?.meta?.version ?? raw.generator_version, 80) || null,
    },
    artifact,
    nodes,
    edges,
    byId,
    adjacency,
    diagnostics: {
      unsafeSourcePaths,
      duplicateNodes,
      danglingEdges,
      inputNodes: rawNodes.length,
      inputEdges: rawEdges.length,
      acceptedNodes: nodes.length,
      acceptedEdges: edges.length,
    },
  };
}

function cacheLimitBytes() {
  const configured = Number(process.env.KLYPIX_PROJECT_GRAPH_CACHE_MB);
  const mb = Number.isFinite(configured) ? Math.max(0, Math.min(64, configured)) : 12;
  return Math.floor(mb * 1024 * 1024);
}

export function discoverProjectGraph({ project, graphPath } = {}) {
  const projectRoot = realRoot(project);
  // No explicit path: prefer the Graphify artifact for continuity, but fall
  // back to KLYPIX's own native artifact so a no-install scan serves
  // project_map_context with zero configuration.
  let effectivePath = graphPath;
  if (!graphPath) {
    const graphifyDefault = path.resolve(projectRoot, DEFAULT_PROJECT_GRAPH);
    const nativeDefault = path.resolve(projectRoot, NATIVE_MAP_ARTIFACT);
    if (!fs.existsSync(graphifyDefault) && fs.existsSync(nativeDefault)) effectivePath = NATIVE_MAP_ARTIFACT;
  }
  const filePath = resolveInsideProject(projectRoot, effectivePath, DEFAULT_PROJECT_GRAPH);
  const artifactDir = path.dirname(filePath);
  const htmlPath = resolveInsideProject(projectRoot, path.join(artifactDir, 'graph.html'), DEFAULT_PROJECT_GRAPH_HTML);
  const reportPath = resolveInsideProject(projectRoot, path.join(artifactDir, 'GRAPH_REPORT.md'), DEFAULT_PROJECT_GRAPH_REPORT);
  const provider = path.basename(artifactDir).toLocaleLowerCase('en-US') === 'graphify-out' ? 'graphify' : 'project-graph';
  if (!fs.existsSync(filePath)) {
    return {
      schemaVersion: PROJECT_GRAPH_SCHEMA_VERSION,
      provider,
      status: 'missing',
      projectRoot,
      filePath,
      artifact: {
        graphJson: relativePortable(projectRoot, filePath),
        graphHtml: fs.existsSync(htmlPath) ? relativePortable(projectRoot, htmlPath) : null,
        report: fs.existsSync(reportPath) ? relativePortable(projectRoot, reportPath) : null,
      },
    };
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Project graph path is not a file.');
  if (stat.size > MAX_GRAPH_BYTES) {
    throw new Error(`Project graph is ${(stat.size / 1024 / 1024).toFixed(1)} MB; the safe read limit is ${MAX_GRAPH_BYTES / 1024 / 1024} MB.`);
  }
  return {
    schemaVersion: PROJECT_GRAPH_SCHEMA_VERSION,
    provider,
    status: 'ready',
    projectRoot,
    filePath,
    artifact: {
      graphJson: relativePortable(projectRoot, filePath),
      graphHtml: fs.existsSync(htmlPath) ? relativePortable(projectRoot, htmlPath) : null,
      report: fs.existsSync(reportPath) ? relativePortable(projectRoot, reportPath) : null,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    },
    stat,
  };
}

export function loadProjectGraph(options = {}) {
  const found = discoverProjectGraph(options);
  if (found.status !== 'ready') return { ...found, graph: null };
  const key = `${found.filePath}:${found.stat.size}:${found.stat.mtimeMs}`;
  if (cache?.key === key && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return { ...found, graph: cache.graph, cache: 'hit' };
  }
  const json = fs.readFileSync(found.filePath, 'utf8');
  let raw;
  try { raw = JSON.parse(json); }
  catch (error) { throw new Error(`Project graph is not valid JSON: ${error?.message || error}`); }
  const graph = normalizeGraph(raw, found.projectRoot, found.artifact);
  graph.provider = found.provider;
  if (found.stat.size <= cacheLimitBytes()) cache = { key, graph, loadedAt: Date.now() };
  else cache = null;
  return { ...found, graph, cache: 'miss' };
}

function queryTokens(value) {
  return [...new Set(String(value || '').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_./:@#$-]+/gu) || [])]
    .filter(token => token.length > 1)
    .slice(0, 32);
}

function scoreNode(node, query, tokens, degree) {
  const label = node.label.toLocaleLowerCase('en-US');
  const source = (node.sourceFile || '').toLocaleLowerCase('en-US');
  const haystack = `${label} ${source} ${node.kind} ${node.community || ''}`.toLocaleLowerCase('en-US');
  let score = Math.min(3, Math.log2(1 + degree));
  if (query && label === query) score += 60;
  else if (query && source === query) score += 55;
  else if (query && label.includes(query)) score += 28;
  else if (query && source.includes(query)) score += 24;
  for (const token of tokens) {
    if (label === token) score += 14;
    else if (label.includes(token)) score += 8;
    if (source.includes(token)) score += 7;
    if (haystack.includes(token)) score += 2;
  }
  return score;
}

export function queryProjectGraph({ project, graphPath, query = '', depth = 1, maxNodes = 60 } = {}) {
  const loaded = loadProjectGraph({ project, graphPath });
  if (!loaded.graph) return { ...loaded, query: String(query || ''), nodes: [], edges: [] };
  const graph = loaded.graph;
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase('en-US');
  const tokens = queryTokens(query);
  const cap = clamp(maxNodes, 1, MAX_QUERY_NODES, 60);
  const hopLimit = clamp(depth, 0, 3, 1);
  const ranked = graph.nodes
    .map(node => ({ node, score: scoreNode(node, normalizedQuery, tokens, graph.adjacency.get(node.id)?.length || 0) }))
    .filter(hit => !tokens.length || hit.score > 0)
    .sort((a, b) => b.score - a.score || a.node.label.localeCompare(b.node.label));
  const seeds = ranked.slice(0, Math.min(tokens.length ? 12 : cap, cap));
  const selected = new Set();
  const queue = seeds.map(hit => ({ id: hit.node.id, depth: 0 }));
  while (queue.length && selected.size < cap) {
    const current = queue.shift();
    if (selected.has(current.id)) continue;
    selected.add(current.id);
    if (current.depth >= hopLimit) continue;
    const neighbors = graph.adjacency.get(current.id) || [];
    for (const neighbor of neighbors) {
      if (!selected.has(neighbor.nodeId) && selected.size + queue.length < cap * 3) {
        queue.push({ id: neighbor.nodeId, depth: current.depth + 1 });
      }
    }
  }
  const nodeScore = new Map(ranked.map(hit => [hit.node.id, hit.score]));
  const nodes = [...selected]
    .map(id => graph.byId.get(id))
    .filter(Boolean)
    .sort((a, b) => (nodeScore.get(b.id) || 0) - (nodeScore.get(a.id) || 0));
  const edges = graph.edges
    .filter(edge => selected.has(edge.source) && selected.has(edge.target))
    .slice(0, MAX_QUERY_EDGES);
  return {
    schemaVersion: PROJECT_GRAPH_SCHEMA_VERSION,
    provider: graph.provider,
    format: graph.format,
    status: 'ready',
    query: String(query || ''),
    depth: hopLimit,
    artifact: graph.artifact,
    counts: {
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      returnedNodes: nodes.length,
      returnedEdges: edges.length,
    },
    diagnostics: graph.diagnostics,
    nodes,
    edges,
    cache: loaded.cache,
  };
}

function edgeIdentity(edge) {
  return `${edge.source}\u0000${edge.relation}\u0000${edge.target}\u0000${edge.confidence}`;
}

/**
 * Compare two already-bounded query results. Artifact totals are exact; named
 * node/edge changes describe only the returned neighborhoods and say so.
 */
export function compareProjectGraphResults(current, previous) {
  if (!current || !previous || current.status !== 'ready' || previous.status !== 'ready') return null;
  const oldNodes = new Map(previous.nodes.map(node => [node.id, node]));
  const newNodes = new Map(current.nodes.map(node => [node.id, node]));
  const oldEdges = new Map(previous.edges.map(edge => [edgeIdentity(edge), edge]));
  const newEdges = new Map(current.edges.map(edge => [edgeIdentity(edge), edge]));
  return {
    graphNodesDelta: current.counts.graphNodes - previous.counts.graphNodes,
    graphEdgesDelta: current.counts.graphEdges - previous.counts.graphEdges,
    addedNodes: current.nodes.filter(node => !oldNodes.has(node.id)).slice(0, 80),
    removedNodes: previous.nodes.filter(node => !newNodes.has(node.id)).slice(0, 80),
    addedEdges: current.edges.filter(edge => !oldEdges.has(edgeIdentity(edge))).slice(0, 160),
    removedEdges: previous.edges.filter(edge => !newEdges.has(edgeIdentity(edge))).slice(0, 160),
    coverage: 'bounded-query-neighborhoods',
    comparedArtifact: previous.artifact?.graphJson || null,
  };
}

function textContainsExactSourcePath(text, sourceFile) {
  const haystack = String(text || '').replace(/\\/g, '/').toLocaleLowerCase('en-US');
  const needle = String(sourceFile || '').replace(/\\/g, '/').toLocaleLowerCase('en-US');
  if (!needle || !haystack.includes(needle)) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s\`'"([{<])${escaped}($|[\\s\`'"\\])}>.,;:#])`, 'i').test(haystack);
}

/**
 * Deterministic proposals only. These are never persisted and never imply
 * causality: an exact project-relative source path must appear in the brain
 * card text before KLYPIX will suggest reviewing the pair.
 */
export function suggestProjectGraphBrainLinks(graphResult, brainContext, limit = 40) {
  if (graphResult?.status !== 'ready' || !Array.isArray(graphResult.nodes)) return [];
  const hits = Array.isArray(brainContext?.hits) ? brainContext.hits : [];
  const proposals = [];
  const seen = new Set();
  for (const node of graphResult.nodes) {
    if (!node?.sourceFile) continue;
    for (const hit of hits) {
      const texts = [hit?.text, hit?.correctedBy].filter(Boolean);
      if (!texts.some(text => textContainsExactSourcePath(text, node.sourceFile))) continue;
      const key = `${hit.id}\u0000${node.id}\u0000${node.sourceFile}`;
      if (seen.has(key)) continue;
      seen.add(key);
      proposals.push({
        brainCardId: hit.id,
        brainArea: hit.area || 'Notes',
        nodeId: node.id,
        nodeLabel: node.label || node.id,
        sourceFile: node.sourceFile,
        basis: 'exact-source-path',
        status: 'review-proposal',
      });
      if (proposals.length >= Math.max(1, Math.min(100, Number(limit) || 40))) return proposals;
    }
  }
  return proposals;
}

const STALE_ARTIFACT_MS = 7 * 24 * 60 * 60 * 1000;

function artifactAgeLine(artifact) {
  const iso = artifact?.modifiedAt;
  if (!iso) return '';
  const generated = Date.parse(iso);
  if (!Number.isFinite(generated)) return '';
  const ageMs = Math.max(0, Date.now() - generated);
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const age = days >= 1 ? `${days} day(s) ago` : 'today';
  const warning = ageMs > STALE_ARTIFACT_MS
    ? ' — the artifact may be stale; regenerate it if the code has moved.'
    : '.';
  return `Artifact generated ${iso} (${age})${warning} Graph evidence is only as current as this artifact.`;
}

export function projectGraphContextMarkdown(result) {
  if (result.status === 'missing') {
    return `# Project Map\n\nNo supported project graph was found at \`${result.artifact.graphJson}\`. KLYPIX did not install or run a provider. Generate the artifact with Graphify, then retry.`;
  }
  const lines = result.nodes.map(node => {
    const where = node.sourceFile ? ` in \`${node.sourceFile}${node.sourceLocation ? `:${node.sourceLocation}` : ''}\`` : '';
    return `- **${node.label || node.id}** (${node.kind || 'symbol'})${where}; id \`${node.id}\``;
  });
  const edgeLines = result.edges.slice(0, 80).map(edge =>
    `- \`${edge.source}\` --${edge.relation}--> \`${edge.target}\` [${edge.confidence}]`);
  const warnings = [];
  if (result.diagnostics?.unsafeSourcePaths) warnings.push(`${result.diagnostics.unsafeSourcePaths} unsafe/out-of-root source path(s) were withheld`);
  if (result.diagnostics?.danglingEdges) warnings.push(`${result.diagnostics.danglingEdges} dangling edge(s) were ignored`);
  return [
    '# Project Map: code evidence',
    `Provider artifact: \`${result.artifact.graphJson}\`; ${result.counts.graphNodes.toLocaleString()} nodes; ${result.counts.graphEdges.toLocaleString()} edges; query \`${result.query || '(overview)'}\`.`,
    artifactAgeLine(result.artifact),
    warnings.length ? `Safety note: ${warnings.join('; ')}.` : '',
    result.change ? `## Change from \`${result.change.comparedArtifact || 'comparison artifact'}\`\nExact total deltas: ${result.change.graphNodesDelta >= 0 ? '+' : ''}${result.change.graphNodesDelta} nodes; ${result.change.graphEdgesDelta >= 0 ? '+' : ''}${result.change.graphEdgesDelta} edges. Named additions and removals are limited to the two bounded query neighborhoods.` : '',
    result.change?.addedNodes?.length ? `Added in bounded result: ${result.change.addedNodes.slice(0, 20).map(node => `\`${node.label || node.id}\``).join(', ')}.` : '',
    result.change?.removedNodes?.length ? `Removed from bounded result: ${result.change.removedNodes.slice(0, 20).map(node => `\`${node.label || node.id}\``).join(', ')}.` : '',
    '## Relevant code nodes',
    lines.join('\n') || '_No matching code nodes._',
    edgeLines.length ? '## Relationships\n' + edgeLines.join('\n') : '',
    '_Graph evidence describes the current generated artifact; brain cards below remain the source for decisions, corrections, and project history._',
  ].filter(Boolean).join('\n\n');
}

export function clearProjectGraphCache() {
  cache = null;
}

// ---------------------------------------------------------------------------
// Native project map — the no-install scanner.
//
// Extracts exactly what the 2026-08-06 value evaluation proved useful: the
// full file inventory plus FILE-LEVEL import edges (who imports whom). It
// deliberately does NOT rebuild a per-symbol AST graph — that depth belongs to
// external providers like Graphify, importable through the same artifact door.

export const NATIVE_MAP_ARTIFACT = 'klypix-map/graph.json';

const SCAN_MAX_FILES = 20_000;
const SCAN_MAX_PARSE_BYTES = 2 * 1024 * 1024;
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const INVENTORY_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  '.json', '.md', '.mdx', '.yml', '.yaml', '.toml', '.css', '.scss', '.html', '.sql',
  '.py', '.rs', '.go', '.swift', '.kt', '.java', '.rb', '.sh', '.ps1', '.vue', '.svelte',
]);
// Junk that polluted the 2026-08-06 field graph (browser profiles, worktrees,
// build output) — excluded even when a repo forgets to gitignore it.
const SCAN_EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'build', 'release', 'out', 'coverage',
  '.next', '.turbo', '.cache', 'tmp', '.worktrees', '.codex-artifacts', '.codex-tmp',
  'graphify-out', 'klypix-map', '__pycache__', '.venv', 'venv',
]);

function runGit(root, args) {
  try {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) return null;
    return result.stdout;
  } catch { return null; }
}

function excludedByDir(rel) {
  return rel.split('/').some(segment => SCAN_EXCLUDED_DIRS.has(segment.toLocaleLowerCase('en-US')));
}

function walkInventoryFallback(root) {
  const out = [];
  const queue = ['.'];
  while (queue.length && out.length < SCAN_MAX_FILES) {
    const relDir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const rel = relDir === '.' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SCAN_EXCLUDED_DIRS.has(entry.name.toLocaleLowerCase('en-US'))) queue.push(rel);
      } else if (entry.isFile()) {
        out.push(rel);
        if (out.length >= SCAN_MAX_FILES) break;
      }
    }
  }
  return out;
}

function listScanInventory(root) {
  // git ls-files (tracked + untracked-not-ignored) honors .gitignore and is the
  // authoritative "what belongs to this project" answer; the manual walk is the
  // no-git fallback. Both still pass the junk-dir filter — field evidence
  // showed repos forget to ignore browser profiles and build drops.
  const gitOut = runGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const rawList = gitOut != null
    ? gitOut.split('\0').filter(Boolean).map(entry => entry.replace(/\\/g, '/'))
    : walkInventoryFallback(root);
  const files = [];
  let truncated = false;
  for (const rel of rawList) {
    if (excludedByDir(rel)) continue;
    const extension = path.extname(rel).toLocaleLowerCase('en-US');
    if (!INVENTORY_EXTENSIONS.has(extension)) continue;
    if (files.length >= SCAN_MAX_FILES) { truncated = true; break; }
    files.push(rel);
  }
  files.sort();
  return { files, truncated, viaGit: gitOut != null };
}

function looksMinified(root, rel, sizeBytes) {
  const base = path.basename(rel).toLocaleLowerCase('en-US');
  if (base.includes('.min.')) return true;
  if (sizeBytes < 50 * 1024) return false;
  try {
    const fd = fs.openSync(path.join(root, rel), 'r');
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const sample = buf.toString('utf8', 0, read);
    const firstNewline = sample.indexOf('\n');
    return firstNewline === -1 || firstNewline > 2000;
  } catch { return false; }
}

const IMPORT_PATTERNS = [
  /(?:^|[^\w$.])import\s+(?:[\w$*{},\s]+?from\s+)?['"]([^'"\n]+)['"]/gm,
  /(?:^|[^\w$.])export\s+[\w$*{},\s]*?from\s+['"]([^'"\n]+)['"]/gm,
  /(?:^|[^\w$.])require\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /(?:^|[^\w$.])import\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

function extractImportSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

function tryResolveFile(candidate, fileSet) {
  const normal = candidate.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
  if (fileSet.has(normal)) return normal;
  for (const extension of RESOLVE_EXTENSIONS) {
    if (fileSet.has(normal + extension)) return normal + extension;
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    if (fileSet.has(`${normal}/index${extension}`)) return `${normal}/index${extension}`;
  }
  return null;
}

function collectWorkspacePackages(root, files) {
  const packages = new Map();
  for (const rel of files) {
    if (path.basename(rel) !== 'package.json') continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
      const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
      if (name && !packages.has(name)) packages.set(name, path.dirname(rel).replace(/^\.$/, ''));
    } catch { /* unparseable package.json is not an error for the scan */ }
  }
  return packages;
}

// Per-package alias scopes: in a monorepo every package can carry its own
// tsconfig `paths` (typically `@/*` -> `./src/*`), scoped to files under that
// package's directory. A root-only reading resolved 0 of a field repo's 56
// `@/lib/utils` importers; nearest-tsconfig scoping resolves them all.
function collectTsconfigAliasScopes(root, files) {
  const scopes = [];
  for (const rel of files) {
    if (path.basename(rel) !== 'tsconfig.json') continue;
    const dir = path.dirname(rel).replace(/^\.$/, '');
    try {
      const raw = fs.readFileSync(path.join(root, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        .replace(/,\s*([}\]])/g, '$1');
      const parsed = JSON.parse(raw);
      const paths = parsed?.compilerOptions?.paths || {};
      const baseUrl = String(parsed?.compilerOptions?.baseUrl || '.').replace(/^\.\//, '').replace(/^\.$/, '');
      const aliases = [];
      for (const [pattern, targets] of Object.entries(paths)) {
        if (!pattern.endsWith('/*') || !Array.isArray(targets) || !targets.length) continue;
        const target = String(targets[0]);
        if (!target.endsWith('/*')) continue;
        const prefix = pattern.slice(0, -1);
        const replacement = [dir, baseUrl, target.slice(0, -1).replace(/^\.\//, '')]
          .filter(Boolean).join('/').replace(/\/{2,}/g, '/');
        aliases.push({ prefix, replacement });
      }
      if (aliases.length) scopes.push({ dir, aliases });
    } catch { /* unparseable tsconfig — that scope stays alias-free */ }
  }
  // Longest directory first so the nearest enclosing tsconfig wins.
  scopes.sort((a, b) => b.dir.length - a.dir.length);
  return scopes;
}

function aliasesForFile(fromRel, scopes) {
  const normal = fromRel.replace(/\\/g, '/');
  for (const scope of scopes) {
    if (!scope.dir || normal.startsWith(`${scope.dir}/`)) return scope.aliases;
  }
  return [];
}

function resolveImport(fromRel, specifier, fileSet, workspaces, aliasScopes) {
  if (!specifier || specifier.startsWith('node:') || specifier.startsWith('data:')) return null;
  if (specifier.startsWith('.')) {
    const joined = path.posix.join(path.posix.dirname(fromRel.replace(/\\/g, '/')), specifier);
    if (joined.startsWith('..')) return null;
    return tryResolveFile(joined, fileSet);
  }
  for (const alias of aliasesForFile(fromRel, aliasScopes)) {
    if (specifier.startsWith(alias.prefix)) {
      return tryResolveFile(`${alias.replacement}${specifier.slice(alias.prefix.length)}`, fileSet);
    }
  }
  for (const [name, dir] of workspaces) {
    if (specifier === name) {
      return tryResolveFile(`${dir}/src/index`, fileSet)
        || tryResolveFile(`${dir}/index`, fileSet)
        || (fileSet.has(`${dir}/package.json`) ? `${dir}/package.json` : null);
    }
    if (specifier.startsWith(`${name}/`)) {
      const sub = `${dir}/${specifier.slice(name.length + 1)}`;
      return tryResolveFile(sub, fileSet) || tryResolveFile(`${dir}/src/${specifier.slice(name.length + 1)}`, fileSet);
    }
  }
  return null;
}

/**
 * Scan the project natively: full file inventory + file-level import edges.
 * Writes klypix-map/graph.json (NetworkX node-link, the same shape external
 * providers use) unless write:false. The artifact is disposable local cache.
 */
export function scanNativeProjectMap({ project, write = true } = {}) {
  const projectRoot = realRoot(project);
  const inventory = listScanInventory(projectRoot);
  const fileSet = new Set(inventory.files);
  const workspaces = collectWorkspacePackages(projectRoot, inventory.files);
  const aliasScopes = collectTsconfigAliasScopes(projectRoot, inventory.files);

  const links = [];
  const externals = new Map();
  let parsedFiles = 0;
  let skippedMinified = 0;
  for (const rel of inventory.files) {
    if (!CODE_EXTENSIONS.has(path.extname(rel).toLocaleLowerCase('en-US'))) continue;
    let stat;
    try { stat = fs.statSync(path.join(projectRoot, rel)); } catch { continue; }
    if (stat.size > SCAN_MAX_PARSE_BYTES) continue;
    if (looksMinified(projectRoot, rel, stat.size)) { skippedMinified++; continue; }
    let source;
    try { source = fs.readFileSync(path.join(projectRoot, rel), 'utf8'); } catch { continue; }
    parsedFiles++;
    for (const specifier of extractImportSpecifiers(source)) {
      const resolved = resolveImport(rel, specifier, fileSet, workspaces, aliasScopes);
      if (resolved && resolved !== rel) {
        links.push({ source: rel, target: resolved, relation: 'imports', confidence: 'EXTRACTED' });
      } else if (!resolved && !specifier.startsWith('.')) {
        const packageName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        externals.set(packageName, (externals.get(packageName) || 0) + 1);
      }
    }
  }

  const nodes = inventory.files.map(rel => ({
    id: rel,
    label: path.basename(rel),
    file_type: 'code',
    source_file: rel,
  }));
  const artifact = {
    directed: true,
    multigraph: false,
    graph: {
      generator: 'klypix-native-map',
      schema_version: 1,
      generated_at: new Date().toISOString(),
      via_git: inventory.viaGit,
      truncated: inventory.truncated,
      external_packages: [...externals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
        .map(([name, count]) => ({ name, imports: count })),
    },
    nodes,
    links,
  };

  let artifactPath = null;
  if (write) {
    const dir = path.join(projectRoot, path.dirname(NATIVE_MAP_ARTIFACT));
    fs.mkdirSync(dir, { recursive: true });
    artifactPath = path.join(projectRoot, ...NATIVE_MAP_ARTIFACT.split('/'));
    const temporary = `${artifactPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(artifact));
    fs.renameSync(temporary, artifactPath);
    clearProjectGraphCache();
  }

  return {
    status: 'ready',
    projectRoot,
    artifactPath,
    artifactRelative: write ? NATIVE_MAP_ARTIFACT : null,
    counts: {
      files: inventory.files.length,
      parsedCodeFiles: parsedFiles,
      importEdges: links.length,
      workspacePackages: workspaces.size,
      externalPackages: externals.size,
      skippedMinified,
    },
    truncated: inventory.truncated,
    viaGit: inventory.viaGit,
    graph: write ? null : artifact,
  };
}

// ---------------------------------------------------------------------------
// Brain drift — check brain cards' file references against repo reality.
//
// Field-derived false-positive taxonomy (2026-08-06 adversarial run) is baked
// in: slash-joined enumerations are rejected, refs that resolve nowhere near
// this project are treated as another repo's mentions and skipped, and a
// checkout that is behind its origin default branch is reported as its own
// headline instead of blaming the cards.

const DRIFT_REF_PATTERN = /[A-Za-z0-9_@](?:[A-Za-z0-9_.@-]|[\\/])*\.[A-Za-z0-9]{1,8}/g;
const DRIFT_TAG_PATTERN = /#file-([a-z0-9-]+)/g;

function slugifyStem(basename) {
  return basename.replace(/\.[^.]+$/, '').toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isEnumerationToken(token) {
  // "AGENTS.md/.cursor/.windsurf" — a NON-final segment carrying a file
  // extension means this is a prose list of names, not one path.
  const segments = token.split('/');
  return segments.slice(0, -1).some(segment => /\.[A-Za-z0-9]{1,8}$/.test(segment) && segment !== '.' && segment !== '..');
}

function driftRefsFromText(text) {
  const refs = new Set();
  for (const match of String(text || '').matchAll(DRIFT_REF_PATTERN)) {
    const token = match[0].replace(/\\/g, '/').replace(/^\.\//, '');
    if (!token.includes('/')) continue;
    if (/^[A-Za-z]:\//.test(token) || token.startsWith('http') || token.startsWith('//')) continue;
    if (isEnumerationToken(token)) continue;
    refs.add(token);
  }
  return [...refs];
}

function checkoutStaleness(root) {
  const head = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const defaultRef = runGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const target = (defaultRef || '').trim() || ['origin/main', 'origin/master']
    .find(ref => runGit(root, ['rev-parse', '--verify', '--quiet', ref]) != null);
  if (!target) return null;
  const behindRaw = runGit(root, ['rev-list', '--count', `HEAD..${target}`]);
  const behind = Number((behindRaw || '').trim());
  if (!Number.isFinite(behind)) return null;
  return { branch: (head || '').trim() || null, comparedTo: target, behind };
}

/**
 * Check every text card in the project brain against the repo's real files.
 * Read-only: never writes to the brain or the repo.
 */
export async function checkBrainDrift({ project, brain } = {}) {
  const projectRoot = realRoot(project);
  const brainPath = brain
    ? path.resolve(projectRoot, brain)
    : ['brain.klypix', 'brain.any'].map(name => path.join(projectRoot, name)).find(file => fs.existsSync(file));
  if (!brainPath || !fs.existsSync(brainPath)) {
    return { status: 'no-brain', projectRoot, brainPath: brainPath || null, cards: [], summary: null, staleCheckout: null };
  }
  const parsed = await parseKlypix(fs.readFileSync(brainPath));
  const cards = Array.isArray(parsed?.struct?.cards) ? parsed.struct.cards : [];

  const inventory = listScanInventory(projectRoot);
  const fileSet = new Set(inventory.files);
  const byBasename = new Map();
  const bySlug = new Map();
  const rootEntries = new Set(fs.readdirSync(projectRoot).map(entry => entry.toLocaleLowerCase('en-US')));
  for (const file of inventory.files) {
    const basename = path.basename(file).toLocaleLowerCase('en-US');
    byBasename.set(basename, [...(byBasename.get(basename) || []), file]);
    const slug = slugifyStem(basename);
    if (slug) bySlug.set(slug, [...(bySlug.get(slug) || []), file]);
  }

  const drifted = [];
  let cardsWithRefs = 0;
  let refsOk = 0;
  let refsChecked = 0;
  for (const card of cards) {
    const text = card?.text || '';
    if (!text) continue;
    const findings = [];
    const refs = driftRefsFromText(text);
    let sawCheckable = false;
    for (const ref of refs) {
      const lower = ref.toLocaleLowerCase('en-US');
      const firstSegment = lower.split('/')[0];
      const inRepoShape = fileSet.has(ref) || fileSet.has(lower) || rootEntries.has(firstSegment);
      if (!inRepoShape) continue; // likely another project's path — not our claim to judge
      sawCheckable = true;
      refsChecked++;
      if (fileSet.has(ref) || fileSet.has(lower) || fs.existsSync(path.join(projectRoot, ref))) { refsOk++; continue; }
      const movedTo = (byBasename.get(path.basename(lower)) || []).slice(0, 3);
      findings.push({ ref, status: movedTo.length ? 'moved' : 'missing', movedTo });
    }
    for (const match of text.matchAll(DRIFT_TAG_PATTERN)) {
      const candidates = bySlug.get(match[1]);
      if (candidates?.length === 1) { sawCheckable = true; refsChecked++; refsOk++; }
    }
    if (sawCheckable) cardsWithRefs++;
    if (findings.length) {
      drifted.push({
        id: card.id || null,
        area: card.area || null,
        preview: shortString(text, 120),
        findings,
      });
    }
  }

  return {
    status: 'ready',
    projectRoot,
    brainPath,
    staleCheckout: checkoutStaleness(projectRoot),
    summary: {
      cards: cards.length,
      cardsWithCheckableRefs: cardsWithRefs,
      refsChecked,
      refsOk,
      driftedCards: drifted.length,
    },
    cards: drifted,
  };
}

export function brainDriftMarkdown(result) {
  if (result.status === 'no-brain') {
    return '# Brain drift\n\nNo brain.klypix found in this project — nothing to check.';
  }
  const lines = ['# Brain drift — cards vs the repo\'s real files'];
  const stale = result.staleCheckout;
  if (stale && stale.behind > 0) {
    lines.push(`⚠️ **This checkout is ${stale.behind} commit(s) behind \`${stale.comparedTo}\`** (branch \`${stale.branch || '?'}\`, as of the last fetch). Files reported missing below may simply not be in THIS checkout — pull before trusting the card verdicts.`);
  }
  const s = result.summary;
  lines.push(`Checked ${s.cards} card(s); ${s.cardsWithCheckableRefs} referenced this repo's files (${s.refsChecked} reference(s), ${s.refsOk} still valid). **${s.driftedCards} card(s) reference files that are gone or moved.**`);
  for (const card of result.cards.slice(0, 40)) {
    lines.push(`- ${card.area ? `[${card.area}] ` : ''}${card.preview}`);
    for (const finding of card.findings.slice(0, 4)) {
      lines.push(`  - \`${finding.ref}\` — ${finding.status}${finding.movedTo.length ? `; probably now: ${finding.movedTo.map(f => `\`${f}\``).join(', ')}` : ''}`);
    }
  }
  if (result.cards.length > 40) lines.push(`…and ${result.cards.length - 40} more drifted card(s).`);
  lines.push('_Read-only report. Fix cards with a CORRECTION marker or edit them in KLYPIX; nothing was changed automatically._');
  return lines.join('\n');
}
