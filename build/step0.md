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
