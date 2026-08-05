#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { discoverProjectGraph } from '../src/project-graph.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = path.resolve(here, '..', 'examples', 'github', 'klypix-project-map.yml');
const args = process.argv.slice(2);
const command = args[0] || 'status';
const force = args.includes('--force');
const rootArg = args.find((value, index) => index > 0 && value !== '--force') || process.cwd();

function projectRoot(value) {
  const root = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(root).isDirectory()) throw new Error('Project root is not a directory.');
  return root;
}

function usage() {
  console.log([
    'KLYPIX Project Map',
    '',
    '  klypix-project-map status [project]',
    '  klypix-project-map setup-github [project] [--force]',
    '',
    'setup-github installs a read-only, pinned GitHub Actions workflow. It never installs or runs a provider on your computer.',
  ].join('\n'));
}

try {
  if (command === '--help' || command === '-h' || command === 'help') {
    usage();
    process.exit(0);
  }
  const root = projectRoot(rootArg);
  if (command === 'status') {
    const graph = discoverProjectGraph({ project: root });
    const workflow = path.join(root, '.github', 'workflows', 'klypix-project-map.yml');
    console.log(`Project: ${root}`);
    console.log(`Graph artifact: ${graph.status === 'ready' ? `ready (${graph.artifact.graphJson})` : `missing (${graph.artifact.graphJson})`}`);
    console.log(`GitHub workflow: ${fs.existsSync(workflow) ? 'installed' : 'not installed'}`);
    process.exit(0);
  }
  if (command !== 'setup-github') {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error('Run setup-github inside a Git checkout.');
  const destination = path.join(root, '.github', 'workflows', 'klypix-project-map.yml');
  const source = fs.readFileSync(template, 'utf8');
  if (fs.existsSync(destination)) {
    const current = fs.readFileSync(destination, 'utf8');
    if (current === source) {
      console.log(`Project Map workflow is already current: ${destination}`);
      process.exit(0);
    }
    if (!force) throw new Error(`Workflow already exists with different contents: ${destination}\nReview it, then rerun with --force if replacement is intended.`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source, { encoding: 'utf8', flag: 'w' });
  console.log(`Installed Project Map workflow: ${destination}`);
  console.log('Commit the workflow when you are ready. Pull requests and main-branch pushes will produce a read-only Project Map artifact.');
} catch (error) {
  console.error(`Project Map: ${error?.message || error}`);
  process.exit(1);
}
