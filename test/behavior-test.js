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
  window.TextEncoder = TextEncoder;

  // jsdom leaves overflow shorthand unexpanded in computed overflowX/Y.
  // Supply the axis values a browser CSSOM reports for these layout fixtures.
  const computedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (el) => {
    const style = computedStyle(el);
    return new Proxy(style, { get(target, property) {
      if ((property === "overflowX" || property === "overflowY") &&
          el.style.overflow && !el.style[property]) return el.style.overflow;
      return target[property];
    } });
  };

  window.Element.prototype.checkVisibility = function (settings = {}) {
    if (["hidden", "collapse"].includes(window.getComputedStyle(this).visibility)) return false;
    for (let el = this; el && el.nodeType === 1; el = el.parentElement) {
      if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
      if (el.style && el.style.display === "none") return false;
      if (settings.checkOpacity && el.style.opacity === "0") return false;
      if (el.tagName === "DETAILS" && !el.hasAttribute("open") && this !== el &&
          !(el.querySelector("summary") && el.querySelector("summary").contains(this))) return false;
    }
    return true;
  };

  if (options.innerHeight !== undefined) {
    Object.defineProperty(window, "innerHeight", { value: options.innerHeight, configurable: true });
  }
  // jsdom has no layout engine. Model browser-reported geometry, including
  // non-bubbling scroll changes, without injecting helpers into production code.
  window.Element.prototype.getBoundingClientRect = function () {
    let top = Number(this.getAttribute("data-top") || 0);
    let left = Number(this.getAttribute("data-left") || 0);
    for (let ancestor = this.parentElement; ancestor; ancestor = ancestor.parentElement) {
      top -= ancestor.scrollTop;
      left -= ancestor.scrollLeft;
    }
    const height = Number(this.getAttribute("data-height") || 40);
    const width = Number(this.getAttribute("data-width") || 100);
    return { top, bottom: top + height, left, right: left + width, width, height, x: left, y: top };
  };
  window.Element.prototype.getClientRects = function () {
    return this.checkVisibility ? (this.checkVisibility({ checkOpacity: true }) ? [this.getBoundingClientRect()] : []) :
      (this.style.display === "none" ? [] : [this.getBoundingClientRect()]);
  };
  for (const [property, attribute, fallback] of [
    ["clientWidth", "data-client-width", "data-width"], ["clientHeight", "data-client-height", "data-height"],
    ["offsetWidth", "data-width", "data-width"], ["offsetHeight", "data-height", "data-height"],
    ["clientLeft", "data-client-left", null], ["clientTop", "data-client-top", null]
  ]) {
    Object.defineProperty(window.Element.prototype, property, { configurable: true, get() {
      return Number(this.getAttribute(attribute) ?? (fallback ? this.getAttribute(fallback) : null) ??
        (property.endsWith("Width") ? 100 : property.endsWith("Height") ? 40 : 0));
    } });
  }
  window.Range.prototype.getClientRects = function () {
    if (options.textRects) return options.textRects(this.startContainer);
    return this.startContainer.parentElement.getClientRects();
  };
  if (options.visibilityFallback) delete window.Element.prototype.checkVisibility;

  window.eval(CONFIG_JS);
  window.LOCAL_AI_CONFIG.dynamicTranslateEnabled = options.dynamic !== false;
  if (options.config) Object.assign(window.LOCAL_AI_CONFIG, options.config);

  const listeners = [];
  const requests = [];
  const pending = [];
  const progressEvents = [];
  let autoRespond = options.autoRespond !== false;
  let responseFor = () => undefined;
  let connection = { ok: true, paired: true, pairing: "paired", online: true, available: true };
  const logs = [];
  window.console.log = (...args) => logs.push(args.join(" "));
  window.console.warn = (...args) => logs.push(args.join(" "));
  window.console.error = (...args) => logs.push(args.join(" "));

  function defaultResponse(request, label = "译") {
    return {
      ok: true,
      identity: { profile: { id: "translate.fast", version: "m0-1", locality: "LOCAL" }, promptVersion: "translate-batch-v1" },
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
        if (msg && msg.type === "CHECK_CONNECTION") return Promise.resolve(connection);
        if (msg && msg.type === "TRANSLATION_PROGRESS") progressEvents.push(msg.progress);
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
            settle(request, custom === undefined ? defaultResponse(request) :
              { identity: defaultResponse(request).identity, ...custom });
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
    progressEvents,
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
    setConnection(value) { connection = value; },
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
  await scenario("B13 sticky sidebar sends visible text and catches non-bubbling container scroll", async () => {
    const env = makeEnv('<main><p>Ordinary document content.</p></main>' +
      '<aside style="position:sticky;top:0"><nav role="navigation" id="scroller" style="overflow-y:auto" data-top="50" data-height="180">' +
      '<ul><li data-top="80"><a id="guide" href="/guide" target="_blank">Grammar and types</a></li>' +
      '<li data-top="180">Partially visible sidebar item</li>' +
      '<li id="later" data-top="300">Functions and iteration</li></ul></nav></aside>', { layout: true, innerHeight: 600 });
    // The browser reports the inline link at the same position as its list item.
    env.document.getElementById("guide").setAttribute("data-top", "80");
    const scroller = env.document.getElementById("scroller");
    scroller.dispatchEvent(new env.window.Event("scroll"));
    await wait(30);
    assert.strictEqual(env.requests.length, 0, "scroll does not translate before user activation");
    await env.translate();
    await wait(60);
    assert.deepStrictEqual(env.sentTexts().sort(), [
      "Ordinary document content.", "Grammar and types", "Partially visible sidebar item"
    ].sort());
    const completed = env.document.getElementById("guide").parentElement.querySelector(".local-ai-translation");
    assert(completed, "visible navigation is translated via normal anchor insertion");
    const before = env.requests.length;
    scroller.scrollTop = 200;
    scroller.dispatchEvent(new env.window.Event("scroll", { bubbles: false }));
    assert(await pollUntil(() => env.sentTexts().includes("Functions and iteration")), "captured container scroll triggers catch-up without a DOM mutation");
    assert(await pollUntil(() => env.translations().length === 4));
    assert.strictEqual(env.requests.length, before + 1);
    assert.strictEqual(env.document.getElementById("guide").parentElement.querySelector(".local-ai-translation"), completed,
      "scrolling a completed source out of view preserves its translation identity");
    assert.strictEqual(env.document.getElementById("guide").getAttribute("href"), "/guide");
    assert.strictEqual(env.document.getElementById("guide").getAttribute("target"), "_blank");
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new env.window.Event("scroll"));
    await wait(DEBOUNCE + 100);
    assert.strictEqual(env.requests.length, before + 1, "returning to completed items does not resend them");
    await env.restore();
    const stopped = env.requests.length;
    scroller.scrollTop = 200;
    scroller.dispatchEvent(new env.window.Event("scroll"));
    await wait(DEBOUNCE + 100);
    assert.strictEqual(env.requests.length, stopped, "Restore removes the scroll listener");
    await env.translate();
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new env.window.Event("scroll"));
    assert(await pollUntil(() => env.translations().includes("【译】Grammar and types")), "Translate re-arms scroll catch-up and reuses cache");
    assert.strictEqual(env.requests.length, stopped);
    env.dom.window.close();
  });

  await scenario("B13 clipping, viewport intersection, fixed/sidebar/nav and hidden exclusion", async () => {
    const env = makeEnv('<main>' +
      '<div style="overflow:hidden" data-top="100" data-left="20" data-width="200" data-height="150" data-client-left="5" data-client-top="5" data-client-width="180" data-client-height="130">' +
      '<div style="overflow-y:scroll" data-top="80" data-height="220" data-width="300">' +
      '<p data-top="120" data-left="50">Visible nested ordinary text</p>' +
      '<p data-top="80" data-left="50" data-height="20">Clipped by outer ancestor</p>' +
      '<p data-top="180" data-left="210" data-width="10">Clipped by horizontal client box</p>' +
      '<p data-top="170" data-left="198" data-width="20">Partly visible on horizontal edge</p>' +
      '<p data-top="235" data-left="50">Touching client edge has no area</p>' +
      '</div></div>' +
      '<div style="overflow:clip" data-top="50" data-height="50"><p data-top="110">Clipped shorthand text</p></div>' +
      '<div style="overflow-x:clip;overflow-y:visible" data-width="200" data-height="20"><p data-top="300">Visible outside un-clipped axis</p></div>' +
      '<div style="overflow:auto" data-top="500" data-height="200"><p data-top="650">Outside document viewport</p></div>' +
      '<div style="overflow:hidden" data-height="60"><p data-top="-20" data-height="40">Partial viewport intersection</p></div>' +
      '<div style="overflow:hidden;display:contents"><p data-top="400">Display contents does not clip</p></div>' +
      '<p data-top="1600">Offscreen document body stays eligible</p>' +
      '<aside style="position:fixed"><p data-top="20">Fixed sidebar text</p><p data-top="900">Offscreen fixed sidebar text</p></aside>' +
      '<div role="navigation"><p data-top="40">ARIA navigation text</p><p data-left="2000">Offscreen horizontal navigation text</p></div>' +
      '<nav hidden><p>Hidden navigation text</p></nav><aside aria-hidden="true"><p>ARIA hidden sidebar text</p></aside></main>', { layout: true, innerHeight: 600, dynamic: false });
    await env.translate();
    assert.deepStrictEqual(env.sentTexts().sort(), [
      "Visible nested ordinary text", "Partly visible on horizontal edge", "Visible outside un-clipped axis",
      "Partial viewport intersection", "Display contents does not clip", "Offscreen document body stays eligible",
      "Fixed sidebar text", "ARIA navigation text"
    ].sort(), "nested visibility differs from viewport-priority ordering for ordinary document text");
    env.dom.window.close();
  });

  await scenario("B13 BR range geometry excludes clipped inline and catches exposed lines and dynamic content", async () => {
    const positions = { "Visible first BR line.": 80, "Clipped second BR line.": 280 };
    const env = makeEnv('<div id="scroller" style="overflow:auto" data-top="50" data-height="130">' +
      '<div id="lines" data-top="50" data-height="400">Visible first BR line.<br>Clipped second BR line.</div>' +
      '<p data-top="80" data-height="300"><span data-top="100">Visible aggregate words.</span>' +
      '<span data-top="230">Initially clipped aggregate words.</span><span hidden>Hidden inline secret.</span></p></div>', {
      layout: true,
      textRects(node) {
        const top = positions[node.nodeValue];
        if (top === undefined) return node.parentElement.getClientRects();
        const offset = node.ownerDocument.getElementById("scroller").scrollTop;
        return [{ top: top - offset, bottom: top - offset + 25, left: 10, right: 90 }];
      }
    });
    await env.translate();
    assert.deepStrictEqual(env.sentTexts().sort(), ["Visible first BR line.", "Visible aggregate words."].sort(),
      "text range, rather than the shared BR container rect, determines line eligibility");
    const scroller = env.document.getElementById("scroller");
    scroller.scrollTop = 170;
    scroller.dispatchEvent(new env.window.Event("scroll"));
    assert(await pollUntil(() => env.translations().includes("【译】Clipped second BR line.")));
    assert(await pollUntil(() => env.translations().includes("【译】Initially clipped aggregate words.")),
      "newly exposed inline source refreshes an aggregate owned by the same anchor");
    assert.strictEqual(env.sentTexts().filter(text => text === "Visible first BR line.").length, 1);
    assert(!env.sentTexts().some(text => text.includes("Hidden inline secret")));
    const added = env.document.createElement("p");
    added.setAttribute("data-top", "260");
    added.textContent = "Dynamic nested container content.";
    scroller.appendChild(added);
    assert(await pollUntil(() => env.translations().includes("【译】Dynamic nested container content.")));
    await env.restore();
    assert.strictEqual(env.document.getElementById("lines").innerHTML, "Visible first BR line.<br>Clipped second BR line.");
    env.dom.window.close();
  });

  await scenario("B13 nested privacy boundaries survive native and fallback visibility and explicit selection", async () => {
    for (const visibilityFallback of [false, true]) {
      const env = makeEnv('<nav style="overflow:auto" data-height="500">' +
        '<p>Visible words <span style="visibility:hidden">Visibility hidden secret</span>' +
        '<span style="display:none">Display hidden secret</span><span style="opacity:0">Opacity hidden secret</span> remain readable.</p>' +
        '<div style="opacity:0"><p>Ancestor opacity secret</p></div>' +
        '<div aria-hidden="true"><p>ARIA hidden secret</p></div><p hidden>Hidden attribute secret</p>' +
        '<div contenteditable="true"><p>Editable draft secret</p></div><div contenteditable="plaintext-only">Plaintext editor secret</div>' +
        '<pre>Preformatted code secret</pre><code>Inline code secret</code>' +
        '<div>Visible BR words <span style="visibility:hidden">BR hidden secret</span><br>Visible second line.</div></nav>',
      { visibilityFallback, dynamic: false });
      await env.translate();
      assert.deepStrictEqual(env.sentTexts().sort(), ["Visible words remain readable.", "Visible BR words", "Visible second line."].sort());
      await env.send({ type: "TRANSLATE_SELECTION", selectionText: "Editable draft secret" });
      assert(env.document.querySelector(".local-ai-selection-card").textContent.includes("【译】Editable draft secret"));
      await env.restore();
      env.document.designMode = "on";
      const before = env.requests.length;
      await env.translate();
      assert.strictEqual(env.requests.length, before, "designMode still excludes the whole nested page");
      env.dom.window.close();
    }
    const collapsed = makeEnv('<nav><details><summary>Visible collapsed heading</summary><p>Collapsed secret content</p></details></nav>', { dynamic: false });
    await collapsed.translate();
    assert.deepStrictEqual(collapsed.sentTexts(), ["Visible collapsed heading"]);
    collapsed.dom.window.close();
  });

  await scenario("ordinary multi-record anchor preserves partial retry and interleaved source order", async () => {
    const env = makeEnv('<main><p id="source"><span>Alpha original segment.</span> <strong>Bravo original segment.</strong></p></main>',
      { config: { recordCharLimit: 25 } });
    env.setResponseFor((request) => request.index === 0 ? {
      ok: true, results: [{ id: request.msg.items[0].id, translation: "中文 A" }]
    } : undefined);
    const first = await env.translate();
    assert.strictEqual(first.translated, 1);
    assert.strictEqual(first.failed, 1);
    assert.strictEqual((await env.status()).status, "partial");
    await wait(DEBOUNCE + 100);
    assert.strictEqual(env.requests.length, 1, "catch-up must not retry the failed sibling segment");
    assert(!env.document.getElementById("source").hasAttribute("data-local-ai-source"));
    await env.translate();
    assert.deepStrictEqual(env.requestTexts(env.requests[1]), ["Bravo original segment."]);
    assert.strictEqual((await env.status()).status, "watching");
    const p = env.document.getElementById("source");
    const a = p.querySelector("span").firstChild;
    const b = p.querySelector("strong").firstChild;
    assert.strictEqual(a.nextSibling.textContent, "中文 A");
    assert.strictEqual(b.nextSibling.textContent, "【译】Bravo original segment.");
    assert(a.nextSibling.compareDocumentPosition(b) & env.window.Node.DOCUMENT_POSITION_FOLLOWING);
    await env.restore();
    assert.strictEqual(p.textContent, "Alpha original segment. Bravo original segment.");
    await env.translate();
    assert.strictEqual(env.requests.length, 2, "both successful segments remain reusable from cache");
    assert.deepStrictEqual(env.translations(), ["中文 A", "【译】Bravo original segment."]);
    env.dom.window.close();
  });

  await scenario("source replacement discards in-flight output and invalidates completed text and BR records", async () => {
    const env = makeEnv('<main><p id="source">Alpha source before update.</p><div id="lines">First BR source.<br>Second BR source.</div></main>',
      { autoRespond: false });
    const run = env.translate();
    assert(await pollUntil(() => env.pending.length === 1));
    const p = env.document.getElementById("source");
    p.textContent = "Bravo replacement source.";
    env.resolveRequest(env.pending[0]);
    await run;
    assert(!env.translations().some((text) => text.includes("Alpha source")));
    assert(await pollUntil(() => env.pending.length === 1), "catch-up recollects the replacement source");
    assert.deepStrictEqual(env.requestTexts(env.pending[0]), ["Bravo replacement source."]);
    env.resolveRequest(env.pending[0]);
    assert(await pollUntil(() => env.translations().length === 3));
    p.textContent = "Charlie updated source.";
    await wait(0);
    assert(!env.translations().some((text) => text.includes("Bravo replacement")), "childList replacement removes old sibling translation");
    assert(!p.hasAttribute("data-local-ai-source"));
    assert(await pollUntil(() => env.pending.length === 1));
    env.resolveRequest(env.pending[0]);
    assert(await pollUntil(() => env.translations().some((text) => text.includes("Charlie updated"))));
    p.firstChild.nodeValue = "Delta character data update.";
    const lines = env.document.getElementById("lines");
    lines.firstChild.nodeValue = "Changed first BR source.";
    await wait(0);
    assert(!env.translations().some((text) => text.includes("Charlie updated") || text.includes("First BR source")));
    assert(await pollUntil(() => env.pending.length === 1));
    assert.deepStrictEqual(env.requestTexts(env.pending[0]).sort(), ["Delta character data update.", "Changed first BR source."].sort());
    env.resolveRequest(env.pending[0]);
    assert(await pollUntil(() => env.translations().length === 3));
    await wait(DEBOUNCE + 100);
    assert.strictEqual(env.requests.length, 4, "plugin mutations do not create a translation feedback loop");
    env.dom.window.close();
  });

  await scenario("rescans reveal hidden content without sending hidden inline or editable text", async () => {
    const env = makeEnv('<main><p>Visible words <span id="inline-reveal" style="display:none">Revealed inline words.</span><span>stay grouped.</span></p>' +
      '<p id="expand" style="display:none">Expanded English paragraph.</p>' +
      '<div contenteditable="true"><p>Editable draft secret.</p><p contenteditable="false">Read only island.</p></div>' +
      '<div contenteditable="plaintext-only">Plaintext editor secret.</div>' +
      '<div>Visible BR words <span hidden>hidden BR secret</span><br>Second visible line.</div></main>');
    await env.translate();
    assert(env.sentTexts().includes("Visible words stay grouped."));
    assert(env.sentTexts().includes("Read only island."));
    assert(!env.sentTexts().some((text) => /secret|Expanded|Revealed/.test(text)));
    env.document.getElementById("expand").style.display = "block";
    env.document.getElementById("inline-reveal").style.display = "inline";
    assert(await pollUntil(() => env.sentTexts().includes("Expanded English paragraph.")));
    assert(env.sentTexts().includes("Visible words Revealed inline words. stay grouped."), "newly visible inline content invalidates the earlier aggregate");
    assert(await pollUntil(() => env.translations().some(text => text.includes("Revealed inline words."))), "revealed source receives refreshed translation");
    assert(!env.translations().includes("【译】Visible words stay grouped."), "reveal removes the obsolete source translation");
    assert(!env.sentTexts().some(text => /secret/.test(text)), "dynamic rescan still excludes hidden/editable text");
    env.dom.window.close();
  });

  await scenario("BR segment source additions invalidate both in-flight and completed translations", async () => {
    const env = makeEnv('<div id="article"><strong>Original BR segment.</strong><br>Stable following segment.</div>',
      { autoRespond: false });
    const article = env.document.getElementById("article");
    const first = env.translate();
    assert(await pollUntil(() => env.pending.length === 1));
    article.insertBefore(env.document.createTextNode("New words in the same segment."), article.querySelector("br"));
    env.resolveRequest(env.pending[0]);
    await first;
    assert.deepStrictEqual(env.translations(), ["【译】Stable following segment."]);
    assert(await pollUntil(() => env.pending.length === 1));
    assert.deepStrictEqual(env.requestTexts(env.pending[0]), ["Original BR segment. New words in the same segment."]);
    env.resolveRequest(env.pending[0]);
    assert(await pollUntil(() => env.translations().length === 2));
    article.querySelector("strong").appendChild(env.document.createTextNode("Added inside the original element."));
    await wait(0);
    assert.deepStrictEqual(env.translations(), ["【译】Stable following segment."]);
    assert(await pollUntil(() => env.pending.length === 1));
    assert.deepStrictEqual(env.requestTexts(env.pending[0]),
      ["Original BR segment. Added inside the original element. New words in the same segment."]);
    env.resolveRequest(env.pending[0]);
    assert(await pollUntil(() => env.translations().length === 2));
    env.dom.window.close();
  });

  await scenario("malformed response IDs stay missing and cannot poison cached results", async () => {
    const env = makeEnv(pageWithTexts(["Duplicate ID source", "Valid source", "Null ID source"]), { dynamic: false });
    env.setResponseFor((request) => request.index === 0 ? { ok: true, results: [
      { id: request.msg.items[0].id, translation: "first duplicate" },
      { id: request.msg.items[1].id, translation: "有效译文" },
      { id: request.msg.items[0].id, translation: "second duplicate" },
      { id: null, translation: "null poison" },
      { id: String(request.msg.items[2].id), translation: "string poison" },
      { id: 999, translation: "unexpected poison" }
    ] } : undefined);
    const first = await env.translate();
    assert.strictEqual(first.failed, 2);
    assert.deepStrictEqual(env.translations(), ["有效译文"]);
    await env.translate();
    assert.deepStrictEqual(env.requestTexts(env.requests[1]).sort(), ["Duplicate ID source", "Null ID source"].sort());
    await env.restore();
    await env.translate();
    assert.strictEqual(env.requests.length, 2);
    assert(!env.translations().some((text) => /poison|duplicate/.test(text)));
    env.dom.window.close();
  });

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
    assert.strictEqual(result.translated, 9, "records include visible navigation, grouped inline text, duplicates, and footer records");
    assert.deepStrictEqual(env.sentTexts().sort(), [
      "Welcome to this great workplace today.", "Save job", "Browse jobs", "Job seekers", "Help centre",
      "Primary navigation", "Sidebar advertisement"
    ].sort(), "same-text records share one model item");
    assert.strictEqual(env.translations().length, 9);
    assert.strictEqual(env.translations().filter(text => text === "【译】Save job").length, 3, "same-batch dedupe fans out to all original records");
    assert(env.translations().includes("【译】Welcome to this great workplace today."));
    assert(env.translations().includes("【译】Job seekers"));
    for (const excluded of ["const hiddenCode", "Hidden page content", "Screen reader hidden content"]) {
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
    assert.strictEqual(restored.removed, 9);
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
    const staleRun = env.send({ type: "TRANSLATE_PAGE", operationId: "popup:old" });
    assert(await pollUntil(() => env.pending.length === 1));
    const staleRequest = env.pending[0];

    await env.send({ type: "RESTORE_PAGE", operationId: "popup:restore" });
    const progressBoundary = env.progressEvents.length;
    const currentRun = env.send({ type: "TRANSLATE_PAGE", operationId: "popup:new" });
    assert(await pollUntil(() => env.pending.length === 2));
    const currentRequest = env.pending.find((request) => request !== staleRequest);
    env.resolveRequest(currentRequest, "CURRENT");
    await currentRun;
    env.resolveRequest(staleRequest, "STALE");
    await staleRun;

    assert.deepStrictEqual(env.translations(), ["【CURRENT】Race condition role"]);
    assert.strictEqual((await env.status()).status, "watching");
    const state = await env.status();
    assert.strictEqual(state.operationId, "popup:new");
    assert(env.progressEvents.slice(progressBoundary).every((progress) =>
      progress.operationId === "popup:new" && progress.sessionGeneration === state.sessionGeneration),
      "late task output cannot publish progress with the new task identity");
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

  await scenario("cross-batch cache reuse, original record counts and LAT_RESET", async () => {
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
      return { reject: new Error("PRIVATE_SERVICE_ERROR_DO_NOT_EXPOSE") };
    });
    const first = await failedEnv.translate();
    assert.strictEqual(first.translated, 0);
    assert.strictEqual(first.failed, 1);
    assert(!JSON.stringify(first).includes("PRIVATE_SERVICE_ERROR"));
    assert(!failedEnv.logs.join(" ").includes("PRIVATE_SERVICE_ERROR"), "raw runtime errors stay out of content logs and UI responses");
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

  await scenario("selection card shares page cache with full-page translation and stays outside DOM collection", async () => {
    const selected = "Senior Software Engineer";
    const env = makeEnv(pageWithTexts([selected, "Other useful page content"]));
    const source = env.document.querySelector("#main p");
    const initialHtml = source.innerHTML;

    await env.send({ type: "TRANSLATE_SELECTION", selectionText: "  " + selected + "  " });
    assert.deepStrictEqual(env.sentTexts(), [selected]);
    assert.strictEqual(env.document.querySelectorAll(".local-ai-selection-card").length, 1);
    assert(env.document.querySelector(".local-ai-selection-card").textContent.includes("【译】" + selected));
    assert.strictEqual(source.innerHTML, initialHtml, "selection translation leaves source text alone");

    const beforeRepeat = env.requests.length;
    await env.send({ type: "TRANSLATE_SELECTION", selectionText: selected });
    assert.strictEqual(env.requests.length, beforeRepeat, "repeat selection is served from the shared cache");
    assert.strictEqual(env.document.querySelectorAll(".local-ai-selection-card").length, 1, "card is reused");

    await env.translate();
    assert.deepStrictEqual(env.sentTexts(), [selected, "Other useful page content"],
      "full-page translation reuses selection cache and never sends card text");
    await wait(DEBOUNCE + 100);
    assert.strictEqual(env.requests.length, 2, "card insertion and update do not trigger dynamic requests");
    await env.restore();
    assert.strictEqual(env.document.querySelectorAll(".local-ai-selection-card").length, 1,
      "Restore leaves the independent selection card open");
    env.document.querySelector(".local-ai-selection-card button").click();
    assert.strictEqual(env.document.querySelectorAll(".local-ai-selection-card").length, 0);
    env.dom.window.close();

    const reverse = makeEnv(pageWithTexts([selected]));
    await reverse.translate();
    const orphan = reverse.document.createElement("section");
    orphan.className = "local-ai-selection-card";
    orphan.textContent = "Old card from a previous content-script context";
    reverse.document.body.appendChild(orphan);
    const beforeSelectionHit = reverse.requests.length;
    await reverse.send({ type: "TRANSLATE_SELECTION", selectionText: selected });
    assert.strictEqual(reverse.requests.length, beforeSelectionHit, "selection reuses prior full-page result");
    assert.strictEqual(reverse.document.querySelectorAll(".local-ai-selection-card").length, 1,
      "a card left by a previous content-script context is replaced");
    assert(reverse.document.querySelector(".local-ai-selection-card").textContent.includes("【译】" + selected));
    reverse.dom.window.close();
  });

  await scenario("new selection wins a late response and stale output stays uncached", async () => {
    const env = makeEnv(pageWithTexts(["Unrelated page body"]), { autoRespond: false, dynamic: false });
    const first = env.send({ type: "TRANSLATE_SELECTION", selectionText: "Alpha selection text" });
    assert(await pollUntil(() => env.pending.length === 1));
    const stale = env.pending[0];
    const second = env.send({ type: "TRANSLATE_SELECTION", selectionText: "Bravo selection text" });
    assert(await pollUntil(() => env.pending.length === 2));
    const current = env.pending.find((request) => request !== stale);
    env.resolveRequest(current, "CURRENT");
    await second;
    env.resolveRequest(stale, "STALE");
    await first;
    assert(env.document.querySelector(".local-ai-selection-card").textContent.includes("【CURRENT】Bravo selection text"));
    assert(!env.document.querySelector(".local-ai-selection-card").textContent.includes("Alpha selection text"));
    const retry = env.send({ type: "TRANSLATE_SELECTION", selectionText: "Alpha selection text" });
    assert(await pollUntil(() => env.pending.length === 1), "stale selection did not populate cache");
    env.resolveRequest(env.pending[0], "RETRY");
    await retry;
    assert(env.document.querySelector(".local-ai-selection-card").textContent.includes("【RETRY】Alpha selection text"));

    const closing = env.send({ type: "TRANSLATE_SELECTION", selectionText: "Closing pending text" });
    assert(await pollUntil(() => env.pending.length === 1));
    env.document.querySelector(".local-ai-selection-card button").click();
    env.resolveRequest(env.pending[0], "LATE");
    await closing;
    assert.strictEqual(env.document.querySelectorAll(".local-ai-selection-card").length, 0,
      "closing the card invalidates its in-flight request");
    const afterClose = env.send({ type: "TRANSLATE_SELECTION", selectionText: "Closing pending text" });
    assert(await pollUntil(() => env.pending.length === 1), "response after close was not cached");
    env.resolveRequest(env.pending[0], "NEW");
    await afterClose;
    env.dom.window.close();
  });

  await scenario("selection rejects overlong text and shows safe Runtime errors", async () => {
    const env = makeEnv(pageWithTexts(["Ordinary page text"]), {
      dynamic: false,
      config: { hardTextLimit: 20 }
    });
    await env.send({ type: "TRANSLATE_SELECTION", selectionText: "This selection is far too long" });
    assert.strictEqual(env.requests.length, 0, "overlong selection never reaches the model");
    assert(env.document.querySelector(".local-ai-selection-card").textContent.includes("过长"));

    env.setResponseFor(() => ({ ok: false, kind: "unavailable", error: "raw secret response" }));
    await env.send({ type: "TRANSLATE_SELECTION", selectionText: "Model error text" });
    const cardText = env.document.querySelector(".local-ai-selection-card").textContent;
    assert(cardText.includes("Translation 不可用"));
    assert(!cardText.includes("raw secret") && !cardText.includes("Model error text"));
    assert(!env.logs.join(" ").includes("Model error text"), "logs never include selection text");
    env.dom.window.close();
  });

  await scenario("BR-separated article text stays segmented, adjacent, dynamic, and restorable", async () => {
    const paragraphs = [
      "First normal English paragraph.",
      "Second normal English paragraph.",
      "SECTION TITLE",
      "Third normal English paragraph."
    ];
    const env = makeEnv('<!doctype html><html><body><div id="article">' +
      paragraphs[0] + '<br>' + paragraphs[1] + '<br><strong>' + paragraphs[2] +
      '</strong><br>' + paragraphs[3] + '</div><div id="feed"></div></body></html>');
    const article = env.document.getElementById("article");
    await env.send({ type: "TRANSLATE_SELECTION", selectionText: "Manual selection only" });
    const beforePage = env.requests.length;
    const sourceNodes = [
      article.firstChild,
      article.childNodes[2],
      article.querySelector("strong"),
      article.lastChild
    ];
    env.setAutoRespond(false);
    const pageRun = env.translate();
    assert(await pollUntil(() => env.pending.length === 1));
    // Retain source boundaries while the request is in flight. Changes to a
    // segment's source identity are separately covered by the stale-DOM cases.
    const originalHtml = article.innerHTML;
    env.resolveRequest(env.pending[0], "译");
    await pageRun;
    env.setAutoRespond(true);

    const pageTexts = env.requests.slice(beforePage).flatMap((request) => env.requestTexts(request));
    assert.deepStrictEqual(pageTexts, paragraphs, "each visual line is sent once and card text is excluded");
    const translated = [...article.querySelectorAll(".local-ai-translation")];
    assert.strictEqual(translated.length, paragraphs.length);
    translated.forEach((node, index) => {
      assert.strictEqual(node.textContent, "【译】" + paragraphs[index]);
      assert(sourceNodes[index].compareDocumentPosition(node) & env.window.Node.DOCUMENT_POSITION_FOLLOWING,
        "each translation follows its own English source in DOM order");
    });

    article.append(env.document.createElement("br"), env.document.createTextNode("Fourth dynamic English paragraph."));
    assert(await pollUntil(() => env.translations().length === 5), "dynamic BR segment is translated");
    assert.deepStrictEqual(env.sentTexts().filter((text) => text === "Fourth dynamic English paragraph."),
      ["Fourth dynamic English paragraph."]);
    await env.restore();
    assert.strictEqual(article.innerHTML, originalHtml + "<br>Fourth dynamic English paragraph.",
      "Restore removes translations without changing source structure");
    assert.strictEqual(env.document.querySelectorAll(".local-ai-translation").length, 0);
    assert.strictEqual(env.document.querySelectorAll("[data-local-ai-source]").length, 0);
    assert.strictEqual(env.document.querySelectorAll(".local-ai-selection-card").length, 1);
    env.dom.window.close();
  });

  await scenario("Runtime batching obeys item, character and exact UTF-8 budgets without record splitting", async () => {
    const texts = Array.from({ length: 70 }, (_, i) => "Small record number " + i);
    const env = makeEnv(pageWithTexts(texts), { dynamic: false });
    await env.translate();
    assert(env.requests.length >= 3);
    assert(env.requests.every(r => r.msg.items.length <= 32));
    assert.deepStrictEqual(env.sentTexts(), texts);
    env.dom.window.close();
    const unicode = Array.from({ length: 6 }, (_, i) => "English " + i + " " + "中".repeat(600));
    const utf8 = makeEnv(pageWithTexts(unicode), { dynamic: false });
    await utf8.translate();
    assert(utf8.requests.every(r => r.msg.items.reduce((sum, item) => sum + new TextEncoder().encode(item.text).length, 0) <= 4096));
    assert(utf8.requests.every(r => r.msg.items.reduce((sum, item) => sum + item.text.length, 0) <= 2800));
    assert.deepStrictEqual(utf8.sentTexts(), unicode);
    utf8.dom.window.close();
  });
  await scenario("oversized records fail as partial and retry only failed records without truncation", async () => {
    const long = "English " + "a".repeat(4100);
    const env = makeEnv(pageWithTexts(["Safe first record", long]), { dynamic: false });
    env.setResponseFor(request => request.msg.items.some(item => item.text === long) ? { ok: false, kind: "unsupported" } : undefined);
    const result = await env.translate();
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.translated, 1);
    assert.strictEqual((await env.status()).status, "partial");
    assert(env.sentTexts().includes(long));
    const before = env.requests.length;
    await env.translate();
    assert.deepStrictEqual(env.requests.slice(before).flatMap(r => env.requestTexts(r)), [long]);
    env.dom.window.close();
  });
  await scenario("public Runtime identity invalidates old cache and isolates Single prompt metadata", async () => {
    const env = makeEnv(pageWithTexts(["Old cached text"]), { dynamic: false });
    await env.translate(); await env.restore();
    env.fillPage(["Old cached text", "New identity text"]);
    const next = { profile: { id: "translate.fast", version: "next-version", locality: "LOCAL" }, promptVersion: "next-batch" };
    env.setResponseFor(request => ({ ok: true, identity: next, results: request.msg.items.map(item => ({ id: item.id, translation: "New translation" })) }));
    const changed = await env.translate();
    assert.strictEqual(changed.failed, 1, "a mixed response cannot insert hits from the prior identity");
    await env.restore(); env.fillPage(["Old cached text"]);
    const before = env.requests.length;
    await env.translate();
    assert.strictEqual(env.requests.length, before + 1, "observed public profile change evicts old cached text");
    await env.restore();
    const large = "English " + "a".repeat(2900);
    env.fillPage([large]);
    env.setResponseFor(request => ({ ok: true, identity: { ...next, promptVersion: "next-single" }, results: request.msg.items.map(item => ({ id: item.id, translation: "Single translation" })) }));
    await env.translate(); await env.restore(); env.fillPage(["Old cached text"]);
    const afterSingle = env.requests.length;
    await env.translate();
    assert.strictEqual(env.requests.length, afterSingle, "Single identity does not contaminate Batch cache");
    env.dom.window.close();
  });
  await scenario("cache reuse cannot bypass Runtime offline or credential revoke", async () => {
    const env = makeEnv(pageWithTexts(["Cached private text"]), { dynamic: false });
    await env.translate(); await env.restore();
    env.setConnection({ ok: true, paired: true, pairing: "paired", online: false, available: false });
    const before = env.requests.length;
    const offline = await env.translate();
    assert.strictEqual(offline.translated, 0);
    assert.strictEqual(env.requests.length, before);
    assert.match(offline.error, /Runtime 离线/);
    env.setConnection({ ok: true, paired: false, pairing: "invalid", online: true, available: false });
    const selection = await env.send({ type: "TRANSLATE_SELECTION", selectionText: "Cached private text" });
    assert.strictEqual(selection.ok, false);
    assert.match(selection.error, /重新配对/);
    env.dom.window.close();
  });
  await scenario("Restore during cache readiness cannot submit stale miss records", async () => {
    const env = makeEnv(pageWithTexts(["Already cached text"]), { dynamic: false });
    await env.translate(); await env.restore();
    env.fillPage(["Already cached text", "New uncached record"]);
    let finishCheck;
    env.setConnection(new Promise(resolve => { finishCheck = resolve; }));
    const before = env.requests.length;
    const inFlight = env.translate();
    await wait(0);
    await env.restore();
    finishCheck({ ok: true, paired: true, pairing: "paired", online: true, available: true });
    assert((await inFlight).stale);
    assert.strictEqual(env.requests.length, before, "cancelled cache preflight never starts a new task");
    assert.strictEqual(env.translations().length, 0);
    env.dom.window.close();
  });
  console.log("\n===== ALL PASS (" + passed.length + " behavior scenarios) =====");
  process.exit(0);
})().catch((error) => {
  console.error("\n===== BEHAVIOR TEST FAILED =====");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
