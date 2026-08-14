# Final Review — Smart Routing for Search (`fezo-skills`, branch `develop`)

**Verdict: do not ship.** Two independent reasons. First, the feature does not exist as a feature: 5 of the 13 in-scope tasks landed, and the five that landed are pure library modules that nothing imports. `node dist/fezoctl.mjs plan "compare pricing of vercel.com and netlify.com"` exits 1 with `unknown command "plan"`; grep confirms zero production consumers of `mergeItems`, `extractItems`, `parsePlanJson`, `heuristicPlanner`, or `diversityOrder` anywhere outside their own modules and tests. The shipped bundle grew 1,201 bytes and contains only the new `indexId` data fields — `grep -c` on `dist/fezoctl.mjs` returns 24 for `indexId` and **0** for `mergeItems`, `canonicalizeUrl`, `heuristicPlanner`, `RESPONSE_ADAPTERS`, `parsePlanJson`, and `orderByIndexDiversity`. Second, Task 6 — the one that halted after three fix rounds — still carries a real ranking defect (RRF counts one provider as several), plus two ways a hand-written Task 14 adapter destroys a round after it has been billed. That said, the code that exists is genuinely good: the deviation discipline is exemplary, the rationale-comment density matches the house style, `pnpm test` (694 passing, 20 files), `pnpm typecheck`, and `pnpm bundle` (byte-reproducible; `git status` clean afterwards) all pass. This is a well-built 40% that needs three fixes and eight more tasks, not a rewrite.

---

## Verification I ran

| Command | Result |
|---|---|
| `pnpm test` | 20 files, 694 tests, all pass (2.3s) |
| `pnpm typecheck` | clean, exit 0 |
| `pnpm bundle` | writes `dist/fezoctl.mjs` + `skills/fezo/scripts/fezoctl.mjs`; `git status` clean after — bundles are in sync with `src/`, no new dependency, esbuild inlines everything |
| `node dist/fezoctl.mjs plan "compare pricing of vercel.com and netlify.com"` | **exit 1**, `fezoctl: unknown command "plan"`, followed by the full help text on stderr |
| `node dist/fezoctl.mjs plan "latest research on solid-state batteries" --json` | **exit 1**, stdout `{"error":{"kind":"usage","message":"unknown command \"plan\""}}`, help on stderr |

The `--json` failure document is well-formed, so the *existing* CLI contract is intact — it is simply reporting, correctly, that the command the spec promises does not exist. Neither invocation touched the network, so "no credentials needed" is trivially satisfied and equally untested.

---

## Blockers

### B1 — The feature is unreachable; 8 of 13 tasks are absent

Tasks 7 (coverage/next actions), 8 (session), 9 (fan-out executor), 10 (target fetching), 11 (rendering), 12 (CLI wiring), and 13 (skill docs) are not started. `src/engine/research.ts` does not exist. `src/cli.ts` has no `plan` or `research` case (the switch at `src/cli.ts:1467-1490` ends at `doctor`). `skills/fezo/SKILL.md` and `README.md` contain no mention of either command.

This is expected given the halt, but it needs stating plainly because it changes what the other findings mean: nothing below has ever run against a real response, and the modules have never been composed with each other. `src/engine/plan.ts` and `src/engine/aggregate.ts` do not import each other and are imported by nothing — the first place they would meet is `research.ts`.

### B2 — RRF double-counts a single provider, defeating the ranking rationale the spec is built on

`src/engine/aggregate.ts:411` fuses over `item.providers`, an array that two separate code paths let one backend enter more than once:

- `src/engine/aggregate.ts:352` — a lane that returns the same canonical URL twice (position 1 and position 3, common when a provider paginates or returns a decorated duplicate) pushes two `ProviderHit`s with the same `backendId`.
- `src/engine/aggregate.ts:396` — the pass-2 cross-host title collapse folds *every* same-title item into the representative, including several from the same lane.

Measured, one lane only:

```
lane('you', 1, [a.example/s 'Wire Story', b.example/s 'Wire Story', c.example/s 'Wire Story'])
  -> providers: [{you,rank 1,resultRank 1},{you,1,2},{you,1,3}]  score 0.04840
```

That single-provider item outscores a genuine two-provider agreement at rank 1 (`2/61 = 0.03279`). And with a same-lane duplicate URL alongside a real agreement:

```
you: [a.example/x, b.example/y, www.a.example/x?utm_source=z]   exa: [b.example/y]
  -> b.example/y  providers ['you','exa']  score 0.032522
     a.example/x  providers ['you','you']  score 0.032266   <-- near-tie, from one provider
```

The spec's § Ordering states the property this breaks in as many words: *"Appearing high on several lists beats appearing first on one, which makes provider agreement a ranking signal for free."* Here one provider's redundancy is read as agreement.

It gets worse downstream. The plan's Task 7 computes `agreementMedian` from `providers.length` (plan lines ~1900-1920, `item(url, providers)` helper), and `nextActions` derives "thin query" gaps from that median. So this bug will silently inflate the coverage numbers the round bills money to produce, and suppress the follow-up commands a caller relies on to know it needs another round.

Fix: fuse over distinct `backendId`s (keep each backend's best `resultRank`), or dedupe `providers` at the two push sites. Either way `ProviderHit[]` should carry an invariant — one entry per backend — and that invariant should be stated on the interface at `src/engine/aggregate.ts:209-215`.

### B3 — `MAX_RESEARCH_CALLS` is enforced nowhere, `MAX_FANOUT` escapes on both caller paths, and `clampPlan`'s docstring claims otherwise

Fan-out bills per provider per query, so this is the finding with a dollar value attached.

- `MAX_RESEARCH_CALLS = 24` (`src/engine/plan.ts:25`) has **zero** references in the repository outside its own declaration and one comment. Nothing computes `queries × fanout + targets`, nothing truncates, nothing reports a truncation.
- `PLAN_SCHEMA.properties.fanout` (`src/engine/plan.ts:68`) declares `minimum: 1` and no maximum. Verified: `parsePlanJson({queries:['x'], fanout:9999}).fanout === 9999`. The spec calls `PLAN_SCHEMA` the validation gate for caller-supplied plans; the gate does not encode the cap it exists to guard.
- `mergePlan(base, {fanout: 9999}).fanout === 9999` (verified). `mergePlan` does not clamp.
- Only `clampPlan` bounds anything, and nothing in `src/` calls it.
- `clampPlan` bounds `fanout` but not `queries.length` or `targets.length`. Verified: a plan with 500 queries survives `parsePlanJson` untouched; `clampPlan` on 50 queries / 100 targets / fanout 99 returns 50 queries, 100 targets, fanout 10 — **600 implied billed calls**, twenty-five times `MAX_RESEARCH_CALLS`.
- `src/engine/plan.ts:185-186` asserts: *"Applied after every merge, so no path — planner, flags, or caller JSON — can exceed a cap."* That is a convention Task 12 has to remember, not an invariant the module enforces, and it is false today for the cap that governs spend.

The abort flag (spec § Budget and failure semantics) does not exist either; `retry.ts:68`'s `ABORT_CODES` and `retry.ts:235`'s classification are present and correctly shaped, but nothing sits above them. So the answer to "does the abort flag really stop new lanes from starting" is: there are no lanes.

One thing here *is* solid and worth keeping: `src/engine/plan.ts:213-215` refuses to let a non-finite `fanout` through, falling back to the depth width, with the rationale that `NaN` would survive both bounds and make `queries.length * fanout` NaN. Pinned at `tests/plan.test.ts:130-135`. That is exactly the right instinct applied to exactly the right constant — it just needs to be applied to the other three.

---

## High

### H1 — An adapter that returns a non-array destroys the whole round after billing

`src/engine/aggregate.ts:196-206` guards `adapter(body)` against `throw` but not against a bad return value. Verified:

```
RESPONSE_ADAPTERS['bad'] = () => null;
extractItems('bad', {results:[{url:'https://a.example'}]})   -> null
mergeItems([{backendId:'x', rank:1, items: null}])
  -> TypeError: Cannot read properties of null (reading 'forEach')   [aggregate.ts:332]
```

That exception escapes `mergeItems` and takes down *every* lane's already-paid-for results, not just the one with the bad adapter. The docstring immediately above it (`src/engine/aggregate.ts:188-195`) argues at length that the response "was already billed; discarding it because our own transcription of a shape went stale is the worst possible trade" — which is precisely what happens, only worse, because it discards the other seven lanes too.

This is the Task 14 readiness question in concrete form: adapters are hand-transcribed from live captures, and "returns `undefined` when the shape isn't what I expected" is the most likely transcription mistake there is. Fix is one line inside the existing `try`: `const out = adapter(body); return Array.isArray(out) ? out : sniffItems(body);`

### H2 — `mergeItems` does not validate that `raw.url` is a string, so a bad adapter produces a scored item with no URL

Verified, adapter returning `[{title: 'no url'}]`:

```json
{"items":[{"title":"no url","providers":[{"backendId":"x","rank":1,"resultRank":1}],"score":0.0164,"duplicates":[]}],"suppressed":0}
```

An item with no `url` key at all, ranked and emitted, violating `ResearchItem.url: string` (`src/engine/aggregate.ts:218`). It does not throw, which makes it worse than H1 — it reaches the output document. `canonicalizeUrl(undefined)` returns `undefined` via its catch, which then becomes the Map key, the `title` placeholder, and the JSON. Same fix site as H1: validate the adapter's items, or make `mergeItems` skip an item whose `url` is not a non-empty string.

---

## Medium

### M1 — `PLAN_SCHEMA`'s nested `enum` arrays are not frozen; the freeze block misses exactly the hole its comment describes

`src/engine/plan.ts:83-88` freezes `property.items` and `property`, but never `property.enum`. Verified:

```
Object.isFrozen(PLAN_SCHEMA.properties.depth.enum)  -> false
PLAN_SCHEMA.properties.depth.enum.push('deep')      -> succeeds
  -> ['shallow','standard','research','deep']
```

The comment at `src/engine/plan.ts:78-82` gives the rationale: the validator is compiled once at module load, so a mutation "would leave the exported constant advertising a contract nothing enforces." That is the state the code is in for `depth.enum` and `source.enum`. (`intents.items.enum` is safe only by accident — it aliases `INTENTS`, frozen in `intent.ts`.) Also a direct breach of the Global Constraint "Declared tables are frozen with `Object.freeze` at module scope."

### M2 — `snippet` has no length cap, and `content` is a snippet candidate

`src/engine/aggregate.ts:44` lists `text`, `content`, and `abstract` among snippet field names. Verified: `sniffItems({results:[{url, content: <200,000 chars>}]})` yields a `snippet` of **200,000 characters**. Firecrawl-family responses put full page markdown in `content`, and `RESPONSE_ADAPTERS` is empty by design, so today every provider goes through this path. A `research` round at fanout 8 across several such providers produces a multi-megabyte `--json` document. Truncate in `toRawItem` before Task 14 spends money capturing these.

### M3 — `TRACKING_PARAMS` silently exceeds the spec's list, including `source`

`src/engine/aggregate.ts:23-26` strips `msclkid`, `mc_cid`, `igshid`, `referrer`, `source`, `yclid`, `dclid`, `_hsenc`, `_hsmi` in addition to the spec's `utm_*`, `gclid`, `fbclid`, `mc_eid`, `ref`, `ref_src`. No deviation was recorded — unlike the trailing-slash change in the same function, which was documented meticulously. Verified: `https://example.com/item?id=5&source=rss` → `https://example.com/item?id=5`. `source` is a genuine content-selecting parameter on some sites (feed variants, localized editions), so this can merge two distinct documents and demote a billed result to `duplicates`. Either record the deviation with a per-entry rationale, or drop `source` and `referrer`.

### M4 — The sniffer cannot read an array of URL strings

`src/engine/aggregate.ts:135-136` requires `isRecord(entry)`. Verified: `sniffItems({links:['https://a.example','https://b.example']})` → `[]`. This is defensible under the spec ("a provider whose shape the sniffer cannot read yields zero items and is reported in coverage"), but a bare string array is the commonest non-object result shape, and with an empty adapter table such a provider is billed and contributes nothing. Worth deciding deliberately before Task 14 rather than discovering it during calibration.

### M5 — Multi-intent plans have no execution or budget semantics; this is a live seam between Tasks 3 and 9

The heuristic emits two intents routinely, not exceptionally: `['search','news']` for any recency cue (`src/engine/planners/heuristic.ts:193-198`; rows at `tests/heuristic-planner.test.ts:48` and `:51`) and `['scrape','search']` for a URL plus prose (`tests/heuristic-planner.test.ts:58`). But the spec's budget formula is `queries × fanout + targets` — no intent term — and `diversityOrder(intent, limit, excluded)` is per-intent. Does `['search','news']` at fanout 4 buy 4 calls or 8? Nobody has decided, and `MAX_RESEARCH_CALLS` accounting depends on the answer. Separately, `'scrape'` in `intents` is redundant with `targets` under the spec's "targets are fetched once, not fanned out" rule. Settle this on paper before Task 9 — it is cheaper now than as a discovered ambiguity mid-implementation.

### M6 — Merged-item identity depends on lane array order, which a concurrent executor will not naturally fix

`src/engine/aggregate.ts:379` iterates `byCanonical.values()` in first-seen order, and pass 2 makes the first-seen item the representative. Verified: swapping two lanes flips the surviving URL between `https://a.example/s` and `https://b.example/s`. `mergeItems` *is* deterministic given its input, and its header claims purity honestly — but nothing tells the caller it must not append lanes in completion order, which is precisely what a bounded concurrency pool does by default. One sentence in the docstring and one Task 9 test close it.

---

## Low

- **L1 — stale cross-references.** The spec's § Adapters says adapters are seeded "during calibration (Task 12)"; the calibration task is Task 14 (Task 12 is CLI wiring). The spec's § Testing names `heuristic.test.ts`; the file shipped as `tests/heuristic-planner.test.ts`.
- **L2 — `canonicalizeUrl` preserves userinfo.** Verified: `https://user:pw@example.com/a` round-trips with credentials intact, into the canonical key, `duplicates`, stdout, and — once Task 8 lands — the 0600 session file on disk. Providers do occasionally echo such URLs.
- **L3 — a targets-only plan still declares a `search` intent.** `src/engine/plan.ts:117` defaults `intents` to `['search']`, and `tests/plan.test.ts:104` explicitly accepts a targets-only plan. Harmless today; a confusion source the moment Task 9 branches on `intents`.

---

## Spec coverage, section by section

| Spec section | Status | Where |
|---|---|---|
| Non-goals (no LLM, no credential, no dep, `zug` untouched, `web-search`/`scrape`/`crawl` untouched, no decomposition) | ✅ all honored | `package.json` unchanged; no new secret anywhere in the diff |
| `RoutingPlan` contract (7 fields) | ✅ | `plan.ts:27-37` |
| Precedence (flags > `--plan-json` > planner) | ✅ deviation recorded, spec amended | `plan.ts:156-183` |
| Validation → exit 1 during argv parsing | ⚠️ half | `parsePlanJson` throws (`plan.ts:104-142`); no caller turns it into exit 1. The spec's named contract is unimplemented and untested. |
| `ResearchItem` | ✅ | `aggregate.ts:217-227` |
| Full `ResearchResult` document (`plan`, `items`, `documents`, `coverage`, `nextActions`, `billing`, `session`) | ❌ | Tasks 7-11 |
| Depth→width table, `MAX_FANOUT`, `MAX_RESEARCH_CALLS` | ⚠️ declared, not enforced | `plan.ts:18,22,25` — see **B3** |
| Deterministic truncation + reporting what was dropped | ❌ | Task 9 |
| Targets fetched once by one scrape provider | ❌ | Task 10 |
| Diversity ordering, `indexId` on every row | ✅ **best work in the change** | `providers.ts:513-571`, all 24 rows; deviation recorded, spec amended |
| Sniffer + field candidate lists | ✅ (superset of spec's names) | `aggregate.ts:158-169` |
| Adapters | ✅ structurally, deliberately empty | `aggregate.ts:186-206` — see **H1/H2** |
| Canonicalization | ✅ deviation recorded, spec amended | `aggregate.ts:74-117` — see **M3** |
| Dedup (URL pass + cross-host title pass) | ✅ | `aggregate.ts:319-415` |
| RRF ordering | ⚠️ right formula, wrong domain | `aggregate.ts:411` — see **B2** |
| Coverage + `nextActions` | ❌ | Task 7 |
| Session state (`--session`, 0600, `seenUrls`) | ❌ | Task 8. `mergeItems` accepts `seenUrls` and suppresses correctly, but nothing supplies it. |
| Budget/failure semantics (partial success, abort flag, `billing.attempts`) | ❌ | Task 9. `retry.ts:68` `ABORT_CODES` and `retry.ts:452-469` `RunReport.attempts` are ready to consume. |
| CLI surface (`plan`, `research`) | ❌ | Task 12 |

**"Does the session id actually reach the emitted follow-up commands?"** — There are no follow-up commands and no session. The plan's own Task 7 test (`expect(actions[0]?.cmd).toContain('--session r-42')`) is the assertion that would answer this, and it has not been written.

---

## Correctness under the conditions you asked about

- **Zero providers in the catalog** — `diversityOrder` returns `[]`; nothing downstream exists. `mergeItems([])` returns `{items:[],suppressed:0}` (verified), so the aggregator is safe.
- **Provider returns an empty body** — `sniffItems({})`, `sniffItems(null)`, `sniffItems(42)` all return `[]` without throwing (verified). Safe; reporting it as a coverage gap is Task 7.
- **Non-JSON 2xx** — `sniffItems('<html>hi</html>')` → `[]`, no throw. Safe.
- **Every lane failing** — undefined. `mergeItems` over all-empty lanes returns an empty set, so the "partial success is success / all-failed is exit 2" distinction must be made by an executor that does not exist.
- **Account-scoped 402 mid-fan-out** — not implemented. `retry.ts` classifies it correctly at the single-call level; there is no round-level abort flag.
- **Plan with targets but no queries** — accepted by `parsePlanJson` (`tests/plan.test.ts:104`) and emitted by the heuristic with a `targets-only` signal (`heuristic.ts:221`). Downstream behavior unimplemented. The related asymmetry — the planner *may* emit a plan with neither queries nor targets (whitespace prompt) that `parsePlanJson` would reject — is deliberate and very well explained at `heuristic.ts:200-213`.

---

## Test quality

132 tests across the four touched files. The suite is meaningfully protective, not implementation-restating, and I want to be specific about why:

- **`tests/providers.test.ts:467`** is the best test in the change: an exhaustive sweep over every intent × every deny-list subset × every limit, pinning that diversity order currently *equals* declared order on the shipped table, with a comment instructing the reader to delete it when it fails. It turns "this code has no observable effect today" from a hidden liability into a tripwire.
- **`tests/providers.test.ts:271`** pins the full `(intent, backendId) → indexId` map as a literal, forcing a routing-data change to be made in two places. Correct call for hand-curated data.
- **`tests/heuristic-planner.test.ts`** is table-driven as the spec asks, carries negative rows with their rationale (`'catalogue this yearbook…'` at `:55`, `'The Great Gatsby literature analysis'` at `:62`), and asserts exact `signals` arrays rather than lengths.
- Task 6's eleven recorded deviations each have a named test, and the plan states all four surviving production lines were found by deleting each conditional in turn. That is hand-rolled mutation testing and it is the right instinct.

**Highest-value missing test:** *`mergeItems` must not report one backend as multiple contributing providers.* Every existing multi-item scenario uses distinct backends, so B2 — the defect that corrupts both ranking and Task 7's coverage arithmetic — sails through the whole suite. The test is three lines: one lane, two items that collapse (by canonical URL or by cross-host title), assert `providers` has length 1.

Also thin:
- No test for an adapter returning a non-array (H1) or items without a `url` (H2) — the two most likely Task 14 failures.
- No test that `mergeItems` leaves its input `lanes` unmutated.
- `sniffItems` is only ever exercised on 1-2 item synthetic bodies. The "largest array wins" tie-break and the depth-6 recursion bound (`aggregate.ts:123`) are untested against anything resembling a real SERP payload. (`tests/fixtures/responses` is off-limits, so this needs a synthetic-but-realistic fixture.)
- The exit-1-before-billing timing the spec names by file and line is untested, because no CLI path reaches it.

---

## What a maintainer trips over in six months

1. **`orderByIndexDiversity` changes nothing on the shipped table.** A maintainer reading `diversityOrder` will reasonably conclude it is a filter-and-slice and "simplify" the round-robin away. The doc comment at `providers.ts:495-504` explains this unusually well and the characterization test guards it — but both go green if someone deletes the loop and the test together. Keep both; consider a one-line pointer from the loop to the test.
2. **`RESPONSE_ADAPTERS` is an exported, mutable, module-scope object in a shipped bundle** (`aggregate.ts:186`). "Nothing in production writes to it at run time" is a convention, and it lasts until the first plugin hook.
3. **`intents` with no defined multi-intent semantics** (M5) is discovered by whoever writes Task 9, at the exact moment they must decide what `['search','news']` costs.
4. **`canonicalizeUrl`'s trailing-slash rule now spans three code paths** — the pathname setter, the serialized-string fallback, and a documented gap for opaque paths carrying a query (`aggregate.ts:99-115`). The prose is excellent but at the limit of what a comment can carry; a four-row table test of the path shapes would age better.
5. **Nothing imports `plan.ts` or `aggregate.ts`,** so esbuild tree-shakes them and no bundle-size or import-cycle problem can surface until Task 9 wires all four modules in at once.

## Task 14 readiness

The structure is right: keyed by tool name, consulted before the sniffer, with an explicit "seed from real captures, never from a guess" rule and the correct argument for why a wrong adapter is worse than none. Three things should land before anyone spends money on captures: **H1** (a bad adapter must not kill the round), **H2** (validate adapter output), and **M2** (cap `snippet`, or the first calibration run against a full-markdown provider produces a multi-megabyte artifact). **M4** is a decision to take, not necessarily a defect to fix.

---

## Recommended follow-ups, in order

1. **Fix B2** before anything builds on `providers[]` — Task 7's coverage arithmetic reads the same array, so fixing it after Task 7 means fixing it twice. State the one-entry-per-backend invariant on `ProviderHit`.
2. **Fix H1 and H2** in `extractItems`/`mergeItems`; add the two tests. This is the Task 14 gate.
3. **Close B3 properly:** add `maximum: MAX_FANOUT` to `PLAN_SCHEMA.properties.fanout`, move the `MAX_RESEARCH_CALLS` bound (and `queries`/`targets` length bounds) into `clampPlan` so the cap is a property of the contract rather than of whichever caller remembers, and correct the docstring at `plan.ts:185-186` to say what the function actually guarantees.
4. **Freeze the nested `enum` arrays** in `PLAN_SCHEMA` (M1).
5. **Record or revert the `TRACKING_PARAMS` additions** (M3), with `source` getting its own justification or removal.
6. **Settle M5 (multi-intent budget) and M6 (lane-order determinism) on paper** — both are Task 9 inputs and both are far cheaper to decide now.
7. **Then resume Task 6's review, and run Tasks 7-13.** Task 14 stays excluded until 1-3 land.

Nothing was committed, pushed, or modified during this review; the working tree is clean and `dist/` matches a fresh build.