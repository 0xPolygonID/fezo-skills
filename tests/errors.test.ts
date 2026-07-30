import { describe, expect, it } from 'vitest';

import type { MechanicalFailure } from '../src/engine/retry.js';
import { classifyFailure } from '../src/engine/retry.js';

// ---------------------------------------------------------------------------
// classifyFailure -- code-first, status-fallback retry classification.
//
// Every case here mirrors one bullet of the governing spec's three lists
// (abort / try-next-candidate / give-up), plus the precedence and
// code-vs-status conflict cases the brief calls out by name. Real gateway
// status/code PAIRINGS are used throughout (see zug/internal/gateway/proxy.go,
// spendlimit.go, and brightdatabackend/handlers.go) rather than invented
// combinations, so these tests double as a check that this module's tables
// match the live gateway source.
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

  it('invalid local arguments (a BindingError) aborts', () => {
    const result = classifyFailure({ kind: 'invalid-arguments', message: 'missing required path parameter(s): id' });
    expect(result.decision).toBe('abort');
    expect(result.reason).toContain('missing required path parameter(s): id');
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
    // bad_request/not_found are real errors.go codes, but written only by
    // non-/v1/* endpoints (account/billing/limits/vouchers/registry) that
    // fezoctl never calls; this exercises the defensive default a genuinely
    // unknown code would hit.
    const result = classifyFailure(gatewayFailure('bad_request', 400));
    expect(result.decision).toBe('give_up');
    expect(result.gatewayCode).toBe('bad_request');
  });
});

describe('classifyFailure — code-first precedence (the central rule)', () => {
  it('a retryable code overrides a status (403) that a code-less classification would give up on', () => {
    // provider_disabled and backend_not_configured are both written with 403
    // (zug/internal/gateway/proxy.go). A code-less 403 is not in the
    // retryable-status set (only 402/429/500/502/503 are), so a classifier
    // that fell back to status here would give up. The code says retry, and
    // the code must win.
    const codeless403 = classifyFailure(backendFailure(403));
    expect(codeless403.decision).toBe('give_up');

    const coded403 = classifyFailure(gatewayFailure('provider_disabled', 403));
    expect(coded403.decision).toBe('retry');
  });

  it('an abort code overrides a status (402) that a code-less classification would retry', () => {
    // limit_exceeded is written with 402 (zug/internal/gateway/spendlimit.go
    // via proxy.go), and 402 IS in the retryable-status set — a code-less 402
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
