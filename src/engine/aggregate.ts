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
  publishedAt: ['published_at', 'publishedAt', 'published_date', 'publishedDate', 'datePublished', 'date', 'pubDate'],
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
  const full = firstString(entry, FIELD_CANDIDATES.snippet);
  // The ellipsis is the whole point of not slicing silently: a truncated
  // preview that ends mid-sentence with no marker reads as a provider that
  // returned a broken snippet, and someone then goes looking for a bug in the
  // provider rather than finding this cap. It costs one character of text
  // rather than being added on top, so the emitted string honours the cap the
  // constant declares instead of overrunning it by one.
  const snippet =
    full !== undefined && full.length > SNIPPET_MAX_CHARS
      ? `${full.slice(0, SNIPPET_MAX_CHARS - 1)}…`
      : full;
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
 */
function recordHit(providers: ProviderHit[], hit: ProviderHit): void {
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
    ...(typeof snippet === 'string' ? { snippet } : {}),
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
): { items: ResearchItem[]; suppressed: number } {
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
          duplicates: raw.url === canonical ? [] : [raw.url],
        });
        return;
      }
      // Via `recordHit`, not `push`: this same lane may have listed the same
      // document twice (pagination, a decorated duplicate), and a backend
      // counted twice reads downstream as two providers agreeing.
      recordHit(existing.providers, hit);
      if (raw.url !== canonical && !existing.duplicates.includes(raw.url)) existing.duplicates.push(raw.url);
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
  return { items: merged, suppressed: suppressedUrls.size };
}
