import { describe, expect, it } from 'vitest';

import { RRF_K, SNIPPET_MAX_CHARS, canonicalizeUrl, capTitle, mergeItems, sniffItems } from '../src/engine/aggregate.js';
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
      served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.queries[0]?.uniqueUrls).toBe(2);
    expect(coverage.queries[0]?.agreementMedian).toBe(2);
  });

  it('flags a thin query as a gap', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 1)] }],
      served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/thin/i);
  });

  it('flags a zero-result query', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [] }],
      served: [], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/no results/i);
  });

  it('reports domain concentration', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://one.example/a', 1), item('https://one.example/b', 1), item('https://two.example/c', 1)] }],
      served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.domainConcentration?.host).toBe('one.example');
    expect(coverage.domainConcentration?.share).toBeCloseTo(2 / 3, 5);
  });

  it('flags a retryable provider failure', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4)] }],
      served: ['you'], unreadable: [], failed: [{ backendId: 'firecrawl', reason: 'rate_limited' }],
      skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/firecrawl/);
  });

  it('flags dropped queries so truncation is never silent', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4)] }],
      served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [{ query: 'b' }], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/not run/i);
  });

  it('flags a query no provider corroborated, however many URLs it returned', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'solid state batteries', items: [item('https://a.example', 1), item('https://b.example', 1), item('https://c.example', 1), item('https://d.example', 1)] }],
      served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/no cross-provider agreement/);
  });

  it('does not alias the caller arrays it was handed', () => {
    const served = ['you'];
    const failed = [{ backendId: 'firecrawl', reason: 'rate_limited' }];
    const skipped = ['exa'];
    const droppedQueries = [{ query: 'b' }];
    const unfetchedTargets = [{ url: 'https://t.example', reason: 'rate_limited' }];
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4)] }],
      served, failed, skipped, droppedQueries, narrowedQueries: [], unfetchedTargets, unreadable: [], suppressed: 0,
    });
    coverage.served.push('exa');
    coverage.skipped.push('you');
    coverage.droppedQueries.push({ query: 'c' });
    coverage.unfetchedTargets.push({ url: 'https://u.example' });
    const firstTarget = coverage.unfetchedTargets[0];
    if (firstTarget !== undefined) firstTarget.url = 'https://rewritten.example';
    coverage.failed.push({ backendId: 'you', reason: 'timeout' });
    const firstFailure = coverage.failed[0];
    if (firstFailure !== undefined) firstFailure.reason = 'rewritten';
    expect(served).toEqual(['you']);
    expect(skipped).toEqual(['exa']);
    expect(droppedQueries).toEqual([{ query: 'b' }]);
    expect(unfetchedTargets).toEqual([{ url: 'https://t.example', reason: 'rate_limited' }]);
    expect(failed).toEqual([{ backendId: 'firecrawl', reason: 'rate_limited' }]);
  });
});

describe('nextActions', () => {
  it('emits a runnable follow-up command carrying the session', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'thin one', items: [item('https://x.example', 1)] }],
      served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    const actions = nextActions(coverage, 'r-42');
    expect(actions[0]?.cmd).toContain('--session r-42');
    expect(actions[0]?.cmd).toContain('fezoctl research');
  });

  it('omits the session flag when no session is in use', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'thin one', items: [item('https://x.example', 1)] }],
      served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(nextActions(coverage, undefined)[0]?.cmd).not.toContain('--session');
  });

  it('returns nothing when there are no gaps', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4), item('https://y.example', 3), item('https://z.example', 3)] }],
      served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(nextActions(coverage, undefined)).toEqual([]);
  });

  it('says why a well-populated query still needs another round', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'solid state batteries', items: [item('https://a.example', 1), item('https://b.example', 1), item('https://c.example', 1), item('https://d.example', 1)] }],
      served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
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
      served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    const actions = nextActions(coverage, 'r-42');
    expect(actions[0]?.cmd).toBe(`fezoctl research 'best $100 keyboards' --depth research --session r-42`);
    expect(actions[1]?.cmd).toBe(`fezoctl research 'is a 27" monitor better' --depth research --session r-42`);
    expect(actions[2]?.cmd).toBe(`fezoctl research 'o'\\''brien \`whoami\` review' --depth research --session r-42`);
  });

  it('quotes a dropped query and an unfetched target', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4), item('https://y.example', 3), item('https://z.example', 3)] }],
      served: ['you'], unreadable: [], failed: [], skipped: [],
      droppedQueries: [{ query: 'price of $BTC & gold' }], narrowedQueries: [],
      unfetchedTargets: [{ url: 'https://example.com/p?a=1&b=2' }], suppressed: 0,
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
      served: ['scrapingdog'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [],
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
      served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [{ url: 'https://example.com/p?a=1&b=2' }], suppressed: 0,
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

// ---------------------------------------------------------------------------
// Final-review MAJ-2: the snippet cap is a property of every item entering
// `mergeItems`, not of one of its two producers. `toRawItem` (the sniffer) had
// it; `sanitizeRow` (the adapter path) did not -- and the adapter path is
// precisely the one Task 14 exists to populate, from the Firecrawl-family
// captures that put whole-page markdown in `content`.
// ---------------------------------------------------------------------------

describe('SNIPPET_MAX_CHARS covers the adapter path', () => {
  it('caps an adapter-supplied snippet exactly as the sniffer path does', () => {
    const original = RESPONSE_ADAPTERS['capped_tool'];
    RESPONSE_ADAPTERS['capped_tool'] = () => [{ url: 'https://a.example', title: 't', snippet: 'x'.repeat(200_000) }];
    try {
      // Through `mergeItems`, which is where `sanitizeRow` guards every row
      // entering the merged set -- `extractItems` hands an adapter's output
      // back as-is, so the cap has to hold at the boundary the OUTPUT crosses,
      // not at the one the adapter returns from. This is the final review's own
      // reproduction, inverted into an assertion.
      const { items } = mergeItems([{ backendId: 'b', rank: 1, items: extractItems('capped_tool', {}) }]);
      expect(items[0]?.snippet?.length).toBe(SNIPPET_MAX_CHARS);
      expect(items[0]?.snippet?.endsWith('…')).toBe(true);
    } finally {
      if (original === undefined) delete RESPONSE_ADAPTERS['capped_tool'];
      else RESPONSE_ADAPTERS['capped_tool'] = original;
    }
  });

  it('leaves a short adapter snippet untouched', () => {
    const original = RESPONSE_ADAPTERS['short_tool'];
    RESPONSE_ADAPTERS['short_tool'] = () => [{ url: 'https://a.example', snippet: 'brief' }];
    try {
      const { items } = mergeItems([{ backendId: 'b', rank: 1, items: extractItems('short_tool', {}) }]);
      expect(items[0]?.snippet).toBe('brief');
    } finally {
      if (original === undefined) delete RESPONSE_ADAPTERS['short_tool'];
      else RESPONSE_ADAPTERS['short_tool'] = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Final-review MAJ-1 / MAJ-3: a dropped query must say WHY it was dropped, a
// narrowed query must be reported at all, and an account-scoped abort must not
// produce actions that spend again.
// ---------------------------------------------------------------------------

describe('computeCoverage: dropped and narrowed queries', () => {
  const base = {
    served: ['you'], unreadable: [], failed: [], skipped: [], droppedQueries: [], narrowedQueries: [], unfetchedTargets: [],
    suppressed: 0,
  };

  it('renders a budget drop and an abort drop as different gaps', () => {
    const coverage = computeCoverage({
      ...base,
      queries: [],
      droppedQueries: [{ query: 'b' }, { query: 'c', reason: 'round aborted' }],
    });
    const gaps = coverage.gaps.join(' | ');
    expect(gaps).toMatch(/not run \(call budget\).*\bb\b/);
    expect(gaps).toMatch(/round aborted.*\bc\b/);
  });

  it('reports a narrowed query with the width it asked for and the width it got', () => {
    const coverage = computeCoverage({
      ...base,
      queries: [],
      narrowedQueries: [{ query: 'a', requested: 5, actual: 2 }],
    });
    expect(coverage.gaps.join(' ')).toMatch(/"a" narrowed to 2 of 5 providers/);
  });
});

describe('nextActions: an account-scoped abort', () => {
  const coverage = computeCoverage({
    queries: [{ query: 'thin one', items: [] }],
    served: [], unreadable: [], failed: [{ backendId: 'you', reason: 'insufficient_balance' }], skipped: [],
    droppedQueries: [{ query: 'beta', reason: 'round aborted' }],
    unfetchedTargets: [{ url: 'https://t1.example', reason: 'round aborted' }],
    narrowedQueries: [], suppressed: 0,
  });

  it('emits nothing that would bill again', () => {
    for (const action of nextActions(coverage, 'r-1', 'insufficient_balance: out of credit')) {
      // Absent entirely is the honest answer -- nothing in this CLI raises a
      // spend limit. If a command is ever added it must still not be a billing
      // one, so the guard checks rather than assumes.
      if (action.cmd !== undefined) {
        expect(action.cmd).not.toMatch(/fezoctl research/);
        expect(action.cmd).not.toMatch(/fezoctl scrape/);
      }
    }
  });

  it('still tells the caller what to do', () => {
    const actions = nextActions(coverage, 'r-1', 'insufficient_balance: out of credit');
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]?.why).toMatch(/insufficient_balance/);
  });

  it('emits the ordinary spend-again actions when there was no abort', () => {
    const actions = nextActions(coverage, 'r-1', undefined);
    expect(actions.some((a) => a.cmd?.includes('fezoctl research') === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Final-review minors and round-1 leftovers.
// ---------------------------------------------------------------------------

describe('canonicalizeUrl: userinfo', () => {
  it('strips credentials rather than carrying them into the session file', () => {
    expect(canonicalizeUrl('https://user:pw@example.com/a')).toBe('https://example.com/a');
  });

  it('merges a credentialed and a bare URL as one document', () => {
    const { items } = mergeItems([
      { backendId: 'you', rank: 1, items: [{ url: 'https://user:pw@example.com/a' }] },
      { backendId: 'exa', rank: 2, items: [{ url: 'https://example.com/a' }] },
    ]);
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toMatch(/pw@/);
  });
});

describe('title is capped like snippet', () => {
  it('does not cap anywhere identity is decided', () => {
    // Neither the sniffer nor `mergeItems` may cap: `research.ts` merges per
    // query and then merges those merges, so a title capped at the end of one
    // merge is a capped title entering the next merge's dedup key. The cap
    // lives at the render boundary; `renderResearch` is where it is asserted.
    const raw = sniffItems({ results: [{ url: 'https://a.example', title: 'T'.repeat(200_000) }] });
    expect(raw[0]?.title?.length).toBe(200_000);
    const { items } = mergeItems([{ backendId: 'b', rank: 1, items: raw }]);
    expect(items[0]?.title.length).toBe(200_000);
  });

  it('does not merge distinct documents whose long titles share a boilerplate prefix', () => {
    // The exact failure a producer-side cap caused: 368 characters of cookie
    // banner, then different headlines. Capping before the dedup key truncated
    // both to the same 299 characters, so two real results became one and the
    // two providers were recorded as agreeing -- doubling the RRF score and
    // inflating agreement_median on corroboration that never happened.
    const boiler = 'Cookie notice. We and our partners use cookies to store and access information on a device. '.repeat(4);
    const { items } = mergeItems([
      { backendId: 'you', rank: 1, items: [{ url: 'https://site-a.example/story', title: `${boiler}Story A headline` }] },
      { backendId: 'exa', rank: 2, items: [{ url: 'https://site-b.example/other', title: `${boiler}Completely different article` }] },
    ]);
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.providers).toHaveLength(1);
  });

  it('still collapses a genuine cross-host twin whose full titles match', () => {
    const long = 'Chip maker acquires rival in landmark deal. '.repeat(10);
    const { items } = mergeItems([
      { backendId: 'you', rank: 1, items: [{ url: 'https://outlet-a.example/s', title: long }] },
      { backendId: 'exa', rank: 2, items: [{ url: 'https://outlet-b.example/s', title: long }] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.providers).toHaveLength(2);
  });

  it('leaves an adapter-supplied title uncapped through the merge, for the same reason', () => {
    const original = RESPONSE_ADAPTERS['big_title'];
    RESPONSE_ADAPTERS['big_title'] = () => [{ url: 'https://a.example', title: 'T'.repeat(200_000) }];
    try {
      const { items } = mergeItems([{ backendId: 'b', rank: 1, items: extractItems('big_title', {}) }]);
      expect(items[0]?.title.length).toBe(200_000);
    } finally {
      if (original === undefined) delete RESPONSE_ADAPTERS['big_title'];
      else RESPONSE_ADAPTERS['big_title'] = original;
    }
  });

  it('caps the title at the render boundary, which is where text stops being identity', () => {
    expect(capTitle('T'.repeat(200_000)).length).toBe(300);
    expect(capTitle('short')).toBe('short');
  });

  it('never truncates in the middle of a surrogate pair', () => {
    // '𝄞' is one astral character, two UTF-16 code units. A boundary landing
    // between them emits a lone high surrogate -- a string that is not
    // well-formed UTF-16.
    const items = sniffItems({ results: [{ url: 'https://a.example', snippet: '𝄞'.repeat(2000) }] });
    const snippet = items[0]?.snippet ?? '';
    // Indexed by CODE UNIT, deliberately. An earlier version of this check
    // iterated code POINTS while indexing units, so for an all-astral string
    // its index never reached the truncation boundary and the assertion could
    // not fail -- deleting the backoff in `capText` left the whole suite green.
    let hasLoneSurrogate = false;
    for (let i = 0; i < snippet.length; i += 1) {
      const code = snippet.charCodeAt(i);
      if (code < 0xd800 || code > 0xdbff) continue;
      const next = i + 1 < snippet.length ? snippet.charCodeAt(i + 1) : Number.NaN;
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) { hasLoneSurrogate = true; break; }
      i += 1;
    }
    expect(hasLoneSurrogate).toBe(false);
    // And pin the boundary itself: the cap must land on a complete pair.
    expect(snippet.endsWith('\u{1D11E}…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
  });
});

describe('sniffItems: an array of bare URL strings', () => {
  it('reads it when no object-shaped rows were found', () => {
    // Under a result-shaped key: `links` is deliberately NOT one, because a
    // `links` array is as often navigation as it is results.
    const items = sniffItems({ results: ['https://a.example', 'https://b.example'] });
    expect(items.map((i) => i.url)).toEqual(['https://a.example', 'https://b.example']);
  });

  it('ignores strings that are not absolute http(s) URLs', () => {
    expect(sniffItems({ tags: ['climate', '/relative/path', 'doc:1234'] })).toEqual([]);
  });

  it('never outranks object-shaped results, however long the string array is', () => {
    // A tag cloud is longer than the results list in plenty of real bodies.
    const items = sniffItems({
      results: [{ url: 'https://real.example', title: 'Real' }],
      related: Array.from({ length: 50 }, (_u, i) => `https://noise${String(i)}.example`),
    });
    expect(items.map((i) => i.url)).toEqual(['https://real.example']);
  });
});

describe('nextActions: no repeated commands', () => {
  it('emits one providers command however many backends failed', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [] }],
      served: [], unreadable: [], skipped: [], droppedQueries: [], unfetchedTargets: [], narrowedQueries: [], suppressed: 0,
      failed: [
        { backendId: 'you', reason: 'rate_limited' },
        { backendId: 'exa', reason: 'rate_limited' },
        { backendId: 'brave', reason: 'rate_limited' },
      ],
    });
    const providerActions = nextActions(coverage, undefined).filter((a) => a.cmd === 'fezoctl providers --intent search');
    expect(providerActions).toHaveLength(1);
  });
});

describe('sniffUrlStrings: navigation is not a result set', () => {
  it('reads nothing from a zero-hit SERP body', () => {
    // The exact body the review demonstrated: no organic results, and the only
    // URL arrays left are navigation. Reading them fabricates findings AND
    // suppresses the honest "returned no results" gap.
    expect(sniffItems({
      search_metadata: { status: 'Success' },
      organic_results: [],
      related_searches: ['https://www.google.com/search?q=a', 'https://www.google.com/search?q=b'],
      pagination: { other_pages: { '2': 'https://www.google.com/search?start=10' } },
    })).toEqual([]);
  });

  it.each([
    ['images', { images: ['https://a.example/a.jpg', 'https://a.example/b.png'] }],
    ['pagination', { results: [], pagination: { pages: ['https://a.example/p/2', 'https://a.example/p/3'] } }],
    ['a cursor', { data: [], next: ['https://api.example/page/2'] }],
    ['a docs link on an error', { error: { docs: ['https://docs.example/errors'] } }],
    ['sitelinks', { sitelinks: ['https://a.example/x', 'https://a.example/y'] }],
  ])('reads nothing from %s', (_label, body) => {
    expect(sniffItems(body)).toEqual([]);
  });

  it('still reads a genuine result-shaped array of URLs', () => {
    expect(sniffItems({ results: ['https://a.example', 'https://b.example'] }).map((i) => i.url))
      .toEqual(['https://a.example', 'https://b.example']);
  });

  it('reads a nested result-shaped array', () => {
    expect(sniffItems({ web: { results: ['https://a.example'] } }).map((i) => i.url)).toEqual(['https://a.example']);
  });

  it('reads a top-level array, which has no competing interpretation', () => {
    expect(sniffItems(['https://a.example', 'https://b.example'])).toHaveLength(2);
  });

  it('still never outranks object-shaped rows', () => {
    const items = sniffItems({
      results: [{ url: 'https://real.example', title: 'Real' }],
      data: Array.from({ length: 50 }, (_u, i) => `https://noise${String(i)}.example`),
    });
    expect(items.map((i) => i.url)).toEqual(['https://real.example']);
  });
});

describe('duplicates never records an item as its own duplicate', () => {
  it('for a lone credentialed URL', () => {
    const { items } = mergeItems([
      { backendId: 'you', rank: 1, items: [{ url: 'https://user:s3cret@a.example/p', title: 'A' }] },
    ]);
    expect(items[0]?.url).toBe('https://a.example/p');
    expect(items[0]?.duplicates).toEqual([]);
    expect(JSON.stringify(items)).not.toMatch(/s3cret/);
  });

  it('for a lone URL that canonicalization rewrites in some other way', () => {
    const { items } = mergeItems([
      { backendId: 'you', rank: 1, items: [{ url: 'https://www.a.example/p?utm_source=x', title: 'A' }] },
    ]);
    // This one IS a genuine rewrite, so the original is worth recording.
    expect(items[0]?.duplicates).toEqual(['https://www.a.example/p?utm_source=x']);
  });
});

describe('sniffUrlStrings: the allow-list entries each work', () => {
  it.each(['results', 'organic_results', 'items', 'hits', 'records', 'entries', 'urls', 'data'])(
    'reads a URL-string array under %s',
    (key) => {
      expect(sniffItems({ [key]: ['https://a.example', 'https://b.example'] })).toHaveLength(2);
    },
  );

  it.each(['related_searches', 'pagination', 'images', 'sitelinks', 'next', 'tags', 'docs', 'links'])(
    'reads nothing under %s',
    (key) => {
      expect(sniffItems({ [key]: ['https://a.example', 'https://b.example'] })).toEqual([]);
    },
  );
});

describe('canonicalizeUrl is idempotent', () => {
  // A PROPERTY, not a handful of examples, because the pipeline applies this
  // function more than once to the same value: `research.ts` merges per query
  // and then merges those merges, and `seenUrlsFrom` canonicalizes items that
  // are already canonical. A non-idempotent canonicalizer silently produces a
  // second, different key — which loses provider attribution in the cross-query
  // merge and writes a session entry that can never match again.
  //
  // `www.www.example.com` is the case that was live: `^www\.` stripped one
  // prefix per pass.
  const CORPUS = [
    'https://example.com', 'https://example.com/', 'https://example.com//',
    'https://www.example.com/a', 'https://www.www.example.com/a',
    'https://www.WWW.example.com/a', 'https://www.www.www.example.com/a',
    'https://wwwsomething.com/a', 'https://example.com/a/', 'https://example.com/a//',
    'https://example.com/a/?b=1', 'https://example.com/a?b=1&a=2',
    'https://example.com/a?utm_source=x&gclid=1', 'https://user:pw@example.com/a',
    'https://example.com/a#frag', 'https://EXAMPLE.com/A/', 'https://example.com:443/a/',
    'https://example.com/%7Euser/', 'https://example.com/a?q=a+b', 'https://example.com/a?q=a%20b',
    'custom:opaque/path/', 'doc:1234', '/relative/path', 'not a url', '',
    // Opaque schemes with a DOUBLED separator. The pathname setter is a no-op
    // for these, so the string-level rule is the only one that runs on them --
    // and it was the third place the same single-strip mistake was made. The
    // corpus carried `custom:opaque/path/` but not `custom:opaque/path//`,
    // which is exactly why two rounds of fixing missed it.
    'doc:1234//', 'doc:1234///', 'custom:opaque/path//', 'urn:isbn:1234//',
    'data:text/plain,hello//', 'tel:+1234//',
  ];

  it.each(CORPUS)('canonicalize(canonicalize(%s)) === canonicalize(it)', (input) => {
    const once = canonicalizeUrl(input);
    expect(canonicalizeUrl(once), `once="${once}"`).toBe(once);
  });

  it('strips every leading www. label, not just the first', () => {
    expect(canonicalizeUrl('https://www.www.example.com/a')).toBe('https://example.com/a');
  });

  it('does not strip a host that merely starts with the letters www', () => {
    expect(canonicalizeUrl('https://wwwsomething.com/a')).toBe('https://wwwsomething.com/a');
  });

  it('reaches a fixed point in one pass across a combinatorial corpus', () => {
    // A FUZZ, because the hand-written list above missed a second instance of
    // exactly the same defect: the trailing-slash rule also stripped only one
    // separator, so `/p//?b=1` canonicalized to `/p/?b=1` and then to
    // `/p?b=1`. Every repeated-token rule in this function is a candidate for
    // that mistake, and enumerating hosts x paths x queries finds them without
    // anyone having to think of the case.
    const hosts = ['a.example', 'www.a.example', 'www.www.a.example', 'WWW.A.example'];
    const paths = ['', '/', '/p', '/p/', '/p//', '/p///', '/p/q/'];
    const queries = ['', '?b=1', '?utm_x=1', '?b=1&a=2', '?ref=1&b=2'];
    for (const host of hosts) {
      for (const path of paths) {
        for (const query of queries) {
          const url = `https://${host}${path}${query}`;
          const once = canonicalizeUrl(url);
          expect(canonicalizeUrl(once), `input=${url} once=${once}`).toBe(once);
        }
      }
    }
  });

  it('collapses a doubled trailing slash even behind a query', () => {
    expect(canonicalizeUrl('https://a.example/p//?b=1')).toBe('https://a.example/p?b=1');
  });
});

describe('computeCoverage: one line per distinct fact', () => {
  const base = {
    queries: [], served: ['you'], unreadable: [], skipped: [], droppedQueries: [],
    unfetchedTargets: [], narrowedQueries: [], suppressed: 0,
  };

  it('reports a provider failing under three queries once, not three times', () => {
    const failed = Array.from({ length: 3 }, () => ({ backendId: 'exa', reason: 'rate_limited' }));
    const gaps = computeCoverage({ ...base, failed }).gaps.filter((g) => g.includes('exa failed'));
    expect(gaps).toHaveLength(1);
  });

  it('still distinguishes two different failures of the same provider', () => {
    const failed = [
      { backendId: 'exa', reason: 'rate_limited' },
      { backendId: 'exa', reason: 'timeout' },
    ];
    expect(computeCoverage({ ...base, failed }).gaps.filter((g) => g.includes('exa failed'))).toHaveLength(2);
  });

  it('reports a billed-but-unreadable provider apart from an empty one', () => {
    const coverage = computeCoverage({ ...base, failed: [], unreadable: ['you'] });
    expect(coverage.unreadable).toEqual(['you']);
    expect(coverage.gaps.join(' ')).toMatch(/you returned a billed response this round could not read/);
  });
});
