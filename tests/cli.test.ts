import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { NO_MORE_CANDIDATES_REASON, candidatesToRun, resolvePackageVersion, runCli } from '../src/cli.js';
import type { CliDeps } from '../src/cli.js';
import { newSchemaCompiler } from '../src/engine/ajv-instance.js';
import type { KeychainCommandResult, KeychainRunner } from '../src/engine/credentials.js';
import type { RunSelection } from '../src/engine/rank.js';
import type { ToolCandidate } from '../src/engine/catalog.js';

// ---------------------------------------------------------------------------
// Fixtures and helpers.
// ---------------------------------------------------------------------------

interface WireMethod {
  name: string;
  http?: {
    method?: string;
    query?: string[];
    path_params?: string[];
    header?: string[];
    request_body?: unknown;
    response_body?: unknown;
  };
  path?: string;
  title?: string;
  description?: string;
  input_schema?: object;
  output_schema?: object;
}

interface WireBackend {
  backend_id: string;
  billing?: { model?: string };
  info?: { title?: string; summary?: string; description?: string };
  user_settings?: string[];
  methods: WireMethod[];
}

function catalogBody(backends: WireBackend[]): string {
  return JSON.stringify({ backends });
}

/**
 * A `fetch` stand-in that answers `GET {base}/v1/catalog` with `catalog`, and
 * routes every other URL to the next queued `Response` for its backend id
 * (mirroring tests/retry.test.ts's `routedFetch`). Throws loudly on an
 * unregistered URL or an over-called backend rather than silently reusing a
 * stale response.
 */
function multiRouteFetch(catalog: WireBackend[], backendResponses: Record<string, Response[]> = {}): typeof fetch {
  const queues = new Map(Object.entries(backendResponses).map(([id, responses]) => [id, [...responses]]));
  return vi.fn(async (url: string | URL) => {
    const asString = String(url);
    if (asString.endsWith('/v1/catalog')) {
      return new Response(catalogBody(catalog), { status: 200 });
    }
    for (const [backendId, queue] of queues) {
      if (asString.includes(`/v1/${backendId}/`) || asString.includes(`/v1/${backendId}?`)) {
        const next = queue.shift();
        if (next === undefined) {
          throw new Error(`multiRouteFetch: backend "${backendId}" was called more times than it had responses queued`);
        }
        return next;
      }
    }
    throw new Error(`multiRouteFetch: no handler registered for URL ${asString}`);
  }) as unknown as typeof fetch;
}

function okResponse(bodyText: string, status = 200): Response {
  return new Response(bodyText, { status });
}

function gatewayErrorResponse(status: number, code: string, message = 'gateway said no'): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status });
}

const SECRET = 'sk-cli-test-secret-value-should-never-leak';

function baseDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    env: { FEZO_URL: 'https://gw.example.com', FEZO_API_KEY: SECRET },
    dotEnvPath: '/nonexistent/.env',
    ...overrides,
  };
}

/** A ToolCandidate fixture, matching the convention in binding.test.ts/render.test.ts. */
function candidate(overrides: Partial<ToolCandidate> & Pick<ToolCandidate, 'tool' | 'backendId' | 'path' | 'httpMethod' | 'bindings'>): ToolCandidate {
  return {
    method: 'method',
    protocol: 'http',
    description: 'a candidate',
    inputSchema: {},
    userSettings: [],
    backendInfoText: '',
    billingModel: 'per_call',
    ...overrides,
  };
}

// The catalog used by most tests: two backends offering a "scrape" method,
// ordered so that catalog/insertion order disagrees with CAPABILITY_PREFERENCES'
// scrape order (scrapingbee before firecrawl) -- this is what makes "run
// selects the preferred backend, not catalog order" an actual test of policy.
const SCRAPE_CATALOG: WireBackend[] = [
  {
    backend_id: 'scrapingbee',
    billing: { model: 'per_call' },
    methods: [
      {
        name: 'scrape',
        path: '/scrape',
        description: 'Scrape a URL via the ScrapingBee API.',
        input_schema: {},
        http: { method: 'GET', query: ['url'] },
      },
    ],
  },
  {
    backend_id: 'firecrawl',
    billing: { model: 'per_call' },
    methods: [
      {
        name: 'scrape',
        path: '/scrape',
        description: 'Scrape a URL and return clean markdown content.',
        input_schema: {},
        http: { method: 'POST' },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// --version
// ---------------------------------------------------------------------------

describe('--version', () => {
  it('matches package.json, not a hardcoded string', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(resolvePackageVersion()).toBe(packageJson.version);
  });

  it('prints the resolved version and exits 0', async () => {
    const result = await runCli(['--version'], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(resolvePackageVersion());
  });

  // ---------------------------------------------------------------------------
  // I4. `resolvePackageVersion` reads a file and can throw (a bundling-layout
  // change is enough). Unguarded, that throw propagates out of `runCli` into an
  // unhandled rejection: a stack trace where a version string belongs. Because
  // the skill's invocation ladder compares a global `fezoctl --version` against
  // the skill's own version to decide whether to use it, that silently turns
  // into mis-resolution rather than a visible failure.
  //
  // `node:fs` is mocked (rather than a version resolver being injected) so this
  // exercises the real production path — the same `readFileSync` call
  // `resolvePackageVersion` actually makes — instead of a test-only seam.
  //
  // Fails against de6f98a: there, `runCli` rejects and the `await` throws, so
  // the assertions below are never reached.
  // ---------------------------------------------------------------------------
  it('exits 2 with a clear message, rather than throwing, when its own version cannot be read', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        default: actual,
        readFileSync: (path: unknown, options?: unknown): unknown => {
          if (String(path).endsWith('package.json')) throw new Error('EACCES: simulated unreadable package.json');
          return (actual.readFileSync as (p: unknown, o?: unknown) => unknown)(path, options);
        },
      };
    });

    try {
      const fresh = await import('../src/cli.js');

      const text = await fresh.runCli(['--version'], {});
      expect(text.exitCode).toBe(2);
      expect(text.stdout).toBe('');
      expect(text.stderr).toContain("could not determine fezoctl's own version");
      expect(text.stderr).toContain('simulated unreadable package.json');

      const json = await fresh.runCli(['--version', '--json'], {});
      expect(json.exitCode).toBe(2);
      const parsed = JSON.parse(json.stdout) as { error: { kind: string; message: string } };
      expect(parsed.error.kind).toBe('version-unavailable');
      expect(parsed.error.message).toContain('version');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// --help / usage errors
// ---------------------------------------------------------------------------

describe('usage errors', () => {
  it('an unknown command exits 1 and explains on stderr', async () => {
    const result = await runCli(['not-a-real-command'], baseDeps());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown command');
  });

  it('call without --args-json exits 1 before any network call', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(['call', 'some_tool'], baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--args-json');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('an unparseable --args-json exits 1 (caller-level invalid arguments, rejected before candidate selection)', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(
      ['call', 'some_tool', '--args-json', '{not valid json'],
      baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--args-json');
    expect(result.stderr).toContain('not valid JSON');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('an unknown flag exits 1', async () => {
    const result = await runCli(['catalog', '--not-a-flag'], baseDeps());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown flag');
  });

  it('a non-integer --max-attempts exits 1', async () => {
    const result = await runCli(['run', 'scrape this', '--args-json', '{}', '--max-attempts', 'three'], baseDeps());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--max-attempts');
  });

  // M10: a budget of zero authorizes no calls at all, so `run` would call
  // nothing and then report "max attempts (0) reached with candidates remaining"
  // as an operational failure — a command-line mistake dressed up as a runtime
  // one. Rejected as a usage error (exit 1) before any network work.
  it('--max-attempts 0 is a usage error (exit 1), not a run that calls nothing and fails', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(
      ['run', 'scrape this page', '--args-json', '{}', '--max-attempts', '0'],
      baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--max-attempts must be an integer >= 1');
    expect(result.stderr).not.toContain('max attempts (0) reached');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('--max-attempts 1 is accepted', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG, { firecrawl: [okResponse('{"markdown":"hi"}')] });
    const result = await runCli(
      ['run', 'scrape this page', '--args-json', '{"url":"https://x.example"}', '--max-attempts', '1', '--json'],
      baseDeps({ fetchFn }),
    );
    expect(result.exitCode).toBe(0);
  });

  it('no args at all prints help and exits 0', async () => {
    const result = await runCli([], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage');
    expect(result.stdout).toContain('Exit codes');
  });

  // M15: `-h`/`--help` used to be recognized at argv[0] only, so `fezoctl
  // search -h` searched the catalog for the term "-h" instead of printing help.
  it('-h and --help are recognized anywhere in argv, not just at argv[0]', async () => {
    const fetchFn = vi.fn();
    for (const argv of [['search', '-h'], ['search', '--help'], ['call', 'some_tool', '-h'], ['run', 'x', '-h']]) {
      const result = await runCli(argv, baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage');
      expect(result.stderr).toBe('');
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// I2. The `--json` error contract: with `--json` set, stdout is ALWAYS a JSON
// document. Before this, the most common failure of all — credentials not
// configured — produced EMPTY stdout plus English on stderr, so an agent
// scripting `fezoctl … --json` had to special-case "empty stdout means go read
// stderr" for some failures and not others.
//
// `kind` is the stable part of the contract, so each value is pinned to the
// exact path that emits it.
// ---------------------------------------------------------------------------

describe('--json failure envelope', () => {
  const noCredentials: CliDeps = { env: {}, dotEnvPath: '/nonexistent/.env' };

  function parseError(stdout: string): { kind: string; message: string } {
    const parsed = JSON.parse(stdout) as { error?: { kind?: unknown; message?: unknown } };
    const kind = parsed.error?.kind;
    const message = parsed.error?.message;
    if (typeof kind !== 'string' || typeof message !== 'string') {
      throw new Error(`expected {"error":{"kind","message"}} on stdout, got: ${stdout}`);
    }
    return { kind, message };
  }

  it('credentials-not-configured: every catalog-backed command emits it (was empty stdout)', async () => {
    const argvs: string[][] = [
      ['search', 'scrape this page', '--json'],
      ['schema', 'firecrawl_scrape', '--json'],
      ['call', 'firecrawl_scrape', '--args-json', '{}', '--json'],
      ['run', 'scrape this page', '--args-json', '{}', '--json'],
      ['catalog', '--json'],
    ];
    for (const argv of argvs) {
      const result = await runCli(argv, noCredentials);
      expect(result.exitCode).toBe(2);
      expect(parseError(result.stdout).kind).toBe('credentials-not-configured');
      // The human-readable message still goes to stderr, unchanged.
      expect(result.stderr).toContain('not configured');
    }
  });

  it('catalog-unavailable: a gateway that cannot be reached, and one that answers non-JSON', async () => {
    const unreachable = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const reachable = await runCli(['catalog', '--json'], baseDeps({ fetchFn: unreachable }));
    expect(reachable.exitCode).toBe(2);
    expect(parseError(reachable.stdout).kind).toBe('catalog-unavailable');
    expect(reachable.stderr).toContain('ECONNREFUSED');

    const notJson = vi.fn(async () => new Response('<html>nope</html>', { status: 200 })) as unknown as typeof fetch;
    const parseFailure = await runCli(['search', 'scrape', '--json'], baseDeps({ fetchFn: notJson }));
    expect(parseFailure.exitCode).toBe(2);
    expect(parseError(parseFailure.stdout).kind).toBe('catalog-unavailable');

    const status500 = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const statusFailure = await runCli(['schema', 'firecrawl_scrape', '--json'], baseDeps({ fetchFn: status500 }));
    expect(statusFailure.exitCode).toBe(2);
    expect(parseError(statusFailure.stdout).kind).toBe('catalog-unavailable');
  });

  it('tool-not-found: schema for a tool absent from the catalog', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG);
    const result = await runCli(['schema', 'totally_unknown_tool', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(2);
    expect(parseError(result.stdout).kind).toBe('tool-not-found');
    expect(result.stderr).toContain('not found');
  });

  it('invalid-args: --args-json failing the resolved tool\'s input schema', async () => {
    const catalog: WireBackend[] = [
      {
        backend_id: 'firecrawl',
        billing: { model: 'per_call' },
        methods: [
          {
            name: 'scrape',
            path: '/scrape',
            description: 'Scrape a URL and return clean markdown content.',
            input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
            http: { method: 'POST' },
          },
        ],
      },
    ];
    const fetchFn = multiRouteFetch(catalog);
    const result = await runCli(['call', 'firecrawl_scrape', '--args-json', '{}', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(2);
    expect(parseError(result.stdout).kind).toBe('invalid-args');
    expect(result.stderr).toContain('input schema');
    // Rejected locally: only the catalog GET happened, nothing was billed.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('usage: a bad flag, an unknown command, and an unparseable payload all emit it', async () => {
    const unknownFlag = await runCli(['catalog', '--not-a-flag', '--json'], baseDeps());
    expect(unknownFlag.exitCode).toBe(1);
    expect(parseError(unknownFlag.stdout).kind).toBe('usage');

    const unknownCommand = await runCli(['not-a-real-command', '--json'], baseDeps());
    expect(unknownCommand.exitCode).toBe(1);
    expect(parseError(unknownCommand.stdout).kind).toBe('usage');

    const badJson = await runCli(['call', 'some_tool', '--args-json', '{not valid json', '--json'], baseDeps());
    expect(badJson.exitCode).toBe(1);
    expect(parseError(badJson.stdout).kind).toBe('usage');

    const missingArgs = await runCli(['call', 'some_tool', '--json'], baseDeps());
    expect(missingArgs.exitCode).toBe(1);
    expect(parseError(missingArgs.stdout).kind).toBe('usage');

    const badMaxAttempts = await runCli(['run', 'x', '--args-json', '{}', '--max-attempts', '0', '--json'], baseDeps());
    expect(badMaxAttempts.exitCode).toBe(1);
    expect(parseError(badMaxAttempts.stdout).kind).toBe('usage');

    // `--json` as the leading token is an unknown COMMAND, so the parsed flags
    // never see it — but stdout must still not go silent on the one invocation
    // that explicitly asked for JSON.
    const jsonAsCommand = await runCli(['--json'], baseDeps());
    expect(jsonAsCommand.exitCode).toBe(1);
    expect(parseError(jsonAsCommand.stdout).kind).toBe('usage');
    expect(parseError(jsonAsCommand.stdout).message).toContain('unknown command');
  });

  it('without --json, the same failures write only to stderr and leave stdout empty', async () => {
    const result = await runCli(['catalog'], noCredentials);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('not configured');
  });

  it('a call that reached the gateway keeps its report document instead of an error envelope', async () => {
    // The deliberate exception to "failures emit an envelope": this document
    // carries the attempt log and what was billed, which an envelope would lose.
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG);
    const result = await runCli(['call', 'nonexistent_tool', '--args-json', '{}', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as { error?: unknown; attempts?: unknown[]; billedAnyAttempt?: boolean };
    expect(parsed.error).toBeUndefined();
    expect(parsed.attempts).toHaveLength(1);
    expect(parsed.billedAnyAttempt).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('search', () => {
  it('ranks matching candidates and shows candidate names and the ranking reason', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG);
    const result = await runCli(['search', 'scrape this page'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('firecrawl_scrape');
    expect(result.stdout).toContain('scrapingbee_scrape');
    expect(result.stdout).not.toContain('input_schema');
  });

  it('--schema includes the input schema and HTTP bindings', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG);
    const result = await runCli(['search', 'scrape this page', '--schema', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { results: { schema?: { httpMethod: string } }[] };
    expect(parsed.results.every((r) => r.schema !== undefined)).toBe(true);
  });

  it('without --schema, the JSON output has no schema field', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG);
    const result = await runCli(['search', 'scrape this page', '--json'], baseDeps({ fetchFn }));
    const parsed = JSON.parse(result.stdout) as { results: Record<string, unknown>[] };
    expect(parsed.results.every((r) => !Object.hasOwn(r, 'schema'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

describe('schema', () => {
  it('resolves a tool by name and prints its schema/bindings', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG);
    const result = await runCli(['schema', 'firecrawl_scrape', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { tool: string; backendId: string; httpMethod: string };
    expect(parsed.tool).toBe('firecrawl_scrape');
    expect(parsed.backendId).toBe('firecrawl');
    expect(parsed.httpMethod).toBe('POST');
  });

  it('an unknown tool name exits 2, and never splits the name on "_" to resolve it', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG);
    const result = await runCli(['schema', 'totally_unknown_tool'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

describe('call', () => {
  it('with --args-json: binds and calls, reporting the billed attempt and result body', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG, { scrapingbee: [okResponse('{"markdown":"hi"}')] });
    const result = await runCli(['call', 'scrapingbee_scrape', '--args-json', '{"url":"https://x.example"}', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      resolved: boolean;
      request: { query: Record<string, string> };
      outcome: { kind: string; body: { markdown: string } };
      billedAnyAttempt: boolean;
    };
    expect(parsed.resolved).toBe(true);
    expect(parsed.request.query).toEqual({ url: 'https://x.example' });
    expect(parsed.outcome.kind).toBe('success');
    expect(parsed.outcome.body.markdown).toBe('hi');
    expect(parsed.billedAnyAttempt).toBe(true);
  });

  it('with --body-json: a mixed binding (query args + a distinct JSON array body) is sent as declared', async () => {
    const catalog: WireBackend[] = [
      {
        backend_id: 'brightdata',
        billing: { model: 'per_call' },
        methods: [
          {
            name: 'scrape_async',
            path: '/scrape_async',
            description: 'Trigger an async scrape job.',
            input_schema: {},
            http: { method: 'POST', query: ['dataset_id'], request_body: { description: 'records' } },
          },
        ],
      },
    ];
    const fetchFn = multiRouteFetch(catalog, { brightdata: [okResponse('{"snapshot_id":"s_1"}')] });
    const result = await runCli(
      [
        'call',
        'brightdata_scrape_async',
        '--args-json',
        '{"dataset_id":"gd_1"}',
        '--body-json',
        '[{"url":"https://example.com"}]',
        '--json',
      ],
      baseDeps({ fetchFn }),
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { request: { query: Record<string, string>; body: unknown } };
    expect(parsed.request.query).toEqual({ dataset_id: 'gd_1' });
    expect(parsed.request.body).toEqual([{ url: 'https://example.com' }]);
  });

  // ---------------------------------------------------------------------------
  // I3 / carry-forward 5. The body is validated against the binding's OWN
  // declared media-type schema, never against `inputSchema` — whose permissive
  // `{type:'object'}` fallback would reject a legitimate non-object body such as
  // brightdata `scrape_async`'s array of records. Two branches matter, and the
  // pre-existing `--body-json` test reached NEITHER: it declared
  // `request_body: {description: 'records'}` with no `content`, so it exited at
  // the `schema === undefined` branch before the compile probe ran.
  //
  // (a) A body schema that FAILS TO COMPILE. This is the branch carry-forward 5
  // exists for: validation must be SKIPPED and the call must proceed with the
  // non-object body intact, rather than falling back to a schema that would
  // reject it.
  //
  // Fails against de6f98a? NO — this branch's behaviour is unchanged by this
  // round of fixes; the test is new coverage of existing (correct) behaviour.
  // It is written to fail if the permissive-fallback rule is ever "simplified"
  // away.
  // ---------------------------------------------------------------------------
  it('--body-json: a body schema that fails to compile skips validation and the call proceeds with the body intact', async () => {
    // Pin the premise: `{type: 'bogus'}` must actually fail to compile under
    // the very compiler `cli.ts`'s `schemaCompiles` probe uses —
    // `newSchemaCompiler()`, not a hand-rolled copy of its options, so a change
    // to that construction cannot leave this guard asserting something the
    // probe no longer does. Without it, a future Ajv version that stopped
    // throwing on an unrecognized `type` would silently slide this test onto
    // the compiles-and-accepts branch instead — same observable result, wrong
    // branch, and the permissive-fallback coverage this test exists for would
    // be lost without the suite ever going red.
    const probeCompiler = newSchemaCompiler();
    expect(() => probeCompiler.compile({ type: 'bogus' })).toThrow();

    const catalog: WireBackend[] = [
      {
        backend_id: 'brightdata',
        billing: { model: 'per_call' },
        methods: [
          {
            name: 'scrape_async',
            path: '/scrape_async',
            description: 'Trigger an async scrape job.',
            input_schema: {},
            http: {
              method: 'POST',
              query: ['dataset_id'],
              // `{type: 'bogus'}` is not a compilable JSON Schema: Ajv throws
              // "schema is invalid" on it even under `strict: false`.
              request_body: { content: { 'application/json': { schema: { type: 'bogus' } } } },
            },
          },
        ],
      },
    ];
    const fetchFn = multiRouteFetch(catalog, { brightdata: [okResponse('{"snapshot_id":"s_1"}')] });
    const result = await runCli(
      [
        'call',
        'brightdata_scrape_async',
        '--args-json',
        '{"dataset_id":"gd_1"}',
        '--body-json',
        '[{"url":"https://example.com"}]',
        '--json',
      ],
      baseDeps({ fetchFn }),
    );

    // The call actually went through — not blocked by an uncompilable schema,
    // and not silently rewritten.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as {
      request: { query: Record<string, string>; body: unknown };
      outcome: { kind: string; body: { snapshot_id: string } };
    };
    expect(parsed.outcome.kind).toBe('success');
    expect(parsed.outcome.body.snapshot_id).toBe('s_1');
    expect(parsed.request.query).toEqual({ dataset_id: 'gd_1' });
    expect(parsed.request.body).toEqual([{ url: 'https://example.com' }]);
    // Catalog GET + the real call: the array body reached the backend.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  // (b) A body schema that COMPILES and REJECTS: exit 2 with the body-schema
  // message, before any request is sent.
  it('--body-json: a body that fails its own compiled media-type schema exits 2 without calling the backend', async () => {
    const catalog: WireBackend[] = [
      {
        backend_id: 'brightdata',
        billing: { model: 'per_call' },
        methods: [
          {
            name: 'scrape_async',
            path: '/scrape_async',
            description: 'Trigger an async scrape job.',
            input_schema: {},
            http: {
              method: 'POST',
              query: ['dataset_id'],
              request_body: {
                content: {
                  'application/json': {
                    schema: { type: 'array', items: { type: 'object', required: ['url'] } },
                  },
                },
              },
            },
          },
        ],
      },
    ];
    const fetchFn = multiRouteFetch(catalog);
    const result = await runCli(
      ['call', 'brightdata_scrape_async', '--args-json', '{"dataset_id":"gd_1"}', '--body-json', '[{}]', '--json'],
      baseDeps({ fetchFn }),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("does not match brightdata_scrape_async's request body schema");
    const parsed = JSON.parse(result.stdout) as { error: { kind: string; message: string } };
    expect(parsed.error.kind).toBe('invalid-body');
    expect(parsed.error.message).toContain('request body schema');
    // Only the catalog GET — the backend was never called, so nothing was billed.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('an unresolved tool is classified as tool_not_in_catalog and exits 2 without calling fetch for a call', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG);
    const result = await runCli(['call', 'nonexistent_tool', '--args-json', '{}', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as { resolved: boolean; attempts: { gatewayCode?: string }[]; outcome: { kind: string } };
    expect(parsed.resolved).toBe(false);
    expect(parsed.attempts[0]?.gatewayCode).toBe('tool_not_in_catalog');
    expect(parsed.outcome.kind).toBe('give_up');
  });
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe('run', () => {
  it('selects the capability-preferred candidate, not catalog/insertion order', async () => {
    // scrapingbee is listed FIRST in the catalog but ranks behind firecrawl in
    // CAPABILITY_PREFERENCES.scrape; a passing test here proves preference,
    // not catalog order, decided the pick.
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG, { firecrawl: [okResponse('{"markdown":"hi"}')] });
    const result = await runCli(['run', 'scrape this page', '--args-json', '{"url":"https://x.example"}', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    // `selection`, not `outcome`: `run`'s --json document names the SELECTION
    // outcome here and the call result under `result` (`call`'s `outcome` is a
    // different shape entirely -- an object, not a string).
    const parsed = JSON.parse(result.stdout) as { selection: string; chosen: { backendId: string }; result: { kind: string } };
    expect(parsed.selection).toBe('selected');
    expect(parsed.chosen.backendId).toBe('firecrawl');
    expect(parsed.result.kind).toBe('success');
  });

  it('retries a retryable mechanical failure and renders the attempt log with billed status', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG, {
      firecrawl: [gatewayErrorResponse(503, 'backend_unavailable')],
      scrapingbee: [okResponse('{"markdown":"hi"}')],
    });
    const result = await runCli(['run', 'scrape this page', '--args-json', '{"url":"https://x.example"}', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      attempts: { backendId: string; status: string; billed: boolean }[];
      result: { kind: string };
    };
    expect(parsed.attempts).toHaveLength(2);
    expect(parsed.attempts[0]).toMatchObject({ backendId: 'firecrawl', status: 'retry', billed: false });
    expect(parsed.attempts[1]).toMatchObject({ backendId: 'scrapingbee', status: 'success', billed: true });
    expect(parsed.result.kind).toBe('success');
  });

  it('refuses an unhinted multi-backend auto-pick, and succeeds with --allow-unhinted-auto-pick', async () => {
    // "translate document" matches no CAPABILITY_KEYWORDS phrase at all, and
    // both backends match the search terms -- exactly the case rank.ts
    // requires a refusal for.
    // Both descriptions match BOTH query terms ("translate" and "document"),
    // so both are in the matched set and the tie is broken by original
    // catalog order (alpha first) — the ONE deterministic tie-break the
    // governing spec allows.
    const catalog: WireBackend[] = [
      { backend_id: 'alpha', methods: [{ name: 'translate', path: '/translate', description: 'Translate a document into another language.', input_schema: {} }] },
      { backend_id: 'beta', methods: [{ name: 'translate', path: '/translate', description: 'Translate a document quickly.', input_schema: {} }] },
    ];

    const fetchFnNoOverride = multiRouteFetch(catalog);
    const refused = await runCli(['run', 'translate document', '--args-json', '{}', '--json'], baseDeps({ fetchFn: fetchFnNoOverride }));
    expect(refused.exitCode).toBe(2);
    const refusedParsed = JSON.parse(refused.stdout) as { selection: string; overridden: boolean };
    expect(refusedParsed.selection).toBe('refused-unhinted-multi-backend');
    expect(refusedParsed.overridden).toBe(false);
    expect(fetchFnNoOverride).toHaveBeenCalledTimes(1); // only the catalog fetch — no candidate was called

    const fetchFnOverride = multiRouteFetch(catalog, { alpha: [okResponse('{"ok":true}')] });
    const overridden = await runCli(
      ['run', 'translate document', '--args-json', '{}', '--allow-unhinted-auto-pick', '--json'],
      baseDeps({ fetchFn: fetchFnOverride }),
    );
    expect(overridden.exitCode).toBe(0);
    const overriddenParsed = JSON.parse(overridden.stdout) as { overridden: boolean; result: { kind: string; backendId: string } };
    expect(overriddenParsed.overridden).toBe(true);
    expect(overriddenParsed.result.kind).toBe('success');
    expect(overriddenParsed.result.backendId).toBe('alpha');
  });

  it('does NOT auto-pick an async-excluded candidate: no call is made, and the run is reported as excluded', async () => {
    // `check_progress` is async by name-suffix (`_progress`, one of
    // ASYNC_NAME_SUFFIXES in rank.ts), but neither query token ("check",
    // "progress") is one of rank.ts's async-override whole-token escape
    // hatches ("async"/"job"/"snapshot"/"status"/"crawl"), and the query does
    // not name the tool exactly either -- so neither documented bypass
    // applies, and this exercises the exclusion itself rather than an
    // override of it.
    const catalog: WireBackend[] = [
      {
        backend_id: 'brightdata',
        methods: [{ name: 'check_progress', path: '/progress', description: 'Check the progress of a long-running task.', input_schema: {} }],
      },
    ];
    const fetchFn = multiRouteFetch(catalog);
    const result = await runCli(['run', 'check progress', '--args-json', '{}', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as { selection: string; asyncExcluded: { tool: string }[] };
    expect(parsed.selection).toBe('async-excluded');
    expect(parsed.asyncExcluded[0]?.tool).toBe('brightdata_check_progress');
    // Only the catalog GET happened -- the async lifecycle method was never called.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// M6. `unresolvedToolReport` synthesizes the give-up report that retry.ts's own
// exhaustion path would have produced, which means cli.ts holds a second copy of
// retry.ts's "no more candidates to try" wording. Nothing in the type system ties
// the two together, so this test does: it drives a REAL `run()` to exhaustion
// and asserts the reason it returns is character-for-character the constant
// cli.ts uses for the synthesized case. A reworded string on either side fails
// here instead of silently desynchronizing `call`'s output from `run`'s.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// C5: `run` must not bill for arguments `call` rejects for free.
//
// Required-field OMISSIONS were already caught free, by `bindArgs`'s
// BindingError. The exposure was type/shape mismatches -- the class a user pays
// to discover -- because `cmdRun` performed no schema validation at all while
// `cmdCall` did. A validation failure is now a candidate SKIP on the same
// footing as a BindingError: no request, no spend, and no charge against the
// `--max-attempts` budget (that budget governs billed calls).
// ---------------------------------------------------------------------------

describe('run validates each candidate\'s input schema before spending', () => {
  // Two backends serving one capability. Both publish a typed schema, and the
  // args below violate BOTH of them, so neither may be called.
  const TYPED_SCRAPE_CATALOG: WireBackend[] = [
    {
      backend_id: 'firecrawl',
      billing: { model: 'per_call' },
      methods: [
        {
          name: 'scrape',
          path: '/scrape',
          description: 'Scrape a URL and return clean markdown content.',
          input_schema: {
            type: 'object',
            properties: { profile: { type: 'string' }, url: { type: 'string' }, depth: { type: 'integer' } },
            required: ['profile'],
          },
          http: { method: 'POST' },
        },
      ],
    },
    {
      backend_id: 'scrapingbee',
      billing: { model: 'per_call' },
      methods: [
        {
          name: 'scrape',
          path: '/scrape',
          description: 'Scrape a URL via the ScrapingBee API.',
          input_schema: {
            type: 'object',
            properties: { profile: { type: 'string' }, url: { type: 'string' }, depth: { type: 'integer' } },
            required: ['profile'],
          },
          http: { method: 'GET', query: ['url'] },
        },
      ],
    },
  ];

  const BAD_ARGS = '{"profile":"p","url":12345,"depth":"deep"}';

  it('skips a candidate whose schema the args violate: nothing is billed, and no request is sent', async () => {
    // No backend responses are queued: `multiRouteFetch` THROWS on any call to a
    // backend, so a regression that spends money fails loudly here rather than
    // quietly passing.
    const fetchFn = multiRouteFetch(TYPED_SCRAPE_CATALOG);
    const result = await runCli(['run', 'scrape this page', '--args-json', BAD_ARGS, '--json'], baseDeps({ fetchFn }));

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as {
      attempts: { backendId: string; status: string; billed: boolean; reason: string }[];
      result: { kind: string; reason: string };
    };
    // Both candidates were attempted (logged) and both were skipped locally.
    expect(parsed.attempts).toHaveLength(2);
    for (const attempt of parsed.attempts) {
      expect(attempt.status).toBe('retry');
      expect(attempt.billed).toBe(false);
      expect(attempt.reason).toContain('candidate rejected the supplied arguments');
      expect(attempt.reason).toContain('/url must be string');
      expect(attempt.reason).toContain('/depth must be integer');
    }
    expect(parsed.result.kind).toBe('give_up');
    expect(parsed.result.reason).toContain('no candidate accepted the supplied arguments');
    // Exactly one fetch: the catalog. Nothing was called, so nothing was billed.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a validation skip does not consume the --max-attempts budget, so a later valid candidate is still called', async () => {
    // The first candidate's schema rejects the args (a free skip); the second
    // accepts them and must still be reached under the default budget of 2,
    // which the skip must not have decremented. Pinned with `--max-attempts 1`
    // so that a skip charged against the budget would leave NO calls at all.
    const catalog: WireBackend[] = [
      {
        backend_id: 'firecrawl',
        billing: { model: 'per_call' },
        methods: [
          {
            name: 'scrape',
            path: '/scrape',
            description: 'Scrape a URL and return clean markdown content.',
            input_schema: { type: 'object', properties: { url: { type: 'integer' } } },
            http: { method: 'POST' },
          },
        ],
      },
      {
        backend_id: 'scrapingbee',
        billing: { model: 'per_call' },
        methods: [
          {
            name: 'scrape',
            path: '/scrape',
            description: 'Scrape a URL via the ScrapingBee API.',
            input_schema: { type: 'object', properties: { url: { type: 'string' } } },
            http: { method: 'GET', query: ['url'] },
          },
        ],
      },
    ];
    const fetchFn = multiRouteFetch(catalog, { scrapingbee: [okResponse('{"markdown":"hi"}')] });
    const result = await runCli(
      ['run', 'scrape this page', '--args-json', '{"url":"https://x.example"}', '--max-attempts', '1', '--json'],
      baseDeps({ fetchFn }),
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      attempts: { backendId: string; status: string; billed: boolean }[];
      result: { kind: string; backendId: string };
    };
    expect(parsed.attempts).toHaveLength(2);
    expect(parsed.attempts[0]).toMatchObject({ backendId: 'firecrawl', status: 'retry', billed: false });
    expect(parsed.attempts[1]).toMatchObject({ backendId: 'scrapingbee', status: 'success', billed: true });
    expect(parsed.result.kind).toBe('success');
    expect(parsed.result.backendId).toBe('scrapingbee');
    expect(fetchFn).toHaveBeenCalledTimes(2); // catalog + the one valid candidate
  });

  it('run and call now agree on the same args and the same tool', async () => {
    // The pre-fix asymmetry, pinned: `call` exited 2 naming the type errors while
    // `run` billed a call for the identical payload.
    const runFetch = multiRouteFetch(TYPED_SCRAPE_CATALOG);
    const viaRun = await runCli(['run', 'scrape this page', '--args-json', BAD_ARGS], baseDeps({ fetchFn: runFetch }));
    expect(viaRun.exitCode).toBe(2);
    expect(runFetch).toHaveBeenCalledTimes(1);

    const callFetch = multiRouteFetch(TYPED_SCRAPE_CATALOG);
    const viaCall = await runCli(['call', 'firecrawl_scrape', '--args-json', BAD_ARGS], baseDeps({ fetchFn: callFetch }));
    expect(viaCall.exitCode).toBe(2);
    expect(viaCall.stderr).toContain('/url must be string');
    expect(viaCall.stderr).toContain('/depth must be integer');
    expect(callFetch).toHaveBeenCalledTimes(1);
  });
});

describe('give-up wording is shared with retry.ts, not re-invented', () => {
  it("a real run() exhaustion returns exactly cli.ts's NO_MORE_CANDIDATES_REASON", async () => {
    // One candidate, a retryable failure, no second candidate to advance into:
    // retry.ts's "ran out of candidates" path, reached through the engine.
    const catalog: WireBackend[] = [
      {
        backend_id: 'firecrawl',
        billing: { model: 'per_call' },
        methods: [{ name: 'scrape', path: '/scrape', description: 'Scrape a URL.', input_schema: {}, http: { method: 'POST' } }],
      },
    ];
    const fetchFn = multiRouteFetch(catalog, { firecrawl: [gatewayErrorResponse(503, 'backend_unavailable')] });
    const fromEngine = await runCli(['call', 'firecrawl_scrape', '--args-json', '{"url":"https://x.example"}', '--json'], baseDeps({ fetchFn }));
    expect(fromEngine.exitCode).toBe(2);
    const engineParsed = JSON.parse(fromEngine.stdout) as { outcome: { kind: string; reason: string } };
    expect(engineParsed.outcome.kind).toBe('give_up');
    expect(engineParsed.outcome.reason).toBe(NO_MORE_CANDIDATES_REASON);

    // ...and the synthesized report for an unresolved tool says the same thing.
    const synthesizedFetch = multiRouteFetch(catalog);
    const synthesized = await runCli(['call', 'nonexistent_tool', '--args-json', '{}', '--json'], baseDeps({ fetchFn: synthesizedFetch }));
    const synthesizedParsed = JSON.parse(synthesized.stdout) as { outcome: { reason: string } };
    expect(synthesizedParsed.outcome.reason).toBe(NO_MORE_CANDIDATES_REASON);
    expect(synthesizedParsed.outcome.reason).toBe(engineParsed.outcome.reason);
  });
});

// ---------------------------------------------------------------------------
// candidatesToRun — the one adapter every `run` call site must funnel
// through (carry-forward #2). Tested directly, not just through the CLI, so
// a regression here is caught even if a future command stops matching the
// end-to-end assertions above.
// ---------------------------------------------------------------------------

describe('candidatesToRun', () => {
  const a = candidate({ tool: 'a_x', backendId: 'a', path: '/x', httpMethod: 'GET', bindings: {} });
  const b = candidate({ tool: 'b_x', backendId: 'b', path: '/x', httpMethod: 'GET', bindings: {} });

  it('no-match, async-excluded, and refused-ambiguous-capability never yield a candidate to call', () => {
    const noMatch: RunSelection = { outcome: 'no-match' };
    expect(candidatesToRun(noMatch, true)).toEqual([]);

    const asyncExcluded: RunSelection = { outcome: 'async-excluded', asyncExcluded: [a] };
    expect(candidatesToRun(asyncExcluded, true)).toEqual([]);

    const ambiguous: RunSelection = {
      outcome: 'refused-ambiguous-capability',
      reason: { kind: 'ambiguous-capability', capabilities: ['scrape', 'serp'] },
      alternatives: [{ candidate: a, explanation: { tier: 'term-score', matchedTerms: [], termScore: 0, billingModel: 'per_call' } }],
    };
    // Even with the override flag true, ambiguous-capability is NOT overridable.
    expect(candidatesToRun(ambiguous, true)).toEqual([]);
  });

  it('refused-unhinted-multi-backend yields nothing without the flag, and only ranked[0] with it', () => {
    const ranked = [
      { candidate: a, explanation: { tier: 'term-score' as const, matchedTerms: [], termScore: 1, billingModel: 'per_call' as const } },
      { candidate: b, explanation: { tier: 'term-score' as const, matchedTerms: [], termScore: 0, billingModel: 'per_call' as const } },
    ];
    const selection: RunSelection = { outcome: 'refused-unhinted-multi-backend', reason: { kind: 'unhinted-multi-backend', backends: ['a', 'b'] }, ranked };
    expect(candidatesToRun(selection, false)).toEqual([]);
    expect(candidatesToRun(selection, true)).toEqual([a]);
  });

  it('selected yields the full ranked list (chosen first, then fallbacks) regardless of the flag', () => {
    const ranked = [
      { candidate: a, explanation: { tier: 'exact-tool' as const, matchedTerms: [], termScore: 3, billingModel: 'per_call' as const } },
      { candidate: b, explanation: { tier: 'term-score' as const, matchedTerms: [], termScore: 1, billingModel: 'per_call' as const } },
    ];
    const selection: RunSelection = { outcome: 'selected', chosen: ranked[0] as (typeof ranked)[number], ranked };
    expect(candidatesToRun(selection, false)).toEqual([a, b]);
    expect(candidatesToRun(selection, true)).toEqual([a, b]);
  });
});

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

describe('catalog', () => {
  it('prints available backends and methods', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG);
    const result = await runCli(['catalog', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { totalMethods: number; backends: { backendId: string }[] };
    expect(parsed.totalMethods).toBe(2);
    expect(parsed.backends.map((b) => b.backendId).sort()).toEqual(['firecrawl', 'scrapingbee']);
  });
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe('doctor', () => {
  it('reports every check, including a preference-hint backend absent from the live catalog', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG);
    const result = await runCli(['doctor', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { checks: { name: string; status: string; message: string }[] };
    const byName = new Map(parsed.checks.map((c) => [c.name, c]));
    expect(byName.get('gateway-url')?.status).toBe('ok');
    expect(byName.get('api-key')?.status).toBe('ok');
    expect(byName.get('gateway-connectivity')?.status).toBe('ok');
    expect(byName.get('auth')?.status).toBe('ok');
    expect(byName.get('catalog-readable')?.status).toBe('ok');
    // Neither "firecrawl" nor "scrapingbee" alone covers every hinted backend
    // (brightdata/geonode/scraperapi/exa/brave/you are all absent here), so
    // this must warn and name at least one of them.
    const prefCheck = byName.get('preference-hints');
    expect(prefCheck?.status).toBe('warn');
    expect(prefCheck?.message).toContain('brightdata');
  });

  it('reports missing credentials as a hard failure and skips the connectivity checks', async () => {
    const result = await runCli(['doctor', '--json'], { env: {}, dotEnvPath: '/nonexistent/.env' });
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as { checks: { name: string; status: string }[] };
    const byName = new Map(parsed.checks.map((c) => [c.name, c]));
    expect(byName.get('gateway-url')?.status).toBe('fail');
    expect(byName.get('api-key')?.status).toBe('fail');
    expect(byName.get('gateway-connectivity')?.status).toBe('skipped');
  });

  it('reports an auth failure distinctly from a connectivity failure', async () => {
    const fetchFn = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
    const result = await runCli(['doctor', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as { checks: { name: string; status: string }[] };
    const byName = new Map(parsed.checks.map((c) => [c.name, c]));
    expect(byName.get('gateway-connectivity')?.status).toBe('ok');
    expect(byName.get('auth')?.status).toBe('fail');
    expect(byName.get('catalog-readable')?.status).toBe('skipped');
  });

  it('never shows the raw API key, only its masked form and source', async () => {
    const fetchFn = multiRouteFetch(SCRAPE_CATALOG);
    const result = await runCli(['doctor', '--json'], baseDeps({ fetchFn }));
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stdout).toContain('sk-c'); // masked prefix of SECRET
  });
});

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

describe('setup', () => {
  it('reads the key from an injected stream and stores it via dotenv, without the key reaching stdout/stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-setup-'));
    try {
      const dotEnvPath = join(dir, '.env');
      const stdin = Readable.from([Buffer.from(`${SECRET}\n`)]);
      const result = await runCli(
        ['setup', '--key-stdin', '--url', 'https://gw.example.com', '--json'],
        { stdin, dotEnvPath, env: {} },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stderr).not.toContain(SECRET);

      const written = readFileSync(dotEnvPath, 'utf8');
      expect(written).toContain(`FEZO_API_KEY=${SECRET}`);
      expect(statSync(dotEnvPath).mode & 0o777).toBe(0o600);

      const parsed = JSON.parse(result.stdout) as { configured: { apiKey?: { masked: string } } };
      expect(parsed.configured.apiKey?.masked).not.toBe(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A faithful in-memory Keychain: `add-generic-password -w` stores the stdin
   * payload, `find-generic-password -w` reads it back.
   *
   * "Faithful" specifically includes the real binary's DOUBLE PROMPT: it reads
   * the password and then a confirmation copy, as two separate newline-terminated
   * lines. When the two do not match (which is what a single-line payload
   * produces — the confirmation read hits EOF), the real `security` stores an
   * EMPTY password and still exits 0. Modelling that is what makes the
   * round-trip assertions below a real test of `writeKeychainSecret`'s payload
   * rather than a test of a fake that quietly accepts one line; see
   * credentials.ts's `writeKeychainSecret` doc comment for the transcript
   * against the real binary.
   */
  function fakeKeychain(): { runner: KeychainRunner; calls: { argv: readonly string[]; stdin: string | undefined }[] } {
    const store = new Map<string, string>();
    const calls: { argv: readonly string[]; stdin: string | undefined }[] = [];
    const runner: KeychainRunner = {
      run(argv, stdin) {
        calls.push({ argv, stdin });
        if (argv[0] === 'add-generic-password') {
          const key = argv.join(' ');
          const [password, confirmation] = (stdin ?? '').split('\n');
          store.set(key, password !== undefined && password === confirmation ? password : '');
          const ok: KeychainCommandResult = { status: 0, stdout: '', stderr: '' };
          return ok;
        }
        if (argv[0] === 'find-generic-password') {
          // Reconstruct the matching add-generic-password key's account/service
          // to look up the same value (mirrors -a/-s identifying one item).
          const account = argv[argv.indexOf('-a') + 1];
          const service = argv[argv.indexOf('-s') + 1];
          for (const [key, value] of store) {
            if (key.includes(`-a ${String(account)} `) && key.includes(`-s ${String(service)} `)) {
              return { status: 0, stdout: `${value}\n`, stderr: '' };
            }
          }
          return { status: 44, stdout: '', stderr: 'security: could not be found' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    return { runner, calls };
  }

  // Fails against de6f98a: with `writeKeychainSecret` piping the secret only
  // once, the faithful fake above stores an empty value, post-write
  // verification catches it, and this exits 2 with `verification-failed`.
  // `--url` is supplied because `setup` now exits non-zero unless the resulting
  // configuration is USABLE (both a URL and a key resolve) — see cmdSetup's
  // comment on that third condition. This test is about the Keychain write
  // path, so it configures a complete credential set and keeps asserting exit 0
  // for it; the URL-less case has its own test below.
  it('keychain storage never places the secret in argv, and round-trips through a faithful keychain', async () => {
    const { runner, calls } = fakeKeychain();
    const stdin = Readable.from([Buffer.from(`${SECRET}\n`)]);
    const result = await runCli(['setup', '--key-stdin', '--storage', 'keychain', '--url', 'https://gw.example.com', '--json'], {
      stdin,
      keychain: runner,
      env: {},
      dotEnvPath: '/nonexistent/.env',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    for (const call of calls) {
      expect(call.argv.join(' ')).not.toContain(SECRET);
    }

    // Exit 0 alone would also be satisfied by "nothing was verified", so pin
    // what actually round-tripped: the key resolves back out of the Keychain
    // (not from env or .env, both of which are empty here) and masks to
    // SECRET's prefix.
    const parsed = JSON.parse(result.stdout) as {
      result: { apiKey: { ok: boolean; reason?: string } };
      configured: { apiKey?: { masked: string; source: string } };
    };
    expect(parsed.result.apiKey.ok).toBe(true);
    expect(parsed.result.apiKey.reason).toBeUndefined(); // verified, not merely "reported ok"
    expect(parsed.configured.apiKey?.source).toBe('keychain');
    expect(parsed.configured.apiKey?.masked).toBe('sk-c…');
  });

  // ---------------------------------------------------------------------------
  // C1(b): the shadowed-source hole. The common shape is a developer with
  // FEZO_API_KEY exported in their shell running `setup --storage keychain`:
  // resolution answers from env, so the Keychain write cannot be read back and
  // NOTHING is verified. That is not a storage failure (the env var legitimately
  // wins resolution), so it must still exit 0 — but the output must not print a
  // bare "stored" as though a round-trip had been confirmed.
  //
  // Fails against de6f98a: there, `verifyStoredField` returned the unverified
  // `{ok:true}` outcome untouched, `reason` was absent, and the text output said
  // exactly "api key: stored".
  // ---------------------------------------------------------------------------
  it('a write shadowed by a higher-priority source exits 0 but is reported as unverified, not as "stored"', async () => {
    const { runner } = fakeKeychain();
    const shadowingKey = 'sk-env-var-that-shadows-the-keychain';
    const deps: CliDeps = {
      stdin: Readable.from([Buffer.from(`${SECRET}\n`)]),
      keychain: runner,
      env: { FEZO_API_KEY: shadowingKey },
      dotEnvPath: '/nonexistent/.env',
    };

    // `--url` for the same reason as the test above: the assertion under test is
    // "exit 0 with an UNVERIFIED api key", which requires the rest of the
    // configuration to be complete.
    const result = await runCli(['setup', '--key-stdin', '--storage', 'keychain', '--url', 'https://gw.example.com', '--json'], deps);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stdout).not.toContain(shadowingKey);
    expect(result.stderr).not.toContain(SECRET);

    const parsed = JSON.parse(result.stdout) as { result: { apiKey: { ok: boolean; reason?: string; message?: string } } };
    expect(parsed.result.apiKey.ok).toBe(true);
    expect(parsed.result.apiKey.reason).toBe('unverified-shadowed-by-env');
    expect(parsed.result.apiKey.message).toContain('could not be verified');

    // ...and the text rendering must not claim a bare "stored".
    const text = await runCli(['setup', '--key-stdin', '--storage', 'keychain', '--url', 'https://gw.example.com'], {
      ...deps,
      stdin: Readable.from([Buffer.from(`${SECRET}\n`)]),
    });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain('NOT verified');
    expect(text.stdout).not.toMatch(/api key: stored$/m);
    expect(text.stdout).not.toContain(SECRET);
    expect(text.stderr).not.toContain(SECRET);
  });

  // ---------------------------------------------------------------------------
  // Reproduces, without the real macOS binary, exactly what smoke-testing
  // against it found (see Task 8's report): `security add-generic-password
  // ... -U -w` can exit 0 while silently storing an empty/null password,
  // because it reads stdin TWICE (password + confirmation) and a
  // single-copy piped payload makes the confirmation read EOF. `storeCredentials`
  // has no way to detect this (it only sees the runner's reported exit
  // status), so `cmdSetup` must verify the write by reading the value back
  // and comparing, rather than trusting a bare "ok" from the storage layer.
  // ---------------------------------------------------------------------------
  it('a Keychain runner that reports success but silently drops the value is caught by post-write verification', async () => {
    const runner: KeychainRunner = {
      run(argv) {
        if (argv[0] === 'add-generic-password') return { status: 0, stdout: '', stderr: '' }; // reports ok...
        if (argv[0] === 'find-generic-password') return { status: 0, stdout: '\n', stderr: '' }; // ...but nothing was actually stored
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const stdin = Readable.from([Buffer.from(`${SECRET}\n`)]);
    const result = await runCli(['setup', '--key-stdin', '--storage', 'keychain', '--json'], {
      stdin,
      keychain: runner,
      env: {},
      dotEnvPath: '/nonexistent/.env',
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).not.toContain(SECRET);
    const parsed = JSON.parse(result.stdout) as { result: { apiKey: { ok: boolean; reason?: string } } };
    expect(parsed.result.apiKey.ok).toBe(false);
    expect(parsed.result.apiKey.reason).toBe('verification-failed');
  });

  // ---------------------------------------------------------------------------
  // C1: `setup --key-stdin` with NO `--url` stored the key, printed nothing about
  // the missing URL (the `configured url:` line was emitted only when one had
  // resolved, so its absence was invisible), and exited 0 -- while the very next
  // command failed with `credentials-not-configured`. That exact command, with no
  // `--url`, was the recipe `build/step0.md` gave the model.
  //
  // Both halves are asserted here: the state is now unmistakable in the output,
  // and the exit code no longer claims more than is true.
  // ---------------------------------------------------------------------------
  it('without --url (and with no FEZO_URL), setup says the config is unusable and exits non-zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-setup-nourl-'));
    try {
      const dotEnvPath = join(dir, '.env');
      const result = await runCli(['setup', '--key-stdin'], {
        stdin: Readable.from([Buffer.from(`${SECRET}\n`)]),
        dotEnvPath,
        env: {},
      });

      // The key really was stored -- this is a partial success reported as
      // incomplete, not a write failure.
      expect(result.stdout).toContain('api key: stored');
      expect(readFileSync(dotEnvPath, 'utf8')).toContain(`FEZO_API_KEY=${SECRET}`);

      // ...and the missing URL is stated explicitly, not left to be inferred
      // from an absent line.
      expect(result.stdout).toContain('configured url: (not configured — pass --url or set FEZO_URL)');
      expect(result.stdout).toContain('this configuration is NOT usable yet');
      expect(result.exitCode).toBe(2);
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stderr).not.toContain(SECRET);

      // The end-to-end claim: exactly the state that makes the next command fail.
      const next = await runCli(['catalog'], { dotEnvPath, env: {} });
      expect(next.exitCode).toBe(2);
      expect(next.stderr).toContain('gateway URL and/or API key are not configured');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--json reports the same incompleteness as `usable: false`, with no second document on stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-setup-nourl-json-'));
    try {
      const dotEnvPath = join(dir, '.env');
      const result = await runCli(['setup', '--key-stdin', '--json'], {
        stdin: Readable.from([Buffer.from(`${SECRET}\n`)]),
        dotEnvPath,
        env: {},
      });
      expect(result.exitCode).toBe(2);
      // Still ONE JSON document (JSON.parse would throw on two concatenated).
      const parsed = JSON.parse(result.stdout) as {
        usable: boolean;
        result: { apiKey: { ok: boolean } };
        configured: { url?: unknown; apiKey?: { masked: string } };
      };
      expect(parsed.result.apiKey.ok).toBe(true); // the write itself succeeded
      expect(parsed.usable).toBe(false);
      expect(parsed.configured.url).toBeUndefined();
      expect(parsed.configured.apiKey?.masked).toBe('sk-c…');
      expect(result.stdout).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a URL supplied through FEZO_URL instead of --url is enough: setup exits 0', async () => {
    // The legitimate reason not to make this a hard failure of the WRITE: a user
    // may configure the URL by environment variable. Resolution reads env first,
    // so that user is already complete at this point and exits 0.
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-setup-envurl-'));
    try {
      const dotEnvPath = join(dir, '.env');
      const result = await runCli(['setup', '--key-stdin'], {
        stdin: Readable.from([Buffer.from(`${SECRET}\n`)]),
        dotEnvPath,
        env: { FEZO_URL: 'https://gw.example.com' },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('configured url: https://gw.example.com (source: env)');
      expect(result.stdout).not.toContain('NOT usable');
      expect(result.stdout).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // C8: a key pasted with surrounding whitespace. `readSecretFromStream` trimmed
  // only trailing NEWLINES, `writeDotEnvFile` wrote the value verbatim, and
  // `parseDotEnv` trimmed everything -- so post-write verification compared an
  // untrimmed write against a trimmed read, reported
  // "the value could not be read back and verified after storing it", and exited
  // 2, while `doctor` resolved the very same key. `.env`'s `wx` no-clobber flag
  // then blocked the retry that message invites. Note the internal contradiction
  // the old behavior produced: ONE atomic write reported `api key: failed` and
  // `url: stored` simultaneously.
  // ---------------------------------------------------------------------------
  it('a key pasted with surrounding whitespace is stored trimmed and verifies, instead of a false failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-setup-ws-'));
    try {
      const dotEnvPath = join(dir, '.env');
      const result = await runCli(['setup', '--key-stdin', '--url', 'https://gw.example.com'], {
        stdin: Readable.from([Buffer.from(`  ${SECRET} \n`)]),
        dotEnvPath,
        env: {},
      });

      expect(result.stdout).toContain('api key: stored');
      expect(result.stdout).not.toContain('failed');
      expect(result.stdout).not.toContain('could not be read back');
      expect(result.exitCode).toBe(0);

      // Stored trimmed, so the value that round-trips is the value that was meant.
      const written = readFileSync(dotEnvPath, 'utf8');
      expect(written).toContain(`FEZO_API_KEY=${SECRET}\n`);
      expect(written).not.toContain(`FEZO_API_KEY= ${SECRET}`);
      expect(written).not.toContain(`${SECRET} \n`);

      // And the one atomic write cannot report two different outcomes for its
      // two fields.
      expect(result.stdout).toContain('url: stored');

      const doctor = await runCli(['doctor'], { dotEnvPath, env: {}, fetchFn: multiRouteFetch(SCRAPE_CATALOG) });
      expect(doctor.stdout).toContain('[ok] api-key: FEZO_API_KEY resolved from dotenv');
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stdout).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires --key-stdin and never accepts a key via a CLI flag', async () => {
    const result = await runCli(['setup'], { env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--key-stdin');
  });
});

// ---------------------------------------------------------------------------
// No command's output ever contains a raw API key — text or --json.
// ---------------------------------------------------------------------------

describe('no secret leakage across every command', () => {
  // Each row carries its expected exit code, and every row's stdout is asserted
  // NON-EMPTY. Without those two checks the sweep would pass vacuously for any
  // command that started failing early — a command that exits 2 with empty
  // stdout trivially "does not contain the secret". Text mode is covered
  // alongside `--json` for every command, since the two render through
  // different code paths.
  it('search, schema, call, run, catalog, and doctor never print the raw API key, in text or JSON mode', async () => {
    const catalog = SCRAPE_CATALOG;
    const commands: { argv: string[]; fetchFn: typeof fetch; exitCode: number }[] = [
      { argv: ['search', 'scrape this page', '--json'], fetchFn: multiRouteFetch(catalog), exitCode: 0 },
      { argv: ['search', 'scrape this page'], fetchFn: multiRouteFetch(catalog), exitCode: 0 },
      { argv: ['schema', 'firecrawl_scrape', '--json'], fetchFn: multiRouteFetch(catalog), exitCode: 0 },
      { argv: ['schema', 'firecrawl_scrape'], fetchFn: multiRouteFetch(catalog), exitCode: 0 },
      {
        argv: ['call', 'scrapingbee_scrape', '--args-json', '{"url":"https://x.example"}', '--json'],
        fetchFn: multiRouteFetch(catalog, { scrapingbee: [okResponse('{"ok":true}')] }),
        exitCode: 0,
      },
      {
        argv: ['call', 'scrapingbee_scrape', '--args-json', '{"url":"https://x.example"}'],
        fetchFn: multiRouteFetch(catalog, { scrapingbee: [okResponse('{"ok":true}')] }),
        exitCode: 0,
      },
      {
        argv: ['run', 'scrape this page', '--args-json', '{"url":"https://x.example"}', '--json'],
        fetchFn: multiRouteFetch(catalog, { firecrawl: [okResponse('{"ok":true}')] }),
        exitCode: 0,
      },
      {
        argv: ['run', 'scrape this page', '--args-json', '{"url":"https://x.example"}'],
        fetchFn: multiRouteFetch(catalog, { firecrawl: [okResponse('{"ok":true}')] }),
        exitCode: 0,
      },
      // A failing call/run too: the failure paths (including the new --json
      // error envelope) render different text than the success paths do.
      {
        argv: ['call', 'scrapingbee_scrape', '--args-json', '{"url":"https://x.example"}', '--json'],
        fetchFn: multiRouteFetch(catalog, { scrapingbee: [gatewayErrorResponse(503, 'backend_unavailable')] }),
        exitCode: 2,
      },
      {
        argv: ['call', 'scrapingbee_scrape', '--args-json', '{"url":"https://x.example"}'],
        fetchFn: multiRouteFetch(catalog, { scrapingbee: [gatewayErrorResponse(503, 'backend_unavailable')] }),
        exitCode: 2,
      },
      { argv: ['catalog', '--json'], fetchFn: multiRouteFetch(catalog), exitCode: 0 },
      { argv: ['catalog'], fetchFn: multiRouteFetch(catalog), exitCode: 0 },
      { argv: ['doctor', '--json'], fetchFn: multiRouteFetch(catalog), exitCode: 0 },
      { argv: ['doctor'], fetchFn: multiRouteFetch(catalog), exitCode: 0 },
    ];

    for (const { argv, fetchFn, exitCode } of commands) {
      const result = await runCli(argv, baseDeps({ fetchFn }));
      const label = argv.join(' ');
      expect(result.exitCode, label).toBe(exitCode);
      expect(result.stdout.length, label).toBeGreaterThan(0);
      expect(result.stdout, label).not.toContain(SECRET);
      expect(result.stderr, label).not.toContain(SECRET);
    }
  });

  // The failure envelope is new output, and a failure message is exactly where
  // an "unable to authenticate with key X" style message would be tempting.
  it('the --json failure envelope and its stderr twin never carry the API key', async () => {
    const rejectingFetch = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;
    for (const argv of [
      ['catalog', '--json'],
      ['search', 'scrape', '--json'],
      ['schema', 'firecrawl_scrape', '--json'],
      ['call', 'firecrawl_scrape', '--args-json', '{}', '--json'],
      ['run', 'scrape this page', '--args-json', '{}', '--json'],
    ]) {
      const result = await runCli(argv, baseDeps({ fetchFn: rejectingFetch }));
      expect(result.exitCode, argv.join(' ')).toBe(2);
      expect(result.stdout.length, argv.join(' ')).toBeGreaterThan(0);
      expect(result.stdout, argv.join(' ')).not.toContain(SECRET);
      expect(result.stderr, argv.join(' ')).not.toContain(SECRET);
    }
  });
});
