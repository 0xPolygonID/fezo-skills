# Final Review — Smart Routing (`fezo-skills`, branch `develop`, `9fd1e8e..9ef4d30`)

**Verdict: ship with follow-ups.** Every defect the round-1 review found is genuinely fixed, not papered over — I re-derived the RRF arithmetic by hand, re-ran the cap-defeating inputs, and re-tried the adapter-robustness holes; all of them now behave correctly (details in *Round-1 regressions* below). The feature is real and reachable: `plan`/`research` are wired into `runCli`, the bundle contains every new symbol, `pnpm test` (788/22), `pnpm typecheck`, `pnpm bundle` (tree clean afterwards) and `pnpm pack:check` all pass, no new runtime dependency, no second HTTP loop, no LLM, no new credential. The engineering quality is unusually high — the rationale comments are load-bearing rather than decorative, the deviation record is exemplary, and the executor's plan-order slotting is exactly the right answer to a problem most implementations would have shipped as a race. What holds it back from an unqualified ship is a cluster of **reporting-honesty defects on the abort and budget paths**: an aborted round reports work it never started as "returned no results" and hands the agent ready-to-run commands that would spend again into an account that just ran out of money; `--max-calls` below one fan-out width silently bills nothing and exits 2; and the `SNIPPET_MAX_CHARS` cap does not cover the adapter path, which is precisely the path Task 14 exists to populate. None of these lose money silently in the way B2/B3 did, and none corrupt the merged result set — they are all fixable inside `research.ts` plus one line in `aggregate.ts` — but three of them contradict the module's own stated principle that "a silent gap reads as full coverage", so I would not consider the feature finished until they land.

---

## Verification I ran

| Command | Result |
|---|---|
| `pnpm test` | 22 files, 788 tests, pass (2.75s) |
| `pnpm typecheck` | clean, exit 0 |
| `pnpm bundle` | writes both bundles; `git status` clean afterwards (only the untracked `docs/superpowers/reviews/` you handed me) |
| `pnpm pack:check` | `OK (7 files; … 1 shipped script(s) self-contained; shipped bundle reports its own version)` |
| `node dist/fezoctl.mjs plan "compare https://vercel.com/pricing and https://netlify.com/pricing"` | **exit 0**. `intents: scrape, search` / `queries: "compare and"` / two targets / `depth: shallow (fan-out 2)` / `signals: url-literal:2; search-verb; short-prompt:2-tokens`. No network touched, no credentials needed. |
| `node dist/fezoctl.mjs plan "latest research on solid-state batteries" --json` | **exit 0**, well-formed plan JSON: `intents ["search","news"]`, `depth "research"`, `fanout 8`, signals include `no-decomposition: …supply --queries` |
| `node dist/fezoctl.mjs research "x" --plan-json '{not json}'` | **exit 1**, stderr `fezoctl: research: --plan-json is not valid JSON: Expected property name or '}' …` — before `openGateway`, so nothing billed |
| `node dist/fezoctl.mjs research "x" --session '../escape'` | **exit 1**, `session id must be 1-64 characters of letters, digits, dot, dash or underscore` |
| `node dist/fezoctl.mjs --help` | **exit 0**, both new commands in the usage block plus the depth/`--session` paragraph |

Bundle contains the feature (round-1's B1 is gone): `mergeItems` 3, `canonicalizeUrl` 3, `heuristicPlanner` 2, `RESPONSE_ADAPTERS` 2, `parsePlanJson` 2, `orderByIndexDiversity` 3, `runResearch` 2, `renderResearch` 2, `validateSessionId` 2 occurrences in `dist/fezoctl.mjs`.

---

## Round-1 regressions: all genuinely fixed

I re-ran round-1's own reproductions against `src/`, not against the repair commit's tests.

| Finding | Status | Evidence I produced |
|---|---|---|
| **B2** RRF double-count | **Fixed** | One lane returning a wire story at three hosts now yields `providers: [{you,1,1}]`, `score 0.016393` — one entry, not three, and no longer beats a genuine two-provider agreement. The `you+exa` agreement scores `0.032522` and outranks the single-provider `0.016393`. The invariant is declared on `ProviderHit` (`src/engine/aggregate.ts:270-283`) and enforced by the exported `recordHit` (`:306`) at all four sites — including the executor's cross-query union (`src/engine/research.ts:467`, `:491`). |
| **B3** spend caps | **Fixed** | `PLAN_SCHEMA.properties.fanout` now carries `maximum: MAX_FANOUT` (`plan.ts:76`) and `parsePlanJson({queries:['x'],fanout:9999})` throws `/fanout must be <= 10`. `mergePlan(base,{fanout:9999}).fanout === 10`. `clampPlan` bounds `queries.length` and `targets.length` against `MAX_RESEARCH_CALLS` (`plan.ts:276-281`): 500 queries at fanout 10 → 2 queries / 20 implied calls; 500q/100t/fanout 99 → 0q/24t/24 implied. `1.5`, `0`, `-1`, `"x"`, `null`, `true` all rejected by the schema. The executor budgets independently (`research.ts:252-269`), so an **unclamped** hostile plan (50 queries × fanout 999 + 50 targets) handed straight to `runResearch` issued exactly **24 HTTP calls** and reported all 46 dropped queries and all 50 unfetched targets. |
| **H1** adapter returns non-array | **Fixed** | `extractItems('bad', body)` with an adapter returning `null` falls back to the sniffer and returns `[{url:'https://a.example'}]` (`aggregate.ts:255-256`). Throwing adapter: same. |
| **H2** item with no url | **Fixed** | `sanitizeRow` (`aggregate.ts:421`) drops `{title:'no url'}`, `undefined`, `{url:42}` and keeps only the valid row; a non-string `title` falls back to the canonical URL placeholder; a non-string `snippet`/`publishedAt` is dropped. |
| **M1** nested enums unfrozen | **Fixed** | `freezeDeep` (`plan.ts:99-104`) — `PLAN_SCHEMA.properties.depth.enum` and `.source.enum` both `Object.isFrozen === true`. The recursive walk is the right call over a hand-enumerated one, and the comment says why. |
| **M2** snippet cap | **Fixed on the sniffer path only** | `sniffItems({results:[{url,content:<200k>}]})` → snippet length 500. **But see M-1 below: the adapter path is still uncapped.** |
| **M3** tracking params | **Fixed** | `source` and `referrer` removed from `TRACKING_PARAMS` with a "must not be added back" rationale (`aggregate.ts:33-39`); `https://example.com/item?id=5&source=rss` round-trips intact. Vendor click ids retained and the deviation is recorded in the spec. |
| **M6** lane ordering | **Fixed** | Documented on `mergeItems` in the strongest terms (`aggregate.ts:458-465`) and enforced by the executor slotting lanes by `(queryIndex, rank-1)` (`research.ts:275-291`, `:340-341`), with two dedicated tests (`tests/research.test.ts:160`, `:294`) that vary network latency and assert an absolute order. |

Round-1's **L2** (userinfo survives canonicalization) is still open: `canonicalizeUrl('https://user:pw@example.com/a')` returns it verbatim, and it now reaches the 0600 session file on disk via `seenUrlsFrom`. Still Low, but it has a disk-persistence consequence it did not have in round 1.

---

## Blockers

None. Nothing here loses a caller's money silently, corrupts the merged result set, or breaks the shipped bundle.

---

## Major

### MAJ-1 — An aborted round reports never-started work as empty results, and emits follow-up commands that spend again

`src/engine/research.ts:383-401`. The abort flag itself works correctly — I confirmed in-flight lanes are awaited and no new lane starts. What is wrong is the **report**.

Concrete input: plan `{queries:['alpha','beta','gamma'], targets:['https://t1.example'], fanout:2}`, `concurrency:1`, first lane returns a gateway `insufficient_balance` (402).

Observed output:

```
http calls issued: 1 of 7          <- the abort flag did its job
ok false   aborted "insufficient_balance: …"
coverage.droppedQueries  []        <- WRONG: 'beta' and 'gamma' never had a lane started
coverage.unfetchedTargets []       <- WRONG: the target was never fetched and vanishes from the report
coverage.gaps [
  "\"alpha\" returned no results",
  "\"beta\" returned no results",   <- 'beta' was never asked; this says the web is empty
  "\"gamma\" returned no results",
  "you failed (insufficient_balance)"
]
nextActions [
  "fezoctl research 'alpha' --depth research",   <- 8 billed lanes
  "fezoctl research 'beta'  --depth research",   <- 8 billed lanes
  "fezoctl research 'gamma' --depth research",   <- 8 billed lanes
  "fezoctl providers --intent search"
]
```

Three separate problems, all from the same root: `droppedQueries` (`research.ts:251`) is populated only by the *budget* loop, and `unfetchedTargets` (`:269`) only by the budget split — neither knows about the abort. Nothing reconciles `plannedLanes` against `laneReports` holes at `:387`.

1. **The gaps lie.** `"beta" returned no results` is produced by `computeCoverage` (`aggregate.ts:700`) from an empty per-query merge. A query that was never asked and a query the whole web could not answer are rendered identically — the exact failure `computeCoverage`'s own docstring (`aggregate.ts:661-669`) says it exists to prevent, and the spec's § Coverage requires "planned-but-unexecuted work: dropped queries, unfetched targets".
2. **The target disappears.** `documents: 0`, `unfetchedTargets: []`, no gap mentioning `t1.example`. A caller who asked for a URL to be fetched gets a round that neither fetched it nor said it didn't.
3. **The next actions re-spend into a tripped limit.** `insufficient_balance` and `limit_exceeded` are account-scoped by definition (`retry.ts:68`). Emitting 24 lanes' worth of ready-to-run commands at that moment inverts the abort's entire purpose — and SKILL.md instructs the agent to run them ("run the command the round offers in `next_actions` before writing your reply", `skills/fezo/SKILL.md:395-398`).

Fix: after `pool()` drains, compute unstarted work by diffing `plannedLanes`/`fetchTargets` against the written slots; feed unstarted queries into `droppedQueries` (or a new `abortedQueries`) and unstarted targets into `unfetchedTargets` with `reason: 'round aborted'`. Then suppress query/target `nextActions` when `aborted !== undefined`, leaving only a "resolve the account issue" action.

### MAJ-2 — `SNIPPET_MAX_CHARS` does not cover the adapter path, which is the Task 14 path

`src/engine/aggregate.ts:183-186` applies the cap inside `toRawItem`, which only the **sniffer** calls. `extractItems` returns adapter output uncast-checked element-wise (`:256`), and `sanitizeRow` (`:421-431`) validates types but applies no cap.

Concrete input: register `RESPONSE_ADAPTERS['you_search'] = () => [{url:'https://a.example', title:'t', snippet:'x'.repeat(200000)}]`, run a fanout-1 round.

Observed: `outcome.items[0].snippet.length === 200000`. Round-1's M2 was fixed on the path that was live at the time and left open on the path Task 14 is about to fill. `SNIPPET_MAX_CHARS`'s own docstring says "Capping per item rather than per document keeps the bound true however many providers answer" — it is not true for any adapter-served provider.

Fix: move the truncation into `sanitizeRow` (or apply it in both places), so the cap is a property of every item entering `mergeItems` rather than of one of the two producers. This is a one-line change and it is a Task-14 gate.

### MAJ-3 — `--max-calls` below one fan-out width bills nothing and exits 2, and the spec's second truncation rule is unimplemented and unrecorded

`src/engine/research.ts:253-259` drops **whole queries only**: `if (lanes.length > budget) { droppedQueries.push(query); continue; }`. The spec (`specs/…:149-151`) says the executor "truncates deterministically (whole queries first, **then lowest-diversity providers**)". The second half does not exist, and unlike every other deviation in this change it is **not recorded** anywhere — I grepped the plan, the spec and the source for `lowest-diversity`.

Measured, single-query rounds:

```
fanout=5 maxCalls=4 -> billed=0  dropped=["alpha"]  items=0  ok=false  (exit 2)
fanout=8 maxCalls=1 -> billed=0  dropped=["alpha"]  items=0  ok=false  (exit 2)
fanout=5 maxCalls=5 -> billed=5  dropped=[]         items=5  ok=true
```

So `fezoctl research "…" --depth research --max-calls 4` does **nothing at all** and exits 2. `--max-calls` is documented in `--help` as a budget flag; a user capping spend below the fan-out width gets an operational failure instead of a narrower round, and the 4 calls they authorized go unspent. The spec's rule would have run 4 of the 5 lanes.

Fix: either implement the per-query trailing truncation the spec describes (drop from the tail of the diversity order, which by construction is the lowest-diversity provider) and report the reduced width, or amend the spec and record the deviation — but the current state is a silent divergence from a written rule with a user-visible bad outcome.

### MAJ-4 — The heuristic bills a residual made entirely of connectives, and `next_actions` amplifies it 4×

This is the defect you flagged. I rate it **major**, and higher than "wasted 2 calls" because of the amplification.

`src/engine/planners/heuristic.ts:179-186`: `residual` is the prompt minus its URLs, and a query is emitted whenever `wantsSearch && tokens.length > 0`. `wantsSearch` is true if `hasQuestion || hasSearchVerb || tokens.length >= 4`. Nothing checks that the residual carries any *content* word — and `src/engine/rank.ts:35` already exports the `STOP_WORDS` set that would.

Measured across the family:

```
"compare <url> and <url>"                     -> queries ["compare and"]         billed 4 (2 search + 2 targets)
"what https://example.com/a"                  -> queries ["what"]                billed 3
"is https://a.example/x better"               -> queries ["is better"]           billed 3
"<url> and <url> and the other one"           -> queries ["and and the other one"] billed 4
"find https://a.example"                      -> queries ["find"]                billed 3
"a the of and https://a.example"              -> queries ["a the of and"]        billed 3
```

The guard *does* work for the single-token cases (`"<url> and"`, `"the <url>"`, `"summarize <url>"` all yield `queries: []`), so the hole is specifically: a search **verb** or a **question word** alone, or ≥4 tokens that happen to all be stop words.

Then the amplification. Running the real round for `"compare <url> and <url>"` with a session:

```
billed 4
gaps        ["\"compare and\" is thin (2 unique URLs)"]
nextActions ["fezoctl research 'compare and' --depth research --session r-42"]
```

The meaningless query returns junk, is correctly diagnosed as thin, and the follow-up command the agent is told to run is that same meaningless query at **depth research = 8 more billed calls**. Two wasted calls become ten, and the round-1 principle that gaps must be actionable is inverted — the gap is real, the action is worthless.

Fix, using the set that already exists: after computing `tokens`, compute `contentTokens = tokens.filter(t => !STOP_WORDS.has(t))` and additionally require `contentTokens.length > 0` before emitting a query. Add `compare`, `find`, `search`, `summarize`, `summarise` — the `SEARCH_VERBS` set at `heuristic.ts:115` — to the stop-word test for this purpose (a bare verb with no object is not a query), and push a `residual-has-no-content` signal so the decision is visible the way every other decision in that module is. Table rows for `"compare <url> and <url>"` and `"what <url>"` belong in `tests/heuristic-planner.test.ts`'s `ROWS`; note the existing row at `:58` (`"what does <url> say about pricing"` → `"what does say about pricing"`) is the case that must keep working.

---

## Minor

**MIN-1 — A query with zero resolvable lanes is reported as "returned no results", and `skipped` stays empty.** `src/engine/research.ts:255` pushes `{query, lanes: []}` and nothing records why. Measured with an empty catalog: `served []`, `failed []`, `skipped []`, `gaps ["coffee returned no results"]`, `billed 0`. Measured with a sparse catalog (fanout 4, one provider present): `billed 1`, `skipped []`, gap `"coffee" is thin (1 unique URLs)` — the round quietly fanned out to a quarter of the requested width and said nothing. The spec's § Coverage asks for "providers … skipped (with reason)"; `skipped` (`research.ts:319`) is only ever written when a lane actually ran and preflight rejected it. A provider dropped for absence from the catalog is exactly a "provider the round declined to call" and should be named.

**MIN-2 — A flag-built plan with nothing to do exits 2 with an empty report, where the JSON path exits 1 with an explanation.** `parsePlanJson` (`plan.ts:168-174`) refuses a plan with neither queries nor targets, with an excellent message. The flag path has no equivalent: `research "hello" --queries "   "` builds `{queries:[],targets:[]}` (clamped away), and `runResearch` returns `ok:false` with `items 0, gaps [], nextActions []` — exit 2, zero diagnostics, an entirely blank report. Apply the same check to the merged plan in `planFromFlags` (`cli.ts:1063-1092`) so both paths fail as usage errors.

**MIN-3 — `--intents scrape` with a query still bills search providers.** `research.ts:93` filters `scrape`/`crawl` out of the intent list, and `:109` falls back to `['search']` when the filtered list is empty. Measured: `{intents:['scrape'], queries:['coffee'], fanout:4}` → `billed 3`, `served ["you","exa","brave"]`. A caller who narrowed the intent to `scrape` and supplied no targets gets a search fan-out they did not ask for. Either drop query lanes when no search-shaped intent survives (reporting it as a gap), or reject the combination at parse time.

**MIN-4 — Duplicate follow-up actions on a multi-lane failure.** `aggregate.ts:787-792` emits one action per failed backend, all with the identical `cmd: fezoctl providers --intent search`. An all-fail round emits it three times (measured). Dedupe by `cmd`.

**MIN-5 — `coverage` is the only section of the `--json` document in camelCase.** `render.ts:1034` maps `calls_billed`, `:1027` maps `backend_id`/`result_rank`, `:1031` maps `backend_id` — but `:1032` emits `outcome.coverage` raw, so the document carries `droppedQueries`, `unfetchedTargets`, `agreementMedian`, `uniqueUrls`, `domainConcentration` next to snake_case siblings. (`billing.attempts` is raw camelCase too, but that matches `renderCall`/`renderRun`, so it is pre-existing convention.) This is a public contract the moment SKILL.md teaches agents to read `gaps`; fix it now or never.

**MIN-6 — The session file grows without bound.** `cli.ts:1170-1180` unions `seenUrls` every round with no cap. Twenty rounds at 24 calls is a large-ish JSON file read and rewritten on every subsequent round. A `slice(-N)` with a comment about why the oldest URLs are the cheapest to forget would age better.

**MIN-7 — `tests/session.test.ts:56` uses `require('node:fs')` mid-test** in an otherwise-ESM file whose header already imports from `node:fs`. It passes under vitest, but it is the one place in the suite that breaks the house ESM rule, and it would not survive being run under plain Node.

---

## Cross-task integration

I traced every seam and they thread correctly.

- **planner → executor.** `cmdPlan`/`cmdResearch` both go through `planFromFlags` (`cli.ts:1063`), which ends in `clampPlan(mergePlan(planner.plan(prompt), overrides))` — so the executor never sees an unclamped plan, and `plan` and `research` cannot disagree about what a prompt routes to. `--intent` (singular) is rejected rather than ignored (`cli.ts:1069-1071`), which is the right call for the one near-miss flag pair that changes what gets billed.
- **executor → aggregator.** Lane items are slotted by `(queryIndex, rank-1)`, merged per query, then merged across queries with attribution rebuilt from the per-query items (`research.ts:414-511`). The per-query items are **copied** before the cross-query union (`:453-457`) — the comment explains that aliasing them inflated `agreementMedian` and suppressed the very gap the round exists to report. That is a subtle bug that was found and fixed, and there is a test for it (`tests/research.test.ts:227`).
- **aggregator → renderer → CLI.** All eight top-level sections present and pinned (`tests/render.test.ts:651`).
- **Session id → `next_actions`.** Yes. `cmdResearch` passes `sessionId: active.id` (`cli.ts:1158`) → `runResearch` → `nextActions(coverage, options.sessionId)` (`research.ts:542`) → `--session ${sessionId}` (`aggregate.ts:769`). I observed it end to end: `fezoctl research 'compare and' --depth research --session r-42`. Pinned at `tests/aggregate.test.ts:640` and `:680`.
- **Session file suppresses on round 2.** Yes, and it is tested end-to-end through `runCli` with a real temp home (`tests/cli.test.ts:2579-2630`): round one writes three canonical URLs at 0600, round two returns `items: []` with `suppressed: 3` and `callsBilled` accumulating 2→4.
- **Types.** `tsc` clean under `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`; every ESM import in `src/` and `tests/` carries `.js`.

---

## Correctness under real conditions

| Condition | Behaviour | Verdict |
|---|---|---|
| Empty catalog | `ok:false`, 0 attempts, gap `"coffee" returned no results`, `skipped []` | Safe, **misreported** — MIN-1 |
| Provider returns an empty body on a 2xx | `served:['you']`, `billed 1`, 0 items, gap emitted, no throw | Correct (`research.ts:326-331`) |
| Non-JSON 2xx (`<html>hi</html>`) | Identical: served, billed, 0 items, gap | Correct |
| Every lane fails | `ok:false` → exit 2, all three failures named with gateway codes | Correct, but MIN-4 |
| Account-scoped 402 mid-fan-out | Only 1 of 7 planned calls issued at concurrency 1; in-flight lane's result **kept** (measured: 2 calls / 10 planned at concurrency 2, `items:1`, `served:['exa']`); `ok:false` → exit 2 | Abort mechanism **correct**; reporting **wrong** — MAJ-1 |
| Targets but no queries | `ok:true`, one document, `served:['scrapingdog']`, no spurious gaps | Correct (`research.ts:537` and its comment) |
| Corrupt session file | `loadSession` returns empty state, round proceeds unsuppressed | Correct (`session.ts:47-54`), tested |
| Unwritable session directory | Round's results printed first, warning on stderr only, exit 0 | Correct (`cli.ts:1167-1189`), tested against a `ENOTDIR` cache root |
| Unclamped hostile plan straight into `runResearch` | 24 calls, everything else reported as dropped | Correct |
| `maxCalls: NaN` into `runResearch` | **300 calls billed.** `Math.min(NaN, 24)` is `NaN`; `lanes.length > NaN` is false, so every query passes the budget test | Not CLI-reachable (`cli.ts:1121-1124` requires an integer ≥ 1), but `clampPlan` guards this exact NaN class for `fanout` with a comment saying why (`plan.ts:262-271`) and `research.ts:244` does not. One `Number.isInteger` guard closes it. Worth fixing for a module whose header calls itself the absolute bound. |

---

## Spec coverage, section by section

| Spec section | Status | Implementation |
|---|---|---|
| Non-goals (no LLM, no credential, no new dep, `zug` untouched, one round per invocation, no decomposition) | ✅ | `package.json` devDeps only; `pack:check` self-contained |
| `RoutingPlan` (7 fields) | ✅ | `plan.ts:27-37` |
| Precedence flags > `--plan-json` > planner | ✅ deviation recorded, spec amended | `plan.ts:190-221`, `tests/plan.test.ts:48` |
| Validation → exit 1 during argv parsing | ✅ | `cli.ts:1074-1092`, observed exit 1 with no gateway open |
| `ResearchItem` / full `ResearchResult` document | ✅ | `aggregate.ts:318-328`, `research.ts:50-62`, `render.ts:1017-1040` |
| Depth→width table, `MAX_FANOUT`, `MAX_RESEARCH_CALLS` | ✅ enforced on every path | schema + `clampPlan` + executor budget; all three re-verified |
| Deterministic truncation, "reports what it dropped" | ⚠️ **partial** | Whole-query drop ✅; per-query provider truncation ✗ and unrecorded — **MAJ-3**. Abort-time unstarted work not reported — **MAJ-1** |
| Targets fetched once by one scrape provider | ✅ | `research.ts:202-222`, tested at `tests/research.test.ts:332` |
| Diversity ordering / `indexId` on every row | ✅ | `providers.ts:489-571`; the exhaustive characterization sweep is still the best test in the change |
| Sniffer + field candidates | ✅ superset | `aggregate.ts:59-64`, `:204-215` |
| Adapters (throw *or* non-array → sniffer) | ✅ | `aggregate.ts:251-262` |
| Snippet cap 500 | ⚠️ **sniffer only** | `aggregate.ts:183-186` — **MAJ-2** |
| Canonicalization | ✅ deviations recorded | `aggregate.ts:110-153`; userinfo still preserved (round-1 L2) |
| Dedup, two passes, first-seen representative | ✅ + order contract documented | `aggregate.ts:433-593` |
| RRF over **distinct** providers | ✅ | `aggregate.ts:580-582`, invariant on `ProviderHit` |
| Coverage: per-query, served/failed/skipped, concentration, dropped work, gaps | ⚠️ `skipped` under-populated (MIN-1); dropped work incomplete on abort (MAJ-1); rest ✅ | `aggregate.ts:670-737` |
| `nextActions` with `why` + runnable `cmd` incl. `--session` | ✅ shell-quoted, POSIX-verified by test | `aggregate.ts:764-811` |
| Session state (0600, `seenUrls`, `queries`, `callsBilled`, id regex) | ✅ | `session.ts`, end-to-end test |
| Budget/failure: partial success = success, abort stops the round, every billed call reported | ✅ mechanism / ⚠️ report | `research.ts:383`, `:537`; **MAJ-1** |
| CLI surface | ✅ all flags present, `--queries`/`--targets` repeatable | `cli.ts:108-119`, `:181-187` |
| Testing (the seven named files) | ✅ all present; `heuristic.test.ts` → `heuristic-planner.test.ts` (round-1 L1, still uncorrected in the spec) | |

---

## Test quality

The suite is genuinely protective, not implementation-restating. Concretely:

- **`tests/aggregate.test.ts:411`, `:426`, `:443`** are exactly the tests round-1 asked for and they are the right shape — one lane, two collapsing items, assert `providers` has length 1, plus a direct "two-provider agreement outranks one provider repeating itself" ordering assertion.
- **`tests/aggregate.test.ts:716`** runs every emitted `cmd` through `/bin/sh` and compares argv. That is the only honest way to test "ready to run" and it is a genuinely excellent test.
- **`tests/research.test.ts:160` and `:294`** vary network latency and assert an *absolute* order in both directions, with a comment explaining why `run(20) === run(0)` would be satisfied by two empty rounds. That is careful test design.
- **`tests/research.test.ts:227`** pins the aliasing bug that would have inflated `agreementMedian` — a defect that would have been invisible in any coarser assertion.
- **`tests/cli.test.ts:2579`** is a real two-round session integration test with a temp home, asserting the file contents, the mode, and the accumulating `callsBilled`.
- **`tests/providers.test.ts:467`**'s exhaustive diversity sweep remains the right answer to "this code has no observable effect on today's table".

Weak spots worth naming: `tests/render.test.ts:667` asserts `expect(text).toContain('2')`, which is satisfied by almost any output; `tests/heuristic-planner.test.ts`'s `ROWS` has no negative row for a residual of pure connectives, which is why MAJ-4 sailed through 788 tests; and there is no test that an adapter-sourced snippet is capped (MAJ-2) or that an abort reports its unstarted work (MAJ-1).

**Highest-value missing test:** *an aborted round must report the queries and targets it never started.* Two queries, `fanout 2`, `concurrency 1`, first lane returns `insufficient_balance`; assert `coverage.droppedQueries` contains the second query, `coverage.unfetchedTargets` contains the planned target, and `nextActions` does **not** contain a `fezoctl research` command. It is the one test that would have caught MAJ-1, it sits on the money path, and it pins a spec sentence (§ Budget and failure semantics) that currently has no assertion behind it at all.

---

## Task 14 readiness

The structure is right and materially better than at round 1: adapters are keyed by tool name, consulted before the sniffer, a throw *or* a non-array falls back, and element-wise row validation now sits at the single point rows enter `mergeItems` with a docstring explaining precisely which transcription mistakes it catches. That is the hard part done.

Two things should land before anyone spends money on captures:

1. **MAJ-2** — the snippet cap must cover the adapter path, or the first calibration run against a Firecrawl-family capture produces the multi-megabyte artifact the cap was written to prevent. This is the single highest-priority Task-14 gate.
2. A decision on round-1's **M4** (the sniffer cannot read an array of bare URL strings, `aggregate.ts:172`). Still true; still a defensible "report zero items in coverage" outcome; but it should be a decision taken on paper, not discovered against a billed capture.

`RESPONSE_ADAPTERS` remains an exported mutable module-scope object in a shipped bundle (`aggregate.ts:232`) — deliberate, so tests can install fixtures, and documented as such. Fine for now; worth revisiting the day anything else can reach the bundle.

**What a maintainer trips over in six months**, beyond the round-1 list (all of which still applies to `orderByIndexDiversity` and `canonicalizeUrl`'s three-path trailing-slash rule):

- `research.ts`'s budget arithmetic lives in three places that must agree — `clampPlan`'s formula, the executor's `budget` loop, and the `fetchable`/`unfetchedTargets` split. They agree today, and each carries a comment saying why, but nothing tests that they *stay* agreeing when `MAX_RESEARCH_CALLS` changes. A property test over `(queries, targets, fanout, maxCalls)` asserting `attempts.length <= min(maxCalls, MAX_RESEARCH_CALLS)` would be cheap and would pin all three at once.
- The `coverage` object is simultaneously an internal record and a public JSON contract (MIN-5). The moment an agent depends on `gaps`, changing `computeCoverage` becomes a breaking change with no marker saying so.

---

## Recommended follow-ups, in priority order

1. **MAJ-1** — report unstarted queries and targets when a round aborts, and suppress spend-again `next_actions` on an account-scoped abort. Add the missing test named above. This is the one finding I would block a merge on if the feature were going straight to agents.
2. **MAJ-2** — apply `SNIPPET_MAX_CHARS` in `sanitizeRow` so the cap covers the adapter path. One line. Task-14 gate.
3. **MAJ-4** — reject a residual with no content token, using `rank.ts`'s existing `STOP_WORDS` plus `SEARCH_VERBS`; emit a `residual-has-no-content` signal; add `"compare <url> and <url>"` and `"what <url>"` rows to the planner table.
4. **MAJ-3** — implement the spec's per-query provider truncation so `--max-calls` narrows a round instead of cancelling it, or amend the spec and record the deviation.
5. Guard `maxCalls` against non-finite input in `research.ts:244`, matching `clampPlan`'s existing NaN rationale.
6. **MIN-1** and **MIN-2** — report providers skipped for catalog absence; make an empty flag-built plan a usage error like the JSON path already is.
7. **MIN-5** — snake_case the `coverage` section before anything depends on it; **MIN-4**, **MIN-6**, **MIN-7** as cleanup.
8. Correct the two stale spec cross-references round-1 flagged (`heuristic.test.ts` → `heuristic-planner.test.ts`).

Nothing was committed, pushed, or modified during this review; the working tree is clean and `dist/` matches a fresh build.