// Gateway-envelope vs. backend-passthrough error discrimination for a
// non-2xx `/v1/{backendId}{path}` response.
//
// The gateway's own errors (auth failures, unknown backend, routing
// problems, backend_not_configured, ...) are always written as a top-level
// `{ "error": { "code": "...", "message": "..." } }` envelope --
// zug/internal/gateway/errors.go's `writeError`. A backend's own non-2xx
// response is proxied through byte-for-byte instead of being re-wrapped --
// see zug/internal/brightdatabackend/handlers.go's `writeUpstreamError`,
// which forwards an upstream `APIError`'s status and body verbatim -- and
// that body can be shaped however the backend's own API shapes errors
// (FastAPI's `{"detail": "..."}`, plain text, or anything else). Treating
// every non-2xx body as one of these two shapes, and never inventing a
// `code` for the second, is the contract zug/docs/backend-authoring.md
// documents and the old MCP client's `parseErrorBody` violated by falling
// back through `detail`/`message`/`JSON.stringify` guesses.
//
// This module only detects which of the two shapes a response is; it does
// not decide what the caller should DO about it. Task 6's retry.ts imports
// `CallError` and adds retry classification (retryable vs. abort, code-first
// with status as fallback) on top of it, and may append a note below this
// comment when it does. Do not add a severity taxonomy or retry/abort policy
// here.

/** A response whose body matched the gateway's own `{error:{code,message}}` shape. */
export interface GatewayErrorEnvelope {
  kind: 'gateway';
  status: number;
  code: string;
  message: string;
}

/**
 * A response that did not match the gateway envelope shape: an opaque
 * backend (or otherwise unrecognized) error. `body` is the raw response text
 * exactly as received -- never reshaped, partially parsed, or replaced with
 * a synthesized message.
 */
export interface BackendErrorResponse {
  kind: 'backend';
  status: number;
  body: string;
}

export type CallError = GatewayErrorEnvelope | BackendErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Classifies a non-2xx `/v1/{backendId}{path}` response body.
 *
 * A response is a gateway envelope only when its JSON is a top-level object
 * with an `error` object whose `code` and `message` are both strings. Any
 * other shape -- unparseable JSON, JSON without a matching `error` object, an
 * `error` object missing either field -- is a backend response: `body`
 * carries the raw text verbatim, and no `code` is invented for it.
 */
export function parseCallError(status: number, bodyText: string): CallError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { kind: 'backend', status, body: bodyText };
  }

  if (isRecord(parsed)) {
    const err = parsed.error;
    if (isRecord(err) && typeof err.code === 'string' && typeof err.message === 'string') {
      return { kind: 'gateway', status, code: err.code, message: err.message };
    }
  }

  return { kind: 'backend', status, body: bodyText };
}

// ---------------------------------------------------------------------------
// Task 6 (retry.ts) documentation note.
//
// Two facts about specific gateway codes are load-bearing for retry.ts's
// classification and worth recording here, next to the detection this module
// owns, even though retry.ts is what acts on them:
//
// 1. `rate_limited` is written by the gateway ONLY on the voucher-redeem path
//    (zug/internal/gateway/vouchers.go:84, HTTP 429) -- not on any `/v1/*`
//    tool call. fezoctl never hits that endpoint, so a `{kind:'gateway',
//    code:'rate_limited'}` envelope is not normally observable in practice.
//    A real upstream provider's rate limit instead arrives as a CODE-LESS
//    backend 429 passthrough (`{kind:'backend', status:429}`), which is why
//    retry.ts's HTTP-status fallback -- not this code -- is the load-bearing
//    path for rate limiting.
// 2. `limit_exceeded` (zug/internal/gateway/spendlimit.go's `TrippedLimit`,
//    HTTP 402) can be scoped to the whole account, one API key, or one
//    backend (`TrippedLimit.BackendID`), but the gateway exposes that scope
//    only in the human-readable `Message()` string -- never as a structured
//    field on the wire. retry.ts does not parse that message, so it aborts
//    the whole run conservatively even when the limit is backend-scoped and a
//    different candidate could, in principle, have safely advanced instead.
// ---------------------------------------------------------------------------
