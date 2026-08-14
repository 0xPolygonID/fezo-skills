import { describe, expect, it } from 'vitest';

import { INTENTS, METHOD_INTENTS } from '../src/engine/intent.js';
import {
  RECOMMENDATIONS,
  declaredIntentsFor,
  diversityOrder,
  displayNameFor,
  isExcluded,
  orderByIndexDiversity,
  recommendationFor,
  recommendationsFor,
  resolveExcludedBackends,
} from '../src/engine/providers.js';
import type { Recommendation, Tier } from '../src/engine/providers.js';

// ---------------------------------------------------------------------------
// The invariant providers.ts's own doc comment promises but nothing in
// mcp-server currently enforces from the providers side: every declared
// entryMethods name must be tagged, in METHOD_INTENTS, with (at least) the
// intent its own list appears under. A name that resolves to nothing (a typo,
// a stale method) or that intent.ts tags with a DIFFERENT intent would make
// `tier:primary` preload silently load nothing, or load something that isn't
// actually an entry point for the requested capability.
// ---------------------------------------------------------------------------

describe('RECOMMENDATIONS.entryMethods vs. METHOD_INTENTS (the cross-table invariant)', () => {
  it('tags every declared entryMethods name in METHOD_INTENTS with at least its own intent', () => {
    const failures: string[] = [];

    for (const intent of INTENTS) {
      for (const rec of recommendationsFor(intent)) {
        for (const methodName of rec.entryMethods) {
          const tagged = METHOD_INTENTS[methodName];
          if (tagged === undefined) {
            failures.push(`${intent}/${rec.backendId}: entryMethod "${methodName}" is absent from METHOD_INTENTS`);
            continue;
          }
          if (!tagged.includes(intent)) {
            failures.push(
              `${intent}/${rec.backendId}: entryMethod "${methodName}" is tagged [${tagged.join(', ')}] in METHOD_INTENTS, missing "${intent}"`,
            );
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('every entryMethods name is prefixed with its own backendId (methodToToolName shape)', () => {
    // Not a substitute for the METHOD_INTENTS check above (a name can start
    // with the right prefix and still be a typo'd/nonexistent method), but a
    // cheap sanity check that catches "declared for the wrong backend" typos.
    for (const intent of INTENTS) {
      for (const rec of recommendationsFor(intent)) {
        for (const methodName of rec.entryMethods) {
          expect(methodName.startsWith(`${rec.backendId}_`)).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Structural invariants over the declared table itself.
// ---------------------------------------------------------------------------

const TIER_WEIGHT: Record<Tier, number> = { primary: 0, secondary: 1, fallback: 2 };

describe('RECOMMENDATIONS structure', () => {
  it('is keyed by exactly INTENTS, in exactly INTENTS order', () => {
    // This is what licenses `declaredIntentsFor`'s substitution of `INTENTS`
    // for `Object.keys(RECOMMENDATIONS)` (providers.ts's comment claims
    // "`INTENTS` enumerates exactly the same domain in the same order"), and
    // it is also what licenses every INTENTS-driven loop in this file. Order
    // matters, not just membership: `declaredIntentsFor` documents its output
    // as being in `RECOMMENDATIONS`' key order, and the brightdata assertion
    // below checks that output positionally.
    expect(Object.keys(RECOMMENDATIONS)).toEqual([...INTENTS]);
  });

  it('gives every intent except "other" at least one primary recommendation', () => {
    for (const intent of INTENTS) {
      if (intent === 'other') continue;
      const tiers = recommendationsFor(intent).map((r) => r.tier);
      expect(tiers, `intent "${intent}" has no primary`).toContain('primary');
    }
  });

  it('never gives "other" a declared recommendation', () => {
    expect(recommendationsFor('other')).toEqual([]);
  });

  it('orders tiers non-increasing down each declared list (primary, then secondary, then fallback)', () => {
    for (const intent of INTENTS) {
      const weights = recommendationsFor(intent).map((r) => TIER_WEIGHT[r.tier]);
      for (let i = 1; i < weights.length; i++) {
        const prev = weights[i - 1];
        const curr = weights[i];
        expect(prev, `intent "${intent}" index ${i}`).toBeDefined();
        expect(curr, `intent "${intent}" index ${i}`).toBeDefined();
        if (prev !== undefined && curr !== undefined) {
          expect(curr, `intent "${intent}": tier weakened then strengthened at index ${i}`).toBeGreaterThanOrEqual(
            prev,
          );
        }
      }
    }
  });

  it('never lists the same backendId twice within one intent', () => {
    for (const intent of INTENTS) {
      const ids = recommendationsFor(intent).map((r) => r.backendId);
      expect(new Set(ids).size, `intent "${intent}" has a duplicate backendId: ${ids.join(', ')}`).toBe(ids.length);
    }
  });

  it('places every notRecommended entry last in its list', () => {
    for (const intent of INTENTS) {
      const recs = recommendationsFor(intent);
      const firstNotRecommended = recs.findIndex((r) => r.notRecommended !== undefined);
      if (firstNotRecommended === -1) continue;
      expect(firstNotRecommended, `intent "${intent}"`).toBe(recs.length - 1);
    }
  });

  it('gives every recommendation at least one entry method', () => {
    for (const intent of INTENTS) {
      for (const rec of recommendationsFor(intent)) {
        expect(rec.entryMethods.length, `${intent}/${rec.backendId}`).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Freezing / determinism.
// ---------------------------------------------------------------------------

describe('RECOMMENDATIONS freezing', () => {
  it('is frozen at every level: the table, each list, each record, and entryMethods', () => {
    expect(Object.isFrozen(RECOMMENDATIONS)).toBe(true);
    for (const intent of INTENTS) {
      const list = RECOMMENDATIONS[intent];
      expect(Object.isFrozen(list), intent).toBe(true);
      for (const rec of list) {
        expect(Object.isFrozen(rec), `${intent}/${rec.backendId}`).toBe(true);
        expect(Object.isFrozen(rec.entryMethods), `${intent}/${rec.backendId}`).toBe(true);
      }
    }
  });

  it('throws rather than silently reordering when a caller mutates a returned list', () => {
    const bogus = {
      backendId: 'bogus',
      displayName: 'Bogus',
      tier: 'primary' as const,
      why: 'n/a',
      entryMethods: [],
      indexId: 'bogus',
    };
    expect(() => recommendationsFor('scrape').push(bogus)).toThrow();
    expect(() => recommendationsFor('scrape').sort()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// recommendationFor / declaredIntentsFor / displayNameFor.
// ---------------------------------------------------------------------------

describe('recommendationFor', () => {
  it('finds a provider within an intent, and returns undefined when absent', () => {
    expect(recommendationFor('scrape', 'scrapingdog')?.tier).toBe('primary');
    expect(recommendationFor('scrape', 'nonexistent-backend')).toBeUndefined();
    expect(recommendationFor('social', 'scrapingdog')).toBeUndefined();
  });
});

describe('declaredIntentsFor', () => {
  it('lists every intent whose declared list mentions a multi-intent backend, in INTENTS order', () => {
    // brightdata is declared under scrape, crawl, social and proxy.
    expect(declaredIntentsFor('brightdata')).toEqual(['scrape', 'crawl', 'social', 'proxy']);
  });

  it('returns an empty array for a backend no declared list mentions', () => {
    expect(declaredIntentsFor('some-unassessed-backend')).toEqual([]);
  });
});

describe('displayNameFor', () => {
  it('resolves a display name across intents, even for one not in the given intent\'s list', () => {
    expect(displayNameFor('brightdata')).toBe('Bright Data');
  });

  it('returns undefined for a backend no declared list mentions', () => {
    expect(displayNameFor('some-unassessed-backend')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveExcludedBackends / isExcluded — the threaded deny-list.
// ---------------------------------------------------------------------------

describe('resolveExcludedBackends', () => {
  it('defaults to falai and alpaca when the env var is absent', () => {
    expect(resolveExcludedBackends({})).toEqual(['falai', 'alpaca']);
  });

  it('honours an explicitly empty string as "exclude nothing"', () => {
    expect(resolveExcludedBackends({ FEZO_EXCLUDED_BACKENDS: '' })).toEqual([]);
  });

  it('replaces, not extends, the default when the env var is set', () => {
    expect(resolveExcludedBackends({ FEZO_EXCLUDED_BACKENDS: 'xro' })).toEqual(['xro']);
    // falai/alpaca are gone entirely, not merged in.
    expect(resolveExcludedBackends({ FEZO_EXCLUDED_BACKENDS: 'xro' })).not.toContain('falai');
  });

  it('splits on commas and trims whitespace', () => {
    expect(resolveExcludedBackends({ FEZO_EXCLUDED_BACKENDS: ' falai , xro ,alpaca' })).toEqual([
      'falai',
      'xro',
      'alpaca',
    ]);
  });

  it('drops blank entries produced by stray commas or trailing whitespace', () => {
    expect(resolveExcludedBackends({ FEZO_EXCLUDED_BACKENDS: 'falai,,xro,' })).toEqual(['falai', 'xro']);
    expect(resolveExcludedBackends({ FEZO_EXCLUDED_BACKENDS: '  ,  ' })).toEqual([]);
  });

  it('does not dedupe: duplicates in the env var are preserved verbatim', () => {
    expect(resolveExcludedBackends({ FEZO_EXCLUDED_BACKENDS: 'falai,falai' })).toEqual(['falai', 'falai']);
  });

  it('returns a fresh array each call: mutating one result never affects another', () => {
    const first = resolveExcludedBackends({});
    first.push('mutated');
    expect(resolveExcludedBackends({})).toEqual(['falai', 'alpaca']);
  });
});

describe('isExcluded', () => {
  it('is a pure predicate over the threaded list, reading no module-level state', () => {
    expect(isExcluded('falai', ['falai', 'alpaca'])).toBe(true);
    expect(isExcluded('firecrawl', ['falai', 'alpaca'])).toBe(false);
    expect(isExcluded('anything', [])).toBe(false);
  });

  it('composes directly with resolveExcludedBackends', () => {
    const excluded = resolveExcludedBackends({ FEZO_EXCLUDED_BACKENDS: 'xro' });
    expect(isExcluded('xro', excluded)).toBe(true);
    expect(isExcluded('falai', excluded)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// indexId / diversityOrder — the fan-out breadth axis over the declared,
// best-value ranking. See providers.ts's doc comment on `indexId` for why
// value rank and index diversity are different axes.
// ---------------------------------------------------------------------------

// The declared map, transcribed from the plan's Task 1 table plus the two
// amendments that task recorded (`firecrawl`/`geonode` resell the Google SERP
// in `search`). Pinned as a literal, keyed by "intent/backendId", because
// `indexId` is the routing input that decides what a fan-out DOESN'T buy:
// moving a provider onto a shared index silently narrows every future round,
// and moving one off a shared index silently widens the bill. Neither is a
// typo-sized change, so both have to be made twice, here and in providers.ts.
const DECLARED_INDEX_IDS: Readonly<Record<string, string>> = {
  'search/you': 'you',
  'search/exa': 'exa',
  'search/brave': 'brave',
  'search/firecrawl': 'google-serp',
  'search/geonode': 'google-serp',
  'scrape/scrapingdog': 'google-serp',
  'scrape/brightdata': 'brightdata',
  'scrape/firecrawl': 'firecrawl',
  'scrape/geonode': 'geonode',
  'scrape/apify': 'apify',
  'scrape/scraperapi': 'google-serp',
  'scrape/scrapingbee': 'google-serp',
  'crawl/firecrawl': 'firecrawl',
  'crawl/geonode': 'geonode',
  'crawl/brightdata': 'brightdata',
  'crawl/apify': 'apify',
  'news/newsapi': 'newsapi',
  'news/you': 'you',
  'news/brave': 'brave',
  'social/apify': 'apify',
  'social/brightdata': 'brightdata',
  'social/xro': 'x',
  'proxy/geonode': 'geonode',
  'proxy/brightdata': 'brightdata',
};

describe('indexId', () => {
  it('is declared on every recommendation', () => {
    for (const [intent, recs] of Object.entries(RECOMMENDATIONS)) {
      for (const rec of recs) {
        expect(rec.indexId, `${intent}/${rec.backendId}`).toBeTruthy();
      }
    }
  });

  it('matches the pinned declared map, row for row', () => {
    const actual: Record<string, string> = {};
    for (const [intent, recs] of Object.entries(RECOMMENDATIONS)) {
      for (const rec of recs) actual[`${intent}/${rec.backendId}`] = rec.indexId;
    }
    expect(actual).toEqual(DECLARED_INDEX_IDS);
  });

  it('declares one index per (intent, backendId) and keeps a backend stable wherever its entry method is the same', () => {
    // The plan's Step 3 asked for one indexId per backend across all intents.
    // Task 1 narrowed that to per-row: a backend's entry method differs by
    // intent, and firecrawl_search (a SERP scrape) shares an upstream that
    // firecrawl_scrape (a fetch of the caller's own URL) does not. What
    // survives is the weaker, true invariant -- rows that declare the SAME
    // entryMethods must declare the same indexId, or the table is asserting
    // that one call hits two different indexes depending on who asked.
    const byMethods = new Map<string, Map<string, string[]>>();
    for (const [intent, recs] of Object.entries(RECOMMENDATIONS)) {
      for (const rec of recs) {
        const key = `${rec.backendId}:${[...rec.entryMethods].sort().join('+')}`;
        const seen = byMethods.get(key) ?? new Map<string, string[]>();
        seen.set(rec.indexId, [...(seen.get(rec.indexId) ?? []), intent]);
        byMethods.set(key, seen);
      }
    }
    const conflicts = [...byMethods.entries()]
      .filter(([, seen]) => seen.size > 1)
      .map(([key, seen]) => {
        const detail = [...seen.entries()].map(([id, intents]) => `${id} (${intents.join(', ')})`).join(' vs ');
        return `${key}: ${detail}`;
      });
    expect(conflicts).toEqual([]);
  });

  it('marks the Google SERP resellers so a search fan-out cannot mistake five providers for five indexes', () => {
    // The motivating case from the spec. If this ever reads 5, the reselling
    // claim has been edited out of the table and every downstream coverage
    // number silently overstates breadth by one.
    const search = recommendationsFor('search');
    expect(search).toHaveLength(5);
    expect(new Set(search.map((r) => r.indexId)).size).toBe(4);
    expect(search.filter((r) => r.indexId === 'google-serp').map((r) => r.backendId)).toEqual([
      'firecrawl',
      'geonode',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The reordering itself, tested on synthetic lists. It cannot be tested
// through `diversityOrder`, which reads the module table: on today's declared
// data every repeated indexId sits at the tail of its list, so the diversity
// order equals the declared order for every intent, deny-list and limit (see
// the characterization test at the end of this block). These inputs are the
// ones the table cannot currently produce -- and they are what a future
// declared entry on a shared index will look like.
// ---------------------------------------------------------------------------

function rec(backendId: string, indexId: string): Recommendation {
  return { backendId, displayName: backendId, tier: 'secondary', why: 'synthetic', entryMethods: [], indexId };
}

const ids = (recs: readonly Recommendation[]): string[] => recs.map((r) => r.backendId);

describe('orderByIndexDiversity', () => {
  it('promotes the first provider of an unseen index over the second of a seen one', () => {
    const ordered = orderByIndexDiversity([rec('a1', 'a'), rec('a2', 'a'), rec('b1', 'b')], 3);
    expect(ids(ordered)).toEqual(['a1', 'b1', 'a2']);
  });

  it('spends a truncated round on distinct indexes, not on the declared prefix', () => {
    // The whole point of the field: at width 2 the declared order would buy
    // index `a` twice.
    const ordered = orderByIndexDiversity([rec('a1', 'a'), rec('a2', 'a'), rec('b1', 'b')], 2);
    expect(ids(ordered)).toEqual(['a1', 'b1']);
  });

  it('round-robins two indexes that both repeat', () => {
    const declared = [rec('a1', 'a'), rec('a2', 'a'), rec('b1', 'b'), rec('b2', 'b')];
    expect(ids(orderByIndexDiversity(declared, 4))).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('supersedes the spec wording: the 4th call goes to the other index, not to the third of the first', () => {
    // declared a1,a2,a3,b1,b2 -- the spec's "continue down the declared order
    // for the remainder" would yield a1,b1,a2,a3,b2. Round-robin holds b2
    // ahead of a3 so every prefix stays as diverse as it can be.
    const declared = [rec('a1', 'a'), rec('a2', 'a'), rec('a3', 'a'), rec('b1', 'b'), rec('b2', 'b')];
    expect(ids(orderByIndexDiversity(declared, 5))).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('visits indexes in the declared order of each index FIRST provider', () => {
    const declared = [rec('b1', 'b'), rec('a1', 'a'), rec('b2', 'b'), rec('a2', 'a')];
    expect(ids(orderByIndexDiversity(declared, 4))).toEqual(['b1', 'a1', 'b2', 'a2']);
  });

  it('keeps declared rank order within one index', () => {
    const declared = [rec('a1', 'a'), rec('a2', 'a'), rec('a3', 'a'), rec('b1', 'b')];
    const ordered = ids(orderByIndexDiversity(declared, 99)).filter((id) => id.startsWith('a'));
    expect(ordered).toEqual(['a1', 'a2', 'a3']);
  });

  it('returns a permutation, not a truncation, when limit reaches the input length', () => {
    const declared = [rec('a1', 'a'), rec('a2', 'a'), rec('b1', 'b')];
    expect([...ids(orderByIndexDiversity(declared, 3))].sort()).toEqual(['a1', 'a2', 'b1']);
    expect([...ids(orderByIndexDiversity(declared, 99))].sort()).toEqual(['a1', 'a2', 'b1']);
  });

  it('returns nothing for a limit of zero or below, and nothing for an empty input', () => {
    const declared = [rec('a1', 'a'), rec('b1', 'b')];
    expect(orderByIndexDiversity(declared, 0)).toEqual([]);
    expect(orderByIndexDiversity(declared, -1)).toEqual([]);
    expect(orderByIndexDiversity([], 5)).toEqual([]);
  });
});

describe('diversityOrder', () => {
  it('takes one provider per distinct index before repeating an index', () => {
    const ordered = diversityOrder('search', 4, []);
    const indexes = ordered.map((r) => r.indexId);
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it('keeps declared rank order within one index', () => {
    const ordered = diversityOrder('search', 10, []);
    const declared = recommendationsFor('search').filter((r) => !r.notRecommended);
    const bySameIndex = (id: string) =>
      ordered.filter((r) => r.indexId === id).map((r) => r.backendId);
    for (const id of new Set(declared.map((r) => r.indexId))) {
      const declaredOrder = declared.filter((r) => r.indexId === id).map((r) => r.backendId);
      expect(bySameIndex(id)).toEqual(declaredOrder);
    }
  });

  it('returns a permutation of the declared list when limit exceeds it', () => {
    const declared = recommendationsFor('search').filter((r) => !r.notRecommended);
    const ordered = diversityOrder('search', 99, []);
    expect([...ordered].map((r) => r.backendId).sort()).toEqual(
      [...declared].map((r) => r.backendId).sort(),
    );
  });

  it('never returns a notRecommended or excluded provider', () => {
    const ordered = diversityOrder('social', 99, ['brightdata']);
    expect(ordered.some((r) => r.notRecommended)).toBe(false);
    expect(ordered.some((r) => r.backendId === 'brightdata')).toBe(false);
  });

  it('permutes the ELIGIBLE list, which is smaller than the declared one once anything is filtered', () => {
    // `social` declares apify, brightdata, xro(notRecommended). Deny-listing
    // brightdata leaves one eligible row: the result is a permutation of that
    // one, not of the declared three. The doc comment says eligible for this
    // reason -- a caller checking "did we reach everyone?" against the
    // declared list would conclude the fan-out failed.
    const declared = recommendationsFor('social');
    const eligible = declared.filter((r) => r.notRecommended === undefined && r.backendId !== 'brightdata');
    const ordered = diversityOrder('social', 99, ['brightdata']);
    expect(eligible.length).toBeLessThan(declared.length);
    expect([...ordered].map((r) => r.backendId).sort()).toEqual([...eligible].map((r) => r.backendId).sort());
  });

  it('coincides with the declared order on every intent, deny-list and limit -- a fact about the table, pinned', () => {
    // Today's ranking is already index-diverse-first: every repeated indexId
    // sits at the tail of its own list, so the round-robin never has anything
    // to promote. That makes `diversityOrder` observationally equal to a
    // filter+slice on the SHIPPED data, which is why the reordering is tested
    // through `orderByIndexDiversity` above instead.
    //
    // This test is the tripwire on that equality, not an endorsement of it.
    // The day a declared entry puts a shared index above an unseen one, this
    // fails -- and it should be deleted then, with the new expected order
    // written down, because at that point the fan-out really has started
    // choosing a different set of providers than the declared prefix.
    for (const intent of INTENTS) {
      const declared = recommendationsFor(intent);
      for (let mask = 0; mask < 1 << declared.length; mask += 1) {
        const excluded = declared.filter((_, i) => mask & (1 << i)).map((r) => r.backendId);
        const eligible = declared.filter(
          (r) => r.notRecommended === undefined && !isExcluded(r.backendId, excluded),
        );
        for (let limit = 0; limit <= declared.length + 1; limit += 1) {
          const label = `${intent} excluded=[${excluded.join(',')}] limit=${limit}`;
          expect(diversityOrder(intent, limit, excluded).map((r) => r.backendId), label).toEqual(
            eligible.slice(0, limit).map((r) => r.backendId),
          );
        }
      }
    }
  });
});
