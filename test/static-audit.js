/* Reproducible source/privacy audit. Prints counts only, never matched content. */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "browser-extension");
let checks = 0;
function check(name, condition) { assert(condition, name); checks++; console.log("AUDIT PASS  " + name); }
const production = fs.readdirSync(EXT).map(name => [name, fs.readFileSync(path.join(EXT, name), "utf8")]);
const combined = production.map(entry => entry[1]).join("\n");
check("zero legacy endpoints/provider settings in production", !/11434|\/api\/(?:chat|tags|version)|qwen3\.5|SYSTEM_PROMPT|ollamaBaseUrl|keep_alive|num_ctx|num_predict|top_p|temperature|translationPromptVersion|\bthink\b/.test(combined));
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json")));
function sameSet(actual, allowed) {
  return Array.isArray(actual) && actual.length === allowed.length &&
    new Set(actual).size === actual.length && allowed.every(value => actual.includes(value));
}
check("only Runtime host and allowed permissions", sameSet(manifest.host_permissions, ["http://127.0.0.1:8765/*"]) &&
  sameSet(manifest.permissions, ["activeTab", "scripting", "contextMenus", "storage"]));
const config = fs.readFileSync(path.join(EXT, "config.js"), "utf8");
const content = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
const popup = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
const runtimeClient = fs.readFileSync(path.join(EXT, "runtime-client.js"), "utf8");
const background = fs.readFileSync(path.join(EXT, manifest.background.service_worker), "utf8");
const injected = background.match(/\bCONTENT_SCRIPTS\s*=\s*(\[[^\]]+\])/);
const untrustedScripts = [...JSON.parse(injected?.[1] || "[]"), ...(manifest.content_scripts || []).flatMap(entry => entry.js), ...Array.from(
  fs.readFileSync(path.join(EXT, manifest.action.default_popup), "utf8").matchAll(/<script\b[^>]*src=["']([^"']+)["']/g), match => match[1])];
check("network stays in worker-loaded Runtime client", !!injected && manifest.background.service_worker === "background.js" &&
  /importScripts\([^;]*["']runtime-client\.js["']/.test(background) &&
  untrustedScripts.every(name => name !== "runtime-client.js" && !/\bRuntimeClient\b|runtime-client\.js/.test(fs.readFileSync(path.join(EXT, name), "utf8"))) &&
  /\bfetch\s*\(/.test(runtimeClient) && production.every(([name, source]) =>
    !/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\s*\(/.test(source) &&
    (name === "runtime-client.js" || !/\bfetch\s*(?:\(|\.|\[)|\[\s*["']fetch["']\s*\]/.test(source))));
check("content has no credential/storage/auth bridge", !/chrome\.storage|Authorization|pairingSecret|\.credential|RuntimeStorage/.test(content));
check("no native token or credential manager access in production", !/\.runtime[\\/]client-token|CredentialManager|WinCred|localStorage|sessionStorage/.test(combined));
check("Browser config contains no credentials or provider ownership", !/credential|pairingSecret|\bmodel\s*:|\bprovider\s*:|generation|promptVersion/.test(config));
check("Origin and Fetch Metadata are never synthesized", !/headers\.(?:Origin|Sec)|["'](?:Origin|Sec-Fetch-[^"']+)["']\s*:/.test(combined));
check("only explicit Copy Origin writes clipboard; content does not read it", !/clipboard\.read|navigator\.clipboard/.test(content) && !/clipboard\.read/.test(popup));
check("production logs use counts/status or controlled kind", production.every(([, source]) => source.split("\n").filter(line => /console\.(log|warn|error)/.test(line)).every(line => !/credential|pairingSecret|Authorization|\.text\b|\.translation\b|e\.message|JSON\.stringify/.test(line))));
const candidates = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).trim().split(/\r?\n/))].filter(name => fs.existsSync(path.join(ROOT, name)));
check("no tracked build/test/private state artifacts", candidates.every(name => !/(^|\/)(node_modules|\.verification|target|bin|obj|dist|logs)(\/|$)|\.(log|zip|jar|tgz|pyc)$/.test(name)));
check("no personal absolute paths or literal browser credentials in source/doc changes", candidates.every(name => {
  const source = fs.readFileSync(path.join(ROOT, name), "utf8");
  return !/[CD]:[\\/](?:Users|IDEA|MC)[\\/]|br1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/.test(source);
}));
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json")));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json")));
const ping = content.match(/msg\.type\s*===\s*["']PING["'][\s\S]*?sendResponse\(\{[^}]*\bversion:\s*["']([^"']+)["']/);
check("release metadata and content PING stay consistent", typeof manifest.version === "string" && !!manifest.version &&
  [packageJson.version, lock.version, lock.packages[""].version, ping?.[1]].every(v => v === manifest.version));
console.log(checks + " static/privacy checks; " + production.length + " production files; " + candidates.length + " candidate source/doc files.");
