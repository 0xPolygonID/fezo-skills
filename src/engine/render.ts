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
import type { RankExplanation, RankedCandidate, RunSelection } from './rank.js';
import type { AttemptLog, RunOutcome, RunReport } from './retry.js';

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
  report?: RunReport;
}

export function renderRun(input: RunRenderInput, json: boolean): string {
  const { selection } = input;
  const billedAnyAttempt = input.report?.attempts.some((attempt) => attempt.billed) ?? false;

  if (json) {
    const base: Record<string, unknown> = {
      intent: input.intent,
      outcome: selection.outcome,
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
        const top = selection.ranked[0];
        if (top !== undefined) lines.push(`--allow-unhinted-auto-pick set: promoting ${summarizeCandidateLine(top.candidate)}`);
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

export function renderSetup(input: SetupRenderInput, json: boolean): string {
  if (json) {
    return toJson({ result: input.result, configured: input.display });
  }

  const lines = [`setup — storage: ${input.result.storage}`];
  lines.push(`  api key: ${input.result.apiKey.ok ? 'stored' : `failed (${input.result.apiKey.message ?? input.result.apiKey.reason ?? 'unknown error'})`}`);
  if (input.result.url !== undefined) {
    lines.push(`  url: ${input.result.url.ok ? 'stored' : `failed (${input.result.url.message ?? input.result.url.reason ?? 'unknown error'})`}`);
  }
  if (input.display.url !== undefined) lines.push(`  configured url: ${input.display.url.value} (source: ${input.display.url.source})`);
  if (input.display.apiKey !== undefined) lines.push(`  configured api key: ${input.display.apiKey.masked} (source: ${input.display.apiKey.source})`);
  return lines.join('\n');
}
