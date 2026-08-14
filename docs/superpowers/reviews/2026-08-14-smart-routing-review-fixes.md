## Verdict

Both commits do what they claim: I reproduced all 16 claims independently and 14 are fully VERIFIED, 2 PARTIAL. `pnpm test` (842 passed), `pnpm typecheck`, `pnpm bundle` (tree clean after), and `pnpm pack:check` all pass. The over-reach I was told to expect is **not** present in the executor or the planner — the targets-first reservation cannot double-spend (I mutated it; the new property test catches it), the budget cap holds on every shape I could construct including unclamped plans, negative/NaN/1e9 budgets and 24-target plans, the `--intents` refusal does not fire for `news`/`social`/`proxy`/`other`, the `skipped` reporting is silent on a healthy catalog, and the planner gate restores URL-free searches exactly as advertised. **The new damage is all in 84a7ff3's aggregation layer**, and it is real: the bare-URL sniffer fabricates results out of related-searches/pagination/image arrays precisely when a provider honestly returned nothing; the new 300-char title cap makes the cross-host dedup key lossy and silently merges two distinct documents that share a long boilerplate title prefix (destroying one result and inflating cross-provider agreement); and every credentialed URL now lists itself in its own `duplicates`. None is a blocker for shipping, but the first two produce silently wrong output on ordinary provider bodies and should be fixed before this is relied on.

## Per-claim verification

| # | Claim | Verdict | Input → observed |
|---|---|---|---|
| **0367e39** ||||
| 1 | Planner guard gated on `targets.length > 0` | VERIFIED | `plan("the who")`/`"what is this"`/`"list"`/`"find"`/`"who"`/`"is it"` → `queries:[prompt]`, no `residual-has-no-content`. `plan("what https://example.com/a")` → `queries:[]`, signals `residual-has-no-content, targets-only`. CLI `fezoctl plan "the who"` exit 0. Mutating the gate away → 5 test failures. |
| 2 | `NextAction.cmd` optional; abort action carries none | VERIFIED | 402 `limit_exceeded` round → `next_actions:[{why:…}]`, **no `cmd` key** in the `--json` doc; human render prints `  the round stopped on…` as prose, not in command position. |
| 3 | `maxCalls` truncated, not just finite-checked | VERIFIED | `maxCalls:3.7`, 3 queries × fanout 5 → 3 attempts, `"alpha" narrowed to 3 of 5`, `not run (call budget): beta, gamma`; no `returned no results`. Mutation caught. *(Note: unreachable from the CLI — `--max-calls` is validated as a positive integer. Defensive only.)* |
| 4 | Abort-stopped query not also reported as narrowed | VERIFIED | 402 on lane 1 of 2 queries → `beta` in `dropped_queries` (reason `round aborted`), absent from `narrowed_queries`. Mutation caught (3 failures). |
| 5 | Targets reserved before queries; no double-spend | VERIFIED | `maxCalls:6`, 6 targets + 1 query fanout 4 → 6 documents, 6 calls, query dropped `not run (call budget)`, next action `fezoctl research 'alpha'`. Mutating `budget = maxCalls - targetReserve` → `budget = maxCalls` → property test fails on 4 shapes. |
| **84a7ff3** ||||
| 6 | Unservable query = not-run with reason; absent ranked providers named in `skipped` | PARTIAL | Empty catalog → `dropped_queries:[{query:'coffee',reason:'no provider in the catalog can serve it'}]`, 0 attempts, no `returned no results`. **But** a provider that *is* in the catalog and merely exposes no query-shaped argument is reported `"<id> (not in catalog)"` — see MINOR 2. |
| 7 | Empty flag-built plan = usage error exit 1 | VERIFIED | `research hello --queries "   "` → exit 1, stderr `…no queries and no targets…`, 0 fetches; `--json` → `error.kind:"usage"`. Same for `plan hello --queries "   "`. Ordinary `plan` prompts (`"the who"`, `"???"`, `"what <url>"`, `--intents scrape`, `--targets " "`) all still exit 0. |
| 8 | `--intents scrape` + query does not fan out | VERIFIED | exit 2, **0 billed**, gap `not run (no search-shaped intent declared (intents: scrape))`, next action `fezoctl research 'coffee'`. Also fires for `['crawl']` and `['scrape','crawl']`; does **not** fire for `['news']` (2 billed), `['social']`, `['proxy']`, `['other']`. |
| 9 | `nextActions` deduped by `cmd` | VERIFIED | 3 failed backends → exactly one `fezoctl providers --intent search`. Mutation caught. |
| 10 | `coverage` section snake_case | PARTIAL | Full CLI `--json` doc: `unique_urls`, `agreement_median`, `backend_id`, `domain_concentration`, `dropped_queries`, `unfetched_targets`, `narrowed_queries` — complete and internally consistent; nested element objects are all single-word. Human renderer unaffected (reads the camelCase object). No doc/SKILL.md reads an old name (`gaps` and `next_actions` are unchanged). **But** the stated rationale ("every other section is snake_case") is false — see MINOR 5. |
| 11 | Session bounded 2000/500, newest kept | PARTIAL | The cli.ts expression is correct: 2010 URLs + 1 new → 2000 kept, first `u11`, last the new one. **But** the bound lives only at the call site — `saveSession` happily writes 2010/510 — and there is **no test**: deleting both `.slice(-N)` calls passes all 842 tests. |
| 12 | `title` capped at 300 on both paths, surrogate-safe | VERIFIED (with a regression, see MAJOR 2) | 301 chars → 300 ending `TT…`; exactly 300 → untouched; `'𝄞'.repeat(400)` → 299 units ending high+low surrogate then `…` (no lone surrogate); `'A'*298 + '𝄞'*10` → backs off correctly. Adapter path capped inside `sanitizeRow` (so `extractItems` alone returns uncapped, but nothing consumes it outside `mergeItems`). A lone surrogate already in the input passes through — truncation never *creates* one. |
| 13 | Bare-URL-string arrays read as a never-outranking fallback | VERIFIED as to precedence, FAILED as to safety | `{results:[{url,title}], related:[50 urls]}` → object row wins. `'/relative/path'`, `'doc:1234'`, `'https://a.example/foo bar'`, HTML strings all rejected. **But** see MAJOR 1. |
| 14 | Userinfo stripped from canonical URLs, redacted on `duplicates` | FAILED (partially) | `canonicalizeUrl('https://user:pw@example.com/a')` → `https://example.com/a` ✓; credentialed+bare merge → 1 item, no `pw@` ✓. **But** a lone credentialed URL yields `duplicates:["https://example.com/a"]` — identical to its own `url`. See MAJOR 3. |
| 15 | Budget property test over 8 shapes | VERIFIED | It is capable of failing: the double-spend mutation makes 4 of the 8 shapes fail with `expected 2 to be less than or equal to 1`. |

Guard-mutation sweep (14 mutations): all caught except **surrogate backoff** and **session bound** — reported below as minors.

## New findings

### MAJOR 1 — `sniffUrlStrings` turns "provider found nothing" into fabricated results
`src/engine/aggregate.ts:271` (fallback) and `:301` (`sniffUrlStrings`)

The fallback fires exactly when the object sweep found nothing — which is the normal shape of a **zero-hit SERP response**, where the only remaining URL arrays are related searches, pagination and image assets.

Input (a realistic zero-hit SERP body):
```js
sniffItems({ search_metadata:{status:'Success'}, organic_results: [],
  related_searches: ['https://www.google.com/search?q=a','https://www.google.com/search?q=b'],
  pagination: { other_pages: { '2': 'https://www.google.com/search?start=10' } } })
```
Observed: `[{url:'https://www.google.com/search?q=a'},{url:'https://www.google.com/search?q=b'}]` — two search-engine query URLs presented as findings. Same for `{images:['…/a.jpg','…/b.png']}` → two image files as results; `{pagination:{pages:[…]}, results:[]}` → pagination links as results; `{data:[], next:['https://api.example/page/2']}` → a cursor URL as a result; `{error:{docs:['https://docs.example/errors']}}` → a docs link as a result.

Downstream these are canonicalized, RRF-scored, counted in `unique_urls`, and — worst — they **suppress the honest `"q" returned no results` gap** and can flip a round from `ok:false` to `ok:true`. This is the same class of false claim about the web the rest of this repair set was written to remove, arriving through the door 84a7ff3 opened. The object sweep's precedence guard does not help, because the guard only fires when object rows exist.

Suggested fix: require positive evidence before promoting a string array — e.g. only accept it when the array's key is not in a deny-list (`related*`, `pagination`, `images`, `next`, `sitelinks`, `tags`) or, more robustly, only when the array is the body's own top-level/`results`-named array. A blanket "longest array of http(s) strings anywhere in the body" is not a result set.

### MAJOR 2 — the 300-char title cap makes the cross-host dedup key lossy and merges distinct documents
`src/engine/aggregate.ts:227` (`TITLE_MAX_CHARS`) + `:651-676` (pass-2 title collapse)

`capTitle` truncates to 299 chars + `…`; `titleKey` then strips the `…` as punctuation. So **any two documents on different hosts whose titles agree on their first 299 characters now collapse into one item** — and the cap's own docstring says the input class that motivates it is a provider putting whole-page text in the title field, which is exactly the case where a shared cookie/nav banner occupies the first several hundred characters.

Input:
```js
const boiler = 'Cookie notice. We and our partners use cookies to store and access information on a device. '.repeat(4); // 368 chars
mergeItems([
  { backendId:'you', rank:1, items:[{url:'https://site-a.example/story', title:`${boiler}Story A headline`}] },
  { backendId:'exa', rank:2, items:[{url:'https://site-b.example/other', title:`${boiler}Completely different article`}] },
]);
```
Observed: **one** item — `url:'https://site-a.example/story'`, `providers:['you','exa']`, `duplicates:['https://site-b.example/other']`. Before the cap these stayed two items with one provider each.

Two harms, not one: a real, distinct result is deleted from `items`, and the two providers are recorded as *agreeing*, which doubles the RRF score and raises `coverage.agreement_median` — the round now claims cross-provider corroboration it does not have. Suggested fix: cap the title for display/storage but build `titleKey` from the **uncapped** title (keep the original on the raw item, or key on a hash of it), so the cap bounds memory without weakening identity.

### MAJOR 3 — a credentialed URL is listed as its own duplicate
`src/engine/aggregate.ts:610`

```ts
duplicates: raw.url === canonical ? [] : [redactUserinfo(raw.url)],
```
The membership test compares the **unredacted** `raw.url` to `canonical`, then stores the **redacted** value — while the sibling branch eight lines down (`:618-619`) correctly compares the redacted value. For any URL whose only difference from canonical was its userinfo, the two are equal after redaction, so the item records itself.

Input (through the real CLI, provider echoes `https://user:s3cret@a.example/p`):
```
fezoctl research coffee --fanout 1
```
Observed:
```
1. A
   https://a.example/p
   sources: you (+1 duplicate link(s))
```
and in `--json`: `{"url":"https://a.example/p", …, "duplicates":["https://a.example/p"]}`. The round asserts a second link collapsed into this item when exactly one was returned. Fix is one line: redact first, then compare — `const original = redactUserinfo(raw.url); duplicates: original === canonical ? [] : [original]`.

### MINOR 1 — the `Math.max(0, budget)` floor was deleted, so a negative budget bills
`src/engine/research.ts:290-291, 339`. The old code had `const fetchable = Math.max(0, budget)`; the reservation rewrite dropped it. `targetReserve = Math.min(6, -5) = -5`, and `targets.slice(0, -5)` on a 6-element array is `[t0]`.
Input: `runResearch({ plan: {targets:[t0..t5]}, maxCalls: -5 })` → **1 call billed, 1 document** on a negative budget. Not reachable from the CLI (`--max-calls` must be a positive integer), which is why this is minor — but the same is true of the fractional budget this commit *added* a guard for, in the module whose header calls itself "the absolute bound". Restore the floor: `const targetReserve = Math.min(plan.targets.length, Math.max(0, maxCalls))`.

### MINOR 2 — `"(not in catalog)"` is asserted about providers that are in the catalog
`src/engine/research.ts:150`. `resolved` is false both when the backend is absent *and* when it is present but `resolveArgName(schema,'query')` finds no query-shaped argument.
Input: catalog `[brightdata_unlock(url), geonode_scrape(url)]`, `plan({intents:['proxy'], queries:['coffee']})` → `skipped: ['geonode (not in catalog)','brightdata (not in catalog)']` and `dropped_queries: [{reason:'no provider in the catalog can serve it'}]`. Both statements are false; the truth is "this provider takes a URL, not a query". Distinguish the two cases (`(not in catalog)` vs `(no query argument)`).

### MINOR 3 — the session bound is untested and is not a property of `session.ts`
`src/cli.ts:1193-1194`; `src/engine/session.ts:19-20`. `saveSession({seenUrls: 2010 entries})` writes all 2010 back; only cli.ts's call site truncates. Deleting both `.slice(-N)` calls passes the entire 842-test suite. Either enforce the bound inside `saveSession` (where the exported constants and their docstring live) or add a test at the cli.ts seam.

### MINOR 4 — the surrogate-pair test cannot fail
`tests/aggregate.test.ts:876`. `[...snippet].some((_ch, i) => …snippet.charCodeAt(i)…)` iterates **code points** but indexes **code units**: for an all-astral string the callback's `i` only ever reaches ~249, so it never inspects the truncation boundary at unit 498. Deleting the backoff (`if (last >= 0xd800 …) end -= 1;`) leaves all 842 tests green. The un-mutated code is correct (verified directly: `'𝄞'.repeat(400)` → 299 units ending in a complete pair), so this is a coverage gap, not a defect. Test the final code units directly instead.

### MINOR 5 — `billing.attempts` still emits camelCase in the same document
`src/engine/render.ts:1065`. The coverage rewrite's justification is "every other section of this document is snake_case". It isn't: the same `--json` output carries `{"tool":…,"backendId":"you","httpStatus":200,"gatewayCode":"limit_exceeded"}`. Either the rationale or the scope is wrong. (`AttemptLog` is emitted raw by `run`/one-step too, so changing it is a wider contract decision — but the comment should not claim a consistency that does not exist.)

### MINOR 6 — intent honouring is one-way
`src/engine/research.ts:298-299` refuses to *search* when the declared intents are scrape-shaped, but nothing refuses to *scrape* when they are search-shaped. Input: `fezoctl research "summarise https://x.example/page for me" --intents search --fanout 1 --json` → plan `intents:["search"]`, `queries:[]`, `targets:["https://x.example/page"]`, **1 billed scrape call**, zero searches. The user declared `search` and paid for a scrape. Pre-existing (targets bypass the intent list entirely), but 84a7ff3 introduced the principle and applied it to only one side.

### MINOR 7 — an abort can still produce `"…" returned no results`
`src/engine/research.ts:484-503`. The unstarted-query recovery only fires when *every* lane of a query is unstarted. Input: 2 queries × fanout 3, concurrency 1, first lane returns 402 `limit_exceeded` → gaps are `"alpha" returned no results`, `you failed (limit_exceeded)`, `not run (round aborted): beta`. Two of alpha's three requests were never sent and the third was killed by an account abort, yet alpha is described with the exact phrase the spec's own "Unstarted work is reported as unstarted" decision calls "a claim about the web made on a request never sent". The boundary is documented in the code, but a query with **zero served lanes** in an aborted round should carry the abort reason, not an emptiness claim.

## Prioritized follow-ups

1. **Fix MAJOR 1** — constrain `sniffUrlStrings` so it cannot promote related-searches / pagination / image / cursor arrays; today a zero-hit provider produces fabricated, RRF-scored results and hides the honest gap.
2. **Fix MAJOR 2** — build `titleKey` from the uncapped title so the 300-char cap stops destroying distinct cross-host documents and inflating `agreement_median`.
3. **Fix MAJOR 3** — redact before comparing at `aggregate.ts:610` (one line); add the missing single-lane credentialed-URL assertion on `duplicates`.
4. **Restore the `Math.max(0, …)` floor** on `targetReserve` (MINOR 1) and split the `(not in catalog)` message (MINOR 2).
5. **Close the two test holes**: the session bound (MINOR 3) and the vacuous surrogate assertion (MINOR 4) — both currently survive mutation.
6. Decide and record whether `AttemptLog` stays camelCase on the wire (MINOR 5), and whether `--intents search` should suppress target fetches (MINOR 6).