// Catalog discovery: fetches GET /v1/catalog from a live Fezo/Zug gateway and
// normalizes its methods into ToolCandidate values that the rest of the
// engine (search/ranking, HTTP binding, schema validation, calling) builds
// on top of.
//
// This module deliberately does not transcribe gateway Go manifests (see
// zug/internal/gateway/catalog.go and manifest.go) into fixtures or a static
// roster. It only mirrors the *wire shape* those files document, and parses
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
 */
export interface HttpBodyMediaType {
  schema?: object;
}

/** Mirrors the manifest's `Body` (zug/internal/gateway/manifest.go). */
export interface HttpBody {
  description?: string;
  content?: Record<string, HttpBodyMediaType>;
}

/**
 * Mirrors the manifest's `HTTPBinding` (zug/internal/gateway/manifest.go)
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
  backendInfoText: string;
  billingModel: 'per_call' | 'dynamic' | 'package';
}

/**
 * Thrown when the catalog endpoint responds with a non-2xx status, or with a
 * 2xx status whose body cannot be parsed as JSON. Carries the raw status and
 * body so a later task (retry classification, error rendering) can decide
 * what it means; this module does not classify or interpret it.
 */
export class CatalogFetchError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`catalog fetch failed with status ${status}`);
    this.name = 'CatalogFetchError';
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

interface CatalogInfo {
  title?: string;
  summary?: string;
  description?: string;
  docsUrl?: string;
  categories?: string[];
}

function parseInfo(value: unknown): CatalogInfo | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;

  const info: CatalogInfo = {};
  const title = asString(rec.title);
  if (title !== undefined) info.title = title;
  const summary = asString(rec.summary);
  if (summary !== undefined) info.summary = summary;
  const description = asString(rec.description);
  if (description !== undefined) info.description = description;
  const docsUrl = asString(rec.docs_url);
  if (docsUrl !== undefined) info.docsUrl = docsUrl;
  const categories = asStringArray(rec.categories);
  if (categories !== undefined) info.categories = categories;
  return info;
}

/**
 * Renders a backend's optional `info` block into a single human-readable
 * string for a tool candidate's `backendInfoText`. There is no wire format
 * for this — it exists to give the skill/CLI something to show alongside a
 * tool without re-fetching backend docs. A backend with no `info` block
 * (the common case for a minimal manifest) renders to an empty string.
 */
function formatBackendInfoText(info: CatalogInfo | undefined): string {
  if (!info) return '';
  const parts: string[] = [];
  if (info.title) parts.push(info.title);
  if (info.summary) parts.push(info.summary);
  if (info.description) parts.push(info.description);
  if (info.categories && info.categories.length > 0) {
    parts.push(`Categories: ${info.categories.join(', ')}`);
  }
  if (info.docsUrl) parts.push(`Docs: ${info.docsUrl}`);
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
      const media: HttpBodyMediaType = {};
      const schema = mediaRec ? asRecord(mediaRec.schema) : undefined;
      if (schema) media.schema = schema;
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
 * Resolves the HTTP verb to call with. `http.method` is optional on the
 * catalog's wire format; when absent (or set to anything other than "GET"),
 * the verb defaults to POST, per the governing spec.
 */
function resolveHttpMethod(bindings: HttpBindings): 'GET' | 'POST' {
  return bindings.method?.toUpperCase() === 'GET' ? 'GET' : 'POST';
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
 * per-backend skip-on-error behavior in catalog.go).
 */
export function normalizeCatalog(parsed: unknown): ToolCandidate[] {
  const root = asRecord(parsed);
  const backendsRaw = root ? asArray(root.backends) : undefined;
  if (!backendsRaw) return [];

  const candidates: ToolCandidate[] = [];

  for (const backendRaw of backendsRaw) {
    const backendRec = asRecord(backendRaw);
    if (!backendRec) continue;

    const backendId = asString(backendRec.backend_id);
    if (!backendId) continue;

    const backendInfoText = formatBackendInfoText(parseInfo(backendRec.info));
    const billingModel = parseBillingModel(backendRec.billing);
    const userSettings = asStringArray(backendRec.user_settings) ?? [];
    const methodsRaw = asArray(backendRec.methods) ?? [];

    for (const methodRaw of methodsRaw) {
      const methodRec = asRecord(methodRaw);
      if (!methodRec) continue;

      const methodName = asString(methodRec.name);
      if (!methodName) continue;

      const protocol = asString(methodRec.protocol) ?? 'http';
      if (protocol !== 'http') {
        process.stderr.write(
          `fezoctl: skipping ${backendId}.${methodName}: unsupported protocol "${protocol}" (only "http" is supported)\n`,
        );
        continue;
      }

      const bindings = parseHttpBindings(methodRec.http);
      const httpMethod = resolveHttpMethod(bindings);
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
 * Throws `CatalogFetchError` on a non-2xx response or an unparseable body;
 * classifying that failure (retryable vs. fatal, gateway-code vs. status) is
 * later tasks' job, not this one's.
 */
export async function fetchCatalog(options: FetchCatalogOptions): Promise<ToolCandidate[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, '')}/v1/catalog`;

  const response = await fetchFn(url, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
  });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new CatalogFetchError(response.status, bodyText);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new CatalogFetchError(response.status, bodyText);
  }

  return normalizeCatalog(parsed);
}
