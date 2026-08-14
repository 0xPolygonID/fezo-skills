import { describe, expect, it } from 'vitest';

import { RRF_K, canonicalizeUrl, mergeItems, sniffItems } from '../src/engine/aggregate.js';
import { RESPONSE_ADAPTERS, extractItems } from '../src/engine/aggregate.js';
import type { LaneItems } from '../src/engine/aggregate.js';

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
