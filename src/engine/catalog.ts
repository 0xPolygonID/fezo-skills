// Catalog discovery: fetches GET /v1/catalog from a live Fezo gateway and
// normalizes its methods into ToolCandidate values that the rest of the
// engine (search/ranking, HTTP binding, schema validation, calling) builds
// on top of.
//
// This module deliberately does not transcribe the gateway's own catalog and
// manifest definitions into fixtures or a static
// roster. It only mirrors the *wire shape* they document, and parses
// it defensively: the catalog document comes from the network and must be
// treated as untrusted, so every field read here is optional-checked rather
// than asserted.

import { methodToToolName } from './tool-name.js';

// ---------------------------------------------------------------------------
// Public types — the contract later tasks build on.
// ---------------------------------------------------------------------------

/**
 * A JSON Schema media type entry, as used inside an HTTP body binding's
 * `content` map (keyed by media type, e.g. "application/json").
 *
 * `schema` is `object | boolean` because JSON Schema 2020-12 allows a boolean
 * in any schema position: `true` accepts every instance, `false` rejects
 * every instance. Both are meaningful and must survive normalization —
 * dropping `false` would silently turn "no body permitted" into "body
 * declared with no schema". An entry present with no `schema` key at all
 * (`{}`) is a body media type the catalog declared without describing; that is
 * distinct from the media type being absent from `content` entirely.
 */
export interface HttpBodyMediaType {
  schema?: object | boolean;
}

/** Mirrors the gateway manifest's `Body`. */
export interface HttpBody {
  description?: string;
  content?: Record<string, HttpBodyMediaType>;
}

/**
 * Mirrors the gateway manifest's `HTTPBinding`
 * field-for-field, including its snake_case wire names: `method`, `query`,
 * `path_params`, `header`, `request_body`, `response_body`. This type is
 * catalog-derived data, not behavior — Task 4's `bindings.ts` owns the logic
 * that decides where an argument goes (query/path/header/body) using these
 * fields; this module only preserves what the catalog reports.
 *
 * All fields are optional: a method with no `http` block in the catalog
 * normalizes to `{}` here, and it is the binding logic's job (not this
 * module's) to apply GET-query / POST-body defaults for that case.
 */
export interface HttpBindings {
  method?: string;
  query?: string[];
  path_params?: string[];
  header?: string[];
  request_body?: HttpBody;
  response_body?: HttpBody;
}

/** One callable backend method, normalized from the catalog. */
export interface ToolCandidate {
  tool: string;
  backendId: string;
  method: string;
  /** Leading slash normalized; falls back to the method name if the catalog omits `path`. */
  path: string;
  /** Defaults to "http"; other protocols are filtered out before normalization ever produces one. */
  protocol: string;
  httpMethod: 'GET' | 'POST';
  bindings: HttpBindings;
  title?: string;
  description: string;
  inputSchema: object;
  outputSchema?: object;
  userSettings: string[];
  /**
   * The backend's `info` title, summary, and description, concatenated —
   * nothing else.
   *
   * The contents of this string are fixed by the search-semantics rule that
   * searchable fields are "tool name, backend id, method name, title,
   * description, and backend info title/summary/description". Search matches
   * query terms as case-insensitive substrings against this text, so every
   * extra token added here becomes a false-match source: a `docs_url` ending
   * in `/scrape` would match the term "scrape" on a backend with no scrape
   * method, and a literal label like "Categories" would match on every
   * backend that has any. Do not add fields or labels beyond the
   * three named above. Case folding and truncation are the search layer's job,
   * not this module's.
   */
  backendInfoText: string;
  billingModel: 'per_call' | 'dynamic' | 'package';
  /**
   * The backend's declared `info.categories` (internal/gateway/manifest.go's
   * three-value product taxonomy — "Search" / "Crawl" / others), carried as
   * its own field rather than folded into `backendInfoText`. Empty array when
   * the catalog declares none.
   *
   * This is deliberately NOT part of `backendInfoText`: that field's contents
   * are fixed by the search-semantics rule documented on it above (title /
   * summary / description, nothing else), and a category name is not a
   * capability the backend has — a backend tagged "Crawl" would otherwise
   * become substring-matchable by a `search` for "crawl" even when none of
   * its methods do any such thing. `classifyMethod` (src/engine/intent.ts)
   * reads this field directly as its category-fallback layer instead.
   */
  backendCategories: string[];
}

/**
 * Thrown when the catalog endpoint responds with a non-2xx status
 * (`reason: 'status'`), or with a 2xx status whose body cannot be parsed as
 * JSON (`reason: 'parse'`). Carries the raw status and body so a later task
 * (retry classification, error rendering) can decide what it means; this
 * module does not classify or interpret it beyond that distinction.
 *
 * `reason` exists because the two modes are not interchangeable and the
 * message is surfaced to users by the CLI: a status failure means the gateway
 * refused, while a parse failure means the gateway answered successfully with
 * something that is not a catalog. Rendering the latter as "failed with status
 * 200" would be untrue.
 */
export class CatalogFetchError extends Error {
  readonly reason: 'status' | 'parse';
  readonly status: number;
  readonly body: string;

  constructor(reason: 'status' | 'parse', status: number, body: string) {
    super(
      reason === 'status'
        ? `catalog fetch failed with status ${status}`
        : `catalog response with status ${status} could not be parsed as JSON`,
    );
    this.name = 'CatalogFetchError';
    this.reason = reason;
    this.status = status;
    this.body = body;
  }
}

export interface FetchCatalogOptions {
  /** Gateway base URL, e.g. "https://gateway.example.com". A trailing slash is tolerated. */
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Defensive JSON parsing helpers.
//
// The catalog document is untrusted input, and noUncheckedIndexedAccess plus
// exactOptionalPropertyTypes mean every field read below must handle absence
// explicitly rather than asserting a shape.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  const arr = asArray(value);
  if (!arr) return undefined;
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

/**
 * Renders a backend's optional `info` block into the searchable text carried
 * on every one of its tool candidates as `backendInfoText`.
 *
 * The contents are fixed by the search-semantics rule quoted on
 * `ToolCandidate.backendInfoText`: exactly `title`, `summary`, and
 * `description`, in that order, and nothing else. `info.docs_url`,
 * `info.categories`, and `info.version` are deliberately excluded, as are
 * field labels — each would be substring-matchable by search without
 * corresponding to any capability the backend actually has, so they are not
 * parsed at all. A backend with no `info` block (the common case for a
 * minimal manifest) renders to an empty string.
 *
 * No case folding and no truncation: search lowercases both sides itself.
 */
function formatBackendInfoText(value: unknown): string {
  const rec = asRecord(value);
  if (!rec) return '';

  const parts: string[] = [];
  for (const key of ['title', 'summary', 'description'] as const) {
    const text = asString(rec[key]);
    if (text !== undefined && text.length > 0) parts.push(text);
  }
  return parts.join(' — ');
}

/**
 * Parses the backend's `billing` block into one of the three models the
 * gateway's manifest validation allows. A missing or unrecognized model is
 * not expected from a real gateway (the gateway rejects invalid billing at
 * registration), but normalization must not throw over it — it falls back to
 * "dynamic", the model with no fixed cost signal to lose.
 */
function parseBillingModel(value: unknown): 'per_call' | 'dynamic' | 'package' {
  const rec = asRecord(value);
  const model = rec ? asString(rec.model) : undefined;
  if (model === 'per_call' || model === 'dynamic' || model === 'package') return model;
  return 'dynamic';
}

/**
 * Parses one JSON Schema value out of the catalog. A schema is either a JSON
 * object or — legally, under JSON Schema 2020-12 — the boolean `true` or
 * `false`. Anything else (a string, a number, an array, null) is not a schema
 * and is reported as absent.
 */
function parseSchema(value: unknown): object | boolean | undefined {
  if (typeof value === 'boolean') return value;
  return asRecord(value);
}

function parseHttpBody(value: unknown): HttpBody | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;

  const body: HttpBody = {};
  const description = asString(rec.description);
  if (description !== undefined) body.description = description;

  const contentRec = asRecord(rec.content);
  if (contentRec) {
    const content: Record<string, HttpBodyMediaType> = {};
    for (const [mediaType, mediaValue] of Object.entries(contentRec)) {
      const mediaRec = asRecord(mediaValue);
      // A media-type value that is not an object is garbled, not "declared
      // with no schema". Recording `{}` for it would report a body media type
      // the catalog never actually described, which the binding logic would
      // read as a real (schema-less) body. Drop it so the media type reads as
      // absent, which is what it effectively is.
      if (!mediaRec) continue;

      const media: HttpBodyMediaType = {};
      const schema = parseSchema(mediaRec.schema);
      if (schema !== undefined) media.schema = schema;
      content[mediaType] = media;
    }
    body.content = content;
  }

  return body;
}

function parseHttpBindings(value: unknown): HttpBindings {
  const rec = asRecord(value);
  if (!rec) return {};

  const bindings: HttpBindings = {};
  const method = asString(rec.method);
  if (method !== undefined) bindings.method = method;
  const query = asStringArray(rec.query);
  if (query !== undefined) bindings.query = query;
  const pathParams = asStringArray(rec.path_params);
  if (pathParams !== undefined) bindings.path_params = pathParams;
  const header = asStringArray(rec.header);
  if (header !== undefined) bindings.header = header;
  const requestBody = parseHttpBody(rec.request_body);
  if (requestBody !== undefined) bindings.request_body = requestBody;
  const responseBody = parseHttpBody(rec.response_body);
  if (responseBody !== undefined) bindings.response_body = responseBody;
  return bindings;
}

/**
 * Emits a diagnostic to stderr. Normalization never throws over a bad catalog
 * entry — one malformed backend or method must not take down discovery for
 * every other one (mirroring the gateway's own per-backend skip-and-log in
 * catalog.go) — so every degradation is announced here instead. stdout is
 * reserved for the CLI's machine-readable output.
 */
function warn(message: string): void {
  process.stderr.write(`fezoctl: ${message}\n`);
}

/**
 * Resolves the HTTP verb to call with. `http.method` is optional on the
 * catalog's wire format; when absent (or set to anything other than "GET"),
 * the verb defaults to POST, per the governing spec.
 *
 * The `'GET' | 'POST'` domain and the POST default are specified, so a
 * manifest declaring some other verb still gets POST — but silently calling
 * POST where the manifest asked for PUT/PATCH/DELETE would be an invisible
 * wrong-verb request, so the coercion is announced.
 */
function resolveHttpMethod(
  bindings: HttpBindings,
  backendId: string,
  methodName: string,
): 'GET' | 'POST' {
  const declared = bindings.method;
  // An absent or empty verb is the specified POST default, not a coercion.
  if (declared === undefined || declared.length === 0) return 'POST';

  const verb = declared.toUpperCase();
  if (verb === 'GET') return 'GET';
  if (verb !== 'POST') {
    warn(
      `${backendId}.${methodName}: unrecognized http.method "${declared}"; calling with POST (only "GET" and "POST" are supported)`,
    );
  }
  return 'POST';
}

/**
 * Resolves the proxy subpath. `path` is optional on the wire; when absent,
 * the method name is used instead. A leading slash is added if missing so
 * callers can always build `/v1/{backendId}{path}` directly.
 */
function resolvePath(path: string | undefined, methodName: string): string {
  const raw = path && path.length > 0 ? path : methodName;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

// ---------------------------------------------------------------------------
// Normalization.
// ---------------------------------------------------------------------------

/**
 * Normalizes a parsed catalog document (the result of `JSON.parse`-ing a
 * `GET /v1/catalog` response body) into a flat list of `ToolCandidate`s.
 *
 * Malformed entries are skipped rather than throwing: a backend with no
 * `backend_id`, or a method with no `name`, has no identity to build a tool
 * name from and cannot be recovered, but one bad entry must not take down
 * discovery for every other backend/method (mirroring the gateway's own
 * per-backend skip-on-error behavior in catalog.go). Every skip is announced
 * on stderr, so a provider that vanishes from discovery always leaves a
 * trace — silently returning a short list is indistinguishable from the
 * gateway not offering the backend at all.
 */
export function normalizeCatalog(parsed: unknown): ToolCandidate[] {
  const root = asRecord(parsed);
  const backendsRaw = root ? asArray(root.backends) : undefined;
  if (!backendsRaw) return [];

  const candidates: ToolCandidate[] = [];

  for (const [backendIndex, backendRaw] of backendsRaw.entries()) {
    const backendRec = asRecord(backendRaw);
    if (!backendRec) {
      warn(`skipping catalog backend at index ${backendIndex}: entry is not an object`);
      continue;
    }

    const backendId = asString(backendRec.backend_id);
    if (!backendId) {
      warn(`skipping catalog backend at index ${backendIndex}: missing "backend_id"`);
      continue;
    }

    const backendInfoText = formatBackendInfoText(backendRec.info);
    const backendCategories = asStringArray(asRecord(backendRec.info)?.categories) ?? [];
    const billingModel = parseBillingModel(backendRec.billing);
    const userSettings = asStringArray(backendRec.user_settings) ?? [];
    const methodsRaw = asArray(backendRec.methods) ?? [];

    for (const [methodIndex, methodRaw] of methodsRaw.entries()) {
      const methodRec = asRecord(methodRaw);
      if (!methodRec) {
        warn(`skipping ${backendId} method at index ${methodIndex}: entry is not an object`);
        continue;
      }

      const methodName = asString(methodRec.name);
      if (!methodName) {
        warn(`skipping ${backendId} method at index ${methodIndex}: missing "name"`);
        continue;
      }

      // `||` not `??`: an empty-string protocol is an omitted protocol, not an
      // unsupported one. (`resolvePath` treats an empty `path` the same way.)
      const protocol = asString(methodRec.protocol) || 'http';
      if (protocol !== 'http') {
        warn(
          `skipping ${backendId}.${methodName}: unsupported protocol "${protocol}" (only "http" is supported)`,
        );
        continue;
      }

      const bindings = parseHttpBindings(methodRec.http);
      const httpMethod = resolveHttpMethod(bindings, backendId, methodName);
      const path = resolvePath(asString(methodRec.path), methodName);
      const title = asString(methodRec.title);
      const description = asString(methodRec.description) ?? '';
      const inputSchema = asRecord(methodRec.input_schema) ?? {};
      const outputSchema = asRecord(methodRec.output_schema);

      const candidate: ToolCandidate = {
        tool: methodToToolName(backendId, methodName),
        backendId,
        method: methodName,
        path,
        protocol,
        httpMethod,
        bindings,
        description,
        inputSchema,
        userSettings,
        backendInfoText,
        backendCategories,
        billingModel,
        ...(title !== undefined ? { title } : {}),
        ...(outputSchema !== undefined ? { outputSchema } : {}),
      };
      candidates.push(candidate);
    }
  }

  return candidates;
}

/**
 * Fetches and normalizes the catalog from a live gateway.
 *
 * Throws `CatalogFetchError` on a non-2xx response (`reason: 'status'`) or an
 * unparseable body (`reason: 'parse'`); classifying that failure (retryable
 * vs. fatal, gateway-code vs. status) is later tasks' job, not this one's.
 */
export async function fetchCatalog(options: FetchCatalogOptions): Promise<ToolCandidate[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, '')}/v1/catalog`;

  const response = await fetchFn(url, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
  });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new CatalogFetchError('status', response.status, bodyText);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new CatalogFetchError('parse', response.status, bodyText);
  }

  return normalizeCatalog(parsed);
}
