// Capability inference and provider-preference policy.
//
// This module owns:
//   - CAPABILITY_KEYWORDS  — how a free-text `run` intent maps to a coarse
//     "capability" (scrape / web-search), used only to decide which
//     preference hint (if any) applies.
//   - CAPABILITY_PREFERENCES — sparse, capability-scoped backend orderings
//     used by rank.ts as a tie-breaker among candidates that already matched
//     the query on their own merits.
//
// CAPABILITY_PREFERENCES is no longer its own hand-written table: it is a
// *view* onto providers.ts's `RECOMMENDATIONS`, the one declared,
// per-intent provider policy in this repo. Each legacy capability names one
// `RECOMMENDATIONS` intent (`scrape` -> `scrape`, `web-search` -> `search`),
// and the exported ordering is that intent's declared backend order with
// `notRecommended` entries dropped (a provider assessed and advised against
// must not win a tie-break). If provider policy ever needs to change, edit
// providers.ts — this module only reshapes that table into the legacy
// buckets `rank.ts` already knows how to read, so there is exactly one place
// a human edits provider policy.
//
// `serp` USED TO BE A THIRD CAPABILITY and is now folded into `web-search`.
// It was dropped, not renamed, because the declared table has no SERP list to
// derive an ordering from: in providers.ts's taxonomy a Google-SERP request
// and a general web-search request are both `search`, served by the same
// declared roster (`you` -> `exa` -> `brave` -> ...), which deliberately
// prefers real search APIs over scraping a results page. Keeping `serp` as a
// separate capability that aliased onto `search` bought nothing and cost
// something real: two capabilities with one ordering between them made
// "google search for X on the web" ambiguous — a refusal over a distinction
// this repo's provider policy does not draw. Its keyword phrases are
// preserved below, under `web-search`, so the same wording still infers a
// capability; only the bucket changed.
//
// This does NOT mean a SERP-specialist query now gets the search roster
// imposed on it. Those backends are absent from the declared `search` list,
// so the hint discriminates nothing among them and `selectForRun` (rank.ts)
// treats it as no hint at all — see `CAPABILITY_PREFERENCES`' doc below.
//
// CAPABILITY_KEYWORDS and `inferCapability` are unchanged from before this
// port: capability inference must not reuse rank.ts's tokenizer (see
// `inferCapability`'s doc comment below for why), and that reasoning has
// nothing to do with where the preference *orderings* come from.

import type { Intent } from './intent.js';
import { recommendationsFor } from './providers.js';

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
  // The first four phrases were the former `serp` capability's; they are kept
  // verbatim so wording that used to infer `serp` still infers a capability.
  // See this module's header for why the bucket was merged rather than kept.
  'web-search': [
    'serp',
    'google search',
    'google results',
    'search engine results',
    'web search',
    'search web',
    'internet search',
    'find sources',
    'research web',
  ],
} as const;

/** The capabilities `run` currently has preference policy for. */
export type Capability = keyof typeof CAPABILITY_KEYWORDS;

/**
 * The capabilities `inferCapability` checks, in the order it checks them.
 *
 * Written out rather than derived from `Object.keys(CAPABILITY_KEYWORDS)`
 * because `Object.keys` returns `string[]` and narrowing it back to
 * `Capability[]` would need a type assertion, which `src/` does not use. The
 * ordering is load-bearing: it is the order capabilities appear in the
 * `ambiguous-capability` report a refused `run` prints.
 *
 * Adding a capability to `CAPABILITY_KEYWORDS` without adding it here would
 * make its keywords un-inferrable. `tests/preference.test.ts` guards against
 * that by asserting every capability in `CAPABILITY_KEYWORDS` is reachable
 * through `inferCapability`.
 */
const CAPABILITY_LIST: readonly Capability[] = ['scrape', 'web-search'];

/**
 * Which `RECOMMENDATIONS` intent each legacy capability derives its order
 * from. One capability, one intent — the aliasing that made two capabilities
 * share `search` is gone (see this module's header on the folded `serp`).
 */
const CAPABILITY_INTENTS: Record<Capability, Intent> = {
  scrape: 'scrape',
  'web-search': 'search',
};

/**
 * Reshapes one `RECOMMENDATIONS` intent list into a bare backend-id order:
 * `notRecommended` entries are dropped rather than merely left low, because a
 * provider assessed and advised against must never win a preference
 * tie-break by default (a caller who actually wants it can still name the
 * tool directly — `run`'s existing exact-tool-name override is untouched).
 */
function declaredOrder(intent: Intent): readonly string[] {
  return recommendationsFor(intent)
    .filter((rec) => rec.notRecommended === undefined)
    .map((rec) => rec.backendId);
}

/**
 * Per-capability backend preference order, used by rank.ts as tie-break tier
 * 5 (see rank.ts `rankCandidates`). Applied only among candidates that
 * already survived search matching and async exclusion — this table cannot
 * make an irrelevant candidate win, and it is never a full roster: a backend
 * absent from a capability's list simply gets no preference boost for it.
 *
 * Because it is sparse, a capability can be inferred for a query whose
 * candidates this table names none of — `web-search` derives from the
 * declared `search` roster, which lists no SERP specialist, so a SERP-worded
 * query that matches only SERP specialists gets a hint that orders nothing.
 * `selectForRun` (rank.ts) therefore treats such a hint as no hint at all
 * rather than letting catalog order decide a billed call; see the comment on
 * its `matched` branch.
 *
 * IMPORTANT: the orderings behind this view are recorded human
 * preference/cost/capability assumptions (see providers.ts's module doc),
 * not measured facts (latency, success rate, price at call time). Treat an
 * edit to the underlying `RECOMMENDATIONS` table as a policy change that
 * needs review, not as syncing telemetry — and edit it there, not here: this
 * object is derived, not authored.
 */
export const CAPABILITY_PREFERENCES: Record<Capability, readonly string[]> = {
  scrape: declaredOrder(CAPABILITY_INTENTS.scrape),
  'web-search': declaredOrder(CAPABILITY_INTENTS['web-search']),
};

// Frozen for the same reason providers.ts freezes `RECOMMENDATIONS` and
// intent.ts freezes `METHOD_INTENTS`: determinism here is a property of the
// data, not of what callers happen to do with it. These arrays are built fresh
// by `declaredOrder`, so — unlike the declared table they derive from — a
// consumer that `.sort()`s or `.push()`es one would corrupt only this view,
// silently reordering `run`'s tie-break process-wide while the source of truth
// still read correctly. `readonly string[]` already blocks the obvious
// mutation at compile time; this makes it fail loudly for a caller that gets
// past the type (an `any`, a JSON round-trip, a JS consumer of the bundle).
for (const list of Object.values(CAPABILITY_PREFERENCES)) Object.freeze(list);
Object.freeze(CAPABILITY_PREFERENCES);

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
  // multi-word "exact phrase" (e.g. "web search") over one that only hit a
  // bare single-token keyword (e.g. "scrape", "serp"): a whole phrase is a
  // much stronger, less coincidental capability signal.
  const phraseWinners = allMatches.filter((match) => match.matchedPhrases.some((phrase) => phrase.includes(' ')));
  if (phraseWinners.length === 1) {
    const winner = phraseWinners[0];
    if (winner === undefined) return { kind: 'ambiguous', candidates: allMatches }; // unreachable given the length check
    return { kind: 'matched', capability: winner.capability, matchedPhrases: winner.matchedPhrases };
  }

  return { kind: 'ambiguous', candidates: allMatches };
}
