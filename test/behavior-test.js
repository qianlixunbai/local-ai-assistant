/* Consolidated behavior tests for the real config.js/content.js in jsdom. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const EXT = path.resolve(__dirname, "..", "browser-extension");
const CONTENT_JS = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
const CONFIG_JS = fs.readFileSync(path.join(EXT, "config.js"), "utf8");
const DEBOUNCE = 750;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeEnv(html, options = {}) {
  const dom = new JSDOM(html, {
    url: "https://example.com/",
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  const { document } = window;

  window.Element.prototype.checkVisibility = function () {
    for (let el = this; el && el.nodeType === 1; el = el.parentElement) {
      if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
      if (el.style && el.style.display === "none") return false;
    }
    return true;
  };

  if (options.innerHeight !== undefined) {
    Object.defineProperty(window, "innerHeight", { value: options.innerHeight, configurable: true });
  }
  if (options.layout) {
    window.Element.prototype.getBoundingClientRect = function () {
      const rawTop = this.getAttribute && this.getAttribute("data-top");
      if (rawTop === null || rawTop === undefined) {
        return { top: 0, bottom: 0, left: 0, right: 100, width: 100, height: 0, x: 0, y: 0 };
      }
      const top = Number(rawTop);
      const height = Number(this.getAttribute("data-height") || 40);
      return { top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top };
    };
  }

  window.eval(CONFIG_JS);
  window.LOCAL_AI_CONFIG.dynamicTranslateEnabled = options.dynamic !== false;
  if (options.config) Object.assign(window.LOCAL_AI_CONFIG, options.config);

  const listeners = [];
  const requests = [];
  const pending = [];
  let autoRespond = options.autoRespond !== false;
  let responseFor = () => undefined;
  const logs = [];
  window.console.log = (...args) => logs.push(args.join(" "));
  window.console.warn = (...args) => logs.push(args.join(" "));
  window.console.error = (...args) => logs.push(args.join(" "));

  function defaultResponse(request, label = "译") {
    return {
      ok: true,
      results: request.msg.items.map((item) => ({
        id: item.id,
        translation: "【" + label + "】" + item.text
      }))
    };
  }

  function settle(request, outcome) {
    const index = pending.indexOf(request);
    if (index < 0) throw new Error("request is not pending");
    pending.splice(index, 1);
    if (outcome && outcome.reject) request.reject(outcome.reject);
    else request.resolve(outcome);
  }

  window.chrome = {
    runtime: {
      sendMessage(msg) {
        if (!msg || msg.type !== "TRANSLATE_BATCH") return Promise.resolve(undefined);

        let resolveRequest;
        let rejectRequest;
        const promise = new Promise((resolve, reject) => {
          resolveRequest = resolve;
          rejectRequest = reject;
        });
        const request = {
          msg,
          index: requests.length,
          resolve: resolveRequest,
          reject: rejectRequest
        };
        requests.push(request);
        pending.push(request);

        if (autoRespond) {
          Promise.resolve().then(() => {
            if (!pending.includes(request)) return;
            const custom = responseFor(request);
            settle(request, custom === undefined ? defaultResponse(request) : custom);
          });
        }
        return promise;
      },
      onMessage: { addListener: (listener) => listeners.push(listener) }
    }
  };

  function loadContentScript() {
    window.eval(CONTENT_JS);
  }
  loadContentScript();

  function latestListener() {
    const listener = listeners[listeners.length - 1];
    if (!listener) throw new Error("content script message listener is missing");
    return listener;
  }

  return {
    dom,
    window,
    document,
    requests,
    pending,
    logs,
    send(msg) {
      return new Promise((resolve) => latestListener()(msg, {}, resolve));
    },
    translate() {
      return this.send({ type: "TRANSLATE_PAGE" });
    },
    restore() {
      return this.send({ type: "RESTORE_PAGE" });
    },
    status() {
      return this.send({ type: "GET_STATUS" });
    },
    fillPage(texts) {
      const main = document.getElementById("main");
      if (!main) throw new Error("test page needs #main");
      main.replaceChildren();
      texts.forEach((text) => {
        const p = document.createElement("p");
        p.textContent = text;
        main.appendChild(p);
      });
    },
    addText(parent, text, tag = "p") {
      const node = document.createElement(tag);
      node.textContent = text;
      parent.appendChild(node);
      return node;
    },
    translations() {
      return [...document.querySelectorAll(".local-ai-translation")].map((node) => node.textContent);
    },
    sentTexts() {
      return requests.flatMap((request) => Array.from(request.msg.items, (item) => item.text));
    },
    requestTexts(request) {
      return Array.from(request.msg.items, (item) => item.text);
    },
    setAutoRespond(value) {
      autoRespond = value;
    },
    setResponseFor(fn) {
      responseFor = fn;
    },
    resolveRequest(request, label) {
      settle(request, defaultResponse(request, label));
    },
    rejectRequest(request, error = new Error("simulated transport failure")) {
      settle(request, { reject: error });
    },
    loadContentScript
  };
}

function pageWithTexts(texts) {
  return "<!doctype html><html><head><title>test</title></head><body>" +
    '<main id="main">' + texts.map((text) => "<p>" + text + "</p>").join("") + "</main>" +
    '<div id="feed"></div></body></html>';
}

async function pollUntil(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await wait(35);
  }
  return predicate();
}

const passed = [];
async function scenario(name, run) {
  await run();
  passed.push(name);
  console.log("PASS  " + name);
}

(async () => {
  await scenario("translation extracts useful main/footer text, preserves DOM, deduplicates, and restores", async () => {
    const env = makeEnv(`<!doctype html><html><head><title>test</title></head><body>
      <main id="main">
        <p id="inline">Welcome <span>to this</span> great workplace today.</p>
        <p>Save job</p><p>Save job</p>
        <a id="main-link" href="/jobs" target="_blank" rel="noopener">Browse jobs</a>
        <nav>Primary navigation</nav><aside>Sidebar advertisement</aside>
        <code>const hiddenCode = true;</code><div hidden>Hidden page content</div>
        <div aria-hidden="true">Screen reader hidden content</div>
      </main>
      <footer><h2>Job seekers</h2><a id="footer-link" href="/help" target="_blank" rel="noreferrer">Help centre</a><a href="/save">Save job</a></footer>
      <div id="feed"></div>
    </body></html>`);

    const result = await env.translate();
    assert.strictEqual(result.translated, 7, "records include grouped inline text, three duplicate records, and footer records");
    assert.deepStrictEqual(env.sentTexts().sort(), [
      "Welcome to this great workplace today.", "Save job", "Browse jobs", "Job seekers", "Help centre"
    ].sort(), "same-text records share one model item");
    assert.strictEqual(env.translations().length, 7);
    assert(env.translations().includes("【译】Welcome to this great workplace today."));
    assert(env.translations().includes("【译】Job seekers"));
    for (const excluded of ["Primary navigation", "Sidebar advertisement", "const hiddenCode", "Hidden page content", "Screen reader hidden content"]) {
      assert(!env.sentTexts().some((text) => text.includes(excluded)), excluded + " should be filtered");
    }

    const link = env.document.getElementById("main-link");
    const footerLink = env.document.getElementById("footer-link");
    assert.strictEqual(link.getAttribute("href"), "/jobs");
    assert.strictEqual(link.getAttribute("target"), "_blank");
    assert.strictEqual(link.getAttribute("rel"), "noopener");
    assert(link.textContent.startsWith("Browse jobs"), "the source link text remains present");
    assert.strictEqual(footerLink.getAttribute("href"), "/help");
    assert.strictEqual(footerLink.getAttribute("target"), "_blank");
    assert.strictEqual(footerLink.getAttribute("rel"), "noreferrer");

    const restored = await env.restore();
    assert.strictEqual(restored.removed, 7);
    assert.strictEqual(env.document.querySelectorAll(".local-ai-translation").length, 0);
    assert.strictEqual(env.document.querySelectorAll("[data-local-ai-source]").length, 0);
    assert.strictEqual(env.document.getElementById("inline").textContent, "Welcome to this great workplace today.");
    assert.strictEqual(link.textContent, "Browse jobs");
    env.dom.window.close();
  });

  await scenario("viewport priority overrides conflicting DOM order and stays stable within groups", async () => {
    const plan = [
      { tag: "F2", top: 2600 },
      { tag: "N2", top: 950 },
      { tag: "V2", top: 120 },
      { tag: "N1", top: -100 },
      { tag: "F1", top: -1800 },
      { tag: "V1", top: 500 },
      { tag: "F3", top: 4000 }
    ];
    const filler = "long page text used to keep each record distinct and eligible for translation";
    const html = '<!doctype html><html><body><main id="main">' + plan.map(({ tag, top }) =>
      `<p data-top="${top}" data-height="40">${tag} ${filler}</p>`
    ).join("") + '</main><div id="feed"></div></body></html>';
    const env = makeEnv(html, {
      layout: true,
      innerHeight: 800,
      config: { firstBatchCharLimit: 200, batchCharLimit: 300 }
    });

    const result = await env.translate();
    const tagOf = (text) => text.slice(0, text.indexOf(" "));
    assert.deepStrictEqual(Array.from(env.requests[0].msg.items).slice(0, 2).map((item) => tagOf(item.text)), ["V2", "V1"]);
    assert.deepStrictEqual(env.sentTexts().map(tagOf), ["V2", "V1", "N2", "N1", "F2", "F1", "F3"]);
    assert.strictEqual(result.translated, plan.length);
    assert.strictEqual(env.translations().length, plan.length);
    env.dom.window.close();
  });

  await scenario("initial catch-up, dynamic cache reuse, watcher stop, and re-arm work together", async () => {
    const env = makeEnv(pageWithTexts(["Initial page content block"]), { autoRespond: false });
    const initialRun = env.translate();
    assert(await pollUntil(() => env.pending.length === 1), "initial request starts");
    env.addText(env.document.getElementById("feed"), "Late arrival content block");
    env.resolveRequest(env.pending[0], "initial");
    await initialRun;

    assert(await pollUntil(() => env.pending.length === 1), "catch-up requests content added during the initial translation");
    assert.deepStrictEqual(env.requestTexts(env.pending[0]), ["Late arrival content block"]);
    env.resolveRequest(env.pending[0], "catchup");
    assert(await pollUntil(() => env.translations().some((text) => text === "【catchup】Late arrival content block")));
    assert.strictEqual((await env.status()).watching, true);

    const beforeDuplicate = env.requests.length;
    env.addText(env.document.getElementById("feed"), "Late arrival content block");
    assert(await pollUntil(() => env.translations().length === 3), "cached dynamic duplicate receives a translation");
    assert.strictEqual(env.requests.length, beforeDuplicate, "dynamic cache hit sends no model request");

    env.setAutoRespond(false);
    env.addText(env.document.getElementById("feed"), "Fresh dynamic content block");
    assert(await pollUntil(() => env.pending.length === 1), "new dynamic content starts one request");
    const inFlight = env.pending[0];
    env.addText(env.document.getElementById("feed"), "Another dynamic content block");
    await wait(DEBOUNCE + 120);
    assert.strictEqual(env.requests.length, beforeDuplicate + 1, "new content waits for the current request");
    env.resolveRequest(inFlight, "dynamic");
    assert(await pollUntil(() => env.pending.length === 1), "queued content starts after the current request");
    assert.deepStrictEqual(env.requestTexts(env.pending[0]), ["Another dynamic content block"]);
    env.resolveRequest(env.pending[0], "dynamic");
    assert(await pollUntil(() => env.translations().length === 5));
    await wait(DEBOUNCE + 120);
    assert.strictEqual(env.requests.length, beforeDuplicate + 2, "observer ignores its own inserted translation nodes");
    env.setAutoRespond(true);

    const restored = await env.restore();
    assert.strictEqual(restored.removed, 5);
    assert.strictEqual((await env.status()).watching, false);
    const beforeStoppedMutation = env.requests.length;
    env.addText(env.document.getElementById("feed"), "Added while restored");
    await wait(DEBOUNCE + 120);
    assert.strictEqual(env.requests.length, beforeStoppedMutation, "Restore stops automatic translation");
    assert.strictEqual(env.translations().length, 0);

    const retranslated = await env.translate();
    assert.strictEqual(retranslated.translated, 6);
    assert.strictEqual((await env.status()).watching, true, "Translate arms the watcher again");
    assert.deepStrictEqual(env.requestTexts(env.requests[beforeStoppedMutation]), ["Added while restored"],
      "previously translated text stays cached across Restore");
    const beforeRearmedMutation = env.requests.length;
    env.addText(env.document.getElementById("feed"), "Added after re-arm");
    assert(await pollUntil(() => env.requests.length === beforeRearmedMutation + 1));
    assert(await pollUntil(() => env.translations().length === 7));
    assert(env.sentTexts().includes("Added after re-arm"));
    env.dom.window.close();
  });

  await scenario("partial output retries only invalid records while new content still works", async () => {
    const env = makeEnv(pageWithTexts([
      "Alpha successful role", "Bravo successful role", "Empty response role", "Missing response role"
    ]));
    let firstRequest = true;
    env.setResponseFor((request) => {
      if (!firstRequest) return undefined;
      firstRequest = false;
      return {
        ok: true,
        results: request.msg.items
          .filter((item) => item.text !== "Missing response role")
          .map((item) => ({
            id: item.id,
            translation: item.text === "Empty response role" ? "   " : "【好】" + item.text
          }))
      };
    });

    const first = await env.translate();
    assert.strictEqual(first.translated, 2);
    assert.strictEqual(first.failed, 2, "blank and omitted results remain failures");
    assert.strictEqual((await env.status()).status, "partial");
    await wait(DEBOUNCE + 100);
    assert.strictEqual(env.requests.length, 1, "watcher does not automatically retry failed anchors");

    env.addText(env.document.getElementById("feed"), "Delta new role during partial");
    assert(await pollUntil(() => env.requests.length === 2), "new content is still translated during partial state");
    assert.deepStrictEqual(env.requestTexts(env.requests[1]), ["Delta new role during partial"]);
    assert(await pollUntil(() => env.translations().some((text) => text.includes("Delta new role during partial"))));
    const stableCount = env.requests.length;
    await wait(DEBOUNCE + 100);
    assert.strictEqual(env.requests.length, stableCount, "failed anchors stay out of dynamic catch-up loops");

    const retry = await env.translate();
    assert.strictEqual(env.requests.length, stableCount + 1);
    assert.deepStrictEqual(env.requestTexts(env.requests[stableCount]).sort(), [
      "Empty response role", "Missing response role"
    ].sort(), "successful initial and dynamic translations are not resent");
    assert.strictEqual(retry.translated, 2);
    assert.strictEqual(retry.failed, 0);
    assert.strictEqual(env.translations().length, 5);
    assert.strictEqual((await env.status()).status, "watching");
    env.dom.window.close();
  });

  await scenario("initial stale response cannot replace the current DOM or cached translation", async () => {
    const env = makeEnv(pageWithTexts(["Race condition role"]), { autoRespond: false });
    const staleRun = env.translate();
    assert(await pollUntil(() => env.pending.length === 1));
    const staleRequest = env.pending[0];

    await env.restore();
    const currentRun = env.translate();
    assert(await pollUntil(() => env.pending.length === 2));
    const currentRequest = env.pending.find((request) => request !== staleRequest);
    env.resolveRequest(currentRequest, "CURRENT");
    await currentRun;
    env.resolveRequest(staleRequest, "STALE");
    await staleRun;

    assert.deepStrictEqual(env.translations(), ["【CURRENT】Race condition role"]);
    assert.strictEqual((await env.status()).status, "watching");
    await env.restore();
    const sentBeforeHit = env.requests.length;
    const cached = await env.translate();
    assert.strictEqual(cached.translated, 1);
    assert.strictEqual(env.requests.length, sentBeforeHit, "stale response did not overwrite the successful cache entry");
    assert.deepStrictEqual(env.translations(), ["【CURRENT】Race condition role"]);
    env.dom.window.close();
  });

  await scenario("stale dynamic request after Restore cannot disrupt a newer translation", async () => {
    const env = makeEnv(pageWithTexts(["Stable initial content"]));
    await env.translate();
    await wait(80);
    env.setAutoRespond(false);
    env.addText(env.document.getElementById("feed"), "Dynamic stale content");
    assert(await pollUntil(() => env.pending.length === 1), "dynamic request is in flight");
    const staleDynamic = env.pending[0];
    assert.deepStrictEqual(env.requestTexts(staleDynamic), ["Dynamic stale content"]);

    await env.restore();
    const currentRun = env.translate();
    assert(await pollUntil(() => env.pending.length === 2));
    const currentDynamic = env.pending.find((request) => request !== staleDynamic);
    assert.deepStrictEqual(env.requestTexts(currentDynamic), ["Dynamic stale content"], "the stable text came from cache");
    env.resolveRequest(staleDynamic, "OLD");
    await wait(50);
    assert(env.pending.includes(currentDynamic), "late dynamic response leaves the new request alive");
    assert(!env.translations().some((text) => text.includes("【OLD】")));

    env.resolveRequest(currentDynamic, "NEW");
    await currentRun;
    assert(await pollUntil(() => env.translations().some((text) => text === "【NEW】Dynamic stale content")));
    assert.strictEqual((await env.status()).status, "watching");

    await env.restore();
    const beforeCacheCheck = env.requests.length;
    await env.translate();
    assert.strictEqual(env.requests.length, beforeCacheCheck, "only the current dynamic result is cached");
    assert.deepStrictEqual(env.translations().sort(), [
      "【译】Stable initial content", "【NEW】Dynamic stale content"
    ].sort());
    env.dom.window.close();
  });

  await scenario("content reinjection re-arms watching without repeating translated work", async () => {
    const first = makeEnv(pageWithTexts(["Existing translated content"]));
    await first.translate();
    const persistedHtml = first.document.body.innerHTML;
    first.dom.window.close();

    const env = makeEnv("<!doctype html><html><head><title>test</title></head><body>" + persistedHtml + "</body></html>");
    assert.strictEqual(env.translations().length, 1);
    assert.strictEqual((await env.status()).status, "translated");
    assert.strictEqual((await env.status()).watching, false);

    const before = env.requests.length;
    const again = await env.translate();
    assert.strictEqual(again.alreadyTranslated, true);
    assert.strictEqual(again.watching, true);
    assert.strictEqual(env.requests.length, before);
    assert.strictEqual(env.translations().length, 1);

    env.addText(env.document.getElementById("feed"), "New content after reinjection");
    assert(await pollUntil(() => env.requests.length === before + 1), "re-armed watcher sends a request");
    assert(await pollUntil(() => env.translations().length === 2));
    assert(env.translations().some((text) => text.includes("New content after reinjection")));
    env.dom.window.close();
  });

  await scenario("same-batch cache fan-out and cross-batch reuse preserve original record counts", async () => {
    const duplicateEnv = makeEnv(pageWithTexts(["Save job", "Unique job role", "Save job"]));
    const duplicateResult = await duplicateEnv.translate();
    assert.deepStrictEqual(duplicateEnv.sentTexts().sort(), ["Save job", "Unique job role"].sort());
    assert.strictEqual(duplicateEnv.translations().length, 3);
    assert.strictEqual(duplicateResult.translated, 3);
    duplicateEnv.dom.window.close();

    const repeated = "Senior backend engineer";
    const batchedEnv = makeEnv(pageWithTexts([repeated, "Customer support analyst", repeated]), {
      dynamic: false,
      config: { firstBatchCharLimit: 24, batchCharLimit: 30 }
    });
    const result = await batchedEnv.translate();
    assert.strictEqual(result.translated, 3);
    assert.deepStrictEqual(batchedEnv.sentTexts(), [repeated, "Customer support analyst"],
      "the repeated record in a later batch reuses the first batch result");
    await batchedEnv.restore();
    await batchedEnv.send({ type: "LAT_RESET" });
    const beforeFullHit = batchedEnv.requests.length;
    const fullHit = await batchedEnv.translate();
    assert.strictEqual(fullHit.translated, 3);
    assert.strictEqual(batchedEnv.requests.length, beforeFullHit, "Restore and LAT_RESET preserve successful entries");
    assert.strictEqual(batchedEnv.translations().length, 3);
    batchedEnv.dom.window.close();
  });

  await scenario("transport failures stay uncached for an explicit retry", async () => {
    const failedEnv = makeEnv(pageWithTexts(["Retry after transport failure"]), { dynamic: false });
    let failFirst = true;
    failedEnv.setResponseFor(() => {
      if (!failFirst) return undefined;
      failFirst = false;
      return { reject: new Error("simulated HTTP failure") };
    });
    const first = await failedEnv.translate();
    assert.strictEqual(first.translated, 0);
    assert.strictEqual(first.failed, 1);
    await failedEnv.restore();
    const beforeRetry = failedEnv.requests.length;
    const retry = await failedEnv.translate();
    assert.strictEqual(failedEnv.requests.length, beforeRetry + 1, "transport failure is not cached");
    assert.strictEqual(retry.translated, 1);
    failedEnv.dom.window.close();
  });

  await scenario("bounded cache evicts its least recently used entry", async () => {
    const lruEnv = makeEnv(pageWithTexts(["Alpha role", "Bravo role"]), {
      dynamic: false,
      config: { translationCacheMaxEntries: 2 }
    });
    await lruEnv.translate(); // A, B
    await lruEnv.restore();
    lruEnv.fillPage(["Alpha role"]); // touch A so B becomes oldest
    await lruEnv.translate();
    await lruEnv.restore();
    lruEnv.fillPage(["Charlie role"]); // insert C and evict B
    await lruEnv.translate();
    await lruEnv.restore();
    lruEnv.fillPage(["Bravo role"]);
    const beforeEvictedLookup = lruEnv.requests.length;
    await lruEnv.translate();
    assert.strictEqual(lruEnv.requests.length, beforeEvictedLookup + 1);
    assert.deepStrictEqual(lruEnv.requestTexts(lruEnv.requests[beforeEvictedLookup]), ["Bravo role"]);
    assert.deepStrictEqual(lruEnv.translations(), ["【译】Bravo role"]);
    lruEnv.dom.window.close();
  });

  console.log("\n===== ALL PASS (" + passed.length + " behavior scenarios) =====");
  process.exit(0);
})().catch((error) => {
  console.error("\n===== BEHAVIOR TEST FAILED =====");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
