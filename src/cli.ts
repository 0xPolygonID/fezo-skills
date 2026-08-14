// `fezoctl`: argv parsing and command dispatch. This module composes the
// engine modules (catalog/tool-name/rank/preference/bindings/schema/client/
// retry/credentials) — it does not reimplement classification, binding, or
// ranking logic itself. Formatting is entirely delegated to
// `src/engine/render.ts`; this file's job is: parse argv, resolve
// credentials, call the engine, and hand the result to a renderer.
//
// Testable without spawning a process: `runCli` takes argv plus injectable
// `fetch`, `stdin`, environment, and a Keychain runner, and returns the exit
// code and everything that would have been written to stdout/stderr, rather
// than writing to the real streams itself. `main()` is the thin real entry
// point that wires those to `process.*`.
//
// Exit codes (documented in HELP_TEXT too):
//   0  success
//   1  usage error — a bad command/flag, or an unparseable
//      --args-json/--body-json payload. The governing spec requires this
//      class of failure to be rejected while parsing argv, before any
//      candidate is selected or called.
//   2  operational failure — credentials not configured, the gateway/catalog
//      could not be reached or read, a resolved tool's arguments failed
//      schema validation, `--version` could not read its own version, or a
//      `call`/`run` that did not end in success (including a `run` refusal or
//      an empty match).
//
// `--json` output contract: stdout is ALWAYS a JSON document when `--json` is
// set — never empty. A failure that never produced an attempt log emits
// render.ts's `{"error":{"kind","message"}}` envelope (see `CliErrorKind` for
// the closed set of kinds); a `call`/`run` that reached the engine emits its
// full report document instead, because that carries strictly more (the attempt
// log and what was billed). The English message goes to stderr either way, and
// the exit code is the same with and without `--json`.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { newSchemaCompiler } from './engine/ajv-instance.js';
import type { ToolCandidate } from './engine/catalog.js';
import { CatalogFetchError, fetchCatalog } from './engine/catalog.js';
import { bindArgs } from './engine/bindings.js';
import type { BoundRequest } from './engine/bindings.js';
import type { CredentialSource, FieldStoreOutcome, KeychainRunner, ResolvedValue, StoreCredentialsResult } from './engine/credentials.js';
import {
  credentialDisplay,
  normalizeCredentialValue,
  readSecretFromStream,
  resolveCredentials,
  storeCredentials,
  systemKeychainRunner,
} from './engine/credentials.js';
import type { Intent } from './engine/intent.js';
import { INTENTS } from './engine/intent.js';
import type { OneStepSpec } from './engine/one-step.js';
import { MAX_PROVIDER_ATTEMPTS, ONE_STEP_SPECS, runOneStep } from './engine/one-step.js';
import { clampPlan, mergePlan, parsePlanJson } from './engine/plan.js';
import type { PlanOverrides, RoutingPlan } from './engine/plan.js';
import { resolvePlanner } from './engine/planners/heuristic.js';
import { inferCapability } from './engine/preference.js';
import { groupByCapability, listProviders } from './engine/provider-view.js';
import { isExcluded, recommendationsFor, resolveExcludedBackends } from './engine/providers.js';
import type { RunSelection } from './engine/rank.js';
import { rankCandidates, searchCandidates, selectForRun } from './engine/rank.js';
import { runResearch, seenUrlsFrom } from './engine/research.js';
import type { CliErrorKind, DoctorCheck } from './engine/render.js';
import {
  renderCall,
  renderCatalog,
  renderDoctor,
  renderError,
  renderListProviders,
  renderOneStep,
  renderPlan,
  renderProviders,
  renderResearch,
  renderRun,
  renderSchema,
  renderSearch,
  renderSetup,
  renderVersion,
  setupProducedUsableConfig,
} from './engine/render.js';
import type { AttemptLog, MechanicalFailure, RunReport } from './engine/retry.js';
import { classifyFailure, run } from './engine/retry.js';
import type { ValidationResult } from './engine/schema.js';
import { SchemaValidatorCache, validateArgs } from './engine/schema.js';
import { SESSION_MAX_QUERIES, SESSION_MAX_SEEN_URLS, loadSession, saveSession, validateSessionId } from './engine/session.js';
import { ONE_STEP_COMMANDS, ONE_STEP_DESCRIPTIONS, RESEARCH_COMMANDS, RESEARCH_DESCRIPTIONS } from './engine/steering.js';
import { findCandidateByToolName } from './engine/tool-name.js';

// ---------------------------------------------------------------------------
// argv parsing.
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(['--json', '--schema', '--retry-empty-2xx', '--allow-unhinted-auto-pick', '--key-stdin', '--explain']);
const VALUE_FLAGS = new Set([
  '--args-json',
  '--body-json',
  '--max-attempts',
  '--url',
  '--storage',
  '--intent',
  '--detail',
  '--limit',
  '--extra-json',
  '--planner',
  '--plan-json',
  '--intents',
  '--depth',
  '--fanout',
  '--max-calls',
  '--session',
]);
// `plan`/`research` are the only commands whose flags can legitimately repeat
// (a research round has several sub-queries, or several scrape targets): every
// other VALUE_FLAG is last-token-wins, matching the rest of this parser, so
// these two get their own set rather than making every value flag an array
// and pushing that ambiguity onto every existing call site.
const REPEATABLE_VALUE_FLAGS = new Set(['--queries', '--targets']);

interface Flags {
  positionals: string[];
  json: boolean;
  schema: boolean;
  retryEmpty2xx: boolean;
  allowUnhintedAutoPick: boolean;
  keyStdin: boolean;
  explain: boolean;
  argsJson?: string;
  bodyJson?: string;
  maxAttempts?: string;
  url?: string;
  storage?: string;
  intent?: string;
  detail?: string;
  limit?: string;
  /** `web-search`/`scrape`/`crawl`'s provider-specific options, merged into
   * the resolved candidate's args alongside the command's single positional
   * value -- see one-step.ts's `runOneStep`. */
  extraJson?: string;
  /** `plan`/`research` (Task 12): which `Planner` (planners/heuristic.ts's
   * `resolvePlanner`) turns the prompt into a `RoutingPlan`. Only "heuristic"
   * ships, but the flag exists now so a future LLM planner needs no CLI change. */
  planner?: string;
  /** A whole caller-supplied plan (plan.ts's `parsePlanJson`), replaced
   * wholesale rather than merged -- see `planFromFlags`. */
  planJson?: string;
  intents?: string;
  queries?: string[];
  targets?: string[];
  depth?: string;
  fanout?: string;
  maxCalls?: string;
  session?: string;
}

type ParseResult = { ok: true; flags: Flags } | { ok: false; error: string };

function parseArgv(argv: readonly string[]): ParseResult {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const arrays: Record<string, string[]> = {};
  const booleans = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (BOOLEAN_FLAGS.has(token)) {
      booleans.add(token);
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const next = argv[i + 1];
      if (next === undefined) return { ok: false, error: `flag ${token} requires a value` };
      values[token] = next;
      i += 1;
      continue;
    }
    if (REPEATABLE_VALUE_FLAGS.has(token)) {
      const next = argv[i + 1];
      if (next === undefined) return { ok: false, error: `flag ${token} requires a value` };
      (arrays[token] ??= []).push(next);
      i += 1;
      continue;
    }
    if (token.startsWith('--')) return { ok: false, error: `unknown flag: ${token}` };
    positionals.push(token);
  }

  return {
    ok: true,
    flags: {
      positionals,
      json: booleans.has('--json'),
      schema: booleans.has('--schema'),
      retryEmpty2xx: booleans.has('--retry-empty-2xx'),
      allowUnhintedAutoPick: booleans.has('--allow-unhinted-auto-pick'),
      keyStdin: booleans.has('--key-stdin'),
      explain: booleans.has('--explain'),
      ...(values['--args-json'] !== undefined ? { argsJson: values['--args-json'] } : {}),
      ...(values['--body-json'] !== undefined ? { bodyJson: values['--body-json'] } : {}),
      ...(values['--max-attempts'] !== undefined ? { maxAttempts: values['--max-attempts'] } : {}),
      ...(values['--url'] !== undefined ? { url: values['--url'] } : {}),
      ...(values['--storage'] !== undefined ? { storage: values['--storage'] } : {}),
      ...(values['--intent'] !== undefined ? { intent: values['--intent'] } : {}),
      ...(values['--detail'] !== undefined ? { detail: values['--detail'] } : {}),
      ...(values['--limit'] !== undefined ? { limit: values['--limit'] } : {}),
      ...(values['--extra-json'] !== undefined ? { extraJson: values['--extra-json'] } : {}),
      ...(values['--planner'] !== undefined ? { planner: values['--planner'] } : {}),
      ...(values['--plan-json'] !== undefined ? { planJson: values['--plan-json'] } : {}),
      ...(values['--intents'] !== undefined ? { intents: values['--intents'] } : {}),
      ...(values['--depth'] !== undefined ? { depth: values['--depth'] } : {}),
      ...(values['--fanout'] !== undefined ? { fanout: values['--fanout'] } : {}),
      ...(values['--max-calls'] !== undefined ? { maxCalls: values['--max-calls'] } : {}),
      ...(values['--session'] !== undefined ? { session: values['--session'] } : {}),
      ...(arrays['--queries'] !== undefined ? { queries: arrays['--queries'] } : {}),
      ...(arrays['--targets'] !== undefined ? { targets: arrays['--targets'] } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// --version: never a hardcoded string, so a drifting version cannot silently
// break the invocation ladder's tier-4 version comparison.
//
// Two mechanisms, in this order:
//
//   1. `__FEZOCTL_VERSION__`, substituted at BUNDLE time by `build/bundle.mjs`
//      via esbuild's `--define` from package.json's own `version`. The bundle
//      is copied to `skills/fezo/scripts/fezoctl.mjs`, which sits TWO levels
//      below the package root, so the `../package.json` walk below misses it
//      entirely (`ENOENT .../skills/fezo/package.json`) — the artifact most
//      users install could not report its own version. Baking the value in
//      removes the filesystem dependency for every shipped copy.
//   2. `resolvePackageVersion()`, the filesystem fallback, kept because
//      `tsc`/vitest run this module UN-bundled from `src/*.ts`, where nothing
//      defines `__FEZOCTL_VERSION__`. That path also still covers
//      `dist/fezoctl.mjs` if the define is ever dropped.
//
// Consequence to be aware of: because the version is now baked into the
// bundle's bytes, bumping package.json's `version` changes dist/fezoctl.mjs
// and CI's bundle-freshness gate will (correctly) go red until `pnpm bundle`
// is re-run. CI's failure message says so explicitly.
// ---------------------------------------------------------------------------

/** Injected by esbuild `--define` at bundle time; genuinely absent when this
 * module runs un-bundled, hence the `typeof` guard at every use. */
declare const __FEZOCTL_VERSION__: string | undefined;

export function resolvePackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(here, '..', 'package.json');
  const raw = readFileSync(packageJsonPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (parsed !== null && typeof parsed === 'object') {
    const version = Reflect.get(parsed, 'version');
    if (typeof version === 'string') return version;
  }
  throw new Error(`could not read "version" from ${packageJsonPath}`);
}

/** The version `--version` reports: the build-time constant when present,
 * otherwise read from package.json. `typeof` rather than a bare reference,
 * because an un-substituted identifier would be a ReferenceError. */
export function resolveVersion(): string {
  if (typeof __FEZOCTL_VERSION__ === 'string' && __FEZOCTL_VERSION__.length > 0) {
    return __FEZOCTL_VERSION__;
  }
  return resolvePackageVersion();
}

// ---------------------------------------------------------------------------
// `run`'s candidate-list adapter (carry-forward #2). `selectForRun` returns a
// five-variant union; this is the ONE place that turns it into the candidate
// list `retry.ts`'s `run()` is allowed to receive. The exhaustive switch with
// a `never`-assigning default makes it a compile error to add a sixth
// `RunSelection` outcome without updating this function.
//
// `asyncExcluded` and `alternatives` are NEVER read here — see rank.ts's
// `RunOptions.candidates` doc comment for why: both are candidate-shaped and
// would compile if used, but `asyncExcluded` holds methods `run` must never
// auto-call, and `alternatives` is display-only on a refusal with no override.
// ---------------------------------------------------------------------------

export function candidatesToRun(selection: RunSelection, allowUnhintedAutoPick: boolean): readonly ToolCandidate[] {
  switch (selection.outcome) {
    case 'no-match':
    case 'async-excluded':
    case 'refused-ambiguous-capability':
      return [];
    case 'refused-unhinted-multi-backend': {
      if (!allowUnhintedAutoPick) return [];
      // The override authorizes promoting `ranked[0]` only (see rank.ts's doc
      // comment on this outcome) — not chaining into further un-hinted
      // backends the user never agreed to.
      const top = selection.ranked[0];
      return top !== undefined ? [top.candidate] : [];
    }
    case 'selected':
      return selection.ranked.map((ranked) => ranked.candidate);
    default: {
      const exhaustive: never = selection;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// `call <tool>` resolution failure: `retry.ts` documents that this must be
// classified through the same `tool_not_in_catalog` gateway-shaped code `run`
// uses when a candidate reports it, so both callers share one policy. There
// is no candidate to actually call, so this synthesizes the attempt log and
// outcome `run()`'s own exhaustion path would have produced for a
// single-candidate list ending in that classification (see
// tests/retry.test.ts's "call context" case), without re-deriving the
// classification decision itself — `classifyFailure` still decides it.
// ---------------------------------------------------------------------------

/**
 * `retry.ts`'s wording for "the candidate list ran out", duplicated here
 * because `unresolvedToolReport` synthesizes the report that path would have
 * produced. The two copies MUST stay identical — otherwise `call`'s output for
 * an unresolved tool silently stops matching `run`'s for the same exhaustion —
 * so `tests/cli.test.ts` pins this constant against the string a real `run()`
 * exhaustion actually returns, rather than trusting the comment.
 * (Importing retry.ts's own copy would be better still, but it is a local
 * expression there, not an exported constant, and retry.ts is out of scope.)
 */
export const NO_MORE_CANDIDATES_REASON = 'no more candidates to try';

function unresolvedToolReport(tool: string): RunReport {
  const failure: MechanicalFailure = {
    kind: 'gateway',
    status: 404,
    code: 'tool_not_in_catalog',
    message: `tool "${tool}" is not present in the catalog`,
  };
  const classified = classifyFailure(failure);
  const attempt: AttemptLog = {
    tool,
    backendId: '(unresolved)',
    status: classified.decision,
    reason: classified.reason,
    billed: false,
    ...(classified.httpStatus !== undefined ? { httpStatus: classified.httpStatus } : {}),
    ...(classified.gatewayCode !== undefined ? { gatewayCode: classified.gatewayCode } : {}),
  };
  return { attempts: [attempt], outcome: { kind: 'give_up', reason: NO_MORE_CANDIDATES_REASON } };
}

// ---------------------------------------------------------------------------
// Schema validation for `call`. Args are validated against `inputSchema`
// directly (args are always meant to be an object of named parameters, so the
// permissive `{type:'object'}` fallback is a correct stand-in there). The
// request body is validated against the binding's OWN declared media-type
// schema, never against `inputSchema` — carry-forward #5: a body position can
// legitimately be a non-object (brightdata's `scrape_async` array-of-records
// body), and `inputSchema`'s permissive fallback rejects exactly that. When
// the body's own schema is absent, or fails to compile, validation is skipped
// for it entirely (the "use `true` for a media-type-schema position" case),
// which is why compile-checking happens locally with a throwaway probe rather
// than relying on `compileSchema`'s own `{type:'object'}` fallback.
// ---------------------------------------------------------------------------

const probeCompiler = newSchemaCompiler();

function schemaCompiles(schema: object | boolean): boolean {
  try {
    probeCompiler.compile(schema);
    return true;
  } catch {
    return false;
  }
}

function validateBodyAgainstBinding(cache: SchemaValidatorCache, candidate: ToolCandidate, bodyJson: unknown): ValidationResult {
  const schema = candidate.bindings.request_body?.content?.['application/json']?.schema;
  if (schema === undefined) return { valid: true };
  if (!schemaCompiles(schema)) return { valid: true };
  return validateArgs(cache.get(schema), bodyJson);
}

// ---------------------------------------------------------------------------
// CLI I/O contract.
// ---------------------------------------------------------------------------

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  stdin?: Readable;
  keychain?: KeychainRunner;
  dotEnvPath?: string;
  /** Overrides `os.homedir()` for session-cache placement (session.ts's
   * `sessionPath`). Tests only; production never sets it, and gets the real
   * home directory via the `homedir()` fallback below. */
  homeDir?: string;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_OPERATIONAL = 2;

/** Default `providers --limit`: enough providers per group to act on, few
 * enough to keep the default call cheap to read. Truncation past this is
 * always reported via `omitted`, never silent -- see render.ts's
 * `renderProviders`. */
const DEFAULT_PROVIDERS_LIMIT = 5;

/** HELP_TEXT's hard-wrap column. Everything in that block is wrapped by hand
 * to this width; the one part that cannot be (the one-step descriptions, which
 * arrive from `steering.ts` as single unwrapped lines shared with SKILL.md) is
 * wrapped to the same column by `oneStepHelpBlock` below. */
const HELP_WRAP_COLUMNS = 78;

/**
 * The three one-step command descriptions as their own labelled block.
 *
 * They are rendered rather than inlined because the source strings are shared
 * data (`ONE_STEP_DESCRIPTIONS`, also read by `build/gen-skill.mjs` for
 * SKILL.md), so they cannot carry either consumer's line breaks — and because
 * splicing three ~150-column sentences into a hand-wrapped paragraph is what
 * this block previously did, which read as one interrupted sentence.
 */
function descriptionHelpBlock(names: readonly string[], descriptions: Record<string, string>): string {
  const labelWidth = Math.max(...names.map((name) => name.length));
  const indent = ' '.repeat(2 + labelWidth + 2);
  const lines: string[] = [];
  for (const name of names) {
    let line = `  ${name.padEnd(labelWidth)}  `;
    let placed = false;
    for (const word of (descriptions[name] ?? '').split(' ')) {
      // An over-long word still goes on an empty line rather than producing a
      // blank line followed by the same over-long word — hence the `placed`
      // guard instead of a pure width test.
      if (placed && line.length + 1 + word.length > HELP_WRAP_COLUMNS) {
        lines.push(line);
        line = indent + word;
      } else {
        line = placed ? `${line} ${word}` : line + word;
      }
      placed = true;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** The three one-step command descriptions as their own labelled block. */
function oneStepHelpBlock(): string {
  return descriptionHelpBlock(ONE_STEP_COMMANDS, ONE_STEP_DESCRIPTIONS);
}

/**
 * The two routing command descriptions, same treatment and same reason.
 *
 * Rendered from `RESEARCH_DESCRIPTIONS` rather than restated here: that table's
 * docstring promises `--help` and `skills/fezo/SKILL.md` cannot describe
 * `plan`/`research` differently, and a hand-written paragraph in this file --
 * which is what stood here first -- makes that promise false the moment either
 * copy is edited alone.
 */
function researchHelpBlock(): string {
  return descriptionHelpBlock(RESEARCH_COMMANDS, RESEARCH_DESCRIPTIONS);
}

const HELP_TEXT = `fezoctl — discover and call Fezo gateway tools from the live catalog

Usage:
  fezoctl search "<query>" [--schema] [--json]
  fezoctl schema <tool> [--json]
  fezoctl call <tool> --args-json '<json>' [--body-json '<json>'] [--json]
  fezoctl run "<intent>" --args-json '<json>' [--body-json '<json>']
             [--max-attempts N] [--retry-empty-2xx] [--allow-unhinted-auto-pick] [--json]
  fezoctl web-search "<query>" [--extra-json '<json>'] [--max-attempts N] [--json]
  fezoctl scrape <url>         [--extra-json '<json>'] [--max-attempts N] [--json]
  fezoctl crawl <url>          [--extra-json '<json>'] [--max-attempts N] [--json]
  fezoctl plan "<prompt>" [--json]
  fezoctl research "<prompt>" [--intents a,b] [--queries "q"]... [--targets <url>]...
                   [--depth shallow|standard|research] [--fanout N] [--max-calls N]
                   [--session <id>] [--plan-json '<json>'] [--planner heuristic] [--json]
  fezoctl catalog [--json]
  fezoctl providers [--intent <intent>] [--detail names|descriptions|schema]
                     [--limit N] [--explain] [--json]
  fezoctl list-providers [--json]
  fezoctl setup [--url <url>] [--storage keychain|dotenv] [--json]
  fezoctl doctor [--json]
  fezoctl --version
  fezoctl --help

setup takes one thing: the API key, on stdin.

  printf '%s' "$YOUR_KEY" | fezoctl setup

Everything else has a default. --storage defaults to dotenv
(~/.config/fezo/.env, mode 0600); --url defaults to the built-in gateway, so
pass it only to point somewhere else. --key-stdin is still accepted but is no
longer needed — stdin is the only channel setup reads a key from, and there is
no flag, argument, or prompt that accepts one, because a key in argv is
readable by any local process via ps and lands in the shell history.
Otherwise, set FEZO_URL and FEZO_API_KEY.

providers/list-providers surface the declared, per-intent provider ranking
(src/engine/providers.ts) instead of catalog/registration order: intents are
${INTENTS.join(', ')}.
providers --detail defaults to "names" (a cheap sweep: rank, provider and
what is callable on it); "descriptions" adds the full why/when prose and the
provider's complete method list, "schema" additionally names each surfaced
method's input schema (inlined under --json, listed as tool names to pass to
\`fezoctl schema\` otherwise). --explain adds the ranking's provenance (which
doc it was read from, and when) to every row. --limit caps each capability
group and always reports what it dropped as "omitted".

providers ranks by what your catalog actually serves, so a provider's rank
moves when a higher-ranked one is absent; list-providers reports the DECLARED
rank instead — the provider's fixed position in the table — which is why the
two commands can print different numbers for the same provider.

web-search/scrape/crawl each walk providers.ts's declared ranking for their
own intent (search/scrape/crawl respectively) top-down, calling one provider
at a time and falling back to the next on a retryable failure — no need to
know any provider's argument name or call convention up front. --extra-json
merges provider-specific options into whichever candidate the walk lands on
(result counts, formats, timeouts — never the query/url itself); a provider
whose own schema rejects those merged arguments is skipped and named in the
output, even when a later, lower-ranked provider then succeeds. --max-attempts
here defaults to ${String(MAX_PROVIDER_ATTEMPTS)}, NOT run's default of 2: run's budget is a RETRY
budget for repeated failures on one already-selected capability; a one-step
command's budget is a RANKED-FALLBACK budget across several genuinely
different, separately-priced providers, so a higher default is deliberate. The
walk also carries its own 60-second wall-clock deadline, not configurable from
the command line: on expiry it stops STARTING new attempts (never aborting one
already in flight, which would discard a result already billed) and reports
whichever candidate answered last. Deny-listed and not-recommended providers
are never attempted by any of the three commands.

${researchHelpBlock()}

Depth sets the fan-out width (shallow 2, standard 4, research 8 providers per
query), and every provider in that width is a billed call. --session <id>
makes a follow-up round exclude what an earlier round already returned, so a
multi-round investigation does not re-pay for links it already has.

What each one is for (the same sentences skills/fezo/SKILL.md uses):

${oneStepHelpBlock()}

FEZO_EXCLUDED_BACKENDS overrides the default deny-listed backends (falai,
alpaca): a comma-separated backend id list that REPLACES the default, or an
explicitly empty string to exclude nothing. Excluded backends never appear in
search/catalog/providers/list-providers, are never attempted by
web-search/scrape/crawl, and schema/call/run refuse to reach one even when
named by its exact tool name.

With --json, stdout is always a JSON document — never empty. A failure that
never reached the gateway is {"error":{"kind":"...","message":"..."}}, where
kind is one of: usage, credentials-not-configured, catalog-unavailable,
tool-not-found, invalid-args, invalid-body, version-unavailable,
backend-excluded. A call/run/web-search/scrape/crawl that did reach the
gateway emits its full attempt-log document instead (the failure is in its
outcome/result, alongside what was billed, and — for the three one-step
commands — which provider served it, its rank, any provider --extra-json
disqualified, and any cap that stopped the walk, all as fields rather than
prose). The human-readable message always goes to stderr, and exit codes do
not change.

Exit codes:
  0  success
  1  usage error: a bad command/flag, or an unparseable
     --args-json/--body-json/--extra-json payload — rejected before any
     candidate is selected or called.
  2  operational failure: credentials not configured, the gateway/catalog
     could not be reached or read, arguments failed schema validation, a
     schema/call/run that named a deny-listed backend, or a
     call/run/web-search/scrape/crawl that did not end in success (including
     a run refusal, an empty match, a one-step walk with no provider to serve
     it, or doctor finding a hard failure).
`;

// ---------------------------------------------------------------------------
// Output sinks + the one place a failure is reported.
//
// Every failure goes through `emitFailure`, which writes the English message to
// stderr AND (under `--json`) the machine-readable envelope to stdout. Bundling
// the two sinks with the `json` flag is what makes that pairing hard to
// half-implement: there is no per-call-site decision left about whether a given
// failure also owes stdout a document, which is exactly how the pre-fix code
// ended up emitting a JSON document on exactly ONE failure path while eight
// others left stdout empty and put the whole story on stderr.
// ---------------------------------------------------------------------------

interface Emit {
  out: (s: string) => void;
  err: (s: string) => void;
  json: boolean;
}

function emitFailure(emit: Emit, kind: CliErrorKind, message: string): void {
  emit.err(`fezoctl: ${message}\n`);
  if (emit.json) emit.out(renderError(kind, message));
}

/** A usage error (exit 1), prefixed with the command it applies to. */
function emitUsageError(emit: Emit, command: string, message: string): void {
  emitFailure(emit, 'usage', `${command}: ${message}`);
}

function catalogErrorMessage(err: unknown): string {
  if (err instanceof CatalogFetchError) {
    return err.reason === 'status' ? `could not fetch the catalog: ${err.message}` : `could not read the catalog: ${err.message}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `could not reach the gateway: ${message}`;
}

interface ResolvedGateway {
  baseUrl: string;
  apiKey: string;
}

function credentialResolutionFor(deps: CliDeps) {
  return resolveCredentials({
    env: deps.env ?? process.env,
    ...(deps.dotEnvPath !== undefined ? { dotEnvPath: deps.dotEnvPath } : {}),
    ...(deps.keychain !== undefined ? { keychain: deps.keychain } : {}),
  });
}

/**
 * The gateway URL is not checked here, and cannot be: it always resolves
 * (`DEFAULT_GATEWAY_URL` is the last rung of its chain), so the API key is the
 * only credential whose absence can stop a command.
 */
function requireCredentials(deps: CliDeps, emit: Emit): ResolvedGateway | undefined {
  const resolution = credentialResolutionFor(deps);
  if (resolution.apiKey === undefined) {
    emitFailure(
      emit,
      'credentials-not-configured',
      'the API key is not configured; run `printf \'%s\' "$YOUR_KEY" | fezoctl setup` or set FEZO_API_KEY',
    );
    return undefined;
  }
  return { baseUrl: resolution.url.value, apiKey: resolution.apiKey.value };
}

// ---------------------------------------------------------------------------
// "Resolve credentials, then fetch the catalog" — the opening move of five of
// the seven commands (search/schema/call/run/catalog), previously copy-pasted
// verbatim at each one. One copy means one place the two failure kinds
// (`credentials-not-configured`, `catalog-unavailable`) are reported and one
// place the exit code is decided.
//
// `doctor` deliberately does NOT use this: it must report each step as its own
// check (and distinguish an auth rejection from a connectivity failure) rather
// than bailing out at the first failure.
// ---------------------------------------------------------------------------

interface GatewaySession {
  creds: ResolvedGateway;
  candidates: ToolCandidate[];
}

type GatewayResult = { ok: true; session: GatewaySession } | { ok: false; exitCode: number };

async function openGateway(deps: CliDeps, emit: Emit): Promise<GatewayResult> {
  const creds = requireCredentials(deps, emit);
  if (!creds) return { ok: false, exitCode: EXIT_OPERATIONAL };

  try {
    const candidates = await fetchCatalog({
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
    });
    return { ok: true, session: { creds, candidates } };
  } catch (err) {
    emitFailure(emit, 'catalog-unavailable', catalogErrorMessage(err));
    return { ok: false, exitCode: EXIT_OPERATIONAL };
  }
}

/**
 * Parses one `--args-json`/`--body-json` payload, reporting an unparseable one
 * as a usage error (exit 1) on both output channels before any candidate is
 * selected or called.
 */
function parseJsonFlag(
  raw: string,
  flagName: string,
  command: string,
  emit: Emit,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitUsageError(emit, command, `${flagName} is not valid JSON: ${message}`);
    return { ok: false };
  }
}

/**
 * Narrows a parsed `--extra-json` value to a plain object, without a type
 * assertion -- same defensive-parse idiom as catalog.ts's `asRecord`. `null`
 * and an array both fail `typeof value === 'object'`'s intent (an array is
 * technically `typeof 'object'`, hence the explicit `Array.isArray` guard);
 * both are usage errors here because `{...extra, [argName]: value}` (see
 * one-step.ts's `runOneStep`) requires a spreadable object.
 */
function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// Deny-list helpers (carry-forward from Phase 1's threaded `isExcluded`).
//
// `search`/`catalog`/`providers`/`list-providers` simply never show an
// excluded backend: `filterExcluded` drops its candidates before anything
// else touches the catalog. `call`/`run` are different: a caller may already
// know an excluded backend's exact tool name (from memory, from docs, from an
// old `search` result cached before the deny-list changed), so silently
// filtering their candidate list first would make them fall through to a
// generic "tool not found"/"no match" -- true, but not the reason, and not
// actionable the same way. Both commands instead resolve against the FULL
// (unfiltered) catalog and refuse by name with the dedicated
// `backend-excluded` kind when the resolved backend is on the list. See
// `cmdCall` and `cmdRun`.
// ---------------------------------------------------------------------------

function filterExcluded(candidates: readonly ToolCandidate[], excluded: readonly string[]): ToolCandidate[] {
  return candidates.filter((c) => !isExcluded(c.backendId, excluded));
}

/** `verb` is what the refusing command would have done, so the message names
 * the action the caller actually attempted -- "cannot be called" is wrong for
 * `schema`, which never calls anything. */
function excludedBackendMessage(backendId: string, tool: string, verb: 'called' | 'inspected' = 'called'): string {
  return `backend "${backendId}" is excluded (FEZO_EXCLUDED_BACKENDS); "${tool}" cannot be ${verb}`;
}

/**
 * `run`'s "even when the caller names the tool exactly" case: does the raw
 * intent string exactly equal an EXCLUDED backend's tool name (or its
 * `{backendId}_{method}` join)? Reuses `searchCandidates`'s own exact-match
 * computation (`SearchMatch.exactMatch === 'tool'`) rather than re-deriving
 * exactness here a second time -- see rank.ts's `classifyTier` for why an
 * intent string and a tokenized query can disagree about what "named exactly"
 * means, and why that decision must be made in exactly one place.
 */
function exactExcludedToolMatch(
  candidates: readonly ToolCandidate[],
  excluded: readonly string[],
  intent: string,
): ToolCandidate | undefined {
  const excludedCandidates = candidates.filter((c) => isExcluded(c.backendId, excluded));
  const match = searchCandidates(excludedCandidates, intent).find((m) => m.exactMatch === 'tool');
  return match?.candidate;
}

/**
 * `--intent`'s value against `INTENTS` (intent.ts), without a type assertion:
 * returns the matching element of `INTENTS` itself (already typed `Intent`)
 * rather than coercing the caller's raw string, so there is exactly one
 * source of truth for which strings are valid intents.
 */
function parseIntentFlag(raw: string): Intent | undefined {
  for (const intent of INTENTS) {
    if (intent === raw) return intent;
  }
  return undefined;
}

type ProvidersDetail = 'names' | 'descriptions' | 'schema';

/** `--detail`'s value, narrowed by literal comparison rather than a type
 * assertion -- see `parseIntentFlag`'s comment for why this repo avoids `as`
 * for this shape of check. */
function parseDetailFlag(raw: string): ProvidersDetail | undefined {
  if (raw === 'names' || raw === 'descriptions' || raw === 'schema') return raw;
  return undefined;
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function cmdSearch(flags: Flags, deps: CliDeps, emit: Emit, excluded: readonly string[]): Promise<number> {
  const query = flags.positionals.join(' ');
  if (query.length === 0) {
    emitUsageError(emit, 'search', 'requires a query, e.g. `fezoctl search "scrape this page"`');
    return EXIT_USAGE;
  }

  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;

  const candidates = filterExcluded(gateway.session.candidates, excluded);
  const matches = searchCandidates(candidates, query);
  const inference = inferCapability(query);
  const capability = inference.kind === 'matched' ? inference.capability : undefined;
  const ranked = rankCandidates(matches, query, capability);

  emit.out(renderSearch(ranked, query, { json: flags.json, includeSchema: flags.schema }));
  return EXIT_OK;
}

async function cmdSchema(flags: Flags, deps: CliDeps, emit: Emit, excluded: readonly string[]): Promise<number> {
  const tool = flags.positionals[0];
  if (tool === undefined || flags.positionals.length > 1) {
    emitUsageError(emit, 'schema', 'requires exactly one tool name, e.g. `fezoctl schema firecrawl_scrape`');
    return EXIT_USAGE;
  }

  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;

  // Resolved against the FULL catalog, then refused by name -- the same
  // ordering `cmdCall` uses, and for the same reason (a caller who already
  // knows the tool name deserves the actual reason, not a "tool not found"
  // that is true but unactionable).
  //
  // `schema` refuses rather than merely filtering, even though it calls
  // nothing and bills nothing, because the alternative is worse for the one
  // caller who reaches it: an agent handed a full input schema and binding map
  // for a backend this CLI will not call has been invited to assemble a call
  // that `cmdCall` then rejects. Refusing here spends one command instead of
  // two and names FEZO_EXCLUDED_BACKENDS, which is the thing to change.
  const candidate = findCandidateByToolName(gateway.session.candidates, tool);
  if (!candidate) {
    emitFailure(emit, 'tool-not-found', `tool "${tool}" was not found in the catalog`);
    return EXIT_OPERATIONAL;
  }
  if (isExcluded(candidate.backendId, excluded)) {
    emitFailure(emit, 'backend-excluded', excludedBackendMessage(candidate.backendId, tool, 'inspected'));
    return EXIT_OPERATIONAL;
  }

  emit.out(renderSchema(candidate, flags.json));
  return EXIT_OK;
}

async function cmdCall(flags: Flags, deps: CliDeps, emit: Emit, excluded: readonly string[]): Promise<number> {
  const tool = flags.positionals[0];
  if (tool === undefined || flags.positionals.length > 1) {
    emitUsageError(emit, 'call', 'requires exactly one tool name, e.g. `fezoctl call firecrawl_scrape --args-json \'{...}\'`');
    return EXIT_USAGE;
  }
  if (flags.argsJson === undefined) {
    emitUsageError(emit, 'call', "requires --args-json '<json>'");
    return EXIT_USAGE;
  }

  const argsParsed = parseJsonFlag(flags.argsJson, '--args-json', 'call', emit);
  if (!argsParsed.ok) return EXIT_USAGE;
  const args = argsParsed.value;

  let bodyJson: unknown;
  if (flags.bodyJson !== undefined) {
    const bodyParsed = parseJsonFlag(flags.bodyJson, '--body-json', 'call', emit);
    if (!bodyParsed.ok) return EXIT_USAGE;
    bodyJson = bodyParsed.value;
  }

  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;
  const { creds } = gateway.session;

  // Resolved against the FULL catalog, not a pre-filtered one: see this
  // file's "Deny-list helpers" comment for why `call` must recognize an
  // excluded backend by name rather than let it fall through to a generic
  // tool-not-found.
  const candidate = findCandidateByToolName(gateway.session.candidates, tool);
  if (candidate && isExcluded(candidate.backendId, excluded)) {
    emitFailure(emit, 'backend-excluded', excludedBackendMessage(candidate.backendId, tool));
    return EXIT_OPERATIONAL;
  }
  if (!candidate) {
    // Not an `emitFailure` envelope: this path has a full attempt log (the
    // synthesized `tool_not_in_catalog` classification `run` would have
    // produced), and that document is strictly more informative.
    emit.out(renderCall({ tool, report: unresolvedToolReport(tool) }, flags.json));
    return EXIT_OPERATIONAL;
  }

  const cache = new SchemaValidatorCache();
  const argsValidation = validateArgs(cache.get(candidate.inputSchema), args);
  if (!argsValidation.valid) {
    emitFailure(emit, 'invalid-args', `--args-json does not match ${candidate.tool}'s input schema: ${argsValidation.errorText}`);
    return EXIT_OPERATIONAL;
  }
  if (bodyJson !== undefined) {
    const bodyValidation = validateBodyAgainstBinding(cache, candidate, bodyJson);
    if (!bodyValidation.valid) {
      emitFailure(
        emit,
        'invalid-body',
        `--body-json does not match ${candidate.tool}'s request body schema: ${bodyValidation.errorText}`,
      );
      return EXIT_OPERATIONAL;
    }
  }

  let boundRequest: BoundRequest | undefined;
  try {
    boundRequest = bindArgs(candidate, args, bodyJson);
  } catch {
    // Left undefined; the run below hits the same BindingError and surfaces
    // its reason in the attempt log, so nothing is lost by not showing it here.
  }

  const report = await run({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    candidates: [candidate],
    args,
    ...(bodyJson !== undefined ? { bodyJson } : {}),
    ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
  });

  emit.out(renderCall({ tool, candidate, ...(boundRequest !== undefined ? { boundRequest } : {}), report }, flags.json));
  return report.outcome.kind === 'success' ? EXIT_OK : EXIT_OPERATIONAL;
}

async function cmdRun(flags: Flags, deps: CliDeps, emit: Emit, excluded: readonly string[]): Promise<number> {
  const intent = flags.positionals.join(' ');
  if (intent.length === 0) {
    emitUsageError(emit, 'run', 'requires an intent, e.g. `fezoctl run "scrape this page" --args-json \'{...}\'`');
    return EXIT_USAGE;
  }
  if (flags.argsJson === undefined) {
    emitUsageError(emit, 'run', "requires --args-json '<json>'");
    return EXIT_USAGE;
  }

  const argsParsed = parseJsonFlag(flags.argsJson, '--args-json', 'run', emit);
  if (!argsParsed.ok) return EXIT_USAGE;
  const args = argsParsed.value;

  let bodyJson: unknown;
  if (flags.bodyJson !== undefined) {
    const bodyParsed = parseJsonFlag(flags.bodyJson, '--body-json', 'run', emit);
    if (!bodyParsed.ok) return EXIT_USAGE;
    bodyJson = bodyParsed.value;
  }

  let maxAttempts: number | undefined;
  if (flags.maxAttempts !== undefined) {
    const n = Number(flags.maxAttempts);
    // `>= 1`, not `>= 0`: `--max-attempts 0` authorizes no calls at all, so the
    // run would call nothing and then report "max attempts (0) reached with
    // candidates remaining" as an operational failure — an unusable outcome
    // dressed up as a runtime one. A budget of zero is a mistake in the
    // command line, so it is rejected as one, before any credential or catalog
    // work happens.
    if (!Number.isInteger(n) || n < 1) {
      emitUsageError(emit, 'run', '--max-attempts must be an integer >= 1');
      return EXIT_USAGE;
    }
    maxAttempts = n;
  }

  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;
  const { creds } = gateway.session;

  // Checked against the FULL catalog before anything is filtered: this is
  // `run`'s "even when the caller names the tool exactly" refusal -- see this
  // file's "Deny-list helpers" comment. Once past this check, excluded
  // backends are filtered out entirely so no hinted or unhinted auto-pick can
  // reach one either.
  const excludedMatch = exactExcludedToolMatch(gateway.session.candidates, excluded, intent);
  if (excludedMatch) {
    emitFailure(emit, 'backend-excluded', excludedBackendMessage(excludedMatch.backendId, excludedMatch.tool));
    return EXIT_OPERATIONAL;
  }

  const candidates = filterExcluded(gateway.session.candidates, excluded);
  const selection = selectForRun(candidates, intent);
  const runCandidates = candidatesToRun(selection, flags.allowUnhintedAutoPick);

  let report: RunReport | undefined;
  if (runCandidates.length > 0) {
    report = await run({
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      candidates: runCandidates,
      args,
      ...(bodyJson !== undefined ? { bodyJson } : {}),
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      ...(flags.retryEmpty2xx ? { retryEmpty2xx: true } : {}),
      ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
    });
  }

  // `runCandidates` is handed to the renderer rather than letting it re-derive
  // which candidate was promoted: this list is what `run()` was actually given,
  // so the output cannot name a different candidate than the one that was
  // called (and billed). See `RunRenderInput.runCandidates`.
  emit.out(
    renderRun(
      {
        intent,
        selection,
        allowUnhintedAutoPick: flags.allowUnhintedAutoPick,
        runCandidates,
        ...(report !== undefined ? { report } : {}),
      },
      flags.json,
    ),
  );

  if (report === undefined) return EXIT_OPERATIONAL;
  return report.outcome.kind === 'success' ? EXIT_OK : EXIT_OPERATIONAL;
}

// ---------------------------------------------------------------------------
// plan / research (Task 10-11's fan-out executor, wired to argv here). `plan`
// does no network I/O at all -- it exists so a caller can see what routing a
// prompt would get before paying for a round -- so it never calls
// `openGateway`, the one thing every other command past this comment does
// first. `research` is the wide fan-out: one round, several providers per
// query, deduplicated and source-attributed, optionally suppressing what an
// earlier `--session` round already returned.
// ---------------------------------------------------------------------------

/**
 * Builds the round's plan from prompt + flags, or throws a usage error.
 *
 * Every rejection here happens during argv handling, before a candidate is
 * selected or a call is billed -- the contract stated at the top of this file
 * and already followed by `--args-json`.
 */
function planFromFlags(prompt: string, flags: Flags): RoutingPlan {
  // `--intent` (singular) is `providers`' flag; routing takes `--intents`
  // (plural, comma-separated). The parser accepts any known flag for any
  // command, and everywhere else an inapplicable flag is merely ignored -- but
  // this is the one near-miss pair where being ignored changes WHICH providers
  // get billed, so it is rejected rather than dropped. Still a usage error
  // raised from argv handling, i.e. still before anything is called.
  if (typeof flags.intent === 'string') {
    throw new Error(`--intent belongs to \`providers\`; routing takes the plural, e.g. --intents ${flags.intent}`);
  }
  const planner = resolvePlanner(typeof flags.planner === 'string' ? flags.planner : 'heuristic');
  const overrides: PlanOverrides = {};
  if (typeof flags.planJson === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(flags.planJson);
    } catch (error) {
      throw new Error(`--plan-json is not valid JSON: ${(error as Error).message}`);
    }
    overrides.plan = parsePlanJson(parsed);
  }
  if (typeof flags.intents === 'string') {
    const intents = flags.intents.split(',').map((s) => s.trim()).filter((s) => s !== '');
    for (const intent of intents) {
      if (!INTENTS.includes(intent as never)) throw new Error(`unknown intent "${intent}"`);
    }
    overrides.intents = intents as RoutingPlan['intents'];
  }
  if (Array.isArray(flags.queries)) overrides.queries = flags.queries;
  if (Array.isArray(flags.targets)) overrides.targets = flags.targets;
  if (typeof flags.depth === 'string') {
    if (!['shallow', 'standard', 'research'].includes(flags.depth)) {
      throw new Error('--depth must be shallow, standard or research');
    }
    overrides.depth = flags.depth as RoutingPlan['depth'];
  }
  if (flags.fanout !== undefined) {
    const fanout = Number(flags.fanout);
    if (!Number.isInteger(fanout) || fanout < 1) throw new Error('--fanout must be a positive integer');
    overrides.fanout = fanout;
  }
  const plan = clampPlan(mergePlan(planner.plan(prompt), overrides));
  // The same emptiness check `parsePlanJson` applies to `--plan-json`, applied
  // to the MERGED plan so every path to a do-nothing round fails the same way.
  // Without it `research "hello" --queries "   "` reached the executor with
  // nothing to run and exited 2 with a blank report -- no results, no gaps, no
  // next actions, and no statement of what went wrong. A round that cannot do
  // anything is a usage error, and a usage error is caught here, during argv
  // handling, before a candidate is selected or a call is billed.
  if (plan.queries.length === 0 && plan.targets.length === 0) {
    throw new Error(
      'this plan has no queries and no targets, so the round would do nothing: '
        + 'give a prompt with something to search for or a URL to fetch, or pass --queries/--targets',
    );
  }
  return plan;
}

async function cmdPlan(flags: Flags, emit: Emit): Promise<number> {
  const prompt = flags.positionals.join(' ');
  if (prompt.trim() === '') {
    emitUsageError(emit, 'plan', 'requires a prompt, e.g. `fezoctl plan "what is a merkle tree"`');
    return EXIT_USAGE;
  }
  let plan: RoutingPlan;
  try {
    plan = planFromFlags(prompt, flags);
  } catch (error) {
    emitUsageError(emit, 'plan', (error as Error).message);
    return EXIT_USAGE;
  }
  emit.out(renderPlan(plan, flags.json));
  return EXIT_OK;
}

async function cmdResearch(flags: Flags, deps: CliDeps, emit: Emit, excluded: readonly string[]): Promise<number> {
  const prompt = flags.positionals.join(' ');
  if (prompt.trim() === '') {
    emitUsageError(emit, 'research', 'requires a prompt, e.g. `fezoctl research "what is a merkle tree"`');
    return EXIT_USAGE;
  }
  let plan: RoutingPlan;
  let sessionId: string | undefined;
  let maxCalls: number | undefined;
  try {
    plan = planFromFlags(prompt, flags);
    if (typeof flags.session === 'string') {
      validateSessionId(flags.session);
      sessionId = flags.session;
    }
    if (flags.maxCalls !== undefined) {
      const value = Number(flags.maxCalls);
      if (!Number.isInteger(value) || value < 1) throw new Error('--max-calls must be a positive integer');
      maxCalls = value;
    }
  } catch (error) {
    emitUsageError(emit, 'research', (error as Error).message);
    return EXIT_USAGE;
  }

  // The same opening move as search/schema/call/run/catalog: resolve
  // credentials and fetch the catalog, with both failure kinds reported in one
  // place. See `openGateway`'s own comment.
  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;
  const { creds, candidates } = gateway.session;

  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  // Id and state travel together, in one binding: `loadSession` is total (it
  // answers a missing or damaged file with an empty state, never `undefined`),
  // so the state exists on exactly the branch where the id does. Pairing them
  // here is what keeps the save site below from re-proving that with a second
  // `!== undefined` test that reads like a case where a first round with a
  // fresh id might skip persistence -- it never does.
  const active = sessionId !== undefined ? { id: sessionId, state: loadSession(sessionId, env, home) } : undefined;

  const outcome = await runResearch({
    plan,
    candidates,
    excluded,
    gateway: { baseUrl: creds.baseUrl, apiKey: creds.apiKey, ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}) },
    ...(active !== undefined ? { seenUrls: new Set(active.state.seenUrls), sessionId: active.id } : {}),
    ...(maxCalls !== undefined ? { maxCalls } : {}),
  });

  // Results first, cache second -- and the cache never takes the round down
  // with it. By this line the providers have already been called and billed,
  // so an unwritable cache location (a read-only or sandboxed home, an
  // XDG_CACHE_HOME pointing at a non-directory, ENOSPC) must cost the caller
  // the NEXT round's suppression, never this round's paid-for results. Throwing
  // here would reject `runCli` itself: stdout empty despite `--json`, whose
  // contract at the top of this file is that stdout is always a document, and
  // an unhandled rejection out of `main()` instead of an exit code. Same
  // reasoning that makes `loadSession` never throw on a damaged file, and that
  // makes `writeDotEnvFile` report a failed write rather than raise it.
  emit.out(renderResearch(outcome, sessionId, flags.json));

  if (active !== undefined) {
    try {
      saveSession(
        {
          id: active.id,
          // Bounded, newest-last. The file is read and rewritten on every
          // round, so an unbounded union makes a long investigation pay a
          // growing I/O and parse cost for suppression value that decays: the
          // oldest URLs are the ones the agent has most likely finished with,
          // and re-seeing one costs a single duplicate row, not a wrong answer.
          // `slice(-N)` keeps the most recent, which are the ones a follow-up
          // round is actually about to re-encounter.
          seenUrls: [...new Set([...active.state.seenUrls, ...seenUrlsFrom(outcome)])].slice(-SESSION_MAX_SEEN_URLS),
          queries: [...new Set([...active.state.queries, ...plan.queries])].slice(-SESSION_MAX_QUERIES),
          callsBilled: active.state.callsBilled + outcome.billing.callsBilled,
        },
        env,
        home,
      );
    } catch (err) {
      // Reported on stderr only, and deliberately NOT through `emitFailure`:
      // that would put a second JSON document on stdout after the report the
      // round just emitted, and `--json` promises exactly one.
      const message = err instanceof Error ? err.message : String(err);
      emit.err(`fezoctl: could not write the session cache for "${active.id}": ${message} — the next --session round will not suppress what this one returned\n`);
    }
  }

  return outcome.ok ? EXIT_OK : EXIT_OPERATIONAL;
}

// ---------------------------------------------------------------------------
// web-search / scrape / crawl (one-step.ts's ranked walk). One function
// parameterized over `OneStepSpec` rather than three near-identical command
// functions: the three commands differ only in which spec they pass, and
// `runCli`'s dispatch (below) supplies that from `ONE_STEP_SPECS`.
// ---------------------------------------------------------------------------

function oneStepArgWord(argKind: OneStepSpec['argKind']): string {
  return argKind === 'query' ? 'a query' : 'a URL';
}

async function cmdOneStep(spec: OneStepSpec, flags: Flags, deps: CliDeps, emit: Emit, excluded: readonly string[]): Promise<number> {
  const value = flags.positionals.join(' ');
  if (value.length === 0) {
    emitUsageError(emit, spec.command, `requires ${oneStepArgWord(spec.argKind)}, e.g. \`fezoctl ${spec.command} "..."\``);
    return EXIT_USAGE;
  }

  let extra: Record<string, unknown> = {};
  if (flags.extraJson !== undefined) {
    const parsed = parseJsonFlag(flags.extraJson, '--extra-json', spec.command, emit);
    if (!parsed.ok) return EXIT_USAGE;
    const asObject = asPlainObject(parsed.value);
    if (asObject === undefined) {
      emitUsageError(emit, spec.command, '--extra-json must be a JSON object');
      return EXIT_USAGE;
    }
    extra = asObject;
  }

  // Defaults to MAX_PROVIDER_ATTEMPTS (3), NOT `run`'s DEFAULT_MAX_ATTEMPTS
  // (2): this is a ranked-FALLBACK budget across distinct providers, not a
  // retry budget for one already-selected candidate -- see HELP_TEXT's note
  // on the distinction. Same validation as `run`'s `--max-attempts`
  // (integer >= 1), for the same reason (a budget of zero would call nothing
  // and then report the outcome as an operational failure).
  let maxAttempts = MAX_PROVIDER_ATTEMPTS;
  if (flags.maxAttempts !== undefined) {
    const n = Number(flags.maxAttempts);
    if (!Number.isInteger(n) || n < 1) {
      emitUsageError(emit, spec.command, '--max-attempts must be an integer >= 1');
      return EXIT_USAGE;
    }
    maxAttempts = n;
  }

  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;
  const { creds } = gateway.session;

  const result = await runOneStep(
    spec,
    value,
    extra,
    gateway.session.candidates,
    excluded,
    { baseUrl: creds.baseUrl, apiKey: creds.apiKey, ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}) },
    maxAttempts,
  );

  emit.out(renderOneStep(result, flags.json));

  // No provider ever actually reached -> operational failure, same exit code
  // family as `run`'s empty match. Otherwise mirror the served candidate's own
  // outcome (`run()`'s classification already decided success vs. failure).
  if (result.served === undefined) return EXIT_OPERATIONAL;
  return result.report.outcome.kind === 'success' ? EXIT_OK : EXIT_OPERATIONAL;
}

async function cmdCatalog(flags: Flags, deps: CliDeps, emit: Emit, excluded: readonly string[]): Promise<number> {
  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;

  emit.out(renderCatalog(filterExcluded(gateway.session.candidates, excluded), flags.json));
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// providers / list-providers.
// ---------------------------------------------------------------------------

async function cmdProviders(flags: Flags, deps: CliDeps, emit: Emit, excluded: readonly string[]): Promise<number> {
  let intent: Intent | undefined;
  if (flags.intent !== undefined) {
    intent = parseIntentFlag(flags.intent);
    if (intent === undefined) {
      emitUsageError(emit, 'providers', `unknown --intent "${flags.intent}"; must be one of ${INTENTS.join(', ')}`);
      return EXIT_USAGE;
    }
  }

  const detail = parseDetailFlag(flags.detail ?? 'names');
  if (detail === undefined) {
    emitUsageError(emit, 'providers', '--detail must be "names", "descriptions", or "schema"');
    return EXIT_USAGE;
  }

  let limit = DEFAULT_PROVIDERS_LIMIT;
  if (flags.limit !== undefined) {
    const n = Number(flags.limit);
    if (!Number.isInteger(n) || n < 1) {
      emitUsageError(emit, 'providers', '--limit must be an integer >= 1');
      return EXIT_USAGE;
    }
    limit = n;
  }

  // Every validation above runs before this line: unknown --intent/--detail
  // and a non-numeric/<1 --limit are usage errors, rejected before any
  // network call, per the governing spec.
  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;

  // Unfiltered candidates go straight into groupByCapability: the deny-list
  // is threaded through as `excluded` and applied inside viewForIntent's own
  // three passes (see provider-view.ts), so there is no separate pre-filter
  // step here — passing an already-filtered candidate list would just make
  // that internal check a no-op.
  const groups = groupByCapability(gateway.session.candidates, excluded);
  const scoped = intent !== undefined ? groups.filter((g) => g.capability === intent) : groups;

  emit.out(
    renderProviders(scoped, {
      json: flags.json,
      detail,
      limit,
      explain: flags.explain,
      candidates: gateway.session.candidates,
      ...(intent !== undefined ? { intent } : {}),
    }),
  );
  return EXIT_OK;
}

async function cmdListProviders(flags: Flags, deps: CliDeps, emit: Emit, excluded: readonly string[]): Promise<number> {
  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;

  const rows = listProviders(gateway.session.candidates, excluded);
  emit.out(renderListProviders(rows, flags.json));
  return EXIT_OK;
}

/**
 * Classifies a storage backend's reported outcome against what reading the
 * value straight back actually produced — see `cmdSetup`'s doc comment on the
 * call site for why post-write verification exists at all. Three outcomes, not
 * two:
 *
 *   - already a failure -> unchanged.
 *   - verified: the freshly resolved value came from the source just written
 *     and equals what was written -> unchanged (`{ok: true}`, "stored").
 *   - shadowed: resolution answered from a DIFFERENT (higher-priority) source,
 *     e.g. an exported `FEZO_API_KEY` while writing to the Keychain. Nothing
 *     was verified, because there is no way to read past the shadowing source
 *     here. That is not a storage failure — the env var legitimately wins
 *     resolution and the write may well have succeeded — so it stays `ok: true`
 *     and exits 0, but it is reported as UNVERIFIED rather than as "stored":
 *     claiming verification that never happened is exactly how the original
 *     null-password bug (see credentials.ts's `writeKeychainSecret`) could
 *     still slip through for any developer with the env var exported.
 *   - anything else (nothing resolved, or a mismatching value from the source
 *     just written) -> a hard verification failure.
 *
 * `source: 'default'` is deliberately NOT treated as shadowing: the built-in
 * gateway URL is the LAST rung of resolution, so seeing it back means the
 * write did not land, not that something outranked it. Reporting it as a
 * shadow would print "default takes priority over dotenv", which is backwards,
 * and would turn a real failed write into a cheerful `ok: true`.
 */
function verifyStoredField(
  outcome: FieldStoreOutcome,
  expectedSource: CredentialSource,
  resolved: ResolvedValue | undefined,
  expectedValue: string,
): FieldStoreOutcome {
  if (!outcome.ok) return outcome;
  if (resolved !== undefined && resolved.source === 'default') {
    return {
      ok: false,
      reason: 'verification-failed',
      message:
        'the write reported success but the value read back is the built-in default, which is the last source consulted — nothing was actually persisted',
    };
  }
  if (resolved !== undefined && resolved.source !== expectedSource) {
    return {
      ok: true,
      reason: `unverified-shadowed-by-${resolved.source}`,
      message:
        `the write reported success but could not be verified: resolution now answers from "${resolved.source}", ` +
        `which takes priority over "${expectedSource}", so the stored value could not be read back. ` +
        `Unset the higher-priority source and re-run \`fezoctl doctor\` to confirm what was stored.`,
    };
  }
  // Compared through the SAME normalization both sides of the write use
  // (`normalizeCredentialValue`, applied by `readSecretFromStream` and
  // `storeCredentials`), never raw against raw. `.env` is written verbatim but
  // read back through `parseDotEnv`, which trims — so a key pasted with a
  // trailing space used to be written untrimmed, read back trimmed, compared
  // unequal, and reported as `verification-failed` even though the key WAS
  // stored and `doctor` resolved it. One normalization, applied everywhere, is
  // what keeps the three modules from disagreeing.
  if (resolved !== undefined && normalizeCredentialValue(resolved.value) === normalizeCredentialValue(expectedValue)) return outcome;
  return {
    ok: false,
    reason: 'verification-failed',
    message:
      'the value could not be read back and verified after storing it; the storage command may have reported success without actually persisting it',
  };
}

/**
 * Whether `stream` is an interactive terminal, which `cmdSetup` warns about
 * before it blocks on a read that prints no prompt of its own.
 *
 * `isTTY` is a property Node sets on `process.stdin` only; an injected
 * `Readable` (every test, and any programmatic caller) simply does not have
 * it, so this is `false` there without needing a separate code path.
 */
function isInteractiveStream(stream: Readable): boolean {
  return 'isTTY' in stream && Boolean(Reflect.get(stream, 'isTTY'));
}

async function cmdSetup(flags: Flags, deps: CliDeps, emit: Emit): Promise<number> {
  // `--key-stdin` is accepted but no longer required: stdin is the ONLY channel
  // this command has ever read a key from, so demanding a flag to say so made
  // the caller restate the only possibility. Dropping the requirement opens no
  // new path for a key -- there is still no flag, argument, or prompt that
  // accepts one, which is the property the threat model actually depends on
  // (see credentials.ts's header). The flag stays valid so that every recipe
  // already in circulation, including installed copies of SKILL.md, keeps
  // working unchanged.
  // A bare positional is almost certainly the key itself: "setup takes only the
  // API key" invites exactly `fezoctl setup sk-live-...`, which is the one form
  // this command must never make work. Silently ignoring it (what an unread
  // `positionals` array amounts to) would fail with "no API key was provided"
  // while the key sat in the user's shell history and in `ps` output for the
  // life of the process -- a confusing failure AND a leak. Refuse, and say what
  // to do about the value that has already leaked.
  if (flags.positionals.length > 0) {
    emitUsageError(
      emit,
      'setup',
      'takes no positional arguments; the API key is read from stdin, never from argv (any local process can read argv via `ps`, and your shell has already recorded that line). ' +
        'Run `printf \'%s\' "$YOUR_KEY" | fezoctl setup` instead — and if what you just typed was a live key, rotate it.',
    );
    return EXIT_USAGE;
  }

  const storage = flags.storage ?? 'dotenv';
  if (storage !== 'dotenv' && storage !== 'keychain') {
    emitUsageError(emit, 'setup', '--storage must be "dotenv" or "keychain"');
    return EXIT_USAGE;
  }

  const stdin = deps.stdin ?? process.stdin;
  // The read below prints nothing and blocks until EOF. When `--key-stdin` was
  // mandatory, a bare `fezoctl setup` at least failed loudly with a usage
  // error; now it would sit there looking hung, with no way for the user to
  // know it wants input. One line to stderr (never stdout, which stays
  // machine-readable) is the difference between "hung" and "waiting for you".
  if (isInteractiveStream(stdin)) {
    emit.err('fezoctl: reading the API key from stdin — paste it, press Enter, then Ctrl-D. It WILL be visible on screen; pipe the key in instead to avoid that.\n');
  }
  const apiKey = await readSecretFromStream(stdin);

  const stored = storeCredentials({
    storage,
    apiKey,
    ...(flags.url !== undefined ? { url: flags.url } : {}),
    ...(deps.dotEnvPath !== undefined ? { dotEnvPath: deps.dotEnvPath } : {}),
    ...(deps.keychain !== undefined ? { keychain: deps.keychain } : {}),
  });

  const resolution = credentialResolutionFor(deps);
  const display = credentialDisplay(resolution);

  // Verify the write actually round-trips, rather than trusting `stored`'s
  // exit-status-derived `ok` alone. This closes a real gap found smoke-testing
  // against the real macOS `security` binary (Task 8's report): `security
  // add-generic-password ... -U -w` reads a non-interactive stdin pipe for the
  // password AND a confirmation copy: piping the secret only once (what
  // `writeKeychainSecret` sends) makes the confirmation read EOF, which
  // `security` treats as a mismatch — yet it still creates the item with a
  // null/empty password and exits 0. Re-resolving through the SAME source
  // right after storing and comparing against the value we just tried to
  // store catches that class of false success. Only attributed to OUR write
  // when the freshly resolved value's source is the one we just wrote to (or
  // nothing resolved at all) — a higher-priority source (a real env var)
  // overriding resolution is a separate, pre-existing condition, not a
  // storage failure, and must not be reported as one. It is reported as
  // UNVERIFIED instead of "stored", though: see `verifyStoredField`.
  const expectedSource = storage;
  const result: StoreCredentialsResult = {
    storage: stored.storage,
    apiKey: verifyStoredField(stored.apiKey, expectedSource, resolution.apiKey, apiKey),
    ...(stored.url !== undefined && flags.url !== undefined
      ? { url: verifyStoredField(stored.url, expectedSource, resolution.url, flags.url) }
      : stored.url !== undefined
        ? { url: stored.url }
        : {}),
  };

  emit.out(renderSetup({ result, display }, flags.json));

  // Three conditions, not two: the API key stored, the URL (if one was being
  // stored) stored, AND the resulting configuration is actually usable — i.e.
  // a key now resolves.
  //
  // That third condition is why a `setup` whose write silently failed cannot
  // exit 0: `ok` used to ignore resolution entirely, so a run that reported a
  // successful write printed "api key: stored" and exited 0 while the next
  // command failed with `credentials-not-configured`. A `setup` that cannot be
  // followed by a working `catalog` must not report success — and the exit code
  // is the only part of that report a script or an agent reliably reads.
  //
  // Omitting `--url` is NOT such a case, and has not been since the gateway URL
  // grew a built-in default (credentials.ts's `DEFAULT_GATEWAY_URL`): the
  // resulting configuration really is usable, so it really does exit 0. The
  // `configured url:` line names the source, so a user who meant to point at
  // their own gateway can still see that they are on the default one.
  const ok =
    result.apiKey.ok && (result.url === undefined || result.url.ok) && setupProducedUsableConfig(display);
  return ok ? EXIT_OK : EXIT_OPERATIONAL;
}

async function cmdDoctor(flags: Flags, deps: CliDeps, emit: Emit): Promise<number> {
  const checks: DoctorCheck[] = [];

  const resolution = credentialResolutionFor(deps);
  const display = credentialDisplay(resolution);

  // Always `ok` — the URL cannot fail to resolve. The two messages exist
  // because "resolved from default" would otherwise read as a configuration
  // the user made: nobody set this one, and someone on a different gateway
  // needs to notice that before wondering why the catalog looks unfamiliar.
  checks.push(
    resolution.url.source === 'default'
      ? {
          name: 'gateway-url',
          status: 'ok',
          message: 'FEZO_URL is not configured; using the built-in default gateway',
          details: { url: display.url },
        }
      : { name: 'gateway-url', status: 'ok', message: `FEZO_URL resolved from ${resolution.url.source}`, details: { url: display.url } },
  );
  checks.push(
    resolution.apiKey !== undefined
      ? { name: 'api-key', status: 'ok', message: `FEZO_API_KEY resolved from ${resolution.apiKey.source}`, details: { apiKey: display.apiKey } }
      : { name: 'api-key', status: 'fail', message: 'FEZO_API_KEY is not configured (env, Keychain, or .env)' },
  );

  let candidates: ToolCandidate[] | undefined;
  if (resolution.apiKey !== undefined) {
    try {
      candidates = await fetchCatalog({
        baseUrl: resolution.url.value,
        apiKey: resolution.apiKey.value,
        ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
      });
      checks.push({ name: 'gateway-connectivity', status: 'ok', message: 'reached the gateway' });
      checks.push({ name: 'auth', status: 'ok', message: 'the API key was accepted' });
      checks.push({ name: 'catalog-readable', status: 'ok', message: `parsed ${String(candidates.length)} tool candidate(s) from the catalog` });
    } catch (err) {
      if (err instanceof CatalogFetchError && err.reason === 'status') {
        if (err.status === 401 || err.status === 403) {
          checks.push({ name: 'gateway-connectivity', status: 'ok', message: 'reached the gateway' });
          checks.push({ name: 'auth', status: 'fail', message: `the gateway rejected the API key (status ${String(err.status)})` });
          checks.push({ name: 'catalog-readable', status: 'skipped', message: 'skipped: auth failed' });
        } else {
          checks.push({ name: 'gateway-connectivity', status: 'fail', message: `gateway responded with status ${String(err.status)}` });
          checks.push({ name: 'auth', status: 'skipped', message: 'skipped: connectivity failed' });
          checks.push({ name: 'catalog-readable', status: 'skipped', message: 'skipped: connectivity failed' });
        }
      } else if (err instanceof CatalogFetchError) {
        // reason === 'parse': the gateway answered (and accepted the key), but
        // the body was not a catalog document.
        checks.push({ name: 'gateway-connectivity', status: 'ok', message: 'reached the gateway' });
        checks.push({ name: 'auth', status: 'ok', message: 'the API key was accepted' });
        checks.push({ name: 'catalog-readable', status: 'fail', message: `the catalog response could not be parsed as JSON (status ${String(err.status)})` });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        checks.push({ name: 'gateway-connectivity', status: 'fail', message: `could not reach the gateway: ${message}` });
        checks.push({ name: 'auth', status: 'skipped', message: 'skipped: connectivity failed' });
        checks.push({ name: 'catalog-readable', status: 'skipped', message: 'skipped: connectivity failed' });
      }
    }
  } else {
    checks.push({ name: 'gateway-connectivity', status: 'skipped', message: 'skipped: credentials not configured' });
    checks.push({ name: 'auth', status: 'skipped', message: 'skipped: credentials not configured' });
    checks.push({ name: 'catalog-readable', status: 'skipped', message: 'skipped: credentials not configured' });
  }

  if (candidates !== undefined) {
    // Ported scope: the old check only looked at `CAPABILITY_PREFERENCES`
    // (scrape/web-search's two buckets). This validates the WHOLE declared
    // table (all seven intents' RECOMMENDATIONS, providers.ts) against the
    // live catalog, two independent ways a declared row can be stale:
    //   - the backend itself is absent from this gateway's catalog entirely;
    //   - the backend is present, but the specific `entryMethods` name this
    //     repo advertises as a "genuine entry point" for the intent (what
    //     `providers`/`list-providers`/the one-step walk try first) is not
    //     one of its published tool names.
    // A backend that is wholly absent trivially fails the second check too
    // (none of its tool names are published), so `missingEntryMethods` is
    // reported ADDITIONALLY, not instead of, `missingBackends` — a reviewer
    // reading "brightdata" only in the backends list would otherwise have to
    // re-derive that its entry methods are unreachable too.
    const liveBackends = new Set(candidates.map((candidate) => candidate.backendId));
    const liveTools = new Set(candidates.map((candidate) => candidate.tool));
    const missingBackends = new Set<string>();
    const missingEntryMethods = new Set<string>();
    for (const intent of INTENTS) {
      for (const rec of recommendationsFor(intent)) {
        if (!liveBackends.has(rec.backendId)) missingBackends.add(rec.backendId);
        for (const method of rec.entryMethods) {
          if (!liveTools.has(method)) missingEntryMethods.add(method);
        }
      }
    }
    const missingBackendsList = [...missingBackends].sort();
    const missingEntryMethodsList = [...missingEntryMethods].sort();
    if (missingBackendsList.length === 0 && missingEntryMethodsList.length === 0) {
      checks.push({
        name: 'preference-hints',
        status: 'ok',
        message: 'every backend and entry method declared in providers.ts (RECOMMENDATIONS) is present in the live catalog',
      });
    } else {
      const clauses: string[] = [];
      if (missingBackendsList.length > 0) clauses.push(`backend(s) absent from the live catalog: ${missingBackendsList.join(', ')}`);
      if (missingEntryMethodsList.length > 0) clauses.push(`declared entry method(s) not published: ${missingEntryMethodsList.join(', ')}`);
      // A `warn`, never a `fail`: a declared row naming a backend/method this
      // particular gateway does not (yet, or ever) expose does not mean
      // fezoctl is broken — the affected row just contributes no ranking
      // signal, exactly like the pre-fix check's own reasoning for the two
      // buckets it covered.
      checks.push({
        name: 'preference-hints',
        status: 'warn',
        message: `providers.ts declares ${clauses.join('; ')}`,
        details: { missingBackends: missingBackendsList, missingEntryMethods: missingEntryMethodsList },
      });
    }
  } else {
    checks.push({ name: 'preference-hints', status: 'skipped', message: 'skipped: catalog unavailable' });
  }

  emit.out(renderDoctor(checks, flags.json));
  return checks.some((check) => check.status === 'fail') ? EXIT_OPERATIONAL : EXIT_OK;
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<CliResult> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const write = (line: string): void => {
    outLines.push(line);
  };
  const writeErr = (line: string): void => {
    errLines.push(line);
  };
  const finish = (exitCode: number): CliResult => ({ exitCode, stdout: outLines.join(''), stderr: errLines.join('') });

  // Before argv is parsed there is no `Flags` to read `--json` off, so these
  // pre-parse paths derive it straight from argv. That is the SAME condition
  // `parseArgv` applies (`--json` is a boolean flag, matched by exact token),
  // so the two agree for every argv that reaches a command.
  const preParseEmit: Emit = { out: write, err: writeErr, json: argv.includes('--json') };

  const first = argv[0];
  // Recognized anywhere in argv, not just at argv[0]: `fezoctl search -h`
  // otherwise silently searches the catalog for the term "-h".
  const wantsHelp = argv.some((token) => token === '--help' || token === '-h');
  if (first === undefined || wantsHelp) {
    write(HELP_TEXT);
    return finish(EXIT_OK);
  }
  if (first === '--version') {
    // Still guarded, because `resolveVersion`'s fallback reads a file and can
    // throw: an unhandled rejection here would print a stack trace where a
    // version string belongs, and the skill's invocation ladder compares a
    // global `fezoctl --version` against the skill's own version to decide
    // whether to use it — so a thrown error becomes silent mis-resolution
    // rather than a visible failure.
    let version: string;
    try {
      version = resolveVersion();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure(preParseEmit, 'version-unavailable', `could not determine fezoctl's own version: ${message}`);
      return finish(EXIT_OPERATIONAL);
    }
    write(renderVersion(version, preParseEmit.json));
    return finish(EXIT_OK);
  }

  const parsed = parseArgv(argv.slice(1));
  if (!parsed.ok) {
    emitFailure(preParseEmit, 'usage', parsed.error);
    writeErr(HELP_TEXT);
    return finish(EXIT_USAGE);
  }
  const { flags } = parsed;
  const emit: Emit = { out: write, err: writeErr, json: flags.json };
  // Resolved once, here, and threaded to every command that needs it — never
  // read from `process.env` inside a command function. See providers.ts's
  // module doc for why a module-load-time env read would be wrong for
  // fezo-skills specifically; the same reasoning applies to reading it more
  // than once per `runCli` call.
  const excluded = resolveExcludedBackends(deps.env ?? process.env);

  // One-step commands dispatch through a single lookup rather than three
  // `case` arms that each hand-pick their own spec: `ONE_STEP_SPECS` is the
  // one place the command-name-to-spec mapping is declared (one-step.ts), so
  // adding a fourth one-step command needs no change here.
  const oneStepSpec = ONE_STEP_SPECS.find((spec) => spec.command === first);
  if (oneStepSpec) {
    return finish(await cmdOneStep(oneStepSpec, flags, deps, emit, excluded));
  }

  switch (first) {
    case 'search':
      return finish(await cmdSearch(flags, deps, emit, excluded));
    case 'schema':
      return finish(await cmdSchema(flags, deps, emit, excluded));
    case 'call':
      return finish(await cmdCall(flags, deps, emit, excluded));
    case 'run':
      return finish(await cmdRun(flags, deps, emit, excluded));
    case 'plan':
      return finish(await cmdPlan(flags, emit));
    case 'research':
      return finish(await cmdResearch(flags, deps, emit, excluded));
    case 'catalog':
      return finish(await cmdCatalog(flags, deps, emit, excluded));
    case 'providers':
      return finish(await cmdProviders(flags, deps, emit, excluded));
    case 'list-providers':
      return finish(await cmdListProviders(flags, deps, emit, excluded));
    case 'setup':
      return finish(await cmdSetup(flags, deps, emit));
    case 'doctor':
      return finish(await cmdDoctor(flags, deps, emit));
    default:
      // `preParseEmit`, not `emit`: the unrecognized command may itself be the
      // `--json` token (`fezoctl --json`), in which case `parseArgv` never saw
      // it as a flag and `flags.json` is false — and stdout would go silent on
      // exactly the invocation that asked for JSON.
      emitFailure(preParseEmit, 'usage', `unknown command "${first}"`);
      writeErr(HELP_TEXT);
      return finish(EXIT_USAGE);
  }
}

// ---------------------------------------------------------------------------
// Real entry point. Not wired into `package.json`'s `bin` by this task — that
// is the bundler task's job — but provided so a later task has a working
// default rather than reimplementing the process wiring.
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2), {
    env: process.env,
    stdin: process.stdin,
    keychain: systemKeychainRunner,
  });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
