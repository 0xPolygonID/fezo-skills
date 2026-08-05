// HTTP argument binding: decides where a tool call's arguments go on the
// wire -- a path segment, the query string, a request header, or the JSON
// body -- following the catalog's `http` binding block (`ToolCandidate.bindings`
// in catalog.ts) instead of assuming GET means "all args in query" or POST
// means "all args in body."
//
// The case that makes the flat-body assumption actively wrong: a scraping
// backend's async-scrape method is a POST whose `http.query` carries
// `dataset_id` (and friends), while its request body is a *separate* array of
// input records that `input_schema` does not even describe. That backend reads
// `dataset_id` from the URL query and 400s "dataset_id is required" if it is
// absent -- so a client that puts every arg in the POST body can never call
// this method. The gateway's backend-authoring contract ("The `http` binding")
// is what governs this module's behavior.
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
   * GET request: the Fetch API rejects a body on GET/HEAD, so a GET that
   * would carry one (an explicit `--body-json`) is refused up front with a
   * `body-not-allowed` `BindingError` rather than having its body silently
   * dropped -- see `bindArgs`.
   */
  body?: unknown;
}

export type BindingErrorReason =
  | 'disallowed-header'
  | 'body-not-allowed'
  | 'missing-path-param'
  | 'missing-query-param'
  | 'missing-header-param'
  | 'missing-body-param';

/**
 * Thrown by `bindArgs` for a problem `bindArgs` can detect without ever
 * sending a request: a manifest naming a reserved header, a body on a verb
 * that cannot carry one, or a path/query/header/body value
 * `input_schema.required` (or the path template itself) demands but
 * `args`/`bodyJson` does not supply. These are local client errors, not
 * requests that get sent and fail upstream.
 */
export class BindingError extends Error {
  readonly reason: BindingErrorReason;
  /**
   * The offending property or header name(s), in the order encountered.
   * Empty for `body-not-allowed`, whose fault is the verb, not a property.
   */
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
    case 'body-not-allowed':
      return 'refusing to send a request body on a GET method (the Fetch API rejects a body on GET/HEAD); drop --body-json, or call a method whose binding declares a request body';
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
 * Emits a diagnostic to stderr, in the same form (and for the same reason) as
 * catalog.ts's `warn`: stdout is reserved for the CLI's machine-readable
 * output, so every silent degradation is announced here instead.
 */
function warn(message: string): void {
  process.stderr.write(`fezoctl: ${message}\n`);
}

/**
 * "Missing" for a *sendable* value (query parameter, header): `undefined` or
 * `null` only. Matching the reference MCP client's GET query construction,
 * which filters exactly those two and does send `''`, an explicitly empty
 * string is a *present* value: `?q=` is a legal, sometimes meaningful request,
 * and refusing to send it would make an intentionally empty parameter
 * unexpressible. A legitimately falsy value (`0`, `false`) is likewise
 * present, not missing.
 */
function isMissingValue(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * "Missing" for a path placeholder: additionally `''`, which is the one place
 * an empty string is not merely unusual but malformed -- it collapses
 * `/snapshots/{id}/data` to `/snapshots//data`, a different resource. Matches
 * the reference MCP client's path-placeholder check.
 */
function isMissingPathValue(value: unknown): boolean {
  return isMissingValue(value) || value === '';
}

/**
 * "Missing" for a JSON body field: absent from the object entirely. A `null`
 * body field is a present value -- a property whose schema is
 * `{"type": ["string", "null"]}` may legitimately be sent as `null`, and JSON
 * cannot express `undefined`, so an `undefined` here means the key was not
 * supplied.
 */
function isMissingBodyValue(value: unknown): boolean {
  return value === undefined;
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
 * The gateway strips inbound `X-Zug-*` headers on its own, in its
 * passthrough-header validation, but `bindArgs` refuses locally rather than
 * rely on that: a header a tool call never sends cannot be a live attack
 * surface regardless of what the gateway would have done with it.
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
 * the reference MCP client's own `call`, which the task brief
 * calls out as already correct: the path template is the one place a
 * missing substitution is directly observable (a literal `{id}` reaching the
 * gateway), so it is the authoritative source. A value is split on `/` and
 * each segment is `encodeURIComponent`-ed individually, so a multi-segment
 * id (`fal-ai/flux/dev`) reaches the gateway with its slashes intact while
 * reserved characters within a segment are still escaped; a single-segment
 * id (an Apify actor `janedoe~my-actor`) is unaffected. A template that names
 * the same placeholder twice (`/a/{id}/b/{id}`) substitutes both occurrences:
 * consumed names are removed from the remaining args only *after* the whole
 * template is resolved, so the second occurrence still sees its value.
 *
 * Placement precedence, when a property name appears in more than one binding
 * list: path wins over query, and query wins over header. Path and query
 * consume the name (it cannot also reach the body), so a name declared in both
 * `query` and `header` is sent as a query parameter and *not* as a header --
 * and, if `input_schema.required` names it, the header pass then reports it as
 * `missing-header-param`. A manifest declaring one property in two places is
 * an authoring error; this is the order in which it is resolved, not an
 * endorsement of it.
 *
 * Body-source rule (three cases, in order):
 *   1. `bodyJson !== undefined` -- it is the body, verbatim. This is the
 *      documented escape hatch for a body shape `input_schema` cannot even
 *      describe (Bright Data's `scrape_async` array-of-records body). A GET
 *      method is refused (`body-not-allowed`) rather than sent bodyless: the
 *      Fetch API throws on a body with GET, and silently discarding a body the
 *      caller explicitly passed would send a different request than the one
 *      asked for.
 *   2. Otherwise, a GET request never gets a body (the Fetch API rejects
 *      one); any args not claimed by path/query/header are unsent, and are
 *      announced on stderr so a typo'd optional parameter on a method with a
 *      closed `query` list is not an invisible no-op.
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

  // Verb safety, likewise independent of args: a GET cannot carry a body, so
  // an explicit `--body-json` on one is refused here rather than bound and
  // then thrown out by `fetch` (`TypeError: Request with GET/HEAD method
  // cannot have body`) at send time.
  if (bodyJson !== undefined && candidate.httpMethod === 'GET') {
    throw new BindingError('body-not-allowed', []);
  }

  // --- Path -------------------------------------------------------------
  const pathParamNames = new Set<string>();
  const missingPath: string[] = [];
  const resolvedPath = candidate.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    pathParamNames.add(name);
    const value = source[name];
    if (isMissingPathValue(value)) {
      // A repeated placeholder reports its name once, not once per occurrence.
      if (!missingPath.includes(name)) missingPath.push(name);
      return `{${name}}`;
    }
    return String(value).split('/').map(encodeURIComponent).join('/');
  });
  if (missingPath.length > 0) {
    throw new BindingError('missing-path-param', missingPath);
  }
  // Consumed only now that every occurrence has been read: deleting inside the
  // replacer would leave a second `{id}` in `/a/{id}/b/{id}` reading undefined.
  for (const name of pathParamNames) delete source[name];

  // --- Query --------------------------------------------------------------
  const query: Record<string, string> = {};
  const missingQuery: string[] = [];
  if (bindings.query !== undefined) {
    for (const name of bindings.query) {
      const value = source[name];
      if (isMissingValue(value)) {
        if (requiredNames.includes(name)) missingQuery.push(name);
        continue;
      }
      query[name] = String(value);
      delete source[name];
    }
  } else if (candidate.httpMethod === 'GET') {
    // Legacy fallback: no declared query binding at all, so every remaining
    // arg becomes a query parameter -- except one a `header` binding claims.
    // Sweeping those into the query string too would let the verb decide
    // placement over an explicit declaration (the exact failure this module
    // exists to prevent): the header pass below would find nothing left, and a
    // required header-bound property would be reported missing here even
    // though the caller did supply it.
    for (const [name, value] of Object.entries(source)) {
      if (headerNames.includes(name)) continue;
      if (isMissingValue(value)) continue;
      query[name] = String(value);
      delete source[name];
    }
    for (const name of requiredNames) {
      if (pathParamNames.has(name) || headerNames.includes(name)) continue;
      if (!(name in query)) missingQuery.push(name);
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
    if (isMissingValue(value)) {
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
      (name) =>
        !pathParamNames.has(name) &&
        !queryNames.includes(name) &&
        !headerNames.includes(name) &&
        isMissingBodyValue(source[name]),
    );
    if (missingBody.length > 0) {
      throw new BindingError('missing-body-param', missingBody);
    }
    body = source;
    hasBody = true;
  } else {
    // A GET has nowhere left to put these. Dropping them silently turns a
    // typo'd optional parameter on a method with a closed `query` list
    // (scraperapi, brave, alpaca) into an invisible no-op, so say so.
    const unbound = Object.keys(source);
    if (unbound.length > 0) {
      warn(
        `${candidate.tool}: not sending argument(s) ${unbound.join(', ')} -- ` +
          `nothing placed them in the path, query string, or a header, and a GET request has no body`,
      );
    }
  }

  return {
    path: resolvedPath,
    query,
    headers,
    ...(hasBody ? { body } : {}),
  };
}
