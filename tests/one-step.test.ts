import { describe, expect, it, vi } from 'vitest';

import type { ToolCandidate } from '../src/engine/catalog.js';
import type { OneStepSpec } from '../src/engine/one-step.js';
import { ONE_STEP_SPECS, buildWalk, resolveArgName, runOneStep } from '../src/engine/one-step.js';

// ---------------------------------------------------------------------------
// Fixture helper -- mirrors the convention in provider-view.test.ts/catalog.test.ts.
// Tests are built against the REAL declared table (providers.ts's
// RECOMMENDATIONS), same as provider-view.test.ts, rather than a synthetic
// roster: this is a port of policy already decided elsewhere, and a fixture
// that invented its own fake backendIds would not exercise it.
// ---------------------------------------------------------------------------

function candidate(overrides: Partial<ToolCandidate> & Pick<ToolCandidate, 'backendId' | 'method'>): ToolCandidate {
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
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    userSettings: [],
    backendInfoText: '',
    backendCategories: [],
    billingModel: 'per_call',
  };
  return { ...base, ...overrides };
}

const NO_EXCLUSIONS: readonly string[] = [];

function specFor(command: 'web-search' | 'scrape' | 'crawl'): OneStepSpec {
  const spec = ONE_STEP_SPECS.find((s) => s.command === command);
  if (!spec) throw new Error(`no ONE_STEP_SPEC for "${command}"`);
  return spec;
}

function okResponse(bodyText: string, status = 200): Response {
  return new Response(bodyText, { status });
}

function gatewayErrorResponse(status: number, code: string, message = 'gateway said no'): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status });
}

/** Mirrors retry.test.ts's `routedFetch`: routes by which candidate's
 * `/v1/{backendId}/...` URL was requested, one queued response per call. */
function routedFetch(handlers: Record<string, Response[]>): typeof fetch {
  const queues = new Map(Object.entries(handlers).map(([id, responses]) => [id, [...responses]]));
  return vi.fn(async (url: string | URL) => {
    const asString = String(url);
    for (const [backendId, queue] of queues) {
      if (asString.includes(`/v1/${backendId}/`)) {
        const next = queue.shift();
        if (next === undefined) {
          throw new Error(`routedFetch: backend "${backendId}" was called more times than it had responses queued`);
        }
        return next;
      }
    }
    throw new Error(`routedFetch: no handler registered for URL ${asString}`);
  }) as unknown as typeof fetch;
}

const GATEWAY = { baseUrl: 'https://gw.example.com', apiKey: 'k' };

// ---------------------------------------------------------------------------
// resolveArgName
// ---------------------------------------------------------------------------

describe('resolveArgName', () => {
  it('a required candidate beats an earlier-listed optional one', () => {
    // ARG_CANDIDATES.query lists "query" before "keyword"; "keyword" wins here
    // anyway because it is required and "query" is not.
    const name = resolveArgName(
      { type: 'object', properties: { query: { type: 'string' }, keyword: { type: 'string' } }, required: ['keyword'] },
      'query',
    );
    expect(name).toBe('keyword');
  });

  it('among two equally-unrequired candidates, ARG_CANDIDATES list order decides', () => {
    // "q" is listed before "keyword" in ARG_CANDIDATES.query.
    const name = resolveArgName({ type: 'object', properties: { keyword: { type: 'string' }, q: { type: 'string' } } }, 'query');
    expect(name).toBe('q');
  });

  it('returns undefined when the schema names nothing plausible for this kind', () => {
    expect(resolveArgName({ type: 'object', properties: { foo: { type: 'string' } } }, 'query')).toBeUndefined();
    expect(resolveArgName({ type: 'object', properties: { query: { type: 'string' } } }, 'url')).toBeUndefined();
  });

  it('returns undefined when the schema declares no properties at all', () => {
    expect(resolveArgName({}, 'query')).toBeUndefined();
    expect(resolveArgName({ type: 'object' }, 'url')).toBeUndefined();
  });

  it('resolves a url-kind candidate the same way', () => {
    expect(resolveArgName({ type: 'object', properties: { url: { type: 'string' }, link: { type: 'string' } } }, 'url')).toBe('url');
  });
});

// ---------------------------------------------------------------------------
// buildWalk
// ---------------------------------------------------------------------------

describe('buildWalk', () => {
  const webSearchSpec = specFor('web-search'); // intent: search

  it('walks the declared roster in declared order, each step carrying its resolved argument name', () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'exa', method: 'search' }),
      candidate({ backendId: 'brave', method: 'search' }),
      candidate({ backendId: 'firecrawl', method: 'search' }),
      candidate({ backendId: 'geonode', method: 'search' }),
    ];
    const { walk, skipped } = buildWalk(webSearchSpec, candidates, NO_EXCLUSIONS);
    expect(walk.map((s) => s.backendId)).toEqual(['you', 'exa', 'brave', 'firecrawl', 'geonode']);
    expect(walk.map((s) => s.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(walk.every((s) => s.argName === 'query')).toBe(true);
    expect(skipped).toEqual([]);
  });

  it('skips a declared provider entirely absent from the live catalog, naming it in `skipped`', () => {
    const candidates = [candidate({ backendId: 'you', method: 'search' }), candidate({ backendId: 'brave', method: 'search' })];
    const { walk, skipped } = buildWalk(webSearchSpec, candidates, NO_EXCLUSIONS);
    expect(walk.map((s) => s.backendId)).toEqual(['you', 'brave']);
    expect(skipped).toContain('exa (not in catalog)');
  });

  it('rank always comes from viewForIntent, never a loop-local counter: a partially-entitled catalog shifts it', () => {
    // exa (declared 2nd) is absent; brave (declared 3rd) must move up to rank
    // 2, not keep a rank derived from this function's own iteration.
    const candidates = [candidate({ backendId: 'you', method: 'search' }), candidate({ backendId: 'brave', method: 'search' })];
    const { walk } = buildWalk(webSearchSpec, candidates, NO_EXCLUSIONS);
    expect(walk.find((s) => s.backendId === 'you')?.rank).toBe(1);
    expect(walk.find((s) => s.backendId === 'brave')?.rank).toBe(2);
  });

  it('skips a provider whose only live method has no plausible argument for this command\'s argKind', () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({
        backendId: 'firecrawl',
        method: 'search',
        inputSchema: { type: 'object', properties: { pageToken: { type: 'string' } } },
      }),
    ];
    const { walk, skipped } = buildWalk(webSearchSpec, candidates, NO_EXCLUSIONS);
    expect(walk.map((s) => s.backendId)).toEqual(['you']);
    expect(skipped).toContain('firecrawl (no query argument)');
  });

  it('takes the first declared entryMethods entry that both exists in the catalog and resolves an argument name', () => {
    // newsapi (declared under `news`) has TWO declared entryMethods:
    // newsapi_articles (no plausible query argument here) and newsapi_events
    // (does) -- the walk must skip past the first and take the second.
    const newsSpec: OneStepSpec = { command: 'web-search', intent: 'news', argKind: 'query' };
    const candidates = [
      candidate({ backendId: 'newsapi', method: 'articles', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }),
      candidate({ backendId: 'newsapi', method: 'events', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }),
    ];
    const { walk } = buildWalk(newsSpec, candidates, NO_EXCLUSIONS);
    const step = walk.find((s) => s.backendId === 'newsapi');
    expect(step?.candidate.tool).toBe('newsapi_events');
    expect(step?.argName).toBe('query');
  });

  it('a deny-listed provider is passed over silently: never attempted, never named in `skipped`', () => {
    // Every declared search provider present, so the only thing that could
    // land in `skipped` is the excluded one -- and it must not.
    const candidates = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'exa', method: 'search' }),
      candidate({ backendId: 'brave', method: 'search' }),
      candidate({ backendId: 'firecrawl', method: 'search' }),
      candidate({ backendId: 'geonode', method: 'search' }),
    ];
    const { walk, skipped } = buildWalk(webSearchSpec, candidates, ['exa']);
    expect(walk.map((s) => s.backendId)).toEqual(['you', 'brave', 'firecrawl', 'geonode']);
    expect(skipped).toEqual([]);
  });

  it('a notRecommended provider is passed over silently, exactly like a deny-listed one', () => {
    // social: xro is the table's one notRecommended entry. Every declared
    // social provider is present, so `skipped` must end up empty -- xro is
    // passed over without ever being named.
    const socialSpec: OneStepSpec = { command: 'web-search', intent: 'social', argKind: 'query' };
    const candidates = [
      candidate({ backendId: 'apify', method: 'runs_submit' }),
      candidate({ backendId: 'brightdata', method: 'scrape_async' }),
      candidate({ backendId: 'xro', method: 'tweets_search_recent' }),
    ];
    const { walk, skipped } = buildWalk(socialSpec, candidates, NO_EXCLUSIONS);
    expect(walk.map((s) => s.backendId)).toEqual(['apify', 'brightdata']);
    expect(skipped).toEqual([]);
  });

  it('an intent with no live candidates at all is an empty walk with every declared provider skipped', () => {
    const { walk, skipped } = buildWalk(webSearchSpec, [], NO_EXCLUSIONS);
    expect(walk).toEqual([]);
    expect(skipped).toEqual(['you (not in catalog)', 'exa (not in catalog)', 'brave (not in catalog)', 'firecrawl (not in catalog)', 'geonode (not in catalog)']);
  });
});

// ---------------------------------------------------------------------------
// runOneStep -- reuses retry.ts's `run()`; billing, cap/deadline reporting,
// and argRejected all come from that shared loop's own report.
// ---------------------------------------------------------------------------

describe('runOneStep', () => {
  const webSearchSpec = specFor('web-search');

  it('falls back down the ranking on a retryable failure and reports who served it, with billing preserved', async () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'exa', method: 'search' }),
      candidate({ backendId: 'brave', method: 'search' }),
      candidate({ backendId: 'firecrawl', method: 'search' }),
      candidate({ backendId: 'geonode', method: 'search' }),
    ];
    const fetchFn = routedFetch({
      you: [gatewayErrorResponse(503, 'backend_unavailable')],
      exa: [okResponse('{"results":[]}')],
    });

    const result = await runOneStep(webSearchSpec, 'weather today', {}, candidates, NO_EXCLUSIONS, { ...GATEWAY, fetchFn });

    expect(result.served).toEqual({ backendId: 'exa', displayName: 'Exa', rank: 2, success: true });
    expect(result.report.attempts.map((a) => a.backendId)).toEqual(['you', 'exa']);
    expect(result.report.attempts[0]?.billed).toBe(false);
    expect(result.report.attempts[1]?.billed).toBe(true);
    expect(result.argRejected).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('a provider whose OWN schema rejects the assembled args is skipped locally and named in argRejected, even on an otherwise successful run', async () => {
    const candidates = [
      candidate({
        backendId: 'you',
        method: 'search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, region: { type: 'string' } },
          required: ['query', 'region'],
        },
      }),
      candidate({ backendId: 'exa', method: 'search' }),
    ];
    const fetchFn = routedFetch({ exa: [okResponse('{"ok":true}')] });

    const result = await runOneStep(webSearchSpec, 'weather today', {}, candidates, NO_EXCLUSIONS, { ...GATEWAY, fetchFn });

    expect(result.argRejected).toEqual(['You.com']);
    expect(result.served).toEqual({ backendId: 'exa', displayName: 'Exa', rank: 2, success: true });
    // "you" issued no request at all -- rejected locally before any call.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // The other local rejection, and the one that must NOT be reported as the
  // caller's fault. `argRejected`'s whole promise is "this one is yours to fix
  // by editing --extra-json"; a provider whose MANIFEST requires a path param a
  // one-step command never asks for is not that, and telling a caller who
  // passed no --extra-json at all that their --extra-json did not match names a
  // knob they never turned. Both rejections share one reason string
  // (retry.ts's `classifyFailure`, deliberately), so this is separable only via
  // the typed `AttemptLog.preflight` — which is exactly what the test below
  // pins, since a regression to prose-matching would put "You.com" back into
  // argRejected and no other assertion in this file would fail.
  it('a provider whose MANIFEST needs an argument this command cannot supply is skipped, not blamed on the caller', async () => {
    const candidates = [
      candidate({
        backendId: 'you',
        method: 'search',
        // Passes its own input_schema (only `query` is required, and the walk
        // supplies it), then fails in bindArgs: nothing supplies `{id}`.
        path: '/search/{id}',
        bindings: { path_params: ['id'] },
      }),
      candidate({ backendId: 'exa', method: 'search' }),
    ];
    const fetchFn = routedFetch({ exa: [okResponse('{"ok":true}')] });

    const result = await runOneStep(webSearchSpec, 'weather today', {}, candidates, NO_EXCLUSIONS, { ...GATEWAY, fetchFn });

    // Not the caller's fault, so not in argRejected...
    expect(result.argRejected).toEqual([]);
    // ...but never silent either, and never buried in `skipped`, which the
    // renderer prints ONLY when nothing served the call -- this run succeeded,
    // and a dropped rank-1 provider must be visible on a successful run too.
    expect(result.manifestRejected).toEqual(['You.com']);
    expect(result.skipped).not.toContain('you (needs an argument this command cannot supply)');
    // The attempt is logged, classified as a binding rejection, and issued no
    // request — so `served` names exa, the only provider actually reached.
    expect(result.report.attempts[0]?.preflight).toBe('binding');
    expect(result.served).toEqual({ backendId: 'exa', displayName: 'Exa', rank: 2, success: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a schema rejection is classified as such, so the two local rejections stay distinguishable', async () => {
    const candidates = [
      candidate({
        backendId: 'you',
        method: 'search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, region: { type: 'string' } },
          required: ['query', 'region'],
        },
      }),
      candidate({ backendId: 'exa', method: 'search' }),
    ];
    const fetchFn = routedFetch({ exa: [okResponse('{"ok":true}')] });

    const result = await runOneStep(webSearchSpec, 'weather today', {}, candidates, NO_EXCLUSIONS, { ...GATEWAY, fetchFn });

    expect(result.report.attempts[0]?.preflight).toBe('schema');
    expect(result.argRejected).toEqual(['You.com']);
    // Reported as the caller's to fix and NOT also as a manifest rejection --
    // the mirror image of the binding case above.
    expect(result.manifestRejected).toEqual([]);
  });

  it('a deny-listed provider is never attempted even when present in the catalog and ranked first', async () => {
    const candidates = [candidate({ backendId: 'you', method: 'search' }), candidate({ backendId: 'exa', method: 'search' })];
    const fetchFn = routedFetch({ exa: [okResponse('{"ok":true}')] });

    const result = await runOneStep(webSearchSpec, 'weather today', {}, candidates, ['you'], { ...GATEWAY, fetchFn });

    expect(result.served?.backendId).toBe('exa');
    expect(result.report.attempts.map((a) => a.backendId)).toEqual(['exa']);
  });

  it('no provider ever reached -> `served` is absent and every declared provider is named in `skipped`', async () => {
    const fetchFn = vi.fn();
    const result = await runOneStep(webSearchSpec, 'weather today', {}, [], NO_EXCLUSIONS, {
      ...GATEWAY,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.served).toBeUndefined();
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.report.outcome).toEqual({ kind: 'give_up', reason: 'no candidates to try' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('the attempt cap and the wall-clock deadline are reported distinctly via `report.stoppedBy`', async () => {
    const candidates = [
      candidate({ backendId: 'you', method: 'search' }),
      candidate({ backendId: 'exa', method: 'search' }),
      candidate({ backendId: 'brave', method: 'search' }),
    ];

    const cappedFetch = routedFetch({
      you: [gatewayErrorResponse(500, 'backend_error')],
      exa: [gatewayErrorResponse(500, 'backend_error')],
      brave: [okResponse('{"ok":true}')],
    });
    const capped = await runOneStep(webSearchSpec, 'q', {}, candidates, NO_EXCLUSIONS, { ...GATEWAY, fetchFn: cappedFetch }, 2);
    expect(capped.report.stoppedBy).toBe('max-attempts');
    expect(capped.report.attempts).toHaveLength(2);
    expect(capped.served).toEqual({ backendId: 'exa', displayName: 'Exa', rank: 2, success: false });

    let time = 0;
    const clock = (): number => time;
    const timedFetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/v1/you/')) {
        time += 100_000; // simulate the first attempt eating the whole budget
        return gatewayErrorResponse(500, 'backend_error');
      }
      return okResponse('{"ok":true}');
    }) as unknown as typeof fetch;
    const timedOut = await runOneStep(webSearchSpec, 'q', {}, candidates, NO_EXCLUSIONS, { ...GATEWAY, fetchFn: timedFetch }, 3, {
      clock,
      ms: 5_000,
    });
    expect(timedOut.report.stoppedBy).toBe('deadline');
    expect(timedOut.report.attempts).toHaveLength(1);
    expect(timedOut.served).toEqual({ backendId: 'you', displayName: 'You.com', rank: 1, success: false });
    expect(timedFetch).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // The reported bug, end to end: an account with every provider disabled
  // except ScraperAPI and ScrapingBee could not scrape a URL at all. The
  // gateway's /v1/catalog does not filter by the caller's own per-backend
  // disable list, so `buildWalk` cannot pass those providers over -- they are
  // in the catalog, they are ranked, and they publish a `url` argument. The
  // walk therefore spent its whole 3-attempt budget on three free 403s
  // (`provider_disabled`) and gave up at rank 3, with ScraperAPI unasked at
  // rank 6 and nothing billed and nothing scraped.
  // -------------------------------------------------------------------------
  it('reaches the one enabled provider when every higher-ranked one is disabled for the account', async () => {
    const scrapeSpec = specFor('scrape');
    const urlSchema = { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] };
    // The real `scrape` ranking, in declared order, each with its declared
    // entry method -- the catalog the gateway serves a user who has disabled
    // the first five.
    const candidates = [
      candidate({ backendId: 'scrapingdog', method: 'scrape', inputSchema: urlSchema }),
      candidate({ backendId: 'brightdata', method: 'unlock', inputSchema: urlSchema }),
      candidate({ backendId: 'firecrawl', method: 'scrape', inputSchema: urlSchema }),
      candidate({ backendId: 'geonode', method: 'scrape', inputSchema: urlSchema }),
      candidate({ backendId: 'apify', method: 'runs_submit', inputSchema: urlSchema }),
      candidate({ backendId: 'scraperapi', method: 'scrape', inputSchema: urlSchema }),
      candidate({ backendId: 'scrapingbee', method: 'scrape', inputSchema: urlSchema }),
    ];
    // A fresh Response per backend: a body can only be read once, so a shared
    // one would surface as a "Body has already been read" transport failure
    // from the second candidate on -- a fixture artifact that would quietly
    // test something else entirely.
    const disabled = (): Response => gatewayErrorResponse(403, 'provider_disabled', 'provider disabled for this account');
    const fetchFn = routedFetch({
      scrapingdog: [disabled()],
      brightdata: [disabled()],
      firecrawl: [disabled()],
      geonode: [disabled()],
      apify: [disabled()],
      scraperapi: [okResponse('<html>the page</html>')],
    });

    const result = await runOneStep(
      scrapeSpec,
      'https://sherpa.ai/blog/training-together-diagnosing-better-federated-learning',
      {},
      candidates,
      NO_EXCLUSIONS,
      { ...GATEWAY, fetchFn },
    );

    expect(result.report.outcome.kind).toBe('success');
    expect(result.served).toEqual({ backendId: 'scraperapi', displayName: 'ScraperAPI', rank: 6, success: true });
    expect(result.report.stoppedBy).toBeUndefined();
    expect(result.report.unbilledRejections).toBe(5);
    // Exactly one paid call: the one that actually returned the page.
    expect(result.report.attempts.filter((a) => a.billed).map((a) => a.backendId)).toEqual(['scraperapi']);
    // ScrapingBee is never reached, and that is correct -- the walk stops at
    // the first provider that answers, it does not sweep the rest.
    expect(result.report.attempts.map((a) => a.backendId)).toEqual([
      'scrapingdog',
      'brightdata',
      'firecrawl',
      'geonode',
      'apify',
      'scraperapi',
    ]);
  });

  it('a direct success on the first try still carries the full billing report', async () => {
    const candidates = [candidate({ backendId: 'you', method: 'search' })];
    const fetchFn = routedFetch({ you: [okResponse('{"ok":true}')] });

    const result = await runOneStep(webSearchSpec, 'weather today', {}, candidates, NO_EXCLUSIONS, { ...GATEWAY, fetchFn });

    expect(result.served).toEqual({ backendId: 'you', displayName: 'You.com', rank: 1, success: true });
    expect(result.report.attempts.every((a) => a.billed === (a.status === 'success'))).toBe(true);
  });
});
