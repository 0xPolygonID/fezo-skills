import { describe, expect, it, vi } from 'vitest';

import type { ToolCandidate } from '../src/engine/catalog.js';
import type { RoutingPlan } from '../src/engine/plan.js';
import { runResearch } from '../src/engine/research.js';

function candidate(backendId: string, method: string): ToolCandidate {
  return {
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
}

/**
 * Catalog covering the declared `search` entry methods used by the fan-out,
 * plus the one `news` entry method: a multi-intent plan must be able to reach
 * a news provider, and it cannot be observed doing so if the catalog offers
 * none.
 */
const CANDIDATES: ToolCandidate[] = [
  candidate('you', 'search'),
  candidate('exa', 'search'),
  candidate('brave', 'search'),
  candidate('firecrawl', 'search'),
  candidate('geonode', 'search'),
  candidate('newsapi', 'articles'),
];

/** A provider body. A bare string is a URL that is also its own title; a pair
 * gives the two separately, which is what the cross-host title collapse keys
 * on. */
function results(rows: Array<string | [string, string]>): Response {
  const items = rows.map((row) => (typeof row === 'string' ? { url: row, title: row } : { url: row[0], title: row[1] }));
  return new Response(JSON.stringify({ results: items }), { status: 200 });
}

function routedFetch(handlers: Record<string, Response[]>): typeof fetch {
  const queues = new Map(Object.entries(handlers).map(([id, responses]) => [id, [...responses]]));
  return vi.fn(async (url: string | URL) => {
    const asString = String(url);
    for (const [backendId, queue] of queues) {
      if (asString.includes(`/v1/${backendId}/`)) {
        const next = queue.shift();
        if (next === undefined) throw new Error(`no queued response for ${backendId}`);
        return next;
      }
    }
    throw new Error(`unrouted request: ${asString}`);
  }) as unknown as typeof fetch;
}

function plan(overrides: Partial<RoutingPlan> = {}): RoutingPlan {
  return {
    intents: ['search'], queries: ['coffee'], targets: [], depth: 'standard',
    fanout: 3, signals: [], source: 'heuristic', ...overrides,
  };
}

const gateway = { baseUrl: 'https://gw.example', apiKey: 'k' };

describe('runResearch', () => {
  it('calls every provider in the fan-out width', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results(['https://b.example'])],
      brave: [results(['https://c.example'])],
    });
    const outcome = await runResearch({ plan: plan(), candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn } });
    expect(outcome.coverage.served.sort()).toEqual(['brave', 'exa', 'you']);
    expect(outcome.items).toHaveLength(3);
  });

  it('merges the same URL from two providers into one item', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://same.example'])],
      exa: [results(['https://same.example'])],
      brave: [results(['https://other.example'])],
    });
    const outcome = await runResearch({ plan: plan(), candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn } });
    expect(outcome.items[0]?.providers).toHaveLength(2);
  });

  it('succeeds when one lane fails and another serves', async () => {
    const fetchFn = routedFetch({
      you: [new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), { status: 429 })],
      exa: [results(['https://b.example'])],
      brave: [results(['https://c.example'])],
    });
    const outcome = await runResearch({ plan: plan(), candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn } });
    expect(outcome.ok).toBe(true);
    expect(outcome.coverage.failed.map((f) => f.backendId)).toContain('you');
  });

  it('fails when every lane fails', async () => {
    const fail = () => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'no' } }), { status: 429 });
    const fetchFn = routedFetch({ you: [fail()], exa: [fail()], brave: [fail()] });
    const outcome = await runResearch({ plan: plan(), candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn } });
    expect(outcome.ok).toBe(false);
  });

  it('stops starting lanes once an account-scoped abort is seen', async () => {
    const limit = () => new Response(JSON.stringify({ error: { code: 'limit_exceeded', message: 'cap' } }), { status: 402 });
    const fetchFn = routedFetch({ you: [limit()], exa: [limit()], brave: [limit()], firecrawl: [limit()], geonode: [limit()] });
    const outcome = await runResearch({
      plan: plan({ fanout: 5 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn }, concurrency: 1,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.aborted).toMatch(/limit_exceeded/);
    expect(outcome.billing.attempts.length).toBeLessThan(5);
  });

  it('reports dropped queries rather than silently truncating', async () => {
    const fetchFn = routedFetch({ you: [results(['https://a.example'])] });
    const outcome = await runResearch({
      plan: plan({ queries: ['one', 'two'], fanout: 1 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn }, maxCalls: 1,
    });
    expect(outcome.coverage.droppedQueries).toEqual(['two']);
  });

  it('suppresses URLs a session has already seen', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://old.example', 'https://new.example'])],
      exa: [results([])],
      brave: [results([])],
    });
    const outcome = await runResearch({
      plan: plan(), candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
      seenUrls: new Set(['https://old.example']),
    });
    expect(outcome.items.map((i) => i.url)).toEqual(['https://new.example']);
    expect(outcome.coverage.suppressed).toBe(1);
  });

  // `mergeItems` makes the FIRST-SEEN item the representative of a merge, so
  // the lane array's order decides which of two cross-host twins appears in the
  // output document. A bounded pool completes lanes in whatever order the
  // network answers, so the executor must slot lanes by diversity rank, not
  // append them on completion -- otherwise this round's document is a race.
  // Delaying the first lane is the whole test: with appending, `you`'s URL wins
  // when it answers first and `exa`'s wins when it answers second.
  //
  // The two lanes must share a TITLE on different hosts, or the collapse this
  // guards never fires: with title === url the items never merge and the final
  // score-then-URL sort pins 'https://exa.example/s' first whatever the lane
  // order was. And the expectation has to be absolute, not `run(20) === run(0)`
  // -- two rounds that both returned nothing satisfy that happily.
  it('orders lanes by plan position, not by which provider answered first', async () => {
    const slow = async (body: Response, ms: number): Promise<Response> =>
      new Promise((resolve) => setTimeout(() => resolve(body), ms));
    const run = async (delayYou: number): Promise<string[]> => {
      const fetchFn = vi.fn(async (url: string | URL) => {
        const asString = String(url);
        if (asString.includes('/v1/you/')) return slow(results([['https://you.example/s', 'One Wire Story']]), delayYou);
        if (asString.includes('/v1/exa/')) return results([['https://exa.example/s', 'One Wire Story']]);
        return results([]);
      }) as unknown as typeof fetch;
      const outcome = await runResearch({
        plan: plan({ fanout: 2 }), candidates: CANDIDATES, excluded: [],
        gateway: { ...gateway, fetchFn },
      });
      return outcome.items.map((i) => i.url);
    };
    expect(await run(20)).toEqual(['https://you.example/s']);
    expect(await run(0)).toEqual(['https://you.example/s']);
  });

  // The one-entry-per-backend invariant on `ProviderHit` (aggregate.ts) has to
  // survive the cross-query union: one backend answering two sub-queries with
  // the same document is one provider, not two agreeing.
  it('counts a backend once when it returns the same document for two queries', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://same.example/a']), results(['https://same.example/a'])],
      exa: [results([]), results([])],
      brave: [results([]), results([])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['one', 'two'] }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn },
    });
    const item = outcome.items.find((i) => i.url === 'https://same.example/a');
    expect(item?.providers.filter((p) => p.backendId === 'you')).toHaveLength(1);
  });

  // The cross-query merge runs the same cross-host title collapse the per-query
  // one does, so a wire story that two sub-queries found at two outlets folds
  // into one representative. Nothing may be thrown away in the fold: the
  // executor emits the REPRESENTATIVE enriched with every contributor's
  // attribution, never a per-query item keyed on the representative's URL --
  // which deleted the loser's URL, its duplicates and its billed provider hit,
  // contradicting both `ResearchItem.duplicates` and the spec's "nothing is
  // lost, only grouped".
  it('keeps the twin a cross-query title collapse folded away', async () => {
    const fetchFn = routedFetch({
      you: [results([['https://a.example/x', 'Big News Today']]), results([])],
      exa: [results([]), results([['https://b.example/y', 'Big News Today']])],
      brave: [results([]), results([])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['one', 'two'] }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn },
    });
    expect(outcome.items.map((i) => i.url)).toEqual(['https://a.example/x']);
    expect(outcome.items[0]?.duplicates).toContain('https://b.example/y');
    expect(outcome.items[0]?.providers.map((p) => p.backendId).sort()).toEqual(['exa', 'you']);
  });

  // Coverage is computed from the PER-QUERY merges, and the cross-query
  // attribution union runs over the same items. If the union mutates them, a
  // document found by one provider under query one and by another under query
  // two makes query one report an agreement that never happened inside it --
  // which suppresses its "no cross-provider agreement" gap and the follow-up
  // command that goes with it. Each query here was served by exactly one
  // provider, so both must report a median of 1.
  it('does not let the cross-query union inflate a query\'s agreement', async () => {
    const three = ['https://u1.example', 'https://u2.example', 'https://u3.example'];
    const fetchFn = routedFetch({
      you: [results(three), results([])],
      exa: [results([]), results(three)],
      brave: [results([]), results([])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['one', 'two'] }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn },
    });
    expect(outcome.coverage.queries).toEqual([
      { query: 'one', uniqueUrls: 3, agreementMedian: 1 },
      { query: 'two', uniqueUrls: 3, agreementMedian: 1 },
    ]);
    expect(outcome.coverage.gaps).toContain('"one" has no cross-provider agreement');
    expect(outcome.nextActions.map((a) => a.why)).toEqual([
      '"one" has no cross-provider agreement',
      '"two" has no cross-provider agreement',
    ]);
    // The union itself still has to happen: one document, two providers.
    expect(outcome.items[0]?.providers.map((p) => p.backendId).sort()).toEqual(['exa', 'you']);
  });

  // `suppressed` is a count of DOCUMENTS the round withheld, which is what
  // `mergeItems` is careful to report -- and summing its per-query figures
  // would multiply that by the number of sub-queries that happened to return
  // the page, exactly the multiplication `mergeItems` refuses on the lane axis.
  it('counts a suppressed page once however many queries returned it', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://old.example']), results(['https://old.example'])],
      exa: [results([]), results([])],
      brave: [results([]), results([])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['one', 'two'] }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn }, seenUrls: new Set(['https://old.example']),
    });
    expect(outcome.coverage.suppressed).toBe(1);
  });

  // `fanout` is a per-query total ACROSS intents, so multi-intent changes which
  // providers a query reaches, never how many. Ordering each intent separately
  // and concatenating cannot do that: the `search` list alone is already five
  // deep, so `newsapi` -- the only distinct news index, and the reason the plan
  // declared `news` -- never survived the truncation, and the fifth call went
  // to `geonode`, a second scrape of the `google-serp` index `firecrawl` had
  // already queried.
  it('spends a multi-intent fan-out on the combined provider list', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results(['https://b.example'])],
      brave: [results(['https://c.example'])],
      firecrawl: [results(['https://d.example'])],
      newsapi: [results(['https://e.example'])],
    });
    const outcome = await runResearch({
      plan: plan({ intents: ['search', 'news'], fanout: 5 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn },
    });
    expect(outcome.coverage.served.sort()).toEqual(['brave', 'exa', 'firecrawl', 'newsapi', 'you']);
    expect(outcome.billing.callsBilled).toBe(5);
  });

  // Two runs against byte-identical responses must emit an identical document,
  // and that includes the round's report of itself: the attempt log is what
  // Task 11 renders, and a bounded pool finishes lanes in completion order.
  it('logs attempts in plan order, not in completion order', async () => {
    const slow = async (body: Response, ms: number): Promise<Response> =>
      new Promise((resolve) => setTimeout(() => resolve(body), ms));
    const run = async (delayYou: number): Promise<string[]> => {
      const fetchFn = vi.fn(async (url: string | URL) => {
        const asString = String(url);
        if (asString.includes('/v1/you/')) return slow(results(['https://a.example']), delayYou);
        return results([]);
      }) as unknown as typeof fetch;
      const outcome = await runResearch({
        plan: plan({ fanout: 3 }), candidates: CANDIDATES, excluded: [],
        gateway: { ...gateway, fetchFn },
      });
      return outcome.billing.attempts.map((a) => a.tool);
    };
    expect(await run(20)).toEqual(['you_search', 'exa_search', 'brave_search']);
    expect(await run(0)).toEqual(['you_search', 'exa_search', 'brave_search']);
  });
});

const SCRAPE_CANDIDATES: ToolCandidate[] = [
  ...CANDIDATES,
  { ...candidate('scrapingdog', 'scrape'), inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { ...candidate('firecrawl', 'scrape'), inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];

describe('runResearch: targets', () => {
  it('fetches every planned target', async () => {
    const fetchFn = routedFetch({ scrapingdog: [new Response('{"content":"page body"}', { status: 200 })] });
    const outcome = await runResearch({
      plan: plan({ intents: ['scrape'], queries: [], targets: ['https://t.example'] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.documents).toHaveLength(1);
    expect(outcome.documents[0]?.url).toBe('https://t.example');
    expect(outcome.ok).toBe(true);
  });

  it('fetches a target once, not once per provider', async () => {
    const fetchFn = routedFetch({ scrapingdog: [new Response('{"content":"body"}', { status: 200 })] });
    const outcome = await runResearch({
      plan: plan({ intents: ['scrape'], queries: [], targets: ['https://t.example'], fanout: 5 }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.billing.attempts.filter((a) => a.billed)).toHaveLength(1);
  });

  it('reports a failed target as a gap rather than failing the round', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results([])],
      brave: [results([])],
      scrapingdog: [new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'no' } }), { status: 429 })],
      firecrawl: [new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'no' } }), { status: 429 })],
    });
    const outcome = await runResearch({
      plan: plan({ intents: ['search', 'scrape'], queries: ['coffee'], targets: ['https://t.example'] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.documents).toHaveLength(0);
    expect(outcome.coverage.gaps.join(' ')).toMatch(/t\.example/);
    expect(outcome.coverage.gaps.join(' ')).toMatch(/rate_limited/);
    // The gap explains; the follow-up command has to RUN. A `cmd` carrying
    // `'https://t.example (rate_limited)'` would destroy the one-step `scrape`
    // fallback that a failed target is deliberately delegated to.
    expect(outcome.nextActions.map((a) => a.cmd)).toContain(`fezoctl scrape 'https://t.example'`);
    expect(outcome.nextActions.find((a) => a.cmd.startsWith('fezoctl scrape'))?.why).toBe('not fetched (rate_limited)');
  });

  it('reports a target no catalog provider can fetch, without billing anything', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results([])],
      brave: [results([])],
    });
    const outcome = await runResearch({
      // CANDIDATES holds no `scrape` entry method at all, so `scrapeLane`
      // resolves nothing and the target never becomes a call.
      plan: plan({ intents: ['search', 'scrape'], queries: ['coffee'], targets: ['https://t.example'] }),
      candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.coverage.gaps.join(' ')).toMatch(/no scrape provider available/);
    expect(outcome.nextActions.map((a) => a.cmd)).toContain(`fezoctl scrape 'https://t.example'`);
    expect(outcome.billing.attempts.filter((a) => a.tool.includes('scrape'))).toHaveLength(0);
  });

  it('names the scrape backend that served in coverage', async () => {
    const fetchFn = routedFetch({ scrapingdog: [new Response('{"content":"page body"}', { status: 200 })] });
    const outcome = await runResearch({
      plan: plan({ intents: ['scrape'], queries: [], targets: ['https://t.example'] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    // A pure-target round has no query lane to put in `served`, and a round
    // that reports nothing served while holding a document reads as a failure.
    expect(outcome.coverage.served).toContain('scrapingdog');
    expect(outcome.documents[0]?.content).toBe('{"content":"page body"}');
  });

  // The reason `TargetReport` is slotted by target index rather than pushed:
  // the pool finishes lanes in whatever order the network answers, and neither
  // the documents nor the attempt log may inherit that order.
  it('reports documents and attempts in plan order, not completion order', async () => {
    const run = async (delayFirst: number): Promise<{ urls: string[]; tools: string[] }> => {
      const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const first = String(init?.body ?? '').includes('https://t1.example');
        const body = new Response(`{"content":"${first ? 'one' : 'two'}"}`, { status: 200 });
        // Only the FIRST target is delayed, so at delay 20 the second target's
        // response lands first and at delay 0 it does not.
        return first ? new Promise<Response>((resolve) => setTimeout(() => resolve(body), delayFirst)) : body;
      }) as unknown as typeof fetch;
      const outcome = await runResearch({
        plan: plan({ intents: ['scrape'], queries: [], targets: ['https://t1.example', 'https://t2.example'] }),
        candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
      });
      return { urls: outcome.documents.map((d) => d.url), tools: outcome.billing.attempts.map((a) => a.tool) };
    };
    expect(await run(20)).toEqual({
      urls: ['https://t1.example', 'https://t2.example'],
      tools: ['scrapingdog_scrape', 'scrapingdog_scrape'],
    });
    expect(await run(0)).toEqual({
      urls: ['https://t1.example', 'https://t2.example'],
      tools: ['scrapingdog_scrape', 'scrapingdog_scrape'],
    });
  });

  // Two identical targets are two entries, and a value-membership split of the
  // budget drops the in-budget occurrence along with the out-of-budget one.
  it('spends the budget on a duplicated target by position, not by value', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results([])],
      brave: [results([])],
      scrapingdog: [new Response('{"content":"one"}', { status: 200 }), new Response('{"content":"two"}', { status: 200 })],
    });
    const outcome = await runResearch({
      // Three query lanes leave 2 of the 5 calls for targets, so the first two
      // of the three targets are fetched -- including the duplicate at index 0.
      plan: plan({
        intents: ['search', 'scrape'], queries: ['coffee'],
        targets: ['https://t1.example', 'https://t2.example', 'https://t1.example'],
      }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn }, maxCalls: 5,
    });
    expect(outcome.documents.map((d) => d.url)).toEqual(['https://t1.example', 'https://t2.example']);
    expect(outcome.coverage.unfetchedTargets).toEqual([{ url: 'https://t1.example' }]);
  });

  it('runs searches and target fetches in the same round', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results(['https://b.example'])],
      brave: [results(['https://c.example'])],
      scrapingdog: [new Response('{"content":"body"}', { status: 200 })],
    });
    const outcome = await runResearch({
      plan: plan({ intents: ['search', 'scrape'], queries: ['coffee'], targets: ['https://t.example'] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.items.length).toBeGreaterThan(0);
    expect(outcome.documents).toHaveLength(1);
  });
});
