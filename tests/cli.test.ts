import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { candidatesToRun, resolvePackageVersion, runCli } from '../src/cli.js';
import type { CliDeps } from '../src/cli.js';
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

  it('no args at all prints help and exits 0', async () => {
    const result = await runCli([], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage');
    expect(result.stdout).toContain('Exit codes');
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
    const parsed = JSON.parse(result.stdout) as { outcome: string; chosen: { backendId: string }; result: { kind: string } };
    expect(parsed.outcome).toBe('selected');
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
    const refusedParsed = JSON.parse(refused.stdout) as { outcome: string; overridden: boolean };
    expect(refusedParsed.outcome).toBe('refused-unhinted-multi-backend');
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
    const parsed = JSON.parse(result.stdout) as { outcome: string; asyncExcluded: { tool: string }[] };
    expect(parsed.outcome).toBe('async-excluded');
    expect(parsed.asyncExcluded[0]?.tool).toBe('brightdata_check_progress');
    // Only the catalog GET happened -- the async lifecycle method was never called.
    expect(fetchFn).toHaveBeenCalledTimes(1);
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

  /** A faithful in-memory Keychain: `add-generic-password -w` stores the stdin payload, `find-generic-password -w` reads it back. */
  function fakeKeychain(): { runner: KeychainRunner; calls: { argv: readonly string[]; stdin: string | undefined }[] } {
    const store = new Map<string, string>();
    const calls: { argv: readonly string[]; stdin: string | undefined }[] = [];
    const runner: KeychainRunner = {
      run(argv, stdin) {
        calls.push({ argv, stdin });
        if (argv[0] === 'add-generic-password') {
          const key = argv.join(' ');
          store.set(key, (stdin ?? '').replace(/\r?\n+$/, ''));
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

  it('keychain storage never places the secret in argv, and round-trips through a faithful keychain', async () => {
    const { runner, calls } = fakeKeychain();
    const stdin = Readable.from([Buffer.from(`${SECRET}\n`)]);
    const result = await runCli(['setup', '--key-stdin', '--storage', 'keychain', '--json'], {
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
  it('search, schema, call, run, catalog, and doctor never print the raw API key', async () => {
    const catalog = SCRAPE_CATALOG;
    const commands: { argv: string[]; fetchFn: typeof fetch }[] = [
      { argv: ['search', 'scrape this page', '--json'], fetchFn: multiRouteFetch(catalog) },
      { argv: ['search', 'scrape this page'], fetchFn: multiRouteFetch(catalog) },
      { argv: ['schema', 'firecrawl_scrape', '--json'], fetchFn: multiRouteFetch(catalog) },
      { argv: ['schema', 'firecrawl_scrape'], fetchFn: multiRouteFetch(catalog) },
      {
        argv: ['call', 'scrapingbee_scrape', '--args-json', '{"url":"https://x.example"}', '--json'],
        fetchFn: multiRouteFetch(catalog, { scrapingbee: [okResponse('{"ok":true}')] }),
      },
      {
        argv: ['run', 'scrape this page', '--args-json', '{"url":"https://x.example"}', '--json'],
        fetchFn: multiRouteFetch(catalog, { firecrawl: [okResponse('{"ok":true}')] }),
      },
      { argv: ['catalog', '--json'], fetchFn: multiRouteFetch(catalog) },
      { argv: ['doctor', '--json'], fetchFn: multiRouteFetch(catalog) },
      { argv: ['doctor'], fetchFn: multiRouteFetch(catalog) },
    ];

    for (const { argv, fetchFn } of commands) {
      const result = await runCli(argv, baseDeps({ fetchFn }));
      expect(result.stdout).not.toContain(SECRET);
      expect(result.stderr).not.toContain(SECRET);
    }
  });
});
