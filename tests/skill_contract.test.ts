// Contract tests for the generated `skills/fezo/SKILL.md` and the two
// artifacts its packaging story depends on: `dist/fezoctl.mjs` (the
// committed, deterministic bundle) and `skills/fezo/scripts/fezoctl.mjs`
// (a committed, byte-identical copy of it that makes the skill directory
// self-contained).
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
// `withCommittedBundlesPreserved` or build to a scratch path — see that helper.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli.js';
import { ONE_STEP_COMMANDS, ONE_STEP_DESCRIPTIONS } from '../src/engine/steering.js';

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
/** `skillMd` with every whitespace run collapsed to one space, for asserting on
 * prose phrases that legitimately wrap across lines: the property under test is
 * the wording, not where the paragraph happens to break. */
const skillMdFlat = skillMd.replace(/\s+/g, ' ');

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
//
// `skills/fezo/scripts/fezoctl.mjs` is committed too, and several tests below
// overwrite it, so it gets the same treatment: the suite must leave BOTH
// tracked artifacts byte-for-byte as it found them, or a passing local run
// still dirties the working tree.
// ---------------------------------------------------------------------------
function withCommittedBundlesPreserved<T>(fn: () => T): T {
  const snapshots = [distBundlePath, skillScriptPath].map((path) => ({
    path,
    bytes: readFileSync(path),
    mode: statSync(path).mode & 0o777,
  }));
  try {
    return fn();
  } finally {
    for (const { path, bytes, mode } of snapshots) {
      writeFileSync(path, bytes);
      chmodSync(path, mode);
    }
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

  it('every FEZOCTL_ARGV expansion in the file is the quoted array form "${FEZOCTL_ARGV[@]}"', () => {
    expect(skillMd).toContain('"${FEZOCTL_ARGV[@]}"');
    expect(skillMd).not.toContain('$FEZOCTL_ARGV[@]"'); // missing open quote

    // A POSITIVE count, not a negative regex. The previous guard here was
    // `not.toMatch(/(?<!")\$FEZOCTL_ARGV(?!\[)/)`, whose lookbehind was inert
    // (`"${FEZOCTL_ARGV[@]}"` contains `{`, so `\$FEZOCTL_ARGV` could never
    // match it) and which therefore PASSED for the two spellings that matter
    // most: `${FEZOCTL_ARGV[@]}` unquoted (word-splits on a spaced SKILL_DIR --
    // the exact hazard the argv-array decision exists to survive) and
    // `"$FEZOCTL_ARGV"` (a quoted scalar, which expands to element 0 alone, so
    // `node /path/x.mjs` becomes bare `node`).
    //
    // Counting instead: every place the variable is READ (`$FEZOCTL_ARGV` or
    // `${FEZOCTL_ARGV...`) must be one of the fully quoted array expansions.
    // Assignments (`FEZOCTL_ARGV=(`) and prose mentions carry no `$` and so are
    // not counted. Both regression spellings above make the two counts differ.
    const reads = [...skillMd.matchAll(/\$\{?FEZOCTL_ARGV/g)];
    const quotedArrayExpansions = [...skillMd.matchAll(/"\$\{FEZOCTL_ARGV\[@\]\}"/g)];
    expect(quotedArrayExpansions.length).toBeGreaterThan(0);
    expect(reads.length, `every FEZOCTL_ARGV expansion must be "\${FEZOCTL_ARGV[@]}"; found ${String(reads.length)} expansion(s) but only ${String(quotedArrayExpansions.length)} in the quoted array form`).toBe(
      quotedArrayExpansions.length,
    );
  });

  // ---------------------------------------------------------------------------
  // C3: the file must not tell the model to resolve once and reuse the result
  // across Bash calls. Each Bash tool call is a fresh shell, so `FEZOCTL_ARGV`
  // is unset on call two and every command after the first degrades to
  // `<subcommand>: command not found`. See the two-shell execution test in
  // tests/invocation_contract.test.ts for the behavioral half of this.
  // ---------------------------------------------------------------------------

  it('tells the model that each Bash call is a fresh shell and FEZOCTL_ARGV must be re-established', () => {
    expect(skillMd).toContain('each Bash tool call runs in a NEW');
    expect(skillMd).toContain('Nothing set in one call survives into the next');
    expect(skillMd).toContain('re-establish the array before using it');
    // The one-line re-establishment it offers must itself be an array literal.
    expect(skillMd).toContain('FEZOCTL_ARGV=(node "/absolute/path/to/fezoctl.mjs")');
    // ...and the pre-fix instruction must be gone.
    expect(skillMd).not.toContain('for every subsequent command in this session');
  });

  // Option 1 (re-paste the resolve block) has a prerequisite the same paragraph
  // says does not survive a fresh shell: SKILL_DIR. Sourcing the block without
  // it hits the `:?` guard and aborts, so the option is only usable if the
  // model sets SKILL_DIR too. Anchored on the sentence that says so, not on the
  // guard's message alone — that message also appears inside the invocation
  // block, so asserting it by itself would pass vacuously.
  it('names SKILL_DIR as a prerequisite of re-pasting the resolve block', () => {
    expect(skillMdFlat).toContain('and set `SKILL_DIR` again in that same call, first');
    expect(skillMdFlat).toContain('sourcing the block aborts with `SKILL_DIR must be set');
    expect(skillMdFlat).toContain('With `SKILL_DIR` set, the block is idempotent and does no network I/O');
  });

  // The ladder is two sections below this sentence (`## Resolve fezoctl`), not
  // in the block that immediately follows it.
  it('points at the resolve section by name rather than at "the next block"', () => {
    expect(skillMdFlat).toContain('resolve the engine with the ladder in the `## Resolve fezoctl` section below');
    expect(skillMdFlat).not.toContain('resolve the engine with the ladder in the next block');
  });

  // ---------------------------------------------------------------------------
  // C2: the credential-leak prohibitions. `allowed-tools` grants
  // `AskUserQuestion` (deliberately — the modal has a legitimate NON-secret use,
  // and the governing spec fixes that exact string), the skill tells the model to
  // run `setup`, and in an agent Bash tool stdin is closed. So the file itself
  // has to rule out both leaking moves and name the correct third one; the rule
  // living only in `src/engine/credentials.ts` (which has no UI) and in
  // `CONFIGURATION.md` (which no model reads) is what made this reachable.
  //
  // Anchored on literal phrases, so dropping or softening the wording fails.
  // ---------------------------------------------------------------------------

  it('forbids collecting the API key through AskUserQuestion, and says why', () => {
    expect(skillMd).toContain('**Never collect the API key through `AskUserQuestion`**');
    expect(skillMdFlat).toContain('becomes part of the conversation transcript, which is persisted');
    expect(skillMd).toContain('a live key in a transcript is a leaked key');
  });

  it('forbids putting the API key in a Bash command the model constructs, and says why', () => {
    expect(skillMd).toContain('**Never put the API key in a Bash command you construct**');
    expect(skillMd).toContain("printf '%s' 'sk-live-…' | ...");
    expect(skillMdFlat).toContain('places the key in that process\'s argv, where any local process can read it with `ps`');
    expect(skillMdFlat).toContain('writes it into the shell history file');
  });

  it('gives the correct third move: the user runs setup themselves', () => {
    expect(skillMdFlat).toContain('stop and ask the user to run `setup` themselves, in their own terminal');
    expect(skillMd).toContain('it never reaches the conversation or an argv');
  });

  // -------------------------------------------------------------------------
  // C2b: the mechanics of that third move must match what `setup --key-stdin`
  // actually does. Two verified facts the previous wording got wrong:
  //
  //   1. `setup --key-stdin` prints NOTHING before reading — `cmdSetup` goes
  //      straight to `readSecretFromStream(stdin)`, which drains the stream to
  //      EOF. A user told to "paste the key at its prompt" gets a blank
  //      terminal and no hint that Ctrl-D is what ends the read.
  //   2. A Claude Code `!` command (and every agent Bash call) has
  //      non-interactive stdin and no controlling terminal — verified: opening
  //      `/dev/tty` there fails with ENXIO — so `setup --key-stdin` reads
  //      immediate EOF, stores nothing and exits 2. The `!` form the file used
  //      to *prefer* was therefore a guaranteed failure.
  //
  // Anchored on literal phrases, and paired with negative assertions on the
  // exact pre-fix strings so neither wrong mechanism can come back.
  // -------------------------------------------------------------------------

  it('says setup prints no prompt, and gives a form that works in a real terminal', () => {
    expect(skillMd).toContain('`setup` **prints no prompt of any kind**');
    expect(skillMdFlat).toContain('Never tell the user to "paste the key at its prompt": there is no prompt');
    // The verified, non-echoing one-liner: prompt from the shell, key read with
    // `read -rs`, handed over through a builtin `printf` pipe so it is in
    // neither an argv nor the history line.
    expect(skillMd).toContain(
      `printf 'Fezo API key: '; read -rs KEY; echo; printf '%s' "$KEY" | node /absolute/path/to/fezoctl.mjs setup; unset KEY`,
    );
    expect(skillMdFlat).toContain('`printf` is a shell builtin in bash and zsh, so no separate process is spawned');
    // ...and it must say WHY that pipe is not the second bullet's forbidden
    // form, or the two paragraphs read as contradicting each other and the
    // model falls back to "I must not suggest any pipe at all".
    expect(skillMdFlat).toContain('This is not the forbidden form from the second bullet: the key never appears as a literal anywhere');
    expect(skillMdFlat).toContain('The forbidden thing is a command in which YOU have written the key out');
    // ...and the bare form documented with the EOF step it actually needs.
    expect(skillMdFlat).toContain('type or paste the key, press Enter, then press Ctrl-D');
    // The pre-fix promise of a prompt must be gone.
    expect(skillMdFlat).not.toContain('they paste the key at its prompt');
  });

  it('rules out the `!` shortcut instead of prescribing it, and says why it cannot work', () => {
    expect(skillMd).toContain('Do NOT hand the user a `! ...` command for this');
    expect(skillMdFlat).toContain('A Claude Code `!` command runs with non-interactive stdin and no controlling terminal');
    expect(skillMdFlat).toContain('reads end-of-file immediately, stores nothing, and exits 2');
    expect(skillMdFlat).toContain('The user runs it in their own terminal, outside this session');
    // The exact pre-fix instruction and its command line, both of which were
    // verified to fail with exit 2, must not reappear.
    expect(skillMd).not.toContain('typing `!` followed by the command');
    expect(skillMd).not.toContain('! node /absolute/path/to/fezoctl.mjs setup');
  });

  // The failure output SKILL.md quotes for that case is labelled "verified", so
  // pin it to what the engine actually prints rather than to a transcript
  // somebody pasted once. Stale-but-labelled-verified output is the exact defect
  // this pass exists to fix, in the file a model reads.
  it('the failure output it quotes for the `!` case is what setup actually prints on an empty stdin', async () => {
    const quoted = skillMd.match(/The whole output, verified:\n\n```\n([\s\S]*?)\n```\n/);
    expect(quoted?.[1], 'SKILL.md must quote the verified failure output in a fenced block').toBeTypeOf('string');

    const dir = mkdtempSync(join(tmpdir(), 'fezoctl-skillmd-nokey-'));
    try {
      const result = await runCli(['setup'], {
        // An empty stream is exactly what a `!` command's non-interactive stdin
        // delivers: readable, immediately at EOF.
        stdin: Readable.from([]),
        dotEnvPath: join(dir, '.env'),
        env: {},
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout.trimEnd()).toBe(quoted?.[1]);
      expect(result.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ranks setup above an exported FEZO_API_KEY, with the reason', () => {
    expect(skillMdFlat).toContain('An exported `FEZO_API_KEY` is **not** a shortcut around that');
    expect(skillMdFlat).toContain('invisible to this already-running session');
    expect(skillMdFlat).toContain('takes effect immediately, which is why it is the option to offer first');
  });

  it('names what the modal MAY collect: the gateway URL and the storage choice, both non-secret', () => {
    expect(skillMdFlat).toContain('What you MAY collect through `AskUserQuestion`: the **gateway URL** and the **storage choice**');
    expect(skillMd).toContain('**storage choice** (`dotenv` or `keychain`)');
    expect(skillMdFlat).toContain('Neither is a secret; the API key is the only value that is');
  });

  // C1: the recipe the model follows must produce a USABLE configuration. Every
  // flag now has a default, so the recipe is the bare command -- and what the
  // file has to say is which single input is still load-bearing.
  it('the setup recipe is the bare command, and says what is and is not optional', () => {
    expect(skillMd).toContain('"${FEZOCTL_ARGV[@]}" setup\n');
    expect(skillMdFlat).toContain('Every flag is optional');
    expect(skillMdFlat).toContain('What is NOT optional is the key');
    expect(skillMdFlat).toContain('exits non-zero');
  });

  // The one form that must never work, and the one the request "setup should
  // take only the API key" most invites someone to try.
  it('forbids passing the key as an argument, and says to rotate one already typed', () => {
    expect(skillMdFlat).toContain('**Never write the key as an argument.**');
    expect(skillMdFlat).toContain('A `setup <key>` form is refused outright (exit 1)');
    expect(skillMdFlat).toContain('tell them to rotate the key');
  });

  // Defaults are only a simplification if the file says they exist; otherwise
  // the model keeps passing flags it does not need.
  it('states that setup takes one input and everything else defaults', () => {
    expect(skillMdFlat).toContain('`setup` takes exactly one input, the API key, and reads it from **stdin**');
    expect(skillMdFlat).toContain('do not add flags the user does not need');
  });

  // The skill must not send the model hunting for a gateway URL that already
  // resolves: "not configured" for the URL is a normal, working state.
  it('states the built-in default gateway URL and that only the API key can be missing', () => {
    expect(skillMd).toContain('https://fezo.ai');
    expect(skillMdFlat).toContain('the only credential that can be missing is the API key');
    expect(skillMdFlat).toContain('never ask the user for one just because');
  });

  // The `"${FEZOCTL_ARGV[@]}"` recipe above is required by the argv-array
  // contract (see the test below), but it is NOT what the user types — their
  // shell never ran the resolve block. The file has to say which form belongs
  // to whom, or the model hands over a line that expands to nothing.
  it('distinguishes the array form the model uses from the expanded form the user types', () => {
    expect(skillMdFlat).toContain('That is the form YOU would use');
    expect(skillMdFlat).toContain('It is **not** the form to show the user: their shell never ran the resolve block');
    expect(skillMdFlat).toContain('would expand to `setup: command not found`');
    expect(skillMdFlat).toContain('Expand it to the literal invocation step 0 resolved');
  });

  it('instructs setup through the resolved array, never a bare `fezoctl` command', () => {
    // A literal `fezoctl` exists as a command only in tier 4; tiers 1, 2, 3 and
    // 5 resolve to a path, `node <path>`, or `npx ...`, so a bare
    // `fezoctl setup --key-stdin` in the instructions is a command not found
    // for the common cases.
    expect(skillMd).toContain('"${FEZOCTL_ARGV[@]}" setup');
    // No prose or example anywhere tells the agent to run a bare `fezoctl <cmd>`.
    // The invocation script's own comments legitimately discuss the literal
    // `fezoctl` binary and `fezoctl --version`, so comment lines are excluded.
    const nonCommentLines = skillMd
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    // The lookbehind excludes a preceding hyphen or word character (so
    // "non-fezoctl" or "myfezoctl" aren't false positives), but deliberately
    // does NOT exclude a preceding backtick or quote: the regression this
    // guards against was itself backticked prose (`` `fezoctl setup
    // --key-stdin` ``), so excluding those characters would let that exact
    // phrasing slip back in silently.
    expect(nonCommentLines).not.toMatch(/(?<![-\w])fezoctl (setup|search|call|run|schema|catalog|doctor)\b/);
  });

  it('does not enumerate a fixed backend/method roster', () => {
    expect(skillMd).not.toMatch(/methods:/);
  });

  // ---------------------------------------------------------------------------
  // "These agree" as a test over data, which is the whole reason
  // src/engine/steering.ts exists as a module. `--help` and SKILL.md describe
  // the same three commands to two different readers; the sentences live once,
  // in `src/engine/one-step-descriptions.json`, and both surfaces render them.
  // This asserts the COMMITTED SKILL.md still carries the current text, so
  // editing a description without regenerating fails here rather than shipping
  // a skill that tells an agent something `--help` contradicts.
  //
  // Compared against `skillMdFlat` because the generator hard-wraps each
  // sentence to SKILL.md's own column: the property under test is the wording,
  // not where a line happens to break.
  // ---------------------------------------------------------------------------

  it("carries every ONE_STEP_DESCRIPTIONS sentence exactly as src/engine/steering.ts exports it", () => {
    for (const command of ONE_STEP_COMMANDS) {
      expect(skillMdFlat, `SKILL.md is stale for "${command}" — run \`pnpm gen-skill\``).toContain(
        ONE_STEP_DESCRIPTIONS[command],
      );
    }
  });

  it('names all three one-step commands and the providers --intent escape hatch in its procedure', () => {
    const procedure = skillMd.slice(skillMd.indexOf('## Procedure'), skillMd.indexOf('## Examples'));
    expect(procedure).not.toBe('');
    for (const command of ONE_STEP_COMMANDS) {
      expect(procedure, `procedure never names \`${command}\``).toContain(`\`${command}\``);
    }
    // The capabilities no one-step command covers (news/social/proxy) are only
    // reachable this way, so the step that routes there must name the command.
    expect(procedure).toContain('`providers --intent <intent>`');
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

/**
 * Overwrites the committed skill-local copy at
 * `skills/fezo/scripts/fezoctl.mjs` with a freshly built bundle, mirroring
 * `copyIntoSkill` in build/bundle.mjs.
 *
 * The `mkdirSync` is retained deliberately even though the directory is now
 * tracked and therefore present in a fresh clone: it mirrors production, and
 * it keeps the helper working in a tree where the copy was removed by hand.
 *
 * Callers MUST wrap this in `withCommittedBundlesPreserved` — this writes to a
 * tracked file, and although the build is deterministic (so the bytes should
 * come back identical), relying on that to keep the working tree clean makes
 * every determinism regression show up as a mysterious dirty file instead of
 * as the reproducibility test failing.
 */
function installSkillLocalCopy(from: string): void {
  mkdirSync(dirname(skillScriptPath), { recursive: true });
  copyFileSync(from, skillScriptPath);
  chmodSync(skillScriptPath, 0o755);
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
// The skill-local bundle copy: COMMITTED, and must also exist in an actual
// npm-published tarball. Chains carry-forward #1 and #6.
//
// Committing it is what makes the skill directory self-contained for
// installers that copy `skills/<name>/` and nothing else (`npx skills add`,
// a plain `cp -R`, a `.skill` archive). Those land the skill somewhere like
// `~/.agents/skills/fezo`, where tier 3 of the invocation ladder
// (`$SKILL_DIR/../../dist/fezoctl.mjs`) cannot resolve — tier 2 is the only
// rung left, and it reads exactly this file. If it is ever gitignored again,
// every such install ships a SKILL.md with no engine behind it, so both
// tracked-ness assertions below are load-bearing, not bookkeeping.
// ---------------------------------------------------------------------------

/** True when git ignores `path`. `git check-ignore` exits 1 (making
 * `execFileSync` throw) when the path is NOT ignored, so the exit code is the
 * whole answer. */
function isGitIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', path], { cwd: repoRoot, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

describe('skills/fezo/scripts/fezoctl.mjs packaging', () => {
  it('is NOT gitignored — installers that copy the skill directory alone need it', () => {
    expect(isGitIgnored(skillScriptPath)).toBe(false);
  });

  it('is actually tracked by git, not merely un-ignored', () => {
    // Un-ignoring it is necessary but not sufficient: an un-ignored file that
    // was never `git add`ed is still absent from a fresh clone and from every
    // tarball a source installer downloads.
    const stdout = execFileSync('git', ['ls-files', '--', skillScriptPath], { cwd: repoRoot, encoding: 'utf8' });
    expect(stdout.trim()).not.toBe('');
  });

  it('dist/fezoctl.mjs is NOT gitignored (it is the deliberately committed artifact)', () => {
    expect(isGitIgnored(distBundlePath)).toBe(false);
  });

  it('both committed bundles are marked linguist-generated -diff via .gitattributes', () => {
    for (const path of [distBundlePath, skillScriptPath]) {
      const stdout = execFileSync('git', ['check-attr', 'linguist-generated', 'diff', 'text', '--', path], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(stdout, path).toContain('linguist-generated: set');
      expect(stdout, path).toContain('diff: unset');
      // `-text` pins the blob byte-for-byte; EOL normalization would break the
      // freshness gate's byte comparison for a non-obvious reason.
      expect(stdout, path).toContain('text: unset');
    }
  });

  it('the committed copy is byte-identical to the committed dist/fezoctl.mjs', () => {
    // Reads only what is on disk — no build. This is the invariant that lets
    // git store ONE blob for both paths, so committing the copy costs a tree
    // entry rather than a second 300+ KB object per release.
    const dist = readFileSync(distBundlePath);
    const copy = readFileSync(skillScriptPath);
    expect(copy.equals(dist)).toBe(true);
  });

  it('is present in real npm pack output (pack:check passes)', () => {
    // pack:check assumes the build already ran (see build/pack-check.mjs's own
    // comment on why it packs with --ignore-scripts), so a freshly built
    // skill-local copy must be in place. Build to a SCRATCH path and copy
    // explicitly rather than running the default `node build/bundle.mjs`,
    // which would also rewrite the committed dist/fezoctl.mjs — see
    // `withCommittedBundlesPreserved`'s comment for why no test may do that in
    // place.
    withCommittedBundlesPreserved(() => {
      const scratchDir = mkdtempSync(join(tmpdir(), 'fezoctl-packcheck-'));
      try {
        const scratchBundle = join(scratchDir, 'fezoctl.mjs');
        execFileSync('node', [bundlePath, '--out', scratchBundle], { cwd: repoRoot, encoding: 'utf8' });
        installSkillLocalCopy(scratchBundle);
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
});

describe('skill-local bundle copy is byte-identical to dist/fezoctl.mjs after a fresh build', () => {
  it('matches after `node build/bundle.mjs` (the pack/build copy step)', () => {
    // The property under test is specifically that the DEFAULT invocation
    // performs the copy step, so this must run `node build/bundle.mjs` with no
    // `--out` — which writes both committed bundles. The guard restores their
    // bytes and modes afterwards so the suite leaves the tracked artifacts
    // untouched regardless of describe ordering.
    withCommittedBundlesPreserved(() => {
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
    withCommittedBundlesPreserved(() => {
      const scratchDir = mkdtempSync(join(tmpdir(), 'fezoctl-skillver-'));
      try {
        // Same scratch-build-then-copy discipline as the pack:check test:
        // never rebuild a committed bundle in place.
        const scratchBundle = join(scratchDir, 'fezoctl.mjs');
        execFileSync('node', [bundlePath, '--out', scratchBundle], { cwd: repoRoot, encoding: 'utf8' });
        installSkillLocalCopy(scratchBundle);
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
      }

      const stdout = execFileSync('node', [skillScriptPath, '--version'], { encoding: 'utf8' });
      expect(stdout.trim()).toBe(`fezoctl ${packageVersion()}`);
    });
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

