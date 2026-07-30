import { describe, expect, it } from 'vitest';

import { BindingError, bindArgs } from '../src/engine/bindings.js';
import type { ToolCandidate } from '../src/engine/catalog.js';

// ---------------------------------------------------------------------------
// Fixture helper. Only the fields bindArgs actually reads vary per test; the
// rest are filled with harmless constants so every candidate is a valid
// ToolCandidate.
// ---------------------------------------------------------------------------

function candidate(overrides: Partial<ToolCandidate> & Pick<ToolCandidate, 'path' | 'httpMethod' | 'bindings'>): ToolCandidate {
  return {
    tool: 'backend_method',
    backendId: 'backend',
    method: 'method',
    protocol: 'http',
    description: '',
    inputSchema: {},
    userSettings: [],
    backendInfoText: '',
    billingModel: 'per_call',
    ...overrides,
  };
}

describe('bindArgs — path substitution', () => {
  it('substitutes a multi-segment value, preserving slashes as path separators', () => {
    const bound = bindArgs(
      candidate({ path: '/run/{model}', httpMethod: 'POST', bindings: { path_params: ['model'] } }),
      { model: 'fal-ai/flux/dev' },
    );
    expect(bound.path).toBe('/run/fal-ai/flux/dev');
  });

  it('leaves a single-segment value with a reserved-but-unescaped character (~) unaffected', () => {
    const bound = bindArgs(
      candidate({ path: '/actors/{id}/run', httpMethod: 'POST', bindings: { path_params: ['id'] } }),
      { id: 'janedoe~my-actor' },
    );
    expect(bound.path).toBe('/actors/janedoe~my-actor/run');
  });

  it('escapes reserved characters within a segment while keeping slashes as separators', () => {
    const bound = bindArgs(
      candidate({ path: '/run/{model}', httpMethod: 'POST', bindings: {} }),
      { model: 'john doe/model#1' },
    );
    expect(bound.path).toBe('/run/john%20doe/model%231');
  });

  it('removes a path parameter from the remaining args so it does not also land in query or body', () => {
    const bound = bindArgs(
      candidate({
        path: '/snapshots/{id}/data',
        httpMethod: 'GET',
        bindings: { path_params: ['id'] },
      }),
      { id: 'snap-1', extra: 'stays' },
    );
    expect(bound.path).toBe('/snapshots/snap-1/data');
    expect(bound.query).toEqual({ extra: 'stays' });
    expect(Object.hasOwn(bound.query, 'id')).toBe(false);
    expect(Object.hasOwn(bound, 'body')).toBe(false);
  });

  it('throws BindingError("missing-path-param") before any binding proceeds, for an absent/null/empty placeholder value', () => {
    const method = candidate({ path: '/snapshots/{id}/data', httpMethod: 'GET', bindings: {} });

    expect(() => bindArgs(method, {})).toThrow(BindingError);
    try {
      bindArgs(method, { id: null });
    } catch (err) {
      expect(err).toBeInstanceOf(BindingError);
      expect((err as BindingError).reason).toBe('missing-path-param');
      expect((err as BindingError).names).toEqual(['id']);
    }
    try {
      bindArgs(method, { id: '' });
    } catch (err) {
      expect((err as BindingError).reason).toBe('missing-path-param');
    }
  });
});

describe('bindArgs — query binding', () => {
  it('sends only the declared query-bound properties for a GET method', () => {
    const bound = bindArgs(
      candidate({ path: '/google/search', httpMethod: 'GET', bindings: { method: 'GET', query: ['query'] } }),
      { query: 'cats' },
    );
    expect(bound.query).toEqual({ query: 'cats' });
    expect(Object.hasOwn(bound, 'body')).toBe(false);
  });

  it('GET with no http block at all falls back to sending every remaining arg as a query parameter', () => {
    const bound = bindArgs(
      candidate({ path: '/scrape', httpMethod: 'GET', bindings: {} }),
      { url: 'https://example.com', render_js: 'true' },
    );
    expect(bound.query).toEqual({ url: 'https://example.com', render_js: 'true' });
    expect(Object.hasOwn(bound, 'body')).toBe(false);
  });

  it('throws BindingError("missing-query-param") only for a query-bound property input_schema marks required', () => {
    const method = candidate({
      path: '/google/search',
      httpMethod: 'GET',
      bindings: { method: 'GET', query: ['query', 'country'] },
      inputSchema: { type: 'object', required: ['query'] },
    });

    // "country" is declared but not required: absent is fine, not an error.
    const bound = bindArgs(method, { query: 'cats' });
    expect(bound.query).toEqual({ query: 'cats' });

    try {
      bindArgs(method, { country: 'US' });
    } catch (err) {
      expect(err).toBeInstanceOf(BindingError);
      expect((err as BindingError).reason).toBe('missing-query-param');
      expect((err as BindingError).names).toEqual(['query']);
    }
  });
});

describe('bindArgs — header binding', () => {
  it('sends only allow-listed headers, coerced to strings', () => {
    const bound = bindArgs(
      candidate({
        path: '/products/{product_id}',
        httpMethod: 'POST',
        bindings: { path_params: ['product_id'], header: ['x-render-js'] },
      }),
      { product_id: 'p1', 'x-render-js': true, fields: ['price'] },
    );
    expect(bound.headers).toEqual({ 'x-render-js': 'true' });
    expect(bound.body).toEqual({ fields: ['price'] });
  });

  it('refuses to bind Authorization via a manifest-declared header binding', () => {
    const method = candidate({ path: '/whatever', httpMethod: 'POST', bindings: { header: ['Authorization'] } });
    try {
      bindArgs(method, { Authorization: 'Bearer smuggled' });
      expect.unreachable('bindArgs should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BindingError);
      expect((err as BindingError).reason).toBe('disallowed-header');
      expect((err as BindingError).names).toEqual(['Authorization']);
    }
  });

  it('refuses to bind any X-Zug-* header via a manifest-declared header binding, case-insensitively', () => {
    const method = candidate({ path: '/whatever', httpMethod: 'POST', bindings: { header: ['x-zug-gw-user-id'] } });
    try {
      bindArgs(method, { 'x-zug-gw-user-id': 'user-42' });
      expect.unreachable('bindArgs should have thrown');
    } catch (err) {
      expect((err as BindingError).reason).toBe('disallowed-header');
      expect((err as BindingError).names).toEqual(['x-zug-gw-user-id']);
    }
  });

  it('refuses before touching args at all -- even when args supplies no value for the reserved header', () => {
    const method = candidate({ path: '/whatever', httpMethod: 'POST', bindings: { header: ['X-Zug-Trace'] } });
    expect(() => bindArgs(method, {})).toThrow(BindingError);
  });

  it('throws BindingError("missing-header-param") for a required header-bound property that is absent', () => {
    const method = candidate({
      path: '/whatever',
      httpMethod: 'POST',
      bindings: { header: ['x-api-version'] },
      inputSchema: { type: 'object', required: ['x-api-version'] },
    });
    try {
      bindArgs(method, {});
    } catch (err) {
      expect(err).toBeInstanceOf(BindingError);
      expect((err as BindingError).reason).toBe('missing-header-param');
      expect((err as BindingError).names).toEqual(['x-api-version']);
    }
  });
});

describe('bindArgs — body-source rule', () => {
  // Modeled on zug/internal/brightdatabackend/manifest.go's scrape_async:
  // POST, dataset_id (and friends) bound to query, and a request body that is
  // a wholly separate shape (an array of input records) input_schema does not
  // describe at all.
  const scrapeAsync = candidate({
    path: '/scrape_async',
    httpMethod: 'POST',
    bindings: {
      method: 'POST',
      query: ['dataset_id', 'format', 'type'],
      request_body: { description: 'Array of input records to scrape.' },
    },
    inputSchema: { type: 'object', required: ['dataset_id'] },
  });

  it('case 1 -- explicit --body-json wins verbatim over anything left in args', () => {
    const bound = bindArgs(
      scrapeAsync,
      { dataset_id: 'gd_l1vikfch', extraneous: 'dropped' },
      [{ url: 'https://example.com' }],
    );
    expect(bound.query).toEqual({ dataset_id: 'gd_l1vikfch' });
    expect(bound.body).toEqual([{ url: 'https://example.com' }]);
  });

  it('case 2 -- mixed shape: query params extracted, remaining unbound object becomes the body, and dataset_id is NOT duplicated into it', () => {
    const bound = bindArgs(scrapeAsync, {
      dataset_id: 'gd_l1vikfch',
      format: 'json',
      input: [{ url: 'https://example.com' }],
    });
    expect(bound.query).toEqual({ dataset_id: 'gd_l1vikfch', format: 'json' });
    expect(bound.body).toEqual({ input: [{ url: 'https://example.com' }] });
    expect(Object.hasOwn(bound.body as object, 'dataset_id')).toBe(false);
  });

  it('case 3 -- no mixed shape: a plain POST with no query/header binding sends the whole args object as the body', () => {
    const plainPost = candidate({ path: '/scrape', httpMethod: 'POST', bindings: {} });
    const bound = bindArgs(plainPost, { url: 'https://example.com', render_js: true });
    expect(bound.query).toEqual({});
    expect(bound.body).toEqual({ url: 'https://example.com', render_js: true });
  });

  it('never attaches a body to a GET request, even when args has unbound leftovers', () => {
    const method = candidate({ path: '/lookup', httpMethod: 'GET', bindings: { query: ['q'] } });
    const bound = bindArgs(method, { q: 'x', leftover: 'ignored-for-get' });
    expect(Object.hasOwn(bound, 'body')).toBe(false);
  });

  it('throws BindingError("missing-body-param") when a required, unbound property has nowhere to go', () => {
    try {
      bindArgs(scrapeAsync, { format: 'json' }); // dataset_id (query-bound, required) is absent
      expect.unreachable('bindArgs should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BindingError);
      expect((err as BindingError).reason).toBe('missing-query-param');
    }

    // A property required by input_schema, not consumed by path/query/header,
    // and absent from the args that would otherwise become the body.
    const needsBodyField = candidate({
      path: '/thing',
      httpMethod: 'POST',
      bindings: { query: ['id'] },
      inputSchema: { type: 'object', required: ['id', 'payload'] },
    });
    try {
      bindArgs(needsBodyField, { id: 'abc' });
      expect.unreachable('bindArgs should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BindingError);
      expect((err as BindingError).reason).toBe('missing-body-param');
      expect((err as BindingError).names).toEqual(['payload']);
    }
  });

  it('does not require a body field when --body-json is explicitly supplied (its shape may be intentionally non-object)', () => {
    const needsBodyField = candidate({
      path: '/thing',
      httpMethod: 'POST',
      bindings: { query: ['id'] },
      inputSchema: { type: 'object', required: ['id', 'payload'] },
    });
    const bound = bindArgs(needsBodyField, { id: 'abc' }, [1, 2, 3]);
    expect(bound.query).toEqual({ id: 'abc' });
    expect(bound.body).toEqual([1, 2, 3]);
  });
});
