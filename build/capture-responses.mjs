// Captures one REAL response per search-shaped entry method into
// tests/fixtures/responses/, so `RESPONSE_ADAPTERS` work is done against
// recorded fact rather than a guess about a provider's shape.
//
// Run manually. It needs a live gateway and a real API key, and EVERY CAPTURE
// IS A BILLED CALL — one per tool listed below, currently 7.
//
//   FEZO_API_KEY=... node build/capture-responses.mjs ["a query"]
//   node build/capture-responses.mjs --dry-run      # lists what it would call
//
// WHY IT SHELLS OUT TO `fezoctl call` rather than fetching itself: the catalog
// declares a per-method HTTP binding (GET vs POST, which inputs are query
// params, which are path params, which form the body), and reimplementing that
// here is how the MCP server got `brightdata_scrape_async` wrong — see
// ../zug/TODO.md. `fezoctl call` already binds arguments through
// src/engine/bindings.ts and classifies failures through src/engine/retry.ts,
// so this script stays a capture harness and owns no protocol knowledge. It is
// also why the argument NAME per tool is read from the live catalog below
// instead of being hardcoded: providers disagree (`query` vs `q`), and the
// disagreement is exactly what src/engine/one-step.ts's ARG_CANDIDATES exists
// to absorb.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const cli = join(repoRoot, 'dist', 'fezoctl.mjs');
const outDir = join(repoRoot, 'tests', 'fixtures', 'responses');

/**
 * The tools worth capturing: the declared `entryMethods` of every provider
 * ranked under a search-shaped intent in src/engine/providers.ts, which are
 * exactly the methods `runResearch` fans a query out to.
 *
 * Deliberately NOT "every method in the catalog": that is 99 candidates and
 * 99 billed calls, and the aggregation layer only ever reads the response of a
 * method a fan-out actually calls. Scrape and crawl entry methods are absent
 * for the same reason — their bodies become `documents`, which are passed
 * through verbatim and never sniffed.
 */
const TOOLS = [
  'you_search',
  'exa_search',
  'brave_search',
  'firecrawl_search',
  'geonode_search',
  'newsapi_articles',
  'brave_news',
];

/**
 * Same order, and the same reasoning, as one-step.ts's ARG_CANDIDATES: a
 * required candidate beats an optional one, and among equals this order wins.
 *
 * A HAND COPY, and nothing enforces that it stays one — this script is plain
 * Node and cannot import the TypeScript engine. If ARG_CANDIDATES.query gains
 * or reorders a name, captures will silently be taken with a different argument
 * than the executor sends, and the fixture will describe a call that never
 * happens in production. Re-check it against src/engine/one-step.ts when a
 * capture looks wrong.
 */
const QUERY_ARGS = ['query', 'q', 'search', 'search_query', 'keyword', 'keywords', 'term', 'text', 'prompt'];

function run(args) {
  return execFileSync('node', [cli, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Reads a tool's input schema off the LIVE catalog and resolves which
 * property carries the query. Returns undefined when the tool is absent or
 * names nothing plausible — either way it is skipped, never guessed at. */
function resolveArg(tool) {
  let schema;
  try {
    schema = JSON.parse(run(['schema', tool, '--json'])).inputSchema ?? {};
  } catch {
    return undefined;
  }
  const props = schema.properties ?? {};
  const names = Object.keys(props);
  const required = new Set(schema.required ?? []);
  const present = QUERY_ARGS.filter((name) => names.includes(name));
  const name = present.find((n) => required.has(n)) ?? present[0];
  if (name === undefined) return undefined;
  // Arity from the schema, exactly as research.ts's `isArrayTyped` decides it.
  // Without this the harness cannot capture `newsapi_articles` -- the very tool
  // whose array-typed `keyword` this script's own run discovered -- so the fix
  // for it could never be exercised end to end and TOOLS would report 6/7
  // forever.
  return { name, isArray: props[name]?.type === 'array' };
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const query = argv.find((a) => !a.startsWith('--')) ?? 'renewable energy storage';

if (!process.env['FEZO_API_KEY'] && !dryRun) {
  process.stderr.write('FEZO_API_KEY is required (or pass --dry-run)\n');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
let captured = 0;
let billed = 0;

for (const tool of TOOLS) {
  const arg = resolveArg(tool);
  if (arg === undefined) {
    process.stdout.write(`skip ${tool}: not in catalog, or no query-shaped argument\n`);
    continue;
  }
  const value = arg.isArray ? [query] : query;
  if (dryRun) {
    process.stdout.write(`would call ${tool} with ${JSON.stringify({ [arg.name]: value })}\n`);
    continue;
  }
  let report;
  try {
    report = JSON.parse(run(['call', tool, '--args-json', JSON.stringify({ [arg.name]: value }), '--json']));
  } catch (error) {
    // A non-zero exit still prints the report document on stdout (see cli.ts's
    // --json contract), so a failed call is reported, never silently skipped.
    const stdout = error?.stdout ?? '';
    process.stdout.write(`FAIL ${tool}: ${String(stdout).slice(0, 200) || String(error)}\n`);
    continue;
  }
  if (report.billedAnyAttempt) billed += 1;
  if (report.outcome?.kind !== 'success') {
    process.stdout.write(`FAIL ${tool}: ${report.outcome?.kind ?? 'unknown'} ${report.outcome?.reason ?? ''}\n`);
    continue;
  }
  // `outcome.body` is the provider's response, parsed — exactly what
  // `extractItems` is handed at run time.
  writeFileSync(join(outDir, `${tool}.json`), `${JSON.stringify(report.outcome.body, null, 2)}\n`);
  captured += 1;
  process.stdout.write(`captured ${tool}\n`);
}

process.stdout.write(dryRun ? '\ndry run: nothing called, nothing billed\n' : `\ncaptured ${String(captured)}/${String(TOOLS.length)}; ${String(billed)} billed call(s)\n`);
