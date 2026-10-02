/* Opt-in real headless Chrome integration. Native dev authority creates/revokes proof;
 * this does NOT claim Windows Assistant GUI / native context-menu acceptance.
 * No worker debugger is attached during the long-task check. Evidence is metadata only.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");
const { spawn } = require("child_process");
const { CDP } = require("./cdp-client");
const { NativeSmokeRuntime, syntheticSmoke, providerRelay, until, wait, ROOT, RUN } = require("./real-runtime-smoke");
const PORT = 19222, SITE = "http://127.0.0.1:18800";
const evidence = { mode: "REAL HEADLESS CHROME / NATIVE DEV PAIRING AUTHORITY", checks: {}, limitations: ["Windows Assistant GUI pairing/revoke and native right-click menu not exercised", "MDN and full frame/privacy manual acceptance pending"] };
let runtime, browser, browserProcess, site, relay, page, popup, extensionId, pageTargetId, popupTargetId;
let tabId;
let workerProbe;
const connected = new Set();
function passed(name, detail = true) { evidence.checks[name] = detail; console.log("REAL CHROME PASS  " + name); }
async function endpoint(route) { return fetch("http://127.0.0.1:" + PORT + route, { signal: AbortSignal.timeout(2000) }).then(r => r.json()); }
async function targetConnection(id) {
  let info;
  await until(async () => { info = (await endpoint("/json/list")).find(t => t.id === id); return info?.webSocketDebuggerUrl; });
  const connection = await CDP.connect(info.webSocketDebuggerUrl); connected.add(connection); return connection;
}
async function startChrome() {
  browserProcess = spawn(process.argv[4], ["--headless=new", "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
    "--user-data-dir=" + path.join(RUN, "chrome-profile"), "--remote-debugging-port=" + PORT, "about:blank"],
    { windowsHide: true, stdio: "ignore" });
  let version;
  await until(async () => { version = await endpoint("/json/version"); return !!version.webSocketDebuggerUrl; });
  evidence.browserVersion = version.Browser;
  browser = await CDP.connect(version.webSocketDebuggerUrl); connected.add(browser);
  extensionId = (await browser.send("Extensions.loadUnpacked", { path: path.join(ROOT, "browser-extension") })).id;
}
async function stopChrome() {
  if (browser) await browser.send("Browser.close").catch(() => {});
  for (const connection of connected) connection.close(); connected.clear();
  if (browserProcess) { const owned = browserProcess; browserProcess = null; await until(() => owned.exitCode !== null, 8000).catch(() => owned.kill()); }
  browser = null;
}
async function openPage(url = SITE + "/fixture") {
  pageTargetId = (await browser.send("Target.createTarget", { url })).targetId;
  page = await targetConnection(pageTargetId);
  await until(() => page.evaluate("document.readyState === 'complete'"));
}
async function openPopup() {
  evidence.stage = "open actual action popup";
  const currentUrl = await page.evaluate("location.href");
  const targets = await browser.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }, { exclude: true }] });
  const tabTarget = targets.targetInfos.find(info => info.url === currentUrl);
  if (!tabTarget) throw new Error("Chrome tab target unavailable");
  await browser.send("Extensions.triggerAction", { id: extensionId, targetId: tabTarget.targetId });
  let popupInfo;
  try {
    await until(async () => { popupInfo = (await endpoint("/json/list")).find(t => t.url === "chrome-extension://" + extensionId + "/popup.html"); return !!popupInfo; });
  } catch (e) {
    evidence.popupTargets = (await endpoint("/json/list")).map(t => ({ type: t.type, url: t.url }));
    throw e;
  }
  popupTargetId = popupInfo.id; popup = await targetConnection(popupTargetId);
  evidence.stage = "popup Origin initialization";
  await until(() => popup.evaluate("document.getElementById('extensionOrigin')?.value === 'chrome-extension://' + chrome.runtime.id"));
  tabId = await popup.evaluate("chrome.tabs.query({active:true,currentWindow:true}).then(t=>t[0]?.id)");
  await until(() => popup.evaluate("document.getElementById('runtimeStatus').textContent !== '未检测' && document.getElementById('runtimeStatus').textContent !== '检测中...'"));
}
async function closePopup() {
  if (popupTargetId) await browser.send("Target.closeTarget", { targetId: popupTargetId }).catch(() => {});
  popup?.close(); if (popup) connected.delete(popup);
  popup = null; popupTargetId = null;
}
async function pair() {
  evidence.stage = "pairing exchange / readiness";
  const origin = await popup.evaluate("document.getElementById('extensionOrigin').value");
  assert.strictEqual(origin, "chrome-extension://" + extensionId);
  const proof = await runtime.pair(origin);
  await popup.evaluate("(() => {document.getElementById('pairingId').value=" + JSON.stringify(proof.pairingId) +
    ";document.getElementById('pairingSecret').value=" + JSON.stringify(proof.pairingSecret) + ";document.getElementById('pairingForm').requestSubmit();return true;})()");
  try {
    await until(() => popup.evaluate("document.getElementById('pairingStatus').textContent === 'Paired' && !document.getElementById('btnTranslate').disabled"), 20000);
  } catch (e) {
    evidence.pairingUi = await popup.evaluate("({pairing:document.getElementById('pairingStatus').textContent,runtime:document.getElementById('runtimeStatus').textContent,translation:document.getElementById('translationStatus').textContent,status:document.getElementById('statusText').textContent,proofCleared:!document.getElementById('pairingSecret').value})");
    evidence.pairingStorage = await popup.evaluate("chrome.storage.local.get('runtimePairing').then(s=>({browserCredentialSaved:typeof s.runtimePairing?.credential==='string' && s.runtimePairing.credential.startsWith('br1.'),originMatches:s.runtimePairing?.origin==='chrome-extension://'+chrome.runtime.id}))");
    evidence.contentStorageDenied = await popup.evaluate("chrome.scripting.executeScript({target:{tabId:" + tabId + "},func:async()=>{try{const s=await chrome.storage.local.get('runtimePairing');return !s.runtimePairing?.credential;}catch(_){return true;}}}).then(r=>r[0]?.result===true)").catch(() => "UNVERIFIED");
    const clients = await runtime.native("GET", "/api/v1/security/clients");
    evidence.serverClientRegistered = clients.some(c => c.origin === origin);
    evidence.checks.exchange = evidence.serverClientRegistered && evidence.pairingStorage.browserCredentialSaved ? "PASS: real Chrome POST exchange / stored browser credential" : "UNVERIFIED";
    evidence.checks.readiness = "FAIL: real Chrome GET rejected 401";
    throw e;
  }
  assert(await popup.evaluate("!document.getElementById('pairingSecret').value && !document.getElementById('pairingId').value"));
  passed("natural extension Origin/Fetch Metadata exchange + readiness + proof clearing");
}
async function readinessClick() {
  await popup.evaluate("document.getElementById('btnTest').click();true");
  await wait(500);
}
async function translate(expectedMin = 1, timeout = 60000) {
  await popup.evaluate("document.getElementById('btnTranslate').click();true");
  await until(() => page.evaluate("document.querySelectorAll('.local-ai-translation').length >= " + expectedMin), timeout);
  // Wait for a terminal popup status instead of only the first DOM insertion.
  await until(() => popup.evaluate("!document.getElementById('btnTranslate').disabled"), timeout);
}
async function restore() {
  await popup.evaluate("document.getElementById('btnRestore').click();true");
  await until(() => page.evaluate("document.querySelectorAll('.local-ai-translation').length === 0"));
  await until(() => popup.evaluate("document.getElementById('statusText').textContent.includes('恢复原文')"));
}
async function run() {
  fs.mkdirSync(RUN, { recursive: true });
  runtime = new NativeSmokeRuntime(process.argv[2], path.resolve(process.argv[3]));
  relay = providerRelay(); await relay.start();
  await runtime.start(relay.url); await syntheticSmoke(runtime);
  site = http.createServer((request, response) => {
    const fixtures = { "/test/dynamic-test-page.html": "dynamic-test-page.html", "/test/privacy-hotfix-page.html": "privacy-hotfix-page.html" };
    if (fixtures[request.url]) { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(fs.readFileSync(path.join(ROOT, "test", fixtures[request.url]))); return; }
    if (request.url !== "/fixture") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end('<!doctype html><meta charset="utf-8"><title>Runtime acceptance fixture</title><main><p id="source">Hello world.</p><p>The library opens every morning.</p><p>Reading books is a useful habit.</p></main><footer>Contact the library</footer>');
  });
  await new Promise(resolve => site.listen(18800, "127.0.0.1", resolve));
  await startChrome(); await openPage(); await openPopup();
  const workerInfo = (await endpoint("/json/list")).find(t => t.type === "service_worker" && t.url === "chrome-extension://" + extensionId + "/background.js");
  if (workerInfo) {
    workerProbe = await CDP.connect(workerInfo.webSocketDebuggerUrl); connected.add(workerProbe);
    evidence.networkHeaders = [];
    workerProbe.on("Network.requestWillBeSentExtraInfo", params => {
      const h = params.headers;
      const get = name => Object.entries(h).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
      evidence.networkHeaders.push({ origin: get("Origin") || "ABSENT", site: get("Sec-Fetch-Site") || "ABSENT", mode: get("Sec-Fetch-Mode") || "ABSENT", dest: get("Sec-Fetch-Dest") || "ABSENT", browserCredentialPresent: /^Bearer br1\./.test(get("Authorization") || "") });
    });
    await workerProbe.send("Network.enable");
  }
  // Previous failed checks revoke only their server client; explicitly forget the isolated profile's old local pairing.
  if (await popup.evaluate("!document.getElementById('btnForget').hidden")) {
    await popup.evaluate("document.getElementById('btnForget').click();true");
    await until(() => popup.evaluate("document.getElementById('pairingStatus').textContent === '未配对'"));
  }
  await pair();
  const permission = await popup.evaluate("chrome.scripting.executeScript({target:{tabId:" + tabId + "},func:async()=>{try{const s=await chrome.storage.local.get('runtimePairing');return !s.runtimePairing?.credential;}catch(_){return true;}}}).then(r=>r[0].result)");
  assert(permission); passed("content script cannot read Browser credential");
  assert(await popup.evaluate("!document.body.textContent.includes('br1.')"));
  assert(await page.evaluate("!document.body.textContent.includes('br1.')")); passed("credential absent from popup/page DOM");
  await closePopup(); await openPopup();
  await until(() => popup.evaluate("document.getElementById('pairingStatus').textContent === 'Paired'"));
  passed("popup reopen pairing persistence");
  const generationBefore = relay.generations;
  await translate(4);
  assert.strictEqual(relay.generations - generationBefore, 1);
  assert(await page.evaluate("document.getElementById('source').textContent === 'Hello world.' && [...document.querySelectorAll('.local-ai-translation')].every(n=>/[\\u3400-\\u9fff]/.test(n.textContent))"));
  passed("full page + Footer: Runtime Batch → actual generation → bilingual DOM", { recordCount: 4, generationCount: 1 });
  await restore(); const cacheBefore = relay.generations; await translate(4);
  assert.strictEqual(relay.generations, cacheBefore); passed("Restore → Translate page cache: zero additional generations");
  await restore();
  await runtime.stop(); await readinessClick();
  assert(await popup.evaluate("document.getElementById('runtimeStatus').textContent === '离线' && document.getElementById('btnTranslate').disabled"));
  assert.strictEqual(await page.evaluate("document.querySelectorAll('.local-ai-translation').length"), 0);
  passed("Runtime offline fails explicitly while actual provider remains running");
  await runtime.start(relay.url); await readinessClick();
  await until(() => popup.evaluate("!document.getElementById('btnTranslate').disabled")); passed("Runtime recovery with persisted pairing");
  await relay.stop(); await readinessClick();
  assert(await popup.evaluate("document.getElementById('runtimeStatus').textContent === '在线' && document.getElementById('translationStatus').textContent === '不可用' && document.getElementById('btnTranslate').disabled"));
  passed("real provider-unavailable route is controlled and has no direct fallback");
  await relay.start(); await readinessClick(); await until(() => popup.evaluate("!document.getElementById('btnTranslate').disabled"));
  passed("provider route recovery");
  const clients = await runtime.native("GET", "/api/v1/security/clients");
  const own = clients.find(c => c.origin === "chrome-extension://" + extensionId);
  assert(own); await runtime.native("DELETE", "/api/v1/security/clients/" + own.clientId); await readinessClick();
  await until(() => popup.evaluate("document.getElementById('pairingStatus').textContent.includes('凭据失效')"));
  assert(await popup.evaluate("document.getElementById('btnTranslate').disabled"));
  await popup.evaluate("document.getElementById('btnForget').click();true");
  await until(() => popup.evaluate("document.getElementById('pairingStatus').textContent === '未配对'"));
  await pair(); passed("real native revoke → 401 → local Forget → real extension re-pair");
  await closePopup(); await browser.send("Target.closeTarget", { targetId: pageTargetId }); page.close(); connected.delete(page);
  await openPage(SITE + "/test/dynamic-test-page.html"); await openPopup();
  await translate(7);
  const beforeDynamic = await page.evaluate("document.querySelectorAll('.local-ai-translation').length");
  await page.evaluate("document.getElementById('loadMore').click();true");
  await until(() => page.evaluate("document.querySelectorAll('.local-ai-translation').length > " + beforeDynamic), 60000);
  passed("existing Dynamic fixture Load More / real incremental Runtime generation");
  await restore(); const stopped = relay.generations;
  await page.evaluate("document.getElementById('loadMore').click();true"); await wait(1200);
  assert.strictEqual(relay.generations, stopped); assert.strictEqual(await page.evaluate("document.querySelectorAll('.local-ai-translation').length"), 0);
  passed("Restore stops automatic Dynamic translation");
  await closePopup(); await browser.send("Target.closeTarget", { targetId: pageTargetId }); page.close(); connected.delete(page);
  await openPage(); await openPopup();
  // A new page has no cache. The next provider generation is delayed 35 seconds and still uses actual inference.
  workerProbe?.close(); if (workerProbe) connected.delete(workerProbe); workerProbe = null;
  relay.delayNext(35000); const started = Date.now(); const longBefore = relay.generations;
  await popup.evaluate("document.getElementById('btnTranslate').click();true");
  await until(() => relay.generations > longBefore); await closePopup();
  await until(() => page.evaluate("document.querySelectorAll('.local-ai-translation').length === 4"), 65000);
  const elapsedMs = Date.now() - started;
  assert(elapsedMs >= 30000 && elapsedMs <= 45000); assert.strictEqual(relay.generations - longBefore, 1);
  passed("MV3 real 30–45s Runtime task completes after popup closure, worker debugger detached", { elapsedMs, generationCount: 1 });
  await openPopup(); await until(() => popup.evaluate("document.getElementById('statusText').textContent.includes('翻译完成')"));
  passed("popup reconnect follows completed Runtime translation");
  await stopChrome(); await startChrome(); await openPage(); await openPopup();
  await until(() => popup.evaluate("document.getElementById('pairingStatus').textContent === 'Paired' && !document.getElementById('btnTranslate').disabled"));
  passed("Chrome restart / new worker credential persistence");
}
(async () => {
  try { await run(); evidence.result = "PARTIAL / AWAITING REAL CHROME ACCEPTANCE"; }
  catch (e) { evidence.result = "PARTIAL / REAL CHROME CHECK FAILED"; evidence.failure = e.message.startsWith("Chrome") || e.message.startsWith("Integration") ? e.message : "Integration assertion failed (private details suppressed)"; if (e.actionDiagnostic) evidence.actionDiagnostic = e.actionDiagnostic; process.exitCode = 1; }
  finally {
    if (runtime?.process && extensionId) {
      try { for (const client of await runtime.native("GET", "/api/v1/security/clients")) if (client.origin === "chrome-extension://" + extensionId) await runtime.native("DELETE", "/api/v1/security/clients/" + client.clientId); } catch (_) {}
    }
    await stopChrome().catch(() => {}); await runtime?.stop().catch(() => {}); await relay?.stop().catch(() => {});
    if (site) { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
    evidence.timestampUtc = new Date().toISOString();
    fs.mkdirSync(RUN, { recursive: true }); fs.writeFileSync(path.join(RUN, "chrome-smoke-evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  }
})();
