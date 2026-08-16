// Output formatting for `fezoctl` (Task 8's CLI). This module owns
// presentation only: every function here takes data already produced by the
// engine (catalog.ts, rank.ts, bindings.ts, retry.ts, credentials.ts) and
// returns a finished string, either compact text or a `JSON.stringify`-ready
// document. It never fetches, binds, validates, calls, or resolves anything
// itself — src/cli.ts owns composing the engine and choosing what to render;
// keeping that split is what makes these functions testable without argv, a
// network, or a filesystem.
//
// Every function here is pure and synchronous.

import type { HttpBindings, ToolCandidate } from './catalog.js';
import type { BoundRequest } from './bindings.js';
import type { CredentialDisplay, StoreCredentialsResult } from './credentials.js';
import type { Intent } from './intent.js';
import type { OneStepResult } from './one-step.js';
import { capTitle } from './aggregate.js';
import type { RoutingPlan } from './plan.js';
import type { AnnotatedProviderRow, CapabilityGroup, ListedProviderRow, ProviderRow } from './provider-view.js';
import { NOT_SUBSTITUTES_NOTE, annotate, annotateListed } from './provider-view.js';
import { RECOMMENDATION_SOURCE } from './providers.js';
import type { Tier } from './providers.js';
import type { RankExplanation, RankedCandidate, RunSelection } from './rank.js';
import type { ResearchOutcome } from './research.js';
import type { AttemptLog, RunOutcome, RunReport } from './retry.js';
import { failureFooter, successFooter } from './steering.js';

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Best-effort structured view of a raw response body: parsed JSON if it parses, the raw text otherwise. */
function parseResultBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

interface CandidateSummary {
  tool: string;
  backendId: string;
  method: string;
  title?: string;
  description: string;
  httpMethod: 'GET' | 'POST';
  path: string;
  billingModel: 'per_call' | 'dynamic' | 'package';
}

function summarizeCandidate(candidate: ToolCandidate): CandidateSummary {
  return {
    tool: candidate.tool,
    backendId: candidate.backendId,
    method: candidate.method,
    description: candidate.description,
    httpMethod: candidate.httpMethod,
    path: candidate.path,
    billingModel: candidate.billingModel,
    ...(candidate.title !== undefined ? { title: candidate.title } : {}),
  };
}

function summarizeCandidateLine(candidate: ToolCandidate): string {
  const title = candidate.title !== undefined ? ` — ${candidate.title}` : '';
  return `${candidate.tool} (${candidate.backendId}.${candidate.method}, ${candidate.httpMethod} ${candidate.path}, ${candidate.billingModel})${title}`;
}

function explainRank(explanation: RankExplanation): string {
  const parts: string[] = [explanation.tier];
  if (explanation.matchedTerms.length > 0) parts.push(`matched: ${explanation.matchedTerms.join(', ')}`);
  parts.push(`termScore=${String(explanation.termScore)}`);
  if (explanation.preference !== undefined) {
    parts.push(`preferred for "${explanation.preference.capability}" (position ${String(explanation.preference.position)})`);
  }
  return parts.join('; ');
}

interface SchemaAndBindings {
  httpMethod: 'GET' | 'POST';
  path: string;
  bindings: HttpBindings;
  inputSchema: object;
  outputSchema?: object;
}

function schemaAndBindings(candidate: ToolCandidate): SchemaAndBindings {
  return {
    httpMethod: candidate.httpMethod,
    path: candidate.path,
    bindings: candidate.bindings,
    inputSchema: candidate.inputSchema,
    ...(candidate.outputSchema !== undefined ? { outputSchema: candidate.outputSchema } : {}),
  };
}

function renderBindingsText(bindings: HttpBindings): string {
  const lines: string[] = [];
  if (bindings.method !== undefined) lines.push(`  method: ${bindings.method}`);
  if (bindings.query !== undefined) lines.push(`  query: [${bindings.query.join(', ')}]`);
  if (bindings.path_params !== undefined) lines.push(`  path_params: [${bindings.path_params.join(', ')}]`);
  if (bindings.header !== undefined) lines.push(`  header: [${bindings.header.join(', ')}]`);
  if (bindings.request_body !== undefined) lines.push(`  request_body: ${toJson(bindings.request_body)}`);
  if (bindings.response_body !== undefined) lines.push(`  response_body: ${toJson(bindings.response_body)}`);
  return lines.length > 0 ? lines.join('\n') : '  (no declared binding — defaults apply)';
}

// ---------------------------------------------------------------------------
// --version
// ---------------------------------------------------------------------------

export function renderVersion(version: string, json: boolean): string {
  if (json) return toJson({ version });
  return `fezoctl ${version}`;
}

// ---------------------------------------------------------------------------
// Failures under `--json`.
//
// Every `--json` failure path writes THIS document to stdout, so a script never
// has to special-case "empty stdout means go read the English on stderr" for
// some failures and not others. The human-readable message still goes to
// stderr, and exit codes are unchanged; this is purely an additional,
// machine-readable statement of the same failure.
//
// `kind` is a closed, STABLE set — it is the contract agents script against, so
// values may be added but must not be renamed or repurposed. The union type is
// what keeps it closed: a call site cannot invent a seventh value without
// changing this declaration.
//
// Not used for a `call`/`run` that reached the engine and came back with a
// report: those already emit their full attempt-log document (which carries the
// failure in `outcome`/`result`, plus what was billed), and replacing it with a
// bare error envelope would LOSE information. This shape is for failures that
// happen before, or instead of, a report existing.
// ---------------------------------------------------------------------------

export type CliErrorKind =
  /** Bad command, bad/missing flag, or an unparseable `--args-json`/`--body-json`. Exit 1. */
  | 'usage'
  /**
   * No API key could be resolved from any source. Exit 2. The gateway URL
   * cannot cause this — it falls back to `DEFAULT_GATEWAY_URL`.
   */
  | 'credentials-not-configured'
  /** The catalog could not be fetched, or could not be parsed once fetched. Exit 2. */
  | 'catalog-unavailable'
  /** `schema <tool>`: the named tool is not in the live catalog. Exit 2. */
  | 'tool-not-found'
  /** `--args-json` failed validation against the resolved tool's `inputSchema`. Exit 2. */
  | 'invalid-args'
  /** `--body-json` failed validation against the binding's own media-type schema. Exit 2. */
  | 'invalid-body'
  /** `--version` could not read the version out of `package.json`. Exit 2. */
  | 'version-unavailable'
  /**
   * `call`/`run` resolved to (or, for `run`, would have auto-picked by an
   * exact tool-name match) a backend on the deny-list
   * (`FEZO_EXCLUDED_BACKENDS` / providers.ts's `isExcluded`). Exit 2.
   * Distinct from `tool-not-found`: the tool genuinely exists in the live
   * catalog -- this CLI simply refuses to call it, regardless of what the
   * gateway serves, and regardless of whether the caller named it exactly.
   */
  | 'backend-excluded';

export function renderError(kind: CliErrorKind, message: string): string {
  return toJson({ error: { kind, message } });
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export interface SearchRenderOptions {
  json: boolean;
  includeSchema: boolean;
}

export function renderSearch(ranked: readonly RankedCandidate[], query: string, options: SearchRenderOptions): string {
  if (options.json) {
    return toJson({
      query,
      count: ranked.length,
      results: ranked.map(({ candidate, explanation }) => ({
        ...summarizeCandidate(candidate),
        rank: explanation,
        ...(options.includeSchema ? { schema: schemaAndBindings(candidate) } : {}),
      })),
    });
  }

  if (ranked.length === 0) {
    return `search "${query}" — no matches`;
  }

  const lines = [`search "${query}" — ${String(ranked.length)} match(es)`];
  ranked.forEach(({ candidate, explanation }, index) => {
    lines.push(`${String(index + 1)}. ${summarizeCandidateLine(candidate)}`);
    lines.push(`   rank: ${explainRank(explanation)}`);
    if (options.includeSchema) {
      lines.push(`   input_schema: ${toJson(candidate.inputSchema)}`);
      if (candidate.outputSchema !== undefined) lines.push(`   output_schema: ${toJson(candidate.outputSchema)}`);
      lines.push(renderBindingsText(candidate.bindings));
    }
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

export function renderSchema(candidate: ToolCandidate, json: boolean): string {
  if (json) {
    return toJson({ ...summarizeCandidate(candidate), ...schemaAndBindings(candidate) });
  }

  const lines = [
    `${candidate.tool}`,
    `  backend: ${candidate.backendId}`,
    `  method: ${candidate.method}`,
    `  call: ${candidate.httpMethod} ${candidate.path}`,
    `  input_schema: ${toJson(candidate.inputSchema)}`,
  ];
  if (candidate.outputSchema !== undefined) lines.push(`  output_schema: ${toJson(candidate.outputSchema)}`);
  lines.push('  bindings:');
  lines.push(renderBindingsText(candidate.bindings));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

export interface CallRenderInput {
  tool: string;
  candidate?: ToolCandidate;
  boundRequest?: BoundRequest;
  report: RunReport;
}

function outcomeToJson(outcome: RunOutcome): object {
  switch (outcome.kind) {
    case 'success':
      return {
        kind: 'success',
        backendId: outcome.candidate.backendId,
        tool: outcome.candidate.tool,
        status: outcome.result.status,
        body: parseResultBody(outcome.result.bodyText),
      };
    case 'aborted':
      return { kind: 'aborted', reason: outcome.reason };
    case 'give_up':
      return { kind: 'give_up', reason: outcome.reason };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

function renderOutcomeText(outcome: RunOutcome): string[] {
  switch (outcome.kind) {
    case 'success':
      return [`result (status ${String(outcome.result.status)}):`, toJson(parseResultBody(outcome.result.bodyText))];
    case 'aborted':
      return [`aborted: ${outcome.reason}`];
    case 'give_up':
      return [`give up: ${outcome.reason}`];
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/**
 * The billing statement every attempt log carries. The governing spec requires
 * the output to STATE that a 2xx attempt is billed — a bare `billed=true` flag
 * only reports it, and leaves a reader to infer what it means and whether a
 * retried run charged them once or twice. Exported so `--json` can carry the
 * identical sentence rather than a second, drifting wording of the same rule.
 */
export const BILLING_STATEMENT =
  'every attempt that reached a 2xx response is billed by the provider (billed=true); attempts that failed or were skipped before a request was sent are not billed';

function renderAttemptsText(attempts: readonly AttemptLog[]): string[] {
  if (attempts.length === 0) return ['attempts: (none)'];
  const lines = ['attempts:'];
  attempts.forEach((attempt, index) => {
    const httpStatus = attempt.httpStatus !== undefined ? ` httpStatus=${String(attempt.httpStatus)}` : '';
    const gatewayCode = attempt.gatewayCode !== undefined ? ` gatewayCode=${attempt.gatewayCode}` : '';
    lines.push(
      `  ${String(index + 1)}. ${attempt.tool} (${attempt.backendId}) [${attempt.status}] billed=${String(attempt.billed)}${httpStatus}${gatewayCode} — ${attempt.reason}`,
    );
  });
  lines.push(`  billing: ${BILLING_STATEMENT}`);
  return lines;
}

export function renderCall(input: CallRenderInput, json: boolean): string {
  const billedAnyAttempt = input.report.attempts.some((attempt) => attempt.billed);

  if (json) {
    return toJson({
      tool: input.tool,
      resolved: input.candidate !== undefined,
      ...(input.candidate !== undefined ? { backendId: input.candidate.backendId, method: input.candidate.method } : {}),
      ...(input.boundRequest !== undefined ? { request: input.boundRequest } : {}),
      attempts: input.report.attempts,
      outcome: outcomeToJson(input.report.outcome),
      billedAnyAttempt,
      billing: BILLING_STATEMENT,
    });
  }

  const lines = [`call ${input.tool}`];
  if (input.candidate !== undefined) {
    lines.push(`resolved: ${input.candidate.backendId}.${input.candidate.method} (${input.candidate.httpMethod} ${input.candidate.path})`);
  } else {
    lines.push('resolved: (tool not found in catalog)');
  }
  if (input.boundRequest !== undefined) {
    lines.push(`request: ${toJson(input.boundRequest)}`);
  }
  lines.push(...renderAttemptsText(input.report.attempts));
  lines.push(`billed: ${String(billedAnyAttempt)}`);
  lines.push(...renderOutcomeText(input.report.outcome));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export interface RunRenderInput {
  intent: string;
  selection: RunSelection;
  allowUnhintedAutoPick: boolean;
  /**
   * The candidate list `run()` was actually given — cli.ts's `candidatesToRun`
   * output, in order. This renderer must NOT re-derive it (in particular, must
   * not reach for `selection.ranked[0]` to name the candidate promoted under
   * `--allow-unhinted-auto-pick`): the promotion rule decides which backend
   * gets billed, cli.ts owns it, and a second copy here could drift into naming
   * a candidate other than the one that was called. Empty (or absent) means
   * nothing was called.
   */
  runCandidates?: readonly ToolCandidate[];
  report?: RunReport;
}

export function renderRun(input: RunRenderInput, json: boolean): string {
  const { selection } = input;
  const billedAnyAttempt = input.report?.attempts.some((attempt) => attempt.billed) ?? false;

  if (json) {
    const base: Record<string, unknown> = {
      intent: input.intent,
      // `selection`, not `outcome`: `call`'s `--json` document uses `outcome`
      // for the CALL's outcome object, and `run` puts its call outcome under
      // `result`. One field name meaning two different things across two
      // commands is a trap for anything scripting against both.
      selection: selection.outcome,
    };
    switch (selection.outcome) {
      case 'no-match':
        break;
      case 'async-excluded':
        base.asyncExcluded = selection.asyncExcluded.map(summarizeCandidate);
        break;
      case 'selected':
        base.chosen = { ...summarizeCandidate(selection.chosen.candidate), rank: selection.chosen.explanation };
        base.ranked = selection.ranked.map(({ candidate, explanation }) => ({ ...summarizeCandidate(candidate), rank: explanation }));
        break;
      case 'refused-ambiguous-capability':
        base.capabilities = selection.reason.capabilities;
        base.alternatives = selection.alternatives.map(({ candidate, explanation }) => ({
          ...summarizeCandidate(candidate),
          rank: explanation,
        }));
        break;
      case 'refused-unhinted-multi-backend': {
        base.backends = selection.reason.backends;
        base.overridable = true;
        base.overridden = input.allowUnhintedAutoPick;
        base.ranked = selection.ranked.map(({ candidate, explanation }) => ({ ...summarizeCandidate(candidate), rank: explanation }));
        break;
      }
      default: {
        const exhaustive: never = selection;
        return exhaustive;
      }
    }
    if (input.report !== undefined) {
      base.attempts = input.report.attempts;
      base.result = outcomeToJson(input.report.outcome);
      base.billedAnyAttempt = billedAnyAttempt;
      base.billing = BILLING_STATEMENT;
    }
    return toJson(base);
  }

  const lines = [`run "${input.intent}"`];
  switch (selection.outcome) {
    case 'no-match':
      lines.push('no candidates matched this intent');
      break;
    case 'async-excluded':
      lines.push('every matching candidate is an async lifecycle method (start/poll/status/fetch-result), so none was auto-picked:');
      for (const candidate of selection.asyncExcluded) lines.push(`  - ${summarizeCandidateLine(candidate)}`);
      lines.push('name the tool exactly (`fezoctl call <tool>`), or add "async"/"job"/"snapshot"/"status"/"crawl" to the intent to allow one');
      break;
    case 'selected':
      lines.push(`selected: ${summarizeCandidateLine(selection.chosen.candidate)}`);
      lines.push(`  why: ${explainRank(selection.chosen.explanation)}`);
      break;
    case 'refused-ambiguous-capability':
      lines.push(`refused: intent matches more than one capability (${selection.reason.capabilities.join(', ')}); not overridable`);
      lines.push('alternatives (not called):');
      for (const { candidate } of selection.alternatives) lines.push(`  - ${summarizeCandidateLine(candidate)}`);
      break;
    case 'refused-unhinted-multi-backend':
      lines.push(
        `refused: candidates span multiple backends with no capability preference (${selection.reason.backends.join(', ')}); ` +
          'use --allow-unhinted-auto-pick to pick the top-ranked one, or call a specific tool',
      );
      if (input.allowUnhintedAutoPick) {
        // Named from the list the caller actually passed to `run()`, never
        // re-derived from `selection.ranked` — see `RunRenderInput.runCandidates`.
        const promoted = input.runCandidates?.[0];
        if (promoted !== undefined) lines.push(`--allow-unhinted-auto-pick set: promoting ${summarizeCandidateLine(promoted)}`);
      }
      break;
    default: {
      const exhaustive: never = selection;
      return exhaustive;
    }
  }

  if (input.report !== undefined) {
    lines.push(...renderAttemptsText(input.report.attempts));
    lines.push(`billed: ${String(billedAnyAttempt)}`);
    lines.push(...renderOutcomeText(input.report.outcome));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// web-search / scrape / crawl (one-step.ts's ranked walk)
//
// Everything here composes data one-step.ts already produced (`OneStepResult`)
// with steering.ts's footer sentences. Per this file's module doc, this is
// where presentation decisions live -- in particular, the routing note (which
// provider served the result, any providers `--extra-json` disqualified, any
// cap that stopped the walk) is prose ONLY in the human view; under `--json`
// the governing spec requires the same information as fields, not text
// appended to a document, so a script reads `served`/`arg_rejected`/
// `stopped_by` directly rather than parsing a sentence.
// ---------------------------------------------------------------------------

/** Wire shape one `OneStepResult` renders as under `--json`. snake_case,
 * matching every other wire type in this module (`AnnotatedProviderRow`,
 * `AnnotatedListedProviderRow`). */
interface OneStepJson {
  command: string;
  intent: Intent;
  value: string;
  max_attempts: number;
  served?: { backend_id: string; provider: string; rank: number; success: boolean };
  /** Providers whose own schema rejected the assembled args -- the caller's to
   * fix by editing `--extra-json`. See one-step.ts's `argRejected`. */
  arg_rejected: string[];
  /** Providers reached but whose MANIFEST needed an argument this command does
   * not supply -- not the caller's to fix. Separate from `arg_rejected` so a
   * script can tell "your argument cost you rank 1" from "rank 1 is not
   * reachable this way". See one-step.ts's `manifestRejected`. */
  manifest_rejected: string[];
  skipped: string[];
  stopped_by?: 'max-attempts' | 'deadline';
  attempts: readonly AttemptLog[];
  result: object;
  billed_any_attempt: boolean;
  billing: string;
}

export function renderOneStep(result: OneStepResult, json: boolean): string {
  const { spec, value, maxAttempts, report, served, argRejected, manifestRejected, skipped } = result;
  const billedAnyAttempt = report.attempts.some((attempt) => attempt.billed);

  if (json) {
    const doc: OneStepJson = {
      command: spec.command,
      intent: spec.intent,
      value,
      max_attempts: maxAttempts,
      ...(served !== undefined
        ? { served: { backend_id: served.backendId, provider: served.displayName, rank: served.rank, success: served.success } }
        : {}),
      arg_rejected: argRejected,
      manifest_rejected: manifestRejected,
      skipped,
      ...(report.stoppedBy !== undefined ? { stopped_by: report.stoppedBy } : {}),
      attempts: report.attempts,
      result: outcomeToJson(report.outcome),
      billed_any_attempt: billedAnyAttempt,
      billing: BILLING_STATEMENT,
    };
    return toJson(doc);
  }

  const lines = [`${spec.command} "${value}"`];
  if (served !== undefined) {
    lines.push(
      served.success
        ? successFooter(served.displayName, spec.intent, served.rank)
        : failureFooter(served.displayName, spec.intent, served.rank),
    );
  } else {
    // Nothing in the walk was ever actually reached -- every declared
    // provider was either passed over by `buildWalk` (named in `skipped`) or
    // had its assembled args rejected before any request went out (named in
    // `argRejected`, reported separately below). Adapted from mcp-server's
    // one_step.ts "No zug provider could serve..." message, pointed at
    // fezoctl's own commands instead of zug's MCP tool names.
    const skippedText = skipped.length > 0 ? ` Skipped: ${skipped.join('; ')}.` : '';
    lines.push(
      `No provider could serve ${spec.intent} for this input.${skippedText} Run ` +
        `\`fezoctl providers --intent ${spec.intent}\` to inspect the ranking, then \`fezoctl call <tool>\` ` +
        'or `fezoctl run` to target one directly.',
    );
  }
  if (argRejected.length > 0) {
    // Reported even when `served` above is a success -- see one-step.ts's
    // `OneStepResult.argRejected` doc for why this must never be silent.
    lines.push(
      `Skipped ${argRejected.join(', ')}: the --extra-json arguments did not match their schema -- run ` +
        `\`fezoctl providers --intent ${spec.intent} --detail schema\` to see what each provider accepts.`,
    );
  }
  if (manifestRejected.length > 0) {
    // Unconditional for the same reason as `argRejected` directly above, and
    // deliberately NOT folded into the `skipped` list, which is printed only
    // when nothing served the call: a higher-ranked provider dropped out on a
    // successful run is exactly the case the caller cannot otherwise see. The
    // wording names the manifest, not the caller's arguments -- see
    // one-step.ts's `manifestRejected` doc.
    lines.push(
      `Skipped ${manifestRejected.join(', ')}: that provider's manifest requires an argument ` +
        `\`${spec.command}\` does not supply -- run \`fezoctl schema <tool>\` to see its bindings, then ` +
        '`fezoctl call <tool>` to supply them yourself.',
    );
  }
  if (report.stoppedBy === 'max-attempts') {
    lines.push(`Stopped after ${String(maxAttempts)} provider(s); lower-ranked ones were not tried.`);
  } else if (report.stoppedBy === 'deadline') {
    lines.push('Stopped on the time budget; lower-ranked providers were not tried.');
  }
  lines.push(...renderAttemptsText(report.attempts));
  lines.push(`billed: ${String(billedAnyAttempt)}`);
  lines.push(...renderOutcomeText(report.outcome));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

export function renderCatalog(candidates: readonly ToolCandidate[], json: boolean): string {
  const byBackend = new Map<string, ToolCandidate[]>();
  for (const candidate of candidates) {
    const list = byBackend.get(candidate.backendId);
    if (list) list.push(candidate);
    else byBackend.set(candidate.backendId, [candidate]);
  }

  if (json) {
    return toJson({
      totalMethods: candidates.length,
      backends: [...byBackend.entries()].map(([backendId, methods]) => ({
        backendId,
        billingModel: methods[0]?.billingModel,
        methods: methods.map((candidate) => ({
          tool: candidate.tool,
          method: candidate.method,
          httpMethod: candidate.httpMethod,
          path: candidate.path,
          description: candidate.description,
          ...(candidate.title !== undefined ? { title: candidate.title } : {}),
        })),
      })),
    });
  }

  if (byBackend.size === 0) return 'catalog: (no backends)';

  const lines = [`catalog — ${String(byBackend.size)} backend(s), ${String(candidates.length)} method(s)`];
  for (const [backendId, methods] of byBackend) {
    lines.push(`${backendId}:`);
    for (const candidate of methods) {
      lines.push(`  ${candidate.tool} (${candidate.httpMethod} ${candidate.path}) — ${candidate.description}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// providers / list-providers
//
// Both commands render provider-view.ts data. `renderProviders` covers the
// per-intent view (`viewForIntent`/`groupByCapability`); `renderListProviders`
// covers the cross-intent merge (`listProviders`). Detail-level shaping
// (`names`/`descriptions`/`schema`) and `--limit` truncation happen here,
// not in cli.ts or provider-view.ts, on the same principle as the rest of
// this module: engine code produces data, this file decides what a command
// actually prints.
// ---------------------------------------------------------------------------

/** How many fallback method names a `names`-detail row carries when the
 * provider has no declared entry point for this intent -- enough to act on,
 * few enough to keep the sweep this detail level exists for cheap. */
const NAMES_FALLBACK_METHODS = 3;

/**
 * `--detail names` shape: the minimal, cheap-to-scan row for a wide sweep.
 *
 * "Cheap" means it omits the why/when prose, the full method list, and any
 * inlined schema -- NOT that it omits identity. It carries exactly the fields
 * the human `names` view prints on its own identity line (rank, tier,
 * provider, backend_id, billing, and the rated/not-recommended flags), because
 * the two views must not disagree about what a detail level means: a script
 * reading `providers --intent social --json` at the default level has to be
 * able to see that a provider is advised against, which a human running the
 * same command without `--json` sees as `[not recommended]`.
 */
interface NamesRow {
  backend_id: string;
  rank: number;
  tier: Tier;
  provider: string;
  billing: ProviderRow['billing'];
  /** False only for a backend no declared list mentions at all. */
  rated: boolean;
  /** Present only for a provider assessed and advised against. */
  not_recommended?: { reason: string };
  /** The provider's declared entry points for this intent. Empty for an
   * off-list or unrated provider -- the declared lists name entry points per
   * capability and neither case has one -- in which case `methods` carries a
   * fallback so the row is still actionable. */
  entry_methods: string[];
  /** Present only when `entry_methods` is empty: the first few of this
   * provider's name-sorted methods, so `--detail names` never returns a row
   * with nothing callable on it. A separate key on purpose -- these are not
   * declared entry points and must not be mistaken for them. */
  methods?: string[];
  /** How many further method names `methods` dropped, present only when that
   * number is non-zero. The human view prints the same cap as `(+N more)`;
   * emitting it here too is this module's own rule that "a truncation a caller
   * cannot see is the failure mode the `omitted` rule exists to prevent" --
   * which applies at least as much to the machine-readable view, where there
   * is no other way to tell three methods from three-of-nine. */
  methods_omitted?: number;
  /** The ranking's provenance, present only under `--explain`. Carried at this
   * detail level too because `--explain` is documented (HELP_TEXT and README)
   * as adding provenance to EVERY row, and `names` is the default detail --
   * so dropping it here made the flag a no-op on the most common `--json`
   * path while the human view printed it. */
  source?: { doc: string; prepared: string };
}

function toNamesRow(row: AnnotatedProviderRow): NamesRow {
  const base = {
    backend_id: row.backend_id,
    rank: row.rank,
    tier: row.tier,
    provider: row.provider,
    billing: row.billing,
    rated: row.rated,
    entry_methods: row.entry_methods,
    ...(row.not_recommended !== undefined ? { not_recommended: row.not_recommended } : {}),
    ...(row.source !== undefined ? { source: row.source } : {}),
  };
  if (row.entry_methods.length > 0) return base;
  const omitted = Math.max(0, row.methods.length - NAMES_FALLBACK_METHODS);
  return {
    ...base,
    methods: row.methods.slice(0, NAMES_FALLBACK_METHODS),
    ...(omitted > 0 ? { methods_omitted: omitted } : {}),
  };
}

/** Maps every candidate's tool name to its own `inputSchema`, for `--detail
 * schema`'s `method_schemas` lookup. Built once per render call, not once per
 * row: two providers never share a tool name (see tool-name.ts), so one flat
 * map covers the whole session's catalog. */
function schemaByToolName(candidates: readonly ToolCandidate[]): Map<string, object> {
  const map = new Map<string, object>();
  for (const c of candidates) map.set(c.tool, c.inputSchema);
  return map;
}

type RenderedProviderRow = NamesRow | AnnotatedProviderRow | (AnnotatedProviderRow & { method_schemas: Record<string, object> });

export interface ProvidersRenderOptions {
  json: boolean;
  /** Present when the caller scoped the request to one intent (`--intent`).
   * `providers` then renders exactly that one group's fields at the top
   * level, with no `groups` wrapper and no `NOT_SUBSTITUTES_NOTE` (comparing
   * across capabilities isn't at stake when the caller already picked one). */
  intent?: Intent;
  detail: 'names' | 'descriptions' | 'schema';
  limit: number;
  explain: boolean;
  /** Every candidate in the current session's catalog; consulted only at
   * `--detail schema`, to look up each surfaced method's input schema by tool
   * name (`schemaByToolName`). */
  candidates: readonly ToolCandidate[];
}

function renderOneProviderRow(row: ProviderRow, options: ProvidersRenderOptions, schemas: Map<string, object>): RenderedProviderRow {
  const annotated = annotate(row, { explain: options.explain });
  if (options.detail === 'names') return toNamesRow(annotated);
  if (options.detail === 'schema') {
    const method_schemas: Record<string, object> = {};
    for (const m of row.methods) {
      const s = schemas.get(m);
      if (s !== undefined) method_schemas[m] = s;
    }
    return { ...annotated, method_schemas };
  }
  return annotated;
}

/**
 * Text rendering of one provider row, honouring `--detail` and `--explain`
 * exactly as the `--json` path does -- HELP_TEXT documents `--detail` as
 * output verbosity, not as a `--json`-only shape, so the two views must agree
 * about what each level means:
 *
 *   - `names`: the cheap sweep -- the identity line plus what is callable
 *     (`entry_methods`, or a capped `methods` sample when the provider has no
 *     declared entry point for this intent). No why/when prose: that is what
 *     `descriptions` is for, and printing it here made the default level and
 *     `descriptions` produce identical output.
 *   - `descriptions`: adds why / when / not_recommended, and the provider's
 *     FULL method list. Nothing is capped at this level -- a caller who asked
 *     for the fuller view must not be silently handed three of eight methods.
 *   - `schema`: adds the tool names whose input schemas `--json` would inline,
 *     as a pointer to `fezoctl schema <tool>`. The schemas themselves are not
 *     printed: a JSON Schema per method is machine-readable output, and this
 *     is the human view.
 *
 * `--explain` adds the same per-row provenance citation `annotate` adds to the
 * wire shape (the doc and when it was read), so the flag has the same visible
 * reach in both views.
 */
function renderProviderRowText(row: ProviderRow, options: ProvidersRenderOptions, schemas: Map<string, object>): string[] {
  const flags = [row.rated ? undefined : 'unrated', row.notRecommended !== undefined ? 'not recommended' : undefined].filter(
    (f): f is string => f !== undefined,
  );
  const flagsText = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
  const lines = [`  ${String(row.rank)}. [${row.tier}] ${row.provider} (${row.backendId}, ${row.billing})${flagsText}`];

  const verbose = options.detail !== 'names';
  if (verbose) {
    lines.push(`     why: ${row.why}`);
    if (row.when !== undefined) lines.push(`     when: ${row.when}`);
    if (row.notRecommended !== undefined) lines.push(`     not_recommended: ${row.notRecommended.reason}`);
  }

  if (row.entryMethods.length > 0) lines.push(`     entry_methods: [${row.entryMethods.join(', ')}]`);
  if (verbose) {
    lines.push(`     methods: [${row.methods.join(', ')}]`);
  } else if (row.entryMethods.length === 0) {
    // The `names`-level fallback so the cheap sweep never returns a row with
    // nothing callable on it. Capped -- but the count of what the cap dropped
    // is printed, because a truncation a caller cannot see is the failure mode
    // the `omitted` rule exists to prevent.
    const shown = row.methods.slice(0, NAMES_FALLBACK_METHODS);
    const more = row.methods.length - shown.length;
    lines.push(`     methods: [${shown.join(', ')}]${more > 0 ? ` (+${String(more)} more)` : ''}`);
  }

  if (options.detail === 'schema') {
    const withSchemas = row.methods.filter((m) => schemas.has(m));
    if (withSchemas.length > 0) {
      lines.push(`     schemas: [${withSchemas.join(', ')}] — run \`fezoctl schema <tool>\` for each`);
    }
  }

  if (options.explain) {
    lines.push(`     source: ${RECOMMENDATION_SOURCE.doc} (prepared ${RECOMMENDATION_SOURCE.preparedAt})`);
  }
  return lines;
}

export function renderProviders(groups: readonly CapabilityGroup[], options: ProvidersRenderOptions): string {
  const schemas = options.detail === 'schema' ? schemaByToolName(options.candidates) : new Map<string, object>();

  const rendered = groups.map((group) => {
    const truncated = group.providers.slice(0, options.limit);
    const omitted = Math.max(0, group.providers.length - truncated.length);
    return {
      group,
      truncated,
      omitted,
      rows: truncated.map((row) => renderOneProviderRow(row, options, schemas)),
    };
  });

  if (options.json) {
    if (options.intent !== undefined) {
      const only = rendered[0];
      return toJson({
        recommendations: RECOMMENDATION_SOURCE,
        capability: options.intent,
        ...(only?.group.bestValue !== undefined ? { best_value: only.group.bestValue } : {}),
        omitted: only?.omitted ?? 0,
        providers: only?.rows ?? [],
      });
    }
    return toJson({
      recommendations: RECOMMENDATION_SOURCE,
      note: NOT_SUBSTITUTES_NOTE,
      groups: rendered.map(({ group, omitted, rows }) => ({
        capability: group.capability,
        ...(group.bestValue !== undefined ? { best_value: group.bestValue } : {}),
        omitted,
        providers: rows,
      })),
    });
  }

  const lines: string[] = [`recommendations: ${RECOMMENDATION_SOURCE.doc} (prepared ${RECOMMENDATION_SOURCE.preparedAt})`];
  if (options.intent === undefined) lines.push(NOT_SUBSTITUTES_NOTE);

  for (const { group, omitted, truncated } of rendered) {
    const bestValueText = group.bestValue ?? '(none)';
    const omittedText = omitted > 0 ? `, omitted: ${String(omitted)}` : '';
    lines.push(`\n${group.capability} — best_value: ${bestValueText}${omittedText}`);
    if (truncated.length === 0) {
      lines.push('  (no providers)');
      continue;
    }
    for (const row of truncated) lines.push(...renderProviderRowText(row, options, schemas));
  }
  return lines.join('\n');
}

export function renderListProviders(rows: readonly ListedProviderRow[], json: boolean): string {
  if (json) {
    return toJson({ recommendations: RECOMMENDATION_SOURCE, providers: rows.map(annotateListed) });
  }

  if (rows.length === 0) return 'providers: (none)';

  const lines = [
    `recommendations: ${RECOMMENDATION_SOURCE.doc} (prepared ${RECOMMENDATION_SOURCE.preparedAt})`,
    `providers — ${String(rows.length)} backend(s)`,
  ];
  for (const row of rows) {
    const status = row.rated ? '' : ' [unrated]';
    lines.push(`  ${row.provider} (${row.backendId}, ${row.billing})${status}`);
    if (row.why !== undefined) lines.push(`    why: ${row.why}`);
    if (row.when !== undefined) lines.push(`    when: ${row.when}`);
    lines.push(`    categories: [${row.categories.join(', ')}]`);
    lines.push(`    methods: [${row.methods.join(', ')}]`);
    if (row.recommendations.length > 0) {
      lines.push('    recommendations:');
      for (const rec of row.recommendations) {
        const notRecommendedText = rec.notRecommended !== undefined ? ` (not recommended: ${rec.notRecommended.reason})` : '';
        // "declared rank", not bare "rank": this is the position in
        // providers.ts's declared table, which is deliberately not the
        // catalog-filtered rank `providers` prints -- see
        // `ListedProviderRow.recommendations`' doc comment. Saying which one
        // it is here is what stops a reader comparing the two outputs and
        // concluding one of them is wrong.
        lines.push(`      ${rec.intent}: declared rank ${String(rec.rank)} (${rec.tier}) — ${rec.why}${notRecommendedText}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  message: string;
  /**
   * Extra structured detail for `--json`, e.g. `credentialDisplay(...)`'s
   * output. Never a raw credential — callers must only ever put
   * `credentialDisplay`'s result (or other non-secret data) here.
   */
  details?: Record<string, unknown>;
}

export function renderDoctor(checks: readonly DoctorCheck[], json: boolean): string {
  if (json) {
    return toJson({ checks });
  }

  const lines = ['doctor:'];
  for (const check of checks) {
    lines.push(`  [${check.status}] ${check.name}: ${check.message}`);
    if (check.details !== undefined) lines.push(`      ${toJson(check.details)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

export interface SetupRenderInput {
  result: StoreCredentialsResult;
  display: CredentialDisplay;
}

/**
 * One field's storage outcome as a phrase.
 *
 * Three states, not two: a successful write that could NOT be read back and
 * confirmed must not print a bare "stored". `cmdSetup` marks that case
 * `{ok: true, reason: 'unverified-shadowed-by-<source>'}` — the write itself
 * reported success and a higher-priority source legitimately shadowing
 * resolution is not a storage failure, but the output must not claim more than
 * was actually checked.
 */
function describeStoreOutcome(outcome: { ok: boolean; reason?: string; message?: string }): string {
  if (!outcome.ok) return `failed (${outcome.message ?? outcome.reason ?? 'unknown error'})`;
  if (outcome.reason !== undefined) {
    return `stored, but NOT verified — ${outcome.message ?? outcome.reason}`;
  }
  return 'stored';
}

/**
 * Whether the credential state `setup` just produced is actually usable —
 * which, since the gateway URL always resolves (`DEFAULT_GATEWAY_URL` backstops
 * it), comes down to whether an API key resolved. `fezoctl`'s every other
 * command needs one (`requireCredentials` in cli.ts refuses with
 * `credentials-not-configured` without it), so this is the condition that
 * decides both what `renderSetup` prints and what `cmdSetup` exits with — one
 * definition, two callers, so the message and the exit code cannot disagree.
 *
 * It still takes the whole `CredentialDisplay` rather than just the key: the
 * question it answers is "is this configuration usable", and if a second
 * required value is ever added the callers should not have to change.
 */
export function setupProducedUsableConfig(display: CredentialDisplay): boolean {
  return display.apiKey !== undefined;
}

export function renderSetup(input: SetupRenderInput, json: boolean): string {
  const usable = setupProducedUsableConfig(input.display);

  if (json) {
    // `usable` is emitted explicitly rather than left implicit in
    // `configured.apiKey`'s absence: a machine reader that only checks
    // `result.apiKey.ok` would otherwise read a key-less setup as a success.
    return toJson({ result: input.result, configured: input.display, usable });
  }

  const lines = [`setup — storage: ${input.result.storage}`];
  lines.push(`  api key: ${describeStoreOutcome(input.result.apiKey)}`);
  if (input.result.url !== undefined) {
    lines.push(`  url: ${describeStoreOutcome(input.result.url)}`);
  }
  // The source is always named, so a URL nobody configured never looks like one
  // somebody did: `(source: default)` is the built-in gateway, not a choice.
  lines.push(`  configured url: ${input.display.url.value} (source: ${input.display.url.source})`);
  if (input.display.apiKey !== undefined) lines.push(`  configured api key: ${input.display.apiKey.masked} (source: ${input.display.apiKey.source})`);
  else lines.push('  configured api key: (not configured)');
  if (!usable) {
    lines.push('  this configuration is NOT usable yet: fezoctl needs an API key.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// plan / research (Task 10-11's fan-out executor)
// ---------------------------------------------------------------------------

/** The plan on its own (`fezoctl plan`) -- no network, no billing, so this is
 * the cheapest way for a caller to see what routing a prompt would get. */
export function renderPlan(plan: RoutingPlan, json: boolean): string {
  if (json) return toJson(plan);
  const lines = [
    `intents:  ${plan.intents.join(', ')}`,
    `queries:  ${plan.queries.length > 0 ? plan.queries.map((q) => `"${q}"`).join(', ') : '(none)'}`,
    `targets:  ${plan.targets.length > 0 ? plan.targets.join(', ') : '(none)'}`,
    `depth:    ${plan.depth} (fan-out ${String(plan.fanout)} providers per query)`,
    `source:   ${plan.source}`,
    `signals:  ${plan.signals.length > 0 ? plan.signals.join('; ') : '(none)'}`,
    '',
    'Override any field: --intents, --queries, --targets, --depth, --fanout, or --plan-json.',
  ];
  return lines.join('\n');
}

/**
 * One research round.
 *
 * Gaps and billing are rendered even on a fully successful round, for the
 * reason `renderOneStep` above states about caps: "it worked" and "it worked
 * but half the providers never answered" must not look identical.
 */
export function renderResearch(outcome: ResearchOutcome, sessionId: string | undefined, json: boolean): string {
  if (json) {
    return toJson({
      ok: outcome.ok,
      plan: outcome.plan,
      items: outcome.items.map((item) => ({
        url: item.url,
        // Capped HERE, at the emit boundary, because this is the last place the
        // title is text rather than identity -- see aggregate.ts's
        // TITLE_MAX_CHARS for the two earlier placements that both poisoned a
        // dedup key.
        title: capTitle(item.title),
        ...(item.snippet !== undefined ? { snippet: item.snippet } : {}),
        ...(item.publishedAt !== undefined ? { published_at: item.publishedAt } : {}),
        providers: item.providers.map((p) => ({ backend_id: p.backendId, rank: p.rank, result_rank: p.resultRank })),
        score: item.score,
        duplicates: item.duplicates,
      })),
      documents: outcome.documents.map((doc) => ({ url: doc.url, backend_id: doc.backendId, content: doc.content })),
      // Mapped, not emitted raw: `coverage` is a shape this feature invented,
      // so its wire spelling was ours to choose, and snake_case matches the
      // sections around it (`calls_billed`, `backend_id`, `result_rank`).
      // SKILL.md teaches agents to read `gaps`, so this is a public contract
      // from the moment anything depends on it -- cheaper to settle now than to
      // carry both spellings forever.
      //
      // NOT a claim that the whole document is snake_case: `billing.attempts`
      // below is `AttemptLog` verbatim (`backendId`, `httpStatus`,
      // `gatewayCode`), which `call` and `run` have emitted in that shape since
      // long before this feature. Renaming it is a wider contract decision
      // about those commands, not a tidy-up belonging to this one.
      coverage: {
        queries: outcome.coverage.queries.map((q) => ({
          query: q.query,
          unique_urls: q.uniqueUrls,
          agreement_median: q.agreementMedian,
        })),
        served: outcome.coverage.served,
        unreadable: outcome.coverage.unreadable,
        failed: outcome.coverage.failed.map((f) => ({ backend_id: f.backendId, reason: f.reason })),
        skipped: outcome.coverage.skipped,
        ...(outcome.coverage.domainConcentration !== undefined
          ? { domain_concentration: outcome.coverage.domainConcentration }
          : {}),
        dropped_queries: outcome.coverage.droppedQueries,
        unfetched_targets: outcome.coverage.unfetchedTargets,
        narrowed_queries: outcome.coverage.narrowedQueries,
        suppressed: outcome.coverage.suppressed,
        gaps: outcome.coverage.gaps,
      },
      next_actions: outcome.nextActions.map((a) => ({
        why: a.why,
        // Omitted rather than emitted as null when an action carries no
        // command: a consumer testing `if (action.cmd)` and one testing
        // `'cmd' in action` must agree, and `null` in a field documented as a
        // runnable command invites being coerced to the string "null".
        ...(a.cmd !== undefined ? { cmd: a.cmd } : {}),
      })),
      billing: { calls_billed: outcome.billing.callsBilled, attempts: outcome.billing.attempts },
      session: sessionId !== undefined ? { id: sessionId } : null,
    });
  }

  const lines: string[] = [];
  outcome.items.forEach((item, index) => {
    const providers = item.providers.map((p) => p.backendId).join(', ');
    lines.push(`${String(index + 1)}. ${capTitle(item.title)}`);
    lines.push(`   ${item.url}`);
    if (item.snippet !== undefined) lines.push(`   ${item.snippet}`);
    lines.push(`   sources: ${providers}${item.duplicates.length > 0 ? ` (+${String(item.duplicates.length)} duplicate link(s))` : ''}`);
    lines.push('');
  });
  if (outcome.items.length === 0) lines.push('No results.', '');

  for (const doc of outcome.documents) {
    // Byte count, not the body: a scraped page is routinely tens of kilobytes,
    // and printing it would bury the merged results this command exists to
    // produce. `--json` carries the full content for anything that needs it.
    lines.push(`fetched ${doc.url} via ${doc.backendId} (${String(doc.content.length)} bytes)`);
  }
  if (outcome.documents.length > 0) lines.push('');

  lines.push(`Providers served: ${outcome.coverage.served.join(', ') || '(none)'}`);
  if (outcome.coverage.failed.length > 0) {
    lines.push(`Failed: ${outcome.coverage.failed.map((f) => `${f.backendId} (${f.reason})`).join(', ')}`);
  }
  if (outcome.coverage.suppressed > 0) {
    lines.push(`Suppressed ${String(outcome.coverage.suppressed)} result(s) already seen in this session.`);
  }
  lines.push(`Billed ${String(outcome.billing.callsBilled)} call(s).`);
  if (outcome.aborted !== undefined) lines.push(`Stopped: ${outcome.aborted}`);
  if (outcome.coverage.gaps.length > 0) {
    lines.push('', 'Gaps:');
    for (const gap of outcome.coverage.gaps) lines.push(`  - ${gap}`);
  }
  if (outcome.nextActions.length > 0) {
    lines.push('', 'Next:');
    // An action with no `cmd` is advice, not a command, and is printed as prose
    // — never in command position with the sentence standing in for a command,
    // which is an instruction to run its first word.
    for (const action of outcome.nextActions) {
      lines.push(action.cmd !== undefined ? `  ${action.cmd}   # ${action.why}` : `  ${action.why}`);
    }
  }
  return lines.join('\n');
}
