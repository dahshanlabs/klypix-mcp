// Crash-safe result files and experiment identity, shared by runner and report.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const experimentId = (config) => crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
export const runKey = (r) => JSON.stringify([r.scenario, r.condition, r.agent, r.run]);

/** Hash actual source bytes, including uncommitted edits, not just a Git revision. */
export function sourceFingerprint(root, entries) {
  const hash = crypto.createHash('sha256');
  const visit = (rel) => {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) { hash.update(`${rel}:missing\0`); return; }
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(rel, name));
    } else if (/\.(mjs|js|json)$/.test(rel)) {
      hash.update(rel.replaceAll('\\', '/')).update('\0').update(fs.readFileSync(file)).update('\0');
    }
  };
  entries.forEach(visit);
  return hash.digest('hex');
}

/** Only an incomplete final line may be discarded; interior corruption is fatal. */
export function parseResults(text, source = 'results') {
  const lines = text.split('\n');
  const rows = []; const kept = [];
  let discardedTail = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch {
      if (i === lines.length - 1 && !text.endsWith('\n')) { discardedTail = true; break; }
      throw new Error(`${source}:${i + 1}: invalid JSON (only an unfinished final line can be recovered)`);
    }
    if (!row || !['scenario', 'condition', 'agent'].every(k => typeof row[k] === 'string') || !Number.isInteger(row.run)) {
      throw new Error(`${source}:${i + 1}: invalid run identity`);
    }
    rows.push(row); kept.push(line);
  }
  return { rows, discardedTail, repairedText: kept.length ? `${kept.join('\n')}\n` : '' };
}

export function assertSameExperiment(rows, expected = null) {
  const ids = new Set(rows.map(r => r.experimentId || 'legacy'));
  if (ids.size > 1 || (expected && [...ids].some(id => id !== expected))) {
    throw new Error('Results belong to different or unverified experiments. Use a new --out file or report each experiment separately.');
  }
}

/** A retry replaces only its own experiment's run, and the latest error stays retryable. */
export function lastRowPerRun(rows) {
  assertSameExperiment(rows);
  const by = new Map();
  for (const r of rows) by.set(runKey(r), r);
  return [...by.values()];
}

export function pendingRuns(plan, rows, expected) {
  assertSameExperiment(rows, expected);
  const done = new Set(lastRowPerRun(rows).filter(r => !r.error && !r.invalid && !r.timedOut && r.agentOk !== false).map(runKey));
  return plan.filter(p => !done.has(runKey({ scenario: p.scenario.id, condition: p.condition.id, agent: p.agent.id, run: p.run })));
}
