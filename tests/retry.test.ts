import { describe, expect, it, vi } from 'vitest';

import type { ToolCandidate } from '../src/engine/catalog.js';
import type { AttemptLog, RunOptions } from '../src/engine/retry.js';
import { DEFAULT_MAX_ATTEMPTS, run } from '../src/engine/retry.js';
import { captureStderrAsync as captureStderr } from './helpers.js';

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
    backendCategories: [],
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
});

// ---------------------------------------------------------------------------
// A per-candidate BindingError is a SKIP, not an abort: it is computed from one
// candidate's own manifest/bindings/required-set, so the next candidate can
// genuinely accept the same arguments. It also issues no request, so it must
// not spend the --max-attempts budget (which governs money), and when it is the
// only thing that happened the run must say so rather than blaming exhaustion.
// ---------------------------------------------------------------------------
describe('run — a per-candidate BindingError skips the candidate', () => {
  /** Requires a path param the test args never supply -> BindingError before any fetch. */
  const unbindable = candidate({
    tool: 'alpha_get',
    backendId: 'alpha',
    path: '/items/{id}',
    httpMethod: 'GET',
    bindings: { path_params: ['id'] },
  });
  const unbindableToo = candidate({
    tool: 'beta_get',
    backendId: 'beta',
    path: '/items/{id}',
    httpMethod: 'GET',
    bindings: { path_params: ['id'] },
  });

  it('candidate 1 raises a BindingError, is skipped without a request, and candidate 2 succeeds', async () => {
    const fetchFn = routedFetch({ beta: [okResponse('{"ok":true}')] });

    const report = await run({ ...baseOptions, args: {}, candidates: [unbindable, beta], fetchFn });

    expect(report.outcome).toEqual({ kind: 'success', candidate: beta, result: { status: 200, bodyText: '{"ok":true}' } });
    expect(report.attempts).toEqual<AttemptLog[]>([
      {
        tool: 'alpha_get',
        backendId: 'alpha',
        status: 'retry',
        reason: 'candidate rejected the supplied arguments: missing required path parameter(s): id',
        billed: false,
        // `'binding'`, not `'schema'`: this candidate's args passed its own
        // input_schema and were refused by `bindArgs`. The two share one
        // reason string on purpose, so this field is the ONLY thing that
        // separates "the provider's manifest could not take these arguments"
        // from "the caller's arguments are wrong" — see one-step.ts's
        // `isCallerFixableArgRejection`, which reports only the latter.
        preflight: 'binding',
      },
      {
        tool: 'beta_scrape',
        backendId: 'beta',
        status: 'success',
        httpStatus: 200,
        reason: '200 response',
        billed: true,
        // Absent on any attempt that actually issued a request.
      },
    ]);
    // The skipped candidate issued no request: only the second one was called.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a local skip does not consume the spend budget: two billed calls still happen with maxAttempts 2', async () => {
    // Three candidates, the first unbindable. With maxAttempts 2, a budget that
    // charged the local skip would leave room for only ONE billed call and stop
    // before gamma; the budget counts requests, so both beta and gamma are
    // tried.
    const fetchFn = routedFetch({
      beta: [gatewayErrorResponse(503, 'backend_unavailable')],
      gamma: [okResponse('{"ok":true}')],
    });

    const report = await run({ ...baseOptions, args: {}, candidates: [unbindable, beta, gamma], maxAttempts: 2, fetchFn });

    expect(report.outcome).toEqual({ kind: 'success', candidate: gamma, result: { status: 200, bodyText: '{"ok":true}' } });
    expect(report.attempts.map((attempt) => attempt.backendId)).toEqual(['alpha', 'beta', 'gamma']);
    expect(report.attempts.map((attempt) => attempt.status)).toEqual(['retry', 'retry', 'success']);
    // Two requests were issued (beta, gamma) — the full budget — even though
    // three attempts are logged.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(report.attempts.filter((attempt) => attempt.billed)).toHaveLength(1);
  });

  it('when every attempted candidate rejects the arguments locally, the summary says so instead of "no more candidates"', async () => {
    const fetchFn = vi.fn();

    const report = await run({
      ...baseOptions,
      args: {},
      candidates: [unbindable, unbindableToo],
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(report.outcome.kind).toBe('give_up');
    const { outcome } = report;
    if (outcome.kind !== 'give_up') {
      throw new Error(`expected a give_up outcome, got ${outcome.kind}`);
    }
    expect(outcome.reason).toContain('no candidate accepted the supplied arguments');
    expect(outcome.reason).not.toContain('no more candidates to try');
    expect(outcome.reason).not.toContain('max attempts');
    // Both candidates were attempted despite maxAttempts defaulting to 2 and
    // neither consuming it; the per-candidate messages stay in the log.
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts.map((attempt) => attempt.status)).toEqual(['retry', 'retry']);
    expect(report.attempts.map((attempt) => attempt.tool)).toEqual(['alpha_get', 'beta_get']);
    for (const attempt of report.attempts) {
      expect(attempt.reason).toContain('candidate rejected the supplied arguments: missing required path parameter(s): id');
    }
    expect(report.attempts.some((attempt) => attempt.billed)).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a mix of a local skip and a real failure keeps the generic exhaustion summary', async () => {
    // The special-cased summary must fire ONLY when every attempt was a local
    // skip — otherwise it would hide the fact that money was spent.
    const fetchFn = routedFetch({ beta: [gatewayErrorResponse(503, 'backend_unavailable')] });

    const report = await run({ ...baseOptions, args: {}, candidates: [unbindable, beta], fetchFn });

    expect(report.outcome).toEqual({ kind: 'give_up', reason: 'no more candidates to try' });
    expect(report.attempts).toHaveLength(2);
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

// ---------------------------------------------------------------------------
// `argsFor` (Phase 3a): additive, per-candidate arguments for one-step.ts's
// ranked walk. Two providers under the same "intent" name the caller's single
// value differently (`q` vs. `keyword`), so this proves `run()` actually calls
// `argsFor` per candidate rather than reusing one shared `args` object.
// ---------------------------------------------------------------------------
describe('run — argsFor (per-candidate arguments)', () => {
  const alphaQ = candidate({
    tool: 'alpha_search',
    backendId: 'alpha',
    path: '/search',
    httpMethod: 'GET',
    bindings: { query: ['q'] },
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  });
  const betaKeyword = candidate({
    tool: 'beta_search',
    backendId: 'beta',
    path: '/search',
    httpMethod: 'GET',
    bindings: { query: ['keyword'] },
    inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
  });

  it('calls each candidate with its OWN resolved argument name, falling back to the first candidate on a retryable failure', async () => {
    const fetchFn = routedFetch({
      alpha: [gatewayErrorResponse(503, 'backend_unavailable')],
      beta: [okResponse('{"ok":true}')],
    });

    const report = await run({
      ...baseOptions,
      args: { q: 'unused-fallback' },
      candidates: [alphaQ, betaKeyword],
      argsFor: (c) => (c.backendId === 'alpha' ? { q: 'hello' } : { keyword: 'hello' }),
      fetchFn,
    });

    expect(report.outcome.kind).toBe('success');
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0]?.[0])).toContain('q=hello');
    expect(String(calls[1]?.[0])).toContain('keyword=hello');
  });

  it('without argsFor, the shared `args` value is used for every candidate — unchanged, default behavior', async () => {
    // beta requires `keyword`, not `q`, so the shared `args` (naming only `q`)
    // fails beta's own schema and beta is skipped locally, never billed —
    // exactly the cross-provider-naming problem `argsFor` exists to solve.
    const fetchFn = routedFetch({ alpha: [okResponse('{"ok":true}')] });

    const report = await run({ ...baseOptions, args: { q: 'hello' }, candidates: [alphaQ, betaKeyword], fetchFn });

    expect(report.outcome).toEqual({ kind: 'success', candidate: alphaQ, result: { status: 200, bodyText: '{"ok":true}' } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// `deadline` (Phase 3a): additive wall-clock budget on the whole walk, checked
// only before starting a NEW attempt, never before the first and never
// mid-attempt. `stoppedBy` reports which cap (if any) actually stopped the
// walk.
// ---------------------------------------------------------------------------
describe('run — deadline', () => {
  it('never checks the deadline before the first attempt, even if it has already "expired" by the clock given', async () => {
    const clock = () => 1_000;
    const fetchFn = routedFetch({ alpha: [okResponse('{"ok":true}')] });

    const report = await run({ ...baseOptions, candidates: [alpha], deadline: { clock, ms: -500 }, fetchFn });

    expect(report.outcome.kind).toBe('success');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stops STARTING new attempts once the deadline has passed, without aborting the attempt already in flight, and reports stoppedBy', async () => {
    let time = 0;
    const clock = (): number => time;
    // Simulates the first attempt itself taking 10s of wall-clock time --
    // i.e. the deadline expires DURING the first (already-completed) attempt,
    // not before it, matching retry.ts's "never mid-attempt" rule: the check
    // only ever runs between attempts.
    const fetchFn = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/v1/alpha/')) {
        time += 10_000;
        return gatewayErrorResponse(503, 'backend_unavailable');
      }
      return okResponse('{"ok":true}');
    }) as unknown as typeof fetch;

    const report = await run({ ...baseOptions, candidates: [alpha, beta], deadline: { clock, ms: 5_000 }, fetchFn });

    expect(report.outcome).toEqual({ kind: 'give_up', reason: 'wall-clock deadline (5000ms) reached with candidates remaining' });
    expect(report.stoppedBy).toBe('deadline');
    expect(report.attempts).toHaveLength(1);
    // beta was never even attempted -- the deadline cut the walk short before it.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stoppedBy is absent when no deadline was given (unchanged default behavior)', async () => {
    const fetchFn = routedFetch({ alpha: [okResponse('{"ok":true}')] });
    const report = await run({ ...baseOptions, candidates: [alpha], fetchFn });
    expect(report.stoppedBy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// `stoppedBy` on the OTHER cap (`--max-attempts`), and its absence when the
// run instead ended for an unrelated reason.
// ---------------------------------------------------------------------------
describe('run — stoppedBy: max-attempts', () => {
  it('reports "max-attempts" when the attempt budget, not candidate exhaustion, is what stopped the walk', async () => {
    const fetchFn = routedFetch({
      alpha: [gatewayErrorResponse(500, 'backend_error')],
      beta: [gatewayErrorResponse(500, 'backend_error')],
      gamma: [okResponse('{"ok":true}')],
    });

    const report = await run({ ...baseOptions, candidates: [alpha, beta, gamma], fetchFn });

    expect(report.outcome).toEqual({ kind: 'give_up', reason: 'max attempts (2) reached with candidates remaining' });
    expect(report.stoppedBy).toBe('max-attempts');
  });

  it('is absent when the run ends by running out of candidates rather than by hitting a cap', async () => {
    const fetchFn = routedFetch({
      alpha: [gatewayErrorResponse(500, 'backend_error')],
      beta: [gatewayErrorResponse(429, 'rate_limited')],
    });

    const report = await run({ ...baseOptions, candidates: [alpha, beta], maxAttempts: 5, fetchFn });

    expect(report.outcome).toEqual({ kind: 'give_up', reason: 'no more candidates to try' });
    expect(report.stoppedBy).toBeUndefined();
  });
});
