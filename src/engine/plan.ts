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
 *
 * The completed plan is clamped BEFORE that check, and the returned plan is the
 * clamped one, so this function's own output holds the invariant the module
 * documents rather than borrowing it from a `mergePlan` call that may or may
 * not follow. Two things follow from the order. A plan with 500 queries is
 * bounded here instead of arriving at the check looking busy; and a plan whose
 * only query is whitespace (`{"queries":["   "]}`) is caught, because the check
 * now counts what would actually be run -- it used to count raw array length,
 * pass, and then clamp to the empty round it exists to prevent.
 *
 * Clamping rather than rejecting an over-large `queries`, where `fanout` is
 * rejected: the two are not the same mistake. `{"fanout":9999}` names a round
 * width that does not exist and is certainly a typo, while a long query list is
 * a caller asking for more than the budget buys -- the same thing the planner
 * and flag paths ask for, and the truncation rule (`clampPlan`'s docstring:
 * whole queries first, targets kept) exists precisely to answer it.
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
  const plan = clampPlan({
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
  });
  // A plan with neither queries nor targets can never do anything, and because
  // this object replaces the planner's, accepting one would wipe the
  // heuristic's queries and produce an empty round at exit 0 -- exactly the
  // "round the caller did not ask for" that PLAN_SCHEMA is closed to prevent,
  // only quieter. Read off the CLAMPED plan, so a query that is only whitespace
  // counts as the nothing it is rather than passing here and being stripped a
  // moment later. The message spells out the replace-not-merge semantics
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
 * `mergePlan` and `parsePlanJson` both apply this to everything they return, so
 * every plan this module hands out holds the bound BY CONSTRUCTION rather than
 * by a caller remembering -- which is what the previous docstring claimed and
 * no code did. It is idempotent, so applying it again anywhere is free, which
 * is what lets both entry points own it without either having to know whether
 * the other already ran.
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
