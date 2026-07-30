## Step 0 — locate the engine and your config

Before doing anything else, resolve two values and keep them for every command
below:

- `SKILL_DIR` — the absolute path of the directory containing this
  `SKILL.md` (the path you loaded it from). It may contain spaces (for
  example, inside a plugin cache); always quote it.
- `SKILL_VERSION` — fixed by this file, baked in at generation time (see the
  invocation block below). It is the released package version, and it is
  compared against a global `fezoctl`'s own `--version` output so a stale
  global install is skipped rather than silently used.

Then resolve the `fezoctl` executable using the ladder in the next block, in
order, and reuse the result (`FEZOCTL_ARGV`) for every subsequent command in
this session.

Credentials (gateway URL and API key) live outside this repository, at
`~/.config/fezo/.env` (or `$XDG_CONFIG_HOME/fezo/.env` if that variable is
set), or in `FEZO_URL` / `FEZO_API_KEY`. If neither is configured, then once
`FEZOCTL_ARGV` is resolved, run setup once — never pass the API key as a
command-line argument:

```bash
"${FEZOCTL_ARGV[@]}" setup --key-stdin
```

Always invoke the engine through `"${FEZOCTL_ARGV[@]}"`, including for setup.
Never type a bare `fezoctl`: only tier 4 of the ladder below puts a literal
`fezoctl` command on `PATH`, so `fezoctl ...` fails outright in tiers 1, 2, 3,
and 5 — which are the common cases.
