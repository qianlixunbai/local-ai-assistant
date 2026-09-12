/* v0.2 Dynamic Content test — loads the REAL config.js + content.js into jsdom. */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const EXT = path.resolve(__dirname, "..", "browser-extension");
const DEBOUNCE = 750;
const WAIT = DEBOUNCE + 350; // margin past one debounce window

const HTML = `<!DOCTYPE html><html><head><title>t</title></head><body>
  <main>
    <h1 id="i1">Initial Jobs</h1>
    <p id="i2">Find your next role today at a great company.</p>
    <a id="i3" href="/jobs/all" target="_blank">Browse all jobs</a>
  </main>
  <div id="feed"></div>
</body></html>`;

const dom = new JSDOM(HTML, { url: "https://example.com/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;

window.Element.prototype.checkVisibility = function () {
  for (let el = this; el && el.nodeType === 1; el = el.parentElement) {
    if (el.hasAttribute("hidden")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
  }
  return true;
};

window.eval(fs.readFileSync(path.join(EXT, "config.js"), "utf8"));

// ---- instrumentation ----
let requestDelayMs = 0;
let active = 0, maxActive = 0;
const requests = []; // each: array of item texts
const listeners = [];
const logs = [];
window.console.log = (...a) => logs.push(a.join(" "));
window.console.error = () => {};

window.chrome = {
  runtime: {
    sendMessage: (msg) => {
      if (msg && msg.type === "TRANSLATE_BATCH") {
        active++; maxActive = Math.max(maxActive, active);
        requests.push(msg.items.map((it) => it.text));
        return new Promise((res) => setTimeout(() => {
          active--;
          res({ ok: true, results: msg.items.map((it) => ({ id: it.id, translation: "【译】" + it.text })) });
        }, requestDelayMs));
      }
      return Promise.resolve(undefined);
    },
    onMessage: { addListener: (fn) => listeners.push(fn) }
  }
};

window.eval(fs.readFileSync(path.join(EXT, "content.js"), "utf8"));

function send(msg) {
  return new Promise((resolve) => listeners[0](msg, {}, (r) => resolve(r)));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const translatedTexts = () => [...doc.querySelectorAll(".local-ai-translation")].map((n) => n.textContent);
const allSent = () => requests.flat();

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra !== undefined ? "  -> " + extra : ""));
}
async function pollUntil(fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await wait(50);
  }
  return fn();
}

(async () => {
  /* ---- 1. initial translate ---- */
  const r1 = await send({ type: "TRANSLATE_PAGE" });
  console.log("initial:", JSON.stringify(r1));
  check("1 initial DOM translated", r1.ok && r1.translated === 3, r1.translated);
  check("1 watcher started after initial", r1.watching === true);
  check("log watcher started", logs.some((l) => /dynamic watcher started/.test(l)));
  check("1 initial = 1 batch request", requests.length === 1, requests.length);

  /* ---- 2/3. one new div, debounced, translated ---- */
  const d1 = doc.createElement("div");
  d1.textContent = "Senior Software Engineer";
  doc.getElementById("feed").appendChild(d1);
  check("2 new div not translated before debounce", !translatedTexts().some((t) => /Senior Software Engineer/.test(t)));
  await pollUntil(() => translatedTexts().some((t) => /Senior Software Engineer/.test(t)), WAIT + 1500);
  check("3 new div translated after debounce", translatedTexts().some((t) => /Senior Software Engineer/.test(t)));
  check("3 exactly one new batch request", requests.length === 2, requests.length);

  /* ---- 4. old nodes not re-requested ---- */
  const req2 = requests[1];
  check("4 old text not re-sent", !req2.some((t) => /Initial Jobs|Browse all jobs|Find your next role/.test(t)), req2.join(" | "));
  check("4 old nodes have single translation", translatedTexts().filter((t) => /Initial Jobs/.test(t)).length === 1);

  /* ---- 5. 10 nodes at once -> merged, not 10 requests ---- */
  const before = requests.length;
  const feed = doc.getElementById("feed");
  for (let i = 1; i <= 10; i++) {
    const card = doc.createElement("div");
    card.className = "card";
    card.innerHTML = `<a href="/job/${i}" target="_blank">Job Title ${i}</a><span>City ${i}</span>`;
    feed.appendChild(card);
  }
  await pollUntil(() => translatedTexts().some((t) => /Job Title 10/.test(t)), WAIT + 2500);
  const added = requests.length - before;
  check("5 ten nodes -> few requests (not 10)", added >= 1 && added <= 2, added + " requests");
  check("5 all ten cards translated", [1,2,3,4,5,6,7,8,9,10].every((i) => translatedTexts().some((t) => new RegExp("Job Title " + i + "\\b").test(t))));

  /* ---- 6. no feedback loop from own translation inserts ---- */
  const countAfter = requests.length;
  await wait(1600);
  check("6 no feedback loop (request count stable)", requests.length === countAfter, countAfter + " -> " + requests.length);
  check("6 no translation node contains translation of translation", !translatedTexts().some((t) => /【译】【译】/.test(t)));

  /* ---- 7/8. dynamic filtering ---- */
  const beforeF = requests.length;
  const f = doc.createElement("div");
  f.innerHTML = `<div><code>const x = 1;</code></div>
    <button>Click me now</button>
    <div hidden>Hidden text here</div>
    <nav><a href="/n">Nav link here</a></nav>
    <aside><p>Aside text here</p></aside>
    <footer><a href="/help">Help centre</a></footer>`;
  doc.body.appendChild(f);
  await pollUntil(() => translatedTexts().some((t) => /Help centre/.test(t)), WAIT + 1500);
  await wait(400);
  const flat = allSent();
  check("7 dynamic code not translated", !flat.some((t) => /const x = 1/.test(t)));
  check("7 dynamic button not translated", !flat.some((t) => /Click me now/.test(t)));
  check("7 dynamic hidden not translated", !flat.some((t) => /Hidden text here/.test(t)));
  check("7 dynamic nav not translated", !flat.some((t) => /Nav link here/.test(t)));
  check("7 dynamic aside not translated", !flat.some((t) => /Aside text here/.test(t)));
  check("8 dynamic footer link translated", translatedTexts().some((t) => /Help centre/.test(t)));
  check("8 filtering cost at least one request", requests.length > beforeF);

  /* ---- 9. single-flight: content during dynamic translation ---- */
  requestDelayMs = 500;
  const A = doc.createElement("div");
  A.textContent = "Alpha content block for flight test";
  const B = doc.createElement("div");
  B.textContent = "Beta content block for flight test";
  doc.getElementById("feed").appendChild(A);
  await wait(DEBOUNCE + 200);           // A's request should be in flight now
  doc.getElementById("feed").appendChild(B); // arrives while A translating
  const bothDone = await pollUntil(
    () => translatedTexts().some((t) => /Alpha content block/.test(t)) && translatedTexts().some((t) => /Beta content block/.test(t)),
    6000
  );
  check("9 both A and B eventually translated", bothDone);
  check("9 no concurrent Ollama requests (max parallel = 1)", maxActive === 1, "maxActive=" + maxActive);
  requestDelayMs = 0;

  /* ---- 13/14. duplicate + href/original integrity ---- */
  const dup = translatedTexts();
  check("13 no duplicate translation nodes", new Set(dup).size === dup.length, dup.length + " nodes");
  const i3 = doc.getElementById("i3");
  check("14 link href unchanged", i3.getAttribute("href") === "/jobs/all", i3.getAttribute("href"));
  check("14 link target unchanged", i3.getAttribute("target") === "_blank");
  check("14 original text preserved", i3.textContent.startsWith("Browse all jobs"));
  check("14 card link href unchanged", doc.querySelector('a[href="/job/5"]') !== null);

  /* ---- 10/11. Restore stops observer ---- */
  const st = await send({ type: "GET_STATUS" });
  check("status watching before restore", st.status === "watching", st.status);
  const rr = await send({ type: "RESTORE_PAGE" });
  check("10 restore removed all translations", doc.querySelectorAll(".local-ai-translation").length === 0, "removed=" + rr.removed);
  check("10 watcher stopped log", logs.some((l) => /dynamic watcher stopped/.test(l)));
  const st2 = await send({ type: "GET_STATUS" });
  check("10 status not watching after restore", st2.watching === false && st2.status === "idle", st2.status);

  const beforeR = requests.length;
  const rdiv = doc.createElement("div");
  rdiv.textContent = "Should not be auto translated after restore";
  doc.getElementById("feed").appendChild(rdiv);
  await wait(WAIT + 800);
  check("11 no auto-translate after restore", requests.length === beforeR && !translatedTexts().some((t) => /Should not be auto/.test(t)), requests.length - beforeR + " requests");

  /* ---- 12. re-translate re-arms watcher ---- */
  const r3 = await send({ type: "TRANSLATE_PAGE" });
  console.log("re-translate:", JSON.stringify(r3));
  check("12 re-translate works", r3.ok && r3.translated > 0, r3.translated);
  check("12 watcher re-armed", r3.watching === true);
  const rc = doc.createElement("div");
  rc.textContent = "Newly added after re-translate";
  doc.getElementById("feed").appendChild(rc);
  await pollUntil(() => translatedTexts().some((t) => /Newly added after re-translate/.test(t)), WAIT + 1500);
  check("12 auto-translate works again after re-translate", translatedTexts().some((t) => /Newly added after re-translate/.test(t)));

  const failed = results.filter((x) => !x.pass);
  console.log("\n===== " + (failed.length ? "FAILED: " + failed.length : "ALL PASS") + " (" + results.length + " checks) =====");
  console.log("total TRANSLATE_BATCH requests:", requests.length, "| maxParallel:", maxActive);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
