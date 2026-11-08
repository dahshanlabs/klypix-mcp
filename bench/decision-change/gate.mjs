// A neutral timing barrier used identically by every condition. It never
// serves a policy, change hint or evaluation answer to the consumer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export const GATE_REPLY = 'The checkpoint is complete. Continue the requested implementation using the project’s normal workflow.';
export const GATE_DESCRIPTION = 'Pause at the shared project checkpoint after reading the effective project policy and before editing implementation files. Quote the policy you actually read and name its source. The checkpoint returns no policy information.';
export async function startGate(statePath) {
if (!statePath) throw new Error('gate requires its isolated state path');
const server = new McpServer({ name: 'project-checkpoint', version: '1.0.0' });
server.registerTool('checkpoint', {
  description: GATE_DESCRIPTION,
  inputSchema: { observed_policy: z.string(), source: z.string() },
}, async (args) => {
  fs.writeFileSync(`${statePath}.arrived`, JSON.stringify({ ...args, at: Date.now() }));
  // Producer update (120 s) + capture flush (120 s) + scheduling margin.
  const until = Date.now() + 300_000;
  while (Date.now() < until) {
    if (fs.existsSync(`${statePath}.release`)) return { content: [{ type: 'text', text: GATE_REPLY }] };
    if (fs.existsSync(`${statePath}.abort`)) return { isError: true, content: [{ type: 'text', text: 'The checkpoint could not complete. Stop this task and report the checkpoint failure.' }] };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { isError: true, content: [{ type: 'text', text: 'The checkpoint timed out. Stop and report the checkpoint failure.' }] };
});
await server.connect(new StdioServerTransport());
return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startGate(process.argv[2]);
