import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { canonicalJson, sha256 } from './dataset-contract.mjs'
import {
  SEMANTIC_PURPOSE, SEMANTIC_PROTOCOL, SEMANTIC_LIMITS, SEMANTIC_PUBLIC_FILES,
  semanticAssert as check, semanticRecord as record, semanticArray as array,
  semanticText as text, semanticHash, freezeSemanticValue, safeSemanticRelativePath,
  assertSafeSemanticDirectory, readSemanticFile, parseSemanticJson,
  projectSemanticPublicData, validateSemanticPublicBundle, validateSemanticExecutionPlan,
  validateSemanticConfiguration, createSemanticAuthorizationDraft, createSemanticCaseRunSpec,
  semanticRunSpecFingerprint, semanticSampleUnit, semanticContentUnit, validateSemanticContentUnit
} from './semantic-eval-contract.mjs'
import { fingerprintQuestion } from '../../electron/services/workflow/question-evidence.ts'
import { validateQuestionReviewResponse } from '../../electron/services/workflow/question-review.ts'
const verified = new WeakMap()
const HASH = /^[a-f0-9]{64}$/u
const EVIDENCE = /^ev_[a-f0-9-]{36}$/u
const STAGES = ['investigation','generation','review','repair','compensation']
const jsonEqual = (left,right,reason='semantic-execution-binding') => check(canonicalJson(left) === canonicalJson(right),reason)
const number = (value,max=Number.MAX_SAFE_INTEGER) => check(Number.isSafeInteger(value) && value >= 0 && value <= max,'semantic-execution-number')
const hash = value => check(typeof value === 'string' && HASH.test(value),'semantic-execution-hash')
const usage = value => { record(value,['inputTokens','outputTokens','totalTokens']); for (const n of Object.values(value)) number(n);check(value.totalTokens===value.inputTokens+value.outputTokens,'semantic-usage-invalid');return value }
const sum = (list,key) => list.reduce((total,item)=>total+item[key],0)
async function diskFiles(root,relative='',counter={entries:0}) {
  check(relative.split('/').length<=32,'semantic-artifact-depth')
  const result=[]
  for (const entry of await readdir(path.join(root,relative),{withFileTypes:true})) {
    check(++counter.entries<=SEMANTIC_LIMITS.files.maxArtifacts*2,'semantic-artifact-count')
    const name=relative ? relative+'/'+entry.name : entry.name
    check(safeSemanticRelativePath(name) && !entry.isSymbolicLink(),'semantic-unsafe-path')
    if(entry.isDirectory()){await assertSafeSemanticDirectory(path.join(root,name));result.push(...await diskFiles(root,name,counter))}
    else {check(entry.isFile(),'semantic-unsafe-path');result.push(name)}
  }
  return result.sort()
}
function range(value) { record(value,['startLine','endLine']);number(value.startLine,1000000);number(value.endLine,1000000);check(value.startLine>0 && value.endLine>=value.startLine,'semantic-source-range');return {startLine:value.startLine,endLine:value.endLine} }
function canonicalSource(project,ref) {
  const file=project.files.find(file=>file.path===ref.path)
  check(file,'semantic-source-file');range({startLine:ref.startLine,endLine:ref.endLine})
  const lines=file.content.split('\n');check(ref.endLine<=lines.length,'semantic-source-range')
  const body=lines.slice(ref.startLine-1,ref.endLine).join('\n')
  return {path:ref.path,startLine:ref.startLine,endLine:ref.endLine,sha256:sha256(Buffer.from(body,'utf8')),text:body}
}
function checkEvidence(value,unit,sample,project,snapshotId) {
  array(value.evidence,1,16);array(value.sources,1,16)
  const byId=new Map();const covered=new Set()
  for (const item of value.evidence) {
    record(item,['id','fileId','relPath','originalRange','displayRange','contentHash','text','sourceKind','snapshotId'])
    check(EVIDENCE.test(item.id) && !byId.has(item.id) && item.snapshotId===snapshotId,'semantic-evidence-id')
    hash(item.fileId);hash(item.contentHash);range(item.displayRange);jsonEqual(item.originalRange,item.displayRange)
    check(['code','documentation','configuration','other'].includes(item.sourceKind),'semantic-evidence-kind')
    const source=canonicalSource(project,{path:item.relPath,...item.displayRange})
    check(source.text===item.text && source.sha256===item.contentHash,'semantic-evidence-source')
    for(let line=item.displayRange.startLine;line<=item.displayRange.endLine;line++) {
      check(sample.evidence.some(ref=>ref.path===item.relPath && line>=ref.startLine && line<=ref.endLine),'semantic-evidence-expansion')
      covered.add(item.relPath+':'+line)
    }
    byId.set(item.id,item)
  }
  for(const ref of sample.evidence) for(let line=ref.startLine;line<=ref.endLine;line++) check(covered.has(ref.path+':'+line),'semantic-evidence-missing')
  jsonEqual(value.sources,value.evidence.map(item=>canonicalSource(project,{path:item.relPath,...item.displayRange})))
  return byId
}
function checkManifest(manifest,unit,snapshotId,evidence,description=null) {
  record(manifest,['version','runId','projectId','snapshotId','selectedIds','requiredIds','packedIds','omitted','sources','requestHash','manifestHash','estimatedInputTokens','serializedChars','contextChars','serializationOverheadTokens','maxInputTokens','maxChars'])
  check(manifest.version===1 && manifest.runId===unit.unitId && manifest.projectId===unit.projectId && manifest.snapshotId===snapshotId,'semantic-manifest-identity')
  for(const field of ['selectedIds','requiredIds','packedIds']) {array(manifest[field],1,16);check(new Set(manifest[field]).size===manifest[field].length && manifest[field].every(id=>evidence.has(id)),'semantic-manifest-evidence')}
  check(manifest.requiredIds.every(id=>manifest.packedIds.includes(id)) && manifest.packedIds.every(id=>manifest.selectedIds.includes(id)),'semantic-manifest-required')
  if(description) check(description.evidenceIds.every(id=>manifest.requiredIds.includes(id) && manifest.packedIds.includes(id)),'semantic-manifest-source-required')
  array(manifest.omitted,0,16);const omitted=manifest.omitted.map(item=>{record(item,['id','reason']);check(item.reason==='budget' && manifest.selectedIds.includes(item.id) && !manifest.packedIds.includes(item.id),'semantic-manifest-omission');return {id:item.id,reason:item.reason}})
  array(manifest.sources,1,16);const ids=[]
  const sources=manifest.sources.map(item=>{
    record(item,['ids','fileId','relPath','displayRange','originalRange','hash','sourceKind']);array(item.ids,1,16);range(item.displayRange);jsonEqual(item.originalRange,item.displayRange)
    const lines=new Map()
    for(const id of item.ids){const entry=evidence.get(id);check(entry && manifest.packedIds.includes(id) && entry.fileId===item.fileId && entry.relPath===item.relPath && entry.sourceKind===item.sourceKind,'semantic-manifest-source');ids.push(id);entry.text.split('\n').forEach((line,index)=>{const n=entry.displayRange.startLine+index;check(!lines.has(n)||lines.get(n)===line,'semantic-manifest-overlap');lines.set(n,line)})}
    const body=[];for(let n=item.displayRange.startLine;n<=item.displayRange.endLine;n++){check(lines.has(n),'semantic-manifest-expansion');body.push(lines.get(n))}
    check(lines.size===body.length && sha256(Buffer.from(body.join('\n'),'utf8'))===item.hash,'semantic-manifest-source-hash')
    return {ids:item.ids,fileId:item.fileId,relPath:item.relPath,displayRange:range(item.displayRange),originalRange:range(item.originalRange),hash:item.hash,sourceKind:item.sourceKind}
  })
  check(ids.length===manifest.packedIds.length && new Set(ids).size===ids.length && ids.every(id=>manifest.packedIds.includes(id)),'semantic-manifest-membership')
  hash(manifest.requestHash);hash(manifest.manifestHash)
  for(const name of ['estimatedInputTokens','serializedChars','contextChars','serializationOverheadTokens','maxInputTokens','maxChars'])number(manifest[name])
  check(manifest.estimatedInputTokens<=manifest.maxInputTokens && manifest.contextChars<=manifest.maxChars && manifest.serializedChars<=manifest.maxChars && manifest.maxChars<=60000,'semantic-manifest-budget')
  const payload={version:manifest.version,runId:manifest.runId,projectId:manifest.projectId,snapshotId:manifest.snapshotId,selectedIds:manifest.selectedIds,requiredIds:manifest.requiredIds,packedIds:manifest.packedIds,omitted,sources,requestHash:manifest.requestHash,estimatedInputTokens:manifest.estimatedInputTokens,serializedChars:manifest.serializedChars,contextChars:manifest.contextChars,serializationOverheadTokens:manifest.serializationOverheadTokens,maxInputTokens:manifest.maxInputTokens,maxChars:manifest.maxChars}
  check(sha256(Buffer.from(JSON.stringify(payload),'utf8'))===manifest.manifestHash,'semantic-manifest-hash')
}
function checkDescription(description,unit,snapshotId,content,evidence,origin) {
  record(description,['version','origin','verification','runId','projectId','snapshotId','questionId','questionFingerprint','requestId','requestHash','manifestHash','evidenceIds','revision'],['version','origin','verification','runId','projectId','snapshotId','questionId','questionFingerprint','requestId','requestHash','manifestHash','evidenceIds'])
  check(description.version===1 && description.runId===unit.unitId && description.projectId===unit.projectId && description.snapshotId===snapshotId && description.questionId===unit.questionId && description.origin===origin,'semantic-source-identity')
  check(description.questionFingerprint===fingerprintQuestion({id:unit.questionId,...content.question}),'semantic-source-fingerprint')
  hash(description.requestHash);hash(description.manifestHash);array(description.evidenceIds,1,16)
  check(new Set(description.evidenceIds).size===description.evidenceIds.length && description.evidenceIds.every(id=>evidence.has(id)),'semantic-source-evidence')
  if(origin==='frozen-evaluation-input')check(description.verification==='imported-input-unverified' && description.requestId===null && !Object.hasOwn(description,'revision'),'semantic-source-origin')
  else check(description.verification==='source-bound-unverified' && typeof description.requestId==='string' && description.revision,'semantic-source-origin')
}
function checkRequests(value,unit,spec,evidence,sourceDescription,aggregate,seenRequests) {
  const policy=SEMANTIC_LIMITS[unit.kind];array(value.requests,0,policy.maxRequests)
  const local={requests:value.requests.length,inputAdmission:0,outputReservation:0};let complete=true
  const byId=new Map();let repairStarted=false;let reviewCount=0;let repairCount=0
  for(const request of value.requests) {
    record(request,['requestId','stage','inputAdmission','outputReservation','contextChars','requestHash','estimatedInputTokens','manifest','manifestUnavailable','guardIntent','fetchFence','transportComplete','outputHash','outputChars','usage','state','ledger'])
    text(request.requestId,128);check(!seenRequests.has(request.requestId),'semantic-request-duplicate');seenRequests.add(request.requestId);byId.set(request.requestId,request)
    check(['review','repair'].includes(request.stage) && !(unit.kind==='review' && request.stage==='repair'),'semantic-request-stage')
    if(request.stage==='repair') {repairStarted=true;repairCount++}else {check(!repairStarted,'semantic-request-order');reviewCount++}
    for(const name of ['inputAdmission','outputReservation','contextChars','estimatedInputTokens'])number(request[name])
    check(request.inputAdmission===request.estimatedInputTokens && request.outputReservation>0 && request.outputReservation<=SEMANTIC_LIMITS[request.stage==='review'?'review':'repair'].callOutputCap && request.outputReservation<=spec.generationOutputTokens && request.contextChars<=60000,'semantic-request-budget')
    hash(request.requestHash)
    for(const name of ['guardIntent','fetchFence','transportComplete'])check(typeof request[name]==='boolean','semantic-request-flags')
    check(!request.fetchFence || request.guardIntent,'semantic-request-fence')
    if(request.outputHash===null)check(request.outputChars===null,'semantic-request-output')
    else {hash(request.outputHash);number(request.outputChars,256000);check(request.transportComplete,'semantic-request-output')}
    if(request.transportComplete)check(request.guardIntent && request.fetchFence && request.outputHash!==null,'semantic-request-completion')
    check(['reserved','known','unknown','unknown-unsent','unsent'].includes(request.state),'semantic-request-state')
    if(request.usage!==null){usage(request.usage);check(request.state==='known','semantic-request-usage');aggregate.actualInputTokens+=request.usage.inputTokens;aggregate.actualOutputTokens+=request.usage.outputTokens}
    else {check(request.state!=='known','semantic-request-usage');if(['unknown','unknown-unsent'].includes(request.state))aggregate.unknownRequests++;complete=false}
    if(request.manifest!==null) {
      check(request.guardIntent && request.manifestUnavailable===null,'semantic-request-manifest')
      checkManifest(request.manifest,unit,spec.snapshotId,evidence,sourceDescription)
      check(request.manifest.requestHash===request.requestHash && request.manifest.contextChars===request.contextChars && request.manifest.estimatedInputTokens===request.inputAdmission+request.manifest.serializationOverheadTokens && request.manifest.maxInputTokens<=spec.generationInputTokens,'semantic-request-manifest-binding')
    }else {check(typeof request.manifestUnavailable==='string','semantic-request-manifest');complete=false}
    if(!request.guardIntent || !request.fetchFence)complete=false
    local.inputAdmission+=request.inputAdmission;local.outputReservation+=request.outputReservation
  }
  check(reviewCount<=2 && repairCount<=2,'semantic-request-attempts')
  check(local.inputAdmission<=policy.inputAdmission && local.outputReservation<=policy.outputReservation,'semantic-case-admission')
  for(const key of Object.keys(local))aggregate[key]+=local[key]
  return {byId,complete}
}
function checkLedger(value,spec,requests) {
  const ledger=value.ledger
  record(ledger,['elapsedMs','blocked','usageComplete','overspend','metrics','total','remaining','byStage','reservations'])
  check(Number.isFinite(ledger.elapsedMs) && ledger.elapsedMs>=0 && typeof ledger.blocked==='boolean' && typeof ledger.usageComplete==='boolean','semantic-ledger-state')
  record(ledger.total,['dispatchedRequests','reservedRequests','inputTokens','outputTokens','estimatedInputTokens','actualProviderUsage','readBytes','toolCalls'])
  record(ledger.overspend,['inputTokens','outputTokens','readBytes']);for(const item of Object.values(ledger.overspend))number(item)
  record(ledger.metrics,['overspendAdmissions','doubleSettlements','unknownUsageTreatedAsZero','generationReserveProtected'])
  for(const field of ['overspendAdmissions','doubleSettlements','unknownUsageTreatedAsZero'])number(ledger.metrics[field])
  check(ledger.metrics.unknownUsageTreatedAsZero===0 && typeof ledger.metrics.generationReserveProtected==='boolean','semantic-ledger-metrics')
  array(ledger.reservations,0,4);record(ledger.byStage,STAGES)
  const byStage=Object.fromEntries(STAGES.map(stage=>[stage,{dispatchedRequests:0,reservedRequests:0,inputTokens:0,outputTokens:0,estimatedInputTokens:0}]))
  let actual={inputTokens:0,outputTokens:0,totalTokens:0};let complete=true;let overInput=0;let overOutput=0;const seen=new Set()
  for(const entry of ledger.reservations) {
    record(entry,['id','stage','inputTokens','outputTokens','contextChars','state','usage','estimatedInputTokens'])
    const request=requests.get(entry.id);check(request && !seen.has(entry.id),'semantic-ledger-request');seen.add(entry.id);jsonEqual(request.ledger,entry)
    check(entry.stage===request.stage && entry.inputTokens===request.inputAdmission && entry.outputTokens===request.outputReservation && entry.estimatedInputTokens===entry.inputTokens && entry.contextChars===request.contextChars,'semantic-ledger-reservation')
    check(['reserved','unknown-unsent','dispatched','settled','unknown'].includes(entry.state),'semantic-ledger-reservation-state')
    const stage=byStage[entry.stage];stage.estimatedInputTokens+=entry.inputTokens
    if(['dispatched','settled','unknown'].includes(entry.state))stage.dispatchedRequests++;else stage.reservedRequests++
    if(entry.state==='settled') {usage(entry.usage);jsonEqual(entry.usage,request.usage);stage.inputTokens+=entry.usage.inputTokens;stage.outputTokens+=entry.usage.outputTokens;for(const field of Object.keys(actual))actual[field]+=entry.usage[field];overInput+=Math.max(0,entry.usage.inputTokens-entry.inputTokens);overOutput+=Math.max(0,entry.usage.outputTokens-entry.outputTokens)}
    else {check(entry.usage===null,'semantic-ledger-unknown');stage.inputTokens+=entry.inputTokens;stage.outputTokens+=entry.outputTokens;if(entry.state!=='reserved')complete=false}
    if(request.guardIntent)check(['settled','unknown','dispatched'].includes(entry.state),'semantic-ledger-intent')
  }
  for(const request of requests.values())if(!seen.has(request.requestId))check(request.ledger===null && !request.guardIntent,'semantic-ledger-released')
  jsonEqual(ledger.byStage,byStage)
  const stages=Object.values(byStage)
  const totals={dispatchedRequests:sum(stages,'dispatchedRequests'),reservedRequests:sum(stages,'reservedRequests'),inputTokens:sum(stages,'inputTokens'),outputTokens:sum(stages,'outputTokens'),estimatedInputTokens:sum(stages,'estimatedInputTokens')}
  for(const [key,wanted] of Object.entries(totals))check(ledger.total[key]===wanted,'semantic-ledger-total')
  check(ledger.usageComplete===complete && ledger.overspend.inputTokens===overInput && ledger.overspend.outputTokens===overOutput,'semantic-ledger-accounting')
  jsonEqual(ledger.total.actualProviderUsage,complete?actual:null)
  array(value.sourceReads,0,16);const readIds=new Set();let bytes=0
  for(const read of value.sourceReads){record(read,['id','reservedBytes','actualBytes','state']);text(read.id,128);check(!readIds.has(read.id) && !requests.has(read.id) && read.state==='settled','semantic-read-receipt');readIds.add(read.id);number(read.reservedBytes);number(read.actualBytes);bytes+=read.actualBytes}
  number(ledger.total.readBytes);check(ledger.total.toolCalls===0,'semantic-ledger-tools')
  if(value.source!==null)check(bytes===ledger.total.readBytes && value.sourceReads.length>0,'semantic-ledger-source-reads')
  else check(ledger.total.readBytes>=bytes,'semantic-ledger-source-reads')
  const remaining=ledger.remaining
  record(remaining,['modelRequests','inputTokens','outputTokens','readBytes','toolCalls','investigationRequests','investigationInputTokens','investigationOutputTokens','investigationReadBytes','investigationToolCalls','investigationWallClockMs'])
  for(const [key,val] of Object.entries(remaining))check(Number.isFinite(val) && val>=0 && (key==='investigationWallClockMs'||Number.isSafeInteger(val)),'semantic-ledger-remaining')
  for(const key of ['inputTokens','outputTokens','readBytes'])check(remaining[key]===Math.max(0,spec.budget.total[key]-ledger.total[key]),'semantic-ledger-remaining')
  check(remaining.modelRequests===Math.max(0,spec.budget.total.maxModelRequests-totals.dispatchedRequests-totals.reservedRequests),'semantic-ledger-remaining')
  check(remaining.investigationReadBytes===Math.max(0,spec.budget.investigation.readBytes-ledger.total.readBytes),'semantic-ledger-remaining')
  check(!overInput && !overOutput || ledger.blocked,'semantic-ledger-overspend')
  return complete && ledger.reservations.every(entry=>entry.state==='settled') && !ledger.blocked && Object.values(ledger.overspend).every(item=>item===0)
}
function checkOutcome(value,unit,evidence,requests) {
  record(value.review,['assessment','outcome']);const outcome=value.review.outcome
  if(outcome===null){check(value.review.assessment==='incomplete','semantic-review-result');return}
  if(outcome.status==='assessed') {
    record(outcome,['status','verification','assessment','findings','requestId','requestHash','manifestHash'])
    check(outcome.verification==='model-assessed-unverified' && value.review.assessment===outcome.assessment,'semantic-review-result')
    array(outcome.findings,0,8);const ids=new Set()
    const findings=outcome.findings.map(finding=>{record(finding,['id','kind','path','evidenceIds','reason']);check(/^finding-[a-f0-9-]{36}$/u.test(finding.id) && !ids.has(finding.id),'semantic-finding-id');ids.add(finding.id);const {id,...rest}=finding;return rest})
    validateQuestionReviewResponse({assessment:outcome.assessment,findings},{id:unit.questionId,...value.before.question},[...evidence.keys()])
    const request=requests.get(outcome.requestId);check(request && request.stage==='review' && request.ledger?.state==='settled' && request.manifest && request.manifest.manifestHash===outcome.manifestHash && request.requestHash===outcome.requestHash && request.transportComplete,'semantic-review-receipt')
  }else {record(outcome,['status','reason','ruleFailures']);check(['incomplete','not-run-budget'].includes(outcome.status) && value.review.assessment==='incomplete','semantic-review-result');text(outcome.reason,80);array(outcome.ruleFailures,0,3)}
}
function checkRevision(value,unit,spec,evidence,requests) {
  if(value.status!=='applied') {jsonEqual(value.after,value.before,'semantic-failed-case-changed');if(value.revision!==null){record(value.revision,['status','reason']);check(['incomplete','not-run-budget'].includes(value.revision.status),'semantic-revision-status');text(value.revision.reason,80)}return}
  check(unit.kind==='repair' && value.review.outcome?.assessment==='material-risk' && value.review.outcome.findings.length>0,'semantic-revision-authority')
  const revision=value.revision;record(revision,['status','verification','provenance','acceptedSource'])
  check(revision.status==='applied' && revision.verification==='source-bound-unverified','semantic-revision-status')
  const provenance=revision.provenance;record(provenance,['questionId','beforeFingerprint','afterFingerprint','findingIds','source'])
  const before=fingerprintQuestion({id:unit.questionId,...value.before.question});const after=fingerprintQuestion({id:unit.questionId,...value.after.question})
  check(provenance.questionId===unit.questionId && provenance.beforeFingerprint===before && provenance.afterFingerprint===after && before!==after,'semantic-revision-fingerprint')
  array(provenance.findingIds,1,8);check(new Set(provenance.findingIds).size===provenance.findingIds.length && provenance.findingIds.every(id=>value.review.outcome.findings.some(finding=>finding.id===id)),'semantic-revision-findings')
  const accepted=revision.acceptedSource;record(accepted,['description','manifest','manifestUnavailable']);check(accepted.manifest && accepted.manifestUnavailable===null,'semantic-revision-source')
  jsonEqual(accepted.description,provenance.source);checkDescription(accepted.description,unit,spec.snapshotId,value.after,evidence,'completed-semantic-revision')
  checkManifest(accepted.manifest,unit,spec.snapshotId,evidence,accepted.description)
  const description=accepted.description;const request=requests.get(description.requestId)
  check(request && request.stage==='repair' && request.ledger?.state==='settled' && request.transportComplete && request.manifest && request.requestHash===description.requestHash && request.manifest.manifestHash===description.manifestHash && accepted.manifest.manifestHash===description.manifestHash,'semantic-revision-receipt')
  const lineage=description.revision;record(lineage,['version','before','after','findingIds']);check(lineage.version===1,'semantic-revision-lineage');jsonEqual(lineage.findingIds,provenance.findingIds)
  jsonEqual(lineage.before,{questionFingerprint:before,requestId:value.source.description.requestId,requestHash:value.source.description.requestHash,manifestHash:value.source.description.manifestHash})
  jsonEqual(lineage.after,{questionFingerprint:after,requestId:description.requestId,requestHash:description.requestHash,manifestHash:description.manifestHash})
}
function checkCase(value,unit,sample,project,configuration,aggregate,seenRequests) {
  record(value,['schemaVersion','unitId','kind','status','reason','before','after','review','revision','source','sources','evidence','spec','specFingerprint','ledger','sourceReads','requests','inputHash','outputHash','artifacts'])
  check(value.schemaVersion===1 && value.unitId===unit.unitId && value.kind===unit.kind && ['completed','applied','incomplete','not-run'].includes(value.status),'semantic-case-identity')
  check(value.reason===null || typeof value.reason==='string' && value.reason.length<=100,'semantic-case-reason')
  array(value.artifacts,0,0);validateSemanticContentUnit(value.before);validateSemanticContentUnit(value.after)
  jsonEqual(value.before,semanticContentUnit(semanticSampleUnit(sample,unit.questionId)),'semantic-case-original')
  check(value.inputHash===unit.inputHash && semanticHash(value.before)===unit.inputHash && value.outputHash===semanticHash(value.after),'semantic-case-content-hash')
  if(value.spec===null) {
    check(value.status!=='applied' && value.ledger===null && value.source===null && value.specFingerprint===null,'semantic-unattempted-case')
    for(const name of ['requests','sourceReads','evidence','sources'])array(value[name],0,0)
    jsonEqual(value.after,value.before);record(value.review,['assessment','outcome']);check(value.review.assessment==='incomplete' && value.review.outcome===null && value.revision===null,'semantic-unattempted-case')
    return {complete:false,requests:new Map()}
  }
  hash(value.spec.snapshotId)
  const spec=createSemanticCaseRunSpec({unit,snapshot:{snapshotId:value.spec.snapshotId,projectId:unit.projectId},configuration})
  jsonEqual(value.spec,spec,'semantic-case-spec');check(value.specFingerprint===semanticRunSpecFingerprint(spec),'semantic-case-spec-hash')
  let evidence=new Map()
  if(value.source!==null) {
    record(value.source,['description','manifest','manifestUnavailable']);evidence=checkEvidence(value,unit,sample,project,spec.snapshotId)
    for(const item of evidence.values())check(item.fileId===sha256(Buffer.from(spec.snapshotId+'\0'+item.relPath,'utf8')),'semantic-evidence-file-id')
    checkDescription(value.source.description,unit,spec.snapshotId,value.before,evidence,'frozen-evaluation-input')
    check(value.source.manifest && value.source.manifestUnavailable===null,'semantic-source-manifest')
    checkManifest(value.source.manifest,unit,spec.snapshotId,evidence,value.source.description)
    check(value.source.manifest.requestHash===value.source.description.requestHash && value.source.manifest.manifestHash===value.source.description.manifestHash,'semantic-source-manifest-binding')
    check(value.sourceReads.length===sample.evidence.length,'semantic-source-read-count')
    const readPaths=new Set()
    for(let index=0;index<sample.evidence.length;index++) {
      const read=value.sourceReads[index];const ref=sample.evidence[index];const file=project.files.find(file=>file.path===ref.path);const bytes=Buffer.byteLength(file.content,'utf8')
      check(read.reservedBytes===bytes && read.actualBytes===(readPaths.has(ref.path)?0:bytes),'semantic-source-read-bytes');readPaths.add(ref.path)
    }
  }else {array(value.sources,0,0);array(value.evidence,0,0);check(value.requests.length===0,'semantic-source-required')}
  const result=checkRequests(value,unit,spec,evidence,value.source?.description,aggregate,seenRequests)
  const ledgerComplete=checkLedger(value,spec,result.byId)
  checkOutcome(value,unit,evidence,result.byId);checkRevision(value,unit,spec,evidence,result.byId)
  if(value.status==='completed')check(unit.kind==='review' && value.review.outcome?.status==='assessed','semantic-case-status')
  return {complete:result.complete && ledgerComplete && value.source!==null && (unit.kind==='repair' || value.requests.length>0),requests:result.byId}
}
function checkJournal(bytes,report,requestsByUnit) {
  const journalText=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
  check(journalText==='' || journalText.endsWith('\n'),'semantic-journal-truncated')
  const lines=journalText===''?[]:journalText.slice(0,-1).split('\n');check(lines.length<=SEMANTIC_LIMITS.files.maxJournalEvents,'semantic-journal-oversized')
  let previous='0'.repeat(64);const states=new Map()
  for(let index=0;index<lines.length;index++) {
    check(Buffer.byteLength(lines[index],'utf8')<=65536,'semantic-journal-oversized');const event=parseSemanticJson(Buffer.from(lines[index],'utf8'))
    const common=['sequence','previousHash','type','unitId','requestId','eventHash']
    const names=event.type==='reservation'?['stage','inputAdmission','outputReservation','contextChars','requestHash']:event.type==='intent'?['requestHash']:['requestHash','usage','outputHash','outputChars','transportComplete','reason']
    record(event,[...common,...names]);check(event.sequence===index && event.previousHash===previous && ['reservation','intent','receipt','unknown'].includes(event.type),'semantic-journal-chain')
    const {eventHash,...body}=event;check(semanticHash(body)===eventHash,'semantic-journal-hash');previous=eventHash
    const request=requestsByUnit.get(event.unitId)?.get(event.requestId);check(request && event.requestHash===request.requestHash,'semantic-journal-request')
    const state=states.get(event.requestId)??'none'
    if(event.type==='reservation'){check(state==='none','semantic-journal-order');for(const key of ['stage','inputAdmission','outputReservation','contextChars'])check(event[key]===request[key],'semantic-journal-reservation');states.set(event.requestId,'reserved')}
    else if(event.type==='intent'){check(state==='reserved','semantic-journal-order');states.set(event.requestId,'intent')}
    else {check(['reserved','intent'].includes(state) && (!request.guardIntent || state==='intent'),'semantic-journal-order');jsonEqual(event.usage,request.usage);for(const key of ['outputHash','outputChars','transportComplete'])check(event[key]===request[key],'semantic-journal-receipt');check((event.type==='receipt')===(request.usage!==null),'semantic-journal-usage');check(event.reason===null || typeof event.reason==='string' && event.reason.length<=100,'semantic-journal-reason');states.set(event.requestId,'done')}
  }
  for(const requests of requestsByUnit.values())for(const id of requests.keys())check(states.get(id)==='done','semantic-journal-missing')
  jsonEqual(report.journal,{path:'critical.jsonl',events:lines.length,headHash:previous})
}
function checkNativeProvenance(value,frozen,authorization) {
  record(value,['schemaVersion','purpose','mode','native','transport','parentNonce','childNonce','source','entrySourceSha256','bundleSha256','publicDataHash','planHash','executionMapHash','configurationHash','authorizationHash','grantHash','grantFileSha256','claimId','bootstrap','freezeBinding'])
  check(value.schemaVersion===1 && value.purpose===SEMANTIC_PURPOSE && value.mode==='real' && value.transport==='electron/services/llm.ts#chatCompletionStream/v1' && value.freezeBinding==='parent-observed-close-exact-freeze-v1','semantic-native-provenance-invalid')
  record(value.native,['platform','processType','electron','node','chrome'])
  check(value.native.platform==='win32' && value.native.processType==='browser','semantic-native-provenance-invalid')
  for(const name of ['electron','node','chrome'])check(typeof value.native[name]==='string' && /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.]+)?$/u.test(value.native[name]),'semantic-native-provenance-invalid')
  for(const name of ['parentNonce','childNonce','entrySourceSha256','bundleSha256','grantHash','grantFileSha256'])hash(value[name])
  check(value.parentNonce!==value.childNonce,'semantic-native-provenance-invalid')
  for(const name of ['source','publicDataHash','planHash','executionMapHash','configurationHash','authorizationHash','claimId'])jsonEqual(value[name],frozen[name],'semantic-native-provenance-invalid')
  const body={type:'semantic-grant',schemaVersion:1,purpose:SEMANTIC_PURPOSE,mode:'real',parentNonce:value.parentNonce,childNonce:value.childNonce,authorization}
  check(semanticHash(body)===value.grantHash && sha256(Buffer.from(canonicalJson({...body,grantHash:value.grantHash})+'\n','utf8'))===value.grantFileSha256,'semantic-native-provenance-invalid')
  jsonEqual(value.bootstrap,{capture:1,stage:1,paths:4,release:1,privateProfile:1,distinctPaths:4,captureBeforeReady:true,pathSwitchBeforeReady:true,releaseAfterPathSwitch:true},'semantic-native-provenance-invalid')
}
/** Independently validates exact frozen bytes and all referenced public/execution artifacts. */
export async function validateFrozenSemanticExecution(outputDirectory,options={}) {
  record(options,['bundle','requireReal','expectedFreezeBytes','nativeParentProof'],[])
  const root=await assertSafeSemanticDirectory(outputDirectory)
  const freezeBytes=await readSemanticFile(root,'execution-freeze.json')
  if(options.expectedFreezeBytes!==undefined)check(Buffer.isBuffer(options.expectedFreezeBytes) && freezeBytes.equals(options.expectedFreezeBytes),'semantic-freeze-bytes')
  const frozen=parseSemanticJson(freezeBytes)
  record(frozen,['schemaVersion','purpose','protocol','mode','source','publicDataHash','planHash','executionMapHash','configurationHash','authorizationHash','claimId','artifacts'])
  check(frozen.schemaVersion===1 && frozen.purpose===SEMANTIC_PURPOSE && frozen.protocol===SEMANTIC_PROTOCOL && ['real','synthetic'].includes(frozen.mode),'semantic-freeze-schema')
  if(options.requireReal===true)check(frozen.mode==='real','semantic-synthetic-not-real')
  if(options.requireReal===true)check(options.nativeParentProof,'semantic-native-parent-proof-required')
  if(frozen.mode==='synthetic')check(options.nativeParentProof===undefined,'semantic-native-parent-proof-mismatch')
  array(frozen.artifacts,109,SEMANTIC_LIMITS.files.maxArtifacts)
  const artifacts=new Map();let bytesTotal=freezeBytes.length
  for(const artifact of frozen.artifacts) {
    record(artifact,['path','bytes','sha256']);number(artifact.bytes,SEMANTIC_LIMITS.files.artifactBytes);hash(artifact.sha256)
    check(safeSemanticRelativePath(artifact.path) && artifact.path!=='execution-freeze.json' && !artifacts.has(artifact.path),'semantic-artifact-path')
    const bytes=await readSemanticFile(root,artifact.path,SEMANTIC_LIMITS.files.artifactBytes)
    check(bytes.length===artifact.bytes && sha256(bytes)===artifact.sha256,'semantic-artifact-hash')
    bytesTotal+=bytes.length;check(bytesTotal<=SEMANTIC_LIMITS.files.executionBytes,'semantic-execution-oversized');artifacts.set(artifact.path,bytes)
  }
  jsonEqual(await diskFiles(root),[...artifacts.keys(),'execution-freeze.json'].sort(),'semantic-artifact-membership')
  const readJson=name=>{check(artifacts.has(name),'semantic-artifact-missing');return parseSemanticJson(artifacts.get(name))}
  const documents={};const rawHashes={}
  for(const name of SEMANTIC_PUBLIC_FILES){const bytes=artifacts.get('inputs/'+name);check(bytes,'semantic-public-input-missing');documents[name]=parseSemanticJson(bytes);rawHashes[name]=sha256(bytes)}
  const bundle=projectSemanticPublicData(documents,rawHashes);jsonEqual(readJson('public-data.json'),bundle,'semantic-public-input-binding')
  if(options.bundle!==undefined){validateSemanticPublicBundle(options.bundle);jsonEqual(options.bundle,bundle,'semantic-public-current-binding')}
  const plan=readJson('plan.json');const executionMap=readJson('execution-map.json');validateSemanticExecutionPlan(bundle,plan,executionMap)
  const authorization=readJson('authorization.json');validateSemanticConfiguration(authorization.configuration)
  const expected=createSemanticAuthorizationDraft({mode:frozen.mode,reference:authorization.reference,source:frozen.source,bundle,plan,executionMap,configuration:authorization.configuration})
  jsonEqual(authorization,expected,'semantic-authorization-binding')
  const claimId=semanticHash({purpose:SEMANTIC_PURPOSE,mode:frozen.mode,reference:authorization.reference,source:frozen.source})
  const claim={schemaVersion:1,purpose:SEMANTIC_PURPOSE,mode:frozen.mode,claimId,authorizationHash:semanticHash(authorization),source:frozen.source,publicDataHash:bundle.publicDataHash,planHash:plan.planHash,executionMapHash:executionMap.executionMapHash,configurationHash:authorization.configuration.configurationHash}
  const started={schemaVersion:1,purpose:SEMANTIC_PURPOSE,mode:frozen.mode,claimId,authorizationHash:claim.authorizationHash,planHash:plan.planHash}
  jsonEqual(readJson('claim.json'),{claim,started},'semantic-claim-binding')
  for(const key of ['claimId','authorizationHash','publicDataHash','planHash','executionMapHash','configurationHash'])check(frozen[key]===claim[key],'semantic-freeze-binding')
  const report=readJson('execution.json')
  record(report,['schemaVersion','purpose','protocol','mode','source','sourceHashMeaning','publicDataHash','planHash','executionMapHash','configurationHash','authorizationHash','claimId','sourceStable','sealed','sealReason','aggregate','cases','journal','quality'])
  for(const key of ['schemaVersion','purpose','protocol','mode','source','publicDataHash','planHash','executionMapHash','configurationHash','authorizationHash','claimId'])jsonEqual(report[key],frozen[key])
  check(report.sourceHashMeaning==='git-commit-tree-identity-v1' && report.quality==='not-evaluated' && typeof report.sourceStable==='boolean' && typeof report.sealed==='boolean' && (report.sealReason===null||typeof report.sealReason==='string' && report.sealReason.length<=100),'semantic-execution-report')
  check(report.sealed===false?report.sealReason===null:report.sealReason!==null,'semantic-execution-seal')
  array(report.cases,100,100)
  const aggregate={requests:0,inputAdmission:0,outputReservation:0,actualInputTokens:0,actualOutputTokens:0,unknownRequests:0}
  const cases=[];const seenRequests=new Set();const requestsByUnit=new Map();const expectedFiles=new Set(['public-data.json','plan.json','execution-map.json','authorization.json','claim.json','execution.json','critical.jsonl',...SEMANTIC_PUBLIC_FILES.map(name=>'inputs/'+name)])
  let nativeProvenance='not-applicable'
  if(frozen.mode==='real') {
    const provenance=readJson('native-provenance.json');expectedFiles.add('native-provenance.json')
    checkNativeProvenance(provenance,frozen,authorization)
    nativeProvenance='unavailable'
    if(options.nativeParentProof!==undefined) {
      // Load the canonical source CJS launcher only in the parent verifier. The
      // child bundle must not create a second parent-proof WeakMap instance.
      const {default:semanticLauncher}=await import(new URL('../evaluation/run-semantic-profile.cjs',import.meta.url).href)
      semanticLauncher.verifySemanticParentProof(options.nativeParentProof,{outputDirectory:root,freezeBytes,provenance})
      nativeProvenance='parent-observed-native-close'
    }
    if(options.requireReal===true)check(nativeProvenance==='parent-observed-native-close','semantic-native-parent-proof-required')
  }
  let complete=true;let unknownSeen=false
  for(let index=0;index<100;index++) {
    const unit=plan.units[index];const mapping=executionMap.entries[index];const entry=report.cases[index]
    record(entry,['unitId','kind','status','file','sha256'])
    check(entry.unitId===unit.unitId && entry.kind===unit.kind && entry.file===`cases/${unit.unitId}.json` && artifacts.has(entry.file) && sha256(artifacts.get(entry.file))===entry.sha256,'semantic-case-file')
    expectedFiles.add(entry.file)
    const sample=bundle.documents[unit.kind==='review'?'review-packet.json':'repair-samples.json'].samples.find(sample=>sample.id===mapping.sampleId)
    const project=bundle.documents['projects.json'].projects.find(project=>project.id===mapping.projectId)
    const value=readJson(entry.file);check(entry.status===value.status,'semantic-case-report')
    if(unknownSeen)check(value.requests.length===0 && value.status==='not-run','semantic-unknown-dispatch')
    const result=checkCase(value,unit,sample,project,authorization.configuration,aggregate,seenRequests)
    requestsByUnit.set(unit.unitId,result.requests);complete&&=result.complete
    if(value.requests.some(request=>['unknown','unknown-unsent'].includes(request.state)))unknownSeen=true
    if(value.spec!==null)for(const file of project.files) {
      const relative=`scratch/${unit.projectId}/${file.path}`;check(artifacts.has(relative) && sha256(artifacts.get(relative))===file.sha256 && artifacts.get(relative).equals(Buffer.from(file.content,'utf8')),'semantic-scratch-source');expectedFiles.add(relative)
    }
    cases.push(value)
  }
  // A project can be materialized before an attempted scan fails; only genuine mapped fixture bytes are permitted.
  for(const [name,bytes] of artifacts)if(name.startsWith('scratch/') && !expectedFiles.has(name)) {
    const unit=plan.units.find(unit=>name.startsWith(`scratch/${unit.projectId}/`));check(unit,'semantic-scratch-project')
    const mapping=executionMap.entries[unit.order];const project=bundle.documents['projects.json'].projects.find(project=>project.id===mapping.projectId)
    const relative=name.slice(`scratch/${unit.projectId}/`.length);const file=project.files.find(file=>file.path===relative)
    check(file && bytes.equals(Buffer.from(file.content,'utf8')) && sha256(bytes)===file.sha256,'semantic-scratch-source');expectedFiles.add(name)
  }
  jsonEqual([...artifacts.keys()].sort(),[...expectedFiles].sort(),'semantic-artifact-unexpected')
  record(report.aggregate,Object.keys(aggregate));jsonEqual(report.aggregate,aggregate,'semantic-aggregate-accounting')
  for(const key of ['requests','inputAdmission','outputReservation'])check(aggregate[key]<=SEMANTIC_LIMITS.aggregate[key==='requests'?'maxRequests':key],'semantic-aggregate-limit')
  checkJournal(artifacts.get('critical.jsonl'),report,requestsByUnit)
  if(unknownSeen)check(report.sealed && !complete,'semantic-unknown-seal')
  const executionHash=sha256(freezeBytes)
  const wrapper=freezeSemanticValue({schemaVersion:1,executionHash,publicDataHash:bundle.publicDataHash,mode:frozen.mode,executionComplete:complete && report.sourceStable && !report.sealed && (frozen.mode==='synthetic'||nativeProvenance==='parent-observed-native-close'),nativeProvenance,accounting:aggregate,cases:100,quality:'not-evaluated'})
  verified.set(wrapper,freezeSemanticValue({bundle,plan,executionMap,cases,executionHash,publicDataHash:bundle.publicDataHash}))
  return wrapper
}
/** Exact public scoring input only; copies cannot stand in for full independent validation. */
export function projectSemanticScoringInputs(validatedExecution) {
  const execution=validatedExecution && typeof validatedExecution==='object'?verified.get(validatedExecution):undefined
  check(execution,'semantic-validated-execution-required')
  const reviews=[];const repairs=[]
  for(let index=0;index<100;index++) {
    const value=execution.cases[index];const unit=execution.plan.units[index];const mapping=execution.executionMap.entries[index]
    if(unit.kind==='review')reviews.push({unitId:unit.unitId,sampleId:mapping.sampleId,assessment:value.review.assessment})
    else {
      const sample=execution.bundle.documents['repair-samples.json'].samples.find(sample=>sample.id===mapping.sampleId)
      const project=execution.bundle.documents['projects.json'].projects.find(project=>project.id===mapping.projectId)
      repairs.push({unitId:unit.unitId,sampleId:mapping.sampleId,status:value.status==='applied'?'applied':value.status==='not-run'?'not-run':'incomplete',before:value.before,after:value.after,sources:value.sources.length?value.sources:sample.evidence.map(ref=>canonicalSource(project,ref))})
    }
  }
  check(reviews.length===80 && repairs.length===20,'semantic-scoring-denominator')
  return freezeSemanticValue({schemaVersion:1,executionHash:execution.executionHash,publicDataHash:execution.publicDataHash,reviews,repairs})
}
