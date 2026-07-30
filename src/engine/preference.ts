// Capability inference and provider-preference policy.
//
// This module owns two small data tables and the pure function that reads
// one of them:
//   - CAPABILITY_KEYWORDS  — how a free-text `run` intent maps to a coarse
//     "capability" (scrape / serp / web-search), used only to decide which
//     preference hint (if any) applies.
//   - CAPABILITY_PREFERENCES — sparse, capability-scoped backend orderings
//     used by rank.ts as a tie-breaker among candidates that already matched
//     the query on their own merits.
//
// Neither table is method ownership and neither is measured fact: they are
// recorded policy (human preference / cost / capability assumptions) that a
// human should be able to find, read, and revise without touching search or
// ranking logic. See the comment above CAPABILITY_PREFERENCES for the
// explicit "this is policy, not telemetry" note the governing spec requires.

/**
 * Keyword phrases that identify a capability in a free-text `run` intent.
 * Checked as case-insensitive substrings of the *original* intent string —
 * see `inferCapability` for why this deliberately does not reuse rank.ts's
 * tokenized/stop-word-filtered query terms.
 *
 * Initial map, values verbatim from the governing specification.
 */
export const CAPABILITY_KEYWORDS = {
  scrape: [
    'scrape',
    'scraper',
    'fetch url',
    'fetch page',
    'page content',
    'extract page',
    'unlock url',
    'webpage',
  ],
  serp: ['serp', 'google search', 'google results', 'search engine results'],
  'web-search': ['web search', 'search web', 'internet search', 'find sources', 'research web'],
} as const;

/** The three capabilities `run` currently has preference policy for. */
export type Capability = keyof typeof CAPABILITY_KEYWORDS;

const CAPABILITY_LIST = Object.keys(CAPABILITY_KEYWORDS) as Capability[];

/**
 * Per-capability backend preference order, used by rank.ts as tie-break tier
 * 5 (see rank.ts `rankCandidates`). Applied only among candidates that
 * already survived search matching and async exclusion — this table cannot
 * make an irrelevant candidate win, and it is never a full roster: a backend
 * absent from a capability's list simply gets no preference boost for it.
 *
 * IMPORTANT: these orderings are recorded human preference/cost/capability
 * assumptions (e.g. "prefer firecrawl for scraping before falling back to
 * harder-target specialists"), not measured facts (latency, success rate,
 * price at call time). Treat edits to this table as a policy change that
 * needs review, not as syncing telemetry. Initial hints, verbatim from the
 * governing specification.
 */
export const CAPABILITY_PREFERENCES = {
  scrape: ['firecrawl', 'scrapingbee', 'scrapingdog', 'geonode', 'scraperapi', 'brightdata'],
  serp: ['scraperapi', 'scrapingbee', 'scrapingdog', 'brightdata'],
  'web-search': ['exa', 'brave', 'firecrawl', 'geonode', 'you'],
} as const satisfies Record<Capability, readonly string[]>;

/** One capability whose keyword phrases matched the intent, and which phrases matched. */
export interface CapabilityMatch {
  capability: Capability;
  /** Phrases from `CAPABILITY_KEYWORDS[capability]` found as substrings of the intent. */
  matchedPhrases: string[];
}

/**
 * Result of inferring a capability from a free-text `run` intent.
 *
 * - `none`: no capability's keywords matched at all. The caller (rank.ts)
 *   decides whether unhinted auto-pick is still safe, based on whether the
 *   matched candidate set spans one backend or several.
 * - `matched`: exactly one capability applies (or one exact-phrase match won
 *   over other single-token matches); its preference hint should be used.
 * - `ambiguous`: multiple capabilities matched and neither exact-phrase
 *   tie-break nor uniqueness resolved it; `run` must refuse to auto-pick and
 *   report `candidates` so the caller can print them.
 */
export type CapabilityInferenceResult =
  | { kind: 'none' }
  | { kind: 'matched'; capability: Capability; matchedPhrases: string[] }
  | { kind: 'ambiguous'; candidates: CapabilityMatch[] };

/**
 * Infers which capability (if any) a free-text `run` intent is asking for,
 * per the governing spec's inference rules.
 *
 * Reads the intent as one lower-cased string and nothing else — no
 * tokenization, no stop-word removal. This is a deliberate, load-bearing
 * split from rank.ts's search pipeline: several keyword phrases above
 * (`page content`, `fetch page`, `extract page`) contain words that rank.ts's
 * STOP_WORDS list drops (`page`). If this function tokenized/stop-word
 * filtered its input first, "page content" would never match because "page"
 * would already be gone by the time the phrase check ran. Capability
 * inference and search/ranking read the same intent string but must stay two
 * independent pipelines for this reason.
 */
export function inferCapability(intent: string): CapabilityInferenceResult {
  const lowered = intent.toLowerCase();

  const allMatches: CapabilityMatch[] = [];
  for (const capability of CAPABILITY_LIST) {
    const phrases = CAPABILITY_KEYWORDS[capability];
    const matchedPhrases = phrases.filter((phrase) => lowered.includes(phrase));
    if (matchedPhrases.length > 0) {
      allMatches.push({ capability, matchedPhrases: [...matchedPhrases] });
    }
  }

  if (allMatches.length === 0) return { kind: 'none' };

  if (allMatches.length === 1) {
    const only = allMatches[0];
    if (only === undefined) return { kind: 'none' }; // unreachable given the length check; satisfies noUncheckedIndexedAccess
    return { kind: 'matched', capability: only.capability, matchedPhrases: only.matchedPhrases };
  }

  // Multiple capabilities matched. Prefer a capability whose match includes a
  // multi-word "exact phrase" (e.g. "google search") over one that only hit a
  // bare single-token keyword (e.g. "serp"): a whole phrase is a much
  // stronger, less coincidental capability signal.
  const phraseWinners = allMatches.filter((match) => match.matchedPhrases.some((phrase) => phrase.includes(' ')));
  if (phraseWinners.length === 1) {
    const winner = phraseWinners[0];
    if (winner === undefined) return { kind: 'ambiguous', candidates: allMatches }; // unreachable given the length check
    return { kind: 'matched', capability: winner.capability, matchedPhrases: winner.matchedPhrases };
  }

  return { kind: 'ambiguous', candidates: allMatches };
}
