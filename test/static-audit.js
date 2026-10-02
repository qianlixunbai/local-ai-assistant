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
check("only Runtime host permission, no broad web permission", JSON.stringify(manifest.host_permissions) === JSON.stringify(["http://127.0.0.1:8765/*"]) && JSON.stringify(manifest.permissions) === JSON.stringify(["activeTab", "scripting", "contextMenus", "storage"]));
const config = fs.readFileSync(path.join(EXT, "config.js"), "utf8");
const content = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
const popup = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
check("network lives only in trusted Runtime client", production.filter(([name, source]) => /\bfetch\(/.test(source)).map(entry => entry[0]).join() === "runtime-client.js");
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
check("version 0.5.0 synchronized", [manifest.version, packageJson.version, lock.version, lock.packages[""].version].every(v => v === "0.5.0") && content.includes('version: "0.5.0"'));
check("legacy model tests removed from current contract", !fs.existsSync(path.join(ROOT, "test", "background-model-test.js")) && packageJson.scripts["test:background-runtime"] === "node test/background-runtime-test.js");
console.log(checks + " static/privacy checks; " + production.length + " production files; " + candidates.length + " candidate source/doc files.");
