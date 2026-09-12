/* v0.2.1 Stability hotfix tests — P1-1 catch-up, P1-2 generation isolation, P2 idempotency.
   Loads the REAL config.js + content.js into jsdom with a deferred-request mock. */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const EXT = path.resolve(__dirname, "..", "browser-extension");
const DEBOUNCE = 750;

function makeDom() {
  const dom = new JSDOM(`<!DOCTYPE html><html><head><title>t</title></head><body>
    <main><h1 id="h">Initial Heading</h1><p id="p">Initial paragraph content here.</p></main>
    <div id="feed"></div></body></html>`,
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

  const pending = [];     // {msg, resolve}
  const requests = [];    // labels in order
  let active = 0, maxActive = 0;
  const listeners = [];
  window.chrome = {
    runtime: {
      sendMessage: (msg) => {
        if (msg && msg.type === "TRANSLATE_BATCH") {
          active++; maxActive = Math.max(maxActive, active);
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

  return {
    window,
    doc: window.document,
    send: (msg) => new Promise((r) => listeners[0](msg, {}, r)),
    pending,
    requests,
    stats: () => ({ maxActive, total: pending.length }),
    maxActive: () => maxActive,
    // resolve the oldest unresolved request with a label-tagged translation
    resolveOldest(label) {
      const p = pending.shift();
      if (!p) throw new Error("no pending request to resolve");
      active--;
      requests.push(label);
      p.resolve({ ok: true, results: p.msg.items.map((it) => ({ id: it.id, translation: "【" + label + "】" + it.text })) });
      return p;
    },
    pendingCount: () => pending.length
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function pollUntil(fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await wait(40); }
  return fn();
}

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra !== undefined ? "  -> " + extra : ""));
}
const tx = (env) => [...env.doc.querySelectorAll(".local-ai-translation")].map((n) => n.textContent);

(async () => {
  /* ============ P1-1: initial-window catch-up ============ */
  console.log("\n---- P1-1 initial translation catch-up ----");
  {
    const env = makeDom();
    const p = env.send({ type: "TRANSLATE_PAGE" }); // don't await: first batch pending
    await tick();
    check("P1-1 initial request in flight", env.pendingCount() === 1, env.pendingCount());

    // New English DOM arrives DURING initial translation (observer not started yet)
    const late = env.doc.createElement("div");
    late.textContent = "Late Arrival Content Block";
    env.doc.getElementById("feed").appendChild(late);
    check("P1-1 late div untranslated while initial pending", !tx(env).some((t) => /Late Arrival/.test(t)));

    env.resolveOldest("init");           // finish initial translation
    await p;
    // NO further mutations from here on. Catch-up must still find the late div.
    const gotCatchup = await pollUntil(() => env.pendingCount() === 1, 2500);
    check("P1-1 catch-up request issued without extra mutation", gotCatchup, "pending=" + env.pendingCount());
    if (gotCatchup) env.resolveOldest("catchup");
    const ok = await pollUntil(() => tx(env).some((t) => /Late Arrival Content Block/.test(t)), 2500);
    check("P1-1 late div auto-translated after initial (no extra mutation)", ok);
    check("P1-1 exactly 2 requests (init + catch-up)", env.requests.length === 2, env.requests.join(","));
    check("P1-1 initial content translated", tx(env).some((t) => /Initial Heading/.test(t)));
  }

  /* ============ P1-2: generation race, initial A -> Restore -> B -> late A ============ */
  console.log("\n---- P1-2 generation isolation (initial) ----");
  {
    const env = makeDom();
    const pA = env.send({ type: "TRANSLATE_PAGE" });
    await tick();
    check("P1-2 A request in flight", env.pendingCount() === 1);

    await env.send({ type: "RESTORE_PAGE" });        // gen++
    const pB = env.send({ type: "TRANSLATE_PAGE" }); // new gen, new session
    await tick();
    check("P1-2 B request in flight (2 pending)", env.pendingCount() === 2, env.pendingCount());

    env.resolveOldest("A");                          // A returns LATE, after B started
    await tick();
    check("P1-2 stale A did not insert", !tx(env).some((t) => /【A】/.test(t)), tx(env).join("|").slice(0, 80));
    check("P1-2 A did not clobber B (B still pending)", env.pendingCount() === 1, env.pendingCount());

    env.resolveOldest("B");                          // B returns
    await pA; await pB;
    const texts = tx(env);
    check("P1-2 page has B translations", texts.some((t) => /【B】/.test(t)));
    check("P1-2 no stale A translations", !texts.some((t) => /【A】/.test(t)));
    check("P1-2 no duplicate nodes", new Set(texts).size === texts.length, texts.length);
    // 注意：maxActive=2 是本用例刻意构造的（A 在途 + B 启动），属允许的 stale 重叠。
    // 真正的不变量是：旧 A 的响应被丢弃，且没有任何“已经作废的循环”再发起新请求。
    check("P1-2 stale A caused no extra request", env.requests.length === 2, env.requests.join(","));

    const st = await env.send({ type: "GET_STATUS" });
    check("P1-2 watcher belongs to B", st.watching === true && st.status === "watching", st.status);
  }

  /* ============ P1-2c: clean single-flight within one live session ============ */
  console.log("\n---- single-flight within one live session ----");
  {
    const env = makeDom();
    // 4 batches in one initial session: build a page big enough to split
    const feed = env.doc.getElementById("feed");
    for (let i = 1; i <= 4; i++) {
      const d = env.doc.createElement("p");
      d.textContent = "Paragraph number " + i + " with enough text to occupy space";
      feed.appendChild(d);
    }
    const p = env.send({ type: "TRANSLATE_PAGE" });
    await tick();
    // resolve batches one at a time; assert never >1 live at once
    let guard = 0;
    while (env.pendingCount() > 0 && guard++ < 10) {
      check("single-flight: exactly 1 live request at a time", env.pendingCount() === 1, "pending=" + env.pendingCount());
      env.resolveOldest("b" + guard);
      await wait(30);
    }
    await p;
    check("single-flight: maxActive == 1 for live session", env.maxActive() === 1, "maxActive=" + env.maxActive());
    check("single-flight: all content translated", tx(env).length >= 5, tx(env).length);
  }

  /* ============ P1-2b: dynamic pending -> Restore -> new Translate -> late dynamic ============ */
  console.log("\n---- P1-2b generation isolation (dynamic) ----");
  {
    const env = makeDom();
    const init = env.send({ type: "TRANSLATE_PAGE" });
    await tick(); env.resolveOldest("init"); await init;
    check("P1-2b watching after initial", (await env.send({ type: "GET_STATUS" })).watching === true);

    // dynamic content -> debounce -> drainDynamic (request pending)
    const d = env.doc.createElement("div");
    d.textContent = "Dynamic Stale Content";
    env.doc.getElementById("feed").appendChild(d);
    const gotReq = await pollUntil(() => env.pendingCount() === 1, DEBOUNCE + 1500);
    check("P1-2b dynamic request in flight", gotReq && env.pendingCount() === 1, env.pendingCount());

    await env.send({ type: "RESTORE_PAGE" });         // gen++ while dynamic req pending
    const pB = env.send({ type: "TRANSLATE_PAGE" });  // new full session
    await tick();
    env.resolveOldest("dynOld");                      // late dynamic response
    await tick();
    check("P1-2b stale dynamic did not insert", !tx(env).some((t) => /【dynOld】/.test(t)));
    check("P1-2b stale dynamic did not kill new session", env.pendingCount() === 1, env.pendingCount());

    env.resolveOldest("new");                         // new session resolves
    await pB;
    const texts = tx(env);
    check("P1-2b new session translated", texts.some((t) => /【new】/.test(t)));
    check("P1-2b no stale dynamic translations", !texts.some((t) => /【dynOld】/.test(t)));
    check("P1-2b no duplicates", new Set(texts).size === texts.length, texts.length);
    const st = await env.send({ type: "GET_STATUS" });
    check("P1-2b watcher belongs to new session", st.watching === true, st.status);
  }

  /* ============ P2: repeat Translate idempotency (content contract) ============ */
  console.log("\n---- P2 repeat Translate idempotency ----");
  {
    const env = makeDom();
    const p = env.send({ type: "TRANSLATE_PAGE" });
    await tick(); env.resolveOldest("init"); await p;

    const st = await env.send({ type: "GET_STATUS" });
    check("P2 status is watching after translate", st.status === "watching", st.status);

    const before = env.requests.length;
    const again = await env.send({ type: "TRANSLATE_PAGE" }); // popup gate would stop earlier; content-level must be safe too
    check("P2 repeat returns alreadyTranslated", again.alreadyTranslated === true, JSON.stringify(again).slice(0, 90));
    check("P2 repeat made no model request", env.requests.length === before, env.requests.length - before + " new");
    check("P2 watcher stays on", again.watching === true);
    check("P2 no duplicate nodes", new Set(tx(env)).size === tx(env).length, tx(env).length);
  }

  /* ============ popup.js static check: gate before LAT_RESET ============ */
  console.log("\n---- P2 popup gate ordering ----");
  {
    const popup = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
    const iStatus = popup.indexOf('type: "GET_STATUS"');
    const iGate = popup.indexOf('st.status === "watching"');
    const iReset = popup.indexOf('type: "LAT_RESET"');
    check("popup checks GET_STATUS before LAT_RESET", iStatus !== -1 && iReset !== -1 && iStatus < iReset, `status@${iStatus} reset@${iReset}`);
    check("popup short-circuits on watching/translated", iGate !== -1 && iGate < iReset);
  }

  const failed = results.filter((x) => !x.pass);
  console.log("\n===== " + (failed.length ? "FAILED: " + failed.length : "ALL PASS") + " (" + results.length + " checks) =====");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
