# Smart Routing for Search — Design

**Date:** 2026-08-14
**Status:** approved for implementation
**Repo:** `fezo-skills` (the `fezoctl` engine). Companion context: `../zug`.

## Goal

Take a user prompt, work out what it needs, fan out to several providers in
parallel, and return one merged, deduplicated, source-attributed result set —
with enough machine-computed coverage information that the calling agent can
decide whether another round is worth paying for.

## Problem

Everything `fezoctl` does today is one-intent, one-provider, one-shape:

- The **caller** declares the intent (`web-search` / `scrape` / `crawl`);
  nothing reads the prompt.
- `one-step.ts` walks `providers.ts`'s declared ranking **sequentially,
  first-success-wins**, capped at `MAX_PROVIDER_ATTEMPTS = 3`.
- The winning provider's response is returned **verbatim** — raw upstream JSON,
  a different shape per provider.

So there is no breadth (one provider answers, the rest are never asked), no
normalization, no dedup, and no citations across providers. Phase D of
`../zug/docs/plans/2026-08-05-mcp-provider-scoring.md` sketched automatic
selection and was deferred, gated on a per-provider argument adapter table.

## Non-goals

- **`fezoctl` does not run the research loop.** One round per invocation. It
  computes and reports coverage gaps; the agent decides whether to spend again.
- **No LLM inside `fezoctl`.** No new credential. The planner interface admits
  an LLM implementation later; none ships.
- **No changes to `zug`.** No gateway endpoint, no Go, no manifest changes.
  Output schemas stay free-text; normalization compensates client-side.
- **`web-search` / `scrape` / `crawl` are untouched.** They remain the cheap
  single-answer path. `research` is the wide one.
- **No query decomposition by the heuristic.** It cannot, and will not pretend
  to. Decomposition is the agent's job, expressed through `queries[]`.

## Decisions

Six, settled during brainstorming:

1. **Home:** the `fezoctl` engine, client-side, in this repo.
2. **Planner:** deterministic heuristic, behind a swappable `Planner`
   interface. An LLM planner is one new file plus one `resolvePlanner` case.
3. **Loop:** one round per call. `fezoctl` computes coverage and emits
   ready-to-run follow-up commands; the agent decides to spend.
4. **Fan-out:** depth sets the width; providers are ordered to maximize
   distinct underlying indexes, not value rank.
5. **Normalization:** a generic response sniffer, with per-provider adapter
   overrides only where sniffing demonstrably fails.
6. **Merge:** URL canonicalization plus near-duplicate title collapsing;
   ordering by reciprocal rank fusion.

## Architecture

```
prompt ──► Planner ──► RoutingPlan ──► research.ts ──► ResearchResult
           (heuristic)      │              │
                            │              ├─ lane(you)      ─┐
           flags ───────────┤              ├─ lane(exa)       │ concurrent,
       --plan-json ─────────┘              ├─ lane(brave)     │ each one
                                           └─ lane(...)      ─┘ retry.run()
                                                  │
                                           aggregate.ts
                                     (sniff → canonicalize →
                                      dedup → RRF → coverage)
```

**Parallelism without a second call loop.** `retry.ts`'s `run()` is a
sequential fallback walk, and `one-step.ts` states the governing rule: no
module opens a second HTTP call loop, so billing accounting and the
gateway-code-first failure classification stay in one place. Fan-out therefore
issues **one `run()` per provider lane with a single candidate and
`maxAttempts: 1`**, and runs those lanes concurrently through a bounded pool.
Every lane is still `retry.ts`; concurrency lives strictly above it.

## Data contracts

### `RoutingPlan`

The seam between understanding and execution. The executor takes a plan and
never sees a planner.

```ts
export interface RoutingPlan {
  intents: Intent[];          // intent.ts's 7-value taxonomy
  queries: string[];          // search terms; may be several for research
  targets: string[];          // literal URLs to fetch
  depth: 'shallow' | 'standard' | 'research';
  fanout: number;             // providers per query
  signals: string[];          // advisory only; never parsed downstream
  source: 'heuristic' | 'flags' | 'caller' | 'llm';
}
```

`intents` and `targets` coexist, so "search or scraping or both" needs no mode
switch: one round can fan out search providers and fetch known URLs at once.

**Precedence:** explicit flags > `--plan-json` (whole plan) > planner output.
A flag beats the `--plan-json` it accompanies because it is the more specific
instruction typed on the same command line; under the reverse order every flag
next to a `--plan-json` would be silently ignored. Flags merge field-wise, so a
caller can correct one field and inherit the rest. `--plan-json` does not: it
replaces the plan wholesale, which is why `parsePlanJson` rejects a fragment
carrying neither `queries` nor `targets` instead of quietly wiping the
planner's queries and producing an empty round. `source` records who won and is
echoed in the output. Recorded as a deviation under the plan's Task 2.

**Validation:** caller-supplied plans validate against `PLAN_SCHEMA` using the
existing `ajv-instance.ts` compiler. A malformed plan fails during argv
parsing with exit code 1 — before any candidate is selected or billed, matching
the contract `--args-json` already follows (`src/cli.ts:16-19`).

### `ResearchResult`

```ts
export interface ResearchItem {
  url: string;                 // canonical
  title: string;
  snippet?: string;
  publishedAt?: string;
  providers: Array<{ backendId: string; rank: number; resultRank: number }>;
  score: number;               // RRF
  duplicates: string[];        // other URLs collapsed into this item
}
```

The full document adds `plan`, `items`, `documents` (fetched targets),
`coverage`, `nextActions`, `billing` (calls billed, full attempt logs), and
`session`.

## Fan-out policy

**Width from depth**, hard-capped:

| depth | providers per query |
|---|---|
| `shallow` | 2 |
| `standard` | 4 |
| `research` | 8 |

`MAX_FANOUT = 10` and `MAX_RESEARCH_CALLS = 24` (overridable downward by
`--max-calls`) bound one round absolutely. Total calls = `queries × fanout +
targets`; the executor truncates deterministically (whole queries first, then
lowest-diversity providers) and **reports what it dropped** — silent truncation
reads as full coverage when it isn't.

**Targets are fetched once, not fanned out.** Breadth is what a fan-out buys
for a *query*, where each index returns a different set of links. A URL is one
document: fetching it from five providers buys five copies of the same page and
bills five times. Each target therefore gets exactly one provider, the
highest-ranked `scrape` provider that publishes a usable entry method. A failed
fetch is reported as a coverage gap pointing at `fezoctl scrape`, whose ranked
fallback walk exists for precisely that case.

**Which providers: diversity ordering.** `providers.ts`'s declared order ranks
by best value, which is the wrong axis for breadth — several `search` entries
resell the same Google SERP, so ranks 4-5 can return what ranks 1-3 already
did. One new field on `Recommendation`:

```ts
indexId: string;   // 'you' | 'exa' | 'brave' | 'google-serp' | 'firecrawl' | ...
```

`indexId` is scoped to a *row*, not to a backend: `firecrawl_search` resells
the Google SERP while `firecrawl_scrape` fetches the URL the caller named, so
`firecrawl` is `'google-serp'` under `search` and `'firecrawl'` under `scrape`.
The concrete resellers are `search` ranks 4-5 (`firecrawl`, `geonode`), which
publish no index of their own.

`diversityOrder(intent, n)` buckets the declared ranking by `indexId`, each
bucket keeping declared order, and **round-robins** across the buckets in the
declared order of each index's first provider. Value rank still decides
*within* an index; diversity only decides *between* them. With `n` ≥ the number
of distinct indexes, the result is a permutation of the eligible list — the
declared list minus its deny-listed and `notRecommended` entries — never a
truncation of it.

Round-robin, and not "unseen indexes first, then the declared order for the
remainder": the two agree until two indexes each have two or more providers,
where for declared `a1,a2,a3,b1,b2` the latter yields `a1,b1,a2,a3,b2` and
round-robin yields `a1,b1,a2,b2,a3`. Because `n` truncates, the property worth
having is that *every* prefix is as index-diverse as it can be, and spending
the 4th call on `a3` while `b2` is unasked gives that up. Recorded as a
deviation under the plan's Task 1.

## Aggregation

**Sniffer.** Walks a provider's JSON for the largest array of objects carrying
a URL-ish key, then maps fields by candidate names — the same idiom as
`one-step.ts`'s `ARG_CANDIDATES`, for the same reason:

- url: `url`, `link`, `href`, `webUrl`, `source_url`
- title: `title`, `name`, `heading`, `headline`
- snippet: `snippet`, `description`, `text`, `summary`, `content`, `excerpt`
- date: `published_at`, `publishedAt`, `date`, `published_date`, `datePublished`

A provider whose shape the sniffer cannot read yields zero items and is
**reported in coverage**, never silently dropped.

**Adapters.** `RESPONSE_ADAPTERS: Record<string, Adapter>` keyed by tool name,
consulted before the sniffer. Seeded from real captured responses during
calibration (Task 12), not from guesswork.

**Canonicalization.** Lowercase scheme and host, strip a leading `www.`, drop
the fragment, remove tracking parameters (`utm_*`, `gclid`, `fbclid`,
`mc_eid`, `ref`, `ref_src`), sort remaining query parameters. A trailing slash
is stripped from *every* path, not only from the root — it is a server-side
directory convention, not a distinct document — and independently of any query,
so `/a/?b=1` and `/a?b=1` yield one key. The original URL survives on
`duplicates`. Recorded as a deviation under the plan's Task 4.

**Dedup.** Same canonical URL merges. Then near-duplicate titles across
*different* hosts merge (normalized title equality after case-folding,
punctuation stripping, and whitespace collapse) — catching one wire story
carried by six outlets. The surviving item keeps every source URL and every
contributing provider, so nothing is lost, only grouped.

**Ordering: reciprocal rank fusion.** `score = Σ 1/(RRF_K + resultRank_i)`
over contributing providers, `RRF_K = 60`. No provider-reported score is used
— they are incomparable across providers and often absent. Appearing high on
several lists beats appearing first on one, which makes provider agreement a
ranking signal for free. Ties break on canonical URL for determinism.

## Coverage and next actions

Computed mechanically from the round's own data:

- per query: unique URLs, median provider agreement
- providers served / failed (with gateway code) / skipped (with reason)
- domain concentration: top host and its share
- planned-but-unexecuted work: dropped queries, unfetched targets
- `gaps[]`: thin queries, zero-result queries, retryable failures

`nextActions[]` carries a `why` and a literal, ready-to-run `cmd` string
including `--session`. This follows the established principle in this codebase
— `one-step.ts` reports "stopped after 3 providers; lower-ranked ones were not
tried" precisely so a cap cannot be mistaken for a failure; a coverage gap is
the same class of fact.

## Session state

`--session <id>` enables cross-round state at
`${XDG_CACHE_HOME:-~/.cache}/fezo/sessions/<id>.json`, mode 0600, holding
`seenUrls` (canonical), `queries` already run, and `callsBilled`. A round with
a session **excludes already-seen URLs from its results** and reports how many
it suppressed. This is what keeps a five-round research run affordable instead
of quadratic. No session id means no file is written or read.

Ids are validated against `/^[A-Za-z0-9._-]{1,64}$/` — the id becomes a
filename, so anything else is rejected at parse time.

## Budget and failure semantics

- **Partial success is success.** If at least one lane served, exit 0 with
  whatever merged. Failed lanes appear in coverage.
- **Account-scoped aborts stop the round.** `retry.ts`'s `ABORT_CODES`
  (`unauthorized`, `limit_exceeded`, `insufficient_balance`) describe the
  account, not one provider. On the first such lane the executor sets an abort
  flag; the pool starts no further lanes, in-flight lanes are awaited (never
  discarded — they may already be billed), and the round exits 2 reporting the
  abort. Not stopping would fire the remaining lanes into a spend limit that
  has already tripped.
- **Every billed call is reported** in `billing.attempts`, straight from
  `RunReport.attempts`.

## CLI surface

```
fezoctl plan "<prompt>" [--json]
fezoctl research "<prompt>" [--intents a,b] [--queries "q1" --queries "q2"]
                            [--targets <url>] [--depth shallow|standard|research]
                            [--fanout N] [--max-calls N] [--session <id>]
                            [--plan-json '<json>'] [--planner heuristic] [--json]
```

`plan` performs no network I/O and needs no credentials.

## Testing

- `plan.test.ts` — merge precedence, schema rejection, exit-1 timing.
- `heuristic.test.ts` — table-driven prompt → plan; no network.
- `aggregate.test.ts` — sniffer shapes, adapter override precedence,
  canonicalization, dedup, RRF ordering, coverage arithmetic.
- `session.test.ts` — temp-dir round trip, id validation, 0600 mode.
- `research.test.ts` — `routedFetch` per `tests/one-step.test.ts`'s convention;
  lane concurrency, abort-flag behavior, truncation reporting, partial success.
- `cli.test.ts` / `render.test.ts` / `skill_contract.test.ts` — flags, output
  contract, SKILL.md prose agreement.

The executor's tests feed hand-written `RoutingPlan` literals, so fan-out
behavior is tested without any prompt parsing — which keeps "the heuristic
misread this" from ever presenting as "the aggregator is broken".

## Risks

- **The heuristic is not comprehension.** It cannot decompose, resolve
  anaphora, or infer domain. Mitigated by making the override path primary for
  research-depth prompts in `SKILL.md`, and by `signals[]` making every
  decision visible. Accepted, explicitly.
- **Fan-out multiplies spend linearly.** Mitigated by depth caps,
  `MAX_RESEARCH_CALLS`, session-based suppression, and the abort flag.
- **`indexId` and the adapter table are hand-curated** and will go stale, the
  same standing risk `METHOD_INTENTS` and `entryMethods` already carry. The
  sniffer means staleness degrades quality rather than breaking calls.
- **Near-duplicate title merging can over-merge** genuinely distinct pages
  sharing a generic title. Restricted to cross-host pairs; every merged URL is
  preserved on `duplicates` so the agent can see what was grouped.
- **`plan` becomes a public contract** once `SKILL.md` teaches agents to emit
  it. Kept to seven fields; additive change only.

## Future, deliberately not now

- **LLM planner** — one file implementing `Planner`, one `resolvePlanner` case,
  plus credential resolution. Nothing else changes.
- **Gateway-side port** — the same contracts reimplemented behind a `zug`
  endpoint so the web UI and MCP server share one implementation.
- **Real `output_schema` in backend manifests**, retiring the sniffer.
