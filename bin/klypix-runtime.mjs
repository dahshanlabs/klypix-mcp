#!/usr/bin/env node
import os from 'os';
import path from 'path';
import { formatRuntimeReport, inspectKlypixRuntime } from '../src/runtime-inspector.mjs';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const json = args.includes('--json');
const brainDir = valueAfter('--brain-dir') || path.join(os.homedir(), '.claude', 'project-brain');
const watchSeconds = Math.max(0, Number(valueAfter('--watch') || 0));

const sample = () => {
  try {
    const report = inspectKlypixRuntime({ brainDir });
    process.stdout.write((json ? JSON.stringify(report) : formatRuntimeReport(report)) + '\n');
  } catch (error) {
    const message = error?.message || String(error);
    if (json) process.stdout.write(JSON.stringify({ schemaVersion: 1, passive: true, mutated: false, error: message }) + '\n');
    else process.stderr.write(`KLYPIX runtime inspection failed: ${message}\n`);
    process.exitCode = 1;
  }
};

sample();
if (watchSeconds > 0) {
  const timer = setInterval(sample, Math.max(5, watchSeconds) * 1_000);
  process.once('SIGINT', () => { clearInterval(timer); process.exit(); });
  process.once('SIGTERM', () => { clearInterval(timer); process.exit(); });
}

