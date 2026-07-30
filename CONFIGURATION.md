# Configuration

This document covers everything about how `fezoctl` finds and stores your
Fezo/Zug gateway URL and API key. For everything else (commands, HTTP
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
  secret.
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

## Canonical environment variables

| Variable | Purpose |
| --- | --- |
| `FEZO_URL` | The gateway's base URL. |
| `FEZO_API_KEY` | Your gateway API key. |

## Deprecated aliases

| Variable | Replaces | Behavior |
| --- | --- | --- |
| `ZUG_URL` | `FEZO_URL` | Accepted, with **one warning** printed to stderr per process the first time it's used. |
| `ZUG_API_KEY` | `FEZO_API_KEY` | Same. |

The gateway itself is not being renamed, so these aliases are a real,
supported compatibility path — not a stub scheduled for deletion. Verified
warning (each alias warns exactly once, even across multiple commands in the
same process):

```
$ ZUG_URL=https://gateway.example.com ZUG_API_KEY=... fezoctl doctor
fezoctl: ZUG_URL is deprecated; use FEZO_URL instead
fezoctl: ZUG_API_KEY is deprecated; use FEZO_API_KEY instead
doctor:
  ...
```

## Resolution order

`FEZO_URL` and `FEZO_API_KEY` are each resolved independently through the
same four sources, in this priority order, stopping at the first one with a
non-empty value:

1. The canonical environment variable (`FEZO_URL` / `FEZO_API_KEY`).
2. The deprecated alias (`ZUG_URL` / `ZUG_API_KEY`), with the one-time warning
   above.
3. macOS Keychain (see below) — skipped entirely on a platform where no
   Keychain runner is available.
4. The `.env` config file (see below).

`fezoctl doctor` reports which source won for each value (`env`,
`deprecated-env`, `keychain`, or `dotenv`) — run it if you're not sure which
credential is actually in effect. Verified:

```
$ node dist/fezoctl.mjs doctor
doctor:
  [ok] gateway-url: FEZO_URL resolved from dotenv
  [ok] api-key: FEZO_API_KEY resolved from dotenv
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
$XDG_CONFIG_HOME/fezo/.env      (if $XDG_CONFIG_HOME is set and non-empty)
~/.config/fezo/.env             (otherwise)
```

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
silently, so you don't lose a credential you didn't intend to replace.

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

Keychain storage is only available where a `security`-binary-backed runner is
wired in (macOS); on other platforms, `--storage keychain` fails as an
ordinary reported error rather than a crash, and the default storage,
`dotenv`, is what you want.

## `setup --key-stdin` usage

The key is never a command-line argument. Pipe it in:

```bash
# .env storage (default):
printf '%s' "$YOUR_KEY" | fezoctl setup --key-stdin --url https://your-gateway.example.com

# macOS Keychain storage:
printf '%s' "$YOUR_KEY" | fezoctl setup --key-stdin --storage keychain --url https://your-gateway.example.com
```

`--url` is optional on a re-run if you only need to rotate the key. `setup`
prints a confirmation with the masked key and the resolved source — never the
raw key:

```
setup — storage: dotenv
  api key: stored
  url: stored
  configured url: https://your-gateway.example.com (source: dotenv)
  configured api key: sk-l… (source: dotenv)
```

`setup` exits `0` only if both writes (or the one write you requested) are
verified; otherwise it exits `2` (an operational failure) with a message
explaining what went wrong or what could not be verified.
