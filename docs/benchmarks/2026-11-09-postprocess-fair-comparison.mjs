// Fifth-experiment report preparation. No model calls, ledger writes, or prior-file edits.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { aggregate, loadRun, renderMarkdown, assertPublicSummarySafe } from './postprocess.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<1e-8;
const sum=values=>values.reduce((a,b)=>a+b,0);
const sorted=values=>[...values].sort();
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const recordShape=r=>r&&({id:r.id,kind:r.kind,status:r.status,actualUsd:r.actualUsd,actualCents:r.actualCents,maxCents:r.maxCents});
const sameRecords=(a,b)=>equal((a||[]).map(recordShape),(b||[]).map(recordShape));
const safeId=value=>/^[a-zA-Z0-9_-]{1,180}$/.test(value||'')?value:`redacted-${sha(String(value)).slice(0,12)}`;
const safeHash=value=>/^[a-f0-9]{40,64}$/.test(value||'')?value:null;
export const POSTPROCESSOR_VERSION='observer-sdk-compatible-report-2.1';
export const EXPERIMENT_LABEL='observer-sdk-compatible-v1';
export const API_AUTHENTICATION=Object.freeze({method:'api-key',transport:'DPAPI at rest; current-user Windows named pipe; spawn-only environment'});
const apiAuthentication=auth=>auth?.method===API_AUTHENTICATION.method&&auth?.transport===API_AUTHENTICATION.transport;
export const PRIOR_REPORT_FILES=['docs/benchmarks/2026-11-09-interrupted-run.json','docs/benchmarks/2026-11-09-native-audit-v1-result.json','docs/benchmarks/2026-11-09-native-audit-v2-result.json','docs/benchmarks/2026-11-09-native-audit-v3-result.json'];
export const SETUP_GATES=['noManualSave','ordinaryProducerToolWork','producerQueueDrained','automaticObservation','nativeSearchFindsObservation','defaultSemanticRoundTrip','consumerMemoryOnly','consumerRetrievedSameObservation','consumerAnswer','consumerQueueDrained','dependenciesHealthy','accountingComplete','noObserverTransportErrors','ownCleanup','apiAuthentication'];
const OUTCOMES=new Set(['pass','measured-failure','stalled','setup-not-measured','budget-not-measured','budget-limited','exposure-unverified','accounting-ineligible']);

// Pure parser permits exact byte-prefix verification without creating another ledger.
export function ledgerSnapshot(bytes){
  const issues=[],events=[],records=new Map();let limitUsd=null,halted=false;
  const lines=bytes.toString('utf8').split('\n').filter(Boolean);
  for(let index=0;index<lines.length;index++){
    let event;try{event=JSON.parse(lines[index]);}catch{issues.push('invalid-ledger-json');continue;}events.push(event);
    if(index===0){if(event.type!=='init'||!integer(event.limitCents))issues.push('invalid-ledger-init');else limitUsd=event.limitCents/100;continue;}
    if(event.type==='reserve'){
      if(!event.id||records.has(event.id)||!integer(event.maxCents)){issues.push('invalid-ledger-reserve');continue;}
      records.set(event.id,{id:event.id,kind:event.kind,maxCents:event.maxCents,status:'reserved'});
    }else if(event.type==='settle'||event.type==='unknown'){
      const prior=records.get(event.id);if(!prior||prior.status!=='reserved'){issues.push('invalid-ledger-settle');continue;}
      if(event.type==='settle'&&(!finite(event.actualUsd)||!integer(event.actualCents)))issues.push('invalid-ledger-cost');
      if(event.type==='unknown'||event.actualCents>prior.maxCents)halted=true;
      records.set(event.id,{...prior,status:event.type,actualUsd:event.actualUsd,actualCents:event.actualCents});
    }else if(event.type==='halt')halted=true;else issues.push('invalid-ledger-event');
  }
  const reservations=[...records.values()];
  return{events,issues,limitUsd,halted,reservations,uncertain:reservations.some(r=>r.status!=='settle'||!finite(r.actualUsd)),
    knownApiEquivalentUsd:sum(reservations.filter(r=>r.status==='settle'&&finite(r.actualUsd)).map(r=>r.actualUsd)),
    chargedAgainstCapUsd:sum(reservations.filter(r=>r.status!=='reserved').map(r=>r.status==='unknown'?r.maxCents:(r.actualCents||0)))/100,
    outstandingReservedUsd:sum(reservations.filter(r=>r.status==='reserved').map(r=>r.maxCents))/100};
}
function successfulSetup(receipt){
  return receipt?.success===true&&!receipt.error&&apiAuthentication(receipt.authentication)
    &&apiAuthentication(receipt.configuration?.authentication)&&receipt.configuration?.oauthCredentialCopied===false
    &&SETUP_GATES.every(g=>receipt.gates?.[g]===true)
    &&Object.values(receipt.gates||{}).every(v=>v===true)&&receipt.stages?.length===2
    &&['setup-producer','setup-consumer'].every(role=>{const stages=receipt.stages.filter(s=>s.role===role);return stages.length===1
      &&stages[0].ok===true&&stages[0].exitCode===0&&stages[0].nativeAuditFinalized===true&&stages[0].pendingResults===0
      &&stages[0].telemetryErrorCount===0&&!stages[0].budgetLimited&&!stages[0].timedOut&&typeof stages[0].sessionId==='string'
      &&stages[0].model==='claude-haiku-5-5'&&apiAuthentication(stages[0].authentication);})
    &&receipt.stages[0].sessionId!==receipt.stages[1].sessionId
    &&receipt.cleanup?.credentialsRemoved===true&&receipt.cleanup?.nativeCloseReturned===true&&receipt.cleanup?.workerPortClosed===true
    &&receipt.cleanup?.knownProcessCount>0&&Array.isArray(receipt.cleanup?.remainingKnownPids)&&receipt.cleanup.remainingKnownPids.length===0
    &&receipt.observerAccounting?.records?.length>0&&receipt.observerAccounting.refusalCount===0
    &&receipt.observerAccounting.records.every(r=>r.status==='settled'&&!r.capped&&!r.inFlight&&r.authMethod==='api-key');
}
function publicPriorReports(priorReports,freeze,issues){
  const expectedCounts=[2,2,1,4],results=[];
  for(let index=0;index<PRIOR_REPORT_FILES.length;index++){
    const file=PRIOR_REPORT_FILES[index],found=priorReports.find(item=>item.file===file),report=found?.report;
    if(!report||found.sha256!==freeze.priorDiagnostics?.[file]?.sha256){issues.push('prior-report-missing-or-hash-mismatch');continue;}
    const raw=index===0?report.attempts:report.results;
    if(!Array.isArray(raw)||raw.length!==expectedCounts[index]||report.attempted!==expectedCounts[index]||report.notStarted!==30-expectedCounts[index])issues.push('prior-attempt-count-mismatch');
    const knownCost=index===0?report.cost?.apiEquivalentUsd:report.cost?.newKnownApiEquivalentUsd;
    const charged=index===0?report.cost?.chargedAgainstBudgetUsd:report.cost?.globalChargedAgainstBudgetUsd-report.cost?.priorConservativeChargeUsd;
    const attempts=(raw||[]).map(row=>({id:safeId(row.runId),condition:safeId(row.condition),scenario:row.scenario?safeId(row.scenario):null,
      originalCategory:OUTCOMES.has(row.originalCategory)?row.originalCategory:'unclassified',originalSuccess:row.originalSuccess===true,
      knownApiEquivalentUsd:index===0?row.knownForegroundApiEquivalentUsd:index===3?row.settledKnownApiEquivalentUsd:row.apiEquivalentUsd,
      firstAttempt:true,pooledIntoCurrentComparison:false}));
    if(!near(sum(attempts.map(a=>a.knownApiEquivalentUsd)),knownCost)||!finite(charged))issues.push('prior-report-cost-mismatch');
    results.push({ordinal:index+1,sourceCommit:safeHash(report.sourceCommit),protocolCommit:safeHash(report.protocolCommit),publishedReport:file,
      publishedReportSha256:found.sha256,attempted:report.attempted,notStarted:report.notStarted,knownApiEquivalentUsd:knownCost,chargedAgainstBudgetUsd:charged,attempts});
  }
  if(results.length!==4||sum(results.map(r=>r.attempts.length))!==9||new Set(results.flatMap(r=>r.attempts.map(a=>a.id))).size!==9)issues.push('prior-nine-attempts-not-preserved');
  return results;
}

export function aggregateObserverFixed({input,freeze,ledgerBytes,priorReports=[],setupReceipts=[],cleanupResolutions=[],continuation=null,continuationV2=null,runEvidence={}}){
  if(!input.experiment)return{status:'no-registered-data',resultClaim:'Fifth matrix has not started. Earlier experiments and setup diagnostics remain separate; no new performance result exists.'};
  const issues=[...input.issues],baseline=freeze?.baselineSharedLedger||{},runtime=input.experiment.ledgerBaseline||{};
  const add=(condition,code)=>{if(!condition)issues.push(code);};
  add(freeze?.kind==='fifth-experiment-pre-run-freeze'&&freeze.experimentOrdinal===5&&freeze.experimentLabel===EXPERIMENT_LABEL,'fifth-freeze-identity-mismatch');
  add(freeze?.measurementTransport==='native-audit-v3'&&input.experiment.measurementTransport==='native-audit-v3','measurement-transport-mismatch');
  add(apiAuthentication(freeze?.authentication)&&apiAuthentication(input.experiment.authentication),'current-api-authentication-not-established');
  add(freeze?.seed==='decision-change-pilot-20261108'&&input.experiment.seed===freeze.seed,'registered-seed-changed');
  for(const [field,key]of [['plan','registeredPlanSha256'],['passMarks','registeredPassMarksSha256'],['limits','registeredLimitsSha256']])
    add(sha(JSON.stringify(input.experiment[field]??null))===freeze?.[key],`registered-${field}-changed`);
  const sourceHashes=input.experiment.sourceHashes||{},frozenSources=freeze?.sourceFiles||{};
  const expectedSourceNames=Object.keys(frozenSources).filter(p=>/^bench\/decision-change\/[^/]+\.mjs$/.test(p)).map(p=>p.slice('bench/decision-change/'.length));
  add(expectedSourceNames.length>0&&equal(sorted(Object.keys(sourceHashes)),sorted(expectedSourceNames))
    &&expectedSourceNames.every(name=>sourceHashes[name]===frozenSources['bench/decision-change/'+name].rawSha256),'runtime-source-fingerprint-mismatch');
  const validLength=integer(baseline.byteLength)&&baseline.byteLength>0&&baseline.byteLength<=ledgerBytes.length&&ledgerBytes[baseline.byteLength-1]===10;
  add(validLength&&sha(ledgerBytes.subarray(0,baseline.byteLength))===baseline.sha256,'baseline-ledger-prefix-changed');
  const frozenSnapshot=ledgerSnapshot(validLength?ledgerBytes.subarray(0,baseline.byteLength):Buffer.from(''));
  const all=ledgerSnapshot(ledgerBytes),records=baseline.reservations||[],recordMap=new Map(records.map(r=>[r.id,r]));
  const baselineIds=new Set(records.map(r=>r.id));
  add(baselineIds.size===records.length&&sameRecords(records,frozenSnapshot.reservations),'frozen-baseline-records-mismatch');
  add(!frozenSnapshot.issues.length&&!frozenSnapshot.halted&&!frozenSnapshot.uncertain&&frozenSnapshot.outstandingReservedUsd===0
    &&frozenSnapshot.limitUsd===50&&baseline.budgetLimitUsd===50&&baseline.oneGlobalBudgetContinues===true
    &&baseline.allReservationsSettledAndKnown===true&&baseline.halted===false&&baseline.outstandingReservedUsd===0,'baseline-accounting-invalid');
  add(near(baseline.knownApiEquivalentUsd,frozenSnapshot.knownApiEquivalentUsd)&&near(baseline.chargedAgainstBudgetUsd,frozenSnapshot.chargedAgainstCapUsd),'baseline-cost-mismatch');
  add(runtime.sha256===baseline.sha256&&runtime.byteLength===baseline.byteLength&&equal(sorted(runtime.reservationIds||[]),sorted(baselineIds))
    &&near(runtime.knownApiEquivalentUsd,baseline.knownApiEquivalentUsd)&&near(runtime.chargedAgainstBudgetUsd,baseline.chargedAgainstBudgetUsd),'experiment-baseline-does-not-match-freeze');
  issues.push(...all.issues);
  add(all.limitUsd===50&&input.ledger.limitUsd===50&&sameRecords(all.reservations,input.ledger.reservations)
    &&near(all.knownApiEquivalentUsd,input.ledger.knownApiEquivalentUsd)&&near(all.chargedAgainstCapUsd,input.ledger.chargedAgainstCapUsd),'global-ledger-snapshot-mismatch');
  for(const record of records)add(equal(recordShape(record),recordShape(all.reservations.find(r=>r.id===record.id))),'baseline-record-mutated');
  const prior=publicPriorReports(priorReports,freeze||{},issues),priorCost=sum(prior.map(r=>r.knownApiEquivalentUsd)),priorCharge=sum(prior.map(r=>r.chargedAgainstBudgetUsd));
  add(priorReports.length===4&&new Set(priorReports.map(r=>r.file)).size===4,'prior-report-set-mismatch');
  const expectedIds=new Set();
  for(const attempt of prior.flatMap(r=>r.attempts)){
    const attributed=records.filter(r=>r.id.startsWith(attempt.id+'-'));
    add(near(sum(attributed.map(r=>r.actualUsd)),attempt.knownApiEquivalentUsd),'prior-attempt-ledger-cost-mismatch');
    for(const record of attributed){add(!expectedIds.has(record.id),'prior-cost-attributed-twice');expectedIds.add(record.id);}
  }
  const first=priorReports.find(r=>r.file===PRIOR_REPORT_FILES[0])?.report,fourth=priorReports.find(r=>r.file===PRIOR_REPORT_FILES[3])?.report;
  const holds=[first?.administrativeHold,fourth?.cost?.administrativeReviewHold];
  for(const hold of holds){
    const record=recordMap.get(hold?.id),reserves=all.events.filter(e=>e.type==='reserve'&&e.id===hold?.id),settles=all.events.filter(e=>e.type==='settle'&&e.id===hold?.id);
    add(hold?.noPaidCall===true&&hold.settledUsd===0&&record?.kind==='administrative-hold'&&record.status==='settle'
      &&record.actualUsd===0&&record.actualCents===0&&reserves.length===1&&reserves[0].meta?.noPaidCall===true&&settles.length===1,'prior-administrative-hold-not-proven-zero');
    if(record){add(!expectedIds.has(record.id),'prior-hold-attributed-twice');expectedIds.add(record.id);}
  }
  add(near(sum([...expectedIds].map(id=>recordMap.get(id)?.actualUsd)),priorCost)
    &&near(sum([...expectedIds].map(id=>recordMap.get(id)?.actualCents))/100,priorCharge),'published-prior-total-mismatch');
  const manifests=freeze?.setupDiagnostics||[],setupPublic=[];
  add(manifests.length>0&&manifests.length===setupReceipts.length&&equal(freeze?.setupDiagnostic,manifests.at(-1)),'setup-diagnostics-manifest-mismatch');
  add(new Set(setupReceipts.map(r=>r.receipt?.runId)).size===setupReceipts.length,'duplicate-setup-diagnostic');
  let previousFinished=0;
  for(let index=0;index<setupReceipts.length;index++){
    const item=setupReceipts[index],receipt=item.receipt||{},manifest=manifests[index]||{};
    add(item.sha256===manifest.receiptSha256&&receipt.runId===manifest.runId&&receipt.version===manifest.version
      &&receipt.sourceRevision===manifest.sourceRevision&&receipt.protocolRevision===manifest.protocolRevision&&receipt.scriptSha256===manifest.scriptSha256
      &&receipt.kind==='setup-diagnostic-not-benchmark'&&/^native-observer-(?:api-)?setup-probe-v[1-9]\d*$/.test(receipt.version||'')
      &&/^[a-f0-9]{40}$/.test(receipt.sourceRevision||'')&&manifest.successful===(receipt.success===true),'setup-receipt-identity-mismatch');
    const setupAuthMethod=receipt.authentication?.method||(receipt.version==='native-observer-setup-probe-v1'?'subscription':'unknown');
    add(manifest.authentication?.method===setupAuthMethod,'setup-authentication-manifest-mismatch');
    if(setupAuthMethod==='api-key')add(apiAuthentication(receipt.authentication)&&apiAuthentication(manifest.authentication)
      &&apiAuthentication(receipt.configuration?.authentication)&&receipt.configuration?.oauthCredentialCopied===false
      &&(receipt.stages||[]).every(s=>apiAuthentication(s.authentication)),'api-setup-authentication-mismatch');
    const start=Date.parse(receipt.startedAt),finish=Date.parse(receipt.finishedAt);
    add(Number.isFinite(start)&&Number.isFinite(finish)&&finish>=start&&start>=previousFinished,'setup-receipt-order-invalid');previousFinished=finish;
    const length=receipt.ledgerBaselineBytes;
    const prefixValid=integer(length)&&length>0&&length<=baseline.byteLength&&ledgerBytes[length-1]===10;
    add(prefixValid&&sha(ledgerBytes.subarray(0,length))===receipt.ledgerBaselineSha256
      &&manifest.ledgerBaselineSha256===receipt.ledgerBaselineSha256&&manifest.ledgerBaselineBytes===length,'setup-ledger-prefix-invalid');
    const prefix=ledgerSnapshot(prefixValid?ledgerBytes.subarray(0,length):Buffer.from(''));
    add(!prefix.issues.length&&!prefix.uncertain&&!prefix.halted&&equal(sorted(prefix.reservations.map(r=>r.id)),sorted(expectedIds)),'setup-prefix-chain-mismatch');
    if(index===0)add(receipt.ledgerBaselineSha256===fourth?.inputHashes?.ledger,'first-setup-baseline-not-fourth-report');
    add(near(receipt.priorActualUsd,prefix.knownApiEquivalentUsd)&&near(receipt.priorChargedUsd,prefix.chargedAgainstCapUsd),'setup-prior-cost-mismatch');
    const setupRecords=[],observers=receipt.observerAccounting?.records||[];
    add(receipt.cost?.uncertain===false&&Array.isArray(receipt.cost?.reservations),'setup-cost-unknown');
    for(const reported of receipt.cost?.reservations||[]){
      const actual=recordMap.get(reported.id);
      add(actual&&!expectedIds.has(actual.id)&&actual.status==='settle'&&reported.status==='settle'&&actual.kind===reported.kind
        &&near(actual.actualUsd,reported.actualUsd)&&near(actual.maxCents/100,reported.reservedUsd),'setup-cost-missing-reused-or-mismatched');
      if(!actual)continue;
      if(setupAuthMethod==='api-key')add(all.events.find(e=>e.type==='reserve'&&e.id===actual.id)?.meta?.authMethod==='api-key','api-setup-ledger-authentication-mismatch');
      if(actual.kind==='observer'){
        const matches=observers.filter(o=>o.id===actual.id);
        add(matches.length===1&&matches[0].status==='settled'&&near(matches[0].cost,actual.actualUsd)
          &&['claude-haiku-5-5','claude-sonnet-5-5'].includes(matches[0].model)
          &&(setupAuthMethod!=='api-key'||matches[0].authMethod==='api-key'),'setup-observer-cost-mismatch');
      }else{
        const role=['setup-producer','setup-consumer'].find(role=>actual.id===receipt.runId+'-'+role);
        add(role&&actual.kind==='agent:'+role&&(receipt.stages||[]).some(s=>s.role===role&&near(s.costUsd,actual.actualUsd)),'setup-foreground-cost-unattributed');
      }
      setupRecords.push(actual);expectedIds.add(actual.id);
    }
    add(observers.every(o=>setupRecords.some(r=>r.id===o.id)),'setup-observer-unattributed');
    const actualCost=sum(setupRecords.map(r=>r.actualUsd)),charged=sum(setupRecords.map(r=>r.actualCents))/100;
    add(near(actualCost,receipt.cost?.apiEquivalentUsd)&&near(charged,receipt.cost?.chargedAgainstCapUsd)
      &&near(actualCost,manifest.newKnownApiEquivalentUsd)&&near(charged,manifest.chargedAgainstBudgetUsd)
      &&equal(sorted(setupRecords.map(r=>r.id)),sorted(manifest.reservationIds||[])),'setup-total-cost-mismatch');
    add(near(sum([...expectedIds].map(id=>recordMap.get(id)?.actualUsd)),receipt.totalActualUsd)
      &&near(sum([...expectedIds].map(id=>recordMap.get(id)?.actualCents))/100,receipt.totalChargedUsd),'setup-final-cost-mismatch');
    if(index===setupReceipts.length-1){
      add(receipt.sourceRevision===freeze.sourceCommit,'successful-setup-source-not-current-freeze');
      add(successfulSetup(receipt),'successful-native-setup-not-established');
      for(const record of setupRecords){const reserve=all.events.find(e=>e.type==='reserve'&&e.id===record.id);
        add(reserve?.meta?.authMethod==='api-key','successful-setup-ledger-authentication-mismatch');}
    }
    setupPublic.push({ordinal:index+1,kind:'setup-diagnostic-not-benchmark',runId:safeId(receipt.runId),originalSuccess:receipt.success===true,
      receiptSha256:safeHash(item.sha256),sourceRevision:safeHash(receipt.sourceRevision),protocolRevision:safeHash(receipt.protocolRevision),
      authentication:{method:setupAuthMethod},knownApiEquivalentUsd:actualCost,chargedAgainstBudgetUsd:charged,pooledIntoCurrentComparison:false,
      interpretation:receipt.success===true?'Native setup verification, not a comparative product result':'Earlier failed setup retained; not a competitor loss'});
  }
  add(equal(sorted(expectedIds),sorted(baselineIds)),'unattributed-baseline-reservation');
  const newRecords=all.reservations.filter(r=>!baselineIds.has(r.id)),assigned=new Set(input.rows.flatMap(row=>(row.cost?.reservations||[]).map(r=>r.id)));
  add(![...assigned].some(id=>baselineIds.has(id)),'prior-or-setup-cost-pooled-into-current-row');
  const unattributed=newRecords.filter(r=>!assigned.has(r.id));add(unattributed.length===0,'new-unattributed-reservation');
  for(const record of newRecords){if(record.kind==='observer'||record.kind?.startsWith('agent:')){
    const reserve=all.events.find(e=>e.type==='reserve'&&e.id===record.id);add(reserve?.meta?.authMethod==='api-key','current-ledger-authentication-mismatch');}}
  const resolvedCleanup=new Map(),cleanupReviews=[];
  let continuationReview=null;
  if(continuation||cleanupResolutions.length){
    const c=continuation?.receipt||{},original=c.originalResultsPrefix||{},originalBytes=runEvidence.originalResultsBytes||Buffer.from('');
    let originalRows=[];try{originalRows=originalBytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{issues.push('continuation-original-results-invalid');}
    const beforeIssues=issues.length;
    add(c.schema===1&&c.kind==='same-source-matrix-continuation'&&continuation?.sha256===sha(JSON.stringify(c)),'continuation-identity');
    add(c.sourceCommit===freeze.sourceCommit&&c.experimentSha256===sha(runEvidence.experimentBytes||'')&&c.freezeSha256===runEvidence.freezeSha256
      &&c.runnerSha256===runEvidence.continuationRunnerSha256&&/^[a-f0-9]{64}$/.test(c.runnerSha256||''),'continuation-source-binding');
    add(original.rowCount===4&&originalRows.length===4&&original.byteLength===originalBytes.length&&original.sha256===sha(originalBytes)
      &&sha((runEvidence.resultsBytes||Buffer.from('')).subarray(0,original.byteLength))===original.sha256
      &&c.originalSummarySha256===sha(runEvidence.originalSummaryBytes||''),'continuation-interruption-binding');
    add(c.planSha256===sha(JSON.stringify(input.experiment.plan))&&equal(c.remainingPlan,input.experiment.plan.slice(4))
      &&equal(c.originalRows,originalRows.map(r=>r.runId)),'continuation-plan-changed');
    add(input.rows.length<=input.experiment.plan.length&&input.rows.every((r,i)=>{const p=input.experiment.plan[i];return p
      &&(r.block==='personal-longitudinal-v1'?'personal-longitudinal':r.block)===p.block&&(r.scenario||null)===p.case
      &&r.condition===p.condition&&r.repetition===p.repetition;}),'continuation-row-order-or-rerun');
    const lb=c.originalLedgerPrefix||{},lengthValid=integer(lb.byteLength)&&lb.byteLength>0&&lb.byteLength<=ledgerBytes.length
      &&ledgerBytes[lb.byteLength-1]===10&&sha(ledgerBytes.subarray(0,lb.byteLength))===lb.sha256;
    const initial=ledgerSnapshot(lengthValid?ledgerBytes.subarray(0,lb.byteLength):Buffer.from(''));
    const expectedInitialIds=[...baselineIds,...originalRows.flatMap(r=>(r.cost?.reservations||[]).map(p=>p.id))];
    add(lengthValid&&!initial.issues.length&&!initial.uncertain&&!initial.halted&&initial.outstandingReservedUsd===0
      &&equal(sorted(expectedInitialIds),sorted(initial.reservations.map(r=>r.id))),'continuation-original-ledger-binding');
    add(Number.isFinite(Date.parse(c.startedAt))&&Number.isFinite(Date.parse(originalRows.at(-1)?.finishedAt))
      &&Date.parse(c.startedAt)>=Date.parse(originalRows.at(-1).finishedAt)
      &&(!input.rows[4]||Date.parse(c.startedAt)<=Date.parse(input.rows[4].startedAt)),'continuation-start-time');
    continuationReview={receiptSha256:safeHash(continuation?.sha256),runnerSha256:safeHash(c.runnerSha256),valid:issues.length===beforeIssues,
      originalAttempts:4,remainingPlanned:26,originalResultsSha256:safeHash(original.sha256),originalSummarySha256:safeHash(c.originalSummarySha256),
      interpretation:'Same registered matrix resumed at its original fifth row; the first four results and interrupted summary remain preserved.'};
  }
  let continuationV2Review=null;
  if(continuationV2){
    const c=continuationV2.receipt||{},p=c.resumedResultsPrefix||{},raw=runEvidence.resumedResultsBytes||Buffer.from('');
    const beforeIssues=issues.length;let priorRows=[];
    try{priorRows=raw.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{issues.push('continuation-v2-original-results-invalid');}
    add(continuationReview?.valid===true&&c.schema===1&&c.kind==='same-source-matrix-continuation'
      &&continuationV2.sha256===sha(JSON.stringify(c))&&c.previousContinuationSha256===continuation?.fileSha256
      &&c.previousRunnerSha256===runEvidence.continuationRunnerSha256,'continuation-v2-chain-binding');
    add(c.sourceCommit===freeze.sourceCommit&&c.experimentSha256===sha(runEvidence.experimentBytes||'')&&c.freezeSha256===runEvidence.freezeSha256
      &&c.runnerSha256===runEvidence.continuationV2RunnerSha256&&/^[a-f0-9]{64}$/.test(c.runnerSha256||''),'continuation-v2-source-binding');
    for(const key of ['originalResultsPrefix','originalSummarySha256','originalLedgerPrefix','originalRows','planSha256'])
      add(equal(c[key],continuation?.receipt?.[key]),'continuation-v2-original-bindings-changed');
    add(p.rowCount===27&&priorRows.length===27&&p.byteLength===raw.length&&p.sha256===sha(raw)
      &&sha((runEvidence.resultsBytes||Buffer.from('')).subarray(0,p.byteLength))===p.sha256
      &&c.resumedSummarySha256===sha(runEvidence.resumedSummaryBytes||''),'continuation-v2-interruption-binding');
    add(equal(c.remainingPlan,input.experiment.plan.slice(27)),'continuation-v2-plan-changed');
    const lb=c.resumedLedgerPrefix||{},validLength=integer(lb.byteLength)&&lb.byteLength>0&&lb.byteLength<=ledgerBytes.length
      &&ledgerBytes[lb.byteLength-1]===10&&sha(ledgerBytes.subarray(0,lb.byteLength))===lb.sha256;
    const before=ledgerSnapshot(validLength?ledgerBytes.subarray(0,lb.byteLength):Buffer.from(''));
    add(validLength&&!before.issues.length&&!before.uncertain&&!before.halted&&before.outstandingReservedUsd===0
      &&equal(sorted([...baselineIds,...priorRows.flatMap(r=>(r.cost?.reservations||[]).map(x=>x.id))]),sorted(before.reservations.map(r=>r.id))),
      'continuation-v2-ledger-binding');
    add(Number.isFinite(Date.parse(c.startedAt))&&Number.isFinite(Date.parse(priorRows.at(-1)?.finishedAt))
      &&Date.parse(c.startedAt)>=Date.parse(priorRows.at(-1).finishedAt)
      &&(!input.rows[27]||Date.parse(c.startedAt)<=Date.parse(input.rows[27].startedAt)),'continuation-v2-start-time');
    continuationV2Review={receiptSha256:safeHash(continuationV2.sha256),previousContinuationFileSha256:safeHash(c.previousContinuationSha256),
      runnerSha256:safeHash(c.runnerSha256),valid:issues.length===beforeIssues,retainedAttempts:27,remainingPlanned:3,
      retainedResultsSha256:safeHash(p.sha256),retainedSummarySha256:safeHash(c.resumedSummarySha256),
      interpretation:'The second administrative continuation preserves all 27 original rows, including the registered retrieval failure, and appends only the last three planned rows.'};
  }
  for(const item of cleanupResolutions){
    const receipt=item.receipt||{},row=input.rows.find(r=>r.runId===receipt.runId),q=receipt.quiescence||{},lp=receipt.ledgerPrefix||{};
    const failures=[],requireReview=(ok,code)=>{if(!ok)failures.push(code);};
    requireReview(receipt.schema===1&&receipt.kind==='post-grade-scratch-cleanup-quiescence'&&row
      &&!resolvedCleanup.has(receipt.runId)&&item.sha256===sha(JSON.stringify(receipt)),'cleanup-resolution-identity');
    requireReview(continuationReview?.valid===true,'cleanup-resolution-continuation-unverified');
    const initialRetrievalFailure=row?.block==='early-change'&&row.failure==='initial-policy-not-retrieved'&&row.success===false
      &&row.outcomeCategory==='measured-failure'&&row.stages?.length===2
      &&['producer-initial','consumer'].every(role=>row.stages.filter(s=>s.role===role).length===1);
    if(initialRetrievalFailure||(receipt.resultsPrefix?.rowCount||0)>27)
      requireReview(continuationV2Review?.valid===true,'cleanup-resolution-v2-continuation-unverified');
    if(initialRetrievalFailure){const updateId=row.runId+'-producer-update',record=all.reservations.find(r=>r.id===updateId),event=all.events.find(e=>e.type==='settle'&&e.id===updateId);
      requireReview(record?.kind==='agent:producer-update'&&record.status==='settle'&&record.actualUsd===0&&record.actualCents===0
        &&event?.usage?.notStarted===true&&event.usage.role==='producer-update'
        &&row.cost?.reservations?.some(r=>r.id===updateId&&r.status==='settle'&&r.actualUsd===0),'cleanup-resolution-unstarted-update-unproven');}
    requireReview(receipt.sourceCommit===freeze.sourceCommit&&receipt.experimentSha256===sha(runEvidence.experimentBytes||'')
      &&receipt.freezeSha256===runEvidence.freezeSha256,'cleanup-resolution-source-binding');
    const original=receipt.originalResultsPrefix||{},prefix=receipt.resultsPrefix||{},rawBytes=runEvidence.resultsBytes||Buffer.from('');
    requireReview(integer(original.byteLength)&&original.byteLength>0&&original.rowCount===4
      &&runEvidence.originalResultsBytes?.length===original.byteLength&&sha(runEvidence.originalResultsBytes||'')===original.sha256
      &&rawBytes.length>=original.byteLength&&sha(rawBytes.subarray(0,original.byteLength))===original.sha256
      &&receipt.originalSummarySha256===sha(runEvidence.originalSummaryBytes||''),'cleanup-resolution-interruption-binding');
    const lengthValid=integer(prefix.byteLength)&&prefix.byteLength>=original.byteLength&&prefix.byteLength<=rawBytes.length
      &&rawBytes[prefix.byteLength-1]===10&&sha(rawBytes.subarray(0,prefix.byteLength))===prefix.sha256;
    requireReview(lengthValid,'cleanup-resolution-result-prefix');
    let prefixRows=[];
    if(lengthValid)try{prefixRows=rawBytes.subarray(0,prefix.byteLength).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{failures.push('cleanup-resolution-result-json');}
    requireReview(prefixRows.length===prefix.rowCount&&prefixRows.at(-1)?.runId===receipt.runId
      &&new Set(prefixRows.map(r=>r.runId)).size===prefixRows.length,'cleanup-resolution-result-order');
    const rawRow=prefixRows.at(-1),cleanRow=row?Object.fromEntries(Object.entries(row).filter(([k])=>!['artifactOrigin','inputOrder'].includes(k))):null;
    requireReview(rawRow&&sha(JSON.stringify(rawRow))===receipt.resultRowSha256&&equal(rawRow,cleanRow)
      &&row.condition==='claude-mem'&&/^Isolated temporary profile cleanup failed at .*: EPERM,/.test(row.cleanupError||'')
      &&receipt.cleanupErrorSha256===sha(row.cleanupError),'cleanup-resolution-original-row');
    requireReview(row&&!row.notMeasured&&!row.budgetLimited&&!row.accountingIneligible&&!row.setupFailure&&!row.finalFlushError
      &&['pass','measured-failure'].includes(row.outcomeCategory)&&(initialRetrievalFailure||row.stages?.length===(row.block==='personal-longitudinal-v1'?7:3))
      &&row.stages.every(s=>s.ok===true&&s.nativeAuditFinalized===true&&s.pendingNativeResults?.length===0&&s.telemetryErrors?.length===0
        &&!s.unpricedModel&&!s.timedOut&&!s.budgetLimited&&apiAuthentication(s.authentication))
      &&!(row.telemetryErrors||[]).length&&!row.flushes?.some(f=>!f.ok)&&row.cost?.uncertain===false
      &&row.cost.reservations?.length>0&&row.cost.reservations.every(r=>r.status==='settle'&&finite(r.actualUsd))
      &&row.configuration?.oauthCredentialCopied===false&&apiAuthentication(row.configuration?.authentication)
      &&row.observerAccounting?.records?.length>0&&row.observerAccounting.reservedUsd===0&&!row.observerAccounting.refusals?.length
      &&row.observerAccounting.records.every(r=>r.status==='settled'&&!r.inFlight&&!r.capped&&r.authMethod==='api-key'&&finite(r.cost)),
      'cleanup-resolution-measurement-ineligible');
    const validLedgerLength=integer(lp.byteLength)&&lp.byteLength>0&&lp.byteLength<=ledgerBytes.length&&ledgerBytes[lp.byteLength-1]===10
      &&sha(ledgerBytes.subarray(0,lp.byteLength))===lp.sha256;
    const reviewedLedger=ledgerSnapshot(validLedgerLength?ledgerBytes.subarray(0,lp.byteLength):Buffer.from(''));
    requireReview(validLedgerLength&&!reviewedLedger.issues.length&&!reviewedLedger.uncertain&&!reviewedLedger.halted
      &&reviewedLedger.limitUsd===50&&reviewedLedger.outstandingReservedUsd===0
      &&equal(sorted(lp.reservationIds||[]),sorted(reviewedLedger.reservations.map(r=>r.id)))
      &&near(lp.knownApiEquivalentUsd,reviewedLedger.knownApiEquivalentUsd)&&near(lp.chargedAgainstBudgetUsd,reviewedLedger.chargedAgainstCapUsd)
      &&(row?.cost?.reservations||[]).every(r=>reviewedLedger.reservations.some(p=>p.id===r.id&&p.status==='settle')),'cleanup-resolution-ledger-binding');
    requireReview(q.workerPortClosed===true&&Array.isArray(q.remainingKnownPids)&&q.remainingKnownPids.length===0&&q.knownProcessCount>0
      &&q.observerRecordsAllSettled===true&&q.pendingNativeResults===0&&q.telemetryErrors===0&&q.oauthCredentialCopied===false
      &&q.nativeShutdownComplete===true&&Array.isArray(q.ownRuntimeProcesses)&&q.ownRuntimeProcesses.length===0
      &&receipt.noDeletionOrForceKill===true&&receipt.retainedScratch===true,'cleanup-resolution-quiescence');
    requireReview(Number.isFinite(Date.parse(receipt.observedAt))&&Number.isFinite(Date.parse(row?.finishedAt))
      &&Date.parse(receipt.observedAt)>=Date.parse(row.finishedAt),'cleanup-resolution-time');
    if(failures.length)issues.push(...failures);else resolvedCleanup.set(receipt.runId,item);
    cleanupReviews.push({runId:safeId(receipt.runId),receiptSha256:safeHash(item.sha256),accepted:failures.length===0,
      observedAt:failures.length===0?new Date(receipt.observedAt).toISOString():null,originalCleanupErrorRetained:true,
      cleanupErrorSha256:safeHash(receipt.cleanupErrorSha256),retainedScratch:true,scope:'Resolves only post-grade scratch-deletion review; original outcomes, metrics and costs remain unchanged.'});
  }
  const auditExcluded=new Set(),authExcluded=new Set();
  const checkedRows=input.rows.map(row=>{
    const gateRow=resolvedCleanup.has(row.runId)?Object.fromEntries(Object.entries(row).filter(([key])=>key!=='cleanupError')):row;
    add(row.measurementTransport==='native-audit-v3','row-measurement-transport-mismatch');
    const invalidAuth=!apiAuthentication(row.authentication)||(row.stages||[]).some(s=>!apiAuthentication(s.authentication))
      ||(row.observerAccounting?.records||[]).some(r=>r.authMethod!=='api-key');
    if(invalidAuth){issues.push('row-or-stage-api-authentication-mismatch');authExcluded.add(row.runId);}
    const invalid=Boolean(row.telemetryErrors?.length)||(row.stages||[]).some(s=>s.nativeAuditFinalized!==true||!Array.isArray(s.pendingNativeResults)
      ||s.pendingNativeResults.length>0||!Array.isArray(s.telemetryErrors)||s.telemetryErrors.length>0);
    if(!invalid&&!invalidAuth)return gateRow;if(invalid)auditExcluded.add(row.runId);
    if(invalid&&!row.notMeasured&&!['setup-not-measured','budget-not-measured','budget-limited','exposure-unverified','accounting-ineligible'].includes(row.outcomeCategory))issues.push('reported-outcome-native-audit-mismatch');
    return{...gateRow,success:false,outcomeCategory:'setup-not-measured',notMeasured:'Final native audit or API authentication is unproven; original outcome preserved separately'};
  });
  const current=aggregate({...input,rows:checkedRows,issues,ledger:{...input.ledger,reservations:newRecords}});
  const prototype=current.conditions.find(c=>c.condition==='klypix-improved');
  const strongest=current.conditions.find(c=>c.condition===current.continuation.strongestNotes);
  const completeComparison=current.attempts.length===30&&current.missing.length===0&&!current.integrityIssues.length
    &&current.attempts.every(a=>a.measured)&&current.conditions.every(c=>c.early.completeMeasured&&c.personal.measured);
  const releaseDecision={completeComparison,plannedAttempts:30,observedAttempts:current.attempts.length,
    measuredPasses:current.attempts.filter(a=>a.outcomeCategory==='pass').length,measuredFailures:current.attempts.filter(a=>a.outcomeCategory==='measured-failure').length,
    recommendation:!completeComparison?'not-established':current.continuation.pass?'continue-prototype-evaluation':'do-not-ship-decision-watch-prototype',
    registeredGate:current.continuation.verdict,strongestNotes:strongest?.condition||null,
    prototypeEarlyCostUsd:prototype?.early.apiEquivalentUsd??null,strongestNotesEarlyCostUsd:strongest?.early.apiEquivalentUsd??null,
    descriptiveEarlyCostRatio:strongest?.early.apiEquivalentUsd>0?prototype.early.apiEquivalentUsd/strongest.early.apiEquivalentUsd:null,
    prototypeFunctionalPasses:prototype?.early.rawPasses??null,prototypeFinalCodeCorrect:prototype?.early.finalCodeCorrect??null,
    strongestNotesFunctionalPasses:strongest?.early.rawPasses??null,strongestNotesFinalCodeCorrect:strongest?.early.finalCodeCorrect??null,
    prototypeFalseAlertControls:prototype?.early.falseDecisionWarningControls??null,
    interpretation:'Descriptive release recommendation from unchanged registered outcomes. Additional cost and accuracy comparisons do not replace or alter the frozen gate.'};
  const personalEvidenceBreakdown=input.rows.filter(row=>row.block==='personal-longitudinal-v1').map(row=>{
    const answers=Array.isArray(row.grade?.answers)?row.grade.answers:[],facts=answers.filter(a=>typeof a.valueCorrect==='boolean');
    const unknowns=answers.filter(a=>a.id==='hosting'&&typeof a.valueCorrect!=='boolean');
    return{runId:safeId(row.runId),condition:safeId(row.condition),gradedAnswers:answers.length,
      knownFactValuesCorrect:facts.filter(a=>a.valueCorrect===true).length,knownFactQuestions:facts.length,
      correctValuesWithoutVerifiedSource:facts.filter(a=>a.valueCorrect===true&&a.evidenceSupported===false).length,
      wholeBrainContainerCitations:facts.filter(a=>a.source==='brain.klypix').length,
      incorrectProvidedFactValues:facts.filter(a=>a.valueCorrect===false&&a.unsupported===true).length,
      knownFactAbstentions:facts.filter(a=>a.valueCorrect===false&&a.unsupported===false).length,
      correctUnknownAbstentions:unknowns.filter(a=>a.correct===true).length,unknownQuestions:unknowns.length,
      registeredSourceCheckedScore:integer(row.grade?.correct)?row.grade.correct:null,registeredTotal:integer(row.grade?.total)?row.grade.total:null,
      registeredUnsupportedClaims:integer(row.grade?.unsupportedClaims)?row.grade.unsupportedClaims:null,
      registeredPass:row.grade?.pass===true,interpretation:'Counts summarize existing grader flags only; values, citation verification and appropriate abstention are distinct. No answer was regraded.'};
  });
  const report={schema:1,status:current.status,kind:'separate-observer-sdk-compatible-experiment-report',experimentLabel:EXPERIMENT_LABEL,
    postprocessor:{version:POSTPROCESSOR_VERSION,sha256:sha(fs.readFileSync(fileURLToPath(import.meta.url))),
      eligibilityCheck:'Requires successful separately reported native setup, immutable original ledger prefix, every prior/setup cost attributed, and finalized native stage audits; raw outcomes remain preserved.'},
    requiredAuthentication:API_AUTHENTICATION,
    observedExperimentAuthentication:apiAuthentication(input.experiment.authentication)?API_AUTHENTICATION:{method:'unverified-or-mismatched'},
    billingDisclosure:'The registered fifth matrix requires Anthropic API-key billing for all five conditions. Foreground models are identical; claude-mem retains its native Haiku/Sonnet observer tiers and their costs are included. Prior subscription usage remains separately labeled API-equivalent estimates; provider invoices are not independently reconciled.',
    releaseDecision,priorExperiments:prior,setupDiagnostics:setupPublic,continuationReview,continuationV2Review,cleanupReviews,personalEvidenceBreakdown,
    observerFixedExperiment:{...current,experiment:EXPERIMENT_LABEL,totalCost:{...current.totalCost,
      basis:'CLI-reported API usage estimates; prior subscription estimates retained separately; provider invoices not independently reconciled'},
      attempts:current.attempts.map((a,index)=>({...a,protocolPass:a.measured?a.protocolPass:null,
      originalOutcomeCategory:OUTCOMES.has(input.rows[index]?.outcomeCategory)?input.rows[index].outcomeCategory:'unclassified',
      originalSuccess:input.rows[index]?.success===true,reportAuditExcluded:auditExcluded.has(input.rows[index]?.runId),
      reportAuthenticationExcluded:authExcluded.has(input.rows[index]?.runId),originalCleanupErrorRetained:Boolean(input.rows[index]?.cleanupError),
      originalCleanupErrorSha256:input.rows[index]?.cleanupError?sha(input.rows[index].cleanupError):null,
      cleanupError:input.rows[index]?.cleanupError?'Original cleanup error retained in private raw evidence; see cleanup review.':null,
      cleanupResolvedAfterReview:resolvedCleanup.has(input.rows[index]?.runId),cleanupResolutionReceiptSha256:resolvedCleanup.get(input.rows[index]?.runId)?.sha256||null,
      cleanupResolvedAt:resolvedCleanup.get(input.rows[index]?.runId)?.receipt.observedAt||null}))},
    costAccounting:{priorPublishedExperimentsApiEquivalentUsd:priorCost,priorConservativeChargeUsd:priorCharge,
      setupDiagnosticsApiEquivalentUsd:sum(setupPublic.map(s=>s.knownApiEquivalentUsd)),setupDiagnosticsChargedAgainstBudgetUsd:sum(setupPublic.map(s=>s.chargedAgainstBudgetUsd)),
      baselineKnownApiEquivalentUsd:baseline.knownApiEquivalentUsd,baselineChargedAgainstBudgetUsd:baseline.chargedAgainstBudgetUsd,baselineLedgerSha256:safeHash(baseline.sha256),
      priorReservationIds:sorted(baselineIds).map(safeId),newKnownApiEquivalentUsd:sum(newRecords.filter(r=>r.status==='settle'&&finite(r.actualUsd)).map(r=>r.actualUsd)),
      globalKnownApiEquivalentUsd:input.ledger.knownApiEquivalentUsd,globalApiEquivalentUsd:input.ledger.apiEquivalentUsd,
      globalChargedAgainstBudgetUsd:input.ledger.chargedAgainstCapUsd,globalOutstandingReservedUsd:input.ledger.outstandingReservedUsd,globalBudgetLimitUsd:input.ledger.limitUsd,
      globalHalted:input.ledger.halted,newUnattributedReservations:unattributed.length,matchedConditionCostsExcludeAllPriorAndSetupSpending:true,
      originalGlobalCapIncludesEveryExperimentAndSetup:true,priorSubscriptionCostBasis:'CLI API-equivalent estimates; actual subscription invoice unknown',
      currentCostBasis:'API-key billed calls; CLI-reported usage estimates, provider invoice not independently reconciled',providerInvoiceReconciled:false},
    interpretation:'All four published experiments retain nine original attempts. Every earlier setup diagnostic remains separately visible, including failures. Only complete matched fifth-experiment data can satisfy the unchanged continuation gate; no earlier outcome or cost is pooled into a new condition.'};
  assertPublicSummarySafe(report);return report;
}
export function renderObserverFixedMarkdown(report){
  if(report.status==='no-registered-data')return report.resultClaim+'\n';
  const c=report.costAccounting,d=report.releaseDecision;
  const labels={'notes-native':'AI-kept notes','notes-notification':'AI-kept notes + change notice','klypix-released':'Released KLYPIX','klypix-improved':'KLYPIX decision-watch prototype','claude-mem':'Native claude-mem'};
  const lead=d.completeComparison?[
    d.recommendation==='do-not-ship-decision-watch-prototype'
      ?'**Decision: do not ship this decision-watch prototype.** All **30/30** planned attempts completed with valid measurement; the unchanged continuation gate was not met.'
      :'All **30/30** planned attempts completed with valid measurement. The prototype meets the small-pilot continuation gate; this is not a general superiority claim.','',
    `AI-kept notes plus a generic change notice passed **${d.strongestNotesFunctionalPasses}/5** decision-change cases. The prototype passed **${d.prototypeFunctionalPasses}/5**, although its final code was correct in **${d.prototypeFinalCodeCorrect}/5**. One unchanged decision triggered a false alert; another corrected decision was missed when ordinary reads did not establish a watch. These remain measured failures.`, '',
    '| Condition | Functional passes | Final code correct | Stale revisions | Matched early-block cost |','|---|---:|---:|---:|---:|',
    ...report.observerFixedExperiment.conditions.map(r=>`| ${labels[r.condition]||r.condition} | ${r.early.rawPasses}/5 | ${r.early.finalCodeCorrect}/5 | ${r.early.staleCodeRevisions??`${r.early.knownStaleRevisionsInAvailableRows} observed; total not comparable`} | $${r.early.apiEquivalentUsd.toFixed(8)} |`),'',
    `The strongest notes control had **zero** stale revisions; the prototype had **one**, so a percentage reduction is undefined and no advantage is demonstrated. Its matched cost was **$${d.prototypeEarlyCostUsd.toFixed(8)}** versus **$${d.strongestNotesEarlyCostUsd.toFixed(8)}**: **${d.descriptiveEarlyCostRatio.toFixed(6)} times**, or **${((d.descriptiveEarlyCostRatio-1)*100).toFixed(2)}% more**, against a 10% limit. Its **${d.prototypeFinalCodeCorrect}/5** final-code accuracy also falls below the control’s **${d.strongestNotesFinalCodeCorrect}/5**. These are additional descriptive failures; the original zero-baseline gate result is unchanged.`,'',
    `Across all conditions, **${d.measuredPasses}** attempts passed and **${d.measuredFailures}** were measured failures; none was omitted or rerun. The fifth matrix cost **$${c.newKnownApiEquivalentUsd.toFixed(9)}** in reported API usage. Including every earlier experiment and setup, known usage totals **$${c.globalKnownApiEquivalentUsd.toFixed(9)}**, with **$${c.globalChargedAgainstBudgetUsd.toFixed(2)}** conservatively charged against the original **$50** cap. All costs are settled.`,'',
    'All five personal-memory replays returned the seven known facts correctly and correctly abstained on the unknown question. Both KLYPIX arms nevertheless scored **1/8** under the frozen citation requirement because they cited the whole brain container; notes and claude-mem scored **8/8**. This is a citation-locator failure, not 1/8 memory accuracy or invented factual content. The five seven-session replays use simulated days, and their questions are correlated.','',
  ]:[];
  return['# Fifth experiment and complete prior accounting','',
    ...lead,
    'The four earlier experiments and every setup diagnostic remain separate. Failed setup is not a competitor loss, and earlier passes are not pooled into this run.','',
    report.billingDisclosure,'',
    ...(report.continuationReview?[`Continuation review: **${report.continuationReview.valid?'verified':'unresolved'}**. ${report.continuationReview.interpretation} Receipt: \`${report.continuationReview.receiptSha256||'invalid'}\`.`,'']:[]),
    ...(report.continuationV2Review?[`Second continuation review: **${report.continuationV2Review.valid?'verified':'unresolved'}**. ${report.continuationV2Review.interpretation} Receipt: \`${report.continuationV2Review.receiptSha256||'invalid'}\`.`,'']:[]),
    ...(report.personalEvidenceBreakdown.length?['Personal recall separates remembered values from the registered citation requirement. A correct value whose citation locator cannot be verified still fails that source-checked answer. “Unsupported” does not by itself mean the remembered value was wrong. The original scores remain unchanged.','',
      '| Condition | Known values correct | Correct unknown abstention | Correct values with unverified citations | Registered source-checked score |','|---|---:|---:|---:|---:|',
      ...report.personalEvidenceBreakdown.map(p=>`| ${p.condition} | ${p.knownFactValuesCorrect}/${p.knownFactQuestions} | ${p.correctUnknownAbstentions}/${p.unknownQuestions} | ${p.correctValuesWithoutVerifiedSource} | ${p.registeredSourceCheckedScore??'?'}/${p.registeredTotal??'?'} |`),'']:[]),
    ...report.personalEvidenceBreakdown.filter(p=>p.wholeBrainContainerCitations>0).flatMap(p=>[`${p.condition} cited the whole \`brain.klypix\` container for ${p.wholeBrainContainerCitations} facts. The frozen grader requires a recognized source locator; this citation-verification failure is distinct from incorrect factual values.`,'']),
    '| Prior experiment | Original attempt | Condition / case | Original outcome | Known API-equivalent cost |','|---|---|---|---|---:|',
    ...report.priorExperiments.flatMap(e=>e.attempts.map(a=>`| ${e.ordinal} | ${a.id} | ${a.condition} / ${a.scenario||'personal replay'} | ${a.originalCategory} | $${a.knownApiEquivalentUsd.toFixed(8)} |`)),'',
    '| Setup diagnostic | Authentication | Original setup outcome | Known API-equivalent cost |','|---|---|---|---:|',
    ...report.setupDiagnostics.map(s=>`| ${s.runId} | ${s.authentication.method} | ${s.originalSuccess?'setup verified':'setup failed; retained'} | $${s.knownApiEquivalentUsd.toFixed(8)} |`),'',
    ...(report.cleanupReviews.length?['Original scratch-cleanup errors remain in the raw results. The following separate operational reviews resolve only the cleanup blocker; task scores, rework and costs are unchanged.','',
      '| Attempt | Cleanup review | Observed at | Receipt SHA-256 |','|---|---|---|---|',
      ...report.cleanupReviews.map(r=>`| ${r.runId} | ${r.accepted?'Quiescence verified; scratch retained':'Unresolved; verification rejected'} | ${r.observedAt||'not established'} | ${r.receiptSha256||'invalid'} |`),'']:[]),
    `Prior experiments: **$${c.priorPublishedExperimentsApiEquivalentUsd.toFixed(8)}**. Setup diagnostics: **$${c.setupDiagnosticsApiEquivalentUsd.toFixed(8)}**. Current experiment known usage: **$${c.newKnownApiEquivalentUsd.toFixed(8)}**.`,
    `All spending remains under one **$${c.globalBudgetLimitUsd}** cap. Prior and setup costs are excluded only from matched current-condition comparisons, never from the cap. Actual subscription invoice cost is unknown.`,'',
    '## Current experiment only','',renderMarkdown(report.observerFixedExperiment).replace('| Personal recall |','| Source-checked recall |')
      .replace('Actual subscription invoice is unknown.','Provider invoices are not independently reconciled; prior subscription usage remains an API-equivalent estimate.')].join('\n');
}

async function main(){
  const args=process.argv.slice(2);if(args.includes('--self-test')){await import('./postprocess-observer-fixed-self-test.mjs');return;}
  const values=name=>args.flatMap((arg,index)=>arg===`--${name}`?[args[index+1]]:[]),opt=(name,fallback)=>values(name)[0]||fallback;
  const runDir=opt('run','C:/Users/HP/AppData/Local/Temp/klypix-decision-pilot-observer-fixed-20261109');
  const ledgerFile=opt('ledger',path.join(HERE,'budget.jsonl')),input=loadRun(runDir,ledgerFile);
  if(!input.experiment){console.log('Fifth experiment has not started; no performance report or baseline created.');return;}
  if(!opt('freeze')||!opt('setup-receipt'))throw new Error('Published fifth freeze and successful setup receipt are required; no failed-only setup may qualify');
  const protocolRoot=opt('protocol-root','C:/Users/HP/.codex/worktrees/decision-change-benchmark/kmcp-vendor');
  const read=file=>({bytes:fs.readFileSync(file),report:JSON.parse(fs.readFileSync(file,'utf8'))});
  const priorReports=PRIOR_REPORT_FILES.map(file=>{const r=read(path.join(protocolRoot,file));return{file,report:r.report,sha256:sha(r.bytes)};});
  const setupFiles=[...values('prior-setup-receipt'),opt('setup-receipt')];
  const setupReceipts=setupFiles.map(file=>{const r=read(file);return{receipt:r.report,sha256:sha(r.bytes)};});
  const freezeInput=read(opt('freeze')),cleanupFile=opt('cleanup-resolutions',path.join(runDir,'cleanup-quiescence.jsonl'));
  const cleanupResolutions=fs.existsSync(cleanupFile)?fs.readFileSync(cleanupFile,'utf8').split('\n').filter(Boolean).map(line=>{const receipt=JSON.parse(line);return{receipt,sha256:sha(JSON.stringify(receipt))};}):[];
  const continuationFile=opt('continuation',path.join(runDir,'continuation.json')),continuationInput=fs.existsSync(continuationFile)?read(continuationFile):null;
  const continuation=continuationInput?{receipt:continuationInput.report,sha256:sha(JSON.stringify(continuationInput.report)),fileSha256:sha(continuationInput.bytes)}:null;
  const v2File=opt('continuation-v2',path.join(runDir,'continuation-v2.json')),v2Input=fs.existsSync(v2File)?read(v2File):null;
  const continuationV2=v2Input?{receipt:v2Input.report,sha256:sha(JSON.stringify(v2Input.report)),fileSha256:sha(v2Input.bytes)}:null;
  const snapshot=path.join(HERE,'observer-fixed-interruption-v1-retained');
  const runEvidence={experimentBytes:fs.readFileSync(path.join(runDir,'experiment.json')),resultsBytes:fs.readFileSync(path.join(runDir,'results.jsonl')),freezeSha256:sha(freezeInput.bytes),
    ...(continuation||cleanupResolutions.length?{originalResultsBytes:fs.readFileSync(path.join(snapshot,'results.jsonl')),originalSummaryBytes:fs.readFileSync(path.join(snapshot,'run-summary.json')),
      continuationRunnerSha256:sha(fs.readFileSync(opt('continuation-runner',path.join(HERE,'resume-fifth-matrix.mjs'))))}:{}),
    ...(continuationV2?{resumedResultsBytes:fs.readFileSync(path.join(HERE,'observer-fixed-interruption-27-retained/results.jsonl')),
      resumedSummaryBytes:fs.readFileSync(path.join(HERE,'observer-fixed-interruption-27-retained/run-summary.json')),
      continuationV2RunnerSha256:sha(fs.readFileSync(opt('continuation-v2-runner',path.join(HERE,'resume-fifth-matrix-v2.mjs'))))}:{})};
  const report=aggregateObserverFixed({input,freeze:freezeInput.report,ledgerBytes:fs.readFileSync(ledgerFile),priorReports,setupReceipts,cleanupResolutions,continuation,continuationV2,runEvidence});
  const out=path.resolve(opt('out',path.join(HERE,'observer-fixed-report'))),relative=path.relative(HERE,out);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Report must remain under the pilot directory');
  const markdown=renderObserverFixedMarkdown(report);assertPublicSummarySafe(markdown);fs.mkdirSync(out,{recursive:true});
  const realRelative=path.relative(fs.realpathSync(HERE),fs.realpathSync(out));if(realRelative.startsWith('..')||path.isAbsolute(realRelative))throw new Error('Report output resolves outside pilot directory');
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(report,null,2)+'\n');fs.writeFileSync(path.join(out,'summary.md'),markdown);
  console.log(`Fifth experiment: ${report.observerFixedExperiment.attempts.length} observed attempts; gate ${report.observerFixedExperiment.continuation.verdict}. Earlier diagnostics/costs preserved; draft only.`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(String(error.message).split('\n')[0]);process.exitCode=1;});
