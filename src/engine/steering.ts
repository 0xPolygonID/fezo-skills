// Agent/user-facing prose for the one-step commands (`web-search`, `scrape`,
// `crawl`): their one-line descriptions and the routing-note sentences a
// finished walk appends to its result. Ported from mcp-server/src/steering.ts's
// `DESCRIPTIONS` + `successFooter`/`failureFooter`, reworded for a CLI (no MCP
// tool names, no "prefer this over a built-in" framing -- fezoctl has no
// competing built-in to out-argue).
//
// Reason this module exists at all, same as mcp-server's: the same sentences
// appear in more than one place -- HELP_TEXT (cli.ts) and the generated
// skills/fezo/SKILL.md -- and a hand-copied sentence drifts the moment one of
// them is edited without the other. Keeping the copy in one place makes "these
// agree" assertable as a test over data (tests/skill_contract.test.ts asserts
// the committed SKILL.md still contains every `ONE_STEP_DESCRIPTIONS` value),
// not something a reviewer has to notice by re-reading prose.
//
// Why the description text itself sits in `./one-step-descriptions.json`
// rather than as string literals below: SKILL.md is produced by
// `build/gen-skill.mjs`, a plain Node script that cannot import TypeScript.
// A `.json` file is the one format both this module (via `resolveJsonModule`,
// bundled inline by esbuild so the shipped artifact stays single-file) and
// that generator can read from the SAME bytes. Everything ABOUT the prose --
// why it is worded this way, who reads it -- stays here, next to the export.
//
// NOT everything a one-step command's output says lives here: the "no
// provider could serve this" message, the arg-rejected note, and the
// attempt-cap note are all built inline in render.ts's `renderOneStep`, on the
// same principle mcp-server's steering.ts states for its own inline notes --
// they are assembled from data (`skipped`, `argRejected`, `stoppedBy`) that is
// this port's presentation layer's job to have, not this module's.

import type { Intent } from './intent.js';
// The shared bytes `build/gen-skill.mjs` also reads; see the module comment
// above for why this one table lives in JSON rather than in this file.
import oneStepDescriptions from './one-step-descriptions.json' with { type: 'json' };

/**
 * Routing note for a *successful* one-step result: which provider answered,
 * and at what rank, so a caller who wants a different one (or a capability a
 * one-step command doesn't cover) knows the next command to reach for.
 *
 * `rank` is always a concrete number here, unlike mcp-server's
 * `successFooter(displayName, intent, rank: number | null)`: mcp-server's
 * `rank` can be `null` for a caller that names a provider directly (bypassing
 * the ranked walk entirely, a code path this port has no equivalent of --
 * every one-step served result comes out of `one-step.ts`'s `buildWalk`,
 * which always resolves a rank from `viewForIntent` before a candidate is
 * even attempted). See one-step.ts's `WalkStep.rank` doc for where that number
 * comes from.
 */
export function successFooter(provider: string, intent: Intent, rank: number): string {
  return (
    `Served by ${provider} (rank ${String(rank)} of ${intent}). For a different provider, more ` +
    `options, or a capability no one-step command covers (news, social, proxy), run ` +
    `\`fezoctl providers --intent ${intent}\`.`
  );
}

/**
 * Routing note for a one-step result where the last-tried provider itself
 * failed (as opposed to never being reachable at all -- see render.ts's
 * "no provider could serve" message for that case). Names the ranked list
 * rather than dwelling on the failure, so the next move stays inside fezoctl.
 */
export function failureFooter(provider: string, intent: Intent, rank: number): string {
  return (
    `${provider} failed (rank ${String(rank)} of ${intent}). Run \`fezoctl providers --intent ${intent}\` ` +
    'for the remaining ranked providers, then `fezoctl call <tool>` or `fezoctl run` to try one directly.'
  );
}

/** The three one-step CLI command names, in the order they are documented and
 * registered -- mirrors `one-step.ts`'s `ONE_STEP_SPECS` order; kept as its
 * own tuple here (rather than importing `ONE_STEP_SPECS` and mapping over it)
 * so this module has no dependency on one-step.ts's engine logic, only on the
 * command-name vocabulary the two modules must agree on. */
export const ONE_STEP_COMMANDS = ['web-search', 'scrape', 'crawl'] as const;
export type OneStepCommand = (typeof ONE_STEP_COMMANDS)[number];

/**
 * One line per one-step command, read by HELP_TEXT (`src/cli.ts`) and by the
 * SKILL.md generator (`build/gen-skill.mjs`, straight from the JSON below).
 * Written decision-relevant-clause-first, the same rule mcp-server's
 * `DESCRIPTIONS` states for its MCP tool descriptions, even though a CLI help
 * line has no byte budget to enforce it: a reader skimming a usage block reads
 * the first few words of a line, not the whole paragraph.
 *
 * Each value is ONE unwrapped line. Both consumers wrap it themselves, to
 * their own column, at render time -- a pre-wrapped constant would embed one
 * consumer's line width in the shared data and force the other to unwrap it.
 *
 * The annotation is what checks the JSON: a missing or renamed key is a
 * compile error here, not a `undefined` spliced into help text at run time.
 */
export const ONE_STEP_DESCRIPTIONS: Record<OneStepCommand, string> = oneStepDescriptions;

/** Frozen for the same reason as intent.ts's/providers.ts's declared tables:
 * this prose is surfaced in help text, `--json` output, and SKILL.md, and must
 * read identically wherever it is read from. */
Object.freeze(ONE_STEP_DESCRIPTIONS);
Object.freeze(ONE_STEP_COMMANDS);
