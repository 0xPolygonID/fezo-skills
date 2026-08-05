# Installing the `fezo` skill into Codex

How to install this skill for [Codex](https://developers.openai.com/codex/cli),
and how to prove it actually works before you rely on it.

Everything below was verified against a real gateway. Where a step could not be
verified on the machine this was written on, it says so.

---

## 1. Prerequisites

- **Node.js >= 22.12** (`package.json`'s `engines`), on the `PATH` **of the
  process Codex spawns shells from**.
- Network access to your Fezo gateway.

The `PATH` qualifier is the most common install failure, and it is worth
checking before anything else. Version managers like `nvm` put `node` on the
`PATH` from an **interactive** rc file (typically `~/.zshrc`), and the shells
an agent spawns are not interactive — so `node --version` can work perfectly in
your terminal and still be missing everywhere the skill runs.

Check it the way an agent would, non-interactively:

```bash
bash -c 'node --version'   # NOT `bash -lc` — a login shell can mask the problem
zsh  -c 'node --version'
```

If those print a version, you are fine. If they print `command not found: node`,
the skill will fail with exactly that message no matter how correctly it is
installed — the ladder in `SKILL.md` invokes the engine as `node <path>`.

Fix it by putting Node somewhere always on the `PATH` (Homebrew, Volta,
`corepack`) rather than relying on rc-file initialization.

---

## 2. Install

### Recommended: `npx skills add`

Codex is covered by the cross-host [`skills`](https://github.com/vercel-labs/skills)
installer.

```bash
# Global — available in every project
npx skills add 0xPolygonID/fezo-skills -g -a codex

# Or project-local — only in the current repository
npx skills add 0xPolygonID/fezo-skills -a codex
```

Where each one lands, read out of the installer's own agent registry:

| Scope | Directory |
| --- | --- |
| Global | `$CODEX_HOME/skills/` — defaults to `~/.codex/skills/` |
| Project | `.agents/skills/` in the current repository |

You should end up with exactly two files:

```
<skills-dir>/fezo/SKILL.md
<skills-dir>/fezo/scripts/fezoctl.mjs
```

`scripts/fezoctl.mjs` is the engine — a single self-contained ~350 KB bundle
with no runtime dependencies. That is what makes this lane work: installers of
this kind copy the skill directory and nothing else.

Two things worth knowing, both confirmed by running it:

- **Codex does not have to be installed yet.** `-a codex` targets it
  explicitly and bypasses auto-detection, so you can install the skill first
  and Codex second. (Auto-detection looks for `~/.codex` or `/etc/codex`.)
- **The project-scope install writes to `.agents/skills/`, not `.codex/`.**
  That is the installer's canonical location for Codex; don't go looking for a
  `.codex/` directory that will not be there.

### Alternative: copy it yourself

The skill directory is self-contained, so a plain copy is a complete install:

```bash
git clone https://github.com/0xPolygonID/fezo-skills
mkdir -p ~/.codex/skills
cp -R fezo-skills/skills/fezo ~/.codex/skills/
```

> **On `.codex-plugin/plugin.json`:** this repository generates a Codex plugin
> manifest, but the lane verified here is `skills add` (or the copy above). If
> you install through a Codex plugin marketplace instead, the credential and
> testing steps below are unchanged — only the directory differs.

---

## 3. Configure credentials — once per machine

**No install lane configures credentials.** The marketplaces and `skills add`
copy files and run no install hooks, deliberately.

Credentials live *outside* the skill directory, so this is one-time per machine
and **shared by every agent on it** — configure once, and Codex, Claude Code,
and anything else all see it.

Resolution order, highest priority first:

1. Environment: `FEZO_URL` / `FEZO_API_KEY` (the only two names accepted)
2. macOS Keychain
3. `$XDG_CONFIG_HOME/fezo/.env`, else `~/.config/fezo/.env`

> ### A `.env` in your project directory is **not** read
>
> Only `~/.config/fezo/.env` (or the `XDG_CONFIG_HOME` equivalent) counts. A
> `.env` sitting in a repository is ignored, and `doctor` will report both
> credentials missing while the file is right there. This trips people up
> constantly.

Run this **in your own terminal** — not through an agent:

```bash
printf 'Fezo API key: '; read -rs KEY; echo; \
  printf '%s' "$KEY" | node ~/.codex/skills/fezo/scripts/fezoctl.mjs \
  setup --key-stdin --url https://your-gateway.example.com; \
  unset KEY
```

Why this exact shape:

- The key never appears in `argv` (visible to any local process via `ps`) and
  never lands in your shell history — the recorded line contains `"$KEY"`, the
  variable's name, not its value.
- `read -rs` does not echo it to the screen.
- `--key-stdin` **prints no prompt of its own**; the `printf` supplies one.

`--url` is not optional in practice. A `setup` that stores only the key exits
non-zero and leaves the configuration unusable.

Add `--storage keychain` to store in the macOS Keychain instead of the dotenv
file.

**It has to be a real terminal.** Any command run through an agent (including
Codex, and including Claude Code's `!` prefix) has non-interactive stdin, so
`setup --key-stdin` reads EOF immediately, stores nothing, and exits 2:

```
setup — storage: dotenv
  api key: failed (no API key was provided; nothing was stored)
  ...
  this configuration is NOT usable yet: fezoctl needs BOTH a gateway URL and an API key.
```

No restart is needed afterwards — the dotenv file and Keychain are re-read on
every command.

---

## 4. Test that it works

Three levels, cheapest first. Do them in order; each one rules out a different
failure.

Set the path once:

```bash
# Global install:
ENGINE=~/.codex/skills/fezo/scripts/fezoctl.mjs
# Project install:
# ENGINE=.agents/skills/fezo/scripts/fezoctl.mjs
```

### Level 1 — the engine runs (no gateway, no credentials)

```bash
node "$ENGINE" --version
```

```
fezoctl 1.0.0
```

If this fails, it is Node or the file path — nothing to do with your gateway.

### Level 2 — credentials and the live catalog

```bash
node "$ENGINE" doctor
```

All six checks should be `[ok]`, and the exit code `0`:

```
doctor:
  [ok] gateway-url: FEZO_URL resolved from env
  [ok] api-key: FEZO_API_KEY resolved from env
  [ok] gateway-connectivity: reached the gateway
  [ok] auth: the API key was accepted
  [ok] catalog-readable: parsed 118 tool candidate(s) from the catalog
  [ok] preference-hints: every backend named in CAPABILITY_PREFERENCES is present in the live catalog
```

The candidate count depends on your gateway. `doctor` is the single best
diagnostic here: it tells you *which* credential resolved and *from which
source*, so a stale environment variable shadowing the file you just wrote is
immediately visible.

Then discover and call something for real:

```bash
node "$ENGINE" search "web search"                # discovery + ranking, no spend
node "$ENGINE" schema brave_search                # inspect before calling
node "$ENGINE" run "web search" --args-json '{"query":"zk rollups","numResults":2}'
```

> **The catalog is read live, so tool names are not fixed.** `brave_search`,
> `exa_search`, and the argument names below are what one gateway returned —
> take the real ones from your own `search` output rather than assuming these
> exist. `search` → `schema` → `call` is the order for exactly this reason:
> `schema` tells you what a tool actually accepts. Note that `run` takes a
> free-text *intent* and picks a provider for you, while `call` names one
> explicitly.

A healthy `run` reports the provider it chose, every attempt, and what was
billed:

```
selected: exa_search (exa.search, POST /search, dynamic) — Search the web
attempts:
  1. exa_search (exa) [success] billed=true httpStatus=200 — 200 response
billed: true
```

> `call` and `run` reach real providers and **cost real money**. `search`,
> `schema`, and `doctor` do not. Note the `billed:` line — an attempt that
> failed before a 2xx is not billed.

A good zero-cost check that argument validation is live — this must be rejected
locally, with no network call and no attempt log:

```bash
node "$ENGINE" call brave_search --args-json '{"count":2}'
```

```
fezoctl: --args-json does not match brave_search's input schema: (root) must have required property 'q'
```

### Level 3 — Codex actually invokes the skill

Levels 1 and 2 prove the engine works. This proves Codex *finds and uses* it.

Start Codex and give it a prompt that needs an external capability without
naming the skill — that is the real test, since the skill has to be selected
from its description:

```
Search the web for what changed in the Ethereum Pectra upgrade and cite your sources.
```

Signals it worked:

1. Codex reads `SKILL.md` from the skills directory.
2. It runs a shell command containing `fezoctl` — you will see `search`,
   `schema`, then `call`/`run`.
3. Its answer reports which backend was used and what was billed.

If Codex answers from memory without running anything, it did not pick up the
skill. Check that `SKILL.md` is in the directory from the table in §2, restart
Codex so it re-scans, and try naming it directly (`use the fezo skill to ...`)
to distinguish "not installed" from "installed but not selected".

---

## 5. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `command not found: node` | Node is not on the `PATH` of non-interactive shells. See §1. |
| `gateway URL and/or API key are not configured` | Credentials not set, or set only in a project `.env`. Run `doctor`; see §3. |
| `doctor` says not configured, but your `.env` exists | It is in the wrong place. Only `~/.config/fezo/.env` is read, never a project-local one. |
| `[fail] auth: the gateway rejected the API key (status 401)` | Wrong or expired key. Re-run `setup --key-stdin`. |
| `setup` exits 2 having stored nothing | It was run with non-interactive stdin. It must be a real terminal — §3. |
| `configured url: (not configured — pass --url or set FEZO_URL)` | `setup` ran without `--url`. Re-run with it. |
| `search: command not found` | `FEZOCTL_ARGV` was not re-established. Each shell call is a fresh process; nothing survives between them, not even an `export`. |
| `SKILL_DIR must be set to the directory containing SKILL.md` | The resolve block refuses to guess. Set `SKILL_DIR` in the *same* shell call. |
| `npx -y fezo-skills@1.0.0 ... CANNOT WORK YET` | The ladder fell through to tier 5. The package is not on npm, so this means the bundle was not found — check `scripts/fezoctl.mjs` exists next to `SKILL.md`. |
| Codex never runs `fezoctl` | Skill not discovered. See Level 3 above. |

### Checking which engine is being used

`SKILL.md` resolves the engine through a five-tier ladder, and a correct
install is served by **tier 2** — the bundle sitting inside the skill
directory, invoked as `node <path>`. Confirm that tier is available:

```bash
ls -l ~/.codex/skills/fezo/scripts/fezoctl.mjs
node ~/.codex/skills/fezo/scripts/fezoctl.mjs --version    # -> fezoctl 1.0.0
```

If that file is present and runs, the ladder cannot fall through to the
npm-fetch tier — tiers 2 and 3 are tried before a global `fezoctl` on `PATH`
unconditionally, so a stale global install can never shadow it.

To override the ladder entirely and pin one engine:

```bash
export FEZOCTL=/path/to/fezoctl.mjs
```

---

## Uninstall

```bash
npx skills remove fezo -g -a codex     # or: rm -rf ~/.codex/skills/fezo
```

Credentials are stored outside the skill directory and are **not** removed by
uninstalling. To clear them:

```bash
rm ~/.config/fezo/.env

# Keychain storage — two items, both under the account `fezo`:
security delete-generic-password -a fezo -s fezo-api-key
security delete-generic-password -a fezo -s fezo-url
```

Those identifiers are fixed and effectively a storage format; see
[`CONFIGURATION.md`](CONFIGURATION.md#macos-keychain).
