# POST-M2 TEST SIMPLIFICATION — BATCH 3 REPORT

Date: 2026-10-03 (Asia/Shanghai). Repository: qianlixunbai/local-ai-assistant.

## 1. Result

**GO / awaiting Closing Review.** Balanced simplification preserves the high-risk Browser regressions.
Automated tests: **101 PASS = 28 content + 68 background/runtime + 5 popup**.
Static/privacy audit: **12 PASS**. No production change; B-Core1–B-Core9 retained.
B11/B12 remain DEFERRED. M3 was not started.

This round removes one independent content wrapper, two background happy-path wrappers,
and the migration-only static guard. It also removes duplicate content setup/assertions.
Distinct protocol/security matrix rows remain separately counted; the estimated case counts are not targets.

## 2. Git

Reality Check completed on clean main before editing:

- local main, HEAD and fetched origin/main: b4c3a71ea7e85b8aee9fa779ad38bf448d5d47a0.
- git status, branch, HEAD, fetch, origin/main and last 12 commits checked.
- Branch: post-m2-test-simplification-3.
- Test commit: 2baf2659950cabd986b1645a4fa741b1d3208bc8 — test: simplify browser regression suite.
- This report is committed separately as docs: record browser test simplification.
- No merge, push, tag or release. main/origin/main stay at the stable baseline.

## 3. Baseline

npm ci, npm test and node test/static-audit.js all passed before editing.
Measured wall time for the complete baseline command sequence: **28.109 seconds**.

| Suite | Baseline |
| --- | ---: |
| Content scenarios | 29 |
| Background/runtime expanded checks | 70 |
| Popup scenarios | 5 |
| Total automated | 104 |
| Static/privacy checks | 13 |

The stable main's closing evidence records Browser Translator v0.5.0 / M2B-2B CLOSED — GO.
Historical real Chrome/MV3 evidence remains in [M2B-2B report](M2B-2B-RUNTIME-MIGRATION-REPORT.md);
it is not a fresh acceptance run for this batch.

## 4. Scope

Changed only test/behavior-test.js, test/background-runtime-test.js, test/static-audit.js
and this report. No runtime-harness or popup change was needed.
Production behavior, Runtime contract, permissions, acceptance tooling and Personal AI Workspace remain unchanged.

## 5. Before

Content was mostly independent regression scenarios. The clear duplicate fixtures were
fixed/sidebar/nav geometry and same-batch cache fan-out.
Background already iterated most negative cases, but repeated names hid the failing row;
successful task responses and selection message construction were duplicated.
Static audit fixed the release forever at 0.5.0, required permission ordering and retained an M2 migration-finalization guard.

## 6. Content Changes

- Old #3 fixed/sidebar/nav-without-overflow fixture is in old #2's geometry scenario.
  Exact expected inputs retain normal/partial viewport intersection, nested clipping,
  offscreen ordinary document eligibility, fixed/sidebar/nav bounds, and hidden exclusion.
- Old #8 stays independent. Its hidden paragraph and hidden inline source become visible,
  are rescanned and translated; old aggregate output is explicitly removed. Editable/read-only-island
  and hidden BR exclusions remain. Duplicate explicit editable Selection and designMode assertions
  are covered by old #5; zero-output Restore is covered by old #11.
- Old #18 stays independent for cross-batch reuse, original-record counts, Restore, LAT_RESET
  and the all-cache-hit path. Its duplicate same-batch fixture moves to old #11's existing
  full-page/footer fixture, now explicitly asserting all three duplicate records receive output.
- Old #19 rejected-Promise/no-failure-cache/explicit retry/raw-error-suppression remains unchanged.
- Old #26 intact oversized record/partial/failed-only retry remains unchanged.
- Every default-protected content scenario remains, including all separate race windows.

## 7. Background Runtime Changes

A small named-row runner prints family/caseName, rather than repeating a generic pass label.
Failed assertions print only completed-check/request/POST counts; catch suppresses raw exceptions.
Rows contain explicit expected controlled kinds, with no removal based on shared UI wording.

Named matrices cover Pairing, Storage, Submission envelope, Controlled task error,
Poll validation, Input budget, Runtime transport and the ASCII/Unicode Single safe path.
A shared accepted-task response and taskWorker fixture remove repeated successful submission setup.
A small Selection message builder does not invent a missing frame/document target.

RuntimeBatchHappyPath combines three old wrappers and retains/strengthens assertions for
one POST/one task, two polls at the same task ID, credential on every request,
redirect disabled, cookies omitted, complete submitted items, profile/prompt identity,
structured results and credential exclusion. The valid Location is consumed through polling.

All 9 submission faults, 11 controlled error codes, 4 poll mismatch rows, 6 invalid-budget rows,
2 safe Single rows, 2 malformed proofs and 3 storage failure rows remain independently executed.
Runtime offline, Provider unavailable and revoked credential remain distinct.
POST no-retry, stalled body deadline, oversized response, GET recovery/exhaustion and overall task deadline retain their assertions.
Partial-result mapping retains valid subsets and rejects/omits missing, duplicate, unexpected, empty and non-integer/wrong IDs.

## 8. Popup Changes

None. All 5 scenarios and assertions remain, including scoped progress, cancellation,
reopen/reconnect, proof clearing, Forget-local versus server revoke, storage failure and revoked state.

## 9. Static Audit Changes

- #2 uses order-independent exact permission sets, rejecting duplicates and additional permissions.
  storage is required; the sole Runtime host is required. Broad hosts and nativeMessaging,
  clipboardRead, offscreen or any unlisted permission still fail.
- #3 additionally checks the worker's Runtime-client import, actual dynamic CONTENT_SCRIPTS
  injection list, optional manifest content scripts and popup script references.
  Page/popup contexts cannot load/access RuntimeClient; fetch whitespace/computed property forms
  and alternative XMLHttpRequest/WebSocket/EventSource/sendBeacon transports are guarded.
  The existing Runtime-only host/provider guards remain. This is a lightweight source guard,
  not a complete JavaScript parser; arbitrary obfuscation is outside its claim.
- #12 compares manifest/package/lock root/lock package/content PING versions without fixing a version value.
- #13 is archived here: absence of background-model-test.js and exact npm script spelling were
  migration-finalization checks. Long-term architecture protection remains in #1/#2/#3/#6.
  Current npm test was actually executed, so this does not claim a static proof that arbitrary future scripts run the intended suites.
- Other source/privacy predicates remain: no direct Provider routes/settings/prompt ownership,
  content credential bridge, native token/WinCred/unsafe storage, synthesized browser headers,
  clipboard reads, unsafe logs, private artifacts, literal Browser credentials or personal absolute paths.

## 10. Acceptance Tooling

All tracked acceptance files are byte-identical to baseline:
test/real-runtime-smoke.js, test/chrome-runtime-smoke.js, test/cdp-client.js,
test/dynamic-test-page.html and test/privacy-hotfix-page.html.
The Chrome script still exercises actual exchange/readiness with natural extension headers,
and records safe Origin/Fetch Metadata presence plus credential-presence metadata through CDP.
It remains a real Browser release gate; automated fixture checks do not substitute for it.

No fresh headful Chrome or 38-second MV3 run was required: only regression tests/docs changed,
production is identical, and acceptance-tool behavior is identical.
The historical CLOSED — GO evidence is preserved with its original scope.

## 11. Replacement Mapping

Numbers refer to the 29-content/13-static baseline; named paths prevent renumbering ambiguity.

| Removed / merged old case | Replacement path | Same fault remains detectable because |
| --- | --- | --- |
| Content #3 independent wrapper/fixture | behavior-test.js: B13 clipping, viewport intersection, fixed/sidebar/nav and hidden exclusion (old #2) | Same fixed/nav visible inputs and vertical/horizontal offscreen exclusions are in the exact expected-input set; hidden/ARIA-hidden elements cannot enter it. Disabling nav/aside viewport bounds fails this merged scenario in the in-memory fault check. |
| Content #8 duplicate editable Selection/designMode/Restore assertions | behavior-test.js: old #5 nested privacy scenario and old #11 full-page Restore; #8 dynamic reveal retained | #5 verifies translated editable Selection in native/fallback visibility and zero designMode requests; #11 verifies all translation/marker removal. #8 still checks editable/read-only-island boundaries before/after dynamic reveal, refreshed output and obsolete source removal. Removing readable-source snapshot comparison fails #8. |
| Content #18 duplicate same-batch fixture | behavior-test.js: old #11 full-page/footer; old #18 cross-batch cache retained | Exact unique submitted texts plus 9 original outputs and 3 Save-job outputs detect dedupe/fan-out loss. Cross-batch case still expects 3 original records from 2 submitted texts, then no requests after Restore/LAT_RESET. Omitting cache writes fails that retained path. |
| Content #19 | Retained unchanged: transport failures stay uncached for an explicit retry | Different failure entrance (Promise rejection) is not equivalent to omitted/blank results. Still verifies failure count, no raw error response/log, restore and new retry request. No deletion proposed. |
| Content #26 | Retained unchanged: oversized records fail as partial and retry only failed records without truncation | Exact oversized source is submitted intact; partial status/counts and only-long-record retry catch truncation or resending success. No deletion proposed. |
| Background three happy wrappers | background-runtime-test.js: RuntimeBatchHappyPath | Every old predicate remains; submitted items, complete public identity/results and same task URL are stronger. Redirect/cookie/profile-identity mutations each fail this case with safe diagnostics. |
| Malformed submission generic loop | background-runtime-test.js: Submission envelope named rows | Each original 9 semantic faults still must return invalid after exactly 1 request; it is not replaced by a generic JSON parse failure. |
| Controlled error generic setup | background-runtime-test.js: Controlled task error named rows + taskWorker | All 11 external codes still have explicit kind mapping and PRIVATE response/log exclusion; shared text does not remove rows. |
| Budget generic loop | background-runtime-test.js: Input budget + Single safe path | All 6 rejection cases require unsupported and zero network; both ASCII/Unicode success cases require exact text/id and one Single POST. |
| Pairing/storage repeated labels and Selection setup | background-runtime-test.js: Pairing/Storage matrices and select helper | All 2 proof/3 storage rows and frame/document/editable-selection predicates remain; default target is empty, preserving missing-frame/document fail-closed behavior. |
| Poll/retry repeated task submission setup | background-runtime-test.js: taskWorker/accepted plus Poll validation and retained transport checks | Same views/overrides, request bounds, success/failure kinds and POST counts remain; rejected POST and stalled body keep separate names and deadlines. |
| Static #2 permission ordering | static-audit.js: only Runtime host and allowed permissions | Set equality accepts reordering but rejects additions, duplicates, missing storage or foreign hosts; positive and negative in-memory checks pass. |
| Static #3 exact fetch-call scan | static-audit.js: network stays in worker-loaded Runtime client, plus #1/#2/#6 | Worker loading and untrusted script boundaries are asserted in addition to network-owner scanning; whitespace fetch, alternative transport, page injection and popup loading faults fail. |
| Static #12 fixed 0.5.0 | static-audit.js: release metadata and content PING stay consistent | A synchronized future version passes; mismatched manifest or missing PING fails. All five release-version sources must agree. |
| Static #13 legacy file absence/exact npm script | Archived migration guard; static #1/#2/#3/#6 plus actual npm test gate | Obsolete filename/spelling are not long-term faults. Their intended architectural faults remain covered by Provider/config bans, sole Runtime permissions and trusted-worker network guard; actual tests verify the current runnable suites. |

## 12. Historical Bug Coverage

| Regression | Retained path |
| --- | --- |
| B01 record granularity/partial/source order | Ordinary multi-record anchor and partial failed-only retry scenarios |
| B02 popup Restore cancellation | Popup scoped operation/Restore preflight scenario |
| B03 source DOM identity | Separate source replacement, BR additions and dynamic hidden reveal scenarios |
| B04 frame/document privacy | Background missing/mismatched frame/document and exact injection checks; unchanged real Chrome tool/evidence |
| B05 fresh visibility | Dynamic paragraph/inline reveal and nested-scroll catch-up |
| B06 hidden inline/BR privacy | Native/fallback privacy, BR range geometry and dynamic reveal exclusions |
| B07 request/body deadline | Stalled POST body, per-request bounds, GET retry limits and separate overall task deadline |
| B08 popup progress/reopen | Scoped tab/operation/session and reopened GET_STATUS scenarios |
| B09 strict output IDs | Independent content cache-poisoning and worker partial mapping checks |
| B10 editable/Selection boundary | Native/fallback privacy/designMode, read-only island and ordinary input explicit Selection |
| B13 sidebar/nested scroll | Sticky/nested scroll, merged geometry matrix and BR line geometry |
| Generation/stale/cache windows | Old #7/#9/#15/#16/#22/#29 remain separate; cache identity, Single isolation, auth gating and LRU remain |

Historical Provider-specific implementation descriptions belong to their original releases;
this batch preserves their relevant Browser regression behavior through the current Runtime architecture.

## 13. Core Regression Gate

| Core | Evidence | Status |
| --- | --- | --- |
| B-Core1 Runtime/security/pairing | All frame/pairing/storage/readiness/security checks retained | RETAINED / PASS |
| B-Core2 Runtime protocol/batch | Happy task flow, semantic/error/poll/budget matrices, partial mapping and retry bounds | RETAINED / PASS |
| B-Core3 Full DOM/Viewport/Restore | Full-page/footer, merged geometry, viewport order and Restore | RETAINED / PASS |
| B-Core4 Dynamic/partial/generation | Independent catch-up, source mutation, partial retry and stale windows | RETAINED / PASS |
| B-Core5 Selection/frame/privacy | Native/fallback/editable boundaries, Selection races, exact target and safe errors | RETAINED / PASS |
| B-Core6 Cache identity/second hit | Dedupe fan-out, cross-batch/LAT_RESET, LRU, shared Selection cache, identity/auth gating | RETAINED / PASS |
| B-Core7 Popup state/security actions | All 5 unchanged popup scenarios | RETAINED / PASS |
| B-Core8 Architecture/release privacy | 12 static groups, including every security predicate and release consistency | RETAINED / PASS |
| B-Core9 Real Chrome/MV3 acceptance tooling | Tooling zero diff; historical CLOSED — GO retained; not rerun | RETAINED / HISTORICAL PASS |

## 14. After

| Suite | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Content scenarios | 29 | 28 | -1 |
| Background/runtime expanded checks | 70 | 68 | -2 |
| Popup scenarios | 5 | 5 | 0 |
| Total automated | 104 | 101 | -3 |
| Static/privacy checks | 13 | 12 | -1 |

These are printed/executed units, not a coverage percentage.
Keeping security/error rows and independent temporal windows is why the result remains 101.

## 15. Test LOC / Maintenance Impact

Physical lines, including comments/blank lines, measured against b4c3a71 with git show and current files.
No production/doc LOC is included. Acceptance tools/HTML fixtures are included only in the explicitly labeled overall total.

| File/scope | Before LOC | After LOC | Net |
| --- | ---: | ---: | ---: |
| test/behavior-test.js | 1109 | 1091 | -18 |
| test/background-runtime-test.js | 201 | 236 | +35 |
| test/static-audit.js | 35 | 51 | +16 |
| Changed test files | 1345 | 1378 | +33 |
| All tracked test JS | 2038 | 2071 | +33 |
| All tracked test files, including acceptance JS/HTML | 2181 | 2214 | +33 (1.51%) |

This is a modest net increase, not a LOC reduction. Explicit negative-row names and safe diagnostics
cost lines; the stronger static loading/release guard adds 16. Geometry, duplicate dedupe fixtures,
editable assertions and repeated Selection/task setup were reduced. The row helper and task response
builders are small; no parser, framework, hundreds of abstraction lines or new dependencies were introduced.
Maintenance improves through distinct failures and less repeated setup, with the 33-line cost stated openly.
The slight count reduction alone is not the justification for GO.

## 16. Tests

Final npm ci and npm test: PASS, 0 failures, 0 npm audit vulnerabilities.
Final npm ci + npm test wall time: **28.458 seconds**.
Final separate node test/static-audit.js wall time: **0.147 seconds**.
Combined measured durations: approximately **28.605 seconds**, versus baseline 28.109.
One local observation is not a performance benchmark; no speedup is claimed.

Syntax checks and git diff --check passed. Final changed paths and full diff were reviewed.
An ephemeral in-memory fault-validation run passed **16 checks**:
2 valid changes accepted (permission order, synchronized future release),
8 invalid static changes rejected (extra permission, foreign host, whitespace fetch, alternate transport,
page injection, popup Runtime-client loading, version mismatch, missing PING),
3 happy-path faults rejected (redirect, cookies, wrong profile identity),
3 selected content faults rejected (nav viewport bound, reveal snapshot, cross-batch cache storage).
It changed fs reads inside isolated test processes; no production files were written and no permanent
mutation suite/tool was added. Background failure output was also checked for private-value markers.

## 17. Static Audit

**12 PASS**, all 11 production files. Before adding this report: 29 candidate source/doc files;
after adding this report: 30. Candidate count includes tracked/untracked nonignored source/docs.
The retired check is only the old migration-finalization guard; security predicate coverage is retained.
The new report is included in the final privacy/path audit.

## 18. Production Zero-Diff

Verified against stable b4c3a71:

- browser-extension/**, including manifest, config and all runtime production modules: zero diff.
- package.json/package-lock.json: zero diff.
- popup tests and runtime harness: zero diff.
- All five acceptance JS/HTML files: zero diff.
- Personal AI Workspace: clean before/after, HEAD unchanged at a2d27d086d035c8860f7caafce3d7aa7e25ee38b.

Only the Browser branch/test/docs changed. npm ci refreshed ignored dependencies only.
No ignored historical evidence was deleted, moved or committed.

## 19. Files Changed

- test/behavior-test.js
- test/background-runtime-test.js
- test/static-audit.js
- docs/POST-M2-TEST-SIMPLIFICATION-BATCH-3.md

## 20. B11/B12

B11 inline BR layout: **DEFERRED**.
B12 mutation debounce starvation: **DEFERRED**.
No production repair, fixture deletion or claim that green regressions resolve these limitations.

## 21. Deferred Tooling Cleanup

Future release-tool reproducibility remains separately scoped.
Ignored .verification/m2b2b-final evidence/runners remain local and untouched; no migration/commit of them.
The stale R1 Chrome GET script recorded by the Workspace audit (ddfa4a0,
m2b2b-runtime-migration, Chrome154) is outside this repository and was not edited.
Tracked chrome-runtime-smoke.js's natural Chrome header gate remains.
No cross-repository audit/status sync or M3 work was undertaken.

## 22. Recommendation

**GO for Closing Review.** Production/tooling zero diff, automated/static gates green,
all removed assertions have explicit replacement or documented migration retirement,
all distinct protocol/security/privacy/race dimensions remain, and B11/B12 remain deferred.
Approve the bounded simplification on its coverage/diagnostic merits; the 101 count and slight LOC increase
are disclosed. Keep merge/push/tag/release pending the separate Closing Review.
