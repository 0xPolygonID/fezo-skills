---
name: fezo
version: "1.0.0"
description: Discover and call Fezo gateway tools from the live catalog. Use when a task needs external capabilities such as web search, news, scraping, market data, social data, product data, or another API-backed service; search the catalog, inspect the schema, call the best provider, and retry another provider when the first fails or returns unsuitable content.
argument-hint: "<external capability or task>"
allowed-tools: Bash, Read, AskUserQuestion
user-invocable: true
homepage: https://github.com/0xPolygonID/fezo-skills
repository: https://github.com/0xPolygonID/fezo-skills
license: MIT
compatibility: Requires bash or zsh, node >=22, curl-compatible network access to the Fezo gateway.
metadata:
  fezo:
    dynamicCatalog: true
---

# fezo

Discover and call Fezo gateway tools from the live catalog. Do not list
or assume a fixed backend roster anywhere in this file — search the
catalog at run time instead.

## Step 0 — locate the engine and your config

Before doing anything else, resolve two values:

- `SKILL_DIR` — the absolute path of the directory containing this
  `SKILL.md` (the path you loaded it from). It may contain spaces (for
  example, inside a plugin cache); always quote it.
- `SKILL_VERSION` — fixed by this file, baked in at generation time (see the
  invocation block below). It is the released package version, and it is
  compared against a global `fezoctl`'s own `--version` output so a stale
  global install is skipped rather than silently used.

Then resolve the engine with the ladder in the `## Resolve fezoctl` section
below — it is two sections further down, after the notes on fresh shells and
on credentials, not the block immediately following this one. It sets a Bash
argv array, `FEZOCTL_ARGV`, and every command in this file runs as
`"${FEZOCTL_ARGV[@]}" <command>`.

### Every Bash call is a fresh shell: re-establish `FEZOCTL_ARGV` in each one

`FEZOCTL_ARGV` is a shell variable, and each Bash tool call runs in a NEW
shell. Nothing set in one call survives into the next — not a variable, not an
array, not even an `export`. A later call that begins
`"${FEZOCTL_ARGV[@]}" search ...` therefore expands to nothing and fails with
`search: command not found`.

So in EVERY Bash call, re-establish the array before using it. Either way is
fine:

1. Paste the resolve block below again at the top of the call — and set
   `SKILL_DIR` again in that same call, first. `SKILL_DIR` is a shell variable
   too, so it is gone along with everything else, and the block refuses to
   guess it: without it, sourcing the block aborts with `SKILL_DIR must be set
   to the directory containing SKILL.md` and nothing runs. With `SKILL_DIR`
   set, the block is idempotent and does no network I/O.
2. Once you know what it resolved to, set the array directly in one line —
   cheaper, and the option to prefer after the first call. To learn the
   resolved value, print it in the first call, right after the resolve block:

   ```bash
   printf '%s\n' "${FEZOCTL_ARGV[@]}"
   ```

   then reuse it verbatim:

   ```bash
   FEZOCTL_ARGV=(node "/absolute/path/to/fezoctl.mjs")   # what step 0 resolved
   ```

Keep the array form even when you know the path: `SKILL_DIR` may contain a
space, and only `"${FEZOCTL_ARGV[@]}"` survives that. Never collapse it into a
single command string.

Always invoke the engine through `"${FEZOCTL_ARGV[@]}"`, including for setup.
Never type a bare `fezoctl`: only tier 4 of the ladder below puts a literal
`fezoctl` command on `PATH`, so a bare invocation fails outright in tiers 1, 2,
3, and 5 — which are the common cases. That rule is about YOUR own calls; a
command line you hand to the *user* must instead be fully expanded, because
their shell has no `FEZOCTL_ARGV` — see the credentials section below.

### Credentials: never handle the API key yourself

Credentials (gateway URL and API key) live outside this repository. They are
resolved from four sources, in this order: the environment (`FEZO_URL` /
`FEZO_API_KEY`), deprecated environment aliases, the macOS Keychain, and
finally `~/.config/fezo/.env` (or `$XDG_CONFIG_HOME/fezo/.env` if that
variable is set). Check what is already configured before concluding that
anything is missing:

```bash
"${FEZOCTL_ARGV[@]}" doctor
```

If the API key is not configured, YOU MUST NOT OBTAIN IT YOURSELF. Two moves
are forbidden, and exactly one is correct:

- **Never collect the API key through `AskUserQuestion`**, or through any
  other conversational prompt. Whatever the user types there becomes part of
  the conversation transcript, which is persisted and may be summarized or
  passed onward: a live key in a transcript is a leaked key.
- **Never put the API key in a Bash command you construct**, not even piped
  into stdin. A command line such as `printf '%s' 'sk-live-…' | ...` places
  the key in that process's argv, where any local process can read it with
  `ps`, and writes it into the shell history file.
- **The one correct move: stop and ask the user to run `setup --key-stdin`
  themselves, in their own terminal** — a real interactive terminal, outside
  this agent session — so the key goes straight from their keyboard into the
  engine's stdin and it never reaches the conversation or an argv.

#### The command to hand the user

`setup --key-stdin` **prints no prompt of any kind**. It reads standard input
to end-of-file and only then reports. Never tell the user to "paste the key at
its prompt": there is no prompt, and a user who is told to expect one sits in
front of a blank terminal with nothing to go on.

Hand them this one-liner, which supplies its own prompt, does not echo the key
as they type it, and still keeps the key out of both argv and the shell history
(`printf` is a shell builtin in bash and zsh, so no separate process is spawned
for it, and the history line holds `"$KEY"`, not the secret):

```
printf 'Fezo API key: '; read -rs KEY; echo; printf '%s' "$KEY" | node /absolute/path/to/fezoctl.mjs setup --key-stdin --url https://gateway.example.com; unset KEY
```

Substitute the invocation step 0 resolved for `node
/absolute/path/to/fezoctl.mjs`, and the real gateway URL for the example one.
Add `--storage keychain` if the user chose Keychain storage.

This is not the forbidden form from the second bullet: the key never appears as
a literal anywhere. What gets typed, recorded in history, and visible to `ps` is
`"$KEY"` — the variable's name, not its value — and you never learn the value
at all. The forbidden thing is a command in which YOU have written the key out.

The bare command works too, but only if you tell the user the part `setup` does
not tell them: **nothing is printed, so type or paste the key, press Enter,
then press Ctrl-D** to signal end-of-file. In that form the key is echoed on
screen, which the one-liner above avoids — prefer the one-liner.

#### There is no `!` shortcut for this: it has to be the user's own terminal

Do NOT hand the user a `! ...` command for this. A Claude Code `!` command runs
with non-interactive stdin and no controlling terminal (opening `/dev/tty`
fails with `ENXIO`), so `setup --key-stdin` reads end-of-file immediately,
stores nothing, and exits 2. The whole output, verified:

```
setup — storage: dotenv
  api key: failed (no API key was provided; nothing was stored)
  url: failed (no API key was provided; nothing was stored)
  configured url: (not configured — pass --url or set FEZO_URL)
  configured api key: (not configured)
  this configuration is NOT usable yet: fezoctl needs BOTH a gateway URL and an API key.
```

Every Bash tool call you make yourself has exactly the same stdin, so there is
no variant of this you can run for them either. The user runs it in their own
terminal, outside this session; then you wait for them to confirm and re-run
`doctor` to verify. No restart is needed — `.env` and the Keychain are read
fresh on every command, so your next `doctor` sees what they just stored.

An exported `FEZO_API_KEY` is **not** a shortcut around that. It is first in
the resolution order, but a variable the user exports in some other terminal is
invisible to this already-running session: environment variables are inherited
at process start, so only processes launched afterwards from that shell would
see it. Suggest it only if the user is willing to restart the agent session
with it exported. `setup --key-stdin` writes a file (or a Keychain item) that
takes effect immediately, which is why it is the option to offer first.

What you MAY collect through `AskUserQuestion`: the **gateway URL** and the
**storage choice** (`dotenv` or `keychain`). Neither is a secret; the API key
is the only value that is.

In this file's own notation, the command is:

```bash
"${FEZOCTL_ARGV[@]}" setup --key-stdin --url <gateway url>
```

That is the form YOU would use — like every other command here, it goes
through the resolved array. It is **not** the form to show the user: their
shell never ran the resolve block, so it has no `FEZOCTL_ARGV` and that line
would expand to `setup: command not found`. Expand it to the literal
invocation step 0 resolved, as in the one-liner above, before handing anything
over.

`--url` is not optional in practice. A `setup` that stores only the key leaves
the configuration unusable, and says so: it prints
`configured url: (not configured — pass --url or set FEZO_URL)` and exits
non-zero, and every other command then fails with `gateway URL and/or API key
are not configured`. Either pass `--url`, or have `FEZO_URL` already exported.

## Resolve fezoctl

```bash
SKILL_VERSION="1.0.0"
# fezoctl invocation ladder.
#
# Requires two variables already set by the caller: SKILL_DIR (quoted at
# every use — it may contain spaces) and SKILL_VERSION. Resolves an argv
# array, never a command string, into FEZOCTL_ARGV, in this fixed order:
#
#   1. $FEZOCTL, if it names an executable file -- or a NON-executable
#      .mjs/.js/.cjs file, which is invoked as `node <path>` for exactly the
#      reason tiers 2 and 3 are: a bundle copied out of an archive commonly
#      loses its executable bit. Requiring `-x` here (while tiers 2-3 do not)
#      made `FEZOCTL=/path/to/fezoctl.mjs` at mode 0644 -- a natural thing to
#      set, and the documented way to carry the resolved path from one Bash
#      call into the next -- fall silently through to tier 5. A $FEZOCTL that
#      is set but usable neither way is reported on stderr, never skipped in
#      silence.
#   2. "$SKILL_DIR/scripts/fezoctl.mjs" (the bundle copied in at pack/build
#      time) — invoked as `node <path>`, not relied on to be executable,
#      because a `.skill` archive or plain file copy may not preserve the
#      executable bit.
#   3. "$SKILL_DIR/../../dist/fezoctl.mjs" (this repo's committed bundle,
#      when the skill is used straight out of a checkout of this repo) —
#      also invoked as `node <path>` for the same reason.
#   4. A global `fezoctl` on PATH, but ONLY if `fezoctl --version` matches
#      SKILL_VERSION exactly. A stale global is skipped, not silently used.
#      NOTE: `fezoctl --version` prints "fezoctl <version>", NOT a bare
#      version, so the comparison target below is "fezoctl $SKILL_VERSION".
#      Comparing the raw output to a bare "$SKILL_VERSION" can never match and
#      silently disables this whole tier.
#   5. A version-pinned `npx -y fezo-skills@$SKILL_VERSION fezoctl`.
#      THIS TIER DOES NOT WORK TODAY: `fezo-skills` is not published to npm, so
#      the pinned version does not exist on the registry and npx fails with a
#      404. It is still the last rung (it is what will work once the package
#      ships), but reaching it is a misconfiguration, so the function announces
#      it on stderr with the three things that must all have missed.
#
# A versioned bundle (tiers 2-3) always outranks PATH (tier 4): tiers 2 and 3
# are tried before tier 4 unconditionally.
resolve_fezoctl() {
  # Tiers 2 and 3 are both relative to SKILL_DIR. An unset or empty SKILL_DIR
  # would make both of them silently miss and land the ladder on tier 5 (a
  # network fetch) with no diagnostic at all, so refuse to guess.
  : "${SKILL_DIR:?SKILL_DIR must be set to the directory containing SKILL.md}"

  FEZOCTL_ARGV=()

  if [ -n "${FEZOCTL:-}" ]; then
    if [ -x "${FEZOCTL}" ]; then
      FEZOCTL_ARGV=("${FEZOCTL}")
      return 0
    fi
    case "${FEZOCTL}" in
      *.mjs | *.js | *.cjs)
        if [ -f "${FEZOCTL}" ]; then
          FEZOCTL_ARGV=(node "${FEZOCTL}")
          return 0
        fi
        ;;
    esac
    printf 'fezoctl: ignoring FEZOCTL=%s -- it is not an executable file, and not an existing .mjs/.js/.cjs bundle that could be run with node\n' \
      "${FEZOCTL}" >&2
  fi

  if [ -f "${SKILL_DIR}/scripts/fezoctl.mjs" ]; then
    FEZOCTL_ARGV=(node "${SKILL_DIR}/scripts/fezoctl.mjs")
    return 0
  fi

  if [ -f "${SKILL_DIR}/../../dist/fezoctl.mjs" ]; then
    FEZOCTL_ARGV=(node "${SKILL_DIR}/../../dist/fezoctl.mjs")
    return 0
  fi

  if command -v fezoctl >/dev/null 2>&1; then
    # `fezoctl --version` prints "fezoctl <version>" (see render.ts's
    # renderVersion), so compare against that exact string rather than against
    # a bare "${SKILL_VERSION}" — the bare comparison is false for EVERY
    # version and silently skips even a perfectly matched global install.
    local global_version
    global_version="$(fezoctl --version 2>/dev/null || true)"
    if [ "${global_version}" = "fezoctl ${SKILL_VERSION}" ]; then
      FEZOCTL_ARGV=(fezoctl)
      return 0
    fi
  fi

  # Tier 5 is reached only when everything above missed, and it cannot succeed
  # until the package is published -- so say so, loudly, instead of handing back
  # an argv that 404s with no explanation. The three misses named here are
  # exactly the ones to check, in the order the ladder tried them.
  printf 'fezoctl: falling back to `npx -y fezo-skills@%s fezoctl`, which CANNOT WORK YET: fezo-skills is not published to npm, so npx will fail with a 404.\n' \
    "${SKILL_VERSION}" >&2
  printf 'fezoctl: nothing above it resolved: no bundle at "%s/scripts/fezoctl.mjs", no sibling bundle at "%s/../../dist/fezoctl.mjs", and no global fezoctl on PATH reporting version %s. Point FEZOCTL at a fezoctl.mjs bundle, or use the skill from a checkout that has dist/fezoctl.mjs.\n' \
    "${SKILL_DIR}" "${SKILL_DIR}" "${SKILL_VERSION}" >&2
  FEZOCTL_ARGV=(npx -y "fezo-skills@${SKILL_VERSION}" fezoctl)
  return 0
}

resolve_fezoctl
```

## Procedure

1. If a task needs external data or an external service, use this skill
   before built-in tools or giving up.
2. Search the live catalog by capability.
3. Inspect the selected tool's schema and HTTP bindings.
4. Call the tool.
5. If the provider mechanically fails, let `run` try another compatible
   candidate.
6. If a successful result is off-topic, incomplete, spammy, a
   block/challenge page, or otherwise unsuitable, choose another candidate
   and call it deliberately.
7. Report which backend(s) were attempted and which 2xx attempts were
   billed.

## Examples

Examples are illustrative only — always discover real tool names and
arguments from the live catalog (`search`/`schema`) rather than assuming
these exact names exist. Do not hardcode a backend roster: the catalog is
the source of truth.

Each line below is one command inside one Bash call, and every Bash call must
re-establish `FEZOCTL_ARGV` first — see Step 0.

```bash
"${FEZOCTL_ARGV[@]}" search "web search" --schema
"${FEZOCTL_ARGV[@]}" call exa_search --args-json '{"query":"...","numResults":3}'
"${FEZOCTL_ARGV[@]}" run "scrape url" --args-json '{"url":"https://example.com"}'
```
