// The aggregation layer against REAL provider responses, captured from the
// live gateway by `build/capture-responses.mjs`.
//
// Why this suite exists separately from aggregate.test.ts: every other test of
// the sniffer feeds it a shape someone imagined. These are the shapes providers
// actually return, and they are the only evidence that `RESPONSE_ADAPTERS` is
// still allowed to be empty. A provider whose body the sniffer cannot read is a
// provider that is billed and contributes nothing — the failure this suite is
// here to make loud.
//
// Refreshing: re-run `FEZO_API_KEY=... node build/capture-responses.mjs`. That
// bills one call per tool, so do it deliberately, not on a whim.

import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { extractItems, mergeItems } from '../src/engine/aggregate.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures', 'responses');
const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json'));

/**
 * What each captured body actually contains, transcribed from the capture run.
 *
 * Exact counts, not `> 0`: an assertion that merely wants "some items" cannot
 * tell a healthy fixture from a degraded one. Replacing a 19-result body with
 * a one-result error envelope -- exactly what a re-capture against a rate
 * limited or out-of-credit account produces -- passed the earlier version of
 * this suite unnoticed, which would have made the calibration a rubber stamp.
 *
 * `dated` is here because the first calibration shipped these fixtures while
 * silently dropping every date on three of the six providers: the sniffer read
 * their URLs and titles, nobody checked their dates, and the spec then claimed
 * it "read every captured body". A count assertion would not have caught that
 * either -- only asserting the FIELDS does.
 */
const EXPECTED: Record<string, { items: number; dated: boolean }> = {
  brave_news: { items: 20, dated: true },
  brave_search: { items: 19, dated: true },
  exa_search: { items: 10, dated: true },
  firecrawl_search: { items: 10, dated: false },
  geonode_search: { items: 19, dated: false },
  you_search: { items: 10, dated: true },
};

describe('extractItems against captured provider responses', () => {
  it('has fixtures to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const tool = basename(file, '.json');
    const body: unknown = JSON.parse(readFileSync(join(fixtureDir, file), 'utf8'));

    it(`reads results from ${tool}`, () => {
      const items = extractItems(tool, body);
      expect(items.length, `${tool} yielded no items — write an adapter for it`).toBeGreaterThan(0);
      const expected = EXPECTED[tool];
      expect(expected, `${tool} has no entry in EXPECTED — add one when adding a fixture`).toBeDefined();
      // Exact: a fixture re-captured against an error or a rate limit shrinks,
      // and a shrunken fixture must fail rather than quietly weaken this suite.
      expect(items.length, `${tool} yielded ${String(items.length)} items, expected ${String(expected?.items)}`)
        .toBe(expected?.items);
    });

    it(`reads publication dates from ${tool} when the provider sends them`, () => {
      const items = extractItems(tool, body);
      const dated = items.filter((i) => i.publishedAt !== undefined).length;
      if (EXPECTED[tool]?.dated === true) {
        // Most results, not all: a provider legitimately omits a date for a
        // page it could not date. Zero means the field name is missing from
        // FIELD_CANDIDATES, which is the defect this pins.
        expect(dated, `${tool} dropped every date — check FIELD_CANDIDATES.publishedAt`).toBeGreaterThan(0);
      } else {
        // The negative side matters as much, and its absence made the whole
        // assertion one-sided: flipping an entry to `dated: false` silenced the
        // check rather than failing it, so a date regression could be "fixed"
        // by editing a boolean. It also pins that no newly-added candidate
        // field name has started reading the wrong key on a provider that
        // genuinely sends none.
        expect(dated, `${tool} newly reads dates — update EXPECTED rather than the code`).toBe(0);
      }
    });

    it(`reads well-formed URLs from ${tool}`, () => {
      for (const item of extractItems(tool, body)) {
        expect(item.url, `${tool} produced a non-http URL`).toMatch(/^https?:\/\//);
      }
    });

    it(`does not read navigation or metadata as results from ${tool}`, () => {
      // A real body carries related searches, thumbnails and favicons. If the
      // count is wildly above what a single page of results holds, the sniffer
      // has latched onto the wrong array — the failure MAJOR 1 was about.
      expect(extractItems(tool, body).length).toBeLessThanOrEqual(50);
    });
  }
});

describe('merging captured responses across providers', () => {
  it('produces one ranked, attributed set from every provider at once', () => {
    const lanes = files.map((file, index) => ({
      backendId: basename(file, '.json'),
      rank: index + 1,
      items: extractItems(basename(file, '.json'), JSON.parse(readFileSync(join(fixtureDir, file), 'utf8'))),
    }));
    const { items } = mergeItems(lanes);
    expect(items.length).toBeGreaterThan(0);
    // Every item names at least one real provider, and the set is ordered.
    for (const item of items) expect(item.providers.length).toBeGreaterThan(0);
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i - 1]!.score).toBeGreaterThanOrEqual(items[i]!.score);
    }
  });
});
