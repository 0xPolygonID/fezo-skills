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
/** The browsable project URL, i.e. the clone URL without the `.git` suffix. */
export const homepage = pkg.homepage;

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
      longDescription:
        'fezo adds a skill that discovers callable tools from a Fezo gateway at run time and invokes the best candidate for the task, retrying a different provider when one fails or returns unsuitable content. The tool roster is read from the gateway catalog on every invocation, so new backends are usable without updating this plugin.',
      developerName: AUTHOR.name,
      category: 'Developer Tools',
      // `Write` is listed because `fezoctl setup` persists credentials to
      // ~/.config/fezo/.env (or the macOS Keychain). Understating this would
      // misrepresent what the skill does on first run.
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
        description: 'Base URL of your Fezo API gateway (required).',
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

export function writeManifests(outRoot = repoRoot) {
  const written = [];
  for (const [relPath, value] of Object.entries(manifests())) {
    const target = join(outRoot, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, render(value));
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
      process.stdout.write(`${Object.keys(manifests()).join('\n')}\n`);
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
