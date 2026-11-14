// Executes the complete production entry with isolated native/Electron boundaries.
// No Electron/native process, provider, profile or key is used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const base = path.dirname(fileURLToPath(import.meta.url)), require2 = createRequire(import.meta.url);
const source = fs.readFileSync(path.join(base, "run-semantic-profile-entry.cjs"), "utf8");
const io = require2("./m09-semantic-io.cjs");
const legacyGuard = "if (require.main === module) { native.bootstrapNativeSemanticContext(args(process.argv.slice(2)), __filename) }";
const legacyFixture = "const native = require('./m09-semantic-native.cjs'); const io = require('./m09-semantic-io.cjs'); function args(argv) { io.check(argv.length === 2 && argv[0] === '--runtime-root', 'semantic-native-arguments-invalid'); return io.absolute(argv[1]) }\n" + legacyGuard + "\nmodule.exports = { args }";
const filename = path.resolve("synthetic-owned", "entry.cjs");
const runtime = path.resolve("synthetic-owned", "runtime");
function run(options = {}, text = source) {
  const events = [], reports = [], exits = [];
  let bootstrapCalls = 0, prepareCalls = 0, electronImports = 0, inputCreates = 0, acceptCalls = 0;
  const input = options.input ?? new PassThrough({ autoDestroy: false }), parsedGrants = [], parserInputs = [];
  let destroys = 0;
  const originalDestroy = input.destroy;
  input.destroy = function (...values) { destroys++; events.push("input-destroy"); return Reflect.apply(originalDestroy, this, values); };
  const token = Object.freeze({ kind: "synthetic-no-native-authority" }), module = { exports: {} };
  const proc = { platform: "win32", type: "browser", versions: { electron: "42.11.10" }, env: {}, stdout: { write() {
    if (options.readyReportError && reports.at(-1)?.type === "semantic-ready") throw Error("synthetic-report-error");
  } }, argv: ["electron.exe", filename, "--runtime-root", runtime], ...options.process };
  Object.defineProperty(proc, "stdin", { get() { throw Error("process-stdin-must-not-be-read"); } });
  function fakeRequire(name) {
    if (name === "node:fs") return { createReadStream(file, settings) {
      inputCreates++; events.push("create-input");
      assert.equal(file, null); assert.equal(settings.fd, 0); assert.equal(settings.autoClose, false);
      assert.deepEqual(Object.keys(settings).sort(), ["autoClose", "fd"]);
      if (options.inputCreateError) throw Error("synthetic-create-error");
      return input;
    } };
    if (name === "node:path") return path;
    if (name === "node:worker_threads") return { isMainThread: options.isMainThread ?? true };
    if (name === "./m09-semantic-io.cjs") return { ...io, oneMessage(stream, settings) {
      events.push("one-message"); parserInputs.push(stream);
      assert.equal(settings.timeoutMs, 60000);
      assert.deepEqual(Object.keys(settings), ["timeoutMs"]);
      return io.oneMessage(stream, settings).then(value => { parsedGrants.push(value); return value; });
    }, bytes(value) {
      reports.push(value);
      return io.bytes(value);
    } };
    if (name === "./m09-semantic-native.cjs") return { bootstrapNativeSemanticContext(root, file) {
      bootstrapCalls++;
      events.push("bootstrap");
      assert.equal(root, runtime);
      assert.equal(file, filename);
      if (options.bootstrapError) throw Object.assign(Error("synthetic"), { code: "semantic-native-before-ready-required" });
      return token;
    }, prepareNativeSemanticContext(value) {
      assert.equal(value, token);
      prepareCalls++;
      events.push("prepare-first-await");
      if (options.prepareError) return Promise.reject(Object.assign(Error("synthetic"), { code: "semantic-native-prepare-failed" }));
      if (options.preparePromise) return options.preparePromise;
      if (options.prepareReady) return Promise.resolve({ type: "semantic-ready", synthetic: true });
      return new Promise(() => {});
    }, acceptNativeSemanticGrant(value, grant) {
      assert.equal(value, token);
      acceptCalls++;
      events.push("accept-grant");
      if (options.acceptError) throw Object.assign(Error("synthetic"), { code: "semantic-native-grant-invalid" });
      assert.equal(io.canonical(grant), io.canonical(grantFixture));
    } };
    if (name === "electron") {
      electronImports++;
      events.push("electron-import");
      return { app: { exit: (code) => exits.push(code) } };
    }
    throw Error("unexpected require " + name);
  }
  if (options.main === "self") fakeRequire.main = module;
  else if (options.main === "other") fakeRequire.main = { exports: {} };
  vm.runInNewContext(text, { module, exports: module.exports, __filename: filename, process: proc, Buffer, require: fakeRequire }, { timeout: 1e3, importModuleDynamically() {
    throw Error("no-store-or-provider-import-allowed");
  } });
  return { module, events, reports, exits, bootstrapCalls, prepareCalls, electronImports, proc, input, parsedGrants, parserInputs,
    get inputCreates() { return inputCreates; }, get acceptCalls() { return acceptCalls; }, get destroys() { return destroys; } };
}
for (const main of [void 0, "other"]) test("former main guard skips dynamic-import shape with require.main " + String(main), () => {
  const f = run({ main }, legacyFixture);
  assert.equal(f.bootstrapCalls, 0);
  assert.equal(f.prepareCalls, 0);
  assert.equal(typeof f.module.exports.args, "function");
});
for (const main of [void 0, "other", "self"]) test("production entry starts once with exact main argv and require.main " + String(main), () => {
  const f = run({ main });
  assert.equal(f.bootstrapCalls, 1);
  assert.equal(f.prepareCalls, 1);
  assert.deepEqual(f.events, ["bootstrap", "electron-import", "prepare-first-await"]);
  assert.equal(f.reports.length, 0);
  assert.deepEqual(f.exits, []);
});
for (const [name, processChange, more] of [
  ["ordinary Node imported helper", { type: void 0, versions: {} }, {}],
  ["Electron sidecar different entry", { argv: ["electron.exe", path.join(path.dirname(filename), "sidecar.cjs"), "--runtime-root", runtime] }, {}],
  ["renderer exact argv", { type: "renderer" }, {}],
  ["worker exact argv", {}, { isMainThread: false }],
  ["non-Windows browser", { platform: "linux" }, {}],
  ["run-as-node even empty marker", { env: { ELECTRON_RUN_AS_NODE: "" } }, {}],
  ["Electron version absent", { versions: {} }, {}],
  ["Electron version nonstring", { versions: { electron: 42 } }, {}],
  ["relative argv filename", { argv: ["electron.exe", "entry.cjs", "--runtime-root", runtime] }, {}],
  ["file URL argv filename", { argv: ["electron.exe", pathToFileURL(filename).href, "--runtime-root", runtime] }, {}],
  ["same basename other directory", { argv: ["electron.exe", path.resolve("other", "entry.cjs"), "--runtime-root", runtime] }, {}],
  ["path suffix lookalike", { argv: ["electron.exe", filename + ".bak", "--runtime-root", runtime] }, {}],
  ["undefined argv", { argv: void 0 }, {}],
  ["empty argv", { argv: [] }, {}],
  ["nonstring argv filename", { argv: ["electron.exe", 42] }, {}]
]) for (const main of [void 0, "other"]) test("import stays inert: " + name + " / " + String(main), () => {
  const f = run({ main, process: processChange, ...more });
  assert.equal(f.bootstrapCalls, 0);
  assert.equal(f.prepareCalls, 0);
  assert.equal(f.electronImports, 0);
  assert.equal(f.reports.length, 0);
  assert.equal(typeof f.module.exports.args, "function");
});
for (const [name, argv] of [
  ["missing runtime option", ["electron.exe", filename]],
  ["wrong runtime option", ["electron.exe", filename, "--runtime", runtime]],
  ["extra argument", ["electron.exe", filename, "--runtime-root", runtime, "extra"]],
  ["relative runtime", ["electron.exe", filename, "--runtime-root", "relative"]]
]) test("matched Electron entry rejects " + name + " before bootstrap", () => {
  const f = run({ process: { argv } });
  assert.equal(f.bootstrapCalls, 0);
  assert.equal(f.prepareCalls, 0);
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].type, "semantic-error");
  assert.deepEqual(f.exits, [1]);
});
test("ordinary Node CJS direct-main route remains and native bootstrap owns refusal", () => {
  const f = run({ main: "self", process: { type: void 0, versions: {} }, bootstrapError: true });
  assert.equal(f.bootstrapCalls, 1);
  assert.equal(f.prepareCalls, 0);
  assert.equal(f.reports[0].code, "semantic-native-before-ready-required");
  assert.deepEqual(f.exits, [1]);
});
test("native bootstrap refusal stops synchronously before prepare/store/ready", () => {
  const f = run({ bootstrapError: true });
  assert.equal(f.bootstrapCalls, 1);
  assert.equal(f.prepareCalls, 0);
  assert.deepEqual(f.events, ["bootstrap", "electron-import"]);
  assert.equal(f.reports[0].code, "semantic-native-before-ready-required");
  assert.deepEqual(f.exits, [1]);
});
test("args export remains safe for helper callers without starting native", () => {
  const f = run({ main: "other", process: { type: void 0, versions: {}, argv: ["node", path.join(path.dirname(filename), "helper.cjs")] } });
  assert.equal(f.module.exports.args(["--runtime-root", runtime]), runtime);
  assert.throws(() => f.module.exports.args(["--wrong", runtime]));
  assert.equal(f.bootstrapCalls, 0);
  assert.equal(f.electronImports, 0);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const grantFixture = { type: "synthetic-grant", schemaVersion: 1 };
test("input remains absent until successful prepare, then exact fd0 receiver precedes ready", async () => {
  let release;
  const f = run({ preparePromise: new Promise(resolve => { release = resolve; }) });
  assert.equal(f.inputCreates, 0); assert.equal(f.reports.length, 0);
  release({ type: "semantic-ready", synthetic: true }); await turn();
  assert.equal(f.inputCreates, 1); assert.equal(f.parserInputs[0], f.input);
  assert.deepEqual(f.events, ["bootstrap", "electron-import", "prepare-first-await", "create-input", "one-message"]);
  assert.equal(f.reports[0].type, "semantic-ready");
  f.input.end(io.bytes(grantFixture)); await turn();
  assert.equal(f.acceptCalls, 1); assert.equal(f.destroys, 1);
  assert.ok(f.events.indexOf("input-destroy") < f.events.indexOf("accept-grant"));
});
test("prepare failure never creates fd0 input or publishes ready", async () => {
  const f = run({ prepareError: true }); await turn();
  assert.equal(f.inputCreates, 0); assert.equal(f.acceptCalls, 0);
  assert.equal(f.reports[0].code, "semantic-native-prepare-failed"); assert.deepEqual(f.exits, [1]);
});
test("fd0 creation failure publishes only a safe failure", async () => {
  const f = run({ prepareReady: true, inputCreateError: true }); await turn();
  assert.equal(f.inputCreates, 1); assert.equal(f.acceptCalls, 0);
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].code, "semantic-native-execution-failed"); assert.deepEqual(f.exits, [1]);
});
test("strict parser waits for EOF and releases input before grant authority check", async () => {
  const f = run({ prepareReady: true }); await turn();
  f.input.write(io.bytes(grantFixture)); await turn();
  assert.equal(f.acceptCalls, 0); assert.equal(f.destroys, 0);
  f.input.end(); await turn();
  assert.equal(f.acceptCalls, 1); assert.deepEqual(f.parsedGrants, [grantFixture]); assert.equal(f.destroys, 1);
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.reports[1].code, "semantic-native-execution-failed");
  assert.doesNotThrow(() => f.input.emit("error", Error("late-private-error")));
});
for (const [name, raw] of [
  ["empty EOF", Buffer.alloc(0)],
  ["CRLF", Buffer.from(JSON.stringify(grantFixture) + "\r\n")],
  ["extra line", Buffer.concat([io.bytes(grantFixture), io.bytes(grantFixture)])],
  ["blank extra line", Buffer.concat([io.bytes(grantFixture), Buffer.from("\n")])],
  ["noncanonical JSON", Buffer.from('{"z":1,"a":2}\n')],
  ["invalid UTF8", Buffer.from([0xff, 10])],
  ["missing LF", io.bytes(grantFixture).subarray(0, -1)],
  ["over original 2MiB limit", Buffer.alloc(io.MAX_CONTROL_BYTES + 1, 120)]
]) test("explicit fd0 input preserves production rejection: " + name, async () => {
  const f = run({ prepareReady: true }); await turn(); f.input.end(raw); await turn();
  assert.equal(f.acceptCalls, 0); assert.equal(f.destroys, 1);
  assert.equal(f.reports[1].code, "semantic-native-handshake-invalid"); assert.deepEqual(f.exits, [1]);
  assert.doesNotThrow(() => f.input.emit("error", Error("late-private-error")));
});
test("pending input read error remains a handshake failure and late errors stay handled", async () => {
  const f = run({ prepareReady: true }); await turn(); f.input.emit("error", Object.assign(Error("private-os-text"), { code: "EIO" })); await turn();
  assert.equal(f.acceptCalls, 0); assert.equal(f.destroys, 1); assert.equal(f.reports[1].code, "semantic-native-handshake-invalid");
  assert.deepEqual(f.exits, [1]); assert.doesNotThrow(() => f.input.emit("error", Error("late-private-text")));
});
test("input close before EOF stays a child-closed failure", async () => {
  const f = run({ prepareReady: true }); await turn(); f.input.destroy(); await turn();
  assert.equal(f.acceptCalls, 0); assert.equal(f.reports[1].code, "semantic-native-child-closed"); assert.deepEqual(f.exits, [1]);
});
test("ready publication failure destroys pending receiver without unhandled rejection", async () => {
  const f = run({ prepareReady: true, readyReportError: true }); await turn(); await turn();
  assert.equal(f.acceptCalls, 0); assert.equal(f.destroys, 1); assert.equal(f.reports[1].code, "semantic-native-execution-failed"); assert.deepEqual(f.exits, [1]);
  assert.doesNotThrow(() => f.input.emit("error", Error("late-private-text")));
});
test("input replacement confers no grant authority", async () => {
  const f = run({ prepareReady: true, acceptError: true }); await turn(); f.input.end(io.bytes(grantFixture)); await turn();
  assert.equal(f.acceptCalls, 1); assert.equal(f.destroys, 1); assert.equal(f.reports[1].code, "semantic-native-grant-invalid"); assert.deepEqual(f.exits, [1]);
});
