// Gateway call execution: binds a catalog candidate's arguments via
// bindings.ts, sends the request with the global `fetch`, and classifies a
// non-2xx response through errors.ts.
//
// The gateway base URL and API key are explicit parameters here, exactly
// like `fetchCatalog`'s `FetchCatalogOptions` in catalog.ts -- this module
// does not resolve credentials from config, env, or a credential store.
// Task 7 owns that and passes the resolved values in.

import type { ToolCandidate } from './catalog.js';
import { bindArgs } from './bindings.js';
import { parseCallError } from './errors.js';
import type { CallError } from './errors.js';

export interface CallToolOptions {
  /** Gateway base URL, e.g. "https://gateway.example.com". A trailing slash is tolerated. */
  baseUrl: string;
  apiKey: string;
  candidate: ToolCandidate;
  /** Parsed `--args-json` value. */
  args: unknown;
  /** Parsed `--body-json` value, if the caller supplied one; see bindings.ts's body-source rule. */
  bodyJson?: unknown;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

export interface CallToolResult {
  status: number;
  /** Raw response body text, exactly as received. */
  bodyText: string;
}

/**
 * Thrown when the gateway responds with a non-2xx status. Carries the
 * `CallError` classification (see errors.ts) rather than a rendered message:
 * Task 8's CLI decides how to display a gateway envelope vs. a backend
 * passthrough, and Task 6's retry.ts decides whether either is retryable.
 * This class does not add either judgement.
 */
export class GatewayCallError extends Error {
  readonly status: number;
  readonly detail: CallError;

  constructor(detail: CallError) {
    super(
      detail.kind === 'gateway'
        ? `gateway error ${detail.status} (${detail.code}): ${detail.message}`
        : `backend error ${detail.status}`,
    );
    this.name = 'GatewayCallError';
    this.status = detail.status;
    this.detail = detail;
  }
}

/**
 * Emits a diagnostic to stderr, in the same form (and for the same reason) as
 * catalog.ts's and bindings.ts's `warn`: stdout is reserved for the CLI's
 * machine-readable output.
 */
function warn(message: string): void {
  process.stderr.write(`fezoctl: ${message}\n`);
}

/**
 * Calls one catalog method end to end: binds `args`/`bodyJson` per
 * `candidate`'s HTTP binding (bindings.ts's `bindArgs`), sends the request,
 * and returns the raw 2xx response.
 *
 * - `BindingError` (from bindings.ts) propagates for a local binding
 *   problem, and is thrown before any network call is attempted.
 * - A transport failure (network error) propagates as-is, unwrapped --
 *   matching `fetchCatalog`'s behavior in catalog.ts, which does not catch
 *   or rewrite `fetch` rejections either.
 * - A non-2xx response is thrown as `GatewayCallError`.
 */
export async function callTool(options: CallToolOptions): Promise<CallToolResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const bound = bindArgs(options.candidate, options.args, options.bodyJson);

  const queryString = new URLSearchParams(bound.query).toString();
  const url =
    `${options.baseUrl.replace(/\/$/, '')}/v1/${options.candidate.backendId}${bound.path}` +
    (queryString.length > 0 ? `?${queryString}` : '');

  // Headers this module owns are written last, and a bound header colliding
  // with one (case-insensitively -- HTTP header names are case-insensitive, and
  // a plain-object `HeadersInit` would otherwise reach `fetch` carrying both
  // spellings) is dropped with a diagnostic. `bindArgs` already refuses to bind
  // `Authorization` or `X-Fezo-*` at all, so this is defense in depth rather
  // than the only barrier: the credential this client sends must not be
  // overridable by catalog data, and neither must the content type of a body
  // this client is the one serializing.
  const hasBody = Object.hasOwn(bound, 'body');
  const clientOwnedHeaders = hasBody ? ['authorization', 'content-type'] : ['authorization'];
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(bound.headers)) {
    if (clientOwnedHeaders.includes(name.toLowerCase())) {
      warn(`${options.candidate.tool}: ignoring bound header "${name}" -- it is set by the client and may not be overridden`);
      continue;
    }
    headers[name] = value;
  }
  headers.Authorization = `Bearer ${options.apiKey}`;

  const init: RequestInit = { method: options.candidate.httpMethod, headers };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(bound.body);
  }

  const response = await fetchFn(url, init);
  const bodyText = await response.text();

  if (!response.ok) {
    throw new GatewayCallError(parseCallError(response.status, bodyText));
  }

  return { status: response.status, bodyText };
}
