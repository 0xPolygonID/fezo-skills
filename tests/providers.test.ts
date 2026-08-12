import { describe, expect, it } from 'vitest';

import { INTENTS, METHOD_INTENTS } from '../src/engine/intent.js';
import {
  RECOMMENDATIONS,
  declaredIntentsFor,
  displayNameFor,
  isExcluded,
  recommendationFor,
  recommendationsFor,
  resolveExcludedBackends,
} from '../src/engine/providers.js';
import type { Tier } from '../src/engine/providers.js';

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
    const bogus = { backendId: 'bogus', displayName: 'Bogus', tier: 'primary' as const, why: 'n/a', entryMethods: [] };
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
