// The declared, per-intent provider ranking `run`'s tie-break (preference.ts)
// and the `providers`/`list-providers` commands are both views of. Ported
// from mcp-server/src/providers.ts, including its RECOMMENDATIONS table and
// every inline rationale/citation comment verbatim: the order below is
// recorded human judgment read off docs/providers-score.md, not something
// this port re-derives, and the comments are the only record of *why* a
// given list departs from a pure score ordering.
//
// One deliberate deviation from mcp-server: the deny-list here is threaded
// (`isExcluded(backendId, excluded)`) rather than read from module-level
// `process.env` state. fezo-skills' `runCli` takes an injectable `env` for
// testability, and a module-load-time `process.env` read would defeat that —
// it would be fixed for the lifetime of the process and could leak
// configuration between tests that construct different `env` objects in the
// same test run. See `resolveExcludedBackends` and `isExcluded` below.

import type { Intent } from './intent.js';
import { INTENTS } from './intent.js';

/** A provider's declared standing within one intent's list, never a sort key. */
export type Tier = 'primary' | 'secondary' | 'fallback';

/**
 * Identifies which document produced the declared order below, and when it was
 * last read. Surfaced verbatim in every recommendation-bearing render so a
 * caller can see the advice's vintage without a code change on our side.
 */
export const RECOMMENDATION_SOURCE = {
  doc: 'docs/providers-score.md',
  preparedAt: '2026-08-05',
} as const;

/**
 * A single provider's declared standing within one intent's list.
 * `tier` is a label the agent reads, never a sort key — see this module's
 * doc for why nothing here is scored or sorted.
 */
export interface Recommendation {
  backendId: string;
  displayName: string;
  tier: Tier;
  why: string;
  when?: string;
  /** Present only for a provider assessed and advised against (currently
   * only `xro` for `social`). Its position (last) is what makes it
   * "not recommended" rather than merely "lower-ranked". */
  notRecommended?: { reason: string };
  /** The 1-3 methods of this provider that are genuine entry points for this
   * intent — what the `providers` command surfaces first on a row, and what
   * the one-step walk tries before anything else. Not the provider's full
   * method list (that lives on the catalog-derived ProviderRow, see
   * provider-view.ts).
   *
   * **Every name here must be a method the backend actually publishes**, as
   * `methodToToolName(backendId, manifestMethodName)` would build it — a name
   * that resolves to nothing makes `providers` advertise an entry point
   * nothing can call. mcp-server checks these against a separate transcription
   * of the Go route/manifest tables (`KNOWN_METHODS` in its own test); the
   * transcription in *this* repo is `METHOD_INTENTS` (intent.ts), so
   * tests/providers.test.ts cross-checks each name against it — every
   * entryMethod must be tagged there with at least its own intent — rather
   * than merely against the `{backendId}_` prefix. Refresh both tables from a
   * live `GET /v1/catalog` dump. */
  entryMethods: string[];
  /**
   * Which underlying index THIS ROW's `entryMethods` actually query.
   *
   * Exists because array order in RECOMMENDATIONS ranks by BEST VALUE, which
   * is the wrong axis for a fan-out: `search` ranks 4-5 (`firecrawl`,
   * `geonode`) publish no index of their own — both search endpoints return
   * Google results, the same SERP the `scrape` reseller trio wraps — so
   * asking all five `search` providers buys four indexes, not five.
   * `diversityOrder` uses this to spend each additional call on a source the
   * round has not queried yet, and lets a caller report the breadth it
   * actually bought instead of the provider count it paid for.
   *
   * The value is a free-form stable key, not an enum: it names a real index
   * (`'you'`, `'exa'`, `'brave'`) or a shared upstream (`'google-serp'`).
   * Two providers sharing a value is the whole point of the field.
   *
   * **Scoped to the row, not to the backend.** A backend is one `indexId` per
   * intent, not one globally: `firecrawl_search` resells the Google SERP
   * while `firecrawl_scrape`/`firecrawl_crawl` fetch the URL the caller
   * named, which is Firecrawl's own retrieval and shares nothing with
   * anyone. Collapsing those to a single per-backend value would either lie
   * about the search row or lie about the scrape row. tests/providers.test.ts
   * pins the whole (intent, backendId) -> indexId map for exactly this
   * reason: a shared index is a routing decision and has to be edited
   * deliberately, in two places.
   */
  indexId: string;
}

/**
 * The declared, per-intent recommendation order. **Array order is rank.**
 * Nothing sorts this: no score, no weight vector, no tie-break, no
 * `Math.random`. `tier` survives as a descriptive label only.
 *
 * Source: mcp-server/docs/providers-score.md § Recommendations and
 * § Revised Best-Value Ranking, read on RECOMMENDATION_SOURCE.preparedAt.
 * Two lists deliberately depart from a pure score-derived order — see the
 * inline notes on `scrape` and `search` below; both departures are exactly
 * what the source doc's own prose recommends.
 */
export const RECOMMENDATIONS: Record<Intent, Recommendation[]> = {
  // § "AI agent / RAG grounding": You primary; Exa where semantic/neural
  // retrieval quality matters most; Brave where independent index / data
  // sovereignty are priorities. A score-derived order would have put `brave`
  // (80.6) ahead of `exa` (79.5) — the doc's own prose orders them the other
  // way, and declared order follows the doc's prose, not the arithmetic.
  search: [
    {
      backendId: 'you',
      displayName: 'You.com',
      tier: 'primary',
      why: 'cheapest quality AI search, clean data rights',
      entryMethods: ['you_search'],
      indexId: 'you',
    },
    {
      backendId: 'exa',
      displayName: 'Exa',
      tier: 'secondary',
      why: 'neural/semantic retrieval with deep research and monitors',
      when: 'semantic/neural retrieval quality matters most',
      entryMethods: ['exa_search'],
      indexId: 'exa',
    },
    {
      backendId: 'brave',
      displayName: 'Brave Search',
      tier: 'secondary',
      why: 'independent 30B+ page index; official MCP server; structured data',
      when: 'independent index / data sovereignty',
      entryMethods: ['brave_search'],
      indexId: 'brave',
    },
    {
      backendId: 'firecrawl',
      displayName: 'Firecrawl',
      tier: 'fallback',
      why: 'LLM-ready markdown search as a last resort when dedicated search APIs are exhausted',
      entryMethods: ['firecrawl_search'],
      // Not `'firecrawl'`: firecrawl_search has no index behind it, it runs a
      // Google query and scrapes the result page into markdown. Ranked 4th on
      // value, but it is the 1st row here that buys no new coverage over a
      // round that already includes the same SERP.
      indexId: 'google-serp',
    },
    {
      backendId: 'geonode',
      displayName: 'Geonode',
      tier: 'fallback',
      why: 'flat per-request search endpoint on top of the cheapest proxy floor',
      entryMethods: ['geonode_search'],
      // Same as firecrawl above: Geonode is a proxy network, and its "search"
      // endpoint is a SERP scrape over that floor, not a proprietary index.
      // Cheap, so it stays declared; a 5th call to it after the 4th, though,
      // widens the bill and not the result set.
      indexId: 'google-serp',
    },
  ],
  // § "Still the best-value scraping API": Scrapingdog leads deliberately.
  // A score-derived order would put `brightdata` (87.7) first and make
  // `best_value: "brightdata"`, which contradicts providers-score.md:9
  // ("our best-value picks are: Scrapingdog"). Declared order + the `when`
  // note + the fallback contract still gets a hard-target scrape to Bright
  // Data on the second hop, which is what the doc actually recommends.
  scrape: [
    {
      backendId: 'scrapingdog',
      displayName: 'Scrapingdog',
      tier: 'primary',
      why: 'best-value managed scraping API; no charge for blocked requests',
      entryMethods: ['scrapingdog_scrape'],
      indexId: 'google-serp',
    },
    {
      backendId: 'brightdata',
      displayName: 'Bright Data',
      tier: 'secondary',
      why: 'highest benchmarked success rate and breadth; premium',
      when: 'hard/anti-bot targets (Cloudflare, DataDome), or when Scrapingdog success on your targets drops below ~50%',
      // Bright Data has no `scrape` method: the single-page entry point is
      // the Web Unlocker (internal/brightdatabackend/routes.go:28).
      entryMethods: ['brightdata_unlock'],
      indexId: 'brightdata',
    },
    {
      backendId: 'firecrawl',
      displayName: 'Firecrawl',
      tier: 'secondary',
      why: 'fastest path to production, AI-ready',
      entryMethods: ['firecrawl_scrape'],
      indexId: 'firecrawl',
    },
    {
      backendId: 'geonode',
      displayName: 'Geonode',
      tier: 'secondary',
      why: 'flat $0.13/1k-request scrape endpoint; no credit multipliers',
      entryMethods: ['geonode_scrape'],
      indexId: 'geonode',
    },
    {
      backendId: 'apify',
      displayName: 'Apify',
      tier: 'fallback',
      why: 'least predictable billing; failed runs still bill',
      // `runs.submit` -> `apify_runs_submit` via methodToToolName's
      // non-alnum coercion (internal/apifybackend/manifest.go:66). The
      // `runs.get`/`runs.dataset` pair are poll/fetch, not entry points.
      entryMethods: ['apify_runs_submit'],
      indexId: 'apify',
    },
    {
      backendId: 'scraperapi',
      displayName: 'ScraperAPI',
      tier: 'fallback',
      why: 'mid-tier all-rounder',
      entryMethods: ['scraperapi_scrape'],
      indexId: 'google-serp',
    },
    {
      backendId: 'scrapingbee',
      displayName: 'ScrapingBee',
      tier: 'fallback',
      why: '~31% benchmarked success; 0% on LinkedIn/Walmart/X',
      entryMethods: ['scrapingbee_scrape'],
      indexId: 'google-serp',
    },
  ],
  crawl: [
    {
      backendId: 'firecrawl',
      displayName: 'Firecrawl',
      tier: 'primary',
      why: 'fastest path to production, AI-ready',
      entryMethods: ['firecrawl_crawl'],
      indexId: 'firecrawl',
    },
    {
      backendId: 'geonode',
      displayName: 'Geonode',
      tier: 'secondary',
      why: 'best value proxy; flat-rate crawl endpoint',
      entryMethods: ['geonode_crawl'],
      indexId: 'geonode',
    },
    {
      backendId: 'brightdata',
      displayName: 'Bright Data',
      tier: 'secondary',
      // There is no Bright Data "Crawl API" on this gateway: multi-page
      // collection is the async Web Scraper API's trigger/poll/download
      // flow, whose only entry point is the trigger. snapshot_progress and
      // snapshot are deliberately excluded — they are how you finish a run,
      // not how you start one.
      why: 'async Web Scraper API (dataset collection) with the strongest anti-bot handling for hard targets',
      entryMethods: ['brightdata_scrape_async'],
      indexId: 'brightdata',
    },
    {
      backendId: 'apify',
      displayName: 'Apify',
      tier: 'fallback',
      why: 'actor marketplace; unpredictable billing',
      entryMethods: ['apify_runs_submit'],
      indexId: 'apify',
    },
  ],
  news: [
    {
      backendId: 'newsapi',
      displayName: 'NewsAPI.ai',
      tier: 'primary',
      why: 'enriched entity/sentiment/event intelligence, archive depth back to 2014',
      // internal/newsapibackend/routes.go:116,135 — `articles` for
      // individual article text, `events` for the AI-clustered story view.
      entryMethods: ['newsapi_articles', 'newsapi_events'],
      indexId: 'newsapi',
    },
    {
      backendId: 'you',
      displayName: 'You.com',
      tier: 'secondary',
      // providers-score.md:69 credits You.com with a News Search product,
      // but this gateway exposes no news route (internal/youbackend/
      // routes.go:81-158), so the entry point is the general search
      // endpoint with a freshness filter.
      why: 'same clean, cheap index; freshness-filtered search stands in for a dedicated news endpoint',
      entryMethods: ['you_search'],
      indexId: 'you',
    },
    {
      backendId: 'brave',
      displayName: 'Brave Search',
      tier: 'fallback',
      why: 'independent index with a dedicated news endpoint',
      // internal/bravebackend/routes.go:39 — `brave_news`, not
      // `brave_search`, which returns web results.
      entryMethods: ['brave_news'],
      indexId: 'brave',
    },
  ],
  // § TL;DR economics argument: third-party alternatives are ~30-90x cheaper
  // than the official X API for the same data, so Apify and Bright Data are
  // both primary; xro is last by construction, no bucket arithmetic needed.
  social: [
    {
      backendId: 'apify',
      displayName: 'Apify',
      tier: 'primary',
      why: 'actor marketplace covers social scraping at a fraction of official-API cost',
      entryMethods: ['apify_runs_submit'],
      indexId: 'apify',
    },
    {
      backendId: 'brightdata',
      displayName: 'Bright Data',
      tier: 'primary',
      why: 'prebuilt datasets and unlocker cover social targets the official API restricts',
      // Datasets (including the Social Media scrapers) are collected via
      // the async trigger; the unlocker covers a single public profile page.
      entryMethods: ['brightdata_scrape_async', 'brightdata_unlock'],
      indexId: 'brightdata',
    },
    {
      backendId: 'xro',
      displayName: 'X API (read-only)',
      tier: 'fallback',
      why: 'authoritative first-party data, for when that is the compliance requirement',
      notRecommended: {
        reason: '~30–90× costlier than third-party alternatives, hard 2M-read cap, heaviest TOS/lock-in risk — use only when first-party authenticity is mandatory',
      },
      // internal/xrobackend/routes.go:70-71 — the search endpoints.
      // `xro_tweet_search` does not exist; `xro_tweet_lookup` is a by-id
      // fetch and is not a discovery entry point.
      entryMethods: ['xro_tweets_search_recent', 'xro_tweets_search_all'],
      indexId: 'x',
    },
  ],
  // Neither backend exposes a raw proxy endpoint over this gateway — the proxy
  // networks are fronted by request-shaped methods (Geonode's Scraper API,
  // Bright Data's Web Unlocker), and those are what an agent can actually call.
  // The declared order still reflects the doc's § Proxy Infrastructure ranking.
  proxy: [
    {
      backendId: 'geonode',
      displayName: 'Geonode',
      tier: 'primary',
      why: 'best value proxy; lowest-price-guaranteed residential floor, reached through the flat-rate Scraper API',
      entryMethods: ['geonode_scrape'],
      indexId: 'geonode',
    },
    {
      backendId: 'brightdata',
      displayName: 'Bright Data',
      tier: 'secondary',
      why: 'best for enterprise / hard targets; largest network, no concurrency limit, reached through the Web Unlocker',
      entryMethods: ['brightdata_unlock'],
      indexId: 'brightdata',
    },
  ],
  // No declared recommendations — a method that classifies here is still
  // returned (see intent.ts), just unranked.
  other: [],
};

// Determinism here is a property of the data structure, not of any sort call, so
// the declared lists are frozen at module load. `recommendationsFor` hands back
// the live reference (no per-call copy, and callers can compare identity), and a
// consumer that tries to `.sort()`, `.splice()` or `.push()` it fails loudly with
// a TypeError instead of silently reordering the declared rank process-wide. The
// declared type stays `Recommendation[]`, so TypeScript will not flag the
// mutation — the runtime throw is the tripwire.
for (const list of Object.values(RECOMMENDATIONS)) {
  for (const rec of list) {
    Object.freeze(rec.entryMethods);
    if (rec.notRecommended) Object.freeze(rec.notRecommended);
    Object.freeze(rec);
  }
  Object.freeze(list);
}
Object.freeze(RECOMMENDATIONS);

// Backends this CLI refuses to surface or call, regardless of what the
// gateway serves. **This is the only switch, not defence in depth**: nothing
// in this repository disables `falai` or `alpaca` at the gateway itself —
// fezo-skills only talks to the gateway over HTTP and has no ability to
// change what it serves. `FEZO_EXCLUDED_BACKENDS` overrides the default
// below, which is what makes the decision reversible without a release.
const DEFAULT_EXCLUDED_BACKENDS: string[] = ['falai', 'alpaca'];

/**
 * Parses `FEZO_EXCLUDED_BACKENDS` into a deny-list. The env var **replaces**
 * the default rather than extending it, and only an *absent* variable falls
 * back to `DEFAULT_EXCLUDED_BACKENDS`: `FEZO_EXCLUDED_BACKENDS=""` is
 * honoured as an intentional empty deny-list, so an operator can run with
 * nothing excluded without inventing a placeholder id. That is what makes the
 * falai/alpaca call reversible without a release, in both directions.
 *
 * Takes `env` as a required parameter rather than defaulting to
 * `process.env`, unlike mcp-server's version of this function — see this
 * module's doc comment for why a module-load-time env read is wrong for
 * fezo-skills specifically. Callers resolve this once from `runCli`'s
 * injected `env` and thread the result down (`isExcluded` below).
 */
export function resolveExcludedBackends(env: Record<string, string | undefined>): string[] {
  const raw = env.FEZO_EXCLUDED_BACKENDS;
  if (raw === undefined) return [...DEFAULT_EXCLUDED_BACKENDS];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The single predicate every call path uses, so a new path cannot forget the
 * deny-list. Takes the resolved list as a parameter instead of reading a
 * module-level `EXCLUDED_BACKENDS` constant (which this module deliberately
 * does not export) — see `resolveExcludedBackends` and this module's doc
 * comment for why the deny-list must be threaded, not read from module
 * state, in fezo-skills.
 */
export function isExcluded(backendId: string, excluded: readonly string[]): boolean {
  return excluded.includes(backendId);
}

/** Returned for an out-of-type intent; frozen for the same reason as the lists. */
const EMPTY_RECOMMENDATIONS: Recommendation[] = [];
Object.freeze(EMPTY_RECOMMENDATIONS);

/**
 * The declared recommendation list for an intent, in rank order. Never throws.
 * The returned array is the frozen declared list itself — treat it as read-only
 * and copy before deriving an order of your own. The `?? []` is a deliberate
 * guard for an out-of-type intent arriving through an unchecked cast (e.g. a
 * string off the wire); `RECOMMENDATIONS` is total over `Intent`, so it is
 * unreachable for a well-typed caller.
 */
export function recommendationsFor(intent: Intent): Recommendation[] {
  return RECOMMENDATIONS[intent] ?? EMPTY_RECOMMENDATIONS;
}

/** The declared recommendation for one provider within one intent, if any. */
export function recommendationFor(intent: Intent, backendId: string): Recommendation | undefined {
  return recommendationsFor(intent).find((r) => r.backendId === backendId);
}

/**
 * Every intent whose declared list mentions this backend, in `Intent` display
 * order (`RECOMMENDATIONS`' key order, which `INTENTS` mirrors). Empty means no
 * declared list mentions it at all — the genuinely unassessed case, and the
 * *only* case a consumer may label `rated: false`. Rank is per-intent, but
 * "has this provider been assessed?" is a question about the whole table, so it
 * has to be asked here and not per-list — see provider-view.ts's off-list
 * pass for why getting that wrong emits false prose.
 *
 * Filters `INTENTS` (intent.ts) rather than `Object.keys(RECOMMENDATIONS)`
 * as mcp-server's version does: `Object.keys` returns `string[]`, and
 * narrowing it back to `Intent[]` would need a type assertion, which `src/`
 * does not use (see preference.ts's `CAPABILITY_LIST` for the same
 * reasoning applied to `Capability`). `INTENTS` enumerates exactly the same
 * domain in the same order, so this is a type-safe substitute, not a
 * behavior change — and it stays one because intent.ts freezes `INTENTS` at
 * module load: mcp-server's version reads the frozen `RECOMMENDATIONS` keys
 * and is therefore immune to anything a caller does to `INTENTS`, and the
 * freeze is what buys this version the same immunity.
 */
export function declaredIntentsFor(backendId: string): Intent[] {
  return INTENTS.filter((intent) => RECOMMENDATIONS[intent].some((r) => r.backendId === backendId));
}

/**
 * A backend's declared display name, resolved across every intent's list: a
 * provider's identity is global even though its rank is per-intent, so
 * `brightdata` is "Bright Data" in a capability group whose declared list does
 * not mention it. `undefined` for a backend no declared list mentions — the
 * only case where a raw backendId is the honest thing to show.
 */
export function displayNameFor(backendId: string): string | undefined {
  for (const list of Object.values(RECOMMENDATIONS)) {
    const found = list.find((r) => r.backendId === backendId);
    if (found) return found.displayName;
  }
  return undefined;
}

/**
 * The pure ordering step behind `diversityOrder`: re-order an already-filtered
 * list so each successive entry queries an index the prefix has not used yet,
 * then truncate to `limit`.
 *
 * Split out from `diversityOrder` because the table this module declares makes
 * the two functions indistinguishable: today no intent has a repeated
 * `indexId` anywhere except at the tail of its list, so on the real data the
 * diversity order and the declared order coincide for every intent, every
 * deny-list and every limit (verified exhaustively). That is a fact about the
 * ranking, not about the algorithm -- best value happens to already be
 * index-diverse-first -- but it means the loop below is untestable through
 * `diversityOrder`, whose only input is an intent. Callers want
 * `diversityOrder`; this export exists so the reordering has direct coverage
 * on inputs the table cannot currently produce, and so it stays covered when
 * a future entry does move a shared index up the ranking.
 *
 * Value rank still decides WITHIN an index (the first-listed provider of a
 * given `indexId` is the one that represents it); diversity only decides
 * BETWEEN indexes. Passing a `limit` at or above `recs.length` therefore
 * returns a permutation of `recs`, never a truncation of it -- a fan-out wide
 * enough to ask everyone still asks everyone.
 */
export function orderByIndexDiversity(recs: readonly Recommendation[], limit: number): Recommendation[] {
  const byIndex = new Map<string, Recommendation[]>();
  for (const rec of recs) {
    const list = byIndex.get(rec.indexId);
    if (list) list.push(rec);
    else byIndex.set(rec.indexId, [rec]);
  }
  // Round-robin across index buckets, each bucket already in declared order.
  // Insertion order of `byIndex` is the declared order of each index's FIRST
  // provider, so the first pass visits indexes best-declared-first.
  //
  // Round-robin, deliberately, and not the spec's "highest-ranked provider of
  // each unseen index first, then continue down the declared order for the
  // remainder" (specs/2026-08-14-smart-routing-design.md § Fan-out policy).
  // The two agree until two indexes each have two or more providers, where for
  // declared a1,a2,a3,b1,b2 the spec yields a1,b1,a2,a3,b2 and this yields
  // a1,b1,a2,b2,a3. Round-robin wins because `limit` truncates: the property
  // worth having is that EVERY prefix is as index-diverse as it can be, and
  // the spec's rule spends the 4th call on a3 while b2 -- the second-best
  // provider of the only other index -- is still unasked. The plan's Task 1
  // records this supersession; the spec's sentence has been amended to match.
  const ordered: Recommendation[] = [];
  let round = 0;
  while (ordered.length < recs.length) {
    let addedThisRound = false;
    for (const bucket of byIndex.values()) {
      const next = bucket[round];
      if (next !== undefined) {
        ordered.push(next);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
    round += 1;
  }
  return ordered.slice(0, Math.max(0, limit));
}

/**
 * The declared ranking for `intent`, re-ordered so each successive provider
 * queries an index the round has not used yet, then truncated to `limit`.
 *
 * Deny-listed and `notRecommended` providers are dropped before ordering, the
 * same rule `buildWalk` applies: a provider assessed and advised against is
 * not a breadth opportunity.
 *
 * Passing a `limit` at or above the number of ELIGIBLE providers returns a
 * permutation of the eligible list -- the declared list minus its deny-listed
 * and `notRecommended` entries -- never a truncation of it. It is not a
 * permutation of the declared list whenever anything was filtered, and it is
 * the filtered set, not the declared one, that a caller should compare
 * against when it wants to know whether the fan-out reached everyone.
 */
export function diversityOrder(intent: Intent, limit: number, excluded: readonly string[]): Recommendation[] {
  const eligible = recommendationsFor(intent).filter(
    (rec) => rec.notRecommended === undefined && !isExcluded(rec.backendId, excluded),
  );
  return orderByIndexDiversity(eligible, limit);
}
