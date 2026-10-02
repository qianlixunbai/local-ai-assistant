/* Internal messages expose translations, public identity and controlled status only. */
async function checkConnection() {
  const epoch = RuntimeStorage.epoch();
  try {
    const token = await RuntimeStorage.credential();
    return { paired: true, pairing: "paired", ...await RuntimeClient.readiness(token) };
  } catch (e) {
    if (e.kind === "unauthorized" && epoch === RuntimeStorage.epoch()) await RuntimeStorage.invalidate(epoch);
    return { paired: !["unpaired", "storage", "unauthorized"].includes(e.kind),
      pairing: e.kind === "unauthorized" ? "invalid" : e.kind === "unpaired" ? "unpaired" : e.kind === "storage" ? "storage" : "paired",
      online: !["network", "unpaired", "storage"].includes(e.kind), available: false,
      reason: RuntimeClient.MESSAGES[e.kind] || RuntimeClient.MESSAGES.failed };
  }
}
function trustedPopup(sender) {
  return sender && sender.id === chrome.runtime.id && !sender.tab &&
    sender.url === "chrome-extension://" + chrome.runtime.id + "/popup.html";
}
const handlers = {
  async ENSURE_CONTENT_SCRIPT(msg) {
    await RuntimeStorage.secure();
    const ready = await ensureContentScript(msg.tabId, 0);
    return { ok: ready.ok, reason: ready.reason };
  },
  async CHECK_CONNECTION() { return checkConnection(); },
  async GET_PAIRING() { return RuntimeStorage.status(); },
  async PAIR(msg) { return RuntimeStorage.pair(msg); },
  async FORGET_PAIRING() { return RuntimeStorage.forget(); },
  async TRANSLATE_BATCH(msg) {
    const epoch = RuntimeStorage.epoch();
    const token = await RuntimeStorage.credential();
    let translated;
    try { translated = await RuntimeClient.translate(msg.items, token); }
    catch (e) {
      if (e.kind === "unauthorized" && epoch === RuntimeStorage.epoch()) await RuntimeStorage.invalidate(epoch);
      throw e;
    }
    if (epoch !== RuntimeStorage.epoch()) throw RuntimeClient.error("unpaired");
    return translated;
  }
};
const POPUP_ONLY = new Set(["PAIR", "FORGET_PAIRING", "GET_PAIRING", "ENSURE_CONTENT_SCRIPT"]);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !Object.hasOwn(handlers, msg.type)) return false;
  if (!sender || sender.id !== chrome.runtime.id || (POPUP_ONLY.has(msg.type) && !trustedPopup(sender))) {
    sendResponse({ ok: false, kind: "denied", error: RuntimeClient.MESSAGES.denied });
    return false;
  }
  handlers[msg.type](msg, sender)
    .then(data => sendResponse({ ok: true, ...data }))
    .catch(async e => {
      const kind = e && Object.hasOwn(RuntimeClient.MESSAGES, e.kind) ? e.kind : "failed";
      console.error("[LAT] 后台请求失败:", kind);
      const response = { ok: false, kind, error: RuntimeClient.MESSAGES[kind] };
      if (e && Number.isInteger(e.status)) response.status = e.status;
      sendResponse(response);
    });
  return true;
});
