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

  // The budget invariant has to hold on this function's OWN output, not only
  // once `mergePlan` has run: nothing in the type system says a caller reaches
  // the merge, and a 500-query plan at fanout 10 implies 5000 billed calls.
  it('returns a plan already inside the call budget, not one that relies on a later merge', () => {
    const parsed = parsePlanJson({
      queries: Array.from({ length: 500 }, (_, i) => `q${i}`),
      fanout: MAX_FANOUT,
    });
    expect(impliedCalls(parsed)).toBeLessThanOrEqual(MAX_RESEARCH_CALLS);
    expect(parsed.queries.length).toBeGreaterThan(0);
  });

  // The nothing-to-do check counts what would actually be run. Counting raw
  // array length instead let a whitespace-only query pass here and then be
  // stripped, producing exactly the empty round at exit 0 the check exists for.
  it('rejects a plan whose only queries are whitespace', () => {
    expect(() => parsePlanJson({ queries: ['   ', '\t'] })).toThrow(/queries/);
    expect(() => parsePlanJson({ queries: ['   '], targets: [' '] })).toThrow(/targets/);
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
