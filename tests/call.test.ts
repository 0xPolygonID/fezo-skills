import { describe, expect, it, vi } from 'vitest';

import { BindingError } from '../src/engine/bindings.js';
import type { ToolCandidate } from '../src/engine/catalog.js';
import { GatewayCallError, callTool } from '../src/engine/client.js';
import { parseCallError } from '../src/engine/errors.js';

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
