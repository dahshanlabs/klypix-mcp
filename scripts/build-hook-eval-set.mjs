#!/usr/bin/env node
// Build a frozen founder-prompt set for the per-prompt hook lane from the
// machine-local enrichment sidecar. Every recorded (prompt, card body) pair is
// a prompt a human actually typed in this project and the card that session
// then captured — the only source of real prompt vocabulary the engine has.
// Private text by construction: the output goes wherever the caller points it
// and is never bundled or published.
//
// Two strata come out:
//   capture-pair — the prompt passes the enrichment quality gate and at least
//                  one live card still carries the body it was recorded
//                  against. Gold = those card(s). Proxy semantics, stated on
//                  the set itself: the card was CREATED after the prompt, so
//                  this measures "would a prompt like this one recall the card
//                  next time", not "did the hook help that very turn".
//   no-inject    — the prompt fails the gate (acknowledgement, console echo,
//                  machine turn, pasted document). The correct behaviour for
//                  these is to inject NOTHING; they are the abstention stratum
//                  the hook lane never had. Only a sidecar written before the
//                  1.86 gate still contains them — later sidecars never do.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'node scripts/build-hook-eval-set.mjs --brain PATH --out PATH [--engine DIR] [--home DIR]';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const flat = (text) => String(text || '').replace(/\s+/g, ' ').trim();

function options(argv) {
  const result = { engine: root };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return null;
    const key = argv[i].slice(2);
    if (!['brain', 'out', 'engine', 'home'].includes(key) || !argv[i].startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(usage);
    result[key] = argv[++i];
  }
  if (!result.brain || !result.out) throw new Error(usage);
  for (const key of ['brain', 'out', 'engine', 'home']) if (result[key]) result[key] = path.resolve(result[key]);
  if (fs.existsSync(result.out)) throw new Error('Output must be a new file.');
  return result;
}

async function main() {
  const args = options(process.argv.slice(2));
  if (!args) { console.log(usage); return; }
  const lib = await import(pathToFileURL(path.join(args.engine, 'src', 'klypix-format.mjs')).href);
  const enrich = await import(pathToFileURL(path.join(args.engine, 'src', 'enrichment.mjs')).href);
  const brainBytes = fs.readFileSync(args.brain);
  const { struct } = await lib.parseKlypix(brainBytes);
  const home = args.home || os.homedir();
  const sidecarFile = enrich.enrichmentFileFor(args.brain, home);
  let sidecarBytes;
  try { sidecarBytes = fs.readFileSync(sidecarFile); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`No enrichment sidecar for this brain at ${sidecarFile}`); throw error; }
  const raw = JSON.parse(sidecarBytes.toString('utf8'));
  const entries = Object.entries(raw?.entries || {});
  // Raw entries on purpose: readEnrichment applies the quality gate, and the
  // texts it drops are exactly the no-inject stratum this builder wants.
  const live = struct.cards.filter((card) => card.type !== 'container' && (card.text || '').trim() && !/^archive$/i.test(card.area || ''));
  const haystack = live.map((card) => ({ card, norm: enrich.normalizeForKey(String(card.text).slice(0, 1500)) }));
  const seen = new Set();
  const questions = [];
  const counts = { capturePair: 0, noInject: 0, orphan: 0, duplicate: 0 };
  const rejectReasons = {};
  for (const [key, entry] of entries) {
    const golds = haystack.filter((h) => h.norm.includes(key)).map((h) => h.card);
    for (const text of entry?.q || []) {
      const quality = enrich.enrichmentQuestionQuality(text);
      const norm = enrich.normalizeForKey(quality.text);
      if (!norm) continue;
      if (seen.has(norm)) { counts.duplicate++; continue; }
      if (!quality.ok) {
        seen.add(norm);
        counts.noInject++;
        rejectReasons[quality.reason] = (rejectReasons[quality.reason] || 0) + 1;
        questions.push({ q: quality.text, strategy: 'no-inject', reason: quality.reason, goldIds: [], goldTexts: [] });
        continue;
      }
      if (!golds.length) { counts.orphan++; continue; }   // the card was merged, edited or deleted since — no gold, no question
      seen.add(norm);
      counts.capturePair++;
      questions.push({ q: quality.text, strategy: 'capture-pair', goldIds: golds.map((card) => card.id), goldTexts: golds.map((card) => flat(card.text)) });
    }
  }
  questions.sort((a, b) => a.strategy.localeCompare(b.strategy) || a.q.localeCompare(b.q));
  const document = {
    version: 1,
    tier: 'hook-lane-capture-pair',
    label: 'frozen founder prompts for the per-prompt hook lane (capture-pair proxy + no-inject stratum)',
    builtAt: new Date().toISOString(),
    brainSha256: hash(brainBytes),
    sidecarSha256: hash(sidecarBytes),
    brainCards: struct.cards.length,
    counts,
    rejectReasons,
    limitations: 'Prompts are the human turns that PRECEDED a capture, paired with the card that capture produced; each card post-dates its prompt, so recall here means "a prompt like this would find the card next time". The hook\'s git-diff fallback for terse prompts is not reproduced. Private text: never bundle or publish this file.',
    questions,
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: args.out, brainCards: struct.cards.length, sidecarEntries: entries.length, ...counts, rejectReasons }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
