#!/usr/bin/env node
// Verifies the artifact `npm pack` would actually publish. This is the
// carry-forward-#1 guard: `skills/fezo/scripts/fezoctl.mjs` is gitignored
// (it is a derived, pack/build-time copy of `dist/fezoctl.mjs`) but MUST
// still land in the npm tarball for tier-2a (`npm install`/`npx`) installs
// to have a working engine. `.npmignore` is what makes that true — npm
// consults `.npmignore` when present and does NOT fall back to `.gitignore`,
// so deleting `.npmignore` as "redundant" would silently break this. This
// script proves the current state actually behaves that way, rather than
// trusting the comment.
//
// Deliberately uses `npm pack`, not `pnpm pack`: the property under test is
// specifically npm's ignore-file precedence (`.npmignore` over
// `.gitignore`), and real end users installing via `npm install`/`npx`
// exercise npm's packing rules, not pnpm's.
//
// Usage: node build/pack-check.mjs   (also wired as `pnpm pack:check`)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

let failed = false;

function fail(message) {
  process.stderr.write(`pack:check: FAIL: ${message}\n`);
  failed = true;
}

function run() {
  const scratch = mkdtempSync(join(tmpdir(), 'fezo-pack-check-'));
  try {
    // This check assumes `pnpm bundle` (and, if run standalone, `pnpm
    // gen-skill`) already ran — CI runs both before `pack:check`. Packing
    // with `--ignore-scripts` here is deliberate, not a shortcut: `npm pack
    // --json`'s stdout must be pure JSON, and letting `prepack` run would
    // interleave `build/bundle.mjs`'s own "wrote ..." lines into the same
    // stdout stream.
    //
    // `npm pack --json` prints an array with the produced filename and, more
    // usefully for us, the full file list — no need to also shell out to
    // `tar -tzf`.
    const raw = execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', scratch, '--ignore-scripts'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const parsed = JSON.parse(raw);
    const entry = parsed[0];
    if (entry === undefined) throw new Error('npm pack produced no output entry');
    const files = entry.files.map((f) => f.path);

    // --- carry-forward #1: the gitignored skill-local bundle must be
    // present in the tarball despite never being tracked by git. ---
    const skillScript = 'skills/fezo/scripts/fezoctl.mjs';
    if (!files.includes(skillScript)) {
      fail(`${skillScript} is missing from the npm pack file list: ${files.join(', ')}`);
    }

    // --- no credentials ever published. ---
    const envLike = files.filter((f) => f === '.env' || f.startsWith('.env.') || f.endsWith('/.env') || f.includes('/.env.'));
    if (envLike.length > 0) {
      fail(`.env-like file(s) present in npm pack output: ${envLike.join(', ')}`);
    }

    // --- source/tooling never published (keeps the tarball to the runtime
    // artifact only; also a cheap proxy for ".npmignore still works"). ---
    const devOnly = files.filter((f) => f.startsWith('src/') || f.startsWith('tests/') || f.startsWith('build/') || f.startsWith('.github/'));
    if (devOnly.length > 0) {
      fail(`dev-only path(s) leaked into npm pack output: ${devOnly.join(', ')}`);
    }

    // --- no skill directory depends on a path outside itself: every file
    // actually shipped under skills/ must be sufficient on its own if that
    // directory were extracted and used standalone (a host copying just
    // `skills/fezo/` into its own skills folder). We check this the way it
    // can actually break: a script under skills/*/ that statically imports
    // or requires a relative path which escapes its own skill directory. ---
    const skillFiles = files.filter((f) => f.startsWith('skills/'));
    if (skillFiles.length === 0) {
      fail('no files under skills/ were present in npm pack output');
    }
    for (const relPath of skillFiles) {
      if (!/\.(mjs|js|cjs)$/.test(relPath)) continue;
      const absPath = join(repoRoot, relPath);
      if (!existsSync(absPath)) continue; // covered by the presence check above
      const text = readFileSync(absPath, 'utf8');
      const skillDirRel = relPath.split('/').slice(0, 2).join('/'); // "skills/<name>"
      const importSpecifiers = [...text.matchAll(/(?:require\(|from\s+|import\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const specifier of importSpecifiers) {
        if (!specifier.startsWith('.')) continue; // bare specifier: node builtin or a real dependency, not a path escape
        const resolved = join(dirname(relPath), specifier);
        const normalized = resolved.split('/').filter((seg) => seg !== '.');
        // Walking ".." above the skill's own directory means the file has a
        // hard, unshippable dependency outside `skills/<name>/`.
        let depth = 0;
        let escapes = false;
        for (const seg of normalized) {
          if (seg === '..') {
            depth -= 1;
            if (depth < 0) escapes = true;
          } else {
            depth += 1;
          }
        }
        if (escapes || !resolved.startsWith(skillDirRel)) {
          fail(`${relPath} imports "${specifier}", which resolves outside ${skillDirRel}/`);
        }
      }
    }

    if (!failed) {
      process.stdout.write(`pack:check: OK (${files.length} files; ${skillScript} present; no .env; no dev-only paths; skills/ self-contained)\n`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  run();
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

process.exitCode = failed ? 1 : 0;
