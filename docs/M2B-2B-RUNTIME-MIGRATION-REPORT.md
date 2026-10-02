# M2B-2B CLOSING REPORT

Date: 2026-10-03 (Asia/Shanghai). Stage: Chrome Extension → Shared Runtime Migration.

## 1. Result

**PARTIAL / AWAITING REAL CHROME ACCEPTANCE — confirmed Runtime security contract blocker.**

Extension v0.5.0 implementation、automated regression、static audit 与真实 Runtime synthetic-client smoke 完成。
真实 Chrome 154 成功 POST exchange、保存 Browser credential、清除 proof，且 content script 无法读取 credential。
随后 readiness GET 自然没有 Origin，被 stable Runtime 拒绝为 401。真实翻译链路因此未完成，不能声明 CLOSED — GO。

| Gate | Result |
| --- | --- |
| Browser implementation / no direct Provider | PASS |
| Automated behavior / protocol / popup | PASS |
| Production/privacy/static audit | PASS |
| Real Runtime, synthetic HTTP client | PASS |
| Real Chrome POST exchange / credential storage boundary | PASS within dev-authority test |
| Real Chrome authenticated readiness GET | FAIL — Origin absent / 401 |
| Chrome full-page, Dynamic, Selection, cache, failures/recovery, revoke/re-pair, MV3 | UNVERIFIED / blocked |
| Windows Assistant GUI pairing/revoke | UNVERIFIED this stage |

## 2. Git

Only `qianlixunbai/local-ai-assistant` changed. Branch `m2b2b-runtime-migration`, created from clean main.
Implementation commit subject: `feat: migrate browser translator to shared runtime`; exact SHA is supplied by final Git output.
No merge, push, tag, Release, reset, force push, or user-work overwrite. Main/origin-main remain the v0.4.1 baseline.

## 3. Baselines

| Repository | Local HEAD = main = origin/main | GitHub main, independently read via connector |
| --- | --- | --- |
| personal-ai-workspace | `25dc1dfc9a103b030267f18d93059316f0ce008d` | Same SHA |
| local-ai-assistant | `75bede161e7e81d2e7c0fa8e62ac2d05a7248c83` | Same SHA |

Both working trees were clean at start. Shell `git ls-remote` could not connect to GitHub; read-only GitHub branch API succeeded.
Runtime README/STATUS/current architecture/ADR-003/M2A/M2B-1/M2B-2A reports and actual Translate/security/task source were reviewed.
Extension README/status/hotfix report, production scripts, Manifest, all test JS and HTML fixtures were reviewed.
Current source was used above stale historical status text. Runtime source and tracked files remain unchanged and clean at final check.

## 4. Version

Manifest/package/lock/root lock package/content PING are **0.5.0**.
Current README/status describe PARTIAL; historical v0.4.1 GO / RELEASED and Chrome → Ollama facts remain historical.
No release claims or tag were added.

## 5. Architecture Migration

```text
popup / content → background → authenticated Personal AI Runtime :8765
→ Translate / Batch Translate → Shared TaskManager → translate.fast → local Provider
```

The implementation uses this route exclusively. Browser Provider URL/model/prompt/generation configuration/parser/retry/warmup were removed.
Runtime owns AI execution. Browser retains DOM, viewport, Dynamic, Restore, Selection, frame/document, page cache and UX.
Normal batches are not expanded into per-item tasks. No fallback, second Provider, scheduler, SDK framework or background service was introduced.

## 6. Pairing Flow

Popup displays exact `chrome-extension://` + `chrome.runtime.id`; explicit Copy Origin writes only that Origin.
User-facing flow is Windows Assistant → Pair Browser → approve Origin/create one-time proof → enter ID/Secret → Pair.
The worker performs exchange without Authorization, Origin or Fetch Metadata overrides. It never automatically repeats exchange.
Proof inputs clear before the wait, after each attempt and on pagehide. Storage failure tells the user to revoke the just-created server client.
Ambiguous exchange tells the user to inspect Paired Browsers and revoke/recreate if necessary.
The real integration used an explicitly invoked native dev authority instead of Windows Assistant GUI; that distinction is retained.

## 7. Credential Storage

`runtime-storage.js` initializes `chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})` before any read/write/network/injection.
Only the Runtime-issued `br1` Browser credential plus clientId/origin and an invalid flag are persisted in one local key.
No native/master token, proof, webpage text or result is stored. Failure to restrict storage fails closed and attempts removal of the credential.
Write/readback failure has no in-memory or alternate-storage fallback. Forget removes only the local record.
Pairing management messages require the exact trusted popup sender; content scripts cannot invoke Pair/Get Pairing/Forget/Injection management.
Real Chrome verified stored Browser credential and denied content-script storage access. Restart persistence is automated-mock PASS, real Chrome UNVERIFIED.

## 8. Manifest Permissions

Permissions: `activeTab`, `scripting`, `contextMenus`, `storage`.
Host permission: only `http://127.0.0.1:8765/*`.
Provider host permissions removed. No all_urls, webpage permission expansion, clipboard read, native messaging, alarms or offscreen permission.

## 9. Runtime Client

`runtime-client.js` is a small trusted-worker transport, not a general SDK. Bearer auth applies only after independent Browser credential retrieval.
Fetch uses explicit cors mode, no cookies, no redirects, no-store and AbortController.
Bounded streaming JSON reads enforce 65536 bytes and UTF-8 decoding; HTTP/body deadlines remain active through response consumption.
Submission requires HTTP 202, UUID, translate capability, legal status, valid LOCAL public profile/version/promptVersion and exact task Location.
Polling also validates the taskId and metadata consistency. Browser messages receive only mappings, projected public identity and controlled error/status.

## 10. Batch Translation

Existing `TRANSLATE_BATCH` message and `{results:[{id,translation}]}` response mapping remain.
Builder preserves viewport/DOM priority and complete records while enforcing ≤32 items / ≤2800 UTF-16 chars / ≤4096 UTF-8 bytes.
First batch target remains about 1000 chars; oversized complete records are isolated. Normal batch is one POST/task, not N tasks.
Result validation ignores unexpected/non-integer ids and empty translations. Any duplicate requested id remains missing, even after a third duplicate.
Successful subsets stay successful and cached; missing ids become partial and are retried only explicitly.

## 11. Oversized Record Handling

Verified Runtime Single admission: `max-text-characters=4000`; UTF-8 limit is `8192-2048-512=5632` bytes.
Browser stores these as input admission limits, not generation settings. One record outside Batch but inside Single uses one text task and maps its string result back to the original id.
Too-large records fail through the existing partial path. No truncation, sentence splitting, context adjustment, model download or direct Provider fallback.
Runtime retains final authority, including serialized input/body budgets; admitted Browser inputs may still be safely rejected by Runtime policy/budget checks.

## 12. Task Polling

QUEUED/RUNNING poll every 750ms. SUCCEEDED/FAILED/CANCELLED/TIMED_OUT are terminal.
Overall client deadline 190s, each request/body deadline 8s, maximum 260 polls. Ownership is enforced by Runtime.
After a deadline/channel loss, the client does not claim server cancellation; Runtime owns its task deadline. No keepalive mechanism was added.

## 13. Retry Semantics

Translate POST and exchange POST never auto-resubmit. Transport timeout/drop/read failure on submission maps to outcome unknown.
Only known-task GET network failures have a total allowance of two retries; other failures stop polling.
Explicit user Translate/partial retry is the existing Browser lifecycle. Failed/missing records are never hidden automatic generation loops.

## 14. Error Mapping

PROVIDER_UNAVAILABLE/MODEL_UNAVAILABLE → Translation unavailable; QUEUE_FULL → Runtime busy.
TASK_CANCELLED/TASK_TIMEOUT → cancelled/timed out; INVALID_REQUEST/POLICY_DENIED → controlled input/policy failure.
PROVIDER_RESPONSE_INVALID → invalid translation response; INTERNAL_ERROR → failed; TASK_NOT_FOUND → missing task.
401 → invalid/revoked pairing, never ordinary network failure. Network readiness failure → Runtime offline.
Raw Runtime/provider messages, model names, URLs and stack traces are never forwarded to UX/logs.

## 15. Readiness

Only authenticated `/api/v1/capabilities/translate/readiness` is consumed: `available` and controlled error code.
Popup displays Pairing, Runtime and Translation. Unpaired/invalid/not ready disables Translate.
Warmup is removed. First actual Translate owns startup latency. Actual Chrome readiness is currently FAIL due to the Origin contract, described in section 26.

## 16. Cache Identity

Key: normalized text + targetLanguage + profile.id + profile.version + promptVersion.
Public profile.locality is validated and returned, with no resolved model/generation settings.
Unknown Batch/Single identities only permit miss; successful tasks teach each mode separately. Observed public profile/prompt changes clear old entries.
Mixed cache hit/miss batches discard old-identity hits when a successful response changes identity, leaving those records eligible for explicit partial retry.
Metadata learning/writes occur only after session or selection generation validation. Cache hit still checks credential/readiness, so it cannot bypass offline/revoke.
Identity is learned from tasks, not a live version-discovery endpoint; no hot-reload/cross-restart identity freshness guarantee is claimed for an all-cache-hit page.
Current page-lifetime cache follows the prompt's task-metadata approach; no Runtime cache companion patch was made.

## 17. DOM Regression

Existing extraction, anchors/source snapshots, insertion, visibility, sidebar/navigation geometry, clipping, nested scroll and frame/document logic retained.
Changes are limited to batching, Runtime metadata/cache/error adaptation and post-await generation checks.
All prior 24 content scenarios remain PASS. New budget/cache/error/cancel coverage is added; actual migrated Chrome DOM is still UNVERIFIED.

## 18. Dynamic Content

Existing watcher/debounce, initial catch-up, single flight, stale discard, catchupSkipRecords and explicit partial retry remain.
Over-budget Dynamic records now fail normally instead of silently disappearing from failure accounting.
Cache readiness awaits cannot cause obsolete miss tasks after Restore. Automated PASS; real migrated Chrome Load More blocked by readiness.

## 19. Selection Translation

Uses the same Runtime task path and public identity cache. Context menu exact tab/frame/document probe retained, including password boundary and fail closed targeting.
Card remains outside page extraction; independent selection generation and stale/closed-card discard retained.
Safe Runtime error mapping replaces model UX. Selection never reads/writes clipboard. Automated PASS; native right-click / real Runtime card acceptance UNVERIFIED.

## 20. Restore

Source DOM identity, markers, cleanup, watcher stop, session invalidation, Restore→Translate race and cache preservation retained.
Additional generation check prevents a cancelled cached readiness preflight from submitting miss records.
Automated PASS. No real migrated Chrome Restore PASS is claimed.

## 21. Privacy

Production logs remain controlled error kinds, status, record/batch/count/length/timing/cache statistics.
No webpage/selection text, translation, prompt, response/body, Authorization, credential or proof logging.
Integration evidence contains metadata and header-presence projections only; Authorization is projected to a boolean.
Private Runtime bootstrap/registry, Chrome profile and logs are ignored under `.verification/`; no such files are committed.
Existing v0.4.1 historical fixture/docs remain unchanged. No telemetry/history/conversation storage was added.

## 22. Security

Exact trusted popup message authorization, independent Browser credential, trusted-only local storage, boundary failure fail closed and no native management calls are implemented/tested.
Epoch checks discard results from a forgotten/replaced pairing, and old request 401 cannot invalidate a newly paired local record.
No existing native credentials or Windows Credential Manager were read. The native smoke authority uses only its own isolated Runtime-created bootstrap file.
Browser code never receives that native bootstrap value. Test clients are revoked during cleanup; owned Runtime/relay/Chrome/site processes are stopped.
Chrome storage.local is extension-owned storage, not an OS vault; no stronger same-OS-user isolation guarantee is made.

## 23. Automated Tests

`npm ci` PASS, 0 vulnerabilities. `npm test` PASS: **29 content behavior scenarios, 70 Runtime/security checks, 5 popup lifecycle/pairing scenarios**.
Mock fetch/Chrome APIs exercise production scripts without real Runtime/provider dependencies.
Coverage includes pairing/proof/storage/sender/revoke boundaries; malformed task/Location/metadata/body size; all controlled errors;
one-task Batch, Single admission/no truncation; bounded GET-only retry, ambiguous POST; UTF-8/item budgets;
page/selection cache identity, mixed identity isolation, offline/revoke cache gate and Restore during readiness.
Popup loads actual HTML and verifies proof cleanup, unpaired/revoked disabling and Forget guidance.

## 24. Static Audit

`node test/static-audit.js` PASS: 13 static/privacy checks across all 11 production files and current candidate source/docs.
`git diff --check` PASS. Required legacy URL/API/model/prompt/generation reference scan in production is zero.
Manifest exact permissions, sole worker fetch path, no native token access, no synthesized Origin/Fetch Metadata, no raw content logger,
no literal Browser credential, personal absolute paths or tracked private/build/log artifacts were verified.
Full final Git diff reviewed. Candidate count is reported by the final audit command instead of treated as a coverage goal.

## 25. Real Runtime Smoke

**REAL PASS / SYNTHETIC CLIENT** against the existing built Runtime artifact compatible with source baseline `25dc1df` and actual existing local inference service.
Isolated native dev authority → production Runtime client exchange/readiness → one Batch POST → strict submit/poll/metadata validation → structured Chinese items.
The production background scripts ran with mocked Chrome storage and a synthetic Browser-header test adapter against the real Runtime.
Standalone smoke completed exit 0, including cleanup. Final standalone task: `06cdb861-a484-4016-b36b-d171d52f310e`, SUCCEEDED, 2 items,
`translate.fast / m0-1 / LOCAL / translate-batch-v1`, 2026-10-03 00:18:15 +08:00; exactly one submission POST was asserted.
Chrome-run preliminary smoke also passed: task `e8424f8f-3e4e-4cf8-849d-806074a5aa31` at 00:06:44 +08:00.
Synthetic HTTP explicitly supplies the approved Browser headers in the dev client; Extension production never does so.
This cannot substitute for natural Chrome GET behavior. Runtime was not rebuilt or modified in its read-only repository.

## 26. Real Chrome Pairing

**PARTIAL: exchange/storage boundary PASS; readiness FAIL.** Real Chrome/154.0.8037.59, isolated profile, current unpacked `browser-extension/`, actual action popup.
Native dev authority created proof for the popup-displayed exact Origin; the popup submitted proof through the real worker fetch.
Runtime issued/registered an independent client. Browser credential was safely stored, Origin matched, proof inputs cleared and content storage access denied.
Copy Origin's exact displayed value is verified; real clipboard click and Windows Assistant GUI flow remain UNVERIFIED.

Actual request projections (no secret/header value dump):

| Request | Origin | Sec-Fetch-Site / Mode / Dest | Authorization | Result |
| --- | --- | --- | --- | --- |
| Exchange POST | exact extension Origin | none / cors / empty | absent | credential issued/registered |
| Readiness GET | **ABSENT** | none / cors / empty | Browser credential present | **401** |

The Runtime `LocalClientFilter` requires Origin for its Browser authentication branch. An Origin-less GET enters the native branch, where a Browser credential cannot match the native token.
Explicit `mode:"cors"` did not change the observed natural GET headers. Extension does not forge Origin or Fetch Metadata.
The popup correctly maps the 401 to pairing invalid; the compatibility mismatch prevents reaching ready.
This is a confirmed Runtime Browser-header contract issue, not evidence that the new Browser credential was actually revoked before readiness.
No Runtime patch is authorized by the cache-only companion exception. A separately scoped Runtime security contract review is required;
it must preserve registered Browser identity/capability/ownership checks and evaluate natural GET requests before changing admission.
No weakening of security or speculative companion patch was applied.
Final metadata evidence: ignored `.verification/m2b2b-smoke/chrome-smoke-evidence.json`, 2026-10-03 00:07:06 +08:00.

## 27. Real Chrome Full Page

UNVERIFIED / blocked before Translate could become ready. Ordinary page/Footer/viewport and MDN acceptance cannot be inferred from mock or synthetic HTTP results.
The opt-in runner contains the ordinary-page check but did not execute it past the readiness gate.

## 28. Real Chrome Dynamic

UNVERIFIED / blocked. Existing `test/dynamic-test-page.html` and privacy fixture retained; Load More/catch-up/partial/rearm/Restore require rerun after contract compatibility is resolved.

## 29. Real Chrome Selection

UNVERIFIED / blocked. Actual native context-menu click, selection card, same-text reuse, stale response, iframe and editable/privacy boundaries still require acceptance.
Calling a handler directly is not presented as native context-menu evidence.

## 30. Real Chrome Cache

UNVERIFIED / blocked. Automated page-lifetime second hit/Restore/Selection/identity isolation PASS.
No migrated Chrome cache, across-page or browser-restart translation-cache claim.

## 31. Runtime Offline / Recovery

Mock protocol/content cache enforcement PASS. Real Chrome offline/recovery UNVERIFIED because normal authenticated readiness already fails.
Owned test Runtime stops cleanly; production code/Manifest statically prove no direct Provider path or fallback.
No existing user's Runtime was stopped. Provider remained running; no actual migrated Chrome translation was generated.

## 32. Provider Offline / Recovery

Mock controlled unavailable/error mapping PASS. Real Chrome provider outage/recovery UNVERIFIED.
The opt-in runner supports a verification-only loopback relay outage while actual Provider stays intact; that acceptance step was not reached.
No Provider installation/configuration/model download or user's Provider process termination.

## 33. Revoke / Re-pair

Mock invalidation, local Forget and re-pair safeguards PASS. Real test client was revoked by the isolated native authority during cleanup.
This cleanup is not a completed Windows Assistant Revoke → real extension 401 → re-pair end-to-end acceptance.
The current readiness 401 occurs before intentional revoke and must not be used as revoke UX proof.

## 34. MV3 Long Task

**UNVERIFIED / blocked**, no migrated 30–45s claim. Prior v0.4.1 R01 PASS stays historical.
The opt-in runner prepares one real provider generation with a 35s relay delay, popup closure and detached worker debugger;
the readiness failure prevented this step. Header diagnostics temporarily attached the worker only for the failed pairing/readiness phase.
No offscreen, keepalive ping, alarms, daemon, WebSocket product transport or native messaging was added.

## 35. Known Limitations

- Confirmed Origin-less Chrome GET incompatibility is the release blocker. True Chrome translation/polling cannot pass on the current baseline contract.
- Windows Assistant GUI pairing/revoke, real clipboard Origin copy, Chrome restart, MDN, frame/privacy/native Selection and long task are pending.
- Browser input admission is bounded to current stable Single limits; Runtime remains final authority if profiles/configuration change.
- Task metadata cache identity is learned, not continuously rediscovered; future freshness requirements need a separately reviewed contract.
- Communication loss does not prove non-submission or cancellation; Runtime tasks are bounded but not durably replayable.
- Testing is on the current Windows/Chrome environment; no broad version/OS/performance guarantee.

## 36. B11 / B12 Status

**B11 inline BR layout: DEFERRED. B12 mutation debounce starvation: DEFERRED.**
Neither issue was fixed or redesigned during migration; their existing code/fixture behavior is preserved.

## 37. Deferred Scope

No Summarize/Ask Browser route, chat, Memory, Finance, M3, RAG, Agent/tools, Knowledge, Cloud, Streaming, Voice, Vision, OCR or screenshot capability.
No Desktop main UI, new Provider framework, dependency/build migration, installer or Workspace progress sync.
Runtime companion changes are deferred to separately scoped contract review, not silently bundled in this branch.

## 38. Files Changed

- `.gitignore`, `README.md`, `package.json`, `package-lock.json`.
- `browser-extension/manifest.json`, `config.js`, `background.js`, `content.js`, `popup.html`, `popup.css`, `popup.js`.
- New trusted-worker `runtime-client.js`, `runtime-storage.js`, `runtime-router.js`.
- `docs/DEVELOPMENT_STATUS.md`, this report.
- `test/behavior-test.js`, `test/popup-behavior-test.js`.
- Replace `test/background-model-test.js` with `test/background-runtime-test.js` and `test/runtime-harness.js`.
- Development-only `test/static-audit.js`, `test/real-runtime-smoke.js`, `test/chrome-runtime-smoke.js`, `test/cdp-client.js`.

Runtime repository, hotfix report, content.css and existing HTML fixtures have no changes. Private evidence/profile/log/auth files remain ignored.

## 39. Architecture Compliance

Extension production has one AI backend, Shared Runtime, and no Provider-owned configuration/parser/fallback.
Runtime task ownership, translate-only capability, policy and execution remain Runtime responsibilities; Browser cannot access native management APIs.
Normal batch remains one task/provider execution, Single is only the complete oversized-record admission path.
Security headers remain Browser-controlled, even when that exposes the baseline mismatch. No workaround bypasses the stated trust boundary.
Chrome transport compatibility remains unfulfilled; architecture implementation alone does not establish full Browser Convergence.

## 40. Workspace M2 Final Sync Readiness

**NOT READY.** M2B-2B is not CLOSED — GO and is not published to local-ai-assistant/main.
Workspace STATUS/architecture/docs stay unchanged. Next required step is a separately scoped Runtime security contract review of the confirmed natural GET behavior,
followed by rerunning Chrome pairing/readiness/full page/Dynamic/Selection/cache/offline/provider/revoke/MV3 acceptance.
Only after all GO gates and the separately authorized publication should Workspace M2 Final Status Sync begin.

Reference API behavior was checked against [Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage),
[Chrome extension cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), and local Chrome DevTools protocol schema.
The absence of Origin is a current real-Chrome network observation, not an inference from those documents.
