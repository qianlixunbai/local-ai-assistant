/* v0.2.1 P2 state-machine tests — partial vs watching, retry-only-failed,
   translated+watching=false re-arm, watching idempotent short-circuit.
   Loads the REAL config.js + content.js into jsdom with a deferred mock. */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const EXT = path.resolve(__dirname, "..", "browser-extension");
const DEBOUNCE = 750;

function makeDom() {
  const dom = new JSDOM(`<!DOCTYPE html><html><head><title>t</title></head><body>
    <main id="m">
      <p id="a1">Alpha content block one here</p>
      <p id="a2">Bravo content block two here</p>
      <p id="a3">Charlie content block three here</p>
    </main></body></html>`,
    { url: "https://example.com/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.checkVisibility = function () {
    for (let el = this; el && el.nodeType === 1; el = el.parentElement) {
      if (el.hasAttribute("hidden")) return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
    }
    return true;
  };
  window.eval(fs.readFileSync(path.join(EXT, "config.js"), "utf8"));

  const pending = [];      // {msg, resolve}
  const requests = [];     // texts arrays, pushed when the request is SENT
  let active = 0, maxActive = 0;
  const listeners = [];
  window.chrome = {
    runtime: {
      sendMessage: (msg) => {
        if (msg && msg.type === "TRANSLATE_BATCH") {
          active++; maxActive = Math.max(maxActive, active);
          requests.push(msg.items.map((it) => it.text));
          return new Promise((resolve) => pending.push({ msg, resolve }));
        }
        return Promise.resolve(undefined);
      },
      onMessage: { addListener: (fn) => listeners.push(fn) }
    }
  };
  window.console.log = () => {};
  window.console.error = () => {};
  window.eval(fs.readFileSync(path.join(EXT, "content.js"), "utf8"));

  function latest() { return listeners[listeners.length - 1]; }

  return {
    window,
    doc: window.document,
    send: (msg) => new Promise((r) => latest()(msg, {}, r)),
    pending,
    requests,
    pendingCount: () => pending.length,
    requestCount: () => requests.length,
    latestRequestTexts: () => (requests.length ? requests[requests.length - 1] : []),
    maxActive: () => maxActive,
    // resolve oldest in-flight batch; fail items whose text matches failMatch
    resolveOldest(label, failMatch) {
      const p = pending.shift();
      if (!p) throw new Error("no pending request to resolve");
      active--;
      p.resolve({
        ok: true,
        results: p.msg.items.map((it) => ({
          id: it.id,
          translation: failMatch && failMatch(it.text) ? "" : "【" + label + "】" + it.text
        }))
      });
      return p;
    },
    // simulate content-script re-injection: keep the DOM + config, reset the
    // content script's module state by clearing its load sentinel and re-evaluating.
    reinject() {
      delete window.__LOCAL_AI_TRANSLATOR_LOADED__;
      window.eval(fs.readFileSync(path.join(EXT, "content.js"), "utf8"));
    }
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function pollUntil(fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await wait(30); }
  return fn();
}
const tx = (env) => [...env.doc.querySelectorAll(".local-ai-translation")].map((n) => n.textContent);

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra !== undefined ? "  -> " + extra : ""));
}

(async () => {
  /* ============ 1. partial + watching coexist ============ */
  console.log("\n---- 1. partial + watching ----");
  let env = makeDom();
  const p1 = env.send({ type: "TRANSLATE_PAGE" });
  await tick();
  check("1 initial batch in flight", env.pendingCount() === 1, env.pendingCount());
  env.resolveOldest("init", (t) => /Charlie/.test(t));   // 2 success, 1 fail
  await p1;

  // let the post-translate catch-up (dirty=true, debounce 0) settle
  await wait(300);

  let st = await env.send({ type: "GET_STATUS" });
  check("1 status is partial (not watching)", st.status === "partial", st.status);
  check("1 watching still true alongside partial", st.watching === true, st.watching);
  check("1 translated node count = 2", tx(env).filter((t) => /【/.test(t)).length === 2, tx(env).join("|"));
  check("1 failed record left untranslated", !tx(env).some((t) => /Charlie/.test(t)));
  check("1 catch-up did NOT retry the failed record", env.requestCount() === 1, env.requestCount() + " requests");

  /* ============ 2. user re-Translate -> only failed record ============ */
  console.log("\n---- 2. user re-Translate retries only failed ----");
  const beforeNodes = tx(env);
  const beforeReqs = env.requestCount();
  const p2 = env.send({ type: "TRANSLATE_PAGE" });      // popup sends this WITHOUT LAT_RESET
  await tick();
  check("2 exactly one new request", env.requestCount() === beforeReqs + 1, env.requestCount());
  const retryTexts = env.latestRequestTexts();
  check("2 retry requests only the failed record", retryTexts.length === 1 && /Charlie/.test(retryTexts[0]), retryTexts.join("|"));
  check("2 retry does NOT re-request the 2 successes", !retryTexts.some((t) => /Alpha|Bravo/.test(t)));
  env.resolveOldest("retry");                            // now all succeed
  await p2;
  await wait(300);

  const afterNodes = tx(env);
  st = await env.send({ type: "GET_STATUS" });
  check("2 status back to watching", st.status === "watching", st.status);
  check("2 watching true", st.watching === true);
  check("2 all 3 translated now", afterNodes.filter((t) => /【/.test(t)).length === 3, afterNodes.join("|"));
  check("2 earlier translations preserved (no reset)", afterNodes.some((t) => t === beforeNodes[0]) && afterNodes.some((t) => t === beforeNodes[1]));
  check("2 no duplicate translation nodes", new Set(afterNodes).size === afterNodes.length, afterNodes.length);
  check("2 no extra requests beyond the single retry", env.requestCount() === beforeReqs + 1, env.requestCount());

  /* ============ 3. translated + watching=false -> re-arm ============ */
  console.log("\n---- 3. translated + watching=false re-arms watcher ----");
  env = makeDom();
  const p3 = env.send({ type: "TRANSLATE_PAGE" });
  await tick(); env.resolveOldest("init"); await p3;
  await wait(300);
  check("3 initial fully translated", tx(env).filter((t) => /【/.test(t)).length === 3, tx(env).length);
  check("3 watching after initial", (await env.send({ type: "GET_STATUS" })).watching === true);

  // simulate extension reload / content-script re-injection: DOM keeps translations,
  // brand-new content script has watching=false
  const nodesBefore = tx(env);
  const reqsBefore = env.requestCount();
  env.reinject();
  await tick();

  st = await env.send({ type: "GET_STATUS" });
  check("3 GET_STATUS = translated", st.status === "translated", st.status);
  check("3 watching reported false after re-inject", st.watching === false, st.watching);

  const p3b = env.send({ type: "TRANSLATE_PAGE" });     // popup: translated -> no LAT_RESET, send TRANSLATE_PAGE
  const r3b = await p3b;
  check("3 re-click returns alreadyTranslated", r3b.alreadyTranslated === true, JSON.stringify(r3b).slice(0, 90));
  check("3 re-click re-armed watching", r3b.watching === true, r3b.watching);
  check("3 re-click called NO model", env.requestCount() === reqsBefore, env.requestCount() - reqsBefore + " new");
  check("3 translation node count unchanged", tx(env).length === nodesBefore.length, tx(env).length + " vs " + nodesBefore.length);
  check("3 existing translations unchanged", JSON.stringify(tx(env)) === JSON.stringify(nodesBefore));

  st = await env.send({ type: "GET_STATUS" });
  check("3 status now watching", st.status === "watching", st.status);
  check("3 watching true after re-arm", st.watching === true);

  /* ============ 4. watching page -> idempotent short-circuit ============ */
  console.log("\n---- 4. watching idempotent short-circuit ----");
  const reqsBefore4 = env.requestCount();
  const nodesBefore4 = tx(env);
  const r4 = await env.send({ type: "TRANSLATE_PAGE" }); // even if popup did NOT short-circuit
  check("4 content-level repeat is idempotent", r4.alreadyTranslated === true, JSON.stringify(r4).slice(0, 90));
  check("4 zero model requests", env.requestCount() === reqsBefore4, env.requestCount() - reqsBefore4 + " new");
  check("4 zero DOM changes", JSON.stringify(tx(env)) === JSON.stringify(nodesBefore4), tx(env).length);
  check("4 watcher stays on", r4.watching === true);

  /* ============ popup.js static contract ============ */
  console.log("\n---- popup.js gate contract ----");
  {
    const popup = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
    const start = popup.indexOf("const st = await sendToTab");
    const end = popup.indexOf("} catch (e) {", start);
    const block = popup.slice(start, end);
    const returns = (block.match(/\breturn;/g) || []).length;
    check("popup short-circuits exactly once", returns === 1, returns + " returns");
    check("popup short-circuit is on watching only", /status === "watching"[\s\S]{0,80}return;/.test(block));
    check("popup skips LAT_RESET for partial", /status === "partial"[\s\S]{0,140}skipReset = true/.test(block));
    check("popup skips LAT_RESET for translated", /status === "translated"[\s\S]{0,140}skipReset = true/.test(block));
    check("popup still sends TRANSLATE_PAGE after status gate", popup.indexOf('type: "TRANSLATE_PAGE"') > end);
  }

  /* ============ 5. partial does not loop: new DOM still translated, failed not retried ============ */
  console.log("\n---- 5. partial + new DOM (no retry loop) ----");
  env = makeDom();
  const p5 = env.send({ type: "TRANSLATE_PAGE" });
  await tick();
  env.resolveOldest("init", (t) => /Charlie/.test(t));   // Charlie fails
  await p5;
  await wait(300);
  check("5 partial after first pass", (await env.send({ type: "GET_STATUS" })).status === "partial");

  const reqsAfterPartial = env.requestCount();
  const d = env.doc.createElement("p");
  d.textContent = "Delta newly added block here";
  env.doc.getElementById("m").appendChild(d);

  const deltaInFlight = await pollUntil(() => env.pendingCount() === 1, DEBOUNCE + 3000);
  check("5 new DOM queued during partial", deltaInFlight, "pending=" + env.pendingCount());
  check("5 new DOM cost exactly one request", env.requestCount() === reqsAfterPartial + 1, env.requestCount());
  env.resolveOldest("dyn");                       // delta succeeds
  const deltaDone = await pollUntil(() => tx(env).some((t) => /Delta newly added/.test(t)), 2000);
  check("5 new DOM translated during partial", deltaDone, tx(env).join("|"));

  // hold still: failed anchor must NOT be retried by the watcher
  const stableReqs = env.requestCount();
  await wait(DEBOUNCE + 1200);
  check("5 failed record never auto-retried (no loop)", env.requestCount() === stableReqs, env.requestCount() - stableReqs + " extra");
  check("5 still partial (failed remains)", (await env.send({ type: "GET_STATUS" })).status === "partial");
  check("5 delta translated, charlie still not", tx(env).some((t) => /Delta/.test(t)) && !tx(env).some((t) => /Charlie/.test(t)));

  /* ============ 6. Restore clears partial ============ */
  console.log("\n---- 6. Restore clears partial ----");
  await env.send({ type: "RESTORE_PAGE" });
  st = await env.send({ type: "GET_STATUS" });
  check("6 restore -> idle", st.status === "idle", st.status);
  check("6 restore -> watching false", st.watching === false);
  check("6 restore removed all translations", tx(env).length === 0, tx(env).length);

  const failed = results.filter((x) => !x.pass);
  console.log("\n===== " + (failed.length ? "FAILED: " + failed.length : "ALL PASS") + " (" + results.length + " checks) =====");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
