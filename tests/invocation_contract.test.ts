// Contract tests for `build/invocation.sh` — the `fezoctl` resolution
// ladder that gets baked into `skills/fezo/SKILL.md`'s "Resolve fezoctl"
// block. These run the actual shell logic (via `bash`), not a
// re-implementation of it in TypeScript, so a regression in the real script
// is what fails these tests.
//
// The central property under test: a `SKILL_DIR` containing a space must
// still resolve correctly at every tier, because a Bash *command string*
// would silently mis-split on that space while a Bash *array* (this
// project's argv-array decision) does not. Every scenario below uses a
// SKILL_DIR with a literal space in it for exactly this reason.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const invocationShPath = join(repoRoot, 'build', 'invocation.sh');
const bundlePath = join(repoRoot, 'build', 'bundle.mjs');

// The harness script text is fixed and untainted by any test input — every
// scenario-specific value (SKILL_DIR, SKILL_VERSION, FEZOCTL, PATH) is passed
// through the child process's environment, never interpolated into this
// string. `\0`-separated output preserves argv elements that themselves
// contain spaces (e.g. a resolved path under a spaced SKILL_DIR).
const HARNESS_SCRIPT = `
set -euo pipefail
source "$INVOCATION_SH"
printf '%s\\0' "\${FEZOCTL_ARGV[@]}"
`;

const scratchDirs: string[] = [];

function makeScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface LadderEnv {
  skillDir: string;
  skillVersion: string;
  fezoctl?: string;
  pathOverride?: string;
}

/**
 * The ladder's resolved argv AND everything it wrote to stderr.
 *
 * stderr is returned rather than left to the parent's: the script now
 * DELIBERATELY writes diagnostics (an unusable `$FEZOCTL`, and the tier-5
 * fallback that cannot work until the package is published), and every scenario
 * below asserts exactly what it did or did not print. `execFileSync` would have
 * let those writes through to the test runner's own stderr, which both pollutes
 * the suite output and leaves the diagnostics unasserted.
 */
interface LadderResult {
  argv: string[];
  stderr: string;
}

function resolveViaLadder(env: LadderEnv): LadderResult {
  const childEnv: NodeJS.ProcessEnv = {
    // A deliberately minimal PATH (plus whatever the scenario adds) so a
    // real, ambient `fezoctl`/`node`/`npx` on the developer's machine cannot
    // accidentally make a broken scenario look like it passed.
    PATH: env.pathOverride ?? process.env['PATH'] ?? '/usr/bin:/bin',
    INVOCATION_SH: invocationShPath,
    SKILL_DIR: env.skillDir,
    SKILL_VERSION: env.skillVersion,
  };
  if (env.fezoctl !== undefined) childEnv['FEZOCTL'] = env.fezoctl;

  const result = spawnSync('bash', ['-c', HARNESS_SCRIPT], { env: childEnv, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`ladder harness exited with status ${String(result.status)}; stderr=${result.stderr}`);
  }
  return {
    argv: result.stdout.split('\0').filter((part) => part.length > 0),
    stderr: result.stderr,
  };
}

/** Writes an executable fake `fezoctl` at `dir/fezoctl` so tier 4's `command
 * -v` + `--version` check has something real to run.
 *
 * CRITICAL: the fake prints `fezoctl <version>` — the EXACT format the real
 * binary produces (`src/engine/render.ts`'s `renderVersion`: `return
 * \`fezoctl ${version}\``), NOT a bare version. An earlier revision of this
 * helper printed a bare version, which made both tier-4 tests certify a
 * comparison (`[ "$(fezoctl --version)" = "$SKILL_VERSION" ]`) that can never
 * be true against the real binary — a matching global install was silently
 * skipped in production while the suite stayed green. A fake MUST produce the
 * same shape the real thing produces. */
function writeFakeGlobalFezoctl(dir: string, version: string): void {
  const path = join(dir, 'fezoctl');
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nif [ "\${1:-}" = "--version" ]; then printf 'fezoctl %s' "${version}"; fi\nexit 0\n`,
  );
  chmodSync(path, 0o755);
}

describe('the tier-4 fake global fezoctl matches the real binary', () => {
  // This is the guard that makes every tier-4 scenario below meaningful: if
  // `writeFakeGlobalFezoctl` ever drifts from the real `--version` output
  // format again, THIS test fails rather than the tier-4 tests quietly
  // certifying an impossible comparison.
  it("prints --version in exactly the format dist/fezoctl.mjs prints", () => {
    const pkg: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const pkgVersion = pkg !== null && typeof pkg === 'object' ? Reflect.get(pkg, 'version') : undefined;
    expect(typeof pkgVersion).toBe('string');

    // Build a private scratch copy of the bundle rather than executing the
    // committed `dist/fezoctl.mjs` directly. That shared file is rewritten
    // in place (non-atomically) by tests/skill_contract.test.ts's
    // `withCommittedDistPreserved` guard, and vitest runs test FILES
    // concurrently by default — so executing the committed path here raced
    // that guard's truncate-and-restore window (a flaky `SyntaxError` /
    // `ENOENT`, not a wrong pass). The reproducibility tests elsewhere
    // already guarantee a fresh build is byte-identical to the committed
    // file, so a scratch build has exactly the same shape and is race-free.
    const scratchDir = makeScratchDir('fake-global-shape-bundle-');
    const scratchBundle = join(scratchDir, 'fezoctl.mjs');
    execFileSync('node', [bundlePath, '--out', scratchBundle], { cwd: repoRoot, encoding: 'utf8' });
    const realOutput = execFileSync('node', [scratchBundle, '--version'], { encoding: 'utf8' }).trim();

    const binDir = makeScratchDir('fake-global-shape-');
    writeFakeGlobalFezoctl(binDir, String(pkgVersion));
    const fakeOutput = execFileSync(join(binDir, 'fezoctl'), ['--version'], { encoding: 'utf8' }).trim();

    // Same version in, so the two must be byte-identical strings.
    expect(fakeOutput).toBe(realOutput);
    // And pin the shape itself, so "both are bare versions" cannot satisfy it.
    expect(realOutput).toBe(`fezoctl ${String(pkgVersion)}`);
  });
});

describe('build/invocation.sh resolution ladder — SKILL_DIR containing a space', () => {
  it('tier 1: a set, executable $FEZOCTL wins outright', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true });
    const fezoctlPath = join(spacedRoot, 'custom fezoctl');
    writeFileSync(fezoctlPath, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(fezoctlPath, 0o755);

    const { argv, stderr } = resolveViaLadder({ skillDir, skillVersion: '1.0.0', fezoctl: fezoctlPath });
    expect(argv).toEqual([fezoctlPath]);
    expect(stderr).toBe('');
  });

  it('tier 2: skill-local scripts/fezoctl.mjs is preferred over everything below it', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    const scriptPath = join(skillDir, 'scripts', 'fezoctl.mjs');
    // Deliberately NOT chmod +x: tier 2 must be invoked as `node <path>`,
    // never relied on to be executable (a `.skill` archive/file copy may not
    // preserve the bit).
    writeFileSync(scriptPath, '// stub\n');

    // Also plant a tier-3 candidate (repo-root dist/fezoctl.mjs) to prove
    // tier 2 is preferred over it.
    const distPath = join(spacedRoot, 'dist', 'fezoctl.mjs');
    mkdirSync(dirname(distPath), { recursive: true });
    writeFileSync(distPath, '// unused — tier 2 must win\n');

    const { argv, stderr } = resolveViaLadder({ skillDir, skillVersion: '1.0.0' });
    expect(argv).toEqual(['node', scriptPath]);
    expect(stderr).toBe('');
  });

  it('tier 3: repo-root dist/fezoctl.mjs is used when the skill-local copy is absent', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true });
    const distPath = join(spacedRoot, 'dist', 'fezoctl.mjs');
    mkdirSync(dirname(distPath), { recursive: true });
    writeFileSync(distPath, '// stub\n');

    const { argv, stderr } = resolveViaLadder({ skillDir, skillVersion: '1.0.0' });
    // Deliberately not `path.join`, which would normalize away the `..`
    // segments: the shell embeds the literal, unnormalized
    // "$SKILL_DIR/../../dist/fezoctl.mjs" string, and that literal string is
    // exactly what must appear in the resolved argv.
    expect(argv).toEqual(['node', `${skillDir}/../../dist/fezoctl.mjs`]);
    expect(stderr).toBe('');
  });

  it('tier 4: a global fezoctl is used only when --version matches SKILL_VERSION exactly', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true });
    const binDir = makeScratchDir('fake-global-bin-');
    writeFakeGlobalFezoctl(binDir, '1.0.0');

    const { argv, stderr } = resolveViaLadder({
      skillDir,
      skillVersion: '1.0.0',
      pathOverride: `${binDir}:/usr/bin:/bin`,
    });
    expect(argv).toEqual(['fezoctl']);
    expect(stderr).toBe('');
  });

  it('tier 4 is skipped (falls through to tier 5) when the global version is stale', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true });
    const binDir = makeScratchDir('fake-global-bin-');
    writeFakeGlobalFezoctl(binDir, '0.9.0'); // stale relative to SKILL_VERSION below

    const { argv, stderr } = resolveViaLadder({
      skillDir,
      skillVersion: '1.0.0',
      pathOverride: `${binDir}:/usr/bin:/bin`,
    });
    expect(argv).toEqual(['npx', '-y', 'fezo-skills@1.0.0', 'fezoctl']);
    // ...and it says so, rather than handing back an argv that 404s silently.
    expect(stderr).toContain('CANNOT WORK YET');
    expect(stderr).toContain('not published to npm');
  });

  it('tier 5: the pinned npx fallback is used when nothing else resolves', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true });

    const { argv, stderr } = resolveViaLadder({
      skillDir,
      skillVersion: '2.3.4',
      pathOverride: '/usr/bin:/bin', // no fezoctl on PATH
    });
    expect(argv).toEqual(['npx', '-y', 'fezo-skills@2.3.4', 'fezoctl']);

    // C10: tier 5 cannot work while the package is unpublished, so reaching it
    // must be announced with the likely cause -- all three misses, named -- not
    // returned as though it were an ordinary fallback.
    expect(stderr).toContain('npx -y fezo-skills@2.3.4 fezoctl');
    expect(stderr).toContain('CANNOT WORK YET');
    expect(stderr).toContain('not published to npm');
    expect(stderr).toContain(`no bundle at "${skillDir}/scripts/fezoctl.mjs"`);
    expect(stderr).toContain(`no sibling bundle at "${skillDir}/../../dist/fezoctl.mjs"`);
    expect(stderr).toContain('no global fezoctl on PATH reporting version 2.3.4');
  });

  it('a versioned bundle (tier 2) outranks PATH even when a matching global fezoctl exists', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    const scriptPath = join(skillDir, 'scripts', 'fezoctl.mjs');
    writeFileSync(scriptPath, '// stub\n');

    const binDir = makeScratchDir('fake-global-bin-');
    writeFakeGlobalFezoctl(binDir, '1.0.0'); // an exact version match, but must still lose to tier 2

    const { argv, stderr } = resolveViaLadder({
      skillDir,
      skillVersion: '1.0.0',
      pathOverride: `${binDir}:/usr/bin:/bin`,
    });
    expect(argv).toEqual(['node', scriptPath]);
    expect(stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// C4: `$FEZOCTL` set but not executable.
//
// Tier 1 used to require `-x`, while tiers 2-3 deliberately do not (they invoke
// `node <path>` precisely because a copied/extracted bundle commonly loses the
// executable bit). So `FEZOCTL=/path/to/fezoctl.mjs` at mode 0644 -- a natural
// thing to set, and the mechanism SKILL.md now names for carrying the resolved
// path from one Bash call into the next -- fell silently through to tier 5.
// ---------------------------------------------------------------------------

describe('build/invocation.sh — tier 1 with a non-executable $FEZOCTL', () => {
  it('accepts a non-executable .mjs bundle and invokes it as `node <path>`', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true });
    // A plain file copy of the bundle, mode 0644 — no executable bit.
    const bundleCopy = join(spacedRoot, 'my bundle', 'fezoctl.mjs');
    mkdirSync(dirname(bundleCopy), { recursive: true });
    writeFileSync(bundleCopy, '// stub\n');
    chmodSync(bundleCopy, 0o644);

    const { argv, stderr } = resolveViaLadder({
      skillDir,
      skillVersion: '1.0.0',
      fezoctl: bundleCopy,
      pathOverride: '/usr/bin:/bin',
    });
    expect(argv).toEqual(['node', bundleCopy]);
    expect(stderr).toBe('');
  });

  it('warns on stderr and falls through when $FEZOCTL is neither executable nor a node bundle', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    const tier2 = join(skillDir, 'scripts', 'fezoctl.mjs');
    writeFileSync(tier2, '// stub\n');

    const junk = join(spacedRoot, 'not a bundle');
    writeFileSync(junk, 'this is not runnable\n');
    chmodSync(junk, 0o644);

    const { argv, stderr } = resolveViaLadder({
      skillDir,
      skillVersion: '1.0.0',
      fezoctl: junk,
      pathOverride: '/usr/bin:/bin',
    });
    // Falls through to tier 2 — but says why, instead of skipping in silence.
    expect(argv).toEqual(['node', tier2]);
    expect(stderr).toContain(`ignoring FEZOCTL=${junk}`);
    expect(stderr).toContain('not an executable file');
  });

  it('warns when $FEZOCTL names a .mjs path that does not exist', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    const tier2 = join(skillDir, 'scripts', 'fezoctl.mjs');
    writeFileSync(tier2, '// stub\n');

    const missing = join(spacedRoot, 'gone', 'fezoctl.mjs');
    const { argv, stderr } = resolveViaLadder({
      skillDir,
      skillVersion: '1.0.0',
      fezoctl: missing,
      pathOverride: '/usr/bin:/bin',
    });
    expect(argv).toEqual(['node', tier2]);
    expect(stderr).toContain(`ignoring FEZOCTL=${missing}`);
  });
});

// ---------------------------------------------------------------------------
// C3: an agent runs every command in a NEW shell.
//
// `tests/invocation_contract.test.ts`'s other scenarios necessarily source the
// ladder and read `FEZOCTL_ARGV` inside ONE bash process, so they cannot see the
// failure the skill actually produced in use: SKILL.md told the model to resolve
// once and "reuse the result for every subsequent command in this session",
// while each Bash tool call is a fresh process where `FEZOCTL_ARGV` is unset —
// so call two degraded to `search: command not found`.
//
// These tests run TWO separate `bash` processes, with nothing shared but the
// filesystem and the environment an agent could actually retype, and execute the
// REAL bundle in the second one (not a stub) so "still resolves" means "still
// runs".
// ---------------------------------------------------------------------------

describe('build/invocation.sh across two separate shell invocations', () => {
  /** A real, freshly built bundle at mode 0644 — the shape a file copy or a
   * `.skill` extraction leaves behind (see tier 2's rationale). */
  function buildNonExecutableBundle(dir: string): string {
    const bundle = join(dir, 'fezoctl.mjs');
    execFileSync('node', [bundlePath, '--out', bundle], { cwd: repoRoot, encoding: 'utf8' });
    chmodSync(bundle, 0o644);
    return bundle;
  }

  function expectedVersionLine(): string {
    const pkg: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const version = pkg !== null && typeof pkg === 'object' ? Reflect.get(pkg, 'version') : undefined;
    if (typeof version !== 'string') throw new Error('package.json has no string "version"');
    return `fezoctl ${version}`;
  }

  /** One `bash -c` process, with a minimal environment. Nothing from a previous
   * call is passed in except values named explicitly here. */
  function freshShell(script: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync('bash', ['-c', script], {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...env },
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('the resolved array is gone in the second shell, and re-establishing it in one line still runs the engine', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    const bundle = buildNonExecutableBundle(join(skillDir, 'scripts'));
    expect(bundle).toBe(join(skillDir, 'scripts', 'fezoctl.mjs'));

    // Call 1: resolve, exactly as Step 0 says, and run a command.
    const first = resolveViaLadder({ skillDir, skillVersion: '1.0.0', pathOverride: '/usr/bin:/bin' });
    expect(first.argv).toEqual(['node', bundle]);
    expect(first.stderr).toBe('');

    // Call 2, naive: a NEW shell that just reuses "${FEZOCTL_ARGV[@]}". This is
    // what the pre-fix SKILL.md instructed, and it is broken — pinned here so
    // the hazard the instructions now avoid is demonstrated, not assumed.
    const naive = freshShell('"${FEZOCTL_ARGV[@]}" --version', { SKILL_DIR: skillDir, SKILL_VERSION: '1.0.0' });
    expect(naive.status).not.toBe(0);
    expect(naive.stdout).toBe('');
    expect(naive.stderr).toContain('--version: command not found');

    // Call 2, as SKILL.md now instructs (option 2): re-establish the array in
    // one line from the path resolved earlier. The path is passed through the
    // environment, never interpolated into the script text, so a spaced path is
    // genuinely exercised.
    const reestablished = freshShell('FEZOCTL_ARGV=(node "$RESOLVED_BUNDLE"); "${FEZOCTL_ARGV[@]}" --version', {
      RESOLVED_BUNDLE: bundle,
    });
    expect(reestablished.stderr).toBe('');
    expect(reestablished.status).toBe(0);
    expect(reestablished.stdout.trim()).toBe(expectedVersionLine());

    // And option 1: re-source the resolve block itself in the new shell.
    const resourced = freshShell('source "$INVOCATION_SH"; "${FEZOCTL_ARGV[@]}" --version', {
      INVOCATION_SH: invocationShPath,
      SKILL_DIR: skillDir,
      SKILL_VERSION: '1.0.0',
    });
    expect(resourced.stderr).toBe('');
    expect(resourced.status).toBe(0);
    expect(resourced.stdout.trim()).toBe(expectedVersionLine());
  });

  it('a second shell that only carries $FEZOCTL (a non-executable bundle path) still resolves and runs', () => {
    // The other half of the C3 remedy, and the reason C4 had to be fixed first:
    // carrying just the PATH in `FEZOCTL` is the cheapest thing an agent can
    // retype, and a 0644 `.mjs` there used to fall through to tier 5's npx.
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true }); // no scripts/, no sibling dist/
    const bundleDir = join(spacedRoot, 'somewhere else');
    mkdirSync(bundleDir, { recursive: true });
    const bundle = buildNonExecutableBundle(bundleDir);

    const second = freshShell('source "$INVOCATION_SH"; "${FEZOCTL_ARGV[@]}" --version', {
      INVOCATION_SH: invocationShPath,
      SKILL_DIR: skillDir,
      SKILL_VERSION: '1.0.0',
      FEZOCTL: bundle,
      // The default PATH is kept (it is what carries `node`); tier 1 is decided
      // before tier 4 is even consulted, so an ambient global `fezoctl` cannot
      // make this scenario pass for the wrong reason.
    });
    expect(second.stderr).toBe('');
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe(expectedVersionLine());
  });
});

describe('build/invocation.sh — SKILL_DIR guard', () => {
  /** Runs the ladder with a deliberately broken SKILL_DIR and returns the
   * child's status + stderr, rather than letting `execFileSync` throw. */
  function resolveExpectingFailure(skillDir: string | undefined): { status: number | null; stderr: string } {
    const childEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      INVOCATION_SH: invocationShPath,
      SKILL_VERSION: '1.0.0',
    };
    if (skillDir !== undefined) childEnv['SKILL_DIR'] = skillDir;
    const result = spawnSync('bash', ['-c', HARNESS_SCRIPT], { env: childEnv, encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
  }

  it('fails loudly when SKILL_DIR is unset, instead of silently landing on tier 5', () => {
    const { status, stderr } = resolveExpectingFailure(undefined);
    expect(status).not.toBe(0);
    expect(stderr).toContain('SKILL_DIR must be set to the directory containing SKILL.md');
  });

  it('fails loudly when SKILL_DIR is set but empty', () => {
    const { status, stderr } = resolveExpectingFailure('');
    expect(status).not.toBe(0);
    expect(stderr).toContain('SKILL_DIR must be set to the directory containing SKILL.md');
  });
});

describe('build/invocation.sh — quoting', () => {
  it('never references $SKILL_DIR unquoted', () => {
    const text = execFileSync('cat', [invocationShPath], { encoding: 'utf8' });
    // Strip comment lines: the doc comment at the top uses "$SKILL_DIR" in
    // prose (already quoted there too, but comments are not executable and
    // are not the property under test).
    const codeLines = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'));
    const code = codeLines.join('\n');
    const unquoted = [...code.matchAll(/(?<!")\$\{?SKILL_DIR\}?/g)];
    expect(unquoted).toEqual([]);
  });

  it('resolves via a Bash argv array, never a command string', () => {
    const text = execFileSync('cat', [invocationShPath], { encoding: 'utf8' });
    expect(text).toContain('FEZOCTL_ARGV=(');
    // A command-string implementation would build up one big quoted string
    // and eval/sh -c it; this codebase must not do that.
    expect(text).not.toContain('eval ');
    expect(text).not.toMatch(/sh -c/);
  });
});
