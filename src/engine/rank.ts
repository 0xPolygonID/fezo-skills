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
// is a CLI concern. Instead it always returns the full ranked candidate
// list alongside its decision, so a caller that wants to override an
// "unhinted-multi-backend" refusal can do so itself by taking `ranked[0]`.

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
 * Lower-cases and splits a query on whitespace and punctuation. ASCII
 * lower-casing only (no Unicode normalization) — matches the existing MCP
 * server's substring-matching behavior, which this module mirrors.
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
 * Best (lowest-numbered-tier) field a term was found in, as a weight for
 * term-score ranking: a hit in the tool/backend/method identifiers is a
 * stronger relevance signal than a hit only in free-text description or
 * backend info, even though both count equally for AND-matching inclusion.
 */
function fieldWeight(term: string, blob: SearchableBlob): number {
  if (blob.identifiers.includes(term)) return 3;
  if (blob.title.includes(term)) return 2;
  if (blob.rest.includes(term)) return 1;
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

// Suffix-anchored on `method` (not the full `${backendId}_${method}` tool
// name): checking the method name alone means a backend id that happens to
// contain one of these words (e.g. "firecrawl") can never cause a false
// exclusion of an unrelated sync method.
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

function hasAsyncNamePattern(method: string): boolean {
  const lower = method.toLowerCase();
  // Exact method-name equality ONLY — never a substring check against the
  // full tool name. `firecrawl` contains the substring "crawl", so a
  // substring test here would incorrectly exclude firecrawl_scrape,
  // firecrawl_search, and firecrawl_map, silently destroying both the scrape
  // and web-search preference tiers while looking like it works.
  if (lower === 'crawl') return true;
  return ASYNC_NAME_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function hasAsyncTextPhrase(candidate: ToolCandidate): boolean {
  const text = `${candidate.title ?? ''} ${candidate.description} ${candidate.backendInfoText}`.toLowerCase();
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
  return hasAsyncNamePattern(candidate.method) || hasAsyncTextPhrase(candidate) || hasAsyncOutputShape(candidate);
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
 * Classifies a search match into a rank tier. `exact-backend-method` and
 * `exact-method` are judged on whole-token equality against the *raw*
 * (un-stop-word-filtered) query tokens — a user typing "firecrawl scrape"
 * gets both identifiers as separate exact tokens even though neither word is
 * a stop word to begin with. A query that exactly equals a bare backend id
 * (e.g. "firecrawl") falls through to `term-score`: the spec defines no
 * dedicated "exact backend alone" tier, and a bare backend name is weak
 * signal about *which* of its methods to prefer.
 */
function classifyTier(match: SearchMatch, rawTokens: ReadonlySet<string>): RankTier {
  if (match.exactMatch === 'tool') return 'exact-tool';
  const hasBackendToken = rawTokens.has(match.candidate.backendId.toLowerCase());
  const hasMethodToken = rawTokens.has(match.candidate.method.toLowerCase());
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

/**
 * Why `run` refused to auto-pick a candidate. Both variants carry enough for
 * a caller to render a useful message and (for `unhinted-multi-backend`) to
 * decide whether to override via `--allow-unhinted-auto-pick` — that flag
 * check belongs to the CLI, not here; see the module doc comment.
 */
export type RunRefusalReason =
  | { kind: 'ambiguous-capability'; capabilities: Capability[] }
  | { kind: 'unhinted-multi-backend'; backends: string[] };

export type RunSelection =
  /** No candidate matched the query (after async exclusion). */
  | { outcome: 'no-match' }
  | { outcome: 'selected'; chosen: RankedCandidate; ranked: RankedCandidate[] }
  | { outcome: 'refused'; reason: RunRefusalReason; ranked: RankedCandidate[] };

/**
 * Decides what (if anything) `run` should auto-select for a free-text
 * intent: search, apply async-lifecycle exclusion, infer a capability from
 * the intent, and rank. Never throws and never consults
 * `--allow-unhinted-auto-pick` — a refusal is a returned decision, always
 * accompanied by the full ranked list, so the CLI can render it and, for the
 * unhinted-multi-backend case, override it itself by taking `ranked[0]`.
 */
export function selectForRun(candidates: readonly ToolCandidate[], intent: string): RunSelection {
  const matches = searchCandidates(candidates, intent);

  const asyncOverride = queryRequestsAsyncBehavior(intent);
  const eligible = matches.filter(
    (match) => asyncOverride || match.exactMatch === 'tool' || !isAsyncLifecycleMethod(match.candidate),
  );

  if (eligible.length === 0) return { outcome: 'no-match' };

  const inference = inferCapability(intent);

  if (inference.kind === 'ambiguous') {
    return {
      outcome: 'refused',
      reason: {
        kind: 'ambiguous-capability',
        capabilities: inference.candidates.map((match) => match.capability),
      },
      ranked: rankCandidates(eligible, intent),
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
