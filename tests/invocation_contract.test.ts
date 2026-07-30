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
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const invocationShPath = join(repoRoot, 'build', 'invocation.sh');

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

function resolveViaLadder(env: LadderEnv): string[] {
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

  const raw = execFileSync('bash', ['-c', HARNESS_SCRIPT], { env: childEnv, encoding: 'utf8' });
  return raw.split('\0').filter((part) => part.length > 0);
}

/** Writes an executable fake `fezoctl` at `dir/fezoctl` that prints `version`
 * on `--version` and exits 0 for anything else, so tier 4's `command -v` +
 * `--version` check has something real to run. */
function writeFakeGlobalFezoctl(dir: string, version: string): void {
  const path = join(dir, 'fezoctl');
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nif [ "\${1:-}" = "--version" ]; then printf '%s' "${version}"; fi\nexit 0\n`,
  );
  chmodSync(path, 0o755);
}

describe('build/invocation.sh resolution ladder — SKILL_DIR containing a space', () => {
  it('tier 1: a set, executable $FEZOCTL wins outright', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true });
    const fezoctlPath = join(spacedRoot, 'custom fezoctl');
    writeFileSync(fezoctlPath, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(fezoctlPath, 0o755);

    const argv = resolveViaLadder({ skillDir, skillVersion: '1.0.0', fezoctl: fezoctlPath });
    expect(argv).toEqual([fezoctlPath]);
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

    const argv = resolveViaLadder({ skillDir, skillVersion: '1.0.0' });
    expect(argv).toEqual(['node', scriptPath]);
  });

  it('tier 3: repo-root dist/fezoctl.mjs is used when the skill-local copy is absent', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true });
    const distPath = join(spacedRoot, 'dist', 'fezoctl.mjs');
    mkdirSync(dirname(distPath), { recursive: true });
    writeFileSync(distPath, '// stub\n');

    const argv = resolveViaLadder({ skillDir, skillVersion: '1.0.0' });
    // Deliberately not `path.join`, which would normalize away the `..`
    // segments: the shell embeds the literal, unnormalized
    // "$SKILL_DIR/../../dist/fezoctl.mjs" string, and that literal string is
    // exactly what must appear in the resolved argv.
    expect(argv).toEqual(['node', `${skillDir}/../../dist/fezoctl.mjs`]);
  });

  it('tier 4: a global fezoctl is used only when --version matches SKILL_VERSION exactly', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true });
    const binDir = makeScratchDir('fake-global-bin-');
    writeFakeGlobalFezoctl(binDir, '1.0.0');

    const argv = resolveViaLadder({
      skillDir,
      skillVersion: '1.0.0',
      pathOverride: `${binDir}:/usr/bin:/bin`,
    });
    expect(argv).toEqual(['fezoctl']);
  });

  it('tier 4 is skipped (falls through to tier 5) when the global version is stale', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true });
    const binDir = makeScratchDir('fake-global-bin-');
    writeFakeGlobalFezoctl(binDir, '0.9.0'); // stale relative to SKILL_VERSION below

    const argv = resolveViaLadder({
      skillDir,
      skillVersion: '1.0.0',
      pathOverride: `${binDir}:/usr/bin:/bin`,
    });
    expect(argv).toEqual(['npx', '-y', 'fezo-skills@1.0.0', 'fezoctl']);
  });

  it('tier 5: the pinned npx fallback is used when nothing else resolves', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(skillDir, { recursive: true });

    const argv = resolveViaLadder({
      skillDir,
      skillVersion: '2.3.4',
      pathOverride: '/usr/bin:/bin', // no fezoctl on PATH
    });
    expect(argv).toEqual(['npx', '-y', 'fezo-skills@2.3.4', 'fezoctl']);
  });

  it('a versioned bundle (tier 2) outranks PATH even when a matching global fezoctl exists', () => {
    const spacedRoot = makeScratchDir('fezo skill root-');
    const skillDir = join(spacedRoot, 'skills', 'fezo');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    const scriptPath = join(skillDir, 'scripts', 'fezoctl.mjs');
    writeFileSync(scriptPath, '// stub\n');

    const binDir = makeScratchDir('fake-global-bin-');
    writeFakeGlobalFezoctl(binDir, '1.0.0'); // an exact version match, but must still lose to tier 2

    const argv = resolveViaLadder({
      skillDir,
      skillVersion: '1.0.0',
      pathOverride: `${binDir}:/usr/bin:/bin`,
    });
    expect(argv).toEqual(['node', scriptPath]);
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
