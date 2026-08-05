import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klypix-map-cli-'));
const cli = fileURLToPath(new URL('../bin/klypix-project-map.mjs', import.meta.url));
let failures = 0;
const ok = (condition, label) => { console.log(`${condition ? '✓' : '✗'} ${label}`); if (!condition) failures++; };

try {
  fs.mkdirSync(path.join(root, '.git'));
  const first = spawnSync(process.execPath, [cli, 'setup-github', root], { encoding: 'utf8' });
  const workflow = path.join(root, '.github', 'workflows', 'klypix-project-map.yml');
  ok(first.status === 0 && fs.existsSync(workflow), 'setup-github installs the pinned workflow into an explicit Git checkout');
  const installed = fs.readFileSync(workflow, 'utf8');
  ok(/permissions:\s*\n\s*contents: read/.test(installed) && /graphifyy==\$\{GRAPHIFY_VERSION\}/.test(installed), 'workflow has read-only permissions and a pinned provider version');
  fs.writeFileSync(workflow, '# user-owned workflow\n');
  const collision = spawnSync(process.execPath, [cli, 'setup-github', root], { encoding: 'utf8' });
  ok(collision.status !== 0 && fs.readFileSync(workflow, 'utf8') === '# user-owned workflow\n', 'setup-github never overwrites a user workflow without --force');
  const forced = spawnSync(process.execPath, [cli, 'setup-github', root, '--force'], { encoding: 'utf8' });
  ok(forced.status === 0 && fs.readFileSync(workflow, 'utf8') === installed, '--force performs the explicit replacement');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} Project Map CLI assertion(s) failed` : '\n✓ Project Map CLI: all assertions passed');
process.exit(failures ? 1 : 0);
