#!/usr/bin/env node
// Generates the per-host plugin manifests that give each agent harness a
// first-class install lane, instead of routing every host through the same
// generic `npx skills add <owner>/<repo>` fallback:
//
//   .claude-plugin/plugin.json        Claude Code plugin
//   .claude-plugin/marketplace.json   `/plugin marketplace add 0xPolygonID/fezo-skills`
//   .codex-plugin/plugin.json         Codex plugin (+ its `interface` UI block)
//   .grok-plugin/plugin.json          xAI Build CLI plugin
//   .grok-plugin/marketplace.json     `grok plugin marketplace add …`
//   .agents/plugins/marketplace.json  cross-host `.agents` marketplace
//   gemini-extension.json             Gemini CLI extension (env-var settings)
//
// …and the two root-scan ignore files, `.skillignore` and `.clawhubignore`,
// which are one exclusion list read by two hosts.
//
// EVERY value here is DERIVED — from `package.json` (version, description,
// homepage, repository, license) and from `build/gen-skill.mjs` (the skill's
// name and description). Nothing is transcribed.
//
// That is the whole point of generating them. Seven manifests each carrying a
// `"version"` field is seven new places for the one-version-number invariant
// to break, and a stale manifest version is worse than a missing one: a host
// installs the plugin and reports a release number that was never cut. CI
// regenerates these and fails on any diff, exactly as it does for SKILL.md and
// the bundles.
//
// Usage:
//   node build/gen-manifests.mjs             # writes all manifests
//   node build/gen-manifests.mjs --out <dir>  # writes under another root (tests)
//   node build/gen-manifests.mjs --list       # prints the relative paths it owns

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SKILL_NAME, SKILL_VERSION, SKILL_DESCRIPTION } from './gen-skill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..');
export const packageJsonPath = join(repoRoot, 'package.json');

function readPackageJson() {
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  for (const field of ['name', 'version', 'description', 'homepage', 'license']) {
    if (typeof parsed?.[field] !== 'string' || parsed[field].length === 0) {
      throw new Error(`package.json is missing a string "${field}"`);
    }
  }
  const repositoryUrl = parsed?.repository?.url;
  if (typeof repositoryUrl !== 'string' || repositoryUrl.length === 0) {
    throw new Error('package.json is missing a string "repository.url"');
  }
  return { ...parsed, repositoryUrl };
}

const pkg = readPackageJson();

/**
 * The clone URL hosts want in a marketplace `source`. `package.json`'s
 * `repository.url` carries npm's `git+` prefix, which is meaningful to npm and
 * meaningless (sometimes rejected) to a plugin host, so it is stripped here
 * rather than stored twice.
 */
export const gitUrl = pkg.repositoryUrl.replace(/^git\+/, '');
/**
 * The browsable project URL: the clone URL without the `.git` suffix, DERIVED
 * rather than read from `package.json`'s own `homepage`.
 *
 * It is what every manifest's `repository` field is set to, so reading the
 * transcribed value would let the two drift: point `homepage` at a docs site or
 * an org page — a routine thing to do — and every host's `repository` would
 * silently name something that is not a repository, while the marketplaces'
 * `source.url` still used the real clone URL. Deriving it makes that
 * impossible; the assertion below makes a `homepage` that disagrees a build
 * failure rather than a silent divergence.
 */
export const homepage = gitUrl.replace(/\.git$/, '');
if (pkg.homepage !== homepage) {
  throw new Error(
    `package.json's homepage (${pkg.homepage}) is not repository.url without its git+ prefix and .git suffix (${homepage}); ` +
      'the manifests set every `repository` field from the derived value, so reconcile the two.',
  );
}

/**
 * Authorship is the GitHub organization, with no `email` field.
 *
 * Deliberate: these manifests are published metadata, and inventing a contact
 * address for a human would put an unverified personal detail into every
 * host's plugin registry. An org URL is verifiable and sufficient — every host
 * treats `email` as optional.
 */
const AUTHOR = {
  name: '0xPolygonID',
  url: 'https://github.com/0xPolygonID',
};

/**
 * Keywords describe CAPABILITIES, never a backend roster.
 *
 * This is design principle #3 (no static method roster) applied to packaging:
 * `SKILL.md` refuses to name backends because the catalog is fetched live, and
 * a keyword list naming today's providers would be exactly the stale roster
 * that principle exists to prevent — visible in a marketplace listing, updated
 * by nobody, wrong the moment a backend registers or leaves.
 */
const KEYWORDS = [
  'fezo',
  'api-gateway',
  'tool-catalog',
  'dynamic-catalog',
  'web-search',
  'scraping',
  'market-data',
];

/** Fields every host's `plugin.json` shares. */
function pluginCore() {
  return {
    name: SKILL_NAME,
    version: SKILL_VERSION,
    description: SKILL_DESCRIPTION,
    author: AUTHOR,
    homepage,
    repository: homepage,
    license: pkg.license,
    keywords: KEYWORDS,
  };
}

/**
 * Claude Code discovers `skills/` inside a plugin by convention, so its
 * `plugin.json` deliberately has NO `skills` field. Codex and Grok both want
 * the path declared explicitly. That asymmetry is real, not an oversight —
 * see the manifests in the wild that this set was modelled on.
 */
function claudePluginJson() {
  return pluginCore();
}

function claudeMarketplaceJson() {
  return {
    name: pkg.name,
    owner: AUTHOR,
    metadata: {
      description: `Marketplace hosting the ${SKILL_NAME} plugin.`,
    },
    plugins: [
      {
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        version: SKILL_VERSION,
        author: AUTHOR,
        // `./` — the marketplace and the plugin live in the same repository,
        // so the plugin source is this checkout's root.
        source: './',
        category: 'productivity',
        homepage,
      },
    ],
  };
}

function codexPluginJson() {
  return {
    ...pluginCore(),
    skills: './skills/',
    interface: {
      displayName: SKILL_NAME,
      shortDescription: 'Call external APIs discovered from a live gateway catalog.',
      // The second sentence is a disclosure, not marketing copy: the skill's
      // primary effect is outbound network traffic to third-party APIs, made by
      // a bundled Node engine the skill shells out to, and billed to the user's
      // gateway account. `capabilities` below has no vocabulary term for either
      // shell execution or network egress, so this is where a Codex user
      // reading the listing learns about them.
      longDescription:
        'fezo adds a skill that discovers callable tools from a Fezo gateway at run time and invokes the best candidate for the task, retrying a different provider when one fails or returns unsuitable content. It runs a bundled Node CLI through the shell on every invocation, which makes outbound HTTPS requests to your gateway and, through it, to third-party API backends — those calls are billed to your gateway account. The tool roster is read from the gateway catalog each time, so new backends are usable without updating this plugin.',
      developerName: AUTHOR.name,
      category: 'Developer Tools',
      // `Write` is listed because `fezoctl setup` persists credentials to
      // ~/.config/fezo/.env (or the macOS Keychain). Understating this would
      // misrepresent what the skill does on first run.
      //
      // These three are the terms this field is known to accept. Shell
      // execution and network egress — the skill's largest effects — have no
      // term here, so they are disclosed in `longDescription` above rather than
      // guessed at with a value the host may reject.
      capabilities: ['Interactive', 'Read', 'Write'],
      websiteURL: homepage,
      // Capability-shaped prompts. NOT provider names — see KEYWORDS.
      defaultPrompt: [
        'search the web for recent news on a topic',
        'scrape a page and summarize it',
        'look up current market data for an asset',
      ],
      brandColor: '#8247E5',
    },
  };
}

function grokPluginJson() {
  return {
    ...pluginCore(),
    skills: './skills/',
  };
}

function grokMarketplaceJson() {
  return {
    name: pkg.name,
    owner: AUTHOR,
    description: `Marketplace for the ${SKILL_NAME} plugin`,
    plugins: [
      {
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        version: SKILL_VERSION,
        category: 'productivity',
        source: { source: 'url', url: gitUrl },
        homepage,
        keywords: KEYWORDS,
      },
    ],
  };
}

function agentsMarketplaceJson() {
  return {
    name: pkg.name,
    interface: { displayName: SKILL_NAME },
    plugins: [
      {
        name: SKILL_NAME,
        source: { source: 'url', url: gitUrl },
        policy: {
          installation: 'AVAILABLE',
          // The skill cannot do anything without a gateway URL and API key, so
          // hosts that support it should prompt at install time rather than
          // letting the first real invocation fail on missing credentials.
          authentication: 'ON_INSTALL',
        },
        category: 'Developer Tools',
      },
    ],
  };
}

/**
 * Gemini CLI extension manifest. Its `settings` become environment variables,
 * which is the FIRST source in fezoctl's credential resolution chain
 * (env > Keychain > dotenv), so this lane needs no separate setup step.
 *
 * No `contextFileName`, `mcpServers`, or `commands` — deliberately. Gemini CLI
 * discovers agent skills bundled with an extension by convention, from
 * `skills/<name>/SKILL.md` relative to the extension root, which is exactly
 * where this repository's skill already lives. Declaring a context file would
 * load a second copy of the instructions into every session unconditionally,
 * which is the opposite of what a skill is for. (This is the one lane whose
 * mechanism is a host convention rather than something the manifest states, so
 * the manifest looking thin here is not an omission.)
 *
 * These two names are the only ones resolution accepts, so they are the only
 * ones that may appear here: an extra entry would present a host-UI field that
 * silently has no effect.
 */
function geminiExtensionJson() {
  return {
    name: pkg.name,
    version: SKILL_VERSION,
    description: pkg.description,
    settings: [
      {
        name: 'Fezo Gateway URL',
        description:
          'Base URL of your Fezo API gateway. Optional — defaults to https://fezo.ai; set this only for a different gateway.',
        envVar: 'FEZO_URL',
        sensitive: false,
      },
      {
        name: 'Fezo API Key',
        description: 'API key for your Fezo gateway (required).',
        envVar: 'FEZO_API_KEY',
        sensitive: true,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Root-scan ignore files.
//
// Hermes and ClawHub scan the WHOLE repository when installing from a Git
// source, not just `skills/`, so these two files decide what an installed skill
// actually contains. They are generated for the same reason the manifests are:
// they were two hand-maintained copies of one list, policed by a test that
// could only report the drift after the fact.
// ---------------------------------------------------------------------------

/**
 * The single exclusion list both files carry, as comment/paths groups.
 *
 * `skills/fezo/` is what must survive: SKILL.md plus the committed engine at
 * `skills/fezo/scripts/fezoctl.mjs`. Nothing here may match either — a pattern
 * that did would produce the same silent failure gitignoring the bundle did, a
 * SKILL.md with no fezoctl behind it.
 */
const ROOT_SCAN_EXCLUSIONS = [
  {
    comment: [
      'Local credentials. This is the one group here that is a security boundary',
      'rather than noise reduction: `.env` is gitignored, so it is never in the',
      'repo, but these scans read the WORKING DIRECTORY. A maintainer installing',
      "or packaging from their own checkout would otherwise ship a live",
      "FEZO_API_KEY into the installed skill and upload it into the scanner's",
      'security review. `.npmignore` excludes it for the same reason, and',
      '`build/pack-check.mjs` asserts it for the npm tarball.',
    ],
    paths: ['.env', '.env.*'],
  },
  {
    comment: ['VCS, caches, and local scratch output.'],
    paths: ['.git/', 'node_modules/', 'coverage/', '*.log', '.DS_Store'],
  },
  {
    comment: [
      'TypeScript source and its build tooling. `dist/fezoctl.mjs` is the build',
      'output, not a runtime dependency of the installed skill: the skill directory',
      'carries its own copy, and tier 3 (which reads dist/) only ever resolves in a',
      'source checkout.',
    ],
    paths: [
      'src/',
      'tests/',
      'build/',
      'dist/',
      'tsconfig.json',
      'vitest.config.ts',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ],
  },
  {
    comment: [
      'Repo automation and host-specific package metadata. Each host reads only its',
      "own manifest; shipping the other hosts' manifests into a scan is noise.",
    ],
    paths: ['.github/', '.agents/', '.claude-plugin/', '.codex-plugin/', '.grok-plugin/', 'gemini-extension.json'],
  },
  {
    comment: [
      'Non-runtime docs and repo-only config. README.md and CODEX.md are install and',
      'development guides for someone reading the repository, not instructions the',
      'installed skill needs — SKILL.md carries the whole runtime flow, credential',
      'setup included. `docs/` is research prose behind the declared provider',
      'ranking (`docs/providers-score.md` is what `src/engine/providers.ts` cites as',
      'its source): the machine-readable conclusion ships inside the bundle, the',
      'reasoning that produced it is for whoever refreshes the table, and nothing in',
      'the runtime flow reads it.',
      '',
      'Two deliberate keeps:',
      '',
      '  CONFIGURATION.md — the credential reference. SKILL.md does NOT link it, so',
      '  this is not load-bearing for setup to work; it is kept because once',
      '  README.md is excluded it is the only place in the payload that documents',
      '  storage locations and resolution precedence.',
      '',
      '  LICENSE — the terms should travel with any copy of the code.',
    ],
    paths: ['README.md', 'CODEX.md', 'docs/', '.npmignore', '.gitignore', '.gitattributes'],
  },
];

/**
 * Renders one ignore file. The two differ only in which host reads them and
 * which sibling they name, so everything else comes from the shared list above.
 */
function rootScanIgnore({ title, siblingNote }) {
  const lines = [
    `# ${title}`,
    '#',
    '# Hermes and ClawHub scan the WHOLE repository when installing from a Git',
    '# source, not just `skills/`. Everything listed here is either dev tooling or',
    '# host metadata that has no business in an installed skill — and, because these',
    '# scans include a security review of what is being installed, keeping the',
    '# surface to the actual runtime skill is what makes that review meaningful.',
    '#',
    '# The runtime skill is `skills/fezo/` and nothing else: SKILL.md plus the',
    '# committed engine at `skills/fezo/scripts/fezoctl.mjs`. Do NOT exclude that',
    '# bundle — it IS the engine (tier 2 of the invocation ladder), and without it an',
    '# installed skill resolves no fezoctl at all.',
    '#',
    `# ${siblingNote}`,
    '# GENERATED by build/gen-manifests.mjs from one shared list — do not hand-edit.',
  ];
  for (const group of ROOT_SCAN_EXCLUSIONS) {
    lines.push('');
    for (const line of group.comment) lines.push(line.length === 0 ? '#' : `# ${line}`);
    lines.push(...group.paths);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Every manifest this generator owns, as `relative path -> value`. Exported so
 * tests and CI enumerate the same list the writer uses, rather than a
 * re-typed copy that could fall behind when a lane is added.
 */
export function manifests() {
  return {
    '.claude-plugin/plugin.json': claudePluginJson(),
    '.claude-plugin/marketplace.json': claudeMarketplaceJson(),
    '.codex-plugin/plugin.json': codexPluginJson(),
    '.grok-plugin/plugin.json': grokPluginJson(),
    '.grok-plugin/marketplace.json': grokMarketplaceJson(),
    '.agents/plugins/marketplace.json': agentsMarketplaceJson(),
    'gemini-extension.json': geminiExtensionJson(),
  };
}

/** Two-space JSON with a trailing newline — the shape every host ships and
 * every editor leaves alone, so regeneration produces no incidental diff. */
export function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Every file this generator owns, as `relative path -> file text`: the JSON
 * manifests plus the two root-scan ignore files. `--list`, the writer, CI's
 * freshness gate, and the tests all enumerate this one map.
 */
export function generatedFiles() {
  const files = {};
  for (const [relPath, value] of Object.entries(manifests())) {
    files[relPath] = render(value);
  }
  files['.skillignore'] = rootScanIgnore({
    title: 'Hermes install-time scanner/package exclusions for repository-root scans.',
    siblingNote: '`.clawhubignore` is the same list for ClawHub.',
  });
  files['.clawhubignore'] = rootScanIgnore({
    title: 'ClawHub/OpenClaw packaging exclusions for repository-root scans.',
    siblingNote: '`.skillignore` is the same list for Hermes.',
  });
  return files;
}

export function writeManifests(outRoot = repoRoot) {
  const written = [];
  for (const [relPath, text] of Object.entries(generatedFiles())) {
    const target = join(outRoot, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    written.push(target);
  }
  return written;
}

function parseArgs(argv) {
  let outRoot = repoRoot;
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--out requires a directory argument');
      outRoot = value;
      i += 1;
    } else if (arg === '--list') {
      list = true;
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  return { outRoot, list };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    const { outRoot, list } = parseArgs(process.argv.slice(2));
    if (list) {
      process.stdout.write(`${Object.keys(generatedFiles()).join('\n')}\n`);
    } else {
      for (const target of writeManifests(outRoot)) {
        process.stdout.write(`wrote ${target}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`gen-manifests: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
