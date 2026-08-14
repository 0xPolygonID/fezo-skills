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

import {
  DEPTH_FANOUT,
  MAX_FANOUT,
  MAX_RESEARCH_CALLS,
  PLAN_SCHEMA,
  clampPlan,
  mergePlan,
  parsePlanJson,
} from '../src/engine/plan.js';
import type { RoutingPlan } from '../src/engine/plan.js';

/** The round's billed-call count, as the spec's budget formula states it. */
function impliedCalls(p: RoutingPlan): number {
  return p.queries.length * p.fanout + p.targets.length;
}

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

  // Pins the deviation recorded under the plan's Task 2: a flag beats the
  // --plan-json it accompanies, the reverse of the spec's original chain.
  it('applies flags on top of a whole-plan override', () => {
    const merged = mergePlan(plan(), { plan: plan({ fanout: 2 }), fanout: 7 });
    expect(merged.fanout).toBe(7);
  });

  it('re-derives fanout from a depth flag that carries no explicit fanout', () => {
    expect(mergePlan(plan({ fanout: 3 }), { depth: 'research' }).fanout).toBe(DEPTH_FANOUT.research);
  });

  it('lets an explicit fanout survive a depth flag', () => {
    expect(mergePlan(plan({ fanout: 3 }), { depth: 'research', fanout: 5 }).fanout).toBe(5);
  });

  it('keeps a fanout that no depth flag disturbs', () => {
    expect(mergePlan(plan({ fanout: 3 }), { queries: ['tea'] }).fanout).toBe(3);
  });

  // Every caps test below is about money: fanout bills once per provider per
  // query. The bound has to be a property of the merge, not of whichever caller
  // remembers to clamp afterwards -- there is only ever one caller until there
  // are two.
  it('clamps a fanout no schema saw, because flags do not pass through the schema', () => {
    expect(mergePlan(plan(), { fanout: 9999 }).fanout).toBe(MAX_FANOUT);
  });

  it('clamps a whole-plan override too', () => {
    expect(mergePlan(plan(), { plan: plan({ fanout: 9999 }) }).fanout).toBe(MAX_FANOUT);
  });

  it('holds the implied call count within MAX_RESEARCH_CALLS for every merge path', () => {
    const many = Array.from({ length: 50 }, (_, i) => `q${i}`);
    expect(impliedCalls(mergePlan(plan(), { queries: many, fanout: 10 }))).toBeLessThanOrEqual(MAX_RESEARCH_CALLS);
    expect(impliedCalls(mergePlan(plan(), { plan: plan({ queries: many, fanout: 10 }) }))).toBeLessThanOrEqual(
      MAX_RESEARCH_CALLS,
    );
    // The no-flag path returns the base as-is, and a planner is not a trusted
    // source of a bounded plan either.
    expect(impliedCalls(mergePlan(plan({ queries: many, fanout: 10 }), {}))).toBeLessThanOrEqual(MAX_RESEARCH_CALLS);
  });

  it('copies the base rather than returning it when there are no overrides', () => {
    const base = plan();
    const merged = mergePlan(base, {});
    expect(merged).toEqual(base);
    // Identity, not just equality: downstream rendering annotates the plan it
    // is handed, and must not be able to reach the planner's own object.
    expect(merged).not.toBe(base);
    expect(merged.signals).not.toBe(base.signals);
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

  it('reports every schema problem at once, not just the first', () => {
    // ajv-instance.ts sets `allErrors: true` so a caller with several typos in
    // a hand-written plan needs one round-trip, not one per typo.
    expect(() => parsePlanJson({ intents: ['telepathy'], depth: 'deep', queries: ['x'] })).toThrow(
      /intents.*depth|depth.*intents/s,
    );
  });

  it('derives fanout from depth when the caller gives none', () => {
    expect(parsePlanJson({ depth: 'shallow', queries: ['x'] }).fanout).toBe(DEPTH_FANOUT.shallow);
  });

  it("forces source to 'caller' whatever the JSON claims", () => {
    expect(parsePlanJson({ source: 'llm', queries: ['x'] }).source).toBe('caller');
  });

  it('rejects a plan with nothing to do, naming both fields', () => {
    // --plan-json replaces the planner's plan wholesale, so a fragment like
    // `{"depth":"research"}` would otherwise wipe the queries and bill nothing.
    expect(() => parsePlanJson({ depth: 'research' })).toThrow(/queries/);
    expect(() => parsePlanJson({ depth: 'research' })).toThrow(/targets/);
    expect(() => parsePlanJson({})).toThrow(/queries/);
  });

  it('accepts a targets-only plan', () => {
    expect(parsePlanJson({ targets: ['https://example.com'] }).targets).toEqual(['https://example.com']);
  });

  // PLAN_SCHEMA is the documented gate for caller-supplied plans, so it has to
  // encode the cap it exists to guard: `{"fanout":9999}` used to validate and
  // come back as 9999.
  it('rejects a fanout above MAX_FANOUT at the schema, naming the bound', () => {
    expect(() => parsePlanJson({ queries: ['x'], fanout: 9999 })).toThrow(/fanout/);
    expect(parsePlanJson({ queries: ['x'], fanout: MAX_FANOUT }).fanout).toBe(MAX_FANOUT);
  });
});

describe('PLAN_SCHEMA', () => {
  // The validator is compiled once at module load, so any mutation of this
  // object leaves the exported constant advertising a contract nothing
  // enforces. The nested `enum` arrays are the part the first freeze pass
  // missed -- and they are exactly the part that describes the contract.
  it('is frozen all the way down, nested enum arrays included', () => {
    expect(Object.isFrozen(PLAN_SCHEMA)).toBe(true);
    expect(Object.isFrozen(PLAN_SCHEMA.properties)).toBe(true);
    expect(Object.isFrozen(PLAN_SCHEMA.properties.depth.enum)).toBe(true);
    expect(Object.isFrozen(PLAN_SCHEMA.properties.source.enum)).toBe(true);
    expect(Object.isFrozen(PLAN_SCHEMA.properties.intents.items.enum)).toBe(true);
    expect(Object.isFrozen(PLAN_SCHEMA.properties.queries.items)).toBe(true);
  });

  it('does not let a caller widen an enum at run time', () => {
    const depths = PLAN_SCHEMA.properties.depth.enum as unknown as string[];
    expect(() => depths.push('deep')).toThrow();
    expect(depths).toEqual(['shallow', 'standard', 'research']);
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

  it('trims and dedupes targets too', () => {
    expect(clampPlan(plan({ targets: ['a', ' a ', ''] })).targets).toEqual(['a']);
  });

  it('truncates a fractional fanout rather than rounding it', () => {
    expect(clampPlan(plan({ fanout: 2.9 })).fanout).toBe(2);
  });

  it("falls back to the depth's width for a non-finite fanout", () => {
    // NaN would otherwise survive every bound and make the executor's
    // `queries.length * fanout` budget NaN.
    expect(clampPlan(plan({ fanout: NaN })).fanout).toBe(DEPTH_FANOUT.standard);
    expect(clampPlan(plan({ fanout: Infinity, depth: 'research' })).fanout).toBe(DEPTH_FANOUT.research);
  });

  // `queries * fanout + targets` is the spec's budget formula, and until now
  // clampPlan bounded only the last-but-one term: 50 queries at fanout 10 came
  // back untouched as 600 implied calls, twenty-five times the cap.
  it('bounds queries so the implied call count cannot exceed MAX_RESEARCH_CALLS', () => {
    const clamped = clampPlan(plan({ queries: Array.from({ length: 50 }, (_, i) => `q${i}`), fanout: 10 }));
    expect(impliedCalls(clamped)).toBeLessThanOrEqual(MAX_RESEARCH_CALLS);
    expect(clamped.queries).toEqual(['q0', 'q1']);
  });

  it('bounds targets, which bill one call each', () => {
    const clamped = clampPlan(plan({ queries: [], targets: Array.from({ length: 100 }, (_, i) => `https://t${i}.example`) }));
    expect(clamped.targets).toHaveLength(MAX_RESEARCH_CALLS);
    expect(impliedCalls(clamped)).toBeLessThanOrEqual(MAX_RESEARCH_CALLS);
  });

  it('bounds the two together, targets first, since a query is the multiplicative term', () => {
    const clamped = clampPlan(
      plan({
        queries: Array.from({ length: 50 }, (_, i) => `q${i}`),
        targets: Array.from({ length: 20 }, (_, i) => `https://t${i}.example`),
        fanout: 2,
      }),
    );
    expect(clamped.targets).toHaveLength(20);
    expect(clamped.queries).toEqual(['q0', 'q1']);
    expect(impliedCalls(clamped)).toBeLessThanOrEqual(MAX_RESEARCH_CALLS);
  });

  it('leaves a plan already within budget completely alone', () => {
    const base = plan({ queries: ['a', 'b'], targets: ['https://t.example'], fanout: 4 });
    expect(clampPlan(base)).toEqual(base);
  });

  it('is idempotent, so applying it twice cannot shrink a plan further', () => {
    const once = clampPlan(plan({ queries: Array.from({ length: 50 }, (_, i) => `q${i}`), fanout: 10 }));
    expect(clampPlan(once)).toEqual(once);
  });

  it('does not alias its input', () => {
    const base = plan({ signals: ['heuristic: search'] });
    const clamped = clampPlan(base);
    expect(clamped).not.toBe(base);
    expect(clamped.signals).not.toBe(base.signals);
    expect(clamped.signals).toEqual(['heuristic: search']);
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
import { ajvErrorsToText } from './schema.js';

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

/** Overrides, in the precedence `mergePlan` implements: a whole `--plan-json`
 * plan replaces the planner's, then the individual flags below overwrite
 * fields on top of it. A flag therefore always beats the JSON it accompanies. */
export interface PlanOverrides {
  /** A whole plan supplied by the caller (`--plan-json`). Replaces the base
   * plan wholesale -- it is NOT merged field-wise, which is why
   * `parsePlanJson` refuses a plan with nothing to do. */
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
    // `maximum` as well as `minimum`, because this schema is the documented
    // gate for caller-supplied plans and fanout is the field that multiplies
    // spend: `{"fanout":9999}` validating and coming back verbatim made the
    // gate advertise a cap it did not check. Rejecting is right here rather
    // than clamping quietly -- a caller who typed 9999 asked for a round that
    // does not exist, and this throw becomes exit 1 during argv parsing, before
    // anything is billed. (`clampPlan` still clamps, for the flag and planner
    // paths that never touch a schema.)
    fanout: { type: 'integer', minimum: 1, maximum: MAX_FANOUT },
    signals: { type: 'array', items: { type: 'string' } },
    source: { type: 'string', enum: ['heuristic', 'flags', 'caller', 'llm'] },
  },
  // Closed on purpose: a typo'd key in a hand-written --plan-json must fail
  // loudly at parse time rather than being silently ignored and producing a
  // round the caller did not ask for -- and paid for.
  additionalProperties: false,
} as const;

// Frozen for the same reason as DEPTH_FANOUT, and down to the nested property
// schemas the way providers.ts freezes its nested rows: the validator below is
// compiled once at module load, so a mutation of this object would leave the
// exported constant advertising a contract nothing enforces. `as const` is a
// compile-time annotation only and stops nothing at runtime.
//
// Recursive rather than a hand-written walk of the levels this schema happens
// to have today: the first version froze each property and its `items` but not
// their `enum` arrays -- and the enums ARE the contract, so
// `PLAN_SCHEMA.properties.depth.enum.push('deep')` made the exported constant
// promise a depth the compiled validator rejects. Enumerating levels is how
// that hole appeared, and a keyword nested one level deeper (`items.items`,
// `properties.x.properties`) would open it again. This walk cannot miss one.
function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
  Object.freeze(value);
}
freezeDeep(PLAN_SCHEMA);

const validatePlanSchema = newSchemaCompiler().compile(PLAN_SCHEMA);

/**
 * Validates and completes a caller-supplied plan fragment.
 *
 * Throws on anything invalid, and the caller (cli.ts) turns that into exit
 * code 1 during argv parsing -- before any candidate is selected or billed,
 * the same contract `--args-json` already follows.
 *
 * Absent fields are filled from defaults here rather than inherited from the
 * planner, because `mergePlan` substitutes the *whole* result for the base
 * plan. That is why the completed plan is then checked for having anything to
 * do at all: see the throw at the bottom.
 */
export function parsePlanJson(raw: unknown): RoutingPlan {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('--plan-json must be a JSON object');
  }
  if (!validatePlanSchema(raw)) {
    // Every error, not just the first: ajv-instance.ts sets `allErrors: true`
    // specifically so a hand-written --plan-json with three typos reports all
    // three in one go instead of costing the caller three round-trips.
    throw new Error(`--plan-json is not a valid plan: ${ajvErrorsToText(validatePlanSchema.errors)}`);
  }
  const partial = raw as Partial<RoutingPlan>;
  const depth = partial.depth ?? 'standard';
  const plan: RoutingPlan = {
    intents: partial.intents ?? ['search'],
    queries: partial.queries ?? [],
    targets: partial.targets ?? [],
    depth,
    fanout: partial.fanout ?? DEPTH_FANOUT[depth],
    signals: partial.signals ?? [],
    // Always 'caller', whatever the JSON claims: this plan arrived from the
    // command line, and `source` records who actually won the merge rather
    // than what the document says about itself.
    source: 'caller',
  };
  // A plan with neither queries nor targets can never do anything, and because
  // this object replaces the planner's, accepting one would wipe the
  // heuristic's queries and produce an empty round at exit 0 -- exactly the
  // "round the caller did not ask for" that PLAN_SCHEMA is closed to prevent,
  // only quieter. The message spells out the replace-not-merge semantics
  // because the mistake it catches is a caller expecting a field-wise merge.
  if (plan.queries.length === 0 && plan.targets.length === 0) {
    throw new Error(
      '--plan-json has no queries and no targets: a plan needs at least one of them ' +
        "(note that --plan-json replaces the planner's whole plan, it does not merge field-wise -- " +
        'use --depth/--fanout/--queries to adjust one field)',
    );
  }
  return plan;
}

/**
 * A whole `--plan-json` plan replaces the base, then individual flags
 * overwrite fields on top of it -- so a flag always wins over the JSON it
 * accompanies. This inverts the spec's stated `--plan-json > flags` chain,
 * deliberately: a flag is the more specific instruction, and under the other
 * order every flag typed next to a `--plan-json` would be silently ignored.
 * Recorded as a deviation under the plan's Task 2.
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
  // Clamped on the no-op path too, and the copy comes with it: the returned
  // plan is never the same object as its input, so a downstream renderer that
  // annotates the plan it was handed cannot reach back and mutate the
  // planner's own. Clamping here rather than leaving it to the caller is the
  // point -- see `clampPlan`'s docstring: a planner is not a trusted source of
  // a bounded plan either, and `--plan-json` reaches this function having
  // passed a schema that bounds `fanout` but knows nothing of
  // `queries.length * fanout`.
  if (!flagged) return clampPlan(out);
  const depth = overrides.depth ?? out.depth;
  out = {
    ...out,
    intents: overrides.intents ?? out.intents,
    queries: overrides.queries ?? out.queries,
    targets: overrides.targets ?? out.targets,
    signals: [...out.signals],
    depth,
    // A depth flag with no explicit fanout re-derives the width, so
    // `--depth research` widens the round the way a caller expects.
    fanout: overrides.fanout ?? (overrides.depth !== undefined ? DEPTH_FANOUT[depth] : out.fanout),
    source: 'flags',
  };
  return clampPlan(out);
}

/**
 * Enforces the hard bounds and removes degenerate input.
 *
 * What this guarantees, exactly: on the returned plan, `1 <= fanout <=
 * MAX_FANOUT` and `queries.length * fanout + targets.length <=
 * MAX_RESEARCH_CALLS` -- the spec's budget formula, so the plan cannot IMPLY a
 * round beyond the cap. Enforcing the round's actual spend as it happens
 * (counting attempts, honouring `--max-calls`, reporting what was dropped)
 * belongs to the executor, which is the only thing that knows what a lane cost.
 *
 * `mergePlan` applies this to everything it returns, so a plan that came
 * through the merge holds the bound BY CONSTRUCTION rather than by a caller
 * remembering -- which is what the previous docstring claimed and no code did.
 * It is idempotent, so applying it again anywhere is free.
 *
 * Truncation order when the budget is short: targets are kept and whole queries
 * are dropped. That is the spec's own rule (§ Fan-out policy truncates "whole
 * queries first"), and it follows from the arithmetic -- a target is exactly
 * one call and was named literally by the caller, while a query costs `fanout`
 * calls, so dropping one query buys back up to ten targets' worth of budget.
 * Truncation here is silent by necessity (a pure function has nowhere to
 * report); the executor compares the plan it runs against the one it was given
 * and reports the difference, because a cap mistaken for full coverage is the
 * failure this whole module exists to avoid.
 */
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
  // A non-finite width falls back to the depth's declared width rather than
  // propagating NaN: `Math.min(MAX, Math.max(1, Math.trunc(NaN)))` is NaN, and
  // a NaN fanout would make `queries.length * fanout` NaN and defeat the
  // MAX_RESEARCH_CALLS accounting below -- `NaN <= 24` is false, but so is
  // `NaN > 24`, so a NaN would slip through the budget test in whichever
  // direction it was written. This function is documented as the last line of
  // defence, so it does not rely on a caller it cannot see.
  const fanout = Number.isFinite(plan.fanout)
    ? Math.min(MAX_FANOUT, Math.max(1, Math.trunc(plan.fanout)))
    : DEPTH_FANOUT[plan.depth];
  // Targets are bounded first and keep their budget; queries then take what is
  // left, at `fanout` calls each. See the docstring for why that order. The
  // floor cannot starve a query-only plan: with no targets and the widest legal
  // fanout it still leaves `floor(24/10) = 2` queries.
  const targets = dedupe(plan.targets).slice(0, MAX_RESEARCH_CALLS);
  const maxQueries = Math.floor((MAX_RESEARCH_CALLS - targets.length) / fanout);
  return {
    ...plan,
    intents: [...new Set(plan.intents)],
    queries: dedupe(plan.queries).slice(0, maxQueries),
    targets,
    // Copied so the returned plan shares no array with its input; every other
    // array here is rebuilt anyway, and an advisory list is exactly the thing
    // a renderer is tempted to append to.
    signals: [...plan.signals],
    fanout,
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

The Step 1 and Step 3 blocks above are the corrected code -- they are what
shipped, and what a reader rebuilding this task should build against. The
changes each block absorbed, and why, are recorded here so implementation can
still be reviewed against intent.

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
4. *The spend caps are now enforced instead of merely declared.* Review found
   `MAX_RESEARCH_CALLS` with zero references outside its own declaration, a
   schema with no `maximum` on `fanout` (`{"queries":["x"],"fanout":9999}`
   validated and came back as 9999), a `mergePlan` that clamped nothing, and a
   `clampPlan` whose docstring asserted "no path -- planner, flags, or caller
   JSON -- can exceed a cap" while bounding only `fanout`: 50 queries at fanout
   10 survived as 600 implied billed calls, twenty-five times the cap. Four
   changes, all in this module. (a) `PLAN_SCHEMA.properties.fanout` gains
   `maximum: MAX_FANOUT`, so the documented gate for caller-supplied plans
   encodes the cap it exists to guard, and rejects rather than clamps -- exit 1
   during argv parsing, before anything is billed, because a caller who typed
   9999 asked for a round that does not exist. (b) `mergePlan` returns
   `clampPlan(...)` on both its paths, so the bound is a property of the merge
   rather than of whichever caller remembers; a planner is not a trusted source
   of a bounded plan either, and the flag path never touches a schema at all.
   (c) `clampPlan` bounds `queries.length` and `targets.length` so
   `queries * fanout + targets <= MAX_RESEARCH_CALLS` -- the spec's own budget
   formula -- keeping targets and dropping whole queries, which is the spec's
   truncation order and follows from the arithmetic (a target is one call and
   was named literally; a query costs `fanout`). The floor cannot starve a
   query-only plan: `floor(24/10) = 2` queries survive at the widest legal
   fanout. (d) The docstring now states what is actually true, and says plainly
   that enforcing a round's real spend as it happens remains Task 9's job.
   Pinned by `tests/plan.test.ts`'s three `mergePlan` cap tests and four
   `clampPlan` budget tests, each of which failed before the change.
5. *`PLAN_SCHEMA`'s freeze is recursive.* Item 3(b)'s hand-written walk froze
   each property and its `items` but not their `enum` arrays, so
   `PLAN_SCHEMA.properties.depth.enum.push('deep')` succeeded and left the
   exported constant advertising a depth the compiled validator rejects -- the
   exact hazard its own comment describes, and a breach of the Global
   Constraint on frozen tables. Enumerating levels is how the hole appeared, so
   `freezeDeep` walks the whole object instead: a keyword nested one level
   deeper cannot reopen it. Pinned by 'is frozen all the way down, nested enum
   arrays included' and 'does not let a caller widen an enum at run time'.

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

import { SNIPPET_MAX_CHARS, canonicalizeUrl, sniffItems } from '../src/engine/aggregate.js';

describe('canonicalizeUrl', () => {
  it('yields a lowercase scheme and host regardless of input casing, but never touches the path', () => {
    expect(canonicalizeUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });

  // The http(s) casing above is folded by the URL parser itself; an opaque host
  // is not, so this is the case that actually exercises our own lowercasing.
  it('lowercases the host of a non-special scheme, which the parser leaves verbatim', () => {
    expect(canonicalizeUrl('CUSTOM://EXAMPLE.COM/Path')).toBe('custom://example.com/Path');
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

  it('normalizes a trailing slash on a deep path too, not just the root', () => {
    expect(canonicalizeUrl('https://example.com/docs/guide/')).toBe('https://example.com/docs/guide');
  });

  // The dedup invariant: a query must not decide whether the slash rule fires.
  it('normalizes a trailing slash on a path that carries a query', () => {
    expect(canonicalizeUrl('https://example.com/a/?b=1')).toBe(canonicalizeUrl('https://example.com/a?b=1'));
    expect(canonicalizeUrl('https://example.com/a/?b=1')).toBe('https://example.com/a?b=1');
  });

  it('returns an unparseable value unchanged rather than throwing', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
  });

  // `source` and `referrer` are ordinary English words, and on real sites they
  // select content (a feed variant, a localized edition) rather than describing
  // a click. Stripping them merges two genuinely different documents and demotes
  // a billed result to `duplicates` -- the one failure mode canonicalization must
  // never have, since over-merging loses data while under-merging only fails to
  // save some.
  it('keeps content-selecting parameters that merely look like tracking', () => {
    expect(canonicalizeUrl('https://example.com/item?id=5&source=rss')).toBe(
      'https://example.com/item?id=5&source=rss',
    );
    expect(canonicalizeUrl('https://example.com/item?referrer=nav')).toBe('https://example.com/item?referrer=nav');
  });

  // The vendor-namespaced click ids beyond the spec's list stay stripped: none
  // of them can select content, so removing them only ever helps the dedup.
  it('still strips vendor click ids that cannot select content', () => {
    expect(canonicalizeUrl('https://example.com/a?msclkid=1&igshid=2&yclid=3&dclid=4&_hsenc=5&_hsmi=6&mc_cid=7&b=2')).toBe(
      'https://example.com/a?b=2',
    );
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

  // `content` is a snippet candidate and a Firecrawl-family body puts the whole
  // page's markdown in it, so without a cap one fanout-8 round emits a
  // multi-megabyte JSON document. The cap is on the item, not on the document,
  // so the bound holds however many providers answer.
  it('truncates an oversized snippet to the declared cap', () => {
    const [item] = sniffItems({ results: [{ url: 'https://a.example', content: 'x'.repeat(200_000) }] });
    expect(item?.snippet?.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS + 1);
    expect(item?.snippet?.startsWith('x'.repeat(SNIPPET_MAX_CHARS))).toBe(true);
  });

  it('leaves a snippet inside the cap exactly as it found it', () => {
    const [item] = sniffItems({ results: [{ url: 'https://a.example', description: 'short and complete' }] });
    expect(item?.snippet).toBe('short and complete');
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
  // provider rather than finding this cap.
  const snippet =
    full !== undefined && full.length > SNIPPET_MAX_CHARS ? `${full.slice(0, SNIPPET_MAX_CHARS)}…` : full;
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

**Deviations recorded during implementation.**

1. *The trailing slash is stripped from every path, not only from the root, and
   is computed on `parsed.pathname` before serialization.* Step 3's rule tested
   the serialized string and guarded it with `parsed.search === ''`, so it could
   only ever fire on a URL with no query. That made `https://example.com/a/?b=1`
   and `https://example.com/a?b=1` canonicalize apart -- two spellings of one
   document, kept as two items, which defeats the dedup this function exists
   for. The string-level test cannot be fixed in place, because the query is
   serialized *last*: for any URL carrying one, the final character is never the
   path's slash. So the rule moved onto `parsed.pathname`, where the query is
   not in the way, and it now applies to every path, a trailing slash being a
   server-side directory convention rather than a distinct document. The
   serialized strip survives for the two cases the pathname setter cannot reach
   (the root, and an opaque path); see the WHY comment on it. Task 6's dedup
   keys on this exact string, so the amended spec paragraph under
   § Aggregation now states the key's shape; `tests/aggregate.test.ts` pins the
   deep-path case and the query case, alongside the original root case.
2. *Step 3's `parsed.protocol = parsed.protocol.toLowerCase()` is deleted as
   dead code.* The WHATWG parser ASCII-lowercases the scheme of *every* URL it
   accepts, special or not, so the assignment could never change anything. The
   host lowercasing next to it is kept and is not dead, which is the asymmetry
   worth writing down: the parser lowercases the host only for special schemes
   (http, https, ws, ...) and leaves an opaque host verbatim, so
   `new URL('CUSTOM://EXAMPLE.COM/Path').hostname === 'EXAMPLE.COM'`. Providers
   hand us whatever string they stored, schemes included, so that fold has to be
   ours. Pinned by `tests/aggregate.test.ts:12` -- the pre-existing http(s)
   casing test asserts only what the parser already does, and so would pass with
   the host fold removed too.
3. *`TRACKING_PARAMS` and each `FIELD_CANDIDATES` name list are frozen.* Global
   Constraints require declared tables to be `Object.freeze`d at module scope;
   Step 3's block froze neither `TRACKING_PARAMS` nor the inner arrays. `as
   const` is erased at compile time, so freezing only the outer object leaves
   every name list open to a `.push()` from a JS consumer of the bundle -- and
   field precedence, like the tracking-parameter table, defines a deterministic
   transform that must not be re-orderable at run time. Same treatment, and the
   same reasoning, as `one-step.ts`'s `ARG_CANDIDATES`.
4. *`TRACKING_PARAMS` exceeds the spec's list, deliberately and now on the
   record -- minus `source` and `referrer`, which are dropped.* Step 3's table
   silently added nine names to the spec's `utm_*`, `gclid`, `fbclid`,
   `mc_eid`, `ref`, `ref_src`, with no deviation recorded. Seven are kept and
   justified per entry, because none of them can select content -- no server
   branches on a click id: `msclkid` (Microsoft Ads), `mc_cid` (Mailchimp
   campaign, the sibling of the spec's `mc_eid`), `igshid` (Instagram share),
   `yclid` (Yandex), `dclid` (DoubleClick), `_hsenc`/`_hsmi` (HubSpot email).
   Stripping those can only merge two spellings of one document. `source` and
   `referrer` are removed: they are ordinary English words, and real sites route
   on `source` (a feed variant, a localized edition, a print view), so
   `https://example.com/item?id=5&source=rss` and `?id=5` were being merged into
   one item. The asymmetry decides it -- failing to merge costs a visible
   duplicate row, while merging two genuinely different documents destroys one
   of them silently and demotes a billed result onto `duplicates`. The spec's
   § Canonicalization paragraph is amended with both halves, and the code
   carries a "must not be added back" note so the next reader does not restore
   the symmetry. Pinned by 'keeps content-selecting parameters that merely look
   like tracking' and its sibling 'still strips vendor click ids that cannot
   select content'.
5. *A snippet is capped at `SNIPPET_MAX_CHARS = 500` in `toRawItem`.* `content`
   is a snippet candidate and the Firecrawl-family backends put a whole page's
   markdown in it, so a 200,000-character snippet was reachable today and a
   `research` round at fanout 8 across such providers emits a multi-megabyte
   `--json` document that no agent can read and every consumer has to buffer.
   500 keeps every genuine SERP snippet (150-300 characters) intact, and the cap
   is per item so the bound holds however many providers answer. Truncation
   appends an ellipsis rather than slicing silently: an unmarked mid-sentence
   cut reads as a broken provider response and sends the next reader hunting a
   bug that is not there. Recorded in the spec under § Adapters. Pinned by
   'truncates an oversized snippet to the declared cap' and, in the other
   direction, 'leaves a snippet inside the cap exactly as it found it'.

---

### Task 5: Per-provider adapter overrides

**Files:**
- Modify: `src/engine/aggregate.ts`
- Test: `tests/aggregate.test.ts`

**Interfaces:**
- Consumes: `RawItem`, `sniffItems` from Task 4.
- Produces: `export type ResponseAdapter = (body: unknown) => RawItem[]`, `export const RESPONSE_ADAPTERS: Record<string, ResponseAdapter>`, `export function extractItems(tool: string, body: unknown): RawItem[]`.

- [ ] **Step 1: Write the failing test**

Extend the header import block of `tests/aggregate.test.ts` (imports belong at
the top of the file, not stranded above the new `describe`) with the adapter
entry points and the `RawItem` type the tests below cast through:

```ts
import { RESPONSE_ADAPTERS, extractItems } from '../src/engine/aggregate.js';
import type { RawItem } from '../src/engine/aggregate.js';
```

Then append the block:

```ts
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

  // The likeliest mistake in a hand-transcribed adapter is not a throw, it is a
  // silent `undefined` return from a shape that did not match. A non-array
  // return used to travel out of here unexamined and become `lane.items`, where
  // `mergeItems`'s `forEach` threw -- destroying EVERY lane's already-billed
  // results, not just the lane with the bad adapter.
  it('falls back to the sniffer when an adapter returns a non-array', () => {
    const original = RESPONSE_ADAPTERS['sloppy_tool'];
    RESPONSE_ADAPTERS['sloppy_tool'] = (() => undefined) as unknown as (body: unknown) => RawItem[];
    try {
      const items = extractItems('sloppy_tool', { results: [{ url: 'https://a.example' }] });
      expect(items).toEqual([{ url: 'https://a.example' }]);
    } finally {
      if (original === undefined) delete RESPONSE_ADAPTERS['sloppy_tool'];
      else RESPONSE_ADAPTERS['sloppy_tool'] = original;
    }
  });

  it('falls back to the sniffer when an adapter returns null', () => {
    const original = RESPONSE_ADAPTERS['null_tool'];
    RESPONSE_ADAPTERS['null_tool'] = (() => null) as unknown as (body: unknown) => RawItem[];
    try {
      expect(extractItems('null_tool', { results: [{ url: 'https://a.example' }] }).length).toBe(1);
    } finally {
      if (original === undefined) delete RESPONSE_ADAPTERS['null_tool'];
      else RESPONSE_ADAPTERS['null_tool'] = original;
    }
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/aggregate.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/aggregate.ts tests/aggregate.test.ts
git commit -m "feat: add per-provider response adapter overrides"
```

**Deviations recorded during implementation.**

The Step 1 and Step 3 blocks above are the corrected code -- they are what
shipped. The change each absorbed, and why, is recorded here.

1. *A non-array adapter return is treated exactly like a throw.* Step 3 guarded
   `adapter(body)` against throwing but returned whatever it produced. Adapters
   are hand-transcribed from captured responses (Task 14), where the likeliest
   mistake is not an exception but `return body.results` on a body that has no
   `results` -- a silent `undefined`. That value became `lane.items`, and
   `mergeItems`'s `forEach` then threw a `TypeError` that escaped the whole
   merge and discarded EVERY lane's already-paid-for results, not just the lane
   with the bad adapter -- the precise opposite of the trade this function's own
   docstring argues for. Now `const out: unknown = adapter(body); return
   Array.isArray(out) ? out : sniffItems(body)`, which is a type guard as much
   as a value check: `RawItem[]` is a compile-time promise an adapter is under
   no runtime obligation to keep. Pinned by 'falls back to the sniffer when an
   adapter returns a non-array' and '... returns null'.

---

### Task 6: Dedup and reciprocal rank fusion

**Files:**
- Modify: `src/engine/aggregate.ts`
- Test: `tests/aggregate.test.ts`

**Interfaces:**
- Consumes: `RawItem`, `canonicalizeUrl` from Task 4.
- Produces: `ProviderHit` (`{ backendId, rank, resultRank }`), `ResearchItem`, `LaneItems` (`{ backendId, rank, items }`), `RRF_K`, `export function mergeItems(lanes: readonly LaneItems[], seenUrls?: ReadonlySet<string>): { items: ResearchItem[]; suppressed: number }`.

- [ ] **Step 1: Write the failing test**

Extend the header import block of `tests/aggregate.test.ts` (imports belong at
the top of the file, not stranded above the new `describe`) so it reads:

```ts
import { RRF_K, SNIPPET_MAX_CHARS, canonicalizeUrl, mergeItems, sniffItems } from '../src/engine/aggregate.js';
import { RESPONSE_ADAPTERS, extractItems } from '../src/engine/aggregate.js';
import type { LaneItems, RawItem } from '../src/engine/aggregate.js';
```

Then append the helper and the block:

```ts
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

  // The lane order is the whole point of this sibling test: with the decorated
  // URL first it is captured by the object literal's `duplicates` initializer
  // and the merge branch's push never runs. A later provider's original URL has
  // to survive too, or a fan-out silently drops provenance for every provider
  // that was not first to report a document -- the common case, since providers
  // disagree about decoration far more often than about which page exists.
  it("preserves a later provider's original URL on duplicates too", () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://example.com/a']]),
      lane('exa', 2, [['https://www.example.com/a?utm_source=x']]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.duplicates).toEqual(['https://www.example.com/a?utm_source=x']);
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

  // The collapse is a judgement call, so what makes it safe is that nothing is
  // discarded: every source URL lands on `duplicates` and every contributing
  // provider on `providers` -- which is also what keeps the RRF score and Task
  // 7's agreement arithmetic correct for a merged item. Counting the survivors
  // is not enough; these are the assertions that fail if either push is lost.
  it('keeps every source URL and every provider when it collapses across hosts', () => {
    const { items } = mergeItems([
      { backendId: 'you', rank: 1, items: [{ url: 'https://a.example/s?utm_source=q', title: 'Wire Story' }] },
      { backendId: 'exa', rank: 2, items: [{ url: 'https://b.example/s', title: 'wire story!', snippet: 'sn', publishedAt: '2026-01-02' }] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.providers.map((p) => p.backendId).sort()).toEqual(['exa', 'you']);
    expect(items[0]?.duplicates).toEqual(
      expect.arrayContaining(['https://a.example/s?utm_source=q', 'https://b.example/s']),
    );
    expect(items[0]?.snippet).toBe('sn');
    // `publishedAt` is asserted alongside `snippet` because the two enrichment
    // lines are one rule, and a date lost in the collapse is not cosmetic: it is
    // the recency signal downstream consumers read off a merged item.
    expect(items[0]?.publishedAt).toBe('2026-01-02');
    expect(items[0]?.score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it('does not collapse an identical title on the same host', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://one.example/a', 'Docs'], ['https://one.example/b', 'Docs']]),
    ]);
    expect(items).toHaveLength(2);
  });

  // The same-host guard has to hold against every host already folded under a
  // title, not just the representative's: with a cross-host item claiming the
  // key first, checking only the representative lets the two one.example pages
  // merge with each other through it.
  it('does not collapse two same-host pages transitively through a cross-host twin', () => {
    const { items } = mergeItems([
      lane('you', 1, [
        ['https://two.example/x', 'Docs'],
        ['https://one.example/a', 'Docs'],
        ['https://one.example/b', 'Docs'],
      ]),
    ]);
    expect(items).toHaveLength(2);
  });

  // An unparseable URL carries no host evidence, so it must never satisfy the
  // cross-host condition. Returning the URL itself as a stand-in host makes the
  // guard trivially true -- each item sits under a distinct canonical URL, so a
  // fabricated host never collides -- and these three site-relative paths, the
  // exact shape a SERP-scraping backend emits, collapse into one, demoting two
  // billed results to `duplicates`.
  it('never collapses same-title pages whose URLs carry no host evidence', () => {
    const { items } = mergeItems([
      lane('you', 1, [['/news/1', 'Docs'], ['/news/2', 'Docs'], ['/news/3', 'Docs']]),
    ]);
    expect(items).toHaveLength(3);
  });

  // The other half of "no host evidence", and the half a catch block cannot
  // reach: an opaque-scheme value parses *successfully* and yields hostname '',
  // so it never touches the catch branch above. '' is a live Set member, so
  // treating it as a host makes it differ from every real hostname and satisfies
  // the cross-host guard on evidence we do not have. A doc id is a named input --
  // `canonicalizeUrl`'s docstring lists it beside the relative path -- and the
  // http item is here to prove the leak in the direction that loses a result:
  // without the fix `doc:1234` is demoted onto the http item's `duplicates`.
  it('never collapses same-title pages whose URLs parse but carry no host', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://a.example/story', 'Docs'], ['doc:1234', 'Docs'], ['doc:5678', 'Docs']]),
    ]);
    expect(items).toHaveLength(3);
  });

  // An ASCII-only title key reduces any non-Latin title to '', which is a live
  // Map key -- so unrelated articles in Russian, Chinese and Japanese would all
  // collapse into one item, silently discarding billed results.
  it('keeps unrelated non-Latin titles on different hosts apart', () => {
    const { items } = mergeItems([
      lane('you', 1, [
        ['https://ru.example/1', 'Новости дня'],
        ['https://cn.example/2', '中国新闻'],
        ['https://jp.example/3', '日本のニュース'],
      ]),
    ]);
    expect(items).toHaveLength(3);
  });

  it('keeps titles that reduce to nothing apart, since an empty key is no evidence of sameness', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://a.example/1', '!!!'], ['https://b.example/2', '???']]),
    ]);
    expect(items).toHaveLength(2);
  });

  it('still collapses the same non-Latin title across hosts', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://ru-a.example/1', 'Новости дня!']]),
      lane('exa', 2, [['https://ru-b.example/2', 'новости дня']]),
    ]);
    expect(items).toHaveLength(1);
  });

  // A URL-only first contributor leaves the URL standing in as the title; a real
  // title from a later provider has to win, or the merged item shows a raw URL
  // to the reader and is skipped by the cross-host collapse pass entirely.
  //
  // `snippet` and `publishedAt` are asserted here rather than in a test of their
  // own because they are the same "keep the richest text" rule the title obeys,
  // and they share its rationale comment in the source. Without them a
  // text-less first contributor starves the item permanently, which would again
  // make the merged output depend on which lane happened to arrive first.
  it('upgrades a placeholder title when a later provider supplies a real one', () => {
    const { items } = mergeItems([
      { backendId: 'you', rank: 1, items: [{ url: 'https://example.com/a' }] },
      { backendId: 'exa', rank: 2, items: [{ url: 'https://example.com/a', title: 'Real Title', snippet: 's', publishedAt: '2026-01-02' }] },
    ]);
    expect(items[0]?.title).toBe('Real Title');
    expect(items[0]?.snippet).toBe('s');
    expect(items[0]?.publishedAt).toBe('2026-01-02');
  });

  it('suppresses already-seen URLs and reports how many', () => {
    const { items, suppressed } = mergeItems(
      [lane('you', 1, [['https://old.example'], ['https://new.example']])],
      new Set(['https://old.example']),
    );
    expect(items.map((i) => i.url)).toEqual(['https://new.example']);
    expect(suppressed).toBe(1);
  });

  // `suppressed` is a count of documents withheld, not of lane hits: the same
  // seen page returned by two providers is still one page the caller did not get.
  it('counts a suppressed page once however many providers returned it', () => {
    const { items, suppressed } = mergeItems(
      [
        lane('you', 1, [['https://old.example'], ['https://new.example']]),
        lane('exa', 2, [['https://www.old.example/?utm_source=z']]),
      ],
      new Set(['https://old.example']),
    );
    expect(items.map((i) => i.url)).toEqual(['https://new.example']);
    expect(suppressed).toBe(1);
  });

  // Equal `resultRank` across two lanes is the only way to produce identical RRF
  // scores, and so the only input that reaches the comparator's second clause --
  // two items within one lane always differ by rank. Asserting the concrete
  // order, not just that two calls agree: a pure function agrees with itself
  // even with the tie-break deleted.
  // `providers` carries one entry per backend, and RRF depends on it: the
  // spec's ordering rationale is "appearing high on several lists beats
  // appearing first on one", so a backend counted twice reads as agreement
  // between two providers that does not exist. A lane returning the same
  // document twice (pagination, a decorated duplicate) is the cheap way to
  // reach it.
  it('counts one backend once when its own lane returns the same document twice', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://example.com/a'], ['https://www.example.com/a?utm_source=x']]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.providers).toHaveLength(1);
    // The best (lowest) resultRank survives, so a document a provider ranked
    // first is not demoted by the same provider also listing it further down.
    expect(items[0]?.providers[0]?.resultRank).toBe(1);
    expect(items[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  // The other route to a duplicated backend, and the one that pays best: pass 2
  // folds every same-title item into the representative, including several from
  // a single lane.
  it('counts one backend once when the cross-host title collapse folds three of its own results', () => {
    const { items } = mergeItems([
      lane('you', 1, [
        ['https://a.example/s', 'Wire Story'],
        ['https://b.example/s', 'Wire Story'],
        ['https://c.example/s', 'Wire Story'],
      ]),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.providers).toHaveLength(1);
    expect(items[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  // The ordering consequence, stated as the spec states it: real agreement
  // between two providers must outrank one provider's own redundancy. Before
  // the distinct-backend fusion the single-lane triple scored 0.0484 against
  // the genuine pair's 0.0328 and took the top slot.
  it('ranks a genuine two-provider agreement above one provider repeating itself', () => {
    const { items } = mergeItems([
      lane('you', 1, [
        ['https://a.example/s', 'Wire Story'],
        ['https://b.example/s', 'Wire Story'],
        ['https://c.example/s', 'Wire Story'],
        ['https://real.example/x', 'Genuine Agreement'],
      ]),
      lane('exa', 2, [['https://real.example/x', 'Genuine Agreement']]),
    ]);
    expect(items[0]?.url).toBe('https://real.example/x');
    expect(items[0]?.providers.map((p) => p.backendId).sort()).toEqual(['exa', 'you']);
  });

  // An adapter is hand-transcribed from a captured response, so an item missing
  // the one field the whole pipeline keys on is a live possibility. Such an item
  // used to be scored and emitted with `url: undefined`, violating
  // `ResearchItem.url: string` inside the output document -- worse than a throw,
  // because nothing announces it.
  it('skips an item whose url is missing or empty rather than emitting one with no url', () => {
    const { items } = mergeItems([
      {
        backendId: 'you',
        rank: 1,
        items: [
          { title: 'no url' } as unknown as RawItem,
          { url: '   ', title: 'blank url' },
          { url: 42 } as unknown as RawItem,
          { url: 'https://real.example/a', title: 'Real' },
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('https://real.example/a');
  });

  it('breaks score ties on canonical URL for determinism', () => {
    const { items } = mergeItems([
      lane('you', 1, [['https://b.example']]),
      lane('exa', 2, [['https://a.example']]),
    ]);
    expect(items[0]?.score).toBe(items[1]?.score);
    expect(items.map((i) => i.url)).toEqual(['https://a.example', 'https://b.example']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/aggregate.test.ts`
Expected: FAIL — `mergeItems` and `RRF_K` are not exported.

- [ ] **Step 3: Implement merging**

Append to `src/engine/aggregate.ts`:

```ts
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
    lane.items.forEach((raw, index) => {
      // `RawItem.url` is a compile-time promise, and an adapter is the one
      // producer that can break it: hand-written from a captured response, it
      // may hand back rows whose url key was named something else. Such a row
      // used to be scored and emitted with `url: undefined` -- violating
      // `ResearchItem.url: string` inside the output document, standing in as
      // the Map key and the placeholder title, and announcing nothing. Skipped
      // rather than repaired, because an item with no URL cannot be deduped,
      // cited or fetched; the index still advances, so the surviving items keep
      // the provider's own ranking.
      if (typeof raw.url !== 'string' || raw.url.trim() === '') return;
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- tests/aggregate.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/aggregate.ts tests/aggregate.test.ts
git commit -m "feat: dedup merged results and order them by reciprocal rank fusion"
```

**Deviations recorded during implementation.**

The Step 1 and Step 3 blocks above are the corrected code -- they are what
shipped, and what a reader rebuilding this task should build against. The
changes each block absorbed, and why, are recorded here so implementation can
still be reviewed against intent.

1. *`titleKey` retains the Unicode letter/number properties, not `[a-z0-9]`.*
   Step 3 originally prescribed `replace(/[^a-z0-9\s]/g, '')`. That class does
   not merely fail to normalize a non-Latin title, it erases it: every Cyrillic,
   CJK, Arabic, Greek and Hebrew title reduces to `''`. `''` is a perfectly
   usable Map key, so a round returning a Russian, a Chinese and a Japanese
   article about three unrelated subjects collapsed all three into one item and
   demoted two billed results to `duplicates` -- silent data loss, and worst
   exactly where the cross-host pass is most valuable (one wire story carried by
   outlets in several scripts). Now `/[^\p{L}\p{N}\s]/gu`; the target is ES2023,
   so property escapes cost no dependency and no transpile step. Pinned by
   'keeps unrelated non-Latin titles on different hosts apart' and, in the other
   direction, 'still collapses the same non-Latin title across hosts'.
2. *A title that reduces to nothing is rejected as a merge key explicitly.*
   Fixing (1) narrows the degenerate case but does not remove it -- a title of
   pure punctuation (`'!!!'`) still reduces to `''`, as does an item still
   carrying its own URL as a placeholder title. Since `''` is a live Map key,
   "reduces to nothing" has to be tested for rather than trusted to be absent,
   so the key is now `undefined` in that case and the item merges with nothing.
   An empty reduction is no evidence of sameness; it is the absence of evidence.
   Pinned by 'keeps titles that reduce to nothing apart'.
3. *The cross-host guard holds a `Set` of every host folded under a key, not the
   representative's host alone.* Step 3 compared `hostOf(item.url)` against the
   representative only. That is not a weaker guard, it is a broken one: with a
   cross-host item claiming the key first, two pages on a single site each
   differ from the representative and so merge with each other transitively,
   through it. Which pages survived then depended on Map iteration order -- precisely
   the destruction of real results the pass exists to avoid. Pinned by 'does not
   collapse two same-host pages transitively through a cross-host twin'.
4. *Pass 1 upgrades `title`, not only `snippet` and `publishedAt`.* Step 3 left
   the title alone, so a title-less first contributor's placeholder (the
   canonical URL) stood permanently: the reader saw a raw URL, and pass 2 skipped
   the item entirely because its title equals its URL. The dedup outcome
   therefore depended on which lane happened to arrive first, which is not a
   property this function may have. Pinned by 'upgrades a placeholder title when
   a later provider supplies a real one'.
5. *`suppressed` counts documents, via a `Set`, not lane hits via a counter.*
   Step 3's `suppressed += 1` per skipped lane hit multiplied the figure by the
   fan-out width: one already-seen page returned by three providers was reported
   as three suppressed pages. The number the caller reads is "pages you already
   had and so did not get again", and the fan-out width is not what they asked
   about. Pinned by 'counts a suppressed page once however many providers
   returned it'.
6. *The tie-break test constructs a genuine tie and asserts a concrete order.*
   Step 1's original compared two `mergeItems` calls against each other, which a
   pure function satisfies with the comparator's second clause deleted, and its
   input could not produce equal scores anyway -- two items in one lane always
   differ by `resultRank`. Equal `resultRank` across two lanes is the only input
   that reaches that clause, so the test now uses one and asserts the resulting
   URL order outright.
7. *The new test imports are hoisted into the file's header block* rather than
   stranded mid-file above the new `describe`, matching every other test file.
8. *`hostOf` returns `string | undefined`, and an unknown host is never
   mergeable.* Step 3 returned the whole `url` from the catch. Because every
   item sits under a distinct canonical URL, a fabricated host is unique by
   construction, so `entry.hosts.has(host)` could never be true for it and the
   same-host guard was disabled outright for any URL the parser rejects -- the
   same silent data loss as (3), reached by another route, and hitting exactly
   the case the guard protects. Relative hrefs are an acknowledged input, not a
   hypothesis: `canonicalizeUrl`'s docstring names them and the SERP-scraping
   backends emit them. "No host evidence" is now a first-class state, mirroring
   the degenerate title key of (2): such an item neither joins a key nor claims
   one. Pinned by 'never collapses same-title pages whose URLs carry no host
   evidence'.
9. *The cross-host collapse's preservation invariant is asserted, not just the
   survivor count.* The two original cross-host tests checked only
   `toHaveLength(1)`, so both the `providers` and the `duplicates` push inside
   the collapse could be deleted with the suite still green -- leaving the
   spec's § Dedup guarantee ("nothing is lost, only grouped") unconstrained, and
   silently corrupting the merged item's RRF score and Task 7's provider-
   agreement arithmetic. 'keeps every source URL and every provider when it
   collapses across hosts' now pins the surviving providers, duplicates,
   enriched snippet and fused score together.
10. *`hostOf` treats an empty hostname as no host, not as a host.* Item (8)
    closed only the throwing path, and that is half the input class its own
    justification cites: `canonicalizeUrl`'s docstring names "a doc id, a
    relative path" in one sentence, and only the relative path throws.
    `new URL('doc:1234')` parses successfully and yields hostname `''` -- as do
    `mailto:`, `urn:`, `data:` and `file:` -- so `''` was returned as a *known*
    host, differing from every real hostname and satisfying the cross-host guard
    on evidence we do not have. Exactly the fabricated-evidence failure of (8),
    reached without ever throwing, and the module's own pass-2 comment already
    forbade it. Damage was bounded but real: with one http item and two doc ids
    sharing a title, the second doc id found `''` already in `entry.hosts` and
    was spared, while the first was demoted onto the http item's `duplicates`,
    folding its provider hit into an unrelated document's RRF score and into
    Task 7's agreement arithmetic. `hostOf` now returns `undefined` for `''`,
    and both its docstring and pass 2's say "carries no host" rather than
    "unparseable", so they cover the non-throwing case too. Pinned by 'never
    collapses same-title pages whose URLs parse but carry no host'.
11. *The pass-1 `duplicates` merge branch and both `publishedAt` enrichments are
    asserted.* A sweep that deleted each conditional in `mergeItems` in turn
    found four production lines that survived the whole suite. The round-1
    report's claim that the pass-1 `duplicates` push was already covered by
    'preserves every original URL on duplicates' was mistaken: that test puts
    the decorated URL on the FIRST lane, where it is captured by the object
    literal's `duplicates: raw.url === canonical ? [] : [raw.url]` initializer,
    so the merge branch never runs. Lane order is therefore the whole substance
    of the new sibling test -- with the decorated URL arriving second, the spec's
    § Canonicalization guarantee ("the original URL survives on `duplicates`")
    finally binds for a provider that was not first to report a document, which
    in a fan-out is the common case. The pass-1 `snippet`/`publishedAt` lines
    left the "keep the richest text" rule unconstrained in both directions
    despite its four-line rationale comment, and the pass-2 `publishedAt` line
    was the twin of the snippet line (9) pinned; `publishedAt` carries the
    recency signal downstream, so losing it in a collapse is not cosmetic.
    Assertions were added to the existing tests that already fed the right
    inputs -- 'upgrades a placeholder title when a later provider supplies a real
    one' and 'keeps every source URL and every provider when it collapses across
    hosts' -- rather than to new ones, keeping each rule pinned beside the rule
    it shares a comment with. All four lines, and (10)'s, were verified by
    deletion: each now turns the suite red.
12. *RRF fuses over DISTINCT backends: `ProviderHit[]` now carries at most one
    entry per `backendId`, holding that backend's best (lowest) `resultRank`.*
    Two paths let one lane enter `item.providers` several times -- a provider
    returning the same canonical URL twice (pagination, a decorated duplicate),
    and pass 2 folding several of one lane's same-title items into the
    representative -- and the score summed over hits rather than over lists.
    Measured on the shipped code: one provider's three same-title results scored
    0.0484 and outranked a genuine two-provider agreement at 0.0328. That
    inverts the spec's stated ordering rationale ("appearing high on several
    lists beats appearing first on one, which makes provider agreement a ranking
    signal for free") by reading one provider's redundancy as agreement, and it
    would have inflated Task 7's `agreementMedian` -- which reads the same array
    -- suppressing the follow-up commands a caller depends on to know another
    round is worth paying for. The invariant is stated on `ProviderHit` and
    enforced at both push sites through one helper, `recordHit`, rather than by
    deduping at the scoring step: the array is read by more than the score, so
    it has to be right, not merely summed correctly. The best rank wins because
    that is what the RRF term means -- a provider that listed a page first and
    again at position 9 ranked it first -- and `rank` moves with `resultRank` so
    the surviving hit is one provider's actual answer rather than a splice of
    two. Pinned by three tests: one per duplication path, plus the ordering
    consequence stated as the spec states it. Fixing this before Task 7 rather
    than after is deliberate; afterwards it would have to be fixed twice.
13. *An item whose `url` is not a non-empty string is skipped, not scored.* An
    adapter returning `[{title:'no url'}]` produced a ranked `ResearchItem` with
    `url: undefined` -- violating the declared `ResearchItem.url: string` inside
    the emitted document, standing in as the Map key and the placeholder title,
    and announcing nothing. Worse than the `TypeError` of Task 5's deviation,
    because nothing announces it. Skipped rather than repaired: an item with no
    URL cannot be deduped, cited or fetched. The lane index still advances, so
    surviving items keep the provider's own ranking. Pinned by 'skips an item
    whose url is missing or empty rather than emitting one with no url'.
14. *`mergeItems`'s docstring states the lane-ordering requirement it imposes on
    its caller.* Both passes make the first-seen item the representative, so
    which of two merged URLs survives is decided by lane position: swapping two
    lanes flips the surviving URL. The function is pure and deterministic given
    its argument, and its header said so honestly -- but nothing told the caller
    that appending lanes in COMPLETION order, which is exactly what a bounded
    concurrency pool does by default, makes the output document a race. Sorting
    inside `mergeItems` was rejected: a lane's identity is `(query, diversity
    rank)` and this module is deliberately not told about queries. Documented
    here and in the spec's § Dedup so Task 9 has to satisfy it, with its own
    test named in Task 9's step list. No code change, and so no failing-first
    test -- the behaviour being documented is the current behaviour.

Items 1-7 came from code review of the first Task 6 implementation; items 8 and
9 from review of that round of fixes; items 10 and 11 from review of the round
after that; items 12-14 from the comprehensive final review of Tasks 1-6.

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
  if (input.droppedQueries.length > 0) gaps.push(`not run (call budget): ${input.droppedQueries.join(', ')}`);
  // Deliberately not "call budget": this list carries both targets dropped on
  // the budget AND targets whose fetch failed, and a label naming only one
  // cause would misreport the other.
  if (input.unfetchedTargets.length > 0) gaps.push(`not fetched: ${input.unfetchedTargets.join(', ')}`);
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
    droppedQueries: [...input.droppedQueries],
    unfetchedTargets: [...input.unfetchedTargets],
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
export function nextActions(coverage: Coverage, sessionId: string | undefined): NextAction[] {
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
  for (const query of coverage.droppedQueries) {
    actions.push({ why: 'not run: call budget', cmd: `fezoctl research ${shellQuote(query)}${session}` });
  }
  for (const target of coverage.unfetchedTargets) {
    // `--session` is deliberately absent: `scrape` is a one-step command and
    // takes no session flag.
    actions.push({ why: 'not fetched', cmd: `fezoctl scrape ${shellQuote(target)}` });
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

**Deviations recorded during implementation.**

The Step 3 block above is the corrected code -- it is what shipped, and what a
reader rebuilding this task should build against. The changes it absorbed, and
why, are recorded here so implementation can still be reviewed against intent.

1. *Host-less URLs are excluded from the concentration tally AND its
   denominator.* Step 3 originally wrote `hosts.set(host, ...)` directly on
   `hostOf(item.url)`, which does not typecheck against the `hostOf(url): string
   | undefined` repaired under Task 6 -- a reader building Task 7 from the
   uncorrected block gets a `tsc` failure on the first run. Skipping such an
   item is the only reading that keeps the metric honest: a URL carrying no host
   evidence can never win the numerator, so counting it in the denominator would
   do nothing but dilute a real concentration signal with results this metric
   cannot see.
2. *Every interpolated value in a `cmd` is single-quoted.* Step 3 built the
   commands as `research "${q.query}"` and `scrape ${target}`. Both ingredients
   are untrusted -- a query is the user's prompt minus its URLs
   (`heuristic.ts`'s `residual`), a target is whatever matched `URL_PATTERN` in
   that prompt -- so the spec's "literal, ready-to-run `cmd`" was not literal:
   `best $100 keyboards` ran as `best 00 keyboards` (the follow-up round
   searches for, and bills for, the wrong thing), `27" monitor` left an
   unterminated string, a backtick reached command substitution, and an
   unquoted `https://ex.com/p?a=1&b=2` lost `&b=2` and backgrounded the job
   under bash while failing zsh's globbing outright. A local `shellQuote` fixes
   all three sites. The session id is deliberately left bare: it is validated
   against `/^[A-Za-z0-9._-]{1,64}$/` at parse time (§ Session state) because it
   becomes a filename, so it holds nothing a shell reacts to -- and leaving it
   bare keeps `--session r-42` greppable in output. Pinned by 'quotes a query so
   the shell cannot expand, split or truncate it', 'quotes a dropped query and
   an unfetched target', and 'emits commands a POSIX shell parses back into the
   exact arguments' (which runs the emitted strings through `/bin/sh` and
   compares argv).
3. *A `why` mirrors its gap's three-way branch instead of saying "is thin" for
   every non-empty query.* The gap text distinguishes "returned no results" /
   "is thin" / "has no cross-provider agreement", but `why` collapsed the last
   two, so a query with four unique URLs and no corroboration was labelled thin
   in the very line sitting next to the gap that says otherwise. The two fields
   describe the same query to the same reader; disagreeing sends the agent after
   the wrong remedy. Pinned by 'says why a well-populated query still needs
   another round'.
4. *The returned `Coverage` copies the input's arrays rather than aliasing
   them.* `computeCoverage(input)` reads as pure and its result is a finished
   report handed onward; returning `input.served` et al by reference (and
   `failed`'s elements by identity) meant a `push` on either side rewrote the
   other's history. Pinned by 'does not alias the caller arrays it was handed'.

*Text no test asserts yet*, left for the Task 9 wiring that first supplies these
inputs from a real round: the domain-concentration gap text (`N% of results are
from <host>`, which needs `share > 0.6` and `total >= 5`, so the concentration
test's three items never trip it), the `not fetched: ...` gap line (executed by
the quoting test but not asserted), and the `fezoctl providers --intent search`
failure action. The `agreementMedian <= 1` gap branch and the `scrape` action
are now both pinned by the tests added above.

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

  // `mergeItems` makes the FIRST-SEEN item the representative of a merge, so
  // the lane array's order decides which of two cross-host twins appears in the
  // output document. A bounded pool completes lanes in whatever order the
  // network answers, so the executor must slot lanes by diversity rank, not
  // append them on completion -- otherwise this round's document is a race.
  // Delaying the first lane is the whole test: with appending, `you`'s URL wins
  // when it answers first and `exa`'s wins when it answers second.
  it('orders lanes by plan position, not by which provider answered first', async () => {
    const slow = async (body: Response, ms: number): Promise<Response> =>
      new Promise((resolve) => setTimeout(() => resolve(body), ms));
    const run = async (delayYou: number): Promise<string | undefined> => {
      const fetchFn = vi.fn(async (url: string | URL) => {
        const asString = String(url);
        if (asString.includes('/v1/you/')) return slow(results(['https://you.example/s']), delayYou);
        if (asString.includes('/v1/exa/')) return results(['https://exa.example/s']);
        return results([]);
      }) as unknown as typeof fetch;
      const outcome = await runResearch({
        plan: plan({ fanout: 2 }), candidates: CANDIDATES, excluded: [],
        gateway: { ...gateway, fetchFn },
      });
      return outcome.items[0]?.url;
    };
    expect(await run(20)).toBe(await run(0));
  });

  // The one-entry-per-backend invariant on `ProviderHit` (aggregate.ts) has to
  // survive the cross-query union: one backend answering two sub-queries with
  // the same document is one provider, not two agreeing.
  it('counts a backend once when it returns the same document for two queries', async () => {
    const fetchFn = routedFetch({
      you: [results(['https://same.example/a']), results(['https://same.example/a'])],
      exa: [results([]), results([])],
      brave: [results([]), results([])],
    });
    const outcome = await runResearch({
      plan: plan({ queries: ['one', 'two'] }), candidates: CANDIDATES, excluded: [],
      gateway: { ...gateway, fetchFn },
    });
    const item = outcome.items.find((i) => i.url === 'https://same.example/a');
    expect(item?.providers.filter((p) => p.backendId === 'you')).toHaveLength(1);
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
  // Sparse by design: a lane writes its own slot (see the write below), so a
  // failed lane leaves a hole rather than shifting its neighbours.
  const laneItemsByQuery = new Map<string, Array<LaneItems | undefined>>();
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
      // Written into the lane's OWN slot, never appended: the pool completes
      // lanes in whatever order the network answers, and `mergeItems` makes the
      // first-seen item the representative of a merge (its docstring says so in
      // as many words), so appending would let a race decide which of two
      // merged URLs appears in the output document. Slotting by diversity rank
      // makes the array plan-ordered whatever the completion order was. Holes
      // (failed lanes) are compacted at the read below.
      const list = laneItemsByQuery.get(query) ?? [];
      list[lane.rank - 1] = { backendId: lane.backendId, rank: lane.rank, items };
      laneItemsByQuery.set(query, list);
    }),
  );

  await pool(tasks, concurrency, () => aborted !== undefined);

  const seen = options.seenUrls ?? new Set<string>();
  const perQuery: Array<{ query: string; items: ResearchItem[] }> = [];
  let suppressed = 0;
  for (const { query } of planned) {
    const laneItems = (laneItemsByQuery.get(query) ?? []).filter((l): l is LaneItems => l !== undefined);
    const merged = mergeItems(laneItems, seen);
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
      if (existing === undefined) {
        attributionByUrl.set(item.url, item);
        continue;
      }
      // `ProviderHit`'s one-entry-per-backend invariant holds across the
      // cross-query union too, and this is the third place that can break it:
      // one backend serving two sub-queries that both returned this document is
      // still one provider agreeing once, and a plain `push(...)` would score
      // the fan-out's own breadth as agreement. Best (lowest) `resultRank`
      // wins, exactly as aggregate.ts's `recordHit` does it -- export that
      // helper rather than keeping this copy if a fourth site ever appears.
      for (const hit of item.providers) {
        const held = existing.providers.find((p) => p.backendId === hit.backendId);
        if (held === undefined) existing.providers.push(hit);
        else if (hit.resultRank < held.resultRank) { held.rank = hit.rank; held.resultRank = hit.resultRank; }
      }
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
# Full URLs, not bare domains: the heuristic detects http(s) URLs only, on the
# stated ground that a bare "vercel.com" is more often a topic than a fetch
# target and guessing wrong spends a call on the wrong intent. A bare-domain
# prompt correctly plans as a search.
node dist/fezoctl.mjs plan "compare https://vercel.com/pricing and https://netlify.com/pricing"
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
