// Retry and fallback classification, and the `run` orchestration loop:
// search-selected candidates already resolved by rank.ts's `selectForRun` are
// tried in order, and a *mechanical* failure on one candidate either aborts
// the whole run, advances to the next candidate, or gives up -- per the
// governing spec's classification table, reproduced in the constants below.
//
// THE SINGLE MOST IMPORTANT RULE, and the reason this module exists at all:
// classify by the gateway's `error.code` FIRST, and fall back to the HTTP
// status only when there is no code. Several codes are written with more than
// one status (`quota_exceeded`/`limit_exceeded`/`insufficient_balance` are all
// 402 -- see spendlimit.go and brightdatabackend/handlers.go), so a
// status-first classifier gets two of those three backwards: it would abort
// on a single provider's exhausted quota (which should advance to the next
// provider) or advance past an account-wide spend limit (which must not).
//
// This module builds on top of errors.ts's `CallError` (gateway-envelope vs.
// backend-passthrough detection) without changing it: detection stays there,
// retry policy lives here.

import type { ToolCandidate } from './catalog.js';
import { BindingError } from './bindings.js';
import type { CallError } from './errors.js';
import { GatewayCallError, callTool } from './client.js';
import type { CallToolResult } from './client.js';

// ---------------------------------------------------------------------------
// Classification tables -- verbatim from the governing spec.
// ---------------------------------------------------------------------------

/**
 * Gateway codes that abort the *whole run* -- trying another candidate cannot
 * help, because these describe the caller's account, not one provider:
 *
 * - `unauthorized`: the API key itself is bad (zug/internal/gateway/proxy.go
 *   and errors.go). Every candidate uses the same key, so every candidate
 *   would fail identically.
 * - `limit_exceeded`, `insufficient_balance`: both HTTP 402
 *   (zug/internal/gateway/spendlimit.go's `TrippedLimit`/`InsufficientBalance`,
 *   written by proxy.go's `Handle`). KNOWN LIMITATION, per the governing spec:
 *   `TrippedLimit` carries a `BackendID` and can be scoped to one backend, one
 *   API key, or the whole account, but the gateway exposes that scope only in
 *   the human-readable `Message()` string, never structured on the wire. This
 *   engine does not parse that message -- doing so would be brittle against a
 *   wording change and is explicitly out of scope -- so it aborts
 *   conservatively even when the limit is backend-scoped and a different
 *   candidate could have safely advanced. Revisit if the gateway ever returns
 *   the scope as a structured field.
 *
 * Invalid local arguments (a `BindingError` -- see bindings.ts -- or a
 * malformed/incompatible request shape detected before any network call) are
 * ALSO an abort, but are not a gateway code at all, so they are handled as
 * their own `MechanicalFailure` variant below rather than added to this set.
 */
const ABORT_CODES: ReadonlySet<string> = new Set(['unauthorized', 'limit_exceeded', 'insufficient_balance']);

/**
 * Gateway codes that advance to the next compatible candidate: each one
 * describes a problem with THIS provider (its quota, its configuration, its
 * availability), not the caller's account or the caller's input.
 *
 * - `quota_exceeded`: a backend's OWN per-request budget, not the user's
 *   account balance -- see brightdatabackend/handlers.go's `overBudget`
 *   (HTTP 402, the same status `limit_exceeded`/`insufficient_balance` use).
 *   This is the crux case the spec calls out: a status-first classifier
 *   cannot tell this apart from an account-level 402 and would wrongly abort
 *   the whole run over one provider's exhausted quota.
 * - `rate_limited`: written by the GATEWAY ONLY on the voucher-redeem path
 *   (zug/internal/gateway/vouchers.go:84, HTTP 429), which is not a `/v1/*`
 *   tool call at all. fezoctl never hits that endpoint, so this code is not
 *   normally observable in practice. An upstream provider's real rate limit
 *   instead arrives as a CODE-LESS backend 429 passthrough (see
 *   `RETRYABLE_CODELESS_STATUSES` below), which is why the HTTP-status
 *   fallback -- not this code -- is the load-bearing path for rate limiting.
 *   The code is still classified here for completeness and in case a future
 *   backend cooperatively adopts it (as brightdata did for `quota_exceeded`).
 * - `backend_unavailable`, `provider_disabled`, `backend_not_configured`,
 *   `backend_not_found`, `backend_error`: gateway-written
 *   (zug/internal/gateway/proxy.go's `Handle`), each describing a fault with
 *   the addressed backend specifically -- unhealthy, disabled by the account,
 *   missing required settings, unregistered, or a gateway-side fault
 *   forwarding to it.
 * - `tool_not_in_catalog`: NOT a gateway wire code (it does not appear in
 *   zug/internal/gateway/errors.go) -- it is fezoctl's own client-side
 *   condition for "this tool name is not present in the catalog we just
 *   fetched," raised before any `/v1/{backendId}{path}` call is attempted.
 *   It is classified through the same gateway-code-shaped path as the codes
 *   above (a caller constructs a `{kind:'gateway', code:'tool_not_in_catalog',
 *   ...}` failure) so it shares one classification and one `AttemptLog` shape
 *   with every other candidate-specific problem. In `run`, this module's own
 *   `candidates` are always already-resolved `ToolCandidate`s from the live
 *   catalog, so this condition cannot arise from `run`'s own loop -- but the
 *   CLI's `call <tool>` command (Task 8) resolves a bare tool name against
 *   the catalog BEFORE any candidate list exists, and must classify a failed
 *   resolution through this same code so the two callers share one policy:
 *   `run` skips it and tries the next candidate (there is one); `call` has no
 *   candidate list to advance into, so exhaustion (see `run` below) turns the
 *   very same "retry" classification into an immediate give-up --
 *   exactly mirroring how an ordinary retryable failure on the last candidate
 *   in `run` also ends the run with `give_up`, not a special case.
 */
const RETRY_CODES: ReadonlySet<string> = new Set([
  'quota_exceeded',
  'rate_limited',
  'backend_unavailable',
  'provider_disabled',
  'backend_not_configured',
  'backend_not_found',
  'backend_error',
  'tool_not_in_catalog',
]);

/**
 * HTTP statuses that advance to the next candidate when the response carries
 * NO gateway code at all (a backend passthrough body -- see errors.ts's
 * `BackendErrorResponse`). This is the fallback path, used only when step 1
 * (classify by code) does not apply.
 *
 * 429 is the load-bearing entry here: real upstream rate limiting almost
 * always arrives this way (see the `rate_limited` note above), not as the
 * gateway's own `rate_limited` code. 402/500/502/503 cover a backend's own
 * cooperative-but-codeless payment/availability signal.
 */
const RETRYABLE_CODELESS_STATUSES: ReadonlySet<number> = new Set([402, 429, 500, 502, 503]);

// ---------------------------------------------------------------------------
// Failure classification.
// ---------------------------------------------------------------------------

/**
 * Every kind of *mechanical* (non-network-success) outcome this module's
 * `attemptCandidate` can classify. `CallError` (errors.ts) covers a non-2xx
 * `/v1/*` response, already discriminated into a gateway envelope or an
 * opaque backend passthrough. The two additional variants cover the failure
 * modes that never produce an HTTP response at all:
 *
 * - `invalid-arguments`: a `BindingError` (bindings.ts) -- a manifest/args
 *   mismatch caught locally before any request is sent (missing required
 *   path/query/header/body value, a disallowed header, or `--body-json` on a
 *   GET). This is "invalid local arguments" from the governing spec's abort
 *   list.
 * - `transport`: `fetch` itself rejected (DNS failure, connection refused,
 *   timeout, ...) -- no response was received to classify by code or status.
 */
export type MechanicalFailure =
  | CallError
  | { kind: 'invalid-arguments'; message: string }
  | { kind: 'transport'; message: string };

/** What a single classified failure means for the run: keep going, stop hard, or stop without another try. */
export type FailureDecision = 'retry' | 'abort' | 'give_up';

export interface FailureClassification {
  decision: FailureDecision;
  /** Short human-readable explanation, suitable for `AttemptLog.reason`. */
  reason: string;
  httpStatus?: number;
  gatewayCode?: string;
}

/**
 * Classifies one mechanical failure with strict precedence: gateway code
 * first, HTTP status only as a fallback when there is no code, and NEVER a
 * synthesized code for a code-less backend response (errors.ts already
 * refuses to invent one; this function does not second-guess that).
 *
 * An unrecognized gateway code (one outside both `ABORT_CODES` and
 * `RETRY_CODES`) is classified `give_up` rather than guessed either way: it is
 * a structured signal this engine does not understand, and continuing to
 * spend money against more candidates on an unknown failure shape is exactly
 * what this module exists to prevent. In practice every code the live gateway
 * writes on `/v1/*` is in one of the two sets above (`bad_request`/
 * `not_found` exist in errors.go but are written only by non-`/v1/*`
 * endpoints -- account/billing/limits/vouchers/registry -- that fezoctl never
 * calls), so this branch is a defensive default, not a documented behavior.
 */
export function classifyFailure(failure: MechanicalFailure): FailureClassification {
  switch (failure.kind) {
    case 'invalid-arguments':
      return { decision: 'abort', reason: `invalid local arguments: ${failure.message}` };

    case 'transport':
      return { decision: 'retry', reason: `transport failure: ${failure.message}` };

    case 'gateway': {
      const { code, status } = failure;
      if (ABORT_CODES.has(code)) {
        return { decision: 'abort', reason: `gateway code "${code}"`, httpStatus: status, gatewayCode: code };
      }
      if (RETRY_CODES.has(code)) {
        return { decision: 'retry', reason: `gateway code "${code}"`, httpStatus: status, gatewayCode: code };
      }
      return {
        decision: 'give_up',
        reason: `unrecognized gateway code "${code}"`,
        httpStatus: status,
        gatewayCode: code,
      };
    }

    case 'backend': {
      const { status } = failure;
      if (RETRYABLE_CODELESS_STATUSES.has(status)) {
        return { decision: 'retry', reason: `code-less HTTP ${status}`, httpStatus: status };
      }
      return { decision: 'give_up', reason: `non-retryable HTTP ${status} with no gateway code`, httpStatus: status };
    }
  }
}

// ---------------------------------------------------------------------------
// Attempt log.
// ---------------------------------------------------------------------------

/** One candidate attempt's outcome, in the exact shape the governing spec requires. */
export interface AttemptLog {
  tool: string;
  backendId: string;
  status: 'success' | 'retry' | 'abort' | 'give_up';
  httpStatus?: number;
  gatewayCode?: string;
  reason: string;
  /**
   * True iff the gateway actually returned a 2xx for this attempt -- i.e. the
   * user was billed. Set directly from the response that was received, never
   * inferred from `status`: a `success` attempt is always billed, but so is a
   * `retry` attempt caused by an empty-2xx-with-`--retry-empty-2xx`, which is
   * exactly why this field cannot be derived from `status` alone.
   */
  billed: boolean;
}

function buildLog(
  candidate: ToolCandidate,
  status: AttemptLog['status'],
  reason: string,
  billed: boolean,
  httpStatus?: number,
  gatewayCode?: string,
): AttemptLog {
  return {
    tool: candidate.tool,
    backendId: candidate.backendId,
    status,
    reason,
    billed,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(gatewayCode !== undefined ? { gatewayCode } : {}),
  };
}

// ---------------------------------------------------------------------------
// `run` orchestration.
// ---------------------------------------------------------------------------

/**
 * Emits a diagnostic to stderr, in the same form (and for the same reason) as
 * catalog.ts's, bindings.ts's, and client.ts's `warn`: stdout is reserved for
 * the CLI's machine-readable output.
 */
function warn(message: string): void {
  process.stderr.write(`fezoctl: ${message}\n`);
}

/** Default `--max-attempts`. Raising it spends more money on retries; see `RunOptions.maxAttempts`. */
export const DEFAULT_MAX_ATTEMPTS = 2;

export interface RunOptions {
  /** Gateway base URL; passed through to `callTool`. */
  baseUrl: string;
  apiKey: string;
  /**
   * Candidates to try, in priority order (most-preferred first) -- e.g. a
   * `RunSelection`'s `chosen` candidate followed by the rest of `ranked`, in
   * order, once a caller (Task 8) has decided which selection to run with.
   * This module does not call `selectForRun` itself and does not re-rank;
   * ordering is entirely the caller's responsibility.
   */
  candidates: readonly ToolCandidate[];
  /** Parsed `--args-json` value, tried against every candidate in turn. */
  args: unknown;
  /** Parsed `--body-json` value, if the caller supplied one; see bindings.ts's body-source rule. */
  bodyJson?: unknown;
  /**
   * Maximum number of candidates this run will actually call. Each call that
   * reaches a 2xx response is billed, so raising this above the default
   * spends more money per `run` invocation on retries alone. Defaults to
   * `DEFAULT_MAX_ATTEMPTS` (2). Users can raise it explicitly (Task 8's
   * `--max-attempts`).
   */
  maxAttempts?: number;
  /**
   * Opt-in: treat an empty-bodied 2xx response as retryable and try the next
   * candidate. Off by default -- an empty 2xx has ALREADY been billed, so
   * retrying spends again for a result that may simply be legitimately empty
   * (Task 8's `--retry-empty-2xx`).
   */
  retryEmpty2xx?: boolean;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

/** What `run` decided about the whole attempt sequence, once it stopped. */
export type RunOutcome =
  | { kind: 'success'; candidate: ToolCandidate; result: CallToolResult }
  | { kind: 'aborted'; reason: string }
  | { kind: 'give_up'; reason: string };

export interface RunReport {
  outcome: RunOutcome;
  /** Every candidate actually attempted, in order, each with its own classification. */
  attempts: AttemptLog[];
}

/** True when `bodyText`, once trimmed, is empty -- the only "empty response" test this module makes. */
function isEmptyBody(bodyText: string): boolean {
  return bodyText.trim().length === 0;
}

/**
 * Classifies whatever `callTool` threw into a `MechanicalFailure`: a
 * `BindingError` is invalid local arguments, a `GatewayCallError` carries its
 * own already-discriminated `CallError` (gateway envelope or backend
 * passthrough), and anything else reaching this function is a transport
 * failure -- `callTool` propagates a `fetch` rejection unwrapped rather than
 * throwing a typed error for it (see client.ts), so this is the only place
 * that can distinguish "transport" from the two typed cases.
 */
function classifyThrown(err: unknown): MechanicalFailure {
  if (err instanceof BindingError) {
    return { kind: 'invalid-arguments', message: err.message };
  }
  if (err instanceof GatewayCallError) {
    return err.detail;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'transport', message };
}

/**
 * Attempts exactly one candidate: calls it, and classifies the outcome into
 * an `AttemptLog` plus (on success) the raw `CallToolResult`.
 *
 * Empty-2xx handling lives here, not in `classifyFailure`, because it is not
 * a failure at all from the gateway's point of view -- billing already
 * happened. Whether to treat it as `success` (the default) or `retry` (opt-in
 * via `retryEmpty2xx`) is a policy choice about a SUCCESSFUL call, layered on
 * top of the mechanical-failure taxonomy rather than folded into it.
 */
async function attemptCandidate(
  candidate: ToolCandidate,
  options: Pick<RunOptions, 'baseUrl' | 'apiKey' | 'args' | 'bodyJson' | 'fetchFn'>,
  retryEmpty2xx: boolean,
): Promise<{ log: AttemptLog; result?: CallToolResult }> {
  try {
    const result = await callTool({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      candidate,
      args: options.args,
      ...(options.bodyJson !== undefined ? { bodyJson: options.bodyJson } : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    });

    if (isEmptyBody(result.bodyText)) {
      if (retryEmpty2xx) {
        warn(
          `${candidate.tool}: got an empty response body on a ${result.status} (already billed) and --retry-empty-2xx ` +
            `is set -- trying another candidate, which bills again`,
        );
        return {
          log: buildLog(candidate, 'retry', 'empty 2xx response body (--retry-empty-2xx)', true, result.status),
        };
      }
      return {
        log: buildLog(candidate, 'success', 'empty 2xx response body (not retried; --retry-empty-2xx not set)', true, result.status),
        result,
      };
    }

    return { log: buildLog(candidate, 'success', `${result.status} response`, true, result.status), result };
  } catch (err) {
    const failure = classifyThrown(err);
    const classified = classifyFailure(failure);
    // Every branch reaching here came from a thrown error, not a returned
    // 2xx `CallToolResult` -- `callTool` only ever throws for a non-2xx
    // response or a local/transport problem, never after billing succeeded.
    // So `billed` is unconditionally false here, by construction, not by
    // inspecting `failure`.
    return {
      log: buildLog(
        candidate,
        classified.decision,
        classified.reason,
        false,
        classified.httpStatus,
        classified.gatewayCode,
      ),
    };
  }
}

/**
 * Attempts `options.candidates` in order, stopping at
 * the first success, the first `abort`-classified failure, or once either
 * `maxAttempts` calls have been made or the candidate list is exhausted.
 *
 * Each element of `attempts` reflects ONE candidate's own classification.
 * Loop control:
 *   - `success` -> stop, `outcome.kind === 'success'`.
 *   - `abort`   -> stop immediately, `outcome.kind === 'aborted'`. No further
 *     candidate is tried even if one remains and even if the attempt budget
 *     is not exhausted -- see `classifyFailure`'s abort-code doc comment for
 *     why (an account-wide condition that no other candidate can fix).
 *   - `give_up` -> stop immediately, same as abort but for a DIFFERENT reason:
 *     an unrecognized or non-retryable-without-a-code failure, where this
 *     engine has no evidence that trying another provider is safe or useful,
 *     per the governing spec's give-up list.
 *   - `retry`   -> continue to the next candidate, budget and list permitting.
 *
 * When the loop ends because of exhaustion (no candidates left, or
 * `maxAttempts` reached) rather than because the last attempt was itself
 * `abort`/`give_up`, `outcome.kind` is still `give_up` -- the run simply ran
 * out of room to keep trying -- with a reason describing WHICH exhaustion
 * happened. This is also how a direct `call <tool>` (Task 8, a single-element
 * candidate list) naturally turns a `retry`-classified failure (including
 * `tool_not_in_catalog`) into a hard error: there is no second element to
 * advance into, so the very same "ran out of candidates" path applies with
 * `attempts.length === 1`.
 */
export async function run(options: RunOptions): Promise<RunReport> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryEmpty2xx = options.retryEmpty2xx ?? false;
  const attempts: AttemptLog[] = [];

  if (options.candidates.length === 0) {
    return { outcome: { kind: 'give_up', reason: 'no candidates to try' }, attempts };
  }

  let attemptBudgetExhausted = false;
  for (const candidate of options.candidates) {
    if (attempts.length >= maxAttempts) {
      attemptBudgetExhausted = true;
      break;
    }

    const { log, result } = await attemptCandidate(candidate, options, retryEmpty2xx);
    attempts.push(log);

    if (log.status === 'success') {
      // attemptCandidate always sets `result` alongside a 'success' log; this
      // is an internal-consistency check, not a real runtime possibility.
      if (result === undefined) {
        throw new Error('internal error: a successful attempt has no CallToolResult');
      }
      return { outcome: { kind: 'success', candidate, result }, attempts };
    }
    if (log.status === 'abort') {
      return { outcome: { kind: 'aborted', reason: log.reason }, attempts };
    }
    if (log.status === 'give_up') {
      return { outcome: { kind: 'give_up', reason: log.reason }, attempts };
    }
    // status === 'retry': fall through to the next candidate.
  }

  const reason = attemptBudgetExhausted
    ? `max attempts (${maxAttempts}) reached with candidates remaining`
    : 'no more candidates to try';
  return { outcome: { kind: 'give_up', reason }, attempts };
}
