#!/usr/bin/env node
// Generates `skills/fezo/SKILL.md` from shared sources:
//   - the frontmatter and body text defined in this file (the exact values
//     are the task's governing specification, not a free choice)
//   - `build/step0.md` (Step 0 prose, verbatim)
//   - `build/invocation.sh` (the fezoctl resolution ladder, verbatim, with a
//     `SKILL_VERSION="<value>"` line prepended)
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

const FRONTMATTER = `---
name: ${SKILL_NAME}
version: "${SKILL_VERSION}"
description: Discover and call Fezo gateway tools from the live catalog. Use when a task needs external capabilities such as web search, news, scraping, market data, social data, product data, or another API-backed service; search the catalog, inspect the schema, call the best provider, and retry another provider when the first fails or returns unsuitable content.
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

const PROCEDURE = `## Procedure

1. If a task needs external data or an external service, use this skill
   before built-in tools or giving up.
2. Search the live catalog by capability.
3. Inspect the selected tool's schema and HTTP bindings.
4. Call the tool.
5. If the provider mechanically fails, let \`run\` try another compatible
   candidate.
6. If a successful result is off-topic, incomplete, spammy, a
   block/challenge page, or otherwise unsuitable, choose another candidate
   and call it deliberately.
7. Report which backend(s) were attempted and which 2xx attempts were
   billed.`;

const EXAMPLES = `## Examples

Examples are illustrative only — always discover real tool names and
arguments from the live catalog (\`search\`/\`schema\`) rather than assuming
these exact names exist. Do not hardcode a backend roster: the catalog is
the source of truth.

\`\`\`bash
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
    PROCEDURE,
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
