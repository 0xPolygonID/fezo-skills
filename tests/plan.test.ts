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

  it('does not alias its input', () => {
    const base = plan({ signals: ['heuristic: search'] });
    const clamped = clampPlan(base);
    expect(clamped).not.toBe(base);
    expect(clamped.signals).not.toBe(base.signals);
    expect(clamped.signals).toEqual(['heuristic: search']);
  });
});
