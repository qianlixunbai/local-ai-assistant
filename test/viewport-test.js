/* v0.1.2 Viewport-First test — loads the REAL config.js + content.js into jsdom. */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const EXT = path.resolve(__dirname, "..", "browser-extension");
const INNER_HEIGHT = 800;

// ---- build records: token, region, top ----
const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore";
function txt(tag, n) {
  let s = tag + " " + FILLER;
  while (s.length < n) s += " " + FILLER;
  return s.slice(0, n);
}

const plan = [];
for (let i = 1; i <= 6; i++) plan.push({ tag: "VP" + i, region: "V", top: 100 * i, h: 50 });
for (let i = 1; i <= 4; i++) plan.push({ tag: "NRA" + i, region: "N", top: -100 * i, h: 50 });   // near above
for (let i = 1; i <= 5; i++) plan.push({ tag: "NRB" + i, region: "N", top: 900 + 100 * i, h: 50 }); // near below
plan.push({ tag: "FRA1", region: "F", top: -2500, h: 50 });                                      // far above
for (let i = 1; i <= 24; i++) plan.push({ tag: "FRB" + i, region: "F", top: 2500 + 100 * i, h: 50 }); // far below

const EXPECT = { V: 6, N: 9, F: 25 };

// DOM order deliberately differs from priority order: far-above, near-above, viewport, near-below, footer
const domOrder = [];
plan.filter((p) => p.tag === "FRA1").forEach((p) => domOrder.push(p));
plan.filter((p) => p.tag.startsWith("NRA")).forEach((p) => domOrder.push(p));
plan.filter((p) => p.tag.startsWith("VP")).forEach((p) => domOrder.push(p));
plan.filter((p) => p.tag.startsWith("NRB")).forEach((p) => domOrder.push(p));
plan.filter((p) => p.tag.startsWith("FRB")).forEach((p) => domOrder.push(p));

const bodyParts = [];
bodyParts.push("<main>");
domOrder.filter((p) => !p.tag.startsWith("FRB")).forEach((p) => {
  bodyParts.push(`<p data-top="${p.top}" data-height="${p.h}">${txt(p.tag, 120)}</p>`);
});
bodyParts.push("</main>");
bodyParts.push("<footer>");
domOrder.filter((p) => p.tag.startsWith("FRB")).forEach((p) => {
  bodyParts.push(`<p data-top="${p.top}" data-height="${p.h}">${txt(p.tag, 120)}</p>`);
});
bodyParts.push('<nav><p data-top="100">nav should be skipped</p></nav>');
bodyParts.push('<aside><p data-top="100">aside should be skipped</p></aside>');
bodyParts.push('<button>button should be skipped</button>');
bodyParts.push('<code>code should be skipped</code>');
bodyParts.push("</footer>");

const HTML = `<!DOCTYPE html><html><head><title>t</title></head><body>${bodyParts.join("")}</body></html>`;

const dom = new JSDOM(HTML, { url: "https://example.com/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;

Object.defineProperty(window, "innerHeight", { value: INNER_HEIGHT, configurable: true });

// visibility stub
window.Element.prototype.checkVisibility = function () {
  for (let el = this; el && el.nodeType === 1; el = el.parentElement) {
    if (el.hasAttribute("hidden")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
  }
  return true;
};
// layout stub: derive rect from data-top/data-height
window.Element.prototype.getBoundingClientRect = function () {
  const t = this.getAttribute && this.getAttribute("data-top");
  if (t !== null) {
    const top = Number(t);
    const h = Number(this.getAttribute("data-height") || 40);
    return { top, bottom: top + h, left: 0, right: 100, width: 100, height: h, x: 0, y: top };
  }
  return { top: 0, bottom: 0, left: 0, right: 100, width: 100, height: 0, x: 0, y: 0 };
};

window.eval(fs.readFileSync(path.join(EXT, "config.js"), "utf8"));

// capture console
const logs = [];
const origLog = window.console.log;
window.console.log = (...a) => { logs.push(a.join(" ")); };
window.console.error = () => {};

// capture batches (order == request order == priority order)
const capturedBatches = [];
const listeners = [];
window.chrome = {
  runtime: {
    sendMessage: (msg) => {
      if (msg && msg.type === "TRANSLATE_BATCH") {
        capturedBatches.push(msg.items.map((it) => it.text));
        return Promise.resolve({
          ok: true,
          results: msg.items.map((it) => ({ id: it.id, translation: "【译】" + it.text.split(" ")[0] }))
        });
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

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  -> " + extra : ""));
}

const tagOf = (text) => (text.match(/^(VP\d+|NRA\d+|NRB\d+|FRA1|FRB\d+)/) || ["?"])[0];
const regionOf = (tag) => (tag.startsWith("VP") ? "V" : tag.startsWith("NR") ? "N" : "F");

(async () => {
  const r1 = await send({ type: "TRANSLATE_PAGE" });
  console.log("=== translate #1:", JSON.stringify(r1));

  const vf = logs.find((l) => l.includes("viewport-first"));
  console.log("=== " + vf);
  check("viewport-first log present", !!vf);

  const m = vf && vf.match(/visibleRecords = (\d+), nearRecords = (\d+), restRecords = (\d+), firstBatchChars = (\d+)/);
  check("priority V count", m && Number(m[1]) === EXPECT.V, m && m[1]);
  check("priority N count", m && Number(m[2]) === EXPECT.N, m && m[2]);
  check("priority F count", m && Number(m[3]) === EXPECT.F, m && m[3]);

  // batch sizes
  const b1chars = capturedBatches[0].reduce((s, t) => s + t.length, 0);
  check("first batch ~1000 chars", b1chars > 800 && b1chars <= 1000, b1chars + " chars");
  const later = capturedBatches.slice(1).map((b) => b.reduce((s, t) => s + t.length, 0));
  console.log("=== batch char sizes:", [b1chars, ...later].join(", "));
  check("a later batch ~2800 chars", later.some((c) => c > 2500 && c <= 2800), later.join(","));

  // batch 1 ordering: all viewport first
  const b1tags = capturedBatches[0].map(tagOf);
  console.log("=== batch1 tags:", b1tags.join(", "));
  check("batch1 starts with viewport records", b1tags.slice(0, EXPECT.V).every((t) => regionOf(t) === "V"));
  check("batch1 viewport in DOM order", b1tags.slice(0, EXPECT.V).join(",") === ["VP1", "VP2", "VP3", "VP4", "VP5", "VP6"].join(","));

  // global order: V then N then F
  const allTags = capturedBatches.flat().map(tagOf);
  const regions = allTags.map(regionOf);
  const firstN = regions.indexOf("N");
  const firstF = regions.indexOf("F");
  const lastV = regions.lastIndexOf("V");
  check("all priority-0 before priority-1", lastV < firstN, "lastV=" + lastV + " firstN=" + firstN);
  check("all priority-1 before priority-2", firstN < firstF, "firstN=" + firstN + " firstF=" + firstF);

  // same-priority DOM order (within N: NRA1-4 then NRB1-5)
  const nTags = allTags.filter((t) => regionOf(t) === "N");
  check("near group keeps DOM order", nTags.join(",") === ["NRA1", "NRA2", "NRA3", "NRA4", "NRB1", "NRB2", "NRB3", "NRB4", "NRB5"].join(","), nTags.join(","));

  // no record split
  const uniqueTags = new Set(allTags);
  check("no record split (tags unique)", uniqueTags.size === allTags.length && allTags.length === 40, allTags.length + " items");

  // footer still queued
  check("footer finally in queue", allTags.includes("FRB24"), "FRB24 present=" + allTags.includes("FRB24"));

  // filtering
  const allText = allTags.join("|");
  check("nav filtered", !allTags.some((t) => t === "?" ) && !capturedBatches.flat().some((t) => /^nav should/.test(t)));
  check("aside filtered", !capturedBatches.flat().some((t) => /^aside should/.test(t)));
  check("button filtered", !capturedBatches.flat().some((t) => /^button should/.test(t)));
  check("code filtered", !capturedBatches.flat().some((t) => /^code should/.test(t)));

  // no duplicate translations
  const trans1 = [...window.document.querySelectorAll(".local-ai-translation")];
  check("one translation per record", trans1.length === 40, trans1.length + " nodes");

  // timing logs
  check("first visible timing logged", logs.some((l) => /first translation visible in/.test(l)));
  check("total timing logged", logs.some((l) => /total translation time/.test(l)));

  // ---- Restore ----
  await send({ type: "RESTORE_PAGE" });
  check("restore removed all", window.document.querySelectorAll(".local-ai-translation").length === 0);
  check("restore cleared source attr", window.document.querySelectorAll("[data-local-ai-source]").length === 0);

  // ---- Translate -> Restore -> Translate ----
  capturedBatches.length = 0;
  const r3 = await send({ type: "TRANSLATE_PAGE" });
  const trans3 = window.document.querySelectorAll(".local-ai-translation").length;
  console.log("=== translate #2:", JSON.stringify(r3));
  check("re-translate works", r3 && r3.ok && r3.translated === 40, JSON.stringify(r3));
  check("re-translate no duplicates", trans3 === 40, trans3 + " nodes");

  // ---- already translated page must not re-insert ----
  capturedBatches.length = 0;
  const r4 = await send({ type: "TRANSLATE_PAGE" });
  console.log("=== translate #3 (already done):", JSON.stringify(r4));
  check("already-translated not re-inserted", !r4.ok && (r4.alreadyTranslated || /已翻译/.test(r4.error || "")), JSON.stringify(r4));
  check("no duplicate nodes after re-click", window.document.querySelectorAll(".local-ai-translation").length === 40);

  const failed = results.filter((x) => !x.pass);
  console.log("\n===== " + (failed.length ? "FAILED: " + failed.length : "ALL PASS") + " (" + results.length + " checks) =====");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
