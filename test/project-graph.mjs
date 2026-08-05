import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildKlypixMap } from '../src/klypix-format.mjs';
import {
  clearProjectGraphCache,
  compareProjectGraphResults,
  discoverProjectGraph,
  loadProjectGraph,
  projectGraphContextMarkdown,
  queryProjectGraph,
} from '../src/project-graph.mjs';

let failures = 0;
const ok = (condition, label) => {
  console.log(`${condition ? 'âœ“' : 'âœ—'} ${label}`);
  if (!condition) failures++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-project-graph-'));
const out = path.join(root, 'graphify-out');
fs.mkdirSync(out, { recursive: true });
const graph = {
  directed: true,
  multigraph: false,
  nodes: [
    { id: 'auth', label: 'AuthService', type: 'class', source_file: 'src/auth.ts', source_location: '12' },
    { id: 'login', name: 'login', kind: 'function', path: 'src/login.ts' },
    { id: 'db', label: 'users table', file_type: 'database', source_file: 'db/schema.sql' },
    { id: 'outside', label: 'Outside', source_file: '../secret.txt' },
  ],
  edges: [
    { source: 'login', target: 'auth', relation: 'calls', confidence: 'EXTRACTED' },
    { source: 'auth', target: 'db', type: 'reads', confidence_score: 0.7 },
    { source: 'auth', target: 'missing', relation: 'calls' },
  ],
};
fs.writeFileSync(path.join(out, 'graph.json'), JSON.stringify(graph));
fs.writeFileSync(path.join(out, 'graph.html'), '<!doctype html><title>Graph</title>');
fs.writeFileSync(path.join(out, 'GRAPH_REPORT.md'), '# Graph');
fs.writeFileSync(path.join(root, 'brain.klypix'), await buildKlypixMap({
  title: 'brain',
  areas: [{ title: 'Architecture', cards: [{ text: 'AuthService owns login validation because API routes must stay transport-only.' }] }],
}));

try {
  const found = discoverProjectGraph({ project: root });
  ok(found.status === 'ready' && found.artifact.graphHtml === 'graphify-out/graph.html', 'discovers the standard Graphify artifact set');

  const loaded = loadProjectGraph({ project: root });
  ok(loaded.graph.nodes.length === 4 && loaded.graph.edges.length === 2, 'normalizes nodes and ignores dangling edges');
  ok(loaded.graph.byId.get('login').label === 'login' && loaded.graph.byId.get('login').sourceFile === 'src/login.ts', 'accepts documented label/path aliases');
  ok(loaded.graph.byId.get('outside').sourceFile === null && loaded.graph.diagnostics.unsafeSourcePaths === 1, 'withholds traversal paths instead of resolving outside the project');
  ok(loaded.graph.edges[1].confidence === 'INFERRED', 'normalizes confidence-score aliases conservatively');

  const result = queryProjectGraph({ project: root, query: 'login auth', depth: 1, maxNodes: 3 });
  ok(result.nodes.some(node => node.id === 'login') && result.nodes.some(node => node.id === 'auth'), 'query returns lexical seeds plus a bounded graph neighborhood');
  ok(result.edges.some(edge => edge.source === 'login' && edge.target === 'auth'), 'query preserves evidence relationships');
  ok(projectGraphContextMarkdown(result).includes('Graph evidence describes the current generated artifact'), 'human output states the graph/brain truth boundary');

  const cached = loadProjectGraph({ project: root });
  ok(cached.cache === 'hit', 'small graphs are cached briefly for responsive repeated queries');
  clearProjectGraphCache();

  const previousOut = path.join(root, 'previous');
  fs.mkdirSync(previousOut);
  fs.writeFileSync(path.join(previousOut, 'graph.json'), JSON.stringify({
    nodes: graph.nodes.filter(node => node.id !== 'db'),
    edges: graph.edges.filter(edge => edge.target !== 'db'),
  }));
  const previous = queryProjectGraph({ project: root, graphPath: 'previous/graph.json', query: 'login auth', depth: 1, maxNodes: 3 });
  result.change = compareProjectGraphResults(result, previous);
  ok(result.change.graphNodesDelta === 1 && result.change.graphEdgesDelta === 1, 'comparison reports exact artifact total deltas');
  ok(result.change.coverage === 'bounded-query-neighborhoods', 'comparison labels named changes as bounded evidence');
  ok(projectGraphContextMarkdown(result).includes('Exact total deltas'), 'human output explains comparison precision');

  const client = new Client({ name: 'project-map-test', version: '1.0.0' }, { capabilities: {} });
  const serverBin = fileURLToPath(new URL('../bin/klypix-mcp.mjs', import.meta.url));
  const testHome = path.join(root, '.test-home');
  fs.mkdirSync(testHome);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverBin, '--vault', root],
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      KLYPIX_BRAIN: path.join(root, 'brain.klypix'),
      KLYPIX_AUTO_UPDATE: '0',
      KLYPIX_SEMANTIC_MEMORY_MODE: 'off',
    },
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    ok(tools.includes('project_map_context'), 'the published MCP surface exposes the combined Project Map tool');
    const combined = await client.callTool({
      name: 'project_map_context',
      arguments: { question: 'where is login validation?', project: root, compare_to: 'previous/graph.json', max_nodes: 5, k: 3 },
    });
    const combinedText = (combined.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    ok(combinedText.includes('AuthService') && combinedText.includes('API routes must stay transport-only'), 'combined context returns current code evidence beside brain rationale');
    ok(combined.structuredContent?.projectGraph?.counts?.returnedNodes > 0, 'combined context includes a machine-readable bounded subgraph');
    ok(combined.structuredContent?.projectGraph?.change?.graphNodesDelta === 1, 'combined context exposes the safe graph comparison');
  } finally {
    await client.close().catch(() => {});
  }

  let escaped = false;
  try { discoverProjectGraph({ project: root, graphPath: '../outside.json' }); } catch { escaped = true; }
  ok(escaped, 'explicit graph paths cannot escape the project root');

  fs.renameSync(path.join(out, 'graph.json'), path.join(out, 'graph.saved.json'));
  const missing = discoverProjectGraph({ project: root });
  ok(missing.status === 'missing', 'missing providers degrade to a clear status without installing anything');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\nâœ— ${failures} project-graph assertion(s) failed` : '\nâœ“ project-graph: all assertions passed');
process.exit(failures ? 1 : 0);
