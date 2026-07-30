import { describe, expect, it } from 'vitest';

import type { ToolCandidate } from '../src/engine/catalog.js';
import { credentialDisplay } from '../src/engine/credentials.js';
import type { CredentialResolution, StoreCredentialsResult } from '../src/engine/credentials.js';
import type { RankedCandidate, RunSelection } from '../src/engine/rank.js';
import type { AttemptLog, RunReport } from '../src/engine/retry.js';
import {
  renderCall,
  renderCatalog,
  renderDoctor,
  renderRun,
  renderSchema,
  renderSearch,
  renderSetup,
  renderVersion,
} from '../src/engine/render.js';
import type { DoctorCheck } from '../src/engine/render.js';

// ---------------------------------------------------------------------------
// Fixture helper, matching the convention in binding.test.ts/call.test.ts/retry.test.ts.
// ---------------------------------------------------------------------------

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

const firecrawl = candidate({
  tool: 'firecrawl_scrape',
  backendId: 'firecrawl',
  method: 'scrape',
  path: '/scrape',
  httpMethod: 'POST',
  bindings: {},
  description: 'Scrapes a URL and returns clean markdown.',
  title: 'Scrape',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
});

const scrapingbee = candidate({
  tool: 'scrapingbee_scrape',
  backendId: 'scrapingbee',
  method: 'scrape',
  path: '/scrape',
  httpMethod: 'GET',
  bindings: { query: ['url'] },
  description: 'Scrapes a URL via the ScrapingBee API.',
});

// ---------------------------------------------------------------------------
// --version
// ---------------------------------------------------------------------------

describe('renderVersion', () => {
  it('renders compact text', () => {
    expect(renderVersion('0.1.0', false)).toBe('fezoctl 0.1.0');
  });

  it('renders JSON', () => {
    expect(JSON.parse(renderVersion('0.1.0', true))).toEqual({ version: '0.1.0' });
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('renderSearch', () => {
  const ranked: RankedCandidate[] = [
    { candidate: firecrawl, explanation: { tier: 'exact-tool', matchedTerms: ['scrape'], termScore: 3, billingModel: 'per_call' } },
    {
      candidate: scrapingbee,
      explanation: {
        tier: 'term-score',
        matchedTerms: ['scrape'],
        termScore: 3,
        billingModel: 'per_call',
        preference: { capability: 'scrape', position: 1 },
      },
    },
  ];

  it('text mode lists every candidate with its tool name and rank reason, without schema by default', () => {
    const text = renderSearch(ranked, 'scrape', { json: false, includeSchema: false });
    expect(text).toContain('firecrawl_scrape');
    expect(text).toContain('scrapingbee_scrape');
    expect(text).toContain('exact-tool');
    expect(text).toContain('preferred for "scrape"');
    expect(text).not.toContain('input_schema');
  });

  it('--schema includes input schema and bindings in text mode', () => {
    const text = renderSearch(ranked, 'scrape', { json: false, includeSchema: true });
    expect(text).toContain('input_schema');
    expect(text).toContain('"url"');
  });

  it('JSON mode omits the schema field unless includeSchema is set', () => {
    const withoutSchema = JSON.parse(renderSearch(ranked, 'scrape', { json: true, includeSchema: false })) as {
      results: Record<string, unknown>[];
    };
    expect(withoutSchema.results).toHaveLength(2);
    expect(withoutSchema.results[0]).toBeDefined();
    expect(Object.hasOwn(withoutSchema.results[0] ?? {}, 'schema')).toBe(false);

    const withSchema = JSON.parse(renderSearch(ranked, 'scrape', { json: true, includeSchema: true })) as {
      results: { schema?: { inputSchema: unknown; httpMethod: string } }[];
    };
    expect(withSchema.results[0]?.schema?.inputSchema).toEqual(firecrawl.inputSchema);
    expect(withSchema.results[0]?.schema?.httpMethod).toBe('POST');
  });

  it('shows candidate names and the ranking reason in JSON', () => {
    const parsed = JSON.parse(renderSearch(ranked, 'scrape', { json: true, includeSchema: false })) as {
      query: string;
      count: number;
      results: { tool: string; rank: { tier: string } }[];
    };
    expect(parsed.query).toBe('scrape');
    expect(parsed.count).toBe(2);
    expect(parsed.results.map((r) => r.tool)).toEqual(['firecrawl_scrape', 'scrapingbee_scrape']);
    expect(parsed.results[0]?.rank.tier).toBe('exact-tool');
  });

  it('renders a "no matches" message for an empty result set', () => {
    expect(renderSearch([], 'nothing matches this', { json: false, includeSchema: false })).toContain('no matches');
  });
});

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

describe('renderSchema', () => {
  it('text mode shows backend id, method, call path/verb, and input schema', () => {
    const text = renderSchema(firecrawl, false);
    expect(text).toContain('firecrawl_scrape');
    expect(text).toContain('backend: firecrawl');
    expect(text).toContain('method: scrape');
    expect(text).toContain('POST /scrape');
    expect(text).toContain('"required"');
  });

  it('JSON mode carries backend id, method, path, httpMethod, bindings, and input schema', () => {
    const parsed = JSON.parse(renderSchema(scrapingbee, true)) as {
      tool: string;
      backendId: string;
      method: string;
      httpMethod: string;
      path: string;
      bindings: { query?: string[] };
      inputSchema: unknown;
    };
    expect(parsed.tool).toBe('scrapingbee_scrape');
    expect(parsed.backendId).toBe('scrapingbee');
    expect(parsed.method).toBe('scrape');
    expect(parsed.httpMethod).toBe('GET');
    expect(parsed.path).toBe('/scrape');
    expect(parsed.bindings.query).toEqual(['url']);
  });
});

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

describe('renderCall', () => {
  const successReport: RunReport = {
    attempts: [{ tool: 'firecrawl_scrape', backendId: 'firecrawl', status: 'success', httpStatus: 200, reason: '200 response', billed: true }],
    outcome: { kind: 'success', candidate: firecrawl, result: { status: 200, bodyText: '{"markdown":"hello"}' } },
  };

  it('text mode shows the resolved candidate, the bound request, attempts, billed, and the result body', () => {
    const text = renderCall(
      { tool: 'firecrawl_scrape', candidate: firecrawl, boundRequest: { path: '/scrape', query: {}, headers: {}, body: { url: 'https://x.example' } }, report: successReport },
      false,
    );
    expect(text).toContain('resolved: firecrawl.scrape');
    expect(text).toContain('"url": "https://x.example"');
    expect(text).toContain('[success]');
    expect(text).toContain('billed=true');
    expect(text).toContain('billed: true');
    expect(text).toContain('"markdown": "hello"');
  });

  it('JSON mode: success carries request, attempts, and a parsed result body', () => {
    const parsed = JSON.parse(
      renderCall(
        { tool: 'firecrawl_scrape', candidate: firecrawl, boundRequest: { path: '/scrape', query: {}, headers: {}, body: { url: 'https://x.example' } }, report: successReport },
        true,
      ),
    ) as {
      tool: string;
      resolved: boolean;
      backendId: string;
      request: { body: { url: string } };
      attempts: AttemptLog[];
      outcome: { kind: string; status: number; body: { markdown: string } };
      billedAnyAttempt: boolean;
    };
    expect(parsed.resolved).toBe(true);
    expect(parsed.backendId).toBe('firecrawl');
    expect(parsed.request.body.url).toBe('https://x.example');
    expect(parsed.attempts).toHaveLength(1);
    expect(parsed.outcome.kind).toBe('success');
    expect(parsed.outcome.body.markdown).toBe('hello');
    expect(parsed.billedAnyAttempt).toBe(true);
  });

  it('an unresolved tool renders resolved:false and the give-up reason, without a request', () => {
    const report: RunReport = {
      attempts: [{ tool: 'nope_tool', backendId: '(unresolved)', status: 'retry', reason: 'gateway code "tool_not_in_catalog"', billed: false }],
      outcome: { kind: 'give_up', reason: 'no more candidates to try' },
    };
    const text = renderCall({ tool: 'nope_tool', report }, false);
    expect(text).toContain('tool not found in catalog');
    expect(text).toContain('give up: no more candidates to try');

    const parsed = JSON.parse(renderCall({ tool: 'nope_tool', report }, true)) as { resolved: boolean; request?: unknown };
    expect(parsed.resolved).toBe(false);
    expect(Object.hasOwn(parsed, 'request')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe('renderRun', () => {
  it('no-match: says nothing matched', () => {
    const selection: RunSelection = { outcome: 'no-match' };
    const text = renderRun({ intent: 'quantum teleport', selection, allowUnhintedAutoPick: false }, false);
    expect(text).toContain('no candidates matched');
  });

  it('async-excluded: lists the excluded candidates and explains the override, without an attempt log', () => {
    const asyncCandidate = candidate({
      tool: 'brightdata_snapshot_status',
      backendId: 'brightdata',
      method: 'snapshot_status',
      path: '/status',
      httpMethod: 'GET',
      bindings: {},
    });
    const selection: RunSelection = { outcome: 'async-excluded', asyncExcluded: [asyncCandidate] };
    const text = renderRun({ intent: 'snapshot status', selection, allowUnhintedAutoPick: false }, false);
    expect(text).toContain('brightdata_snapshot_status');
    expect(text).toContain('async lifecycle');
    expect(text).not.toContain('attempts:');

    const parsed = JSON.parse(renderRun({ intent: 'snapshot status', selection, allowUnhintedAutoPick: false }, true)) as {
      outcome: string;
      asyncExcluded: { tool: string }[];
    };
    expect(parsed.outcome).toBe('async-excluded');
    expect(parsed.asyncExcluded[0]?.tool).toBe('brightdata_snapshot_status');
  });

  it('selected: shows the chosen candidate, why it was chosen, and the attempt log with billed status', () => {
    const ranked: RankedCandidate[] = [
      { candidate: firecrawl, explanation: { tier: 'term-score', matchedTerms: ['scrape'], termScore: 3, billingModel: 'per_call', preference: { capability: 'scrape', position: 0 } } },
    ];
    const selection: RunSelection = { outcome: 'selected', chosen: ranked[0] as RankedCandidate, ranked };
    const report: RunReport = {
      attempts: [{ tool: 'firecrawl_scrape', backendId: 'firecrawl', status: 'success', httpStatus: 200, reason: '200 response', billed: true }],
      outcome: { kind: 'success', candidate: firecrawl, result: { status: 200, bodyText: '{"ok":true}' } },
    };
    const text = renderRun({ intent: 'scrape this page', selection, allowUnhintedAutoPick: false, report }, false);
    expect(text).toContain('selected: firecrawl_scrape');
    expect(text).toContain('preferred for "scrape"');
    expect(text).toContain('billed=true');
    expect(text).toContain('billed: true');

    const parsed = JSON.parse(renderRun({ intent: 'scrape this page', selection, allowUnhintedAutoPick: false, report }, true)) as {
      chosen: { tool: string };
      attempts: AttemptLog[];
      billedAnyAttempt: boolean;
    };
    expect(parsed.chosen.tool).toBe('firecrawl_scrape');
    expect(parsed.attempts).toHaveLength(1);
    expect(parsed.billedAnyAttempt).toBe(true);
  });

  it('refused-ambiguous-capability: lists the capabilities and marks alternatives as informational only', () => {
    const ranked: RankedCandidate[] = [{ candidate: firecrawl, explanation: { tier: 'term-score', matchedTerms: [], termScore: 0, billingModel: 'per_call' } }];
    const selection: RunSelection = {
      outcome: 'refused-ambiguous-capability',
      reason: { kind: 'ambiguous-capability', capabilities: ['scrape', 'serp'] },
      alternatives: ranked,
    };
    const text = renderRun({ intent: 'scrape serp results', selection, allowUnhintedAutoPick: false }, false);
    expect(text).toContain('scrape');
    expect(text).toContain('serp');
    expect(text).toContain('not overridable');
    expect(text).toContain('alternatives (not called)');
  });

  it('refused-unhinted-multi-backend: without the override flag, no candidate is promoted', () => {
    const ranked: RankedCandidate[] = [
      { candidate: firecrawl, explanation: { tier: 'term-score', matchedTerms: [], termScore: 1, billingModel: 'per_call' } },
      { candidate: scrapingbee, explanation: { tier: 'term-score', matchedTerms: [], termScore: 0, billingModel: 'per_call' } },
    ];
    const selection: RunSelection = {
      outcome: 'refused-unhinted-multi-backend',
      reason: { kind: 'unhinted-multi-backend', backends: ['firecrawl', 'scrapingbee'] },
      ranked,
    };
    const text = renderRun({ intent: 'translate document', selection, allowUnhintedAutoPick: false }, false);
    expect(text).toContain('--allow-unhinted-auto-pick');
    expect(text).not.toContain('promoting');

    const parsed = JSON.parse(renderRun({ intent: 'translate document', selection, allowUnhintedAutoPick: false }, true)) as {
      overridden: boolean;
      backends: string[];
    };
    expect(parsed.overridden).toBe(false);
    expect(parsed.backends).toEqual(['firecrawl', 'scrapingbee']);
  });

  it('refused-unhinted-multi-backend: with the override flag and a report, shows the promoted candidate ran', () => {
    const ranked: RankedCandidate[] = [
      { candidate: firecrawl, explanation: { tier: 'term-score', matchedTerms: [], termScore: 1, billingModel: 'per_call' } },
      { candidate: scrapingbee, explanation: { tier: 'term-score', matchedTerms: [], termScore: 0, billingModel: 'per_call' } },
    ];
    const selection: RunSelection = {
      outcome: 'refused-unhinted-multi-backend',
      reason: { kind: 'unhinted-multi-backend', backends: ['firecrawl', 'scrapingbee'] },
      ranked,
    };
    const report: RunReport = {
      attempts: [{ tool: 'firecrawl_scrape', backendId: 'firecrawl', status: 'success', httpStatus: 200, reason: '200 response', billed: true }],
      outcome: { kind: 'success', candidate: firecrawl, result: { status: 200, bodyText: '{}' } },
    };
    const text = renderRun({ intent: 'translate document', selection, allowUnhintedAutoPick: true, report }, false);
    expect(text).toContain('promoting firecrawl_scrape');
    expect(text).toContain('billed: true');

    const parsed = JSON.parse(renderRun({ intent: 'translate document', selection, allowUnhintedAutoPick: true, report }, true)) as { overridden: boolean };
    expect(parsed.overridden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

describe('renderCatalog', () => {
  it('groups methods by backend in text mode', () => {
    const text = renderCatalog([firecrawl, scrapingbee], false);
    expect(text).toContain('firecrawl:');
    expect(text).toContain('scrapingbee:');
    expect(text).toContain('firecrawl_scrape');
  });

  it('JSON mode groups methods by backend and reports totals', () => {
    const parsed = JSON.parse(renderCatalog([firecrawl, scrapingbee], true)) as {
      totalMethods: number;
      backends: { backendId: string; methods: { tool: string }[] }[];
    };
    expect(parsed.totalMethods).toBe(2);
    expect(parsed.backends.map((b) => b.backendId).sort()).toEqual(['firecrawl', 'scrapingbee']);
  });
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe('renderDoctor', () => {
  const checks: DoctorCheck[] = [
    { name: 'gateway-url', status: 'ok', message: 'FEZO_URL resolved from env' },
    { name: 'preference-hints', status: 'warn', message: 'preference hints name backend(s) absent from the live catalog: you', details: { missing: ['you'] } },
    { name: 'api-key', status: 'fail', message: 'FEZO_API_KEY is not configured' },
  ];

  it('text mode lists every check with its status', () => {
    const text = renderDoctor(checks, false);
    expect(text).toContain('[ok] gateway-url');
    expect(text).toContain('[warn] preference-hints');
    expect(text).toContain('[fail] api-key');
  });

  it('JSON mode carries every check verbatim, including details', () => {
    const parsed = JSON.parse(renderDoctor(checks, true)) as { checks: DoctorCheck[] };
    expect(parsed.checks).toHaveLength(3);
    expect(parsed.checks[1]?.details).toEqual({ missing: ['you'] });
  });
});

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

describe('renderSetup', () => {
  it('text and JSON both report storage/outcome and the masked (never raw) configured credential', () => {
    const result: StoreCredentialsResult = { storage: 'dotenv', apiKey: { ok: true }, url: { ok: true } };
    const resolution: CredentialResolution = {
      url: { value: 'https://gw.example.com', masked: 'http…', source: 'dotenv' },
      apiKey: { value: 'sk-should-never-appear-in-setup-output', masked: 'sk-s…', source: 'dotenv' },
    };
    const display = credentialDisplay(resolution);

    const text = renderSetup({ result, display }, false);
    expect(text).toContain('stored');
    expect(text).toContain('sk-s…');
    expect(text).not.toContain('sk-should-never-appear-in-setup-output');

    const json = renderSetup({ result, display }, true);
    expect(json).not.toContain('sk-should-never-appear-in-setup-output');
    const parsed = JSON.parse(json) as { configured: { apiKey?: { masked: string } } };
    expect(parsed.configured.apiKey?.masked).toBe('sk-s…');
  });
});

// ---------------------------------------------------------------------------
// credentialDisplay — the one sanctioned addition to credentials.ts
// (carry-forward #7). Printing `apiKey.value` instead of `apiKey.masked` would
// silently leak a live key; this is the load-bearing assertion that a
// renderer using ONLY `credentialDisplay`'s output cannot do that.
// ---------------------------------------------------------------------------

describe('credentialDisplay', () => {
  it('never carries the raw secret, in any field, once serialized', () => {
    const secret = 'sk-credential-display-must-never-leak-this';
    const resolution: CredentialResolution = {
      url: { value: 'https://gw.example.com', masked: 'http…', source: 'env' },
      apiKey: { value: secret, masked: 'sk-c…', source: 'keychain' },
    };
    const display = credentialDisplay(resolution);
    expect(JSON.stringify(display)).not.toContain(secret);
    expect(display.apiKey?.masked).toBe('sk-c…');
    expect(Object.keys(display.apiKey ?? {}).sort()).toEqual(['masked', 'source']);
  });

  it('omits url/apiKey entirely (not present-but-undefined) when the resolution has none', () => {
    const display = credentialDisplay({});
    expect(Object.hasOwn(display, 'url')).toBe(false);
    expect(Object.hasOwn(display, 'apiKey')).toBe(false);
  });

  it('keeps the URL value as-is, since a gateway URL is not a secret', () => {
    const resolution: CredentialResolution = { url: { value: 'https://gw.example.com', masked: 'http…', source: 'env' } };
    const display = credentialDisplay(resolution);
    expect(display.url?.value).toBe('https://gw.example.com');
  });
});
