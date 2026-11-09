import fs from 'node:fs';
import path from 'node:path';
import { claudeHookSettings, INSTALLED_CLAUDE_HOOKS } from '../coordination/conditions.mjs';
import { redactProcessCredential } from './auth.mjs';

// A transparent subprocess wrapper: the product receives the original event
// bytes, arguments and host environment. Successful context stdout is retained
// as evidence, never rewritten or replaced with fixture knowledge.
export function auditHookSource({ source, auditFile }) {
  return `import fs from 'node:fs';import {spawn} from 'node:child_process';
${redactProcessCredential.toString()}
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const input=Buffer.concat(chunks);let event={};try{event=JSON.parse(input.toString());}catch{}
const base={sessionId:event.session_id,hookEvent:event.hook_event_name,tool:event.tool_name||null,role:process.env.BENCH_DECISION_ROLE||null};
const log=record=>{try{fs.appendFileSync(${JSON.stringify(auditFile)},redactProcessCredential(JSON.stringify({...base,...record}))+'\\n',{mode:0o600});}catch{process.stderr.write('Benchmark hook audit could not be written.\\n');}};
log({phase:'start',at:Date.now()});
const child=spawn(process.execPath,[${JSON.stringify(source)},...process.argv.slice(2)],{env:process.env,cwd:process.cwd(),stdio:['pipe','pipe','pipe'],windowsHide:true});let stdout='',truncated=false;
child.stdout.on('data',chunk=>{process.stdout.write(chunk);if(stdout.length+chunk.length<=4194304)stdout+=chunk.toString();else truncated=true;});child.stderr.pipe(process.stderr);
child.on('error',error=>{log({phase:'end',at:Date.now(),exitCode:null,error:error.message});process.exitCode=1;});
child.on('close',code=>{log({phase:'end',at:Date.now(),exitCode:code,stdout,truncated});process.exit(code??1);});child.stdin.on('error',()=>{});child.stdin.end(input);
`;
}

export function readHookAudit(auditFile, { sessionId } = {}) {
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { const record = JSON.parse(line); return (!sessionId || record.sessionId === sessionId) ? [record] : []; }
    catch { return []; }
  });
}

export function deliveredHookEvidence(records) {
  return records.filter(record => record.phase !== 'start' && record.exitCode === 0 && !record.truncated
    && ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(record.hookEvent));
}

export function prepareKlypixHooks({ root, home }) {
  const source = path.join(root, 'src/global-brain-hook.mjs');
  if (!fs.existsSync(source)) throw new Error(`Native KLYPIX hook source missing: ${source}`);
  const wrapper = path.join(home, 'klypix-source-hook.mjs');
  const auditFile = path.join(home, 'klypix-hook-audit.jsonl');
  fs.writeFileSync(wrapper, auditHookSource({ source, auditFile }));
  // Same command form and event/matcher/timeout table as the source installer.
  const command = `node "${wrapper.replace(/\\/g, '/')}"`;
  return { settings: claudeHookSettings(command),
    metadata: { source, events: INSTALLED_CLAUDE_HOOKS, wrapper: 'transparent stdin/stdout audit; no session identity override' },
    hookAudit: options => readHookAudit(auditFile, options),
    exposureEvidence: options => deliveredHookEvidence(readHookAudit(auditFile, options)) };
}
