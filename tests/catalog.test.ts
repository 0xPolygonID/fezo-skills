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
// real gateway manifest. Shape follows the gateway's catalog document.
// ---------------------------------------------------------------------------

// `product_detail`'s http block is the full binding surface: query,
// path_params, header, request_body and response_body. Task 4 (bindings.ts)
// decides argument placement from exactly these fields, so this module's only
// job is to hand them over byte-for-byte — hence the deep round-trip
// assertion below rather than a spot check.
const productDetailHttp = {
  method: 'POST',
  query: ['country'],
  path_params: ['product_id'],
  header: ['x_render_js'],
  request_body: {
    description: 'Product lookup options',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { fields: { type: 'array', items: { type: 'string' } } },
          required: ['fields'],
        },
      },
    },
  },
  response_body: {
    content: {
      'application/json': { schema: { type: 'object', properties: { price: { type: 'number' } } } },
    },
  },
};

const wellFormedCatalog = {
  backends: [
    {
      backend_id: 'scraperapi',
      info: {
        title: 'ScraperAPI',
        summary: 'Web scraping proxy',
        docs_url: 'https://docs.example.com/scrape',
        categories: ['Search & crawl'],
        version: '2.1.0',
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
          name: 'product_detail',
          path: '/products/{product_id}',
          title: 'Product Detail',
          description: 'Fetch one product by id',
          protocol: 'http',
          input_schema: {
            type: 'object',
            properties: { product_id: { type: 'string' } },
            required: ['product_id'],
          },
          http: productDetailHttp,
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

/** Every line written to stderr so far, in order. */
function stderrWarnings(): string[] {
  return (stderrSpy.mock.calls as unknown as unknown[][]).map((call) => String(call[0]));
}

describe('normalizeCatalog', () => {
  it('normalizes a well-formed catalog into tool candidates', () => {
    const candidates = normalizeCatalog(wellFormedCatalog);

    // crawl (protocol grpc) is skipped, leaving google_search,
    // product_detail and scrape.
    expect(candidates).toHaveLength(3);

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
  });

  it('preserves every HTTP binding field verbatim, including path_params, header and request/response bodies', () => {
    const candidates = normalizeCatalog(wellFormedCatalog);
    const productDetail = candidates.find((c) => c.method === 'product_detail');
    expect(productDetail).toBeDefined();
    expect(productDetail).toMatchObject({
      path: '/products/{product_id}',
      httpMethod: 'POST',
      title: 'Product Detail',
    });

    // Deep equality against the fixture's own http block: any field this
    // module drops, renames, or reshapes fails here. Design principle 5
    // ("respect manifest HTTP bindings") depends on this round-trip, and
    // Task 4 has nothing to bind from if it regresses.
    expect(productDetail?.bindings).toEqual(productDetailHttp);
    expect(productDetail?.bindings.path_params).toEqual(['product_id']);
    expect(productDetail?.bindings.header).toEqual(['x_render_js']);
    expect(productDetail?.bindings.request_body?.description).toBe('Product lookup options');
    expect(productDetail?.bindings.request_body?.content?.['application/json']?.schema).toEqual({
      type: 'object',
      properties: { fields: { type: 'array', items: { type: 'string' } } },
      required: ['fields'],
    });
    expect(productDetail?.bindings.response_body?.content?.['application/json']?.schema).toEqual({
      type: 'object',
      properties: { price: { type: 'number' } },
    });
  });

  it('renders backendInfoText as exactly the info title, summary and description', () => {
    // The searchable-fields rule fixes this to title/summary/description only.
    // `docs_url`, `categories` and `version` are all present in the fixture
    // and must not appear: a docs URL ending in "/scrape" would otherwise
    // make every method of this backend a substring match for "scrape", and a
    // literal "Docs"/"Categories" label would match on every backend.
    const candidates = normalizeCatalog(wellFormedCatalog);
    const googleSearch = candidates.find((c) => c.method === 'google_search');
    expect(googleSearch?.backendInfoText).toBe('ScraperAPI — Web scraping proxy');

    expect(googleSearch?.backendInfoText).not.toContain('Docs');
    expect(googleSearch?.backendInfoText).not.toContain('docs.example.com');
    expect(googleSearch?.backendInfoText).not.toContain('Categories');
    expect(googleSearch?.backendInfoText).not.toContain('Search & crawl');
    expect(googleSearch?.backendInfoText).not.toContain('2.1.0');
  });

  it('carries backend.info.categories on the candidate as backendCategories, absent from backendInfoText', () => {
    const candidates = normalizeCatalog(wellFormedCatalog);
    const googleSearch = candidates.find((c) => c.method === 'google_search');
    // The fixture's `info.categories` is ['Search & crawl'] (see wellFormedCatalog above).
    expect(googleSearch?.backendCategories).toEqual(['Search & crawl']);
    // backendInfoText's contents are fixed to title/summary/description only
    // (see the earlier test); a category name must never leak into it.
    expect(googleSearch?.backendInfoText).not.toContain('Search & crawl');
  });

  it('defaults backendCategories to [] when the catalog declares no categories', () => {
    const candidates = normalizeCatalog({
      backends: [{ backend_id: 'noinfo', methods: [{ name: 'm' }] }],
    });
    expect(candidates[0]?.backendCategories).toEqual([]);
  });

  it('includes info.description in backendInfoText and omits absent parts without leaving separators', () => {
    const candidates = normalizeCatalog({
      backends: [
        {
          backend_id: 'full',
          info: { title: 'Full', summary: 'Sum', description: 'Desc' },
          methods: [{ name: 'm' }],
        },
        {
          backend_id: 'sparse',
          info: { description: 'Only a description' },
          methods: [{ name: 'm' }],
        },
        { backend_id: 'noinfo', methods: [{ name: 'm' }] },
      ],
    });
    expect(candidates.map((c) => c.backendInfoText)).toEqual([
      'Full — Sum — Desc',
      'Only a description',
      '',
    ]);
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

  it('warns on stderr for every skipped malformed entry, so a vanished provider leaves a trace', () => {
    const candidates = normalizeCatalog({
      backends: [
        'not-an-object',
        { billing: { model: 'per_call' }, methods: [{ name: 'orphan' }] },
        { backend_id: 'partly_ok', methods: [{ name: 'good' }, { description: 'no name' }, 42] },
      ],
    });
    expect(candidates.map((c) => c.method)).toEqual(['good']);

    const warnings = stderrWarnings();
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('index 0');
    expect(warnings[0]).toContain('not an object');
    expect(warnings[1]).toContain('index 1');
    expect(warnings[1]).toContain('backend_id');
    expect(warnings[2]).toContain('partly_ok');
    expect(warnings[2]).toContain('"name"');
    expect(warnings[3]).toContain('partly_ok');
    expect(warnings[3]).toContain('not an object');
    for (const warning of warnings) {
      expect(warning.startsWith('fezoctl: skipping ')).toBe(true);
      expect(warning.endsWith('\n')).toBe(true);
    }
  });

  it('treats an empty-string protocol as absent, not as an unsupported protocol', () => {
    const candidates = normalizeCatalog({
      backends: [{ backend_id: 'b', methods: [{ name: 'm', protocol: '' }] }],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.protocol).toBe('http');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('warns when http.method is neither GET nor POST, and still defaults to POST', () => {
    const candidates = normalizeCatalog({
      backends: [
        {
          backend_id: 'b',
          methods: [
            { name: 'replace', http: { method: 'PUT' } },
            { name: 'remove', http: { method: 'DELETE' } },
            { name: 'lower_get', http: { method: 'get' } },
            { name: 'lower_post', http: { method: 'post' } },
            { name: 'blank', http: { method: '' } },
          ],
        },
      ],
    });
    expect(candidates.map((c) => c.httpMethod)).toEqual(['POST', 'POST', 'GET', 'POST', 'POST']);
    // The declared verb is preserved on `bindings` even when coerced.
    expect(candidates[0]?.bindings.method).toBe('PUT');

    // Only the two unrecognized verbs warn: a case-insensitive GET/POST is
    // recognized, and an absent/blank verb is the specified POST default.
    const warnings = stderrWarnings();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('b.replace');
    expect(warnings[0]).toContain('"PUT"');
    expect(warnings[0]).toContain('POST');
    expect(warnings[1]).toContain('b.remove');
    expect(warnings[1]).toContain('"DELETE"');
  });
});

describe('parseHttpBody degradation paths', () => {
  it('preserves boolean JSON Schemas (`true`/`false` are legal JSON Schema 2020-12)', () => {
    const candidates = normalizeCatalog({
      backends: [
        {
          backend_id: 'b',
          methods: [
            {
              name: 'm',
              http: {
                request_body: { content: { 'application/json': { schema: true } } },
                response_body: { content: { 'application/json': { schema: false } } },
              },
            },
          ],
        },
      ],
    });

    const bindings = candidates[0]?.bindings;
    // `false` in particular must survive: dropping it would turn "no body
    // permitted" into "body declared with no schema".
    expect(bindings?.request_body?.content?.['application/json']).toEqual({ schema: true });
    expect(bindings?.response_body?.content?.['application/json']).toEqual({ schema: false });
  });

  it('drops garbled media-type entries instead of reporting them as schema-less bodies', () => {
    const candidates = normalizeCatalog({
      backends: [
        {
          backend_id: 'b',
          methods: [
            {
              name: 'm',
              http: {
                request_body: {
                  content: {
                    'application/json': 'not-an-object',
                    'text/plain': ['also-not-an-object'],
                    'application/octet-stream': null,
                    // Declared with no schema — genuinely a body, and must be
                    // distinguishable from the garbled entries above.
                    'text/csv': {},
                    // Declared with a non-schema `schema` value: the media
                    // type is real, the schema is not.
                    'application/x-www-form-urlencoded': { schema: 'nope' },
                    'application/xml': { schema: { type: 'string' } },
                  },
                },
              },
            },
          ],
        },
      ],
    });

    const content = candidates[0]?.bindings.request_body?.content;
    expect(content).toEqual({
      'text/csv': {},
      'application/x-www-form-urlencoded': {},
      'application/xml': { schema: { type: 'string' } },
    });
    // Absent, not present-and-empty: the binding logic must not see a body
    // media type the catalog never described.
    expect(Object.hasOwn(content ?? {}, 'application/json')).toBe(false);
    expect(Object.hasOwn(content ?? {}, 'text/plain')).toBe(false);
    expect(Object.hasOwn(content ?? {}, 'application/octet-stream')).toBe(false);
    // Present, with `schema` absent rather than set to undefined.
    expect(Object.hasOwn(content?.['text/csv'] ?? {}, 'schema')).toBe(false);
  });

  it('distinguishes an absent body, a body with no content, and a garbled body', () => {
    const candidates = normalizeCatalog({
      backends: [
        {
          backend_id: 'b',
          methods: [
            { name: 'absent', http: { method: 'POST' } },
            { name: 'no_content', http: { request_body: { description: 'opaque' } } },
            { name: 'empty_content', http: { request_body: { content: {} } } },
            { name: 'garbled', http: { request_body: 'nonsense' } },
          ],
        },
      ],
    });
    const byMethod = new Map(candidates.map((c) => [c.method, c.bindings]));

    expect(Object.hasOwn(byMethod.get('absent') ?? {}, 'request_body')).toBe(false);
    expect(byMethod.get('no_content')?.request_body).toEqual({ description: 'opaque' });
    expect(Object.hasOwn(byMethod.get('no_content')?.request_body ?? {}, 'content')).toBe(false);
    expect(byMethod.get('empty_content')?.request_body).toEqual({ content: {} });
    expect(Object.hasOwn(byMethod.get('garbled') ?? {}, 'request_body')).toBe(false);
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

    expect(candidates).toHaveLength(3);
  });

  it('throws CatalogFetchError with reason "status", status and raw body on a non-2xx response', async () => {
    const fetchFn = vi.fn(
      async () => new Response('{"error":{"code":"unauthorized"}}', { status: 401 }),
    );

    await expect(
      fetchCatalog({ baseUrl: 'https://gateway.example.com', apiKey: 'bad', fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toMatchObject({
      reason: 'status',
      status: 401,
      body: '{"error":{"code":"unauthorized"}}',
      message: 'catalog fetch failed with status 401',
    });
  });

  it('throws CatalogFetchError with reason "parse" on an unparseable 2xx body, without claiming the status failed', async () => {
    const fetchFn = vi.fn(async () => new Response('not json', { status: 200 }));

    let caught: unknown;
    try {
      await fetchCatalog({ baseUrl: 'https://gateway.example.com', apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CatalogFetchError);
    expect((caught as CatalogFetchError).reason).toBe('parse');
    expect((caught as CatalogFetchError).status).toBe(200);
    expect((caught as CatalogFetchError).body).toBe('not json');
    // Task 8's CLI shows this message to users, so "failed with status 200"
    // would be an untrue diagnostic for a gateway that answered successfully.
    expect((caught as CatalogFetchError).message).toBe(
      'catalog response with status 200 could not be parsed as JSON',
    );
    expect((caught as CatalogFetchError).message).not.toContain('failed with status');
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

  it('hashes the raw (unsanitized) name, not the sanitized one, when hash-capping', () => {
    // MCP wire compatibility: the reference MCP server truncates the
    // *sanitized* string but hashes the *raw* one. The all-`a`/`b` case above
    // cannot see the difference (there, raw === sanitized), so this case
    // carries a character outside [a-zA-Z0-9_-] to pin the distinction.
    const backendId = 'my backend'; // the space is sanitized to `_`
    const methodName = 'x'.repeat(60);
    const raw = `${backendId}_${methodName}`;
    const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');

    expect(raw.length).toBeGreaterThan(MAX_TOOL_NAME_LENGTH);
    expect(sanitized).not.toBe(raw);

    const hashOfRaw = createHash('sha256').update(raw).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
    const hashOfSanitized = createHash('sha256')
      .update(sanitized)
      .digest('hex')
      .slice(0, TOOL_NAME_HASH_LENGTH);
    // Guard the guard: if these ever collided the assertion below would pass
    // for the wrong reason.
    expect(hashOfRaw).not.toBe(hashOfSanitized);

    const name = methodToToolName(backendId, methodName);
    const expectedPrefix = sanitized.slice(0, MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1);
    expect(name).toBe(`${expectedPrefix}-${hashOfRaw}`);
    expect(name.endsWith(hashOfSanitized)).toBe(false);
    expect(name).toHaveLength(MAX_TOOL_NAME_LENGTH);
    // The truncated prefix is sanitized (no raw space survives), while the
    // hash comes from the raw string — both halves asserted.
    expect(name).not.toContain(' ');
    expect(name.startsWith('my_backend_')).toBe(true);
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
