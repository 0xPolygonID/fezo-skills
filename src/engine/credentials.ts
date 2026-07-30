// Credential resolution and `setup` primitives.
//
// This module resolves the gateway URL and API key `fezoctl` needs for every
// other engine call (catalog.ts's `fetchCatalog`, client.ts's `callTool`,
// retry.ts's `run` — all of which take `baseUrl`/`apiKey` as *explicit*
// parameters and resolve nothing themselves, by design). It also implements
// the storage half of `fezoctl setup --key-stdin`: writing a secret to
// macOS Keychain or a `.env` file without ever putting it in argv, a log
// line, or a world-readable file.
//
// THREAT MODEL, reiterated because every rule below exists to close one leak
// path, not as boilerplate: an API key must never reach a conversation
// transcript, `ps` output, shell history, a log line, or a file any other
// local user can read.
//
//   1. Never collect a key through a conversational UI. This module has no
//      such UI — it only reads a key from an injected stream (`readSecretFromStream`)
//      and the CLI (a later task) is expected to wire that to stdin, never to
//      an `AskUserQuestion`-style prompt.
//   2. Never put a key in argv. `writeKeychainSecret` builds the `security`
//      argv WITHOUT a value following `-w` (see its doc comment for why that
//      specific form pipes the secret through stdin instead of exposing it to
//      `ps`), and nothing in this module ever accepts a key via a CLI flag.
//   3. `.env` is opened with `fs.openSync(path, 'wx', 0o600)` — mode set AT
//      OPEN TIME, not chmod'ed after the fact, and `wx` refuses to clobber an
//      existing file (see `writeDotEnvFile`).
//   4. Every value this module renders back to a caller is either non-secret
//      (a `CredentialSource`, a file path, a boolean) or has gone through
//      `maskSecret`. This module never constructs or logs an `Authorization`
//      header — it has no reason to; that header is client.ts's job.
//
// Resolution order (identical for both `FEZO_URL`/`FEZO_API_KEY`): canonical
// env var, then its deprecated `ZUG_*` alias (warned exactly once per
// process — see `resolveCredentials`), then macOS Keychain, then `.env`.
// The gateway is not being renamed, so the aliases are a real supported path,
// not a legacy stub to delete later.

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/**
 * Emits a diagnostic to stderr, in the same form (and for the same reason) as
 * catalog.ts's, bindings.ts's, client.ts's, and retry.ts's `warn`: stdout is
 * reserved for the CLI's machine-readable output. Never called with a secret.
 */
function warn(message: string): void {
  process.stderr.write(`fezoctl: ${message}\n`);
}

/**
 * Reads a Node error's `.code` (e.g. `"EEXIST"`, `"ENOENT"`) without an `as`
 * cast: `err` from a `catch` clause is `unknown`, and narrowing it with `in`
 * (after confirming it is a non-null object) is enough to read the property
 * safely. `Reflect.get` returns `any` rather than requiring a cast to index
 * into it.
 */
function nodeErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const code: unknown = Reflect.get(err, 'code');
  return typeof code === 'string' ? code : undefined;
}

/** Strips one or more trailing newlines (`\n` or `\r\n`). Does not touch interior or leading whitespace. */
function trimTrailingNewline(value: string): string {
  return value.replace(/\r?\n+$/, '');
}

// ---------------------------------------------------------------------------
// Masking.
// ---------------------------------------------------------------------------

/** How many leading characters of a secret `maskSecret` ever reveals. */
const MASK_VISIBLE_CHARS = 4;

/**
 * Renders a secret for display: at most `MASK_VISIBLE_CHARS` leading
 * characters, followed by an ellipsis, and nothing else — the full value
 * (and even its length) never survives. An empty string masks to itself
 * (there is nothing to hide).
 *
 * Every caller in this module that returns or logs something derived from a
 * resolved credential must run it through this function first; nothing in
 * `fezoctl` renders a raw key.
 */
export function maskSecret(secret: string): string {
  if (secret.length === 0) return '';
  return `${secret.slice(0, MASK_VISIBLE_CHARS)}…`;
}

// ---------------------------------------------------------------------------
// Reading a secret from an injected stream (`setup --key-stdin`'s input side).
// ---------------------------------------------------------------------------

/**
 * Reads a secret from `stream` to completion and trims its trailing
 * newline(s). Takes a `Readable` rather than referencing `process.stdin`
 * directly so the real code path (not a monkey-patched global) is exercised
 * by tests, and so a later task can pass `process.stdin` for `--key-stdin`
 * without this module knowing anything about argv or the CLI.
 */
export async function readSecretFromStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return trimTrailingNewline(Buffer.concat(chunks).toString('utf8'));
}

// ---------------------------------------------------------------------------
// macOS Keychain access — injectable, so tests can assert the exact argv and
// stdin without a real `security` binary (which does not exist in CI).
// ---------------------------------------------------------------------------

export interface KeychainCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Executes one `security` subcommand. Kept as a thin, swappable interface
 * (rather than calling `child_process` directly from every function that
 * needs Keychain access) for two reasons: `security` is macOS-only and
 * unavailable in CI, and this is the seam that makes it possible to assert
 * *the exact argv and stdin* a write would use — the assertion that proves
 * the secret never reaches argv, which cannot be made against a hardcoded
 * subprocess call.
 */
export interface KeychainRunner {
  run(argv: readonly string[], stdin?: string): KeychainCommandResult;
}

/**
 * The real implementation, backed by `/usr/bin/security` via `spawnSync`.
 * Not used by any test in this repo (no `security` binary in CI) — it exists
 * so a later task has a working default to pass when actually running on
 * macOS, without reimplementing the subprocess plumbing.
 */
export const systemKeychainRunner: KeychainRunner = {
  run(argv, stdin) {
    const result = spawnSync('security', Array.from(argv), {
      input: stdin ?? '',
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  },
};

/** Fixed identifiers this module stores/looks up Keychain items under. */
export const KEYCHAIN_ACCOUNT = 'fezoctl';
export const KEYCHAIN_SERVICE_URL = 'fezoctl-url';
export const KEYCHAIN_SERVICE_API_KEY = 'fezoctl-api-key';

export interface KeychainWriteResult {
  ok: boolean;
  message?: string;
}

/**
 * Writes `secret` to Keychain via `runner`, piping it through stdin rather
 * than argv.
 *
 * The commonly documented form, `security add-generic-password -w "$KEY"`,
 * puts the secret in argv, where `ps` can read it from any local process.
 * `man security` documents the alternative this function uses instead: "`-w
 * password` Specify password to be added. Put at end of command to be
 * prompted (recommended)." Passing `-w` as the LAST argv element with no
 * following value makes `security` read the password from stdin instead of
 * argv (or prompt interactively on a real terminal) — exactly the property
 * this function needs. `-U` makes the write idempotent (update in place if
 * the item already exists) so re-running `setup` does not require a manual
 * delete first.
 *
 * The stdin payload gets a trailing newline appended: `security`'s
 * non-interactive stdin read expects a newline-terminated line, matching how
 * a human would type a password into the interactive prompt this form falls
 * back to.
 */
export function writeKeychainSecret(
  runner: KeychainRunner,
  service: string,
  account: string,
  secret: string,
): KeychainWriteResult {
  const argv = ['add-generic-password', '-a', account, '-s', service, '-U', '-w'];
  const result = runner.run(argv, `${secret}\n`);
  if (result.status === 0) return { ok: true };
  const message = result.stderr.trim();
  return message.length > 0 ? { ok: false, message } : { ok: false, message: `security exited with status ${String(result.status)}` };
}

export interface KeychainReadResult {
  ok: boolean;
  value?: string;
  message?: string;
}

/**
 * Reads a previously stored secret back from Keychain via `runner`.
 *
 * `find-generic-password -w` (per `man security`) prints ONLY the password
 * to stdout, with no other item metadata — unlike bare `-g`, which dumps the
 * whole item (label, account, creation date, ...) to stderr alongside it.
 * `-w` is therefore both the minimal and the safest form to parse: there is
 * nothing else in the output that a naive caller could accidentally log
 * alongside the secret.
 */
export function readKeychainSecret(runner: KeychainRunner, service: string, account: string): KeychainReadResult {
  const argv = ['find-generic-password', '-a', account, '-s', service, '-w'];
  const result = runner.run(argv);
  if (result.status === 0) {
    return { ok: true, value: trimTrailingNewline(result.stdout) };
  }
  const message = result.stderr.trim();
  return message.length > 0 ? { ok: false, message } : { ok: false, message: `security exited with status ${String(result.status)}` };
}

// ---------------------------------------------------------------------------
// `.env` file access.
// ---------------------------------------------------------------------------

/**
 * Where `.env` lives when a caller does not name a path explicitly:
 * `$XDG_CONFIG_HOME/fezoctl/.env`, falling back to `~/.config/fezoctl/.env`.
 * `fezoctl` is a globally installed CLI (see `package.json`'s `bin.fezoctl`),
 * not a per-project tool, so credentials belong in the user's config
 * directory rather than in whatever directory happens to be the current
 * working one — writing a live API key into an arbitrary project's `.env`
 * would risk it being picked up by that project's own tooling or committed
 * by accident.
 *
 * Every function that reads or writes `.env` in this module takes the path
 * as an explicit parameter and falls back to this function only when the
 * caller omits it — the path itself is never hardcoded inside a resolver.
 */
export function defaultDotEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(configHome, 'fezoctl', '.env');
}

/**
 * Parses `.env`-format text: `KEY=value` lines, blank lines ignored, `#`
 * comment lines ignored, and whitespace around both the key and the value
 * trimmed. Deliberately minimal — no quoting, no escaping, no multi-line
 * values — because `writeDotEnvFile` never emits any of those, and adding
 * parsing surface for a format `fezoctl` itself never writes is not worth it.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key.length === 0) continue;
    values[key] = line.slice(eq + 1).trim();
  }
  return values;
}

/**
 * Reads and parses `.env` at `path`. A missing file is the ordinary case (no
 * credentials stored there yet) and resolves to `{}` silently. Any OTHER
 * read failure (permissions, a directory in the way, ...) is not silently
 * swallowed the same way — it is announced on stderr, mirroring catalog.ts's
 * and bindings.ts's practice of never hiding a degradation without a trace —
 * and still resolves to `{}` so resolution can fall through to "no
 * credential found" rather than throwing.
 */
export function readDotEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (nodeErrorCode(err) !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      warn(`could not read ${path}: ${message}`);
    }
    return {};
  }
  return parseDotEnv(text);
}

export interface DotEnvWriteResult {
  ok: boolean;
  reason?: 'exists' | 'error';
  message?: string;
}

/**
 * Writes `values` to `.env` at `path` as `KEY=value` lines, one write, one
 * file.
 *
 * Mode `0600` is set AT OPEN TIME via `fs.openSync(path, 'wx', 0o600)`, not
 * chmod'ed onto the file afterward — a chmod-after-write would leave a
 * window, between the file's creation and the chmod call, during which it is
 * world-readable (whatever the process umask allows). `wx` additionally
 * refuses to clobber an existing file (`EEXIST`), which is deliberate: this
 * function has no way to know whether an existing `.env` holds credentials
 * the caller does not intend to overwrite, so it reports that back as an
 * ordinary (`reason: 'exists'`) outcome instead of guessing.
 */
export function writeDotEnvFile(path: string, values: Readonly<Record<string, string>>): DotEnvWriteResult {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if (nodeErrorCode(err) === 'EEXIST') {
      return { ok: false, reason: 'exists', message: `${path} already exists; refusing to overwrite it` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'error', message };
  }

  try {
    const contents = Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('');
    writeSync(fd, contents, null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

export type CredentialSource = 'env' | 'deprecated-env' | 'keychain' | 'dotenv';

export interface ResolvedValue {
  value: string;
  source: CredentialSource;
}

export interface CredentialResolution {
  url?: ResolvedValue;
  apiKey?: ResolvedValue;
}

export interface ResolveCredentialsOptions {
  env?: NodeJS.ProcessEnv;
  /** Defaults to `defaultDotEnvPath(env)`. */
  dotEnvPath?: string;
  /** Omit to skip the Keychain step entirely (non-macOS, or a caller that has none to inject). */
  keychain?: KeychainRunner;
  /**
   * Tracks which deprecated alias names have already been warned about, so
   * the warning fires exactly once — not once per lookup, which a naive
   * per-call implementation would do. Defaults to a module-level singleton
   * that persists for the process's lifetime, so a caller that never passes
   * this gets "exactly once per process" for free; tests pass their own
   * `new Set()` to isolate cases from one another.
   */
  warnedAliases?: Set<string>;
}

/** Shared for the lifetime of the process when a caller does not inject its own tracker. */
const PROCESS_ALIAS_WARNINGS = new Set<string>();

interface ResolveOneOptions {
  canonicalName: 'FEZO_URL' | 'FEZO_API_KEY';
  deprecatedName: 'ZUG_URL' | 'ZUG_API_KEY';
  keychainService: string;
  env: NodeJS.ProcessEnv;
  dotEnv: Record<string, string>;
  keychain: KeychainRunner | undefined;
  warnedAliases: Set<string>;
}

/**
 * Resolves one credential (URL or API key) through the four sources in
 * priority order, short-circuiting at the first one that has a non-empty
 * value: canonical env var, deprecated alias (env var empty/absent is
 * checked with `||`-style truthiness, matching catalog.ts's convention that
 * an empty string means "omitted", not "set to nothing"), Keychain, `.env`.
 *
 * Keychain is only consulted when `keychain` is supplied AND neither env
 * source had a value — this both matches the specified priority order and
 * avoids spawning `security` on every resolution when an env var already
 * answered the question.
 */
function resolveOne(options: ResolveOneOptions): ResolvedValue | undefined {
  const canonical = options.env[options.canonicalName];
  if (canonical !== undefined && canonical.length > 0) {
    return { value: canonical, source: 'env' };
  }

  const deprecated = options.env[options.deprecatedName];
  if (deprecated !== undefined && deprecated.length > 0) {
    if (!options.warnedAliases.has(options.deprecatedName)) {
      options.warnedAliases.add(options.deprecatedName);
      warn(`${options.deprecatedName} is deprecated; use ${options.canonicalName} instead`);
    }
    return { value: deprecated, source: 'deprecated-env' };
  }

  if (options.keychain) {
    const found = readKeychainSecret(options.keychain, options.keychainService, KEYCHAIN_ACCOUNT);
    if (found.ok && found.value !== undefined && found.value.length > 0) {
      return { value: found.value, source: 'keychain' };
    }
  }

  const fromDotEnv = options.dotEnv[options.canonicalName];
  if (fromDotEnv !== undefined && fromDotEnv.length > 0) {
    return { value: fromDotEnv, source: 'dotenv' };
  }

  return undefined;
}

/**
 * Resolves `FEZO_URL` and `FEZO_API_KEY` independently, each through the
 * same four-source chain, and reports where each came from (`doctor`, a
 * later task, renders this as the credential source).
 *
 * A missing credential is not an error here — it is an ordinary outcome,
 * reported by the corresponding field being absent from the result — so
 * callers can decide how to render "not configured" (a later task's job, not
 * this function's).
 */
export function resolveCredentials(options: ResolveCredentialsOptions = {}): CredentialResolution {
  const env = options.env ?? process.env;
  const dotEnvPath = options.dotEnvPath ?? defaultDotEnvPath(env);
  const warnedAliases = options.warnedAliases ?? PROCESS_ALIAS_WARNINGS;
  const dotEnv = readDotEnvFile(dotEnvPath);

  const url = resolveOne({
    canonicalName: 'FEZO_URL',
    deprecatedName: 'ZUG_URL',
    keychainService: KEYCHAIN_SERVICE_URL,
    env,
    dotEnv,
    keychain: options.keychain,
    warnedAliases,
  });
  const apiKey = resolveOne({
    canonicalName: 'FEZO_API_KEY',
    deprecatedName: 'ZUG_API_KEY',
    keychainService: KEYCHAIN_SERVICE_API_KEY,
    env,
    dotEnv,
    keychain: options.keychain,
    warnedAliases,
  });

  return {
    ...(url !== undefined ? { url } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}

// ---------------------------------------------------------------------------
// `setup`'s storage side. Reading the key is `readSecretFromStream` above;
// this is the write half — Task 8 wires `--key-stdin` and the URL/storage
// modal (both non-secret) to these functions.
// ---------------------------------------------------------------------------

export type StorageChoice = 'keychain' | 'dotenv';

export interface StoreCredentialsOptions {
  storage: StorageChoice;
  apiKey: string;
  /** Non-secret; optional because a caller may be re-running `setup` to rotate only the key. */
  url?: string;
  /** Used only when `storage === 'dotenv'`. Defaults to `defaultDotEnvPath()`. */
  dotEnvPath?: string;
  /** Used only when `storage === 'keychain'`. Required in that case (see `StoreCredentialsResult`). */
  keychain?: KeychainRunner;
}

export interface FieldStoreOutcome {
  ok: boolean;
  reason?: string;
  message?: string;
}

export interface StoreCredentialsResult {
  storage: StorageChoice;
  apiKey: FieldStoreOutcome;
  url?: FieldStoreOutcome;
}

/**
 * Stores `apiKey` (and, if supplied, `url`) using `storage`. Never accepts
 * either value except as an in-memory string parameter: the API key is
 * expected to have already been read via `readSecretFromStream`, and the URL
 * is non-secret input a modal may safely have collected (see this module's
 * header comment).
 *
 * `dotenv` storage writes both values in ONE `writeDotEnvFile` call so the
 * `wx`-refuses-to-clobber behavior applies to the whole credential set
 * atomically, not per field — writing the API key first and the URL second
 * would make the second call fail with `EEXIST` against the file the first
 * call just created.
 *
 * `keychain` storage stores the URL as its own Keychain item alongside the
 * API key, through the same stdin-piping `writeKeychainSecret` path, even
 * though the URL is not a secret — this keeps one storage choice meaning one
 * place both values live, and there is no cost to using the safer write path
 * for a non-secret too. If the caller picks `keychain` storage without
 * supplying a `KeychainRunner`, that is reported as an ordinary failed
 * outcome (a caller/config mistake, not a fault worth throwing over).
 */
export function storeCredentials(options: StoreCredentialsOptions): StoreCredentialsResult {
  if (options.storage === 'dotenv') {
    const dotEnvPath = options.dotEnvPath ?? defaultDotEnvPath();
    const values: Record<string, string> = { FEZO_API_KEY: options.apiKey };
    if (options.url !== undefined) values.FEZO_URL = options.url;

    const written = writeDotEnvFile(dotEnvPath, values);
    const apiKeyOutcome: FieldStoreOutcome = written.ok
      ? { ok: true }
      : { ok: false, ...(written.reason !== undefined ? { reason: written.reason } : {}), ...(written.message !== undefined ? { message: written.message } : {}) };

    return {
      storage: 'dotenv',
      apiKey: apiKeyOutcome,
      ...(options.url !== undefined ? { url: apiKeyOutcome } : {}),
    };
  }

  // storage === 'keychain'
  if (!options.keychain) {
    const outcome: FieldStoreOutcome = { ok: false, reason: 'no-keychain-runner', message: 'keychain storage requires a KeychainRunner' };
    return {
      storage: 'keychain',
      apiKey: outcome,
      ...(options.url !== undefined ? { url: outcome } : {}),
    };
  }

  const apiKeyWrite = writeKeychainSecret(options.keychain, KEYCHAIN_SERVICE_API_KEY, KEYCHAIN_ACCOUNT, options.apiKey);
  const apiKeyOutcome: FieldStoreOutcome = apiKeyWrite.ok
    ? { ok: true }
    : { ok: false, ...(apiKeyWrite.message !== undefined ? { message: apiKeyWrite.message } : {}) };

  if (options.url === undefined) {
    return { storage: 'keychain', apiKey: apiKeyOutcome };
  }

  const urlWrite = writeKeychainSecret(options.keychain, KEYCHAIN_SERVICE_URL, KEYCHAIN_ACCOUNT, options.url);
  const urlOutcome: FieldStoreOutcome = urlWrite.ok
    ? { ok: true }
    : { ok: false, ...(urlWrite.message !== undefined ? { message: urlWrite.message } : {}) };

  return { storage: 'keychain', apiKey: apiKeyOutcome, url: urlOutcome };
}
