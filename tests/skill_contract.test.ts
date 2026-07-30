// Contract tests for the generated `skills/fezo/SKILL.md` and the two
// artifacts its packaging story depends on: `dist/fezoctl.mjs` (the
// committed, deterministic bundle) and `skills/fezo/scripts/fezoctl.mjs`
// (the gitignored, pack/build-time copy of the same bundle).
//
// Per this project's test-hygiene rule ("a test that merely re-reads a
// generated file it also generated proves nothing"): frontmatter field
// assertions below compare against literal expected values transcribed from
// the governing specification, not against `build/gen-skill.mjs`'s own
// constants; the Step 0 / invocation-block presence checks compare against
// `build/step0.md` and `build/invocation.sh` read directly from disk; and
// the two reproducibility checks build into scratch files that are diffed
// against each other and against the pre-existing committed artifact, never
// against a file the test itself just wrote.
//
// Related, and previously WRONG: two tests here did run the default `node
// build/bundle.mjs`, which rewrites dist/fezoctl.mjs in place, so the suite DID
// overwrite the committed artifact and the freshness assertion above was
// non-vacuous only by accident of describe ordering. Both now go through
// `withCommittedDistPreserved` or build to a scratch path — see that helper.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const skillMdPath = join(repoRoot, 'skills', 'fezo', 'SKILL.md');
const skillDirPath = join(repoRoot, 'skills', 'fezo');
const step0Path = join(repoRoot, 'build', 'step0.md');
const invocationShPath = join(repoRoot, 'build', 'invocation.sh');
const genSkillPath = join(repoRoot, 'build', 'gen-skill.mjs');
const bundlePath = join(repoRoot, 'build', 'bundle.mjs');
const distBundlePath = join(repoRoot, 'dist', 'fezoctl.mjs');
const skillScriptPath = join(repoRoot, 'skills', 'fezo', 'scripts', 'fezoctl.mjs');
const packageJsonPath = join(repoRoot, 'package.json');

const skillMd = readFileSync(skillMdPath, 'utf8');

function packageVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const version = pkg !== null && typeof pkg === 'object' ? Reflect.get(pkg, 'version') : undefined;
  if (typeof version !== 'string') throw new Error('package.json has no string "version"');
  return version;
}

// ---------------------------------------------------------------------------
// No test in this file may overwrite the committed `dist/fezoctl.mjs`.
//
// Two tests below must exercise the DEFAULT `node build/bundle.mjs`
// invocation, because "the default invocation also copies the bundle into the
// skill directory" is the property they test — and that invocation writes
// dist/fezoctl.mjs by definition. So they run inside this guard, which
// snapshots the committed bytes and mode beforehand and restores them
// afterwards, unconditionally.
//
// This matters beyond tidiness: the freshness assertion in
// "dist/fezoctl.mjs reproducibility" compares a scratch build against the
// COMMITTED file. If any test in the suite rebuilt dist/ in place, that
// assertion would silently become "a fresh build matches a fresh build" —
// vacuous — depending only on which describe happened to run first.
// ---------------------------------------------------------------------------
function withCommittedDistPreserved<T>(fn: () => T): T {
  const original = readFileSync(distBundlePath);
  const originalMode = statSync(distBundlePath).mode & 0o777;
  try {
    return fn();
  } finally {
    writeFileSync(distBundlePath, original);
    chmodSync(distBundlePath, originalMode);
  }
}

// ---------------------------------------------------------------------------
// A small, purpose-built frontmatter extractor. This is not a general YAML
// parser — it only needs to handle this project's fixed, flat-plus-one-level
// frontmatter shape, and deliberately does not reuse anything from
// `build/gen-skill.mjs` (see file-level comment on independence).
// ---------------------------------------------------------------------------

function extractFrontmatter(content: string): { block: string; fields: Map<string, string> } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (match === null) throw new Error('SKILL.md has no --- frontmatter block');
  const block = match[1];
  if (block === undefined) throw new Error('frontmatter capture group was empty');
  const fields = new Map<string, string>();
  for (const line of block.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) continue; // nested value, not a top-level key
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    fields.set(key, value);
  }
  return { block, fields };
}

const { block: frontmatterBlock, fields: frontmatter } = extractFrontmatter(skillMd);

function requireField(key: string): string {
  const value = frontmatter.get(key);
  if (value === undefined) throw new Error(`frontmatter is missing required key "${key}"`);
  return value;
}

describe('skills/fezo/SKILL.md frontmatter', () => {
  it('name equals the skill directory name', () => {
    expect(requireField('name')).toBe('fezo');
    expect(requireField('name')).toBe(basename(skillDirPath));
  });

  it('version is top-level and is "1.0.0" (the value baked into SKILL_VERSION below)', () => {
    expect(requireField('version')).toBe('"1.0.0"');
  });

  // ONE version number, not two. The frontmatter `version` IS the value baked
  // in as `SKILL_VERSION`, which is used for two package facts: the tier-5
  // `npx -y fezo-skills@$SKILL_VERSION` pin and the tier-4 exact-match
  // comparison against a global install's `--version`. A frontmatter version
  // that drifts from the published package version pins a version that cannot
  // exist. Asserted against package.json read from disk — not against
  // gen-skill.mjs's own constant, which is derived from the same source and so
  // could not disagree.
  it("version equals package.json's version", () => {
    expect(requireField('version')).toBe(`"${packageVersion()}"`);
  });

  it('argument-hint is present', () => {
    expect(requireField('argument-hint').length).toBeGreaterThan(0);
  });

  it('user-invocable is true', () => {
    expect(requireField('user-invocable')).toBe('true');
  });

  it('description includes every required activation noun', () => {
    const description = requireField('description');
    const requiredNouns = ['search', 'scraping', 'market', 'social', 'product', 'external', 'catalog', 'provider', 'retry'];
    for (const noun of requiredNouns) {
      expect(description.toLowerCase(), `description should mention "${noun}"`).toContain(noun);
    }
  });

  it('allowed-tools is exactly "Bash, Read, AskUserQuestion"', () => {
    expect(requireField('allowed-tools')).toBe('Bash, Read, AskUserQuestion');
  });

  it('homepage, repository, and license are present', () => {
    expect(requireField('homepage').length).toBeGreaterThan(0);
    expect(requireField('repository').length).toBeGreaterThan(0);
    expect(requireField('license').length).toBeGreaterThan(0);
  });

  it('has no metadata.fezo.methods field (no static method roster)', () => {
    // The nested "methods:" key would appear indented under "  fezo:" in the
    // raw frontmatter block if present — check the raw block text, since
    // the flat extractor above intentionally skips indented (nested) lines.
    expect(frontmatterBlock).not.toMatch(/^\s+methods:/m);
  });
});

function basename(path: string): string {
  const parts = path.split('/');
  const last = parts[parts.length - 1];
  return last ?? '';
}

describe('skills/fezo/SKILL.md generated content', () => {
  it('contains the Step 0 block verbatim from build/step0.md', () => {
    const step0Source = readFileSync(step0Path, 'utf8').replace(/\n+$/, '');
    expect(skillMd).toContain(step0Source);
  });

  it('contains the invocation ladder verbatim from build/invocation.sh, with SKILL_VERSION baked in', () => {
    const invocationSource = readFileSync(invocationShPath, 'utf8').replace(/\n+$/, '');
    expect(skillMd).toContain(invocationSource);
    expect(skillMd).toContain('SKILL_VERSION="1.0.0"');
  });

  it("the baked-in SKILL_VERSION equals package.json's version, so the tier-5 npx pin names a real release", () => {
    expect(skillMd).toContain(`SKILL_VERSION="${packageVersion()}"`);
    expect(skillMd).toContain(`fezo-skills@\${SKILL_VERSION}`);
  });

  it('the Examples block expands FEZOCTL_ARGV as a quoted array, "${FEZOCTL_ARGV[@]}"', () => {
    expect(skillMd).toContain('"${FEZOCTL_ARGV[@]}"');
    // Guard against a regression to an unquoted or scalar-style expansion.
    expect(skillMd).not.toMatch(/(?<!")\$FEZOCTL_ARGV(?!\[)/);
    expect(skillMd).not.toContain('$FEZOCTL_ARGV[@]"'); // missing open quote
  });

  it('instructs setup through the resolved array, never a bare `fezoctl` command', () => {
    // A literal `fezoctl` exists as a command only in tier 4; tiers 1, 2, 3 and
    // 5 resolve to a path, `node <path>`, or `npx ...`, so a bare
    // `fezoctl setup --key-stdin` in the instructions is a command not found
    // for the common cases.
    expect(skillMd).toContain('"${FEZOCTL_ARGV[@]}" setup --key-stdin');
    // No prose or example anywhere tells the agent to run a bare `fezoctl <cmd>`.
    // The invocation script's own comments legitimately discuss the literal
    // `fezoctl` binary and `fezoctl --version`, so comment lines are excluded.
    const nonCommentLines = skillMd
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(nonCommentLines).not.toMatch(/(?<![-`"\w])fezoctl (setup|search|call|run|schema|catalog|doctor)\b/);
  });

  it('does not enumerate a fixed backend/method roster', () => {
    expect(skillMd).not.toMatch(/methods:/);
  });
});

describe('skills/fezo/SKILL.md is reproducible from build/gen-skill.mjs', () => {
  it('a fresh run of the generator produces byte-identical output to the committed file', () => {
    const stdout = execFileSync('node', [genSkillPath, '--stdout'], { encoding: 'utf8' });
    expect(stdout).toBe(skillMd);
  });
});

// ---------------------------------------------------------------------------
// dist/fezoctl.mjs: determinism (two independent builds match each other)
// and freshness (a fresh build matches the pre-existing committed file,
// which this test never overwrites).
// ---------------------------------------------------------------------------

const scratchFiles: string[] = [];

afterEach(() => {
  while (scratchFiles.length > 0) {
    const file = scratchFiles.pop();
    if (file !== undefined) rmSync(file, { force: true });
  }
});

function buildBundleTo(outPath: string): void {
  execFileSync('node', [bundlePath, '--out', outPath], { encoding: 'utf8' });
  scratchFiles.push(outPath);
}

describe('dist/fezoctl.mjs reproducibility', () => {
  it('two independent builds from source are byte-identical', () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'fezoctl-bundle-'));
    const outA = join(scratchDir, 'a.mjs');
    const outB = join(scratchDir, 'b.mjs');
    buildBundleTo(outA);
    buildBundleTo(outB);
    const a = readFileSync(outA);
    const b = readFileSync(outB);
    expect(a.equals(b)).toBe(true);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('a fresh build matches the committed dist/fezoctl.mjs exactly (CI\'s freshness gate)', () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'fezoctl-bundle-'));
    const out = join(scratchDir, 'fresh.mjs');
    buildBundleTo(out);
    const fresh = readFileSync(out);
    const committed = readFileSync(distBundlePath);
    expect(fresh.equals(committed)).toBe(true);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('has a #!/usr/bin/env node shebang and mode 0755', () => {
    const content = readFileSync(distBundlePath, 'utf8');
    expect(content.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const mode = statSync(distBundlePath).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('contains no absolute filesystem paths', () => {
    const content = readFileSync(distBundlePath, 'utf8');
    expect(content).not.toContain(repoRoot);
    expect(content).not.toMatch(/\/(Users|home)\//);
  });

  it("the built artifact's --version equals package.json's version", () => {
    const stdout = execFileSync('node', [distBundlePath, '--version'], { encoding: 'utf8' });
    const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const pkgVersion = pkg !== null && typeof pkg === 'object' ? Reflect.get(pkg, 'version') : undefined;
    expect(typeof pkgVersion).toBe('string');
    expect(stdout.trim()).toBe(`fezoctl ${String(pkgVersion)}`);
  });
});

// ---------------------------------------------------------------------------
// The bundle's entry-point footer. `main()` is async, so a bare `main();`
// footer would turn any unexpected throw into an unhandled rejection (stack
// trace + a process-level warning) rather than the clean non-zero exit the
// CLI's error contract promises. Executed against the PRODUCTION footer string
// imported from build/bundle.mjs, not a re-typed copy of it.
// ---------------------------------------------------------------------------

describe("dist/fezoctl.mjs entry-point footer handles main()'s promise", () => {
  it('the committed bundle does not end in a bare, unhandled `main();`', () => {
    const content = readFileSync(distBundlePath, 'utf8');
    expect(content).toContain('main().catch(');
    expect(content).not.toMatch(/^main\(\);$/m);
  });

  it('a throwing main() exits non-zero with a message instead of an unhandled rejection', () => {
    // Reads the PRODUCTION footer string out of build/bundle.mjs (a plain .mjs
    // with no type declarations, hence the subprocess rather than an `import`),
    // so this cannot drift from what the bundler actually emits.
    const FOOTER_JS = execFileSync(
      'node',
      ['--input-type=module', '-e', `import { FOOTER_JS } from ${JSON.stringify(pathToFileURL(bundlePath).href)}; process.stdout.write(FOOTER_JS);`],
      { encoding: 'utf8' },
    );
    expect(FOOTER_JS.length).toBeGreaterThan(0);

    const scratchDir = mkdtempSync(join(tmpdir(), 'fezoctl-footer-'));
    try {
      const modulePath = join(scratchDir, 'throwing.mjs');
      writeFileSync(modulePath, `async function main() { throw new Error('simulated bundle-entry failure'); }\n${FOOTER_JS}\n`);
      const result = spawnSync('node', [modulePath], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fezoctl: ');
      expect(result.stderr).toContain('simulated bundle-entry failure');
      // The distinguishing symptom of the bare-`main();` bug.
      expect(result.stderr).not.toContain('UnhandledPromiseRejection');
      expect(result.stderr).not.toContain('unhandledRejection');
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The skill-local bundle copy: gitignored in the working tree, but must
// exist in an actual npm-published tarball. Chains carry-forward #1 and #6.
// ---------------------------------------------------------------------------

describe('skills/fezo/scripts/fezoctl.mjs packaging', () => {
  it('is gitignored (git check-ignore matches it)', () => {
    // `execFileSync` throws on a non-zero exit; git check-ignore exits 1
    // when a path is NOT ignored, so a throw here would itself be the
    // failure signal. We still assert on stdout for a clear message.
    const stdout = execFileSync('git', ['check-ignore', skillScriptPath], { cwd: repoRoot, encoding: 'utf8' });
    expect(stdout.trim()).toBe(skillScriptPath);
  });

  it('dist/fezoctl.mjs is NOT gitignored (it is the deliberately committed artifact)', () => {
    let ignored = false;
    try {
      execFileSync('git', ['check-ignore', distBundlePath], { cwd: repoRoot, encoding: 'utf8' });
      ignored = true;
    } catch {
      ignored = false;
    }
    expect(ignored).toBe(false);
  });

  it('dist/fezoctl.mjs is marked linguist-generated -diff via .gitattributes', () => {
    const stdout = execFileSync('git', ['check-attr', 'linguist-generated', 'diff', '--', distBundlePath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(stdout).toContain('linguist-generated: set');
    expect(stdout).toContain('diff: unset');
  });

  it('is present in real npm pack output despite being gitignored (pack:check passes)', () => {
    // pack:check assumes the build already ran (see build/pack-check.mjs's own
    // comment on why it packs with --ignore-scripts), so the gitignored
    // skill-local copy must exist. Build to a SCRATCH path and copy explicitly
    // into the skill directory rather than running the default `node
    // build/bundle.mjs`, which would also rewrite the committed
    // dist/fezoctl.mjs — see `withCommittedDistPreserved`'s comment for why no
    // test may do that in place.
    const scratchDir = mkdtempSync(join(tmpdir(), 'fezoctl-packcheck-'));
    try {
      const scratchBundle = join(scratchDir, 'fezoctl.mjs');
      execFileSync('node', [bundlePath, '--out', scratchBundle], { cwd: repoRoot, encoding: 'utf8' });
      copyFileSync(scratchBundle, skillScriptPath);
      chmodSync(skillScriptPath, 0o755);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
    let stdout = '';
    let stderr = '';
    let failed = false;
    try {
      stdout = execFileSync('node', [join(repoRoot, 'build', 'pack-check.mjs')], { cwd: repoRoot, encoding: 'utf8' });
    } catch (error) {
      failed = true;
      if (error !== null && typeof error === 'object') {
        const stdoutProp = Reflect.get(error, 'stdout');
        const stderrProp = Reflect.get(error, 'stderr');
        if (typeof stdoutProp === 'string') stdout = stdoutProp;
        if (typeof stderrProp === 'string') stderr = stderrProp;
      }
    }
    expect(failed, `pack:check failed; stdout=${stdout} stderr=${stderr}`).toBe(false);
    expect(stdout).toContain('skills/fezo/scripts/fezoctl.mjs present');
  });
});

describe('skill-local bundle copy is byte-identical to dist/fezoctl.mjs after a fresh build', () => {
  it('matches after `node build/bundle.mjs` (the pack/build copy step)', () => {
    // The property under test is specifically that the DEFAULT invocation
    // performs the copy step, so this must run `node build/bundle.mjs` with no
    // `--out` — which writes dist/fezoctl.mjs. The guard restores the committed
    // bytes and mode afterwards so the suite leaves the tracked artifact
    // untouched regardless of describe ordering.
    withCommittedDistPreserved(() => {
      execFileSync('node', [bundlePath], { cwd: repoRoot, encoding: 'utf8' });
      const dist = readFileSync(distBundlePath);
      const copy = readFileSync(skillScriptPath);
      expect(copy.equals(dist)).toBe(true);
      const mode = statSync(skillScriptPath).mode & 0o777;
      expect(mode).toBe(0o755);
    });
  });
});

// ---------------------------------------------------------------------------
// The skill-local copy must be able to report its own version. It sits TWO
// levels below the package root, so the pre-fix `../package.json` walk in
// `resolveVersion`'s fallback resolves to a nonexistent
// `skills/fezo/package.json`. This is executed, not reasoned about: the
// artifact most users install is run as a real process.
// ---------------------------------------------------------------------------

describe('skills/fezo/scripts/fezoctl.mjs reports its own version', () => {
  it("--version prints `fezoctl <package.json version>` from the skill-local copy", () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'fezoctl-skillver-'));
    try {
      // Same scratch-build-then-copy discipline as the pack:check test: never
      // rebuild the committed dist/ in place.
      const scratchBundle = join(scratchDir, 'fezoctl.mjs');
      execFileSync('node', [bundlePath, '--out', scratchBundle], { cwd: repoRoot, encoding: 'utf8' });
      copyFileSync(scratchBundle, skillScriptPath);
      chmodSync(skillScriptPath, 0o755);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }

    const stdout = execFileSync('node', [skillScriptPath, '--version'], { encoding: 'utf8' });
    expect(stdout.trim()).toBe(`fezoctl ${packageVersion()}`);
  });

  it('the skill directory is self-sufficient: --version works with no package.json anywhere above it', () => {
    // Copy just `skills/fezo/` into an isolated scratch tree — no package.json
    // at any ancestor — which is exactly what a host copying the skill
    // directory alone produces. The build-time constant is what makes this
    // work; the filesystem fallback cannot.
    const scratchDir = mkdtempSync(join(tmpdir(), 'fezoctl-standalone-'));
    try {
      const scriptsDir = join(scratchDir, 'fezo', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      const standalone = join(scriptsDir, 'fezoctl.mjs');
      execFileSync('node', [bundlePath, '--out', standalone], { cwd: repoRoot, encoding: 'utf8' });
      const stdout = execFileSync('node', [standalone, '--version'], { encoding: 'utf8' });
      expect(stdout.trim()).toBe(`fezoctl ${packageVersion()}`);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

