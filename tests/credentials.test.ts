import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';

import {
  defaultDotEnvPath,
  maskSecret,
  parseDotEnv,
  readDotEnvFile,
  readKeychainSecret,
  readSecretFromStream,
  resolveCredentials,
  storeCredentials,
  writeDotEnvFile,
  writeKeychainSecret,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE_API_KEY,
  KEYCHAIN_SERVICE_URL,
} from '../src/engine/credentials.js';
import type { KeychainCommandResult, KeychainRunner } from '../src/engine/credentials.js';

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

/**
 * Runs `fn` with process.stderr.write mocked out and returns everything it
 * wrote, joined. Writes are collected into a local array rather than read off
 * the spy afterwards: vitest's `mockRestore` also resets the spy's call
 * history, so any assertion made on the spy after restoring would read an
 * empty history and pass vacuously. (Duplicated from tests/binding.test.ts;
 * that helper is not exported.)
 */
function captureStderr(fn: () => void): string {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return writes.join('');
}

/** Same as captureStderr, but for a function that returns a value. */
function captureStderrWithResult<T>(fn: () => T): { stderr: string; result: T } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  let result: T;
  try {
    result = fn();
  } finally {
    spy.mockRestore();
  }
  return { stderr: writes.join(''), result };
}

/** A KeychainRunner that records every call it receives and answers from a fixed script. */
function recordingKeychainRunner(answer: KeychainCommandResult): {
  runner: KeychainRunner;
  calls: { argv: readonly string[]; stdin: string | undefined }[];
} {
  const calls: { argv: readonly string[]; stdin: string | undefined }[] = [];
  const runner: KeychainRunner = {
    run(argv, stdin) {
      calls.push({ argv, stdin });
      return answer;
    },
  };
  return { runner, calls };
}

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'fezoctl-credentials-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OK: KeychainCommandResult = { status: 0, stdout: '', stderr: '' };
const NOT_FOUND: KeychainCommandResult = { status: 44, stdout: '', stderr: 'security: could not be found' };

// ---------------------------------------------------------------------------
// Resolution precedence.
// ---------------------------------------------------------------------------

describe('resolveCredentials — precedence', () => {
  it('canonical env var wins when every other source also has a value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-credentials-'));
    try {
      const dotEnvPath = join(dir, '.env');
      writeDotEnvFile(dotEnvPath, { FEZO_API_KEY: 'sk-from-dotenv', FEZO_URL: 'https://dotenv.example.com' });
      const { runner } = recordingKeychainRunner({ status: 0, stdout: 'sk-from-keychain\n', stderr: '' });

      const resolution = resolveCredentials({
        env: { FEZO_API_KEY: 'sk-from-canonical-env', ZUG_API_KEY: 'sk-from-alias' },
        dotEnvPath,
        keychain: runner,
        warnedAliases: new Set(),
      });

      expect(resolution.apiKey).toEqual({ value: 'sk-from-canonical-env', masked: 'sk-f…', source: 'env' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deprecated alias is used when the canonical var is absent, and its source is reported', () => {
    const stderr = captureStderr(() => {
      const resolution = resolveCredentials({
        env: { ZUG_URL: 'https://alias.example.com' },
        dotEnvPath: '/nonexistent/.env',
        warnedAliases: new Set(),
      });
      expect(resolution.url).toEqual({ value: 'https://alias.example.com', masked: 'http…', source: 'deprecated-env' });
    });
    expect(stderr).toContain('ZUG_URL');
    expect(stderr).toContain('FEZO_URL');
  });

  it('Keychain is used when neither the canonical nor the deprecated env var is set', () => {
    const { runner, calls } = recordingKeychainRunner({ status: 0, stdout: 'sk-from-keychain\n', stderr: '' });
    const resolution = resolveCredentials({
      env: {},
      dotEnvPath: '/nonexistent/.env',
      keychain: runner,
      warnedAliases: new Set(),
    });
    expect(resolution.apiKey).toEqual({ value: 'sk-from-keychain', masked: 'sk-f…', source: 'keychain' });
    expect(calls.length).toBeGreaterThan(0);
  });

  it('.env is used only when env vars and Keychain all miss', () => {
    withTmpDir((dir) => {
      const dotEnvPath = join(dir, '.env');
      writeDotEnvFile(dotEnvPath, { FEZO_API_KEY: 'sk-from-dotenv' });
      const { runner } = recordingKeychainRunner(NOT_FOUND);

      const resolution = resolveCredentials({
        env: {},
        dotEnvPath,
        keychain: runner,
        warnedAliases: new Set(),
      });
      expect(resolution.apiKey).toEqual({ value: 'sk-from-dotenv', masked: 'sk-f…', source: 'dotenv' });
    });
  });

  it('resolves url and apiKey independently from different sources at once', () => {
    withTmpDir((dir) => {
      const dotEnvPath = join(dir, '.env');
      writeDotEnvFile(dotEnvPath, { FEZO_URL: 'https://dotenv.example.com' });

      const resolution = resolveCredentials({
        env: { FEZO_API_KEY: 'sk-from-env' },
        dotEnvPath,
        warnedAliases: new Set(),
      });
      expect(resolution.apiKey).toEqual({ value: 'sk-from-env', masked: 'sk-f…', source: 'env' });
      expect(resolution.url).toEqual({ value: 'https://dotenv.example.com', masked: 'http…', source: 'dotenv' });
    });
  });

  it('a value absent from every source is omitted from the result entirely, not present-but-undefined', () => {
    const resolution = resolveCredentials({
      env: {},
      dotEnvPath: '/nonexistent/.env',
      warnedAliases: new Set(),
    });
    expect(Object.hasOwn(resolution, 'apiKey')).toBe(false);
    expect(Object.hasOwn(resolution, 'url')).toBe(false);
  });

  it('an empty-string env var is treated as absent, not as an empty credential', () => {
    withTmpDir((dir) => {
      const dotEnvPath = join(dir, '.env');
      writeDotEnvFile(dotEnvPath, { FEZO_API_KEY: 'sk-from-dotenv' });
      const resolution = resolveCredentials({
        env: { FEZO_API_KEY: '' },
        dotEnvPath,
        warnedAliases: new Set(),
      });
      expect(resolution.apiKey).toEqual({ value: 'sk-from-dotenv', masked: 'sk-f…', source: 'dotenv' });
    });
  });
});

// ---------------------------------------------------------------------------
// Deprecated-alias warning: exactly once per process.
// ---------------------------------------------------------------------------

describe('resolveCredentials — deprecated alias warning', () => {
  it('warns exactly once across multiple resolutions sharing one tracker, and names the canonical replacement', () => {
    const warnedAliases = new Set<string>();
    const env = { ZUG_API_KEY: 'sk-alias-secret' };

    const stderr = captureStderr(() => {
      resolveCredentials({ env, dotEnvPath: '/nonexistent/.env', warnedAliases });
      resolveCredentials({ env, dotEnvPath: '/nonexistent/.env', warnedAliases });
      resolveCredentials({ env, dotEnvPath: '/nonexistent/.env', warnedAliases });
    });

    const occurrences = stderr.split('ZUG_API_KEY').length - 1;
    expect(occurrences).toBe(1);
    expect(stderr).toContain('FEZO_API_KEY');
  });

  it('warns once for each distinct deprecated alias, independently', () => {
    const warnedAliases = new Set<string>();
    const env = { ZUG_URL: 'https://alias.example.com', ZUG_API_KEY: 'sk-alias-secret' };

    const stderr = captureStderr(() => {
      resolveCredentials({ env, dotEnvPath: '/nonexistent/.env', warnedAliases });
      resolveCredentials({ env, dotEnvPath: '/nonexistent/.env', warnedAliases });
    });

    expect(stderr.split('ZUG_URL').length - 1).toBe(1);
    expect(stderr.split('ZUG_API_KEY').length - 1).toBe(1);
  });

  it('a fresh tracker warns again, independent of a previous one', () => {
    const env = { ZUG_API_KEY: 'sk-alias-secret' };
    const first = captureStderr(() => {
      resolveCredentials({ env, dotEnvPath: '/nonexistent/.env', warnedAliases: new Set() });
    });
    const second = captureStderr(() => {
      resolveCredentials({ env, dotEnvPath: '/nonexistent/.env', warnedAliases: new Set() });
    });
    expect(first).toContain('ZUG_API_KEY');
    expect(second).toContain('ZUG_API_KEY');
  });

  it('the default (no explicit tracker) warns exactly once for the lifetime of the process', async () => {
    // Uses a fresh module instance (vi.resetModules + dynamic import) so this
    // test's use of the real process-lifetime singleton cannot poison any
    // other test in this file -- every other test injects its own Set.
    vi.resetModules();
    const mod = await import('../src/engine/credentials.js');
    const env = { ZUG_API_KEY: 'sk-alias-secret' };

    const stderr = captureStderr(() => {
      mod.resolveCredentials({ env, dotEnvPath: '/nonexistent/.env' });
      mod.resolveCredentials({ env, dotEnvPath: '/nonexistent/.env' });
      mod.resolveCredentials({ env, dotEnvPath: '/nonexistent/.env' });
    });

    expect(stderr.split('ZUG_API_KEY').length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Storage locations and identifiers. These are pinned by name because they are
// effectively a storage format: the config directory is mandated by the design
// spec (`~/.config/fezo/`), and the Keychain account/service names cannot be
// changed after a release without orphaning every already-stored secret.
// ---------------------------------------------------------------------------

describe('defaultDotEnvPath', () => {
  it('honours XDG_CONFIG_HOME and puts .env under a "fezo" directory', () => {
    const path = defaultDotEnvPath({ XDG_CONFIG_HOME: '/xdg-config' });
    expect(path).toBe(join('/xdg-config', 'fezo', '.env'));
    expect(path.split(sep)).toContain('fezo');
  });

  it('falls back to ~/.config/fezo/.env when XDG_CONFIG_HOME is unset', () => {
    const path = defaultDotEnvPath({});
    expect(path).toBe(join(homedir(), '.config', 'fezo', '.env'));
  });

  it('treats an empty XDG_CONFIG_HOME as unset', () => {
    expect(defaultDotEnvPath({ XDG_CONFIG_HOME: '' })).toBe(join(homedir(), '.config', 'fezo', '.env'));
  });

  it('names the config directory after the product, never after the binary', () => {
    // The design spec says `~/.config/fezo/`; the binary happens to be called
    // something else, and this asserts the directory does not drift to it.
    const segments = defaultDotEnvPath({ XDG_CONFIG_HOME: '/xdg-config' }).split(sep);
    expect(segments).toContain('fezo');
    expect(segments).not.toContain('fezoctl');
  });
});

describe('Keychain identifiers', () => {
  it('are pinned: renaming them would orphan secrets already in users Keychains', () => {
    expect(KEYCHAIN_ACCOUNT).toBe('fezo');
    expect(KEYCHAIN_SERVICE_URL).toBe('fezo-url');
    expect(KEYCHAIN_SERVICE_API_KEY).toBe('fezo-api-key');
  });
});

// ---------------------------------------------------------------------------
// .env file creation: mode 0600 at open time, refuses to clobber.
// ---------------------------------------------------------------------------

describe('writeDotEnvFile', () => {
  it('creates the file with mode 0600', () => {
    withTmpDir((dir) => {
      const path = join(dir, '.env');
      const result = writeDotEnvFile(path, { FEZO_API_KEY: 'sk-test-value' });
      expect(result.ok).toBe(true);
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  it('writes readable KEY=value content', () => {
    withTmpDir((dir) => {
      const path = join(dir, '.env');
      writeDotEnvFile(path, { FEZO_API_KEY: 'sk-test-value', FEZO_URL: 'https://gw.example.com' });
      const contents = readFileSync(path, 'utf8');
      expect(contents).toContain('FEZO_API_KEY=sk-test-value');
      expect(contents).toContain('FEZO_URL=https://gw.example.com');
    });
  });

  it('creates a missing parent directory chain, with mode 0700 on every directory it makes', () => {
    withTmpDir((dir) => {
      // The first-run shape: nothing below the temp dir exists yet, exactly
      // like `~/.config/fezo/` on a machine that has never run setup.
      const configDir = join(dir, 'config');
      const productDir = join(configDir, 'fezo');
      const path = join(productDir, '.env');
      expect(existsSync(configDir)).toBe(false);

      const result = writeDotEnvFile(path, { FEZO_API_KEY: 'sk-first-run' });

      expect(result).toEqual({ ok: true });
      expect(readFileSync(path, 'utf8')).toContain('FEZO_API_KEY=sk-first-run');
      // 0700, not just "not world-writable": a readable directory advertises
      // that a credential file exists even though the file itself is 0600.
      expect(statSync(configDir).mode & 0o777).toBe(0o700);
      expect(statSync(productDir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  it('an existing parent directory is left alone (no mode changes, no failure)', () => {
    withTmpDir((dir) => {
      const before = statSync(dir).mode & 0o777;
      const result = writeDotEnvFile(join(dir, '.env'), { FEZO_API_KEY: 'sk-existing-parent' });
      expect(result).toEqual({ ok: true });
      expect(statSync(dir).mode & 0o777).toBe(before);
    });
  });

  it('a failure mid-write reports reason "error" and removes the partial file so a retry can succeed', () => {
    withTmpDir((dir) => {
      const path = join(dir, '.env');

      // A real, unmocked failure raised while the contents are being built --
      // after `openSync` has already created the file, which is precisely the
      // window that used to wedge: the throw escaped the function, and every
      // later attempt then hit `wx`'s EEXIST against the empty file left behind.
      const hostile: Record<string, string> = {};
      Object.defineProperty(hostile, 'FEZO_API_KEY', {
        enumerable: true,
        get(): string {
          throw new Error('simulated write-path failure');
        },
      });

      const failed = writeDotEnvFile(path, hostile);
      expect(failed.ok).toBe(false);
      expect(failed.reason).toBe('error');
      expect(failed.message).toContain('simulated write-path failure');

      // The wedge is gone: no leftover file, so the retry is not an 'exists'.
      expect(existsSync(path)).toBe(false);
      const retried = writeDotEnvFile(path, { FEZO_API_KEY: 'sk-after-retry' });
      expect(retried).toEqual({ ok: true });
      expect(readFileSync(path, 'utf8')).toContain('FEZO_API_KEY=sk-after-retry');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  it('reports reason "error", not "exists", when a file sits where the parent directory should be', () => {
    withTmpDir((dir) => {
      const inTheWay = join(dir, 'not-a-directory');
      expect(writeDotEnvFile(inTheWay, { FEZO_API_KEY: 'sk-blocker' })).toEqual({ ok: true });

      const result = writeDotEnvFile(join(inTheWay, '.env'), { FEZO_API_KEY: 'sk-blocked' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('error');
    });
  });

  it('refuses to clobber an existing file and reports reason "exists"', () => {
    withTmpDir((dir) => {
      const path = join(dir, '.env');
      const first = writeDotEnvFile(path, { FEZO_API_KEY: 'sk-first' });
      expect(first.ok).toBe(true);

      const second = writeDotEnvFile(path, { FEZO_API_KEY: 'sk-second' });
      expect(second.ok).toBe(false);
      expect(second.reason).toBe('exists');

      // The original content must be untouched.
      const contents = readFileSync(path, 'utf8');
      expect(contents).toContain('sk-first');
      expect(contents).not.toContain('sk-second');
    });
  });
});

// ---------------------------------------------------------------------------
// Keychain write: secret via stdin, never in argv.
// ---------------------------------------------------------------------------

describe('writeKeychainSecret', () => {
  it('passes the secret on stdin and never places it in argv', () => {
    const secret = 'sk-super-secret-value-12345';
    const { runner, calls } = recordingKeychainRunner(OK);

    const result = writeKeychainSecret(runner, KEYCHAIN_SERVICE_API_KEY, KEYCHAIN_ACCOUNT, secret);

    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('unreachable');

    // The load-bearing assertion: no argv element contains any substring of
    // the secret. This is exactly the check that would catch a regression to
    // `-w "$KEY"`.
    for (const arg of call.argv) {
      expect(arg.includes(secret)).toBe(false);
    }
    expect(call.argv.join(' ').includes(secret)).toBe(false);

    // The secret must instead have been sent on stdin.
    expect(call.stdin).toBe(`${secret}\n`);
  });

  it('uses the recommended trailing "-w" form (no value follows it in argv)', () => {
    const { runner, calls } = recordingKeychainRunner(OK);
    writeKeychainSecret(runner, KEYCHAIN_SERVICE_API_KEY, KEYCHAIN_ACCOUNT, 'sk-anything');
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('unreachable');
    expect(call.argv.at(-1)).toBe('-w');
  });

  it('reports a non-zero exit as a failed outcome with the command\'s stderr as the message', () => {
    const { runner } = recordingKeychainRunner({ status: 1, stdout: '', stderr: 'security: SecKeychainAddGenericPassword: boom' });
    const result = writeKeychainSecret(runner, KEYCHAIN_SERVICE_API_KEY, KEYCHAIN_ACCOUNT, 'sk-whatever');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('boom');
  });
});

describe('readKeychainSecret', () => {
  it('reads the value from stdout and trims a trailing newline', () => {
    const { runner } = recordingKeychainRunner({ status: 0, stdout: 'sk-round-tripped\n', stderr: '' });
    const result = readKeychainSecret(runner, KEYCHAIN_SERVICE_API_KEY, KEYCHAIN_ACCOUNT);
    expect(result.ok).toBe(true);
    expect(result.value).toBe('sk-round-tripped');
  });

  it('reports "not found" as a structured failure rather than throwing', () => {
    const { runner } = recordingKeychainRunner(NOT_FOUND);
    const result = readKeychainSecret(runner, KEYCHAIN_SERVICE_API_KEY, KEYCHAIN_ACCOUNT);
    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Trailing-newline trimming.
// ---------------------------------------------------------------------------

describe('trailing newline trimming', () => {
  it('readSecretFromStream trims a trailing newline from piped stdin-like input', async () => {
    const stream = Readable.from([Buffer.from('sk-pasted-key\n')]);
    const value = await readSecretFromStream(stream);
    expect(value).toBe('sk-pasted-key');
  });

  it('readSecretFromStream trims a trailing CRLF', async () => {
    const stream = Readable.from([Buffer.from('sk-pasted-key\r\n')]);
    const value = await readSecretFromStream(stream);
    expect(value).toBe('sk-pasted-key');
  });

  it('readSecretFromStream leaves a key with no trailing newline unchanged', async () => {
    const stream = Readable.from([Buffer.from('sk-no-newline')]);
    const value = await readSecretFromStream(stream);
    expect(value).toBe('sk-no-newline');
  });
});

// ---------------------------------------------------------------------------
// Masking.
// ---------------------------------------------------------------------------

describe('maskSecret', () => {
  it('shows only a short prefix; the full key never appears in the result', () => {
    const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const masked = maskSecret(secret);
    expect(masked).not.toContain(secret);
    expect(masked.length).toBeLessThan(10);
    expect(masked.startsWith('sk-A')).toBe(true);
  });

  it('masks a short secret without revealing all of it unobscured', () => {
    const masked = maskSecret('ab');
    expect(masked).not.toBe('ab');
  });

  it('masks the empty string to itself (nothing to hide)', () => {
    expect(maskSecret('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// .env parsing edge cases.
// ---------------------------------------------------------------------------

describe('parseDotEnv / readDotEnvFile', () => {
  it('a missing file resolves to {} without throwing', () => {
    expect(readDotEnvFile('/definitely/does/not/exist/.env')).toEqual({});
  });

  it('a file without the key omits that key from the result', () => {
    expect(parseDotEnv('FEZO_URL=https://gw.example.com\n')).toEqual({ FEZO_URL: 'https://gw.example.com' });
  });

  it('ignores comment lines', () => {
    const text = ['# a comment', 'FEZO_API_KEY=sk-value', '# FEZO_URL=https://ignored.example.com'].join('\n');
    expect(parseDotEnv(text)).toEqual({ FEZO_API_KEY: 'sk-value' });
  });

  it('trims surrounding whitespace around key and value', () => {
    expect(parseDotEnv('  FEZO_API_KEY   =   sk-value  \n')).toEqual({ FEZO_API_KEY: 'sk-value' });
  });

  it('ignores blank lines', () => {
    const text = ['', 'FEZO_API_KEY=sk-value', '', ''].join('\n');
    expect(parseDotEnv(text)).toEqual({ FEZO_API_KEY: 'sk-value' });
  });
});

// ---------------------------------------------------------------------------
// storeCredentials — end to end for both storage choices.
// ---------------------------------------------------------------------------

describe('storeCredentials', () => {
  it('dotenv storage writes both values in one file with mode 0600', () => {
    withTmpDir((dir) => {
      const dotEnvPath = join(dir, '.env');
      const result = storeCredentials({
        storage: 'dotenv',
        apiKey: 'sk-stored-value',
        url: 'https://gw.example.com',
        dotEnvPath,
      });
      expect(result.apiKey.ok).toBe(true);
      expect(result.url?.ok).toBe(true);
      expect(statSync(dotEnvPath).mode & 0o777).toBe(0o600);
      const contents = readFileSync(dotEnvPath, 'utf8');
      expect(contents).toContain('FEZO_API_KEY=sk-stored-value');
      expect(contents).toContain('FEZO_URL=https://gw.example.com');
    });
  });

  it('dotenv storage works on a first run, where the config directory does not exist yet', () => {
    withTmpDir((dir) => {
      const dotEnvPath = join(dir, 'config', 'fezo', '.env');
      const result = storeCredentials({
        storage: 'dotenv',
        apiKey: 'sk-first-run-setup',
        url: 'https://gw.example.com',
        dotEnvPath,
      });
      expect(result.apiKey).toEqual({ ok: true });
      expect(result.url).toEqual({ ok: true });
      expect(readFileSync(dotEnvPath, 'utf8')).toContain('FEZO_API_KEY=sk-first-run-setup');
      expect(statSync(dotEnvPath).mode & 0o777).toBe(0o600);
    });
  });

  it('keychain storage stores the secret via the injected runner, never in argv', () => {
    const { runner, calls } = recordingKeychainRunner(OK);
    const result = storeCredentials({
      storage: 'keychain',
      apiKey: 'sk-stored-in-keychain',
      url: 'https://gw.example.com',
      keychain: runner,
    });
    expect(result.apiKey.ok).toBe(true);
    expect(result.url?.ok).toBe(true);
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.argv.join(' ')).not.toContain('sk-stored-in-keychain');
    }
    // Pins the identifiers the writes actually use, not just the constants'
    // values: a resolver looking under different names would find nothing.
    expect(calls[0]?.argv).toEqual(['add-generic-password', '-a', 'fezo', '-s', 'fezo-api-key', '-U', '-w']);
    expect(calls[1]?.argv).toEqual(['add-generic-password', '-a', 'fezo', '-s', 'fezo-url', '-U', '-w']);
  });

  it('keychain storage without a runner reports a structured failure instead of throwing', () => {
    const result = storeCredentials({ storage: 'keychain', apiKey: 'sk-whatever' });
    expect(result.apiKey.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// storeCredentials must not accept a key that resolveCredentials would then
// report as absent -- an empty stdin (Ctrl-D with nothing pasted) is the real
// case this closes.
// ---------------------------------------------------------------------------

describe('storeCredentials — empty API key', () => {
  it('rejects an empty key for dotenv storage and writes no file at all', () => {
    withTmpDir((dir) => {
      const dotEnvPath = join(dir, '.env');
      const result = storeCredentials({ storage: 'dotenv', apiKey: '', url: 'https://gw.example.com', dotEnvPath });

      expect(result.apiKey.ok).toBe(false);
      expect(result.apiKey.reason).toBe('empty-api-key');
      expect(result.url?.ok).toBe(false);
      // Nothing written: not even an empty `FEZO_API_KEY=` line, which would
      // both look configured and resolve as unconfigured.
      expect(existsSync(dotEnvPath)).toBe(false);
    });
  });

  it('rejects a whitespace-only key for dotenv storage', () => {
    withTmpDir((dir) => {
      const dotEnvPath = join(dir, '.env');
      const result = storeCredentials({ storage: 'dotenv', apiKey: '   ', dotEnvPath });
      expect(result.apiKey.ok).toBe(false);
      expect(result.apiKey.reason).toBe('empty-api-key');
      expect(existsSync(dotEnvPath)).toBe(false);
    });
  });

  it('rejects an empty key for keychain storage without invoking the runner', () => {
    const { runner, calls } = recordingKeychainRunner(OK);
    const result = storeCredentials({ storage: 'keychain', apiKey: '', keychain: runner });
    expect(result.apiKey.ok).toBe(false);
    expect(result.apiKey.reason).toBe('empty-api-key');
    expect(calls.length).toBe(0);
  });

  it('rejects a whitespace-only key for keychain storage without invoking the runner', () => {
    const { runner, calls } = recordingKeychainRunner(OK);
    const result = storeCredentials({ storage: 'keychain', apiKey: '   ', keychain: runner });
    expect(result.apiKey.ok).toBe(false);
    expect(result.apiKey.reason).toBe('empty-api-key');
    expect(calls.length).toBe(0);
  });

  it("what setup stores, resolveCredentials reports -- the two halves agree on 'no credential'", () => {
    withTmpDir((dir) => {
      const dotEnvPath = join(dir, '.env');
      const stored = storeCredentials({ storage: 'dotenv', apiKey: '', dotEnvPath });
      expect(stored.apiKey.ok).toBe(false);

      const resolution = resolveCredentials({ env: {}, dotEnvPath, warnedAliases: new Set() });
      expect(Object.hasOwn(resolution, 'apiKey')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// No leakage. Stated precisely, because "the secret never appears in the
// result" is NOT the invariant for resolveCredentials: it deliberately returns
// the raw key so client.ts can send it. The invariant is that the raw key lives
// in exactly one field (`apiKey.value`), and that everything else -- stderr,
// `masked`, and the whole of storeCredentials' result -- is free of it.
// ---------------------------------------------------------------------------

describe('no secret leakage', () => {
  it('resolveCredentials never writes the resolved secret to stderr', () => {
    const secret = 'sk-should-never-appear-in-logs';
    const { stderr } = captureStderrWithResult(() =>
      resolveCredentials({
        env: { ZUG_API_KEY: secret },
        dotEnvPath: '/nonexistent/.env',
        warnedAliases: new Set(),
      }),
    );
    // The alias warning fires here, so this is a real check of a real line.
    expect(stderr).toContain('ZUG_API_KEY');
    expect(stderr).not.toContain(secret);
  });

  it('resolveCredentials carries the raw secret in apiKey.value and nowhere else', () => {
    const secret = 'sk-should-appear-exactly-once';
    const result = resolveCredentials({
      env: { FEZO_API_KEY: secret },
      dotEnvPath: '/nonexistent/.env',
      warnedAliases: new Set(),
    });

    // The field set is closed: a future field carrying the secret in another
    // shape (a rendered summary, a header, a copy) fails this.
    expect(Object.keys(result.apiKey ?? {}).sort()).toEqual(['masked', 'source', 'value']);
    expect(result.apiKey?.value).toBe(secret);

    // Serialized, the secret occurs exactly once -- under `value`. Redacting
    // that one field must leave nothing behind.
    const serialized = JSON.stringify(result);
    expect(serialized.split(secret).length - 1).toBe(1);
    expect(serialized.replace(secret, '<redacted>')).not.toContain(secret);
  });

  it('the masked companion never contains the full secret, whatever the source', () => {
    withTmpDir((dir) => {
      const secret = 'sk-masking-must-hold-for-every-source';
      const dotEnvPath = join(dir, '.env');
      writeDotEnvFile(dotEnvPath, { FEZO_API_KEY: secret });

      const fromDotEnv = resolveCredentials({ env: {}, dotEnvPath, warnedAliases: new Set() });
      expect(fromDotEnv.apiKey?.masked).toBe('sk-m…');
      expect(fromDotEnv.apiKey?.masked).not.toContain(secret);

      const { runner } = recordingKeychainRunner({ status: 0, stdout: `${secret}\n`, stderr: '' });
      const fromKeychain = resolveCredentials({
        env: {},
        dotEnvPath: '/nonexistent/.env',
        keychain: runner,
        warnedAliases: new Set(),
      });
      expect(fromKeychain.apiKey?.masked).toBe('sk-m…');
      expect(fromKeychain.apiKey?.masked).not.toContain(secret);

      const fromEnv = resolveCredentials({ env: { FEZO_API_KEY: secret }, dotEnvPath: '/nonexistent/.env', warnedAliases: new Set() });
      expect(fromEnv.apiKey?.masked).not.toContain(secret);
      expect(maskSecret(secret).length).toBeLessThan(secret.length);
    });
  });

  it('storeCredentials never writes the secret to stderr and never returns it', () => {
    const secret = 'sk-should-never-appear-either';
    const { runner } = recordingKeychainRunner(OK);
    const { stderr, result } = captureStderrWithResult(() =>
      storeCredentials({ storage: 'keychain', apiKey: secret, url: 'https://gw.example.com', keychain: runner }),
    );
    expect(stderr).toBe('');
    // storeCredentials reports outcomes, never values: unlike resolveCredentials
    // it has no legitimate reason to hand the key back, so absence is the
    // invariant here.
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('storeCredentials does not echo the secret back in a failure message either', () => {
    const secret = 'sk-not-in-the-error-message';
    const { runner } = recordingKeychainRunner({ status: 1, stdout: '', stderr: 'security: SecKeychainAddGenericPassword: boom' });
    const { stderr, result } = captureStderrWithResult(() =>
      storeCredentials({ storage: 'keychain', apiKey: secret, keychain: runner }),
    );
    expect(result.apiKey.ok).toBe(false);
    expect(stderr).toBe('');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('a dotenv store writes the secret to the file and to nothing else', () => {
    withTmpDir((dir) => {
      const secret = 'sk-only-in-the-file';
      const dotEnvPath = join(dir, 'config', 'fezo', '.env');
      const { stderr, result } = captureStderrWithResult(() =>
        storeCredentials({ storage: 'dotenv', apiKey: secret, dotEnvPath }),
      );
      expect(result.apiKey.ok).toBe(true);
      expect(stderr).toBe('');
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(readFileSync(dotEnvPath, 'utf8')).toContain(secret);
    });
  });
});
