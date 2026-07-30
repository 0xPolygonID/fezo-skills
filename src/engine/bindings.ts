// HTTP argument binding: decides where a tool call's arguments go on the
// wire -- a path segment, the query string, a request header, or the JSON
// body -- following the catalog's `http` binding block (`ToolCandidate.bindings`
// in catalog.ts) instead of assuming GET means "all args in query" or POST
// means "all args in body."
//
// The case that makes the flat-body assumption actively wrong:
// zug/internal/brightdatabackend/manifest.go's `scrape_async` method is a
// POST whose `http.query` carries `dataset_id` (and friends), while its
// request body is a *separate* array of input records that `input_schema`
// does not even describe. zug/internal/brightdatabackend/handlers.go's
// `startAsync` reads `dataset_id` from `r.URL.Query()` and 400s
// "dataset_id is required" if it is absent -- so a client that puts every
// arg in the POST body can never call this method. See
// zug/docs/backend-authoring.md ("The `http` binding") for the governing
// contract this module implements.
//
// Argument-schema validation (AJV, Task 5) is a deliberate seam this module
// leaves open: `bindArgs` takes already-parsed `--args-json`/`--body-json`
// values and only enforces the *structural* minimum needed to build a
// well-formed request at all -- a path placeholder with no value, or a
// property `input_schema.required` names that ends up with nowhere to go.
// It does not validate shapes against `input_schema`. Task 5 slots full
// schema validation in before (or alongside) a `bindArgs` call without this
// function's signature needing to change.

import type { ToolCandidate } from './catalog.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** A resolved, ready-to-send request shape for one tool call. */
export interface BoundRequest {
  /**
   * `candidate.path` with every `{placeholder}` substituted from `args`.
   * Always has a leading slash (inherited from `candidate.path`); callers
   * append it directly after `/v1/{backendId}`.
   */
  path: string;
  /** Query parameters to send, already coerced to strings. */
  query: Record<string, string>;
  /**
   * Allow-listed request headers to send. Never contains `Authorization` or
   * an `X-Zug-*` name -- `bindArgs` refuses (throws) rather than let either
   * through, even if the catalog's own `http.header` list names one.
   */
  headers: Record<string, string>;
  /**
   * JSON request body, present iff this call sends one. Never present for a
   * GET request (the Fetch API rejects a body on GET/HEAD).
   */
  body?: unknown;
}

export type BindingErrorReason =
  | 'disallowed-header'
  | 'missing-path-param'
  | 'missing-query-param'
  | 'missing-header-param'
  | 'missing-body-param';

/**
 * Thrown by `bindArgs` for a problem `bindArgs` can detect without ever
 * sending a request: a manifest naming a reserved header, or a path/query/
 * header/body value `input_schema.required` (or the path template itself)
 * demands but `args`/`bodyJson` does not supply. These are local client
 * errors, not requests that get sent and fail upstream.
 */
export class BindingError extends Error {
  readonly reason: BindingErrorReason;
  /** The offending property or header name(s), in the order encountered. */
  readonly names: string[];

  constructor(reason: BindingErrorReason, names: string[]) {
    super(formatBindingError(reason, names));
    this.name = 'BindingError';
    this.reason = reason;
    this.names = names;
  }
}

function formatBindingError(reason: BindingErrorReason, names: string[]): string {
  const list = names.join(', ');
  switch (reason) {
    case 'disallowed-header':
      return `refusing to bind reserved header name(s): ${list} (Authorization and X-Zug-* headers may never be set by a tool call)`;
    case 'missing-path-param':
      return `missing required path parameter(s): ${list}`;
    case 'missing-query-param':
      return `missing required query parameter(s): ${list}`;
    case 'missing-header-param':
      return `missing required header parameter(s): ${list}`;
    case 'missing-body-param':
      return `missing required body field(s): ${list}`;
  }
}

// ---------------------------------------------------------------------------
// Small local helpers (each engine module keeps its own; see catalog.ts/rank.ts).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A value counts as "missing" for required-argument purposes when it is
 * `undefined`, `null`, or the empty string -- matching the reference MCP
 * client's path-placeholder check (`zug/mcp-server/src/zug_gateway_client.ts`).
 * A legitimately falsy value (`0`, `false`) is present, not missing.
 */
function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Reads `input_schema.required` defensively; anything else yields no required names. */
function requiredPropertyNames(schema: object): string[] {
  if (!isRecord(schema)) return [];
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((name): name is string => typeof name === 'string');
}

const DISALLOWED_HEADER_EXACT = 'authorization';
const DISALLOWED_HEADER_PREFIX = 'x-zug-';

/**
 * True for `Authorization` or any `X-Zug-*` header name, case-insensitively.
 * The gateway strips inbound `X-Zug-*` headers on its own
 * (zug/internal/gateway/manifest.go's passthrough-header validation), but
 * `bindArgs` refuses locally rather than rely on that: a header a tool call
 * never sends cannot be a live attack surface regardless of what the gateway
 * would have done with it.
 */
function isDisallowedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === DISALLOWED_HEADER_EXACT || lower.startsWith(DISALLOWED_HEADER_PREFIX);
}

// ---------------------------------------------------------------------------
// Binding.
// ---------------------------------------------------------------------------

/**
 * Binds `args` (parsed `--args-json`) and optionally `bodyJson` (parsed
 * `--body-json`) into a `BoundRequest` for `candidate`, per the governing
 * spec's binding rules and body-source rule. Throws `BindingError` for any
 * local problem; never sends a request itself (see client.ts for that).
 *
 * Path substitution is driven by the literal `{placeholder}` segments in
 * `candidate.path` -- not by `candidate.bindings.path_params` -- matching
 * the reference MCP client
 * (`zug/mcp-server/src/zug_gateway_client.ts`'s `call`), which the task brief
 * calls out as already correct: the path template is the one place a
 * missing substitution is directly observable (a literal `{id}` reaching the
 * gateway), so it is the authoritative source. A value is split on `/` and
 * each segment is `encodeURIComponent`-ed individually, so a multi-segment
 * id (`fal-ai/flux/dev`) reaches the gateway with its slashes intact while
 * reserved characters within a segment are still escaped; a single-segment
 * id (an Apify actor `janedoe~my-actor`) is unaffected.
 *
 * Body-source rule (three cases, in order):
 *   1. `bodyJson !== undefined` -- it is the body, verbatim. This is the
 *      documented escape hatch for a body shape `input_schema` cannot even
 *      describe (Bright Data's `scrape_async` array-of-records body).
 *   2. Otherwise, a GET request never gets a body (the Fetch API rejects
 *      one); any args not claimed by path/query/header are simply unsent.
 *   3. Otherwise (a POST-like request), everything left in `args` after
 *      path/query/header extraction becomes the JSON body. This is
 *      deliberately the *same* mechanism for a "plain" POST (nothing
 *      declared in `query`/`header`, so the whole object remains) and a
 *      "mixed" POST (`query`/`header` peel off a subset, the rest is body)
 *      -- the spec's two body-source bullets for the no-`--body-json` case
 *      are one mechanism, not two.
 */
export function bindArgs(candidate: ToolCandidate, args: unknown, bodyJson?: unknown): BoundRequest {
  const bindings = candidate.bindings;
  const source: Record<string, unknown> = isRecord(args) ? { ...args } : {};
  const requiredNames = requiredPropertyNames(candidate.inputSchema);

  // Manifest safety, checked before anything else and independent of args:
  // a header name a tool call could never legitimately need to set.
  const headerNames = bindings.header ?? [];
  const disallowedHeaders = headerNames.filter(isDisallowedHeaderName);
  if (disallowedHeaders.length > 0) {
    throw new BindingError('disallowed-header', disallowedHeaders);
  }

  // --- Path -------------------------------------------------------------
  const pathParamNames = new Set<string>();
  const missingPath: string[] = [];
  const resolvedPath = candidate.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    pathParamNames.add(name);
    const value = source[name];
    if (isMissing(value)) {
      missingPath.push(name);
      return `{${name}}`;
    }
    delete source[name];
    return String(value).split('/').map(encodeURIComponent).join('/');
  });
  if (missingPath.length > 0) {
    throw new BindingError('missing-path-param', missingPath);
  }

  // --- Query --------------------------------------------------------------
  const query: Record<string, string> = {};
  const missingQuery: string[] = [];
  if (bindings.query !== undefined) {
    for (const name of bindings.query) {
      const value = source[name];
      if (isMissing(value)) {
        if (requiredNames.includes(name)) missingQuery.push(name);
        continue;
      }
      query[name] = String(value);
      delete source[name];
    }
  } else if (candidate.httpMethod === 'GET') {
    // Legacy fallback: no declared query binding at all, so every remaining
    // arg becomes a query parameter.
    for (const [name, value] of Object.entries(source)) {
      if (isMissing(value)) continue;
      query[name] = String(value);
      delete source[name];
    }
    for (const name of requiredNames) {
      if (!pathParamNames.has(name) && !(name in query)) missingQuery.push(name);
    }
  }
  if (missingQuery.length > 0) {
    throw new BindingError('missing-query-param', missingQuery);
  }

  // --- Header ---------------------------------------------------------------
  const headers: Record<string, string> = {};
  const missingHeader: string[] = [];
  for (const name of headerNames) {
    const value = source[name];
    if (isMissing(value)) {
      if (requiredNames.includes(name)) missingHeader.push(name);
      continue;
    }
    headers[name] = String(value);
    delete source[name];
  }
  if (missingHeader.length > 0) {
    throw new BindingError('missing-header-param', missingHeader);
  }

  // --- Body -----------------------------------------------------------------
  let body: unknown;
  let hasBody = false;
  if (bodyJson !== undefined) {
    body = bodyJson;
    hasBody = true;
  } else if (candidate.httpMethod !== 'GET') {
    const queryNames = bindings.query ?? [];
    const missingBody = requiredNames.filter(
      (name) => !pathParamNames.has(name) && !queryNames.includes(name) && !headerNames.includes(name) && isMissing(source[name]),
    );
    if (missingBody.length > 0) {
      throw new BindingError('missing-body-param', missingBody);
    }
    body = source;
    hasBody = true;
  }

  return {
    path: resolvedPath,
    query,
    headers,
    ...(hasBody ? { body } : {}),
  };
}
