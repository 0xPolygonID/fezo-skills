// The capability taxonomy every provider recommendation and one-step command
// is organized under. Ported from mcp-server/src/intent.ts and
// mcp-server/src/types.ts (the `Intent` type lived there because mcp-server
// splits its type declarations into their own module; fezo-skills has no such
// module, so the type is defined here instead, in the module that owns the
// taxonomy).
//
// This module's tables and `classifyMethod` are transcribed verbatim,
// including their inline rationale/citation comments: they encode reasoning
// already done once (which Go route/manifest a method comes from, why a
// keyword belongs in `tokens` rather than `substrings`) that this port must
// carry forward rather than re-derive.

import type { ToolCandidate } from './catalog.js';
import { methodToToolName } from './tool-name.js';

/** The capability taxonomy providers are grouped and ranked under (providers.ts). */
export type Intent = 'search' | 'scrape' | 'crawl' | 'news' | 'social' | 'proxy' | 'other';

/**
 * Display order for the `intent` enum, not a ranking -- rank lives on
 * `RECOMMENDATIONS` per intent (providers.ts).
 */
export const INTENTS: Intent[] = ['search', 'scrape', 'crawl', 'news', 'social', 'proxy', 'other'];

/** Frozen for the same reason as RECOMMENDATIONS: determinism is a property of
 * the data, not of anything a caller does to it at runtime. Load-bearing here
 * because `declaredIntentsFor` (providers.ts) iterates this array in place of
 * `Object.keys(RECOMMENDATIONS)`, so a caller that sorted or spliced it would
 * change that function's answer process-wide. */
Object.freeze(INTENTS);

/**
 * One agent-facing line per intent, meant to be folded into help text /
 * SKILL.md wherever the `intent` value is surfaced.
 */
export const INTENT_DESCRIPTIONS: Record<Intent, string> = {
  search: 'Find information or pages on the open web (queries, questions, lookups).',
  scrape: 'Fetch and extract the content of a specific, already-known page or URL.',
  crawl: 'Discover and collect many pages from a site or a structured dataset run.',
  news: 'Find news articles or clustered news events, optionally by recency.',
  social: 'Read social-platform content: posts, profiles, follows, mentions, trends.',
  proxy: 'Route a request through a proxy/unlocker network rather than fetch content directly.',
  other: 'Anything that does not fit the capabilities above.',
};

/** Frozen for the same reason as INTENTS above: this prose is surfaced in help
 * text, `--json` output and SKILL.md, and must read identically in all three. */
Object.freeze(INTENT_DESCRIPTIONS);

/**
 * A minimal view of a catalog method, just enough for classification: name,
 * the raw route path (may be absent), and free-text description. Deliberately
 * not `import type { Method }` -- keeps this module usable with a synthetic
 * fixture in tests and with the live catalog's `Method` alike.
 */
export interface ClassifiableMethod {
  name: string;
  path?: string;
  description?: string;
}

/**
 * The explicit `{backendId}_{method}` classification table. Static because the
 * intent(s) a method serves are a property of *what that method does*, which a
 * keyword heuristic can only approximate -- and because several methods
 * legitimately serve more than one intent (e.g. `apify_runs_submit` is the
 * generic actor-run trigger behind `scrape`, `crawl` *and* `social` in
 * providers.ts; `brightdata_unlock`'s single-page unlocker backs `scrape`,
 * `social` and `proxy`). Every `RECOMMENDATIONS[intent]` entryMethods name in
 * providers.ts appears here tagged with (at least) that intent, so the two
 * tables cannot silently disagree about what a method is for.
 *
 * Transcribed from the gateway's Go route/manifest tables (see the per-entry
 * citation comments below), not hand-guessed -- this table *is* this repo's
 * transcription of them, which is why tests/providers.test.ts validates
 * `RECOMMENDATIONS`' entryMethods against it rather than against a second
 * fixture (mcp-server keeps a separate `KNOWN_METHODS` fixture for that; a
 * second transcription here would just be a second thing to drift). It is
 * still a hand-curated surface over 60+ methods
 * and the largest one in this feature. A new backend or route is
 * *discoverable* immediately via `classifyMethod`'s keyword/category fallback
 * below; it just won't have a static, authoritative entry until this table is
 * refreshed from a live `GET /v1/catalog` dump.
 */
export const METHOD_INTENTS: Record<string, Intent[]> = {
  // -- you (internal/youbackend/routes.go:81,100,113,131,147,158) --
  you_search: ['search', 'news'],
  you_contents: ['scrape'],
  you_research: ['search'],
  you_research_start: ['search'],
  you_research_status: ['search'],
  you_finance_research: ['search'],

  // -- brightdata (internal/brightdatabackend/routes.go:28,34; manifest.go:77,107,127) --
  brightdata_unlock: ['scrape', 'social', 'proxy'],
  brightdata_serp: ['search'],
  brightdata_scrape_async: ['crawl', 'social'],
  brightdata_snapshot_progress: ['crawl'],
  brightdata_snapshot: ['crawl'],

  // -- geonode (internal/geonodebackend/manifest.go:63,102,136,188) --
  geonode_scrape: ['scrape', 'proxy'],
  geonode_search: ['search'],
  geonode_crawl: ['crawl'],
  geonode_crawl_status: ['crawl'],

  // -- brave (internal/bravebackend/routes.go:38-43) --
  brave_search: ['search'],
  brave_news: ['news'],
  brave_images: ['search'],
  brave_videos: ['search'],

  // -- scrapingdog (internal/scrapingdogbackend/routes.go:58,73,88,98,109,121,133,144) --
  scrapingdog_scrape: ['scrape'],
  scrapingdog_google_search: ['search'],
  scrapingdog_google_maps: ['search'],
  scrapingdog_amazon_product: ['scrape'],
  scrapingdog_amazon_search: ['search'],
  scrapingdog_amazon_offers: ['scrape'],
  scrapingdog_linkedin: ['social'],
  scrapingdog_linkedin_jobs: ['social'],

  // -- exa (internal/exabackend/manifest.go:58,103) --
  exa_search: ['search'],
  exa_contents: ['scrape'],

  // -- newsapi (internal/newsapibackend/routes.go:116,135) --
  newsapi_articles: ['news'],
  newsapi_events: ['news'],

  // -- firecrawl (internal/firecrawlbackend/manifest.go:67,121,158,192,244) --
  firecrawl_scrape: ['scrape'],
  firecrawl_map: ['crawl'],
  firecrawl_search: ['search'],
  firecrawl_crawl: ['crawl'],
  firecrawl_crawl_status: ['crawl'],

  // -- apify (internal/apifybackend/manifest.go:66,105,141; dotted names) --
  apify_runs_submit: ['scrape', 'crawl', 'social'],
  apify_runs_get: ['other'],
  apify_runs_dataset: ['other'],

  // -- scraperapi (internal/scraperapibackend/routes.go:48,61-86) --
  scraperapi_scrape: ['scrape'],
  // The async pair, read off a live `GET /v1/catalog` dump rather than the Go
  // route table (they postdate the transcription above). Both are `scrape`,
  // not `crawl`: `scrape_async` submits ONE job -- "a hard site or large
  // batch" of URLs the caller already names -- and never discovers a page,
  // which is what separates `crawl` from `scrape` (see INTENT_DESCRIPTIONS).
  // `scrape_status` is the poll half of that pair and carries its family's
  // intent, as firecrawl_crawl_status and geonode_crawl_status do for theirs.
  // Neither is an entryMethod in providers.ts: ScraperAPI's declared `scrape`
  // entry point stays the synchronous `scraperapi_scrape`.
  scraperapi_scrape_async: ['scrape'],
  scraperapi_scrape_status: ['scrape'],
  scraperapi_amazon_product: ['scrape'],
  scraperapi_amazon_search: ['search'],
  scraperapi_amazon_offers: ['scrape'],
  scraperapi_ebay_product: ['scrape'],
  scraperapi_ebay_search: ['search'],
  scraperapi_walmart_product: ['scrape'],
  scraperapi_walmart_search: ['search'],
  scraperapi_walmart_category: ['scrape'],
  scraperapi_walmart_reviews: ['scrape'],
  scraperapi_google_search: ['search'],
  scraperapi_google_news: ['news'],
  scraperapi_google_jobs: ['search'],
  scraperapi_google_shopping: ['search'],
  scraperapi_google_maps: ['search'],
  scraperapi_redfin_agent_details: ['scrape'],
  scraperapi_redfin_for_rent: ['search'],
  scraperapi_redfin_for_sale: ['search'],
  scraperapi_redfin_listing_search: ['search'],

  // -- scrapingbee (internal/scrapingbeebackend/routes.go:53-175) --
  scrapingbee_scrape: ['scrape'],
  scrapingbee_google: ['search'],
  scrapingbee_amazon_product: ['scrape'],
  scrapingbee_amazon_search: ['search'],
  scrapingbee_youtube_search: ['search'],
  scrapingbee_youtube_metadata: ['scrape'],
  scrapingbee_youtube_subtitles: ['scrape'],
  scrapingbee_walmart_product: ['scrape'],
  scrapingbee_walmart_search: ['search'],
  scrapingbee_chatgpt: ['other'],
  scrapingbee_gemini: ['other'],

  // -- xro (internal/xrobackend/routes.go:68-95) --
  xro_tweet_lookup: ['social'],
  xro_tweets_lookup: ['social'],
  xro_tweets_search_recent: ['social'],
  xro_tweets_search_all: ['social'],
  xro_tweets_counts_recent: ['social'],
  xro_tweets_counts_all: ['social'],
  xro_user_tweets: ['social'],
  xro_user_mentions: ['social'],
  xro_user_lookup: ['social'],
  xro_user_by_username: ['social'],
  xro_users_lookup: ['social'],
  xro_users_by: ['social'],
  xro_user_followers: ['social'],
  xro_user_following: ['social'],
  xro_trends_by_woeid: ['social'],
  xro_space_lookup: ['social'],
  xro_spaces_lookup: ['social'],
  xro_spaces_by_creator_ids: ['social'],
  xro_spaces_search: ['social'],
  xro_space_tweets: ['social'],
  xro_space_buyers: ['social'],
  xro_list_lookup: ['social'],
  xro_list_tweets: ['social'],
  xro_list_members: ['social'],
  xro_list_followers: ['social'],
  xro_user_owned_lists: ['social'],
  xro_user_list_memberships: ['social'],
  xro_user_followed_lists: ['social'],
};

/** Frozen for the same reason as RECOMMENDATIONS: determinism is a property of
 * the data, not of anything a caller does to it at runtime. */
Object.freeze(METHOD_INTENTS);
for (const intents of Object.values(METHOD_INTENTS)) Object.freeze(intents);

/**
 * The keyword fallback's rules, in priority order.
 *
 * `substrings` match anywhere in the haystack, which is what lets one keyword
 * cover a family of inflections (`post` -> `posts`/`posted`, `event` ->
 * `events`). `tokens` must match a *whole* word instead, split on
 * non-alphanumeric boundaries.
 *
 * The distinction exists because a keyword short enough to occur inside
 * ordinary English is worse than useless as a substring. `ip` is the case:
 * scraped-web prose is full of "JavaScript", "multiple" and "shipping", so a
 * substring `ip` would file a new backend's `render`/`batch`/`products` methods
 * under `proxy` and they would never surface in the `scrape` or `crawl` group
 * an agent actually asked for -- defeating the whole point of this layer. Any
 * keyword added here at two or three characters belongs in `tokens`.
 */
const KEYWORD_RULES: Array<{ intent: Intent; substrings?: string[]; tokens?: string[] }> = [
  { intent: 'crawl', substrings: ['crawl'] },
  { intent: 'search', substrings: ['search'] },
  { intent: 'scrape', substrings: ['scrape', 'unlock', 'fetch', 'contents'] },
  { intent: 'news', substrings: ['news', 'article', 'event'] },
  { intent: 'social', substrings: ['tweet', 'post', 'user'] },
  { intent: 'proxy', substrings: ['proxy'], tokens: ['ip'] },
];

const CATEGORY_RULES: Array<{ category: string; intents: Intent[] }> = [
  { category: 'Search', intents: ['search'] },
  { category: 'Crawl', intents: ['scrape', 'crawl'] },
];

/**
 * Classifies one catalog method into the intent(s) it serves. Layered, in
 * priority order, and each layer is total (never throws, never returns an
 * empty array):
 *
 * 1. The static `METHOD_INTENTS` table, keyed by the same
 *    `{backendId}_{method}` shape `methodToToolName` builds.
 * 2. A keyword fallback over the method's name / path / description, so a
 *    method this table has never seen is still discoverable the day it
 *    registers, without a release. Long keywords match as
 *    substrings, short ones only as whole tokens -- see `KEYWORD_RULES`.
 * 3. The backend's declared catalog `categories`
 *    (internal/gateway/manifest.go:97) -- a floor, not a classifier: it is a
 *    three-value product taxonomy (Search / Crawl / Others), so an unknown
 *    backend on this layer alone lands in `search`, `scrape`+`crawl`, or falls
 *    through to `other`.
 * 4. `other`, unconditionally, so the function is always total.
 */
export function classifyMethod(backendId: string, method: ClassifiableMethod, categories?: string[]): Intent[] {
  const toolName = methodToToolName(backendId, method.name);
  const known = METHOD_INTENTS[toolName];
  // A copy, not the frozen table entry: every branch below returns a fresh
  // array, and callers that merge/dedupe intents across a provider's methods
  // (provider-view.ts) must not hit a TypeError on the common path only.
  if (known) return [...known];

  const haystack = `${method.name} ${method.path ?? ''} ${method.description ?? ''}`.toLowerCase();
  const tokens = new Set(haystack.split(/[^a-z0-9]+/));
  for (const rule of KEYWORD_RULES) {
    if (rule.substrings?.some((kw) => haystack.includes(kw))) return [rule.intent];
    if (rule.tokens?.some((tk) => tokens.has(tk))) return [rule.intent];
  }

  for (const rule of CATEGORY_RULES) {
    // Copy: `rule.intents` is a module-level array shared by every call, so
    // returning it directly lets one caller's mutation corrupt the rule.
    if (categories?.includes(rule.category)) return [...rule.intents];
  }

  return ['other'];
}

/**
 * The fezo-native adapter: classifies a normalized `ToolCandidate`
 * (catalog.ts) by delegating to `classifyMethod`.
 *
 * Passes `candidate.method` -- the manifest's own method name -- and NOT
 * `candidate.tool`. `classifyMethod` rebuilds the `{backendId}_{method}` tool
 * name itself via `methodToToolName(backendId, method.name)` to look it up in
 * `METHOD_INTENTS`; handing it the already-built tool name as `method.name`
 * would make it rebuild `{backendId}_{candidate.tool}` instead, a name that
 * appears in no table and always falls through to the keyword/category/other
 * layers.
 */
export function classifyCandidate(candidate: ToolCandidate): Intent[] {
  return classifyMethod(
    candidate.backendId,
    { name: candidate.method, path: candidate.path, description: candidate.description },
    candidate.backendCategories,
  );
}
