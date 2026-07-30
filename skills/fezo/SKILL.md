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

Then resolve the engine with the ladder in the next block. It sets a Bash argv
array, `FEZOCTL_ARGV`, and every command in this file runs as
`"${FEZOCTL_ARGV[@]}" <command>`.

### Every Bash call is a fresh shell: re-establish `FEZOCTL_ARGV` in each one

`FEZOCTL_ARGV` is a shell variable, and each Bash tool call runs in a NEW
shell. Nothing set in one call survives into the next — not a variable, not an
array, not even an `export`. A later call that begins
`"${FEZOCTL_ARGV[@]}" search ...` therefore expands to nothing and fails with
`search: command not found`.

So in EVERY Bash call, re-establish the array before using it. Either way is
fine:

1. Paste the resolve block below again at the top of the call. It is
   idempotent and does no network I/O.
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
3, and 5 — which are the common cases.

### Credentials: never handle the API key yourself

Credentials (gateway URL and API key) live outside this repository, at
`~/.config/fezo/.env` (or `$XDG_CONFIG_HOME/fezo/.env` if that variable is
set), or in `FEZO_URL` / `FEZO_API_KEY`. Check what is already configured
before concluding that anything is missing:

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
  themselves, in their own terminal**, so they paste the key at its prompt and
  it never reaches the conversation or an argv. In Claude Code they can do
  this without leaving the session by typing `!` followed by the command. Give
  them a fully expanded command line — their shell has no `FEZOCTL_ARGV` — for
  example:

  ```
  ! node /absolute/path/to/fezoctl.mjs setup --key-stdin --url https://gateway.example.com
  ```

  Substitute the invocation you resolved above and the gateway URL. Then wait
  for the user to confirm, and re-run `doctor` to verify.

What you MAY collect through `AskUserQuestion`: the **gateway URL** and the
**storage choice** (`dotenv` or `keychain`). Neither is a secret; the API key
is the only value that is.

For reference, this is the command the user runs:

```bash
"${FEZOCTL_ARGV[@]}" setup --key-stdin --url <gateway url>
```

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
