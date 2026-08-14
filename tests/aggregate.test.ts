import { describe, expect, it } from 'vitest';

import { RRF_K, SNIPPET_MAX_CHARS, canonicalizeUrl, mergeItems, sniffItems } from '../src/engine/aggregate.js';
import { RESPONSE_ADAPTERS, extractItems } from '../src/engine/aggregate.js';
import { computeCoverage, nextActions } from '../src/engine/aggregate.js';
import type { LaneItems, RawItem } from '../src/engine/aggregate.js';

describe('canonicalizeUrl', () => {
  it('yields a lowercase scheme and host regardless of input casing, but never touches the path', () => {
    expect(canonicalizeUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });

  // The http(s) casing above is folded by the URL parser itself; an opaque host
  // is not, so this is the case that actually exercises our own lowercasing.
  it('lowercases the host of a non-special scheme, which the parser leaves verbatim', () => {
    expect(canonicalizeUrl('CUSTOM://EXAMPLE.COM/Path')).toBe('custom://example.com/Path');
  });

  it('strips a leading www.', () => {
    expect(canonicalizeUrl('https://www.example.com/a')).toBe('https://example.com/a');
  });

  it('drops the fragment', () => {
    expect(canonicalizeUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('removes tracking parameters and keeps the rest, sorted', () => {
    expect(canonicalizeUrl('https://example.com/a?utm_source=x&b=2&gclid=9&a=1')).toBe(
      'https://example.com/a?a=1&b=2',
    );
  });

  it('normalizes a bare trailing slash', () => {
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('normalizes a trailing slash on a deep path too, not just the root', () => {
    expect(canonicalizeUrl('https://example.com/docs/guide/')).toBe('https://example.com/docs/guide');
  });

  // The dedup invariant: a query must not decide whether the slash rule fires.
  it('normalizes a trailing slash on a path that carries a query', () => {
    expect(canonicalizeUrl('https://example.com/a/?b=1')).toBe(canonicalizeUrl('https://example.com/a?b=1'));
    expect(canonicalizeUrl('https://example.com/a/?b=1')).toBe('https://example.com/a?b=1');
  });

  it('returns an unparseable value unchanged rather than throwing', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
  });

  // `source` and `referrer` are ordinary English words, and on real sites they
  // select content (a feed variant, a localized edition) rather than describing
  // a click. Stripping them merges two genuinely different documents and demotes
  // a billed result to `duplicates` -- the one failure mode canonicalization must
  // never have, since over-merging loses data while under-merging only fails to
  // save some.
  it('keeps content-selecting parameters that merely look like tracking', () => {
    expect(canonicalizeUrl('https://example.com/item?id=5&source=rss')).toBe(
      'https://example.com/item?id=5&source=rss',
    );
    expect(canonicalizeUrl('https://example.com/item?referrer=nav')).toBe('https://example.com/item?referrer=nav');
  });

  // The vendor-namespaced click ids beyond the spec's list stay stripped: none
  // of them can select content, so removing them only ever helps the dedup.
  it('still strips vendor click ids that cannot select content', () => {
    expect(canonicalizeUrl('https://example.com/a?msclkid=1&igshid=2&yclid=3&dclid=4&_hsenc=5&_hsmi=6&mc_cid=7&b=2')).toBe(
      'https://example.com/a?b=2',
    );
  });
});

describe('sniffItems', () => {
  it('finds the largest array of url-bearing objects', () => {
    const body = {
      meta: [{ url: 'https://a.example' }],
      results: [
        { url: 'https://one.example', title: 'One', description: 'first' },
        { url: 'https://two.example', title: 'Two', description: 'second' },
      ],
    };
    expect(sniffItems(body).map((i) => i.url)).toEqual(['https://one.example', 'https://two.example']);
  });

  it('maps alternative field names', () => {
    const body = { web: { items: [{ link: 'https://x.example', name: 'X', snippet: 'sn', date: '2026-01-01' }] } };
    expect(sniffItems(body)[0]).toEqual({
      url: 'https://x.example',
      title: 'X',
      snippet: 'sn',
      publishedAt: '2026-01-01',
    });
  });

  it('reads a top-level array', () => {
    expect(sniffItems([{ url: 'https://a.example' }]).length).toBe(1);
  });

  it('returns nothing for a body with no url-bearing array', () => {
    expect(sniffItems({ markdown: '# a page', status: 'ok' })).toEqual([]);
  });

  it('skips entries with no usable url', () => {
    expect(sniffItems([{ title: 'no url' }, { url: 'https://a.example' }]).length).toBe(1);
  });

  it('never throws on null or a scalar', () => {
    expect(sniffItems(null)).toEqual([]);
    expect(sniffItems(42)).toEqual([]);
  });

  // `content` is a snippet candidate and a Firecrawl-family body puts the whole
  // page's markdown in it, so without a cap one fanout-8 round emits a
  // multi-megabyte JSON document. The cap is on the item, not on the document,
  // so the bound holds however many providers answer.
  it('truncates an oversized snippet to the declared cap', () => {
    const [item] = sniffItems({ results: [{ url: 'https://a.example', content: 'x'.repeat(200_000) }] });
    // The cap is on the emitted string, ellipsis included: the marker costs a
    // character of text rather than being added on top of a full-length slice.
    expect(item?.snippet?.length).toBe(SNIPPET_MAX_CHARS);
    expect(item?.snippet).toBe(`${'x'.repeat(SNIPPET_MAX_CHARS - 1)}…`);
  });

  it('leaves a snippet inside the cap exactly as it found it', () => {
    const [item] = sniffItems({ results: [{ url: 'https://a.example', description: 'short and complete' }] });
    expect(item?.snippet).toBe('short and complete');
  });
});

describe('extractItems', () => {
  it('falls back to the sniffer when no adapter is registered', () => {
    expect(extractItems('unknown_tool', { results: [{ url: 'https://a.example' }] }).length).toBe(1);
  });

  it('prefers a registered adapter over the sniffer', () => {
    const original = RESPONSE_ADAPTERS['fake_tool'];
    RESPONSE_ADAPTERS['fake_tool'] = () => [{ url: 'https://from-adapter.example' }];
    try {
      const items = extractItems('fake_tool', { results: [{ url: 'https://from-sniffer.example' }] });
      expect(items).toEqual([{ url: 'https://from-adapter.example' }]);
    } finally {
      if (original === undefined) delete RESPONSE_ADAPTERS['fake_tool'];
      else RESPONSE_ADAPTERS['fake_tool'] = original;
    }
  });

  it('falls back to the sniffer when an adapter throws', () => {
    const original = RESPONSE_ADAPTERS['throwing_tool'];
    RESPONSE_ADAPTERS['throwing_tool'] = () => { throw new Error('bad shape'); };
    try {
      expect(extractItems('throwing_tool', { results: [{ url: 'https://a.example' }] }).length).toBe(1);
    } finally {
      if (original === undefined) delete RESPONSE_ADAPTERS['throwing_tool'];
      else RESPONSE_ADAPTERS['throwing_tool'] = original;
    }
  });

  it('returns nothing for a body neither path can read', () => {
    expect(extractItems('unknown_tool', { markdown: '# page' })).toEqual([]);
  });

  // The likeliest mistake in a hand-transcribed adapter is not a throw, it is a
  // silent `undefined` return from a shape that did not match. A non-array
  // return used to travel out of here unexamined and become `lane.items`, where
  // `mergeItems`'s `forEach` threw -- destroying EVERY lane's already-billed
  // results, not just the lane with the bad adapter.
  it('falls back to the sniffer when an adapter returns a non-array', () => {
    const original = RESPONSE_ADAPTERS['sloppy_tool'];
    RESPONSE_ADAPTERS['sloppy_tool'] = (() => undefined) as unknown as (body: unknown) => RawItem[];
    try {
      const items = extractItems('sloppy_tool', { results: [{ url: 'https://a.example' }] });
      expect(items).toEqual([{ url: 'https://a.example' }]);
    } finally {
      if (original === undefined) delete RESPONSE_ADAPTERS['sloppy_tool'];
      else RESPONSE_ADAPTERS['sloppy_tool'] = original;
    }
  });

  it('falls back to the sniffer when an adapter returns null', () => {
    const original = RESPONSE_ADAPTERS['null_tool'];
    RESPONSE_ADAPTERS['null_tool'] = (() => null) as unknown as (body: unknown) => RawItem[];
    try {
      expect(extractItems('null_tool', { results: [{ url: 'https://a.example' }] }).length).toBe(1);
    } finally {
      if (original === undefined) delete RESPONSE_ADAPTERS['null_tool'];
      else RESPONSE_ADAPTERS['null_tool'] = original;
    }
  });
});

function lane(backendId: string, rank: number, urls: Array<[string, string?]>): LaneItems {
  return { backendId, rank, items: urls.map(([url, title]) => ({ url, ...(title !== undefined ? { title } : {}) })) };
}

describe('mergeItems', () => {
  it('merges the same page found by two providers into one item', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://www.example.com/a?utm_source=x']]),
      lane('exa', 2, [['https://example.com/a']]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.providers.map((p) => p.backendId).sort()).toEqual(['exa', 'you']);
  });

  it('preserves every original URL on duplicates', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://www.example.com/a?utm_source=x']]),
      lane('exa', 2, [['https://example.com/a']]),
    ]);
    expect(items[0]?.duplicates).toContain('https://www.example.com/a?utm_source=x');
  });

  // The lane order is the whole point of this sibling test: with the decorated
  // URL first it is captured by the object literal's `duplicates` initializer
  // and the merge branch's push never runs. A later provider's original URL has
  // to survive too, or a fan-out silently drops provenance for every provider
  // that was not first to report a document -- the common case, since providers
  // disagree about decoration far more often than about which page exists.
  it("preserves a later provider's original URL on duplicates too", () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://example.com/a']]),
      lane('exa', 2, [['https://www.example.com/a?utm_source=x']]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.duplicates).toEqual(['https://www.example.com/a?utm_source=x']);
  });

  it('scores by reciprocal rank fusion', () => {
    const { items } = mergeItems([lane('you', 1, [['https://a.example']])]);
    expect(items[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it('ranks an item found by two providers above one found first by a single provider', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://solo.example'], ['https://shared.example']]),
      lane('exa', 2, [['https://shared.example']]),
    ]);
    expect(items[0]?.url).toBe('https://shared.example');
  });

  it('collapses a near-identical title across different hosts', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://outlet-a.example/story', 'Chip Maker Buys Rival!']]),
      lane('exa', 2, [['https://outlet-b.example/story', 'chip maker buys rival']]),
    ]);
    expect(items).toHaveLength(1);
  });

  // The collapse is a judgement call, so what makes it safe is that nothing is
  // discarded: every source URL lands on `duplicates` and every contributing
  // provider on `providers` -- which is also what keeps the RRF score and Task
  // 7's agreement arithmetic correct for a merged item. Counting the survivors
  // is not enough; these are the assertions that fail if either push is lost.
  it('keeps every source URL and every provider when it collapses across hosts', () => {
    const { items } = mergeItems([
      { backendId: 'you', rank: 1, items: [{ url: 'https://a.example/s?utm_source=q', title: 'Wire Story' }] },
      { backendId: 'exa', rank: 2, items: [{ url: 'https://b.example/s', title: 'wire story!', snippet: 'sn', publishedAt: '2026-01-02' }] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.providers.map((p) => p.backendId).sort()).toEqual(['exa', 'you']);
    expect(items[0]?.duplicates).toEqual(
      expect.arrayContaining(['https://a.example/s?utm_source=q', 'https://b.example/s']),
    );
    expect(items[0]?.snippet).toBe('sn');
    // `publishedAt` is asserted alongside `snippet` because the two enrichment
    // lines are one rule, and a date lost in the collapse is not cosmetic: it is
    // the recency signal downstream consumers read off a merged item.
    expect(items[0]?.publishedAt).toBe('2026-01-02');
    expect(items[0]?.score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it('does not collapse an identical title on the same host', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://one.example/a', 'Docs'], ['https://one.example/b', 'Docs']]),
    ]);
    expect(items).toHaveLength(2);
  });

  // The same-host guard has to hold against every host already folded under a
  // title, not just the representative's: with a cross-host item claiming the
  // key first, checking only the representative lets the two one.example pages
  // merge with each other through it.
  it('does not collapse two same-host pages transitively through a cross-host twin', () => {
    const { items } = mergeItems([
      lane('you', 1, [
        ['https://two.example/x', 'Docs'],
        ['https://one.example/a', 'Docs'],
        ['https://one.example/b', 'Docs'],
      ]),
    ]);
    expect(items).toHaveLength(2);
  });

  // An unparseable URL carries no host evidence, so it must never satisfy the
  // cross-host condition. Returning the URL itself as a stand-in host makes the
  // guard trivially true -- each item sits under a distinct canonical URL, so a
  // fabricated host never collides -- and these three site-relative paths, the
  // exact shape a SERP-scraping backend emits, collapse into one, demoting two
  // billed results to `duplicates`.
  it('never collapses same-title pages whose URLs carry no host evidence', () => {
    const { items } = mergeItems([
      lane('you', 1, [['/news/1', 'Docs'], ['/news/2', 'Docs'], ['/news/3', 'Docs']]),
    ]);
    expect(items).toHaveLength(3);
  });

  // The other half of "no host evidence", and the half a catch block cannot
  // reach: an opaque-scheme value parses *successfully* and yields hostname '',
  // so it never touches the catch branch above. '' is a live Set member, so
  // treating it as a host makes it differ from every real hostname and satisfies
  // the cross-host guard on evidence we do not have. A doc id is a named input --
  // `canonicalizeUrl`'s docstring lists it beside the relative path -- and the
  // http item is here to prove the leak in the direction that loses a result:
  // without the fix `doc:1234` is demoted onto the http item's `duplicates`.
  it('never collapses same-title pages whose URLs parse but carry no host', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://a.example/story', 'Docs'], ['doc:1234', 'Docs'], ['doc:5678', 'Docs']]),
    ]);
    expect(items).toHaveLength(3);
  });

  // An ASCII-only title key reduces any non-Latin title to '', which is a live
  // Map key -- so unrelated articles in Russian, Chinese and Japanese would all
  // collapse into one item, silently discarding billed results.
  it('keeps unrelated non-Latin titles on different hosts apart', () => {
    const { items } = mergeItems([
      lane('you', 1, [
        ['https://ru.example/1', 'Новости дня'],
        ['https://cn.example/2', '中国新闻'],
        ['https://jp.example/3', '日本のニュース'],
      ]),
    ]);
    expect(items).toHaveLength(3);
  });

  it('keeps titles that reduce to nothing apart, since an empty key is no evidence of sameness', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://a.example/1', '!!!'], ['https://b.example/2', '???']]),
    ]);
    expect(items).toHaveLength(2);
  });

  it('still collapses the same non-Latin title across hosts', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://ru-a.example/1', 'Новости дня!']]),
      lane('exa', 2, [['https://ru-b.example/2', 'новости дня']]),
    ]);
    expect(items).toHaveLength(1);
  });

  // A URL-only first contributor leaves the URL standing in as the title; a real
  // title from a later provider has to win, or the merged item shows a raw URL
  // to the reader and is skipped by the cross-host collapse pass entirely.
  //
  // `snippet` and `publishedAt` are asserted here rather than in a test of their
  // own because they are the same "keep the richest text" rule the title obeys,
  // and they share its rationale comment in the source. Without them a
  // text-less first contributor starves the item permanently, which would again
  // make the merged output depend on which lane happened to arrive first.
  it('upgrades a placeholder title when a later provider supplies a real one', () => {
    const { items } = mergeItems([
      { backendId: 'you', rank: 1, items: [{ url: 'https://example.com/a' }] },
      { backendId: 'exa', rank: 2, items: [{ url: 'https://example.com/a', title: 'Real Title', snippet: 's', publishedAt: '2026-01-02' }] },
    ]);
    expect(items[0]?.title).toBe('Real Title');
    expect(items[0]?.snippet).toBe('s');
    expect(items[0]?.publishedAt).toBe('2026-01-02');
  });

  it('suppresses already-seen URLs and reports how many', () => {
    const { items, suppressed } = mergeItems(
      [lane('you', 1, [['https://old.example'], ['https://new.example']])],
      new Set(['https://old.example']),
    );
    expect(items.map((i) => i.url)).toEqual(['https://new.example']);
    expect(suppressed).toBe(1);
  });

  // `suppressed` is a count of documents withheld, not of lane hits: the same
  // seen page returned by two providers is still one page the caller did not get.
  it('counts a suppressed page once however many providers returned it', () => {
    const { items, suppressed } = mergeItems(
      [
        lane('you', 1, [['https://old.example'], ['https://new.example']]),
        lane('exa', 2, [['https://www.old.example/?utm_source=z']]),
      ],
      new Set(['https://old.example']),
    );
    expect(items.map((i) => i.url)).toEqual(['https://new.example']);
    expect(suppressed).toBe(1);
  });

  // The URLs travel with the count so a caller that merges several times (the
  // executor merges once per sub-query) can union the sets: adding the counts
  // up would report one already-seen page as several withheld pages.
  it('reports which canonical URLs were suppressed, not just how many', () => {
    const { suppressed, suppressedUrls } = mergeItems(
      [lane('you', 1, [['https://www.old.example/?utm_source=z'], ['https://new.example']])],
      new Set(['https://old.example']),
    );
    expect([...suppressedUrls]).toEqual(['https://old.example']);
    expect(suppressed).toBe(suppressedUrls.size);
  });

  // `providers` carries one entry per backend, and RRF depends on it: the
  // spec's ordering rationale is "appearing high on several lists beats
  // appearing first on one", so a backend counted twice reads as agreement
  // between two providers that does not exist. A lane returning the same
  // document twice (pagination, a decorated duplicate) is the cheap way to
  // reach it.
  it('counts one backend once when its own lane returns the same document twice', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://example.com/a'], ['https://www.example.com/a?utm_source=x']]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.providers).toHaveLength(1);
    // The best (lowest) resultRank survives, so a document a provider ranked
    // first is not demoted by the same provider also listing it further down.
    expect(items[0]?.providers[0]?.resultRank).toBe(1);
    expect(items[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  // The other route to a duplicated backend, and the one that pays best: pass 2
  // folds every same-title item into the representative, including several from
  // a single lane.
  it('counts one backend once when the cross-host title collapse folds three of its own results', () => {
    const { items } = mergeItems([
      lane('you', 1, [
        ['https://a.example/s', 'Wire Story'],
        ['https://b.example/s', 'Wire Story'],
        ['https://c.example/s', 'Wire Story'],
      ]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.providers).toHaveLength(1);
    expect(items[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  // The ordering consequence, stated as the spec states it: real agreement
  // between two providers must outrank one provider's own redundancy. Before
  // the distinct-backend fusion the single-lane triple scored 0.0484 against
  // the genuine pair's 0.0328 and took the top slot.
  it('ranks a genuine two-provider agreement above one provider repeating itself', () => {
    const { items } = mergeItems([
      lane('you', 1, [
        ['https://a.example/s', 'Wire Story'],
        ['https://b.example/s', 'Wire Story'],
        ['https://c.example/s', 'Wire Story'],
        ['https://real.example/x', 'Genuine Agreement'],
      ]),
      lane('exa', 2, [['https://real.example/x', 'Genuine Agreement']]),
    ]);
    expect(items[0]?.url).toBe('https://real.example/x');
    expect(items[0]?.providers.map((p) => p.backendId).sort()).toEqual(['exa', 'you']);
  });

  // An adapter is hand-transcribed from a captured response, so an item missing
  // the one field the whole pipeline keys on is a live possibility. Such an item
  // used to be scored and emitted with `url: undefined`, violating
  // `ResearchItem.url: string` inside the output document -- worse than a throw,
  // because nothing announces it.
  it('skips an item whose url is missing or empty rather than emitting one with no url', () => {
    const { items } = mergeItems([
      {
        backendId: 'you',
        rank: 1,
        items: [
          { title: 'no url' } as unknown as RawItem,
          { url: '   ', title: 'blank url' },
          { url: 42 } as unknown as RawItem,
          { url: 'https://real.example/a', title: 'Real' },
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('https://real.example/a');
  });

  // `extractItems` only guarantees that an adapter returned an ARRAY, so a
  // transcription slip like `(body) => [body.result]` against a renamed key
  // delivers a lane whose ELEMENTS are undefined. Dereferencing one used to
  // throw straight out of `mergeItems`, which runs after every lane is billed --
  // so one bad row destroyed a healthy lane's paid-for results too.
  it('skips null and undefined rows without losing another lane already billed', () => {
    const { items } = mergeItems([
      { backendId: 'good', rank: 1, items: [{ url: 'https://paid.example/1', title: 'Paid' }] },
      {
        backendId: 'bad',
        rank: 2,
        items: [undefined, null, { url: 'https://real.example/a', title: 'Real' }] as unknown as RawItem[],
      },
    ]);
    expect(items.map((i) => i.url).sort()).toEqual(['https://paid.example/1', 'https://real.example/a']);
  });

  // The same class of breakage one field over, and it reached a different site:
  // a non-string title threw inside `titleKey` during pass 2, with the same
  // whole-round blast radius. The url is what the pipeline keys on, so a bad
  // title costs only the title -- the item still survives, under the placeholder.
  it('falls back to the canonical URL when an adapter hands back a non-string title', () => {
    const { items } = mergeItems([
      { backendId: 'x', rank: 1, items: [{ url: 'https://a.example', title: 42 }] as unknown as RawItem[] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('https://a.example');
  });

  // Non-throwing variant of the same hole: a non-string optional field used to
  // reach the emitted document, so `--json` stdout carried an object where
  // `ResearchItem.snippet?: string` promises a string.
  it('drops a non-string snippet or publishedAt rather than emitting it', () => {
    const { items } = mergeItems([
      {
        backendId: 'x',
        rank: 1,
        items: [{ url: 'https://a.example', snippet: {}, publishedAt: 7 }] as unknown as RawItem[],
      },
    ]);
    expect(items[0]?.snippet).toBeUndefined();
    expect(items[0]?.publishedAt).toBeUndefined();
  });

  // Equal `resultRank` across two lanes is the only way to produce identical RRF
  // scores, and so the only input that reaches the comparator's second clause --
  // two items within one lane always differ by rank. Asserting the concrete
  // order, not just that two calls agree: a pure function agrees with itself
  // even with the tie-break deleted.
  it('breaks score ties on canonical URL for determinism', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://b.example']]),
      lane('exa', 2, [['https://a.example']]),
    ]);
    expect(items[0]?.score).toBe(items[1]?.score);
    expect(items.map((i) => i.url)).toEqual(['https://a.example', 'https://b.example']);
  });
});

const item = (url: string, providers: number) => ({
  url,
  title: url,
  providers: Array.from({ length: providers }, (_unused, i) => ({ backendId: `p${String(i)}`, rank: i + 1, resultRank: 1 })),
  score: 1,
  duplicates: [],
});

describe('computeCoverage', () => {
  it('reports unique URLs and median agreement per query', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 3), item('https://y.example', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.queries[0]?.uniqueUrls).toBe(2);
    expect(coverage.queries[0]?.agreementMedian).toBe(2);
  });

  it('flags a thin query as a gap', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/thin/i);
  });

  it('flags a zero-result query', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [] }],
      served: [], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/no results/i);
  });

  it('reports domain concentration', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://one.example/a', 1), item('https://one.example/b', 1), item('https://two.example/c', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.domainConcentration?.host).toBe('one.example');
    expect(coverage.domainConcentration?.share).toBeCloseTo(2 / 3, 5);
  });

  it('flags a retryable provider failure', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4)] }],
      served: ['you'], failed: [{ backendId: 'firecrawl', reason: 'rate_limited' }],
      skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/firecrawl/);
  });

  it('flags dropped queries so truncation is never silent', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: ['b'], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/not run/i);
  });

  it('flags a query no provider corroborated, however many URLs it returned', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'solid state batteries', items: [item('https://a.example', 1), item('https://b.example', 1), item('https://c.example', 1), item('https://d.example', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/no cross-provider agreement/);
  });

  it('does not alias the caller arrays it was handed', () => {
    const served = ['you'];
    const failed = [{ backendId: 'firecrawl', reason: 'rate_limited' }];
    const skipped = ['exa'];
    const droppedQueries = ['b'];
    const unfetchedTargets = [{ url: 'https://t.example', reason: 'rate_limited' }];
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4)] }],
      served, failed, skipped, droppedQueries, unfetchedTargets, suppressed: 0,
    });
    coverage.served.push('exa');
    coverage.skipped.push('you');
    coverage.droppedQueries.push('c');
    coverage.unfetchedTargets.push({ url: 'https://u.example' });
    const firstTarget = coverage.unfetchedTargets[0];
    if (firstTarget !== undefined) firstTarget.url = 'https://rewritten.example';
    coverage.failed.push({ backendId: 'you', reason: 'timeout' });
    const firstFailure = coverage.failed[0];
    if (firstFailure !== undefined) firstFailure.reason = 'rewritten';
    expect(served).toEqual(['you']);
    expect(skipped).toEqual(['exa']);
    expect(droppedQueries).toEqual(['b']);
    expect(unfetchedTargets).toEqual([{ url: 'https://t.example', reason: 'rate_limited' }]);
    expect(failed).toEqual([{ backendId: 'firecrawl', reason: 'rate_limited' }]);
  });
});

describe('nextActions', () => {
  it('emits a runnable follow-up command carrying the session', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'thin one', items: [item('https://x.example', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    const actions = nextActions(coverage, 'r-42');
    expect(actions[0]?.cmd).toContain('--session r-42');
    expect(actions[0]?.cmd).toContain('fezoctl research');
  });

  it('omits the session flag when no session is in use', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'thin one', items: [item('https://x.example', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(nextActions(coverage, undefined)[0]?.cmd).not.toContain('--session');
  });

  it('returns nothing when there are no gaps', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4), item('https://y.example', 3), item('https://z.example', 3)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(nextActions(coverage, undefined)).toEqual([]);
  });

  it('says why a well-populated query still needs another round', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'solid state batteries', items: [item('https://a.example', 1), item('https://b.example', 1), item('https://c.example', 1), item('https://d.example', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    // Not "is thin": the query returned four unique URLs, and a `why` that
    // contradicts its own gap line points the agent at the wrong remedy.
    expect(nextActions(coverage, undefined)[0]?.why).toBe('"solid state batteries" has no cross-provider agreement');
  });

  it('quotes a query so the shell cannot expand, split or truncate it', () => {
    const coverage = computeCoverage({
      queries: [
        { query: 'best $100 keyboards', items: [] },
        { query: 'is a 27" monitor better', items: [] },
        { query: "o'brien `whoami` review", items: [] },
      ],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    const actions = nextActions(coverage, 'r-42');
    expect(actions[0]?.cmd).toBe(`fezoctl research 'best $100 keyboards' --depth research --session r-42`);
    expect(actions[1]?.cmd).toBe(`fezoctl research 'is a 27" monitor better' --depth research --session r-42`);
    expect(actions[2]?.cmd).toBe(`fezoctl research 'o'\\''brien \`whoami\` review' --depth research --session r-42`);
  });

  it('quotes a dropped query and an unfetched target', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4), item('https://y.example', 3), item('https://z.example', 3)] }],
      served: ['you'], failed: [], skipped: [],
      droppedQueries: ['price of $BTC & gold'], unfetchedTargets: [{ url: 'https://example.com/p?a=1&b=2' }], suppressed: 0,
    });
    const actions = nextActions(coverage, undefined);
    expect(actions[0]?.cmd).toBe(`fezoctl research 'price of $BTC & gold'`);
    expect(actions[1]?.cmd).toBe(`fezoctl scrape 'https://example.com/p?a=1&b=2'`);
  });

  // The reason a target is missing belongs in `why` and nowhere near `cmd`:
  // `cmd` is promised runnable, and `fezoctl scrape` is the very fallback the
  // fan-out delegates a failed target to.
  it('carries a failed target\'s reason in why and leaves the command runnable', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4), item('https://y.example', 3), item('https://z.example', 3)] }],
      served: ['scrapingdog'], failed: [], skipped: [], droppedQueries: [],
      unfetchedTargets: [{ url: 'https://t.example/a', reason: 'rate_limited' }, { url: 'https://t.example/b' }],
      suppressed: 0,
    });
    expect(coverage.gaps).toContain('not fetched: https://t.example/a (rate_limited), https://t.example/b');
    const actions = nextActions(coverage, undefined);
    expect(actions.map((a) => a.cmd)).toEqual([
      `fezoctl scrape 'https://t.example/a'`,
      `fezoctl scrape 'https://t.example/b'`,
    ]);
    expect(actions[0]?.why).toBe('not fetched (rate_limited)');
    expect(actions[1]?.why).toBe('not fetched');
  });

  it('emits commands a POSIX shell parses back into the exact arguments', async () => {
    const { execFileSync } = await import('node:child_process');
    const coverage = computeCoverage({
      queries: [{ query: 'best $100 keyboards & "27\' monitors"', items: [] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [{ url: 'https://example.com/p?a=1&b=2' }], suppressed: 0,
    });
    const argvOf = (cmd: string): string[] =>
      execFileSync('/bin/sh', ['-c', `fezoctl() { for a in "$@"; do printf '%s\\n' "$a"; done; }; ${cmd}`], { encoding: 'utf8' })
        .split('\n')
        .slice(0, -1);
    const actions = nextActions(coverage, 'r-42');
    expect(argvOf(actions[0]?.cmd ?? '')).toEqual(['research', 'best $100 keyboards & "27\' monitors"', '--depth', 'research', '--session', 'r-42']);
    expect(argvOf(actions[1]?.cmd ?? '')).toEqual(['scrape', 'https://example.com/p?a=1&b=2']);
  });
});
