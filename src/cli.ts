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
//      schema validation, or a `call`/`run` that did not end in success
//      (including a `run` refusal or an empty match).

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
  readSecretFromStream,
  resolveCredentials,
  storeCredentials,
  systemKeychainRunner,
} from './engine/credentials.js';
import { CAPABILITY_PREFERENCES, inferCapability } from './engine/preference.js';
import type { RunSelection } from './engine/rank.js';
import { rankCandidates, searchCandidates, selectForRun } from './engine/rank.js';
import type { DoctorCheck } from './engine/render.js';
import {
  renderCall,
  renderCatalog,
  renderDoctor,
  renderRun,
  renderSchema,
  renderSearch,
  renderSetup,
  renderVersion,
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
// --version: reads package.json rather than a hardcoded string, so a drifting
// version cannot silently break the invocation ladder's tier-3 version check.
// ---------------------------------------------------------------------------

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
  return { attempts: [attempt], outcome: { kind: 'give_up', reason: 'no more candidates to try' } };
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

Exit codes:
  0  success
  1  usage error: a bad command/flag, or an unparseable --args-json/--body-json
     payload — rejected before any candidate is selected or called.
  2  operational failure: credentials not configured, the gateway/catalog
     could not be reached or read, arguments failed schema validation, or a
     call/run that did not end in success (including a run refusal, an empty
     match, or doctor finding a hard failure).
`;

function usageErrorMessage(command: string, message: string): string {
  return `fezoctl: ${command}: ${message}\n`;
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

function requireCredentials(deps: CliDeps, writeErr: (line: string) => void): ResolvedGateway | undefined {
  const resolution = credentialResolutionFor(deps);
  if (resolution.url === undefined || resolution.apiKey === undefined) {
    writeErr('fezoctl: gateway URL and/or API key are not configured; run `fezoctl setup --key-stdin` or set FEZO_URL/FEZO_API_KEY\n');
    return undefined;
  }
  return { baseUrl: resolution.url.value, apiKey: resolution.apiKey.value };
}

function parseJsonFlag(raw: string, flagName: string, command: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: usageErrorMessage(command, `${flagName} is not valid JSON: ${message}`) };
  }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function cmdSearch(flags: Flags, deps: CliDeps, write: (s: string) => void, writeErr: (s: string) => void): Promise<number> {
  const query = flags.positionals.join(' ');
  if (query.length === 0) {
    writeErr(usageErrorMessage('search', 'requires a query, e.g. `fezoctl search "scrape this page"`'));
    return EXIT_USAGE;
  }

  const creds = requireCredentials(deps, writeErr);
  if (!creds) return EXIT_OPERATIONAL;

  let candidates: ToolCandidate[];
  try {
    candidates = await fetchCatalog({ baseUrl: creds.baseUrl, apiKey: creds.apiKey, ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}) });
  } catch (err) {
    writeErr(`fezoctl: ${catalogErrorMessage(err)}\n`);
    return EXIT_OPERATIONAL;
  }

  const matches = searchCandidates(candidates, query);
  const inference = inferCapability(query);
  const capability = inference.kind === 'matched' ? inference.capability : undefined;
  const ranked = rankCandidates(matches, query, capability);

  write(renderSearch(ranked, query, { json: flags.json, includeSchema: flags.schema }));
  return EXIT_OK;
}

async function cmdSchema(flags: Flags, deps: CliDeps, write: (s: string) => void, writeErr: (s: string) => void): Promise<number> {
  const tool = flags.positionals[0];
  if (tool === undefined || flags.positionals.length > 1) {
    writeErr(usageErrorMessage('schema', 'requires exactly one tool name, e.g. `fezoctl schema firecrawl_scrape`'));
    return EXIT_USAGE;
  }

  const creds = requireCredentials(deps, writeErr);
  if (!creds) return EXIT_OPERATIONAL;

  let candidates: ToolCandidate[];
  try {
    candidates = await fetchCatalog({ baseUrl: creds.baseUrl, apiKey: creds.apiKey, ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}) });
  } catch (err) {
    writeErr(`fezoctl: ${catalogErrorMessage(err)}\n`);
    return EXIT_OPERATIONAL;
  }

  const candidate = findCandidateByToolName(candidates, tool);
  if (!candidate) {
    writeErr(`fezoctl: tool "${tool}" was not found in the catalog\n`);
    return EXIT_OPERATIONAL;
  }

  write(renderSchema(candidate, flags.json));
  return EXIT_OK;
}

async function cmdCall(flags: Flags, deps: CliDeps, write: (s: string) => void, writeErr: (s: string) => void): Promise<number> {
  const tool = flags.positionals[0];
  if (tool === undefined || flags.positionals.length > 1) {
    writeErr(usageErrorMessage('call', 'requires exactly one tool name, e.g. `fezoctl call firecrawl_scrape --args-json \'{...}\'`'));
    return EXIT_USAGE;
  }
  if (flags.argsJson === undefined) {
    writeErr(usageErrorMessage('call', "requires --args-json '<json>'"));
    return EXIT_USAGE;
  }

  const argsParsed = parseJsonFlag(flags.argsJson, '--args-json', 'call');
  if (!argsParsed.ok) {
    writeErr(argsParsed.error);
    return EXIT_USAGE;
  }
  const args = argsParsed.value;

  let bodyJson: unknown;
  if (flags.bodyJson !== undefined) {
    const bodyParsed = parseJsonFlag(flags.bodyJson, '--body-json', 'call');
    if (!bodyParsed.ok) {
      writeErr(bodyParsed.error);
      return EXIT_USAGE;
    }
    bodyJson = bodyParsed.value;
  }

  const creds = requireCredentials(deps, writeErr);
  if (!creds) return EXIT_OPERATIONAL;

  let candidates: ToolCandidate[];
  try {
    candidates = await fetchCatalog({ baseUrl: creds.baseUrl, apiKey: creds.apiKey, ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}) });
  } catch (err) {
    writeErr(`fezoctl: ${catalogErrorMessage(err)}\n`);
    return EXIT_OPERATIONAL;
  }

  const candidate = findCandidateByToolName(candidates, tool);
  if (!candidate) {
    write(renderCall({ tool, report: unresolvedToolReport(tool) }, flags.json));
    return EXIT_OPERATIONAL;
  }

  const cache = new SchemaValidatorCache();
  const argsValidation = validateArgs(cache.get(candidate.inputSchema), args);
  if (!argsValidation.valid) {
    writeErr(`fezoctl: --args-json does not match ${candidate.tool}'s input schema: ${argsValidation.errorText}\n`);
    return EXIT_OPERATIONAL;
  }
  if (bodyJson !== undefined) {
    const bodyValidation = validateBodyAgainstBinding(cache, candidate, bodyJson);
    if (!bodyValidation.valid) {
      writeErr(`fezoctl: --body-json does not match ${candidate.tool}'s request body schema: ${bodyValidation.errorText}\n`);
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

  write(renderCall({ tool, candidate, ...(boundRequest !== undefined ? { boundRequest } : {}), report }, flags.json));
  return report.outcome.kind === 'success' ? EXIT_OK : EXIT_OPERATIONAL;
}

async function cmdRun(flags: Flags, deps: CliDeps, write: (s: string) => void, writeErr: (s: string) => void): Promise<number> {
  const intent = flags.positionals.join(' ');
  if (intent.length === 0) {
    writeErr(usageErrorMessage('run', 'requires an intent, e.g. `fezoctl run "scrape this page" --args-json \'{...}\'`'));
    return EXIT_USAGE;
  }
  if (flags.argsJson === undefined) {
    writeErr(usageErrorMessage('run', "requires --args-json '<json>'"));
    return EXIT_USAGE;
  }

  const argsParsed = parseJsonFlag(flags.argsJson, '--args-json', 'run');
  if (!argsParsed.ok) {
    writeErr(argsParsed.error);
    return EXIT_USAGE;
  }
  const args = argsParsed.value;

  let bodyJson: unknown;
  if (flags.bodyJson !== undefined) {
    const bodyParsed = parseJsonFlag(flags.bodyJson, '--body-json', 'run');
    if (!bodyParsed.ok) {
      writeErr(bodyParsed.error);
      return EXIT_USAGE;
    }
    bodyJson = bodyParsed.value;
  }

  let maxAttempts: number | undefined;
  if (flags.maxAttempts !== undefined) {
    const n = Number(flags.maxAttempts);
    if (!Number.isInteger(n) || n < 0) {
      writeErr(usageErrorMessage('run', '--max-attempts must be a non-negative integer'));
      return EXIT_USAGE;
    }
    maxAttempts = n;
  }

  const creds = requireCredentials(deps, writeErr);
  if (!creds) return EXIT_OPERATIONAL;

  let candidates: ToolCandidate[];
  try {
    candidates = await fetchCatalog({ baseUrl: creds.baseUrl, apiKey: creds.apiKey, ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}) });
  } catch (err) {
    writeErr(`fezoctl: ${catalogErrorMessage(err)}\n`);
    return EXIT_OPERATIONAL;
  }

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

  write(renderRun({ intent, selection, allowUnhintedAutoPick: flags.allowUnhintedAutoPick, ...(report !== undefined ? { report } : {}) }, flags.json));

  if (report === undefined) return EXIT_OPERATIONAL;
  return report.outcome.kind === 'success' ? EXIT_OK : EXIT_OPERATIONAL;
}

async function cmdCatalog(flags: Flags, deps: CliDeps, write: (s: string) => void, writeErr: (s: string) => void): Promise<number> {
  const creds = requireCredentials(deps, writeErr);
  if (!creds) return EXIT_OPERATIONAL;

  let candidates: ToolCandidate[];
  try {
    candidates = await fetchCatalog({ baseUrl: creds.baseUrl, apiKey: creds.apiKey, ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}) });
  } catch (err) {
    writeErr(`fezoctl: ${catalogErrorMessage(err)}\n`);
    return EXIT_OPERATIONAL;
  }

  write(renderCatalog(candidates, flags.json));
  return EXIT_OK;
}

/**
 * Downgrades a storage backend's reported outcome to a failure when it cannot
 * be verified by reading the value straight back — see `cmdSetup`'s doc
 * comment on the call site for why this exists. Leaves `outcome` untouched
 * when it was already a failure, or when the freshly resolved value came from
 * a source other than the one just written (nothing to attribute a mismatch
 * to; a higher-priority source is a separate, pre-existing condition).
 */
function verifyStoredField(
  outcome: FieldStoreOutcome,
  expectedSource: CredentialSource,
  resolved: ResolvedValue | undefined,
  expectedValue: string,
): FieldStoreOutcome {
  if (!outcome.ok) return outcome;
  if (resolved !== undefined && resolved.source !== expectedSource) return outcome;
  if (resolved !== undefined && resolved.value === expectedValue) return outcome;
  return {
    ok: false,
    reason: 'verification-failed',
    message:
      'the value could not be read back and verified after storing it; the storage command may have reported success without actually persisting it',
  };
}

async function cmdSetup(flags: Flags, deps: CliDeps, write: (s: string) => void, writeErr: (s: string) => void): Promise<number> {
  if (!flags.keyStdin) {
    writeErr(
      usageErrorMessage('setup', 'requires --key-stdin (the API key is read from stdin; it must never be passed as a command-line argument)'),
    );
    return EXIT_USAGE;
  }
  const storage = flags.storage ?? 'dotenv';
  if (storage !== 'dotenv' && storage !== 'keychain') {
    writeErr(usageErrorMessage('setup', '--storage must be "dotenv" or "keychain"'));
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
  // storage failure, and must not be reported as one.
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

  write(renderSetup({ result, display }, flags.json));

  const ok = result.apiKey.ok && (result.url === undefined || result.url.ok);
  return ok ? EXIT_OK : EXIT_OPERATIONAL;
}

async function cmdDoctor(flags: Flags, deps: CliDeps, write: (s: string) => void, _writeErr: (s: string) => void): Promise<number> {
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

  write(renderDoctor(checks, flags.json));
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

  const first = argv[0];
  if (first === undefined || first === '--help' || first === '-h') {
    write(HELP_TEXT);
    return finish(EXIT_OK);
  }
  if (first === '--version') {
    write(renderVersion(resolvePackageVersion(), argv.includes('--json')));
    return finish(EXIT_OK);
  }

  const parsed = parseArgv(argv.slice(1));
  if (!parsed.ok) {
    writeErr(`fezoctl: ${parsed.error}\n`);
    writeErr(HELP_TEXT);
    return finish(EXIT_USAGE);
  }
  const { flags } = parsed;

  switch (first) {
    case 'search':
      return finish(await cmdSearch(flags, deps, write, writeErr));
    case 'schema':
      return finish(await cmdSchema(flags, deps, write, writeErr));
    case 'call':
      return finish(await cmdCall(flags, deps, write, writeErr));
    case 'run':
      return finish(await cmdRun(flags, deps, write, writeErr));
    case 'catalog':
      return finish(await cmdCatalog(flags, deps, write, writeErr));
    case 'setup':
      return finish(await cmdSetup(flags, deps, write, writeErr));
    case 'doctor':
      return finish(await cmdDoctor(flags, deps, write, writeErr));
    default:
      writeErr(`fezoctl: unknown command "${first}"\n`);
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
