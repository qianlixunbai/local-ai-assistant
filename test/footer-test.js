/* Footer coverage DOM test — loads the REAL config.js + content.js into jsdom. */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const EXT = path.resolve(__dirname, "..", "browser-extension");

const HTML = `<!DOCTYPE html><html><head><title>t</title></head><body>
  <main>
    <h1>Welcome to the job board</h1>
    <p>Find your next role today.</p>
  </main>
  <nav><a href="/n1">Primary navigation item</a></nav>
  <aside><p>Sidebar promo text</p></aside>
  <footer>
    <h3>Job seekers</h3>
    <a href="/job-search" target="_blank" rel="noopener">Job search</a>
    <a href="/profile">Profile</a>
    <a href="/saved-jobs">Saved jobs</a>
    <h3>Employers</h3>
    <a href="/post">Post a job ad</a>
    <h3>About us</h3>
    <a href="/newsroom">Newsroom</a>
    <h3>Contact</h3>
    <a href="/help">Help centre</a>
    <a href="/careers">Careers</a>
    <a href="/investors">Investors</a>
    <a href="/social">Social</a>
    <a href="/contact">Contact</a>
    <!-- must NOT be translated -->
    <code>const x = 1;</code>
    <button>Submit application</button>
    <div hidden>Hidden secret text</div>
    <div aria-hidden="true">Aria hidden text</div>
    <a href="/x">12345</a>
    <a href="/y">https://example.com/only-url</a>
    <a href="/z">a@b.com</a>
  </footer>
</body></html>`;

const dom = new JSDOM(HTML, { url: "https://example.com/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;

// Faithful-ish visibility stub (jsdom has no layout engine).
window.Element.prototype.checkVisibility = function () {
  for (let el = this; el && el.nodeType === 1; el = el.parentElement) {
    if (el.hasAttribute("hidden")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const st = el.style && el.style.display;
    if (st === "none") return false;
  }
  return true;
};

// Load real config.js into the jsdom window context.
window.eval(fs.readFileSync(path.join(EXT, "config.js"), "utf8"));

// Stub chrome messaging; capture the content-script message listener.
const listeners = [];
window.chrome = {
  runtime: {
    sendMessage: (msg) => {
      if (msg && msg.type === "TRANSLATE_BATCH") {
        return Promise.resolve({
          ok: true,
          results: msg.items.map((it) => ({ id: it.id, translation: "【译】" + it.text }))
        });
      }
      return Promise.resolve(undefined);
    },
    onMessage: { addListener: (fn) => listeners.push(fn) }
  }
};

// Load real content.js.
window.eval(fs.readFileSync(path.join(EXT, "content.js"), "utf8"));

function send(msg) {
  return new Promise((resolve) => {
    const fn = listeners[0];
    const ret = fn(msg, {}, (r) => resolve(r));
    if (ret !== true) { /* sync path already responded */ }
  });
}

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra || "" });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "  -> " + extra : ""));
}

(async () => {
  const r = await send({ type: "TRANSLATE_PAGE" });
  console.log("translatePage result:", JSON.stringify(r));

  const doc = window.document;
  const trans = [...doc.querySelectorAll(".local-ai-translation")];
  const transText = trans.map((n) => n.textContent);

  // --- footer text extracted ---
  const wantTranslations = [
    "Job seekers", "Job search", "Profile", "Saved jobs", "Employers",
    "Post a job ad", "About us", "Newsroom", "Contact", "Help centre",
    "Careers", "Investors", "Social", "Welcome to the job board", "Find your next role today."
  ];
  wantTranslations.forEach((t) => {
    check("translated: " + JSON.stringify(t), transText.includes("【译】" + t));
  });

  // --- link href / target unchanged ---
  const a = doc.querySelector('a[href="/job-search"]');
  check("href preserved", a && a.getAttribute("href") === "/job-search", a && a.getAttribute("href"));
  check("target preserved", a && a.getAttribute("target") === "_blank", a && a.getAttribute("target"));
  check("rel preserved", a && a.getAttribute("rel") === "noopener");
  check("link text preserved", a && a.textContent.startsWith("Job search"), a && a.textContent);

  // --- no duplicate translations (structural: one anchor -> at most one translation) ---
  // Value collisions are legitimate (e.g. "Contact" heading + "Contact" link);
  // the real invariant is that no single anchor receives two translation nodes.
  const anchorsWithTranslation = new Set();
  let structuralDup = 0;
  doc.querySelectorAll(".local-ai-translation").forEach((n) => {
    const anchor = n.previousElementSibling || n.parentElement;
    if (!anchor) return;
    if (anchorsWithTranslation.has(anchor)) structuralDup++;
    anchorsWithTranslation.add(anchor);
  });
  const sourceAnchors = doc.querySelectorAll("[data-local-ai-source]").length;
  check("no structural duplicate translations", structuralDup === 0, "dups=" + structuralDup);
  check("one translation per source anchor", trans.length === sourceAnchors, trans.length + " trans vs " + sourceAnchors + " anchors");

  // --- restore ---
  const beforeRestore = trans.length;
  const r2 = await send({ type: "RESTORE_PAGE" });
  const afterNodes = doc.querySelectorAll(".local-ai-translation").length;
  const leftoverAttr = doc.querySelectorAll("[data-local-ai-source]").length;
  check("restore removed all translations", afterNodes === 0, "removed=" + r2.removed + "/" + beforeRestore);
  check("restore cleared source attr", leftoverAttr === 0, "leftover=" + leftoverAttr);

  // --- original text untouched after restore ---
  const footer = doc.querySelector("footer");
  check("original footer text intact", footer.innerHTML.includes("Job seekers") && footer.innerHTML.includes("Help centre"));
  const a2 = doc.querySelector('a[href="/job-search"]');
  check("original link text intact after restore", a2.textContent.trim() === "Job search", JSON.stringify(a2.textContent));

  // --- excluded content NOT translated ---
  const codeNot = !transText.some((t) => /const x/.test(t));
  const btnNot = !transText.some((t) => /Submit application/.test(t));
  const hiddenNot = !transText.some((t) => /Hidden secret/.test(t));
  const ariaNot = !transText.some((t) => /Aria hidden/.test(t));
  check("code not translated", codeNot);
  check("button not translated", btnNot);
  check("hidden not translated", hiddenNot);
  check("aria-hidden not translated", ariaNot);

  // --- noise tokens not translated ---
  check("pure number not translated", !transText.some((t) => t === "【译】12345"));
  check("url-only not translated", !transText.some((t) => /example\.com\/only-url/.test(t)));
  check("email-only not translated", !transText.some((t) => /a@b\.com/.test(t)));

  // --- nav / aside strategies unchanged (still pruned) ---
  check("nav still not translated", !transText.some((t) => /Primary navigation item/.test(t)));
  check("aside still not translated", !transText.some((t) => /Sidebar promo text/.test(t)));

  const failed = results.filter((x) => !x.pass);
  console.log("\n===== " + (failed.length ? "FAILED: " + failed.length : "ALL PASS") + " (" + results.length + " checks) =====");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
