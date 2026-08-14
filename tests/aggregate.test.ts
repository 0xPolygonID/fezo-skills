import { describe, expect, it } from 'vitest';

import { canonicalizeUrl, sniffItems } from '../src/engine/aggregate.js';
import { RESPONSE_ADAPTERS, extractItems } from '../src/engine/aggregate.js';

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
