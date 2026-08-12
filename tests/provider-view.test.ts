import { describe, expect, it } from 'vitest';

import type { ToolCandidate } from '../src/engine/catalog.js';
import {
  annotate,
  annotateListed,
  groupByCapability,
  listProviders,
  viewForIntent,
} from '../src/engine/provider-view.js';
import { RECOMMENDATION_SOURCE } from '../src/engine/providers.js';

// ---------------------------------------------------------------------------
// Fixture helper — mirrors the convention in intent.test.ts/catalog.test.ts.
// ---------------------------------------------------------------------------

function candidate(
  overrides: Partial<ToolCandidate> & Pick<ToolCandidate, 'backendId' | 'method'>,
): ToolCandidate {
  const { backendId, method } = overrides;
  const base: ToolCandidate = {
    tool: `${backendId}_${method}`,
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
    backendCategories: [],
    billingModel: 'per_call',
  };
  return { ...base, ...overrides };
}

const NO_EXCLUSIONS: readonly string[] = [];

// ---------------------------------------------------------------------------
// viewForIntent — the three ordered passes.
// ---------------------------------------------------------------------------

describe('viewForIntent', () => {
  it('pass 1: every declared, non-notRecommended provider present in the catalog, in declared order', () => {
    // search's declared order is you, exa, brave, firecrawl, geonode.
    const candidates = [
      candidate({ backendId: 'brave', method: 'search' }),
      candidate({ backendId: 'you', method: 'search' }), // deliberately out of declared order
      candidate({ backendId: 'exa', method: 'search' }),
    ];
    const rows = viewForIntent(candidates, 'search', NO_EXCLUSIONS);
    expect(rows.map((r) => r.backendId)).toEqual(['you', 'exa', 'brave']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.rated)).toBe(true);
  });

  it('omits a declared provider with no method in the live catalog right now', () => {
    const candidates = [candidate({ backendId: 'you', method: 'search' })];
    const rows = viewForIntent(candidates, 'search', NO_EXCLUSIONS);
    expect(rows.map((r) => r.backendId)).toEqual(['you']);
  });

  it('pass 2: an off-list backend declared for ANOTHER intent is rated:true, with offListWhy naming it', () => {
    // scrapingdog is declared for `scrape`, not `search` -- but
    // scrapingdog_google_search classifies (via METHOD_INTENTS) into `search`.
    const candidates = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'scrapingdog', method: 'google_search' }),
    ];
    const rows = viewForIntent(candidates, 'search', NO_EXCLUSIONS);
    const offList = rows.find((r) => r.backendId === 'scrapingdog');
    expect(offList).toBeDefined();
    expect(offList?.rated).toBe(true);
    expect(offList?.provider).toBe('Scrapingdog');
    expect(offList?.why).toContain('not among the recommended providers for search');
    expect(offList?.why).toContain('scrape'); // scrapingdog IS declared for scrape elsewhere
    expect(offList?.entryMethods).toEqual([]);
    // Ranked after every declared (pass 1) row.
    expect(rows.map((r) => r.backendId).indexOf('scrapingdog')).toBeGreaterThan(
      rows.map((r) => r.backendId).indexOf('you'),
    );
  });

  it('pass 2: a backend no declared list mentions at all is rated:false with UNRATED_WHY', () => {
    const candidates = [
      candidate({ backendId: 'brand-new-backend', method: 'lookup', description: 'Search the whole web' }),
    ];
    const rows = viewForIntent(candidates, 'search', NO_EXCLUSIONS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rated).toBe(false);
    expect(rows[0]?.provider).toBe('brand-new-backend');
    expect(rows[0]?.why).toContain('Not yet assessed');
  });

  it('pass 2: sorts off-list/unrated rows by backendId for determinism', () => {
    const candidates = [
      candidate({ backendId: 'zzz-backend', method: 'lookup', description: 'Search the index' }),
      candidate({ backendId: 'aaa-backend', method: 'lookup', description: 'Search the index' }),
    ];
    const rows = viewForIntent(candidates, 'search', NO_EXCLUSIONS);
    expect(rows.map((r) => r.backendId)).toEqual(['aaa-backend', 'zzz-backend']);
  });

  it('pass 3: a notRecommended declared provider is always last, still rated:true, carrying notRecommended', () => {
    // social: apify, brightdata (both non-notRecommended), then xro (notRecommended).
    const candidates = [
      candidate({ backendId: 'xro', method: 'tweets_search_recent' }),
      candidate({ backendId: 'apify', method: 'runs_submit' }),
    ];
    const rows = viewForIntent(candidates, 'social', NO_EXCLUSIONS);
    expect(rows.map((r) => r.backendId)).toEqual(['apify', 'xro']);
    const xroRow = rows[1];
    expect(xroRow?.rated).toBe(true);
    expect(xroRow?.notRecommended).toBeDefined();
  });

  it('never lets a notRecommended provider leak into pass 1 or pass 2', () => {
    const candidates = [candidate({ backendId: 'xro', method: 'tweets_search_recent' })];
    const rows = viewForIntent(candidates, 'social', NO_EXCLUSIONS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.backendId).toBe('xro');
    expect(rows[0]?.rank).toBe(1);
  });

  it('the deny-list removes a backend from every pass', () => {
    const declared = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'exa', method: 'search' }),
    ];
    const rows = viewForIntent(declared, 'search', ['exa']);
    expect(rows.map((r) => r.backendId)).toEqual(['you']);

    const offList = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'scrapingdog', method: 'google_search' }),
    ];
    expect(viewForIntent(offList, 'search', ['scrapingdog']).map((r) => r.backendId)).toEqual(['you']);

    const notRecommended = [
      candidate({ backendId: 'apify', method: 'runs_submit' }),
      candidate({ backendId: 'xro', method: 'tweets_search_recent' }),
    ];
    expect(viewForIntent(notRecommended, 'social', ['xro']).map((r) => r.backendId)).toEqual(['apify']);
  });

  it('methods is every catalog tool name for the backend, sorted -- not just the entry methods', () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'research' }),
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'you', method: 'contents' }),
    ];
    const rows = viewForIntent(candidates, 'search', NO_EXCLUSIONS);
    expect(rows[0]?.methods).toEqual(['you_contents', 'you_research', 'you_search']);
  });

  it('entryMethods is the declared subset intersected with what the catalog actually publishes', () => {
    // Only you_contents is live; you's declared search entry method (you_search) is absent.
    const candidates = [candidate({ backendId: 'you', method: 'contents' })];
    const rows = viewForIntent(candidates, 'search', NO_EXCLUSIONS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.backendId).toBe('you');
    expect(rows[0]?.entryMethods).toEqual([]);
    expect(rows[0]?.methods).toEqual(['you_contents']);
  });

  it('carries billing and categories from the backend\'s own candidates', () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'search', billingModel: 'dynamic', backendCategories: ['Search'] }),
    ];
    const rows = viewForIntent(candidates, 'search', NO_EXCLUSIONS);
    expect(rows[0]?.billing).toBe('dynamic');
    expect(rows[0]?.categories).toEqual(['Search']);
  });

  it('an intent with no matching candidates at all is an empty array, never a throw', () => {
    expect(viewForIntent([], 'search', NO_EXCLUSIONS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// groupByCapability — bestValue's presence conditions.
// ---------------------------------------------------------------------------

describe('groupByCapability', () => {
  it('one group per INTENTS entry, in INTENTS order', () => {
    const groups = groupByCapability([], NO_EXCLUSIONS);
    expect(groups.map((g) => g.capability)).toEqual(['search', 'scrape', 'crawl', 'news', 'social', 'proxy', 'other']);
  });

  it('bestValue is the rank-1 backendId when it is a declared, non-notRecommended row', () => {
    const candidates = [candidate({ backendId: 'you', method: 'search' })];
    const groups = groupByCapability(candidates, NO_EXCLUSIONS);
    const search = groups.find((g) => g.capability === 'search');
    expect(search?.bestValue).toBe('you');
  });

  it('bestValue is undefined for an empty group', () => {
    const groups = groupByCapability([], NO_EXCLUSIONS);
    const search = groups.find((g) => g.capability === 'search');
    expect(search?.bestValue).toBeUndefined();
    expect(search?.providers).toEqual([]);
  });

  it('bestValue is undefined when the rank-1 row is off-list/unrated (alphabetical position, not a judgment)', () => {
    // No declared search provider present at all -- only an off-list one.
    const candidates = [candidate({ backendId: 'scrapingdog', method: 'google_search' })];
    const groups = groupByCapability(candidates, NO_EXCLUSIONS);
    const search = groups.find((g) => g.capability === 'search');
    expect(search?.providers[0]?.backendId).toBe('scrapingdog');
    expect(search?.bestValue).toBeUndefined();
  });

  it('bestValue is undefined when the rank-1 row is notRecommended', () => {
    const candidates = [candidate({ backendId: 'xro', method: 'tweets_search_recent' })];
    const groups = groupByCapability(candidates, NO_EXCLUSIONS);
    const social = groups.find((g) => g.capability === 'social');
    expect(social?.providers[0]?.backendId).toBe('xro');
    expect(social?.bestValue).toBeUndefined();
  });

  it('"other" never advertises a bestValue, even with a rank-1 row present', () => {
    const candidates = [candidate({ backendId: 'apify', method: 'runs_get' })]; // METHOD_INTENTS -> ['other']
    const groups = groupByCapability(candidates, NO_EXCLUSIONS);
    const other = groups.find((g) => g.capability === 'other');
    expect(other?.providers.length).toBeGreaterThan(0);
    expect(other?.bestValue).toBeUndefined();
  });

  it('the deny-list is applied per group, exactly as in viewForIntent', () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'exa', method: 'search' }),
    ];
    const groups = groupByCapability(candidates, ['you']);
    const search = groups.find((g) => g.capability === 'search');
    expect(search?.providers.map((p) => p.backendId)).toEqual(['exa']);
    expect(search?.bestValue).toBe('exa');
  });
});

// ---------------------------------------------------------------------------
// annotate — the wire shape.
// ---------------------------------------------------------------------------

describe('annotate', () => {
  it('produces snake_case fields and omits when/not_recommended when absent', () => {
    const [row] = viewForIntent([candidate({ backendId: 'you', method: 'search' })], 'search', NO_EXCLUSIONS);
    const annotated = annotate(row!);
    expect(annotated).toMatchObject({ rank: 1, tier: 'primary', rated: true, backend_id: 'you', provider: 'You.com' });
    expect(Object.hasOwn(annotated, 'when')).toBe(false);
    expect(Object.hasOwn(annotated, 'not_recommended')).toBe(false);
    expect(Object.hasOwn(annotated, 'source')).toBe(false);
  });

  it('includes when/not_recommended when the row has them', () => {
    const [row] = viewForIntent([candidate({ backendId: 'exa', method: 'search' })], 'search', NO_EXCLUSIONS);
    expect(annotate(row!).when).toBeDefined();

    const [xroRow] = viewForIntent(
      [candidate({ backendId: 'xro', method: 'tweets_search_recent' })],
      'social',
      NO_EXCLUSIONS,
    );
    expect(annotate(xroRow!).not_recommended).toBeDefined();
  });

  it('adds the doc citation only when explain is requested', () => {
    const [row] = viewForIntent([candidate({ backendId: 'you', method: 'search' })], 'search', NO_EXCLUSIONS);
    expect(annotate(row!, { explain: true }).source).toEqual({
      doc: RECOMMENDATION_SOURCE.doc,
      prepared: RECOMMENDATION_SOURCE.preparedAt,
    });
    expect(annotate(row!, { explain: false }).source).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listProviders / annotateListed — the cross-intent merge.
// ---------------------------------------------------------------------------

describe('listProviders', () => {
  it('one row per non-excluded backend present in the catalog', () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'brightdata', method: 'unlock' }),
    ];
    const rows = listProviders(candidates, NO_EXCLUSIONS);
    expect(rows.map((r) => r.backendId).sort()).toEqual(['brightdata', 'you']);
  });

  it('merges every declared intent for a multi-intent backend', () => {
    const candidates = [candidate({ backendId: 'brightdata', method: 'unlock' })];
    const [row] = listProviders(candidates, NO_EXCLUSIONS);
    const intents = row?.recommendations.map((r) => r.intent).sort();
    expect(intents).toEqual(['crawl', 'proxy', 'scrape', 'social'].sort());
  });

  it('orders rated-and-active providers by their best (lowest) rank, then alphabetically', () => {
    // scrapingdog: rank 1 in `scrape`. geonode: rank 2 in `search`, but also
    // rank 2 in `scrape` and rank 1 in `proxy` -- its best rank is 1 (proxy).
    const candidates = [
      candidate({ backendId: 'scrapingdog', method: 'scrape' }),
      candidate({ backendId: 'geonode', method: 'scrape' }),
    ];
    const rows = listProviders(candidates, NO_EXCLUSIONS);
    // Both have a best rank of 1 (scrapingdog in scrape, geonode in proxy) --
    // tie-broken alphabetically.
    expect(rows.map((r) => r.backendId)).toEqual(['geonode', 'scrapingdog']);
  });

  it('places never-assessed backends after every rated-and-active one, alphabetically', () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'zzz-newcomer', method: 'op', description: '' }),
      candidate({ backendId: 'aaa-newcomer', method: 'op', description: '' }),
    ];
    const rows = listProviders(candidates, NO_EXCLUSIONS);
    expect(rows.map((r) => r.backendId)).toEqual(['you', 'aaa-newcomer', 'zzz-newcomer']);
    expect(rows[1]?.rated).toBe(false);
    expect(rows[1]?.why).toBeUndefined();
  });

  it('places a backend that is notRecommended in EVERY intent it is declared under last of all', () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'zzz-newcomer', method: 'op', description: '' }),
      candidate({ backendId: 'xro', method: 'tweets_search_recent' }),
    ];
    const rows = listProviders(candidates, NO_EXCLUSIONS);
    expect(rows.map((r) => r.backendId)).toEqual(['you', 'zzz-newcomer', 'xro']);
    const xro = rows[2];
    expect(xro?.rated).toBe(true);
    expect(xro?.recommendations.every((r) => r.notRecommended !== undefined)).toBe(true);
  });

  it('the deny-list removes a backend entirely, not just from one intent', () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'exa', method: 'search' }),
    ];
    const rows = listProviders(candidates, ['exa']);
    expect(rows.map((r) => r.backendId)).toEqual(['you']);
  });

  it('methods is every catalog tool name for the backend, sorted', () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'research' }),
      candidate({ backendId: 'you', method: 'search' }),
    ];
    const [row] = listProviders(candidates, NO_EXCLUSIONS);
    expect(row?.methods).toEqual(['you_research', 'you_search']);
  });
});

describe('annotateListed', () => {
  it('produces snake_case fields and omits why/when/not_recommended when absent', () => {
    const candidates = [candidate({ backendId: 'you', method: 'search' })];
    const [row] = listProviders(candidates, NO_EXCLUSIONS);
    const annotated = annotateListed(row!);
    expect(annotated.backend_id).toBe('you');
    expect(annotated.provider).toBe('You.com');
    // you's own best rec (search, primary) has a `why` but no `when`.
    expect(annotated.why).toBeDefined();
    expect(Object.hasOwn(annotated, 'when')).toBe(false);
    expect(annotated.recommendations.every((r) => Object.hasOwn(r, 'not_recommended') === false)).toBe(true);
  });

  it('surfaces not_recommended on the per-intent recommendations array', () => {
    const candidates = [candidate({ backendId: 'xro', method: 'tweets_search_recent' })];
    const [row] = listProviders(candidates, NO_EXCLUSIONS);
    const annotated = annotateListed(row!);
    expect(annotated.recommendations[0]?.not_recommended).toBeDefined();
  });
});
