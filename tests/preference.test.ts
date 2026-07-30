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
import type { SearchMatch } from '../src/engine/rank.js';
import { methodToToolName } from '../src/engine/tool-name.js';

// ---------------------------------------------------------------------------
// Fixture helper — small, hand-written ToolCandidate values, not
// transcriptions of any real catalog or gateway manifest.
// ---------------------------------------------------------------------------

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
    const scrape = makeCandidate({ backendId: 'firecrawl', method: 'scrape', description: 'Scrape a single page' });
    const search = makeCandidate({ backendId: 'firecrawl', method: 'search', description: 'Search the web' });

    expect(isAsyncLifecycleMethod(scrape)).toBe(false);
    expect(isAsyncLifecycleMethod(search)).toBe(false);
  });

  it('excludes firecrawl_crawl by exact method-name equality', () => {
    const crawl = makeCandidate({
      backendId: 'firecrawl',
      method: 'crawl',
      description: 'Crawl an entire site starting from a URL',
    });

    expect(isAsyncLifecycleMethod(crawl)).toBe(true);
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
    const candidates = ['brave', 'exa', 'firecrawl'].map((backendId) =>
      makeCandidate({
        backendId,
        method: 'search',
        title: 'Web Search',
        description: 'Web search API',
      }),
    );

    const result = selectForRun(candidates, 'web search');

    expect(result.outcome).toBe('selected');
    if (result.outcome === 'selected') {
      expect(result.chosen.candidate.backendId).toBe('exa');
      expect(result.chosen.explanation.preference).toEqual({ capability: 'web-search', position: 0 });
    }
  });

  it('selects firecrawl for "scrape url" over firecrawl_scrape/scraperapi_scrape', () => {
    const candidates = ['firecrawl', 'scraperapi'].map((backendId) =>
      makeCandidate({
        backendId,
        method: 'scrape',
        title: 'Scrape URL',
        description: 'Scrape a url and return its content',
      }),
    );

    const result = selectForRun(candidates, 'scrape url');

    expect(result.outcome).toBe('selected');
    if (result.outcome === 'selected') {
      expect(result.chosen.candidate.backendId).toBe('firecrawl');
      expect(result.chosen.explanation.preference).toEqual({ capability: 'scrape', position: 0 });
    }
  });

  it('refuses to auto-pick when candidates span two or more backends and no capability hint applies', () => {
    const candidates = ['acme', 'beta'].map((backendId) =>
      makeCandidate({ backendId, method: 'list_widgets', description: 'List all widgets' }),
    );

    const result = selectForRun(candidates, 'list widgets');

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toEqual({ kind: 'unhinted-multi-backend', backends: ['acme', 'beta'] });
      expect(result.ranked).toHaveLength(2);
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

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason.kind).toBe('ambiguous-capability');
      if (result.reason.kind === 'ambiguous-capability') {
        expect(result.reason.capabilities.sort()).toEqual(['scrape', 'serp']);
      }
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
    // nothing else to select.
    const excluded = selectForRun([crawl], 'fetch every page');
    expect(excluded.outcome).toBe('no-match');

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
    expect(byDescription.outcome).toBe('no-match');

    // Naming the tool exactly lifts the exclusion even though the query
    // still contains no override keyword.
    const byExactTool = selectForRun([candidate], candidate.tool);
    expect(byExactTool.outcome).toBe('selected');
    if (byExactTool.outcome === 'selected') {
      expect(byExactTool.chosen.candidate.method).toBe('export_dataset');
    }
  });

  it('returns no-match when nothing matches the query', () => {
    const candidates = [makeCandidate({ backendId: 'acme', method: 'lookup', description: 'irrelevant' })];
    const result = selectForRun(candidates, 'completely unrelated gibberish query');
    expect(result.outcome).toBe('no-match');
  });
});
