import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = resolve('scripts/agentic/datasets/v1')
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex')
const canonical = value => JSON.stringify(sortKeys(value))
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
  return value
}

const projects = [
  { id: 'py-cache', language: 'Python', files: {
    'README.md': `# Fast cache\nThe cache uses a fixed 60 second timeout.\n`,
    'settings.py': `TTL_SECONDS = 60\nMAX_ENTRIES = 3\n`,
    'cache.py': `from time import monotonic\nfrom settings import TTL_SECONDS, MAX_ENTRIES\n\nclass Cache:\n    def __init__(self):\n        self.items = {}\n\n    def put(self, key, value):\n        self.items[key] = (value, monotonic())\n        if len(self.items) > MAX_ENTRIES:\n            oldest = min(self.items, key=lambda item: self.items[item][1])\n            del self.items[oldest]\n\n    def get(self, key):\n        entry = self.items.get(key)\n        if entry is None:\n            return None\n        value, created = entry\n        if monotonic() - created >= TTL_SECONDS:\n            del self.items[key]\n            return None\n        return value\n`,
    'service.py': `from cache import Cache\n\n_cache = Cache()\n\ndef load(key, fetch):\n    cached = _cache.get(key)\n    if cached is not None:\n        return cached\n    value = fetch(key)\n    _cache.put(key, value)\n    return value\n` } },
  { id: 'py-retry', language: 'Python', files: {
    'README.md': `# Retry client\nNetwork retries wait a constant interval.\n`,
    'config.py': `ATTEMPTS = 4\nBASE_DELAY = 0.05\n`,
    'transport.py': `class TemporaryFailure(Exception):\n    pass\n\nclass PermanentFailure(Exception):\n    pass\n\ndef send(request):\n    if request.get("broken"):\n        raise PermanentFailure("invalid request")\n    if request.get("busy"):\n        raise TemporaryFailure("busy")\n    return {"ok": True}\n`,
    'client.py': `from time import sleep\nfrom config import ATTEMPTS, BASE_DELAY\nfrom transport import TemporaryFailure, send\n\ndef request(payload):\n    for attempt in range(ATTEMPTS):\n        try:\n            return send(payload)\n        except TemporaryFailure:\n            if attempt + 1 == ATTEMPTS:\n                raise\n            sleep(BASE_DELAY * (2 ** attempt))\n` } },
  { id: 'py-permissions', language: 'Python', files: {
    'README.md': `# Permission helper\nAdmins always inherit access to every resource.\n`,
    'policy.py': `DEFAULT_ROLE = "reader"\n`,
    'roles.py': `from policy import DEFAULT_ROLE\n\nclass Principal:\n    def __init__(self, name, role=None):\n        self.name = name\n        self.role = role or DEFAULT_ROLE\n\nclass Admin(Principal):\n    def __init__(self, name):\n        super().__init__(name, "admin")\n\nclass Resource:\n    def __init__(self, owner):\n        self.owner = owner\n`,
    'access.py': `from roles import Admin\n\ndef can_write(principal, resource):\n    if principal.name == resource.owner:\n        return True\n    return isinstance(principal, Admin)\n\ndef can_read(principal, resource):\n    return principal.name == resource.owner or principal.role in {"reader", "admin"}\n` } },
  { id: 'py-importer', language: 'Python', files: {
    'README.md': `# Import worker\nMalformed records stop the import.\n`,
    'config.py': `STRICT = True\n`,
    'parser.py': `def parse(line):\n    name, raw = line.split(":")\n    return name, int(raw)\n`,
    'worker.py': `from parser import parse\n\ndef import_lines(lines, on_error):\n    accepted = []\n    rejected = 0\n    for line in lines:\n        try:\n            name, amount = parse(line)\n        except (ValueError, TypeError) as error:\n            rejected += 1\n            on_error(line, error)\n            continue\n        accepted.append({"name": name, "amount": amount})\n    return accepted, rejected\n` } },
  { id: 'js-queue', language: 'JavaScript', files: {
    'README.md': `# Work queue\nThe queue retries every failed job three times.\n`,
    'config.js': `export const maxPending = 2\n`,
    'queue.js': `import { maxPending } from './config.js'\n\nexport class Queue {\n  constructor() { this.pending = []; this.running = false }\n  add(job) {\n    if (this.pending.length >= maxPending) return false\n    this.pending.push(job)\n    return true\n  }\n  async drain(run, onDone) {\n    if (this.running) return\n    this.running = true\n    try {\n      while (this.pending.length) {\n        const job = this.pending.shift()\n        try { onDone(job, await run(job), null) }\n        catch (error) { onDone(job, null, error) }\n      }\n    } finally { this.running = false }\n  }\n}\n`,
    'service.js': `import { Queue } from './queue.js'\nexport const queue = new Queue()\nexport const submit = (job, run, done) => {\n  if (!queue.add(job)) return Promise.resolve(false)\n  return queue.drain(run, done).then(() => true)\n}\n` } },
  { id: 'js-pricing', language: 'JavaScript', files: {
    'README.md': `# Price calculator\nAll discounts are applied before tax.\n`,
    'config.js': `export const taxRate = 0.1\nexport const memberRate = 0.2\n`,
    'discount.js': `export function discount(subtotal, member) {\n  if (!member || subtotal < 100) return 0\n  return Math.min(subtotal * 0.2, 30)\n}\n`,
    'checkout.js': `import { taxRate } from './config.js'\nimport { discount } from './discount.js'\nexport function total(subtotal, member) {\n  const afterDiscount = subtotal - discount(subtotal, member)\n  return Number((afterDiscount * (1 + taxRate)).toFixed(2))\n}\n` } },
  { id: 'js-router', language: 'JavaScript', files: {
    'README.md': `# Request router\nA missing route returns a 404 response.\n`,
    'routes.js': `export const routes = new Map([\n  ['/health', () => ({ status: 200, body: 'ok' })],\n  ['/items', () => ({ status: 200, body: 'items' })]\n])\n`,
    'router.js': `import { routes } from './routes.js'\nexport function dispatch(path, send) {\n  const handler = routes.get(path)\n  if (!handler) return send({ status: 404, body: 'missing' })\n  try { return send(handler()) }\n  catch (error) { return send({ status: 500, body: 'failed' }) }\n}\n`,
    'server.js': `import { dispatch } from './router.js'\nexport const handle = (request, send) => dispatch(request.path, send)\n` } },
  { id: 'js-config', language: 'JavaScript', files: {
    'README.md': `# Feature switch\nThe production flag defaults to false.\n`,
    'settings.json': `{"enabled":false,"rollout":25}\n`,
    'feature.js': `export function isEnabled(settings, userId) {\n  if (settings.enabled !== true) return false\n  if (settings.rollout >= 100) return true\n  if (settings.rollout <= 0) return false\n  const bucket = [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100\n  return bucket < settings.rollout\n}\n`,
    'controller.js': `import { isEnabled } from './feature.js'\nexport function response(settings, userId) {\n  return isEnabled(settings, userId) ? 'new' : 'old'\n}\n` } },
  { id: 'ts-events', language: 'TypeScript', files: {
    'README.md': `# Event dispatcher\nListener exceptions are swallowed and delivery continues.\n`,
    'types.ts': `export type Listener<T> = (event: T) => void\n`,
    'emitter.ts': `import type { Listener } from './types.js'\nexport class Emitter<T> {\n  private listeners = new Set<Listener<T>>()\n  subscribe(listener: Listener<T>): () => void {\n    this.listeners.add(listener)\n    return () => this.listeners.delete(listener)\n  }\n  emit(event: T): number {\n    let failures = 0\n    for (const listener of [...this.listeners]) {\n      try { listener(event) }\n      catch { failures += 1 }\n    }\n    return failures\n  }\n}\n`,
    'app.ts': `import { Emitter } from './emitter.js'\nexport const events = new Emitter<string>()\n` } },
  { id: 'ts-inventory', language: 'TypeScript', files: {
    'README.md': `# Inventory\nAvailable stock can never be negative.\n`,
    'config.ts': `export const warningThreshold = 5\n`,
    'base.ts': `export class StockRecord {\n  constructor(public readonly sku: string, protected quantity: number) {}\n  available(): number { return this.quantity }\n}\n`,
    'warehouse.ts': `import { StockRecord } from './base.js'\nimport { warningThreshold } from './config.js'\nexport class WarehouseStock extends StockRecord {\n  reserve(count: number): boolean {\n    if (!Number.isInteger(count) || count <= 0 || count > this.quantity) return false\n    this.quantity -= count\n    return true\n  }\n  needsRestock(): boolean { return this.quantity < warningThreshold }\n}\n` } },
  { id: 'ts-session', language: 'TypeScript', files: {
    'README.md': `# Session tokens\nExpired sessions are refreshed automatically.\n`,
    'config.ts': `export const lifetimeMs = 1000\n`,
    'session.ts': `import { lifetimeMs } from './config.js'\nexport type Session = { token: string; expiresAt: number }\nexport function valid(session: Session, now: number): boolean {\n  return Boolean(session.token) && session.expiresAt > now\n}\nexport function issue(token: string, now: number): Session {\n  return { token, expiresAt: now + lifetimeMs }\n}\n`,
    'guard.ts': `import { valid, type Session } from './session.js'\nexport function authorize(session: Session, now: number, next: () => void): boolean {\n  if (!valid(session, now)) return false\n  next()\n  return true\n}\n` } },
  { id: 'ts-parser', language: 'TypeScript', files: {
    'README.md': `# CSV parser\nRows with missing columns are rejected.\n`,
    'schema.ts': `export const columns = ['id', 'amount'] as const\n`,
    'parse.ts': `import { columns } from './schema.js'\nexport type Row = { id: string; amount: number }\nexport function parseRow(cells: string[]): Row | null {\n  if (cells.length !== columns.length) return null\n  const amount = Number(cells[1])\n  if (!Number.isFinite(amount)) return null\n  return { id: cells[0].trim(), amount }\n}\n`,
    'import.ts': `import { parseRow, type Row } from './parse.js'\nexport function importRows(lines: string[], onInvalid: (line: string) => void): Row[] {\n  const rows: Row[] = []\n  for (const line of lines) {\n    const row = parseRow(line.split(','))\n    if (row) rows.push(row)\n    else onInvalid(line)\n  }\n  return rows\n}\n` } }
]

const projectRecords = projects.map(project => {
  const files = Object.entries(project.files).map(([path, content]) => ({ path, content, sha256: sha(content) }))
  return { id: project.id, language: project.language, sourceKind: 'authored-fixture', files, contentSha256: sha(canonical({ id: project.id, language: project.language, files: files.map(({ path, sha256 }) => ({ path, sha256 })) })) }
})
const projectsById = new Map(projectRecords.map(project => [project.id, project]))
const fileText = (projectId, path) => projectsById.get(projectId).files.find(file => file.path === path).content
const ref = (projectId, path, startLine, endLine = startLine) => ({ path, startLine, endLine, sha256: sha(fileText(projectId, path).split('\n').slice(startLine - 1, endLine).join('\n')) })
const group = (id, ...refs) => ({ id, allOf: refs })

const retrievalSpecs = [
  ['py-cache','Where is cache expiration decided, and what causes an item to be evicted?','backend','medium',['Python','conditions-exceptions'], 'normal',[group('expiry',ref('py-cache','cache.py',14,22)),group('capacity',ref('py-cache','cache.py',8,12))]],
  ['py-cache','Trace a cache miss from the public load function through insertion.','backend','fine',['Python','cross-file'], 'normal',[group('miss',ref('py-cache','service.py',5,10)),group('store',ref('py-cache','cache.py',8,12))]],
  ['py-retry','How many send attempts occur and how does delay change after each temporary failure?','backend','medium',['Python','conditions-exceptions'], 'normal',[group('policy',ref('py-retry','config.py',1,2)),group('retry',ref('py-retry','client.py',5,13))]],
  ['py-retry','Which failure type is retried, and which payload condition produces a permanent failure?','backend','medium',['Python','conditions-exceptions','cross-file'], 'unavailable',[group('errors',ref('py-retry','transport.py',1,13)),group('handler',ref('py-retry','client.py',8,13))]],
  ['py-permissions','Compare the actual admin write rule with the README claim about all resources.','backend','medium',['Python','config-vs-behavior'], 'normal',[group('write',ref('py-permissions','access.py',3,6)),group('admin',ref('py-permissions','roles.py',9,11))]],
  ['py-permissions','How does Admin inherit Principal initialization and how is that inheritance used for authorization?','backend','fine',['Python','inheritance-callback','cross-file'], 'normal',[group('inherit',ref('py-permissions','roles.py',4,11)),group('check',ref('py-permissions','access.py',3,6))]],
  ['py-importer','What malformed input is caught, and does one bad line stop later lines from being processed?','backend','medium',['Python','conditions-exceptions','cross-file'], 'normal',[group('parse',ref('py-importer','parser.py',1,3)),group('loop',ref('py-importer','worker.py',4,13))]],
  ['py-importer','What does the error callback receive, and how are accepted and rejected records reported?','backend','fine',['Python','inheritance-callback'], 'unavailable',[group('callback',ref('py-importer','worker.py',2,14))]],
  ['js-queue','What happens when a job handler rejects, and does draining continue with later jobs?','backend','medium',['JavaScript','conditions-exceptions'], 'normal',[group('drain',ref('js-queue','queue.js',10,19))]],
  ['js-queue','How is queue capacity enforced and what does submit return when the queue is full?','backend','medium',['JavaScript','config-vs-behavior','cross-file'], 'normal',[group('limit',ref('js-queue','config.js',1,1)),group('add',ref('js-queue','queue.js',4,9)),group('submit',ref('js-queue','service.js',3,6))]],
  ['js-pricing','In what order are the member discount and tax applied, and what cap limits the discount?','backend','fine',['JavaScript','cross-file','conditions-exceptions'], 'normal',[group('discount',ref('js-pricing','discount.js',1,4)),group('total',ref('js-pricing','checkout.js',3,7))]],
  ['js-pricing','Does the configured memberRate control the actual discount calculation?','backend','medium',['JavaScript','config-vs-behavior'], 'unavailable',[group('config',ref('js-pricing','config.js',1,2)),group('behavior',ref('js-pricing','discount.js',1,4))]],
  ['js-router','How are unknown routes and handler exceptions translated into responses?','backend','medium',['JavaScript','conditions-exceptions'], 'normal',[group('dispatch',ref('js-router','router.js',2,8))]],
  ['js-router','Trace a request from the server adapter into the selected route callback and response sender.','backend','fine',['JavaScript','cross-file','inheritance-callback'], 'normal',[group('entry',ref('js-router','server.js',1,2)),group('route',ref('js-router','routes.js',1,4)),group('dispatch',ref('js-router','router.js',2,8))]],
  ['js-config','Which settings must be true for a user to receive the new feature, including boundary rollout cases?','general','fine',['JavaScript','conditions-exceptions','config-vs-behavior'], 'normal',[group('flag',ref('js-config','settings.json',1,1)),group('logic',ref('js-config','feature.js',1,8))]],
  ['js-config','How does controller response depend on the feature decision?','general','medium',['JavaScript','cross-file'], 'unavailable',[group('decision',ref('js-config','feature.js',1,8)),group('consumer',ref('js-config','controller.js',1,4))]],
  ['ts-events','What does emit return when listeners throw, and will the remaining listeners still run?','backend','medium',['TypeScript','conditions-exceptions'], 'normal',[group('emit',ref('ts-events','emitter.ts',8,16))]],
  ['ts-events','How does subscribe let a caller remove a listener, and what set is traversed during emit?','backend','fine',['TypeScript','inheritance-callback','cross-file'], 'normal',[group('api',ref('ts-events','emitter.ts',3,16)),group('use',ref('ts-events','app.ts',1,2))]],
  ['ts-inventory','What validation prevents an invalid reservation, and when does the restock warning activate?','backend','medium',['TypeScript','conditions-exceptions','cross-file'], 'normal',[group('base',ref('ts-inventory','base.ts',1,4)),group('behavior',ref('ts-inventory','warehouse.ts',3,10)),group('threshold',ref('ts-inventory','config.ts',1,1))]],
  ['ts-session','Does authorize refresh an expired session or reject it, and what callback behavior follows a valid session?','backend','fine',['TypeScript','inheritance-callback','conditions-exceptions'], 'unavailable',[group('validity',ref('ts-session','session.ts',3,8)),group('guard',ref('ts-session','guard.ts',2,6)),group('setting',ref('ts-session','config.ts',1,1))]],
]
const tasks = retrievalSpecs.map((s,i)=>({id:`retrieval-${String(i+1).padStart(2,'0')}`,projectId:s[0],objective:s[1],roleFocus:s[2],granularity:s[3],tags:s[5] === 'unavailable' ? [...s[4], 'index-failure'] : s[4],indexMode:s[5]}))
const retrievalLabels = retrievalSpecs.map((s,i)=>({taskId:tasks[i].id,requiredEvidenceGroups:s[6],notes:'Agent-authored label based on the complete fixture source; synthetic development data only.'}))

const generationSpecs = [
  ['py-cache','Explain the cache expiration and capacity eviction mechanisms.','backend','medium','cache lifecycle'],
  ['py-cache','Trace how a cache miss invokes fetch and stores its result.','backend','fine','cache miss flow'],
  ['py-retry','Explain retry eligibility, attempt count, and exponential delay.','backend','medium','retry policy'],
  ['py-retry','Compare permanent and temporary transport failures.','backend','medium','failure classification'],
  ['py-permissions','Explain how inheritance affects read and write access decisions.','backend','fine','authorization rules'],
  ['py-importer','Explain row parsing, error callback behavior, and continued processing.','backend','medium','import errors'],
  ['js-queue','Explain queue capacity and draining behavior when job callbacks fail.','backend','fine','async queue'],
  ['js-queue','Trace the submit return value and completion callback path.','backend','medium','submit contract'],
  ['js-pricing','Explain discount eligibility, cap, tax order, and rounding.','backend','fine','checkout calculation'],
  ['js-router','Explain route selection and response behavior for missing routes and thrown errors.','backend','medium','router behavior'],
  ['js-config','Explain the runtime feature rollout decision and its controller consumer.','general','fine','feature rollout'],
  ['js-config','Explain which settings actually affect feature eligibility.','general','medium','feature configuration'],
  ['ts-events','Explain listener registration, unsubscribe, and exception handling during emit.','backend','fine','event emitter'],
  ['ts-events','Explain the return value from event delivery and its meaning.','backend','medium','event failures'],
  ['ts-inventory','Explain the stock reservation invariant and restock threshold behavior.','backend','fine','inventory'],
  ['ts-inventory','Trace inherited stock state into reservation validation and mutation.','backend','medium','inheritance'],
  ['ts-session','Explain session validity and how authorization invokes its continuation.','security','fine','session guard'],
  ['ts-session','Explain how session expiry is computed and whether expiry triggers refresh.','security','medium','session expiry'],
]
const frozenGenerationSpecs = [...generationSpecs.slice(0,4), ...generationSpecs.slice(6,10), ...generationSpecs.slice(12,16)]
const generationTasks = frozenGenerationSpecs.map((s,i)=>({id:`generation-${String(i+1).padStart(2,'0')}`,projectId:s[0],objective:s[1],roleFocus:s[2],granularity:s[3],topic:s[4]}))
const allowedRoleFocus = new Set(['general','frontend','backend','algorithm'])
const allowedGranularity = new Set(['coarse','medium','fine'])
for (const task of [...tasks, ...generationTasks]) {
  if (!allowedRoleFocus.has(task.roleFocus)) throw new Error(`Dataset freeze check failed: invalid roleFocus ${task.roleFocus} on ${task.id}`)
  if (!allowedGranularity.has(task.granularity)) throw new Error(`Dataset freeze check failed: invalid granularity ${task.granularity} on ${task.id}`)
}
const sourceLines = {
  'py-cache': [['cache.py',8,22]], 'py-retry': [['client.py',5,13],['transport.py',7,12]], 'py-permissions': [['roles.py',9,14],['access.py',3,10]], 'py-importer': [['parser.py',1,3],['worker.py',2,14]],
  'js-queue': [['queue.js',4,19],['service.js',3,6]], 'js-pricing': [['discount.js',1,4],['checkout.js',3,7]], 'js-router': [['routes.js',1,4],['router.js',2,8]], 'js-config': [['feature.js',1,8],['controller.js',2,4]],
  'ts-events': [['emitter.ts',3,16]], 'ts-inventory': [['base.ts',1,4],['warehouse.ts',3,10]], 'ts-session': [['session.ts',3,8],['guard.ts',2,6]], 'ts-parser': [['parse.ts',1,8],['import.ts',2,10]]
}
const generationLabels = generationTasks.map(task=>{
  const evidence=sourceLines[task.projectId].map(([path,start,end])=>ref(task.projectId,path,start,end))
  return {taskId:task.id,evidence,expectedFacts:[{id:`${task.id}-fact-1`,claim:`The source evidence for ${task.topic} determines the behavior; configuration and README statements alone are not treated as runtime proof.`},{id:`${task.id}-fact-2`,claim:`Boundary conditions, returned values, callback effects, and exception handling must match the cited implementation.`}],pitfalls:['Do not infer behavior from README claims when implementation differs.','Do not claim retries, refresh, inheritance behavior, or error handling unless directly supported by the cited source.']}
})

const factual = [
  ['py-cache','Why does a cache lookup return no value for an expired entry?','Cache.get compares elapsed monotonic time with TTL_SECONDS, deletes an expired key, and returns None.','Cache.get leaves expired entries in place and returns their value.','cache.py',14,22],
  ['py-cache','What happens when insertion exceeds the configured cache capacity?','Cache.put removes the key with the smallest recorded creation time after insertion exceeds MAX_ENTRIES.','Cache.put removes the most recently inserted key whenever the cache reaches capacity.','cache.py',8,12],
  ['py-cache','What does load do after a cache miss?','load calls fetch(key), stores the returned value, then returns it.','load calls fetch only after inserting a placeholder and returns None.','service.py',5,10],
  ['py-retry','Which transport exception is retried by request?','request catches TemporaryFailure and retries until the configured final attempt.','request retries PermanentFailure and immediately returns on TemporaryFailure.','client.py',5,13],
  ['py-retry','How does retry delay change?','The sleep delay is BASE_DELAY multiplied by 2 to the zero-based attempt index.','The sleep delay is a fixed BASE_DELAY on every retry.','client.py',5,13],
  ['py-retry','What condition makes send raise PermanentFailure?','A request mapping with a truthy broken field raises PermanentFailure.','A busy field raises PermanentFailure.','transport.py',7,12],
  ['py-permissions','Can an Admin write to a resource owned by someone else?','Yes. can_write returns true for an Admin instance after the owner check fails.','No. can_write requires every principal to match the resource owner.','access.py',3,6],
  ['py-permissions','Does Admin inherit Principal?','Admin subclasses Principal and initializes the inherited fields through super().__init__.','Admin is independent of Principal and only stores a name.','roles.py',4,11],
  ['py-permissions','How does read access differ from write access?','Read allows the owner or a principal whose role is reader/admin; write allows owner or Admin instance.','Read is owner-only, while write is granted to every reader role.','access.py',3,10],
  ['py-importer','What happens after a malformed line is parsed?','import_lines increments rejected, invokes on_error with the line and exception, then continues.','A malformed line propagates the parsing exception and stops the loop.','worker.py',4,13],
  ['py-importer','What input format does parse expect?','parse splits the line on a colon and converts the second part to int.','parse splits on commas and keeps the second part as text.','parser.py',1,3],
  ['py-importer','What does import_lines return?','It returns a pair containing accepted record dictionaries and the rejected count.','It returns only the number of accepted records.','worker.py',2,14],
  ['js-queue','Does queue drain stop after a job rejects?','The catch calls onDone with the error, then the while loop continues to pending jobs.','The first rejected job exits drain and leaves all later jobs pending.','queue.js',10,19],
  ['js-queue','What is the queue capacity?','add rejects a new job when pending length is already at maxPending, configured as 2.','The queue accepts unlimited jobs because maxPending is not checked.','config.js',1,1],
  ['js-queue','What does submit return when add rejects a job?','submit returns a resolved Promise with false when queue.add returns false.','submit throws synchronously when queue.add returns false.','service.js',3,6],
  ['js-pricing','When is a member discount applied?','A member with subtotal at least 100 receives a discount capped at 30.','Every member receives a 30 discount regardless of subtotal.','discount.js',1,4],
  ['js-pricing','What is the calculation order in total?','total subtracts the discount, applies tax to the remainder, and rounds to two decimals.','total applies tax first, then subtracts the discount from the taxed amount.','checkout.js',3,7],
  ['js-pricing','Does memberRate configure the discount function?','No. discount uses a literal 0.2; memberRate is exported but not imported there.','Yes. discount imports memberRate and always uses its configured value.','config.js',1,2],
  ['js-router','How does dispatch handle an unknown path?','It sends a 404 response with body missing when no route handler exists.','It sends a 500 response for an unknown path.','router.js',2,8],
  ['js-router','What happens if a route handler throws?','dispatch catches the exception and sends a 500 response with body failed.','The exception escapes dispatch without calling send.','router.js',2,8],
  ['js-router','Which route paths are registered?','The route map contains /health and /items.','The route map contains /health and /users.','routes.js',1,4],
  ['js-config','What is required for feature rollout to be enabled?','settings.enabled must be true; partial rollout then compares a deterministic user bucket with rollout.','A positive rollout value enables the feature even when enabled is false.','feature.js',1,8],
  ['js-config','How is the user bucket computed?','The code sums userId character codes and takes the result modulo 100.','The code hashes userId with a random seed on each request.','feature.js',4,7],
  ['js-config','What response does the controller choose?','response returns new when isEnabled is true and old otherwise.','response always returns new when rollout is greater than zero.','controller.js',2,4],
  ['ts-events','What does emit return?','emit returns the number of listener callbacks that threw.','emit returns the number of listeners that completed successfully.','emitter.ts',8,16],
  ['ts-events','Does one listener failure prevent delivery to later listeners?','No. each callback has its own try/catch inside the loop over a listener snapshot.','Yes. emit rethrows the first listener exception.','emitter.ts',8,16],
  ['ts-events','What does the unsubscribe function do?','The returned closure deletes that listener from the Set.','The returned closure clears every listener in the emitter.','emitter.ts',3,7],
  ['ts-inventory','What makes reserve reject a request?','It rejects non-integers, non-positive counts, and counts greater than current quantity.','It rejects only counts greater than the warning threshold.','warehouse.ts',3,7],
  ['ts-inventory','When does needsRestock return true?','It returns true when quantity is below warningThreshold, which is 5.','It returns true when quantity is at or below zero only.','warehouse.ts',8,10],
  ['ts-inventory','How is quantity state inherited?','WarehouseStock extends StockRecord and uses the inherited protected quantity field.','WarehouseStock copies quantity into an unrelated public field.','base.ts',1,4],
  ['ts-session','Does authorize refresh an expired session?','No. invalid sessions return false before next is called; there is no refresh path.','Yes. authorize issues a replacement token before calling next.','guard.ts',2,6],
  ['ts-session','At the exact expiry timestamp, is a session valid?','No. valid requires expiresAt to be strictly greater than now.','Yes. valid accepts expiresAt equal to now.','session.ts',3,5],
  ['ts-session','How is the expiry timestamp created?','issue adds lifetimeMs to now and returns that as expiresAt.','issue sets expiresAt to the current timestamp without a lifetime.','session.ts',6,8],
  ['ts-parser','What row shape does parseRow accept?','It requires exactly two cells, converts the second to a finite number, and trims the first for id.','It accepts any number of cells and parses the first cell as the amount.','parse.ts',3,8],
  ['ts-parser','How are invalid import rows handled?','importRows calls onInvalid for rows where parseRow returns null and continues.','importRows throws on the first invalid row and never calls onInvalid.','import.ts',2,10],
  ['ts-parser','What happens when amount conversion is non-finite?','parseRow returns null when Number(cells[1]) is not finite.','parseRow substitutes zero for every invalid amount.','parse.ts',3,8]
]
for (const label of generationLabels) {
  const projectId = generationTasks.find(task => task.id === label.taskId).projectId
  const projectFacts = factual.filter(fact => fact[0] === projectId)
  label.expectedFacts = projectFacts.slice(0, 3).map((fact, index) => ({ id: `${label.taskId}-fact-${index + 1}`, claim: fact[2] }))
}
const reviewSamples = []
const reviewLabels = []
for (let i=0;i<80;i++) {
  const f=factual[i%factual.length], erroneous=i%2===1, variant=Math.floor(i/factual.length)
  const question=variant ? `${f[1]} (case ${variant+1})` : f[1]
  const answer=erroneous?f[3]:f[2]
  const followUps=[{question:'Which implementation path controls this behavior?',answer:`The branch and returned value are determined in ${f[4]} lines ${f[5]}-${f[6]}.`}]
  const evidence=[ref(f[0],f[4],f[5],f[6])]
  const fingerprint=sha(canonical({question,answer,followUps}))
  const id=`sample-${sha(`review-${i+1}`).slice(0,12)}`
  reviewSamples.push({id,projectId:f[0],question,answer,followUps,evidence,answerFingerprint:fingerprint})
  reviewLabels.push({sampleId:id,materialError:erroneous,errors:erroneous?[{claim:answer,explanation:`The cited source contradicts this claim; the supported behavior is: ${f[2]}`}]:[],facts:[f[2]]})
}
// Deterministic opaque shuffle; labels stay keyed by IDs and never leak into the public packets.
const shuffle = values => [...values].sort((a,b)=>sha(a.id).localeCompare(sha(b.id)))
const shuffledReview=shuffle(reviewSamples)
const reviewLabelById=new Map(reviewLabels.map(label=>[label.sampleId,label]))
const shuffledReviewLabels=shuffledReview.map(sample=>reviewLabelById.get(sample.id))

const repairSamples=[],repairLabels=[]
for(let i=0;i<20;i++){
  const f=factual[(i*7+3)%factual.length]
  const question=`Repair exercise ${String(i+1).padStart(2,'0')}: ${f[1]}`
  const answer=f[3]
  const followUps=[{question:'Which implementation path controls this behavior?',answer:`The branch and returned value are determined in ${f[4]} lines ${f[5]}-${f[6]}.`}]
  const evidence=[ref(f[0],f[4],f[5],f[6])]
  const fingerprint=sha(canonical({question,answer,followUps}))
  const id=`repair-${sha(`independent-repair-${i+1}`).slice(0,12)}`
  repairSamples.push({id,projectId:f[0],question,answer,followUps,evidence,answerFingerprint:fingerprint})
  repairLabels.push({sampleId:id,expectedRepairFacts:[f[2]],errorExplanation:`Replace the contradicted statement with the behavior supported by ${f[4]} lines ${f[5]}-${f[6]}.`})
}
const repairShuffled=shuffle(repairSamples),repairLabelById=new Map(repairLabels.map(label=>[label.sampleId,label]))

const outputs={
  'projects.json':{schemaVersion:1,split:'development-synthetic',projects:projectRecords},
  'retrieval-tasks.json':{schemaVersion:1,tasks},
  'retrieval-labels.json':{schemaVersion:1,labels:retrievalLabels},
  'generation-tasks.json':{schemaVersion:1,tasks:generationTasks},
  'generation-labels.json':{schemaVersion:1,labels:generationLabels},
  'review-packet.json':{schemaVersion:1,samples:shuffledReview},
  'review-key.json':{schemaVersion:1,labels:shuffledReviewLabels},
  'repair-samples.json':{schemaVersion:1,samples:repairShuffled},
  'repair-key.json':{schemaVersion:1,labels:repairShuffled.map(sample=>repairLabelById.get(sample.id))}
}
const assert = (condition, message) => { if (!condition) throw new Error(`Dataset freeze check failed: ${message}`) }
assert(projectRecords.length === 12, 'expected twelve synthetic projects')
assert(tasks.length === 20, 'expected twenty retrieval tasks')
assert(generationTasks.length === 12, 'expected twelve generation tasks')
assert(['Python','JavaScript','TypeScript'].every(language => generationTasks.filter(task => projectsById.get(task.projectId).language === language).length === 4), 'generation tasks must have four per language')
assert(shuffledReview.length === 80 && shuffledReviewLabels.filter(label => label.materialError).length === 40, 'review packet must contain forty erroneous and forty correct samples')
assert(repairShuffled.length === 20, 'expected twenty independent repair samples')
for (const tag of ['Python','JavaScript','TypeScript','cross-file','inheritance-callback','conditions-exceptions','config-vs-behavior','index-failure']) assert(tasks.filter(task => task.tags.includes(tag)).length >= 2, `retrieval coverage missing ${tag}`)
for (const project of projectRecords) {
  assert(project.sourceKind === 'authored-fixture', `invalid source kind for ${project.id}`)
  for (const file of project.files) assert(sha(file.content) === file.sha256, `file hash mismatch: ${project.id}/${file.path}`)
  const expected = sha(canonical({ id: project.id, language: project.language, files: project.files.map(({ path, sha256 }) => ({ path, sha256 })) }))
  assert(expected === project.contentSha256, `project hash mismatch: ${project.id}`)
}
for (const label of [...retrievalLabels, ...generationLabels]) {
  const evidence = label.requiredEvidenceGroups ? label.requiredEvidenceGroups.flatMap(evidenceGroup => evidenceGroup.allOf) : label.evidence
  for (const range of evidence) {
    const source = fileText(label.taskId.startsWith('retrieval-') ? tasks.find(task => task.id === label.taskId).projectId : generationTasks.find(task => task.id === label.taskId).projectId, range.path)
    const lines = source.split('\n')
    assert(Number.isInteger(range.startLine) && range.startLine > 0 && range.endLine >= range.startLine && range.endLine <= lines.length, `out-of-bounds range: ${label.taskId}/${range.path}`)
    assert(sha(lines.slice(range.startLine - 1, range.endLine).join('\n')) === range.sha256, `range hash mismatch: ${label.taskId}/${range.path}:${range.startLine}-${range.endLine}`)
  }
}
const repairIds = new Set(repairShuffled.map(sample => sample.id)), reviewIds = new Set(shuffledReview.map(sample => sample.id))
const reviewFingerprints = new Set(shuffledReview.map(sample => sample.answerFingerprint))
assert(repairShuffled.every(sample => !reviewIds.has(sample.id) && !reviewFingerprints.has(sample.answerFingerprint)), 'repair samples must be independent of review packet IDs and fingerprints')
assert(new Set(shuffledReview.map(sample => sample.id)).size === 80 && new Set(repairShuffled.map(sample => sample.id)).size === 20, 'sample identifiers must be unique')
assert(new Set(shuffledReview.map(sample => sample.answerFingerprint)).size === 80 && new Set(repairShuffled.map(sample => sample.answerFingerprint)).size === 20, 'answer fingerprints must be unique within each packet')
for (const sample of [...shuffledReview, ...repairShuffled]) assert(sample.answerFingerprint === sha(canonical({ question: sample.question, answer: sample.answer, followUps: sample.followUps })), `answer fingerprint mismatch: ${sample.id}`)
const publicReview = JSON.stringify(outputs['review-packet.json'])
assert(!/materialError|expectedRepairFacts|errorExplanation/i.test(publicReview), 'review packet leaked a label or quality hint')
await mkdir(root,{recursive:true})
for(const [name,data] of Object.entries(outputs)){
  const target=resolve(root,name)
  await mkdir(dirname(target),{recursive:true})
  await writeFile(target,`${JSON.stringify(data,null,2)}\n`,'utf8')
}
console.log(JSON.stringify({root,projects:projectRecords.length,retrievalTasks:tasks.length,generationTasks:generationTasks.length,generationLanguages:{Python:4,JavaScript:4,TypeScript:4},reviewSamples:shuffledReview.length,reviewErrors:shuffledReviewLabels.filter(label=>label.materialError).length,repairSamples:repairShuffled.length,hashesAndRanges:'valid',provenance:'agent-authored; synthetic development data; no human labels; no external model calls'}))
