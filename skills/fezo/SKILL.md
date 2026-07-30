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

Before doing anything else, resolve two values and keep them for every command
below:

- `SKILL_DIR` — the absolute path of the directory containing this
  `SKILL.md` (the path you loaded it from). It may contain spaces (for
  example, inside a plugin cache); always quote it.
- `SKILL_VERSION` — fixed by this file, baked in at generation time (see the
  invocation block below). It is compared against a global `fezoctl`'s own
  `--version` output so a stale global install is skipped rather than
  silently used.

Credentials (gateway URL and API key) live outside this repository, at
`~/.config/fezo/.env` (or `$XDG_CONFIG_HOME/fezo/.env` if that variable is
set), or in `FEZO_URL` / `FEZO_API_KEY`. If neither is configured, run
`fezoctl setup --key-stdin` once via the resolved invocation below — never
pass the API key as a command-line argument.

Then resolve the `fezoctl` executable using the ladder in the next block, in
order, and reuse the result (`FEZOCTL_ARGV`) for every subsequent command in
this session.

## Resolve fezoctl

```bash
SKILL_VERSION="1.0.0"
# fezoctl invocation ladder.
#
# Requires two variables already set by the caller: SKILL_DIR (quoted at
# every use — it may contain spaces) and SKILL_VERSION. Resolves an argv
# array, never a command string, into FEZOCTL_ARGV, in this fixed order:
#
#   1. $FEZOCTL, if it names an executable file.
#   2. "$SKILL_DIR/scripts/fezoctl.mjs" (the bundle copied in at pack/build
#      time) — invoked as `node <path>`, not relied on to be executable,
#      because a `.skill` archive or plain file copy may not preserve the
#      executable bit.
#   3. "$SKILL_DIR/../../dist/fezoctl.mjs" (this repo's committed bundle,
#      when the skill is used straight out of a checkout of this repo) —
#      also invoked as `node <path>` for the same reason.
#   4. A global `fezoctl` on PATH, but ONLY if `fezoctl --version` matches
#      SKILL_VERSION exactly. A stale global is skipped, not silently used.
#   5. A version-pinned `npx -y fezo-skills@$SKILL_VERSION fezoctl`, which
#      always works and always resolves the version this skill was written
#      against.
#
# A versioned bundle (tiers 2-3) always outranks PATH (tier 4): tiers 2 and 3
# are tried before tier 4 unconditionally.
resolve_fezoctl() {
  FEZOCTL_ARGV=()

  if [ -n "${FEZOCTL:-}" ] && [ -x "${FEZOCTL}" ]; then
    FEZOCTL_ARGV=("${FEZOCTL}")
    return 0
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
    global_version="$(fezoctl --version 2>/dev/null || true)"
    if [ "${global_version}" = "${SKILL_VERSION}" ]; then
      FEZOCTL_ARGV=(fezoctl)
      return 0
    fi
  fi

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

```bash
"${FEZOCTL_ARGV[@]}" search "web search" --schema
"${FEZOCTL_ARGV[@]}" call exa_search --args-json '{"query":"...","numResults":3}'
"${FEZOCTL_ARGV[@]}" run "scrape url" --args-json '{"url":"https://example.com"}'
```
