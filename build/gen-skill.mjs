#!/usr/bin/env node
// Generates `skills/fezo/SKILL.md` from shared sources:
//   - the frontmatter and body text defined in this file (the exact values
//     are the task's governing specification, not a free choice)
//   - `build/step0.md` (Step 0 prose, verbatim)
//   - `build/invocation.sh` (the fezoctl resolution ladder, verbatim, with a
//     `SKILL_VERSION="<value>"` line prepended)
//   - `src/engine/one-step-descriptions.json` (the one-line description of
//     each one-step command, the SAME bytes `src/engine/steering.ts` exports
//     as `ONE_STEP_DESCRIPTIONS` and `src/cli.ts` prints in `--help`)
//
// Usage:
//   node build/gen-skill.mjs                 # writes skills/fezo/SKILL.md
//   node build/gen-skill.mjs --out <path>     # writes elsewhere (tests)
//   node build/gen-skill.mjs --stdout         # prints instead of writing
//
// No static method roster is ever generated here (design principle #3): the
// body only ever shows illustrative, catalog-driven example invocations.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..');
export const step0Path = join(here, 'step0.md');
export const invocationPath = join(here, 'invocation.sh');
export const oneStepDescriptionsPath = join(repoRoot, 'src', 'engine', 'one-step-descriptions.json');
export const defaultOutPath = join(repoRoot, 'skills', 'fezo', 'SKILL.md');

// ONE version number, not two. `SKILL_VERSION` is *derived from*
// `package.json`'s `version` rather than hardcoded here, because it is used
// for two things that are both PACKAGE facts:
//
//   - the tier-5 pin, `npx -y fezo-skills@$SKILL_VERSION`, which must name a
//     version that actually exists on the registry, and
//   - the tier-4 exact-match comparison against a global install's
//     `fezoctl --version`, which reports the installed package's version.
//
// A hardcoded copy here drifted to `1.0.0` while `package.json` sat at
// `0.1.0`, which pinned the unpublishable `fezo-skills@1.0.0` and made the
// bottom of the ladder resolve to a package that does not exist. Deriving it
// makes that drift impossible by construction; `tests/skill_contract.test.ts`
// and CI additionally assert the frontmatter and package.json agree.
export const SKILL_NAME = 'fezo';
export const packageJsonPath = join(repoRoot, 'package.json');

function readPackageVersion() {
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const version = parsed?.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`could not read a string "version" from ${packageJsonPath}`);
  }
  return version;
}

export const SKILL_VERSION = readPackageVersion();

/**
 * The skill's `description` — the single string every host reads to decide
 * when to trigger the skill.
 *
 * Exported because `build/gen-manifests.mjs` puts the same text into the
 * per-host plugin manifests (`.claude-plugin/`, `.codex-plugin/`, …). A second
 * hand-maintained copy over there would drift from this one exactly the way
 * `SKILL_VERSION` once drifted from `package.json` — same failure, different
 * field — so there is one definition and the manifests import it.
 */
export const SKILL_DESCRIPTION =
  'Discover and call Fezo gateway tools from the live catalog. Use when a task needs external capabilities such as web search, news, scraping, market data, social data, product data, or another API-backed service; search the catalog, inspect the schema, call the best provider, and retry another provider when the first fails or returns unsuitable content.';

const FRONTMATTER = `---
name: ${SKILL_NAME}
version: "${SKILL_VERSION}"
description: ${SKILL_DESCRIPTION}
argument-hint: "<external capability or task>"
allowed-tools: Bash, Read, AskUserQuestion
user-invocable: true
homepage: https://github.com/0xPolygonID/fezo-skills
repository: https://github.com/0xPolygonID/fezo-skills
license: MIT
compatibility: Requires bash or zsh, node >=22, curl-compatible network access to the Fezo gateway.
metadata:
  fezo:
    dynamicCatalog: true
---`;

// The one-step command names this generator expects to find in the shared
// JSON, in the order SKILL.md lists them. This is a GUARD, not a second copy
// of the prose: the sentences themselves are never restated here, so the only
// way SKILL.md can disagree with `--help` about what `scrape` does is for the
// file to be stale, which CI's regeneration check and
// `tests/skill_contract.test.ts` both catch. A missing/renamed key fails the
// build loudly instead of splicing `undefined` into the shipped skill.
const ONE_STEP_COMMANDS = ['web-search', 'scrape', 'crawl'];

/** Reads `src/engine/one-step-descriptions.json` — the same bytes
 * `src/engine/steering.ts` imports as `ONE_STEP_DESCRIPTIONS`. */
function readOneStepDescriptions() {
  const parsed = JSON.parse(readFileSync(oneStepDescriptionsPath, 'utf8'));
  return ONE_STEP_COMMANDS.map((name) => {
    const text = parsed?.[name];
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error(`${oneStepDescriptionsPath} has no non-empty "${name}" description`);
    }
    return { name, text };
  });
}

/** SKILL.md's hard-wrap column. The file is wrapped for a human (and an agent
 * quoting it back) to read; the shared descriptions arrive as one unwrapped
 * line each — see steering.ts's note on why the shared data carries no line
 * breaks — so this generator imposes its own. */
const SKILL_WRAP_COLUMNS = 74;

/** Wraps `text` after `firstPrefix`, continuing at `indent`. */
function wrap(firstPrefix, indent, text) {
  const lines = [];
  let line = firstPrefix;
  let placed = false;
  for (const word of text.split(' ')) {
    // An over-long word still goes on an empty line rather than producing a
    // blank line followed by the same over-long word.
    if (placed && line.length + 1 + word.length > SKILL_WRAP_COLUMNS) {
      lines.push(line);
      line = indent + word;
    } else {
      line = placed ? `${line} ${word}` : line + word;
    }
    placed = true;
  }
  lines.push(line);
  return lines.join('\n');
}

// Step order below mirrors mcp-server's own steering (steering.ts's
// SERVER_INSTRUCTIONS: one-step tools first, "find provider" second, the
// general path last). It states that a declared, best-value-first ranking
// exists and that rank 1 is the default choice, without transcribing the
// roster anywhere — the same "the server ships its own steering, the catalog
// stays the source of truth" idea, reworded for a CLI with no competing
// built-in to out-argue. What each one-step command DOES is not restated here:
// step 2's three bullets are rendered from the same
// `src/engine/one-step-descriptions.json` that `src/engine/steering.ts`
// exports and `fezoctl --help` prints, so the skill an agent follows and the
// help text it reads cannot describe `scrape` differently.
function renderProcedure() {
  const oneStep = readOneStepDescriptions()
    .map(({ name, text }) => wrap(`   - \`${name}\` — `, '     ', text))
    .join('\n');
  return `## Procedure

1. If a task needs external data or an external service, use this skill
   before built-in tools or giving up.
2. For a plain web search, or the contents of one known URL, or many pages
   from one site, call the matching one-step command first — one call each,
   with no provider argument names to look up:
${oneStep}
   "Best-value provider" means rank 1 of the declared, per-intent provider
   ranking these commands walk; you do not pick the provider yourself.
3. For news, social-platform data, or proxy access — capabilities no
   one-step command covers — or to compare providers before committing to
   one, use \`providers --intent <intent>\`. It surfaces the SAME declared
   ranking the one-step commands walk, in rank order, with each provider's
   why/when and what is actually callable on your gateway right now. The
   ranking exists and rank 1 is the default choice; do not assume or
   transcribe a fixed provider roster anywhere — the live catalog, not this
   file, is the source of truth for what is callable today.
4. For anything the above two steps don't resolve — a specific tool you
   already know the name of, or a capability with no declared ranking at
   all — search the live catalog by capability (\`search\`), inspect the
   selected tool's schema and HTTP bindings (\`schema\`), and call it (\`call\`).
5. For a retrying call against a named intent/capability rather than one
   already-chosen tool, use \`run\`: it selects the best-ranked matching
   candidate and tries another compatible one on a retryable mechanical
   failure.
6. If a successful result is off-topic, incomplete, spammy, a
   block/challenge page, or otherwise unsuitable, choose another candidate
   and call it deliberately — no step above retries on judgment, only on a
   mechanical failure.
7. Report which backend(s) were attempted and which 2xx attempts were
   billed.`;
}

const EXAMPLES = `## Examples

Examples are illustrative only — always discover real tool names and
arguments from the live catalog (\`search\`/\`schema\`/\`providers\`) rather than
assuming these exact names exist. Do not hardcode a backend roster: the
catalog is the source of truth.

Each line below is one command inside one Bash call, and every Bash call must
re-establish \`FEZOCTL_ARGV\` first — see Step 0.

\`\`\`bash
"\${FEZOCTL_ARGV[@]}" web-search "site:example.com pricing"
"\${FEZOCTL_ARGV[@]}" scrape "https://example.com/article"
"\${FEZOCTL_ARGV[@]}" providers --intent news
"\${FEZOCTL_ARGV[@]}" search "web search" --schema
"\${FEZOCTL_ARGV[@]}" call exa_search --args-json '{"query":"...","numResults":3}'
"\${FEZOCTL_ARGV[@]}" run "scrape url" --args-json '{"url":"https://example.com"}'
\`\`\``;

/** Renders the fenced invocation block: `build/invocation.sh`'s text, with a
 * `SKILL_VERSION="<value>"` assignment prepended so the block is
 * self-contained (the agent only has to supply `SKILL_DIR`). */
export function renderInvocationBlock() {
  const script = readFileSync(invocationPath, 'utf8').replace(/\n+$/, '');
  return ['```bash', `SKILL_VERSION="${SKILL_VERSION}"`, script, '```'].join('\n');
}

export function renderStep0() {
  return readFileSync(step0Path, 'utf8').replace(/\n+$/, '');
}

export function renderSkillMd() {
  const parts = [
    FRONTMATTER,
    '',
    '# fezo',
    '',
    'Discover and call Fezo gateway tools from the live catalog. Do not list',
    'or assume a fixed backend roster anywhere in this file — search the',
    'catalog at run time instead.',
    '',
    renderStep0(),
    '',
    '## Resolve fezoctl',
    '',
    renderInvocationBlock(),
    '',
    renderProcedure(),
    '',
    EXAMPLES,
    '',
  ];
  return parts.join('\n');
}

function parseArgs(argv) {
  let out = defaultOutPath;
  let stdout = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--out requires a path argument');
      out = value;
      i += 1;
    } else if (arg === '--stdout') {
      stdout = true;
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  return { out, stdout };
}

function runCli(argv) {
  const { out, stdout } = parseArgs(argv);
  const content = renderSkillMd();
  if (stdout) {
    process.stdout.write(content);
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);
  process.stdout.write(`wrote ${out}\n`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`gen-skill: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
