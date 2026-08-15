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

/**
 * Query parameters that identify a click, not a document. Removing them is
 * what makes the same page found via two providers dedupe to one item.
 *
 * Every entry beyond the spec's list (`utm_*`, `gclid`, `fbclid`, `mc_eid`,
 * `ref`, `ref_src`) is a VENDOR-NAMESPACED click id -- `msclkid` (Microsoft),
 * `mc_cid` (Mailchimp campaign), `igshid` (Instagram), `yclid` (Yandex),
 * `dclid` (DoubleClick), `_hsenc`/`_hsmi` (HubSpot). None of them can select
 * content: no server branches on them, so dropping them can only ever merge two
 * spellings of one document, never two documents. Recorded as a deviation under
 * the plan's Task 4.
 *
 * `source` and `referrer` are deliberately ABSENT, and must not be added back.
 * They are ordinary English words, and real sites route on them (a feed
 * variant, a localized edition, a print view), so stripping them merges pages
 * that are genuinely different and demotes a billed result onto `duplicates`.
 * The asymmetry decides it: failing to merge two spellings costs a duplicate
 * row a caller can see, while merging two documents destroys one of them
 * silently.
 */
const TRACKING_PARAMS = [
  'gclid', 'fbclid', 'msclkid', 'mc_eid', 'mc_cid', 'igshid',
  'ref', 'ref_src', 'yclid', 'dclid', '_hsenc', '_hsmi',
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
  // `page_age` is FIRST among the vendor spellings and ahead of `date`, on
  // evidence rather than taste: the captured fixtures
  // (tests/fixtures/responses/) show Brave (web and news) and You.com dating
  // every result with `page_age` in ISO-8601, while Brave's `age` alongside it
  // is human prose ("January 12, 2021") and its `date` appears on nested
  // metadata rather than on the result. Omitting `page_age` silently dropped
  // the date from three of the six calibrated providers -- including both news
  // paths, where recency is the entire point of the intent.
  publishedAt: [
    'published_at', 'publishedAt', 'published_date', 'publishedDate', 'datePublished',
    'page_age', 'date', 'pubDate',
  ],
} as const;
// Both levels, as in one-step.ts's ARG_CANDIDATES: `as const` is erased at
// compile time, so freezing only the outer object leaves each name list open to
// a `.push()` from a JS consumer of the bundle or anything that got past the
// type. Field precedence is a contract; it must not be re-orderable at run time.
for (const names of Object.values(FIELD_CANDIDATES)) Object.freeze(names);
Object.freeze(FIELD_CANDIDATES);

/**
 * Longest snippet kept on a `RawItem`, in characters.
 *
 * The bound is on the emitted string, ellipsis included, not on the text
 * retained beneath it -- a cap a caller can read off the output is worth more
 * than one that is a character short of what it says.
 *
 * A snippet is a preview, not a document: a real SERP snippet is 150-300
 * characters, so 500 keeps every genuine one intact. The cap exists because
 * `content` is a snippet candidate and the Firecrawl-family backends put a
 * whole page's markdown in it -- a 200,000-character "snippet" is reachable
 * today, and one `research` round at fanout 8 across such providers emits a
 * multi-megabyte `--json` document that no agent can read and every consumer
 * has to buffer. Capping per item rather than per document keeps the bound
 * true however many providers answer.
 */
export const SNIPPET_MAX_CHARS = 500;

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
  // ALL leading `www.` labels, not one. `replace(/^www\./, '')` strips a single
  // prefix, which makes this whole function NON-IDEMPOTENT for a host like
  // `www.www.example.com`: one pass yields `www.example.com`, a second yields
  // `example.com`. That matters because the pipeline canonicalizes twice --
  // `research.ts` merges per query and then merges those merges, and
  // `seenUrlsFrom` canonicalizes items whose URLs are already canonical. The
  // second application then produced a DIFFERENT key, so provider attribution
  // was looked up under a URL that no longer existed, and the session stored a
  // URL that could never match the next round's suppression check.
  //
  // Canonicalization must be idempotent to be composable at all; that property
  // is pinned by a corpus test rather than left to this comment.
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^(?:www\.)+/, '');
  parsed.hash = '';
  // Userinfo is stripped, not carried. It is not part of the DOCUMENT's
  // identity -- `https://user:pw@example.com/a` and `https://example.com/a` are
  // the same page -- so keeping it both defeats the dedup this function exists
  // for and writes a credential into places that outlive the round: the
  // canonical key, `duplicates`, stdout, and the session cache on disk. A
  // provider echoing such a URL back is uncommon but not rare, and nothing
  // downstream would ever remove it.
  parsed.username = '';
  parsed.password = '';
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
  if (parsed.pathname !== '/') {
    // EVERY trailing slash, not one -- the same idempotency requirement as the
    // `www.` strip above, and it was broken the same way. `slice(0, -1)` turned
    // `/p//?b=1` into `/p/?b=1` on the first pass and `/p?b=1` on the second,
    // so a URL with a doubled trailing slash canonicalized to two different
    // keys depending on how many times the pipeline had been through it. The
    // `|| '/'` restores the root when a path was nothing but slashes.
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
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

/**
 * `text` truncated to `SNIPPET_MAX_CHARS`, ellipsis included in the count.
 *
 * The ellipsis is the whole point of not slicing silently: a truncated preview
 * that ends mid-sentence with no marker reads as a provider that returned a
 * broken snippet, and someone then goes looking for a bug in the provider
 * rather than finding this cap. It costs one character of text rather than
 * being added on top, so the emitted string honours the cap the constant
 * declares instead of overrunning it by one.
 *
 * Shared by BOTH producers of a `RawItem` -- the sniffer (`toRawItem`) and the
 * adapter path (`sanitizeRow`). It lived inline in the sniffer first, which
 * left the adapter path uncapped; a cap that only one of two producers applies
 * is not a bound on anything.
 */
function capText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  // Never cut between a surrogate pair. `String.prototype.slice` counts UTF-16
  // code units, so a boundary landing inside an astral character (emoji, most
  // CJK extensions, mathematical alphanumerics) emits a lone high surrogate --
  // a string that is not well-formed UTF-16 and renders as a replacement
  // character wherever it lands. Backing off one unit costs one character and
  // makes the cap safe for every script rather than for Latin-1 only.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function capSnippet(text: string): string {
  return capText(text, SNIPPET_MAX_CHARS);
}

/**
 * `title` is capped for the same reason `snippet` is, and on both the same
 * paths.
 *
 * A provider that puts whole-page text where a title belongs is not
 * hypothetical -- it is the same Firecrawl-family shape that motivated the
 * snippet cap -- and an uncapped title is worse, because `mergeItems` uses the
 * title as a dedup KEY: a 200,000-character key is hashed and compared on every
 * cross-host pass, and the merged item carries it into the JSON document, the
 * human render, and the RRF-ordered list a caller reads first.
 *
 * Larger than the snippet cap because a title is the field a reader scans, and
 * truncating a long-but-legitimate headline hurts more than carrying it.
 *
 * APPLIED AT THE RENDER BOUNDARY (`render.ts`), never anywhere identity is
 * decided. Capping a title puts a truncated string into the cross-host dedup
 * KEY -- `titleKey` strips the ellipsis -- so two distinct documents whose
 * titles agree for the first 299 characters collapse into one. That is exactly
 * the input class the cap exists for: a provider putting whole-page text in the
 * title, where a shared cookie or nav banner fills the opening paragraphs. The
 * cost is three harms at once: a real result deleted, two providers recorded as
 * agreeing (doubling the RRF score and inflating `agreement_median`), and a
 * self-contradicting document whose `coverage.queries` and `items` disagree
 * about how many URLs were found.
 *
 * This was first fixed by moving the cap from the producers to the end of
 * `mergeItems`, which was still wrong: `research.ts` merges per query and then
 * merges those merges, so the "end" of the first call is the INPUT of the
 * second. A cap is only safe where nothing downstream compares titles again --
 * and the only such place is where the text is written out.
 */
const TITLE_MAX_CHARS = 300;

export function capTitle(text: string): string {
  return capText(text, TITLE_MAX_CHARS);
}

function toRawItem(entry: unknown): RawItem | undefined {
  if (!isRecord(entry)) return undefined;
  const url = firstString(entry, FIELD_CANDIDATES.url);
  if (url === undefined) return undefined;
  const title = firstString(entry, FIELD_CANDIDATES.title);
  const full = firstString(entry, FIELD_CANDIDATES.snippet);
  const snippet = full !== undefined ? capSnippet(full) : undefined;
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
  // Only when the object sweep found nothing: see `sniffUrlStrings`. Folded in
  // here rather than layered over this function by its callers, so every
  // consumer -- `extractItems` and any direct caller -- reads the same shapes.
  return best.length > 0 ? best : sniffUrlStrings(body);
}

/**
 * Absolute http(s) URLs, for reading an array of bare strings.
 *
 * Deliberately stricter than `canonicalizeUrl`'s "try to parse it": that
 * function is forgiving because it is handed a value a provider already
 * NOMINATED as a URL (it sat under a `url`/`link` key). Here there is no such
 * nomination -- the only evidence is the shape of the string itself -- so a
 * relative path, a doc id or a sentence must not be promoted into a result.
 */
const BARE_URL = /^https?:\/\/\S+$/;

/**
 * Keys whose array value is plausibly a RESULT SET.
 *
 * An allow-list, not a deny-list, and that asymmetry is the whole safety of
 * this fallback. A deny-list has to anticipate every non-result array a
 * provider might carry -- and the first version of this code, which had no
 * list at all, turned a zero-hit SERP body into two fabricated results by
 * reading its `related_searches`. An allow-list fails the other way: an
 * unrecognized key contributes nothing, the provider is honestly reported as
 * returning nothing, and the fix is to add one name here.
 *
 * The arrays this deliberately does NOT read are the ones a zero-hit response
 * is made of: `related_searches`, `pagination`, `images`, `sitelinks`, `next`,
 * `tags`. Those are navigation and metadata; presenting them as findings is a
 * claim about the web nobody made.
 */
const RESULT_ARRAY_KEYS: ReadonlySet<string> = new Set([
  'results', 'organic_results', 'items', 'hits', 'records', 'entries', 'urls', 'data',
]);
// `docs` is deliberately absent despite being a real result key in some search
// APIs: it is also where an error payload puts a documentation link, and this
// walk has no notion of the surrounding context. Under the allow-list's
// failure asymmetry, leaving it out costs one provider's results until someone
// adds it deliberately, while including it turns an error body into a finding.

/**
 * Reads an array of bare URL strings, the commonest non-object result shape.
 *
 * Two constraints, both load-bearing:
 *
 * 1. **Only under a result-shaped key** (`RESULT_ARRAY_KEYS`), or as the body's
 *    own top-level array. Anything else is navigation, and reading it
 *    fabricates results out of a response that honestly found nothing -- which
 *    also suppresses the "returned no results" gap and can flip a round from
 *    failed to ok.
 * 2. **Only as a FALLBACK**, after the object-shaped sweep found nothing, so a
 *    body carrying real result objects can never be out-scored by some longer
 *    array of strings elsewhere in it.
 *
 * A result read this way has a URL and nothing else -- no title, no snippet --
 * which is exactly what such a provider gave us.
 */
function sniffUrlStrings(body: unknown): RawItem[] {
  let best: RawItem[] = [];
  const consider = (value: unknown, key: string | undefined, depth: number): void => {
    if (depth > 6) return;
    if (Array.isArray(value)) {
      // `undefined` key means the body itself is the array: a top-level array
      // of URLs has no competing interpretation.
      if (key === undefined || RESULT_ARRAY_KEYS.has(key.toLowerCase())) {
        const items: RawItem[] = [];
        for (const entry of value) {
          if (typeof entry !== 'string') continue;
          const trimmed = entry.trim();
          if (BARE_URL.test(trimmed)) items.push({ url: trimmed });
        }
        if (items.length > best.length) best = items;
      }
      // Still descend: a result array is often nested one level down
      // (`{web: {results: [...]}}`), and the elements may be objects holding
      // their own result arrays.
      for (const entry of value) consider(entry, key, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const [childKey, child] of Object.entries(value)) consider(child, childKey, depth + 1);
    }
  };
  consider(body, undefined, 0);
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
 *
 * A non-array return is treated exactly like a throw, and has to be: adapters
 * are hand-transcribed from captured responses, so `return body.results` on a
 * body that turned out to have no `results` -- yielding `undefined`, not an
 * exception -- is the single likeliest transcription mistake there is. Left
 * unchecked it becomes `lane.items`, where `mergeItems`'s `forEach` throws and
 * takes down EVERY lane's already-paid-for results, not just this one. The
 * `Array.isArray` test is a type guard as much as a value check: `RawItem[]` is
 * a compile-time promise an adapter is under no runtime obligation to keep.
 */
export function extractItems(tool: string, body: unknown): RawItem[] {
  const adapter = RESPONSE_ADAPTERS[tool];
  if (adapter !== undefined) {
    try {
      const out: unknown = adapter(body);
      return Array.isArray(out) ? (out as RawItem[]) : sniffItems(body);
    } catch {
      return sniffItems(body);
    }
  }
  return sniffItems(body);
}

/**
 * Which provider contributed an item, and where it sat on that provider's own list.
 *
 * INVARIANT, on every `ProviderHit[]` this module produces: **at most one entry
 * per `backendId`**, carrying that backend's best (lowest) `resultRank`.
 * `providers.length` is therefore literally the number of distinct providers
 * that returned the document, which is what both the RRF score and Task 7's
 * agreement arithmetic read it as. Two paths would otherwise duplicate a
 * backend -- one lane returning the same canonical URL twice, and the pass-2
 * title collapse folding several of one lane's items together -- and either
 * turns one provider's redundancy into fabricated agreement. `recordHit` is the
 * only way to extend such an array; see its comment.
 */
export interface ProviderHit {
  backendId: string;
  /** The provider's rank in the fan-out (diversity order position, 1-based). */
  rank: number;
  /** This item's 1-based position within that provider's own results. */
  resultRank: number;
}

/**
 * Adds `hit` under the one-entry-per-backend invariant declared on `ProviderHit`.
 *
 * The best (lowest) `resultRank` wins, because that is what the RRF term means:
 * how highly this provider ranked the document. A provider that listed a page
 * first and again at position 9 ranked it first; taking the later position, or
 * summing both, would score its own redundancy as either a demotion or an
 * endorsement. `rank` moves with `resultRank` rather than being kept
 * independently, so the surviving hit is one provider's actual answer and not a
 * splice of two.
 *
 * A linear scan, not a Map: `providers` is bounded by the fan-out width
 * (`MAX_FANOUT = 10`), so the scan is cheaper than the Map it would replace and
 * keeps the array's order -- first-contributing backend first -- which is what
 * makes the emitted document byte-stable for a given lane order.
 *
 * Exported because a fourth site appeared, exactly as the note on `ProviderHit`
 * anticipated: the executor unions one document's hits across sub-queries, and
 * a hand-copied version of this rule living there would let the invariant drift
 * out of the module that declares it.
 */
export function recordHit(providers: ProviderHit[], hit: ProviderHit): void {
  const existing = providers.find((p) => p.backendId === hit.backendId);
  if (existing === undefined) {
    providers.push(hit);
    return;
  }
  if (hit.resultRank < existing.resultRank) {
    existing.rank = hit.rank;
    existing.resultRank = hit.resultRank;
  }
}

export interface ResearchItem {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: string;
  providers: ProviderHit[];
  score: number;
  /** Every other original URL collapsed into this item -- nothing is discarded
   * by dedup, only grouped, so a caller can always see what was merged. */
  duplicates: string[];
}

/** One provider lane's contribution to a round. */
export interface LaneItems {
  backendId: string;
  rank: number;
  items: readonly RawItem[];
}

/**
 * Reciprocal rank fusion's smoothing constant, at its standard value.
 *
 * RRF is used rather than any provider-reported relevance score because those
 * scores are incomparable across providers (different scales, different
 * meanings) and most providers omit them entirely. Rank position is the one
 * signal every provider actually gives us.
 */
export const RRF_K = 60;

/**
 * Title reduced to a comparison key: case-folded, punctuation removed,
 * whitespace collapsed. Used only for the cross-host near-duplicate pass.
 *
 * The retained class is the Unicode letter/number properties, not `[a-z0-9]`.
 * An ASCII-only class does not merely fail to normalize a non-Latin title, it
 * erases it: every Cyrillic, CJK, Arabic, Greek or Hebrew title reduces to the
 * empty string, and an empty string is a perfectly usable Map key, so unrelated
 * non-English results would all compare equal and collapse into one item. The
 * target is ES2023, so property escapes cost no dependency and no transpile.
 */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/**
 * The host a URL belongs to, or `undefined` when the value carries no host
 * evidence at all.
 *
 * "No host" is a first-class answer, exactly like the degenerate title key
 * below, and for the same reason: returning any stand-in instead would be
 * *worse* than no answer. Every item sits under a distinct canonical URL, so a
 * fabricated host is unique by construction, which makes the "different host"
 * test in pass 2 trivially true and disables the same-host guard for precisely
 * the inputs it protects -- many pages of one site sharing one title.
 *
 * Two input classes reach that state, and `canonicalizeUrl`'s docstring names
 * them together in one breath ("a doc id, a relative path") because providers
 * emit both: a relative href, which the parser rejects, and an opaque-scheme
 * value, which it accepts. Neither is a hypothesis -- the SERP-scraping backends
 * emit site-relative links, and a doc id is what a corpus-backed provider
 * returns when it has no web URL to give. They must be treated identically here
 * even though only one of them throws.
 */
function hostOf(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  // An opaque-scheme URL parses fine and has no host at all: `new URL('doc:1234')`
  // yields hostname ''. So do `mailto:`, `urn:`, `data:` and `file:`. That is the
  // absence of host evidence, not a host -- and '' is a perfectly usable Set
  // member, so returning it would make '' read as a *known* host differing from
  // every real hostname: the same fabricated-evidence failure as the catch above,
  // reached without ever throwing.
  return host === '' ? undefined : host;
}

/**
 * One lane row reduced to the fields this module may actually rely on, or
 * `undefined` when the row carries nothing usable.
 *
 * `RawItem` is a compile-time promise, and an adapter is the one producer that
 * can break it: hand-transcribed from a captured response, `body.results.map(r
 * => ({url: r.url, title: r.title}))` against a body whose keys were renamed
 * yields rows that are `undefined`, or whose `title` is a number, or whose
 * `snippet` is an object. `extractItems` only checks that the adapter returned
 * an ARRAY -- element-wise the contents are still whatever the provider had --
 * so the elements have to be checked here, once, at the only place they enter.
 *
 * The blast radius is why this is a guard and not an assumption: `mergeItems`
 * runs after every lane has been billed, so one bad row throwing out of it
 * (`raw.url` on `undefined`, `title.toLowerCase` on a number in pass 2)
 * destroys EVERY other lane's paid-for results, not just this one.
 *
 * A row with no usable url is dropped rather than repaired -- an item with no
 * URL cannot be deduped, cited or fetched -- while a bad optional field only
 * costs that field, because a title or snippet is not what the pipeline keys
 * on. `url` is passed through untrimmed: `canonicalizeUrl` already tolerates
 * surrounding whitespace, and `duplicates` must report the string the provider
 * actually sent.
 */
function sanitizeRow(entry: unknown): RawItem | undefined {
  if (!isRecord(entry)) return undefined;
  const { url, title, snippet, publishedAt } = entry;
  if (typeof url !== 'string' || url.trim() === '') return undefined;
  return {
    url,
    ...(typeof title === 'string' ? { title } : {}),
    // Capped here as well as in `toRawItem`, so the bound is a property of
    // every item entering `mergeItems` rather than of one of its two
    // producers. This is the ADAPTER path, and adapters are hand-transcribed
    // from live captures -- including the Firecrawl-family responses that put
    // whole-page markdown in `content`, which is exactly the 200,000-character
    // snippet the cap exists to stop. Capping in only one producer left the
    // constant's own promise ("keeps the bound true however many providers
    // answer") false for every adapter-served provider.
    ...(typeof snippet === 'string' ? { snippet: capSnippet(snippet) } : {}),
    ...(typeof publishedAt === 'string' ? { publishedAt } : {}),
  };
}

/**
 * Merges every lane's results into one ordered, deduplicated set.
 *
 * Two passes, in this order:
 *
 * 1. **Canonical URL.** Exact same document, however each provider decorated
 *    the link. This pass is safe and always correct.
 * 2. **Near-identical title across DIFFERENT hosts.** One wire story carried by
 *    six outlets. Restricted to cross-host pairs because a site legitimately
 *    reuses one title across many of its own pages (docs sections, paginated
 *    listings), and merging those would destroy real results. "Different host"
 *    means a *known* host, differing from *every* host already merged under that
 *    title -- not just from the representative's, or the same-host pages would
 *    sneak in transitively, and not a URL that carries no host standing in for
 *    one (whether it failed to parse or parsed to an empty hostname), or the
 *    guard would be satisfied by an item about which we know nothing. This
 *    pass is a judgement call, which is why every collapsed URL survives on
 *    `duplicates` and every contributing provider on `providers`.
 *
 * `seenUrls` (canonical) are dropped entirely -- that is what makes a
 * multi-round research session return only new material instead of re-paying
 * for the same links.
 *
 * **`lanes` ORDER IS PART OF THE INPUT, and the caller owns it.** This function
 * is pure and deterministic *given its argument*, but not order-independent: in
 * both passes the first-seen item becomes the representative, so which of two
 * merged URLs survives -- and therefore what the output document says -- is
 * decided by lane position. A bounded concurrency pool appends lanes in
 * COMPLETION order by default, which is a race, so the executor must assemble
 * this array in a deterministic order (plan order: query, then diversity
 * position) rather than in the order the network answered. Sorting here instead
 * was rejected: a lane's identity is `(query, diversity rank)` and this module
 * is deliberately not told about queries.
 */
export function mergeItems(
  lanes: readonly LaneItems[],
  seenUrls: ReadonlySet<string> = new Set(),
): { items: ResearchItem[]; suppressed: number; suppressedUrls: Set<string> } {
  const byCanonical = new Map<string, ResearchItem>();
  // A set, not a counter: the figure the caller reads is "pages you already had
  // and so did not get again", which is per-document. Counting lane hits instead
  // would multiply it by the fan-out width -- one already-seen page returned by
  // three providers would be reported as three suppressed pages -- and the
  // fan-out width is not a thing the caller asked about.
  const suppressedUrls = new Set<string>();

  for (const lane of lanes) {
    lane.items.forEach((entry, index) => {
      // Validated before anything is read off it, and validated ONCE: see
      // `sanitizeRow` for why an adapter's rows cannot be trusted element-wise
      // and what a bad one used to cost. Everything below this line works on
      // the sanitized row, so no later site has to re-check a field. The index
      // still advances over a dropped row, so the surviving items keep the
      // provider's own ranking.
      const raw = sanitizeRow(entry);
      if (raw === undefined) return;
      const canonical = canonicalizeUrl(raw.url);
      if (seenUrls.has(canonical)) {
        suppressedUrls.add(canonical);
        return;
      }
      const hit: ProviderHit = { backendId: lane.backendId, rank: lane.rank, resultRank: index + 1 };
      const existing = byCanonical.get(canonical);
      if (existing === undefined) {
        byCanonical.set(canonical, {
          url: canonical,
          title: raw.title ?? canonical,
          ...(raw.snippet !== undefined ? { snippet: raw.snippet } : {}),
          ...(raw.publishedAt !== undefined ? { publishedAt: raw.publishedAt } : {}),
          providers: [hit],
          score: 0,
          // Redacted FIRST, then compared. Comparing the raw URL and storing
          // the redacted one made a credentialed URL its own duplicate: the
          // two differ only by userinfo, so they are equal once redacted, and
          // the item recorded a second source it never had. The sibling push
          // below always got this right; this branch did not.
          duplicates: redactUserinfo(raw.url) === canonical ? [] : [redactUserinfo(raw.url)],
        });
        return;
      }
      // Via `recordHit`, not `push`: this same lane may have listed the same
      // document twice (pagination, a decorated duplicate), and a backend
      // counted twice reads downstream as two providers agreeing.
      recordHit(existing.providers, hit);
      const original = redactUserinfo(raw.url);
      if (original !== canonical && !existing.duplicates.includes(original)) existing.duplicates.push(original);
      // Keep the richest text: a provider that returned a snippet is more
      // useful than one that returned only a link, whichever arrived first.
      //
      // The title obeys the same rule, and has to: a title-less first
      // contributor left the canonical URL standing in as the title, and a real
      // title from any later provider beats that placeholder both for the reader
      // and for pass 2, which skips an item whose title is still its own URL.
      // Without this the dedup outcome would depend on which lane arrived first.
      if (existing.title === existing.url && raw.title !== undefined) existing.title = raw.title;
      if (existing.snippet === undefined && raw.snippet !== undefined) existing.snippet = raw.snippet;
      if (existing.publishedAt === undefined && raw.publishedAt !== undefined) existing.publishedAt = raw.publishedAt;
    });
  }

  // Pass 2: cross-host title collapse.
  //
  // Each key carries the FULL set of hosts already folded into its
  // representative, not just the representative's own host. Comparing against
  // one host is not a weaker version of the guard, it is a broken one: two pages
  // on a single site merge with each other transitively, through whichever
  // cross-host item happened to claim the key first, and which pages survive
  // then depends on Map iteration order. That is precisely the destruction of
  // real results this pass exists to avoid.
  const byTitle = new Map<string, { rep: ResearchItem; hosts: Set<string> }>();
  const merged: ResearchItem[] = [];
  for (const item of byCanonical.values()) {
    // A title that reduces to nothing is no evidence of sameness, so it must
    // never become a merge key -- and '' is a valid Map key, so "reduces to
    // nothing" has to be rejected explicitly rather than trusted to be absent.
    // Two sources of one: an item still carrying its URL as a placeholder title,
    // and a title made only of characters the key strips (pure punctuation).
    const reduced = item.title === item.url ? '' : titleKey(item.title);
    const key = reduced === '' ? undefined : reduced;
    const entry = key !== undefined ? byTitle.get(key) : undefined;
    // An item whose URL carries no host -- it failed to parse, or it parsed to
    // an empty hostname -- has no known host, and so can neither join a key (the
    // cross-host condition is unsatisfiable without evidence) nor claim one (a
    // later item must not be judged "different host" against a host we never
    // established).
    const host = hostOf(item.url);
    if (entry !== undefined && host !== undefined && !entry.hosts.has(host)) {
      entry.hosts.add(host);
      // The second place a backend can be counted twice, and the one that pays
      // best: one lane's own results for a wire story carried by six outlets
      // all fold in here, so a plain `push(...)` scored a single provider as
      // six. `recordHit` per hit keeps the invariant and the best rank.
      for (const hit of item.providers) recordHit(entry.rep.providers, hit);
      // No membership guard here, unlike the pass-1 push above: `item` and
      // `entry.rep` sit under distinct canonical URLs, and canonicalization is a
      // function, so no original URL can appear under both -- their duplicate
      // sets are necessarily disjoint.
      entry.rep.duplicates.push(item.url, ...item.duplicates);
      if (entry.rep.snippet === undefined && item.snippet !== undefined) entry.rep.snippet = item.snippet;
      if (entry.rep.publishedAt === undefined && item.publishedAt !== undefined) entry.rep.publishedAt = item.publishedAt;
      continue;
    }
    if (key !== undefined && entry === undefined && host !== undefined) byTitle.set(key, { rep: item, hosts: new Set([host]) });
    merged.push(item);
  }

  // One term per DISTINCT backend, which is what `ProviderHit`'s invariant
  // makes this reduce mean: RRF's premise is that appearing high on several
  // lists beats appearing first on one, so the sum has to run over lists, not
  // over hits. Summed over hits, one provider returning a wire story from three
  // outlets scored 0.0484 and outranked a real two-provider agreement at
  // 0.0328 -- the ranking signal inverted by the redundancy it was supposed to
  // see through.
  for (const item of merged) {
    item.score = item.providers.reduce((sum, hit) => sum + 1 / (RRF_K + hit.resultRank), 0);
  }
  merged.sort((a, b) => (b.score - a.score) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  // NO TITLE CAP HERE. See TITLE_MAX_CHARS: capping anywhere inside this
  // function poisons a dedup key, and "at the end" is not far enough -- callers
  // compose `mergeItems` (research.ts merges per query, then merges the results
  // of those merges), so a title capped at the end of one call is a capped
  // title entering the next call's cross-host key. The cap belongs at the
  // boundary where text is EMITTED, not where identity is decided.
  // The SET travels alongside the count, because the per-document figure this
  // function is careful to compute is only per-document within ONE call: a
  // caller that merges per sub-query and adds the counts up reintroduces the
  // multiplication the comment on `suppressedUrls` rejects, on the query axis
  // instead of the lane axis. One already-seen page returned under three
  // sub-queries is still one page the round withheld, and unioning the sets is
  // the only way a multi-call caller can say so. Fresh per call, so handing it
  // out aliases nothing this function still holds.
  return { items: merged, suppressed: suppressedUrls.size, suppressedUrls };
}

/** Below this many unique URLs, a query is reported as thin. */
const THIN_QUERY_THRESHOLD = 3;

export interface QueryCoverage {
  query: string;
  uniqueUrls: number;
  /** Median number of providers that returned each item. 1 means no provider
   * corroborated any other -- weak coverage even when the count looks fine. */
  agreementMedian: number;
}

/**
 * A planned target this round returned no page for, and why.
 *
 * The URL stays BARE and the cause travels beside it rather than inside it,
 * because `nextActions` shell-quotes this `url` as the sole argument of
 * `fezoctl scrape` and promises the result is ready to run. A caller that
 * pre-formatted `https://t.example (rate_limited)` into one string would emit a
 * follow-up command the agent cannot run -- and that one-step `scrape` is
 * precisely the fallback a fan-out delegates a failed target to, so destroying
 * it costs the round its only remedy.
 */
export interface UnfetchedTarget {
  url: string;
  /** Absent when the call budget left no room to attempt the fetch at all;
   * present when a fetch was attempted and failed, or no provider in the
   * catalog could serve it. */
  reason?: string;
}

/**
 * A query this round planned but did not run, and why.
 *
 * Structured rather than a bare string, for the same reason `UnfetchedTarget`
 * is: two causes reach this list and they call for different responses from the
 * caller. A budget drop (`reason` absent) is a "run it again, on its own" —
 * money was left unspent. An abort (`reason` present) means the ACCOUNT stopped
 * the round, and running it again spends into whatever tripped. Rendering both
 * as "not run (call budget)" told the caller to do the one thing that cannot
 * work.
 */
export interface DroppedQuery {
  query: string;
  /** Absent for a call-budget drop; present when something other than the
   * budget stopped it (today: the round aborted). */
  reason?: string;
}

/**
 * A query that ran at less than its planned fan-out width because the call
 * budget could not cover all of it.
 *
 * Reported because a narrowed round and a full one are otherwise
 * indistinguishable in the output: the caller sees fewer results and reads them
 * as the web being thin, when the truth is that the round asked fewer
 * providers. Same principle as every other field here — a silent gap reads as
 * full coverage.
 */
export interface NarrowedQuery {
  query: string;
  /** The fan-out width the plan asked for. */
  requested: number;
  /** The number of lanes the budget actually allowed. */
  actual: number;
}

export interface Coverage {
  queries: QueryCoverage[];
  served: string[];
  failed: Array<{ backendId: string; reason: string }>;
  skipped: string[];
  domainConcentration?: { host: string; share: number };
  droppedQueries: DroppedQuery[];
  unfetchedTargets: UnfetchedTarget[];
  narrowedQueries: NarrowedQuery[];
  /** Results withheld because a session had already seen them. */
  suppressed: number;
  /** Machine-computed, human-readable. The agent's cue to spend another round. */
  gaps: string[];
}

/**
 * `url` with any userinfo removed, for recording an ORIGINAL on `duplicates`.
 *
 * `duplicates` exists to show what was collapsed into an item, and the original
 * spelling is the useful part of that -- but a password is not part of a
 * spelling, and `duplicates` is printed to stdout and serialized into the
 * `--json` document. Redacting keeps the record and drops the secret.
 * Unparseable values (a doc id, a relative path) pass through unchanged, the
 * same forgiving contract `canonicalizeUrl` states.
 */
function redactUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === '' && parsed.password === '') return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Dropped queries that carry a reason, grouped by it, in first-seen order —
 * so N queries stopped by one abort render as one line naming all of them
 * rather than N lines repeating the same cause. */
function groupByReason(dropped: readonly DroppedQuery[]): Array<[string, string[]]> {
  const byReason = new Map<string, string[]>();
  for (const entry of dropped) {
    if (entry.reason === undefined) continue;
    const list = byReason.get(entry.reason);
    if (list) list.push(entry.query);
    else byReason.set(entry.reason, [entry.query]);
  }
  return [...byReason.entries()];
}

export interface CoverageInput {
  queries: Array<{ query: string; items: readonly ResearchItem[] }>;
  served: string[];
  failed: Array<{ backendId: string; reason: string }>;
  skipped: string[];
  droppedQueries: DroppedQuery[];
  unfetchedTargets: UnfetchedTarget[];
  narrowedQueries: NarrowedQuery[];
  suppressed: number;
}

export interface NextAction {
  why: string;
  /**
   * A literally runnable command, or ABSENT when the honest next step is not a
   * command this CLI has.
   *
   * Optional rather than filled with prose: `cmd` is printed in command
   * position by `renderResearch` and SKILL.md tells the agent to run what it
   * finds there, so a sentence in this field is an instruction to shell out to
   * its first word. The account-scoped abort action is the case -- nothing in
   * `fezoctl` raises a spend limit or replaces a key -- and naming a real
   * command anyway (`doctor`) would send the agent somewhere that cannot help.
   */
  cmd?: string;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/**
 * Everything about this round that a caller could act on, computed from the
 * round's own data -- never a judgement about whether the RESULTS answered the
 * question, which needs the question's meaning and belongs to the agent.
 *
 * This exists for the reason one-step.ts reports "stopped after 3 providers":
 * a cap, a failure, and a genuinely empty web must not produce identical
 * output. A silent gap reads as full coverage.
 */
export function computeCoverage(input: CoverageInput): Coverage {
  const queries: QueryCoverage[] = input.queries.map(({ query, items }) => ({
    query,
    uniqueUrls: items.length,
    agreementMedian: median(items.map((i) => i.providers.length)),
  }));

  const hosts = new Map<string, number>();
  let total = 0;
  for (const { items } of input.queries) {
    for (const item of items) {
      // `hostOf` returns `undefined` for a URL that carries no host evidence at
      // all (see its docstring). That is not a distinct host to concentrate on,
      // so it is left out of both the tally and the denominator -- counting it
      // in the denominator while it can never win the numerator would only
      // dilute a real concentration signal with results this metric cannot see.
      const host = hostOf(item.url);
      if (host === undefined) continue;
      hosts.set(host, (hosts.get(host) ?? 0) + 1);
      total += 1;
    }
  }
  let domainConcentration: Coverage['domainConcentration'];
  if (total > 0) {
    const [host, count] = [...hosts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    if (host !== '') domainConcentration = { host, share: count / total };
  }

  const gaps: string[] = [];
  for (const q of queries) {
    if (q.uniqueUrls === 0) gaps.push(`"${q.query}" returned no results`);
    else if (q.uniqueUrls < THIN_QUERY_THRESHOLD) gaps.push(`"${q.query}" is thin (${String(q.uniqueUrls)} unique URLs)`);
    else if (q.agreementMedian <= 1) gaps.push(`"${q.query}" has no cross-provider agreement`);
  }
  for (const failure of input.failed) gaps.push(`${failure.backendId} failed (${failure.reason})`);
  // Split by cause, not joined into one line: a budget drop tells the caller
  // to run the query again, an abort tells them not to. See `DroppedQuery`.
  const budgetDropped = input.droppedQueries.filter((d) => d.reason === undefined).map((d) => d.query);
  if (budgetDropped.length > 0) gaps.push(`not run (call budget): ${budgetDropped.join(', ')}`);
  for (const [reason, queries_] of groupByReason(input.droppedQueries)) {
    gaps.push(`not run (${reason}): ${queries_.join(', ')}`);
  }
  for (const narrowed of input.narrowedQueries) {
    gaps.push(
      `"${narrowed.query}" narrowed to ${String(narrowed.actual)} of ${String(narrowed.requested)} providers (call budget)`,
    );
  }
  // Deliberately not "call budget": this list carries both targets dropped on
  // the budget AND targets whose fetch failed, and a label naming only one
  // cause would misreport the other. The per-target `reason` is rendered HERE,
  // from the structured value -- this line is the one place a human reads it,
  // and the field `nextActions` quotes has to stay a bare URL.
  if (input.unfetchedTargets.length > 0) {
    const rendered = input.unfetchedTargets.map((t) => (t.reason !== undefined ? `${t.url} (${t.reason})` : t.url));
    gaps.push(`not fetched: ${rendered.join(', ')}`);
  }
  if (domainConcentration !== undefined && domainConcentration.share > 0.6 && total >= 5) {
    gaps.push(`${String(Math.round(domainConcentration.share * 100))}% of results are from ${domainConcentration.host}`);
  }

  // Copied, not aliased. A `Coverage` reads as a finished report of a round and
  // is handed to a renderer and to `nextActions`; returning the caller's own
  // arrays would make a later `push` on either side silently rewrite the other's
  // history of what was served. Cheap here (these are round-sized lists) and it
  // keeps the function as pure as its signature claims.
  return {
    queries,
    served: [...input.served],
    failed: input.failed.map((f) => ({ ...f })),
    skipped: [...input.skipped],
    ...(domainConcentration !== undefined ? { domainConcentration } : {}),
    // Element-wise, like `failed` above and for the same reason: a spread alone
    // would hand the caller's own objects back inside a finished report.
    droppedQueries: input.droppedQueries.map((d) => ({ ...d })),
    unfetchedTargets: input.unfetchedTargets.map((t) => ({ ...t })),
    narrowedQueries: input.narrowedQueries.map((n) => ({ ...n })),
    suppressed: input.suppressed,
    gaps,
  };
}

/**
 * A string wrapped so a POSIX shell passes it through as one literal argument.
 *
 * `cmd` is promised to be ready to run, and its ingredients are untrusted: a
 * query is the user's prompt minus its URLs, and a target is whatever matched
 * the URL pattern in that prompt. Interpolated raw into double quotes, `$100`
 * expands to nothing (the follow-up round then searches for, and bills for, the
 * wrong thing), a `"` in `27" monitor` closes the quote and leaves the shell on
 * a continuation prompt, and a backtick or `$(...)` reaches command
 * substitution. Bare, a `?` or `&` in a query string truncates the URL and
 * backgrounds the job under bash, and fails outright under zsh's globbing.
 * Single quotes suppress every one of those; the only character they cannot
 * carry is `'` itself, hence the close-escape-reopen dance.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Ready-to-run follow-up commands, one per actionable gap.
 *
 * Handing over the literal command is the point: an agent that has to compose
 * the follow-up itself will sometimes get the session flag wrong and re-pay for
 * links it already has.
 */
export function nextActions(coverage: Coverage, sessionId: string | undefined, aborted?: string): NextAction[] {
  // An account-scoped abort (`retry.ts`'s ABORT_CODES: unauthorized,
  // limit_exceeded, insufficient_balance) is the one state in which every
  // action below is not merely useless but actively harmful. Those codes
  // describe the ACCOUNT, not one provider, so re-running any query spends into
  // whatever just tripped -- and a `--depth research` follow-up, which is what
  // the thin-query branch emits, is eight lanes of it. SKILL.md instructs the
  // agent to run what this function returns, so returning them at all is
  // instructing it to do exactly that.
  //
  // One action, naming the real blocker. It carries no `fezoctl` command
  // because there is no command in this CLI that fixes a spend limit or a bad
  // key; pointing at a command that cannot help is how the caller ends up
  // running it anyway.
  if (aborted !== undefined) {
    return [{
      why: `the round stopped on an account-scoped failure (${aborted}) — every provider presents the same account, so a follow-up round would spend into it. Check the account balance or spend limits before re-running.`,
    }];
  }
  // The id alone needs no quoting: it is validated against
  // /^[A-Za-z0-9._-]{1,64}$/ at parse time because it becomes a filename, so it
  // holds nothing a shell reacts to. Everything else here goes through
  // `shellQuote`.
  const session = sessionId !== undefined ? ` --session ${sessionId}` : '';
  const actions: NextAction[] = [];
  for (const q of coverage.queries) {
    if (q.uniqueUrls >= THIN_QUERY_THRESHOLD && q.agreementMedian > 1) continue;
    actions.push({
      // Mirrors the three-way branch the gap text uses, because `why` and the
      // gap describe the same query to the same reader: calling a query with
      // plenty of unique URLs "thin" contradicts the gap line sitting next to it
      // and sends the agent after the wrong remedy.
      why:
        q.uniqueUrls === 0
          ? `"${q.query}" returned nothing`
          : q.uniqueUrls < THIN_QUERY_THRESHOLD
            ? `"${q.query}" is thin`
            : `"${q.query}" has no cross-provider agreement`,
      cmd: `fezoctl research ${shellQuote(q.query)} --depth research${session}`,
    });
  }
  for (const failure of coverage.failed) {
    actions.push({
      why: `${failure.backendId} failed (${failure.reason})`,
      cmd: `fezoctl providers --intent search`,
    });
  }
  for (const dropped of coverage.droppedQueries) {
    actions.push({
      why: dropped.reason !== undefined ? `not run (${dropped.reason})` : 'not run: call budget',
      cmd: `fezoctl research ${shellQuote(dropped.query)}${session}`,
    });
  }
  for (const target of coverage.unfetchedTargets) {
    // `--session` is deliberately absent: `scrape` is a one-step command and
    // takes no session flag. The URL is quoted ALONE -- the cause rides in
    // `why`, which is the field free to explain, while `cmd` is the field that
    // has to survive being pasted into a shell. Appending "(rate_limited)" to
    // the argument instead hands the agent
    // `fezoctl scrape 'https://t.example (rate_limited)'`: a billed fetch of an
    // address nobody wrote, or a hard failure, in place of the one retry this
    // action exists to offer.
    actions.push({
      why: target.reason !== undefined ? `not fetched (${target.reason})` : 'not fetched',
      cmd: `fezoctl scrape ${shellQuote(target.url)}`,
    });
  }
  // Deduped by `cmd`: every failed backend produces the identical
  // `fezoctl providers --intent search`, so an all-lanes-failed round emitted
  // it once per provider. A list of next actions with the same line three times
  // reads as three things to do.  The FIRST occurrence is kept, so the `why`
  // the caller sees is the first cause that produced it.
  const seenCmd = new Set<string>();
  return actions.filter((action) => {
    if (action.cmd === undefined) return true;
    if (seenCmd.has(action.cmd)) return false;
    seenCmd.add(action.cmd);
    return true;
  });
}
