import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildKlypixMap, parseKlypix } from '../src/klypix-format.mjs';
import { addCandidates, loadRulesDoc } from '../src/brain-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const bin of ['klypix-worker.mjs', 'klypix-mcp.mjs']) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-rule-wire-'));
  const home = path.join(temp, 'home'); fs.mkdirSync(home);
  const brain = await buildKlypixMap({ title: 'brain', kind: 'brain', areas: [{ title: 'Lessons', cards: [{ text: 'Use relative imports.' }] }] });
  fs.writeFileSync(path.join(temp, 'brain.klypix'), brain);
  const card = (await parseKlypix(brain)).struct.cards.find(c => c.type !== 'container');
  addCandidates(temp, [{ id: 'relative-import', kind: 'forbid-pattern', severity: 'warn', why: 'Absolute imports fail.', fix: 'Use relative imports.', source: { card: card.id }, files: ['src/*.ts'], pattern: 'bad-import' }]);
  const client = new Client({ name: 'rule-approval-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let accept = false, prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async req => {
    prompts++;
    assert.ok(req.params.message.includes(temp) && req.params.message.includes('"severity": "block"'));
    assert.equal(req.params.requestedSchema.properties.confirm.default, false);
    return { action: accept ? 'accept' : 'decline', content: { confirm: accept } };
  });
  const env = { ...process.env, HOME: home, USERPROFILE: home, KLYPIX_AUTO_UPDATE: '0', KLYPIX_VAULT: temp };
  delete env.KLYPIX_BRAIN; delete env.KLYPIX_PLUGIN_MODE;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin', bin), '--vault', temp], cwd: temp, env, stderr: 'pipe' }));
    const args = { name: 'brain_rules', arguments: { action: 'promote', project: temp, ids: ['relative-import'], block: true } };
    const declined = await client.callTool(args);
    assert.equal(declined.structuredContent.reason, 'not-approved');
    assert.equal(loadRulesDoc(temp).rules[0].status, 'candidate');
    accept = true;
    const activated = await client.callTool(args);
    assert.equal(activated.structuredContent.ok, true, JSON.stringify(activated));
    assert.equal(loadRulesDoc(temp).rules[0].status, 'active');
    assert.equal(loadRulesDoc(temp).rules[0].severity, 'block');
    assert.equal(prompts, 2);
    assert.ok(!JSON.stringify(activated).includes('approval code'));
    console.log(`${bin}: real MCP form decline and approval passed.`);
  } finally { await client.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
