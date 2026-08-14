# Smart Routing for Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `fezoctl plan` and `fezoctl research` — understand a prompt, fan out to several providers in parallel, and return one deduplicated, source-attributed, coverage-annotated result set.

**Architecture:** A deterministic heuristic planner behind a swappable `Planner` interface produces a `RoutingPlan`; an executor turns that plan into concurrent single-candidate `retry.ts` `run()` lanes (one per provider, so no second HTTP call loop is ever opened); a pure aggregation module sniffs each provider's response into common items, canonicalizes and dedups them, orders them by reciprocal rank fusion, and computes coverage gaps plus ready-to-run follow-up commands.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node >= 22.12, vitest, ajv 8.20.0 (already a dependency). No new runtime dependencies — `fezoctl` ships as a single bundled `.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-14-smart-routing-design.md`

## Global Constraints

- **No new runtime dependencies.** The engine bundles to one file via esbuild; anything imported must already be in `package.json`.
- **No second HTTP call loop.** Every network call goes through `retry.ts`'s `run()`. Concurrency lives strictly above it. This rule is stated in `src/engine/one-step.ts`'s module header and in `retry.ts`; violating it splits billing accounting and failure classification.
- **No LLM, no new credential.** The only secret `fezoctl` handles remains the Fezo API key.
- **ESM imports carry the `.js` extension** (`from './plan.js'`), including in tests (`from '../src/engine/plan.js'`).
- **Exit codes:** 1 = usage error, detected during argv parsing before anything is selected or billed; 2 = operational failure. Defined at `src/cli.ts:16-24`.
- **`--json` always writes a JSON document to stdout**, never empty; the English message goes to stderr.
- **Declared tables are frozen** with `Object.freeze` at module scope, matching `providers.ts` / `intent.ts` / `steering.ts`.
- **Style:** 2-space indent, single quotes, comments explain *why* not *what*.
- **Commands:** `pnpm test` (vitest run), `pnpm typecheck` (tsc). Both must pass before every commit.
- **Constants:** `MAX_FANOUT = 10`, `MAX_RESEARCH_CALLS = 24`, `RRF_K = 60`, `RESEARCH_CONCURRENCY = 6`, depth widths `shallow: 2`, `standard: 4`, `research: 8`.

---

### Task 1: Index diversity on the declared ranking

**Files:**
- Modify: `src/engine/providers.ts` (add `indexId` to `Recommendation`, one value per entry; add `diversityOrder`)
- Test: `tests/providers.test.ts`

**Interfaces:**
- Consumes: existing `Recommendation`, `RECOMMENDATIONS`, `recommendationsFor`, `isExcluded` from `providers.ts`; `Intent` from `intent.ts`.
- Produces: `Recommendation.indexId: string`; `export function diversityOrder(intent: Intent, limit: number, excluded: readonly string[]): Recommendation[]`.

- [ ] **Step 1: Write the failing test**

Add to `tests/providers.test.ts`:

```ts
import { RECOMMENDATIONS, diversityOrder, recommendationsFor } from '../src/engine/providers.js';

describe('indexId', () => {
  it('is declared on every recommendation', () => {
    for (const [intent, recs] of Object.entries(RECOMMENDATIONS)) {
      for (const rec of recs) {
        expect(rec.indexId, `${intent}/${rec.backendId}`).toBeTruthy();
      }
    }
  });
});

describe('diversityOrder', () => {
  it('takes one provider per distinct index before repeating an index', () => {
    const ordered = diversityOrder('search', 4, []);
    const indexes = ordered.map((r) => r.indexId);
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it('keeps declared rank order within one index', () => {
    const ordered = diversityOrder('search', 10, []);
    const declared = recommendationsFor('search').filter((r) => !r.notRecommended);
    const bySameIndex = (id: string) =>
      ordered.filter((r) => r.indexId === id).map((r) => r.backendId);
    for (const id of new Set(declared.map((r) => r.indexId))) {
      const declaredOrder = declared.filter((r) => r.indexId === id).map((r) => r.backendId);
      expect(bySameIndex(id)).toEqual(declaredOrder);
    }
  });

  it('returns a permutation of the declared list when limit exceeds it', () => {
    const declared = recommendationsFor('search').filter((r) => !r.notRecommended);
    const ordered = diversityOrder('search', 99, []);
    expect([...ordered].map((r) => r.backendId).sort()).toEqual(
      [...declared].map((r) => r.backendId).sort(),
    );
  });

  it('never returns a notRecommended or excluded provider', () => {
    const ordered = diversityOrder('social', 99, ['brightdata']);
    expect(ordered.some((r) => r.notRecommended)).toBe(false);
    expect(ordered.some((r) => r.backendId === 'brightdata')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/providers.test.ts`
Expected: FAIL — `diversityOrder` is not exported, and `indexId` is undefined on every recommendation.

- [ ] **Step 3: Add `indexId` to the interface and to every entry**

In `src/engine/providers.ts`, add to `interface Recommendation`:

```ts
  /**
   * Which underlying index this provider's entry method actually queries.
   *
   * Exists because array order in RECOMMENDATIONS ranks by BEST VALUE, which
   * is the wrong axis for a fan-out: several `search` providers resell the
   * same Google SERP, so taking the declared top 5 can buy the same index
   * three times. `diversityOrder` uses this to spend each additional call on
   * a source the round has not queried yet.
   *
   * The value is a free-form stable key, not an enum: it names a real index
   * (`'you'`, `'exa'`, `'brave'`) or a shared upstream (`'google-serp'`).
   * Two providers sharing a value is the whole point of the field.
   */
  indexId: string;
```

Then add `indexId` to every entry in `RECOMMENDATIONS`. Values, by backend:

| backendId | indexId |
|---|---|
| `you` | `'you'` |
| `exa` | `'exa'` |
| `brave` | `'brave'` |
| `firecrawl` | `'firecrawl'` |
| `geonode` | `'geonode'` |
| `scrapingdog` | `'google-serp'` |
| `scraperapi` | `'google-serp'` |
| `scrapingbee` | `'google-serp'` |
| `brightdata` | `'brightdata'` |
| `apify` | `'apify'` |
| `newsapi` | `'newsapi'` |
| `xro` | `'x'` |

Use the same value for a backend across every intent it appears in.

- [ ] **Step 4: Implement `diversityOrder`**

Append to `src/engine/providers.ts`:

```ts
/**
 * The declared ranking for `intent`, re-ordered so each successive provider
 * queries an index the round has not used yet, then truncated to `limit`.
 *
 * Value rank still decides WITHIN an index (the first-declared provider of a
 * given `indexId` is the one that represents it); diversity only decides
 * BETWEEN indexes. Passing a `limit` at or above the number of declared
 * providers therefore returns a permutation of the declared list, never a
 * truncation of it -- a fan-out wide enough to ask everyone still asks
 * everyone.
 *
 * Deny-listed and `notRecommended` providers are dropped before ordering, the
 * same rule `buildWalk` applies: a provider assessed and advised against is
 * not a breadth opportunity.
 */
export function diversityOrder(intent: Intent, limit: number, excluded: readonly string[]): Recommendation[] {
  const eligible = recommendationsFor(intent).filter(
    (rec) => rec.notRecommended === undefined && !isExcluded(rec.backendId, excluded),
  );
  const byIndex = new Map<string, Recommendation[]>();
  for (const rec of eligible) {
    const list = byIndex.get(rec.indexId);
    if (list) list.push(rec);
    else byIndex.set(rec.indexId, [rec]);
  }
  // Round-robin across index buckets, each bucket already in declared order.
  // Insertion order of `byIndex` is the declared order of each index's FIRST
  // provider, so the first pass visits indexes best-declared-first.
  const ordered: Recommendation[] = [];
  let round = 0;
  while (ordered.length < eligible.length) {
    let addedThisRound = false;
    for (const bucket of byIndex.values()) {
      const next = bucket[round];
      if (next !== undefined) {
        ordered.push(next);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
    round += 1;
  }
  return ordered.slice(0, Math.max(0, limit));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- tests/providers.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/providers.ts tests/providers.test.ts
git commit -m "feat: declare index diversity on provider recommendations"
```

Also `git add dist/fezoctl.mjs skills/fezo/scripts/fezoctl.mjs` after
`pnpm bundle`: `skill_contract.test.ts` gates the bundles as byte-identical to a
fresh build of `src/`, so any change under `src/engine/` fails the suite until
they are regenerated in the same commit.

**Deviations recorded during implementation.**

1. *`indexId` is per row, not per backend.* Step 3 asked for "the same value for
   a backend across every intent it appears in", and the table above pins
   `firecrawl -> 'firecrawl'` and `geonode -> 'geonode'`. Both are wrong for the
   `search` rows, and the spec says so directly (§ Fan-out policy: "several
   `search` entries resell the same Google SERP, so ranks 4-5 can return what
   ranks 1-3 already did" — `search` ranks 4-5 *are* `firecrawl` and `geonode`).
   `firecrawl_search` runs a Google query and scrapes the SERP into markdown;
   `geonode_search` is a SERP scrape over a proxy floor. Neither publishes an
   index. So both `search` rows are `'google-serp'`, and the `scrape`/`crawl`/
   `proxy` rows keep their own values, because `firecrawl_scrape` fetches the
   URL the *caller* named and shares nothing with anyone. A single per-backend
   value would have to lie about one row or the other. What replaces Step 3's
   invariant: rows declaring the same `entryMethods` must declare the same
   `indexId` (tested), plus the full `(intent, backendId) -> indexId` map pinned
   as a literal in `tests/providers.test.ts` so a change to a shared index has
   to be made deliberately in two places.
2. *Step 4's round-robin deliberately supersedes the spec's "then continues down
   the declared order for the remainder".* See the WHY comment on the loop and
   the amended spec paragraph: because `limit` truncates, the property worth
   having is that every prefix is maximally index-diverse, which the spec's rule
   gives up as soon as two indexes each have two or more providers.
3. *The ordering step is exported as `orderByIndexDiversity(recs, limit)` and
   `diversityOrder` delegates to it.* On the shipped table the reordering is
   unobservable — every repeated `indexId` sits at the tail of its own list, so
   diversity order equals declared order for every intent, every deny-list and
   every limit (verified by exhaustive enumeration, and pinned by a
   characterization test). That is a property of the ranking, not of the
   algorithm, but it leaves the loop with no coverage through an intent-only
   signature. The pure function is tested directly on synthetic lists.

---

### Task 2: The plan contract

**Files:**
- Create: `src/engine/plan.ts`
- Test: `tests/plan.test.ts`

**Interfaces:**
- Consumes: `Intent`, `INTENTS` from `intent.ts`; `newSchemaCompiler` from `ajv-instance.ts`.
- Produces: `RoutingPlan`, `PlanDepth`, `Planner`, `PlanOverrides`, `DEPTH_FANOUT`, `MAX_FANOUT`, `MAX_RESEARCH_CALLS`, `PLAN_SCHEMA`, `parsePlanJson(raw: unknown): RoutingPlan`, `mergePlan(base: RoutingPlan, overrides: PlanOverrides): RoutingPlan`, `clampPlan(plan: RoutingPlan): RoutingPlan`.

- [ ] **Step 1: Write the failing test**

Create `tests/plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { DEPTH_FANOUT, MAX_FANOUT, clampPlan, mergePlan, parsePlanJson } from '../src/engine/plan.js';
import type { RoutingPlan } from '../src/engine/plan.js';

function plan(overrides: Partial<RoutingPlan> = {}): RoutingPlan {
  return {
    intents: ['search'],
    queries: ['coffee'],
    targets: [],
    depth: 'standard',
    fanout: DEPTH_FANOUT.standard,
    signals: [],
    source: 'heuristic',
    ...overrides,
  };
}

describe('mergePlan', () => {
  it('lets a caller override one field and inherit the rest', () => {
    const merged = mergePlan(plan(), { fanout: 9 });
    expect(merged.fanout).toBe(9);
    expect(merged.queries).toEqual(['coffee']);
    expect(merged.source).toBe('flags');
  });

  it('marks a whole-plan override as caller-sourced', () => {
    const merged = mergePlan(plan(), { plan: plan({ queries: ['tea'], source: 'heuristic' }) });
    expect(merged.queries).toEqual(['tea']);
    expect(merged.source).toBe('caller');
  });

  it('applies flags on top of a whole-plan override', () => {
    const merged = mergePlan(plan(), { plan: plan({ fanout: 2 }), fanout: 7 });
    expect(merged.fanout).toBe(7);
  });

  it('returns the base untouched when there are no overrides', () => {
    expect(mergePlan(plan(), {})).toEqual(plan());
  });
});

describe('parsePlanJson', () => {
  it('accepts a well-formed plan', () => {
    expect(parsePlanJson({ intents: ['search'], queries: ['x'], depth: 'research', fanout: 8 }).depth).toBe('research');
  });

  it('rejects an unknown intent', () => {
    expect(() => parsePlanJson({ intents: ['telepathy'], queries: ['x'] })).toThrow(/intent/i);
  });

  it('rejects a non-object', () => {
    expect(() => parsePlanJson('nope')).toThrow();
  });

  it('rejects an unknown top-level key', () => {
    expect(() => parsePlanJson({ intents: ['search'], queries: ['x'], nonsense: 1 })).toThrow();
  });
});

describe('clampPlan', () => {
  it('caps fanout at MAX_FANOUT', () => {
    expect(clampPlan(plan({ fanout: 99 })).fanout).toBe(MAX_FANOUT);
  });

  it('floors fanout at 1', () => {
    expect(clampPlan(plan({ fanout: 0 })).fanout).toBe(1);
  });

  it('drops empty and duplicate queries', () => {
    expect(clampPlan(plan({ queries: ['a', '  ', 'a', 'b'] })).queries).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/plan.test.ts`
Expected: FAIL — cannot resolve `../src/engine/plan.js`.

- [ ] **Step 3: Implement `src/engine/plan.ts`**

```ts
// The seam between understanding a prompt and executing a fan-out.
//
// Everything downstream of this module (research.ts, aggregate.ts, render.ts)
// consumes a `RoutingPlan` and never holds a reference to a `Planner`. That is
// the whole point of the split: swapping the heuristic planner for an LLM one
// later is a new file plus one `resolvePlanner` case, with no change to the
// executor, the aggregator, or any of their tests.

import type { Intent } from './intent.js';
import { INTENTS } from './intent.js';
import { newSchemaCompiler } from './ajv-instance.js';

export type PlanDepth = 'shallow' | 'standard' | 'research';

/** How many providers one query is fanned out to, per depth. Deliberately
 * small numbers: every provider in the width is a billed call per query. */
export const DEPTH_FANOUT: Record<PlanDepth, number> = { shallow: 2, standard: 4, research: 8 };
Object.freeze(DEPTH_FANOUT);

/** Absolute ceiling on one round's width, whatever a caller asks for. */
export const MAX_FANOUT = 10;

/** Absolute ceiling on one round's billed calls (`queries * fanout + targets`). */
export const MAX_RESEARCH_CALLS = 24;

export interface RoutingPlan {
  intents: Intent[];
  queries: string[];
  targets: string[];
  depth: PlanDepth;
  fanout: number;
  /** Why the planner decided what it did. ADVISORY ONLY: rendered for humans
   * and agents, never parsed by anything downstream. Nothing may branch on it. */
  signals: string[];
  source: 'heuristic' | 'flags' | 'caller' | 'llm';
}

/** A planner turns a prompt into a plan. The heuristic one is the only
 * implementation that ships; see this module's header. */
export interface Planner {
  readonly id: RoutingPlan['source'];
  plan(prompt: string): RoutingPlan;
}

/** Field-wise overrides, in the precedence `mergePlan` implements. */
export interface PlanOverrides {
  /** A whole plan supplied by the caller (`--plan-json`). Applied first. */
  plan?: RoutingPlan;
  intents?: Intent[];
  queries?: string[];
  targets?: string[];
  depth?: PlanDepth;
  fanout?: number;
}

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    intents: { type: 'array', items: { type: 'string', enum: INTENTS } },
    queries: { type: 'array', items: { type: 'string' } },
    targets: { type: 'array', items: { type: 'string' } },
    depth: { type: 'string', enum: ['shallow', 'standard', 'research'] },
    fanout: { type: 'integer', minimum: 1 },
    signals: { type: 'array', items: { type: 'string' } },
    source: { type: 'string', enum: ['heuristic', 'flags', 'caller', 'llm'] },
  },
  // Closed on purpose: a typo'd key in a hand-written --plan-json must fail
  // loudly at parse time rather than being silently ignored and producing a
  // round the caller did not ask for -- and paid for.
  additionalProperties: false,
} as const;

const validatePlanSchema = newSchemaCompiler().compile(PLAN_SCHEMA);

/**
 * Validates and completes a caller-supplied plan fragment.
 *
 * Throws on anything invalid, and the caller (cli.ts) turns that into exit
 * code 1 during argv parsing -- before any candidate is selected or billed,
 * the same contract `--args-json` already follows.
 */
export function parsePlanJson(raw: unknown): RoutingPlan {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('--plan-json must be a JSON object');
  }
  if (!validatePlanSchema(raw)) {
    const first = validatePlanSchema.errors?.[0];
    const where = first?.instancePath !== undefined && first.instancePath !== '' ? first.instancePath : 'plan';
    throw new Error(`--plan-json is not a valid plan: ${where} ${first?.message ?? 'failed validation'}`);
  }
  const partial = raw as Partial<RoutingPlan>;
  const depth = partial.depth ?? 'standard';
  return {
    intents: partial.intents ?? ['search'],
    queries: partial.queries ?? [],
    targets: partial.targets ?? [],
    depth,
    fanout: partial.fanout ?? DEPTH_FANOUT[depth],
    signals: partial.signals ?? [],
    source: 'caller',
  };
}

/**
 * Applies overrides in precedence order: whole plan, then individual flags.
 *
 * `source` records who actually won, so an output document always says where
 * its routing came from -- a misroute is otherwise indistinguishable from a
 * bad heuristic.
 */
export function mergePlan(base: RoutingPlan, overrides: PlanOverrides): RoutingPlan {
  let out: RoutingPlan = overrides.plan !== undefined ? { ...overrides.plan, source: 'caller' } : base;
  const flagged =
    overrides.intents !== undefined ||
    overrides.queries !== undefined ||
    overrides.targets !== undefined ||
    overrides.depth !== undefined ||
    overrides.fanout !== undefined;
  if (!flagged) return out;
  const depth = overrides.depth ?? out.depth;
  out = {
    ...out,
    intents: overrides.intents ?? out.intents,
    queries: overrides.queries ?? out.queries,
    targets: overrides.targets ?? out.targets,
    depth,
    // A depth flag with no explicit fanout re-derives the width, so
    // `--depth research` widens the round the way a caller expects.
    fanout: overrides.fanout ?? (overrides.depth !== undefined ? DEPTH_FANOUT[depth] : out.fanout),
    source: 'flags',
  };
  return out;
}

/** Enforces the hard bounds and removes degenerate input. Applied after every
 * merge, so no path -- planner, flags, or caller JSON -- can exceed a cap. */
export function clampPlan(plan: RoutingPlan): RoutingPlan {
  const dedupe = (values: readonly string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed === '' || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  };
  return {
    ...plan,
    intents: [...new Set(plan.intents)],
    queries: dedupe(plan.queries),
    targets: dedupe(plan.targets),
    fanout: Math.min(MAX_FANOUT, Math.max(1, Math.trunc(plan.fanout))),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/plan.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/plan.ts tests/plan.test.ts
git commit -m "feat: add the routing plan contract"
```

**Deviations recorded during implementation.**

1. *The spec's precedence chain is inverted: explicit flags beat `--plan-json`,
   not the other way round.* Step 3's `mergePlan` applies `overrides.plan`
   first and then lets the individual flags overwrite fields on top of it, which
   is the opposite of the spec's original `--plan-json (whole plan) > explicit
   flags > planner output`. The code is kept and the spec paragraph amended,
   because a flag is the more specific instruction typed on the same command
   line: under the spec's order, `--plan-json '{"fanout":2}' --depth research`
   would silently ignore `--depth`, and there would be no way to correct one
   field of a stored plan without editing the JSON. The amended paragraph is in
   the spec under `RoutingPlan`; `mergePlan`'s docstring and
   `PlanOverrides`'s state the direction unambiguously, and
   `tests/plan.test.ts`'s 'applies flags on top of a whole-plan override' pins
   it.
2. *`--plan-json` replaces the plan wholesale, and a fragment with nothing to do
   is now rejected.* The spec says overrides are "merged field-wise so a caller
   can correct one field and inherit the rest"; that holds for the flags, but
   not for `--plan-json`, because `parsePlanJson` fills every absent field from
   defaults and `mergePlan` substitutes the completed object for the whole base
   plan. `--plan-json '{"depth":"research"}'` would therefore wipe the
   heuristic's queries and yield zero lanes, an empty document and exit 0 --
   a round the caller did not ask for, which is the same failure the closed
   schema exists to prevent, only quieter. Step 3's `parsePlanJson` gains a
   final check: a plan with neither `queries` nor `targets` throws, and the
   message names the replace-not-merge semantics because that is the
   misunderstanding it catches. Exit 1 during argv parsing, as before, so
   nothing is billed. Making `--plan-json` genuinely field-wise instead would
   mean carrying a `Partial<RoutingPlan>` through the merge and was rejected as
   out of scope for this task.
3. *Four hardening fixes on top of Step 3's block, all keeping its behaviour on
   the paths that already worked.* (a) `parsePlanJson` renders errors with
   `schema.ts`'s exported `ajvErrorsToText` instead of hand-rolling the first
   error, so the `allErrors: true` that `ajv-instance.ts` argues for actually
   reaches the caller. (b) `PLAN_SCHEMA` is frozen down to its nested property
   schemas, matching `providers.ts` and `intent.ts`: the validator is compiled
   once at module load, so a mutation would leave the exported constant
   advertising a contract nothing enforces. (c) `clampPlan` falls back to the
   depth's declared width for a non-finite fanout -- `Math.trunc(NaN)` survives
   both bounds, and a NaN fanout would make `queries.length * fanout` NaN and
   defeat Task 9's `MAX_RESEARCH_CALLS` accounting. (d) `mergePlan` and
   `clampPlan` never return an object (or a `signals` array) aliased to their
   input, so downstream rendering can annotate the plan it is handed without
   reaching back into the planner's own.

---

### Task 3: The heuristic planner

**Files:**
- Create: `src/engine/planners/heuristic.ts`
- Test: `tests/heuristic-planner.test.ts`

**Interfaces:**
- Consumes: `RoutingPlan`, `Planner`, `PlanDepth`, `DEPTH_FANOUT` from `plan.js`; `Intent` from `intent.js`.
- Produces: `export const heuristicPlanner: Planner`; `export function resolvePlanner(id: string): Planner`.

- [ ] **Step 1: Write the failing test**

Create `tests/heuristic-planner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { heuristicPlanner, resolvePlanner } from '../src/engine/planners/heuristic.js';

const plan = (prompt: string) => heuristicPlanner.plan(prompt);

describe('heuristicPlanner: intent', () => {
  it('routes a literal URL to scrape and records it as a target', () => {
    const p = plan('summarise https://example.com/pricing');
    expect(p.intents).toContain('scrape');
    expect(p.targets).toEqual(['https://example.com/pricing']);
  });

  it('routes a bare question to search', () => {
    expect(plan('what is a merkle tree').intents).toEqual(['search']);
  });

  it('adds news for a recency cue', () => {
    expect(plan('latest coverage of the EU AI Act').intents).toContain('news');
  });

  it('keeps both intents when a prompt has a URL and a question', () => {
    const p = plan('what does https://example.com say about pricing');
    expect(p.intents).toEqual(expect.arrayContaining(['search', 'scrape']));
  });

  it('carries the prompt through as the query when there is no URL', () => {
    expect(plan('best rust web frameworks').queries).toEqual(['best rust web frameworks']);
  });

  it('does not make a query out of a pure-URL prompt', () => {
    expect(plan('https://example.com').queries).toEqual([]);
  });
});

describe('heuristicPlanner: depth', () => {
  it('is research when the prompt says so', () => {
    const p = plan('do comprehensive research on solid-state batteries');
    expect(p.depth).toBe('research');
    expect(p.fanout).toBe(8);
  });

  it('is shallow for a bare lookup', () => {
    expect(plan('rust release date').depth).toBe('shallow');
  });

  it('is standard for an ordinary question', () => {
    expect(plan('how does the borrow checker handle closures in practice').depth).toBe('standard');
  });
});

describe('heuristicPlanner: transparency', () => {
  it('records a signal for every decision it made', () => {
    expect(plan('latest news about https://example.com').signals.length).toBeGreaterThan(0);
  });

  it('always reports itself as the source', () => {
    expect(plan('anything').source).toBe('heuristic');
  });
});

describe('resolvePlanner', () => {
  it('returns the heuristic planner by default', () => {
    expect(resolvePlanner('heuristic').id).toBe('heuristic');
  });

  it('rejects an unknown planner by name', () => {
    expect(() => resolvePlanner('psychic')).toThrow(/unknown planner/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/heuristic-planner.test.ts`
Expected: FAIL — cannot resolve `../src/engine/planners/heuristic.js`.

- [ ] **Step 3: Implement `src/engine/planners/heuristic.ts`**

```ts
// The default planner: a deterministic, network-free, credential-free reading
// of one prompt string.
//
// WHAT THIS IS NOT: comprehension. It cannot decompose a research question into
// sub-queries, resolve "their pricing page" against a previous conversational
// turn, or know that "papers citing Vaswani et al." means an academic corpus.
// Those need the conversation and a model, and the caller -- an agent -- has
// both. This module's job is to be a DETERMINISTIC FLOOR: guarantee that a
// headless `fezoctl research "..."` does something sane, and make every
// decision it did make visible in `signals` so a better-informed caller knows
// exactly what to override.

import type { Intent } from '../intent.js';
import { DEPTH_FANOUT } from '../plan.js';
import type { PlanDepth, Planner, RoutingPlan } from '../plan.js';

/** Absolute URLs. Deliberately http(s)-only: a bare `example.com` is far more
 * often a topic than a fetch target, and guessing wrong spends a call on the
 * wrong intent. */
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

/** Words that mean "recent", which is what distinguishes a `news` fan-out from
 * a plain `search` one. Matched as whole words. */
const RECENCY_WORDS = new Set([
  'latest', 'recent', 'current', 'currently', 'today', 'yesterday', 'now',
  'breaking', 'news', 'update', 'updates', 'this week', 'this month',
]);

/** Phrases that ask, unambiguously, for breadth. Matched as substrings because
 * they are long enough not to collide with ordinary prose. */
const RESEARCH_PHRASES = [
  'deep research', 'comprehensive', 'in depth', 'in-depth', 'thorough',
  'everything about', 'all sources', 'as much as possible', 'exhaustive',
  'literature', 'survey of', 'research on', 'research about',
];

/** Openers that mark a prompt as a question rather than a lookup. */
const QUESTION_WORDS = new Set(['what', 'why', 'how', 'when', 'where', 'who', 'which', 'is', 'are', 'does', 'do', 'can', 'should']);

/** Verbs that ask for retrieval even without a question form. */
const SEARCH_VERBS = new Set(['find', 'search', 'compare', 'list', 'research', 'investigate', 'analyse', 'analyze', 'gather']);

function words(prompt: string): string[] {
  return prompt.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== '');
}

function looksLikeYear(word: string): boolean {
  return /^(19|20)\d{2}$/.test(word);
}

function pickDepth(prompt: string, tokens: readonly string[], signals: string[]): PlanDepth {
  const lower = prompt.toLowerCase();
  for (const phrase of RESEARCH_PHRASES) {
    if (lower.includes(phrase)) {
      signals.push(`research-phrase:${phrase}`);
      return 'research';
    }
  }
  // A long prompt, or one joining several clauses, is asking for more than a
  // lookup. A short one is not. This is a proxy for effort, and a weak one --
  // which is exactly why `signals` says so and `--depth` overrides it.
  if (tokens.length >= 12) {
    signals.push(`long-prompt:${String(tokens.length)}-tokens`);
    return 'standard';
  }
  if (tokens.length <= 4) {
    signals.push(`short-prompt:${String(tokens.length)}-tokens`);
    return 'shallow';
  }
  const isQuestion = tokens[0] !== undefined && QUESTION_WORDS.has(tokens[0]);
  if (isQuestion) {
    signals.push('question-form');
    return 'standard';
  }
  signals.push('default-depth');
  return 'shallow';
}

export const heuristicPlanner: Planner = {
  id: 'heuristic',
  plan(prompt: string): RoutingPlan {
    const signals: string[] = [];
    const intents: Intent[] = [];

    const targets = [...prompt.matchAll(URL_PATTERN)].map((m) => m[0]);
    if (targets.length > 0) {
      intents.push('scrape');
      signals.push(`url-literal:${String(targets.length)}`);
    }

    // The prompt minus its URLs: what is left is what a search would be for.
    const residual = prompt.replace(URL_PATTERN, ' ').trim();
    const tokens = words(residual);
    const hasQuestion = tokens[0] !== undefined && QUESTION_WORDS.has(tokens[0]);
    const hasSearchVerb = tokens.some((t) => SEARCH_VERBS.has(t));
    // Residual prose alongside a URL still means a search: "what does <url> say
    // about X" wants both the page and the topic.
    const wantsSearch = targets.length === 0 || hasQuestion || hasSearchVerb || tokens.length >= 4;
    if (wantsSearch && tokens.length > 0) {
      intents.push('search');
      if (hasQuestion) signals.push('question-form');
      if (hasSearchVerb) signals.push('search-verb');
    }

    const hasRecency = tokens.some((t) => RECENCY_WORDS.has(t) || looksLikeYear(t));
    if (hasRecency && intents.includes('search')) {
      intents.push('news');
      signals.push('recency-cue');
    }

    // Fail safe rather than empty: a prompt that matched nothing at all is
    // still a search, because returning "no intent" would make the command do
    // nothing for input a human plainly meant as a query.
    if (intents.length === 0) {
      intents.push('search');
      signals.push('fallback:no-signal');
    }

    const depth = pickDepth(residual, tokens, signals);
    const queries = intents.includes('search') && residual !== '' ? [residual] : [];
    if (queries.length === 0 && targets.length > 0) signals.push('targets-only');
    // Stated plainly, because it is the single most important limitation of
    // this planner and the reason an agent should override it for research.
    if (depth === 'research' && queries.length <= 1) {
      signals.push('no-decomposition: heuristic cannot split this into sub-queries; supply --queries');
    }

    return { intents, queries, targets, depth, fanout: DEPTH_FANOUT[depth], signals, source: 'heuristic' };
  },
};

/** Planner lookup by name. The LLM planner, if it is ever built, is one more
 * case here and one more file -- nothing downstream changes. */
export function resolvePlanner(id: string): Planner {
  if (id === 'heuristic') return heuristicPlanner;
  throw new Error(`unknown planner "${id}"`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/heuristic-planner.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/planners/heuristic.ts tests/heuristic-planner.test.ts
git commit -m "feat: add the deterministic heuristic planner"
```

**Deviations recorded during implementation.**

1. *`targets` strip trailing sentence punctuation.* Step 3's `URL_PATTERN`
   excludes closing brackets and quotes but not `.`/`,`/`;`, so
   `see https://example.com/a. and also https://example.com/b,` produced the
   targets `https://example.com/a.` and `https://example.com/b,`. Nothing
   downstream repairs that: Task 4's `canonicalizeUrl` runs on sniffed *result*
   items, not on `plan.targets`, and Task 10 passes each target verbatim into
   the scrape provider's `argName`. The consequence is a billed fetch of a URL
   the user never wrote, reported afterwards as a coverage gap. Each match is
   now put through `TRAILING_PUNCTUATION` (`/[.,;:!?'"]+$/`) before it becomes a
   target; the two rows above are pinned in the test table.
2. *Multi-word recency cues moved out of `RECENCY_WORDS` into
   `RECENCY_PHRASES`.* Step 3 put `'this week'` and `'this month'` in a Set that
   is only ever tested against `words()` output, which splits on a non-word
   class and so can never yield a token containing a space -- both entries were
   unreachable, while the table's own comment ("Matched as whole words") read as
   if phrases worked. `what happened this week in AI` got `search` and no
   `news`. The two entries (plus `'this year'`, for symmetry) are now a frozen
   `RECENCY_PHRASES` array checked with `includes` against the lowercased
   residual, alongside the token check, and the prompt is a table row.
3. *`'literature'` replaced by `'literature review'` and `'literature survey'`
   in `RESEARCH_PHRASES`.* The table's comment justifies substring matching by
   the entries being "long enough not to collide with ordinary prose"; a bare
   common noun is not, and the collision is expensive in the one direction that
   matters -- `The Great Gatsby literature analysis` took depth `research`,
   fan-out 8, four times the lanes of the shallow lookup it is. Both the
   negative and the positive case are table rows.
4. *Three smaller corrections to Step 3's block.* (a) The depth stage pushes
   `depth:question-form` rather than a second `question-form`, because both
   stages read the same cue and `plan.ts` renders `signals` to a human as the
   explanation of the routing, where the same entry twice reads as a bug.
   (b) The residual collapses interior whitespace as well as trimming, so the
   hole a cut URL leaves does not travel into the provider's query argument --
   and so two logically identical queries cannot survive `clampPlan`'s dedupe,
   which trims but does not collapse. (c) `words()` splits on `/[^\p{L}\p{N}]+/u`
   instead of `/[^a-z0-9]+/`: the ASCII-only class discarded every non-Latin
   character, tokenizing a Chinese or Russian prompt to `[]`, which sent it down
   the `fallback:no-signal` path at depth `shallow` however long it was. The
   word tables stay English-only, so such a prompt still takes the fallback
   intent, but `pickDepth` now measures its length correctly.
5. *`RESEARCH_PHRASES` and `RECENCY_PHRASES` are frozen; the Sets are typed
   `ReadonlySet<string>`.* Global Constraints require declared tables to be
   frozen at module scope. `Object.freeze` on a `Set` does not stop `.add`, so
   the Sets follow `rank.ts:35`'s `STOP_WORDS` convention instead, which states
   the same intent through the type.
6. *The test file is table-driven, as the spec asks, and pins exact signal
   arrays.* Step 1's transparency test asserted only `signals.length > 0`, which
   would have caught none of the above. The intent and depth blocks are now one
   `it.each` table of prompt -> `{ intents, queries, targets, depth, fanout }`
   (the spec's § Testing "table-driven prompt -> plan"), and five separate cases
   assert the exact `signals` array, since a missing entry and a duplicated one
   are both defects in output whose entire job is to be read.
7. *`)` admitted into `URL_PATTERN` and unwound by a balanced-paren rule.*
   Step 3 excluded `)` from the character class outright, which truncated
   `.../wiki/Merkle_tree_(data_structure)` to `.../wiki/Merkle_tree_(data_structure`
   -- the same harm deviation 1 was written to close, since Task 10 passes each
   target verbatim to the scrape provider: a billed fetch of an address the
   user never wrote, reported afterwards as a coverage gap. Wikipedia- and
   MSDN-style parenthesised URLs are among the commonest a research prompt
   pastes. Unlike `>`/`"`/`'`/`]`, a closing paren is genuinely common inside
   an address, so no fixed character class can decide it; the match now admits
   `)` and `trimUrl` drops trailing ones only while the match holds more `)`
   than `(`, i.e. only when the paren closes something opened outside the URL.
   The stripper loops, because `(see https://example.com/a.)` ends in `)` (so
   `TRAILING_PUNCTUATION` does not fire) and ends in `.` once that paren goes.
   Four rows pin it: the parenthesised address kept whole, and
   `(https://example.com/a)` / `[the docs](https://example.com/docs)` still
   yielding the bare URL.
8. *`RECENCY_PHRASES` matched with a word boundary.* `lowerResidual.includes(phrase)`
   fired "this week" inside "this weekend" and "this year" inside "this
   yearbook", so `catalogue this yearbook of student photos please` took a
   `news` lane the user never asked for -- and the table's own comment
   ("already reads as a time reference in any sentence it appears in")
   justified the substring test on a premise those words disprove. The frozen
   phrase table is now compiled once into `RECENCY_PHRASE_PATTERNS`
   (`\bphrase\b`), which is what makes scanning the text safe; the "yearbook"
   prompt is a negative table row beside the positive "this week" one.
9. *The `fallback:no-signal` branch is pinned and explained.* It was the one
   untested path, and the only one that can emit a plan with neither queries
   nor targets -- which `parsePlanJson` rejects outright ("a plan needs at
   least one of them"), so the gap between what the planner may produce and
   what the caller path forbids was undocumented. It is intended: an empty
   prompt is Task 12's usage error (exit 1) to catch during argv parsing,
   before anything is billed, and throwing from the planner would put that
   check behind a planner call and deny a caller a plain "what would you do
   with this?". A whitespace-only row and an exact-signals case
   (`['fallback:no-signal', 'short-prompt:0-tokens']`) pin the behaviour, and
   the branch carries the rationale.

---

### Task 4: Response sniffing and URL canonicalization

**Files:**
- Create: `src/engine/aggregate.ts`
- Test: `tests/aggregate.test.ts`

**Interfaces:**
- Consumes: nothing from other new modules.
- Produces: `RawItem` (`{ url, title?, snippet?, publishedAt? }`), `export function canonicalizeUrl(url: string): string`, `export function sniffItems(body: unknown): RawItem[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/aggregate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { canonicalizeUrl, sniffItems } from '../src/engine/aggregate.js';

describe('canonicalizeUrl', () => {
  it('lowercases scheme and host but never the path', () => {
    expect(canonicalizeUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('strips a leading www.', () => {
    expect(canonicalizeUrl('https://www.example.com/a')).toBe('https://example.com/a');
  });

  it('drops the fragment', () => {
    expect(canonicalizeUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('removes tracking parameters and keeps the rest, sorted', () => {
    expect(canonicalizeUrl('https://example.com/a?utm_source=x&b=2&gclid=9&a=1')).toBe(
      'https://example.com/a?a=1&b=2',
    );
  });

  it('normalizes a bare trailing slash', () => {
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('returns an unparseable value unchanged rather than throwing', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
  });
});

describe('sniffItems', () => {
  it('finds the largest array of url-bearing objects', () => {
    const body = {
      meta: [{ url: 'https://a.example' }],
      results: [
        { url: 'https://one.example', title: 'One', description: 'first' },
        { url: 'https://two.example', title: 'Two', description: 'second' },
      ],
    };
    expect(sniffItems(body).map((i) => i.url)).toEqual(['https://one.example', 'https://two.example']);
  });

  it('maps alternative field names', () => {
    const body = { web: { items: [{ link: 'https://x.example', name: 'X', snippet: 'sn', date: '2026-01-01' }] } };
    expect(sniffItems(body)[0]).toEqual({
      url: 'https://x.example',
      title: 'X',
      snippet: 'sn',
      publishedAt: '2026-01-01',
    });
  });

  it('reads a top-level array', () => {
    expect(sniffItems([{ url: 'https://a.example' }]).length).toBe(1);
  });

  it('returns nothing for a body with no url-bearing array', () => {
    expect(sniffItems({ markdown: '# a page', status: 'ok' })).toEqual([]);
  });

  it('skips entries with no usable url', () => {
    expect(sniffItems([{ title: 'no url' }, { url: 'https://a.example' }]).length).toBe(1);
  });

  it('never throws on null or a scalar', () => {
    expect(sniffItems(null)).toEqual([]);
    expect(sniffItems(42)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/aggregate.test.ts`
Expected: FAIL — cannot resolve `../src/engine/aggregate.js`.

- [ ] **Step 3: Implement the first half of `src/engine/aggregate.ts`**

```ts
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
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  parsed.hash = '';
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.includes(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  parsed.search = '';
  for (const [key, value] of params) parsed.searchParams.append(key, value);
  let out = parsed.toString();
  // A bare trailing slash on the root path is not a different document.
  if (out.endsWith('/') && parsed.search === '' ) out = out.slice(0, -1);
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/aggregate.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/aggregate.ts tests/aggregate.test.ts
git commit -m "feat: add response sniffing and URL canonicalization"
```

---

### Task 5: Per-provider adapter overrides

**Files:**
- Modify: `src/engine/aggregate.ts`
- Test: `tests/aggregate.test.ts`

**Interfaces:**
- Consumes: `RawItem`, `sniffItems` from Task 4.
- Produces: `export type ResponseAdapter = (body: unknown) => RawItem[]`, `export const RESPONSE_ADAPTERS: Record<string, ResponseAdapter>`, `export function extractItems(tool: string, body: unknown): RawItem[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/aggregate.test.ts`:

```ts
import { RESPONSE_ADAPTERS, extractItems } from '../src/engine/aggregate.js';

describe('extractItems', () => {
  it('falls back to the sniffer when no adapter is registered', () => {
    expect(extractItems('unknown_tool', { results: [{ url: 'https://a.example' }] }).length).toBe(1);
  });

  it('prefers a registered adapter over the sniffer', () => {
    const original = RESPONSE_ADAPTERS['fake_tool'];
    RESPONSE_ADAPTERS['fake_tool'] = () => [{ url: 'https://from-adapter.example' }];
    try {
      const items = extractItems('fake_tool', { results: [{ url: 'https://from-sniffer.example' }] });
      expect(items).toEqual([{ url: 'https://from-adapter.example' }]);
    } finally {
      if (original === undefined) delete RESPONSE_ADAPTERS['fake_tool'];
      else RESPONSE_ADAPTERS['fake_tool'] = original;
    }
  });

  it('falls back to the sniffer when an adapter throws', () => {
    const original = RESPONSE_ADAPTERS['throwing_tool'];
    RESPONSE_ADAPTERS['throwing_tool'] = () => { throw new Error('bad shape'); };
    try {
      expect(extractItems('throwing_tool', { results: [{ url: 'https://a.example' }] }).length).toBe(1);
    } finally {
      if (original === undefined) delete RESPONSE_ADAPTERS['throwing_tool'];
      else RESPONSE_ADAPTERS['throwing_tool'] = original;
    }
  });

  it('returns nothing for a body neither path can read', () => {
    expect(extractItems('unknown_tool', { markdown: '# page' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/aggregate.test.ts`
Expected: FAIL — `extractItems` and `RESPONSE_ADAPTERS` are not exported.

- [ ] **Step 3: Implement the adapter layer**

Append to `src/engine/aggregate.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/aggregate.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/aggregate.ts tests/aggregate.test.ts
git commit -m "feat: add per-provider response adapter overrides"
```

---

### Task 6: Dedup and reciprocal rank fusion

**Files:**
- Modify: `src/engine/aggregate.ts`
- Test: `tests/aggregate.test.ts`

**Interfaces:**
- Consumes: `RawItem`, `canonicalizeUrl` from Task 4.
- Produces: `ProviderHit` (`{ backendId, rank, resultRank }`), `ResearchItem`, `LaneItems` (`{ backendId, rank, items }`), `RRF_K`, `export function mergeItems(lanes: readonly LaneItems[], seenUrls?: ReadonlySet<string>): { items: ResearchItem[]; suppressed: number }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/aggregate.test.ts`:

```ts
import { RRF_K, mergeItems } from '../src/engine/aggregate.js';
import type { LaneItems } from '../src/engine/aggregate.js';

function lane(backendId: string, rank: number, urls: Array<[string, string?]>): LaneItems {
  return { backendId, rank, items: urls.map(([url, title]) => ({ url, ...(title !== undefined ? { title } : {}) })) };
}

describe('mergeItems', () => {
  it('merges the same page found by two providers into one item', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://www.example.com/a?utm_source=x']]),
      lane('exa', 2, [['https://example.com/a']]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.providers.map((p) => p.backendId).sort()).toEqual(['exa', 'you']);
  });

  it('preserves every original URL on duplicates', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://www.example.com/a?utm_source=x']]),
      lane('exa', 2, [['https://example.com/a']]),
    ]);
    expect(items[0]?.duplicates).toContain('https://www.example.com/a?utm_source=x');
  });

  it('scores by reciprocal rank fusion', () => {
    const { items } = mergeItems([lane('you', 1, [['https://a.example']])]);
    expect(items[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it('ranks an item found by two providers above one found first by a single provider', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://solo.example'], ['https://shared.example']]),
      lane('exa', 2, [['https://shared.example']]),
    ]);
    expect(items[0]?.url).toBe('https://shared.example');
  });

  it('collapses a near-identical title across different hosts', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://outlet-a.example/story', 'Chip Maker Buys Rival!']]),
      lane('exa', 2, [['https://outlet-b.example/story', 'chip maker buys rival']]),
    ]);
    expect(items).toHaveLength(1);
  });

  it('does not collapse an identical title on the same host', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://one.example/a', 'Docs'], ['https://one.example/b', 'Docs']]),
    ]);
    expect(items).toHaveLength(2);
  });

  it('suppresses already-seen URLs and reports how many', () => {
    const { items, suppressed } = mergeItems(
      [lane('you', 1, [['https://old.example'], ['https://new.example']])],
      new Set(['https://old.example']),
    );
    expect(items.map((i) => i.url)).toEqual(['https://new.example']);
    expect(suppressed).toBe(1);
  });

  it('breaks score ties on canonical URL for determinism', () => {
    const a = mergeItems([lane('you', 1, [['https://b.example'], ['https://a.example']])]);
    const b = mergeItems([lane('you', 1, [['https://b.example'], ['https://a.example']])]);
    expect(a.items.map((i) => i.url)).toEqual(b.items.map((i) => i.url));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/aggregate.test.ts`
Expected: FAIL — `mergeItems` and `RRF_K` are not exported.

- [ ] **Step 3: Implement merging**

Append to `src/engine/aggregate.ts`:

```ts
/** Which provider contributed an item, and where it sat on that provider's own list. */
export interface ProviderHit {
  backendId: string;
  /** The provider's rank in the fan-out (diversity order position, 1-based). */
  rank: number;
  /** This item's 1-based position within that provider's own results. */
  resultRank: number;
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

/** Title reduced to a comparison key: case-folded, punctuation removed,
 * whitespace collapsed. Used only for the cross-host near-duplicate pass. */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
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
 *    listings), and merging those would destroy real results. This pass is a
 *    judgement call, which is why every collapsed URL survives on `duplicates`.
 *
 * `seenUrls` (canonical) are dropped entirely -- that is what makes a
 * multi-round research session return only new material instead of re-paying
 * for the same links.
 */
export function mergeItems(
  lanes: readonly LaneItems[],
  seenUrls: ReadonlySet<string> = new Set(),
): { items: ResearchItem[]; suppressed: number } {
  const byCanonical = new Map<string, ResearchItem>();
  let suppressed = 0;

  for (const lane of lanes) {
    lane.items.forEach((raw, index) => {
      const canonical = canonicalizeUrl(raw.url);
      if (seenUrls.has(canonical)) {
        suppressed += 1;
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
      existing.providers.push(hit);
      if (raw.url !== canonical && !existing.duplicates.includes(raw.url)) existing.duplicates.push(raw.url);
      // Keep the richest text: a provider that returned a snippet is more
      // useful than one that returned only a link, whichever arrived first.
      if (existing.snippet === undefined && raw.snippet !== undefined) existing.snippet = raw.snippet;
      if (existing.publishedAt === undefined && raw.publishedAt !== undefined) existing.publishedAt = raw.publishedAt;
    });
  }

  // Pass 2: cross-host title collapse.
  const byTitle = new Map<string, ResearchItem>();
  const merged: ResearchItem[] = [];
  for (const item of byCanonical.values()) {
    const key = item.title === item.url ? undefined : titleKey(item.title);
    const twin = key !== undefined ? byTitle.get(key) : undefined;
    if (twin !== undefined && hostOf(twin.url) !== hostOf(item.url)) {
      twin.providers.push(...item.providers);
      twin.duplicates.push(item.url, ...item.duplicates);
      if (twin.snippet === undefined && item.snippet !== undefined) twin.snippet = item.snippet;
      if (twin.publishedAt === undefined && item.publishedAt !== undefined) twin.publishedAt = item.publishedAt;
      continue;
    }
    if (key !== undefined && twin === undefined) byTitle.set(key, item);
    merged.push(item);
  }

  for (const item of merged) {
    item.score = item.providers.reduce((sum, hit) => sum + 1 / (RRF_K + hit.resultRank), 0);
  }
  merged.sort((a, b) => (b.score - a.score) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { items: merged, suppressed };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/aggregate.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/aggregate.ts tests/aggregate.test.ts
git commit -m "feat: dedup merged results and order them by reciprocal rank fusion"
```

---

### Task 7: Coverage and next actions

**Files:**
- Modify: `src/engine/aggregate.ts`
- Test: `tests/aggregate.test.ts`

**Interfaces:**
- Consumes: `ResearchItem`, `LaneItems` from Task 6.
- Produces: `QueryCoverage`, `Coverage`, `NextAction`, `CoverageInput`, `export function computeCoverage(input: CoverageInput): Coverage`, `export function nextActions(coverage: Coverage, sessionId: string | undefined): NextAction[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/aggregate.test.ts`:

```ts
import { computeCoverage, nextActions } from '../src/engine/aggregate.js';

const item = (url: string, providers: number) => ({
  url,
  title: url,
  providers: Array.from({ length: providers }, (_unused, i) => ({ backendId: `p${String(i)}`, rank: i + 1, resultRank: 1 })),
  score: 1,
  duplicates: [],
});

describe('computeCoverage', () => {
  it('reports unique URLs and median agreement per query', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 3), item('https://y.example', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.queries[0]?.uniqueUrls).toBe(2);
    expect(coverage.queries[0]?.agreementMedian).toBe(2);
  });

  it('flags a thin query as a gap', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/thin/i);
  });

  it('flags a zero-result query', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [] }],
      served: [], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/no results/i);
  });

  it('reports domain concentration', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://one.example/a', 1), item('https://one.example/b', 1), item('https://two.example/c', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.domainConcentration?.host).toBe('one.example');
    expect(coverage.domainConcentration?.share).toBeCloseTo(2 / 3, 5);
  });

  it('flags a retryable provider failure', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4)] }],
      served: ['you'], failed: [{ backendId: 'firecrawl', reason: 'rate_limited' }],
      skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/firecrawl/);
  });

  it('flags dropped queries so truncation is never silent', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: ['b'], unfetchedTargets: [], suppressed: 0,
    });
    expect(coverage.gaps.join(' ')).toMatch(/not run/i);
  });
});

describe('nextActions', () => {
  it('emits a runnable follow-up command carrying the session', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'thin one', items: [item('https://x.example', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    const actions = nextActions(coverage, 'r-42');
    expect(actions[0]?.cmd).toContain('--session r-42');
    expect(actions[0]?.cmd).toContain('fezoctl research');
  });

  it('omits the session flag when no session is in use', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'thin one', items: [item('https://x.example', 1)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(nextActions(coverage, undefined)[0]?.cmd).not.toContain('--session');
  });

  it('returns nothing when there are no gaps', () => {
    const coverage = computeCoverage({
      queries: [{ query: 'a', items: [item('https://x.example', 4), item('https://y.example', 3), item('https://z.example', 3)] }],
      served: ['you'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [], suppressed: 0,
    });
    expect(nextActions(coverage, undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/aggregate.test.ts`
Expected: FAIL — `computeCoverage` and `nextActions` are not exported.

- [ ] **Step 3: Implement coverage**

Append to `src/engine/aggregate.ts`:

```ts
/** Below this many unique URLs, a query is reported as thin. */
const THIN_QUERY_THRESHOLD = 3;

export interface QueryCoverage {
  query: string;
  uniqueUrls: number;
  /** Median number of providers that returned each item. 1 means no provider
   * corroborated any other -- weak coverage even when the count looks fine. */
  agreementMedian: number;
}

export interface Coverage {
  queries: QueryCoverage[];
  served: string[];
  failed: Array<{ backendId: string; reason: string }>;
  skipped: string[];
  domainConcentration?: { host: string; share: number };
  droppedQueries: string[];
  unfetchedTargets: string[];
  /** Results withheld because a session had already seen them. */
  suppressed: number;
  /** Machine-computed, human-readable. The agent's cue to spend another round. */
  gaps: string[];
}

export interface CoverageInput {
  queries: Array<{ query: string; items: readonly ResearchItem[] }>;
  served: string[];
  failed: Array<{ backendId: string; reason: string }>;
  skipped: string[];
  droppedQueries: string[];
  unfetchedTargets: string[];
  suppressed: number;
}

export interface NextAction {
  why: string;
  cmd: string;
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
      const host = hostOf(item.url);
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
  if (input.droppedQueries.length > 0) gaps.push(`not run (call budget): ${input.droppedQueries.join(', ')}`);
  // Deliberately not "call budget": this list carries both targets dropped on
  // the budget AND targets whose fetch failed, and a label naming only one
  // cause would misreport the other.
  if (input.unfetchedTargets.length > 0) gaps.push(`not fetched: ${input.unfetchedTargets.join(', ')}`);
  if (domainConcentration !== undefined && domainConcentration.share > 0.6 && total >= 5) {
    gaps.push(`${String(Math.round(domainConcentration.share * 100))}% of results are from ${domainConcentration.host}`);
  }

  return {
    queries,
    served: input.served,
    failed: input.failed,
    skipped: input.skipped,
    ...(domainConcentration !== undefined ? { domainConcentration } : {}),
    droppedQueries: input.droppedQueries,
    unfetchedTargets: input.unfetchedTargets,
    suppressed: input.suppressed,
    gaps,
  };
}

/**
 * Ready-to-run follow-up commands, one per actionable gap.
 *
 * Handing over the literal command is the point: an agent that has to compose
 * the follow-up itself will sometimes get the session flag wrong and re-pay for
 * links it already has.
 */
export function nextActions(coverage: Coverage, sessionId: string | undefined): NextAction[] {
  const session = sessionId !== undefined ? ` --session ${sessionId}` : '';
  const actions: NextAction[] = [];
  for (const q of coverage.queries) {
    if (q.uniqueUrls >= THIN_QUERY_THRESHOLD && q.agreementMedian > 1) continue;
    actions.push({
      why: q.uniqueUrls === 0 ? `"${q.query}" returned nothing` : `"${q.query}" is thin`,
      cmd: `fezoctl research "${q.query}" --depth research${session}`,
    });
  }
  for (const failure of coverage.failed) {
    actions.push({
      why: `${failure.backendId} failed (${failure.reason})`,
      cmd: `fezoctl providers --intent search`,
    });
  }
  for (const query of coverage.droppedQueries) {
    actions.push({ why: 'not run: call budget', cmd: `fezoctl research "${query}"${session}` });
  }
  for (const target of coverage.unfetchedTargets) {
    // `--session` is deliberately absent: `scrape` is a one-step command and
    // takes no session flag.
    actions.push({ why: 'not fetched', cmd: `fezoctl scrape ${target}` });
  }
  return actions;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/aggregate.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/aggregate.ts tests/aggregate.test.ts
git commit -m "feat: compute coverage gaps and runnable follow-up actions"
```

---

### Task 8: Session state

**Files:**
- Create: `src/engine/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: nothing from other new modules.
- Produces: `SessionState` (`{ id, seenUrls: string[], queries: string[], callsBilled: number }`), `export function sessionPath(id: string, env: Record<string, string | undefined>, home: string): string`, `export function validateSessionId(id: string): void`, `export function loadSession(id, env, home): SessionState`, `export function saveSession(state, env, home): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/session.test.ts`:

```ts
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadSession, saveSession, sessionPath, validateSessionId } from '../src/engine/session.js';

function scratch(): { env: Record<string, string | undefined>; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fezo-session-'));
  return { env: { XDG_CACHE_HOME: dir }, home: dir };
}

describe('validateSessionId', () => {
  it('accepts an ordinary id', () => {
    expect(() => validateSessionId('r-42_a.b')).not.toThrow();
  });

  it('rejects a path separator', () => {
    expect(() => validateSessionId('../escape')).toThrow(/session id/i);
  });

  it('rejects an empty id', () => {
    expect(() => validateSessionId('')).toThrow(/session id/i);
  });
});

describe('sessionPath', () => {
  it('honours XDG_CACHE_HOME', () => {
    expect(sessionPath('r-1', { XDG_CACHE_HOME: '/c' }, '/h')).toBe('/c/fezo/sessions/r-1.json');
  });

  it('falls back to ~/.cache', () => {
    expect(sessionPath('r-1', {}, '/h')).toBe('/h/.cache/fezo/sessions/r-1.json');
  });
});

describe('load/save', () => {
  it('returns an empty state for an unknown session', () => {
    const { env, home } = scratch();
    expect(loadSession('new', env, home)).toEqual({ id: 'new', seenUrls: [], queries: [], callsBilled: 0 });
  });

  it('round-trips state', () => {
    const { env, home } = scratch();
    saveSession({ id: 'r-1', seenUrls: ['https://a.example'], queries: ['q'], callsBilled: 3 }, env, home);
    expect(loadSession('r-1', env, home).seenUrls).toEqual(['https://a.example']);
  });

  it('writes the file 0600', () => {
    const { env, home } = scratch();
    saveSession({ id: 'r-1', seenUrls: [], queries: [], callsBilled: 0 }, env, home);
    expect(statSync(sessionPath('r-1', env, home)).mode & 0o777).toBe(0o600);
  });

  it('returns an empty state rather than throwing on a corrupt file', () => {
    const { env, home } = scratch();
    saveSession({ id: 'r-1', seenUrls: ['https://a.example'], queries: [], callsBilled: 0 }, env, home);
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(sessionPath('r-1', env, home), '{not json');
    expect(loadSession('r-1', env, home).seenUrls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/session.test.ts`
Expected: FAIL — cannot resolve `../src/engine/session.js`.

- [ ] **Step 3: Implement `src/engine/session.ts`**

```ts
// Cross-round state for a multi-round research run: which URLs this session has
// already returned, which queries it has already run, and how much it has
// billed.
//
// This is what makes round 5 as cheap as round 1: without it, every round
// re-returns (and the agent re-reads) the same links, and the cost of a
// research run grows quadratically in rounds rather than linearly.
//
// A CACHE, never a credential store: it holds URLs and query strings, no
// secrets. It still writes 0600 -- a research history is a record of what
// someone was investigating, which is not a thing to leave world-readable.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SessionState {
  id: string;
  /** Canonical URLs (aggregate.ts's `canonicalizeUrl` form) already returned. */
  seenUrls: string[];
  queries: string[];
  callsBilled: number;
}

/** The id becomes a filename, so it is validated as one -- no separators, no
 * traversal, no surprises. Rejected during argv parsing (exit 1). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function validateSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id) || id === '.' || id === '..') {
    throw new Error('session id must be 1-64 characters of letters, digits, dot, dash or underscore');
  }
}

export function sessionPath(id: string, env: Record<string, string | undefined>, home: string): string {
  const base = env['XDG_CACHE_HOME'] !== undefined && env['XDG_CACHE_HOME'] !== ''
    ? env['XDG_CACHE_HOME']
    : join(home, '.cache');
  return join(base, 'fezo', 'sessions', `${id}.json`);
}

/**
 * Reads a session, or an empty one if it does not exist or cannot be read.
 *
 * Never throws on a damaged file: a corrupt cache must degrade to "this round
 * suppresses nothing", not fail a round the caller is about to pay for.
 */
export function loadSession(id: string, env: Record<string, string | undefined>, home: string): SessionState {
  const empty: SessionState = { id, seenUrls: [], queries: [], callsBilled: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sessionPath(id, env, home), 'utf8'));
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const record = parsed as Partial<SessionState>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return {
    id,
    seenUrls: strings(record.seenUrls),
    queries: strings(record.queries),
    callsBilled: typeof record.callsBilled === 'number' ? record.callsBilled : 0,
  };
}

export function saveSession(state: SessionState, env: Record<string, string | undefined>, home: string): void {
  const path = sessionPath(state.id, env, home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/session.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/session.ts tests/session.test.ts
git commit -m "feat: add research session state"
```

---

### Task 9: The fan-out executor

**Files:**
- Create: `src/engine/research.ts`
- Test: `tests/research.test.ts`

**Interfaces:**
- Consumes: `RoutingPlan`, `MAX_RESEARCH_CALLS` from `plan.js`; `diversityOrder` from `providers.js`; `resolveArgName` from `one-step.js`; `run`, `ABORT_CODES`, `AttemptLog` from `retry.js`; `extractItems`, `mergeItems`, `computeCoverage`, `nextActions`, `canonicalizeUrl` from `aggregate.js`; `ToolCandidate` from `catalog.js`.
- Produces: `ResearchOptions`, `ResearchOutcome`, `RESEARCH_CONCURRENCY`, `export async function runResearch(options: ResearchOptions): Promise<ResearchOutcome>`, `export function seenUrlsFrom(outcome: ResearchOutcome): string[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/research.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import type { ToolCandidate } from '../src/engine/catalog.js';
import type { RoutingPlan } from '../src/engine/plan.js';
import { runResearch } from '../src/engine/research.js';

function candidate(backendId: string, method: string): ToolCandidate {
  return {
    tool: `${backendId}_${method}`,
    backendId,
    method,
    path: `/${method}`,
    protocol: 'http',
    httpMethod: 'POST',
    bindings: {},
    description: '',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    userSettings: [],
    backendInfoText: '',
    backendCategories: [],
    billingModel: 'per_call',
  };
}

/** Catalog covering the declared `search` entry methods used by the fan-out. */
const CANDIDATES: ToolCandidate[] = [
  candidate('you', 'search'),
  candidate('exa', 'search'),
  candidate('brave', 'search'),
  candidate('firecrawl', 'search'),
  candidate('geonode', 'search'),
];

function results(urls: string[]): Response {
  return new Response(JSON.stringify({ results: urls.map((url) => ({ url, title: url })) }), { status: 200 });
}

function routedFetch(handlers: Record<string, Response[]>): typeof fetch {
  const queues = new Map(Object.entries(handlers).map(([id, responses]) => [id, [...responses]]));
  return vi.fn(async (url: string | URL) => {
    const asString = String(url);
    for (const [backendId, queue] of queues) {
      if (asString.includes(`/v1/${backendId}/`)) {
        const next = queue.shift();
        if (next === undefined) throw new Error(`no queued response for ${backendId}`);
        return next;
      }
    }
    throw new Error(`unrouted request: ${asString}`);
  }) as unknown as typeof fetch;
}

function plan(overrides: Partial<RoutingPlan> = {}): RoutingPlan {
  return {
    intents: ['search'], queries: ['coffee'], targets: [], depth: 'standard',
    fanout: 3, signals: [], source: 'heuristic', ...overrides,
  };
}

const gateway = { baseUrl: 'https://gw.example', apiKey: 'k' };

describe('runResearch', () => {
  it('calls every provider in the fan-out width', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results(['https://b.example'])],
      brave: [results(['https://c.example'])],
    });
    const outcome = await runResearch({ plan: plan(), candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn } });
    expect(outcome.coverage.served.sort()).toEqual(['brave', 'exa', 'you']);
    expect(outcome.items).toHaveLength(3);
  });

  it('merges the same URL from two providers into one item', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://same.example'])],
      exa: [results(['https://same.example'])],
      brave: [results(['https://other.example'])],
    });
    const outcome = await runResearch({ plan: plan(), candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn } });
    expect(outcome.items[0]?.providers).toHaveLength(2);
  });

  it('succeeds when one lane fails and another serves', async () => {
    const fetchFn = routedFetch({
      you: [new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), { status: 429 })],
      exa: [results(['https://b.example'])],
      brave: [results(['https://c.example'])],
    });
    const outcome = await runResearch({ plan: plan(), candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn } });
    expect(outcome.ok).toBe(true);
    expect(outcome.coverage.failed.map((f) => f.backendId)).toContain('you');
  });

  it('fails when every lane fails', async () => {
    const fail = () => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'no' } }), { status: 429 });
    const fetchFn = routedFetch({ you: [fail()], exa: [fail()], brave: [fail()] });
    const outcome = await runResearch({ plan: plan(), candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn } });
    expect(outcome.ok).toBe(false);
  });

  it('stops starting lanes once an account-scoped abort is seen', async () => {
    const limit = () => new Response(JSON.stringify({ error: { code: 'limit_exceeded', message: 'cap' } }), { status: 402 });
    const fetchFn = routedFetch({ you: [limit()], exa: [limit()], brave: [limit()], firecrawl: [limit()], geonode: [limit()] });
    const outcome = await runResearch({
      plan: plan({ fanout: 5 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn }, concurrency: 1,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.aborted).toMatch(/limit_exceeded/);
    expect(outcome.billing.attempts.length).toBeLessThan(5);
  });

  it('reports dropped queries rather than silently truncating', async () => {
    const fetchFn = routedFetch({ you: [results(['https://a.example'])] });
    const outcome = await runResearch({
      plan: plan({ queries: ['one', 'two'], fanout: 1 }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn }, maxCalls: 1,
    });
    expect(outcome.coverage.droppedQueries).toEqual(['two']);
  });

  it('suppresses URLs a session has already seen', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://old.example', 'https://new.example'])],
      exa: [results([])],
      brave: [results([])],
    });
    const outcome = await runResearch({
      plan: plan(), candidates: CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
      seenUrls: new Set(['https://old.example']),
    });
    expect(outcome.items.map((i) => i.url)).toEqual(['https://new.example']);
    expect(outcome.coverage.suppressed).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/research.test.ts`
Expected: FAIL — cannot resolve `../src/engine/research.js`.

- [ ] **Step 3: Implement `src/engine/research.ts`**

```ts
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

import { canonicalizeUrl, computeCoverage, extractItems, mergeItems, nextActions } from './aggregate.js';
import type { Coverage, LaneItems, NextAction, ResearchItem } from './aggregate.js';
import type { ToolCandidate } from './catalog.js';
import { resolveArgName } from './one-step.js';
import { MAX_RESEARCH_CALLS } from './plan.js';
import type { RoutingPlan } from './plan.js';
import { diversityOrder } from './providers.js';
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
  coverage: Coverage;
  nextActions: NextAction[];
  billing: { callsBilled: number; attempts: AttemptLog[] };
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
): Lane[] {
  const byTool = new Map(candidates.map((c) => [c.tool, c]));
  const lanes: Lane[] = [];
  // Every search-shaped intent contributes providers; a `news` plan should
  // reach news providers as well as general search ones.
  const intents = plan.intents.filter((intent) => intent !== 'scrape' && intent !== 'crawl');
  const seenBackend = new Set<string>();
  for (const intent of intents.length > 0 ? intents : (['search'] as const)) {
    for (const rec of diversityOrder(intent, plan.fanout, excluded)) {
      if (seenBackend.has(rec.backendId)) continue;
      for (const entry of rec.entryMethods) {
        const candidate = byTool.get(entry);
        if (candidate === undefined) continue;
        const argName = resolveArgName(candidate.inputSchema, 'query');
        if (argName === undefined) continue;
        seenBackend.add(rec.backendId);
        lanes.push({ query, backendId: rec.backendId, rank: lanes.length + 1, candidate, argName });
        break;
      }
      if (lanes.length >= plan.fanout * (intents.length > 0 ? intents.length : 1)) break;
    }
  }
  return lanes.slice(0, plan.fanout);
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

export async function runResearch(options: ResearchOptions): Promise<ResearchOutcome> {
  const { plan, candidates, excluded, gateway } = options;
  const maxCalls = Math.min(options.maxCalls ?? MAX_RESEARCH_CALLS, MAX_RESEARCH_CALLS);
  const concurrency = options.concurrency ?? RESEARCH_CONCURRENCY;

  // Budget allocation, whole queries first: half of two queries' providers is
  // worse coverage than all of one query's, and a partially-run query reports
  // a "thin" gap that is really a budget artefact.
  const planned: Array<{ query: string; lanes: Lane[] }> = [];
  const droppedQueries: string[] = [];
  let budget = maxCalls;
  for (const query of plan.queries) {
    const lanes = lanesForQuery(query, plan, candidates, excluded);
    if (lanes.length === 0) { planned.push({ query, lanes: [] }); continue; }
    if (lanes.length > budget) { droppedQueries.push(query); continue; }
    budget -= lanes.length;
    planned.push({ query, lanes });
  }
  const unfetchedTargets = plan.targets.slice(Math.max(0, budget));

  const attempts: AttemptLog[] = [];
  const failed: Array<{ backendId: string; reason: string }> = [];
  const served = new Set<string>();
  const skipped: string[] = [];
  const laneItemsByQuery = new Map<string, LaneItems[]>();
  let aborted: string | undefined;

  const tasks = planned.flatMap(({ query, lanes }) =>
    lanes.map((lane) => async () => {
      // ONE candidate, ONE attempt: this lane is a single provider call. The
      // ranked-fallback behaviour of `run()` is deliberately not used here --
      // breadth across providers is the fan-out's job, and a lane that also
      // fell back would double-bill the same slot.
      const report = await run({
        baseUrl: gateway.baseUrl,
        apiKey: gateway.apiKey,
        candidates: [lane.candidate],
        args: { [lane.argName]: query },
        maxAttempts: 1,
        ...(gateway.fetchFn !== undefined ? { fetchFn: gateway.fetchFn } : {}),
      });
      attempts.push(...report.attempts);
      for (const attempt of report.attempts) {
        if (attempt.gatewayCode !== undefined && ABORT_CODES.has(attempt.gatewayCode)) {
          aborted ??= `${attempt.gatewayCode}: ${attempt.reason}`;
        }
      }
      if (report.outcome.kind !== 'success') {
        const last = report.attempts[report.attempts.length - 1];
        if (last?.preflight !== undefined) skipped.push(`${lane.backendId} (${last.preflight} rejected)`);
        else failed.push({ backendId: lane.backendId, reason: last?.gatewayCode ?? last?.reason ?? 'failed' });
        return;
      }
      served.add(lane.backendId);
      let body: unknown;
      try {
        body = JSON.parse(report.outcome.result.bodyText);
      } catch {
        // A billed 2xx that is not JSON yields no items but is still a served
        // lane -- reported, never silently counted as a failure.
        body = undefined;
      }
      const items = extractItems(lane.candidate.tool, body);
      const list = laneItemsByQuery.get(query) ?? [];
      list.push({ backendId: lane.backendId, rank: lane.rank, items });
      laneItemsByQuery.set(query, list);
    }),
  );

  await pool(tasks, concurrency, () => aborted !== undefined);

  const seen = options.seenUrls ?? new Set<string>();
  const perQuery: Array<{ query: string; items: ResearchItem[] }> = [];
  let suppressed = 0;
  for (const { query } of planned) {
    const merged = mergeItems(laneItemsByQuery.get(query) ?? [], seen);
    suppressed += merged.suppressed;
    perQuery.push({ query, items: merged.items });
  }
  // One set across queries: the same URL surfacing under two of a research
  // plan's sub-queries is one document, and the agent should read it once.
  const allLanes: LaneItems[] = perQuery.flatMap(({ items }, queryIndex) => [
    { backendId: `merged-${String(queryIndex)}`, rank: queryIndex + 1, items: items.map((i) => ({ url: i.url, ...(i.title !== i.url ? { title: i.title } : {}), ...(i.snippet !== undefined ? { snippet: i.snippet } : {}) })) },
  ]);
  const combined = mergeItems(allLanes, new Set());
  // Provider attribution comes from the per-query merge, which knows the real
  // backends; the cross-query pass only unions and re-scores.
  const attributionByUrl = new Map<string, ResearchItem>();
  for (const { items } of perQuery) {
    for (const item of items) {
      const existing = attributionByUrl.get(item.url);
      if (existing === undefined) attributionByUrl.set(item.url, item);
      else existing.providers.push(...item.providers);
    }
  }
  const items = combined.items.map((item) => attributionByUrl.get(item.url) ?? item);
  items.sort((a, b) => (b.score - a.score) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  const coverage = computeCoverage({
    queries: perQuery,
    served: [...served],
    failed,
    skipped,
    droppedQueries,
    unfetchedTargets,
    suppressed,
  });

  const callsBilled = attempts.filter((a) => a.billed).length;
  return {
    plan,
    ok: aborted === undefined && served.size > 0,
    ...(aborted !== undefined ? { aborted } : {}),
    items,
    coverage,
    nextActions: nextActions(coverage, options.sessionId),
    billing: { callsBilled, attempts },
  };
}

/** Canonical URLs this outcome returned, for a session to remember. */
export function seenUrlsFrom(outcome: ResearchOutcome): string[] {
  return outcome.items.map((item) => canonicalizeUrl(item.url));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/research.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/research.ts tests/research.test.ts
git commit -m "feat: add the parallel research fan-out executor"
```

---

### Task 10: Fetching plan targets

**Files:**
- Modify: `src/engine/research.ts`
- Test: `tests/research.test.ts`

**Interfaces:**
- Consumes: `ResearchOptions`, `ResearchOutcome` from Task 9; `diversityOrder` from `providers.js`; `resolveArgName`, `run` as already imported there.
- Produces: `ResearchDocument` (`{ url, backendId, content }`); `ResearchOutcome.documents: ResearchDocument[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/research.test.ts`:

```ts
const SCRAPE_CANDIDATES: ToolCandidate[] = [
  ...CANDIDATES,
  { ...candidate('scrapingdog', 'scrape'), inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { ...candidate('firecrawl', 'scrape'), inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];

describe('runResearch: targets', () => {
  it('fetches every planned target', async () => {
    const fetchFn = routedFetch({ scrapingdog: [new Response('{"content":"page body"}', { status: 200 })] });
    const outcome = await runResearch({
      plan: plan({ intents: ['scrape'], queries: [], targets: ['https://t.example'] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.documents).toHaveLength(1);
    expect(outcome.documents[0]?.url).toBe('https://t.example');
    expect(outcome.ok).toBe(true);
  });

  it('fetches a target once, not once per provider', async () => {
    const fetchFn = routedFetch({ scrapingdog: [new Response('{"content":"body"}', { status: 200 })] });
    const outcome = await runResearch({
      plan: plan({ intents: ['scrape'], queries: [], targets: ['https://t.example'], fanout: 5 }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.billing.attempts.filter((a) => a.billed)).toHaveLength(1);
  });

  it('reports a failed target as a gap rather than failing the round', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results([])],
      brave: [results([])],
      scrapingdog: [new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'no' } }), { status: 429 })],
      firecrawl: [new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'no' } }), { status: 429 })],
    });
    const outcome = await runResearch({
      plan: plan({ intents: ['search', 'scrape'], queries: ['coffee'], targets: ['https://t.example'] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.documents).toHaveLength(0);
    expect(outcome.coverage.gaps.join(' ')).toMatch(/t\.example/);
  });

  it('runs searches and target fetches in the same round', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://a.example'])],
      exa: [results(['https://b.example'])],
      brave: [results(['https://c.example'])],
      scrapingdog: [new Response('{"content":"body"}', { status: 200 })],
    });
    const outcome = await runResearch({
      plan: plan({ intents: ['search', 'scrape'], queries: ['coffee'], targets: ['https://t.example'] }),
      candidates: SCRAPE_CANDIDATES, excluded: [], gateway: { ...gateway, fetchFn },
    });
    expect(outcome.items.length).toBeGreaterThan(0);
    expect(outcome.documents).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/research.test.ts`
Expected: FAIL — `outcome.documents` is undefined.

- [ ] **Step 3: Implement target fetching**

In `src/engine/research.ts`, add the type and extend the outcome:

```ts
/** One fetched target page. */
export interface ResearchDocument {
  url: string;
  backendId: string;
  /** The provider's response body, verbatim. Truncation is the renderer's
   * decision, not this module's -- an executor that silently shortened a page
   * would make a scrape look complete when it is not. */
  content: string;
}
```

Add `documents: ResearchDocument[];` to `ResearchOutcome`.

Add the target lane builder, above `runResearch`:

```ts
/**
 * The single provider that will fetch `target`.
 *
 * ONE provider per target, not `fanout` of them: breadth is what a fan-out buys
 * for a QUERY, where each index returns a different set of links. A URL is one
 * document -- fetching it from five providers buys five copies of the same page
 * and bills five times. Fallback on failure is the one-step `scrape` command's
 * job, and the coverage gap points there.
 */
function scrapeLaneFor(
  target: string,
  candidates: readonly ToolCandidate[],
  excluded: readonly string[],
): { backendId: string; candidate: ToolCandidate; argName: string } | undefined {
  const byTool = new Map(candidates.map((c) => [c.tool, c]));
  for (const rec of diversityOrder('scrape', MAX_RESEARCH_CALLS, excluded)) {
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
```

Inside `runResearch`, declare the collectors next to the existing ones:

```ts
  const documents: ResearchDocument[] = [];
  const failedTargets: string[] = [];
```

Then build the target tasks and append them to `tasks` before the `pool` call:

```ts
  const targetTasks = plan.targets
    .filter((target) => !unfetchedTargets.includes(target))
    .map((target) => async () => {
      const lane = scrapeLaneFor(target, candidates, excluded);
      if (lane === undefined) {
        failedTargets.push(`${target} (no scrape provider available)`);
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
      attempts.push(...report.attempts);
      for (const attempt of report.attempts) {
        if (attempt.gatewayCode !== undefined && ABORT_CODES.has(attempt.gatewayCode)) {
          aborted ??= `${attempt.gatewayCode}: ${attempt.reason}`;
        }
      }
      if (report.outcome.kind !== 'success') {
        const last = report.attempts[report.attempts.length - 1];
        failedTargets.push(`${target} (${last?.gatewayCode ?? last?.reason ?? 'failed'})`);
        return;
      }
      served.add(lane.backendId);
      documents.push({ url: target, backendId: lane.backendId, content: report.outcome.result.bodyText });
    });
```

Change the pool call to run both kinds of work in the same round:

```ts
  await pool([...tasks, ...targetTasks], concurrency, () => aborted !== undefined);
```

Feed the failures into coverage — replace the `unfetchedTargets` argument in the
`computeCoverage` call with:

```ts
    unfetchedTargets: [...unfetchedTargets, ...failedTargets],
```

Include documents in the outcome, and count them toward success:

```ts
    ok: aborted === undefined && (served.size > 0 || documents.length > 0),
    documents,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/research.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/research.ts tests/research.test.ts
git commit -m "feat: fetch planned scrape targets in the same research round"
```

---

### Task 11: Rendering

**Files:**
- Modify: `src/engine/render.ts`
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: `RoutingPlan` from `plan.js`; `ResearchOutcome` from `research.js`.
- Produces: `export function renderPlan(plan: RoutingPlan, json: boolean): string`, `export function renderResearch(outcome: ResearchOutcome, sessionId: string | undefined, json: boolean): string`.

- [ ] **Step 1: Write the failing test**

Append to `tests/render.test.ts`:

```ts
import { renderPlan, renderResearch } from '../src/engine/render.js';
import type { RoutingPlan } from '../src/engine/plan.js';
import type { ResearchOutcome } from '../src/engine/research.js';

const PLAN: RoutingPlan = {
  intents: ['search'], queries: ['coffee'], targets: [], depth: 'standard',
  fanout: 4, signals: ['question-form'], source: 'heuristic',
};

const OUTCOME: ResearchOutcome = {
  plan: PLAN,
  ok: true,
  items: [{
    url: 'https://a.example', title: 'A', snippet: 'about a',
    providers: [{ backendId: 'you', rank: 1, resultRank: 1 }, { backendId: 'exa', rank: 2, resultRank: 3 }],
    score: 0.03, duplicates: [],
  }],
  documents: [{ url: 'https://t.example', backendId: 'scrapingdog', content: '{"content":"body"}' }],
  coverage: {
    queries: [{ query: 'coffee', uniqueUrls: 1, agreementMedian: 2 }],
    served: ['you', 'exa'], failed: [], skipped: [], droppedQueries: [], unfetchedTargets: [],
    suppressed: 0, gaps: ['"coffee" is thin (1 unique URLs)'],
  },
  nextActions: [{ why: '"coffee" is thin', cmd: 'fezoctl research "coffee" --depth research' }],
  billing: { callsBilled: 2, attempts: [] },
};

describe('renderPlan', () => {
  it('emits the plan as JSON under --json', () => {
    expect(JSON.parse(renderPlan(PLAN, true)).depth).toBe('standard');
  });

  it('names the signals in human output', () => {
    expect(renderPlan(PLAN, false)).toContain('question-form');
  });
});

describe('renderResearch', () => {
  it('emits a JSON document with every top-level section', () => {
    const doc = JSON.parse(renderResearch(OUTCOME, undefined, true));
    expect(Object.keys(doc).sort()).toEqual(['billing', 'coverage', 'documents', 'items', 'next_actions', 'ok', 'plan', 'session'].sort());
  });

  it('attributes every item to its providers in human output', () => {
    const text = renderResearch(OUTCOME, undefined, false);
    expect(text).toContain('https://a.example');
    expect(text).toContain('you');
    expect(text).toContain('exa');
  });

  it('always surfaces gaps in human output', () => {
    expect(renderResearch(OUTCOME, undefined, false)).toMatch(/thin/);
  });

  it('reports what was billed', () => {
    expect(renderResearch(OUTCOME, undefined, false)).toContain('2');
  });

  it('carries the session id into the JSON document', () => {
    expect(JSON.parse(renderResearch(OUTCOME, 'r-1', true)).session.id).toBe('r-1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/render.test.ts`
Expected: FAIL — `renderPlan` / `renderResearch` are not exported.

- [ ] **Step 3: Implement the renderers**

Append to `src/engine/render.ts`:

```ts
/** The plan on its own (`fezoctl plan`) -- no network, no billing, so this is
 * the cheapest way for a caller to see what routing a prompt would get. */
export function renderPlan(plan: RoutingPlan, json: boolean): string {
  if (json) return `${JSON.stringify(plan, null, 2)}\n`;
  const lines = [
    `intents:  ${plan.intents.join(', ')}`,
    `queries:  ${plan.queries.length > 0 ? plan.queries.map((q) => `"${q}"`).join(', ') : '(none)'}`,
    `targets:  ${plan.targets.length > 0 ? plan.targets.join(', ') : '(none)'}`,
    `depth:    ${plan.depth} (fan-out ${String(plan.fanout)} providers per query)`,
    `source:   ${plan.source}`,
    `signals:  ${plan.signals.length > 0 ? plan.signals.join('; ') : '(none)'}`,
    '',
    'Override any field: --intents, --queries, --targets, --depth, --fanout, or --plan-json.',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * One research round.
 *
 * Gaps and billing are rendered even on a fully successful round, for the
 * reason one-step.ts states about caps: "it worked" and "it worked but half the
 * providers never answered" must not look identical.
 */
export function renderResearch(outcome: ResearchOutcome, sessionId: string | undefined, json: boolean): string {
  if (json) {
    return `${JSON.stringify({
      ok: outcome.ok,
      plan: outcome.plan,
      items: outcome.items.map((item) => ({
        url: item.url,
        title: item.title,
        ...(item.snippet !== undefined ? { snippet: item.snippet } : {}),
        ...(item.publishedAt !== undefined ? { published_at: item.publishedAt } : {}),
        providers: item.providers.map((p) => ({ backend_id: p.backendId, rank: p.rank, result_rank: p.resultRank })),
        score: item.score,
        duplicates: item.duplicates,
      })),
      documents: outcome.documents.map((doc) => ({ url: doc.url, backend_id: doc.backendId, content: doc.content })),
      coverage: outcome.coverage,
      next_actions: outcome.nextActions.map((a) => ({ why: a.why, cmd: a.cmd })),
      billing: { calls_billed: outcome.billing.callsBilled, attempts: outcome.billing.attempts },
      session: sessionId !== undefined ? { id: sessionId } : null,
    }, null, 2)}\n`;
  }

  const lines: string[] = [];
  outcome.items.forEach((item, index) => {
    const providers = item.providers.map((p) => p.backendId).join(', ');
    lines.push(`${String(index + 1)}. ${item.title}`);
    lines.push(`   ${item.url}`);
    if (item.snippet !== undefined) lines.push(`   ${item.snippet}`);
    lines.push(`   sources: ${providers}${item.duplicates.length > 0 ? ` (+${String(item.duplicates.length)} duplicate link(s))` : ''}`);
    lines.push('');
  });
  if (outcome.items.length === 0) lines.push('No results.', '');

  for (const doc of outcome.documents) {
    // Byte count, not the body: a scraped page is routinely tens of kilobytes,
    // and printing it would bury the merged results this command exists to
    // produce. `--json` carries the full content for anything that needs it.
    lines.push(`fetched ${doc.url} via ${doc.backendId} (${String(doc.content.length)} bytes)`);
  }
  if (outcome.documents.length > 0) lines.push('');

  lines.push(`Providers served: ${outcome.coverage.served.join(', ') || '(none)'}`);
  if (outcome.coverage.failed.length > 0) {
    lines.push(`Failed: ${outcome.coverage.failed.map((f) => `${f.backendId} (${f.reason})`).join(', ')}`);
  }
  if (outcome.coverage.suppressed > 0) {
    lines.push(`Suppressed ${String(outcome.coverage.suppressed)} result(s) already seen in this session.`);
  }
  lines.push(`Billed ${String(outcome.billing.callsBilled)} call(s).`);
  if (outcome.aborted !== undefined) lines.push(`Stopped: ${outcome.aborted}`);
  if (outcome.coverage.gaps.length > 0) {
    lines.push('', 'Gaps:');
    for (const gap of outcome.coverage.gaps) lines.push(`  - ${gap}`);
  }
  if (outcome.nextActions.length > 0) {
    lines.push('', 'Next:');
    for (const action of outcome.nextActions) lines.push(`  ${action.cmd}   # ${action.why}`);
  }
  return `${lines.join('\n')}\n`;
}
```

Add the imports at the top of `src/engine/render.ts`:

```ts
import type { RoutingPlan } from './plan.js';
import type { ResearchOutcome } from './research.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/render.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/render.ts tests/render.test.ts
git commit -m "feat: render plan and research output"
```

---

### Task 12: CLI wiring

**Files:**
- Modify: `src/cli.ts` (flag parsing, `cmdPlan`, `cmdResearch`, dispatch, `HELP_TEXT`)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `clampPlan`, `mergePlan`, `parsePlanJson`, `PlanOverrides`, `RoutingPlan` (Task 2); `resolvePlanner` (Task 3); `loadSession`, `saveSession`, `validateSessionId` (Task 8); `runResearch`, `seenUrlsFrom` (Tasks 9-10); `renderPlan`, `renderResearch` (Task 11); the existing `openGateway`, `emitFailure`, `EXIT_OK` / `EXIT_USAGE` / `EXIT_OPERATIONAL` in `cli.ts`.
- Produces: `CliDeps.homeDir?: string`; the `plan` and `research` commands.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli.test.ts`. That file already imports `runCli` from `../src/cli.js` and defines a `baseDeps(overrides?)` helper returning a `CliDeps`; `runCli(argv, deps)` resolves to `{ exitCode, stdout, stderr }`.

```ts
describe('fezoctl plan', () => {
  it('prints a plan without touching the network', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(['plan', 'what is a merkle tree', '--json'], baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).intents).toContain('search');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('requires a prompt', async () => {
    expect((await runCli(['plan'], baseDeps())).exitCode).toBe(1);
  });
});

describe('fezoctl research', () => {
  it('rejects a malformed --plan-json with a usage error before any call', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(
      ['research', 'x', '--plan-json', '{not json'],
      baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
    );
    expect(result.exitCode).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects an unknown key in --plan-json', async () => {
    const result = await runCli(['research', 'x', '--plan-json', '{"nonsense":1}'], baseDeps());
    expect(result.exitCode).toBe(1);
  });

  it('rejects an invalid --session id before any call', async () => {
    const fetchFn = vi.fn();
    const result = await runCli(
      ['research', 'x', '--session', '../escape'],
      baseDeps({ fetchFn: fetchFn as unknown as typeof fetch }),
    );
    expect(result.exitCode).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric --fanout', async () => {
    expect((await runCli(['research', 'x', '--fanout', 'wide'], baseDeps())).exitCode).toBe(1);
  });

  it('emits a JSON error envelope on failure with --json', async () => {
    const result = await runCli(['research', 'x', '--fanout', 'wide', '--json'], baseDeps());
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.kind).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/cli.test.ts`
Expected: FAIL — `unknown command "plan"`, exit code 1 for the wrong reason and no JSON plan on stdout.

- [ ] **Step 3: Wire the commands into `src/cli.ts`**

Add one field to `CliDeps` (`src/cli.ts:337`), so a test can point the session
cache at a scratch directory instead of the real home:

```ts
  /** Overrides `os.homedir()` for session-cache placement. Tests only;
   * production never sets it. */
  homeDir?: string;
```

Add imports:

```ts
import { homedir } from 'node:os';

import { clampPlan, mergePlan, parsePlanJson } from './engine/plan.js';
import type { PlanOverrides, RoutingPlan } from './engine/plan.js';
import { resolvePlanner } from './engine/planners/heuristic.js';
import { runResearch, seenUrlsFrom } from './engine/research.js';
import { loadSession, saveSession, validateSessionId } from './engine/session.js';
import { renderPlan, renderResearch } from './engine/render.js';
import { INTENTS } from './engine/intent.js';
```

Add the flag parsing helper and both commands:

```ts
/**
 * Builds the round's plan from prompt + flags, or throws a usage error.
 *
 * Every rejection here happens during argv handling, before a candidate is
 * selected or a call is billed -- the contract stated at the top of this file
 * and already followed by `--args-json`.
 */
function planFromFlags(prompt: string, flags: ParsedFlags): RoutingPlan {
  const planner = resolvePlanner(typeof flags.planner === 'string' ? flags.planner : 'heuristic');
  const overrides: PlanOverrides = {};
  if (typeof flags.planJson === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(flags.planJson);
    } catch (error) {
      throw new Error(`--plan-json is not valid JSON: ${(error as Error).message}`);
    }
    overrides.plan = parsePlanJson(parsed);
  }
  if (typeof flags.intents === 'string') {
    const intents = flags.intents.split(',').map((s) => s.trim()).filter((s) => s !== '');
    for (const intent of intents) {
      if (!INTENTS.includes(intent as never)) throw new Error(`unknown intent "${intent}"`);
    }
    overrides.intents = intents as RoutingPlan['intents'];
  }
  if (Array.isArray(flags.queries)) overrides.queries = flags.queries;
  if (Array.isArray(flags.targets)) overrides.targets = flags.targets;
  if (typeof flags.depth === 'string') {
    if (!['shallow', 'standard', 'research'].includes(flags.depth)) {
      throw new Error(`--depth must be shallow, standard or research`);
    }
    overrides.depth = flags.depth as RoutingPlan['depth'];
  }
  if (flags.fanout !== undefined) {
    const fanout = Number(flags.fanout);
    if (!Number.isInteger(fanout) || fanout < 1) throw new Error('--fanout must be a positive integer');
    overrides.fanout = fanout;
  }
  return clampPlan(mergePlan(planner.plan(prompt), overrides));
}

async function cmdPlan(flags: ParsedFlags, deps: CliDeps, emit: Emit): Promise<number> {
  const prompt = flags._[1];
  if (prompt === undefined || prompt.trim() === '') {
    emitFailure(emit, 'usage', 'plan requires a prompt');
    return EXIT_USAGE;
  }
  let plan: RoutingPlan;
  try {
    plan = planFromFlags(prompt, flags);
  } catch (error) {
    emitFailure(emit, 'usage', (error as Error).message);
    return EXIT_USAGE;
  }
  emit(renderPlan(plan, flags.json === true));
  return EXIT_OK;
}

async function cmdResearch(flags: ParsedFlags, deps: CliDeps, emit: Emit, excluded: readonly string[]): Promise<number> {
  const prompt = flags._[1];
  if (prompt === undefined || prompt.trim() === '') {
    emitFailure(emit, 'usage', 'research requires a prompt');
    return EXIT_USAGE;
  }
  let plan: RoutingPlan;
  let sessionId: string | undefined;
  let maxCalls: number | undefined;
  try {
    plan = planFromFlags(prompt, flags);
    if (typeof flags.session === 'string') {
      validateSessionId(flags.session);
      sessionId = flags.session;
    }
    if (flags.maxCalls !== undefined) {
      const value = Number(flags.maxCalls);
      if (!Number.isInteger(value) || value < 1) throw new Error('--max-calls must be a positive integer');
      maxCalls = value;
    }
  } catch (error) {
    emitFailure(emit, 'usage', (error as Error).message);
    return EXIT_USAGE;
  }

  // The same opening move as search/schema/call/run/catalog: resolve
  // credentials and fetch the catalog, with both failure kinds reported in one
  // place. See `openGateway`'s own comment.
  const gateway = await openGateway(deps, emit);
  if (!gateway.ok) return gateway.exitCode;
  const { creds, candidates } = gateway.session;

  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  const session = sessionId !== undefined ? loadSession(sessionId, env, home) : undefined;

  const outcome = await runResearch({
    plan,
    candidates,
    excluded,
    gateway: { baseUrl: creds.baseUrl, apiKey: creds.apiKey, ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}) },
    ...(session !== undefined ? { seenUrls: new Set(session.seenUrls) } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(maxCalls !== undefined ? { maxCalls } : {}),
  });

  if (session !== undefined && sessionId !== undefined) {
    saveSession({
      id: sessionId,
      seenUrls: [...new Set([...session.seenUrls, ...seenUrlsFrom(outcome)])],
      queries: [...new Set([...session.queries, ...plan.queries])],
      callsBilled: session.callsBilled + outcome.billing.callsBilled,
    }, env, home);
  }

  emit(renderResearch(outcome, sessionId, flags.json === true));
  return outcome.ok ? EXIT_OK : EXIT_OPERATIONAL;
}
```

Add both to the dispatch switch, next to `case 'run'`:

```ts
    case 'plan':
      return finish(await cmdPlan(flags, deps, emit));
    case 'research':
      return finish(await cmdResearch(flags, deps, emit, excluded));
```

Register the new flags in the argv parser alongside the existing string flags: `--planner`, `--plan-json`, `--intents`, `--depth`, `--fanout`, `--max-calls`, `--session` as single-valued, and `--queries` / `--targets` as repeatable (accumulating into an array).

Add to `HELP_TEXT`, after the one-step command lines:

```
  fezoctl plan "<prompt>" [--json]
  fezoctl research "<prompt>" [--intents a,b] [--queries "q"]... [--targets <url>]...
                   [--depth shallow|standard|research] [--fanout N] [--max-calls N]
                   [--session <id>] [--plan-json '<json>'] [--json]
```

and this paragraph:

```
research fans one prompt out to several providers at once and returns a single
deduplicated, source-attributed result set with a coverage report. `plan` shows
what routing a prompt would get without calling anything. Depth sets the width
(shallow 2, standard 4, research 8 providers per query); --session <id> makes a
follow-up round exclude what an earlier round already returned.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: add plan and research commands to fezoctl"
```

---

### Task 13: Skill documentation

**Files:**
- Modify: `src/engine/steering.ts` (add `RESEARCH_DESCRIPTIONS`)
- Modify: `skills/fezo/SKILL.md` via `build/gen-skill.mjs` (run the generator; do not hand-edit generated regions)
- Test: `tests/skill_contract.test.ts`

**Interfaces:**
- Consumes: `ONE_STEP_DESCRIPTIONS` conventions from `steering.ts`.
- Produces: `export const RESEARCH_DESCRIPTIONS: Record<'plan' | 'research', string>`.

- [ ] **Step 1: Write the failing test**

Append to `tests/skill_contract.test.ts`:

```ts
import { RESEARCH_DESCRIPTIONS } from '../src/engine/steering.js';

describe('SKILL.md research contract', () => {
  const skill = readFileSync(new URL('../skills/fezo/SKILL.md', import.meta.url), 'utf8');

  it('documents every research command description verbatim', () => {
    for (const description of Object.values(RESEARCH_DESCRIPTIONS)) {
      expect(skill).toContain(description);
    }
  });

  it('tells the agent to plan explicitly for research-depth prompts', () => {
    expect(skill).toMatch(/--queries/);
    expect(skill).toMatch(/decompos/i);
  });

  it('tells the agent to act on coverage gaps', () => {
    expect(skill).toMatch(/gaps/);
    expect(skill).toMatch(/--session/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/skill_contract.test.ts`
Expected: FAIL — `RESEARCH_DESCRIPTIONS` is not exported and SKILL.md says nothing about research.

- [ ] **Step 3: Add the descriptions and the skill procedure**

In `src/engine/steering.ts`:

```ts
/** One line per research command, read by HELP_TEXT and by the SKILL.md
 * generator -- same single-source rule as ONE_STEP_DESCRIPTIONS. */
export const RESEARCH_DESCRIPTIONS: Record<'plan' | 'research', string> = {
  plan: 'Show what routing a prompt would get — intents, queries, depth, fan-out width — without calling anything.',
  research: 'Fan one prompt out to several providers at once and return one deduplicated, source-attributed result set with a coverage report.',
};
Object.freeze(RESEARCH_DESCRIPTIONS);
```

Add a section to the SKILL.md source template used by `build/gen-skill.mjs`:

```markdown
## Breadth: `research`

For a question that wants several sources rather than one answer, use
`research` instead of `web-search`. It calls several providers at once and
returns one merged, deduplicated list where every item names the providers
that returned it.

    "${FEZOCTL_ARGV[@]}" research "<prompt>" --json

**Decompose it yourself for real research.** The built-in planner reads one
string: it cannot split a question into sub-questions, and it cannot resolve
"their pricing page" against anything said earlier in this conversation. You
can do both. For anything beyond a single lookup, rewrite the prompt so it
stands alone and pass the sub-questions explicitly:

    "${FEZOCTL_ARGV[@]}" research "EU AI Act enforcement" \
      --queries "EU AI Act enforcement actions 2026" \
      --queries "EU AI Act national competent authorities" \
      --depth research --session r-1

Run `plan` first if you want to see what the heuristic would have done — it
costs nothing and makes no calls.

**Read the `gaps` before you answer.** Every round reports what it could not
cover: thin queries, providers that failed, work dropped on the call budget.
If `gaps` is non-empty and the answer matters, run the command in
`next_actions` before writing your reply. Always pass the same `--session` on
a follow-up round: it stops the round from returning — and charging for —
links you already have.

**Every provider in the fan-out is a billed call.** `--depth research` is 8
providers per query. Use `--depth shallow` for a lookup.
```

Regenerate and verify:

```bash
pnpm gen-skill
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/engine/steering.ts skills/fezo/SKILL.md build/gen-skill.mjs tests/skill_contract.test.ts
git commit -m "docs: teach the fezo skill to plan and run research rounds"
```

---

### Task 14: Live calibration of response adapters

**Files:**
- Create: `build/capture-responses.mjs`
- Create: `tests/fixtures/responses/<tool>.json` (one per provider, captured)
- Modify: `src/engine/aggregate.ts` (`RESPONSE_ADAPTERS` entries, only where needed)
- Test: `tests/aggregate-fixtures.test.ts`

**Interfaces:**
- Consumes: `extractItems`, `RESPONSE_ADAPTERS` from `aggregate.ts`.
- Produces: captured fixtures and any adapters the captures prove necessary.

> **This is the one task that needs a live gateway and a real API key.** It is deliberately last: every module above is complete and tested against synthetic shapes, and this task replaces guesses about real provider bodies with recorded fact. Do not write an adapter before capturing the response it adapts.

- [ ] **Step 1: Write the capture script**

Create `build/capture-responses.mjs`:

```js
// Captures one real response per search-capable provider into
// tests/fixtures/responses/, so adapter work is done against recorded fact
// rather than a guess about a provider's shape. Run manually; needs a live
// gateway and a real key. Each run bills one call per provider.
//
// Usage: FEZO_URL=... FEZO_API_KEY=... node build/capture-responses.mjs "test query"

import { mkdirSync, writeFileSync } from 'node:fs';

const url = process.env.FEZO_URL ?? 'https://zug-gateway.internal-iden3-dev.com';
const key = process.env.FEZO_API_KEY;
const query = process.argv[2] ?? 'renewable energy storage';
if (!key) { console.error('FEZO_API_KEY is required'); process.exit(1); }

const catalog = await (await fetch(`${url}/v1/catalog`, { headers: { Authorization: `Bearer ${key}` } })).json();
mkdirSync('tests/fixtures/responses', { recursive: true });

for (const backend of catalog.backends ?? []) {
  for (const method of backend.methods ?? []) {
    const tool = `${backend.backend_id}_${method.name.replace(/\./g, '_')}`;
    const props = method.input_schema?.properties ?? {};
    const argName = ['query', 'q', 'search', 'keyword', 'term'].find((n) => n in props);
    if (!argName) continue;
    const response = await fetch(`${url}/v1/${backend.backend_id}${method.path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [argName]: query }),
    });
    const text = await response.text();
    if (!response.ok) { console.error(`${tool}: HTTP ${response.status}`); continue; }
    writeFileSync(`tests/fixtures/responses/${tool}.json`, text);
    console.log(`captured ${tool} (${text.length} bytes)`);
  }
}
```

- [ ] **Step 2: Capture real responses**

```bash
FEZO_API_KEY="$YOUR_KEY" node build/capture-responses.mjs "renewable energy storage"
```

Expected: one JSON file per search-capable provider under `tests/fixtures/responses/`.

- [ ] **Step 3: Write the fixture test**

Create `tests/aggregate-fixtures.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractItems } from '../src/engine/aggregate.js';

const dir = new URL('./fixtures/responses/', import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('extractItems against captured provider responses', () => {
  it('has fixtures to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const tool = basename(file, '.json');
    it(`reads results from ${tool}`, () => {
      const body = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const items = extractItems(tool, body);
      expect(items.length, `${tool} yielded no items — write an adapter`).toBeGreaterThan(0);
      for (const item of items) expect(item.url).toMatch(/^https?:\/\//);
    });
  }
});
```

- [ ] **Step 4: Run the test and write an adapter for every failure**

Run: `pnpm test -- tests/aggregate-fixtures.test.ts`

For each failing tool, read its fixture and add exactly one entry to
`RESPONSE_ADAPTERS` in `src/engine/aggregate.ts`, shaped like this (the example
is illustrative; write what the captured body actually shows):

```ts
RESPONSE_ADAPTERS['example_search'] = (body) => {
  const hits = (body as { data?: { hits?: unknown[] } }).data?.hits ?? [];
  return hits.flatMap((hit) => {
    const record = hit as Record<string, unknown>;
    const url = typeof record['target'] === 'string' ? record['target'] : undefined;
    if (url === undefined) return [];
    return [{
      url,
      ...(typeof record['label'] === 'string' ? { title: record['label'] } : {}),
    }];
  });
};
```

Re-run until every fixture yields items.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add build/capture-responses.mjs tests/fixtures/responses tests/aggregate-fixtures.test.ts src/engine/aggregate.ts
git commit -m "feat: calibrate response adapters against captured provider bodies"
```

---

## Verification

After Task 14, verify end to end against a live gateway:

```bash
node dist/fezoctl.mjs plan "compare pricing of vercel.com and netlify.com"
node dist/fezoctl.mjs research "state of solid-state battery commercialisation" --depth research --session v-1 --json
node dist/fezoctl.mjs research "solid-state battery pilot production lines 2026" --session v-1 --json
```

Expected: the first prints a scrape-intent plan with two targets and makes no
calls; the second returns a merged set with multi-provider attribution and a
coverage block; the third returns strictly new URLs and reports a non-zero
`coverage.suppressed`.

```bash
pnpm bundle && pnpm pack:check
```

Expected: the single-file bundle builds and passes the packaging check — the
new modules must not have introduced a dependency esbuild cannot inline.
