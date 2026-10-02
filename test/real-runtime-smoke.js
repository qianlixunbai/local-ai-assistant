/* Explicit opt-in integration check, separate from npm test.
 * Own Runtime process/private native bootstrap only. No existing native credentials are read.
 * Synthetic browser HTTP verifies Runtime compatibility, never Chrome acceptance.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const assert = require("assert");
const { makeBackground } = require("./runtime-harness");
const ROOT = path.resolve(__dirname, "..");
const RUN = path.join(ROOT, ".verification", "m2b2b-smoke");
const BASE = "http://127.0.0.1:8765";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await predicate()) return; } catch (_) {} await wait(200); }
  throw new Error("Integration wait deadline exceeded");
}
class NativeSmokeRuntime {
  constructor(java, jar) { this.java = java; this.jar = jar; this.process = null; this.token = null; this.restarts = 0; }
  async start(providerUrl) {
    fs.mkdirSync(RUN, { recursive: true });
    // Refuse a listener owned by someone else; do not stop an existing Runtime.
    try { await fetch(BASE + "/actuator/health", { signal: AbortSignal.timeout(500) }); throw new Error("Runtime port occupied"); }
    catch (e) { if (e.message === "Runtime port occupied") throw e; }
    const nativeFile = path.join(RUN, "private-native-authority", "bootstrap");
    const log = fs.openSync(path.join(RUN, "runtime-" + this.restarts++ + ".log"), "a");
    this.process = spawn(this.java, ["-jar", this.jar, "--workspace.security.token-file=" + nativeFile,
      ...(providerUrl ? ["--workspace.ollama.base-url=" + providerUrl] : [])], { cwd: RUN, windowsHide: true, stdio: ["ignore", log, log] });
    fs.closeSync(log);
    await until(async () => {
      if (this.process.exitCode !== null) throw new Error("Own Runtime exited");
      const r = await fetch(BASE + "/actuator/health/readiness", { signal: AbortSignal.timeout(1000) });
      return r.ok && (await r.json()).status === "UP";
    });
    this.token = fs.readFileSync(nativeFile, "utf8").trim();
  }
  async stop() {
    if (!this.process) return;
    const process = this.process; this.process = null;
    process.kill();
    await until(() => process.exitCode !== null || process.signalCode !== null, 8000);
  }
  async native(method, route, body) {
    const response = await fetch(BASE + route, { method, headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Native smoke request failed");
    return response.status === 204 ? null : response.json();
  }
  pair(origin) { return this.native("POST", "/api/v1/security/pairings", { origin, displayName: "M2B2B Verification", userApproved: true }); }
}
async function syntheticSmoke(runtime) {
  const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  let issued;
  const headers = { Origin: origin, "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", "Content-Type": "application/json" };
  try {
    const proof = await runtime.pair(origin);
    const exchange = await fetch(BASE + "/api/v1/security/pairings/exchange", { method: "POST", headers, body: JSON.stringify(proof, ["pairingId", "pairingSecret"]) });
    assert.strictEqual(exchange.status, 200); issued = await exchange.json();
    const authorized = { ...headers, Authorization: "Bearer " + issued.credential };
    const readiness = await fetch(BASE + "/api/v1/capabilities/translate/readiness", { headers: authorized });
    assert.strictEqual(readiness.status, 200); assert((await readiness.json()).available);
    // Exercise the actual production worker/client with mock storage and synthetic dev-client headers.
    let taskId;
    const worker = makeBackground({
      store: { runtimePairing: { credential: issued.credential, clientId: issued.client.clientId, origin } },
      config: { runtimeRequestTimeoutMs: 8000, runtimeTaskDeadlineMs: 190000, runtimePollIntervalMs: 250 },
      fetch: async (url, init) => {
        const response = await fetch(url, { ...init, headers: { ...init.headers, ...headers } });
        if (response.status === 202) taskId = response.headers.get("Location")?.split("/").at(-1);
        return response;
      }
    });
    assert((await worker.checkConnection()).available);
    const translated = await worker.translateBatch([{ id: 1, text: "Hello world." }, { id: 2, text: "The library opens every morning." }]);
    assert(translated.ok); assert.strictEqual(translated.results.length, 2);
    assert(translated.results.every(item => /[\u3400-\u9fff]/.test(item.translation)));
    assert.strictEqual(worker.calls.filter(call => call.init.method === "POST").length, 1);
    const evidence = { result: "REAL RUNTIME PASS / SYNTHETIC CLIENT", taskId, status: "SUCCEEDED", itemCount: translated.results.length,
      productionClientValidated: true, profile: translated.identity.profile, promptVersion: translated.identity.promptVersion, timestampUtc: new Date().toISOString() };
    fs.writeFileSync(path.join(RUN, "runtime-smoke-evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally { if (issued) await runtime.native("DELETE", "/api/v1/security/clients/" + issued.client.clientId).catch(() => {}); }
}
// A verification-only relay supports equivalent provider outages and one 35s real-generation task.
function providerRelay(port = 18834) {
  let server = null, delayNext = 0, generations = 0;
  return {
    get generations() { return generations; },
    delayNext(ms) { delayNext = ms; },
    async start() {
      server = http.createServer(async (request, response) => {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const delay = request.url === "/api/chat" ? delayNext : 0;
        if (request.url === "/api/chat") { generations++; delayNext = 0; }
        if (delay) await wait(delay);
        try {
          const r = await fetch("http://127.0.0.1:11434" + request.url, { method: request.method, headers: { "Content-Type": "application/json" }, ...(body.length ? { body } : {}) });
          response.writeHead(r.status, { "Content-Type": "application/json" }); response.end(Buffer.from(await r.arrayBuffer()));
        } catch (_) { response.writeHead(503, { "Content-Type": "application/json" }); response.end('{"error":"verification provider unavailable"}'); }
      });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    },
    async stop() { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; } },
    url: "http://127.0.0.1:" + port
  };
}
module.exports = { NativeSmokeRuntime, syntheticSmoke, providerRelay, until, wait, ROOT, RUN, BASE };
if (require.main === module) {
  const runtime = new NativeSmokeRuntime(process.argv[2], path.resolve(process.argv[3]));
  (async () => { try { await runtime.start(); await syntheticSmoke(runtime); } finally { await runtime.stop(); } })()
    .catch(() => { console.error("Real Runtime smoke failed (private response details suppressed)"); process.exitCode = 1; });
}
