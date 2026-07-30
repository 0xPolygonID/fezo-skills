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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('the Examples block expands FEZOCTL_ARGV as a quoted array, "${FEZOCTL_ARGV[@]}"', () => {
    expect(skillMd).toContain('"${FEZOCTL_ARGV[@]}"');
    // Guard against a regression to an unquoted or scalar-style expansion.
    expect(skillMd).not.toMatch(/(?<!")\$FEZOCTL_ARGV(?!\[)/);
    expect(skillMd).not.toContain('$FEZOCTL_ARGV[@]"'); // missing open quote
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
    // Ensure both artifacts exist and are fresh before invoking pack:check,
    // which assumes the build already ran (see build/pack-check.mjs's own
    // comment on why it packs with --ignore-scripts).
    execFileSync('node', [bundlePath], { cwd: repoRoot, encoding: 'utf8' });
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
    execFileSync('node', [bundlePath], { cwd: repoRoot, encoding: 'utf8' });
    const dist = readFileSync(distBundlePath);
    const copy = readFileSync(skillScriptPath);
    expect(copy.equals(dist)).toBe(true);
    const mode = statSync(skillScriptPath).mode & 0o777;
    expect(mode).toBe(0o755);
  });
});

