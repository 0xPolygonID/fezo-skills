import { describe, expect, it } from 'vitest';

import type { ToolCandidate } from '../src/engine/catalog.js';
import { INTENTS, INTENT_DESCRIPTIONS, METHOD_INTENTS, classifyCandidate, classifyMethod } from '../src/engine/intent.js';

// ---------------------------------------------------------------------------
// Fixture helper — mirrors the convention in catalog.test.ts/preference.test.ts.
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
    inputSchema: {},
    userSettings: [],
    backendInfoText: '',
    backendCategories: [],
    billingModel: 'dynamic',
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// INTENTS / INTENT_DESCRIPTIONS — display-order and coverage sanity.
// ---------------------------------------------------------------------------

describe('INTENTS and INTENT_DESCRIPTIONS', () => {
  it('has exactly one description per declared intent, in the same set', () => {
    expect(Object.keys(INTENT_DESCRIPTIONS).sort()).toEqual([...INTENTS].sort());
  });

  it('lists "other" last, as the floor rather than a real capability', () => {
    expect(INTENTS[INTENTS.length - 1]).toBe('other');
  });

  it('freezes both tables so a caller cannot reorder them process-wide', () => {
    // Not decoration: providers.ts's `declaredIntentsFor` iterates INTENTS in
    // place of `Object.keys(RECOMMENDATIONS)`, so an in-place sort or splice
    // here would silently change what that function returns for every caller.
    // The declared types stay `Intent[]` / `Record<...>`, so TypeScript will
    // not flag the mutation — the runtime throw is the tripwire.
    expect(Object.isFrozen(INTENTS)).toBe(true);
    expect(Object.isFrozen(INTENT_DESCRIPTIONS)).toBe(true);
    expect(() => INTENTS.push('other')).toThrow(TypeError);
    expect(() => INTENTS.sort()).toThrow(TypeError);
    expect(INTENTS[INTENTS.length - 1]).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// classifyMethod — the four-layer classifier.
// ---------------------------------------------------------------------------

describe('classifyMethod', () => {
  it('hits the static METHOD_INTENTS table first, even when the method text looks like something else', () => {
    // brightdata_unlock is statically tagged ['scrape', 'social', 'proxy'];
    // its description below contains "search", which would otherwise trigger
    // the keyword fallback's `search` rule if the static table did not win.
    const result = classifyMethod('brightdata', {
      name: 'unlock',
      description: 'Unlock a URL; also usable to verify a search result page renders',
    });
    expect(result).toEqual(['scrape', 'social', 'proxy']);
  });

  it('falls back to a keyword rule for a method absent from METHOD_INTENTS', () => {
    expect(classifyMethod('acme', { name: 'crawl_site', description: 'Crawl an entire domain' })).toEqual(['crawl']);
    expect(classifyMethod('acme', { name: 'lookup', description: 'Search the catalog' })).toEqual(['search']);
    expect(classifyMethod('acme', { name: 'grab', description: 'Fetch and unlock a page' })).toEqual(['scrape']);
    expect(classifyMethod('acme', { name: 'digest', description: 'Latest news articles and events' })).toEqual([
      'news',
    ]);
    expect(classifyMethod('acme', { name: 'timeline', description: 'List a user\'s recent posts' })).toEqual([
      'social',
    ]);
  });

  it('checks the method name and path, not only the description, for keyword matches', () => {
    expect(classifyMethod('acme', { name: 'crawl', description: '' })).toEqual(['crawl']);
    expect(classifyMethod('acme', { name: 'op', path: '/v1/crawl/start', description: '' })).toEqual(['crawl']);
  });

  it('matches "ip" only as a whole token, never as a substring of ordinary words', () => {
    // The hazard the KEYWORD_RULES comment calls out by name: "shipping" and
    // "JavaScript" both contain the letters "ip", but neither is a proxy
    // capability. Both must fall through every keyword rule to "other" (no
    // other rule matches either description).
    expect(
      classifyMethod('acme', { name: 'op', description: 'Estimate multiple shipping options for the order' }),
    ).toEqual(['other']);
    expect(
      classifyMethod('acme', { name: 'op', description: 'Render the page after JavaScript executes' }),
    ).toEqual(['other']);

    // The whole-token spelling does match.
    expect(classifyMethod('acme', { name: 'op', description: 'Route the request through a residential ip' })).toEqual(
      ['proxy'],
    );
  });

  it('falls back to the backend category floor when no method-level signal exists', () => {
    expect(classifyMethod('acme', { name: 'op', description: '' }, ['Search'])).toEqual(['search']);
    expect(classifyMethod('acme', { name: 'op', description: '' }, ['Crawl'])).toEqual(['scrape', 'crawl']);
  });

  it('lands on "other" when nothing at all matches', () => {
    expect(classifyMethod('acme', { name: 'op', description: '' })).toEqual(['other']);
    expect(classifyMethod('acme', { name: 'op', description: '' }, ['Others'])).toEqual(['other']);
    expect(classifyMethod('acme', { name: 'op', description: '' }, [])).toEqual(['other']);
  });

  it('never throws and never returns an empty array, across every layer', () => {
    const cases: Array<[string, { name: string; path?: string; description?: string }, string[] | undefined]> = [
      ['you', { name: 'search' }, undefined],
      ['acme', { name: 'crawl_now' }, undefined],
      ['acme', { name: 'mystery' }, ['Search']],
      ['acme', { name: 'mystery' }, undefined],
    ];
    for (const [backendId, method, categories] of cases) {
      const result = classifyMethod(backendId, method, categories);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('returns a fresh array from the static table: mutating the result never corrupts METHOD_INTENTS', () => {
    const first = classifyMethod('you', { name: 'search' });
    first.push('proxy');
    const second = classifyMethod('you', { name: 'search' });
    expect(second).toEqual(['search', 'news']);
    expect(METHOD_INTENTS['you_search']).toEqual(['search', 'news']);
  });

  it('returns a fresh array from the category-fallback layer: mutating the result never corrupts CATEGORY_RULES', () => {
    const first = classifyMethod('acme', { name: 'op', description: '' }, ['Crawl']);
    first.push('other');
    const second = classifyMethod('acme', { name: 'op', description: '' }, ['Crawl']);
    expect(second).toEqual(['scrape', 'crawl']);
  });
});

// ---------------------------------------------------------------------------
// classifyCandidate — the fezo-native adapter over ToolCandidate.
// ---------------------------------------------------------------------------

describe('classifyCandidate', () => {
  it('classifies from the manifest METHOD name, not the derived TOOL name', () => {
    // If classifyCandidate mistakenly passed `candidate.tool`
    // ("you_search") as the method name, classifyMethod would rebuild
    // "you_you_search" -- absent from METHOD_INTENTS -- and fall through to
    // the keyword layer, which would still land on `search` by luck (the
    // substring "search" survives either way) but for the wrong reason. Use
    // a method whose tool-shaped name would NOT contain any keyword to catch
    // the mistake for real.
    const c = candidate({ backendId: 'you', method: 'search', description: 'no keyword here' });
    expect(classifyCandidate(c)).toEqual(['search', 'news']);
  });

  it('passes path, description and backendCategories through to classifyMethod', () => {
    const viaPath = candidate({ backendId: 'acme', method: 'op', path: '/v1/crawl/run', description: '' });
    expect(classifyCandidate(viaPath)).toEqual(['crawl']);

    const viaDescription = candidate({ backendId: 'acme', method: 'op', description: 'Search the index' });
    expect(classifyCandidate(viaDescription)).toEqual(['search']);

    const viaCategory = candidate({ backendId: 'acme', method: 'op', backendCategories: ['Search'] });
    expect(classifyCandidate(viaCategory)).toEqual(['search']);
  });
});
