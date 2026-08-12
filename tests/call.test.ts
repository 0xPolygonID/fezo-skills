import { describe, expect, it, vi } from 'vitest';

import { BindingError } from '../src/engine/bindings.js';
import type { ToolCandidate } from '../src/engine/catalog.js';
import { GatewayCallError, callTool } from '../src/engine/client.js';
import { parseCallError } from '../src/engine/errors.js';
import { captureStderrAsync as captureStderr } from './helpers.js';

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
    backendCategories: [],
    billingModel: 'per_call',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// errors.ts — gateway envelope vs. backend passthrough discrimination.
// ---------------------------------------------------------------------------

describe('parseCallError', () => {
  it('recognizes the gateway envelope shape ({error:{code,message}}) and extracts code/message', () => {
    const result = parseCallError(401, '{"error":{"code":"unauthorized","message":"bad key"}}');
    expect(result).toEqual({ kind: 'gateway', status: 401, code: 'unauthorized', message: 'bad key' });
  });

  it('preserves a backend passthrough body verbatim, without synthesizing a code', () => {
    // FastAPI-shaped error, as a proxied backend might actually return.
    const body = '{"detail":"dataset_id is required"}';
    const result = parseCallError(400, body);
    expect(result).toEqual({ kind: 'backend', status: 400, body });
    expect((result as { code?: unknown }).code).toBeUndefined();
  });

  it('treats an "error" object missing code or message as a backend passthrough, not a partial gateway envelope', () => {
    const body = '{"error":{"message":"only a message"}}';
    const result = parseCallError(500, body);
    expect(result).toEqual({ kind: 'backend', status: 500, body });
  });

  it('treats unparseable JSON as a backend passthrough, keeping the raw text', () => {
    const body = 'internal server error (plain text)';
    const result = parseCallError(502, body);
    expect(result).toEqual({ kind: 'backend', status: 502, body });
  });
});

// ---------------------------------------------------------------------------
// client.ts — request construction and response classification.
// ---------------------------------------------------------------------------

describe('callTool', () => {
  it('sends a GET with declared query bindings, a bearer token, and no body', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://gw.example.com/v1/scraperapi/google/search?query=cats');
      expect(init?.method).toBe('GET');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer secret-key');
      expect(headers['Content-Type']).toBeUndefined();
      expect(init?.body).toBeUndefined();
      return new Response('{"results":[]}', { status: 200 });
    });

    const result = await callTool({
      baseUrl: 'https://gw.example.com/',
      apiKey: 'secret-key',
      candidate: candidate({
        backendId: 'scraperapi',
        path: '/google/search',
        httpMethod: 'GET',
        bindings: { method: 'GET', query: ['query'] },
      }),
      args: { query: 'cats' },
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ status: 200, bodyText: '{"results":[]}' });
  });

  it('drops a leftover, unbound arg from the query string on a GET when `query` IS declared (not the flat-GET-query bug)', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      // Only the declared "query" param reaches the wire; "extra" (not in
      // bindings.query) does not silently become a second query parameter --
      // that is exactly the reference MCP server's flat GET-query bug this
      // engine exists to avoid (see bindings.ts's file comment).
      expect(String(url)).toBe('https://gw.example.com/v1/scraperapi/google/search?query=cats');
      expect(init?.body).toBeUndefined();
      return new Response('{}', { status: 200 });
    });

    // bindArgs warns on stderr about the dropped, unbound "extra" arg (a GET
    // has nowhere to put it) -- captured and asserted, not muted.
    const stderr = await captureStderr(async () => {
      await callTool({
        baseUrl: 'https://gw.example.com',
        apiKey: 'k',
        candidate: candidate({
          backendId: 'scraperapi',
          path: '/google/search',
          httpMethod: 'GET',
          bindings: { method: 'GET', query: ['query'] },
        }),
        args: { query: 'cats', extra: 'unbound' },
        fetchFn: fetchFn as unknown as typeof fetch,
      });
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(stderr).toContain('not sending argument(s) extra');
  });

  it('percent-encodes a query value needing escaping, via URLSearchParams', async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      // `URLSearchParams` encodes a space as "+" and "&"/"=" as their percent
      // escapes, so this pins the actual wire encoding rather than just
      // trusting that "some encoding" happened.
      expect(String(url)).toBe('https://gw.example.com/v1/scraperapi/google/search?query=cats+%26+dogs%3D2');
      return new Response('{}', { status: 200 });
    });

    await callTool({
      baseUrl: 'https://gw.example.com',
      apiKey: 'k',
      candidate: candidate({
        backendId: 'scraperapi',
        path: '/google/search',
        httpMethod: 'GET',
        bindings: { method: 'GET', query: ['query'] },
      }),
      args: { query: 'cats & dogs=2' },
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sends the whole args object as the JSON body for a POST with no `http` block at all', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://gw.example.com/v1/backend/thing');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(init?.body).toBe(JSON.stringify({ url: 'https://example.com', render_js: true }));
      return new Response('{}', { status: 200 });
    });

    await callTool({
      baseUrl: 'https://gw.example.com',
      apiKey: 'k',
      candidate: candidate({ backendId: 'backend', path: '/thing', httpMethod: 'POST', bindings: {} }),
      args: { url: 'https://example.com', render_js: true },
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sends a mixed POST with dataset_id in the query string and a distinct JSON body (brightdata scrape_async shape)', async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://gw.example.com/v1/brightdata/scrape_async?dataset_id=gd_l1vikfch');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(init?.body).toBe(JSON.stringify([{ url: 'https://example.com' }]));
      return new Response('{"snapshot_id":"s_1"}', { status: 200 });
    });

    const result = await callTool({
      baseUrl: 'https://gw.example.com',
      apiKey: 'k',
      candidate: candidate({
        backendId: 'brightdata',
        path: '/scrape_async',
        httpMethod: 'POST',
        bindings: { method: 'POST', query: ['dataset_id'], request_body: { description: 'records' } },
      }),
      args: { dataset_id: 'gd_l1vikfch' },
      bodyJson: [{ url: 'https://example.com' }],
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.status).toBe(200);
  });

  it('substitutes a multi-segment path placeholder end to end', async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://gw.example.com/v1/falai/run/fal-ai/flux/dev');
      return new Response('{}', { status: 200 });
    });

    await callTool({
      baseUrl: 'https://gw.example.com',
      apiKey: 'k',
      candidate: candidate({
        backendId: 'falai',
        path: '/run/{model}',
        httpMethod: 'POST',
        bindings: { path_params: ['model'] },
      }),
      args: { model: 'fal-ai/flux/dev', prompt: 'a cat' },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sends only allow-listed headers, in addition to Authorization', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers).toEqual({
        Authorization: 'Bearer k',
        'Content-Type': 'application/json',
        'x-render-js': 'true',
      });
      return new Response('{}', { status: 200 });
    });

    await callTool({
      baseUrl: 'https://gw.example.com',
      apiKey: 'k',
      candidate: candidate({
        backendId: 'b',
        path: '/products/{id}',
        httpMethod: 'POST',
        bindings: { path_params: ['id'], header: ['x-render-js'] },
      }),
      args: { id: 'p1', 'x-render-js': true, fields: ['price'] },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    // REQUIRED, not decorative: the only `expect` above is INSIDE the fetch
    // mock, so without this the test passes having asserted nothing whenever
    // `callTool` returns without calling fetch — which is exactly what the three
    // `BindingError` tests below prove it does for a range of inputs. Seven of
    // this describe's eight siblings carry the same line for the same reason.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps its own Content-Type when a manifest header binding declares a colliding spelling', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers).toEqual({ Authorization: 'Bearer k', 'Content-Type': 'application/json' });
      return new Response('{}', { status: 200 });
    });

    const stderr = await captureStderr(async () => {
      await callTool({
        baseUrl: 'https://gw.example.com',
        apiKey: 'k',
        candidate: candidate({
          tool: 'b_thing',
          backendId: 'b',
          path: '/thing',
          httpMethod: 'POST',
          bindings: { header: ['content-type'] },
        }),
        args: { 'content-type': 'text/xml', field: 1 },
        fetchFn: fetchFn as unknown as typeof fetch,
      });
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(stderr).toContain('b_thing: ignoring bound header "content-type" -- it is set by the client and may not be overridden');
  });

  it('refuses locally (BindingError) and never calls fetch, for --body-json on a GET method', async () => {
    const fetchFn = vi.fn();
    await expect(
      callTool({
        baseUrl: 'https://gw.example.com',
        apiKey: 'k',
        candidate: candidate({
          backendId: 'brightdata',
          path: '/snapshots/{id}/data',
          httpMethod: 'GET',
          bindings: { method: 'GET', path_params: ['id'] },
        }),
        args: { id: 'snap-1' },
        bodyJson: { some: 'body' },
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(BindingError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses locally (BindingError) and never calls fetch, for a missing required path parameter', async () => {
    const fetchFn = vi.fn();
    await expect(
      callTool({
        baseUrl: 'https://gw.example.com',
        apiKey: 'k',
        candidate: candidate({
          backendId: 'brightdata',
          path: '/snapshots/{id}/data',
          httpMethod: 'GET',
          bindings: { path_params: ['id'] },
        }),
        args: {},
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(BindingError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses locally and never calls fetch when a manifest header binding names Authorization', async () => {
    const fetchFn = vi.fn();
    await expect(
      callTool({
        baseUrl: 'https://gw.example.com',
        apiKey: 'k',
        candidate: candidate({
          backendId: 'b',
          path: '/thing',
          httpMethod: 'POST',
          bindings: { header: ['Authorization'] },
        }),
        args: { Authorization: 'Bearer smuggled' },
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(BindingError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws GatewayCallError with the gateway-envelope classification on a non-2xx gateway error', async () => {
    const fetchFn = vi.fn(
      async () => new Response('{"error":{"code":"backend_not_configured","message":"no api key set"}}', { status: 403 }),
    );

    let caught: unknown;
    try {
      await callTool({
        baseUrl: 'https://gw.example.com',
        apiKey: 'k',
        candidate: candidate({ backendId: 'b', path: '/thing', httpMethod: 'GET', bindings: {} }),
        args: {},
        fetchFn: fetchFn as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GatewayCallError);
    expect((caught as GatewayCallError).status).toBe(403);
    expect((caught as GatewayCallError).detail).toEqual({
      kind: 'gateway',
      status: 403,
      code: 'backend_not_configured',
      message: 'no api key set',
    });
  });

  it('throws GatewayCallError with the backend body preserved verbatim (no synthesized code) on a proxied backend error', async () => {
    const backendBody = '{"detail":"dataset_id is required"}';
    const fetchFn = vi.fn(async () => new Response(backendBody, { status: 400 }));

    let caught: unknown;
    try {
      await callTool({
        baseUrl: 'https://gw.example.com',
        apiKey: 'k',
        candidate: candidate({ backendId: 'brightdata', path: '/scrape_async', httpMethod: 'POST', bindings: {} }),
        args: {},
        fetchFn: fetchFn as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GatewayCallError);
    expect((caught as GatewayCallError).status).toBe(400);
    expect((caught as GatewayCallError).detail).toEqual({ kind: 'backend', status: 400, body: backendBody });
    expect((caught as GatewayCallError).detail).not.toHaveProperty('code');
  });

  it('propagates a transport failure unwrapped, without catching or rewriting it', async () => {
    const transportError = new Error('network down');
    const fetchFn = vi.fn(async () => {
      throw transportError;
    });

    await expect(
      callTool({
        baseUrl: 'https://gw.example.com',
        apiKey: 'k',
        candidate: candidate({ backendId: 'b', path: '/thing', httpMethod: 'GET', bindings: {} }),
        args: {},
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toBe(transportError);
  });
});
