import { describe, expect, it } from 'vitest';

import type { ToolCandidate } from '../src/engine/catalog.js';
import { CAPABILITY_KEYWORDS, CAPABILITY_PREFERENCES, inferCapability } from '../src/engine/preference.js';
import {
  isAsyncLifecycleMethod,
  queryRequestsAsyncBehavior,
  rankCandidates,
  removeStopWords,
  searchCandidates,
  selectForRun,
  tokenize,
} from '../src/engine/rank.js';
import type { RunSelection, SearchMatch } from '../src/engine/rank.js';
import { methodToToolName } from '../src/engine/tool-name.js';

// ---------------------------------------------------------------------------
// Fixture helper — small, hand-written ToolCandidate values, not
// transcriptions of any real catalog or gateway manifest.
// ---------------------------------------------------------------------------

// Real `backendInfoText` values, copied from the deployed gateway's own
// backend manifests. They are quoted verbatim because their
// exact wording is the hazard under test: each contains an async word, and
// `backendInfoText` is backend-WIDE (identical on every method a backend
// exposes). If async text detection read this field, one word here would
// exclude every method of the backend — which for these three backends means
// every deployed rung of the `scrape` and `serp` preference lists, leaving
// `run` with nothing to select. Fixtures below must use these, not '', or
// they cannot see that failure.
const FIRECRAWL_INFO =
  'Scrape pages, map and crawl sites, and search the web via the Firecrawl v2 API. Crawl starts asynchronously and is polled by job id.';
const SCRAPERAPI_INFO =
  'Scrape any URL (with JS rendering, geotargeting, premium proxies), collect structured data from Amazon, eBay, Walmart, Google, and Redfin, and run large/hard scrapes via the async jobs API. Billed per ScraperAPI credit.';
const BRIGHTDATA_INFO =
  'Fetch any URL through the Web Unlocker, run search-engine queries via the SERP API, and collect structured data from any Bright Data dataset (including the Social Media scrapers) via the async trigger/poll/download flow. Billed per request and per collected record.';
const FALAI_INFO =
  'Run Fal AI models for image, video, audio, and other generative tasks — synchronously, or submitted to the Fal job queue and polled for results.';

// falai's `queue.result` and its synchronous neighbour `run`, verbatim from
// that backend's deployed manifest. `queue.result` is the only live
// method whose async nature is carried by nothing but the phrase "request id"
// in its own description — no async name suffix, no `poll`, and an output
// schema that is the real model result rather than an id. `run` is its
// synchronous neighbour, quoted so the same fixtures can show the phrase does
// not over-reach.
const FALAI_QUEUE_RESULT_TITLE = 'Get queued request result';
const FALAI_QUEUE_RESULT_DESCRIPTION =
  'Fetch the result of a completed queued Fal AI request by its request id.';
const FALAI_RUN_TITLE = 'Run a model (synchronous)';
const FALAI_RUN_DESCRIPTION =
  "Run a Fal AI model and wait for the result. The path is the Fal model id; the JSON body is the model's input.";

function makeCandidate(
  overrides: Partial<ToolCandidate> & Pick<ToolCandidate, 'backendId' | 'method'>,
): ToolCandidate {
  const { backendId, method } = overrides;
  const base: ToolCandidate = {
    tool: methodToToolName(backendId, method),
    backendId,
    method,
    path: `/${method}`,
    protocol: 'http',
    httpMethod: 'POST',
    bindings: {},
    description: '',
    inputSchema: {},
    userSettings: [],
    backendInfoText: '',
    billingModel: 'dynamic',
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Tokenization and stop words.
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('lower-cases and splits on whitespace and punctuation', () => {
    expect(tokenize('Scrape: the URL, please!')).toEqual(['scrape', 'the', 'url', 'please']);
  });

  it('drops empty segments from repeated punctuation', () => {
    expect(tokenize('scrape---url')).toEqual(['scrape', 'url']);
  });
});

describe('removeStopWords', () => {
  it('drops the specified stop words', () => {
    expect(removeStopWords(tokenize('scrape the url for a client'))).toEqual(['scrape', 'url', 'client']);
  });

  it('keeps every token when the query has no other terms (escape hatch)', () => {
    // "the" and "a" are both stop words; filtering them would leave nothing.
    expect(removeStopWords(['the', 'a'])).toEqual(['the', 'a']);
  });
});

// ---------------------------------------------------------------------------
// Search matching.
// ---------------------------------------------------------------------------

describe('searchCandidates', () => {
  it('matches "scrape" against text containing only "Web Scraper" (substring, not token equality)', () => {
    const candidate = makeCandidate({
      backendId: 'acme',
      method: 'proxy_fetch',
      description: 'Fetch a page through a residential proxy',
      backendInfoText: 'Web Scraper',
    });

    const matches = searchCandidates([candidate], 'scrape');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedTerms).toEqual(['scrape']);
  });

  it('ANDs across all remaining terms: different phrasing produces different candidate sets', () => {
    const hasBoth = makeCandidate({
      backendId: 'firecrawl',
      method: 'scrape',
      description: 'Scrape a url and return its content',
    });
    const scrapeOnly = makeCandidate({
      backendId: 'other',
      method: 'scrape',
      description: 'Scrape any webpage',
    });

    const urlMatches = searchCandidates([hasBoth, scrapeOnly], 'scrape url');
    expect(urlMatches.map((m) => m.candidate.backendId)).toEqual(['firecrawl']);

    const webpageMatches = searchCandidates([hasBoth, scrapeOnly], 'scrape webpage');
    expect(webpageMatches.map((m) => m.candidate.backendId)).toEqual(['other']);
  });

  it('flags an exact tool-name query with exactMatch: "tool"', () => {
    // (A query equal to the tool name also happens to satisfy AND-matching,
    // since the identifiers text always contains the tool name itself — the
    // exactMatch flag's real load-bearing use is in selectForRun's async
    // exclusion override, "or names the tool exactly", tested below.)
    const candidate = makeCandidate({
      backendId: 'firecrawl',
      method: 'status_check',
      description: 'Internal housekeeping method with unrelated words',
    });

    const matches = searchCandidates([candidate], candidate.tool);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.exactMatch).toBe('tool');
  });
});

// ---------------------------------------------------------------------------
// Async-lifecycle exclusion — the detail most likely to silently break this
// task. `firecrawl` contains the substring "crawl"; only exact method-name
// equality to "crawl" may exclude, never a substring test against the tool
// name.
// ---------------------------------------------------------------------------

describe('isAsyncLifecycleMethod', () => {
  it('does NOT exclude firecrawl_scrape or firecrawl_search (backend id contains "crawl" as a substring)', () => {
    const scrape = makeCandidate({
      backendId: 'firecrawl',
      method: 'scrape',
      description: 'Scrape a single page',
      backendInfoText: FIRECRAWL_INFO,
    });
    const search = makeCandidate({
      backendId: 'firecrawl',
      method: 'search',
      description: 'Search the web',
      backendInfoText: FIRECRAWL_INFO,
    });

    expect(isAsyncLifecycleMethod(scrape)).toBe(false);
    expect(isAsyncLifecycleMethod(search)).toBe(false);
  });

  it('does NOT exclude a sync method whose BACKEND-WIDE info text mentions async/poll/job id', () => {
    // The real manifests: firecrawl "polled by job id", scraperapi "async jobs
    // API", brightdata "async trigger/poll/download flow". Async text
    // detection reads the method's OWN title/description only. Reading
    // backendInfoText here would exclude every method of all three backends —
    // i.e. every deployed rung of the scrape and serp preference lists.
    const cases = [
      makeCandidate({
        backendId: 'firecrawl',
        method: 'scrape',
        title: 'Scrape a URL',
        description: 'Fetch a single URL and return its cleaned content in the requested formats.',
        backendInfoText: FIRECRAWL_INFO,
      }),
      makeCandidate({
        backendId: 'scraperapi',
        method: 'scrape',
        title: 'Scrape a URL',
        description: 'Fetch any URL through the ScraperAPI proxy and return the raw response body.',
        backendInfoText: SCRAPERAPI_INFO,
      }),
      makeCandidate({
        backendId: 'brightdata',
        method: 'scrape',
        title: 'Unlock a URL',
        description: 'Fetch any URL through the Web Unlocker and return the response body.',
        backendInfoText: BRIGHTDATA_INFO,
      }),
    ];

    for (const candidate of cases) {
      expect(isAsyncLifecycleMethod(candidate), `${candidate.tool} must survive async exclusion`).toBe(false);
    }
  });

  it('still excludes firecrawl_crawl even though its backend info is not consulted', () => {
    // Two independent reasons, neither of which is backendInfoText: the exact
    // method name `crawl`, and the method's OWN description.
    const crawl = makeCandidate({
      backendId: 'firecrawl',
      method: 'crawl',
      title: 'Crawl a site',
      description: 'Returns a job id; poll crawl_status for results',
      backendInfoText: FIRECRAWL_INFO,
    });
    expect(isAsyncLifecycleMethod(crawl)).toBe(true);

    // Reason 1 alone: the method name, with a description that says nothing async.
    const nameOnly = makeCandidate({
      backendId: 'firecrawl',
      method: 'crawl',
      description: 'Crawl an entire site starting from a URL',
      backendInfoText: FIRECRAWL_INFO,
    });
    expect(isAsyncLifecycleMethod(nameOnly)).toBe(true);

    // Reason 2 alone: the method's own description, with a sync-looking name.
    const textOnly = makeCandidate({
      backendId: 'firecrawl',
      method: 'batch_scrape',
      description: 'Returns a job id; poll crawl_status for results',
      backendInfoText: FIRECRAWL_INFO,
    });
    expect(isAsyncLifecycleMethod(textOnly)).toBe(true);
  });

  it('excludes any backend\'s exact "crawl" method, not only firecrawl\'s', () => {
    const crawl = makeCandidate({ backendId: 'geonode', method: 'crawl' });
    expect(isAsyncLifecycleMethod(crawl)).toBe(true);
  });

  it('excludes by name-pattern suffix (_async, _status, _snapshot, _get, _dataset, _progress)', () => {
    const suffixes = ['start_async', 'job_status', 'job_snapshot', 'result_get', 'export_dataset', 'crawl_progress'];
    for (const method of suffixes) {
      const candidate = makeCandidate({ backendId: 'acme', method });
      expect(isAsyncLifecycleMethod(candidate)).toBe(true);
    }
  });

  it('excludes a BARE lifecycle method name (status, get, progress, snapshot, dataset, async)', () => {
    // The spec's patterns are globs over the tool name (`*_status`), and the
    // suffix test is anchored there: `'status'.endsWith('_status')` is false,
    // so a method named exactly `status` would escape a method-anchored test.
    // Anchoring on the tool name is still safe against the firecrawl hazard
    // because a backend id is always followed by `_`.
    for (const method of ['status', 'get', 'progress', 'snapshot', 'dataset', 'async']) {
      const candidate = makeCandidate({ backendId: 'acme', method });
      expect(isAsyncLifecycleMethod(candidate), `bare method "${method}" must be excluded`).toBe(true);
    }

    // Same suffixes appearing inside a BACKEND id must not exclude anything:
    // the suffix has to land at the end of the tool name.
    const statusBackend = makeCandidate({ backendId: 'status_io', method: 'scrape' });
    expect(isAsyncLifecycleMethod(statusBackend)).toBe(false);
  });

  it('still excludes the live catalog\'s async methods once backendInfoText is out of the picture', () => {
    // Copied from the deployed manifests. brightdata's `snapshot` is the
    // load-bearing one: it is the download step of the async
    // trigger/poll/download flow, its own title and description contain no
    // async phrase at all, and it used to be excluded only by the
    // backend-wide info text. Tool-name anchoring (`*_snapshot`) is what keeps
    // it excluded now.
    const snapshot = makeCandidate({
      backendId: 'brightdata',
      method: 'snapshot',
      title: 'Download snapshot data',
      description: 'Download the collected records for a ready snapshot.',
      backendInfoText: BRIGHTDATA_INFO,
    });
    expect(snapshot.tool).toBe('brightdata_snapshot');
    expect(isAsyncLifecycleMethod(snapshot)).toBe(true);

    const crawlStatus = makeCandidate({
      backendId: 'firecrawl',
      method: 'crawl_status',
      description: 'Poll a crawl job by id. Returns status, completed/total counts, scraped data.',
      backendInfoText: FIRECRAWL_INFO,
    });
    const scrapeAsync = makeCandidate({
      backendId: 'scraperapi',
      method: 'scrape_async',
      description: 'Submit an async scrape job for a hard site or large batch. Returns a job id.',
      backendInfoText: SCRAPERAPI_INFO,
    });
    const snapshotProgress = makeCandidate({
      backendId: 'brightdata',
      method: 'snapshot_progress',
      description: 'Poll an async snapshot by id.',
      backendInfoText: BRIGHTDATA_INFO,
    });
    for (const candidate of [crawlStatus, scrapeAsync, snapshotProgress]) {
      expect(isAsyncLifecycleMethod(candidate), `${candidate.tool} must stay excluded`).toBe(true);
    }

    // ...while the sync neighbours from the same backends stay eligible.
    const map = makeCandidate({
      backendId: 'firecrawl',
      method: 'map',
      title: 'Map a site',
      description: 'List the URLs of a site.',
      backendInfoText: FIRECRAWL_INFO,
    });
    expect(isAsyncLifecycleMethod(map)).toBe(false);
  });

  it('excludes falai_queue_result, whose ONLY async signal is the phrase "request id"', () => {
    // Real title/description/output schema from that backend's deployed
    // manifest. This method downloads the result
    // of a completed queued job, so `run` must never auto-call it — a 2xx is
    // billed. Every other detector misses it on purpose:
    //   - name: tool is `falai_queue_result`; no ASYNC_NAME_SUFFIXES match and
    //     the method is not exactly `crawl`;
    //   - output shape: it is the free-form model result envelope (no
    //     properties at all), not "an id to poll later";
    //   - backendInfoText ("...polled for results") is deliberately not read.
    // So the phrase list is the whole defence, and it needs the SPACED
    // spelling: the prose says "request id", not "request_id".

    // falai's modelResultSchema, shared verbatim by `run` and `queue.result`.
    const modelResultSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      description: 'Model-specific result; shape depends on the model.',
      additionalProperties: true,
    };

    const queueResult = makeCandidate({
      backendId: 'falai',
      method: 'queue.result',
      title: FALAI_QUEUE_RESULT_TITLE,
      description: FALAI_QUEUE_RESULT_DESCRIPTION,
      outputSchema: modelResultSchema,
      backendInfoText: FALAI_INFO,
    });

    expect(queueResult.tool).toBe('falai_queue_result');
    expect(isAsyncLifecycleMethod(queueResult)).toBe(true);

    // Guards the premise, and is what makes the assertion above a real test of
    // the added phrase rather than of some other detector: strike "request id"
    // out of the description and nothing else catches this candidate. Drop
    // 'request id' from ASYNC_TEXT_PHRASES and the assertion above fails while
    // this one still passes.
    const withoutPhrase: ToolCandidate = {
      ...queueResult,
      description: FALAI_QUEUE_RESULT_DESCRIPTION.replace('request id', 'identifier'),
    };
    expect(withoutPhrase.description).not.toContain('request id');
    expect(isAsyncLifecycleMethod(withoutPhrase)).toBe(false);

    // ...and the phrase does not over-reach: falai's synchronous `run` method
    // shares the same backend info text and output schema and stays eligible.
    const run = makeCandidate({
      backendId: 'falai',
      method: 'run',
      title: FALAI_RUN_TITLE,
      description: FALAI_RUN_DESCRIPTION,
      outputSchema: modelResultSchema,
      backendInfoText: FALAI_INFO,
    });
    expect(isAsyncLifecycleMethod(run)).toBe(false);
  });

  it('excludes a *_status method whose tool name was hash-capped for length', () => {
    // methodToToolName truncates over MAX_TOOL_NAME_LENGTH and appends
    // `-<hash>`, so the capped tool name no longer ends in `_status`. The
    // uncapped `${backendId}_${method}` spelling is checked too for exactly
    // this case.
    const method = `${'b'.repeat(30)}_status`;
    const candidate = makeCandidate({ backendId: 'a'.repeat(40), method });

    expect(candidate.tool.endsWith('_status')).toBe(false); // guards the premise
    expect(isAsyncLifecycleMethod(candidate)).toBe(true);
  });

  it('excludes by descriptive text phrase even when the method name looks synchronous', () => {
    const candidate = makeCandidate({
      backendId: 'acme',
      method: 'begin_export',
      description: 'Returns a snapshot_id to poll for results later',
    });
    expect(isAsyncLifecycleMethod(candidate)).toBe(true);
  });

  it('excludes by output shape that is only an id to poll later', () => {
    const candidate = makeCandidate({
      backendId: 'acme',
      method: 'begin',
      outputSchema: { type: 'object', properties: { snapshot_id: { type: 'string' } } },
    });
    expect(isAsyncLifecycleMethod(candidate)).toBe(true);
  });

  it('does not exclude a normal method with an ordinary output schema', () => {
    const candidate = makeCandidate({
      backendId: 'acme',
      method: 'lookup',
      description: 'Look up a product by id',
      outputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } } },
    });
    expect(isAsyncLifecycleMethod(candidate)).toBe(false);
  });
});

describe('queryRequestsAsyncBehavior', () => {
  it('is true when the intent explicitly names async/job/snapshot/status/crawl', () => {
    expect(queryRequestsAsyncBehavior('crawl the whole site')).toBe(true);
    expect(queryRequestsAsyncBehavior('check the job status')).toBe(true);
  });

  it('is false for an ordinary intent', () => {
    expect(queryRequestsAsyncBehavior('scrape this page')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Capability inference (preference.ts).
// ---------------------------------------------------------------------------

describe('inferCapability', () => {
  it('returns none when no capability keyword matches', () => {
    expect(inferCapability('list all the widgets')).toEqual({ kind: 'none' });
  });

  it('matches a single capability', () => {
    const result = inferCapability('please scrape this url');
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.capability).toBe('scrape');
    }
  });

  it('matches a keyword phrase that itself contains a stop word ("page content")', () => {
    // "page" is a rank.ts stop word. Capability inference reads the ORIGINAL
    // intent, not stop-word-filtered tokens, so this must still match scrape
    // via the "page content" phrase.
    const result = inferCapability('Please get the page content for our records');
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.capability).toBe('scrape');
      expect(result.matchedPhrases).toContain('page content');
    }

    // Demonstrate why the two pipelines must stay separate: the same intent,
    // once tokenized and stop-word filtered for search, no longer contains "page".
    expect(removeStopWords(tokenize('Please get the page content for our records'))).not.toContain('page');
  });

  it('resolves multiple matches via an exact-phrase winner over a single-token match', () => {
    // "google search" (serp, multi-word) beats a coincidental "scrape" hit? No —
    // use an intent where scrape matches by bare token and serp matches by phrase.
    const result = inferCapability('scrape the google search results page');
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.capability).toBe('serp');
    }
  });

  it('is ambiguous when multiple capabilities match with no exact-phrase winner', () => {
    const result = inferCapability('serp scrape');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      const capabilities = result.candidates.map((c) => c.capability).sort();
      expect(capabilities).toEqual(['scrape', 'serp']);
    }
  });

  it('is ambiguous when two capabilities each win on an exact phrase', () => {
    // "google search" (serp) and "search web" (web-search) are both
    // multi-word phrase hits, so neither uniquely wins the phrase tie-break.
    const result = inferCapability('google search web');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      const capabilities = result.candidates.map((c) => c.capability).sort();
      expect(capabilities).toEqual(['serp', 'web-search']);
    }
  });
});

// Sanity: the two data tables cover the same capability set.
describe('CAPABILITY_KEYWORDS and CAPABILITY_PREFERENCES', () => {
  it('define preference hints for every capability that has keywords', () => {
    expect(Object.keys(CAPABILITY_PREFERENCES).sort()).toEqual(Object.keys(CAPABILITY_KEYWORDS).sort());
  });

  it('makes every capability in CAPABILITY_KEYWORDS reachable through inferCapability', () => {
    // preference.ts enumerates the capabilities it scans in an explicit
    // CAPABILITY_LIST (no `Object.keys(...) as Capability[]` assertion), so a
    // capability added to CAPABILITY_KEYWORDS but not to that list would be
    // silently un-inferrable. This is the guard for that.
    for (const [capability, phrases] of Object.entries(CAPABILITY_KEYWORDS)) {
      const phrase = phrases[0];
      expect(phrase, `capability "${capability}" has no keyword phrases`).toBeDefined();
      if (phrase === undefined) continue;

      const result = inferCapability(phrase);
      expect(result.kind, `capability "${capability}" is unreachable via inferCapability("${phrase}")`).toBe(
        'matched',
      );
      if (result.kind === 'matched') expect(result.capability).toBe(capability);
    }
  });
});

// ---------------------------------------------------------------------------
// Ranking and provider preference (rank.ts, using preference.ts's tables).
// ---------------------------------------------------------------------------

describe('rankCandidates', () => {
  it('ranks an exact tool match ahead of a higher term-score candidate', () => {
    // Built by hand rather than via searchCandidates: this isolates
    // rankCandidates' tier ordering from search's own AND-matching, which
    // would otherwise make it awkward to get both candidates into the same
    // matched set while keeping their term scores unequal.
    const named = makeCandidate({ backendId: 'acme', method: 'lookup' });
    const other = makeCandidate({ backendId: 'other', method: 'lookup_widget', title: 'Widget Lookup' });

    const matches: SearchMatch[] = [
      { candidate: other, matchedTerms: ['widget', 'lookup'] }, // higher term score
      { candidate: named, matchedTerms: [], exactMatch: 'tool' }, // but an exact tool match
    ];

    const ranked = rankCandidates(matches, 'irrelevant intent text');

    expect(ranked[0]?.candidate.backendId).toBe('acme');
    expect(ranked[0]?.explanation.tier).toBe('exact-tool');
  });

  it('reaches the exact-method tier for a method name containing an underscore', () => {
    // `tokenize` splits on `_`, so an intent equal to the method name
    // `scrape_url` yields the tokens {scrape, url} and NEVER the token
    // `scrape_url`. classifyTier must honor searchCandidates' `exactMatch:
    // "method"` instead of re-deriving the tier from token membership;
    // otherwise this candidate falls to `term-score` while the competing
    // backend's bare `scrape` method is promoted to `exact-method` and wins on
    // a method-name shape coincidence.
    const underscored = makeCandidate({
      backendId: 'scrapingbee',
      method: 'scrape_url',
      description: 'Fetch a single address',
    });
    const bare = makeCandidate({
      backendId: 'firecrawl',
      method: 'scrape',
      description: 'Scrape a url and return its content',
    });

    const matches = searchCandidates([bare, underscored], 'scrape_url');
    const named = matches.find((m) => m.candidate.backendId === 'scrapingbee');
    expect(named?.exactMatch).toBe('method');

    const ranked = rankCandidates(matches, 'scrape_url', 'scrape');

    expect(ranked[0]?.candidate.method).toBe('scrape_url');
    expect(ranked[0]?.explanation.tier).toBe('exact-method');
  });

  it('reaches the exact-backend-method tier when the query names both identifiers as tokens', () => {
    const target = makeCandidate({ backendId: 'firecrawl', method: 'scrape', description: 'Scrape a page' });
    const other = makeCandidate({ backendId: 'scraperapi', method: 'fetch', description: 'Scrape a page' });

    const ranked = rankCandidates(searchCandidates([other, target], 'firecrawl scrape'), 'firecrawl scrape');

    expect(ranked[0]?.candidate.backendId).toBe('firecrawl');
    expect(ranked[0]?.explanation.tier).toBe('exact-backend-method');
  });

  it('weights term hits identifiers 3 / title 2 / description+backend info 1', () => {
    // Pins the tier-4 weights themselves (see the comment on
    // IDENTIFIER_TERM_WEIGHT in rank.ts). One term, one hit each, in a
    // different field per candidate.
    const inIdentifier = makeCandidate({ backendId: 'a', method: 'widget' });
    const inTitle = makeCandidate({ backendId: 'b', method: 'op', title: 'Widget lookup' });
    const inRest = makeCandidate({ backendId: 'c', method: 'op', description: 'Handles widget requests' });
    const inBackendInfo = makeCandidate({ backendId: 'd', method: 'op', backendInfoText: 'Widget provider' });

    const ranked = rankCandidates(
      searchCandidates([inIdentifier, inTitle, inRest, inBackendInfo], 'widget'),
      'widget',
    );

    expect(ranked.map((r) => [r.candidate.backendId, r.explanation.termScore])).toEqual([
      ['a', 3],
      ['b', 2],
      ['c', 1],
      ['d', 1],
    ]);
  });

  it('lets a higher term score beat capability preference (tier 4 is compared before tier 5)', () => {
    // Load-bearing consequence of the tier order, pinned so it cannot change
    // silently: firecrawl is CAPABILITY_PREFERENCES.scrape[0] and scrapingbee
    // is [1], but scrapingbee scores higher on terms (both query terms hit its
    // identifiers, weight 3 each) and therefore wins outright.
    const preferred = makeCandidate({
      backendId: 'firecrawl',
      method: 'fetch',
      description: 'Scrape a url',
      backendInfoText: FIRECRAWL_INFO,
    });
    const higherScore = makeCandidate({
      backendId: 'scrapingbee',
      method: 'scrape_url',
      description: 'Fetch a single address',
    });

    const ranked = rankCandidates(searchCandidates([preferred, higherScore], 'scrape url'), 'scrape url', 'scrape');

    expect(ranked[0]?.candidate.backendId).toBe('scrapingbee');
    expect(ranked[0]?.explanation.termScore).toBe(6);
    expect(ranked[0]?.explanation.preference).toEqual({ capability: 'scrape', position: 1 });
    // ...and the loser really was the top-preference backend.
    expect(ranked[1]?.explanation.preference).toEqual({ capability: 'scrape', position: 0 });
    expect(ranked[1]?.explanation.termScore).toBe(2);
  });

  it('uses capability preference when term scores tie (tier 5)', () => {
    const scraperapi = makeCandidate({ backendId: 'scraperapi', method: 'scrape', title: 'Scrape URL' });
    const firecrawl = makeCandidate({ backendId: 'firecrawl', method: 'scrape', title: 'Scrape URL' });

    const ranked = rankCandidates(searchCandidates([scraperapi, firecrawl], 'scrape'), 'scrape', 'scrape');

    expect(ranked.map((r) => r.candidate.backendId)).toEqual(['firecrawl', 'scraperapi']);
  });

  it('uses billing model as a weak tie-breaker (package < per_call < dynamic)', () => {
    // Method names avoid the query term entirely, and the query term lives
    // only in an identical description across all three, so tier and term
    // score tie and billing model is left to decide.
    const dynamic = makeCandidate({ backendId: 'a', method: 'op_a', description: 'Handles widget requests', billingModel: 'dynamic' });
    const perCall = makeCandidate({ backendId: 'b', method: 'op_b', description: 'Handles widget requests', billingModel: 'per_call' });
    const packaged = makeCandidate({ backendId: 'c', method: 'op_c', description: 'Handles widget requests', billingModel: 'package' });

    const matches = searchCandidates([dynamic, perCall, packaged], 'widget');
    const ranked = rankCandidates(matches, 'widget');

    expect(ranked.map((r) => r.candidate.backendId)).toEqual(['c', 'b', 'a']);
  });
});

// ---------------------------------------------------------------------------
// selectForRun — the full search + async-exclusion + capability inference +
// ranking pipeline, and the auto-pick refusal decision.
// ---------------------------------------------------------------------------

describe('selectForRun', () => {
  it('selects exa for "web search" over brave_search/exa_search/firecrawl_search — not the alphabetically-first backend', () => {
    // firecrawl carries its REAL backend info text, which says "Crawl starts
    // asynchronously and is polled by job id". If that backend-wide field fed
    // async detection, firecrawl_search would be silently dropped here — the
    // acid test would still pass (exa wins either way) and prove nothing.
    const infoText: Record<string, string> = { firecrawl: FIRECRAWL_INFO };
    const candidates = ['brave', 'exa', 'firecrawl'].map((backendId) =>
      makeCandidate({
        backendId,
        method: 'search',
        title: 'Web Search',
        description: 'Web search API',
        backendInfoText: infoText[backendId] ?? '',
      }),
    );

    const result = selectForRun(candidates, 'web search');

    expect(result.outcome).toBe('selected');
    if (result.outcome === 'selected') {
      expect(result.chosen.candidate.backendId).toBe('exa');
      expect(result.chosen.explanation.preference).toEqual({ capability: 'web-search', position: 0 });
      // The whole matched set survived async exclusion, firecrawl included.
      expect(result.ranked.map((r) => r.candidate.backendId).sort()).toEqual(['brave', 'exa', 'firecrawl']);
    }
  });

  it('selects firecrawl for "scrape url" over scraperapi/brightdata, with all three backends\' real info text', () => {
    // Against the live catalog these are the only deployed rungs of
    // CAPABILITY_PREFERENCES.scrape, and every one of their real backend info
    // strings contains an async word ("polled by job id" / "async jobs API" /
    // "async trigger/poll/download flow"). If async detection read
    // backendInfoText, all three would be excluded and `run "scrape url"`
    // would answer no-match — the `scrape` capability would be dead.
    const infoText: Record<string, string> = {
      firecrawl: FIRECRAWL_INFO,
      scraperapi: SCRAPERAPI_INFO,
      brightdata: BRIGHTDATA_INFO,
    };
    const candidates = ['firecrawl', 'scraperapi', 'brightdata'].map((backendId) =>
      makeCandidate({
        backendId,
        method: 'scrape',
        title: 'Scrape URL',
        description: 'Scrape a url and return its content',
        backendInfoText: infoText[backendId] ?? '',
      }),
    );

    const result = selectForRun(candidates, 'scrape url');

    expect(result.outcome).toBe('selected');
    if (result.outcome === 'selected') {
      expect(result.chosen.candidate.backendId).toBe('firecrawl');
      expect(result.chosen.explanation.preference).toEqual({ capability: 'scrape', position: 0 });
      expect(result.ranked.map((r) => r.candidate.backendId)).toEqual(['firecrawl', 'scraperapi', 'brightdata']);
    }
  });

  it('selects a serp provider for "google search results" despite the backends\' async info text', () => {
    // Same hazard for the serp capability: scraperapi is
    // CAPABILITY_PREFERENCES.serp[0], brightdata is last, and both real info
    // strings contain async words.
    const scraperapi = makeCandidate({
      backendId: 'scraperapi',
      method: 'serp',
      title: 'Google SERP',
      description: 'Run a google search and return the results',
      backendInfoText: SCRAPERAPI_INFO,
    });
    const brightdata = makeCandidate({
      backendId: 'brightdata',
      method: 'serp',
      title: 'Google SERP',
      description: 'Run a google search and return the results',
      backendInfoText: BRIGHTDATA_INFO,
    });

    const result = selectForRun([brightdata, scraperapi], 'google search results');

    expect(result.outcome).toBe('selected');
    if (result.outcome === 'selected') {
      expect(result.chosen.candidate.backendId).toBe('scraperapi');
      expect(result.chosen.explanation.preference).toEqual({ capability: 'serp', position: 0 });
      expect(result.ranked).toHaveLength(2);
    }
  });

  it('refuses to auto-pick when candidates span two or more backends and no capability hint applies', () => {
    const candidates = ['acme', 'beta'].map((backendId) =>
      makeCandidate({ backendId, method: 'list_widgets', description: 'List all widgets' }),
    );

    const result = selectForRun(candidates, 'list widgets');

    expect(result.outcome).toBe('refused-unhinted-multi-backend');
    if (result.outcome === 'refused-unhinted-multi-backend') {
      expect(result.reason).toEqual({ kind: 'unhinted-multi-backend', backends: ['acme', 'beta'] });
      // This is the ONE overridable refusal, so it — and only it — hands back a
      // ranked list whose head `--allow-unhinted-auto-pick` may promote. The
      // outer `outcome` literal is what makes `ranked` visible here, so the
      // promotion branch cannot be written without naming this state.
      expect(result.ranked).toHaveLength(2);
    } else {
      expect.unreachable('expected an unhinted-multi-backend refusal');
    }
  });

  it('permits auto-pick with no capability hint when all matched candidates are from one backend', () => {
    const candidates = [
      makeCandidate({ backendId: 'acme', method: 'list_widgets', description: 'List all widgets' }),
      makeCandidate({ backendId: 'acme', method: 'export_widgets', description: 'List all widgets for export' }),
    ];

    const result = selectForRun(candidates, 'list widgets');

    expect(result.outcome).toBe('selected');
    if (result.outcome === 'selected') {
      expect(result.chosen.candidate.backendId).toBe('acme');
      expect(result.ranked.every((r) => r.candidate.backendId === 'acme')).toBe(true);
      expect(result.ranked.length).toBeGreaterThan(1);
    }
  });

  it('refuses on an ambiguous capability and lists the candidate capabilities', () => {
    // Each candidate's own searchable text must contain BOTH query terms
    // ("serp" and "scrape") to survive AND-across-all-terms matching —
    // "scraperapi" conveniently already contains the substring "scrape".
    const candidates = [
      makeCandidate({ backendId: 'firecrawl', method: 'scrape', description: 'Scrape a page or look up serp data' }),
      makeCandidate({ backendId: 'scraperapi', method: 'serp_lookup', description: 'Query SERP results' }),
    ];

    const result = selectForRun(candidates, 'serp scrape');

    expect(result.outcome).toBe('refused-ambiguous-capability');
    if (result.outcome === 'refused-ambiguous-capability') {
      expect(result.reason.kind).toBe('ambiguous-capability');
      // Copy before sorting: `.sort()` mutates in place, and this array is the
      // engine's own, not a defensive copy.
      expect([...result.reason.capabilities].sort()).toEqual(['scrape', 'serp']);
      // Ambiguous capability is NOT overridable by --allow-unhinted-auto-pick,
      // so this variant offers no promotable `ranked` list — only display-only
      // alternatives.
      expect('ranked' in result).toBe(false);
      expect(result.alternatives).toHaveLength(2);
    } else {
      expect.unreachable('expected an ambiguous-capability refusal');
    }
  });

  it('preserves the order of reason.capabilities (the engine must not hand back a mutated array)', () => {
    const candidates = [
      makeCandidate({ backendId: 'firecrawl', method: 'scrape', description: 'Scrape a page or look up serp data' }),
      makeCandidate({ backendId: 'scraperapi', method: 'serp_lookup', description: 'Query SERP results' }),
    ];

    const result = selectForRun(candidates, 'serp scrape');

    expect(result.outcome).toBe('refused-ambiguous-capability');
    if (result.outcome === 'refused-ambiguous-capability') {
      // CAPABILITY_LIST order in preference.ts, not intent order: scrape first.
      expect(result.reason.capabilities).toEqual(['scrape', 'serp']);
    }
  });

  it('excludes firecrawl_crawl from auto-pick unless the intent explicitly asks for crawl behavior', () => {
    const crawl = makeCandidate({
      backendId: 'firecrawl',
      method: 'crawl',
      description: 'Recursively fetch every page starting from a URL',
    });

    // Matches via description text alone ("fetch"/"every"), with no override
    // word in the query: the async-lifecycle exclusion applies and there is
    // nothing else to select. That is reported as `async-excluded`, NOT
    // `no-match` — the two have different remedies and Task 8's `run` says so.
    const excluded = selectForRun([crawl], 'fetch every page');
    expect(excluded.outcome).toBe('async-excluded');
    if (excluded.outcome === 'async-excluded') {
      expect(excluded.asyncExcluded.map((c) => c.tool)).toEqual(['firecrawl_crawl']);
    }

    // Same candidate, but the intent now explicitly says "crawl": the
    // async-lifecycle exclusion is lifted and the candidate is selected.
    const explicit = selectForRun([crawl], 'fetch every page and crawl');
    expect(explicit.outcome).toBe('selected');
    if (explicit.outcome === 'selected') {
      expect(explicit.chosen.candidate.method).toBe('crawl');
    }
  });

  it('lifts async exclusion when the query names the tool exactly, even without an override keyword', () => {
    const candidate = makeCandidate({
      backendId: 'acme',
      method: 'export_dataset', // "_dataset" suffix — async-excluded by name pattern.
      description: 'Export the full result set',
    });

    // No override word ("async"/"job"/"snapshot"/"status"/"crawl") in this
    // query, so the async-lifecycle exclusion applies by default.
    const byDescription = selectForRun([candidate], 'export the full result set');
    expect(byDescription.outcome).toBe('async-excluded');

    // Naming the tool exactly lifts the exclusion even though the query
    // still contains no override keyword.
    const byExactTool = selectForRun([candidate], candidate.tool);
    expect(byExactTool.outcome).toBe('selected');
    if (byExactTool.outcome === 'selected') {
      expect(byExactTool.chosen.candidate.method).toBe('export_dataset');
    }
  });

  it('does not auto-pick (and bill) falai_queue_result for "queued request result"', () => {
    // The billing hazard the "request id" phrase closes, end to end. falai's
    // other two queue methods were already detected (`queue.submit` says
    // "...a request id to poll", `queue.status` ends in `_status`), so
    // `queue.result` was the single undetected async method in the live
    // catalog: it is falai's only match for this intent, falai is the only
    // backend in the set, and an unhinted single-backend set is auto-pickable
    // — i.e. `run` would have issued a billed call to a result-download
    // endpoint.
    const queueResult = makeCandidate({
      backendId: 'falai',
      method: 'queue.result',
      title: FALAI_QUEUE_RESULT_TITLE,
      description: FALAI_QUEUE_RESULT_DESCRIPTION,
      backendInfoText: FALAI_INFO,
    });
    const run = makeCandidate({
      backendId: 'falai',
      method: 'run',
      title: FALAI_RUN_TITLE,
      description: FALAI_RUN_DESCRIPTION,
      backendInfoText: FALAI_INFO,
    });

    const result = selectForRun([run, queueResult], 'queued request result');

    expect(result.outcome).toBe('async-excluded');
    if (result.outcome === 'async-excluded') {
      expect(result.asyncExcluded.map((c) => c.tool)).toEqual(['falai_queue_result']);
    }

    // The remedies still work, and `call` is unaffected.
    expect(selectForRun([run, queueResult], queueResult.tool).outcome).toBe('selected');

    // And the synchronous sibling is still selectable on its own terms.
    const sync = selectForRun([run, queueResult], 'run a model');
    expect(sync.outcome).toBe('selected');
    if (sync.outcome === 'selected') expect(sync.chosen.candidate.method).toBe('run');
  });

  it('returns no-match when nothing matches the query', () => {
    const candidates = [makeCandidate({ backendId: 'acme', method: 'lookup', description: 'irrelevant' })];
    const result = selectForRun(candidates, 'completely unrelated gibberish query');
    expect(result.outcome).toBe('no-match');
  });

  it('distinguishes "nothing matched" from "everything that matched was async-excluded"', () => {
    const asyncOnly = makeCandidate({
      backendId: 'brightdata',
      method: 'snapshot_progress',
      description: 'Poll an async snapshot by id and report the collected record count',
      backendInfoText: BRIGHTDATA_INFO,
    });

    // Nothing matched at all: no candidate carries these words.
    expect(selectForRun([asyncOnly], 'translate a document').outcome).toBe('no-match');

    // Something matched, but only async lifecycle methods. Task 8 needs to
    // tell the user to name the tool exactly or ask for async behavior, which
    // it cannot do from a bare no-match.
    const excluded = selectForRun([asyncOnly], 'collected record count');
    expect(excluded.outcome).toBe('async-excluded');
    if (excluded.outcome === 'async-excluded') {
      expect(excluded.asyncExcluded).toEqual([asyncOnly]);
    }

    // And the remedies both work.
    expect(selectForRun([asyncOnly], 'collected record count snapshot').outcome).toBe('selected');
    expect(selectForRun([asyncOnly], asyncOnly.tool).outcome).toBe('selected');
  });
});

// ---------------------------------------------------------------------------
// RunSelection's discriminant. `run` decides here whether a BILLED gateway
// call happens, and only two of the five outcomes may lead to one, so the
// shape must let the compiler — not a comment — enforce which branch can
// promote a candidate.
// ---------------------------------------------------------------------------

/**
 * Compile-time proof that `outcome` alone discriminates all five states.
 *
 * This is the real test for finding 2, and it is enforced by `pnpm typecheck`
 * rather than by an assertion:
 *
 *   - the `never` default arm fails to compile if a sixth state is added
 *     without being handled here;
 *   - the two `refused-*` case labels fail to compile (TS2678, "not
 *     comparable") if the refusals ever collapse back into a single
 *     `outcome: 'refused'` discriminated only by a nested `reason.kind`;
 *   - `result.ranked` is reachable in exactly one refusal arm, so the
 *     `--allow-unhinted-auto-pick` promotion cannot be written on a guard that
 *     also matches `selected` (which carries `ranked` too — the trap that
 *     `'ranked' in result` fell into).
 */
function summarizeOutcome(result: RunSelection): string {
  switch (result.outcome) {
    case 'no-match':
      return 'no-match';
    case 'async-excluded':
      return `async-excluded:${result.asyncExcluded.length}`;
    case 'selected':
      return `selected:${result.chosen.candidate.tool}`;
    case 'refused-ambiguous-capability':
      // Display only: no `ranked`, because this refusal is not overridable.
      return `refused-ambiguous-capability:${result.reason.capabilities.join('+')}`;
    case 'refused-unhinted-multi-backend':
      // The one branch that may promote a candidate, and only under the flag.
      return `refused-unhinted-multi-backend:${result.reason.backends.join('+')}:${result.ranked.length}`;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

describe('RunSelection outcome discriminant', () => {
  it('gives all five states — including each refusal — a distinct outcome literal', () => {
    const noMatch = selectForRun(
      [makeCandidate({ backendId: 'acme', method: 'lookup', description: 'irrelevant' })],
      'completely unrelated gibberish query',
    );
    const asyncExcluded = selectForRun(
      [makeCandidate({ backendId: 'acme', method: 'export_dataset', description: 'Export the full result set' })],
      'export the full result set',
    );
    const selected = selectForRun(
      [makeCandidate({ backendId: 'acme', method: 'list_widgets', description: 'List all widgets' })],
      'list widgets',
    );
    const ambiguous = selectForRun(
      [
        makeCandidate({
          backendId: 'firecrawl',
          method: 'scrape',
          description: 'Scrape a page or look up serp data',
        }),
        makeCandidate({ backendId: 'scraperapi', method: 'serp_lookup', description: 'Query SERP results' }),
      ],
      'serp scrape',
    );
    const unhinted = selectForRun(
      ['acme', 'beta'].map((backendId) =>
        makeCandidate({ backendId, method: 'list_widgets', description: 'List all widgets' }),
      ),
      'list widgets',
    );

    const outcomes = [noMatch, asyncExcluded, selected, ambiguous, unhinted].map((r) => r.outcome);
    expect(outcomes).toEqual([
      'no-match',
      'async-excluded',
      'selected',
      'refused-ambiguous-capability',
      'refused-unhinted-multi-backend',
    ]);
    // Would collapse to 4 if the two refusals ever shared one literal again.
    expect(new Set(outcomes).size).toBe(5);

    // Exercise the exhaustive switch above at runtime too, so the compile-time
    // guard is not dead code.
    expect([noMatch, asyncExcluded, selected, ambiguous, unhinted].map(summarizeOutcome)).toEqual([
      'no-match',
      'async-excluded:1',
      'selected:acme_list_widgets',
      'refused-ambiguous-capability:scrape+serp',
      'refused-unhinted-multi-backend:acme+beta:2',
    ]);
  });

  it('offers a promotable `ranked` list on the overridable refusal only', () => {
    const candidates = ['acme', 'beta'].map((backendId) =>
      makeCandidate({ backendId, method: 'list_widgets', description: 'List all widgets' }),
    );
    const unhinted = selectForRun(candidates, 'list widgets');
    const ambiguous = selectForRun(
      [
        makeCandidate({
          backendId: 'firecrawl',
          method: 'scrape',
          description: 'Scrape a page or look up serp data',
        }),
        makeCandidate({ backendId: 'scraperapi', method: 'serp_lookup', description: 'Query SERP results' }),
      ],
      'serp scrape',
    );

    // How Task 8 must write the override: keyed on the outcome literal, which
    // is the only narrowing that exposes `ranked` on a refusal.
    const promote = (result: RunSelection): string | undefined =>
      result.outcome === 'refused-unhinted-multi-backend' ? result.ranked[0]?.candidate.tool : undefined;

    expect(promote(unhinted)).toBe('acme_list_widgets');
    expect(promote(ambiguous)).toBeUndefined();
    expect('ranked' in ambiguous).toBe(false);
  });
});
