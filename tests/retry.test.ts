import { describe, expect, it, vi } from 'vitest';

import type { ToolCandidate } from '../src/engine/catalog.js';
import type { AttemptLog, RunOptions } from '../src/engine/retry.js';
import { DEFAULT_MAX_ATTEMPTS, run } from '../src/engine/retry.js';

// ---------------------------------------------------------------------------
// Fixture helpers, matching the convention in binding.test.ts/call.test.ts.
// ---------------------------------------------------------------------------

function candidate(overrides: Partial<ToolCandidate> & Pick<ToolCandidate, 'tool' | 'backendId' | 'path' | 'httpMethod' | 'bindings'>): ToolCandidate {
  return {
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

function gatewayErrorResponse(status: number, code: string, message = 'gateway said no'): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status });
}

/** A backend passthrough error: a body that does NOT match the gateway envelope shape. */
function backendErrorResponse(status: number, body = '{"detail":"upstream says no"}'): Response {
  return new Response(body, { status });
}

function okResponse(bodyText: string, status = 200): Response {
  return new Response(bodyText, { status });
}

/**
 * Routes a mocked fetch by which candidate's `/v1/{backendId}/...` URL was
 * requested. `handlers` maps `backendId -> ordered list of responses`; each
 * call to that backend consumes the next response in its list (so a backend
 * hit more than once in one test — should not happen in these tests, but the
 * queue shape makes an accidental double-call loud rather than silently
 * reusing the first response forever).
 */
function routedFetch(handlers: Record<string, Response[]>): typeof fetch {
  const queues = new Map(Object.entries(handlers).map(([id, responses]) => [id, [...responses]]));
  return vi.fn(async (url: string | URL) => {
    const asString = String(url);
    for (const [backendId, queue] of queues) {
      if (asString.includes(`/v1/${backendId}/`)) {
        const next = queue.shift();
        if (next === undefined) {
          throw new Error(`routedFetch: backend "${backendId}" was called more times than it had responses queued`);
        }
        return next;
      }
    }
    throw new Error(`routedFetch: no handler registered for URL ${asString}`);
  }) as unknown as typeof fetch;
}

/**
 * Runs `fn` with process.stderr.write mocked out and returns everything it
 * wrote, joined. Async variant of the pattern in binding.test.ts/schema.test.ts
 * (`captureStderr`): `run` is async, so the write can happen after an
 * `await`, and the spy must still be in place when it does. Writes are
 * collected into a local array rather than read off the spy afterwards,
 * because vitest's `mockRestore` also resets the spy's call history, so any
 * assertion made on the spy after restoring would read an empty history and
 * pass vacuously.
 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return writes.join('');
}

const baseOptions: Pick<RunOptions, 'baseUrl' | 'apiKey' | 'args'> = {
  baseUrl: 'https://gw.example.com',
  apiKey: 'k',
  args: {},
};

const alpha = candidate({ tool: 'alpha_scrape', backendId: 'alpha', path: '/scrape', httpMethod: 'GET', bindings: {} });
const beta = candidate({ tool: 'beta_scrape', backendId: 'beta', path: '/scrape', httpMethod: 'GET', bindings: {} });
const gamma = candidate({ tool: 'gamma_scrape', backendId: 'gamma', path: '/scrape', httpMethod: 'GET', bindings: {} });

describe('run — retrying a retryable failure', () => {
  it('tries candidate 1, then candidate 2, on a retryable gateway failure, and logs both attempts with correct billed values', async () => {
    const fetchFn = routedFetch({
      alpha: [gatewayErrorResponse(503, 'backend_unavailable')],
      beta: [okResponse('{"ok":true}')],
    });

    const report = await run({ ...baseOptions, candidates: [alpha, beta], fetchFn });

    expect(report.outcome).toEqual({ kind: 'success', candidate: beta, result: { status: 200, bodyText: '{"ok":true}' } });
    expect(report.attempts).toEqual<AttemptLog[]>([
      {
        tool: 'alpha_scrape',
        backendId: 'alpha',
        status: 'retry',
        httpStatus: 503,
        gatewayCode: 'backend_unavailable',
        reason: 'gateway code "backend_unavailable"',
        billed: false,
      },
      {
        tool: 'beta_scrape',
        backendId: 'beta',
        status: 'success',
        httpStatus: 200,
        reason: '200 response',
        billed: true,
      },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('run — abort', () => {
  it('aborts immediately on unauthorized without trying another candidate', async () => {
    const fetchFn = routedFetch({
      alpha: [gatewayErrorResponse(401, 'unauthorized')],
      beta: [okResponse('{"ok":true}')],
    });

    const report = await run({ ...baseOptions, candidates: [alpha, beta], fetchFn });

    expect(report.outcome).toEqual({ kind: 'aborted', reason: 'gateway code "unauthorized"' });
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]).toMatchObject({ backendId: 'alpha', status: 'abort', billed: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('aborts on a BindingError (invalid local arguments) and never calls fetch at all', async () => {
    const missingPathParam = candidate({
      tool: 'alpha_get',
      backendId: 'alpha',
      path: '/items/{id}',
      httpMethod: 'GET',
      bindings: { path_params: ['id'] },
    });
    const fetchFn = routedFetch({ beta: [okResponse('{"ok":true}')] });

    const report = await run({ ...baseOptions, args: {}, candidates: [missingPathParam, beta], fetchFn });

    expect(report.outcome.kind).toBe('aborted');
    expect(report.attempts).toHaveLength(1);
    const [first] = report.attempts;
    expect(first).toBeDefined();
    expect(first?.status).toBe('abort');
    expect(first?.billed).toBe(false);
    expect(first?.reason).toContain('missing required path parameter(s): id');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('run — give up', () => {
  it('gives up on a non-retryable code-less 4xx and does not try the next candidate', async () => {
    const fetchFn = routedFetch({
      alpha: [backendErrorResponse(400)],
      beta: [okResponse('{"ok":true}')],
    });

    const report = await run({ ...baseOptions, candidates: [alpha, beta], fetchFn });

    expect(report.outcome).toEqual({ kind: 'give_up', reason: 'non-retryable HTTP 400 with no gateway code' });
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]).toMatchObject({ status: 'give_up', billed: false });
    expect(report.attempts[0]).not.toHaveProperty('gatewayCode');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('run — transport failure', () => {
  it('advances to the next candidate on a transport failure', async () => {
    const transportError = new Error('ECONNREFUSED');
    const fetchFn = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/v1/alpha/')) throw transportError;
      return okResponse('{"ok":true}');
    }) as unknown as typeof fetch;

    const report = await run({ ...baseOptions, candidates: [alpha, beta], fetchFn });

    expect(report.outcome).toEqual({ kind: 'success', candidate: beta, result: { status: 200, bodyText: '{"ok":true}' } });
    expect(report.attempts[0]).toMatchObject({ backendId: 'alpha', status: 'retry', billed: false, reason: 'transport failure: ECONNREFUSED' });
    expect(report.attempts[1]).toMatchObject({ backendId: 'beta', status: 'success', billed: true });
  });
});

describe('run — tool_not_in_catalog: context determines the outcome', () => {
  it('run context (a second candidate exists): tool_not_in_catalog is a skipped candidate, and the engine tries the next one', async () => {
    const fetchFn = routedFetch({
      alpha: [gatewayErrorResponse(404, 'tool_not_in_catalog')],
      beta: [okResponse('{"ok":true}')],
    });

    const report = await run({ ...baseOptions, candidates: [alpha, beta], fetchFn });

    expect(report.outcome.kind).toBe('success');
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[0]).toMatchObject({ backendId: 'alpha', status: 'retry', gatewayCode: 'tool_not_in_catalog' });
    expect(report.attempts[1]).toMatchObject({ backendId: 'beta', status: 'success' });
  });

  it('call context (no candidate list to continue through): the very same retry-classified failure becomes a hard error via exhaustion', async () => {
    const fetchFn = routedFetch({ alpha: [gatewayErrorResponse(404, 'tool_not_in_catalog')] });

    const report = await run({ ...baseOptions, candidates: [alpha], fetchFn });

    // The per-attempt classification is still 'retry' (unchanged by context) —
    // it is the run's overall outcome that differs, because there was nothing
    // left to advance into.
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]).toMatchObject({ status: 'retry', gatewayCode: 'tool_not_in_catalog' });
    expect(report.outcome).toEqual({ kind: 'give_up', reason: 'no more candidates to try' });
  });
});

describe('run — --max-attempts', () => {
  it('defaults to 2 and stops trying once reached, even with more candidates available', async () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(2);
    const fetchFn = routedFetch({
      alpha: [gatewayErrorResponse(500, 'backend_error')],
      beta: [gatewayErrorResponse(500, 'backend_error')],
      gamma: [okResponse('{"ok":true}')],
    });

    const report = await run({ ...baseOptions, candidates: [alpha, beta, gamma], fetchFn });

    expect(report.outcome).toEqual({ kind: 'give_up', reason: 'max attempts (2) reached with candidates remaining' });
    expect(report.attempts).toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('an explicit higher --max-attempts reaches the third candidate', async () => {
    const fetchFn = routedFetch({
      alpha: [gatewayErrorResponse(500, 'backend_error')],
      beta: [gatewayErrorResponse(500, 'backend_error')],
      gamma: [okResponse('{"ok":true}')],
    });

    const report = await run({ ...baseOptions, candidates: [alpha, beta, gamma], maxAttempts: 3, fetchFn });

    expect(report.outcome.kind).toBe('success');
    expect(report.attempts).toHaveLength(3);
  });

  it('maxAttempts: 0 calls nothing at all', async () => {
    const fetchFn = vi.fn();
    const report = await run({ ...baseOptions, candidates: [alpha, beta], maxAttempts: 0, fetchFn: fetchFn as unknown as typeof fetch });

    expect(report.outcome).toEqual({ kind: 'give_up', reason: 'max attempts (0) reached with candidates remaining' });
    expect(report.attempts).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('run — exhausted candidate list', () => {
  it('ends cleanly with a complete attempt log when every candidate is tried and none succeed, independent of --max-attempts', async () => {
    const fetchFn = routedFetch({
      alpha: [gatewayErrorResponse(500, 'backend_error')],
      beta: [gatewayErrorResponse(429, 'rate_limited')],
    });

    // maxAttempts is generously large so the stop is caused by running out of
    // candidates, not by the attempt budget — distinguishing this case from
    // the --max-attempts tests above.
    const report = await run({ ...baseOptions, candidates: [alpha, beta], maxAttempts: 5, fetchFn });

    expect(report.outcome).toEqual({ kind: 'give_up', reason: 'no more candidates to try' });
    expect(report.attempts).toEqual<AttemptLog[]>([
      {
        tool: 'alpha_scrape',
        backendId: 'alpha',
        status: 'retry',
        httpStatus: 500,
        gatewayCode: 'backend_error',
        reason: 'gateway code "backend_error"',
        billed: false,
      },
      {
        tool: 'beta_scrape',
        backendId: 'beta',
        status: 'retry',
        httpStatus: 429,
        gatewayCode: 'rate_limited',
        reason: 'gateway code "rate_limited"',
        billed: false,
      },
    ]);
  });
});

describe('run — empty 2xx retry is opt-in', () => {
  it('does NOT retry an empty 2xx response by default', async () => {
    const fetchFn = routedFetch({ alpha: [okResponse('')] });

    const report = await run({ ...baseOptions, candidates: [alpha, beta], fetchFn });

    expect(report.outcome).toEqual({ kind: 'success', candidate: alpha, result: { status: 200, bodyText: '' } });
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]).toMatchObject({ status: 'success', billed: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('DOES retry an empty 2xx response when --retry-empty-2xx is set, and warns on stderr that the retry bills again', async () => {
    const fetchFn = routedFetch({ alpha: [okResponse('')], beta: [okResponse('{"ok":true}')] });
    let report: Awaited<ReturnType<typeof run>> | undefined;

    const stderr = await captureStderr(async () => {
      report = await run({ ...baseOptions, candidates: [alpha, beta], retryEmpty2xx: true, fetchFn });
    });

    if (report === undefined) {
      throw new Error('run() did not produce a report');
    }
    expect(report.outcome).toEqual({ kind: 'success', candidate: beta, result: { status: 200, bodyText: '{"ok":true}' } });
    expect(report.attempts).toEqual<AttemptLog[]>([
      {
        tool: 'alpha_scrape',
        backendId: 'alpha',
        status: 'retry',
        httpStatus: 200,
        reason: 'empty 2xx response body (--retry-empty-2xx)',
        billed: true,
      },
      {
        tool: 'beta_scrape',
        backendId: 'beta',
        status: 'success',
        httpStatus: 200,
        reason: '200 response',
        billed: true,
      },
    ]);
    expect(stderr).toContain('alpha_scrape');
    expect(stderr).toContain('already billed');
    expect(stderr).toContain('--retry-empty-2xx');
  });
});

describe('run — no candidates', () => {
  it('gives up immediately with an empty attempt log', async () => {
    const fetchFn = vi.fn();
    const report = await run({ ...baseOptions, candidates: [], fetchFn: fetchFn as unknown as typeof fetch });
    expect(report.outcome).toEqual({ kind: 'give_up', reason: 'no candidates to try' });
    expect(report.attempts).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
