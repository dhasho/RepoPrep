import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFile,writeFile,unlink} from 'node:fs/promises'
import path from 'node:path'
import {canonicalJson,sha256} from './dataset-contract.mjs'
import {fixture,replaceFrozenJson,profile} from './semantic-eval-test-fixture.mjs'
import {executeSemanticEvaluation} from './semantic-eval.mjs'
import {validateFrozenSemanticExecution,projectSemanticScoringInputs,semanticHash,SEMANTIC_LIMITS} from './semantic-eval-contract.mjs'
import {estimateMessageTokens} from '../../shared/token-budget.ts'
function transportFor(f,{retry=false,unknown=false,unsent=false,cancel=false,noRiskRepairs=new Set()}={}) {
  const counters={entries:0,fetches:0,review:0,repair:0,messages:[]};const repairQuestions=new Set(f.bundle.documents['repair-samples.json'].samples.map(sample=>sample.question))
  const transport=async(active,messages,_emit,options)=>{
    counters.entries++;assert.equal(active.contextWindowTokens,f.input.profile.contextWindowTokens)
    if(unsent)return '{}'
    await options.beforeRequest?.();if(cancel){cancel.abort();options.beforeFetch?.();throw new Error('cancelled')}
    options.beforeFetch?.();counters.fetches++;counters.messages.push(JSON.stringify(messages))
    const isRepair=messages[0].content.startsWith('Revise only');const ordinal=++counters[isRepair?'repair':'review']
    assert.ok(options.maxOutputTokens<=(isRepair?8192:4096));assert.ok(options.maxOutputTokens<=f.input.profile.maxOutputTokens)
    const inputTokens=estimateMessageTokens(messages);if(!unknown)options.onUsage?.({inputTokens,outputTokens:1,totalTokens:inputTokens+1})
    if(retry && ordinal%2===1)return '{malformed'
    const ids=[...new Set(JSON.stringify(messages).match(/ev_[a-f0-9-]{36}/gu))]
    if(isRepair) {
      const unit=JSON.parse(messages[1].content.split('\n')[1]);const question={question:unit.question,answer:unit.answer+' Revised from the actual supplied source.',followUps:unit.followUps,...(unit.title?{title:unit.title}:{})}
      return JSON.stringify({question,evidenceIds:ids,glossary:{}})
    }
    const unit=JSON.parse(messages[1].content.split('\n')[1]);const isNoRisk=noRiskRepairs.has(unit.question)
    return JSON.stringify(isNoRisk?{assessment:'no-material-risk',findings:[]}:{assessment:'material-risk',findings:[{kind:'unsupported-claim',path:'answer',evidenceIds:ids,reason:'Synthetic evidence-based test finding.'}]})
  }
  return {counters,transport}
}
test('all100 genuine S/R/V cases and240 retry dispatches retain original ledger, manifests, caps and exact freeze/scoring bytes',async t=>{
  const f=await fixture(t);const claim=await f.claim();await assert.rejects(executeSemanticEvaluation({mode:'synthetic',claim:{...claim},outputDirectory:f.output,transport:async()=>''}),/semantic-claim-required/u)
  const {counters,transport}=transportFor(f,{retry:true});const result=await executeSemanticEvaluation({mode:'synthetic',claim,outputDirectory:f.output,transport})
  assert.equal(counters.entries,240);assert.equal(counters.fetches,240);assert.equal(counters.review,200);assert.equal(counters.repair,40);assert.equal(result.sealed,false)
  const freeze=await readFile(path.join(f.output,'execution-freeze.json'));assert.equal(result.executionHash,sha256(freeze));assert.equal(Object.hasOwn(JSON.parse(freeze),'executionHash'),false)
  const valid=await validateFrozenSemanticExecution(f.output,{bundle:f.bundle,expectedFreezeBytes:freeze});assert.equal(valid.executionComplete,true);assert.equal(valid.accounting.requests,240);assert.equal(valid.accounting.outputReservation,1146880)
  const projection=projectSemanticScoringInputs(valid);assert.equal(projection.reviews.length,80);assert.equal(projection.repairs.length,20);assert.equal(projection.repairs.filter(item=>item.status==='applied').length,20);assert.equal(projection.executionHash,result.executionHash)
  assert.equal(Object.isFrozen(projection.repairs[0].after.question),true);assert.throws(()=>projectSemanticScoringInputs({...valid}),/semantic-validated-execution-required/u)
  for(const sample of [...f.bundle.documents['review-packet.json'].samples,...f.bundle.documents['repair-samples.json'].samples])assert.equal(counters.messages.some(message=>message.includes(sample.id)),false)
  assert.equal(counters.messages.some(message=>message.includes(profile.apiKey)),false)
  for(const project of f.bundle.documents['projects.json'].projects)assert.equal(counters.messages.some(message=>message.includes(project.id)),false)
  await assert.rejects(validateFrozenSemanticExecution(f.output,{requireReal:true}),/semantic-synthetic-not-real/u)
  await assert.rejects(validateFrozenSemanticExecution(f.output,{expectedFreezeBytes:Buffer.concat([freeze,Buffer.from('\n')])}),/semantic-freeze-bytes/u)
  await assert.rejects(executeSemanticEvaluation({mode:'synthetic',claim,outputDirectory:f.output,transport}),/semantic-claim-required/u)
  const caseName=`cases/${f.plan.units.find(unit=>unit.kind==='repair').unitId}.json`
  for(const [name,mutate] of [
    ['execution.json',value=>value.aggregate.inputAdmission++],
    [caseName,value=>value.ledger.total.inputTokens++],
    [caseName,value=>value.requests[0].manifest.sources[0].hash='0'.repeat(64)],
    [caseName,value=>value.requests[0].manifest.requestHash='0'.repeat(64)],
    [caseName,value=>value.revision.provenance.beforeFingerprint='0'.repeat(64)],
    [caseName,value=>value.sourceReads[0].actualBytes++],
    [caseName,value=>value.evidence[0].text+=' forged'],
    ['execution-map.json',value=>value.entries[0].sampleId=value.entries[1].sampleId]
  ]){const restore=await replaceFrozenJson(f.output,name,mutate);try{await assert.rejects(validateFrozenSemanticExecution(f.output))}finally{await restore()}}
  const journalPath=path.join(f.output,'critical.jsonl');const original=await readFile(journalPath);await writeFile(journalPath,original.subarray(0,original.length-1));await assert.rejects(validateFrozenSemanticExecution(f.output));await writeFile(journalPath,original)
  await writeFile(path.join(f.output,'uncommitted-extra.txt'),'extra');await assert.rejects(validateFrozenSemanticExecution(f.output),/semantic-artifact-membership/u);await unlink(path.join(f.output,'uncommitted-extra.txt'))
})
test('unknown and unknown-unsent usage seal subsequent dispatch, preserve reservations and all100 denominators',async t=>{
  for(const mode of ['unknown','unsent']){
    const f=await fixture(t);const claim=await f.claim();const {counters,transport}=transportFor(f,{[mode]:true});const result=await executeSemanticEvaluation({mode:'synthetic',claim,outputDirectory:f.output,transport})
    assert.equal(counters.entries,1);assert.equal(counters.fetches,mode==='unknown'?1:0);assert.equal(result.sealed,true)
    const valid=await validateFrozenSemanticExecution(f.output);assert.equal(valid.executionComplete,false);assert.equal(valid.accounting.unknownRequests,1);assert.equal(valid.accounting.requests,1)
    const first=JSON.parse(await readFile(path.join(f.output,'cases',f.plan.units[0].unitId+'.json'),'utf8'));assert.equal(first.ledger.reservations[0].state,mode==='unknown'?'unknown':'unknown-unsent');assert.equal(first.ledger.total.inputTokens,first.requests[0].inputAdmission);assert.equal(first.ledger.total.outputTokens,first.requests[0].outputReservation)
    const scoring=projectSemanticScoringInputs(valid);assert.equal(scoring.reviews.length,80);assert.equal(scoring.repairs.length,20);for(const repair of scoring.repairs)assert.deepEqual(repair.after,repair.before)
  }
})
test('cancellation after awaited admission reaches no final dispatch and retains all denominator slots',async t=>{
  const f=await fixture(t);const controller=new AbortController();const {counters,transport}=transportFor(f,{cancel:controller});const result=await executeSemanticEvaluation({mode:'synthetic',claim:await f.claim(),outputDirectory:f.output,transport,signal:controller.signal})
  assert.equal(counters.fetches,0);assert.equal(result.cases,100);assert.equal((await validateFrozenSemanticExecution(f.output)).executionComplete,false)
})
test('six fully accounted known non-applied repairs stay zero-of20 while14applied repairs remain complete',async t=>{
  const f=await fixture(t);const six=new Set(f.bundle.documents['repair-samples.json'].samples.slice(0,6).map(sample=>sample.question));const {transport}=transportFor(f,{noRiskRepairs:six})
  await executeSemanticEvaluation({mode:'synthetic',claim:await f.claim(),outputDirectory:f.output,transport});const valid=await validateFrozenSemanticExecution(f.output);assert.equal(valid.executionComplete,true)
  const scoring=projectSemanticScoringInputs(valid);assert.equal(scoring.repairs.filter(repair=>repair.status==='applied').length,14);const failed=scoring.repairs.filter(repair=>repair.status!=='applied');assert.equal(failed.length,6);failed.forEach(repair=>assert.deepEqual(repair.after,repair.before))
})

test('known budget-denied zero-dispatch repairs remain accounted with genuine source and unchanged scoring pairs',async t=>{
  const f=await fixture(t,{copyData:true,privateProfile:{...profile,contextWindowTokens:8192,maxOutputTokens:4096},prepareData:async data=>{
    const file=path.join(data,'repair-samples.json');const doc=JSON.parse(await readFile(file,'utf8'))
    for(const sample of doc.samples.slice(0,6)){sample.answer='x'.repeat(14000);sample.answerFingerprint=semanticHash({question:sample.question,answer:sample.answer,followUps:sample.followUps})}
    await writeFile(file,JSON.stringify(doc))
  }})
  const {transport}=transportFor(f);await executeSemanticEvaluation({mode:'synthetic',claim:await f.claim(),outputDirectory:f.output,transport})
  const zero=[]
  for(const unit of f.plan.units.filter(unit=>unit.kind==='repair')){const value=JSON.parse(await readFile(path.join(f.output,'cases',unit.unitId+'.json'),'utf8'));if(value.requests.length===0)zero.push(value)}
  assert.equal(zero.length,6,JSON.stringify(zero.map(value=>({reason:value.reason,source:!!value.source}))))
  for(const value of zero){assert.ok(value.source?.manifest);assert.equal(value.review.outcome.status,'not-run-budget');assert.equal(value.ledger.total.dispatchedRequests,0);assert.deepEqual(value.after,value.before)}
  const valid=await validateFrozenSemanticExecution(f.output);assert.equal(valid.executionComplete,true)
  const scoring=projectSemanticScoringInputs(valid);assert.equal(scoring.repairs.filter(repair=>repair.status==='applied').length,14);assert.equal(scoring.repairs.length,20)
})

test('last synchronous fetch fence rejects public mutation after awaited admission with a non-aborted signal',async t=>{
  const f=await fixture(t,{copyData:true});let entries=0;let fetches=0;const controller=new AbortController();const file=path.join(f.data,'projects.json');const original=await readFile(file)
  const transport=async(_profile,messages,_emit,options)=>{entries++;await options.beforeRequest?.();await writeFile(file,Buffer.concat([original,Buffer.from(' ')]));options.beforeFetch?.();fetches++;const inputTokens=estimateMessageTokens(messages);options.onUsage?.({inputTokens,outputTokens:1,totalTokens:inputTokens+1});return JSON.stringify({assessment:'no-material-risk',findings:[]})}
  const result=await executeSemanticEvaluation({mode:'synthetic',claim:await f.claim(),outputDirectory:f.output,transport,signal:controller.signal})
  assert.equal(controller.signal.aborted,false);assert.equal(entries,1);assert.equal(fetches,0);assert.equal(result.sealed,true);const valid=await validateFrozenSemanticExecution(f.output);assert.equal(valid.executionComplete,false);assert.equal(valid.accounting.requests,1)
})
