#!/usr/bin/env node
// Builds the single-file, dependency-free `fezoctl` bundle from `src/cli.ts`.
//
// Determinism requirements (see docs/task-9 brief):
//   - pinned esbuild (package.json/pnpm-lock.yaml pin the exact version; this
//     script does not itself pin anything further)
//   - no timestamps in the output
//   - no absolute filesystem paths in the output
//   - byte-identical across repeated builds from the same source tree
//
// This script has exactly one dependency: esbuild. It is invoked as
// `node build/bundle.mjs` (also wired as `pnpm bundle`) and writes
// `dist/fezoctl.mjs`.

import { build } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..');
export const entryPoint = join(repoRoot, 'src', 'cli.ts');
export const packageJsonPath = join(repoRoot, 'package.json');
export const outfile = join(repoRoot, 'dist', 'fezoctl.mjs');
// Bundle policy: this file is COMMITTED, byte-identical to `dist/fezoctl.mjs`
// above (git stores one blob for both paths). It is what makes the skill
// directory self-contained for installers that copy `skills/<name>/` and
// nothing else — see `.gitignore`'s comment. `pnpm bundle` rewrites it, and
// CI's freshness gate fails if the committed bytes drift from a fresh build.
export const skillScriptCopyTarget = join(repoRoot, 'skills', 'fezo', 'scripts', 'fezoctl.mjs');

/**
 * The bundle's entry-point call. `src/cli.ts` exports `main()` but deliberately
 * does not call it at module scope (see its own comment: wiring the real entry
 * point is "the bundler task's job"), so this runs once after all top-level
 * module code — `main` is still an ordinary bundle-scope identifier at that
 * point, so this does not require touching src/cli.ts.
 *
 * `main()` is async, so the returned promise MUST be handled: a bare `main();`
 * turns any throw into an unhandled rejection — a stack trace and a
 * process-level warning — instead of the clean exit code the CLI's error
 * contract promises. `main` itself sets `process.exitCode` on handled failures;
 * this catch only covers the unexpected ones.
 *
 * Exported so `tests/skill_contract.test.ts` can execute THIS EXACT STRING
 * against a deliberately throwing `main`, rather than a re-typed copy of it.
 */
export const FOOTER_JS = [
  'main().catch((err) => {',
  "  process.stderr.write(`fezoctl: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\\n`);",
  '  process.exitCode = 1;',
  '});',
].join('\n');

/**
 * The version baked into the bundle via esbuild `--define`. `src/cli.ts`'s
 * `resolveVersion()` prefers that constant over reading `../package.json`,
 * because the skill-local copy of the bundle sits TWO levels below the package
 * root (`skills/fezo/scripts/`), where that relative walk resolves to a
 * `skills/fezo/package.json` that does not exist — so the artifact most users
 * install could not report its own version at all.
 *
 * Determinism is preserved: the value comes from a committed source file, not
 * from the clock or the environment. It does mean the bundle's bytes change on
 * every version bump, so a `package.json` bump without a matching `pnpm
 * bundle` correctly fails CI's bundle-freshness gate.
 */
export function readPackageVersion() {
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const version = parsed?.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`could not read a string "version" from ${packageJsonPath}`);
  }
  return version;
}

/**
 * Runs the esbuild bundle step and chmods the result to 0755. Exported so
 * tests can invoke the exact same build twice (into distinct outfiles) and
 * compare bytes, rather than shelling out to `pnpm bundle` and re-reading the
 * file it also produced.
 */
export async function bundle({ outfile: outputPath = outfile } = {}) {
  mkdirSync(dirname(outputPath), { recursive: true });

  await build({
    entryPoints: [entryPoint],
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node22'],
    // `esbuild` embeds the working directory into module-boundary comments
    // and sourcemaps unless pinned; `absWorkingDir: repoRoot` makes every
    // embedded path relative to the repo root (and therefore identical
    // regardless of the caller's cwd or machine).
    absWorkingDir: repoRoot,
    // Bakes package.json's version in as a literal, so every copy of the
    // bundle can report its own version without locating package.json on
    // disk. See `readPackageVersion` and src/cli.ts's `resolveVersion`.
    define: { __FEZOCTL_VERSION__: JSON.stringify(readPackageVersion()) },
    banner: { js: '#!/usr/bin/env node' },
    // See `FOOTER_JS`.
    footer: { js: FOOTER_JS },
    legalComments: 'none',
    sourcemap: false,
    minify: false,
    treeShaking: true,
    logLevel: 'silent',
    write: true,
  });

  // Mode is set after write, unconditionally, so a pre-existing file with a
  // different mode (e.g. checked out at 0644) is normalized too.
  chmodSync(outputPath, 0o755);
}

/**
 * Copies the built bundle into `skills/fezo/scripts/fezoctl.mjs` (mode
 * 0755). The source of truth stays `dist/fezoctl.mjs`; this is a derived —
 * but COMMITTED — artifact, so a self-contained skill directory (copied,
 * archived, or fetched by `npx skills add`, all of which take the skill
 * directory alone) still carries a working engine.
 */
export function copyIntoSkill({ from = outfile, to = skillScriptCopyTarget } = {}) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  chmodSync(to, 0o755);
}

function parseArgs(argv) {
  let outputPath = outfile;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--out requires a path argument');
      outputPath = value;
      i += 1;
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  return outputPath;
}

// Run when invoked directly (`node build/bundle.mjs [--out <path>]` /
// `pnpm bundle`), not when imported by a test. `--out` lets tests build into
// a scratch location (for determinism/freshness comparisons) without ever
// touching either committed bundle from a test run. Only the default (no
// `--out`) invocation also refreshes the committed skill-local copy at
// `skills/fezo/scripts/fezoctl.mjs` — this is what `prepack` runs.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  let outputPath;
  try {
    outputPath = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`bundle: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
  if (outputPath !== undefined) {
    const isDefaultOutput = outputPath === outfile;
    bundle({ outfile: outputPath })
      .then(() => {
        process.stdout.write(`wrote ${outputPath}\n`);
        if (isDefaultOutput) {
          copyIntoSkill({ from: outputPath });
          process.stdout.write(`wrote ${skillScriptCopyTarget}\n`);
        }
      })
      .catch((error) => {
        process.stderr.write(`bundle: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
