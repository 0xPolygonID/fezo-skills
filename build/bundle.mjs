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
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..');
export const entryPoint = join(repoRoot, 'src', 'cli.ts');
export const outfile = join(repoRoot, 'dist', 'fezoctl.mjs');
// Bundle policy: this file is deliberately gitignored (`.gitignore`) and
// copied in only at pack/build time — see `.npmignore`'s comment for why
// npm still needs it even though git never tracks it.
export const skillScriptCopyTarget = join(repoRoot, 'skills', 'fezo', 'scripts', 'fezoctl.mjs');

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
    banner: { js: '#!/usr/bin/env node' },
    // `src/cli.ts` exports `main()` but deliberately does not call it at
    // module scope (see its own comment: wiring the real entry point is
    // "the bundler task's job"). The footer calls it once, after all
    // top-level module code (including esbuild's own `export {}` tail) has
    // run — `main` is still an ordinary bundle-scope identifier at that
    // point, so this does not require touching src/cli.ts.
    footer: { js: 'main();' },
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
 * 0755). This is the "only for pack/build" copy the bundle policy requires:
 * the source of truth stays `dist/fezoctl.mjs`; this is a derived, gitignored
 * artifact so a self-contained skill directory (copied or archived alone)
 * still carries a working engine.
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
// touching the committed dist/fezoctl.mjs from a test run. Only the default
// (no `--out`) invocation also performs the pack/build copy into
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
