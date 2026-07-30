// Search, async exclusion, and ranking over normalized catalog candidates.
//
// This module owns everything the governing spec calls "search semantics"
// (tokenization, stop-word removal, AND-matching, async-lifecycle exclusion)
// plus the ranking order that decides what `run` calls when several
// candidates match. It combines its own semantic match score with the
// provider-preference hint layer from preference.ts (capability inference
// and CAPABILITY_PREFERENCES); this module does not own either of those
// tables itself.
//
// `selectForRun` is the entry point later tasks (the `run` CLI command,
// Task 8) build on. It never reads `--allow-unhinted-auto-pick` — that flag
// is a CLI concern. Instead, the one refusal that flag can override
// ("unhinted-multi-backend") returns the full ranked candidate list, so the
// caller can override it itself by taking `ranked[0]`. The refusals that flag
// cannot override carry no `ranked` field at all, so the type never offers a
// caller a candidate it is not allowed to promote.

import type { ToolCandidate } from './catalog.js';
import type { Capability } from './preference.js';
import { CAPABILITY_PREFERENCES, inferCapability } from './preference.js';

// ---------------------------------------------------------------------------
// Tokenization and stop words.
// ---------------------------------------------------------------------------

/**
 * Common stop words dropped from a search query before matching, verbatim
 * from the governing specification's list. Not a general-purpose English
 * stop-word list — just the specified set.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'to',
  'for',
  'of',
  'and',
  'or',
  'please',
  'page',
  'site',
]);

/**
 * Lower-cases a query and splits it into `[a-z0-9]+` runs.
 *
 * Everything outside `[a-z0-9]` after lower-casing is a separator, so it is
 * not only whitespace and punctuation that splits: any non-ASCII character is
 * treated as a separator too. `café` tokenizes to `['caf']` and `naïve` to
 * `['na', 've']`. There is no Unicode normalization, case folding beyond
 * `String.prototype.toLowerCase`, or accent stripping. That is a deliberate
 * match for the existing MCP server's substring matching, which this module
 * mirrors, and it is acceptable because every catalog identifier is
 * `[a-zA-Z0-9_-]` by construction (see tool-name.ts) and the gateway
 * manifests are English-only. If either stops being true, this function is
 * where the fix belongs.
 */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Drops stop words from an already-tokenized query, *unless* doing so would
 * leave nothing: a query made entirely of stop words (e.g. "the" alone) must
 * still be able to match something on its own terms, rather than degrading
 * to an empty term list that a naive AND-across-terms check would treat as
 * "matches everything" or "matches nothing" depending on how it's written.
 */
export function removeStopWords(tokens: readonly string[]): string[] {
  const filtered = tokens.filter((token) => !STOP_WORDS.has(token));
  return filtered.length > 0 ? filtered : [...tokens];
}

// ---------------------------------------------------------------------------
// Searchable text and term scoring.
// ---------------------------------------------------------------------------

/**
 * A candidate's searchable text, split into three weighted groups for term
 * scoring (see `fieldWeight`): identifiers (tool/backend/method — the
 * strongest signal), title, and everything else (description and backend
 * info text).
 *
 * Fields per the governing spec: "tool name, backend id, method name,
 * title, description, and backend info title/summary/description."
 */
interface SearchableBlob {
  identifiers: string;
  title: string;
  rest: string;
  full: string;
}

function searchableBlob(candidate: ToolCandidate): SearchableBlob {
  const identifiers = `${candidate.tool} ${candidate.backendId} ${candidate.method}`.toLowerCase();
  const title = (candidate.title ?? '').toLowerCase();
  const rest = `${candidate.description} ${candidate.backendInfoText}`.toLowerCase();
  return { identifiers, title, rest, full: `${identifiers} ${title} ${rest}` };
}

/**
 * Per-field weights for the tier-4 term score. The governing spec names tier
 * 4's inputs ("query term score in title/description/tool/backend info") but
 * not their relative weights, so these three numbers are a local design
 * choice, stated here explicitly rather than left implicit in the code:
 *
 *   identifiers (tool/backend/method) = 3
 *   title                             = 2
 *   description + backend info        = 1
 *
 * A term is scored once, at the weight of the strongest field it appears in.
 * Rationale: a hit in an identifier is a much stronger relevance signal than
 * a hit in free-text prose, even though both count equally for AND-matching
 * inclusion.
 *
 * CONSEQUENCE, and the reason these weights are load-bearing policy rather
 * than a detail: tier 4 is compared BEFORE tier 5, so any term-score
 * difference beats capability preference outright. Two candidates that tie on
 * term score are ordered by CAPABILITY_PREFERENCES; a candidate that scores
 * even one point higher wins regardless of preference order. Changing these
 * numbers therefore changes which provider `run` picks. `tests/preference.test.ts`
 * pins both halves of that behavior ("term score outranks capability
 * preference" and the per-field weights) so it cannot drift silently.
 */
const IDENTIFIER_TERM_WEIGHT = 3;
const TITLE_TERM_WEIGHT = 2;
const REST_TERM_WEIGHT = 1;

/**
 * Weight of the strongest field `term` was found in, or 0 if absent. See the
 * comment on the weight constants above for why the ordering matters.
 */
function fieldWeight(term: string, blob: SearchableBlob): number {
  if (blob.identifiers.includes(term)) return IDENTIFIER_TERM_WEIGHT;
  if (blob.title.includes(term)) return TITLE_TERM_WEIGHT;
  if (blob.rest.includes(term)) return REST_TERM_WEIGHT;
  return 0;
}

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

/** One candidate that matched a search query, and why. */
export interface SearchMatch {
  candidate: ToolCandidate;
  /** Query terms (after stop-word removal) found as substrings of this candidate's searchable text. */
  matchedTerms: string[];
  /** Which identifier the raw (untokenized) query equals exactly, if any. */
  exactMatch?: 'tool' | 'backend' | 'method';
}

/**
 * Searches candidates for a free-text query. A candidate matches when either:
 *   - the raw query equals its tool name, backend id, or method name exactly
 *     (case-insensitive), regardless of stop words or AND-matching; or
 *   - every remaining query term (after stop-word removal) is present as a
 *     case-insensitive substring somewhere in its searchable text.
 *
 * This mirrors the existing MCP server's substring matching (`scrape` must
 * match text containing `scraper` or `Web Scraper`) and intentionally makes
 * phrasing matter: AND-across-all-terms means "scrape url" and
 * "scrape webpage" can select different candidate sets.
 */
export function searchCandidates(candidates: readonly ToolCandidate[], query: string): SearchMatch[] {
  const trimmedQuery = query.trim().toLowerCase();
  const terms = removeStopWords(tokenize(query));

  const matches: SearchMatch[] = [];
  for (const candidate of candidates) {
    const blob = searchableBlob(candidate);

    let exactMatch: 'tool' | 'backend' | 'method' | undefined;
    if (trimmedQuery.length > 0) {
      if (trimmedQuery === candidate.tool.toLowerCase()) exactMatch = 'tool';
      else if (trimmedQuery === candidate.backendId.toLowerCase()) exactMatch = 'backend';
      else if (trimmedQuery === candidate.method.toLowerCase()) exactMatch = 'method';
    }

    const matchedTerms = terms.filter((term) => blob.full.includes(term));
    const allTermsMatch = terms.length > 0 && matchedTerms.length === terms.length;

    if (allTermsMatch || exactMatch !== undefined) {
      matches.push({
        candidate,
        matchedTerms,
        ...(exactMatch !== undefined ? { exactMatch } : {}),
      });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Async-lifecycle exclusion.
// ---------------------------------------------------------------------------

// Suffix-anchored on the *tool* name (`${backendId}_${method}`), not on the
// bare method, because the spec's patterns are written as globs over the tool
// name (`*_status`) and a bare method name defeats a method-anchored test:
// `'status'.endsWith('_status')` is false, so a method named exactly `status`,
// `get`, `progress`, `snapshot`, `dataset`, or `async` would escape the rule
// entirely. Anchoring on the tool name is equally safe against the firecrawl
// hazard that motivates the method-name-only `crawl` rule below: a backend id
// is always followed by `_` in the tool name, so these suffixes can only ever
// match at a backend/method or method-internal word boundary, never inside a
// backend id like "firecrawl".
const ASYNC_NAME_SUFFIXES = ['_async', '_status', '_progress', '_snapshot', '_get', '_dataset'] as const;

const ASYNC_TEXT_PHRASES = [
  'asynchronous',
  'async',
  'job id',
  'snapshot_id',
  'snapshot id',
  'request_id',
  'poll',
  'status endpoint',
  'progress endpoint',
] as const;

// Output-schema property names that suggest the response is primarily "here
// is an id, poll for the real result later" rather than a real payload.
const ASYNC_ID_PROPERTY_NAMES = new Set(['id', 'job_id', 'snapshot_id', 'request_id', 'task_id']);

function hasAsyncNamePattern(candidate: ToolCandidate): boolean {
  // Exact METHOD-name equality ONLY — never a substring check against the
  // full tool name. `firecrawl` contains the substring "crawl", so a
  // substring test here would incorrectly exclude firecrawl_scrape,
  // firecrawl_search, and firecrawl_map, silently destroying both the scrape
  // and web-search preference tiers while looking like it works. This one
  // rule stays method-scoped for that reason; the suffixes below are
  // tool-name-scoped (see ASYNC_NAME_SUFFIXES).
  if (candidate.method.toLowerCase() === 'crawl') return true;

  // Two spellings of the tool name are checked: `candidate.tool`, which is
  // what a user actually types and which has had illegal characters
  // sanitized to `_` (so a method literally named `job.status` is caught),
  // and the raw `${backendId}_${method}` join, which `candidate.tool` may
  // have truncated behind a hash suffix for long names (see
  // methodToToolName). Either spelling matching is enough.
  const names = [candidate.tool.toLowerCase(), `${candidate.backendId}_${candidate.method}`.toLowerCase()];
  return ASYNC_NAME_SUFFIXES.some((suffix) => names.some((name) => name.endsWith(suffix)));
}

/**
 * Async text-phrase detection over the method's **own** title and
 * description, and deliberately NOT over `candidate.backendInfoText`.
 *
 * `backendInfoText` is backend-wide: it is the same title/summary/description
 * string on every method a backend exposes. One async word anywhere in a
 * backend's prose would therefore disqualify all of its methods, and the live
 * gateway manifests contain exactly such words — firecrawl ("Crawl starts
 * asynchronously and is polled by job id"), scraperapi ("run large/hard
 * scrapes via the async jobs API"), brightdata ("the async Web Scraper API",
 * "async trigger/poll/download flow"), apify, falai. Including it would leave
 * `run` with no candidate at all for the `scrape` and `serp` capabilities:
 * every deployed rung of both preference lists would be excluded, and
 * `selectForRun` would answer `no-match` for `scrape url`.
 *
 * `backendInfoText` remains a **search** field (search rule 5); it is
 * excluded from async detection only. This scoping is the governing spec's
 * amended async rule, not a local judgement call.
 */
function hasAsyncTextPhrase(candidate: ToolCandidate): boolean {
  const text = `${candidate.title ?? ''} ${candidate.description}`.toLowerCase();
  return ASYNC_TEXT_PHRASES.some((phrase) => text.includes(phrase));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True when the output schema's declared properties are entirely drawn from
 * `ASYNC_ID_PROPERTY_NAMES` — i.e. the response shape is "an id to poll
 * later" and nothing else. A schema with no `properties`, or with any
 * property outside that set, is not flagged: this heuristic only catches the
 * narrow, unambiguous case.
 */
function hasAsyncOutputShape(candidate: ToolCandidate): boolean {
  const schema = candidate.outputSchema;
  if (!isRecord(schema)) return false;
  const properties = schema.properties;
  if (!isRecord(properties)) return false;
  const keys = Object.keys(properties);
  if (keys.length === 0) return false;
  return keys.every((key) => ASYNC_ID_PROPERTY_NAMES.has(key.toLowerCase()));
}

/**
 * True when a candidate is an async lifecycle method (start/poll/status/
 * fetch-result-by-id) rather than a synchronous one, per the governing
 * spec's name-pattern, text-phrase, and output-shape detection rules.
 *
 * Async candidates remain visible in `search` and callable through `call`;
 * this only marks them for exclusion from `run`'s auto-selection (see
 * `selectForRun`).
 */
export function isAsyncLifecycleMethod(candidate: ToolCandidate): boolean {
  return hasAsyncNamePattern(candidate) || hasAsyncTextPhrase(candidate) || hasAsyncOutputShape(candidate);
}

const ASYNC_OVERRIDE_TERMS = new Set(['async', 'job', 'snapshot', 'status', 'crawl']);

/**
 * True when the user's intent explicitly asks for async/job/snapshot/status/
 * crawl behavior (a whole query token equals one of those words), in which
 * case `run` must not exclude async-lifecycle candidates at all.
 */
export function queryRequestsAsyncBehavior(intent: string): boolean {
  return tokenize(intent).some((token) => ASYNC_OVERRIDE_TERMS.has(token));
}

// ---------------------------------------------------------------------------
// Ranking.
// ---------------------------------------------------------------------------

/** Which ranking rule decided a candidate's position, from strongest to weakest. */
export type RankTier = 'exact-tool' | 'exact-backend-method' | 'exact-method' | 'term-score';

function tierWeight(tier: RankTier): number {
  switch (tier) {
    case 'exact-tool':
      return 0;
    case 'exact-backend-method':
      return 1;
    case 'exact-method':
      return 2;
    case 'term-score':
      return 3;
  }
}

/**
 * Classifies a search match into a rank tier.
 *
 * Two independent signals count as "the query named this identifier":
 *
 *   1. `match.exactMatch`, computed by `searchCandidates` from the whole raw
 *      query string. This must be honored, not re-derived: `tokenize` splits
 *      on `_`, so an intent exactly equal to a method named `scrape_url`
 *      yields the tokens {scrape, url} and never the token `scrape_url`. A
 *      token-membership test alone would drop that candidate to `term-score`
 *      while promoting a competing backend whose method happens to be a bare
 *      `scrape` to `exact-method` — letting a method-name shape coincidence
 *      outrank capability preference across providers.
 *   2. Whole-token equality against the *raw* (un-stop-word-filtered) query
 *      tokens, so a user typing "firecrawl scrape" gets both identifiers as
 *      separate exact tokens.
 *
 * A query that exactly equals a bare backend id (e.g. "firecrawl") still
 * falls through to `term-score` unless a method token is also present: the
 * spec defines no dedicated "exact backend alone" tier, and a bare backend
 * name is weak signal about *which* of its methods to prefer.
 */
function classifyTier(match: SearchMatch, rawTokens: ReadonlySet<string>): RankTier {
  if (match.exactMatch === 'tool') return 'exact-tool';
  const hasBackendToken =
    match.exactMatch === 'backend' || rawTokens.has(match.candidate.backendId.toLowerCase());
  const hasMethodToken = match.exactMatch === 'method' || rawTokens.has(match.candidate.method.toLowerCase());
  if (hasBackendToken && hasMethodToken) return 'exact-backend-method';
  if (hasMethodToken) return 'exact-method';
  return 'term-score';
}

function billingWeight(model: ToolCandidate['billingModel']): number {
  // Lower-risk billing first: package (pre-paid, bounded) before per_call
  // (bounded, known) before dynamic (unbounded/unknown cost) — a weak
  // tie-breaker only, per the governing spec.
  if (model === 'package') return 0;
  if (model === 'per_call') return 1;
  return 2;
}

/** Machine-readable explanation of why a candidate ranked where it did. */
export interface RankExplanation {
  tier: RankTier;
  matchedTerms: string[];
  termScore: number;
  /** Present only when a capability was inferred AND this candidate's backend appears in that capability's preference list. */
  preference?: { capability: Capability; position: number };
  billingModel: ToolCandidate['billingModel'];
}

export interface RankedCandidate {
  candidate: ToolCandidate;
  explanation: RankExplanation;
}

/**
 * Ranks already-matched (and, for `run`, already async-filtered) candidates.
 *
 * `capability`, when given, applies CAPABILITY_PREFERENCES[capability] as
 * tie-break tier 5 — sparse, capability-scoped policy, never method
 * ownership: a backend absent from the list simply gets no boost. Sort order
 * (strongest to weakest), per the governing spec:
 *   1. Exact tool match
 *   2. Exact backend + method match
 *   3. Exact method match
 *   4. Query term score (identifiers > title > description/backend info)
 *   5. Capability preference position, if a capability applies
 *   6. Billing model (package < per_call < dynamic)
 *   7. Original relative order in `matches` (stable tie-break of last resort)
 */
export function rankCandidates(
  matches: readonly SearchMatch[],
  intent: string,
  capability?: Capability,
): RankedCandidate[] {
  const rawTokens = new Set(tokenize(intent));
  const preferenceList: readonly string[] | undefined =
    capability !== undefined ? CAPABILITY_PREFERENCES[capability] : undefined;

  const withRank = matches.map((match, originalIndex) => {
    const tier = classifyTier(match, rawTokens);
    const blob = searchableBlob(match.candidate);
    const termScore = match.matchedTerms.reduce((sum, term) => sum + fieldWeight(term, blob), 0);
    const preferencePosition = preferenceList?.indexOf(match.candidate.backendId) ?? -1;

    const explanation: RankExplanation = {
      tier,
      matchedTerms: match.matchedTerms,
      termScore,
      billingModel: match.candidate.billingModel,
      ...(capability !== undefined && preferencePosition >= 0
        ? { preference: { capability, position: preferencePosition } }
        : {}),
    };
    return { candidate: match.candidate, explanation, originalIndex };
  });

  withRank.sort((a, b) => {
    const tierDiff = tierWeight(a.explanation.tier) - tierWeight(b.explanation.tier);
    if (tierDiff !== 0) return tierDiff;

    const scoreDiff = b.explanation.termScore - a.explanation.termScore;
    if (scoreDiff !== 0) return scoreDiff;

    const aPosition = a.explanation.preference?.position ?? Number.POSITIVE_INFINITY;
    const bPosition = b.explanation.preference?.position ?? Number.POSITIVE_INFINITY;
    if (aPosition !== bPosition) return aPosition - bPosition;

    const billingDiff = billingWeight(a.explanation.billingModel) - billingWeight(b.explanation.billingModel);
    if (billingDiff !== 0) return billingDiff;

    return a.originalIndex - b.originalIndex;
  });

  return withRank.map(({ candidate, explanation }) => ({ candidate, explanation }));
}

// ---------------------------------------------------------------------------
// `run` auto-pick entry point.
// ---------------------------------------------------------------------------

/** Two or more capabilities matched the intent; not overridable. */
export interface AmbiguousCapabilityRefusal {
  kind: 'ambiguous-capability';
  capabilities: Capability[];
}

/**
 * The matched set spans multiple backends with no capability hint to pick
 * between them; overridable with `--allow-unhinted-auto-pick`.
 */
export interface UnhintedMultiBackendRefusal {
  kind: 'unhinted-multi-backend';
  backends: string[];
}

/**
 * Why `run` refused to auto-pick a candidate. Both variants carry enough for
 * a caller to render a useful message and (for `unhinted-multi-backend`) to
 * decide whether to override via `--allow-unhinted-auto-pick` — that flag
 * check belongs to the CLI, not here; see the module doc comment.
 */
export type RunRefusalReason = AmbiguousCapabilityRefusal | UnhintedMultiBackendRefusal;

export type RunSelection =
  /** Nothing matched the query at all. */
  | { outcome: 'no-match' }
  /**
   * Candidates matched, but every one of them was removed by async-lifecycle
   * exclusion. Distinct from `no-match` because the remedy is different and
   * worth telling the user: name the tool exactly, or ask for async behavior
   * explicitly ("async"/"job"/"snapshot"/"status"/"crawl"). `asyncExcluded`
   * holds the matched-but-excluded candidates in catalog order so the caller
   * can name them; they are deliberately NOT ranked and NOT promotable —
   * `run` must not auto-call an async lifecycle method.
   */
  | { outcome: 'async-excluded'; asyncExcluded: ToolCandidate[] }
  | { outcome: 'selected'; chosen: RankedCandidate; ranked: RankedCandidate[] }
  /**
   * Refused because two or more capabilities matched the intent. There is no
   * `--allow-unhinted-auto-pick` override for this case, so this variant
   * deliberately carries no `ranked` field: the type must not hand a caller a
   * candidate it is not allowed to promote. `alternatives` is for display
   * only.
   */
  | { outcome: 'refused'; reason: AmbiguousCapabilityRefusal; alternatives: RankedCandidate[] }
  /**
   * Refused because the matched set spans multiple backends and no capability
   * hint applies. This is the ONE overridable refusal: a CLI that sees
   * `--allow-unhinted-auto-pick` may promote `ranked[0]`.
   *
   * Narrow with `'ranked' in result`. Testing `result.reason.kind` narrows
   * `result.reason` but NOT `result` itself (TypeScript does not narrow an
   * outer union on a nested discriminant), so it does not make `ranked`
   * reachable — which is the intended shape: the only way to a promotable
   * candidate is through the variant that has one.
   */
  | { outcome: 'refused'; reason: UnhintedMultiBackendRefusal; ranked: RankedCandidate[] };

/**
 * Decides what (if anything) `run` should auto-select for a free-text
 * intent: search, apply async-lifecycle exclusion, infer a capability from
 * the intent, and rank. Never throws and never consults
 * `--allow-unhinted-auto-pick` — a refusal is a returned decision. The one
 * overridable refusal (`unhinted-multi-backend`) carries the full ranked list
 * so the CLI can promote `ranked[0]` itself; the non-overridable ones do not.
 */
export function selectForRun(candidates: readonly ToolCandidate[], intent: string): RunSelection {
  const matches = searchCandidates(candidates, intent);

  const asyncOverride = queryRequestsAsyncBehavior(intent);
  const eligible = matches.filter(
    (match) => asyncOverride || match.exactMatch === 'tool' || !isAsyncLifecycleMethod(match.candidate),
  );

  if (eligible.length === 0) {
    // Separate the two ways of having nothing to run: nothing matched, versus
    // everything that matched was an async lifecycle method. The second is
    // recoverable by the user (name the tool exactly, or say "async"/"job"/
    // "snapshot"/"status"/"crawl"), so it must not be reported as a bare
    // no-match.
    if (matches.length === 0) return { outcome: 'no-match' };
    return { outcome: 'async-excluded', asyncExcluded: matches.map((match) => match.candidate) };
  }

  const inference = inferCapability(intent);

  if (inference.kind === 'ambiguous') {
    return {
      outcome: 'refused',
      reason: {
        kind: 'ambiguous-capability',
        capabilities: inference.candidates.map((match) => match.capability),
      },
      alternatives: rankCandidates(eligible, intent),
    };
  }

  if (inference.kind === 'matched') {
    const ranked = rankCandidates(eligible, intent, inference.capability);
    const chosen = ranked[0];
    if (chosen === undefined) return { outcome: 'no-match' };
    return { outcome: 'selected', chosen, ranked };
  }

  // No capability hint. Auto-pick is safe only when every matched candidate
  // is from the same backend — there is no cross-provider policy to get
  // wrong in that case. Once two or more backends are in play, picking one
  // without a hint would silently make alphabetical/catalog order into the
  // provider policy, which the governing spec forbids.
  const ranked = rankCandidates(eligible, intent);
  const backends = new Set(eligible.map((match) => match.candidate.backendId));
  if (backends.size > 1) {
    return {
      outcome: 'refused',
      reason: { kind: 'unhinted-multi-backend', backends: [...backends] },
      ranked,
    };
  }

  const chosen = ranked[0];
  if (chosen === undefined) return { outcome: 'no-match' };
  return { outcome: 'selected', chosen, ranked };
}
