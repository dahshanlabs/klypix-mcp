#!/usr/bin/env node
// Creates the fictional demo repository the README GIF is recorded against.
//
// Everything on screen in the demo must be real tool output over fictional
// content — never a real project, never real filenames (public-asset rule).
// This seeds "aurora", a small fictional weather app, with a few decisions,
// one standing correction, and one open question, via the same buildKlypix
// codec every writer uses.
//
// Usage: node docs/demo/setup.mjs [dir]   (default: ./.demo-repo, gitignored)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const { buildKlypix } = await import(pathToFileURL(path.join(repoRoot, 'src', 'klypix-format.mjs')).href);

const dir = path.resolve(process.argv[2] || path.join(repoRoot, '.demo-repo'));
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'src', 'auth'), { recursive: true });
fs.mkdirSync(path.join(dir, 'src', 'forecast'), { recursive: true });

// A believable little codebase for the declared files to point at.
fs.writeFileSync(path.join(dir, 'src', 'auth', 'token.ts'), 'export const refresh = () => {/* … */};\n');
fs.writeFileSync(path.join(dir, 'src', 'auth', 'routes.ts'), 'export const routes = [];\n');
fs.writeFileSync(path.join(dir, 'src', 'forecast', 'daily.ts'), 'export const daily = () => [];\n');
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'aurora', private: true }, null, 2));
fs.writeFileSync(path.join(dir, 'README.md'), '# aurora — a small weather app (fictional demo project)\n');

execSync('git init -q', { cwd: dir });
execSync('git add -A', { cwd: dir });
execSync('git -c user.email=demo@aurora.test -c user.name=aurora commit -qm "aurora: demo seed"', { cwd: dir });

const buf = await buildKlypix({
  name: 'brain',
  cards: [
    { text: 'Auth: refresh tokens rotate on every use — CORRECTION: supersedes "refresh tokens are long-lived". A stolen token dies at its first replay.' },
    { text: 'Auth: sessions are stored server-side only; the client holds an opaque id.' },
    { text: 'Forecast: the 7-day view ships behind a flag until the radar tiles are cached offline.' },
    { text: '? Forecast: do we interpolate missing hourly points, or show the gap honestly?' },
    { text: 'Strategy: one screen, one answer — aurora never shows two forecasts that disagree.' },
  ],
});
fs.writeFileSync(path.join(dir, 'brain.klypix'), buf);

console.log(dir);
