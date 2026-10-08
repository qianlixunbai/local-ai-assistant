/* Authenticated Translate transport. Only the trusted service worker loads this file. */
const RuntimeClient = (() => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const TOKEN_PART = /^[A-Za-z0-9._-]{1,64}$/;
  const STATES = new Set(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]);
  const MESSAGES = Object.freeze({
    network: "Runtime 离线，请启动 Personal AI Runtime。",
    unauthorized: "Browser 配对凭据已失效或被撤销，请重新配对。",
    unpaired: "尚未配对，请先在 Windows Assistant 创建一次性配对。",
    unavailable: "Translation 不可用，请在 Windows Assistant 检查翻译服务。",
    busy: "Runtime 繁忙，请稍后重试。",
    timeout: "翻译超时，请稍后重试。",
    cancelled: "翻译任务已取消。",
    freshness: "翻译身份已变化，请显式重试。",
    invalid: "翻译响应无效，请重试。",
    unsupported: "翻译输入超出 Runtime 安全预算或格式无效。",
    denied: "Runtime 不允许此翻译请求。",
    missing: "翻译任务已不存在，请显式重试。",
    failed: "翻译失败，请重试。",
    submissionUnknown: "提交结果未知，Runtime 可能已接受任务；不会自动重试。",
    pairingUnknown: "配对状态未知，请在 Windows Assistant 查看 Paired Browsers；必要时撤销后重新创建配对。",
    proof: "配对 ID / Secret 无效、已过期或已使用，请创建新配对。",
    storage: "Browser credential 未安全保存。请到 Windows Assistant → Paired Browsers 撤销刚创建客户端，然后重新配对。"
  });
  function error(kind, status) {
    const e = new Error(MESSAGES[kind] || MESSAGES.failed);
    e.kind = Object.hasOwn(MESSAGES, kind) ? kind : "failed";
    e.isLatError = true;
    if (Number.isInteger(status)) e.status = status;
    return e;
  }
  function exact(value, keys) {
    return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  }
  function cacheIdentity(value) {
    if (!exact(value, ["version", "single", "batch"]) || value.version !== 1) throw error("invalid");
    const safe = { version: 1 };
    for (const mode of ["single", "batch"]) {
      const item = value[mode];
      if (!exact(item, ["profile", "promptVersion"]) || !exact(item.profile, ["id", "version", "locality"])) throw error("invalid");
      safe[mode] = identity(item);
      if (item.promptVersion !== (mode === "single" ? "translate-v1" : "translate-batch-v1")) throw error("invalid");
    }
    if (JSON.stringify(safe.single.profile) !== JSON.stringify(safe.batch.profile)) throw error("invalid");
    return safe;
  }
  function object(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
  function timestamp(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value));
  }
  function identity(view) {
    const p = view && view.profile;
    if (!object(p) || p.id !== "translate.fast" || !TOKEN_PART.test(p.version || "") ||
        p.locality !== "LOCAL" || typeof p.version !== "string" ||
        typeof view.promptVersion !== "string" || !TOKEN_PART.test(view.promptVersion)) throw error("invalid");
    return { profile: { id: p.id, version: p.version, locality: p.locality }, promptVersion: view.promptVersion };
  }
  function task(view, expectedId) {
    if (!object(view) || typeof view.taskId !== "string" || !UUID.test(view.taskId) ||
        (expectedId && view.taskId !== expectedId) || view.capability !== "translate" ||
        !STATES.has(view.status) || !timestamp(view.createdAt)) {
      throw error("invalid");
    }
    const safe = identity(view);
    const terminal = !["QUEUED", "RUNNING"].includes(view.status);
    if (terminal && !timestamp(view.finishedAt)) throw error("invalid");
    if (!terminal && (view.result != null || view.error != null || view.finishedAt != null)) throw error("invalid");
    if (view.status === "SUCCEEDED" && (view.result == null || view.error != null)) throw error("invalid");
    if (terminal && view.status !== "SUCCEEDED" && (view.result != null || !object(view.error) || typeof view.error.code !== "string")) throw error("invalid");
    return safe;
  }
  function codeError(code, status) {
    const kinds = {
      PROVIDER_UNAVAILABLE: "unavailable", MODEL_UNAVAILABLE: "unavailable", MODEL_SWITCH_CONFLICT: "busy", MODEL_EXECUTION_UNCERTAIN: "unavailable",
      MODEL_STATE_UNAVAILABLE: "unavailable", MODEL_IDENTITY_CHANGED: "unavailable", MODEL_CONFIGURATION_INVALID: "unavailable", TASK_CANCELLED: "cancelled",
      TASK_TIMEOUT: "timeout", QUEUE_FULL: "busy", INVALID_REQUEST: "unsupported", POLICY_DENIED: "denied",
      PROVIDER_RESPONSE_INVALID: "invalid", INTERNAL_ERROR: "failed", UNAUTHORIZED: "unauthorized", TASK_NOT_FOUND: "missing"
    };
    return error(kinds[code] || "failed", status);
  }
  // Bounded streaming read. The deadline remains active through headers AND body reads.
  async function readJSON(response, limit) {
    const length = response.headers.get("Content-Length");
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw error("invalid");
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") || "")) throw error("invalid");
    if (!response.body || typeof response.body.getReader !== "function") throw error("invalid");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) { void reader.cancel().catch(() => {}); throw error("invalid"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch (_) { throw error("invalid"); }
  }
  async function request(path, method, body, credential, timeoutMs = CFG.runtimeRequestTimeoutMs, responseLimit = CFG.runtimeResponseByteLimit) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(error("network")); }, timeoutMs);
    });
    const operation = (async () => {
      const headers = { "Content-Type": "application/json" };
      if (credential) headers.Authorization = "Bearer " + credential;
      // Origin and Fetch Metadata are generated by Chrome; never synthesize them here.
      const response = await fetch(CFG.runtimeBaseUrl + path, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal, mode: "cors", redirect: "error", credentials: "omit", cache: "no-store"
      });
      if (response.status === 401) throw error("unauthorized", 401);
      const data = await readJSON(response, responseLimit);
      if (!response.ok) throw codeError(object(data) && data.code, response.status);
      return { response, data };
    })();
    try { return await Promise.race([operation, deadline]); }
    catch (e) { if (e && e.isLatError) throw e; throw error("network"); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async function exchange(pairingId, pairingSecret) {
    if (typeof pairingId !== "string" || !UUID.test(pairingId) ||
        typeof pairingSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(pairingSecret)) throw error("proof");
    try {
      const { response, data } = await request("/api/v1/security/pairings/exchange", "POST", { pairingId, pairingSecret });
      if (response.status !== 200 || !object(data) || !object(data.client)) throw error("pairingUnknown");
      const c = data.client;
      if (!UUID.test(c.clientId || "") || c.clientType !== "browser-extension" ||
          c.origin !== "chrome-extension://" + chrome.runtime.id ||
          !Array.isArray(c.allowedCapabilities) || c.allowedCapabilities.length !== 1 || c.allowedCapabilities[0] !== "translate" ||
          typeof data.credential !== "string" ||
          !new RegExp("^br1\\." + c.clientId.replace(/-/g, "\\-") + "\\.[A-Za-z0-9_-]{43}$").test(data.credential)) throw error("pairingUnknown");
      return { credential: data.credential, clientId: c.clientId, origin: c.origin };
    } catch (e) {
      if (e.kind === "unauthorized") throw error("proof", 401);
      if (["network", "invalid"].includes(e.kind)) throw error("pairingUnknown");
      throw e;
    }
  }
  async function readiness(credential) {
    const { response, data } = await request("/api/v1/capabilities/translate/readiness?cacheIdentityVersion=1", "GET", undefined, credential, CFG.runtimeRequestTimeoutMs, 1024);
    if (response.status !== 200 || !object(data) || typeof data.available !== "boolean" ||
        (data.available && data.error != null) || (!data.available && (!object(data.error) || typeof data.error.code !== "string"))) throw error("invalid");
    const safe = data.cacheIdentity === undefined ? null : cacheIdentity(data.cacheIdentity);
    if (!data.available && safe !== null) throw error("invalid");
    return { online: true, available: data.available, cacheIdentity: safe, reason: data.available ? "" : codeError(data.error.code).message };
  }
  function isSingle(text) {
    return text.length > CFG.batchCharLimit || new TextEncoder().encode(text).length > CFG.batchUtf8ByteLimit;
  }
  function validateItems(items) {
    if (!Array.isArray(items) || !items.length || items.length > CFG.batchItemLimit) throw error("unsupported");
    const ids = new Set();
    let chars = 0, bytes = 0;
    for (const item of items) {
      if (!object(item) || !Number.isInteger(item.id) || item.id < 0 || item.id > 2147483647 || ids.has(item.id) ||
          typeof item.text !== "string" || !item.text.trim()) throw error("unsupported");
      ids.add(item.id); chars += item.text.length; bytes += new TextEncoder().encode(item.text).length;
    }
    const single = items.length === 1 && isSingle(items[0].text);
    if (single ? chars > CFG.singleTextCharLimit || bytes > CFG.singleTextUtf8ByteLimit :
        chars > CFG.batchCharLimit || bytes > CFG.batchUtf8ByteLimit) throw error("unsupported");
    return { ids, single };
  }
  function results(view, items, ids, single) {
    if (single) {
      if (typeof view.result !== "string" || !view.result.trim()) throw error("invalid");
      return [{ id: items[0].id, translation: view.result.trim() }];
    }
    if (!object(view.result) || !Array.isArray(view.result.items)) throw error("invalid");
    const byId = new Map(), seen = new Set();
    for (const r of view.result.items) {
      if (!object(r) || !Number.isInteger(r.id) || !ids.has(r.id)) continue;
      if (seen.has(r.id)) { byId.delete(r.id); continue; }
      seen.add(r.id);
      if (typeof r.translation === "string" && r.translation.trim()) byId.set(r.id, r.translation.trim());
    }
    return items.filter(i => byId.has(i.id)).map(i => ({ id: i.id, translation: byId.get(i.id) }));
  }
  async function translate(items, credential, expectedIdentity) {
    const { ids, single } = validateItems(items);
    const body = { ...(single ? { text: items[0].text } : { items }), sourceLanguage: "en", targetLanguage: CFG.targetLanguage, profile: "translate.fast" };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 32768) throw error("unsupported");
    const deadline = Date.now() + CFG.runtimeTaskDeadlineMs;
    let submission;
    try { submission = await request("/api/v1/translate/tasks", "POST", body, credential); }
    catch (e) { if (["network", "invalid"].includes(e.kind)) throw error("submissionUnknown"); throw e; }
    const view = submission.data;
    if (submission.response.status !== 202) throw error("invalid");
    const acceptedIdentity = task(view);
    if (acceptedIdentity.promptVersion !== (single ? "translate-v1" : "translate-batch-v1")) throw error("invalid");
    if (expectedIdentity && JSON.stringify(acceptedIdentity) !== JSON.stringify(identity(expectedIdentity))) throw error("freshness");
    const path = "/api/v1/tasks/" + view.taskId;
    const location = submission.response.headers.get("Location");
    if (location !== path && location !== CFG.runtimeBaseUrl + path) throw error("invalid");
    let current = view, getFailures = 0, polls = 0;
    while (true) {
      const safe = task(current, view.taskId);
      if (JSON.stringify(safe) !== JSON.stringify(acceptedIdentity)) throw error("invalid");
      if (current.status === "SUCCEEDED") return { ok: true, results: results(current, items, ids, single), identity: safe };
      if (current.status === "CANCELLED") throw error("cancelled");
      if (current.status === "TIMED_OUT") throw error("timeout");
      if (current.status === "FAILED") throw codeError(current.error.code);
      if (Date.now() >= deadline || ++polls > CFG.runtimeMaxPolls) throw error("timeout");
      await new Promise(resolve => setTimeout(resolve, Math.min(CFG.runtimePollIntervalMs, Math.max(0, deadline - Date.now()))));
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error("timeout");
      try {
        const fetched = await request(path, "GET", undefined, credential, Math.min(CFG.runtimeRequestTimeoutMs, remaining));
        if (fetched.response.status !== 200) throw error("invalid");
        current = fetched.data;
      } catch (e) {
        if (e.kind !== "network" || ++getFailures > CFG.runtimeGetRetryLimit) throw e;
        // Retry only GET for the known task. Never repeat submission.
      }
    }
  }
  return { error, MESSAGES, exchange, readiness, translate };
})();
