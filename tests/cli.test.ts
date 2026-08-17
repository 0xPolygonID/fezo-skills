import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { NO_MORE_CANDIDATES_REASON, candidatesToRun, resolvePackageVersion, runCli } from '../src/cli.js';
import type { CliDeps } from '../src/cli.js';
import { newSchemaCompiler } from '../src/engine/ajv-instance.js';
import { DEFAULT_GATEWAY_URL } from '../src/engine/credentials.js';
import type { KeychainCommandResult, KeychainRunner } from '../src/engine/credentials.js';
import type { RunSelection } from '../src/engine/rank.js';
import type { ToolCandidate } from '../src/engine/catalog.js';
import { ONE_STEP_COMMANDS, ONE_STEP_DESCRIPTIONS } from '../src/engine/steering.js';

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
    backendCategories: [],
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

// A default-deny-listed backend (providers.ts's DEFAULT_EXCLUDED_BACKENDS),
// with one live, callable method -- so tests can prove `search`/`catalog`
// filter it out, and `call`/`run` refuse it BY NAME rather than falling
// through to a generic tool-not-found/no-match.
const FALAI_BACKEND: WireBackend = {
  backend_id: 'falai',
  billing: { model: 'per_call' },
  methods: [
    {
      name: 'generate',
      path: '/generate',
      description: 'Generate an image from a text prompt.',
      input_schema: {},
      http: { method: 'POST', query: ['prompt'] },
    },
  ],
};

// Two declared `search` providers (`RECOMMENDATIONS.search`'s rank 1 and 2),
// used by the `providers`/`list-providers` tests below. `you` publishes only
// `contents` -- not its declared entry method `you_search` -- so the same
// fixture also covers the "--detail names never returns a row with nothing
// callable on it" fallback.
const SEARCH_PROVIDERS_CATALOG: WireBackend[] = [
  {
    backend_id: 'you',
    billing: { model: 'dynamic' },
    methods: [
      { name: 'contents', path: '/contents', description: 'Fetch the contents of a URL.', input_schema: {} },
      { name: 'research', path: '/research', description: 'Deep research over the web.', input_schema: {} },
      { name: 'research_start', path: '/research_start', description: 'Start a deep research job.', input_schema: {} },
      { name: 'finance_research', path: '/finance_research', description: 'Financial research.', input_schema: {} },
    ],
  },
  {
    backend_id: 'exa',
    billing: { model: 'per_call' },
    methods: [
      { name: 'search', path: '/search', description: 'Neural/semantic search over the web.', input_schema: {} },
    ],
  },
];

// Every declared `search` provider (`RECOMMENDATIONS.search`, all five ranks),
// each publishing just its own declared entry method -- for `--limit`/
// `omitted` truncation, which needs more live rows than the default limit.
const ALL_SEARCH_PROVIDERS_CATALOG: WireBackend[] = [
  { backend_id: 'you', billing: { model: 'dynamic' }, methods: [{ name: 'search', path: '/search', description: 'Search the web.', input_schema: {} }] },
  { backend_id: 'exa', billing: { model: 'per_call' }, methods: [{ name: 'search', path: '/search', description: 'Neural search.', input_schema: {} }] },
  { backend_id: 'brave', billing: { model: 'per_call' }, methods: [{ name: 'search', path: '/search', description: 'Independent-index search.', input_schema: {} }] },
  { backend_id: 'firecrawl', billing: { model: 'per_call' }, methods: [{ name: 'search', path: '/search', description: 'LLM-ready markdown search.', input_schema: {} }] },
  { backend_id: 'geonode', billing: { model: 'per_call' }, methods: [{ name: 'search', path: '/search', description: 'Proxy-backed search.', input_schema: {} }] },
];

// The two top-ranked declared `search` providers, each publishing its entry
// method with a BINDABLE query parameter -- the catalogs above declare
// `input_schema: {}`, which `resolveArgName` cannot resolve an argument name
// out of, so a fan-out over them plans zero lanes and bills nothing. This is
// the minimum catalog a `research` round can actually spend a call against;
// `RECOMMENDATIONS.search` ranks `you` first and `exa` second, so `--fanout 2`
// reaches exactly these two.
const RESEARCH_CATALOG: WireBackend[] = [
  {
    backend_id: 'you',
    billing: { model: 'per_call' },
    methods: [
      {
        name: 'search',
        path: '/search',
        description: 'Search the web.',
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        http: { method: 'GET', query: ['query'] },
      },
    ],
  },
  {
    backend_id: 'exa',
    billing: { model: 'per_call' },
    methods: [
      {
        name: 'search',
        path: '/search',
        description: 'Neural/semantic search over the web.',
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        http: { method: 'GET', query: ['query'] },
      },
    ],
  },
];

/** A search provider's body, in the shape `sniffItems` recognizes. Title is the
 * URL: these tests assert on merging and suppression, not on titles. */
function searchResults(urls: string[]): Response {
  return okResponse(JSON.stringify({ results: urls.map((url) => ({ url, title: url })) }));
}

/** The two lanes a `--fanout 2` round runs, with `b.example` deliberately
 * returned by both providers so a round's result set proves the fusion. */
function researchFetch(): typeof fetch {
  return multiRouteFetch(RESEARCH_CATALOG, {
    you: [searchResults(['https://a.example/one', 'https://b.example/two'])],
    exa: [searchResults(['https://b.example/two', 'https://c.example/three'])],
  });
}

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

  it('excludes a deny-listed backend from results, even when it matches the query', async () => {
    const catalog = [...SCRAPE_CATALOG, FALAI_BACKEND];
    // A query worded to match falai_generate on its own description alone, so
    // whether it appears is entirely down to the deny-list, not term overlap
    // with the other fixtures.
    const query = 'generate an image from a text prompt';

    const excluded = await runCli(['search', query, '--json'], baseDeps({ fetchFn: multiRouteFetch(catalog) }));
    const excludedParsed = JSON.parse(excluded.stdout) as { results: { tool: string }[] };
    expect(excludedParsed.results.some((r) => r.tool === 'falai_generate')).toBe(false);

    // Same query, same catalog, only the env's deny-list differs: proves the
    // absence above is the deny-list's doing, not a term-matching accident.
    const included = await runCli(
      ['search', query, '--json'],
      baseDeps({ fetchFn: multiRouteFetch(catalog), env: { FEZO_URL: 'https://gw.example.com', FEZO_API_KEY: SECRET, FEZO_EXCLUDED_BACKENDS: '' } }),
    );
    const includedParsed = JSON.parse(included.stdout) as { results: { tool: string }[] };
    expect(includedParsed.results.some((r) => r.tool === 'falai_generate')).toBe(true);
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

  // Deny-list enforcement: `call` refuses an excluded backend BY NAME, even
  // though the tool genuinely exists in the live catalog -- see cli.ts's
  // "Deny-list helpers" comment. `falai` is one of providers.ts's
  // DEFAULT_EXCLUDED_BACKENDS, so no env override is needed here.
  it('refuses a deny-listed backend by its exact tool name -- exit 2, backend-excluded, no call made', async () => {
    const catalog = [...SCRAPE_CATALOG, FALAI_BACKEND];
    const fetchFn = multiRouteFetch(catalog);
    const result = await runCli(
      ['call', 'falai_generate', '--args-json', '{"prompt":"a cat"}', '--json'],
      baseDeps({ fetchFn }),
    );
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as { error: { kind: string; message: string } };
    expect(parsed.error.kind).toBe('backend-excluded');
    expect(parsed.error.message).toContain('falai');
    expect(result.stderr).toContain('excluded');
    // Only the catalog GET happened -- the excluded backend was never billed.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // `schema` refuses too, rather than merely filtering. It bills nothing, so
  // this is not a spend guard -- it is so an agent is never handed a full
  // input schema and binding map for a backend `call` will then refuse,
  // which costs two commands to learn one fact. The message names the action
  // actually attempted ("inspected", not "called").
  it('schema refuses a deny-listed backend by name, with the same kind call uses', async () => {
    const catalog = [...SCRAPE_CATALOG, FALAI_BACKEND];
    const fetchFn = multiRouteFetch(catalog);
    const result = await runCli(['schema', 'falai_generate', '--json'], baseDeps({ fetchFn }));

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as { error: { kind: string; message: string } };
    expect(parsed.error.kind).toBe('backend-excluded');
    expect(parsed.error.message).toContain('cannot be inspected');
    // Distinct from tool-not-found: the tool really is in the catalog.
    expect(parsed.error.message).toContain('falai');
  });

  it('schema still serves a non-excluded backend from the same catalog', async () => {
    const catalog = [...SCRAPE_CATALOG, FALAI_BACKEND];
    const result = await runCli(['schema', 'firecrawl_scrape', '--json'], baseDeps({ fetchFn: multiRouteFetch(catalog) }));

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { tool: string };
    expect(parsed.tool).toBe('firecrawl_scrape');
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

  // Deny-list enforcement, `run`'s half: "even when the caller names the tool
  // exactly" (cli.ts's `exactExcludedToolMatch`) -- checked against the FULL
  // catalog before `--allow-unhinted-auto-pick` or any hinted/unhinted
  // selection rule gets a say.
  it('refuses a deny-listed backend named exactly, exit 2, backend-excluded -- --allow-unhinted-auto-pick does not override it', async () => {
    const catalog = [...SCRAPE_CATALOG, FALAI_BACKEND];
    const fetchFn = multiRouteFetch(catalog);
    const result = await runCli(
      ['run', 'falai_generate', '--args-json', '{"prompt":"a cat"}', '--allow-unhinted-auto-pick', '--json'],
      baseDeps({ fetchFn }),
    );
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as { error: { kind: string; message: string } };
    expect(parsed.error.kind).toBe('backend-excluded');
    expect(parsed.error.message).toContain('falai');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a deny-listed backend never enters the ranked/hinted selection either -- it is filtered before selectForRun', async () => {
    // `falai_generate` classifies as `other` (no keyword/category match), so
    // it never competes with scrapingbee/firecrawl for "scrape this page"
    // even when it is not excluded -- the point of this test is that adding
    // it to the catalog changes nothing about which backend `run` picks.
    const catalog = [...SCRAPE_CATALOG, FALAI_BACKEND];
    const fetchFn = multiRouteFetch(catalog, { firecrawl: [okResponse('{"markdown":"hi"}')] });
    const result = await runCli(
      ['run', 'scrape this page', '--args-json', '{"url":"https://x.example"}', '--json'],
      baseDeps({ fetchFn }),
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { chosen: { backendId: string } };
    expect(parsed.chosen.backendId).toBe('firecrawl');
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
// web-search / scrape / crawl (one-step.ts's ranked walk, wired through
// cli.ts). Built against the REAL declared `search`/`scrape`/`crawl` rosters
// (providers.ts), same convention as the `providers`/`list-providers` tests
// below: a synthetic roster would not exercise the policy this port carries.
// ---------------------------------------------------------------------------

describe('web-search / scrape / crawl (one-step commands)', () => {
  const SEARCH_YOU_EXA: WireBackend[] = [
    {
      backend_id: 'you',
      billing: { model: 'dynamic' },
      methods: [
        {
          name: 'search',
          path: '/search',
          description: 'Search the web.',
          input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      ],
    },
    {
      backend_id: 'exa',
      billing: { model: 'per_call' },
      methods: [
        {
          name: 'search',
          path: '/search',
          description: 'Neural search.',
          input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      ],
    },
  ];

  it('requires a query/URL positional argument, exit 1, before any network call', async () => {
    const webSearchFetch = vi.fn();
    const webSearchResult = await runCli(['web-search'], baseDeps({ fetchFn: webSearchFetch as unknown as typeof fetch }));
    expect(webSearchResult.exitCode).toBe(1);
    expect(webSearchResult.stderr).toContain('requires a query');
    expect(webSearchFetch).not.toHaveBeenCalled();

    const scrapeFetch = vi.fn();
    const scrapeResult = await runCli(['scrape'], baseDeps({ fetchFn: scrapeFetch as unknown as typeof fetch }));
    expect(scrapeResult.exitCode).toBe(1);
    expect(scrapeResult.stderr).toContain('requires a URL');
    expect(scrapeFetch).not.toHaveBeenCalled();
  });

  it('an unparseable --extra-json exits 1 before any network call, exactly like --args-json', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(
      ['web-search', 'weather today', '--extra-json', '{not valid json'],
      baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--extra-json');
    expect(result.stderr).toContain('not valid JSON');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a non-object --extra-json (e.g. an array) exits 1 before any network call', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(['web-search', 'weather today', '--extra-json', '[1,2,3]'], baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--extra-json must be a JSON object');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a non-integer/--max-attempts < 1 exits 1 before any network call', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(['scrape', 'https://x.example', '--max-attempts', '0'], baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--max-attempts');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('falls back to the next-ranked provider on a retryable failure, and reports who served it, its rank, and billing as fields under --json', async () => {
    const fetchFn = multiRouteFetch(SEARCH_YOU_EXA, {
      you: [gatewayErrorResponse(503, 'backend_unavailable')],
      exa: [okResponse('{"results":[]}')],
    });

    const result = await runCli(['web-search', 'weather today', '--json'], baseDeps({ fetchFn }));

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      command: string;
      intent: string;
      served: { backend_id: string; provider: string; rank: number; success: boolean };
      arg_rejected: string[];
      skipped: string[];
      attempts: { backendId: string; status: string; billed: boolean }[];
      billed_any_attempt: boolean;
    };
    expect(parsed.command).toBe('web-search');
    expect(parsed.intent).toBe('search');
    expect(parsed.served).toEqual({ backend_id: 'exa', provider: 'Exa', rank: 2, success: true });
    expect(parsed.arg_rejected).toEqual([]);
    expect(parsed.attempts).toHaveLength(2);
    expect(parsed.attempts[0]).toMatchObject({ backendId: 'you', status: 'retry', billed: false });
    expect(parsed.attempts[1]).toMatchObject({ backendId: 'exa', status: 'success', billed: true });
    expect(parsed.billed_any_attempt).toBe(true);
  });

  it('the human-readable view names the serving provider and its rank via steering.ts\'s footer', async () => {
    const fetchFn = multiRouteFetch(SEARCH_YOU_EXA, { you: [okResponse('{"results":[]}')] });
    const result = await runCli(['web-search', 'weather today'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Served by You.com (rank 1 of search)');
  });

  it('--extra-json merges into the resolved candidate\'s own arguments; a provider whose schema rejects the merged args is skipped and reported in arg_rejected even on success', async () => {
    const catalog: WireBackend[] = [
      {
        backend_id: 'you',
        billing: { model: 'dynamic' },
        methods: [
          {
            name: 'search',
            path: '/search',
            description: 'Search the web.',
            input_schema: {
              type: 'object',
              properties: { query: { type: 'string' }, safe_search: { type: 'boolean' } },
              required: ['query', 'safe_search'],
            },
          },
        ],
      },
      {
        backend_id: 'exa',
        billing: { model: 'per_call' },
        methods: [
          {
            name: 'search',
            path: '/search',
            description: 'Neural search.',
            input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          },
        ],
      },
    ];

    // Without --extra-json, "you" locally rejects the args (missing
    // safe_search) and the walk falls to "exa" -- reported in arg_rejected
    // even though the overall run still succeeds.
    const withoutExtra = multiRouteFetch(catalog, { exa: [okResponse('{"ok":true}')] });
    const resultWithout = await runCli(['web-search', 'weather today', '--json'], baseDeps({ fetchFn: withoutExtra }));
    expect(resultWithout.exitCode).toBe(0);
    const parsedWithout = JSON.parse(resultWithout.stdout) as { served: { backend_id: string }; arg_rejected: string[] };
    expect(parsedWithout.served.backend_id).toBe('exa');
    expect(parsedWithout.arg_rejected).toEqual(['You.com']);

    // With --extra-json supplying safe_search, "you" (rank 1) is called directly.
    const withExtra = multiRouteFetch(catalog, { you: [okResponse('{"ok":true}')] });
    const resultWith = await runCli(
      ['web-search', 'weather today', '--extra-json', '{"safe_search":true}', '--json'],
      baseDeps({ fetchFn: withExtra }),
    );
    expect(resultWith.exitCode).toBe(0);
    const parsedWith = JSON.parse(resultWith.stdout) as { served: { backend_id: string }; arg_rejected: string[] };
    expect(parsedWith.served.backend_id).toBe('you');
    expect(parsedWith.arg_rejected).toEqual([]);
  });

  // The other local rejection, end to end and IN THE HUMAN VIEW. Asserting the
  // engine field alone is what let this regress once already: a provider that
  // dropped out because its own manifest needs an argument the command cannot
  // supply was reported in `--json` but invisible without it, since the list it
  // had been folded into is printed only when nothing serves the call. On a
  // SUCCESSFUL run -- the case that matters, because the caller otherwise sees
  // only who did serve them -- both views must name it.
  it('a provider whose manifest needs an unsuppliable argument is named in both views, on a successful run', async () => {
    const catalog: WireBackend[] = [
      {
        backend_id: 'you',
        billing: { model: 'dynamic' },
        methods: [
          {
            // Passes its own input_schema, then fails in bindArgs: nothing
            // supplies the `{id}` path parameter.
            name: 'search',
            path: '/search/{id}',
            description: 'Search the web.',
            http: { method: 'POST', path_params: ['id'] },
            input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          },
        ],
      },
      {
        backend_id: 'exa',
        billing: { model: 'per_call' },
        methods: [
          {
            name: 'search',
            path: '/search',
            description: 'Neural search.',
            input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          },
        ],
      },
    ];

    const asJson = await runCli(
      ['web-search', 'weather today', '--json'],
      baseDeps({ fetchFn: multiRouteFetch(catalog, { exa: [okResponse('{"ok":true}')] }) }),
    );
    expect(asJson.exitCode).toBe(0);
    const parsed = JSON.parse(asJson.stdout) as {
      served: { backend_id: string };
      arg_rejected: string[];
      manifest_rejected: string[];
    };
    expect(parsed.served.backend_id).toBe('exa');
    expect(parsed.manifest_rejected).toEqual(['You.com']);
    // Never blamed on the caller, who passed no --extra-json at all.
    expect(parsed.arg_rejected).toEqual([]);

    const asText = await runCli(
      ['web-search', 'weather today'],
      baseDeps({ fetchFn: multiRouteFetch(catalog, { exa: [okResponse('{"ok":true}')] }) }),
    );
    expect(asText.exitCode).toBe(0);
    expect(asText.stdout).toContain('Skipped You.com');
    expect(asText.stdout).toContain("manifest requires an argument");
    // The wording must not send the caller to an argument they never passed.
    expect(asText.stdout).not.toContain('the --extra-json arguments did not match');
  });

  it('no provider could serve it: `served` is absent, skipped providers are named, exit 2', async () => {
    const fetchFn = multiRouteFetch([]);
    const result = await runCli(['scrape', 'https://x.example', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as { served?: unknown; skipped: string[] };
    expect(parsed.served).toBeUndefined();
    expect(parsed.skipped.length).toBeGreaterThan(0);
    expect(parsed.skipped).toContain('scrapingdog (not in catalog)');
  });

  it('a deny-listed provider is never attempted, even ranked first, and FEZO_EXCLUDED_BACKENDS controls it', async () => {
    const fetchFn = multiRouteFetch(SEARCH_YOU_EXA, { exa: [okResponse('{"results":[]}')] });
    const result = await runCli(
      ['web-search', 'weather today', '--json'],
      baseDeps({ fetchFn, env: { FEZO_URL: 'https://gw.example.com', FEZO_API_KEY: SECRET, FEZO_EXCLUDED_BACKENDS: 'you' } }),
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { served: { backend_id: string }; attempts: { backendId: string }[] };
    expect(parsed.served.backend_id).toBe('exa');
    expect(parsed.attempts.map((a) => a.backendId)).toEqual(['exa']);
  });

  it('--max-attempts defaults to 3 (MAX_PROVIDER_ATTEMPTS), not run\'s default of 2, and stopped_by/the cap note are reported when it is what stops the walk', async () => {
    const catalog = ALL_SEARCH_PROVIDERS_CATALOG.map((backend) => ({
      ...backend,
      methods: backend.methods.map((m) => ({
        ...m,
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      })),
    }));
    const fetchFn = multiRouteFetch(catalog, {
      you: [gatewayErrorResponse(500, 'backend_error')],
      exa: [gatewayErrorResponse(500, 'backend_error')],
      brave: [gatewayErrorResponse(500, 'backend_error')],
      // firecrawl/geonode deliberately have NO queued response: reaching
      // either would throw inside `multiRouteFetch`, catching a cap that let
      // the walk run one attempt too many.
    });

    const result = await runCli(['web-search', 'weather today', '--json'], baseDeps({ fetchFn }));

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as {
      served: { backend_id: string; provider: string; rank: number; success: boolean };
      stopped_by?: string;
      attempts: unknown[];
      max_attempts: number;
    };
    expect(parsed.max_attempts).toBe(3);
    expect(parsed.attempts).toHaveLength(3);
    expect(parsed.served).toEqual({ backend_id: 'brave', provider: 'Brave Search', rank: 3, success: false });
    expect(parsed.stopped_by).toBe('max-attempts');
    expect(result.stdout).not.toContain('Stopped on the time budget');

    const textResult = await runCli(['web-search', 'weather today'], baseDeps({ fetchFn: multiRouteFetch(catalog, {
      you: [gatewayErrorResponse(500, 'backend_error')],
      exa: [gatewayErrorResponse(500, 'backend_error')],
      brave: [gatewayErrorResponse(500, 'backend_error')],
    }) }));
    expect(textResult.stdout).toContain('Stopped after 3 provider(s)');
  });

  it('crawl walks the declared `crawl` roster with a url-kind argument', async () => {
    const catalog: WireBackend[] = [
      {
        backend_id: 'firecrawl',
        billing: { model: 'per_call' },
        methods: [
          {
            name: 'crawl',
            path: '/crawl',
            description: 'Crawl a site.',
            input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
          },
        ],
      },
    ];
    const fetchFn = multiRouteFetch(catalog, { firecrawl: [okResponse('{"job_id":"1"}')] });
    const result = await runCli(['crawl', 'https://x.example', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { command: string; intent: string; served: { backend_id: string } };
    expect(parsed.command).toBe('crawl');
    expect(parsed.intent).toBe('crawl');
    expect(parsed.served.backend_id).toBe('firecrawl');
  });

  it('HELP_TEXT documents the three one-step commands and --extra-json', async () => {
    const result = await runCli(['--help'], {});
    expect(result.stdout).toContain('web-search');
    expect(result.stdout).toContain('fezoctl scrape');
    expect(result.stdout).toContain('fezoctl crawl');
    expect(result.stdout).toContain('--extra-json');
  });

  // The one-step descriptions are shared data (steering.ts, also rendered into
  // SKILL.md), so HELP_TEXT cannot hand-wrap them and must not paste them raw
  // either: they were once interpolated straight into the middle of the
  // --max-attempts sentence, which printed three ~150-column lines inside a
  // 78-column block and split that sentence in half. Both halves are asserted
  // here — the wording survives, and the block stays hard-wrapped.
  it('HELP_TEXT renders each one-step description as its own wrapped, labelled block', async () => {
    const result = await runCli(['--help'], {});
    const flat = result.stdout.replace(/\s+/g, ' ');
    for (const command of ONE_STEP_COMMANDS) {
      expect(flat, `--help does not carry the ${command} description`).toContain(ONE_STEP_DESCRIPTIONS[command]);
    }
    // The interrupted sentence, whole again.
    expect(flat).toContain("NOT run's default of 2: run's budget is a RETRY budget");
    // Everything after the usage block is hard-wrapped prose. The usage block
    // itself is exempt: those lines are command signatures whose shape is the
    // information, and wrapping one would misrepresent the grammar.
    const prose = result.stdout.slice(result.stdout.indexOf('  fezoctl --help\n'));
    const overlong = prose.split('\n').filter((line) => line.length > 78);
    expect(overlong, `HELP_TEXT lines wider than 78 columns: ${overlong.join(' | ')}`).toEqual([]);
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
      reason: { kind: 'ambiguous-capability', capabilities: ['scrape', 'web-search'] },
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

  it('excludes a default-deny-listed backend, and honours FEZO_EXCLUDED_BACKENDS="" to include it again', async () => {
    const catalog = [...SCRAPE_CATALOG, FALAI_BACKEND];

    const withDefault = await runCli(['catalog', '--json'], baseDeps({ fetchFn: multiRouteFetch(catalog) }));
    const withDefaultParsed = JSON.parse(withDefault.stdout) as { backends: { backendId: string }[] };
    expect(withDefaultParsed.backends.map((b) => b.backendId).sort()).toEqual(['firecrawl', 'scrapingbee']);

    const withOverride = await runCli(
      ['catalog', '--json'],
      baseDeps({ fetchFn: multiRouteFetch(catalog), env: { FEZO_URL: 'https://gw.example.com', FEZO_API_KEY: SECRET, FEZO_EXCLUDED_BACKENDS: '' } }),
    );
    const withOverrideParsed = JSON.parse(withOverride.stdout) as { backends: { backendId: string }[] };
    expect(withOverrideParsed.backends.map((b) => b.backendId).sort()).toEqual(['falai', 'firecrawl', 'scrapingbee']);
  });
});

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

interface ProvidersJson {
  recommendations: { doc: string; preparedAt: string };
  note?: string;
  groups?: { capability: string; best_value?: string; omitted: number; providers: Record<string, unknown>[] }[];
  capability?: string;
  best_value?: string;
  omitted?: number;
  providers?: Record<string, unknown>[];
}

describe('providers', () => {
  it('with no --intent, returns every capability group in INTENTS order, with the NOT_SUBSTITUTES_NOTE', async () => {
    const fetchFn = multiRouteFetch(SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(['providers', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as ProvidersJson;
    expect(parsed.groups?.map((g) => g.capability)).toEqual(['search', 'scrape', 'crawl', 'news', 'social', 'proxy', 'other']);
    expect(parsed.note).toBeDefined();
    expect(parsed.recommendations.doc).toBe('docs/providers-score.md');
  });

  it('with --intent, returns exactly that one group, no groups wrapper and no note', async () => {
    const fetchFn = multiRouteFetch(SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(['providers', '--intent', 'search', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as ProvidersJson;
    expect(parsed.capability).toBe('search');
    expect(parsed.groups).toBeUndefined();
    expect(parsed.note).toBeUndefined();
    // Declared order: you (rank 1) is present and is not on the deny-list, so
    // it is the group's bestValue -- see provider-view.ts's groupByCapability.
    expect(parsed.best_value).toBe('you');
    expect(parsed.providers?.map((p) => p['backend_id'])).toEqual(['you', 'exa']);
  });

  it('unknown --intent is a usage error, exit 1, before any network call', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(
      ['providers', '--intent', 'bogus-intent', '--json'],
      baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
    );
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { error: { kind: string } };
    expect(parsed.error.kind).toBe('usage');
    expect(result.stderr).toContain('--intent');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('unknown --detail is a usage error, exit 1, before any network call', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(
      ['providers', '--detail', 'verbose', '--json'],
      baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
    );
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { error: { kind: string } };
    expect(parsed.error.kind).toBe('usage');
    expect(result.stderr).toContain('--detail');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a non-numeric or <1 --limit is a usage error, exit 1, before any network call', async () => {
    const fetchFn = vi.fn();
    for (const badLimit of ['zero', '0', '-1']) {
      const result = await runCli(
        ['providers', '--limit', badLimit, '--json'],
        baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
      );
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout) as { error: { kind: string } };
      expect(parsed.error.kind).toBe('usage');
      expect(result.stderr).toContain('--limit');
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('--detail names (the default): a provider with no live entry method still shows a few callable methods, never nothing', async () => {
    // `you` publishes no `you_search` (SEARCH_PROVIDERS_CATALOG), so its
    // declared search entry method is absent from the live catalog.
    const fetchFn = multiRouteFetch(SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(['providers', '--intent', 'search', '--json'], baseDeps({ fetchFn }));
    const parsed = JSON.parse(result.stdout) as ProvidersJson;
    const you = parsed.providers?.find((p) => p['backend_id'] === 'you') as { entry_methods: string[]; methods?: string[] } | undefined;
    expect(you?.entry_methods).toEqual([]);
    expect(you?.methods).toBeDefined();
    expect(you?.methods?.length).toBeGreaterThan(0);
    expect(you?.methods?.length).toBeLessThanOrEqual(3);

    // exa DOES publish its declared entry method, so no fallback needed.
    const exa = parsed.providers?.find((p) => p['backend_id'] === 'exa') as { entry_methods: string[]; methods?: string[] } | undefined;
    expect(exa?.entry_methods).toEqual(['exa_search']);
    expect(exa?.methods).toBeUndefined();
  });

  it('--detail descriptions: adds why/when and the FULL method list, uncapped', async () => {
    const fetchFn = multiRouteFetch(SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(['providers', '--intent', 'search', '--detail', 'descriptions', '--json'], baseDeps({ fetchFn }));
    const parsed = JSON.parse(result.stdout) as ProvidersJson;
    const you = parsed.providers?.find((p) => p['backend_id'] === 'you') as { why: string; methods: string[] } | undefined;
    expect(you?.why).toBeDefined();
    // `you`'s 4 live methods, none dropped -- distinct from the capped
    // `--detail names` fallback above.
    expect(you?.methods).toEqual(['you_contents', 'you_finance_research', 'you_research', 'you_research_start']);
  });

  it('--detail schema: adds method_schemas, keyed by tool name, for the provider\'s methods', async () => {
    const fetchFn = multiRouteFetch(SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(['providers', '--intent', 'search', '--detail', 'schema', '--json'], baseDeps({ fetchFn }));
    const parsed = JSON.parse(result.stdout) as ProvidersJson;
    const exa = parsed.providers?.find((p) => p['backend_id'] === 'exa') as { method_schemas: Record<string, unknown> } | undefined;
    expect(exa?.method_schemas).toBeDefined();
    expect(Object.keys(exa?.method_schemas ?? {})).toContain('exa_search');
  });

  // The `names`-level fallback method list is capped at three, and the cap has
  // to be VISIBLE in both views. The human view prints `(+N more)`; the wire
  // shape carries `methods_omitted`. Without the latter there is no way to
  // tell three methods from three-of-nine in --json — which is this repo's
  // stated `omitted` rule (render.ts), applied to the same cap it already
  // applies to `--limit`. `you` publishes four methods here and none of them
  // is its declared entry method `you_search`, so it takes the fallback path.
  it('--detail names reports what the fallback method cap dropped, in both views', async () => {
    const json = await runCli(
      ['providers', '--intent', 'search', '--json'],
      baseDeps({ fetchFn: multiRouteFetch(SEARCH_PROVIDERS_CATALOG) }),
    );
    const parsed = JSON.parse(json.stdout) as ProvidersJson;
    const you = parsed.providers?.find((p) => p['backend_id'] === 'you') as
      | { entry_methods: string[]; methods?: string[]; methods_omitted?: number }
      | undefined;
    expect(you?.entry_methods).toEqual([]);
    expect(you?.methods).toHaveLength(3);
    expect(you?.methods_omitted).toBe(1);

    const text = await runCli(
      ['providers', '--intent', 'search'],
      baseDeps({ fetchFn: multiRouteFetch(SEARCH_PROVIDERS_CATALOG) }),
    );
    expect(text.stdout).toContain('(+1 more)');
  });

  it('omits methods_omitted entirely when the cap dropped nothing', async () => {
    const result = await runCli(
      ['providers', '--intent', 'search', '--json'],
      baseDeps({ fetchFn: multiRouteFetch(ALL_SEARCH_PROVIDERS_CATALOG) }),
    );
    const parsed = JSON.parse(result.stdout) as ProvidersJson;
    // Every provider here publishes its declared entry method, so no row takes
    // the fallback path at all.
    for (const row of parsed.providers ?? []) {
      expect(Object.hasOwn(row, 'methods_omitted')).toBe(false);
    }
  });

  // HELP_TEXT and README both promise `--explain` adds provenance to EVERY
  // row. `names` is the DEFAULT detail level, so a `source` that attached only
  // at `descriptions` made the flag a no-op on the most common --json path
  // while the human view printed it -- documented behavior the code did not
  // have. Pinned at the default level for that reason.
  it('--explain adds the recommendation source citation at the DEFAULT detail level', async () => {
    const fetchFn = multiRouteFetch(SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(['providers', '--intent', 'search', '--explain', '--json'], baseDeps({ fetchFn }));
    const parsed = JSON.parse(result.stdout) as ProvidersJson;
    const you = parsed.providers?.find((p) => p['backend_id'] === 'you') as { source?: { doc: string; prepared: string } } | undefined;
    expect(you?.source).toEqual({ doc: 'docs/providers-score.md', prepared: '2026-08-05' });

    const without = await runCli(
      ['providers', '--intent', 'search', '--json'],
      baseDeps({ fetchFn: multiRouteFetch(SEARCH_PROVIDERS_CATALOG) }),
    );
    const withoutParsed = JSON.parse(without.stdout) as ProvidersJson;
    const youNo = withoutParsed.providers?.find((p) => p['backend_id'] === 'you') as { source?: unknown } | undefined;
    expect(Object.hasOwn(youNo ?? {}, 'source')).toBe(false);
  });

  it('--explain adds the recommendation source citation at descriptions detail too', async () => {
    const fetchFn = multiRouteFetch(SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(
      ['providers', '--intent', 'search', '--detail', 'descriptions', '--explain', '--json'],
      baseDeps({ fetchFn }),
    );
    const parsed = JSON.parse(result.stdout) as ProvidersJson;
    const you = parsed.providers?.find((p) => p['backend_id'] === 'you') as { source?: { doc: string; prepared: string } } | undefined;
    expect(you?.source).toEqual({ doc: 'docs/providers-score.md', prepared: '2026-08-05' });

    const withoutExplain = await runCli(
      ['providers', '--intent', 'search', '--detail', 'descriptions', '--json'],
      baseDeps({ fetchFn: multiRouteFetch(SEARCH_PROVIDERS_CATALOG) }),
    );
    const withoutExplainParsed = JSON.parse(withoutExplain.stdout) as ProvidersJson;
    const youNoExplain = withoutExplainParsed.providers?.find((p) => p['backend_id'] === 'you') as { source?: unknown } | undefined;
    expect(Object.hasOwn(youNoExplain ?? {}, 'source')).toBe(false);
  });

  it('--limit caps each group and reports what it dropped as "omitted", never silently', async () => {
    const fetchFn = multiRouteFetch(ALL_SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(['providers', '--intent', 'search', '--limit', '2', '--json'], baseDeps({ fetchFn }));
    const parsed = JSON.parse(result.stdout) as ProvidersJson;
    expect(parsed.providers).toHaveLength(2);
    expect(parsed.providers?.map((p) => p['backend_id'])).toEqual(['you', 'exa']);
    expect(parsed.omitted).toBe(3);

    // Human output must surface the same count, not just the JSON shape.
    const humanResult = await runCli(['providers', '--intent', 'search', '--limit', '2'], baseDeps({ fetchFn: multiRouteFetch(ALL_SEARCH_PROVIDERS_CATALOG) }));
    expect(humanResult.stdout).toContain('omitted: 3');
  });

  it('the deny-list removes a backend from providers output, and FEZO_EXCLUDED_BACKENDS="" restores it', async () => {
    const excludedResult = await runCli(
      ['providers', '--intent', 'search', '--json'],
      baseDeps({
        fetchFn: multiRouteFetch(SEARCH_PROVIDERS_CATALOG),
        env: { FEZO_URL: 'https://gw.example.com', FEZO_API_KEY: SECRET, FEZO_EXCLUDED_BACKENDS: 'exa' },
      }),
    );
    const excludedParsed = JSON.parse(excludedResult.stdout) as ProvidersJson;
    expect(excludedParsed.providers?.map((p) => p['backend_id'])).toEqual(['you']);

    const restoredResult = await runCli(
      ['providers', '--intent', 'search', '--json'],
      baseDeps({
        fetchFn: multiRouteFetch(SEARCH_PROVIDERS_CATALOG),
        env: { FEZO_URL: 'https://gw.example.com', FEZO_API_KEY: SECRET, FEZO_EXCLUDED_BACKENDS: '' },
      }),
    );
    const restoredParsed = JSON.parse(restoredResult.stdout) as ProvidersJson;
    expect(restoredParsed.providers?.map((p) => p['backend_id'])).toEqual(['you', 'exa']);
  });

  it('without --json, prints a human-readable rank/tier/provider/why summary', async () => {
    const fetchFn = multiRouteFetch(SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(['providers', '--intent', 'search'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[primary]');
    expect(result.stdout).toContain('You.com');
    expect(result.stdout).toContain('best_value: you');
  });
});

// ---------------------------------------------------------------------------
// list-providers
// ---------------------------------------------------------------------------

interface ListProvidersJson {
  recommendations: { doc: string; preparedAt: string };
  providers: { backend_id: string; recommendations: { intent: string; rank: number }[] }[];
}

describe('list-providers', () => {
  it('one row per non-excluded catalog backend, each carrying its declared standing per intent', async () => {
    const fetchFn = multiRouteFetch(SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(['list-providers', '--json'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as ListProvidersJson;
    expect(parsed.recommendations.doc).toBe('docs/providers-score.md');
    expect(parsed.providers.map((p) => p.backend_id).sort()).toEqual(['exa', 'you']);
    const you = parsed.providers.find((p) => p.backend_id === 'you');
    expect(you?.recommendations.some((r) => r.intent === 'search')).toBe(true);
  });

  it('the deny-list removes a backend entirely, and FEZO_EXCLUDED_BACKENDS="" restores it', async () => {
    const excludedResult = await runCli(
      ['list-providers', '--json'],
      baseDeps({
        fetchFn: multiRouteFetch(SEARCH_PROVIDERS_CATALOG),
        env: { FEZO_URL: 'https://gw.example.com', FEZO_API_KEY: SECRET, FEZO_EXCLUDED_BACKENDS: 'exa' },
      }),
    );
    const excludedParsed = JSON.parse(excludedResult.stdout) as ListProvidersJson;
    expect(excludedParsed.providers.map((p) => p.backend_id)).toEqual(['you']);

    const restoredResult = await runCli(
      ['list-providers', '--json'],
      baseDeps({
        fetchFn: multiRouteFetch(SEARCH_PROVIDERS_CATALOG),
        env: { FEZO_URL: 'https://gw.example.com', FEZO_API_KEY: SECRET, FEZO_EXCLUDED_BACKENDS: '' },
      }),
    );
    const restoredParsed = JSON.parse(restoredResult.stdout) as ListProvidersJson;
    expect(restoredParsed.providers.map((p) => p.backend_id).sort()).toEqual(['exa', 'you']);
  });

  it('without --json, prints a human-readable per-provider summary with declared-rank recommendations', async () => {
    const fetchFn = multiRouteFetch(SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(['list-providers'], baseDeps({ fetchFn }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('You.com');
    expect(result.stdout).toContain('declared rank');
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

  it('warns about a declared entry method missing from an otherwise-present backend, distinctly from an absent backend', async () => {
    // SEARCH_PROVIDERS_CATALOG's `you` publishes `contents`/`research`/etc.
    // but never `search` -- so `you` itself IS in the live catalog (as
    // `you_contents` and friends), yet its declared `search` entry method
    // (`you_search`) is not one of its published tool names. This is the
    // case the pre-Phase-4 check could not see at all: it only compared
    // backend ids, never entry-method names.
    const fetchFn = multiRouteFetch(SEARCH_PROVIDERS_CATALOG);
    const result = await runCli(['doctor', '--json'], baseDeps({ fetchFn }));
    const parsed = JSON.parse(result.stdout) as {
      checks: { name: string; status: string; details?: { missingBackends: string[]; missingEntryMethods: string[] } }[];
    };
    const prefCheck = parsed.checks.find((c) => c.name === 'preference-hints');
    expect(prefCheck?.status).toBe('warn');
    expect(prefCheck?.details?.missingBackends).not.toContain('you');
    expect(prefCheck?.details?.missingEntryMethods).toContain('you_search');
    // `exa` DOES publish its declared entry method (`exa_search`), so it must
    // appear in neither list.
    expect(prefCheck?.details?.missingBackends).not.toContain('exa');
    expect(prefCheck?.details?.missingEntryMethods).not.toContain('exa_search');
  });

  it('reports a missing API key as a hard failure and skips the connectivity checks', async () => {
    const result = await runCli(['doctor', '--json'], { env: {}, dotEnvPath: '/nonexistent/.env' });
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.stdout) as {
      checks: { name: string; status: string; message: string; details?: { url?: { value: string; source: string } } }[];
    };
    const byName = new Map(parsed.checks.map((c) => [c.name, c]));
    // The URL cannot fail -- it always resolves -- so the key is the only
    // credential that can stop `doctor` here. The check still has to SAY that
    // nobody configured a gateway, which is what its message and source carry.
    const gatewayUrl = byName.get('gateway-url');
    expect(gatewayUrl?.status).toBe('ok');
    expect(gatewayUrl?.message).toBe('FEZO_URL is not configured; using the built-in default gateway');
    expect(gatewayUrl?.details?.url).toEqual({ value: DEFAULT_GATEWAY_URL, source: 'default' });
    expect(byName.get('api-key')?.status).toBe('fail');
    expect(byName.get('gateway-connectivity')?.status).toBe('skipped');
  });

  it('names the source when a gateway URL WAS configured, so the default is distinguishable', async () => {
    const result = await runCli(['doctor', '--json'], { env: { FEZO_URL: 'https://gw.example.com' }, dotEnvPath: '/nonexistent/.env' });
    const parsed = JSON.parse(result.stdout) as { checks: { name: string; status: string; message: string }[] };
    const gatewayUrl = parsed.checks.find((c) => c.name === 'gateway-url');
    expect(gatewayUrl?.status).toBe('ok');
    expect(gatewayUrl?.message).toBe('FEZO_URL resolved from env');
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
  // Since the gateway URL grew a built-in default, the *outcome* of that recipe
  // is no longer broken -- the next command works -- but the reason the fix
  // existed still holds and is what these two assert: the URL in effect is
  // always stated, WITH its source, so "you are on the built-in gateway" can
  // never be mistaken for "you configured this one".
  // ---------------------------------------------------------------------------
  it('without --url (and with no FEZO_URL), setup falls back to the default gateway and exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-setup-nourl-'));
    try {
      const dotEnvPath = join(dir, '.env');
      const result = await runCli(['setup', '--key-stdin'], {
        stdin: Readable.from([Buffer.from(`${SECRET}\n`)]),
        dotEnvPath,
        env: {},
      });

      expect(result.stdout).toContain('api key: stored');
      expect(readFileSync(dotEnvPath, 'utf8')).toContain(`FEZO_API_KEY=${SECRET}`);

      // The URL in effect is named, and so is the fact that nobody chose it.
      expect(result.stdout).toContain(`configured url: ${DEFAULT_GATEWAY_URL} (source: default)`);
      expect(result.stdout).not.toContain('NOT usable');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stderr).not.toContain(SECRET);

      // The end-to-end claim, inverted from what it used to be: this really is
      // a complete configuration, so the next command gets as far as the
      // gateway rather than refusing on credentials.
      const next = await runCli(['catalog'], { dotEnvPath, env: {}, fetchFn: multiRouteFetch([]) });
      expect(next.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--json reports the default-sourced URL and `usable: true`, with no second document on stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-setup-nourl-json-'));
    try {
      const dotEnvPath = join(dir, '.env');
      const result = await runCli(['setup', '--key-stdin', '--json'], {
        stdin: Readable.from([Buffer.from(`${SECRET}\n`)]),
        dotEnvPath,
        env: {},
      });
      expect(result.exitCode).toBe(0);
      // Still ONE JSON document (JSON.parse would throw on two concatenated).
      const parsed = JSON.parse(result.stdout) as {
        usable: boolean;
        result: { apiKey: { ok: boolean } };
        configured: { url?: { value: string; source: string }; apiKey?: { masked: string } };
      };
      expect(parsed.result.apiKey.ok).toBe(true);
      expect(parsed.usable).toBe(true);
      // A machine reader can tell a defaulted URL from a chosen one without
      // parsing prose -- `source` is the field that carries it.
      expect(parsed.configured.url).toEqual({ value: DEFAULT_GATEWAY_URL, source: 'default' });
      expect(parsed.configured.apiKey?.masked).toBe('sk-c…');
      expect(result.stdout).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The condition `usable` actually tracks now: the API key. An empty stdin
  // (the `!`-command case build/step0.md warns about) stores nothing.
  it('reports an unusable configuration, and exits non-zero, when no API key was supplied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-setup-nokey-'));
    try {
      const dotEnvPath = join(dir, '.env');
      const result = await runCli(['setup', '--key-stdin'], {
        stdin: Readable.from([Buffer.from('')]),
        dotEnvPath,
        env: {},
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain('api key: failed (no API key was provided; nothing was stored)');
      expect(result.stdout).toContain('configured api key: (not configured)');
      expect(result.stdout).toContain('this configuration is NOT usable yet: fezoctl needs an API key.');
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

  // ---------------------------------------------------------------------------
  // `setup` takes one input: the key, on stdin. `--key-stdin` used to be
  // mandatory, which made every caller restate the only channel the command has
  // ever read from. Dropping the requirement removes a word, not a safeguard --
  // the property that matters is that NO flag, argument, or prompt accepts a
  // key, and that is what these pin.
  // ---------------------------------------------------------------------------
  it('reads the key from stdin with no flags at all, defaulting to dotenv storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-setup-bare-'));
    try {
      const dotEnvPath = join(dir, '.env');
      const result = await runCli(['setup'], {
        stdin: Readable.from([Buffer.from(`${SECRET}\n`)]),
        dotEnvPath,
        env: {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('setup — storage: dotenv');
      expect(result.stdout).toContain('api key: stored');
      expect(readFileSync(dotEnvPath, 'utf8')).toContain(`FEZO_API_KEY=${SECRET}`);
      expect(result.stdout).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Every recipe in circulation -- including installed copies of SKILL.md that
  // this repo cannot update -- passes `--key-stdin`. It must stay a no-op, not
  // become an unknown flag.
  it('still accepts an explicit --key-stdin, with an identical result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-setup-explicit-'));
    try {
      const dotEnvPath = join(dir, '.env');
      const result = await runCli(['setup', '--key-stdin'], {
        stdin: Readable.from([Buffer.from(`${SECRET}\n`)]),
        dotEnvPath,
        env: {},
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(dotEnvPath, 'utf8')).toContain(`FEZO_API_KEY=${SECRET}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never accepts a key via a CLI flag', async () => {
    const result = await runCli(['setup', '--api-key', SECRET], { env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown flag: --api-key');
  });

  // The failure mode "setup takes only the API key" invites: typing the key as
  // an argument. Silently ignoring it would fail with "no API key was provided"
  // while the key sat in shell history and `ps`.
  it('refuses a positional argument, and says the leaked value should be rotated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-setup-positional-'));
    try {
      const dotEnvPath = join(dir, '.env');
      const result = await runCli(['setup', SECRET], {
        stdin: Readable.from([Buffer.from(`${SECRET}\n`)]),
        dotEnvPath,
        env: {},
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('takes no positional arguments');
      expect(result.stderr).toContain('rotate it');
      // Refused BEFORE any write -- a key that arrived through argv is never
      // stored, however convenient that would be.
      expect(existsSync(dotEnvPath)).toBe(false);
      expect(result.stderr).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  it('search, schema, call, run, plan, research, catalog, and doctor never print the raw API key, in text or JSON mode', async () => {
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
      // `plan` never reaches the network, but it renders the round the
      // credentials would have paid for; `research` renders a full attempt log,
      // which is exactly where a request's own headers would be tempting to
      // echo.
      { argv: ['plan', 'merkle tree proofs', '--json'], fetchFn: multiRouteFetch(catalog), exitCode: 0 },
      { argv: ['plan', 'merkle tree proofs'], fetchFn: multiRouteFetch(catalog), exitCode: 0 },
      { argv: ['research', 'merkle tree proofs', '--fanout', '2', '--json'], fetchFn: researchFetch(), exitCode: 0 },
      { argv: ['research', 'merkle tree proofs', '--fanout', '2'], fetchFn: researchFetch(), exitCode: 0 },
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

// ---------------------------------------------------------------------------
// plan / research (Task 12: smart-routing CLI wiring)
// ---------------------------------------------------------------------------

describe('fezoctl plan', () => {
  it('prints a plan without touching the network', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(['plan', 'what is a merkle tree', '--json'], baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).intents).toContain('search');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('requires a prompt', async () => {
    expect((await runCli(['plan'], baseDeps())).exitCode).toBe(1);
  });
});

describe('fezoctl research', () => {
  it('rejects a malformed --plan-json with a usage error before any call', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(
      ['research', 'x', '--plan-json', '{not json'],
      baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
    );
    expect(result.exitCode).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects an unknown key in --plan-json', async () => {
    const result = await runCli(['research', 'x', '--plan-json', '{"nonsense":1}'], baseDeps());
    expect(result.exitCode).toBe(1);
  });

  it('rejects an invalid --session id before any call', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(
      ['research', 'x', '--session', '../escape'],
      baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
    );
    expect(result.exitCode).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric --fanout', async () => {
    expect((await runCli(['research', 'x', '--fanout', 'wide'], baseDeps())).exitCode).toBe(1);
  });

  it('emits a JSON error envelope on failure with --json', async () => {
    const result = await runCli(['research', 'x', '--fanout', 'wide', '--json'], baseDeps());
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.kind).toBeTruthy();
  });

  // `--intent` is `providers`' flag and `--intents` is routing's. The parser
  // accepts any known flag for any command, so the singular would otherwise
  // parse, be dropped, and bill a round routed by the heuristic's intents
  // rather than the caller's.
  it('rejects the singular --intent, before any call, pointing at the plural', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(['research', 'latest news', '--intent', 'news'], baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--intents news');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The billed `research` path: everything past the usage gate -- openGateway,
// the fan-out, session load/save, and the render.
// ---------------------------------------------------------------------------

describe('fezoctl research (the billed path)', () => {
  it('fuses two providers into one result set, persists the session, and suppresses it next round', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fezoctl-cli-research-home-'));
    try {
      const argv = ['research', 'merkle tree proofs', '--fanout', '2', '--session', 'round-1', '--json'];
      const first = await runCli(argv, baseDeps({ homeDir: home, fetchFn: researchFetch() }));
      expect(first.exitCode).toBe(0);

      const firstDoc = JSON.parse(first.stdout) as {
        items: { url: string; providers: { backend_id: string }[] }[];
        coverage: { served: string[]; suppressed: number };
        billing: { calls_billed: number };
        session: { id: string } | null;
        next_actions: { cmd: string }[];
      };
      expect(firstDoc.items.map((item) => item.url).sort()).toEqual([
        'https://a.example/one',
        'https://b.example/two',
        'https://c.example/three',
      ]);
      // The one URL both providers returned is ONE item carrying both of them,
      // which is what the fan-out exists to produce.
      const shared = firstDoc.items.find((item) => item.url === 'https://b.example/two');
      expect(shared?.providers.map((p) => p.backend_id).sort()).toEqual(['exa', 'you']);
      expect(firstDoc.coverage.served.sort()).toEqual(['exa', 'you']);
      expect(firstDoc.billing.calls_billed).toBe(2);
      expect(firstDoc.session).toEqual({ id: 'round-1' });

      const sessionFile = join(home, '.cache', 'fezo', 'sessions', 'round-1.json');
      const saved = JSON.parse(readFileSync(sessionFile, 'utf8')) as { id: string; seenUrls: string[]; queries: string[]; callsBilled: number };
      expect(saved.id).toBe('round-1');
      expect(saved.seenUrls.sort()).toEqual([
        'https://a.example/one',
        'https://b.example/two',
        'https://c.example/three',
      ]);
      expect(saved.queries).toContain('merkle tree proofs');
      expect(saved.callsBilled).toBe(2);

      // Round two, same id, same provider bodies: nothing new to read, and the
      // billing counter accumulates ACROSS rounds rather than restarting.
      const second = await runCli(argv, baseDeps({ homeDir: home, fetchFn: researchFetch() }));
      expect(second.exitCode).toBe(0);
      const secondDoc = JSON.parse(second.stdout) as { items: unknown[]; coverage: { suppressed: number }; billing: { calls_billed: number } };
      expect(secondDoc.coverage.suppressed).toBe(firstDoc.items.length);
      expect(secondDoc.items).toEqual([]);
      expect(secondDoc.billing.calls_billed).toBe(2);
      const after = JSON.parse(readFileSync(sessionFile, 'utf8')) as { callsBilled: number };
      expect(after.callsBilled).toBe(4);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The round is already paid for by the time the cache is written, so a cache
  // this round cannot persist must cost the caller the NEXT round's
  // suppression -- never this round's results. Before the fix `saveSession`
  // ran unguarded AND before the render, so an unwritable cache location
  // rejected `runCli` outright: two billed calls thrown away, stdout empty
  // despite `--json`, and an unhandled rejection instead of an exit code.
  it('still prints an already-billed round when the session cache cannot be written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-cli-research-cache-'));
    try {
      // A regular file where the cache root should be: every mkdir under it
      // fails with ENOTDIR, the same shape as a read-only or sandboxed home.
      const blocked = join(dir, 'not-a-directory');
      writeFileSync(blocked, 'x');
      const result = await runCli(
        ['research', 'merkle tree proofs', '--fanout', '2', '--session', 'round-1', '--json'],
        baseDeps({
          env: { FEZO_URL: 'https://gw.example.com', FEZO_API_KEY: SECRET, XDG_CACHE_HOME: blocked },
          homeDir: dir,
          fetchFn: researchFetch(),
        }),
      );
      expect(result.exitCode).toBe(0);
      const doc = JSON.parse(result.stdout) as { items: unknown[]; billing: { calls_billed: number } };
      expect(doc.items).toHaveLength(3);
      expect(doc.billing.calls_billed).toBe(2);
      // Reported, not silent -- and on stderr only, because `--json` promises
      // exactly one document on stdout.
      expect(result.stderr).toContain('could not write the session cache');
      expect(result.stderr).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fezoctl research: a plan with nothing to do is a usage error', () => {
  it('rejects a whitespace-only --queries before any call', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(
      ['research', 'hello', '--queries', '   '],
      baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no queries and no targets/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('says so on stdout under --json, like every other usage error', async () => {
    const result = await runCli(['research', 'hello', '--queries', '   ', '--json'], baseDeps());
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.kind).toBe('usage');
  });
});
