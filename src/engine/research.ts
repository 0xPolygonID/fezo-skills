// The fan-out executor: turns one RoutingPlan into many concurrent provider
// lanes and hands their responses to aggregate.ts.
//
// THE RULE THIS MODULE OBEYS, stated in one-step.ts's header and in retry.ts:
// there is exactly one HTTP call loop in this engine, and it is retry.ts's
// `run()`. So a lane here is a `run()` with ONE candidate and `maxAttempts: 1`
// -- not a second loop. Concurrency lives strictly above `run()`, which keeps
// billing accounting and the gateway-code-first abort/retry classification
// governed in exactly one place. Do not "optimise" this into a bespoke fetch
// loop; the classification it would have to duplicate is the subtlest logic in
// the repository.

import { canonicalizeUrl, computeCoverage, extractItems, mergeItems, nextActions, recordHit, RRF_K } from './aggregate.js';
import type { Coverage, DroppedQuery, LaneItems, NarrowedQuery, NextAction, ProviderHit, ResearchItem, UnfetchedTarget } from './aggregate.js';
import type { ToolCandidate } from './catalog.js';
import { resolveArgName } from './one-step.js';
import { MAX_RESEARCH_CALLS } from './plan.js';
import type { RoutingPlan } from './plan.js';
import { diversityOrder, orderByIndexDiversity } from './providers.js';
import type { Recommendation } from './providers.js';
import { ABORT_CODES, run } from './retry.js';
import type { AttemptLog } from './retry.js';

/**
 * How many provider lanes may be in flight at once.
 *
 * Not unbounded: a `research` fan-out with several queries can be 24 calls, and
 * firing all of them simultaneously buries the gateway under one user's single
 * command and makes an account-scoped abort useless (every call is already
 * gone before the first 402 comes back). Six is wide enough that wall-clock is
 * dominated by the slowest provider rather than by queueing.
 */
export const RESEARCH_CONCURRENCY = 6;

export interface ResearchOptions {
  plan: RoutingPlan;
  candidates: readonly ToolCandidate[];
  excluded: readonly string[];
  gateway: { baseUrl: string; apiKey: string; fetchFn?: typeof fetch };
  /** Canonical URLs a session has already returned; suppressed from results. */
  seenUrls?: ReadonlySet<string>;
  /** The session id in force, so emitted follow-up commands carry `--session`.
   * Without it an agent composing its own follow-up would re-pay for links it
   * already has -- the exact cost this feature exists to avoid. */
  sessionId?: string;
  maxCalls?: number;
  concurrency?: number;
}

export interface ResearchOutcome {
  plan: RoutingPlan;
  /** True when at least one lane served. A round that got some results is a
   * success: partial breadth is the normal case for a fan-out. */
  ok: boolean;
  /** Set when an account-scoped code stopped the round. */
  aborted?: string;
  items: ResearchItem[];
  documents: ResearchDocument[];
  coverage: Coverage;
  nextActions: NextAction[];
  billing: { callsBilled: number; attempts: AttemptLog[] };
}

/** One fetched target page. */
export interface ResearchDocument {
  url: string;
  backendId: string;
  /** The provider's response body, verbatim. Truncation is the renderer's
   * decision, not this module's -- an executor that silently shortened a page
   * would make a scrape look complete when it is not. */
  content: string;
}

/** One planned unit of work: one query against one provider's entry method. */
interface Lane {
  query: string;
  backendId: string;
  rank: number;
  candidate: ToolCandidate;
  argName: string;
}

/** Resolves the provider lanes for one query, in diversity order. */
function lanesForQuery(
  query: string,
  plan: RoutingPlan,
  candidates: readonly ToolCandidate[],
  excluded: readonly string[],
): { lanes: Lane[]; skipped: string[] } {
  const byTool = new Map(candidates.map((c) => [c.tool, c]));
  // Every search-shaped intent contributes providers; a `news` plan should
  // reach news providers as well as general search ones.
  const intents = plan.intents.filter((intent) => intent !== 'scrape' && intent !== 'crawl');
  // ONE combined list, ordered for diversity ONCE -- never per intent and then
  // concatenated. `fanout` is a per-query TOTAL across intents (spec § Fan-out
  // policy: "the providers for every declared intent are ordered for diversity
  // and the first `fanout` of that combined list are called"), so multi-intent
  // has to change WHICH providers a query reaches. Ordering per intent cannot
  // do that at any width the CLI actually offers: the first intent's eligible
  // list is already at least as long as the fan-out, so the second intent's
  // providers only ever appear behind a truncation that has already discarded
  // them, and `['search','news']` reaches exactly the providers `['search']`
  // does. Worse, the calls it does spend go to the wrong indexes -- at fanout 5
  // the 5th lane went to `geonode`, whose `indexId` is the `google-serp` that
  // `firecrawl` had just queried, while `newsapi`, the only distinct news index
  // and the reason the plan declared `news` at all, was never called.
  const eligible: Recommendation[] = [];
  const seenBackend = new Set<string>();
  for (const intent of intents.length > 0 ? intents : (['search'] as const)) {
    // The WHOLE eligible list per intent, not `plan.fanout` of it: a per-intent
    // truncation would throw away exactly the rows the combined ordering exists
    // to promote. `diversityOrder` at a limit above the eligible count returns a
    // permutation and never a truncation (its docstring says so), and the
    // round-robin below is idempotent on an already round-robined list, so
    // ordering twice changes nothing.
    for (const rec of diversityOrder(intent, Number.MAX_SAFE_INTEGER, excluded)) {
      // First appearance wins, so a backend declared under two intents keeps its
      // best-ranked row -- and that row's entry methods, which differ per intent
      // (`brave_search` under `search`, `brave_news` under `news`).
      if (seenBackend.has(rec.backendId)) continue;
      seenBackend.add(rec.backendId);
      eligible.push(rec);
    }
  }
  const lanes: Lane[] = [];
  const skipped: string[] = [];
  // The one width bound in this function, which is why the old
  // `fanout * intents.length` break is gone: it could never change the outcome
  // (a trailing `slice(0, fanout)` decided the width regardless), so it only
  // resolved candidates that were then thrown away while reading like a budget
  // guard. A row this catalog cannot reach still costs its slot -- it is a
  // provider the round declined to call, not one it may replace.
  for (const rec of orderByIndexDiversity(eligible, plan.fanout)) {
    let resolved = false;
    /** True once one of this provider's entry methods was found in the live
     * catalog -- which separates "your gateway does not serve this provider"
     * from "it does, but the method takes a URL rather than a query". Reporting
     * both as "not in catalog" asserts something false about the caller's
     * gateway and sends them looking for a registration problem they do not
     * have. */
    let inCatalog = false;
    for (const entry of rec.entryMethods) {
      const candidate = byTool.get(entry);
      if (candidate === undefined) continue;
      inCatalog = true;
      const argName = resolveArgName(candidate.inputSchema, 'query');
      if (argName === undefined) continue;
      lanes.push({ query, backendId: rec.backendId, rank: lanes.length + 1, candidate, argName });
      resolved = true;
      break;
    }
    // A ranked provider this caller's catalog cannot reach is REPORTED, not
    // silently absent. Without it a fanout-4 round against a catalog holding
    // one provider bills once, says nothing, and its thin-coverage gap reads as
    // "the web is sparse" when the truth is "three of the four providers you
    // budgeted for are not on your gateway". Same vocabulary as one-step.ts's
    // `buildWalk`, so the two report an unreachable provider identically.
    if (!resolved) skipped.push(`${rec.backendId} (${inCatalog ? 'no query argument' : 'not in catalog'})`);
  }
  return { lanes, skipped };
}

/**
 * Everything one lane has to say about itself, written into that lane's own
 * slot and read back in plan order once the pool has drained.
 *
 * A per-lane record rather than shared accumulator arrays because a bounded
 * pool finishes lanes in whatever order the network answers: `push`-ing into
 * shared arrays made the attempt log, the failure list and the reported abort
 * code come out in completion order, so two runs against byte-identical
 * provider responses emitted different documents. That is the same
 * completion-order nondeterminism the lane-slotting comment below refuses for
 * results, applied to the round's own report of itself -- and Task 11 renders
 * all of it.
 */
interface LaneReport {
  attempts: AttemptLog[];
  /** Set when the lane was billed and answered: the backend that served. */
  served?: string;
  failed?: { backendId: string; reason: string };
  skipped?: string;
  /** The account-scoped code this lane saw, if any. */
  aborted?: string;
}

/** Runs `tasks` with at most `limit` in flight, stopping early once
 * `shouldStop()` is true. In-flight work is always awaited, never discarded:
 * a response may already be billed. */
async function pool<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number, shouldStop: () => boolean): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      if (shouldStop()) return;
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task === undefined) return;
      out.push(await task());
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The single provider that will fetch this round's targets.
 *
 * ONE provider per target, not `fanout` of them: breadth is what a fan-out buys
 * for a QUERY, where each index returns a different set of links. A URL is one
 * document -- fetching it from five providers buys five copies of the same page
 * and bills five times. Fallback on failure is the one-step `scrape` command's
 * job, and the coverage gap points there (which is why the gap must carry the
 * target as a bare, runnable URL; see `UnfetchedTarget`).
 *
 * Takes no target: the resolved lane is the same for every URL in the round,
 * and a `target` parameter the body never read made this function look as
 * though it routed per address while rebuilding the tool map once per target.
 */
function scrapeLane(
  candidates: readonly ToolCandidate[],
  excluded: readonly string[],
): { backendId: string; candidate: ToolCandidate; argName: string } | undefined {
  const byTool = new Map(candidates.map((c) => [c.tool, c]));
  // `Number.MAX_SAFE_INTEGER`, as `lanesForQuery` asks above: the argument is a
  // permutation request, not a budget. `diversityOrder` never truncates at a
  // limit above the eligible count (its docstring says so), and which provider
  // may serve a scrape is a different quantity from how many calls this round
  // may bill -- `MAX_RESEARCH_CALLS` here read as a provider-count cap.
  for (const rec of diversityOrder('scrape', Number.MAX_SAFE_INTEGER, excluded)) {
    for (const entry of rec.entryMethods) {
      const candidate = byTool.get(entry);
      if (candidate === undefined) continue;
      const argName = resolveArgName(candidate.inputSchema, 'url');
      if (argName === undefined) continue;
      return { backendId: rec.backendId, candidate, argName };
    }
  }
  return undefined;
}

/**
 * One target lane's own report, written into its own slot for the same reason
 * `LaneReport` above is: a bounded pool finishes lanes -- query lanes and
 * target lanes alike -- in whatever order the network answers, and this
 * round's list of documents and gaps must not depend on that order.
 */
interface TargetReport {
  attempts: AttemptLog[];
  document?: ResearchDocument;
  /** The bare target URL and, separately, why it is missing. Structured rather
   * than pre-formatted: `computeCoverage` renders the pair into a gap line and
   * `nextActions` quotes the URL alone into a runnable `fezoctl scrape`, and
   * only one of those two can be served by a single joined string. */
  failed?: UnfetchedTarget;
  /** The account-scoped code this lane saw, if any. */
  aborted?: string;
}

export async function runResearch(options: ResearchOptions): Promise<ResearchOutcome> {
  const { plan, candidates, excluded, gateway } = options;
  // `Math.min(NaN, n)` is NaN, and every `lanes.length > NaN` test below is
  // false -- so a non-finite budget would wave through every lane of every
  // query, in the one module whose header calls itself the absolute bound.
  // Treated as "no budget supplied" rather than as unlimited, matching
  // `clampPlan`'s rationale for the same input class on `fanout`.
  // `Math.trunc`, not merely `Number.isFinite`: a FRACTIONAL budget is as bad
  // as a non-finite one and fails more quietly. With 3.7, `budget` never
  // reaches 0, `lanes.slice(0, 0.7)` keeps nothing, and every remaining query
  // is planned with zero lanes -- so it falls through to "returned no results",
  // reviving the exact false claim about the web that this round of repairs
  // removed from the abort path. `clampPlan` truncates for the same reason.
  const requestedCalls = options.maxCalls;
  const maxCalls = Math.min(
    Number.isFinite(requestedCalls) ? Math.trunc(requestedCalls as number) : MAX_RESEARCH_CALLS,
    MAX_RESEARCH_CALLS,
  );
  const concurrency = options.concurrency ?? RESEARCH_CONCURRENCY;

  // Budget allocation, whole queries first: half of two queries' providers is
  // worse coverage than all of one query's, and a partially-run query reports
  // a "thin" gap that is really a budget artefact.
  const planned: Array<{ query: string; lanes: Lane[] }> = [];
  const droppedQueries: DroppedQuery[] = [];
  const narrowedQueries: NarrowedQuery[] = [];
  /** Ranked providers no lane could be built for, gathered while planning.
   * Deduped at the end: with several queries the same absent provider is
   * reported once per query, and a list repeating one fact reads as many. */
  const planSkipped: string[] = [];
  // Targets are reserved BEFORE queries take what is left, which is the order
  // `clampPlan` states ("Targets are bounded first and keep their budget;
  // queries then take what is left"). Letting the query loop spend first
  // inverted it: on `--max-calls 4` with one target and a fanout-5 query, all
  // four calls went to the query and the URL the caller had NAMED went
  // unfetched -- a fan-out width is a preference, an explicit target is an
  // instruction, and the two modules disagreeing about which comes first is the
  // three-places-must-agree hazard the review flagged.
  // `Math.max(0, ...)` restored: the reservation rewrite dropped the floor the
  // old `fetchable` computation carried, and a negative budget then made
  // `slice(0, -5)` keep everything but the last five -- so a round with a
  // negative call budget still billed. Not reachable through the CLI, which is
  // exactly what was true of the fractional budget this module already guards.
  // Symmetric with the search refusal below: a caller who declared intents,
  // none of which is scrape-shaped, does not get their targets fetched. The
  // principle was one-way before -- `--intents scrape` refused to search, but
  // `--intents search` still billed a scrape for a URL the planner had put in
  // `targets`. Declaring an intent is an instruction in both directions.
  //
  // The ordinary path is unaffected: the heuristic emits `['scrape','search']`
  // whenever a prompt carries a URL, so only an explicit narrowing reaches this.
  const scrapeShaped = plan.intents.some((intent) => intent === 'scrape' || intent === 'crawl');
  const noScrapeIntent = plan.intents.length > 0 && !scrapeShaped;
  const refusedTargets: UnfetchedTarget[] = noScrapeIntent
    ? plan.targets.map((url) => ({ url, reason: `no scrape-shaped intent declared (intents: ${plan.intents.join(', ')})` }))
    : [];
  const fetchableTargets = noScrapeIntent ? [] : plan.targets;
  const targetReserve = Math.min(fetchableTargets.length, Math.max(0, maxCalls));
  let budget = maxCalls - targetReserve;
  // A caller who declared intents, none of which a query can be served by
  // (`--intents scrape` with a query and no target), gets NO search fan-out.
  // The `['search']` fallback below exists for a plan that declared nothing at
  // all; applying it here billed search providers against an explicit
  // instruction not to search. Reported, never silent, so the caller can see
  // their own flag caused it.
  const searchShaped = plan.intents.filter((intent) => intent !== 'scrape' && intent !== 'crawl');
  const noSearchIntent = plan.intents.length > 0 && searchShaped.length === 0;
  for (const query of plan.queries) {
    if (noSearchIntent) {
      droppedQueries.push({ query, reason: `no search-shaped intent declared (intents: ${plan.intents.join(', ')})` });
      continue;
    }
    const { lanes, skipped: unreachable } = lanesForQuery(query, plan, candidates, excluded);
    planSkipped.push(...unreachable);
    // Zero lanes is not "the web returned nothing" -- nothing was asked. Left
    // in `planned` it would earn a `"…" returned no results` gap, the same
    // false claim the abort path used to make.
    if (lanes.length === 0) {
      droppedQueries.push({ query, reason: 'no provider in the catalog can serve it' });
      continue;
    }
    if (budget <= 0) { droppedQueries.push({ query }); continue; }
    // A budget smaller than the width NARROWS the query rather than cancelling
    // it: `--max-calls 4` on a fanout-5 round used to bill nothing and exit 2,
    // spending none of the four calls the caller explicitly authorised. Lanes
    // are dropped from the TAIL, which by `diversityOrder`'s construction is
    // the lowest-diversity provider -- the one whose index another lane in this
    // same query is most likely to have covered already. The narrowing is
    // reported (see `narrowedQueries`), because a thinner round and a full one
    // otherwise read identically in the output.
    const width = Math.min(lanes.length, budget);
    if (width < lanes.length) narrowedQueries.push({ query, requested: lanes.length, actual: width });
    const kept = lanes.slice(0, width);
    budget -= kept.length;
    planned.push({ query, lanes: kept });
  }
  // Split by POSITION, never by value. `plan.targets.filter((t) => !unfetched.includes(t))`
  // decides membership by string equality, so a target listed twice with only
  // one occurrence inside the budget loses BOTH -- a call the round had already
  // reserved and then never spent, reported afterwards as a gap. `clampPlan`
  // dedupes `targets` today, but that is another module's invariant and this one
  // must not silently depend on it: the same reason the lane slots below are
  // keyed by a query's position rather than by its text.
  // `targetReserve`, not whatever the query loop left over: the reservation
  // above is what the queries were already budgeted around, so reading the
  // leftover here would spend the same calls twice.
  const fetchTargets = fetchableTargets.slice(0, targetReserve);
  const unfetchedTargets = fetchableTargets.slice(targetReserve);

  // The flat, plan-ordered list of lanes this round will run: query order
  // first, then diversity position within the query. Every slot array below is
  // indexed by a position in THIS list (or in `planned`), never by completion
  // order and never by a query's text.
  const plannedLanes = planned.flatMap(({ lanes }, queryIndex) =>
    lanes.map((lane) => ({ queryIndex, lane })),
  );
  const laneReports: Array<LaneReport | undefined> = plannedLanes.map(() => undefined);
  // Sparse by design: a lane writes its own slot (see the write below), so a
  // failed lane leaves a hole rather than shifting its neighbours. Keyed by the
  // query's POSITION in `planned` rather than by its text, because a lane's
  // identity is (query index, diversity rank): keyed by string, two identical
  // query strings in one plan would share a slot array and the second query's
  // lanes would overwrite the first's already-billed results. `clampPlan`
  // dedupes `queries` today, but that is another module's invariant and this
  // one must not silently depend on it.
  const laneItemsByQuery: Array<Array<LaneItems | undefined>> = planned.map(() => []);
  // One slot per target this round will actually fetch; `unfetchedTargets` is
  // whatever the query budget left no room for, and those never get a lane.
  const targetReports: Array<TargetReport | undefined> = fetchTargets.map(() => undefined);
  // Live flag, read by the pool's stop check while lanes are still in flight.
  // The code this round REPORTS is picked out of the lane slots afterwards, so
  // it does not depend on whose 402 came back first.
  let abortSeen = false;

  const tasks = plannedLanes.map(({ queryIndex, lane }, laneIndex) => async () => {
    // ONE candidate, ONE attempt: this lane is a single provider call. The
    // ranked-fallback behaviour of `run()` is deliberately not used here --
    // breadth across providers is the fan-out's job, and a lane that also
    // fell back would double-bill the same slot.
    const report = await run({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      candidates: [lane.candidate],
      args: { [lane.argName]: lane.query },
      maxAttempts: 1,
      ...(gateway.fetchFn !== undefined ? { fetchFn: gateway.fetchFn } : {}),
    });
    const laneReport: LaneReport = { attempts: [...report.attempts] };
    laneReports[laneIndex] = laneReport;
    for (const attempt of report.attempts) {
      if (attempt.gatewayCode !== undefined && ABORT_CODES.has(attempt.gatewayCode)) {
        laneReport.aborted ??= `${attempt.gatewayCode}: ${attempt.reason}`;
        abortSeen = true;
      }
    }
    if (report.outcome.kind !== 'success') {
      const last = report.attempts[report.attempts.length - 1];
      if (last?.preflight !== undefined) laneReport.skipped = `${lane.backendId} (${last.preflight} rejected)`;
      else laneReport.failed = { backendId: lane.backendId, reason: last?.gatewayCode ?? last?.reason ?? 'failed' };
      return;
    }
    laneReport.served = lane.backendId;
    let body: unknown;
    try {
      body = JSON.parse(report.outcome.result.bodyText);
    } catch {
      // A billed 2xx that is not JSON yields no items but is still a served
      // lane -- reported, never silently counted as a failure.
      body = undefined;
    }
    const items = extractItems(lane.candidate.tool, body);
    // Written into the lane's OWN slot, never appended: the pool completes
    // lanes in whatever order the network answers, and `mergeItems` makes the
    // first-seen item the representative of a merge (its docstring says so in
    // as many words), so appending would let a race decide which of two
    // merged URLs appears in the output document. Slotting by diversity rank
    // makes the array plan-ordered whatever the completion order was. Holes
    // (failed lanes) are compacted at the read below.
    const list = laneItemsByQuery[queryIndex];
    if (list !== undefined) list[lane.rank - 1] = { backendId: lane.backendId, rank: lane.rank, items };
  });

  // Resolved ONCE for the round rather than inside each task: the lane does not
  // depend on the target -- every URL goes to the same best-ranked scrape
  // provider -- so re-resolving it per target rebuilt the tool map and re-ran
  // `diversityOrder` for an answer that cannot change.
  const lane = scrapeLane(candidates, excluded);
  // Runs alongside the query lanes, in the SAME round, for the reason the spec
  // gives targets a place in `RoutingPlan` at all: a search-and-scrape prompt
  // should not cost two invocations. Fetching a target is still exactly one
  // `run()` call with `maxAttempts: 1` -- the same single-candidate lane shape
  // as a query lane, just keyed by target index instead of (query, rank).
  const targetTasks = fetchTargets.map((target, targetIndex) => async () => {
    if (lane === undefined) {
      targetReports[targetIndex] = { attempts: [], failed: { url: target, reason: 'no scrape provider available' } };
      return;
    }
    const report = await run({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      candidates: [lane.candidate],
      args: { [lane.argName]: target },
      maxAttempts: 1,
      ...(gateway.fetchFn !== undefined ? { fetchFn: gateway.fetchFn } : {}),
    });
    const targetReport: TargetReport = { attempts: [...report.attempts] };
    targetReports[targetIndex] = targetReport;
    for (const attempt of report.attempts) {
      if (attempt.gatewayCode !== undefined && ABORT_CODES.has(attempt.gatewayCode)) {
        targetReport.aborted ??= `${attempt.gatewayCode}: ${attempt.reason}`;
        abortSeen = true;
      }
    }
    if (report.outcome.kind !== 'success') {
      const last = report.attempts[report.attempts.length - 1];
      targetReport.failed = { url: target, reason: last?.gatewayCode ?? last?.reason ?? 'failed' };
      return;
    }
    targetReport.document = { url: target, backendId: lane.backendId, content: report.outcome.result.bodyText };
  });

  await pool([...tasks, ...targetTasks], concurrency, () => abortSeen);

  // Read back in plan order: a lane that never ran (the pool stopped) simply
  // has no slot, which is why the holes are dropped rather than defaulted.
  const ran = laneReports.filter((r): r is LaneReport => r !== undefined);
  const targetsRan = targetReports.filter((r): r is TargetReport => r !== undefined);
  const documents = targetsRan.flatMap((r) => (r.document !== undefined ? [r.document] : []));
  const failedTargets = targetsRan.flatMap((r) => (r.failed !== undefined ? [r.failed] : []));
  // Query attempts before target attempts -- both slotted, neither in
  // completion order, so this concatenation is deterministic and matches the
  // plan's own ordering of the round's two kinds of work.
  const attempts = [...ran.flatMap((r) => r.attempts), ...targetsRan.flatMap((r) => r.attempts)];
  const served = new Set([
    ...ran.flatMap((r) => (r.served !== undefined ? [r.served] : [])),
    ...documents.map((d) => d.backendId),
  ]);
  const failed = ran.flatMap((r) => (r.failed !== undefined ? [r.failed] : []));
  const skipped = [...new Set([...planSkipped, ...ran.flatMap((r) => (r.skipped !== undefined ? [r.skipped] : []))])];
  const aborted = ran.find((r) => r.aborted !== undefined)?.aborted ?? targetsRan.find((r) => r.aborted !== undefined)?.aborted;

  // Work the pool never started, recovered by diffing the plan against the
  // slots. Without this the round reports a query nobody asked as
  // `"beta" returned no results` -- a claim about the WEB, made on the strength
  // of a request that was never sent -- and the planned target disappears from
  // the report entirely. `computeCoverage`'s own docstring says it exists to
  // stop exactly that, and the abort path was the one route around it.
  //
  // A query counts as unstarted only when NONE of its lanes ran: one lane that
  // came back is a real, if thin, answer, and the thin-coverage gap is the
  // honest description of it.
  const unstartedQueryIndexes = new Set<number>();
  /** The same set keyed by text, for `narrowedQueries` — which carries no
   * index. Two identical query strings in one plan would collapse here, but a
   * narrowing entry for either of them is moot once one is unstarted. */
  const unstartedQueries = new Set<string>();
  if (aborted !== undefined) {
    planned.forEach(({ lanes }, queryIndex) => {
      if (lanes.length === 0) return;
      const laneSlots = plannedLanes
        .map((entry, laneIndex) => ({ entry, laneIndex }))
        .filter(({ entry }) => entry.queryIndex === queryIndex);
      // ZERO SERVED, not zero started. A query whose lanes were partly never
      // sent and partly killed by the account abort has produced no evidence
      // about the web either way, so `"…" returned no results` is the same
      // false claim in a thinner disguise -- the spec's own decision is that
      // unstarted work is reported as unstarted. A query with even one lane
      // that actually answered keeps its honest thin-coverage gap.
      const served = laneSlots.some(({ laneIndex }) => laneReports[laneIndex]?.served !== undefined);
      if (!served) unstartedQueryIndexes.add(queryIndex);
    });
    for (const queryIndex of unstartedQueryIndexes) {
      const entry = planned[queryIndex];
      if (entry === undefined) continue;
      droppedQueries.push({ query: entry.query, reason: 'round aborted' });
      unstartedQueries.add(entry.query);
    }
  }
  // Targets whose slot is still empty were never fetched, for the same reason.
  const unstartedTargets: UnfetchedTarget[] =
    aborted === undefined
      ? []
      : fetchTargets.flatMap((url, index) =>
          targetReports[index] === undefined ? [{ url, reason: 'round aborted' }] : [],
        );

  const seen = options.seenUrls ?? new Set<string>();
  const perQuery: Array<{ query: string; items: ResearchItem[] }> = [];
  // A set of URLs unioned across queries, never a sum of the per-query counts.
  // `mergeItems` reports suppression per DOCUMENT on purpose -- its own comment
  // rejects a counter because it would multiply the figure by the fan-out width
  // -- and adding its per-query figures up reintroduces exactly that
  // multiplication on the query axis: one already-seen page returned under a
  // research plan's three sub-queries would be reported as three pages
  // withheld. What the caller asked is "how many pages did I already have?",
  // and that answer cannot depend on how the plan was split.
  const suppressedUrls = new Set<string>();
  planned.forEach(({ query }, queryIndex) => {
    // A query the abort stopped before any lane started is reported as not run
    // (see `unstartedQueryIndexes`), not as a query that came back empty. Left
    // in here it would ALSO get a `"…" returned no results` gap, which is the
    // false claim this whole diff exists to remove.
    if (unstartedQueryIndexes.has(queryIndex)) return;
    const laneItems = (laneItemsByQuery[queryIndex] ?? []).filter((l): l is LaneItems => l !== undefined);
    const merged = mergeItems(laneItems, seen);
    for (const url of merged.suppressedUrls) suppressedUrls.add(url);
    perQuery.push({ query, items: merged.items });
  });
  // One set across queries: the same URL surfacing under two of a research
  // plan's sub-queries is one document, and the agent should read it once.
  const allLanes: LaneItems[] = perQuery.map(({ items }, queryIndex) => ({
    backendId: `merged-${String(queryIndex)}`,
    rank: queryIndex + 1,
    items: items.map((i) => ({
      url: i.url,
      ...(i.title !== i.url ? { title: i.title } : {}),
      ...(i.snippet !== undefined ? { snippet: i.snippet } : {}),
      // Carried through even though neither pass keys on it: the emitted
      // document is built from THIS merge's representative (see below), so a
      // field dropped here is a field dropped from the round's output.
      ...(i.publishedAt !== undefined ? { publishedAt: i.publishedAt } : {}),
    })),
  }));
  const combined = mergeItems(allLanes, new Set());
  // Provider attribution comes from the per-query merge, which knows the real
  // backends; the cross-query pass only unions and re-scores.
  const attributionByUrl = new Map<string, ResearchItem>();
  for (const { items } of perQuery) {
    for (const item of items) {
      const existing = attributionByUrl.get(item.url);
      if (existing === undefined) {
        // COPIED, never aliased. `perQuery` is what `computeCoverage` reads
        // below, and it derives `agreementMedian` from `providers.length` --
        // which the union just under here mutates. Sharing these objects made a
        // document found by provider A under query one and by provider B under
        // query two report cross-provider agreement INSIDE query one that never
        // happened there; first-writer-wins meant it inflated only the first
        // query, which is what proves it was aliasing rather than a designed
        // round-level rollup. The inflated median then suppressed that query's
        // "no cross-provider agreement" gap and the follow-up command that goes
        // with it, and a silent gap reads as full coverage.
        attributionByUrl.set(item.url, {
          ...item,
          providers: item.providers.map((hit) => ({ ...hit })),
          duplicates: [...item.duplicates],
        });
        continue;
      }
      // `ProviderHit`'s one-entry-per-backend invariant holds across the
      // cross-query union too, and this is the third place that can break it:
      // one backend serving two sub-queries that both returned this document is
      // still one provider agreeing once, and a plain `push(...)` would score
      // the fan-out's own breadth as agreement. `recordHit` is aggregate.ts's
      // own implementation of that rule, exported rather than copied here so
      // the invariant cannot drift away from the module that declares it.
      for (const hit of item.providers) recordHit(existing.providers, hit);
      // A later query's item may have collapsed originals of its own; they are
      // this document's duplicates too, whichever query first surfaced it.
      for (const url of item.duplicates) {
        if (!existing.duplicates.includes(url)) existing.duplicates.push(url);
      }
    }
  }
  // Built FROM the cross-query representative, never substituted for it. Pass 2
  // of that merge collapses two same-title different-host documents into one
  // representative, so replacing it with the per-query item keyed on the
  // representative's URL alone deleted the collapsed twin outright: its URL, its
  // `duplicates` and its provider hit, all of them already billed. Both
  // `ResearchItem.duplicates` ("nothing is discarded by dedup, only grouped")
  // and the spec ("the surviving item keeps every source URL and every
  // contributing provider") promise the exact opposite.
  const items = combined.items.map((item) => {
    // The representative plus every URL that folded into it: each is a key in
    // `attributionByUrl`, because every URL in this merge came from a per-query
    // item and pass 1 cannot invent one (its inputs are already canonical).
    const contributors = [item.url, ...item.duplicates].flatMap((url) => attributionByUrl.get(url) ?? []);
    const providers: ProviderHit[] = [];
    const duplicates = [...item.duplicates];
    for (const contributor of contributors) {
      for (const hit of contributor.providers) recordHit(providers, hit);
      // Two kinds of duplicate meet here and a document keeps both: the
      // cross-query twins' canonical URLs (already in `duplicates`), and each
      // contributor's own originals -- the pre-canonicalization strings its
      // providers actually sent.
      for (const url of contributor.duplicates) {
        if (!duplicates.includes(url)) duplicates.push(url);
      }
    }
    return {
      ...item,
      providers,
      duplicates,
      // Re-scored over the UNION rather than carried from one query's merge:
      // `score` is defined as the RRF sum over `providers`, so an item whose
      // provider list grew here and whose score did not would state two
      // different numbers of contributing providers in one document.
      score: providers.reduce((sum, hit) => sum + 1 / (RRF_K + hit.resultRank), 0),
    };
  });
  items.sort((a, b) => (b.score - a.score) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  const coverage = computeCoverage({
    queries: perQuery,
    served: [...served],
    failed,
    skipped,
    droppedQueries,
    // Both budget-dropped targets and targets whose fetch failed belong in the
    // one gap: `computeCoverage`'s own comment on this field says a label
    // naming only one cause would misreport the other. A budget drop carries no
    // `reason` -- nothing was attempted, so there is nothing to report but the
    // URL, and the shared "not fetched" label already says that much.
    unfetchedTargets: [
      ...unfetchedTargets.map((url) => ({ url })),
      ...refusedTargets,
      ...failedTargets,
      ...unstartedTargets,
    ],
    // A query the abort stopped before any lane started is reported as not run,
    // and describing the width of a round that never happened alongside it is
    // two answers to one question. The narrowing is real but moot.
    narrowedQueries: narrowedQueries.filter(
      (n) => !unstartedQueries.has(n.query),
    ),
    suppressed: suppressedUrls.size,
  });

  const callsBilled = attempts.filter((a) => a.billed).length;
  return {
    plan,
    // `served` unions the backends that answered a QUERY with the backends that
    // fetched a DOCUMENT (see its construction above), so a round with targets
    // and no queries reports `served: ['scrapingdog']` and a served scrape
    // backend is what makes such a round a success. The `|| documents.length > 0`
    // disjunct that used to sit here predated that union and could no longer
    // decide the value either way.
    ok: aborted === undefined && served.size > 0,
    ...(aborted !== undefined ? { aborted } : {}),
    items,
    documents,
    coverage,
    nextActions: nextActions(coverage, options.sessionId, aborted),
    billing: { callsBilled, attempts },
  };
}

/** Canonical URLs this outcome returned, for a session to remember. */
export function seenUrlsFrom(outcome: ResearchOutcome): string[] {
  return outcome.items.map((item) => canonicalizeUrl(item.url));
}
