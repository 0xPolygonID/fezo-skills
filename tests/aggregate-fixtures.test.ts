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
