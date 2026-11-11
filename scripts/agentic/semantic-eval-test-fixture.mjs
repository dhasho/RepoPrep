import assert from 'node:assert/strict'
import { mkdtemp,mkdir,readFile,writeFile,rm,lstat,realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {canonicalJson,sha256} from './dataset-contract.mjs'
import {SEMANTIC_PUBLIC_FILES,loadSemanticPublicBundle,createSemanticExecutionPlan,deriveSemanticConfiguration,createSemanticAuthorizationDraft} from './semantic-eval-contract.mjs'
import {claimSemanticExecution} from './semantic-eval.mjs'
export const dataDirectory=fileURLToPath(new URL('./datasets/v1/',import.meta.url))
export const profile=Object.freeze({id:'synthetic-profile',name:'Synthetic',baseUrl:'https://synthetic.invalid/v1',model:'synthetic-model',apiKey:'synthetic-only-no-real-key',protocol:'openai',contextWindowTokens:49152,maxOutputTokens:8192})
export const source=Object.freeze({commit:'a'.repeat(40),treeSha256:'b'.repeat(64)})
export async function fixture(t,{copyData=false,privateProfile=profile,prepareData}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'repoprep-semantic-test-'));const captured=await realpath(root)
  t.after(async()=>{const actual=await realpath(root);assert.equal(actual,captured);assert.equal(path.dirname(actual).toLowerCase(),(await realpath(os.tmpdir())).toLowerCase());assert.match(path.basename(actual),/^repoprep-semantic-test-/u);assert.equal((await lstat(actual)).isSymbolicLink(),false);await rm(actual,{recursive:true,force:true})})
  await mkdir(path.join(root,'claims'));let data=dataDirectory
  if(copyData){data=path.join(root,'data');await mkdir(data);for(const name of SEMANTIC_PUBLIC_FILES)await writeFile(path.join(data,name),await readFile(path.join(dataDirectory,name)))}
  if(prepareData)await prepareData(data)
  const bundle=await loadSemanticPublicBundle(data);const {plan,executionMap}=createSemanticExecutionPlan(bundle);const configuration=deriveSemanticConfiguration(privateProfile)
  const authorization=createSemanticAuthorizationDraft({mode:'synthetic',reference:'synthetic-test-'+randomUUID(),source,bundle,plan,executionMap,configuration})
  const input={mode:'synthetic',syntheticSource:source,dataDirectory:data,plan,executionMap,profile:privateProfile,authorization,claimDirectory:path.join(root,'claims')}
  return {root,data,bundle,plan,executionMap,configuration,authorization,input,async claim(){return claimSemanticExecution(input)},output:path.join(root,'output')}
}
export async function replaceFrozenJson(output,name,mutate) {
  const filename=path.join(output,name);const original=await readFile(filename);const freezePath=path.join(output,'execution-freeze.json');const oldFreeze=await readFile(freezePath)
  const value=JSON.parse(original);mutate(value);const bytes=Buffer.from(canonicalJson(value)+'\n','utf8');await writeFile(filename,bytes)
  const frozen=JSON.parse(oldFreeze);const artifact=frozen.artifacts.find(artifact=>artifact.path===name);artifact.sha256=sha256(bytes);artifact.bytes=bytes.length
  let oldReport=null
  if(name.startsWith('cases/')) {
    const reportPath=path.join(output,'execution.json');oldReport=await readFile(reportPath);const report=JSON.parse(oldReport);report.cases.find(entry=>entry.file===name).sha256=artifact.sha256
    const reportBytes=Buffer.from(canonicalJson(report)+'\n','utf8');await writeFile(reportPath,reportBytes);const record=frozen.artifacts.find(artifact=>artifact.path==='execution.json');record.sha256=sha256(reportBytes);record.bytes=reportBytes.length
  }
  await writeFile(freezePath,canonicalJson(frozen)+'\n')
  return async()=>{await writeFile(filename,original);if(oldReport)await writeFile(path.join(output,'execution.json'),oldReport);await writeFile(freezePath,oldFreeze)}
}
