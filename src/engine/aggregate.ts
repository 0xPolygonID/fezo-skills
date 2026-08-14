// Turning many providers' incompatible response bodies into one comparable,
// deduplicated, source-attributed result set. Pure: no I/O, no clock, no
// randomness -- every function here is a deterministic transform, which is what
// lets the executor's tests assert on merged output without a network.
//
// Why a sniffer rather than a schema: the gateway's manifests declare
// `response_body` as free text (`jsonBody("Search results.")`), so there is no
// machine-readable output shape to normalize from. Per-provider adapters cover
// what sniffing misses (see RESPONSE_ADAPTERS), but the sniffer is what makes a
// newly-registered backend contribute results on its first day instead of
// silently returning nothing until someone writes it an adapter.

/** One result as read off a provider's response, before canonicalization. */
export interface RawItem {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

/** Query parameters that identify a click, not a document. Removing them is
 * what makes the same page found via two providers dedupe to one item. */
const TRACKING_PARAMS = [
  'gclid', 'fbclid', 'msclkid', 'mc_eid', 'mc_cid', 'igshid',
  'ref', 'ref_src', 'referrer', 'source', 'yclid', 'dclid', '_hsenc', '_hsmi',
];
// Frozen for the same reason heuristic.ts freezes RECENCY_PHRASES: this table
// defines a deterministic transform, and a table a caller could push to at run
// time would make that determinism a property of nothing -- the same document
// would canonicalize two ways in one process.
Object.freeze(TRACKING_PARAMS);

/**
 * Field names carrying each part of a result, in preference order.
 *
 * Same idiom, and the same reasoning, as one-step.ts's `ARG_CANDIDATES`: each
 * provider names the same thing differently, and a name list is the cheapest
 * thing that spans them without a per-provider table. Order matters -- the
 * first present, non-empty string wins.
 */
const FIELD_CANDIDATES = {
  url: ['url', 'link', 'href', 'web_url', 'webUrl', 'source_url', 'sourceUrl', 'permalink'],
  title: ['title', 'name', 'heading', 'headline', 'page_title'],
  snippet: ['snippet', 'description', 'summary', 'text', 'content', 'excerpt', 'abstract'],
  publishedAt: ['published_at', 'publishedAt', 'published_date', 'publishedDate', 'datePublished', 'date', 'pubDate'],
} as const;
// Both levels, as in one-step.ts's ARG_CANDIDATES: `as const` is erased at
// compile time, so freezing only the outer object leaves each name list open to
// a `.push()` from a JS consumer of the bundle or anything that got past the
// type. Field precedence is a contract; it must not be re-orderable at run time.
for (const names of Object.values(FIELD_CANDIDATES)) Object.freeze(names);
Object.freeze(FIELD_CANDIDATES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * A stable, comparison-ready form of `url`.
 *
 * Never throws: a provider can and does return values that are not URLs at all
 * (a doc id, a relative path), and an aggregation pass that threw on one bad
 * row would discard a whole provider's billed response. An unparseable value
 * comes back unchanged and simply fails to match anything else.
 */
export function canonicalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  // The scheme needs no folding: the WHATWG parser ASCII-lowercases it for
  // every scheme. The host does, though -- the parser only lowercases the host
  // of *special* schemes (http, https, ws, ...), and leaves an opaque host
  // verbatim, so `custom://EXAMPLE.COM` survives parsing with its case intact.
  // Providers hand us whatever string they stored, schemes included.
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  parsed.hash = '';
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.includes(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  parsed.search = '';
  for (const [key, value] of params) parsed.searchParams.append(key, value);
  // A trailing slash on *any* path is a server-side directory convention, not a
  // distinct document, so it is stripped everywhere rather than only at the
  // root. Done on the pathname rather than on the serialized string because a
  // string-level test sees the query last and so would never fire for a URL
  // that carries one -- which is exactly how `/a/?b=1` and `/a?b=1` came to
  // canonicalize apart, defeating the dedup this function exists for.
  if (parsed.pathname.endsWith('/') && parsed.pathname !== '/') {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  let out = parsed.toString();
  // Two cases still arrive here with a trailing slash, and neither can be handled
  // above. The root path is the one slash the pathname setter cannot remove --
  // assigning '' yields '/' again -- so it is trimmed off the serialized form
  // instead. And a URL with an *opaque* path (`custom:opaque/path/`, `data:...`)
  // has no writable pathname at all: the setter is a silent no-op there, so the
  // pathname-level rule never ran. Trimming the string is safe because the
  // urlencoded serializer escapes a '/' inside a parameter value as %2F, so a
  // final slash is always the path's own. It does leave one gap the rule above
  // has no way to close: an opaque path that also carries a query keeps its
  // slash (`custom:opaque/path/?b=1`), so the every-path invariant holds only
  // for schemes with a hierarchical path -- which is every URL a search or
  // scrape provider returns.
  if (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/** Every array nested anywhere in `body`, depth-first. */
function collectArrays(value: unknown, depth = 0, found: unknown[][] = []): unknown[][] {
  // Bounded: provider bodies are occasionally deeply nested, and an unbounded
  // walk on a hostile body is a denial of service against our own process.
  if (depth > 6) return found;
  if (Array.isArray(value)) {
    found.push(value);
    for (const entry of value) collectArrays(entry, depth + 1, found);
    return found;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) collectArrays(entry, depth + 1, found);
  }
  return found;
}

function toRawItem(entry: unknown): RawItem | undefined {
  if (!isRecord(entry)) return undefined;
  const url = firstString(entry, FIELD_CANDIDATES.url);
  if (url === undefined) return undefined;
  const title = firstString(entry, FIELD_CANDIDATES.title);
  const snippet = firstString(entry, FIELD_CANDIDATES.snippet);
  const publishedAt = firstString(entry, FIELD_CANDIDATES.publishedAt);
  return {
    url,
    ...(title !== undefined ? { title } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

/**
 * Reads a provider's parsed response body as a list of results.
 *
 * Picks the array with the MOST url-bearing objects rather than the first one
 * found: real bodies carry several arrays (related searches, sitelinks,
 * metadata), and the results array is reliably the biggest of them. Ties go to
 * the earliest found, so the result is deterministic.
 */
export function sniffItems(body: unknown): RawItem[] {
  let best: RawItem[] = [];
  for (const array of collectArrays(body)) {
    const items: RawItem[] = [];
    for (const entry of array) {
      const item = toRawItem(entry);
      if (item !== undefined) items.push(item);
    }
    if (items.length > best.length) best = items;
  }
  return best;
}

/** Reads one specific provider's response body into results. */
export type ResponseAdapter = (body: unknown) => RawItem[];

/**
 * Per-tool overrides for bodies the sniffer reads wrongly or not at all, keyed
 * by tool name (`{backendId}_{method}`, tool-name.ts's form).
 *
 * DELIBERATELY EMPTY at first. Entries are added from REAL captured responses
 * during calibration (see the plan's calibration task), never from a guess
 * about a provider's shape: a wrong adapter is worse than no adapter, because
 * it silently overrides a sniffer that was working.
 *
 * Mutable (not frozen) so tests can install a fixture adapter and remove it
 * again; nothing in production writes to it at run time.
 */
export const RESPONSE_ADAPTERS: Record<string, ResponseAdapter> = {};

/**
 * The one entry point for turning a provider's body into results: adapter if
 * one is registered for this tool, sniffer otherwise.
 *
 * An adapter that throws falls back to the sniffer rather than failing the
 * round. The response was already billed; discarding it because our own
 * transcription of a shape went stale is the worst possible trade.
 */
export function extractItems(tool: string, body: unknown): RawItem[] {
  const adapter = RESPONSE_ADAPTERS[tool];
  if (adapter !== undefined) {
    try {
      return adapter(body);
    } catch {
      return sniffItems(body);
    }
  }
  return sniffItems(body);
}
