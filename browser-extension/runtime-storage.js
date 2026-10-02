/* Trusted worker storage. Never send the stored object across runtime messaging. */
const RuntimeStorage = (() => {
  const KEY = "runtimePairing";
  let healthy = true;
  let epoch = 0;
  let pairingOperation = false;
  // Start at worker initialization, before reads, writes, network or injection.
  const boundary = (async () => {
    try {
      if (!chrome.storage?.local?.setAccessLevel) throw new Error();
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      return true;
    } catch (_) {
      healthy = false;
      try { await chrome.storage?.local?.remove(KEY); } catch (_) { /* fail closed */ }
      return false;
    }
  })();
  async function secure() {
    if (!await boundary || !healthy) throw RuntimeClient.error("storage");
  }
  async function read() {
    await secure();
    try {
      const stored = (await chrome.storage.local.get(KEY))[KEY];
      if (!stored) return null;
      if (typeof stored.clientId !== "string" || stored.origin !== "chrome-extension://" + chrome.runtime.id ||
          typeof stored.credential !== "string" ||
          !/^br1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(stored.credential) ||
          stored.credential.slice(4, 40) !== stored.clientId) throw new Error();
      return stored;
    } catch (_) { throw RuntimeClient.error("storage"); }
  }
  async function credential() {
    const paired = await read();
    if (!paired) throw RuntimeClient.error("unpaired");
    if (paired.invalid) throw RuntimeClient.error("unauthorized");
    return paired.credential;
  }
  async function status() {
    const paired = await read();
    return { paired: !!paired && !paired.invalid, pairing: paired?.invalid ? "invalid" : paired ? "paired" : "unpaired" };
  }
  async function invalidate(expectedEpoch = epoch) {
    try {
      const paired = await read();
      if (expectedEpoch !== epoch) return;
      if (paired) await chrome.storage.local.set({ [KEY]: { ...paired, invalid: true } });
    } catch (_) { if (expectedEpoch === epoch) healthy = false; }
  }
  async function pair(msg) {
    await secure();
    if (pairingOperation) throw RuntimeClient.error("busy");
    pairingOperation = true;
    try {
      if (await read()) throw RuntimeClient.error("denied");
      ++epoch;
      const paired = await RuntimeClient.exchange(msg.pairingId, msg.pairingSecret);
      try {
        await chrome.storage.local.set({ [KEY]: paired });
        const saved = await read();
        if (!saved || saved.credential !== paired.credential) throw new Error();
      } catch (_) {
        healthy = false;
        try { await chrome.storage.local.remove(KEY); } catch (_) { /* no fallback */ }
        throw RuntimeClient.error("storage");
      }
      return { paired: true, pairing: "paired" };
    } finally { pairingOperation = false; }
  }
  async function forget() {
    if (pairingOperation) throw RuntimeClient.error("busy");
    if (!await boundary) throw RuntimeClient.error("storage");
    ++epoch;
    try { await chrome.storage.local.remove(KEY); healthy = true; }
    catch (_) { healthy = false; throw RuntimeClient.error("storage"); }
    return { paired: false, pairing: "unpaired" };
  }
  return { secure, credential, status, invalidate, pair, forget, epoch: () => epoch };
})();
