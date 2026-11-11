import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile,writeFile,link,mkdir,symlink } from 'node:fs/promises'
import path from 'node:path'
import { canonicalJson,sha256 } from './dataset-contract.mjs'
import { fixture,profile,source } from './semantic-eval-test-fixture.mjs'
import { SEMANTIC_PUBLIC_FILES,loadSemanticPublicBundle,createSemanticExecutionPlan,createSemanticAuthorizationDraft,parseSemanticJson,readSemanticFile,safeSemanticRelativePath,validateSemanticExecutionPlan,deriveSemanticConfiguration,semanticEffectiveProfile,createSemanticCaseRunSpec,validateSemanticAuthorization,semanticHash } from './semantic-eval-contract.mjs'
import { claimSemanticExecution,executeSemanticEvaluation } from './semantic-eval.mjs'
test('semantic public loader binds exactly80+20 to raw/canonical public bytes without private files',async t=>{
  const f=await fixture(t,{copyData:true});assert.equal(f.bundle.documents['review-packet.json'].samples.length,80);assert.equal(f.bundle.documents['repair-samples.json'].samples.length,20)
  await writeFile(path.join(f.data,'review-key.json'),'invalid private data must never be read')
  const before=await loadSemanticPublicBundle(f.data);const file=path.join(f.data,'projects.json');await writeFile(file,' \n'+await readFile(file,'utf8')+'\n')
  const after=await loadSemanticPublicBundle(f.data);assert.equal(before.assets['projects.json'].canonicalSha256,after.assets['projects.json'].canonicalSha256);assert.notEqual(before.assets['projects.json'].rawSha256,after.assets['projects.json'].rawSha256);assert.notEqual(before.publicDataHash,after.publicDataHash)
  for(const mutate of [doc=>doc.projects[0].files[0].content+='tamper',doc=>doc.projects[0].files[0].path='../escape.ts',doc=>doc.projects[0].files[0].path='source.ts:stream',doc=>doc.projects[0].labels=[]]) {
    const original=await readFile(file);const doc=JSON.parse(original);mutate(doc);await writeFile(file,JSON.stringify(doc));await assert.rejects(loadSemanticPublicBundle(f.data));await writeFile(file,original)
  }
  const sampleFile=path.join(f.data,'review-packet.json');const original=await readFile(sampleFile)
  for(const mutate of [doc=>doc.samples[0].truth=true,doc=>doc.samples[1].id=doc.samples[0].id,doc=>doc.samples[0].evidence[0].endLine=99999,doc=>doc.samples[0].evidence[0].sha256='0'.repeat(64),doc=>doc.samples[0].fingerprint='0'.repeat(64)]){const doc=JSON.parse(original);mutate(doc);await writeFile(sampleFile,JSON.stringify(doc));await assert.rejects(loadSemanticPublicBundle(f.data));await writeFile(sampleFile,original)}
})
test('semantic byte reader and JSON parser reject ambiguous, unsafe, linked and oversized inputs',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'input.json'),'{}');await assert.rejects(readSemanticFile(f.root,'input.json',1))
  await link(path.join(f.root,'input.json'),path.join(f.root,'hard.json'));await assert.rejects(readSemanticFile(f.root,'input.json'));await assert.rejects(readSemanticFile(f.root,'hard.json'))
  await mkdir(path.join(f.root,'actual'));await writeFile(path.join(f.root,'actual','value.json'),'{}');await symlink(path.join(f.root,'actual'),path.join(f.root,'junction'),'junction');await assert.rejects(readSemanticFile(f.root,'junction/value.json'))
  for(const value of ['../a','a/../b','C:/a','/a','a\\b','con.txt','a:stream','a.','a ','a//b','a/./b'])assert.equal(safeSemanticRelativePath(value),false,value)
  for(const value of ['{"a":1,"a":2}','{"a":{"x":0,"x":1}}','[1,]','{"x":1e9999}','[','{}{}','['.repeat(50)+'0'+']'.repeat(50)])assert.throws(()=>parseSemanticJson(Buffer.from(value,'utf8')))
  assert.throws(()=>parseSemanticJson(Buffer.from([0x22,0xff,0x22])));assert.deepEqual(parseSemanticJson(Buffer.from('{"a":[true,null,1.2e3]}')),{a:[true,null,1200]})
})
test('runtime plan is shuffled, bijective and opaque; configuration only tightens output under original context/read/time ceilings',async t=>{
  const f=await fixture(t);assert.equal(validateSemanticExecutionPlan(f.bundle,f.plan,f.executionMap),true)
  assert.equal(new Set(f.plan.units.map(unit=>unit.unitId)).size,100);assert.equal(new Set(f.executionMap.entries.map(unit=>unit.sampleId)).size,100)
  for(const unit of f.plan.units){assert.match(unit.unitId,/^unit-[a-f0-9-]{36}$/u);assert.match(unit.questionId,/^question-[a-f0-9-]{36}$/u);assert.match(unit.projectId,/^project-[a-f0-9-]{36}$/u)}
  const wrong=structuredClone(f.executionMap);wrong.entries[0].sampleId=wrong.entries[1].sampleId;assert.throws(()=>validateSemanticExecutionPlan(f.bundle,f.plan,wrong))
  for(const kind of ['review','repair']){const effective=semanticEffectiveProfile(profile,kind);assert.equal(effective.contextWindowTokens,profile.contextWindowTokens);assert.equal(effective.maxOutputTokens,kind==='review'?4096:8192);const unit=f.plan.units.find(unit=>unit.kind===kind);const spec=createSemanticCaseRunSpec({unit,snapshot:{snapshotId:'c'.repeat(64),projectId:unit.projectId},configuration:f.configuration});assert.equal(spec.granularity,'coarse');assert.equal(spec.roleFocus,'general');assert.equal(spec.budget.total.wallClockMs,600000);assert.equal(spec.budget.total.readBytes,8388608);assert.equal(spec.budget.total.maxModelRequests,kind==='review'?2:4)}
  assert.throws(()=>deriveSemanticConfiguration({...profile,baseUrl:'https://user:secret@synthetic.invalid/v1'}));assert.throws(()=>deriveSemanticConfiguration({...profile,contextWindowTokens:4096,maxOutputTokens:8192}));assert.equal(profile.maxOutputTokens,8192)
})
test('exclusive synthetic claims bind the complete grant, reject copies/purpose/config and real dirty source before profile access',async t=>{
  const f=await fixture(t);await f.claim();await assert.rejects(f.claim(),/EEXIST/u)
  const authorization=structuredClone(f.authorization);authorization.purpose='m08-generation-v1';assert.throws(()=>validateSemanticAuthorization(authorization,{mode:'synthetic',source,bundle:f.bundle,plan:f.plan,executionMap:f.executionMap,configuration:f.configuration}))
  let profiles=0;const {syntheticSource,...real}=f.input;await assert.rejects(claimSemanticExecution({...real,mode:'real',repoRoot:path.resolve('.'),currentProfile:()=>{profiles++;throw new Error('must not read profile')}}),/semantic-source-dirty/u);assert.equal(profiles,0)
})


test('changed public bytes after claim reject before transport and a new plan cannot reuse a claimed reference',async t=>{
  const f=await fixture(t,{copyData:true});const claim=await f.claim();let transports=0
  const file=path.join(f.data,'projects.json');const original=await readFile(file);await writeFile(file,' '+original.toString('utf8'))
  await assert.rejects(executeSemanticEvaluation({mode:'synthetic',claim,outputDirectory:f.output,transport:async()=>{transports++;return ''}}),/semantic-public-changed/u);assert.equal(transports,0)
  await writeFile(file,original);const next=createSemanticExecutionPlan(f.bundle)
  const authorization=createSemanticAuthorizationDraft({mode:'synthetic',reference:f.authorization.reference,source,bundle:f.bundle,...next,configuration:f.configuration})
  await assert.rejects(claimSemanticExecution({...f.input,...next,authorization}),/EEXIST/u)
})
