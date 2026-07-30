import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CatalogFetchError, fetchCatalog, normalizeCatalog } from '../src/engine/catalog.js';
import type { ToolCandidate } from '../src/engine/catalog.js';
import {
  MAX_TOOL_NAME_LENGTH,
  TOOL_NAME_HASH_LENGTH,
  findCandidateByToolName,
  methodToToolName,
} from '../src/engine/tool-name.js';

// ---------------------------------------------------------------------------
// Fixtures — small, hand-written catalog documents, not transcriptions of any
// real gateway manifest. Shape follows zug/internal/gateway/catalog.go.
// ---------------------------------------------------------------------------

const wellFormedCatalog = {
  backends: [
    {
      backend_id: 'scraperapi',
      info: {
        title: 'ScraperAPI',
        summary: 'Web scraping proxy',
        categories: ['Search & crawl'],
      },
      billing: { model: 'per_call', price: '0.01' },
      user_settings: ['api_key'],
      methods: [
        {
          name: 'google_search',
          path: 'google/search',
          title: 'Google Search',
          description: 'Search Google via ScraperAPI',
          protocol: 'http',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          output_schema: { type: 'object' },
          http: { method: 'GET', query: ['query'] },
        },
        {
          name: 'scrape',
          description: 'Scrape a URL',
          input_schema: {
            type: 'object',
            properties: { url: { type: 'string' } },
          },
          // No `path`, `protocol`, or `http` block: exercises every default.
        },
        {
          name: 'crawl',
          protocol: 'grpc',
          description: 'Crawl a site (not HTTP — must be skipped)',
        },
      ],
    },
  ],
};

// wellFormedCatalog's `crawl` method has an unsupported protocol and always
// triggers a stderr warning on normalization; mock stderr for every test
// below so a deliberately-triggered warning never leaks into pristine test
// output.
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('normalizeCatalog', () => {
  it('normalizes a well-formed catalog into tool candidates', () => {
    const candidates = normalizeCatalog(wellFormedCatalog);

    // crawl (protocol grpc) is skipped, leaving google_search and scrape.
    expect(candidates).toHaveLength(2);

    const googleSearch = candidates.find((c) => c.method === 'google_search');
    expect(googleSearch).toBeDefined();
    expect(googleSearch).toMatchObject({
      tool: methodToToolName('scraperapi', 'google_search'),
      backendId: 'scraperapi',
      method: 'google_search',
      path: '/google/search',
      protocol: 'http',
      httpMethod: 'GET',
      title: 'Google Search',
      description: 'Search Google via ScraperAPI',
      userSettings: ['api_key'],
      billingModel: 'per_call',
    });
    expect(googleSearch?.bindings).toEqual({ method: 'GET', query: ['query'] });
    expect(googleSearch?.inputSchema).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
    expect(googleSearch?.outputSchema).toEqual({ type: 'object' });
    expect(googleSearch?.backendInfoText).toBe('ScraperAPI — Web scraping proxy — Categories: Search & crawl');
  });

  it('falls back path to the method name when `path` is absent, with a normalized leading slash', () => {
    const candidates = normalizeCatalog(wellFormedCatalog);
    const scrape = candidates.find((c) => c.method === 'scrape');
    expect(scrape).toBeDefined();
    expect(scrape?.path).toBe('/scrape');
  });

  it('defaults the verb to POST when `http.method` is absent (and there is no `http` block at all)', () => {
    const candidates = normalizeCatalog(wellFormedCatalog);
    const scrape = candidates.find((c) => c.method === 'scrape');
    expect(scrape).toBeDefined();
    expect(scrape?.httpMethod).toBe('POST');
    // Preserved binding metadata is empty, not fabricated — Task 4 owns
    // applying GET-query / POST-body placement defaults from this.
    expect(scrape?.bindings).toEqual({});
  });

  it('skips non-HTTP-protocol methods and warns on stderr, without a `title` property (absent, not undefined)', () => {
    const candidates = normalizeCatalog(wellFormedCatalog);
    expect(candidates.find((c) => c.method === 'crawl')).toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const [warning] = stderrSpy.mock.calls[0] as [string];
    expect(warning).toContain('crawl');
    expect(warning).toContain('grpc');

    const scrape = candidates.find((c) => c.method === 'scrape');
    expect(scrape).toBeDefined();
    expect(Object.hasOwn(scrape as ToolCandidate, 'title')).toBe(false);
  });

  it('retains user_settings and billing for every method of a backend', () => {
    const candidates = normalizeCatalog(wellFormedCatalog);
    for (const candidate of candidates) {
      expect(candidate.userSettings).toEqual(['api_key']);
      expect(candidate.billingModel).toBe('per_call');
    }
  });

  it('produces an empty list for a catalog with no backends, and skips malformed entries', () => {
    expect(normalizeCatalog({ backends: [] })).toEqual([]);
    expect(normalizeCatalog({})).toEqual([]);
    expect(normalizeCatalog(null)).toEqual([]);
    // A backend missing backend_id, and a method missing name, are both
    // unrecoverable (no identity to build a tool name from) and are skipped
    // rather than throwing.
    expect(
      normalizeCatalog({
        backends: [
          { billing: { model: 'per_call' }, methods: [{ description: 'no name' }] },
          { backend_id: 'ok', billing: { model: 'dynamic' }, methods: [{ name: 'm' }] },
        ],
      }),
    ).toHaveLength(1);
  });
});

describe('fetchCatalog', () => {
  it('fetches with a bearer token and normalizes the response', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://gateway.example.com/v1/catalog');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
      return new Response(JSON.stringify(wellFormedCatalog), { status: 200 });
    });

    const candidates = await fetchCatalog({
      baseUrl: 'https://gateway.example.com/',
      apiKey: 'secret-key',
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(candidates).toHaveLength(2);
  });

  it('throws CatalogFetchError with status and raw body on a non-2xx response', async () => {
    const fetchFn = vi.fn(
      async () => new Response('{"error":{"code":"unauthorized"}}', { status: 401 }),
    );

    await expect(
      fetchCatalog({ baseUrl: 'https://gateway.example.com', apiKey: 'bad', fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toMatchObject({
      status: 401,
      body: '{"error":{"code":"unauthorized"}}',
    });
  });

  it('throws CatalogFetchError on an unparseable 2xx body', async () => {
    const fetchFn = vi.fn(async () => new Response('not json', { status: 200 }));

    let caught: unknown;
    try {
      await fetchCatalog({ baseUrl: 'https://gateway.example.com', apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CatalogFetchError);
    expect((caught as CatalogFetchError).status).toBe(200);
    expect((caught as CatalogFetchError).body).toBe('not json');
  });
});

// ---------------------------------------------------------------------------
// Tool-name sanitization / hash-capping / resolve-by-rebuild.
// ---------------------------------------------------------------------------

describe('methodToToolName', () => {
  it('sanitizes characters outside [a-zA-Z0-9_-] to underscore', () => {
    expect(methodToToolName('my backend!', 'do.thing')).toBe('my_backend__do_thing');
  });

  it('returns the sanitized name unchanged at exactly MAX_TOOL_NAME_LENGTH', () => {
    const backendId = 'a'.repeat(30);
    const methodName = 'b'.repeat(33); // 30 + 1 ('_') + 33 = 64
    const raw = `${backendId}_${methodName}`;
    expect(raw).toHaveLength(MAX_TOOL_NAME_LENGTH);

    const name = methodToToolName(backendId, methodName);
    expect(name).toBe(raw);
    expect(name).toHaveLength(MAX_TOOL_NAME_LENGTH);
  });

  it('hash-caps a name one character over MAX_TOOL_NAME_LENGTH', () => {
    const backendId = 'a'.repeat(30);
    const methodName = 'b'.repeat(34); // 30 + 1 + 34 = 65
    const raw = `${backendId}_${methodName}`;
    expect(raw).toHaveLength(MAX_TOOL_NAME_LENGTH + 1);

    const name = methodToToolName(backendId, methodName);
    const expectedHash = createHash('sha256').update(raw).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
    const expectedPrefix = raw.slice(0, MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1);

    expect(name).toHaveLength(MAX_TOOL_NAME_LENGTH);
    expect(name).toBe(`${expectedPrefix}-${expectedHash}`);
  });
});

describe('resolve-by-rebuild', () => {
  it('resolves a tool name back to its candidate for underscore-heavy backend/method names', () => {
    // backend `scraperapi` with method `google_search`, as called out in the
    // brief: both halves already contain underscores, so a naive split on
    // `_` is not a reliable way to recover them.
    const candidates: Array<Pick<ToolCandidate, 'backendId' | 'method'>> = [
      { backendId: 'scraperapi', method: 'google_search' },
      { backendId: 'firecrawl', method: 'scrape' },
    ];

    const toolName = methodToToolName('scraperapi', 'google_search');
    const resolved = findCandidateByToolName(candidates, toolName);
    expect(resolved).toEqual({ backendId: 'scraperapi', method: 'google_search' });
  });

  it('is not fooled by two different (backendId, method) pairs that share the same joined string', () => {
    // "scraper_api" + "_" + "google_search"  ===  "scraper" + "_" + "api_google_search"
    // Splitting the resulting tool name on `_` cannot tell these apart; only
    // rebuilding from a known candidate list can.
    const a = { backendId: 'scraper_api', method: 'google_search' };
    const b = { backendId: 'scraper', method: 'api_google_search' };
    expect(methodToToolName(a.backendId, a.method)).toBe(methodToToolName(b.backendId, b.method));

    const toolName = methodToToolName(a.backendId, a.method);
    // Both are legitimate matches for the ambiguous string; the point of
    // findCandidateByToolName is that it resolves from a concrete candidate
    // list (here, only `a` is present) rather than parsing the string.
    const resolved = findCandidateByToolName([a], toolName);
    expect(resolved).toEqual(a);
    expect(findCandidateByToolName([b], toolName)).toEqual(b);
  });
});
