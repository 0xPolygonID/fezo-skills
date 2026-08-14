import { describe, expect, it, vi } from 'vitest';

import type { ToolCandidate } from '../src/engine/catalog.js';
import type { RoutingPlan } from '../src/engine/plan.js';
import { MAX_RESEARCH_CALLS } from '../src/engine/plan.js';
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
    expect(outcome.coverage.droppedQueries).toEqual([{ query: 'two' }]);
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
    expect(outcome.nextActions.find((a) => a.cmd?.startsWith('fezoctl scrape') === true)?.why).toBe('not fetched (rate_limited)');
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
      // Targets are reserved before queries take what is left (`clampPlan`'s
      // stated order, which the executor now matches), so a 2-call budget buys
      // the first two of the three targets -- including the duplicate at index
      // 0 -- and leaves nothing for the query. The third target is the one
      // dropped, BY POSITION: dropping by value would lose both copies of t1,
      // one of which the round had already reserved a call for.
      plan: plan({
        intents: ['search', 'scrape'], queries: ['coffee'],
        targets: ['https://t1.example', 'https://t2.example', 'https://t1.example'],
      }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn }, maxCalls: 2,
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

// ---------------------------------------------------------------------------
// Reporting honesty on the abort and budget paths (final review MAJ-1, MAJ-3).
//
// The abort MECHANISM was already correct -- no new lane starts, in-flight
// lanes are awaited rather than discarded. What these pin is the REPORT: an
// aborted round must not describe work it never started as work that came back
// empty, and it must not hand the caller commands that would spend again into
// an account that just ran out of money.
// ---------------------------------------------------------------------------

describe('runResearch: an aborted round reports what it never started', () => {
  const limit = () =>
    new Response(JSON.stringify({ error: { code: 'insufficient_balance', message: 'out of credit' } }), { status: 402 });

  it('reports unstarted queries as not run, never as "returned no results"', async () => {
    const fetchFn = routedFetch({ you: [limit()] });
    const outcome = await runResearch({
      plan: plan({ queries: ['alpha', 'beta', 'gamma'], fanout: 1 }),
      candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn }, concurrency: 1,
    });
    expect(outcome.aborted).toMatch(/insufficient_balance/);
    // All three carry the abort reason, on ZERO SERVED rather than zero
    // started: 'beta' and 'gamma' never had a lane sent, and 'alpha''s single
    // lane came back 402 without answering. None of the three produced any
    // evidence about the web, so none may be described as having returned
    // nothing -- that is the same false claim in a thinner disguise.
    expect(outcome.coverage.droppedQueries.map((d) => d.query)).toEqual(['alpha', 'beta', 'gamma']);
    for (const dropped of outcome.coverage.droppedQueries) {
      expect(dropped.reason).toMatch(/abort/i);
    }
    expect(outcome.coverage.gaps.join(' ')).not.toMatch(/returned no results/);
  });

  it('reports an unstarted target instead of dropping it from the report', async () => {
    const fetchFn = routedFetch({ you: [limit()] });
    const outcome = await runResearch({
      plan: plan({ queries: ['alpha'], targets: ['https://t1.example'], fanout: 1 }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn }, concurrency: 1,
    });
    expect(outcome.documents).toHaveLength(0);
    expect(outcome.coverage.unfetchedTargets.map((t) => t.url)).toContain('https://t1.example');
  });

  it('emits no spend-again next actions once the account is the problem', async () => {
    const fetchFn = routedFetch({ you: [limit()] });
    const outcome = await runResearch({
      plan: plan({ queries: ['alpha', 'beta'], targets: ['https://t1.example'], fanout: 1 }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn }, concurrency: 1,
    });
    for (const action of outcome.nextActions) {
      // No command at all is the honest answer here; if one is ever added it
      // must still not be a billing one.
      if (action.cmd !== undefined) {
        expect(action.cmd).not.toMatch(/fezoctl research/);
        expect(action.cmd).not.toMatch(/fezoctl scrape/);
      }
    }
    // Still actionable -- the round must say what to do, just not "spend more".
    expect(outcome.nextActions.length).toBeGreaterThan(0);
  });
});

describe('runResearch: --max-calls narrows a round instead of cancelling it', () => {
  it('runs a reduced width when the budget is below the requested fan-out', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results(['https://b.example'])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['alpha'], fanout: 5 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn }, maxCalls: 2,
    });
    expect(outcome.billing.callsBilled).toBe(2);
    expect(outcome.ok).toBe(true);
    expect(outcome.coverage.droppedQueries).toEqual([]);
  });

  it('reports the narrowing rather than passing a thinner round off as a full one', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results(['https://b.example'])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['alpha'], fanout: 5 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn }, maxCalls: 2,
    });
    expect(outcome.coverage.narrowedQueries).toEqual([{ query: 'alpha', requested: 5, actual: 2 }]);
    expect(outcome.coverage.gaps.join(' ')).toMatch(/narrowed/i);
  });

  it('drops a query only when the budget leaves it no lane at all', async () => {
    const fetchFn = routedFetch({ you: [results(['https://a.example'])] });
    const outcome = await runResearch({
      plan: plan({ queries: ['one', 'two'], fanout: 1 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn }, maxCalls: 1,
    });
    expect(outcome.coverage.droppedQueries.map((d) => d.query)).toEqual(['two']);
  });

  it('treats a non-finite call budget as no budget at all, never as unlimited', async () => {
    // Not reachable through the CLI (cli.ts requires an integer >= 1), but this
    // module's header calls itself the absolute bound, and `Math.min(NaN, 24)`
    // is NaN -- against which every `lanes.length > budget` test is false, so a
    // NaN budget would wave through every lane of every query.
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results(['https://b.example'])],
      brave: [results(['https://c.example'])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: Array.from({ length: 12 }, (_u, i) => `q${String(i)}`), fanout: 3 }),
      candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn }, maxCalls: Number.NaN,
    });
    // 12 queries x 3 = 36 lanes requested; the absolute bound is 24. A NaN that
    // reached the comparisons unguarded would let all 36 through.
    expect(outcome.billing.attempts.length).toBeLessThanOrEqual(MAX_RESEARCH_CALLS);
    expect(outcome.coverage.droppedQueries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Budget-ordering and abort-reporting corners found verifying the first repair.
// ---------------------------------------------------------------------------

describe('runResearch: budget ordering and fractional budgets', () => {
  it('fetches an explicitly named target before widening a query', async () => {
    // An explicit target is an instruction; a fan-out width is a preference.
    // `clampPlan` states this order and the executor has to agree with it.
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results(['https://b.example'])],
      brave: [results(['https://c.example'])],
      scrapingdog: [new Response('{"content":"body"}', { status: 200 })],
    });
    const outcome = await runResearch({
      // Both intents declared, as the planner emits whenever a prompt carries a
      // URL. A search-only intent list would now refuse the target outright,
      // which is a different behaviour tested below.
      plan: plan({ intents: ['search', 'scrape'], queries: ['alpha'], targets: ['https://t.example'], fanout: 5 }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn }, maxCalls: 4,
    });
    expect(outcome.documents.map((d) => d.url)).toEqual(['https://t.example']);
    expect(outcome.coverage.unfetchedTargets).toEqual([]);
    expect(outcome.billing.callsBilled).toBe(4);
  });

  it('truncates a fractional budget instead of planning zero-lane queries', async () => {
    // 3.7 left `budget` never reaching 0 and `slice(0, 0.7)` keeping nothing,
    // so later queries were planned with no lanes and reported as "returned no
    // results" -- the false claim about the web this repair set removed.
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results(['https://b.example'])],
      brave: [results(['https://c.example'])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['alpha', 'beta', 'gamma'], fanout: 5 }), candidates: CANDIDATES,
      excluded: [], gateway: { ...gateway, fetchFn }, maxCalls: 3.7,
    });
    expect(outcome.billing.attempts.length).toBe(3);
    expect(outcome.coverage.gaps.join(' ')).not.toMatch(/"beta" returned no results/);
    expect(outcome.coverage.droppedQueries.map((d) => d.query)).toEqual(['beta', 'gamma']);
    for (const narrowed of outcome.coverage.narrowedQueries) {
      expect(Number.isInteger(narrowed.actual)).toBe(true);
    }
  });

  it('does not report an unstarted query as narrowed as well as not run', async () => {
    const limit = () =>
      new Response(JSON.stringify({ error: { code: 'limit_exceeded', message: 'cap' } }), { status: 402 });
    const fetchFn = routedFetch({ you: [limit()] });
    const outcome = await runResearch({
      plan: plan({ queries: ['alpha', 'beta'], fanout: 3 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn }, maxCalls: 5, concurrency: 1,
    });
    expect(outcome.coverage.droppedQueries.map((d) => d.query)).toContain('beta');
    expect(outcome.coverage.narrowedQueries.map((n) => n.query)).not.toContain('beta');
  });
});

describe('runResearch: reporting a query nothing could serve', () => {
  it('names the ranked providers this catalog cannot reach', async () => {
    const fetchFn = routedFetch({ you: [results(['https://a.example'])] });
    const outcome = await runResearch({
      plan: plan({ queries: ['coffee'], fanout: 4 }),
      candidates: [candidate('you', 'search')], excluded: [], gateway: { ...gateway, fetchFn },
    });
    // One provider served; the other three budgeted lanes were unreachable and
    // must be said so, or the thin gap reads as "the web is sparse".
    expect(outcome.coverage.skipped.length).toBeGreaterThan(0);
    for (const entry of outcome.coverage.skipped) expect(entry).toMatch(/not in catalog/);
  });

  it('reports a query with no reachable provider as not run, not as empty', async () => {
    const fetchFn = routedFetch({});
    const outcome = await runResearch({
      plan: plan({ queries: ['coffee'] }), candidates: [], excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.coverage.droppedQueries).toEqual([
      { query: 'coffee', reason: 'no provider in the catalog can serve it' },
    ]);
    expect(outcome.coverage.gaps.join(' ')).not.toMatch(/returned no results/);
    expect(outcome.billing.attempts).toHaveLength(0);
  });

  it('does not fan out searches when the caller declared only scrape', async () => {
    const fetchFn = routedFetch({});
    const outcome = await runResearch({
      plan: plan({ intents: ['scrape'], queries: ['coffee'], targets: [] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.billing.attempts).toHaveLength(0);
    expect(outcome.coverage.droppedQueries[0]?.reason).toMatch(/no search-shaped intent/);
  });
});

describe('runResearch: the call budget holds across every shape', () => {
  // The three places that must agree — clampPlan's formula, the executor's
  // budget loop, and the target reservation — have no test pinning them
  // together. This is that test: whatever the shape, the round may never issue
  // more calls than the budget it was given.
  const shapes: Array<{ queries: number; targets: number; fanout: number; maxCalls?: number }> = [
    { queries: 1, targets: 0, fanout: 1 },
    { queries: 3, targets: 0, fanout: 5 },
    { queries: 1, targets: 3, fanout: 5, maxCalls: 4 },
    { queries: 5, targets: 5, fanout: 4 },
    { queries: 12, targets: 0, fanout: 3 },
    { queries: 0, targets: 10, fanout: 8 },
    { queries: 2, targets: 2, fanout: 10, maxCalls: 6 },
    { queries: 8, targets: 8, fanout: 8, maxCalls: 1 },
  ];

  it.each(shapes)('never exceeds min(maxCalls, MAX_RESEARCH_CALLS) for %o', async (shape) => {
    let calls = 0;
    const fetchFn = (async (url: string | URL) => {
      calls += 1;
      return String(url).includes('/scrape')
        ? new Response('{"content":"body"}', { status: 200 })
        : results([`https://r${String(calls)}.example`]);
    }) as unknown as typeof fetch;
    const outcome = await runResearch({
      plan: plan({
        intents: ['search', 'scrape'],
        queries: Array.from({ length: shape.queries }, (_u, i) => `q${String(i)}`),
        targets: Array.from({ length: shape.targets }, (_u, i) => `https://t${String(i)}.example`),
        fanout: shape.fanout,
      }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
      ...(shape.maxCalls !== undefined ? { maxCalls: shape.maxCalls } : {}),
    });
    const ceiling = Math.min(shape.maxCalls ?? MAX_RESEARCH_CALLS, MAX_RESEARCH_CALLS);
    expect(calls).toBeLessThanOrEqual(ceiling);
    expect(outcome.billing.attempts.length).toBeLessThanOrEqual(ceiling);
  });
});

describe('runResearch: an aborted round keeps an honest gap for a query that DID answer', () => {
  it('reports a served-but-thin query as thin, not as not-run', async () => {
    const limit = () =>
      new Response(JSON.stringify({ error: { code: 'limit_exceeded', message: 'cap' } }), { status: 402 });
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [limit()],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['alpha', 'beta'], fanout: 2 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn }, concurrency: 1,
    });
    // `alpha` had a lane that actually answered, so it keeps its real coverage
    // gap; only `beta`, which never ran, is reported as not-run.
    expect(outcome.coverage.droppedQueries.map((d) => d.query)).toEqual(['beta']);
    expect(outcome.coverage.queries.map((q) => q.query)).toContain('alpha');
  });
});

describe('runResearch: skipped names the real reason', () => {
  it('distinguishes a provider that is absent from one that takes no query', async () => {
    // `firecrawl` is inside a fanout-4 diversity order for `search`, so it is
    // actually considered; `geonode` is not, and would be skipped for a
    // different reason entirely.
    const urlOnly = {
      ...candidate('firecrawl', 'search'),
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    };
    const fetchFn = routedFetch({ you: [results(['https://a.example'])] });
    const outcome = await runResearch({
      plan: plan({ queries: ['coffee'], fanout: 4 }),
      candidates: [candidate('you', 'search'), urlOnly], excluded: [], gateway: { ...gateway, fetchFn },
    });
    const skipped = outcome.coverage.skipped.join(' | ');
    expect(skipped).toMatch(/firecrawl \(no query argument\)/);
    expect(skipped).not.toMatch(/firecrawl \(not in catalog\)/);
  });
});

describe('runResearch: declared intents are honoured in both directions', () => {
  it('does not fetch a target when the caller declared only search', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results([])],
      brave: [results([])],
    });
    const outcome = await runResearch({
      plan: plan({ intents: ['search'], queries: ['alpha'], targets: ['https://t.example'] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.documents).toHaveLength(0);
    expect(outcome.coverage.unfetchedTargets[0]?.reason).toMatch(/search-only/);
    // The searches still ran: refusing one half of a plan must not cancel the other.
    expect(outcome.coverage.served).toContain('you');
  });

  it('still fetches when the planner declared both, which is the ordinary path', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results([])],
      brave: [results([])],
      scrapingdog: [new Response('{"content":"body"}', { status: 200 })],
    });
    const outcome = await runResearch({
      plan: plan({ intents: ['scrape', 'search'], queries: ['alpha'], targets: ['https://t.example'] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.documents).toHaveLength(1);
  });
});

describe('runResearch: a long shared title prefix does not merge distinct documents', () => {
  // The regression MAJOR 1 of the Task-14 review found: capping the title at
  // the end of `mergeItems` looked correct in a unit test and still failed
  // here, because this function merges per query and then merges THOSE merges
  // -- so the first call's capped titles became the second call's dedup key.
  // Asserted at the executor level for exactly that reason: a `mergeItems`
  // test cannot see a defect that only exists in the composition.
  const boiler = 'Cookie notice. We and our partners use cookies to store and access information on a device. '.repeat(4);

  it('keeps both documents, with one provider each', async () => {
    const fetchFn = routedFetch({
      you: [new Response(JSON.stringify({ results: [{ url: 'https://site-a.example/story', title: `${boiler}Story A headline` }] }), { status: 200 })],
      exa: [new Response(JSON.stringify({ results: [{ url: 'https://site-b.example/other', title: `${boiler}Completely different article` }] }), { status: 200 })],
      brave: [results([])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['storage'], fanout: 3 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn },
    });
    expect(outcome.items).toHaveLength(2);
    for (const item of outcome.items) expect(item.providers).toHaveLength(1);
  });

  it('does not contradict itself between coverage and items', async () => {
    const fetchFn = routedFetch({
      you: [new Response(JSON.stringify({ results: [{ url: 'https://site-a.example/story', title: `${boiler}Story A headline` }] }), { status: 200 })],
      exa: [new Response(JSON.stringify({ results: [{ url: 'https://site-b.example/other', title: `${boiler}Completely different article` }] }), { status: 200 })],
      brave: [results([])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['storage'], fanout: 3 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn },
    });
    // `uniqueUrls` is computed from the per-query merge and `items` from the
    // cross-query merge. When the two disagree a reader cannot tell which half
    // to believe, which is worse than either being wrong alone.
    expect(outcome.coverage.queries[0]?.uniqueUrls).toBe(outcome.items.length);
  });

  it('still collapses a genuine cross-host twin through the executor', async () => {
    const same = `${boiler}Identical headline`;
    const fetchFn = routedFetch({
      you: [new Response(JSON.stringify({ results: [{ url: 'https://outlet-a.example/s', title: same }] }), { status: 200 })],
      exa: [new Response(JSON.stringify({ results: [{ url: 'https://outlet-b.example/s', title: same }] }), { status: 200 })],
      brave: [results([])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['storage'], fanout: 3 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn },
    });
    expect(outcome.items).toHaveLength(1);
    expect(outcome.items[0]?.providers).toHaveLength(2);
  });
});

describe('runResearch: guards the review found live but unguarded', () => {
  it('sends a single query as a one-element array when the schema declares one', async () => {
    // The entire point of the Task-14 array fix, and it shipped untested:
    // `newsapi_articles` types its query argument as array-of-string, so a bare
    // string fails that method's own schema at pre-flight and the rank-1 news
    // provider is unreachable while still consuming a budgeted slot.
    let sentBody: unknown;
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? '{}'));
      return results(['https://a.example']);
    }) as unknown as typeof fetch;
    const arrayArg = {
      ...candidate('you', 'search'),
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'array', items: { type: 'string' } } },
        required: ['query'],
      },
    };
    await runResearch({
      plan: plan({ queries: ['coffee'], fanout: 1 }), candidates: [arrayArg], excluded: [],
      gateway: { ...gateway, fetchFn },
    });
    expect(sentBody).toEqual({ query: ['coffee'] });
  });

  it('still sends a bare string when the schema declares a string', async () => {
    let sentBody: unknown;
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? '{}'));
      return results(['https://a.example']);
    }) as unknown as typeof fetch;
    await runResearch({
      plan: plan({ queries: ['coffee'], fanout: 1 }), candidates: [candidate('you', 'search')], excluded: [],
      gateway: { ...gateway, fetchFn },
    });
    expect(sentBody).toEqual({ query: 'coffee' });
  });

  it('bills nothing on a negative call budget', async () => {
    // The Math.max(0, ...) floor has now been silently deleted once; without a
    // test it can be deleted again. `slice(0, -5)` keeps all but the last five.
    let calls = 0;
    const fetchFn = (async () => { calls += 1; return new Response('{"content":"b"}', { status: 200 }); }) as unknown as typeof fetch;
    const outcome = await runResearch({
      // SIX targets, not two: `slice(0, -5)` keeps all but the last five, so a
      // missing floor only leaks when the list is longer than the magnitude of
      // the negative budget. A two-target case passes with or without the fix.
      plan: plan({
        intents: ['search', 'scrape'], queries: ['alpha'],
        targets: Array.from({ length: 6 }, (_u, i) => `https://t${String(i)}.example`),
      }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn }, maxCalls: -5,
    });
    expect(calls).toBe(0);
    expect(outcome.billing.callsBilled).toBe(0);
    expect(outcome.documents).toHaveLength(0);
  });

  it('does not fetch a refused target, not merely report it as unfetched', async () => {
    // Previously only the GAP was pinned, so removing the refusal produced a
    // round that billed the fetch and reported it as not fetched in the same
    // document -- a contradiction no test could see.
    let calls = 0;
    const fetchFn = (async (url: string | URL) => {
      calls += 1;
      return String(url).includes('/scrape')
        ? new Response('{"content":"b"}', { status: 200 })
        : results(['https://a.example']);
    }) as unknown as typeof fetch;
    const outcome = await runResearch({
      plan: plan({ intents: ['search'], queries: ['alpha'], targets: ['https://t.example'], fanout: 1 }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.documents).toHaveLength(0);
    expect(calls).toBe(1); // the one search lane, and nothing else
  });
});

describe('runResearch: the target refusal is narrow', () => {
  it.each(['social', 'proxy', 'other'])('still fetches a target under --intents %s', async (intent) => {
    // These intents say nothing about fetching. `social` in particular is the
    // one most likely to accompany a social-media URL, and refusing there
    // silently drops a fetch the caller plainly asked for.
    const fetchFn = routedFetch({ scrapingdog: [new Response('{"content":"b"}', { status: 200 })] });
    const outcome = await runResearch({
      plan: plan({ intents: [intent as never], queries: [], targets: ['https://t.example'] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.documents).toHaveLength(1);
  });

  it.each([['search'], ['news'], ['search', 'news']])('refuses under find-only intents %j', async (...intents) => {
    const fetchFn = routedFetch({});
    const outcome = await runResearch({
      plan: plan({ intents: intents as never, queries: [], targets: ['https://t.example'] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.documents).toHaveLength(0);
    expect(outcome.coverage.unfetchedTargets[0]?.reason).toMatch(/search-only/);
  });
});
