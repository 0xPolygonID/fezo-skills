import { describe, expect, it } from 'vitest';

import type { MechanicalFailure } from '../src/engine/retry.js';
import { ABORT_CODES, RETRY_CODES, classifyFailure } from '../src/engine/retry.js';

// ---------------------------------------------------------------------------
// classifyFailure -- code-first, status-fallback retry classification.
//
// Every case here mirrors one bullet of the governing spec's three lists
// (abort / try-next-candidate / give-up), plus the precedence and
// code-vs-status conflict cases the brief calls out by name. Real gateway
// status/code PAIRINGS are used throughout -- taken from the gateway's proxy
// handler and spend-limit check, and from a backend's own error writer --
// rather than invented combinations, so these tests double as a check that
// this module's tables match what the gateway actually emits.
// ---------------------------------------------------------------------------

function gatewayFailure(code: string, status: number): MechanicalFailure {
  return { kind: 'gateway', status, code, message: 'irrelevant for classification' };
}

function backendFailure(status: number): MechanicalFailure {
  return { kind: 'backend', status, body: '{}' };
}

describe('classifyFailure — abort the whole run', () => {
  it('unauthorized (401) aborts', () => {
    expect(classifyFailure(gatewayFailure('unauthorized', 401)).decision).toBe('abort');
  });

  it('limit_exceeded (402) aborts', () => {
    expect(classifyFailure(gatewayFailure('limit_exceeded', 402)).decision).toBe('abort');
  });

  it('insufficient_balance (402) aborts', () => {
    expect(classifyFailure(gatewayFailure('insufficient_balance', 402)).decision).toBe('abort');
  });
});

describe('classifyFailure — a per-candidate BindingError skips the candidate, it does NOT abort', () => {
  it('invalid-arguments is a retry decision whose reason names the candidate, not the caller, as the scope', () => {
    const result = classifyFailure({ kind: 'invalid-arguments', message: 'missing required path parameter(s): id' });
    // Every BindingErrorReason is computed from ONE candidate's own manifest,
    // bindings, and input_schema.required, so another candidate can genuinely
    // accept the same arguments (`url` vs. `link`, GET vs. POST). Aborting
    // would also let a backend-published `disallowed-header` manifest defect
    // kill a run the user cannot repair.
    expect(result.decision).toBe('retry');
    expect(result.decision).not.toBe('abort');
    expect(result.reason).toContain('candidate rejected the supplied arguments');
    expect(result.reason).toContain('missing required path parameter(s): id');
    // No response existed, so neither wire field may be invented.
    expect(result.httpStatus).toBeUndefined();
    expect(result.gatewayCode).toBeUndefined();
  });
});

describe('classifyFailure — try the next compatible candidate', () => {
  it('quota_exceeded (402, backend envelope) advances', () => {
    const result = classifyFailure(gatewayFailure('quota_exceeded', 402));
    expect(result.decision).toBe('retry');
  });

  it('rate_limited advances', () => {
    expect(classifyFailure(gatewayFailure('rate_limited', 429)).decision).toBe('retry');
  });

  it('backend_unavailable advances', () => {
    expect(classifyFailure(gatewayFailure('backend_unavailable', 503)).decision).toBe('retry');
  });

  it('provider_disabled advances', () => {
    expect(classifyFailure(gatewayFailure('provider_disabled', 403)).decision).toBe('retry');
  });

  it('backend_not_configured advances', () => {
    expect(classifyFailure(gatewayFailure('backend_not_configured', 403)).decision).toBe('retry');
  });

  it('backend_not_found advances', () => {
    expect(classifyFailure(gatewayFailure('backend_not_found', 404)).decision).toBe('retry');
  });

  it('backend_error advances', () => {
    expect(classifyFailure(gatewayFailure('backend_error', 500)).decision).toBe('retry');
  });

  it('tool_not_in_catalog advances', () => {
    expect(classifyFailure(gatewayFailure('tool_not_in_catalog', 404)).decision).toBe('retry');
  });

  it('a code-less HTTP 402 advances', () => {
    expect(classifyFailure(backendFailure(402)).decision).toBe('retry');
  });

  it('a code-less HTTP 429 advances (the real rate-limit path — see errors.ts)', () => {
    const result = classifyFailure(backendFailure(429));
    expect(result.decision).toBe('retry');
  });

  it('a code-less HTTP 500 advances', () => {
    expect(classifyFailure(backendFailure(500)).decision).toBe('retry');
  });

  it('a code-less HTTP 502 advances', () => {
    expect(classifyFailure(backendFailure(502)).decision).toBe('retry');
  });

  it('a code-less HTTP 503 advances', () => {
    expect(classifyFailure(backendFailure(503)).decision).toBe('retry');
  });

  it('a transport failure advances', () => {
    const result = classifyFailure({ kind: 'transport', message: 'ECONNREFUSED' });
    expect(result.decision).toBe('retry');
    expect(result.reason).toContain('ECONNREFUSED');
  });
});

describe('classifyFailure — give up', () => {
  it('a code-less HTTP 400 gives up, and does NOT synthesize a backend_error gateway code', () => {
    const result = classifyFailure(backendFailure(400));
    expect(result.decision).toBe('give_up');
    expect(result.gatewayCode).toBeUndefined();
    expect(result.reason).not.toContain('backend_error');
  });

  it('a code-less HTTP 404 gives up, and does NOT synthesize a backend_error gateway code', () => {
    const result = classifyFailure(backendFailure(404));
    expect(result.decision).toBe('give_up');
    expect(result.gatewayCode).toBeUndefined();
  });

  it('an unrecognized gateway code gives up rather than guessing either way', () => {
    // NOT a hypothetical: the backends write gateway-shaped envelopes with the
    // same {error:{code,message}} writer (brightdatabackend/handlers.go:383)
    // and the gateway forwards them through /v1/* verbatim, so `bad_request`
    // reaches this branch from ~19 real backend sites (e.g.
    // brightdatabackend/handlers.go:86, exabackend/handlers.go:71). Give up is
    // the right outcome for it; the branch is live, not defensive.
    const result = classifyFailure(gatewayFailure('bad_request', 400));
    expect(result.decision).toBe('give_up');
    expect(result.gatewayCode).toBe('bad_request');
  });

  it('the other backend-emitted envelope codes forwarded through /v1/* also give up', () => {
    // not_found (apifybackend/handlers.go:148), method_not_allowed
    // (xrobackend/handlers.go:75), request_too_large
    // (newsapibackend/handlers.go:80), owner_data_forbidden
    // (xrobackend/handlers.go:80). None is in ABORT_CODES or RETRY_CODES, and
    // none should be: another provider's identical call would not fix any of
    // them.
    for (const [code, status] of [
      ['not_found', 404],
      ['method_not_allowed', 405],
      ['request_too_large', 413],
      ['owner_data_forbidden', 403],
    ] as const) {
      const result = classifyFailure(gatewayFailure(code, status));
      expect(result.decision, code).toBe('give_up');
      expect(result.gatewayCode, code).toBe(code);
      expect(result.httpStatus, code).toBe(status);
    }
  });
});

describe('classifyFailure — code-first precedence (the central rule)', () => {
  it('a retryable code overrides a status (403) that a code-less classification would give up on', () => {
    // provider_disabled and backend_not_configured are both written with 403
    // by the gateway's proxy handler. A code-less 403 is not in the
    // retryable-status set (only 402/429/500/502/503 are), so a classifier
    // that fell back to status here would give up. The code says retry, and
    // the code must win.
    const codeless403 = classifyFailure(backendFailure(403));
    expect(codeless403.decision).toBe('give_up');

    const coded403 = classifyFailure(gatewayFailure('provider_disabled', 403));
    expect(coded403.decision).toBe('retry');
  });

  it('an abort code overrides a status (402) that a code-less classification would retry', () => {
    // limit_exceeded is written with 402 by the gateway's spend-limit check,
    // and 402 IS in the retryable-status set — a code-less 402
    // (e.g. quota_exceeded's own shape minus its code) advances. The code
    // says abort, and the code must win.
    const codeless402 = classifyFailure(backendFailure(402));
    expect(codeless402.decision).toBe('retry');

    const coded402 = classifyFailure(gatewayFailure('limit_exceeded', 402));
    expect(coded402.decision).toBe('abort');
  });
});

describe('classifyFailure — the quota_exceeded / limit_exceeded / insufficient_balance trio (all HTTP 402)', () => {
  it('quota_exceeded advances, limit_exceeded aborts, insufficient_balance aborts — same status, opposite codes', () => {
    expect(classifyFailure(gatewayFailure('quota_exceeded', 402)).decision).toBe('retry');
    expect(classifyFailure(gatewayFailure('limit_exceeded', 402)).decision).toBe('abort');
    expect(classifyFailure(gatewayFailure('insufficient_balance', 402)).decision).toBe('abort');
  });
});

// ---------------------------------------------------------------------------
// Set-membership assertion.
//
// Every test above pins ONE code's behavior individually: "unauthorized
// aborts", "quota_exceeded advances", and so on. None of them would catch a
// FUTURE twelfth code landing in the wrong table -- a code added to
// RETRY_CODES that should have gone in ABORT_CODES (or vice versa) produces a
// self-consistent per-code test ("newCode advances" passes because the
// classifier does, in fact, advance on it) with nothing to check that
// against. This test pins the exact, exhaustive membership of both tables so
// a future addition to either one is a visible, deliberate diff here, not a
// change that slips in silently.
// ---------------------------------------------------------------------------
describe('classifyFailure — ABORT_CODES / RETRY_CODES set membership', () => {
  const expectedAbortCodes = ['unauthorized', 'limit_exceeded', 'insufficient_balance'];
  const expectedRetryCodes = [
    'quota_exceeded',
    'rate_limited',
    'backend_unavailable',
    'provider_disabled',
    'backend_not_configured',
    'backend_not_found',
    'backend_error',
    'tool_not_in_catalog',
  ];

  it('ABORT_CODES is exactly this list, no more and no fewer', () => {
    expect(new Set(ABORT_CODES)).toEqual(new Set(expectedAbortCodes));
    expect(ABORT_CODES.size).toBe(expectedAbortCodes.length);
  });

  it('RETRY_CODES is exactly this list, no more and no fewer', () => {
    expect(new Set(RETRY_CODES)).toEqual(new Set(expectedRetryCodes));
    expect(RETRY_CODES.size).toBe(expectedRetryCodes.length);
  });

  it('the two tables are disjoint: no code is classified both ways', () => {
    const overlap = expectedAbortCodes.filter((code) => RETRY_CODES.has(code));
    expect(overlap).toEqual([]);
    const reverseOverlap = expectedRetryCodes.filter((code) => ABORT_CODES.has(code));
    expect(reverseOverlap).toEqual([]);
  });

  it('every code in ABORT_CODES classifies as abort, and every code in RETRY_CODES classifies as retry', () => {
    for (const code of ABORT_CODES) {
      expect(classifyFailure(gatewayFailure(code, 400)).decision, code).toBe('abort');
    }
    for (const code of RETRY_CODES) {
      expect(classifyFailure(gatewayFailure(code, 400)).decision, code).toBe('retry');
    }
  });
});
