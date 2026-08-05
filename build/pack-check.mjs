#!/usr/bin/env node
// Verifies the artifact `npm pack` would actually publish. This is the
// carry-forward-#1 guard: `skills/fezo/scripts/fezoctl.mjs` (a derived copy
// of `dist/fezoctl.mjs`) MUST land in the npm tarball for tier-2a (`npm
// install`/`npx`) installs to have a working engine.
//
// The file is now committed, so git tracks it — but that is not what puts it
// in the tarball. `package.json`'s `files` allowlist is, and `.npmignore`
// governs what is pruned from within it. This script proves the published
// bytes are right rather than trusting either config to stay correct.
//
// Deliberately uses `npm pack`, not `pnpm pack`: real end users installing
// via `npm install`/`npx` exercise npm's packing rules, not pnpm's — and
// `.npmignore`'s precedence over `.gitignore` is an npm-specific behavior
// that only npm's packer demonstrates.
//
// Usage: node build/pack-check.mjs   (also wired as `pnpm pack:check`)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

    // Extract the tarball we just produced, so every content check below
    // inspects THE PUBLISHED BYTES rather than the working tree's copy of the
    // same path. Reading from repoRoot would pass even if npm shipped a
    // different (or truncated, or absent) file — precisely the class of bug
    // this script exists to catch. npm tarballs root everything under
    // `package/`.
    if (typeof entry.filename !== 'string') throw new Error('npm pack --json did not report a filename');
    const tarballPath = join(scratch, entry.filename);
    const extractRoot = join(scratch, 'extracted');
    mkdirSync(extractRoot, { recursive: true });
    execFileSync('tar', ['-xzf', tarballPath, '-C', extractRoot], { encoding: 'utf8' });
    const packageRoot = join(extractRoot, 'package');

    // --- carry-forward #1: the skill-local bundle must be present in the
    // tarball. It is committed (see `.gitignore`'s comment), so git tracks it
    // too — but `files`/`.npmignore` are what put it in the TARBALL, and this
    // asserts that separately from git's view of it. ---
    const skillScript = 'skills/fezo/scripts/fezoctl.mjs';
    if (!files.includes(skillScript)) {
      fail(`${skillScript} is missing from the npm pack file list: ${files.join(', ')}`);
    }

    // --- both operator docs must ship. `README.md`'s "Credentials" section
    // is only a LINK to `CONFIGURATION.md`, so shipping the first without the
    // second leaves an installed package whose entire credential story is a
    // dead relative link — and `CONFIGURATION.md` is the only place the
    // threat model, the three-source resolution order, and the `.env` rotation
    // path are written down. npm force-includes `README` regardless of
    // `files`, but `CONFIGURATION.md` is there only because `package.json`'s
    // `files` names it; asserting the pair together is what makes removing it
    // from `files` fail here instead of silently shipping a broken link. ---
    for (const doc of ['README.md', 'CONFIGURATION.md']) {
      if (!files.includes(doc)) {
        fail(`${doc} is missing from the npm pack file list: ${files.join(', ')}`);
        continue;
      }
      // Listed is not the same as shipped: read it out of the EXTRACTED
      // tarball, and require real content rather than an empty placeholder.
      const absDoc = join(packageRoot, doc);
      if (!existsSync(absDoc)) {
        fail(`${doc} is listed in the npm pack file list but is absent from the extracted tarball`);
        continue;
      }
      if (readFileSync(absDoc, 'utf8').trim().length === 0) {
        fail(`${doc} is present in the tarball but empty`);
      }
    }

    // --- no credentials ever published. ---
    const envLike = files.filter((f) => f === '.env' || f.startsWith('.env.') || f.endsWith('/.env') || f.includes('/.env.'));
    if (envLike.length > 0) {
      fail(`.env-like file(s) present in npm pack output: ${envLike.join(', ')}`);
    }

    // --- source/tooling never published (keeps the tarball to the runtime
    // artifact only; also a cheap proxy for ".npmignore still works"). ---
    // Per-host plugin manifests (`.claude-plugin/`, `.codex-plugin/`, …) are
    // REPOSITORY metadata: each host reads them from a Git checkout of this
    // repo, never from the npm tarball. Shipping them would put a second,
    // silently-stale copy of the version number inside every `npm install`.
    const hostManifestPrefixes = ['.claude-plugin/', '.codex-plugin/', '.grok-plugin/', '.agents/'];
    const devOnly = files.filter(
      (f) =>
        f.startsWith('src/') ||
        f.startsWith('tests/') ||
        f.startsWith('build/') ||
        f.startsWith('.github/') ||
        f === 'gemini-extension.json' ||
        hostManifestPrefixes.some((prefix) => f.startsWith(prefix)),
    );
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
    let scriptsInspected = 0;
    for (const relPath of skillFiles) {
      if (!/\.(mjs|js|cjs)$/.test(relPath)) continue;
      // From the EXTRACTED tarball, not from repoRoot.
      const absPath = join(packageRoot, relPath);
      if (!existsSync(absPath)) {
        // Not `continue`: npm listed this path in the tarball, so it must be
        // extractable. Silently skipping here is how a missing or unreadable
        // shipped script previously passed the self-containment check.
        fail(`${relPath} is listed in the npm pack file list but is absent from the extracted tarball`);
        continue;
      }
      scriptsInspected += 1;
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

    // The self-containment check is only meaningful if it actually read
    // something. Zero inspected scripts means the loop above found no shipped
    // script at all, which is a failure of this check, not a pass.
    if (scriptsInspected === 0) {
      fail('no shippable script under skills/ was inspected for self-containment');
    }

    // --- the shipped skill-local bundle must be byte-identical to the
    // committed dist/fezoctl.mjs, and must be able to report its own version
    // from inside the tarball's layout (two levels below the package root,
    // where a `../package.json` walk misses). ---
    const shippedSkillScript = join(packageRoot, skillScript);
    if (existsSync(shippedSkillScript)) {
      const shipped = readFileSync(shippedSkillScript);
      const committedDist = readFileSync(join(repoRoot, 'dist', 'fezoctl.mjs'));
      if (!shipped.equals(committedDist)) {
        fail(`${skillScript} in the tarball is not byte-identical to the committed dist/fezoctl.mjs`);
      }
      const expectedVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
      const reported = execFileSync('node', [shippedSkillScript, '--version'], { encoding: 'utf8' }).trim();
      if (reported !== `fezoctl ${expectedVersion}`) {
        fail(`${skillScript} in the tarball reports "${reported}", expected "fezoctl ${expectedVersion}"`);
      }
    }

    if (!failed) {
      process.stdout.write(
        `pack:check: OK (${files.length} files; ${skillScript} present; README.md + CONFIGURATION.md present; ` +
          `no .env; no dev-only paths; ${scriptsInspected} shipped script(s) self-contained; ` +
          `shipped bundle reports its own version)\n`,
      );
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
