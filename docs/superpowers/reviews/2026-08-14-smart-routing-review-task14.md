All probes complete, tree clean. Here is my report.

---

# Adversarial review: `eb90fab` + `cebebef`

## Verdict

**Keep both commits, but they are not done.** Of the twelve claims, ten are VERIFIED, one is PARTIAL, and **one has FAILED**: the headline fix in `eb90fab` — moving the 300-char title cap to run "ONCE and LAST, after dedup" — repairs `mergeItems` in isolation but **does not repair the production path**, because `runResearch` calls `mergeItems` *twice*, feeding the first call's already-capped titles into the second call's cross-host dedup key. The prior review's exact MAJOR 2 input, replayed through the real executor, still deletes a real result and still fabricates two-provider agreement. The predicted failure mode held: this fix batch introduced a defect of its own, again in the aggregation layer, again where it was moving capability around rather than tightening reporting. Separately, `cebebef`'s live calibration under-delivered on its own premise — the six real fixtures prove three of six providers ship an ISO-8601 `page_age` that `FIELD_CANDIDATES.publishedAt` does not list, so every Brave and You.com result reaches the wire undated and the fixture suite is too shallow to notice. Spend safety is genuinely intact across both commits: I could not construct any plan that bills more than `MAX_RESEARCH_CALLS`, and negative/NaN/fractional budgets all bill zero or truncate correctly. The committed fixtures are safe and honest — real public web data, no credentials, no PII.

Gates: `pnpm test` 882 passed / 23 files; `pnpm typecheck` clean; `pnpm bundle` clean with `git status` empty afterwards; `pnpm pack:check` OK (7 files).

## Per-claim verification

Mutation results below exclude `tests/skill_contract.test.ts`, which rebuilds the bundle and byte-compares it against committed `dist/` — it fires on *any* source edit, so it "killed" all 13 of my first-round mutants and told me nothing. Excluding it changes four verdicts.

| # | Claim | Verdict | Input → observed |
|---|---|---|---|
| **eb90fab** ||||
| 1 | Bare-URL sniffer constrained to an allow-list | VERIFIED | `sniffItems({search_metadata:{status:'Success'}, organic_results:[], related_searches:[2 urls], pagination:{…}})` → `[]`. Same for `images`, `sitelinks`, `next`, `error.docs`, `links`. `{results:['https://a…','https://b…']}` → 2 items; `{web:{results:[…]}}` → 1. Object rows still outrank 50 noise strings. Mutating the allow-list away → killed by `aggregate.test.ts`. |
| 2 | `docs` deliberately excluded | VERIFIED | `sniffItems({docs:[2 urls]})` → 0 items. |
| 3 | **Title cap runs once and last, so truncation can't reach the dedup key** | **FAILED** | Fixed in `mergeItems` alone (2 items, 1 provider each). But through `runResearch` — see MAJOR 1 — the review's own cookie-banner input yields **1 item, `providers=you+exa`, `score` doubled**. |
| 4 | `duplicates` redacts before comparing | VERIFIED | `mergeItems([{items:[{url:'https://user:s3cret@a.example/p'}]}])` → `url:'https://a.example/p'`, `duplicates:[]`, no `s3cret` anywhere. Reverting to `raw.url === canonical` → killed by `aggregate.test.ts`. |
| 5 | `Math.max(0,…)` floor restored, negative budget cannot bill | VERIFIED (untested) | `maxCalls:-5` with 6 targets → **0 HTTP, 0 billed, 0 docs**; with queries → 0. `-0` → 0. Removing the floor → **no behavioural test fails** (MINOR 2). |
| 6 | `skipped` distinguishes `(not in catalog)` / `(no query argument)` | VERIFIED | Both mutations (collapsing the message; never setting `inCatalog`) killed by `research.test.ts`. |
| 7 | Session bound enforced inside `saveSession` | VERIFIED | Removing both `.slice(-N)` in `session.ts` → killed by `session.test.ts`. |
| 8 | Surrogate-pair test rewritten to be non-vacuous | VERIFIED | Deleting the backoff in `capText` → killed by `aggregate.test.ts`. The old test survived this exact mutation; the new one indexes code units and pins `endsWith('\u{1D11E}…')`. |
| 9 | Intent honouring symmetric | PARTIAL | `--intents social` + target → 0 docs, 0 billed, gap `not fetched: … (no scrape-shaped intent declared (intents: social))`. Correct, but removing `fetchableTargets = noScrapeIntent ? [] : plan.targets` → **no test fails**: only the gap is pinned, not the non-spend. Over-reaches to `news`/`social`/`proxy`/`other` (MINOR 6). |
| 10 | Aborted round keys unstarted work on zero SERVED | VERIFIED | Reverting to zero-started → killed by `research.test.ts`. A query whose lanes ran and failed with a non-abort error correctly has no evidence about the web (a failed lane observed nothing), so the relabel is sound. |
| **cebebef** ||||
| 11 | Capture script shells out to `fezoctl call`, reads arg from live catalog | VERIFIED | Read `build/capture-responses.mjs`; `resolveArg` reads `schema <tool> --json` off the live catalog. `QUERY_ARGS` matches `ARG_CANDIDATES.query` exactly today, but is a hand copy (MINOR 8). Script does **not** array-wrap, so it still cannot capture `newsapi_articles` (MINOR 7). |
| 12 | Six real fixtures, sniffer reads all, adapters can stay empty | VERIFIED (shallow) | Yields match the real arrays: brave_news 20/20, brave_search 19/19, exa 10/10, firecrawl 10/10, geonode 19/19, you 10/10, all URLs `https://`. But see MAJOR 2 (dates dropped) and MINOR 5 (assertions can't detect degradation). |
| 13 | Executor sends a one-element array when schema says `type:'array'` | VERIFIED (untested) | `{type:'array',items:{type:'string'}}` → body `{"query":["coffee"]}`. `type:['array','string']` → `"coffee"`; `anyOf` → `"coffee"`; array-of-object → preflight-rejected, **0 requests** (fail-closed, no regression). Removing the wrap, or stubbing `isArrayTyped` to `false`, → **no test fails** (MINOR 1). |

## New findings

### MAJOR 1 — the title cap still poisons the dedup key, because `runResearch` merges twice
`src/engine/aggregate.ts:750` (cap at end of `mergeItems`) + `src/engine/research.ts:598,604-617`

`mergeItems` caps titles at the end. `runResearch` then builds `allLanes` **from the capped output** and runs `mergeItems` a second time (`combined`), whose pass-2 cross-host collapse keys on `titleKey(item.title)` — and `titleKey` strips the `…` as punctuation. So the truncated title reaches a dedup key after all, one layer up from where the fix was applied. The fix is correct for the unit and wrong for the program; the review's suggested fix (key on the *uncapped* title) would not have had this hole.

Input — the prior review's exact MAJOR 2 body, through `runResearch`, single query, fanout 3:

```js
const boiler = 'Cookie notice. We and our partners use cookies to store and access information on a device. '.repeat(4); // 368 chars
you   → { results: [{ url: 'https://site-a.example/story', title: `${boiler}Story A headline` }] }
exa   → { results: [{ url: 'https://site-b.example/other', title: `${boiler}Completely different article` }] }
brave → { results: [] }
```

Observed:
```
FINAL items = 1
  url=https://site-a.example/story providers=you+exa score=0.03278688524590164 dupes=["https://site-b.example/other"] titlelen=300
FINAL coverage.queries = [{"query":"storage","uniqueUrls":2,"agreementMedian":1}]
```

Expected 2 items, one provider each, `score` 0.0164. Three harms, one more than the original report:
1. A real, distinct document is deleted from `items`.
2. `providers` claims cross-provider corroboration that never happened, doubling the RRF score.
3. **New**: the document now contradicts itself — `coverage.queries[0].uniqueUrls` says `2` and `agreementMedian` says `1` (both computed from the correct per-query merge), while `items` shows 1 URL with 2 providers. A reader cannot tell which half is true.

The `aggregate.test.ts` regression test added for this claim asserts on a single `mergeItems` call, so it passes while the shipped path fails.

Fix: key pass 2 on a title that was never capped — carry the full title on the item (or a hash of it) and cap only at the emit boundary in `render.ts` — or make the second merge in `research.ts` receive uncapped titles.

### MAJOR 2 — calibration shipped fixtures proving `page_age` is dropped, and did not read them
`src/engine/aggregate.ts:63` (`FIELD_CANDIDATES.publishedAt`)

`publishedAt` candidates are `published_at, publishedAt, published_date, publishedDate, datePublished, date, pubDate`. Three of the six captured providers date their results with **`page_age`** (plus Brave's human-readable `age`), which is on neither list.

Input — the committed fixtures themselves:
```
extractItems('brave_news',   brave_news.json)   → 20 items, 20 titles, 20 snippets, dates: 0
extractItems('brave_search', brave_search.json) → 19 items, dates: 0
extractItems('you_search',   you_search.json)   → 10 items, dates: 0
```
`brave_news.json` result[0] carries `"page_age": "2021-01-12T23:22:13"` and `"age": "January 12, 2021"`; `brave_search.json` result[0] carries `"page_age": "2025-01-27T19:08:55"`. Both are discarded, so `published_at` never appears in the `--json` document for any Brave or You.com item — including for `--intents news`, where recency is the whole point of the intent.

This is precisely the class of defect Task 14 existed to find ("captured real responses… which is exactly what that exercise is for"), and the spec now asserts the sniffer "read every captured body". It read their URLs; it did not read their dates. Adding `'page_age'` to the candidate list is a one-line fix that the committed fixtures already pin.

### MINOR 1 — the array-wrap fix, the entire point of `cebebef`, has no test
`src/engine/research.ts:107-112, 437`. Both `args: {…: lane.argIsArray ? [lane.query] : lane.query}` → `lane.query` and `isArrayTyped(…) → false` survive the suite with `skill_contract` excluded. Compounding it, `newsapi_articles` failed pre-flight during capture (spec, Task 14 outcome), so there is no fixture and no live evidence either — the fix is unverified in every direction. The code is correct (I observed `{"query":["coffee"]}`), so this is a coverage gap.

### MINOR 2 — the restored `Math.max(0, …)` floor has no test
`src/engine/research.ts:351`. Removing it passes the suite. Behaviour is correct (`maxCalls:-5` → 0 billed), but this is the second time this floor has been silently deleted; it is exactly the regression a test exists to prevent.

### MINOR 3 — the target-refusal is pinned only in its reporting half, not its spend half
`src/engine/research.ts:350`. Setting `fetchableTargets = plan.targets` passes the suite — and produces an outright contradiction no test catches: the target is fetched and billed *and* simultaneously listed in `gaps` as `not fetched: … (no scrape-shaped intent declared)`. Removing `refusedTargets` from the gap list *is* caught, so only the cheap half is guarded.

### MINOR 4 — `data` on the allow-list is untested
`src/engine/aggregate.ts:311`. Dropping `'data'` passes the suite. `data` is the most generic name on the list and is the one most likely to hold an error envelope, but it is fallback-only and object rows always win, so the risk is small. Note the negative case `{data:[], next:[…]}` *is* tested; the positive case is not.

### MINOR 5 — the fixture suite asserts existence, not fidelity
`tests/aggregate-fixtures.test.ts:34-50`. The three assertions are `length > 0`, URLs match `^https?://`, and `length <= 50`. I degraded `brave_search.json` from 19 results to 1 → **20 tests passed**. I then replaced it entirely with `{"error":"quota exceeded","results":[{"url":"https://docs.brave.com/limits","title":"Rate limits"}]}` → **20 tests passed**. Truncating the sniffer's object sweep to `best.slice(0,1)` is likewise invisible to this suite (it is caught only by `aggregate.test.ts`). A regenerated-against-an-error-body fixture would sail through. Pin a per-fixture expected count instead, e.g. `brave_search → 19`.

### MINOR 6 — the intent refusal over-reaches past the case that was asked for
`src/engine/research.ts:345-350`. The prior review's MINOR 6 asked specifically whether `--intents search` should suppress target fetches. The implementation generalizes to *every* non-scrape intent, so `fezoctl research "https://x.com/u/status/1" --intents social` and `--intents other` now both refuse the fetch (observed: 0 documents, gap `no scrape-shaped intent declared (intents: social)`). `other` is a catch-all and `social` is the intent most likely to accompany a social-media URL; refusing there is a judgement the review did not ask for and the spec does not record. The heuristic planner emits `['scrape','search']` whenever a prompt carries a URL, so only explicit narrowing reaches it — which is why this is minor and not major.

### MINOR 7 — the capture script cannot capture the one tool that motivated its own fix
`build/capture-responses.mjs:110`. It builds `{[argName]: query}` with no array wrap, so re-running it today still fails `newsapi_articles` at pre-flight — the harness that discovered the array-typed argument cannot exercise the fix for it, and `TOOLS` will permanently report 6/7.

### MINOR 8 — `QUERY_ARGS` is a hand copy of `ARG_CANDIDATES`
`build/capture-responses.mjs:56`. Identical today (verified against `src/engine/one-step.ts:68`), and the docstring claims they share reasoning — but nothing enforces it, so a change to `ARG_CANDIDATES` would silently make captures use a different argument than the executor sends. The script already imports nothing from `src/`; a comment is the only link.

### MINOR 9 — the spec now describes the title cap incorrectly
`docs/superpowers/specs/2026-08-14-smart-routing-design.md` still reads "**`title` is capped like `snippet`** (300 vs 500 characters), on both the sniffer and adapter paths". `eb90fab` removed the cap from *both* producer paths (`toRawItem`, `sanitizeRow`) and moved it to the end of `mergeItems`. `cebebef` added a Task 14 section but left this line stale.

### MINOR 10 — `skill_contract.test.ts` masks mutation testing
It rebuilds the bundle and byte-compares it to committed `dist/`, so it fails on any source edit. Any future reviewer running a mutation sweep will see 100% of mutants "killed" and conclude coverage is total — as I did on my first pass. Five of the guards in these two commits are in fact unguarded. Worth a note in the suite header that mutation sweeps must exclude it.

## Closed from prior reviews

Confirmed closed, each by an input I constructed and a mutation that a behavioural test caught: MAJOR 1 (fabricated results from navigation arrays), MAJOR 3 (self-duplicate on credentialed URLs), MINOR 2 (`(not in catalog)` misreport), MINOR 3 (session bound), MINOR 4 (vacuous surrogate assertion), MINOR 7 (abort → "returned no results"). MINOR 1 and MINOR 6 are closed in behaviour but not in test (MINOR 2/3 above). MINOR 5 (`billing.attempts` camelCase) was resolved as documentation, which matches the review's "decide and record" ask. **MAJOR 2 is not closed** — see MAJOR 1 above.

## Spend safety

Re-verified across both commits; I could not construct a billing overrun. Observed HTTP calls against a counting `fetchFn`: 10 queries × fanout 10 → 24; `maxCalls: 1e9` → 24; `NaN` → 24; `3.7` → 3; `-5` → 0; `-0` → 0; 24 targets + 5 queries × fanout 10 → 24 (24 documents, 0 query lanes). `MAX_RESEARCH_CALLS = 24` holds on every shape. The intent-refusal path bills 0 as claimed.

## Fixture safety

Clean. All URLs are public institutional and news sites on a neutral query ("renewable energy storage"). No emails, no `api_key`/`token`/`signature` query parameters, no credentials. The long opaque strings are Brave CDN thumbnail content hashes on `imgs.search.brave.com` (118 of them), plus one Firecrawl job `id`, one Exa `requestId`, and one Geonode `job_id` — request correlation identifiers, not secrets. Nothing here should be withheld from a public repo.

## Prioritized follow-ups

1. **MAJOR 1 — re-fix the title cap for the composed path.** Make pass 2 key on an uncapped title, and add the regression test at the `runResearch` level, not the `mergeItems` level. The unit test that ships with `eb90fab` cannot see this class of bug.
2. **MAJOR 2 — add `'page_age'` to `FIELD_CANDIDATES.publishedAt`** and assert dates in the fixture suite. Three of six calibrated providers currently lose every date, including both news paths.
3. **MINOR 5 — pin per-fixture expected counts** so the calibration suite detects a degraded or error-body fixture. It currently cannot.
4. **MINOR 1/2/3 — add the three missing behavioural tests**: array wrap sends `[query]`, negative budget bills 0, and the refused target is not fetched. All three guards are live and correct but unguarded.
5. **MINOR 7 — array-wrap `build/capture-responses.mjs`** so `newsapi_articles` can actually be captured and the fix exercised end to end.
6. **MINOR 6 — decide and record** whether the target refusal should apply to `news`/`social`/`proxy`/`other`, or only to `search`. Then **MINOR 9** — correct the stale spec sentence about where the title cap runs.
7. **MINOR 4/8/10** — housekeeping: test the `data` allow-list entry, note the `QUERY_ARGS` drift hazard, and warn in `skill_contract.test.ts` that mutation sweeps must exclude it.