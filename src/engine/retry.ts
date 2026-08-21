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
import { SchemaValidatorCache, validateArgs } from './schema.js';

// ---------------------------------------------------------------------------
// Classification tables -- verbatim from the governing spec.
// ---------------------------------------------------------------------------

/**
 * Gateway codes that abort the *whole run* -- trying another candidate cannot
 * help, because these describe the caller's account, not one provider:
 *
 * - `unauthorized` (HTTP 401): the gateway writes it when the caller's API key
 *   itself is bad, and every candidate presents that same key, so for the
 *   GATEWAY-emitted 401 every candidate really would fail identically. That
 *   reasoning does NOT cover the whole code: every backend-emitted
 *   `unauthorized` instead means "invalid call token" on the gateway->backend
 *   hop, which is a per-backend deployment fault -- a different backend could
 *   well be provisioned correctly. Abort is kept anyway, for a reason that
 *   holds for both shapes: a 401 is never transient and never
 *   capability-shaped, it always means a credential is wrong somewhere, and no
 *   amount of trying other providers repairs that. Because the wire cannot
 *   tell the two apart, aborting surfaces the credential defect loudly instead
 *   of hiding one backend's misconfiguration behind a silent (and billed)
 *   fallback.
 * - `limit_exceeded`, `insufficient_balance`: both HTTP 402, written by the
 *   gateway's spend-limit check. KNOWN LIMITATION, per the governing spec: a
 *   tripped limit can be scoped to one backend, one API key, or the whole
 *   account, but the gateway exposes that scope only in the human-readable
 *   message string, never structured on the wire. This engine does not parse
 *   that message -- doing so would be brittle against a wording change and is
 *   explicitly out of scope -- so it aborts conservatively even when the limit
 *   is backend-scoped and a different candidate could have safely advanced.
 *   Revisit if the gateway ever returns the scope as a structured field.
 *
 * A per-candidate `BindingError` (bindings.ts) is deliberately NOT an abort and
 * NOT in this set: unlike the three codes above, which are account-scoped
 * without exception, it is computed from ONE candidate's own manifest. It is
 * handled as its own `MechanicalFailure` variant below -- see the
 * `invalid-arguments` note there for why it skips the candidate instead.
 */
// Exported (read-only) so tests/classify_failure.test.ts can assert exact set
// membership over both tables, not just per-code behavior -- see that file's
// comment on why per-code assertions alone cannot catch a new code landing in
// the wrong table.
export const ABORT_CODES: ReadonlySet<string> = new Set(['unauthorized', 'limit_exceeded', 'insufficient_balance']);

/**
 * Gateway codes that advance to the next compatible candidate: each one
 * describes a problem with THIS provider (its quota, its configuration, its
 * availability), not the caller's account or the caller's input.
 *
 * - `quota_exceeded`: a backend's OWN per-request budget, not the user's
 *   account balance -- emitted by a backend's over-budget check (HTTP 402, the
 *   same status `limit_exceeded`/`insufficient_balance` use).
 *   This is the crux case the spec calls out: a status-first classifier
 *   cannot tell this apart from an account-level 402 and would wrongly abort
 *   the whole run over one provider's exhausted quota.
 * - `rate_limited`: written by the GATEWAY ONLY on the voucher-redeem path
 *   (HTTP 429), which is not a `/v1/*`
 *   tool call at all. fezoctl never hits that endpoint, so this code is not
 *   normally observable in practice. An upstream provider's real rate limit
 *   instead arrives as a CODE-LESS backend 429 passthrough (see
 *   `RETRYABLE_CODELESS_STATUSES` below), which is why the HTTP-status
 *   fallback -- not this code -- is the load-bearing path for rate limiting.
 *   The code is still classified here for completeness and in case a future
 *   backend cooperatively adopts it (as a scraping backend already has for
 *   `quota_exceeded`).
 * - `backend_unavailable`, `provider_disabled`, `backend_not_configured`,
 *   `backend_not_found`, `backend_error`: written by the gateway's proxy
 *   handler, each describing a fault with
 *   the addressed backend specifically -- unhealthy, disabled by the account,
 *   missing required settings, unregistered, or a gateway-side fault
 *   forwarding to it.
 * - `tool_not_in_catalog`: NOT a gateway wire code (it does not appear among
 *   the gateway's error codes) -- it is fezoctl's own client-side
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
export const RETRY_CODES: ReadonlySet<string> = new Set([
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
 * The subset of `RETRY_CODES` the GATEWAY writes from a pre-check, before the
 * call is forwarded upstream -- so the attempt cost the user nothing and must
 * not consume `RunOptions.maxAttempts`.
 *
 * `maxAttempts` is a SPEND cap, not a request cap: its own doc (and `run`'s)
 * says the budget "counts CALLS ... i.e. the ones that could have been
 * billed", which is why a local pre-flight skip already leaves it untouched.
 * A gateway pre-check rejection is the same thing one layer out -- the
 * gateway answered without ever calling the provider -- and charging the
 * budget for it produces the bug this set exists to prevent: with every
 * top-ranked provider disabled on the account, a one-step `scrape` spent its
 * whole 3-attempt budget on three free 403s and gave up with `max attempts
 * reached` while the provider the user had actually left enabled sat unasked
 * at rank 6. Nothing was billed and nothing was scraped.
 *
 * Membership is decided by WHERE the gateway writes the code, verified
 * against the proxy handler's resolve -> enforce -> forward flow (zug
 * internal/gateway/proxy.go `Handle`), not by how the failure reads:
 *
 * - `backend_not_found` (404), `backend_unavailable` (503),
 *   `provider_disabled` (403), `backend_not_configured` (403): all four are
 *   written by checks that run BEFORE the forward -- unknown/unregistered
 *   backend, backend not marked available, the account's own per-backend
 *   disable list, and missing required user settings.
 *
 * Deliberately EXCLUDED, and each for a reason -- a code belongs here only
 * when it CANNOT follow an upstream request:
 *
 * - `backend_error`: the gateway writes it both before the forward (call
 *   token, address, request build) and after one fails mid-flight (502).
 *   The post-forward case may have reached the provider, so this code cannot
 *   promise "nothing was billed".
 * - `quota_exceeded`, `rate_limited`: emitted by a BACKEND, which means the
 *   request was already forwarded and the provider's own service handled it.
 * - `tool_not_in_catalog`: fezoctl's own client-side condition, never
 *   reachable inside `run`'s loop (its candidates all come from the live
 *   catalog); it is `call`'s resolution failure, which issues no request at
 *   all and never touches this budget.
 *
 * Exported for the same reason `RETRY_CODES`/`ABORT_CODES` are: so
 * tests/classify_failure.test.ts can assert exact set membership -- including
 * that this set stays a SUBSET of `RETRY_CODES`, since a code that aborts the
 * run has no budget left to spare.
 */
export const UNBILLED_GATEWAY_CODES: ReadonlySet<string> = new Set([
  'backend_not_found',
  'backend_unavailable',
  'provider_disabled',
  'backend_not_configured',
]);

/**
 * True for an attempt the gateway rejected in a pre-check, before forwarding:
 * a real HTTP round-trip (so NOT a `preflight` skip) that still cost nothing.
 * Reads the typed `gatewayCode`, never the attempt's prose -- same rule as
 * one-step.ts's `isCallerFixableArgRejection`.
 */
export function isUnbilledGatewayRejection(attempt: AttemptLog): boolean {
  return attempt.gatewayCode !== undefined && UNBILLED_GATEWAY_CODES.has(attempt.gatewayCode);
}

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
 * - `invalid-arguments`: an args/manifest mismatch caught locally, before any
 *   request is sent. Two sources, both candidate-scoped: a `BindingError`
 *   (bindings.ts -- missing required path/query/header/body value, a disallowed
 *   header, or `--body-json` on a GET), and a failed `input_schema` validation
 *   of the args (schema.ts, checked by `attemptCandidate` before it calls
 *   anything -- see there for why `run` must not bill for what `call` rejects
 *   for free). This SKIPS the candidate (a `retry` decision); it does NOT abort the
 *   run, and because it issues no request it does not consume the attempt
 *   budget either (see `RunOptions.maxAttempts` and `run`). Every
 *   `BindingErrorReason` is derived from one candidate's own manifest,
 *   `bindings`, and `input_schema.required`, so it says nothing about whether
 *   the NEXT candidate will accept the same arguments: two providers serving
 *   one capability may name a parameter differently (`url` vs. `link`), and
 *   `body-not-allowed` fires only because THIS candidate's verb is GET while
 *   the next may be a POST. `disallowed-header` is not caused by the caller at
 *   all -- it fires when a backend publishes a manifest naming a reserved
 *   header, so aborting would let one provider's manifest defect kill a run
 *   the user has no way to repair. Caller-level invalid arguments (an
 *   unparseable `--args-json`/`--body-json` payload, which no candidate could
 *   accept) ARE a genuine abort, but the CLI rejects those while parsing argv,
 *   before `run` selects a candidate, so they never reach this module.
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
 * what this module exists to prevent.
 *
 * That branch IS REACHABLE in production -- do not delete it and do not flip
 * its default. The BACKENDS, not just the gateway, write gateway-shaped
 * envelopes: each one carries its own copy of the same
 * `{"error":{"code","message"}}` writer, the gateway forwards those bodies
 * through `/v1/*` verbatim, and errors.ts therefore parses them as
 * `{kind:'gateway'}` envelopes carrying codes that appear in NO gateway-side
 * table. Observed across the backend fleet: `bad_request` (400, by far the
 * most common -- roughly twenty distinct sites), `not_found` (404),
 * `method_not_allowed` (405), `request_too_large` (413), and
 * `owner_data_forbidden` (403). Giving up is the correct
 * outcome for every one of them -- each describes a request this caller built
 * wrong, an absent resource, or a forbidden one, none of which another
 * provider's identical call would fix -- so the behavior is right; it is
 * simply real, exercised behavior rather than a defensive default. (An earlier
 * revision of this comment called the branch unreachable on the strength of a
 * grep that covered only the gateway's own sources and so missed every
 * backend.)
 */
export function classifyFailure(failure: MechanicalFailure): FailureClassification {
  switch (failure.kind) {
    case 'invalid-arguments':
      // Candidate-scoped, not caller-scoped: skip THIS candidate and let the
      // next one try the same arguments. The reason string names the scope
      // explicitly so an attempt log cannot be misread as "your arguments are
      // wrong" when it means "this provider's manifest could not take them".
      return { decision: 'retry', reason: `candidate rejected the supplied arguments: ${failure.message}` };

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
  /**
   * Present iff this attempt was rejected LOCALLY, before any request was
   * issued -- and which of the two local checks rejected it:
   *
   *   - `'schema'`: the arguments failed this candidate's own `input_schema`.
   *     Caller-fixable: a different argument value would get past it.
   *   - `'binding'`: `bindArgs` refused to build a request (a missing path/
   *     query/header/body value this candidate's manifest requires, or a
   *     disallowed header). NOT caller-fixable in the general case: the
   *     candidate needs a value the caller was never asked for.
   *
   * Absent means a request actually went out (so the attempt may be billed) --
   * for any log THIS module built. cli.ts's `unresolvedToolReport` synthesizes
   * an attempt for a tool that is not in the catalog at all, which issued no
   * request and carries no `preflight` either: it never went through
   * `attemptCandidate`, and there was no candidate to run a local check
   * against. That path is never reached by one-step.ts (a walk is built only
   * from catalog candidates), so the field stays a safe test for "was this a
   * real network call" for the consumer that asks.
   *
   * This distinction is carried as a FIELD rather than left to be recovered
   * from `reason`, because both cases share one `MechanicalFailure` kind
   * (`invalid-arguments`) and therefore one reason prefix -- deliberately, see
   * `classifyFailure`. A consumer that needs to tell "your arguments are
   * wrong" from "this provider's manifest could not take them" (one-step.ts's
   * `argRejected` is the one in this repo) must not re-derive it by matching
   * that prose: the string is worded to prevent exactly that misreading, and a
   * future rewording would silently flip the consumer's answer with no test
   * failing. `preflight` is also the honest test for "was this attempt a real
   * network call", which is otherwise the same prose match.
   */
  preflight?: 'schema' | 'binding';
}

function buildLog(
  candidate: ToolCandidate,
  status: AttemptLog['status'],
  reason: string,
  billed: boolean,
  httpStatus?: number,
  gatewayCode?: string,
  preflight?: AttemptLog['preflight'],
): AttemptLog {
  return {
    tool: candidate.tool,
    backendId: candidate.backendId,
    status,
    reason,
    billed,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(gatewayCode !== undefined ? { gatewayCode } : {}),
    ...(preflight !== undefined ? { preflight } : {}),
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
   *
   * FORBIDDEN SOURCES: never populate this list from a `RunSelection`'s
   * `asyncExcluded` (outcome `async-excluded`) or its `alternatives` (outcome
   * `refused-ambiguous-capability`). rank.ts states that an async lifecycle
   * method must never be auto-called and that `alternatives` is display-only on
   * the one refusal with no override -- but both fields hold
   * candidate-shaped values, so `run({candidates: selection.asyncExcluded,
   * ...})` compiles cleanly and would bill exactly the call rank.ts refused to
   * make. The only legitimate sources are `chosen`/`ranked` from `selected`,
   * and `ranked[0]` from `refused-unhinted-multi-backend` under
   * `--allow-unhinted-auto-pick`. (A compiler-enforced adapter that makes the
   * misuse unrepresentable is Task 8's job, not this module's.)
   */
  candidates: readonly ToolCandidate[];
  /**
   * Parsed `--args-json` value, tried against every candidate in turn.
   *
   * This is the FALLBACK: when `argsFor` (below) is absent, every candidate is
   * called with this exact value and behavior is exactly what it was before
   * `argsFor` existed -- `call`/`run` (Task 8) never pass `argsFor` and are
   * therefore untouched by its addition. `args` stays required (rather than
   * becoming optional once `argsFor` exists) so those two existing callers need
   * no change at all, and so a caller that forgets to pass `argsFor` still gets
   * a well-defined, single-argument-object run instead of `undefined` reaching
   * `callTool`.
   */
  args: unknown;
  /**
   * Per-candidate arguments, for one-step.ts's ranked walk (search/scrape/crawl):
   * each provider names the same single input differently (`query` vs `q` vs
   * `keyword`), so one shared `args` object cannot serve a walk across several
   * providers the way it can for `call`/`run`, which always target one
   * already-resolved tool or one already-selected candidate list that agreed on
   * argument names via `selectForRun`'s search match. When present, this
   * REPLACES `args` for every candidate (`args` is not merged with it); when
   * absent, `args` alone governs, exactly as before this field existed.
   */
  argsFor?: (candidate: ToolCandidate) => unknown;
  /** Parsed `--body-json` value, if the caller supplied one; see bindings.ts's body-source rule. */
  bodyJson?: unknown;
  /**
   * Maximum number of candidates this run will actually call. Each call that
   * reaches a 2xx response is billed, so raising this above the default
   * spends more money per `run` invocation on retries alone. Defaults to
   * `DEFAULT_MAX_ATTEMPTS` (2). Users can raise it explicitly (Task 8's
   * `--max-attempts`).
   *
   * Because this budget governs SPEND, only candidates that actually issue a
   * request consume it. A candidate skipped by a local pre-flight check (a
   * `BindingError`, or args that fail its own `input_schema`) sends nothing and
   * is charged nothing, so it is logged as an attempt but does not decrement
   * the budget -- otherwise one unbindable manifest, or one provider whose
   * schema disagrees with the supplied arguments, would silently halve the real
   * retry budget. See `run`.
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
  /**
   * A wall-clock budget for the WHOLE walk, checked only before starting a new
   * attempt -- never mid-attempt, and never before the first (a slow catalog
   * fetch must not make `run` return "gave up" without ever having called
   * anyone). Absent means no deadline, exactly today's behavior.
   *
   * Ported from mcp-server's one_step.ts `WALK_DEADLINE_MS` reasoning:
   * attempts are sequential, so without a deadline several slow candidates can
   * outlast the CALLER's own timeout -- and a client-side timeout at that point
   * returns nothing, discarding a lower-ranked result this run had already paid
   * for. On expiry, `run` stops starting new attempts and reports what it has;
   * it never aborts an attempt already in flight, because doing so would throw
   * away a response that may already have been billed.
   *
   * `clock` is a test seam (defaults to `Date.now`) so a test can advance
   * fake time without sleeping or shrinking the real production budget; every
   * production caller (one-step.ts) passes only `ms` and takes the default.
   */
  deadline?: { clock?: () => number; ms: number };
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
  /**
   * Set only when a CAP -- not a per-candidate abort/give_up, and not simply
   * running out of candidates -- is what stopped the walk while candidates
   * remained untried: `maxAttempts` was reached (`'max-attempts'`) or
   * `deadline` expired (`'deadline'`). Absent for every other ending,
   * including the two existing `give_up` reasons this field does not change
   * ("no more candidates to try", the all-preflight-skip summary).
   *
   * Exists because `outcome.reason`'s prose already says a cap was hit, but a
   * caller rendering the human/`--json` output needs a stable field to key on
   * rather than parsing that sentence -- "it failed" and "we stopped paying to
   * find out" must not look identical in a document a caller scripts against.
   */
  stoppedBy?: 'max-attempts' | 'deadline';
  /**
   * How many attempts issued a real request but were rejected by a GATEWAY
   * pre-check, before any provider was called -- see `UNBILLED_GATEWAY_CODES`.
   * Absent when there were none.
   *
   * A typed field rather than a sentence appended to `outcome.reason`, for the
   * same reason `AttemptLog.preflight` is one, and for one more specific to
   * this number: cli.ts's `NO_MORE_CANDIDATES_REASON` is deliberately the
   * SAME string the engine produces on exhaustion (a synthesized report for an
   * unresolved tool must not read differently from a real one), so the
   * exhaustion wording is a shared contract this field must not disturb.
   *
   * Worth surfacing because it is the difference between "every provider was
   * tried and failed" and "no provider was ever reached": a run whose whole
   * walk is unbilled rejections spent nothing, scraped nothing, and is fixed
   * by re-enabling a provider -- not by retrying, and not by raising
   * `--max-attempts`, which these attempts no longer consume.
   */
  unbilledRejections?: number;
}

/** True when `bodyText`, once trimmed, is empty -- the only "empty response" test this module makes. */
function isEmptyBody(bodyText: string): boolean {
  return bodyText.trim().length === 0;
}

/**
 * Classifies whatever `callTool` threw into a `MechanicalFailure`: a
 * `BindingError` is a candidate-scoped `invalid-arguments`, a `GatewayCallError`
 * carries its own already-discriminated `CallError` (gateway envelope or
 * backend passthrough), and anything else reaching this function is a transport
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
 *
 * `preflightFailure` tells `run` whether this attempt was rejected locally by
 * `bindArgs` before any request was issued. It is derived from the classified
 * failure's `kind`, not re-sniffed from the log, and `run` uses it for the two
 * things a no-request attempt must not do: consume the spend budget, and be
 * summarized as an ordinary out-of-candidates ending.
 */
async function attemptCandidate(
  candidate: ToolCandidate,
  options: Pick<RunOptions, 'baseUrl' | 'apiKey' | 'args' | 'bodyJson' | 'fetchFn'>,
  retryEmpty2xx: boolean,
  validators: SchemaValidatorCache,
): Promise<{ log: AttemptLog; result?: CallToolResult; preflightFailure: boolean }> {
  // Schema validation is a PRE-FLIGHT check, on the same footing as
  // `bindArgs`'s `BindingError`: it runs before any request, so a candidate
  // that fails it costs nothing and is skipped rather than called.
  //
  // Without it, `run` billed for exactly the arguments `call` rejects for free.
  // `bindArgs` catches a MISSING required path/query/header value, but nothing
  // caught a type or shape mismatch (`{"url": 12345, "depth": "deep"}` against
  // `{url: string, depth: integer}`), so `run` sent it, the backend answered
  // 2xx or 4xx, and the user paid to discover a mistake `call` names locally.
  // Validating per candidate (not once for the whole run) is deliberate: each
  // provider publishes its own `input_schema`, so one candidate rejecting these
  // arguments says nothing about the next — exactly the reasoning behind
  // `invalid-arguments` being a candidate skip rather than an abort.
  //
  // `validateArgs` is used rather than calling the validator and reading
  // `.errors`: validators are cached and shared, and AJV stores `errors` as
  // mutable state on the function object, so a later validation would overwrite
  // an earlier one's errors under any caller that held on to the reference.
  const argsValidation = validateArgs(validators.get(candidate.inputSchema), options.args);
  if (!argsValidation.valid) {
    const failure: MechanicalFailure = {
      kind: 'invalid-arguments',
      message: `arguments do not match ${candidate.tool}'s input schema: ${argsValidation.errorText}`,
    };
    const classified = classifyFailure(failure);
    return {
      log: buildLog(candidate, classified.decision, classified.reason, false, undefined, undefined, 'schema'),
      preflightFailure: true,
    };
  }

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
          preflightFailure: false,
        };
      }
      return {
        log: buildLog(candidate, 'success', 'empty 2xx response body (not retried; --retry-empty-2xx not set)', true, result.status),
        result,
        preflightFailure: false,
      };
    }

    return {
      log: buildLog(candidate, 'success', `${result.status} response`, true, result.status),
      result,
      preflightFailure: false,
    };
  } catch (err) {
    const failure = classifyThrown(err);
    const classified = classifyFailure(failure);
    // `billed` is unconditionally false here by construction (every branch
    // reaching this catch threw instead of returning a 2xx `CallToolResult`),
    // not by inspecting `failure`.
    //
    // KNOWN LIMITATION -- this can UNDER-REPORT spend, and it is recorded here
    // rather than papered over because making spend visible is this module's
    // stated job. `callTool` awaits `fetchFn(...)` and THEN `await
    // response.text()` before it ever looks at the status (client.ts:113-114),
    // while the gateway's proxy handler records the billing event BEFORE it
    // copies the response body downstream. So a connection dropped *while reading
    // the body of an already-billed 2xx* rejects out of client.ts:114, arrives
    // here as an untyped rejection, is classified `transport`, and is logged
    // `billed: false` even though the user was charged. This module cannot
    // distinguish that from a pre-response transport failure without changing
    // client.ts to report whether a response status was received at all, which
    // is out of scope here. Read an attempt log accordingly: a `transport`
    // failure with `billed: false` MAY still correspond to a charge.
    // An `invalid-arguments` reaching THIS catch can only have come from a
    // `BindingError` (`classifyThrown` is the only producer, and schema
    // validation above returns before the try block) -- so it is the
    // `'binding'` half of `preflight`, never the `'schema'` half.
    const preflight = failure.kind === 'invalid-arguments' ? 'binding' : undefined;
    return {
      log: buildLog(
        candidate,
        classified.decision,
        classified.reason,
        false,
        classified.httpStatus,
        classified.gatewayCode,
        preflight,
      ),
      preflightFailure: preflight !== undefined,
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
 * The `maxAttempts` budget counts CALLS, not log entries: a candidate skipped
 * by a local pre-flight check (a `BindingError`, or args that fail that
 * candidate's own `input_schema`) issued no request and was charged nothing, so
 * it appears in `attempts` but leaves the budget untouched.
 * Charging it would let one provider's unbindable manifest silently halve the
 * user's real retry budget, which is the opposite of what a spend limit is for.
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
 *
 * One exhaustion reason is special-cased: when EVERY attempted candidate was
 * skipped by a local pre-flight check, the summary says that no
 * candidate accepted the supplied arguments rather than the generic "no more
 * candidates to try". Skipping (rather than aborting) such a candidate is
 * right, but it must not cost the crisp diagnostic an abort used to give: that
 * run made no call at all, and the user's next move is to fix the arguments,
 * not to retry. The per-candidate messages stay in the attempt log either way.
 */
export async function run(options: RunOptions): Promise<RunReport> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryEmpty2xx = options.retryEmpty2xx ?? false;
  const attempts: AttemptLog[] = [];

  if (options.candidates.length === 0) {
    return { outcome: { kind: 'give_up', reason: 'no candidates to try' }, attempts };
  }

  let attemptBudgetExhausted = false;
  let deadlineExceeded = false;
  // Counts only attempts that actually issued a request -- i.e. the ones that
  // could have been billed. See `RunOptions.maxAttempts`.
  let callsMade = 0;
  let preflightSkips = 0;
  // Attempts that DID issue a request but were rejected by a gateway
  // pre-check, so they cost nothing and left `callsMade` alone. Reported on
  // `RunReport`; it caps nothing.
  let unbilledRejections = 0;
  /** The optional `unbilledRejections` field, spread into every `RunReport`
   * this function builds so no ending can forget it. */
  const unbilled = (): Pick<RunReport, 'unbilledRejections'> => (unbilledRejections > 0 ? { unbilledRejections } : {});
  // One cache for the whole run: two candidates may share an `inputSchema`
  // object, and a retried candidate must not recompile its own.
  const validators = new SchemaValidatorCache();
  // Captured once, before the loop, so every deadline check compares against
  // the SAME instant rather than a moving target. `undefined` when the caller
  // passed no `deadline` -- the check below is skipped entirely in that case,
  // which is what makes this option additive (no `deadline` -> no new
  // behavior at all). See `RunOptions.deadline`.
  const clock = options.deadline?.clock ?? Date.now;
  const deadlineAt = options.deadline !== undefined ? clock() + options.deadline.ms : undefined;

  for (const candidate of options.candidates) {
    if (callsMade >= maxAttempts) {
      attemptBudgetExhausted = true;
      break;
    }
    // Never checked before the first attempt (`attempts.length === 0`): a slow
    // catalog fetch or a slow caller must not make the very first candidate's
    // attempt itself subject to the deadline -- see `RunOptions.deadline`.
    if (attempts.length > 0 && deadlineAt !== undefined && clock() >= deadlineAt) {
      deadlineExceeded = true;
      break;
    }

    // Per-candidate args when the caller supplied `argsFor` (one-step.ts's
    // ranked walk); `options.args` otherwise -- see `RunOptions.argsFor`'s doc
    // comment for why one shared `args` object cannot serve every candidate in
    // that walk. Building a narrowed options object here (rather than
    // `{...options, args: candidateArgs}`) keeps `attemptCandidate`'s
    // signature exactly what it was before this field existed.
    const candidateArgs = options.argsFor ? options.argsFor(candidate) : options.args;
    const attemptOptions: Pick<RunOptions, 'baseUrl' | 'apiKey' | 'args' | 'bodyJson' | 'fetchFn'> = {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      args: candidateArgs,
      ...(options.bodyJson !== undefined ? { bodyJson: options.bodyJson } : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    };
    const { log, result, preflightFailure } = await attemptCandidate(candidate, attemptOptions, retryEmpty2xx, validators);
    attempts.push(log);
    if (preflightFailure) {
      preflightSkips += 1;
    } else if (isUnbilledGatewayRejection(log)) {
      // A real round-trip, but the gateway answered from a pre-check without
      // forwarding, so nothing was billed and the spend-shaped budget is
      // untouched -- see `UNBILLED_GATEWAY_CODES`. Counted separately rather
      // than not at all: the walk is still bounded (by the candidate list and
      // by `deadline`, which is wall-clock and so DOES cover these), and the
      // count is what lets the exhaustion summary below say that the budget
      // was never the thing that ran out.
      unbilledRejections += 1;
    } else {
      callsMade += 1;
    }

    if (log.status === 'success') {
      // attemptCandidate always sets `result` alongside a 'success' log; this
      // is an internal-consistency check, not a real runtime possibility.
      if (result === undefined) {
        throw new Error('internal error: a successful attempt has no CallToolResult');
      }
      // The count rides along on EVERY ending, not just exhaustion: a success
      // at rank 6 that got there past five disabled providers is precisely the
      // case a caller wants to see, and it is invisible in `outcome` alone.
      return { outcome: { kind: 'success', candidate, result }, attempts, ...unbilled() };
    }
    if (log.status === 'abort') {
      return { outcome: { kind: 'aborted', reason: log.reason }, attempts, ...unbilled() };
    }
    if (log.status === 'give_up') {
      return { outcome: { kind: 'give_up', reason: log.reason }, attempts, ...unbilled() };
    }
    // status === 'retry': fall through to the next candidate.
  }

  // Every attempted candidate refused the arguments locally, so no request was
  // ever sent: say so, instead of implying the run ran out of providers to try.
  // (Unreachable via the budget branch by construction -- a pre-flight skip
  // never decrements the budget -- but tested independently of that reasoning.
  // Reachable together with `deadlineExceeded`, though: a deadline is wall-clock
  // time, not request count, so a very short one can still expire while every
  // attempt made so far was an instant local skip. The preflight-skip summary
  // still wins in that case -- it is the more actionable diagnostic either way.)
  const everyAttemptWasAPreflightSkip = attempts.length > 0 && preflightSkips === attempts.length;
  const reason = everyAttemptWasAPreflightSkip
    ? `no candidate accepted the supplied arguments: all ${attempts.length} candidate(s) rejected them before any request was sent (see the attempt log for each candidate's reason)`
    : deadlineExceeded
      ? `wall-clock deadline (${String(options.deadline?.ms)}ms) reached with candidates remaining`
      : attemptBudgetExhausted
        ? `max attempts (${maxAttempts}) reached with candidates remaining`
        : 'no more candidates to try';
  // Independent of `reason`'s wording/precedence above: `stoppedBy` reports
  // WHICH cap actually cut the loop short, even on the preflight-skip
  // sentence, because "a cap was reached" and "nothing was ever callable" are
  // both true statements a caller may want to distinguish. A typed local
  // (rather than an inline `'deadline' as const`/`'max-attempts' as const` in
  // the returned object) is what lets this stay assertion-free: TypeScript
  // widens a bare string literal in an object-literal position, but not one
  // assigned to an already-narrowly-typed `let`.
  let stoppedBy: RunReport['stoppedBy'];
  if (deadlineExceeded) stoppedBy = 'deadline';
  else if (attemptBudgetExhausted) stoppedBy = 'max-attempts';

  return {
    outcome: { kind: 'give_up', reason },
    attempts,
    ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    ...unbilled(),
  };
}
