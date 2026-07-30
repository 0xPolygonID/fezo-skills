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

import { Ajv } from 'ajv';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

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
import { CAPABILITY_PREFERENCES, inferCapability } from './engine/preference.js';
import type { RunSelection } from './engine/rank.js';
import { rankCandidates, searchCandidates, selectForRun } from './engine/rank.js';
import type { CliErrorKind, DoctorCheck } from './engine/render.js';
import {
  renderCall,
  renderCatalog,
  renderDoctor,
  renderError,
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
import { findCandidateByToolName } from './engine/tool-name.js';

// ---------------------------------------------------------------------------
// argv parsing.
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(['--json', '--schema', '--retry-empty-2xx', '--allow-unhinted-auto-pick', '--key-stdin']);
const VALUE_FLAGS = new Set(['--args-json', '--body-json', '--max-attempts', '--url', '--storage']);

interface Flags {
  positionals: string[];
  json: boolean;
  schema: boolean;
  retryEmpty2xx: boolean;
  allowUnhintedAutoPick: boolean;
  keyStdin: boolean;
  argsJson?: string;
  bodyJson?: string;
  maxAttempts?: string;
  url?: string;
  storage?: string;
}

type ParseResult = { ok: true; flags: Flags } | { ok: false; error: string };

function parseArgv(argv: readonly string[]): ParseResult {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
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
      ...(values['--args-json'] !== undefined ? { argsJson: values['--args-json'] } : {}),
      ...(values['--body-json'] !== undefined ? { bodyJson: values['--body-json'] } : {}),
      ...(values['--max-attempts'] !== undefined ? { maxAttempts: values['--max-attempts'] } : {}),
      ...(values['--url'] !== undefined ? { url: values['--url'] } : {}),
      ...(values['--storage'] !== undefined ? { storage: values['--storage'] } : {}),
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

const probeAjv = new Ajv({ allErrors: true, strict: false });

function schemaCompiles(schema: object | boolean): boolean {
  try {
    probeAjv.compile(schema);
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
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_OPERATIONAL = 2;

const HELP_TEXT = `fezoctl — discover and call Fezo/Zug gateway tools from the live catalog

Usage:
  fezoctl search "<query>" [--schema] [--json]
  fezoctl schema <tool> [--json]
  fezoctl call <tool> --args-json '<json>' [--body-json '<json>'] [--json]
  fezoctl run "<intent>" --args-json '<json>' [--body-json '<json>']
             [--max-attempts N] [--retry-empty-2xx] [--allow-unhinted-auto-pick] [--json]
  fezoctl catalog [--json]
  fezoctl setup --key-stdin [--url <url>] [--storage keychain|dotenv] [--json]
  fezoctl doctor [--json]
  fezoctl --version
  fezoctl --help

Credentials are never accepted as a command-line argument: setup --key-stdin
reads the API key from stdin. Otherwise, set FEZO_URL and FEZO_API_KEY (the
deprecated ZUG_URL/ZUG_API_KEY aliases are also accepted, with one warning).

With --json, stdout is always a JSON document — never empty. A failure that
never reached the gateway is {"error":{"kind":"...","message":"..."}}, where
kind is one of: usage, credentials-not-configured, catalog-unavailable,
tool-not-found, invalid-args, invalid-body, version-unavailable. A call/run
that did reach the gateway emits its full attempt-log document instead (the
failure is in its outcome/result, alongside what was billed). The
human-readable message always goes to stderr, and exit codes do not change.

Exit codes:
  0  success
  1  usage error: a bad command/flag, or an unparseable --args-json/--body-json
     payload — rejected before any candidate is selected or called.
  2  operational failure: credentials not configured, the gateway/catalog
     could not be reached or read, arguments failed schema validation, or a
     call/run that did not end in success (including a run refusal, an empty
     match, or doctor finding a hard failure).
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

function requireCredentials(deps: CliDeps, emit: Emit): ResolvedGateway | undefined {
  const resolution = credentialResolutionFor(deps);
  if (resolution.url === undefined || resolution.apiKey === undefined) {
    emitFailure(
      emit,
      'credentials-not-configured',
      'gateway URL and/or API key are not configured; run `fezoctl setup --key-stdin` or set FEZO_URL/FEZO_API_KEY',
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

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function cmdSearch(flags: Flags, deps: CliDeps, emit: Emit): Promise<number> {
  const query = flags.positionals.join(' ');
  if (query.length === 0) {
    emitUsageError(emit, 'search', 'requires a query, e.g. `fezoctl search "scrape this page"`');
    return EXIT_USAGE;
  }

  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;

  const matches = searchCandidates(gateway.session.candidates, query);
  const inference = inferCapability(query);
  const capability = inference.kind === 'matched' ? inference.capability : undefined;
  const ranked = rankCandidates(matches, query, capability);

  emit.out(renderSearch(ranked, query, { json: flags.json, includeSchema: flags.schema }));
  return EXIT_OK;
}

async function cmdSchema(flags: Flags, deps: CliDeps, emit: Emit): Promise<number> {
  const tool = flags.positionals[0];
  if (tool === undefined || flags.positionals.length > 1) {
    emitUsageError(emit, 'schema', 'requires exactly one tool name, e.g. `fezoctl schema firecrawl_scrape`');
    return EXIT_USAGE;
  }

  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;

  const candidate = findCandidateByToolName(gateway.session.candidates, tool);
  if (!candidate) {
    emitFailure(emit, 'tool-not-found', `tool "${tool}" was not found in the catalog`);
    return EXIT_OPERATIONAL;
  }

  emit.out(renderSchema(candidate, flags.json));
  return EXIT_OK;
}

async function cmdCall(flags: Flags, deps: CliDeps, emit: Emit): Promise<number> {
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

  const candidate = findCandidateByToolName(gateway.session.candidates, tool);
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

async function cmdRun(flags: Flags, deps: CliDeps, emit: Emit): Promise<number> {
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

  const selection = selectForRun(gateway.session.candidates, intent);
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

async function cmdCatalog(flags: Flags, deps: CliDeps, emit: Emit): Promise<number> {
  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;

  emit.out(renderCatalog(gateway.session.candidates, flags.json));
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
 */
function verifyStoredField(
  outcome: FieldStoreOutcome,
  expectedSource: CredentialSource,
  resolved: ResolvedValue | undefined,
  expectedValue: string,
): FieldStoreOutcome {
  if (!outcome.ok) return outcome;
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

async function cmdSetup(flags: Flags, deps: CliDeps, emit: Emit): Promise<number> {
  if (!flags.keyStdin) {
    emitUsageError(emit, 'setup', 'requires --key-stdin (the API key is read from stdin; it must never be passed as a command-line argument)');
    return EXIT_USAGE;
  }
  const storage = flags.storage ?? 'dotenv';
  if (storage !== 'dotenv' && storage !== 'keychain') {
    emitUsageError(emit, 'setup', '--storage must be "dotenv" or "keychain"');
    return EXIT_USAGE;
  }

  const stdin = deps.stdin ?? process.stdin;
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
  // BOTH a URL and a key now resolve.
  //
  // That third condition is why `setup --key-stdin` with no `--url` no longer
  // exits 0. It used to: `ok` ignored the URL entirely, so a run that stored
  // the key and left the gateway URL unset printed "api key: stored" and exited
  // 0, and the next command failed with `credentials-not-configured`. A `setup`
  // that cannot be followed by a working `catalog` must not report success —
  // and the exit code is the only part of that report a script or an agent
  // reliably reads. The output still says exactly what DID get stored (see
  // `renderSetup`), so nothing is lost by the non-zero exit: this is a partial
  // success reported as incomplete, not a write failure. A user who supplies
  // `FEZO_URL` by environment variable instead of `--url` already has it
  // resolving at this point (resolution reads the env first), so they exit 0.
  const ok =
    result.apiKey.ok && (result.url === undefined || result.url.ok) && setupProducedUsableConfig(display);
  return ok ? EXIT_OK : EXIT_OPERATIONAL;
}

async function cmdDoctor(flags: Flags, deps: CliDeps, emit: Emit): Promise<number> {
  const checks: DoctorCheck[] = [];

  const resolution = credentialResolutionFor(deps);
  const display = credentialDisplay(resolution);

  checks.push(
    resolution.url !== undefined
      ? { name: 'gateway-url', status: 'ok', message: `FEZO_URL resolved from ${resolution.url.source}`, details: { url: display.url } }
      : { name: 'gateway-url', status: 'fail', message: 'FEZO_URL is not configured (env, Keychain, or .env)' },
  );
  checks.push(
    resolution.apiKey !== undefined
      ? { name: 'api-key', status: 'ok', message: `FEZO_API_KEY resolved from ${resolution.apiKey.source}`, details: { apiKey: display.apiKey } }
      : { name: 'api-key', status: 'fail', message: 'FEZO_API_KEY is not configured (env, Keychain, or .env)' },
  );

  let candidates: ToolCandidate[] | undefined;
  if (resolution.url !== undefined && resolution.apiKey !== undefined) {
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
    const liveBackends = new Set(candidates.map((candidate) => candidate.backendId));
    const hintedBackends = new Set<string>([
      ...CAPABILITY_PREFERENCES.scrape,
      ...CAPABILITY_PREFERENCES.serp,
      ...CAPABILITY_PREFERENCES['web-search'],
    ]);
    const missing = [...hintedBackends].filter((backendId) => !liveBackends.has(backendId)).sort();
    checks.push(
      missing.length === 0
        ? { name: 'preference-hints', status: 'ok', message: 'every backend named in CAPABILITY_PREFERENCES is present in the live catalog' }
        : {
            name: 'preference-hints',
            status: 'warn',
            message: `preference hints name backend(s) absent from the live catalog: ${missing.join(', ')}`,
            details: { missing },
          },
    );
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

  switch (first) {
    case 'search':
      return finish(await cmdSearch(flags, deps, emit));
    case 'schema':
      return finish(await cmdSchema(flags, deps, emit));
    case 'call':
      return finish(await cmdCall(flags, deps, emit));
    case 'run':
      return finish(await cmdRun(flags, deps, emit));
    case 'catalog':
      return finish(await cmdCatalog(flags, deps, emit));
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
