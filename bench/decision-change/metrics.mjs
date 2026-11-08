import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { NOTES_NOTICE } from './notes-notify-hook.mjs';

const bodyText = block => typeof block.content === 'string' ? block.content
  : (block.content || []).map(item => item.text || '').join('\n');
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
const isDecisionNotice = text => /(?:## Decision changes: PENDING REVIEW|Decision (?:changes|change)[^\n]{0,100}PENDING REVIEW)/i.test(text);

export function createTelemetry({ repoDir }) {
  const calls = new Map(); const revisions = []; const responses = [];
  let lastHash;
  function snapshot(meta = {}) {
    try {
      const source = fs.readFileSync(path.join(repoDir, 'lib/invoice.mjs'), 'utf8');
      const digest = crypto.createHash('sha256').update(source).digest('hex');
      if (digest === lastHash) return;
      lastHash = digest;
      revisions.push({ at: Date.now(), hash: digest, source, ...meta });
    } catch (error) { revisions.push({ at: Date.now(), error: error.message, ...meta }); }
  }
  snapshot({ kind: 'initial' });
  return { revisions, responses, snapshot,
    observe(event) {
      for (const block of event?.message?.content || []) {
        if (block.type === 'tool_use') calls.set(block.id, { tool: block.name, input: block.input, at: Date.now() });
        if (block.type !== 'tool_result') continue;
        const call = calls.get(block.tool_use_id) || {};
        responses.push({ at: Date.now(), toolUseId: block.tool_use_id, tool: call.tool,
          isError: block.is_error === true, text: bodyText(block) });
        // Observe after any completed tool, including shell writes. No hidden
        // grader or expected answer is created while an agent is running.
        snapshot({ kind: 'completed-tool', toolUseId: block.tool_use_id, tool: call.tool });
      }
    },
  };
}

export function notificationMetrics({ responses = [], hookEvidence = [], changedAt, revisions = [] }) {
  const after = timestamp(changedAt);
  const records = [
    ...responses.filter(r => !r.isError).map(r => ({ ...r, channel: 'tool-result' })),
    ...hookEvidence.filter(r => r.exitCode === 0 && !r.truncated && r.phase !== 'start')
      .map(r => ({ ...r, text: r.stdout || r.text || '', channel: 'native-hook' })),
  ].filter(r => Number.isFinite(after) && timestamp(r.at) >= after);
  const notices = records.flatMap(record => {
    const kind = isDecisionNotice(record.text) ? 'watched-decision-change'
      : record.text.includes(NOTES_NOTICE) ? 'whole-notes-change' : null;
    return kind ? [{ at: timestamp(record.at), kind, channel: record.channel,
      tool: record.tool || null, hookEvent: record.hookEvent || null, text: record.text }] : [];
  }).sort((a, b) => a.at - b.at);
  const firstWrite = revisions.find(r => r.kind !== 'initial' && !r.error && r.at >= after);
  return { notices, decisionNotices: notices.filter(n => n.kind === 'watched-decision-change').length,
    genericNotesNotices: notices.filter(n => n.kind === 'whole-notes-change').length,
    timeOrigin: 'Producer stage and capture flush finished; this is not the exact memory-write timestamp',
    firstNoticeAfterCaptureFinishedMs: notices.length ? notices[0].at - after : null,
    noticeBeforeFirstCodeRevision: firstWrite && notices.length ? notices[0].at < firstWrite.at : null };
}

// Called ONLY after the consumer exits. Each captured revision is executed in
// a separate temporary directory, with no output fed back into its transcript.
// Relative imports are unsupported for historical snapshots: report unknown
// rather than evaluate against later versions of their dependencies.
export function gradeRevisions({ revisions, changed, scratchDir, env }) {
  const expected = changed ? [17, 115, 0, 110] : [18, 116, 0, 110];
  const old = [18, 116, 0, 110];
  const results = revisions.filter(r => r.kind !== 'initial').map((revision, index) => {
    if (!revision.source || revision.error) return { ...revision, source: undefined, classification: 'unknown' };
    if (/\b(?:import|export)\s[^;\n]*\bfrom\s*['"]\.|\bimport\s*\(\s*['"]\./.test(revision.source)) {
      return { ...revision, source: undefined, classification: 'unknown-relative-import' };
    }
    const dir = path.join(scratchDir, `revision-${index}`); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'invoice.mjs'), revision.source);
    fs.writeFileSync(path.join(dir, 'probe.mjs'), `import {invoiceTotalCents as f} from './invoice.mjs';\nconsole.log(JSON.stringify([f([5,5,5],10),f([25,25,25,25],15),f([],20),f([100],10)]));\n`);
    const result = spawnSync(process.execPath, [path.join(dir, 'probe.mjs')], {
      cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 3000,
    });
    let values;
    try { values = JSON.parse(String(result.stdout || '').trim().split('\n').at(-1)); } catch { /* incomplete implementation */ }
    const matches = target => result.status === 0 && JSON.stringify(values) === JSON.stringify(target);
    return { ...revision, source: undefined, values: values || null,
      classification: matches(expected) ? 'current-policy-correct' : changed && matches(old) ? 'stale-policy-correct' : 'other-or-incomplete' };
  });
  const firstCorrect = results.findIndex(r => r.classification === 'current-policy-correct');
  const firstStale = results.findIndex(r => r.classification === 'stale-policy-correct');
  const eligible = results.every(r => !r.classification.startsWith('unknown'));
  return { revisions: results, observedCodeRevisions: results.length, eligibleForReworkComparison: eligible,
    firstCodeRevisionCurrent: results.length ? results[0].classification === 'current-policy-correct' : null,
    staleCodeRevisions: eligible ? results.filter(r => r.classification === 'stale-policy-correct').length : null,
    knownStaleCodeRevisions: results.filter(r => r.classification === 'stale-policy-correct').length,
    correctedAfterStaleCode: firstStale >= 0 && firstCorrect > firstStale,
    revisionsBeforeFirstCorrect: firstCorrect >= 0 ? firstCorrect : null,
    observationLimit: 'Completed-tool snapshots; coalesced or within-tool intermediate writes are not observed. This measures code revisions, not hidden reasoning or all rework.' };
}
