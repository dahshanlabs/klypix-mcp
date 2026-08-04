// Provider-neutral, read-only project-graph adapter.
//
// Graphify is the first supported producer, but callers only see the stable
// KLYPIX shape below. Generated graph artifacts remain disposable local cache:
// this module never runs Graphify, edits source, or writes into brain.klypix.

import fs from 'fs';
import path from 'path';

export const PROJECT_GRAPH_SCHEMA_VERSION = 1;
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
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
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
  const filePath = resolveInsideProject(projectRoot, graphPath, DEFAULT_PROJECT_GRAPH);
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

export function projectGraphContextMarkdown(result) {
  if (result.status === 'missing') {
    return `# Project Map\n\nNo supported project graph was found at \`${result.artifact.graphJson}\`. KLYPIX did not install or run a provider. Generate the artifact with Graphify, then retry.`;
  }
  const lines = result.nodes.map(node => {
    const where = node.sourceFile ? ` â€” \`${node.sourceFile}${node.sourceLocation ? `:${node.sourceLocation}` : ''}\`` : '';
    return `- **${node.label || node.id}** (${node.kind || 'symbol'})${where} Â· id \`${node.id}\``;
  });
  const edgeLines = result.edges.slice(0, 80).map(edge =>
    `- \`${edge.source}\` â€”${edge.relation}â†’ \`${edge.target}\` [${edge.confidence}]`);
  const warnings = [];
  if (result.diagnostics?.unsafeSourcePaths) warnings.push(`${result.diagnostics.unsafeSourcePaths} unsafe/out-of-root source path(s) were withheld`);
  if (result.diagnostics?.danglingEdges) warnings.push(`${result.diagnostics.danglingEdges} dangling edge(s) were ignored`);
  return [
    '# Project Map â€” code evidence',
    `Provider artifact: \`${result.artifact.graphJson}\` Â· ${result.counts.graphNodes.toLocaleString()} nodes Â· ${result.counts.graphEdges.toLocaleString()} edges Â· query \`${result.query || '(overview)'}\`.`,
    warnings.length ? `Safety note: ${warnings.join('; ')}.` : '',
    '## Relevant code nodes',
    lines.join('\n') || '_No matching code nodes._',
    edgeLines.length ? '## Relationships\n' + edgeLines.join('\n') : '',
    '_Graph evidence describes the current generated artifact; brain cards below remain the source for decisions, corrections, and project history._',
  ].filter(Boolean).join('\n\n');
}

export function clearProjectGraphCache() {
  cache = null;
}
