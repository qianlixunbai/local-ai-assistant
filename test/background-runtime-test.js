const assert = require("assert");
const { makeBackground, task, json, identity, TASK_ID, PROOF, CREDENTIAL, ORIGIN } = require("./runtime-harness");
const checks = [];
let activeCase = "Background setup";
function check(name, condition, worker) {
  activeCase = name;
  if (!condition) console.error("SAFE COUNTS", JSON.stringify({ completed: checks.length,
    ...(worker ? { requests: worker.calls.length, posts: worker.calls.filter(c => c.init.method === "POST").length } : {})
  }));
  assert(condition); checks.push(name); console.log("PASS  " + name);
}
async function matrix(family, rows, run) {
  for (const [caseName, ...values] of rows) {
    activeCase = family + "/" + caseName;
    await run(activeCase, ...values);
  }
}
const taskLocation = "/api/v1/tasks/" + TASK_ID;
const accepted = () => json(task(), 202, { Location: taskLocation });
function taskWorker(view) {
  return makeBackground({ fetch: async (_url, init) => init.method === "POST" ? accepted() : json(view) });
}
(async () => {
  const bg = makeBackground();
  bg.install();
  const menu = bg.menus[0];
  const targetTab = { id: 7, url: "https://example.com/article" };
  const select = (selectionText, target = {}, tab = targetTab) =>
    bg.clickMenu({ menuItemId: menu.id, selectionText, ...target }, tab);
  await select("Senior Software Engineer", { frameId: 2, documentId: "doc-frame" });
  const sent = bg.tabMessages.filter((entry) => entry.message.type === "TRANSLATE_SELECTION");
  const messagesBeforeMissingFrame = bg.tabMessages.length;
  await select("No frame id");
  check("A context-menu selection without a frame id fails closed",
    bg.tabMessages.length === messagesBeforeMissingFrame);
  const messagesBeforeMissingDocumentId = bg.tabMessages.length;
  bg.setDocumentIdAvailable(false);
  await select("Senior Software Engineer", { frameId: 2 });
  bg.setDocumentIdAvailable(true);
  check("A selection fails closed when the probe cannot pin a document ID",
    bg.tabMessages.length === messagesBeforeMissingDocumentId);
  const callsBeforeMismatch = bg.scriptCalls.length;
  await select("Old document selection", { frameId: 2, documentId: "doc-frame" });
  check("A selection that no longer matches the target frame is dropped",
    bg.scriptCalls.length === callsBeforeMismatch + 1 &&
    !bg.tabMessages.some((entry) => entry.message.type === "TRANSLATE_SELECTION" &&
      entry.message.selectionText === "Old document selection"));
  await select("restricted", { frameId: 0 }, { id: 8, url: "chrome://settings" });
  await bg.clickMenu({ menuItemId: "different-menu", selectionText: "ignored" }, targetTab);
  const selectionMessages = bg.tabMessages.filter((entry) => entry.message.type === "TRANSLATE_SELECTION");
  check("One selection context menu routes only the selected text to an injectable tab",
    bg.menus.length === 1 && menu.title === "使用 Local AI 翻译选中文本" &&
    menu.contexts.length === 1 && menu.contexts[0] === "selection" &&
    sent.length === 1 && sent[0].tabId === 7 &&
    sent[0].message.selectionText === "Senior Software Engineer" &&
    sent[0].options.documentId === "doc-frame" &&
    sent[0].message.selectionTarget.frameId === 2 &&
    sent[0].message.selectionTarget.documentId === "doc-frame" &&
    selectionMessages.length === 1);

  const selectionProbe = bg.scriptCalls.find((call) => call.func);
  check("Selection probe and script target stay bound to the clicked frame/document",
    selectionProbe.target.frameIds[0] === 2 &&
    bg.scriptCalls.filter((call) => call.files).every((call) =>
      call.target.documentIds && call.target.documentIds[0] === "doc-frame"));

  const inputValue = "before Input selected text after";
  const inputStart = inputValue.indexOf("Input selected text");
  bg.setActiveInput({
    tagName: "INPUT",
    type: "text",
    value: inputValue,
    selectionStart: inputStart,
    selectionEnd: inputStart + "Input selected text".length
  });
  await select("Input selected text", { frameId: 0 });
  bg.setActiveInput(null);
  const inputSelectionMessage = bg.tabMessages.find((entry) =>
    entry.message.type === "TRANSLATE_SELECTION" && entry.message.selectionText === "Input selected text");
  check("Selection probing supports selected text in ordinary text inputs",
    !!inputSelectionMessage && inputSelectionMessage.options.documentId === "doc-top");


  const items = [{ id: 1, text: "Hello world" }, { id: 2, text: "Good morning" }];
  const paired = makeBackground({ unpaired: true });
  const pairResult = await paired.send({ type: "PAIR", pairingId: TASK_ID, pairingSecret: PROOF });
  check("Explicit exchange saves only browser credential and safe metadata", pairResult.ok && pairResult.paired && paired.store.runtimePairing.credential === CREDENTIAL &&
    !JSON.stringify(paired.store).includes(PROOF) && !JSON.stringify(pairResult).includes(CREDENTIAL));
  check("Storage is restricted before the first read or exchange", paired.storageEvents[0].type === "access" && paired.storageEvents[0].value.accessLevel === "TRUSTED_CONTEXTS");
  check("Exchange has no Authorization or synthesized browser headers", paired.calls.length === 1 &&
    !["Authorization", "Origin", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest"].some(key => key in paired.calls[0].init.headers));
  check("Worker restart reuses persisted browser pairing", (await makeBackground({ store: paired.store }).send({ type: "GET_PAIRING" })).paired);
  const deniedPair = await paired.send({ type: "PAIR", pairingId: TASK_ID, pairingSecret: PROOF }, paired.content);
  const deniedStatus = await paired.send({ type: "GET_PAIRING" }, paired.content);
  check("Content scripts cannot manage or read pairing", deniedPair.kind === "denied" && deniedStatus.kind === "denied");
  await matrix("Pairing", [
    ["invalid ID", { pairingId: "invalid", pairingSecret: PROOF }],
    ["invalid secret", { pairingId: TASK_ID, pairingSecret: "invalid" }]
  ], async (caseName, proof) => {
    const invalid = makeBackground({ unpaired: true });
    check(caseName, (await invalid.send({ type: "PAIR", ...proof })).kind === "proof" && invalid.calls.length === 0, invalid);
  });
  await matrix("Storage", [
    ["restriction rejected", { boundaryFail: true }],
    ["boundary unavailable", { boundaryMissing: true }],
    ["credential write failure", { writeFail: true }]
  ], async (caseName, options) => {
    const failed = makeBackground({ ...options, unpaired: true });
    const response = await failed.send({ type: "PAIR", pairingId: TASK_ID, pairingSecret: PROOF });
    check(caseName, response.kind === "storage" && response.error.includes("撤销") && !(await failed.checkConnection()).paired &&
      !failed.store.runtimePairing && failed.calls.length === (options.writeFail ? 1 : 0), failed);
  });
  const expired = makeBackground({ unpaired: true, fetch: async () => json({ code: "UNAUTHORIZED", message: "PRIVATE" }, 401) });
  check("Expired/replayed proof maps to safe pairing failure", (await expired.send({ type: "PAIR", pairingId: TASK_ID, pairingSecret: PROOF })).kind === "proof" && expired.calls.length === 1);
  const unknown = makeBackground({ unpaired: true, fetch: async () => { throw new Error(PROOF); } });
  const unknownResult = await unknown.send({ type: "PAIR", pairingId: TASK_ID, pairingSecret: PROOF });
  check("Ambiguous exchange never replays and tells user to inspect server clients", unknownResult.kind === "pairingUnknown" && unknown.calls.length === 1 && unknownResult.error.includes("Paired Browsers"));
  const beforeForget = paired.calls.length;
  check("Forget deletes local pairing without server management calls", !(await paired.send({ type: "FORGET_PAIRING" })).paired && !paired.store.runtimePairing && paired.calls.length === beforeForget);
  check("Unpaired translate has no backend request", (await paired.translateBatch(items)).kind === "unpaired" && paired.calls.length === beforeForget);
  check("Readiness is authenticated and consumes safe availability only", (await bg.checkConnection()).available && bg.calls.at(-1).init.headers.Authorization === "Bearer " + CREDENTIAL);
  const cache = { version: 1, single: { ...identity, promptVersion: "translate-v1" }, batch: identity };
  const identityWorker = makeBackground({ fetch: async () => json({ available: true, cacheIdentity: cache }) });
  const identityStatus = await identityWorker.checkConnection();
  check("Opt-in readiness forwards only validated Single/Batch identity", identityStatus.available &&
    JSON.stringify(identityStatus.cacheIdentity) === JSON.stringify(cache) &&
    identityWorker.calls[0].url.endsWith("/readiness?cacheIdentityVersion=1") && identityWorker.calls[0].init.cache === "no-store");
  check("Legacy Runtime readiness preserves translation without cache authority", (await bg.checkConnection()).cacheIdentity === null &&
    (await bg.translateBatch(items)).ok);
  for (const badCache of [ { ...cache, version: 2 }, { ...cache, extra: "PRIVATE" },
    { ...cache, single: { ...cache.single, promptVersion: "translate-batch-v1" } },
    { ...cache, batch: { ...identity, profile: { ...identity.profile, version: "other" } } },
    { ...cache, batch: { ...identity, profile: { ...identity.profile, model: "PRIVATE" } } }, null ]) {
    const invalidIdentity = makeBackground({ fetch: async () => json({ available: true, cacheIdentity: badCache }) });
    const result = await invalidIdentity.checkConnection();
    check("Malformed cache identity disables availability and leaks no diagnostics", !result.available && !result.cacheIdentity && !JSON.stringify(result).includes("PRIVATE"));
  }
  const hugeReadiness = makeBackground({ fetch: async () => json({ available: true, padding: "x".repeat(1024) }) });
  check("Readiness body has its own 1024-byte limit", !(await hugeReadiness.checkConnection()).available);
  let completeReadiness;
  const replacedReadiness = makeBackground({ fetch: () => new Promise(resolve => { completeReadiness = resolve; }) });
  const pendingReadiness = replacedReadiness.checkConnection();
  while (!completeReadiness) await new Promise(resolve => setTimeout(resolve, 0));
  await replacedReadiness.send({ type: "FORGET_PAIRING" });
  completeReadiness(json({ available: true, cacheIdentity: cache }));
  check("Credential replacement suppresses late readiness identity", !(await pendingReadiness).available);
  const mismatch = makeBackground({ fetch: async () => accepted() });
  const mismatchResult = await mismatch.send({ type: "TRANSLATE_BATCH", items,
    expectedIdentity: { ...identity, profile: { ...identity.profile, version: "old" } } }, mismatch.content);
  check("Mixed plan checks accepted identity before polling and never repeats POST", mismatchResult.kind === "freshness" && mismatch.calls.length === 1);
  const offline = makeBackground({ fetch: async () => { throw new Error("PRIVATE"); } });
  check("Runtime offline is explicit", !(await offline.checkConnection()).online);
  const unavailable = makeBackground({ fetch: async () => json({ available: false, error: { code: "PROVIDER_UNAVAILABLE", message: "PRIVATE" }, provider: "PRIVATE" }) });
  const unavailableStatus = await unavailable.checkConnection();
  check("Translation unavailable retains online Runtime and hides diagnostics", unavailableStatus.online && !unavailableStatus.available && !JSON.stringify(unavailableStatus).includes("PRIVATE"));
  const revoked = makeBackground({ fetch: async () => json({ code: "UNAUTHORIZED" }, 401) });
  check("Revoked credential is distinct from network and disables pairing", (await revoked.checkConnection()).pairing === "invalid" && !(await revoked.send({ type: "GET_PAIRING" })).paired);
  const happy = makeBackground();
  let poll = 0;
  happy.setFetch(async (_url, init) => init.method === "POST" ? accepted() :
    json(++poll === 1 ? task("RUNNING") : task("SUCCEEDED", { result: { items: items.map(i => ({ id: i.id, translation: "译文" })) } })));
  const translated = await happy.translateBatch(items);
  check("RuntimeBatchHappyPath", translated.ok && translated.results.length === 2 &&
    happy.calls.filter(c => c.init.method === "POST").length === 1 && poll === 2 &&
    happy.calls.slice(1).every(c => c.url.endsWith(taskLocation) && c.init.method === "GET") &&
    happy.calls.every(c => c.init.headers.Authorization === "Bearer " + CREDENTIAL && c.init.redirect === "error" && c.init.credentials === "omit") &&
    JSON.stringify(JSON.parse(happy.calls[0].init.body).items) === JSON.stringify(items) &&
    JSON.stringify(translated.identity) === JSON.stringify(identity) &&
    JSON.stringify(translated.results) === JSON.stringify(items.map(i => ({ id: i.id, translation: "译文" }))) &&
    !JSON.stringify(translated).includes(CREDENTIAL), happy);
  await matrix("Submission envelope", [
    ["invalid task ID", task("QUEUED", { taskId: "invalid" }), "/api/v1/tasks/invalid"],
    ["foreign Location", task(), "https://example.com/tasks/" + TASK_ID],
    ["wrong capability", task("QUEUED", { capability: "ask" })],
    ["illegal status", task("QUEUED", { status: "UNKNOWN" })],
    ["CLOUD locality", task("QUEUED", { profile: { ...identity.profile, locality: "CLOUD" } })],
    ["invalid profile version", task("QUEUED", { profile: { ...identity.profile, version: 1 } })],
    ["invalid promptVersion", task("QUEUED", { promptVersion: "" })],
    ["premature result", task("QUEUED", { result: "late" })],
    ["invalid timestamp", task("QUEUED", { createdAt: "2026" })]
  ], async (caseName, view, location = taskLocation) => {
    const bad = makeBackground({ fetch: async () => json(view, 202, { Location: location }) });
    check(caseName, (await bad.translateBatch(items)).kind === "invalid" && bad.calls.length === 1, bad);
  });
  await matrix("Controlled task error", [
    ["availability/PROVIDER_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "unavailable"],
    ["availability/MODEL_UNAVAILABLE", "MODEL_UNAVAILABLE", "unavailable"],
    ["lifecycle/TASK_CANCELLED", "TASK_CANCELLED", "cancelled"],
    ["lifecycle/TASK_TIMEOUT", "TASK_TIMEOUT", "timeout"],
    ["availability/QUEUE_FULL", "QUEUE_FULL", "busy"],
    ["input/INVALID_REQUEST", "INVALID_REQUEST", "unsupported"],
    ["policy/POLICY_DENIED", "POLICY_DENIED", "denied"],
    ["sanitization/PROVIDER_RESPONSE_INVALID", "PROVIDER_RESPONSE_INVALID", "invalid"],
    ["sanitization/INTERNAL_ERROR", "INTERNAL_ERROR", "failed"],
    ["auth/UNAUTHORIZED", "UNAUTHORIZED", "unauthorized"],
    ["lifecycle/TASK_NOT_FOUND", "TASK_NOT_FOUND", "missing"]
  ], async (caseName, code, expected) => {
    const failed = taskWorker(task("FAILED", { error: { code, message: "PRIVATE", stack: "PRIVATE" } }));
    const result = await failed.translateBatch(items);
    check(caseName, result.kind === expected && !JSON.stringify(result).includes("PRIVATE") && !failed.logs.join(" ").includes("PRIVATE"), failed);
  });
  for (const [status, kind] of [["CANCELLED", "cancelled"], ["TIMED_OUT", "timeout"]]) {
    const terminal = taskWorker(task(status));
    check("Terminal " + status + " ends polling", (await terminal.translateBatch(items)).kind === kind && terminal.calls.length === 2);
  }
  const full = makeBackground({ fetch: async () => json({ code: "QUEUE_FULL", message: "PRIVATE" }, 429) });
  check("Queue admission failure does not resubmit", (await full.translateBatch(items)).kind === "busy" && full.calls.length === 1);
  await matrix("Runtime transport", [
    ["POST rejected / no resubmit", async () => { throw new Error("PRIVATE"); }],
    ["POST stalled body / deadline / no resubmit", async () => new Response(new ReadableStream({ start() {} }), { status: 202, headers: { "Content-Type": "application/json" } })]
  ], async (caseName, fetch) => {
    const lost = makeBackground({ fetch, config: { runtimeRequestTimeoutMs: 8 } });
    check(caseName, (await lost.translateBatch(items)).kind === "submissionUnknown" && lost.calls.length === 1, lost);
  });
  const huge = makeBackground({ fetch: async () => json({ private: "x".repeat(65537) }, 202) });
  check("Oversized streamed response is rejected without retry", (await huge.translateBatch(items)).kind === "submissionUnknown" && huge.calls.length === 1);
  let gets = 0;
  const retry = makeBackground({ fetch: async (_url, init) => {
    if (init.method === "POST") return accepted();
    if (++gets <= 2) throw new Error("PRIVATE");
    return json(task("SUCCEEDED"));
  } });
  check("Known-task GET allows two bounded retries without POST", (await retry.translateBatch(items)).ok && gets === 3 && retry.calls.filter(c => c.init.method === "POST").length === 1);
  const exhausted = makeBackground({ fetch: async (_url, init) => init.method === "POST" ? accepted() : Promise.reject(new Error("PRIVATE")) });
  check("GET retry exhaustion remains bounded", (await exhausted.translateBatch(items)).kind === "network" && exhausted.calls.length === 4);
  const queued = makeBackground({ fetch: async (_url, init) => json(task(), init.method === "POST" ? 202 : 200, { Location: "/api/v1/tasks/" + TASK_ID }), config: { runtimeTaskDeadlineMs: 10 } });
  check("Overall task deadline terminates queued polling", (await queued.translateBatch(items)).kind === "timeout" && queued.calls.length < 20);
  await matrix("Poll validation", [
    ["task ID changed", { taskId: "00000000-0000-4000-8000-000000000002" }],
    ["capability changed", { capability: "ask" }],
    ["profile identity changed", { profile: { ...identity.profile, version: "next" } }],
    ["invalid result shape", { result: [] }]
  ], async (caseName, overrides) => {
    const bad = taskWorker(task("SUCCEEDED", overrides));
    check(caseName, (await bad.translateBatch(items)).kind === "invalid", bad);
  });
  const partial = taskWorker(task("SUCCEEDED", { result: { items: [
    { id: 1, translation: "valid" }, { id: 2, translation: "duplicate" }, { id: 2, translation: "duplicate" },
    { id: 2, translation: "third" }, { id: 3, translation: " " }, { id: 99, translation: "unexpected" }, { id: "4", translation: "invalid" }
  ] } }));
  const partialResult = await partial.translateBatch([...items, { id: 3, text: "three" }, { id: 4, text: "four" }]);
  check("Missing/duplicate/unexpected/empty mappings stay missing without fabricated results", partialResult.ok && partialResult.results.length === 1 && partialResult.results[0].id === 1);
  await matrix("Input budget", [
    ["max items", Array.from({ length: 33 }, (_, id) => ({ id, text: "word" }))],
    ["aggregate chars", [{ id: 1, text: "x".repeat(1401) }, { id: 2, text: "y".repeat(1400) }]],
    ["aggregate UTF8", [{ id: 1, text: "中".repeat(700) }, { id: 2, text: "中".repeat(700) }]],
    ["Single chars", [{ id: 1, text: "a".repeat(4001) }]],
    ["Single UTF8", [{ id: 1, text: "中".repeat(1900) }]],
    ["duplicate IDs", [{ id: 1, text: "one" }, { id: 1, text: "two" }]]
  ], async (caseName, invalidItems) => {
    const budget = makeBackground();
    check(caseName, (await budget.translateBatch(invalidItems)).kind === "unsupported" && budget.calls.length === 0, budget);
  });
  await matrix("Single safe path", [["ASCII / no truncation", "a".repeat(3000)], ["Unicode / no truncation", "English " + "中".repeat(1500)]], async (caseName, text) => {
    const single = makeBackground({ fetch: async (_url, init) => {
      const view = task(init.method === "POST" ? "QUEUED" : "SUCCEEDED", { promptVersion: "translate-v1", ...(init.method === "POST" ? {} : { result: "单条译文" }) });
      return json(view, init.method === "POST" ? 202 : 200, { Location: "/api/v1/tasks/" + TASK_ID });
    } });
    const result = await single.translateBatch([{ id: 7, text }]);
    const sent = JSON.parse(single.calls[0].init.body);
    check(caseName, result.ok && result.results[0].id === 7 && sent.text === text && !sent.items && single.calls.filter(c => c.init.method === "POST").length === 1, single);
  });
  check("Credentials/proof/input/results never appear in production logs", [bg, paired, happy, partial, unknown, revoked].every(worker => !worker.logs.join(" ").includes(CREDENTIAL) && !worker.logs.join(" ").includes(PROOF) && !worker.logs.join(" ").includes("Hello world")));
  console.log("\n" + checks.length + " background Runtime/security checks passed.");
})().catch(() => { console.error("FAIL  " + activeCase + " (completed checks: " + checks.length + "; private details suppressed)"); process.exitCode = 1; });
