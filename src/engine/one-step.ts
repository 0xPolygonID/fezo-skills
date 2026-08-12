// The `web-search`/`scrape`/`crawl` one-step commands: each takes a single
// value (a query, or a URL) and walks the declared, per-intent ranking
// (providers.ts) top-down until one provider answers, falling back on a
// retryable failure. Ported from mcp-server/src/one_step.ts's *selection*
// half -- which providers to try, in what order, and how to resolve each
// one's own argument name for the caller's single value.
//
// Deliberately NOT ported: mcp-server's own retry/execution loop. That loop
// classifies a result as `retryable` vs. `terminal` using a coarser rule than
// this repo's gateway-code-first classification (retry.ts's `classifyFailure`,
// and the module doc there on why status-first classification gets real cases
// backwards). Reusing retry.ts's `run()` for EXECUTION -- while this module
// keeps SELECTION -- means billing accounting and that classification stay
// governed in exactly one place; this module never opens a second HTTP call
// loop of its own. See `runOneStep`.

import type { ToolCandidate } from './catalog.js';
import type { Intent } from './intent.js';
import { viewForIntent } from './provider-view.js';
import { isExcluded, recommendationsFor } from './providers.js';
import { run } from './retry.js';
import type { AttemptLog, RunReport } from './retry.js';
import type { OneStepCommand } from './steering.js';

// ---------------------------------------------------------------------------
// Defensive JSON-Schema reads -- same idiom as catalog.ts's `asRecord`, for
// the same reason: `inputSchema` is `object`-typed catalog data (ultimately
// backend-supplied), and `src/` reads it without a type assertion.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Argument-name resolution -- verbatim from mcp-server/src/one_step.ts.
// ---------------------------------------------------------------------------

/**
 * Candidate argument names, in preference order, for the single value a
 * one-step command forwards to whichever provider it lands on.
 *
 * Necessary because each provider names the same input differently and the
 * one-step commands deliberately expose one uniform argument. Resolution
 * reads the target method's own `input_schema`, so a provider whose
 * vocabulary is not listed here degrades to "skipped", never to a malformed
 * call.
 *
 * Candidates here are all single-string properties: a provider that names its
 * URL argument `urls` (plural) almost always types it as an array, and the
 * caller's value is a bare string, so it would fail schema validation and the
 * provider would be skipped -- fail-closed, but a dead entry. An array-typed
 * URL parameter needs an explicit per-provider override, not a name added
 * here.
 */
const ARG_CANDIDATES: Record<'query' | 'url', readonly string[]> = {
  query: ['query', 'q', 'search', 'search_query', 'keyword', 'keywords', 'term', 'text', 'prompt'],
  url: ['url', 'target_url', 'page_url', 'link', 'website', 'start_url'],
};
Object.freeze(ARG_CANDIDATES.query);
Object.freeze(ARG_CANDIDATES.url);
Object.freeze(ARG_CANDIDATES);

/**
 * Resolves which property of `inputSchema` carries the caller's single value.
 *
 * A *required* candidate beats an optional one regardless of list position: a
 * provider that requires `keyword` and also accepts an optional `query` wants
 * `keyword`, and calling it with only the optional one fails schema
 * validation. Among equals, `ARG_CANDIDATES` order decides.
 *
 * Returns `undefined` when the schema names nothing plausible -- the caller
 * must then skip that provider rather than guess.
 */
export function resolveArgName(inputSchema: object, kind: 'query' | 'url'): string | undefined {
  const schema = asRecord(inputSchema);
  const props = schema ? asRecord(schema.properties) : undefined;
  if (!props) return undefined;

  const required = new Set(schema ? asStringArray(schema.required) : []);
  const present = ARG_CANDIDATES[kind].filter((name) => name in props);
  if (present.length === 0) return undefined;

  const preferred = present.find((name) => required.has(name));
  if (preferred !== undefined) return preferred;

  // `present.length > 0` was just checked above; `noUncheckedIndexedAccess`
  // still types `present[0]` as possibly `undefined`, so this guard satisfies
  // the type-checker rather than handling a real runtime case -- same idiom as
  // preference.ts's `only`/`winner` guards.
  const first = present[0];
  if (first === undefined) return undefined;
  return first;
}

// ---------------------------------------------------------------------------
// Command declarations.
// ---------------------------------------------------------------------------

/** One one-step command's declaration: its CLI name, the intent it serves, and
 * what its single positional argument means. */
export interface OneStepSpec {
  /** The CLI command name (`fezoctl <command> ...`). Shares its literal type
   * with steering.ts's `OneStepCommand` so the two modules' command
   * vocabularies cannot silently diverge, without one importing the other's
   * tables. */
  command: OneStepCommand;
  intent: Intent;
  /** Which `ARG_CANDIDATES` bucket -- and which of the value's meanings
   * ("what to search for" vs. "which page/site to fetch") -- this command's
   * single positional argument represents. */
  argKind: 'query' | 'url';
}

export const ONE_STEP_SPECS: readonly OneStepSpec[] = [
  { command: 'web-search', intent: 'search', argKind: 'query' },
  { command: 'scrape', intent: 'scrape', argKind: 'url' },
  { command: 'crawl', intent: 'crawl', argKind: 'url' },
];
for (const spec of ONE_STEP_SPECS) Object.freeze(spec);
Object.freeze(ONE_STEP_SPECS);

/**
 * How many providers one one-step call may bill before giving up.
 *
 * Each attempt is a paid request against the user's own provider account, so
 * an uncapped walk would turn a single `web-search`/`scrape`/`crawl` call into
 * a sweep of the whole ranked list -- the caller asked for one search and paid
 * for five. Three is enough to get past a blocked target or a rate-limited
 * primary, which is what the fallback exists for. Ported from mcp-server's
 * one_step.ts: same constant, same value, same reasoning.
 */
export const MAX_PROVIDER_ATTEMPTS = 3;

/**
 * Wall-clock budget for the whole walk, in milliseconds -- passed straight
 * through as retry.ts's `RunOptions.deadline.ms`; see that field's doc for why
 * a deadline exists at all (a client-side timeout discards a result already
 * paid for). Ported from mcp-server's one_step.ts `WALK_DEADLINE_MS`, same
 * value, same reasoning: attempts are sequential, so without a deadline three
 * slow scrapes can outlast the CALLER's own tool timeout.
 */
export const WALK_DEADLINE_MS = 60_000;

// ---------------------------------------------------------------------------
// Building the walk.
// ---------------------------------------------------------------------------

/** One provider this walk will try, in the order it will try them. */
export interface WalkStep {
  candidate: ToolCandidate;
  /** The resolved single-argument name on THIS candidate's own schema --
   * different providers under the same intent can (and do) name it
   * differently; see `resolveArgName`. */
  argName: string;
  backendId: string;
  displayName: string;
  /**
   * This step's position in `viewForIntent(candidates, spec.intent, excluded)`
   * -- NEVER a second counter kept by this module's own loop.
   *
   * mcp-server's one_step.ts states why, and the same reasoning applies here
   * verbatim: an earlier version of this walk counted rank by incrementing
   * across its own loop, and that count silently drifted from
   * `viewForIntent`'s numbering TWICE -- once when a declared provider was
   * absent from the caller's catalog entitlement, and once when a provider was
   * entitled but published no callable method at all (`viewForIntent`'s
   * `buildRow` drops that provider from the ranked list too, so it consumes no
   * rank there either -- but a loop-local counter that only knows "did I skip
   * this one" cannot reproduce that same drop without re-deriving `buildRow`'s
   * own rules). Reading the rank out of the one place that actually computes
   * it is what keeps the two numbers from disagreeing a third time.
   */
  rank: number;
}

export interface BuildWalkResult {
  /** The ordered list of providers this walk will actually try, most-preferred
   * first -- becomes retry.ts's `run()` candidate list, via `.candidate`. */
  walk: WalkStep[];
  /** Every declared provider this walk did NOT include, with a short reason,
   * e.g. `"apify (not in catalog)"`. Never names a deny-listed or
   * `notRecommended` provider: those are passed over silently, before any
   * reason would be assigned -- see the loop below. */
  skipped: string[];
}

/**
 * Builds the ranked, catalog-checked walk for one one-step command: the
 * ordered list of providers `runOneStep` will hand to retry.ts's `run()`,
 * plus every declared provider this walk passed over and why.
 *
 * Walks `recommendationsFor(spec.intent)` top-down (declared rank order,
 * never re-sorted) and, for each provider that is not deny-listed and not
 * `notRecommended`:
 *
 * 1. Skip if the backend has no method at all in the live `candidates` list --
 *    "not in catalog" for this caller's entitlement.
 * 2. Skip if `viewForIntent` assigned it no rank for this intent.
 *
 *    PORTING NOTE: in mcp-server this is a genuinely distinct case from (1) --
 *    a backend can be *registered* with zero methods, which is "in the
 *    catalog" but still unranked there. fezo-skills' catalog has no such
 *    state (see catalog.ts/provider-view.ts's own porting notes on why there
 *    is no separate "backend record" apart from its `ToolCandidate`s), so a
 *    backend with zero candidates in `candidates` is exactly what (1) already
 *    tests -- in THIS port, (2) can only fire when (1) would also have fired.
 *    It stays anyway, as its own case with its own message, for two reasons:
 *    it is what keeps "rank must come from `viewForIntent`, never a second
 *    counter" true even for this line (see `WalkStep.rank`'s doc), and it is
 *    a correct safety net if `viewForIntent`'s rules ever grow a reason a
 *    backend WITH live candidates still gets no rank -- a case (1) alone
 *    would silently wave through as "ranked" when it is not.
 * 3. Otherwise, take the first of the provider's declared `entryMethods` that
 *    both exists in the live catalog (by tool name) and whose `input_schema`
 *    yields a `resolveArgName` for this command's `argKind`; skip with a
 *    reason if none of the declared entry methods qualifies.
 *
 * Does NOT validate the caller's `extra` against the resolved candidate's own
 * schema -- that check needs the caller's actual `value`/`extra`, which this
 * function does not take. It is instead left to retry.ts's `run()` own
 * pre-flight schema check, once `runOneStep` supplies per-candidate args via
 * `argsFor`; see `runOneStep`'s doc for how `argRejected` is derived from that
 * check's results rather than re-run here.
 */
export function buildWalk(spec: OneStepSpec, candidates: readonly ToolCandidate[], excluded: readonly string[]): BuildWalkResult {
  const byBackend = new Map<string, ToolCandidate[]>();
  for (const c of candidates) {
    const list = byBackend.get(c.backendId);
    if (list) list.push(c);
    else byBackend.set(c.backendId, [c]);
  }

  const rankByBackend = new Map(viewForIntent(candidates, spec.intent, excluded).map((row) => [row.backendId, row.rank]));

  const walk: WalkStep[] = [];
  const skipped: string[] = [];

  for (const rec of recommendationsFor(spec.intent)) {
    // Deny-listed and notRecommended providers are passed over silently --
    // never attempted, and never even named in `skipped`, because both are
    // policy exclusions decided ahead of time, not something this specific
    // call discovered about them.
    if (rec.notRecommended || isExcluded(rec.backendId, excluded)) continue;

    const backendCandidates = byBackend.get(rec.backendId);
    if (!backendCandidates) {
      skipped.push(`${rec.backendId} (not in catalog)`);
      continue;
    }

    const rank = rankByBackend.get(rec.backendId);
    if (rank === undefined) {
      skipped.push(`${rec.backendId} (no callable method)`);
      continue;
    }

    let matched: { candidate: ToolCandidate; argName: string } | undefined;
    for (const entry of rec.entryMethods) {
      const candidate = backendCandidates.find((c) => c.tool === entry);
      if (!candidate) continue;
      const argName = resolveArgName(candidate.inputSchema, spec.argKind);
      if (argName !== undefined) {
        matched = { candidate, argName };
        break;
      }
    }
    if (!matched) {
      skipped.push(`${rec.backendId} (no ${spec.argKind} argument)`);
      continue;
    }

    walk.push({ candidate: matched.candidate, argName: matched.argName, backendId: rec.backendId, displayName: rec.displayName, rank });
  }

  return { walk, skipped };
}

// ---------------------------------------------------------------------------
// Running the walk.
// ---------------------------------------------------------------------------

/**
 * Did this candidate reject the args THIS walk assembled, in a way the caller
 * can fix by editing `--extra-json`?
 *
 * Reads retry.ts's typed `AttemptLog.preflight`, never the attempt's prose.
 * The two local rejections share one `MechanicalFailure` kind and therefore
 * one reason prefix (deliberately -- see `classifyFailure`), so a prose match
 * cannot separate them, and only ONE of them is the caller's to fix:
 *
 *   - `'schema'` IS caller-fixable -- the assembled `{...extra, [argName]:
 *     value}` failed that provider's own `input_schema`, so a different
 *     `--extra-json` gets past it. This is what mcp-server's `argRejected`
 *     means and the only thing this repo reports under that name.
 *   - `'binding'` is NOT -- the provider's manifest requires a path/query/
 *     header value a one-step command never asks for. Telling a caller who
 *     passed no `--extra-json` at all that "the --extra-json arguments did not
 *     match" would name a knob they never turned, so this case is reported as
 *     an ordinary skip instead.
 */
function isCallerFixableArgRejection(attempt: AttemptLog): boolean {
  return attempt.preflight === 'schema';
}

/** True for any attempt that never issued a request -- either local rejection.
 * `served` and the real-attempt count must both key on this rather than on
 * `isCallerFixableArgRejection`: a binding-rejected candidate made no network
 * call either, so counting it as one would name a provider that never ran. */
function isPreflightRejection(attempt: AttemptLog): boolean {
  return attempt.preflight !== undefined;
}

/** One ranked walk's finished result: what was tried, what was skipped and
 * why, which provider (if any) ultimately answered, and the full billing
 * report `run()` produced for it. */
export interface OneStepResult {
  spec: OneStepSpec;
  /** The value the caller passed (the query, or the URL) -- echoed back for
   * render.ts's output. */
  value: string;
  /** The `--max-attempts`-equivalent cap this walk actually ran under -- see
   * `runOneStep`'s `maxAttempts` parameter. Echoed back so a human-readable
   * cap note can name the number that was actually in force, not always the
   * default `MAX_PROVIDER_ATTEMPTS`. */
  maxAttempts: number;
  report: RunReport;
  /** Declared providers this walk never attempted at all, i.e. passed over
   * before any candidate list was handed to `run()` -- so a provider that WAS
   * attempted and rejected locally is not here (see `argRejected` and
   * `manifestRejected`, which are reported even on a successful run, whereas
   * this list is surfaced only when nothing served the call). Absent from the
   * catalog, unranked, or with no resolvable argument. See `buildWalk`. */
  skipped: string[];
  /**
   * Providers whose OWN schema rejected the args this walk assembled
   * (`{...extra, [argName]: value}`) -- reported even on an otherwise
   * successful run.
   *
   * Ported verbatim as a rule from mcp-server's one_step.ts: without it,
   * "rank 1 was blocked" and "your `extra` disqualified rank 1" produce the
   * exact same output, and only one of those is something the caller can fix
   * by editing `--extra-json`.
   */
  argRejected: string[];
  /**
   * Providers that WERE reached in the walk but whose own manifest needed an
   * argument this command cannot supply -- a `bindArgs` refusal (a required
   * path/query/header value), not a schema mismatch.
   *
   * Separate from both neighbours on purpose, because it is neither:
   *   - not `argRejected`, which promises "this one is yours to fix by editing
   *     --extra-json"; this one is a fact about the provider's manifest, and a
   *     caller who passed no --extra-json at all cannot act on it;
   *   - not `skipped`, whose members were never attempted and which is only
   *     surfaced when NOTHING served the call. These providers were attempted,
   *     they have an attempt-log entry, and -- like `argRejected` -- they must
   *     be reported even on an otherwise successful run: silently demoting
   *     rank 1 and reporting only who did serve it is the exact failure
   *     `argRejected` exists to prevent, and it is no better when the cause is
   *     the manifest rather than the arguments.
   */
  manifestRejected: string[];
  /** The last provider this walk actually called over the network -- never a
   * provider whose args were rejected locally before any request went out --
   * and whether that call is this run's final SUCCESS. Absent when nothing in
   * the walk was ever really reached (every candidate was skipped by
   * `buildWalk`, or every attempt made was a local arg rejection). */
  served?: { backendId: string; displayName: string; rank: number; success: boolean };
}

/**
 * Runs one one-step command's ranked walk: builds it (`buildWalk`), then hands
 * the resulting candidate list to retry.ts's `run()` -- REUSING that loop
 * rather than opening a second one, so billing accounting and the
 * gateway-code-first retry/abort/give_up classification retry.ts documents at
 * length stay governed in exactly one place. This function's own job is
 * SELECTION (which candidates, in what order, with which per-candidate args)
 * and INTERPRETATION of `run()`'s report (who ultimately served it, whose
 * args were rejected) -- it must never grow a second call loop of its own.
 *
 * `maxAttempts`/`deadline` default to this module's `MAX_PROVIDER_ATTEMPTS`/
 * `WALK_DEADLINE_MS`. cli.ts overrides `maxAttempts` for `--max-attempts`;
 * `deadline` has no CLI override, mirroring mcp-server, which has none either.
 */
export async function runOneStep(
  spec: OneStepSpec,
  value: string,
  extra: Record<string, unknown>,
  candidates: readonly ToolCandidate[],
  excluded: readonly string[],
  gateway: { baseUrl: string; apiKey: string; fetchFn?: typeof fetch },
  maxAttempts: number = MAX_PROVIDER_ATTEMPTS,
  deadline: { clock?: () => number; ms: number } = { ms: WALK_DEADLINE_MS },
): Promise<OneStepResult> {
  const { walk, skipped } = buildWalk(spec, candidates, excluded);

  // Keyed by tool name, not by candidate identity: two providers never share a
  // tool name (tool-name.ts), which makes this simpler than a WeakMap for a
  // lookup table that is rebuilt fresh on every call anyway.
  const stepByTool = new Map(walk.map((step) => [step.candidate.tool, step]));

  const report = await run({
    baseUrl: gateway.baseUrl,
    apiKey: gateway.apiKey,
    candidates: walk.map((step) => step.candidate),
    // Fallback only (see retry.ts's `RunOptions.args` doc): every element of
    // `candidates` above came from `walk`, and the `argsFor` below always has
    // an entry for each of them, so this value is never actually read in
    // practice. It exists only because `args` is a required field on
    // `RunOptions`.
    args: { ...extra, [spec.argKind]: value },
    argsFor: (candidate) => {
      const step = stepByTool.get(candidate.tool);
      // Unreachable given the comment above -- `run()` only ever calls
      // `argsFor` with a candidate drawn from the list this function just
      // built from `walk` itself -- but `Map.get` is typed to return
      // `undefined` and `src/` does not assert past that, so the fallback is
      // written out rather than asserted away.
      return step !== undefined ? { ...extra, [step.argName]: value } : { ...extra, [spec.argKind]: value };
    },
    maxAttempts,
    deadline,
    ...(gateway.fetchFn !== undefined ? { fetchFn: gateway.fetchFn } : {}),
  });

  const argRejected: string[] = [];
  const manifestRejected: string[] = [];
  for (const attempt of report.attempts) {
    const step = stepByTool.get(attempt.tool);
    if (step === undefined) continue;
    if (isCallerFixableArgRejection(attempt)) argRejected.push(step.displayName);
    // A binding rejection is a fact about that provider's manifest, not about
    // the caller's input -- reported, but never under a name that tells the
    // caller to go edit an argument they may never have passed.
    else if (attempt.preflight === 'binding') manifestRejected.push(step.displayName);
  }

  // The last attempt that was an actual network call (success, or a real
  // mechanical failure) -- never a locally rejected one, of either kind.
  // Mirrors mcp-server's `last`, which one_step.ts sets only once
  // `tool.call(...)` actually ran. `undefined` means nothing in the whole walk
  // was ever really reached.
  const realAttempts = report.attempts.filter((attempt) => !isPreflightRejection(attempt));
  const lastReal = realAttempts[realAttempts.length - 1];
  const servedStep = lastReal !== undefined ? stepByTool.get(lastReal.tool) : undefined;
  const served =
    servedStep !== undefined
      ? {
          backendId: servedStep.backendId,
          displayName: servedStep.displayName,
          rank: servedStep.rank,
          success: report.outcome.kind === 'success',
        }
      : undefined;

  return {
    spec,
    value,
    maxAttempts,
    report,
    skipped,
    argRejected,
    manifestRejected,
    ...(served !== undefined ? { served } : {}),
  };
}
