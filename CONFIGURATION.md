# Configuration

This document covers everything about how `fezoctl` finds and stores your
Fezo gateway URL and API key. For everything else (commands, HTTP
binding, retry behavior, the `--json` error contract), see
[README.md](README.md).

Commands below are shown as `fezoctl <command>` for brevity. Substitute
however you actually resolved the executable — `node dist/fezoctl.mjs
<command>` from a checkout, or the skill's own `"${FEZOCTL_ARGV[@]}"` — see
README.md's ["Installation"](README.md#installation) section.

## Threat model

An API key must never end up in any of these places:

- a conversation transcript,
- a process list (`ps` can read any local process's argv),
- shell history,
- or a world-readable file.

Every rule in this document exists to close one of those leak paths, not as
boilerplate. Concretely:

- `fezoctl` never has a `--api-key` flag, and never accepts a key as a
  command-line argument anywhere. The only way to hand it a key is
  `fezoctl setup --key-stdin`, which reads the key from **stdin**.
- There is no interactive "ask the agent to collect a key" flow; nothing in
  this CLI is designed to be driven by an `AskUserQuestion`-style prompt for a
  secret. That rule has to be stated where a *model* will read it, not only
  here: `skills/fezo/SKILL.md` (generated from `build/step0.md`) forbids
  collecting the key through `AskUserQuestion` **and** forbids putting it in a
  Bash command the model constructs, and tells the model to stop and have the
  user run `setup --key-stdin` in their own terminal instead. The gateway URL
  and the storage choice are the only things a modal may collect — neither is
  a secret.
- Writes to macOS Keychain pipe the secret through the write process's
  **stdin**, never through argv — the commonly-documented
  `security add-generic-password -w "$KEY"` form puts the secret in argv,
  where `ps` can read it from any local process; `fezoctl` deliberately avoids
  that form.
- The `.env` config file is created with mode `0600` **at open time**
  (`fs.openSync(path, 'wx', 0o600)`), not `chmod`'d afterward — a
  chmod-after-write would leave a window during which the file is
  world-readable. Its parent directory is created `0700` for the same reason:
  a world-readable directory advertises that a credential file exists (and
  its size and modification time) even if the file itself is `0600`.
- Every renderer (`doctor`, `--json` output, `setup`'s own confirmation)
  prints a **masked** form of the key — at most 4 leading characters followed
  by an ellipsis, never the full value or even its true length. The raw
  secret exists in exactly one place in the code (`credentials.ts`'s
  `ResolvedValue.value`), because the HTTP client needs the real value to
  call the gateway; nothing else is allowed to read that field.
- `fezoctl` never logs an `Authorization` header.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `FEZO_URL` | The gateway's base URL. Optional — defaults to `https://zug-gateway.internal-iden3-dev.com`. |
| `FEZO_API_KEY` | Your gateway API key. Required; there is no default. |

These are the only two environment variables `fezoctl` reads for
credentials — there are no aliases. Any other name is ignored silently, so if
a credential is not taking effect, check the spelling of the variable before
anything else; `fezoctl doctor` reports what actually resolved.

### The default gateway URL

`fezoctl` ships with a built-in gateway URL
(`https://zug-gateway.internal-iden3-dev.com`, `credentials.ts`'s
`DEFAULT_GATEWAY_URL`). It is the **last** source consulted for the URL, below
all three below — so configuring `FEZO_URL`, a Keychain item, or a `.env` entry
always wins, and pointing `fezoctl` at a different gateway needs no code
change. `doctor` and `setup` report a defaulted URL as `source: default`,
which is how you tell "nobody configured this" from "this is what I chose".

**The API key has no default and must not grow one.** A default key would
either be a live credential committed to the repository or a placeholder that
turns "you configured nothing" into a 401 from the gateway. A default URL has
neither property: it is not a secret, and a wrong gateway fails loudly at the
first catalog fetch. So the only credential `setup` genuinely has to supply is
the key — `setup --key-stdin` with no `--url` now produces a complete, usable
configuration and exits `0`.

## `FEZO_EXCLUDED_BACKENDS` (not a credential)

One more environment variable `fezoctl` reads, kept out of the table above
because it configures policy, not authentication: which backends `fezoctl`
refuses to surface or call, regardless of what the gateway itself serves. The
default deny-list is `falai,alpaca` — see the README's ["Deny-listed
backends"](README.md#deny-listed-backends-falai-alpaca) for why those two
specifically, and for how `search`/`catalog`/`providers`/`list-providers`
filter them out while `call`/`run` refuse to reach one by name even when you
already know it.

Two rules about the value, both load-bearing:

- **It REPLACES the default, it does not extend it.** Setting
  `FEZO_EXCLUDED_BACKENDS=geonode` excludes *only* `geonode` — `falai` and
  `alpaca` are no longer excluded unless you list them too. There is no
  "default plus one more" shorthand; write out every id you want excluded.
- **An explicitly empty string is honoured as "exclude nothing"** — a
  genuinely distinct state from leaving the variable unset. `fezoctl` reads
  the variable as **absent vs. present**, not as truthy vs. falsy:

  | Value | Effect |
  | --- | --- |
  | *(unset)* | Default deny-list: `falai`, `alpaca`. |
  | `FEZO_EXCLUDED_BACKENDS=""` | Deny-list is empty — every backend the gateway serves is callable, including `falai`/`alpaca`. |
  | `FEZO_EXCLUDED_BACKENDS="geonode,apify"` | Deny-list is exactly `geonode` and `apify` — `falai`/`alpaca` are NOT excluded unless also listed. |

  This is what makes the `falai`/`alpaca` exclusion reversible without a
  release, in both directions: an operator can run with nothing excluded
  without inventing a placeholder id, and without that meaning "and also keep
  the two defaults."

The value is a comma-separated list of backend ids, trimmed of surrounding
whitespace, with blank entries dropped (`FEZO_EXCLUDED_BACKENDS=" geonode ,  "`
excludes exactly `geonode`). It is resolved once per `fezoctl` invocation from
the same injected `env` credentials read from — never cached at module load —
so it responds to a changed environment on the very next command, same as
`FEZO_URL`/`FEZO_API_KEY`.

`fezoctl doctor`'s `preference-hints` check (see the README's
["`doctor`"](README.md#doctor)) warns, but never fails, if the declared
provider table names a backend or entry method your current catalog does not
publish — unrelated to this variable, but worth knowing about if you exclude
a backend that provider policy still recommends: the recommendation itself is
unaffected, only what `fezoctl` will actually call.

## Resolution order

`FEZO_URL` and `FEZO_API_KEY` are each resolved independently through the
same three sources, in this priority order, stopping at the first one with a
non-empty value (`FEZO_URL` then has a fourth rung the key does not — the
built-in default described above):

1. The environment variable (`FEZO_URL` / `FEZO_API_KEY`).
2. macOS Keychain (see below). This step is always **attempted**, never
   conditionally skipped: `fezoctl`'s entry point always injects its
   `/usr/bin/security`-backed Keychain runner (`src/cli.ts`'s `main()`), so
   every resolution that gets past the environment shells out to
   `security find-generic-password`. On a platform with no `/usr/bin/security`
   that lookup just fails, and resolution falls through to the `.env` file —
   the outcome is the same as skipping it, but the mechanism is a failed
   lookup, not an absent runner.
3. The `.env` config file (see below).
4. **`FEZO_URL` only:** the built-in `DEFAULT_GATEWAY_URL`. An unconfigured
   API key simply does not resolve, and every command then fails with
   `the API key is not configured`.

`fezoctl doctor` reports which source won for each value (`env`, `keychain`,
`dotenv`, or — for the URL — `default`) — run it if you're not sure which
credential is actually in effect. Each `ok` credential check also prints a
pretty-printed `details` block: the URL in full, the API key **masked**.
Verified (against a local test gateway, hence the `localhost` URL; the
`details` JSON's continuation lines are not re-indented, which is what the
renderer actually emits):

```
$ node dist/fezoctl.mjs doctor
doctor:
  [ok] gateway-url: FEZO_URL resolved from dotenv
      {
  "url": {
    "value": "http://localhost:8899",
    "source": "dotenv"
  }
}
  [ok] api-key: FEZO_API_KEY resolved from dotenv
      {
  "apiKey": {
    "masked": "test…",
    "source": "dotenv"
  }
}
  ...
```

An env var set in your shell will always win over anything stored via
`setup`, even if `setup` reports a successful write — this is expected, not a
bug: `setup` verifies its write by reading the value back through the *same*
resolution chain, and if a higher-priority source (an exported env var)
answers first, it reports the write as **unverified** (still exit 0) rather
than falsely claiming "stored," pointing you at the shadowing source.

## Config file location

`.env` lives at:

```
$XDG_CONFIG_HOME/fezo/.env      (if $XDG_CONFIG_HOME is set to an ABSOLUTE path)
~/.config/fezo/.env             (otherwise)
```

A relative `XDG_CONFIG_HOME` is **ignored** (with a note on stderr), per the XDG
base-directory spec, and the `~/.config` fallback is used instead: joined
verbatim, `XDG_CONFIG_HOME=.config` would resolve against the current working
directory and write a live API key into whatever project you happened to be
in — `0600`, but committable.

**Not** `~/.config/fezoctl/` — the directory follows the product name
(`fezo`), not the CLI binary's name, matching `FEZO_URL`/`FEZO_API_KEY` and
the Keychain identifiers below. If you have used an early build or another
tool that wrote to a `fezoctl`-named directory, `fezoctl` will not find
credentials there.

The file is plain `KEY=value` lines (no quoting, no escaping):

```
FEZO_API_KEY=your-key-here
FEZO_URL=https://your-gateway.example.com
```

`fezoctl setup --key-stdin --storage dotenv` (the default storage) writes
this file for you, atomically, refusing to clobber an existing one — if
`.env` already exists, `setup` reports that instead of overwriting it
silently, so you don't lose a credential you didn't intend to replace. That
refusal is also what makes a second `setup` fail rather than rotate the key;
see ["Rotating a key"](#rotating-a-key) for what to do instead.

Verified file mode after `setup --key-stdin`:

```
$ ls -la ~/.config/fezo/
drwx------  .
-rw-------  .env
```

## macOS Keychain

`fezoctl setup --key-stdin --storage keychain` stores the URL and API key as
two Keychain items instead of a file. Both live under the **same fixed
identifiers**, which are effectively a storage format — do not expect them to
ever change:

| Identifier | Value |
| --- | --- |
| Account | `fezo` |
| Service (API key) | `fezo-api-key` |
| Service (URL) | `fezo-url` |

`fezoctl` always wires up its Keychain runner (see
["Resolution order"](#resolution-order)), but that runner shells out to
`/usr/bin/security`, which exists only on macOS. Elsewhere, `--storage
keychain` is *attempted* and reports an ordinary failure rather than crashing,
and the default storage, `dotenv`, is what you want.

## `setup --key-stdin` usage

The key is never a command-line argument. Pipe it in:

```bash
# .env storage (default):
printf '%s' "$YOUR_KEY" | fezoctl setup --key-stdin --url https://your-gateway.example.com

# macOS Keychain storage:
printf '%s' "$YOUR_KEY" | fezoctl setup --key-stdin --storage keychain --url https://your-gateway.example.com
```

**There is no prompt.** `setup --key-stdin` prints nothing before reading; it
drains standard input to end-of-file and only then reports. So if you run it
without a pipe, you get a blank line and no instructions: type or paste the key,
press Enter, then press **Ctrl-D** to signal end-of-file. The key is echoed on
screen in that form. To type it without echo, and without ever putting it in a
command line or the history file:

```bash
printf 'Fezo API key: '; read -rs KEY; echo
printf '%s' "$KEY" | fezoctl setup --key-stdin --url https://your-gateway.example.com
unset KEY
```

`printf` is a builtin in both bash and zsh, so the key never becomes a separate
process's argv. Note that this needs a real terminal: with stdin closed or
redirected from `/dev/null` — an agent's shell, a CI step, a Claude Code `!`
command — `setup --key-stdin` reads immediate end-of-file, stores nothing, and
exits **2** with `api key: failed (no API key was provided; nothing was
stored)`.

`--url` **is** optional: omitting it stores only the key and leaves the gateway
at the built-in default, which is a complete configuration. `setup` says so
explicitly and exits **0**:

```
setup — storage: dotenv
  api key: stored
  configured url: https://zug-gateway.internal-iden3-dev.com (source: default)
  configured api key: sk-l… (source: dotenv)
```

`(source: default)` is the part to read: it distinguishes a gateway nobody
chose from one you configured. Pass `--url` only to point somewhere else.

What `setup` still refuses to call a success is a run that stores **no key** —
the one credential with no default. That prints `this configuration is NOT
usable yet: fezoctl needs an API key.` and exits **2**, which under `--json` is
the top-level `"usable": false`. The distinction matters because the exit code
is the only part of the report a script or an agent reliably reads: a `setup`
that cannot be followed by a working `catalog` must not exit 0.

With an explicit `--url`, `setup` prints a confirmation with the masked key and
the resolved source — never the raw key:

```
setup — storage: dotenv
  api key: stored
  url: stored
  configured url: https://your-gateway.example.com (source: dotenv)
  configured api key: sk-l… (source: dotenv)
```

## Rotating a key

**With `--storage keychain`, just re-run `setup`.** Keychain writes pass `-U`
to `security add-generic-password` ("Update item if it already exists (if
omitted, the item cannot already exist)" — `man security`), so they are
idempotent, and the URL and the key are two independent Keychain items. `--url`
really is optional on a re-run:

```bash
printf '%s' "$NEW_KEY" | fezoctl setup --key-stdin --storage keychain
```

The previously stored URL survives, and the new key takes effect immediately.

**With the default `dotenv` storage, a plain re-run does not rotate — it
fails.** `setup` writes `.env` with `openSync(path, 'wx', 0o600)`, and `wx`
means "create, or fail if it already exists", so a second `setup` is refused
with exit code `2`:

```
$ printf '%s' "$NEW_KEY" | node dist/fezoctl.mjs setup --key-stdin
setup — storage: dotenv
  api key: failed (/Users/you/.config/fezo/.env already exists; refusing to overwrite it)
  configured url: https://your-gateway.example.com (source: dotenv)
  configured api key: test… (source: dotenv)
$ echo $?
2
```

(The path in the message is your real `.env` path, printed in full.) Note the
last two lines: the *old* credential is still in effect and is what `setup`
reports back. Nothing was changed.

The `wx` flag is deliberate, not an oversight. It is the same rule that keeps
`setup` from silently destroying a credential you didn't mean to replace, and
it is what lets the file be created `0600` **at open time** rather than
`chmod`'d afterward — a create-then-chmod would leave a window in which a live
API key sits in a world-readable file. Both properties are worth more than a
one-command rotation, so `setup` does not offer an `--overwrite` flag.

Two ways to rotate a `dotenv`-stored credential:

1. **Edit `~/.config/fezo/.env` in place.** It is plain `KEY=value` lines with
   no quoting or escaping (see ["Config file location"](#config-file-location)),
   so changing `FEZO_API_KEY=` to the new value with any editor is a complete
   rotation. This preserves the file's existing `0600` mode and leaves
   `FEZO_URL` alone — it is the smaller, safer of the two.

2. **Remove the file and re-run `setup`** — and **pass `--url` again if you are
   not on the default gateway**:

   ```bash
   rm ~/.config/fezo/.env
   printf '%s' "$NEW_KEY" | fezoctl setup --key-stdin --url https://your-gateway.example.com
   ```

   `setup` writes the whole file, not a patch, so a re-run without `--url`
   leaves you with a `.env` containing only `FEZO_API_KEY` — **your custom
   gateway URL is gone**, and resolution silently falls back to the built-in
   default. Since that default is a working configuration, `setup` exits `0`
   here: the only thing that tells you the URL changed is the `configured url:`
   line and its source. Verified — same run, `--url` omitted:

   ```
   $ rm ~/.config/fezo/.env
   $ printf '%s' "$NEW_KEY" | node dist/fezoctl.mjs setup --key-stdin
   setup — storage: dotenv
     api key: stored
     configured url: https://zug-gateway.internal-iden3-dev.com (source: default)
     configured api key: sk-l… (source: dotenv)
   $ echo $?
   0
   $ cat ~/.config/fezo/.env
   FEZO_API_KEY=sk-live-rotated-key
   ```

   This is the one place the default costs you something: rotating this way used
   to fail loudly when it dropped your URL, and now it succeeds against a
   different gateway. **Read the `configured url:` line, or prefer route 1**,
   which never touches the URL at all. Run `fezoctl doctor` after either route
   to confirm what is actually in effect.

## `setup`'s exit code

`setup` exits `2` (an operational failure) in three cases:

1. **A write failed** — the `.env`-already-exists refusal above, or a Keychain
   write that reported an error.
2. **A value it just wrote could not be read back**, and nothing
   higher-priority explains why.
3. **The resulting configuration is still not usable** — after the write, no
   API key resolves. `setup` prints `this configuration is NOT usable yet:
   fezoctl needs an API key.` and exits `2` rather than reporting a success the
   next command would contradict. The gateway URL cannot put you here: it
   always resolves, defaulting if nothing configured one.

Otherwise it exits `0`.

A write that succeeded but could not be verified *because a higher-priority
source shadows it* is **not** a failure: it is reported as "stored, but NOT
verified" and exits `0`. This is the case described under
["Resolution order"](#resolution-order) — the value really was stored, but
resolution now answers from an exported env var, so `setup` cannot read its own
write back to prove it. Verified (`FEZO_URL`/`FEZO_API_KEY` exported in the
shell, `setup` writing to `dotenv`):

```
$ printf '%s' "$NEW_KEY" | node dist/fezoctl.mjs setup --key-stdin --url http://localhost:8899
setup — storage: dotenv
  api key: stored, but NOT verified — the write reported success but could not be verified: resolution now answers from "env", which takes priority over "dotenv", so the stored value could not be read back. Unset the higher-priority source and re-run `fezoctl doctor` to confirm what was stored.
  url: stored, but NOT verified — the write reported success but could not be verified: resolution now answers from "env", which takes priority over "dotenv", so the stored value could not be read back. Unset the higher-priority source and re-run `fezoctl doctor` to confirm what was stored.
  configured url: https://env-gateway.example.com (source: env)
  configured api key: sk-e… (source: env)
$ echo $?
0
```

So a `0` exit from `setup` means "nothing failed **and** a URL and a key both
resolve now" — it does *not* mean "the value I just stored is the one `fezoctl`
will use", because a higher-priority source may be answering instead. Read the
per-field lines, and use `doctor` to confirm which source actually wins.

Under `--json`, the same three conditions are visible per field (each field's
`ok`) plus the top-level `"usable"` flag for condition 3.
