import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureHandoffTurns, handoffTranscript } from '../src/session-handoff.mjs';
import { opBrainHandoff } from '../src/klypix-core.mjs';
import { buildKlypixMap } from '../src/klypix-format.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-hosts-'));
const saved={HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE};
process.env.HOME=root; process.env.USERPROFILE=root;
try {
 const project=path.join(root,'project'); fs.mkdirSync(project);
 fs.writeFileSync(path.join(project,'brain.klypix'),await buildKlypixMap({title:'Host test',kind:'brain',areas:[{title:'Test',cards:[{text:'Seed'}]}]}));
 const now=Date.now();
 const turn={id:'u1',role:'user',at:now,text:'Compare the video; do not lose this followup'};
 for(const host of ['antigravity','cursor','cline','roo-code','kilo-code','github-copilot','continue','windsurf','aider','opencode','custom-host']) {
  const from={sessionId:`${host}:session/1`,client:host};
  const call=args=>opBrainHandoff({vault:project,from,...args});
  const captured=await call({action:'capture',turns:[turn]});
  assert.equal(captured.structured?.captured?.added,1,JSON.stringify(captured));
  assert.equal((await call({action:'capture',turns:[turn]})).structured.captured.added,0);
  assert.ok((await call({action:'capture',turns:[{...turn,text:'changed'}]})).isError);
  const written=await call({action:'write',title:'Followup',task:'Review media',next:['Compare video']});
  assert.ok(!written.isError,JSON.stringify(written)); const id=written.structured.id;
  const review=await opBrainHandoff({vault:project,from:{sessionId:'new-session',client:'codex'},action:'review',id});
  assert.equal(review.structured.freshness.coverage,'captured-only',JSON.stringify(review));
  assert.ok(review.blocks[0].text.includes('UNKNOWN'));
  const oldToken=review.structured.freshness.reviewToken;
  await call({action:'capture',turns:[{...turn,id:'u2',at:now+1,text:'Also check audio'}]});
  assert.ok((await call({action:'review',id,reviewToken:oldToken,summary:'done'})).isError);
  const page=await call({action:'review',id});
  assert.equal(page.structured.freshness.totalTurns,2);
  const ack=await call({action:'review',id,reviewToken:page.structured.freshness.reviewToken,summary:'Video and audio still pending'});
  assert.ok(!ack.isError,JSON.stringify(ack));
  assert.ok(ack.blocks[0].text.includes('UNKNOWN'));
  assert.ok((await call({action:'take',id})).blocks[0].text.includes('UNKNOWN'));
 }
 assert.throws(()=>captureHandoffTurns(project,'s','custom',[{...turn,at:NaN}]));
 const other=path.join(root,'other');fs.mkdirSync(other);
 fs.writeFileSync(path.join(other,'brain.klypix'),await buildKlypixMap({title:'Other',kind:'brain',areas:[{title:'Test',cards:[{text:'Seed'}]}]}));
 const foreign=await opBrainHandoff({vault:other,from:{sessionId:'antigravity:session/1',client:'antigravity'},action:'write',title:'Separate project',task:'Work',next:['Check']});
 assert.equal((await opBrainHandoff({vault:other,action:'review',id:foreign.structured.id})).structured.freshness.status,'unknown');
 const sid='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
 const dir=path.join(root,'.gemini','tmp','projecthash','chats');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'session-test.json');
 const record={sessionId:sid,messages:[{type:'user',timestamp:new Date(now).toISOString(),content:[{text:'Original request'}]},{type:'gemini',timestamp:new Date(now+1).toISOString(),content:'Working'},{type:'user',timestamp:new Date(now+2).toISOString(),content:'Unanswered followup'}]};
 fs.writeFileSync(file,JSON.stringify(record));
 const original=handoffTranscript(sid,'gemini-cli',{home:root});assert.equal(original.status,'available');assert.equal(original.turns.length,3);
 record.messages[2].content='Changed followup';fs.writeFileSync(file,JSON.stringify(record));
 assert.notEqual(handoffTranscript(sid,'gemini-cli',{home:root}).revision,original.revision);
 fs.copyFileSync(file,path.join(dir,'session-duplicate.json'));
 assert.equal(handoffTranscript(sid,'gemini-cli',{home:root}).status,'unknown');
 fs.unlinkSync(path.join(dir,'session-duplicate.json'));
 fs.writeFileSync(path.join(dir,'session-new.jsonl'),JSON.stringify({sessionId:sid})+'\n');
 assert.equal(handoffTranscript(sid,'gemini-cli',{home:root}).status,'unknown','new JSONL cannot be hidden by stale JSON');
 fs.unlinkSync(file);
 assert.equal(handoffTranscript(sid,'gemini-cli',{home:root}).status,'unknown','unsupported mutations fail closed');
 assert.throws(()=>captureHandoffTurns(project,'s','custom',[{...turn,at:Number.MAX_SAFE_INTEGER}]));
 console.log('PASS cross-host capture/review, deduplication, conflicting retries, stale tokens, project isolation, Gemini JSON and ambiguity');
} finally {
 for(const [k,v] of Object.entries(saved)) {if(v===undefined) delete process.env[k]; else process.env[k]=v;}
 fs.rmSync(root,{recursive:true,force:true});
}
