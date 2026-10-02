const assert = require("assert");
const { makeBackground, task, json, identity, TASK_ID, PROOF, CREDENTIAL, CLIENT_ID, ORIGIN } = require("./runtime-harness");
const checks = [];
function check(name, condition) { assert(condition, name); checks.push(name); console.log("PASS  " + name); }
(async () => {
  const bg = makeBackground();
  bg.install();
  const menu = bg.menus[0];
  const targetTab = { id: 7, url: "https://example.com/article" };
  await bg.clickMenu({
    menuItemId: menu.id,
    selectionText: "Senior Software Engineer",
    frameId: 2,
    documentId: "doc-frame"
  }, targetTab);
  const sent = bg.tabMessages.filter((entry) => entry.message.type === "TRANSLATE_SELECTION");
  const messagesBeforeMissingFrame = bg.tabMessages.length;
  await bg.clickMenu({ menuItemId: menu.id, selectionText: "No frame id" }, targetTab);
  check("A context-menu selection without a frame id fails closed",
    bg.tabMessages.length === messagesBeforeMissingFrame);
  const messagesBeforeMissingDocumentId = bg.tabMessages.length;
  bg.setDocumentIdAvailable(false);
  await bg.clickMenu({
    menuItemId: menu.id,
    selectionText: "Senior Software Engineer",
    frameId: 2
  }, targetTab);
  bg.setDocumentIdAvailable(true);
  check("A selection fails closed when the probe cannot pin a document ID",
    bg.tabMessages.length === messagesBeforeMissingDocumentId);
  const callsBeforeMismatch = bg.scriptCalls.length;
  await bg.clickMenu({
    menuItemId: menu.id,
    selectionText: "Old document selection",
    frameId: 2,
    documentId: "doc-frame"
  }, targetTab);
  check("A selection that no longer matches the target frame is dropped",
    bg.scriptCalls.length === callsBeforeMismatch + 1 &&
    !bg.tabMessages.some((entry) => entry.message.type === "TRANSLATE_SELECTION" &&
      entry.message.selectionText === "Old document selection"));
  await bg.clickMenu({
    menuItemId: menu.id,
    selectionText: "restricted",
    frameId: 0
  }, { id: 8, url: "chrome://settings" });
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
  await bg.clickMenu({
    menuItemId: menu.id,
    selectionText: "Input selected text",
    frameId: 0
  }, targetTab);
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
  for (const proof of [{ pairingId: "invalid", pairingSecret: PROOF }, { pairingId: TASK_ID, pairingSecret: "invalid" }]) {
    const invalid = makeBackground({ unpaired: true });
    check("Malformed proof is rejected before network", (await invalid.send({ type: "PAIR", ...proof })).kind === "proof" && invalid.calls.length === 0);
  }
  for (const options of [{ boundaryFail: true }, { boundaryMissing: true }, { writeFail: true }]) {
    const failed = makeBackground({ ...options, unpaired: true });
    const response = await failed.send({ type: "PAIR", pairingId: TASK_ID, pairingSecret: PROOF });
    check("Secure storage failure fails closed with revoke guidance", response.kind === "storage" && response.error.includes("撤销") && !(await failed.checkConnection()).paired &&
      !failed.store.runtimePairing && failed.calls.length === (options.writeFail ? 1 : 0));
  }
  const expired = makeBackground({ unpaired: true, fetch: async () => json({ code: "UNAUTHORIZED", message: "PRIVATE" }, 401) });
  check("Expired/replayed proof maps to safe pairing failure", (await expired.send({ type: "PAIR", pairingId: TASK_ID, pairingSecret: PROOF })).kind === "proof" && expired.calls.length === 1);
  const unknown = makeBackground({ unpaired: true, fetch: async () => { throw new Error(PROOF); } });
  const unknownResult = await unknown.send({ type: "PAIR", pairingId: TASK_ID, pairingSecret: PROOF });
  check("Ambiguous exchange never replays and tells user to inspect server clients", unknownResult.kind === "pairingUnknown" && unknown.calls.length === 1 && unknownResult.error.includes("Paired Browsers"));
  const beforeForget = paired.calls.length;
  check("Forget deletes local pairing without server management calls", !(await paired.send({ type: "FORGET_PAIRING" })).paired && !paired.store.runtimePairing && paired.calls.length === beforeForget);
  check("Unpaired translate has no backend request", (await paired.translateBatch(items)).kind === "unpaired" && paired.calls.length === beforeForget);
  check("Readiness is authenticated and consumes safe availability only", (await bg.checkConnection()).available && bg.calls.at(-1).init.headers.Authorization === "Bearer " + CREDENTIAL);
  const offline = makeBackground({ fetch: async () => { throw new Error("PRIVATE"); } });
  check("Runtime offline is explicit", !(await offline.checkConnection()).online);
  const unavailable = makeBackground({ fetch: async () => json({ available: false, error: { code: "PROVIDER_UNAVAILABLE", message: "PRIVATE" }, provider: "PRIVATE" }) });
  const unavailableStatus = await unavailable.checkConnection();
  check("Translation unavailable retains online Runtime and hides diagnostics", unavailableStatus.online && !unavailableStatus.available && !JSON.stringify(unavailableStatus).includes("PRIVATE"));
  const revoked = makeBackground({ fetch: async () => json({ code: "UNAUTHORIZED" }, 401) });
  check("Revoked credential is distinct from network and disables pairing", (await revoked.checkConnection()).pairing === "invalid" && !(await revoked.send({ type: "GET_PAIRING" })).paired);
  const happy = makeBackground();
  let poll = 0;
  happy.setFetch(async (_url, init) => init.method === "POST" ? json(task(), 202, { Location: "/api/v1/tasks/" + TASK_ID }) :
    json(++poll === 1 ? task("RUNNING") : task("SUCCEEDED", { result: { items: items.map(i => ({ id: i.id, translation: "译文" })) } })));
  const translated = await happy.translateBatch(items);
  check("One multi-record batch submits one task then QUEUED/RUNNING/SUCCEEDED", translated.ok && translated.results.length === 2 && happy.calls.filter(c => c.init.method === "POST").length === 1 && poll === 2);
  check("Authenticated requests cannot redirect or use cookies", happy.calls.every(c => c.init.headers.Authorization === "Bearer " + CREDENTIAL && c.init.redirect === "error" && c.init.credentials === "omit"));
  check("Normal batch preserves items contract and public identity", JSON.parse(happy.calls[0].init.body).items.length === 2 && translated.identity.promptVersion === identity.promptVersion && !JSON.stringify(translated).includes(CREDENTIAL));
  const malformed = [
    [task("QUEUED", { taskId: "invalid" }), "/api/v1/tasks/invalid"],
    [task(), "https://example.com/tasks/" + TASK_ID],
    [task("QUEUED", { capability: "ask" }), "/api/v1/tasks/" + TASK_ID],
    [task("QUEUED", { status: "UNKNOWN" }), "/api/v1/tasks/" + TASK_ID],
    [task("QUEUED", { profile: { ...identity.profile, locality: "CLOUD" } }), "/api/v1/tasks/" + TASK_ID],
    [task("QUEUED", { profile: { ...identity.profile, version: 1 } }), "/api/v1/tasks/" + TASK_ID],
    [task("QUEUED", { promptVersion: "" }), "/api/v1/tasks/" + TASK_ID],
    [task("QUEUED", { result: "late" }), "/api/v1/tasks/" + TASK_ID]
    , [task("QUEUED", { createdAt: "2026" }), "/api/v1/tasks/" + TASK_ID]
  ];
  for (const [view, location] of malformed) {
    const bad = makeBackground({ fetch: async () => json(view, 202, { Location: location }) });
    check("Malformed submission task/Location/metadata is rejected", (await bad.translateBatch(items)).kind === "invalid" && bad.calls.length === 1);
  }
  for (const code of ["PROVIDER_UNAVAILABLE", "MODEL_UNAVAILABLE", "TASK_CANCELLED", "TASK_TIMEOUT", "QUEUE_FULL", "INVALID_REQUEST", "POLICY_DENIED", "PROVIDER_RESPONSE_INVALID", "INTERNAL_ERROR", "UNAUTHORIZED", "TASK_NOT_FOUND"]) {
    const expected = { PROVIDER_UNAVAILABLE: "unavailable", MODEL_UNAVAILABLE: "unavailable", TASK_CANCELLED: "cancelled", TASK_TIMEOUT: "timeout", QUEUE_FULL: "busy", INVALID_REQUEST: "unsupported", POLICY_DENIED: "denied", PROVIDER_RESPONSE_INVALID: "invalid", INTERNAL_ERROR: "failed", UNAUTHORIZED: "unauthorized", TASK_NOT_FOUND: "missing" }[code];
    const failed = makeBackground({ fetch: async (_url, init) => init.method === "POST" ? json(task(), 202, { Location: "/api/v1/tasks/" + TASK_ID }) : json(task("FAILED", { error: { code, message: "PRIVATE", stack: "PRIVATE" } })) });
    const result = await failed.translateBatch(items);
    check("Task failure maps controlled code " + code, result.kind === expected && !JSON.stringify(result).includes("PRIVATE") && !failed.logs.join(" ").includes("PRIVATE"));
  }
  for (const [status, kind] of [["CANCELLED", "cancelled"], ["TIMED_OUT", "timeout"]]) {
    const terminal = makeBackground({ fetch: async (_url, init) => init.method === "POST" ? json(task(), 202, { Location: "/api/v1/tasks/" + TASK_ID }) : json(task(status)) });
    check("Terminal " + status + " ends polling", (await terminal.translateBatch(items)).kind === kind && terminal.calls.length === 2);
  }
  const full = makeBackground({ fetch: async () => json({ code: "QUEUE_FULL", message: "PRIVATE" }, 429) });
  check("Queue admission failure does not resubmit", (await full.translateBatch(items)).kind === "busy" && full.calls.length === 1);
  for (const fetch of [async () => { throw new Error("PRIVATE"); }, async () => new Response(new ReadableStream({ start() {} }), { status: 202, headers: { "Content-Type": "application/json" } })]) {
    const lost = makeBackground({ fetch, config: { runtimeRequestTimeoutMs: 8 } });
    check("POST transport/body deadline is ambiguous and never retried", (await lost.translateBatch(items)).kind === "submissionUnknown" && lost.calls.length === 1);
  }
  const huge = makeBackground({ fetch: async () => json({ private: "x".repeat(65537) }, 202) });
  check("Oversized streamed response is rejected without retry", (await huge.translateBatch(items)).kind === "submissionUnknown" && huge.calls.length === 1);
  let gets = 0;
  const retry = makeBackground({ fetch: async (_url, init) => {
    if (init.method === "POST") return json(task(), 202, { Location: "/api/v1/tasks/" + TASK_ID });
    if (++gets <= 2) throw new Error("PRIVATE");
    return json(task("SUCCEEDED"));
  } });
  check("Known-task GET allows two bounded retries without POST", (await retry.translateBatch(items)).ok && gets === 3 && retry.calls.filter(c => c.init.method === "POST").length === 1);
  const exhausted = makeBackground({ fetch: async (_url, init) => init.method === "POST" ? json(task(), 202, { Location: "/api/v1/tasks/" + TASK_ID }) : Promise.reject(new Error("PRIVATE")) });
  check("GET retry exhaustion remains bounded", (await exhausted.translateBatch(items)).kind === "network" && exhausted.calls.length === 4);
  const queued = makeBackground({ fetch: async (_url, init) => json(task(), init.method === "POST" ? 202 : 200, { Location: "/api/v1/tasks/" + TASK_ID }), config: { runtimeTaskDeadlineMs: 10 } });
  check("Overall task deadline terminates queued polling", (await queued.translateBatch(items)).kind === "timeout" && queued.calls.length < 20);
  for (const overrides of [{ taskId: "00000000-0000-4000-8000-000000000002" }, { capability: "ask" }, { profile: { ...identity.profile, version: "next" } }, { result: [] }]) {
    const bad = makeBackground({ fetch: async (_url, init) => init.method === "POST" ? json(task(), 202, { Location: "/api/v1/tasks/" + TASK_ID }) : json(task("SUCCEEDED", overrides)) });
    check("Poll task ID/capability/identity/result mismatch fails closed", (await bad.translateBatch(items)).kind === "invalid");
  }
  const partial = makeBackground({ fetch: async (_url, init) => init.method === "POST" ? json(task(), 202, { Location: "/api/v1/tasks/" + TASK_ID }) : json(task("SUCCEEDED", { result: { items: [
    { id: 1, translation: "valid" }, { id: 2, translation: "duplicate" }, { id: 2, translation: "duplicate" },
    { id: 2, translation: "third" }, { id: 3, translation: " " }, { id: 99, translation: "unexpected" }, { id: "4", translation: "invalid" }
  ] } })) });
  const partialResult = await partial.translateBatch([...items, { id: 3, text: "three" }, { id: 4, text: "four" }]);
  check("Missing/duplicate/unexpected/empty mappings stay missing without fabricated results", partialResult.ok && partialResult.results.length === 1 && partialResult.results[0].id === 1);
  for (const invalidItems of [Array.from({ length: 33 }, (_, id) => ({ id, text: "word" })), [{ id: 1, text: "x".repeat(1401) }, { id: 2, text: "y".repeat(1400) }], [{ id: 1, text: "中".repeat(700) }, { id: 2, text: "中".repeat(700) }], [{ id: 1, text: "a".repeat(4001) }], [{ id: 1, text: "中".repeat(1900) }], [{ id: 1, text: "one" }, { id: 1, text: "two" }]]) {
    const budget = makeBackground();
    check("Invalid IDs and over-budget inputs fail without network or truncation", (await budget.translateBatch(invalidItems)).kind === "unsupported" && budget.calls.length === 0);
  }
  for (const text of ["a".repeat(3000), "English " + "中".repeat(1500)]) {
    const single = makeBackground({ fetch: async (_url, init) => {
      const view = task(init.method === "POST" ? "QUEUED" : "SUCCEEDED", { promptVersion: "translate-v1", ...(init.method === "POST" ? {} : { result: "单条译文" }) });
      return json(view, init.method === "POST" ? 202 : 200, { Location: "/api/v1/tasks/" + TASK_ID });
    } });
    const result = await single.translateBatch([{ id: 7, text }]);
    const sent = JSON.parse(single.calls[0].init.body);
    check("Oversized safe record uses one Single task and preserves text/id", result.ok && result.results[0].id === 7 && sent.text === text && !sent.items && single.calls.filter(c => c.init.method === "POST").length === 1);
  }
  check("Credentials/proof/input/results never appear in production logs", [bg, paired, happy, partial, unknown, revoked].every(worker => !worker.logs.join(" ").includes(CREDENTIAL) && !worker.logs.join(" ").includes(PROOF) && !worker.logs.join(" ").includes("Hello world")));
  console.log("\n" + checks.length + " background Runtime/security checks passed.");
})().catch(() => { console.error("FAIL  background Runtime contract regression (details suppressed)"); process.exitCode = 1; });
