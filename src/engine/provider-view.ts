// Projects normalized catalog candidates (catalog.ts's `ToolCandidate`) onto
// the declared, per-intent provider order (providers.ts) so the `providers`
// and `list-providers` CLI commands never have to sort anything themselves.
// Ported from mcp-server/src/provider_view.ts.
//
// This module is deliberately small, for the same reason mcp-server's is:
// with order already declared in providers.ts, there is nothing to sort here.
// The work is projecting live catalog data onto the declared lists. Pure: no
// I/O, no CLI/JSON types -- see providers.ts and intent.ts for the same
// constraint.
//
// PORTING NOTE -- why this module's input is flatter than mcp-server's. In
// mcp-server, one backend's manifest-level metadata (categories, billing) and
// its callable methods are two separate types (`BackendRecord` and
// `MethodCandidate`), because its catalog client keeps them apart. fezo's
// `catalog.ts` normalizer already denormalizes that manifest metadata onto
// EVERY method of a backend (`ToolCandidate.backendCategories`/`billingModel`
// -- every candidate for one backendId carries an identical copy), so the
// `BackendRecord`/`MethodCandidate` split collapses into the single
// `ToolCandidate[]` this module's functions take. There is no separate
// "backend records" list to pass alongside it.
//
// PORTING NOTE -- the off-list classification hazard mcp-server guards
// against does not arise here. mcp-server's off-list pass deliberately
// classifies each candidate's OWN (unframed) description, not the
// agent-facing copy its MCP tools actually return, because that copy injects
// a provider display name plus a routing clause and would let a vendor's own
// name decide the intent (`Firecrawl` contains "crawl", the highest-priority
// keyword rule). fezo's `ToolCandidate.description` **is** already that raw,
// unframed catalog description -- `catalog.ts` normalizes it straight off the
// wire with no injected framing -- so there is no second, framed copy for this
// module to accidentally classify against. `classifyCandidate` (intent.ts)
// is used unmodified below for exactly that reason.
//
// PORTING NOTE -- `blockedMethods` is NOT ported. mcp-server's
// `ProviderRow.blockedMethods` documents that it has "no production trigger
// today" and exists only for a hypothetical future uncallable method, backed
// by one synthetic test in provider_view.test.ts. Shipping a field nothing
// produces and nothing here tests would be exactly the kind of speculative
// surface the governing house rules ask this port to avoid; if a genuinely
// uncallable method shows up, add the field back together with the test that
// justifies it.

import type { ToolCandidate } from './catalog.js';
import { classifyCandidate } from './intent.js';
import type { Intent } from './intent.js';
import {
  RECOMMENDATION_SOURCE,
  declaredIntentsFor,
  displayNameFor,
  isExcluded,
  recommendationFor,
  recommendationsFor,
} from './providers.js';
import type { Tier } from './providers.js';
import { INTENTS } from './intent.js';

// ---------------------------------------------------------------------------
// Per-intent view: ProviderRow / CapabilityGroup / viewForIntent / groupByCapability.
// ---------------------------------------------------------------------------

/**
 * A ranked provider row in the recommendation catalog, for one intent. This is
 * the unit of *recommending* -- distinct from `ToolCandidate` (catalog.ts),
 * which remains the unit of *calling*. camelCase, internal; the wire shape a
 * command actually renders is `AnnotatedProviderRow` (`annotate` below) --
 * kept as two types for the same reason mcp-server splits them: this shape is
 * for engine code to build and test against, the other is what a `--json`
 * consumer scripts against, and the two must be free to diverge in field
 * naming convention without one drifting to match the other by accident.
 */
export interface ProviderRow {
  rank: number;
  tier: Tier;
  /** false only for a catalog backend absent from **every** intent's declared
   * recommendations (newly onboarded / not yet assessed) -- surfaced, never
   * dropped. A provider declared under some other capability but not this one
   * is still `rated: true`; its `why` says so (see `offListWhy` below). */
  rated: boolean;
  backendId: string;
  provider: string;
  categories: string[];
  billing: ToolCandidate['billingModel'];
  why: string;
  when?: string;
  /** Assessed and advised against (currently only `xro` for `social`). */
  notRecommended?: { reason: string };
  /** All of the provider's *callable* catalog tool names, sorted -- not a
   * ranking: these are distinct operations, not alternatives. */
  methods: string[];
  /** The ordered subset of `methods` an agent should reach for first. */
  entryMethods: string[];
}

/** One capability group: an intent's declared + unrated + not-recommended
 * providers (in that order), plus the rank-1 provider's backendId. */
export interface CapabilityGroup {
  capability: Intent;
  /** The rank-1 row's backendId -- but only when that row is a declared,
   * not-advised-against recommendation. Undefined for an empty group, and for
   * a group topped by an off-list/unrated row (whose position is alphabetical,
   * not a judgment). See `groupByCapability`. */
  bestValue?: string;
  providers: ProviderRow[];
}

/**
 * The response shape one provider row is rendered as. snake_case, to match
 * the wire; the internal `ProviderRow` stays camelCase (see its doc comment).
 */
export interface AnnotatedProviderRow {
  rank: number;
  tier: Tier;
  rated: boolean;
  backend_id: string;
  provider: string;
  categories: string[];
  billing: ProviderRow['billing'];
  why: string;
  when?: string;
  not_recommended?: { reason: string };
  methods: string[];
  entry_methods: string[];
  /** Only present when `explain` is requested. `why`/`when` are already the
   * full prose above -- there is no abridged variant in the data model -- so
   * `explain` adds provenance (which doc, and when it was read), not more text. */
  source?: { doc: string; prepared: string };
}

/**
 * The doc's own warning (providers-score.md § TL;DR): the rated providers span
 * distinct functional categories and are not interchangeable across them.
 * Surfaced whenever a caller asks for the ungrouped, all-capability view.
 */
export const NOT_SUBSTITUTES_NOTE =
  'These providers are not substitutes for one another — they span distinct functional ' +
  'categories (search, scrape/crawl, news, social, proxy). Compare providers within one ' +
  'capability group; a top rank in one group says nothing about fitness for another.';

/**
 * Why an unrated row is unrated -- a note, not a judgment against the provider.
 * Reserved for a backend **no** declared list mentions (`declaredIntentsFor`
 * empty), i.e. genuinely newly onboarded. Saying this about a provider that is
 * merely off *this* capability's list would be false: nine of the twelve rated
 * providers publish methods that classify into an intent they are not declared
 * for (e.g. `brightdata_serp` -> `search`, `you_contents` -> `scrape`).
 */
const UNRATED_WHY =
  'Not yet assessed against the declared recommendations — unrecommended ' +
  'because it is unrated, not because it is known to be bad.';

/**
 * Why an *assessed* provider appears below the declared list for a capability it
 * publishes methods for but is not declared under. Distinct from both
 * `UNRATED_WHY` (never assessed) and `notRecommended` (assessed and advised
 * against for a capability it *is* declared under).
 */
function offListWhy(intent: Intent, backendId: string): string {
  const elsewhere = declaredIntentsFor(backendId).filter(
    (i) => i !== intent && !recommendationFor(i, backendId)?.notRecommended,
  );
  const tail =
    elsewhere.length > 0
      ? `it is a recommended provider for ${elsewhere.join(', ')}`
      : 'it is not a recommended provider for any capability';
  return (
    `Assessed, but not among the recommended providers for ${intent} — ${tail}. ` +
    'Prefer the ranked providers above for this capability.'
  );
}

/** Groups candidates by backendId once, so every pass below can look a
 * provider's catalog methods up in O(1). */
function indexByBackend(candidates: readonly ToolCandidate[]): Map<string, ToolCandidate[]> {
  const byBackend = new Map<string, ToolCandidate[]>();
  for (const c of candidates) {
    const list = byBackend.get(c.backendId);
    if (list) list.push(c);
    else byBackend.set(c.backendId, [c]);
  }
  return byBackend;
}

/**
 * Projects one backend's catalog methods into a `ProviderRow` (minus `rank`,
 * assigned by the caller once the final order is known), or `undefined` when
 * the backend has no method in the live catalog right now -- omitted, not a
 * zero-method row, because it is not currently registered.
 */
function buildRow(
  backendId: string,
  tier: Tier,
  rated: boolean,
  provider: string,
  why: string,
  when: string | undefined,
  notRecommended: { reason: string } | undefined,
  declaredEntryMethods: readonly string[],
  methodsByBackend: Map<string, ToolCandidate[]>,
): Omit<ProviderRow, 'rank'> | undefined {
  const backendCandidates = methodsByBackend.get(backendId);
  if (!backendCandidates || backendCandidates.length === 0) return undefined;

  const methods = backendCandidates.map((c) => c.tool).sort();
  const methodSet = new Set(methods);
  // Filtering against `methodSet` both drops a declared entry method the
  // catalog doesn't currently publish and keeps `entryMethods` a genuine
  // subset of `methods`.
  const entryMethods = declaredEntryMethods.filter((m) => methodSet.has(m));

  // Every candidate for one backendId carries an identical copy of the
  // backend-level metadata (see this module's "PORTING NOTE" on why there is
  // no separate backend-records list), so the first candidate's copy is the
  // whole backend's.
  const first = backendCandidates[0];
  const categories = first?.backendCategories ?? [];
  const billing = first?.billingModel ?? 'dynamic';

  return {
    tier,
    rated,
    backendId,
    provider,
    categories,
    billing,
    why,
    ...(when !== undefined ? { when } : {}),
    ...(notRecommended !== undefined ? { notRecommended } : {}),
    methods,
    entryMethods,
  };
}

/**
 * Groups and ranks the given catalog candidates for one intent, per the
 * declared order in `providers.ts`. Nothing here sorts the recommended
 * providers -- their position is `recommendationsFor(intent)`'s array index.
 * The only ordering decision this function makes is where to splice in
 * providers the declared list does not mention for this intent:
 *
 * 1. Every non-`notRecommended` declared provider, in declared order --
 *    omitted if it has no method in the catalog right now.
 * 2. Every catalog backend the declared list does not mention for this
 *    intent, but whose catalog methods classify into this intent (via
 *    `classifyCandidate`'s keyword/category fallback) -- appended, sorted by
 *    backendId for determinism, and never dropped: an off-list backend is
 *    unrecommended for this capability, not hidden. Two different things end
 *    up in this pass and they are labelled differently, because "absent from
 *    *this* list" is not the same as "unassessed":
 *      - a backend some *other* intent's declared list names (`brightdata`'s
 *        `serp` under `search`, `you`'s `contents` under `scrape`) keeps
 *        `rated: true` and its declared `displayName`, with `offListWhy`;
 *      - a backend no declared list names at all is the newly-onboarded case:
 *        `rated: false`, backendId as the display name, `UNRATED_WHY`.
 * 3. Every `notRecommended` declared provider, in declared order -- last, by
 *    construction (see providers.ts's `xro` comment).
 *
 * Excluded backends (`isExcluded`) appear at none of the three -- the
 * deny-list applies to the declared passes too, so adding a declared id to
 * `FEZO_EXCLUDED_BACKENDS` removes it from discovery as well as from `call`/`run`.
 *
 * `rank` is then assigned from the final array's index, 1-based.
 */
export function viewForIntent(
  candidates: readonly ToolCandidate[],
  intent: Intent,
  excluded: readonly string[],
): ProviderRow[] {
  const methodsByBackend = indexByBackend(candidates);
  const recs = recommendationsFor(intent);
  const declaredIds = new Set(recs.map((r) => r.backendId));

  const rows: Array<Omit<ProviderRow, 'rank'>> = [];

  for (const rec of recs.filter((r) => !r.notRecommended && !isExcluded(r.backendId, excluded))) {
    const row = buildRow(
      rec.backendId,
      rec.tier,
      true,
      rec.displayName,
      rec.why,
      rec.when,
      undefined,
      rec.entryMethods,
      methodsByBackend,
    );
    if (row) rows.push(row);
  }

  const offListIds = [...methodsByBackend.keys()]
    .filter((id) => !declaredIds.has(id) && !isExcluded(id, excluded))
    .filter((id) =>
      // `classifyCandidate`, not a hand-rolled classification: see this
      // module's "PORTING NOTE" on why fezo's candidate description carries
      // no injected framing and so needs none of mcp-server's workaround.
      (methodsByBackend.get(id) ?? []).some((c) => classifyCandidate(c).includes(intent)),
    )
    .sort();
  for (const id of offListIds) {
    // Assessed elsewhere vs. never assessed -- see this function's doc and
    // UNRATED_WHY. `entryMethods` stays empty either way: the declared lists
    // name entry points per capability, and neither case has one here.
    const declaredName = displayNameFor(id);
    const row =
      declaredName === undefined
        ? buildRow(id, 'fallback', false, id, UNRATED_WHY, undefined, undefined, [], methodsByBackend)
        : buildRow(id, 'fallback', true, declaredName, offListWhy(intent, id), undefined, undefined, [], methodsByBackend);
    if (row) rows.push(row);
  }

  for (const rec of recs.filter((r) => r.notRecommended && !isExcluded(r.backendId, excluded))) {
    const row = buildRow(
      rec.backendId,
      rec.tier,
      true,
      rec.displayName,
      rec.why,
      rec.when,
      rec.notRecommended,
      rec.entryMethods,
      methodsByBackend,
    );
    if (row) rows.push(row);
  }

  return rows.map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * One group per intent, in `INTENTS`' declared display order, each carrying
 * the rank-1 provider's backendId as `bestValue` -- `scrapingdog` for `scrape`,
 * `you` for `search`, matching `providers-score.md`.
 *
 * `bestValue` is undefined unless the rank-1 row came from the *declared* pass
 * and is not advised against. A group can otherwise be topped by a row the
 * declared data never made a claim about: the off-list and unrated passes sort
 * by backendId purely for determinism (see `viewForIntent`), so reading
 * `providers[0]` there would publish alphabetical position as a value
 * judgment. The catch-all `other` intent has an empty declared list by design
 * and so is *entirely* off-list rows -- it would have advertised a "best
 * value" on the most common code path, the no-argument grouped call.
 */
export function groupByCapability(
  candidates: readonly ToolCandidate[],
  excluded: readonly string[],
): CapabilityGroup[] {
  return INTENTS.map((capability) => {
    const providers = viewForIntent(candidates, capability, excluded);
    const top = providers[0];
    const topRec = top !== undefined ? recommendationFor(capability, top.backendId) : undefined;
    const bestValue = top !== undefined && topRec && !topRec.notRecommended ? top.backendId : undefined;
    return { capability, ...(bestValue !== undefined ? { bestValue } : {}), providers };
  });
}

/**
 * Renders one `ProviderRow` into the response shape a command actually
 * returns. Base fields (`rank`, `tier`, `provider`, `billing`, `why`, `when`,
 * `categories`, `methods`, `entry_methods`) are always present when
 * applicable, alongside `backend_id`/`rated`/`not_recommended` so a client can
 * key on identity and status without re-deriving them from `provider`/
 * position. Only when `explain` is requested does the output gain the doc
 * citation.
 */
export function annotate(row: ProviderRow, options: { explain?: boolean } = {}): AnnotatedProviderRow {
  return {
    rank: row.rank,
    tier: row.tier,
    rated: row.rated,
    backend_id: row.backendId,
    provider: row.provider,
    categories: row.categories,
    billing: row.billing,
    why: row.why,
    methods: row.methods,
    entry_methods: row.entryMethods,
    ...(row.when !== undefined ? { when: row.when } : {}),
    ...(row.notRecommended !== undefined ? { not_recommended: row.notRecommended } : {}),
    ...(options.explain ? { source: { doc: RECOMMENDATION_SOURCE.doc, prepared: RECOMMENDATION_SOURCE.preparedAt } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cross-intent view: listProviders / annotateListed (the `list-providers`
// command's data). Not named in this phase's provider-view.ts bullet list --
// in mcp-server the equivalent (`fezo_list_providers`/`buildListBackendsTool`)
// lives in helper_tools.ts, not provider_view.ts, because mcp-server's
// provider_view.ts only ever grew the per-intent view. It is placed here
// instead of in cli.ts (which would otherwise have to reimplement the
// cross-intent merge inline) because it is exactly as pure and
// declared-table-driven as `viewForIntent`/`groupByCapability` above, and
// cli.ts's job is composing engine functions, not being one.
// ---------------------------------------------------------------------------

/** One `list-providers` row per non-deny-listed backend present in the live
 * catalog: the merged, cross-intent view of that provider's declared
 * recommendations (its rank/tier/why/when in every intent it is declared
 * under), plus catalog metadata. Top-level `why`/`when` mirror the provider's
 * *best* declared standing, so a caller that doesn't care about the per-intent
 * breakdown still gets a one-line reason. */
export interface ListedProviderRow {
  backendId: string;
  provider: string;
  rated: boolean;
  categories: string[];
  billing: ToolCandidate['billingModel'];
  why?: string;
  when?: string;
  methods: string[];
  /** This provider's standing in every intent's DECLARED list.
   *
   * `rank` here is the provider's position in `recommendationsFor(intent)` --
   * the declared table in providers.ts -- and deliberately **NOT** the
   * catalog-filtered rank `viewForIntent` assigns (which is what `providers`
   * renders). The two disagree whenever the live catalog is missing a
   * higher-ranked declared provider: with `you` absent, `firecrawl` is rank 3
   * in `providers --intent search` and rank 4 here. That is intended.
   * `list-providers` answers "what does the declared table say about this
   * provider?", a question about the table alone, so its answer must be stable
   * across callers and entitlements; `providers` answers "who should I call
   * for this intent, right now?", which is necessarily a question about the
   * live catalog. A caller comparing the two numbers is comparing answers to
   * two different questions -- the human render says "declared rank" for
   * exactly that reason, and tests/provider-view.test.ts pins the divergence. */
  recommendations: Array<{
    intent: Intent;
    rank: number;
    tier: Tier;
    why: string;
    when?: string;
    notRecommended?: { reason: string };
  }>;
}

/** Wire shape of `ListedProviderRow` -- snake_case, matching `AnnotatedProviderRow`'s split. */
export interface AnnotatedListedProviderRow {
  backend_id: string;
  provider: string;
  rated: boolean;
  categories: string[];
  billing: ToolCandidate['billingModel'];
  why?: string;
  when?: string;
  methods: string[];
  /** Wire form of `ListedProviderRow.recommendations` -- including its `rank`,
   * which is the DECLARED rank, not `providers`' catalog-filtered one. See
   * that field's doc comment. */
  recommendations: Array<{
    intent: Intent;
    rank: number;
    tier: Tier;
    why: string;
    when?: string;
    not_recommended?: { reason: string };
  }>;
}

/**
 * One recommendation-ordered row per non-deny-listed backend present in the
 * live catalog, carrying its rank/tier/why/when per declared intent,
 * categories, billing model and callable tool names.
 *
 * Sort order, mirroring `viewForIntent`'s three-pass shape but merged ACROSS
 * intents instead of within one: actively recommended providers first
 * (ordered by their best -- i.e. lowest -- declared rank in any intent, then
 * alphabetically), then never-assessed providers (alphabetical), then
 * providers assessed and advised against in EVERY intent they are declared
 * under (alphabetical). Ordering only by rank here, never by tier: a
 * provider's best standing is a MERGE across intents, where a (primary, rank
 * 3) provider and a (secondary, rank 2) provider genuinely disagree between a
 * rank-only and a tier-weighted key -- unlike within one declared list, where
 * `tests/providers.test.ts` already guarantees tier and rank never disagree.
 */
export function listProviders(candidates: readonly ToolCandidate[], excluded: readonly string[]): ListedProviderRow[] {
  const methodsByBackend = indexByBackend(candidates);
  const backendIds = [...methodsByBackend.keys()].filter((id) => !isExcluded(id, excluded));

  interface Scored {
    row: ListedProviderRow;
    bucket: number;
    bestScore: number;
  }

  const scored: Scored[] = backendIds.map((backendId) => {
    const declared = declaredIntentsFor(backendId);
    const rated = declared.length > 0;
    const recs = declared.map((intent) => {
      const rec = recommendationFor(intent, backendId);
      // `declaredIntentsFor` only names intents where a recommendation
      // exists, so `rec` is always defined here; the `?? 0`/`?? 'fallback'`/
      // `?? ''` defaults below are unreachable defensive defaults, present
      // only because the type-checker cannot see across that guarantee.
      // `rank` is the position in the DECLARED table, not the live view's --
      // see `ListedProviderRow.recommendations`' doc comment for why.
      const rank = rec ? recommendationsFor(intent).findIndex((r) => r.backendId === backendId) + 1 : 0;
      return {
        intent,
        rank,
        tier: rec?.tier ?? 'fallback',
        why: rec?.why ?? '',
        when: rec?.when,
        notRecommended: rec?.notRecommended,
      };
    });
    const activeRecs = recs.filter((r) => r.notRecommended === undefined);
    const allNotRecommended = rated && activeRecs.length === 0;
    const bestRec = activeRecs.reduce<(typeof activeRecs)[number] | undefined>(
      (best, r) => (!best || r.rank < best.rank ? r : best),
      undefined,
    );
    const bestScore = bestRec ? bestRec.rank : Number.POSITIVE_INFINITY;

    const backendCandidates = methodsByBackend.get(backendId) ?? [];
    const methods = backendCandidates.map((c) => c.tool).sort();
    const first = backendCandidates[0];

    const row: ListedProviderRow = {
      backendId,
      provider: displayNameFor(backendId) ?? backendId,
      rated,
      categories: first?.backendCategories ?? [],
      billing: first?.billingModel ?? 'dynamic',
      ...(bestRec?.why !== undefined ? { why: bestRec.why } : {}),
      ...(bestRec?.when !== undefined ? { when: bestRec.when } : {}),
      methods,
      recommendations: recs.map((r) => ({
        intent: r.intent,
        rank: r.rank,
        tier: r.tier,
        why: r.why,
        ...(r.when !== undefined ? { when: r.when } : {}),
        ...(r.notRecommended !== undefined ? { notRecommended: r.notRecommended } : {}),
      })),
    };
    const bucket = rated && !allNotRecommended ? 0 : rated ? 2 : 1;
    return { row, bucket, bestScore };
  });

  scored.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket;
    if (a.bucket === 0 && a.bestScore !== b.bestScore) return a.bestScore - b.bestScore;
    return a.row.backendId.localeCompare(b.row.backendId);
  });

  return scored.map((s) => s.row);
}

/** Wire-shapes one `ListedProviderRow`, mirroring `annotate` above. */
export function annotateListed(row: ListedProviderRow): AnnotatedListedProviderRow {
  return {
    backend_id: row.backendId,
    provider: row.provider,
    rated: row.rated,
    categories: row.categories,
    billing: row.billing,
    ...(row.why !== undefined ? { why: row.why } : {}),
    ...(row.when !== undefined ? { when: row.when } : {}),
    methods: row.methods,
    recommendations: row.recommendations.map((r) => ({
      intent: r.intent,
      rank: r.rank,
      tier: r.tier,
      why: r.why,
      ...(r.when !== undefined ? { when: r.when } : {}),
      ...(r.notRecommended !== undefined ? { not_recommended: r.notRecommended } : {}),
    })),
  };
}
