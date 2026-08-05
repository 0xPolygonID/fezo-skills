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
//      existing file (see `writeDotEnvFile`). Its parent directory is created
//      `0700` for the same reason: a world-readable directory advertises the
//      file's existence even when the file itself is unreadable.
//   4. Exactly ONE field in this module's output carries a raw secret:
//      `ResolvedValue.value`, which exists because client.ts and catalog.ts
//      need the real key to call the gateway. Every `ResolvedValue` also
//      carries `masked` (via `maskSecret`), which is what any renderer
//      (`doctor`, `--json`) must print; `storeCredentials`'s result carries no
//      secret at all. This module never constructs or logs an `Authorization`
//      header — it has no reason to; that header is client.ts's job.
//
// Resolution order (identical for both `FEZO_URL`/`FEZO_API_KEY`): canonical
// env var, then macOS Keychain, then `.env`. There is exactly one accepted
// name per credential — no aliases — so "which variable is actually in
// effect" has a single answer at every call site.

import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
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

/**
 * The ONE normalization applied to a credential value on its way in and on the
 * way back out again: surrounding whitespace removed, interior untouched.
 *
 * This exists because three places in this module used to disagree about it,
 * and the disagreement produced a false failure plus a wedged config file.
 * `readSecretFromStream` trimmed only trailing NEWLINES, `writeDotEnvFile`
 * wrote the value verbatim, and `parseDotEnv` trimmed everything — so a key
 * pasted with a trailing space (` sk-live-abcdef `, trivially easy from a
 * clipboard) was stored correctly but read back as a DIFFERENT string, which
 * `cmdSetup`'s post-write verification reported as
 * "the value could not be read back and verified after storing it" while
 * `doctor` happily resolved the very same key. `.env`'s `wx` no-clobber flag
 * then blocked the retry the message invited.
 *
 * Surrounding whitespace is never part of an API key or a URL, and `.env`
 * cannot represent it anyway (`parseDotEnv` trims on read), so normalizing it
 * away at every boundary is both safe and the only way the read-back
 * comparison can be meaningful.
 */
export function normalizeCredentialValue(value: string): string {
  return value.trim();
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
 * Reads a secret from `stream` to completion and normalizes it with
 * `normalizeCredentialValue` (surrounding whitespace removed — see that
 * function for why trailing-newline-only trimming was not enough). Takes a
 * `Readable` rather than referencing `process.stdin` directly so the real code
 * path (not a monkey-patched global) is exercised by tests, and so a later task
 * can pass `process.stdin` for `--key-stdin` without this module knowing
 * anything about argv or the CLI.
 */
export async function readSecretFromStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return normalizeCredentialValue(Buffer.concat(chunks).toString('utf8'));
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

/** The macOS `security` binary, spelled absolutely — see `systemKeychainRunner`. */
const SECURITY_BINARY = '/usr/bin/security';

/**
 * The real implementation, backed by `/usr/bin/security` via `spawnSync`.
 * Not used by any test in this repo (no `security` binary in CI) — it exists
 * so a later task has a working default to pass when actually running on
 * macOS, without reimplementing the subprocess plumbing.
 *
 * The binary is named by ABSOLUTE PATH, not as bare `security` resolved
 * through `PATH`: this runner pipes a live API key to that process's stdin,
 * so an attacker-controlled or merely accidental `security` earlier on `PATH`
 * would be handed the secret. `/usr/bin/security` is a fixed part of macOS,
 * so there is no portability cost to pinning it.
 */
export const systemKeychainRunner: KeychainRunner = {
  run(argv, stdin) {
    const result = spawnSync(SECURITY_BINARY, Array.from(argv), {
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

/**
 * Fixed identifiers this module stores/looks up Keychain items under.
 *
 * `fezo`-prefixed to match the rest of the product's naming (`~/.config/fezo/`,
 * `FEZO_URL`, `FEZO_API_KEY`) rather than the binary name. These three strings
 * are effectively a storage format: changing them after a release would leave
 * every already-stored secret orphaned in users' Keychains under the old names,
 * with `fezoctl` reporting "no credential found" and no migration path — so
 * they are pinned by a test and must not be renamed.
 */
export const KEYCHAIN_ACCOUNT = 'fezo';
export const KEYCHAIN_SERVICE_URL = 'fezo-url';
export const KEYCHAIN_SERVICE_API_KEY = 'fezo-api-key';

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
 * The stdin payload carries the secret TWICE, each newline-terminated. This is
 * not redundancy and must not be "simplified" to one copy: the prompting form
 * of `security add-generic-password ... -w` prompts twice — "password data for
 * new item:" and then "retype password for new item:" — so a single-line stdin
 * satisfies only the first prompt. The confirmation read then hits EOF,
 * `security` prints "passwords don't match", re-prompts, reads EOF again, and
 * CREATES THE ITEM WITH AN EMPTY PASSWORD WHILE EXITING 0. Verified against
 * the real `/usr/bin/security` on macOS 15:
 *
 *   printf 'S\n'    | security add-generic-password -a A -s S -U -w  -> exit 0, stored value EMPTY
 *   printf 'S\nS\n' | security add-generic-password -a A -s S -U -w  -> exit 0, stored value correct
 *
 * Because the failure exits 0, no status check can catch it; the exit status is
 * not evidence that anything was stored. `cmdSetup` additionally reads the
 * value back and compares (defence in depth), and tests assert the exact stdin
 * this function sends — see tests/credentials.test.ts.
 */
export function writeKeychainSecret(
  runner: KeychainRunner,
  service: string,
  account: string,
  secret: string,
): KeychainWriteResult {
  const argv = ['add-generic-password', '-a', account, '-s', service, '-U', '-w'];
  const result = runner.run(argv, `${secret}\n${secret}\n`);
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
 * `$XDG_CONFIG_HOME/fezo/.env`, falling back to `~/.config/fezo/.env` — the
 * config directory the design spec mandates (§3's "Config directory
 * `~/.config/fezo/`" and the naming-migration clause: config `~/.config/fezo/`,
 * binary `fezoctl`; the directory follows the product name, not the binary's).
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
 *
 * `XDG_CONFIG_HOME` is honoured only when it is ABSOLUTE. A relative value is
 * resolved by the OS against the current working directory, which is exactly
 * the outcome the paragraph above says this function prevents: with
 * `XDG_CONFIG_HOME=.config`, `setup` wrote a live API key to
 * `<cwd>/.config/fezo/.env` — inside whatever project happened to be the
 * working directory, 0600 but committable. The XDG base-directory spec itself
 * requires these variables to hold absolute paths and says a relative value
 * "must be ignored", so falling back to the `homedir()` path is both the safe
 * and the specified behavior. It is announced on stderr rather than applied
 * silently, so a user whose override is being ignored can see why.
 */
export function defaultDotEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.XDG_CONFIG_HOME;
  const fallback = join(homedir(), '.config');
  let configHome = fallback;
  if (override !== undefined && override.length > 0) {
    if (isAbsolute(override)) {
      configHome = override;
    } else {
      warn(`ignoring XDG_CONFIG_HOME="${override}": it is not an absolute path; using ${fallback} instead`);
    }
  }
  return join(configHome, 'fezo', '.env');
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
 *
 * The parent directory is created first (`recursive`, mode `0700`) because on a
 * first run it does not exist yet — without this, the primary documented setup
 * path fails with a raw `ENOENT` the first time anyone uses it. `0700` rather
 * than the default `0777`-minus-umask is deliberate: a world-readable config
 * directory advertises that a credential file exists (and its size and mtime)
 * even though the file itself is `0600`. Mode `0700` is also umask-proof — a
 * umask can only clear bits, and there are no group/other bits here to clear.
 *
 * Never throws: every failure — including one that strikes mid-write, after
 * `openSync` has already created the file — comes back as a structured result.
 * A mid-write failure additionally REMOVES the partial file, because leaving it
 * behind would make every subsequent attempt fail with `reason: 'exists'`
 * against a truncated `.env`: a permanent wedge only a manual `rm` could clear.
 */
export function writeDotEnvFile(path: string, values: Readonly<Record<string, string>>): DotEnvWriteResult {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (err) {
    // Not folded into the `openSync` catch below: `mkdirSync` reports an
    // existing *file* in the directory's place as `EEXIST` too, which that
    // catch would mistranslate into the "refusing to overwrite" outcome.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'error', message };
  }

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

  // `failure` is a box rather than the raw `unknown` so that "no failure" is
  // distinguishable from a falsy thrown value, and so the first failure wins:
  // `closeSync` can itself fail (a buffered ENOSPC surfaces there), but the
  // write's own error is the more informative one to report.
  let failure: { readonly err: unknown } | undefined;
  try {
    const contents = Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('');
    writeSync(fd, contents, null, 'utf8');
  } catch (err) {
    failure = { err };
  }
  try {
    closeSync(fd);
  } catch (err) {
    failure ??= { err };
  }

  if (failure !== undefined) {
    try {
      unlinkSync(path);
    } catch {
      // Deliberately swallowed: the write error is what the caller needs to
      // see, and masking it with a cleanup error would hide the real cause.
      // The worst case is the pre-existing behavior (a stale empty `.env`).
    }
    const message = failure.err instanceof Error ? failure.err.message : String(failure.err);
    return { ok: false, reason: 'error', message };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

export type CredentialSource = 'env' | 'keychain' | 'dotenv';

export interface ResolvedValue {
  /**
   * The raw value. For the API key this is the live secret: it is here because
   * client.ts and catalog.ts need it to call the gateway, and it is the ONLY
   * field in this module's output that carries one. Anything that renders a
   * credential to a human, a log line, or `--json` must use `masked` instead.
   */
  value: string;
  /**
   * `maskSecret(value)` — a short prefix and an ellipsis, never the full value
   * or even its length. Precomputed rather than left to each caller so that
   * the safe field is the obvious one to reach for: a renderer that
   * `JSON.stringify`s a `ResolvedValue` wholesale is a leak, and a renderer
   * that has to call a function to get a printable form is a renderer that
   * will eventually forget to.
   */
  masked: string;
  source: CredentialSource;
}

export interface CredentialResolution {
  url?: ResolvedValue;
  apiKey?: ResolvedValue;
}

// ---------------------------------------------------------------------------
// Safe presentation of a `CredentialResolution` — the ONE object shape any
// renderer (Task 8's `doctor`, and every `--json` path that touches
// credentials) is allowed to print.
//
// This exists because `ResolvedValue` deliberately carries the raw secret in
// `value` (client.ts and catalog.ts need it), so "which field do I print" is a
// per-call-site judgement call every renderer would otherwise have to get
// right on its own -- and a URL row and an API key row look identical to
// copy-paste from, which is exactly how a renderer prints `apiKey.value`
// instead of `apiKey.masked`. `credentialDisplay` removes the judgement call:
// it is the only field selection a caller can reach for, `url` keeps its
// (non-secret) `value`, and `apiKey` exposes `masked` only -- there is no
// field on this type a renderer could print to leak the key.
// ---------------------------------------------------------------------------

export interface CredentialDisplay {
  url?: { value: string; source: CredentialSource };
  apiKey?: { masked: string; source: CredentialSource };
}

/**
 * Renders a `CredentialResolution` for display: the URL's real value (it is
 * not a secret) and the API key's `masked` form only. `doctor` and every
 * `--json` path that shows credential state must render this, and nothing
 * else derived from the underlying `ResolvedValue`s.
 */
export function credentialDisplay(resolution: CredentialResolution): CredentialDisplay {
  return {
    ...(resolution.url !== undefined
      ? { url: { value: resolution.url.value, source: resolution.url.source } }
      : {}),
    ...(resolution.apiKey !== undefined
      ? { apiKey: { masked: resolution.apiKey.masked, source: resolution.apiKey.source } }
      : {}),
  };
}

export interface ResolveCredentialsOptions {
  env?: NodeJS.ProcessEnv;
  /** Defaults to `defaultDotEnvPath(env)`. */
  dotEnvPath?: string;
  /** Omit to skip the Keychain step entirely (non-macOS, or a caller that has none to inject). */
  keychain?: KeychainRunner;
}

/** The one place a `ResolvedValue` is built, so `masked` can never be forgotten at a call site. */
function resolved(value: string, source: CredentialSource): ResolvedValue {
  return { value, masked: maskSecret(value), source };
}

interface ResolveOneOptions {
  canonicalName: 'FEZO_URL' | 'FEZO_API_KEY';
  keychainService: string;
  env: NodeJS.ProcessEnv;
  dotEnv: Record<string, string>;
  keychain: KeychainRunner | undefined;
}

/**
 * Resolves one credential (URL or API key) through the three sources in
 * priority order, short-circuiting at the first one that has a non-empty
 * value: canonical env var (empty/absent is checked with `||`-style
 * truthiness, matching catalog.ts's convention that an empty string means
 * "omitted", not "set to nothing"), Keychain, `.env`.
 *
 * Keychain is only consulted when `keychain` is supplied AND the env var had
 * no value — this both matches the specified priority order and avoids
 * spawning `security` on every resolution when the environment already
 * answered the question.
 */
function resolveOne(options: ResolveOneOptions): ResolvedValue | undefined {
  const canonical = options.env[options.canonicalName];
  if (canonical !== undefined && canonical.length > 0) {
    return resolved(canonical, 'env');
  }

  if (options.keychain) {
    const found = readKeychainSecret(options.keychain, options.keychainService, KEYCHAIN_ACCOUNT);
    if (found.ok && found.value !== undefined && found.value.length > 0) {
      return resolved(found.value, 'keychain');
    }
  }

  const fromDotEnv = options.dotEnv[options.canonicalName];
  if (fromDotEnv !== undefined && fromDotEnv.length > 0) {
    return resolved(fromDotEnv, 'dotenv');
  }

  return undefined;
}

/**
 * Resolves `FEZO_URL` and `FEZO_API_KEY` independently, each through the
 * same three-source chain, and reports where each came from (`doctor`, a
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
  const dotEnv = readDotEnvFile(dotEnvPath);

  const url = resolveOne({
    canonicalName: 'FEZO_URL',
    keychainService: KEYCHAIN_SERVICE_URL,
    env,
    dotEnv,
    keychain: options.keychain,
  });
  const apiKey = resolveOne({
    canonicalName: 'FEZO_API_KEY',
    keychainService: KEYCHAIN_SERVICE_API_KEY,
    env,
    dotEnv,
    keychain: options.keychain,
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
 *
 * An empty or whitespace-only `apiKey` is rejected BEFORE any write. That is
 * not defensive boilerplate: `readSecretFromStream` returns `''` when the user
 * hits Ctrl-D without pasting anything, and without this check `setup` would
 * happily write `FEZO_API_KEY=` (or an empty Keychain item) and report success,
 * while `resolveOne` — which treats an empty value as "not set" — would then
 * report no credential at all. The two halves of this module have to agree on
 * what counts as a credential.
 */
export function storeCredentials(options: StoreCredentialsOptions): StoreCredentialsResult {
  // Normalized once, here, so every storage backend below persists the SAME
  // bytes a later read-back produces — `.env` is written verbatim and parsed
  // with trimming, so an untrimmed write cannot round-trip. See
  // `normalizeCredentialValue`.
  const apiKey = normalizeCredentialValue(options.apiKey);
  const url = options.url !== undefined ? normalizeCredentialValue(options.url) : undefined;

  if (apiKey.length === 0) {
    const outcome: FieldStoreOutcome = {
      ok: false,
      reason: 'empty-api-key',
      message: 'no API key was provided; nothing was stored',
    };
    return {
      storage: options.storage,
      apiKey: outcome,
      ...(url !== undefined ? { url: outcome } : {}),
    };
  }

  if (options.storage === 'dotenv') {
    const dotEnvPath = options.dotEnvPath ?? defaultDotEnvPath();
    const values: Record<string, string> = { FEZO_API_KEY: apiKey };
    if (url !== undefined) values.FEZO_URL = url;

    const written = writeDotEnvFile(dotEnvPath, values);
    const apiKeyOutcome: FieldStoreOutcome = written.ok
      ? { ok: true }
      : { ok: false, ...(written.reason !== undefined ? { reason: written.reason } : {}), ...(written.message !== undefined ? { message: written.message } : {}) };

    return {
      storage: 'dotenv',
      apiKey: apiKeyOutcome,
      ...(url !== undefined ? { url: apiKeyOutcome } : {}),
    };
  }

  // storage === 'keychain'
  if (!options.keychain) {
    const outcome: FieldStoreOutcome = { ok: false, reason: 'no-keychain-runner', message: 'keychain storage requires a KeychainRunner' };
    return {
      storage: 'keychain',
      apiKey: outcome,
      ...(url !== undefined ? { url: outcome } : {}),
    };
  }

  const apiKeyWrite = writeKeychainSecret(options.keychain, KEYCHAIN_SERVICE_API_KEY, KEYCHAIN_ACCOUNT, apiKey);
  const apiKeyOutcome: FieldStoreOutcome = apiKeyWrite.ok
    ? { ok: true }
    : { ok: false, ...(apiKeyWrite.message !== undefined ? { message: apiKeyWrite.message } : {}) };

  if (url === undefined) {
    return { storage: 'keychain', apiKey: apiKeyOutcome };
  }

  const urlWrite = writeKeychainSecret(options.keychain, KEYCHAIN_SERVICE_URL, KEYCHAIN_ACCOUNT, url);
  const urlOutcome: FieldStoreOutcome = urlWrite.ok
    ? { ok: true }
    : { ok: false, ...(urlWrite.message !== undefined ? { message: urlWrite.message } : {}) };

  return { storage: 'keychain', apiKey: apiKeyOutcome, url: urlOutcome };
}
