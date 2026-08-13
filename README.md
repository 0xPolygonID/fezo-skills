# fezo-skills

`fezo-skills` is an agent skill (`fezo`) backed by a small, dependency-free
TypeScript CLI (`fezoctl`). The skill discovers and calls Fezo API gateway
tools by reading the gateway's live catalog (`GET /v1/catalog`) at run time,
instead of shipping a hand-maintained, per-backend method roster.

The skill itself (`skills/fezo/SKILL.md`) is written for an agent and tells it
*when* to reach for `fezo` and how to run the procedure. This document is
written for the human who installs and operates `fezoctl` — what to run, what
each flag does, what a failure means, and where the rough edges are.

## Why "live catalog" matters

New backends and methods become callable the moment they register with the
gateway and show up in `/v1/catalog` — no new release of this skill or this
CLI is required to recognize them. `fezoctl` never transcribes a backend's
manifest into a fixture; it fetches the catalog fresh on every invocation and
builds its candidate list from that response alone. See
["The dynamic flow"](#the-dynamic-flow) below.

## Requirements

- Node.js >= 22.12 (pinned in `package.json`'s `engines`; `SKILL.md`'s
  `compatibility` field says "node >=22" — treat the `package.json` value as
  authoritative).
- bash or zsh, and network access to your Fezo gateway.
- [pnpm](https://pnpm.io/) — only if you are developing this repository, not
  to use the CLI.

## Installation

Each host has a first-class lane; `npx skills add` is the cross-host fallback
that covers everything else.

| Surface | Install |
| --------- | --------- |
| **Claude Code** (recommended) | `/plugin marketplace add 0xPolygonID/fezo-skills` |
| **Grok** (xAI Build CLI) | `grok plugin marketplace add 0xPolygonID/fezo-skills`, then `grok plugin install fezo` |
| **Gemini CLI** | `gemini extensions install https://github.com/0xPolygonID/fezo-skills` |
| **Codex** | `npx skills add 0xPolygonID/fezo-skills -g -a codex` — step-by-step install and test guide in [`CODEX.md`](CODEX.md) |
| **Cursor, Copilot, and 70+ other hosts** | `npx skills add 0xPolygonID/fezo-skills -g` |
| **OpenClaw** | `openclaw skills install git:0xPolygonID/fezo-skills@main` |
| **Hermes** | copy `skills/fezo/` into `~/.hermes/skills/` |
| **claude.ai / Cowork** (web) | zip `skills/fezo/` and upload — see [caveats](#claude-cowork--claudeai) |

Every lane installs the same skill directory and the same engine; they differ
only in who discovers the manifest. The manifests are generated — see
["Per-host manifests"](#per-host-manifests).

Whichever lane you use, credentials are a separate one-time step: see
["Credentials"](#credentials-once-per-machine) below.

### Cross-host: `npx skills add`

```bash
npx skills add 0xPolygonID/fezo-skills -g
```

[`skills`](https://github.com/vercel-labs/skills) reads `skills/fezo/` out of
this repository and installs it into every coding agent it detects on your
machine — Claude Code, Codex, Cursor, OpenClaw, and others — with the
canonical copy at `~/.agents/skills/fezo` and each agent's own skills
directory symlinked to it. Drop `-g` to install into the current project
instead, and add `-a claude-code` (repeatable) to target specific agents.

This works because the skill directory is **self-contained**: it carries its
own engine at `skills/fezo/scripts/fezoctl.mjs`, a committed copy of
`dist/fezoctl.mjs`. Installers of this kind copy the skill directory and
nothing else, so tier 3 of the [invocation ladder](#the-invocation-ladder)
cannot resolve at the install target and tier 2 is what serves them.

### Credentials: once per machine

No install lane configures credentials. `skills add` and the plugin
marketplaces copy files and run no install hooks, deliberately — so do this
once, yourself, after installing by any route (see
[`CONFIGURATION.md`](CONFIGURATION.md) for the full story):

```bash
printf '%s' "$YOUR_FEZO_API_KEY" | node ~/.agents/skills/fezo/scripts/fezoctl.mjs setup
node ~/.agents/skills/fezo/scripts/fezoctl.mjs doctor
```

Only the API key is required. The gateway URL defaults to
`https://fezo.ai`; add
`--url https://your-gateway.example.com` if you are on a different one.

Credentials live outside the skill directory (`~/.config/fezo/.env` at mode
0600, the macOS Keychain, or the environment), so **every host on the machine
shares one setup** — installing a second lane does not mean configuring again.

Two exceptions worth knowing:

- **Gemini CLI** takes `FEZO_URL` and `FEZO_API_KEY` as extension settings and
  injects them as environment variables, which is the highest-priority source
  in the resolution chain. That lane needs no `setup` run.
- **claude.ai / Cowork** has no persistent home directory and no way to inject
  environment variables — see the caveats below.

Node.js >= 22.12 and network access to your gateway must be available to
whatever agent runs the skill; `doctor` is the check for both, and it reports
which source each credential resolved from.

### Per-host manifests

The plugin lanes in the table above are driven by manifests at the repository
root, all **generated** by `pnpm gen-manifests`:

| File | Lane |
| ------ | ------ |
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | Claude Code |
| `.codex-plugin/plugin.json` | Codex |
| `.grok-plugin/plugin.json`, `.grok-plugin/marketplace.json` | Grok / xAI Build CLI |
| `.agents/plugins/marketplace.json` | cross-host `.agents` marketplace |
| `gemini-extension.json` | Gemini CLI |
| `.skillignore`, `.clawhubignore` | Hermes / ClawHub root-scan exclusions |

**Do not hand-edit the generated files.** Every value in them — version,
description, URLs, license — is derived from `package.json` and
`build/gen-skill.mjs`, so a manual edit is reverted by the next
`pnpm gen-manifests` and fails CI's manifest-freshness gate in the meantime.
They are generated precisely because seven copies of the version number is
seven ways to publish a release that was never cut.

`.claude-plugin/marketplace.json` earns its keep twice: Claude Code installs
from it, and the `skills` CLI also discovers skills declared in it, so the two
lanes share one file. The skill is deduplicated by name, so it is not
double-listed.

### Other ways

There is no published npm package yet — see ["Known gaps"](#known-gaps).

- **Copy or symlink the skill directory.** `cp -R skills/fezo
  ~/.claude/skills/fezo` (or `~/.agents/skills/`, `~/.hermes/skills/`,
  `~/.openclaw/skills/`, …). A symlink to a checkout works too, and keeps the
  skill updated by `git pull`.
- **Use the skill straight from a checkout.** Point your agent at
  `skills/fezo/SKILL.md` in a clone. Tier 2 resolves the engine; tier 3 is the
  same bundle one directory up.
- **Run the committed bundle directly.** `dist/fezoctl.mjs` is a
  self-contained, deterministic build committed to this repository — clone it
  and run `node dist/fezoctl.mjs <command>`.
- **Build from source.** `pnpm install && pnpm bundle` produces
  `dist/fezoctl.mjs` from `src/cli.ts` and refreshes the skill-local copy.

### Claude Cowork / claude.ai

```bash
cd skills && zip -r fezo.zip fezo
```

Upload via **Customize → Skills → + → Create skill → Upload a skill**, and
enable *Code execution and file creation* under Capabilities. Tier 2 of the
ladder resolves, because the engine rides inside the zip.

Expect friction here, and verify before relying on it. Three things must hold
in that container, and none is under your control:

1. **Node.js >= 22.12** — the container's version is not documented.
2. **Network egress to your gateway** — the sandbox restricts outbound
   connections, so an arbitrary gateway host is normally unreachable unless it
   has been allowlisted.
3. **Credentials** — there is no way to inject `FEZO_API_KEY` into that
   container, and `~/.config/fezo/.env` does not persist between sessions, so
   `setup` has to be re-run each session. That means the key passes through the
   conversation, which is exactly what the stdin-only key channel exists to
   avoid everywhere else.

Run `doctor` first; it names which of the three failed. Until egress and a
credential path are settled, treat this lane as unsupported rather than
broken-in-an-interesting-way.

### The invocation ladder

`SKILL.md`'s "Resolve fezoctl" step (generated from `build/invocation.sh`)
resolves the `fezoctl` executable in a fixed order, and every subsequent
command in that skill session is invoked through the result
(`"${FEZOCTL_ARGV[@]}"`), never as a bare `fezoctl`:

1. `$FEZOCTL`, if it names an executable file.
2. `<skill dir>/scripts/fezoctl.mjs` — the bundle committed inside the skill
   directory — invoked as `node <path>`, not relied on to be executable (a
   `.skill` archive or plain file copy may not preserve the executable bit).
   **This is the rung that serves installed skills**, wherever they came from:
   `npx skills add`, a `cp -R`, an archive.
3. `<skill dir>/../../dist/fezoctl.mjs` — this repo's own committed bundle,
   when the skill is used straight out of a checkout — also invoked as
   `node <path>`. Only a checkout has this layout; an installed skill
   directory does not, which is why tier 2 exists.
4. A global `fezoctl` on `PATH`, but **only** if `fezoctl --version` matches
   `SKILL_VERSION` **exactly**. `fezoctl --version` prints `fezoctl <version>`
   (a prefixed string, not a bare version), so the ladder compares against
   `"fezoctl $SKILL_VERSION"`, not against `$SKILL_VERSION` alone — a stale or
   differently-versioned global install is skipped, not silently used.
5. A version-pinned `npx -y fezo-skills@$SKILL_VERSION fezoctl`.

Tiers 2–3 (a versioned bundle shipped with the skill or checked out alongside
it) always outrank tier 4 (`PATH`): a bundle known to match the skill's own
version is preferred over whatever happens to be globally installed, even if
something is on `PATH`.

**Tier 5 does not work today.** `fezo-skills` is not yet published to npm (see
["Known gaps"](#known-gaps)), so `npx -y fezo-skills@<version>` resolves to a
version that does not exist on the registry and will fail. Tiers 1–4 (a
checkout, the committed bundle, or a matching global install) are the only
paths that currently work.

### One version number, not two

The skill's frontmatter `version` and `package.json`'s `version` are the same
release number, asserted equal by CI (`tests/skill_contract.test.ts`).
`$SKILL_VERSION` is derived from this single number and used for two things
that are both facts about the *package*: the tier-5 `npx` pin above, and the
tier-4 exact-match comparison against a global install's `--version` output.
The per-host plugin manifests carry that same number, which is why they are
generated rather than hand-written. If you bump `package.json`'s `version`, you
must re-run and commit **all three**:

```bash
pnpm bundle        # rebuilds both committed bundles with the new version baked in
pnpm gen-skill     # regenerates skills/fezo/SKILL.md with the new SKILL_VERSION
pnpm gen-manifests # regenerates every per-host plugin manifest
```

Bumping the version changes `dist/fezoctl.mjs`'s bytes (the version is baked
in via an esbuild `--define`, not read from `package.json` at run time in the
bundled artifact), so CI's freshness gates will fail until all three commands
are re-run and the results committed.

## Quick start

```bash
# From a checkout of this repository:
node dist/fezoctl.mjs --help

# Configure the API key once — the gateway URL defaults to
# https://fezo.ai, so --url is only for a different
# gateway (see CONFIGURATION.md for the full story):
printf '%s' "$YOUR_FEZO_API_KEY" | node dist/fezoctl.mjs setup

# Confirm everything is wired up:
node dist/fezoctl.mjs doctor

# Search, inspect, and call:
node dist/fezoctl.mjs search "web search"
node dist/fezoctl.mjs schema exa_search
node dist/fezoctl.mjs call exa_search --args-json '{"query":"anthropic claude","numResults":3}'
```

Real output from a session against a gateway (backend and tool names vary by
what your gateway has registered — never hardcode these):

```
$ node dist/fezoctl.mjs call exa_search --args-json '{"query":"anthropic claude","numResults":3}'
call exa_search
resolved: exa.search (POST /search)
request: {
  "path": "/search",
  "query": {
    "query": "anthropic claude"
  },
  "headers": {},
  "body": {
    "numResults": 3
  }
}
attempts:
  1. exa_search (exa) [success] billed=true httpStatus=200 — 200 response
  billing: every attempt that reached a 2xx response is billed by the provider (billed=true); attempts that failed or were skipped before a request was sent are not billed
billed: true
result (status 200):
{
  "results": [ ... ]
}
```

Notice `query` went into the query string and `numResults` went into the JSON
body of the same POST call — see ["HTTP binding behavior"](#http-binding-behavior).

## The dynamic flow

```text
user intent -> search live catalog -> inspect schema/bindings -> choose candidate
            -> call -> retry another compatible candidate on retryable failure
```

- `fezoctl search "<query>"` fetches `/v1/catalog` and ranks matching tools.
  The searchable text is six fields (`src/engine/rank.ts`'s
  `searchableBlob`): tool name, **backend id**, method name, **title**,
  description, and backend info text (the backend's `info` title, summary, and
  description — and *only* those three). Nothing else in the catalog is
  matchable: verified that a term appearing only in `info.docs_url`, only in
  `info.categories`, or only as an input-schema property name returns no
  matches. That exclusion is deliberate (`src/engine/catalog.ts`'s
  `formatBackendInfoText`) — a `docs_url` ending in `/scrape` would otherwise
  match "scrape" on a backend that cannot scrape.
- `fezoctl schema <tool>` shows one tool's input schema, HTTP verb, binding
  map (query/path/header/body), backend id, method name, and call path — the
  information you need before calling it correctly.
- `fezoctl call <tool> --args-json '<json>'` resolves exactly the named tool
  from the live catalog, validates arguments, binds them per the catalog's
  HTTP binding rules, and calls it once (no retry, no candidate selection).
- `fezoctl run "<intent>" --args-json '<json>'` is the retrying, policy-driven
  variant: it searches, picks the best-ranked candidate for the intent
  (honoring provider preference hints — see
  ["Provider selection"](#provider-selection)), calls it, and on a *retryable
  mechanical* failure tries the next compatible candidate.
- `fezoctl web-search "<query>"` / `scrape <url>` / `crawl <url>` skip search
  and selection entirely: each walks the **declared** per-intent provider
  ranking top-down (not a `search` match), trying one provider at a time and
  falling back on a retryable failure — see ["One-step
  commands"](#one-step-commands).
- `fezoctl providers [--intent <intent>]` / `list-providers` surface that same
  declared ranking directly, for comparing providers or reaching a capability
  (news, social, proxy) no one-step command covers — see ["Provider
  recommendations"](#provider-recommendations).

Because every one of these commands fetches `/v1/catalog` fresh, a backend
registering with the gateway today is discoverable by `search`/`schema`/`run`
today, with no new release of this CLI or skill. This is the central design
claim of `fezo-skills`: the catalog is the source of truth, and this repo
never hardcodes a backend roster (see `skills/fezo/SKILL.md`'s own
instruction not to assume one).

## CLI reference

```
fezoctl search "<query>" [--schema] [--json]
fezoctl schema <tool> [--json]
fezoctl call <tool> --args-json '<json>' [--body-json '<json>'] [--json]
fezoctl run "<intent>" --args-json '<json>' [--body-json '<json>']
           [--max-attempts N] [--retry-empty-2xx] [--allow-unhinted-auto-pick] [--json]
fezoctl web-search "<query>" [--extra-json '<json>'] [--max-attempts N] [--json]
fezoctl scrape <url>         [--extra-json '<json>'] [--max-attempts N] [--json]
fezoctl crawl <url>          [--extra-json '<json>'] [--max-attempts N] [--json]
fezoctl catalog [--json]
fezoctl providers [--intent <intent>] [--detail names|descriptions|schema]
                   [--limit N] [--explain] [--json]
fezoctl list-providers [--json]
fezoctl setup [--url <url>] [--storage keychain|dotenv] [--json]
fezoctl doctor [--json]
fezoctl --version
fezoctl --help
```

(Verbatim from `node dist/fezoctl.mjs --help`, which is the authoritative
source — run it yourself if this ever looks stale.)

| Command | Purpose |
| --- | --- |
| `search "<query>" [--schema]` | Fetch the catalog, rank matching tools, optionally include each match's schema and HTTP bindings. |
| `schema <tool>` | Print one tool's input/output schema, HTTP verb, binding map, backend id, method name, and call path. |
| `call <tool> --args-json '<json>' [--body-json '<json>']` | Resolve exactly one named tool, validate, bind, and call it once. |
| `run "<intent>" --args-json '<json>' [--body-json '<json>']` | Search, select the best candidate for the intent, call it, and retry a compatible alternative on a retryable mechanical failure. |
| `web-search "<query>"` / `scrape <url>` / `crawl <url>` | One-step commands: walk `src/engine/providers.ts`'s declared ranking for `search`/`scrape`/`crawl` top-down, calling one provider at a time and falling back to the next on a retryable failure — no need to know any provider's argument name. See ["One-step commands"](#one-step-commands). |
| `providers [--intent <intent>]` | Surface the declared, per-intent provider ranking, grouped by capability — every group by default, or exactly one with `--intent`. See ["Provider recommendations"](#provider-recommendations). |
| `list-providers` | One row per live catalog backend, with its declared standing across every intent it appears in. See ["Provider recommendations"](#provider-recommendations). |
| `catalog` | List every backend and method the gateway currently reports. |
| `setup` | Store the API key (and optionally the gateway URL) without ever putting the key in argv or a transcript. The key is read from stdin — `printf '%s' "$KEY" | fezoctl setup` is the whole command, and a key passed as an argument is refused with exit 1. `--url` is optional — omit it and the gateway stays at the built-in default (`configured url: … (source: default)`), which is a complete configuration. A `setup` that stores no API key is not: it prints `this configuration is NOT usable yet: fezoctl needs an API key.` and exits 2 rather than reporting a success no other command can use. |
| `doctor` | Diagnose configuration and connectivity — the first thing to run when something is wrong. See ["`doctor`"](#doctor). |

### Exit codes

From `src/cli.ts`'s `HELP_TEXT` (and matching its `EXIT_OK`/`EXIT_USAGE`/`EXIT_OPERATIONAL` constants):

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Usage error: a bad command/flag, or an unparseable `--args-json`/`--body-json`/`--extra-json` payload, or an unknown/invalid `providers` `--intent`/`--detail`/`--limit`. Rejected while parsing argv, **before** any candidate is selected or called. |
| `2` | Operational failure: credentials not configured, the gateway/catalog could not be reached or read, arguments failed schema validation, a `schema`/`call`/`run` that named a deny-listed backend, or a `call`/`run`/`web-search`/`scrape`/`crawl` that did not end in success (including a `run` refusal, an empty match, a one-step walk with no provider left to serve it, or `doctor` finding a hard failure). |

Verified: `--help`/no-args exit `0`; an unknown command, missing `--args-json`,
invalid JSON, or `--max-attempts 0` exit `1`; missing credentials, an
unresolved tool, failed schema validation, and a `run` that gives up or is
refused all exit `2`.

## HTTP binding behavior

`fezoctl` reads the catalog's `http` block for each method and places your
arguments accordingly — in the URL path, the query string, a request header,
or the JSON body — **based on what the catalog says, not on what the HTTP
verb implies.** This is a deliberate fix for a real bug in the gateway's
existing MCP server, which assumes GET means "all args in query" and POST
means "all args in body." That assumption breaks down in practice: **a POST can
legitimately require query parameters.** For example, a backend's async
scrape method may be a POST whose `http.query` binding carries an id the
backend reads from `r.URL.Query()`, while the POST body is an entirely
separate payload the input schema doesn't even describe.

Binding rules, in brief (see `src/engine/bindings.ts` for the exact logic):

- **Path parameters** come from `{placeholder}` segments in the catalog path,
  URL-encoded per segment, and removed from the remaining argument object.
- **Query parameters** come from the catalog's `http.query` list.
- **Header parameters** come from `http.header` — and only from that list:
  `fezoctl` refuses (throws a local error) to let a tool call set
  `Authorization` or any `X-Fezo-*` header, even if a manifest names one.
- **Body** comes from whatever isn't claimed by path/query/header (for a
  POST-like method), or from `--body-json` when you supply it.
- If a method's catalog entry has no `http` block at all, `fezoctl` falls
  back to the legacy assumption (GET → query, POST → body) — but this is
  the exception, not the rule, and is exactly the behavior the binding logic
  otherwise avoids.

Missing a required path/query/header/body value is a **local client error**:
`fezoctl` never sends a request that some other value should have completed.
In a `run`, this kind of local rejection does not abort the whole run — it
just skips that one candidate (see ["Retry behavior and billing"](#retry-behavior-and-billing)).

### `--body-json` and the three-branch body-source rule

`--body-json` is how you supply a request body that isn't simply "the
remaining arguments as JSON" — needed whenever a method's body shape is
distinct from its query/path/header arguments (the async-scrape example
above is the canonical case). The rule, applied in this order:

1. **`--body-json` given:** it is sent as the body, verbatim. A GET method
   refuses this outright (`body-not-allowed`) rather than silently dropping
   the body, because the Fetch API cannot send a body on GET/HEAD.
2. **`--body-json` absent, and the method has both non-body bindings (query/
   path/header) and a request-body binding:** the bound values are pulled out
   of `--args-json` for the path/query/header, and whatever is left over in
   `--args-json` becomes the JSON body.
3. **`--body-json` absent, and there is no such "mixed" shape** (a plain POST
   with nothing bound to query/path/header, or a plain GET): `--args-json` is
   the sole source, used for whichever destination the method actually has.

Case 2 and case 3's "POST" sub-case are the same mechanism in the
implementation — a plain POST is just the "mixed" case where nothing happened
to be claimed by query/path/header, so the whole object is left over as body.

Verified example (a POST method whose query binding claims `dataset_id`, and
whose body binding is a separate array the input schema does not describe):

```
$ node dist/fezoctl.mjs call brightdata_scrape_async \
    --args-json '{"dataset_id":"gd_l1"}' \
    --body-json '[{"url":"https://example.com"}]'
...
request: {
  "path": "/scrape_async",
  "query": { "dataset_id": "gd_l1" },
  "headers": {},
  "body": [ { "url": "https://example.com" } ]
}
```

## Retry behavior and billing

**Every 2xx response is billed by the provider.** `fezoctl run` makes this
explicit rather than hiding it behind automatic retries:

- `--max-attempts` defaults to **2** and bounds **billed calls**, not log
  entries. A candidate that a local binding check rejects before any request
  is sent (a missing required argument for *that specific* candidate) costs
  nothing and does not count against the budget — but it still appears in the
  attempt log, so you can see why it was skipped. A run can therefore log
  more attempts than `--max-attempts` if some of them were free pre-flight
  rejections.
- Each attempt in the log carries a `billed` field, set from the actual
  response received — `true` for any 2xx, `false` otherwise — never inferred
  from the attempt's `status`. (A `retry`-status attempt caused by an empty
  2xx body is still `billed: true`, because the empty response was already
  paid for.)
- **Empty-2xx retry is opt-in**, via `--retry-empty-2xx`, precisely because
  retrying spends money on a response that may simply be legitimately empty.
  Without the flag, an empty 2xx body counts as `success`.
- **Semantic-quality retries are never automatic.** The engine only detects
  *mechanical* failure (a non-2xx response, a transport error, a local
  binding rejection). Whether a successful response is actually useful — on
  topic, complete, not a bot-block page — is the agent's judgment call;
  `SKILL.md` instructs the agent to inspect the result and deliberately call
  a different candidate if it isn't.

### Classification (why one failure retries and another aborts)

Classification is by **gateway error code first, HTTP status only as a
fallback** when there is no code (`src/engine/retry.ts`):

- **Abort the whole run:** `unauthorized`, `limit_exceeded`,
  `insufficient_balance` — these describe the caller's account or
  credentials, not one provider, so trying another candidate cannot help.
  Known limitation: `limit_exceeded` can, in principle, be scoped to a single
  backend, but the gateway currently exposes that scope only in a
  human-readable message, not a structured field — so `fezoctl` aborts
  conservatively even when a backend-scoped limit could have safely advanced
  to another provider.
- **Try the next candidate:** `quota_exceeded`, `rate_limited`,
  `backend_unavailable`, `provider_disabled`, `backend_not_configured`,
  `backend_not_found`, `backend_error`, `tool_not_in_catalog`, a code-less
  HTTP 402/429/500/502/503, a transport failure, and (opt-in) an empty 2xx
  body. Note: `rate_limited` as a *gateway* code is not normally observed in
  practice — a real upstream rate limit almost always arrives as a code-less
  backend 429, so the HTTP-status fallback is the path that actually matters
  for rate limiting.
- **Give up:** an **unrecognized** gateway code (one in neither the abort nor
  the retry set above — `fezoctl` will not guess what an unknown code means);
  a code-less response whose status is **anything** outside 402/429/500/502/503
  (so a code-less 404 *and* a code-less 504 both give up — the rule is not
  scoped to 4xx); or an exhausted candidate list.
- A **local binding rejection** (a candidate-specific missing argument, a
  disallowed header) is *never* an abort — it just skips that one candidate,
  because it says nothing about whether the next candidate (which may name
  its parameters differently, or use a different HTTP verb) would also fail.

Verified fallback example — a preferred backend fails with a code-less 503,
and `run` advances to the next preferred candidate for the same capability.
(`position 2` is firecrawl's index in the declared `scrape` order, which
begins `scrapingdog` → `brightdata` → `firecrawl`; neither of the first two is
in this catalog, so firecrawl is the highest-ranked provider actually present.
Before this CLI derived its preference from the declared table, the same run
reported `position 0` against a hand-written list that began with firecrawl —
so a `run` whose catalog *does* carry `scrapingdog` or `brightdata` will now
pick one of those first.)

```
$ node dist/fezoctl.mjs run "scrape url" --args-json '{"url":"https://example.com"}'
run "scrape url"
selected: firecrawl_scrape (firecrawl.scrape, POST /scrape, per_call)
  why: exact-method; matched: scrape, url; termScore=4; preferred for "scrape" (position 2)
attempts:
  1. firecrawl_scrape (firecrawl) [retry] billed=false httpStatus=503 — code-less HTTP 503
  2. scrapingbee_scrape (scrapingbee) [success] billed=true httpStatus=200 — 200 response
  billing: every attempt that reached a 2xx response is billed by the provider (billed=true); attempts that failed or were skipped before a request was sent are not billed
billed: true
result (status 200):
{
  "markdown": "# Example\ncontent"
}
```

Verified give-up example — the same intent and the same candidate list, but
the first attempt returns a gateway code that is in neither classification
set. `run` stops there rather than spending money on `scrapingbee`, because an
unknown code is not evidence that another provider would do better:

```
$ node dist/fezoctl.mjs run "scrape url" --args-json '{"url":"https://example.com"}'
run "scrape url"
selected: firecrawl_scrape (firecrawl.scrape, POST /scrape, per_call)
  why: exact-method; matched: scrape, url; termScore=4; preferred for "scrape" (position 2)
attempts:
  1. firecrawl_scrape (firecrawl) [give_up] billed=false httpStatus=400 gatewayCode=malformed_request — unrecognized gateway code "malformed_request"
  billing: every attempt that reached a 2xx response is billed by the provider (billed=true); attempts that failed or were skipped before a request was sent are not billed
billed: false
give up: unrecognized gateway code "malformed_request"
```

A code-less response gives up the same way, with `non-retryable HTTP <status>
with no gateway code` — verified for both a code-less 404 and a code-less 504.

### Known limitation: a dropped connection during a billed response

If the connection drops while `fezoctl` is reading the **body** of an
already-2xx response, the gateway has already recorded the billing event
(it bills before copying the response body), but `fezoctl` cannot tell that
apart from a pre-response transport failure. That attempt is logged as a
`transport` failure with `billed: false` — **even though you may have been
charged.** This is a documented, accepted gap (`src/engine/retry.ts`'s
`attemptCandidate` doc comment), not something `fezoctl` currently detects or
corrects for.

## Provider recommendations

The per-capability ("intent") ordering `providers`/`list-providers` return,
and that `web-search`/`scrape`/`crawl` walk, is declared by hand in
[`src/engine/providers.ts`](src/engine/providers.ts)'s `RECOMMENDATIONS` —
**array order is rank; nothing is scored or sorted at runtime.** It is the
*conclusions* of [`docs/providers-score.md`](docs/providers-score.md) (the
underlying five-criterion rubric, its weights, and its arithmetic) written
down directly, ported verbatim from `zug/mcp-server`'s own declared table —
including its rationale comments — because writing the order down removes
float-rounding and tie-break machinery that exists only to reproduce twelve
numbers whose gaps are false precision anyway (`brave` 80.6 vs `exa` 79.5 — a
1.1-point gap from integer judgments on five axes). The rubric survives as an
audit trail, not as the mechanism. **Provider policy is edited in
`src/engine/providers.ts`, nowhere else** — see ["Provider
selection"](#provider-selection) for how `run`'s legacy tie-break table is
just a derived view of this same one.

Current declared order per intent (`primary` → `secondary` → `fallback`; a
`when` note tells you when to skip ahead a rank):

| Intent | Order |
| --- | --- |
| `search` | `you` → `exa` (semantic/neural retrieval) → `brave` (independent index/data sovereignty) → `firecrawl` → `geonode` |
| `scrape` | `scrapingdog` → `brightdata` (hard/anti-bot targets, or Scrapingdog success <~50%) → `firecrawl` → `geonode` → `apify` → `scraperapi` → `scrapingbee` |
| `crawl` | `firecrawl` → `geonode` → `brightdata` → `apify` |
| `news` | `newsapi` → `you` → `brave` |
| `social` | `apify` and `brightdata` (both primary) → `xro` (not recommended: ~30–90× costlier than third-party alternatives, hard 2M-read cap, heaviest TOS/lock-in risk) |
| `proxy` | `geonode` → `brightdata` |

This table is a snapshot for orientation, not the thing to script against —
`fezoctl providers`/`list-providers` read the live, canonical table and also
tell you what is actually *callable on your gateway right now*, which this
static list cannot.

**Providers are not substitutes across these groups.** They span four
functional categories (AI search, scraping, proxy infrastructure,
specialized/social) — a global cross-capability ranking would put an AI-search
provider above a proxy/unlocking provider and point you at the wrong tool for
a Cloudflare-protected page. Always compare *within* one capability group:
pass `--intent` to `providers` to get exactly one such group.

Two cases that look similar but are not, both always surfaced (never
dropped):

- **Unrated** (`rated: false`) — a live catalog backend that no declared list
  mentions at all, e.g. a newly onboarded backend. Appended after every
  declared provider with a note that it is simply not yet assessed.
- **Not recommended** (`not_recommended.reason` present) — assessed and
  advised against; currently only `xro` for `social`. Placed last in its
  declared list.

An unrated backend therefore sorts ahead of a not-recommended one, and
`best_value` (the group's top pick) is present only when rank 1 is a
declared, not-advised-against recommendation — never for an unrated backend,
and never for the `other` group (which has no declared recommendations at
all).

Verified — `providers --intent search` against a two-backend catalog (`you`
publishes no live `search` method, so its row falls back to a few of its
other catalog method names rather than showing nothing callable; `exa`
publishes its declared entry method):

```
$ node dist/fezoctl.mjs providers --intent search
recommendations: docs/providers-score.md (prepared 2026-08-05)

search — best_value: you
  1. [primary] You.com (you, dynamic)
     methods: [you_contents, you_finance_research, you_research] (+1 more)
  2. [secondary] Exa (exa, per_call)
     entry_methods: [exa_search]
```

`list-providers` inverts the view — one row per live backend, every intent it
has a declared standing in:

```
$ node dist/fezoctl.mjs list-providers
recommendations: docs/providers-score.md (prepared 2026-08-05)
providers — 2 backend(s)
  You.com (you, dynamic)
    why: cheapest quality AI search, clean data rights
    categories: []
    methods: [you_contents, you_finance_research, you_research, you_research_start]
    recommendations:
      search: declared rank 1 (primary) — cheapest quality AI search, clean data rights
      news: declared rank 2 (secondary) — same clean, cheap index; freshness-filtered search stands in for a dedicated news endpoint
  Exa (exa, per_call)
    why: neural/semantic retrieval with deep research and monitors
    when: semantic/neural retrieval quality matters most
    categories: []
    methods: [exa_search]
    recommendations:
      search: declared rank 2 (secondary) — neural/semantic retrieval with deep research and monitors
```

`providers` ranks by what your catalog **actually serves** — a provider's
number moves up when a higher-ranked one is absent from your gateway's
entitlement — while `list-providers` always reports the **declared** rank,
the provider's fixed position in `RECOMMENDATIONS`. The two commands can
therefore print different numbers for the same provider; neither is wrong,
they answer different questions ("what should I call right now" vs. "where
does this provider stand in the policy").

`--detail` (on `providers`) defaults to `names` — a cheap sweep carrying each
row's identity (rank, tier, provider, backend id, billing model, and the
`rated` / `not_recommended` flags) plus what is callable; a provider with no
live entry method for the intent still shows a few of its catalog method
names rather than an empty row, exactly like the `you` example above, and
reports what that cap dropped as `methods_omitted`. "Cheap" means this level
omits the why/when prose, the complete method list and any inlined schema —
**not** that it omits identity: the `--json` and human views carry the same
fields at every level, so a script can see that a provider is advised against
without having to ask for `descriptions`. `descriptions` adds the full
why/when prose and the provider's complete method list; `schema` additionally
inlines each surfaced method's input schema. `--explain` adds the
`recommendations` provenance block to every row, at every detail level.
`--limit` caps each group and always reports what it dropped as `omitted`,
never silently.

### Deny-listed backends (`falai`, `alpaca`)

`falai` and `alpaca` never appear in `search`/`catalog`/`providers`/
`list-providers`, and `schema`/`call`/`run` refuse them by name (exit `2`,
`backend-excluded`) even when you already know the exact tool name.

`schema` refuses rather than merely filtering, even though it calls nothing
and bills nothing: handing back a full input schema and binding map for a
backend this CLI will then refuse to call just costs you a second command to
learn one fact. The message names the action you attempted — `cannot be
inspected` for `schema`, `cannot be called` for `call`/`run` — and names
`FEZO_EXCLUDED_BACKENDS`, which is the thing to change if you want it back.
**This deny-list is currently the only thing disabling either backend** on
this CLI's side — `fezoctl` only talks to the gateway over HTTP and cannot
change what the gateway itself serves — so treat it as the switch, not as
defence in depth.

The default set (`['falai', 'alpaca']`) is overridden — **not extended** — by
`FEZO_EXCLUDED_BACKENDS`: a comma-separated backend-id list. An explicitly
empty string, `FEZO_EXCLUDED_BACKENDS=""`, is honoured as "exclude nothing" —
an *absent* variable is what falls back to the default, so there is no way to
ask for "the default plus one more" short of writing out the whole list
yourself. This is what makes the falai/alpaca call reversible without a
release, in both directions. `web-search`/`scrape`/`crawl`'s ranked walk also
never attempts a deny-listed provider, silently skipping past it exactly like
a `notRecommended` one (see ["One-step commands"](#one-step-commands)).

### Refresh procedure

Recommendations are prose-to-prose against the source doc; there is no
arithmetic to reconcile until (or unless) a scoring rubric is ever wired up at
runtime. To refresh:

1. Re-read [`docs/providers-score.md`](docs/providers-score.md).
2. Update `RECOMMENDATIONS` and `RECOMMENDATION_SOURCE.preparedAt` in
   `src/engine/providers.ts` to match.
3. Re-check the invariants `tests/providers.test.ts` pins by hand-editing a
   fixture, or just re-run `pnpm test` — every intent needs a `primary`;
   tiers must stay non-increasing down each list; no `backendId` may appear
   twice within one intent; every `entryMethods` name must be tagged with (at
   least) its own intent in `src/engine/intent.ts`'s `METHOD_INTENTS`. None of
   that says the order is *right* — only a re-read of the source doc speaks to
   that.
4. Run `fezoctl doctor` against a real gateway afterward — its
   `preference-hints` check (see ["`doctor`"](#doctor)) warns if the refreshed
   table now names a backend or entry method your catalog doesn't actually
   publish.

## One-step commands

`web-search "<query>"`, `scrape <url>`, and `crawl <url>` are one call each —
no need to search first, pick a candidate, or know any provider's argument
name. Each walks [`src/engine/providers.ts`](src/engine/providers.ts)'s
declared ranking for its own intent (`search`/`scrape`/`crawl` respectively)
**top-down**, in declared order — never re-sorted, never the `search` command's
relevance ranking — trying one provider at a time and falling back to the
next on a retryable mechanical failure, until one succeeds or the walk is
exhausted.

Verified fallback — `you` (rank 1 of `search`) fails with a code-less 503,
and the walk advances to `exa` (rank 2), which succeeds:

```
$ node dist/fezoctl.mjs web-search "weather today"
web-search "weather today"
Served by Exa (rank 2 of search). For a different provider, more options, or a capability no one-step command covers (news, social, proxy), run `fezoctl providers --intent search`.
attempts:
  1. you_search (you) [retry] billed=false httpStatus=503 gatewayCode=backend_unavailable — gateway code "backend_unavailable"
  2. exa_search (exa) [success] billed=true httpStatus=200 — 200 response
  billing: every attempt that reached a 2xx response is billed by the provider (billed=true); attempts that failed or were skipped before a request was sent are not billed
billed: true
result (status 200):
{
  "results": []
}
```

A few rules specific to these three commands:

- **Argument-name resolution is automatic.** Each provider names the same
  input differently (`query` vs `q` vs `keyword` for `web-search`; `url` vs
  `target_url` vs `link` for `scrape`/`crawl`) — the walk reads each
  candidate's own input schema and resolves which property carries your
  value, preferring a *required* property over an optional one with the same
  name. A provider whose schema names nothing plausible is skipped, never
  called with a guessed argument name.
- **`--extra-json` merges provider-specific options** into whichever
  candidate the walk lands on (result counts, formats, timeouts — never the
  query/URL itself, which is always the command's own positional argument).
  A provider whose own schema rejects the merged arguments is skipped and
  named under `arg_rejected` — reported **even on an otherwise successful
  run**, so "rank 1 was blocked" and "your `--extra-json` disqualified rank 1"
  never produce identical-looking output.
- **`manifest_rejected` is the case that is *not* yours to fix.** A provider
  whose arguments pass its schema but whose manifest then requires a value
  the command never asks for (a path or query parameter, say) is named here
  instead — also reported even on a successful run, and deliberately worded
  to send you to `fezoctl schema <tool>` and `fezoctl call <tool>` rather
  than to an `--extra-json` you may never have passed. The two are separate
  fields because only one of them describes something you can change.
- **`--max-attempts` defaults to 3 here, not `run`'s default of 2** — a
  deliberately different budget, because the two numbers bound different
  things: `run`'s budget is a *retry* budget for repeated failures on one
  already-selected candidate; a one-step command's budget is a
  *ranked-fallback* budget across several genuinely different,
  separately-priced providers. Pass `--max-attempts` to override it.
- **A 60-second wall-clock deadline** bounds the whole walk, not configurable
  from the command line. It is checked only **before starting a new
  attempt, never mid-attempt, and never before the first** — a client-side
  timeout that aborted a call already in flight would discard a result
  already billed. On expiry the walk stops starting new attempts and reports
  whichever candidate answered last; the output says the cap stopped it,
  which reads differently from "every provider failed" for exactly the reason
  a caller needs to know which one happened.
- **Deny-listed and `notRecommended` providers are never attempted**, and
  never explain their own absence in the output — they are policy exclusions
  decided ahead of time, not something this specific call discovered.
- **No provider could serve the request at all** (every declared provider was
  absent from your catalog, unranked, or had no resolvable argument) exits
  `2` and names which providers were skipped and why, pointing you at
  `fezoctl providers --intent <intent>` to see the full picture.
- **Each command's one-line description exists once**, in
  [`src/engine/one-step-descriptions.json`](src/engine/one-step-descriptions.json).
  `fezoctl --help` renders it (through `src/engine/steering.ts`'s
  `ONE_STEP_DESCRIPTIONS`) and so does the generated
  [`skills/fezo/SKILL.md`](skills/fezo/SKILL.md) (through
  `build/gen-skill.mjs`), each wrapping it to its own column — so the help
  text an operator reads and the procedure an agent follows cannot end up
  describing the same command differently. Edit the JSON, then run
  `pnpm gen-skill`; `tests/skill_contract.test.ts` fails if the committed
  SKILL.md no longer carries the current sentences.

## Provider selection

When `run` has more than one compatible candidate, which one it tries first
is **policy, not measurement**: `src/engine/preference.ts`'s
`CAPABILITY_PREFERENCES` is a per-capability backend ordering — recorded
human judgment about which provider to prefer, not a measured cost or latency
ranking. `run` never falls back to alphabetical catalog order as a substitute
policy.

Capabilities are **`scrape` and `web-search`** — that's the whole set.
`serp` is not a capability: it used to be a third one, and was folded into
`web-search` (its keyword phrases — `"serp"`, `"google search"`, etc. — moved
there verbatim) rather than kept as a separate bucket sharing `web-search`'s
ordering, because the declared table this repo derives from has no SERP-
specific list to give it: a Google-SERP request and a general web-search
request are both the `search` intent in `src/engine/providers.ts`, served by
the same declared roster. Two capabilities aliased onto one ordering only
bought a spurious `ambiguous-capability` refusal on "google search for X on
the web" over a distinction this repo's provider policy does not draw.

`CAPABILITY_PREFERENCES` is **derived, not authored**: it is a view of the
declared per-intent provider table `RECOMMENDATIONS` in
`src/engine/providers.ts` — see ["Provider
recommendations"](#provider-recommendations) — with each capability taking
its intent's declared backend order (`scrape` → `scrape`; `web-search` →
`search`) and `notRecommended` entries dropped. **Provider policy is edited
in `src/engine/providers.ts`**, the one authored table in the repo; editing
`preference.ts` changes only how that table is reshaped into the two legacy
buckets `rank.ts` reads.

- A free-text intent is matched against a small keyword table
  (`CAPABILITY_KEYWORDS`) to infer which capability, if any, applies. If a
  capability is inferred, its preference ordering breaks ties among matching
  candidates.
- Each capability's ordering is **sparse** — a backend absent from it simply
  gets no preference boost — so an inferred capability can name *none* of the
  matched candidates' backends. This is exactly the SERP case above in a
  different guise: a SERP-worded query (`"google search results"`) infers
  `web-search`, but `web-search`'s declared `search` roster (`you` → `exa` →
  `brave` → `firecrawl` → `geonode`) deliberately names no SERP specialist —
  zug's provider policy prefers real search APIs over scraping a results
  page. A hint that discriminates nothing among the actual candidates is
  treated as **no hint at all** (`rank.ts`'s `selectForRun`, the
  `discriminates` guard): ranking on it would decide a billed call by
  input/catalog order while still reporting the result as a hinted `selected`
  pick, with no `--allow-unhinted-auto-pick` gate in front of it — exactly
  the "alphabetical order becomes the policy" outcome the unhinted rule below
  exists to prevent.
- If no usable capability hint applies — the intent's wording doesn't match
  any known capability phrase, **or** the inferred capability's ordering
  discriminates nothing among the matched candidates (the case just above) —
  and the matching candidates span **two or more backends**, `run` **refuses
  to auto-pick** rather than silently making catalog/alphabetical order the
  policy. This refusal is overridable with `--allow-unhinted-auto-pick`,
  which promotes **only the top-ranked candidate** — there is no fallback to
  a second candidate under this override, because the user only agreed to
  the one promotion, not to a chain of un-hinted backends. When every
  matched candidate is from a *single* backend, there is no cross-provider
  policy to get wrong, so `run` auto-picks even with a non-discriminating (or
  absent) hint — the guard only ever turns a would-be `selected` into a
  refusal when two or more backends are actually competing.
- If two or more capabilities match ambiguously, `run` also refuses — with
  **no override** for that case.
- **Async lifecycle methods are excluded from auto-selection by default.** A
  method that looks like starting, polling, or fetching the result of an
  asynchronous job is not something `run` will call on your behalf from an
  ordinary free-text intent. The exclusion is a **default, not a wall** — two
  things re-enable it (`src/engine/rank.ts`'s `selectForRun`), and when every
  match was excluded, `run` prints the first one as a hint rather than
  reporting a bare no-match:
  1. The intent contains `async`, `job`, `snapshot`, `status`, or `crawl` as a
     whole word. Async candidates are then eligible for auto-selection like
     any other — asking for async behavior counts as consent to it.
  2. The intent exactly matches one tool's name (that candidate alone is
     re-enabled). `fezoctl call <tool>` always works too, and never applies
     this filter at all.

Verified refusal and override, generic case (no capability wording matches
at all):

```
$ node dist/fezoctl.mjs run "search" --args-json '{"query":"x"}'
run "search"
refused: candidates span multiple backends with no capability preference (exa, newsapi); use --allow-unhinted-auto-pick to pick the top-ranked one, or call a specific tool

$ node dist/fezoctl.mjs run "search" --args-json '{"query":"x"}' --allow-unhinted-auto-pick
run "search"
refused: candidates span multiple backends with no capability preference (exa, newsapi); use --allow-unhinted-auto-pick to pick the top-ranked one, or call a specific tool
--allow-unhinted-auto-pick set: promoting exa_search (exa.search, POST /search, per_call)
attempts:
  1. exa_search (exa) [success] billed=true httpStatus=200 — 200 response
...
```

Verified refusal and override, the Amendment-A "hint discriminates nothing"
case: `"google search results"` DOES infer `web-search`, but the two matching
candidates (`scraperapi`/`brightdata` SERP endpoints) are both absent from
`web-search`'s declared `search` roster, so the hint is treated as none and
this still lands on the same overridable refusal as the unhinted case above —
never on a silent `selected` decided by catalog order:

```
$ node dist/fezoctl.mjs run "google search results" --args-json '{"q":"widgets"}'
run "google search results"
refused: candidates span multiple backends with no capability preference (scraperapi, brightdata); use --allow-unhinted-auto-pick to pick the top-ranked one, or call a specific tool

$ node dist/fezoctl.mjs run "google search results" --args-json '{"q":"widgets"}' --allow-unhinted-auto-pick
run "google search results"
refused: candidates span multiple backends with no capability preference (scraperapi, brightdata); use --allow-unhinted-auto-pick to pick the top-ranked one, or call a specific tool
--allow-unhinted-auto-pick set: promoting scraperapi_serp (scraperapi.serp, GET /serp, per_call) — Google SERP
attempts:
  1. scraperapi_serp (scraperapi) [success] billed=true httpStatus=200 — 200 response
...
```

Both exit `2` without the flag and `0` with it — identically to the generic
case, which is the point: a non-discriminating hint and no hint at all are
handled by the exact same rule.

Verified async exclusion, the hint `run` prints, and the intent-word override:

```
$ node dist/fezoctl.mjs run "dataset" --args-json '{"dataset_id":"gd_l1"}'
run "dataset"
every matching candidate is an async lifecycle method (start/poll/status/fetch-result), so none was auto-picked:
  - brightdata_scrape_async (brightdata.scrape_async, POST /scrape_async, dynamic)
name the tool exactly (`fezoctl call <tool>`), or add "async"/"job"/"snapshot"/"status"/"crawl" to the intent to allow one

$ node dist/fezoctl.mjs run "dataset job" --args-json '{"dataset_id":"gd_l1"}'
run "dataset job"
selected: brightdata_scrape_async (brightdata.scrape_async, POST /scrape_async, dynamic)
  why: term-score; matched: dataset, job; termScore=2
attempts:
  1. brightdata_scrape_async (brightdata) [success] billed=true httpStatus=200 — 200 response
...
```

The first form exits `2`, the second `0`. Because the override makes an async
method billable from a free-text intent, prefer `call` when you already know
which method you want.

## The `--json` error contract

With `--json`, stdout is a JSON document for every command — never empty —
which is what makes it safe for an agent or script to parse unconditionally.
There is exactly one exception, noted below.[^help-json] There are two
possible shapes, and a consumer must handle both:

1. **A failure that never reached the engine** (bad usage, no credentials,
   catalog unreachable, `schema` naming a tool that isn't in the catalog,
   schema validation failed, `--version` couldn't read its own version, or
   `call`/`run` refusing a deny-listed backend by name):

   ```json
   {"error": {"kind": "...", "message": "..."}}
   ```

   `kind` is a **closed set of eight values** (from `src/engine/render.ts`'s
   `CliErrorKind`, stable — values may be added in the future but never
   renamed or repurposed): `usage`, `credentials-not-configured`,
   `catalog-unavailable`, `tool-not-found`, `invalid-args`, `invalid-body`,
   `version-unavailable`, `backend-excluded`.

2. **A `call`/`run`/`web-search`/`scrape`/`crawl` that reached the engine** —
   even if the outcome was a retry give-up, an abort, a run refusal, or a
   one-step walk that never found a provider to serve it — emits its **full
   attempt-log report** instead of an error envelope, because that document
   carries strictly more information (the attempt log and what was billed).
   Look for an `attempts` array and an `outcome`/`result` field, not an
   `error` key. **This includes `call <tool>` where `<tool>` is not in the
   catalog**: `call` synthesizes the one-entry attempt log `run` would have
   produced rather than emitting a `tool-not-found` envelope, so the marker to
   test is `resolved: false`, not `error`. Only `schema <tool>` produces the
   `tool-not-found` envelope (`src/cli.ts`'s `cmdSchema` vs. `cmdCall`).
   **`backend-excluded` is the one exception in the other direction**: a
   `call`/`run` that resolves to a deny-listed backend refuses BEFORE calling
   anything, exactly like `tool-not-found`, so it is shape 1 above even though
   `call`/`run` are otherwise shape-2 commands — see ["Deny-listed
   backends"](#deny-listed-backends-falai-alpaca).

The human-readable message always goes to **stderr**, in both cases, and the
exit code does not change based on `--json`.

Verified — shape 1, an argument that fails the resolved tool's schema:

```
$ node dist/fezoctl.mjs call exa_search --args-json '{}' --json
{
  "error": {
    "kind": "invalid-args",
    "message": "--args-json does not match exa_search's input schema: (root) must have required property 'query'"
  }
}
```

Verified — the same unknown tool name through both commands, showing that
"tool not found" is shape 2 under `call` and shape 1 under `schema`. Both exit
`2`:

```
$ node dist/fezoctl.mjs call nope_tool --args-json '{}' --json
{
  "tool": "nope_tool",
  "resolved": false,
  "attempts": [
    {
      "tool": "nope_tool",
      "backendId": "(unresolved)",
      "status": "retry",
      "reason": "gateway code \"tool_not_in_catalog\"",
      "billed": false,
      "httpStatus": 404,
      "gatewayCode": "tool_not_in_catalog"
    }
  ],
  "outcome": {
    "kind": "give_up",
    "reason": "no more candidates to try"
  },
  "billedAnyAttempt": false,
  "billing": "every attempt that reached a 2xx response is billed by the provider (billed=true); attempts that failed or were skipped before a request was sent are not billed"
}

$ node dist/fezoctl.mjs schema nope_tool --json
{
  "error": {
    "kind": "tool-not-found",
    "message": "tool \"nope_tool\" was not found in the catalog"
  }
}
```

Verified — `call` naming a deny-listed backend's tool by its exact name. The
tool genuinely exists in the live catalog (unlike the `nope_tool` case
above), but `fezoctl` refuses to reach it regardless — shape 1, not shape 2,
because no request is ever sent:

```
$ node dist/fezoctl.mjs call falai_generate --args-json '{"prompt":"a cat"}' --json
{
  "error": {
    "kind": "backend-excluded",
    "message": "backend \"falai\" is excluded (FEZO_EXCLUDED_BACKENDS); \"falai_generate\" cannot be called"
  }
}
```

[^help-json]: `fezoctl --help --json` (or `-h` anywhere in argv alongside
    `--json`) prints the **help text** on stdout and exits `0` — help is
    resolved before argv is parsed into a command, and it has no JSON form.
    That output is not parseable JSON, so a script that unconditionally
    `JSON.parse`es stdout must not pass `--help`/`-h`. Every other command,
    including a bare `fezoctl --json` (which is a `usage` error, because
    `--json` is not a command), does emit a JSON document.

## Credentials

Only the **API key** has to be configured. The gateway URL falls back to a
built-in default, `https://fezo.ai`, as the last
rung of its resolution chain — `FEZO_URL`, a Keychain item, and `~/.config/fezo/.env`
all outrank it, and `doctor`/`setup` report a defaulted URL as `source: default`
so a gateway nobody chose never looks like one somebody did. The API key has no
default and must not grow one.

See **[CONFIGURATION.md](CONFIGURATION.md)** for the full credential model:
the resolution order, the security reasoning behind
`setup`, macOS Keychain details, `.env` file location and
permissions, and **how to rotate a key** —
which differs between the two storage backends, because a second
`setup` on the default `dotenv` storage is refused rather than
overwriting the file.

## `doctor`

Run `fezoctl doctor` first whenever something is wrong. It reports a sequence
of independent checks rather than bailing out at the first failure, so you
can see exactly how far configuration and connectivity got:

| Check | Meaning |
| --- | --- |
| `gateway-url` | Which source `FEZO_URL` resolved from. Never fails: with none configured it reports `FEZO_URL is not configured; using the built-in default gateway` and `source: default`, which is a working state — see ["Credentials"](#credentials). |
| `api-key` | Whether `FEZO_API_KEY` resolved from any source, and which one. The only credential whose absence is a hard failure. |
| `gateway-connectivity` | Whether the gateway responded at all to a catalog fetch. |
| `auth` | Whether the gateway accepted the API key (distinguished from connectivity by a 401/403 status specifically). |
| `catalog-readable` | Whether the response body actually parsed as a catalog document. |
| `preference-hints` | Whether every backend AND declared entry method in `src/engine/providers.ts`'s `RECOMMENDATIONS` (all seven intents) is actually present in the live catalog (a `warn`, not a `fail` — a declared row naming a backend/method this gateway does not expose just means that row currently contributes no ranking signal). |

**Known limitation: `doctor` probes connectivity via `GET /v1/catalog`, which
requires authentication.** That means it cannot cleanly separate "the gateway
is unreachable / `FEZO_URL` is wrong" from "the URL is fine but the key is
bad" the way an unauthenticated health-check endpoint would. `doctor` *does*
distinguish a 401/403 response (reported as an `auth` failure, with
`gateway-connectivity` still `ok`) from any other non-2xx status (reported as
a `gateway-connectivity` failure, with `auth` skipped) — so the information is
there, and the check names above tell you which is which — but do not expect
`doctor` to give you a separate "is the URL even reachable" signal
independent of your key being valid. (The gateway does expose an open,
unauthenticated `/healthz`; `fezoctl` does not call it today.)

A check that has structured data to report also prints it as a
pretty-printed `details` block on the line below — the resolved URL in full,
the API key **masked** (never the raw key), and `preference-hints`'
`missingBackends`/`missingEntryMethods` lists. Only the first line of that
block carries the indent the renderer adds, so it looks ragged; that is the
literal output, not a transcription slip.

Verified — a stored key that the gateway's `/v1/catalog` rejects with 401
(run against a local test gateway with an isolated `HOME`, hence the
`localhost` URL). Exits `2`, because one check is a `fail`:

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
    "masked": "sk-l…",
    "source": "dotenv"
  }
}
  [ok] gateway-connectivity: reached the gateway
  [fail] auth: the gateway rejected the API key (status 401)
  [skipped] catalog-readable: skipped: auth failed
  [skipped] preference-hints: skipped: catalog unavailable
```

## Known gaps

- **`fezo-skills` is not published to npm.** The invocation ladder's tier-5
  `npx -y fezo-skills@$SKILL_VERSION` fallback does not work today — it
  resolves to a version that does not exist on the registry. Use a checkout
  of this repository, the committed `dist/fezoctl.mjs` bundle, or a matching
  global install (tiers 1–4) instead.
- **`doctor`'s connectivity probe requires auth** (see ["`doctor`"](#doctor)
  above) — it does not separate "gateway unreachable" from "key rejected" as
  cleanly as an unauthenticated health check would, though it does
  distinguish a 401/403 from other failures.

## Development

Requires Node >=22.12 and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm typecheck    # or `pnpm build` — same command; tsc runs with noEmit
pnpm test         # run the test suite
pnpm bundle       # build dist/fezoctl.mjs and copy it into skills/fezo/scripts/
pnpm gen-skill    # regenerate skills/fezo/SKILL.md from build/step0.md + build/invocation.sh
pnpm gen-manifests # regenerate the per-host plugin manifests
pnpm pack:check   # verify the artifact `npm pack` would actually publish
```

- `dist/fezoctl.mjs` is a deterministic, dependency-free, single-file bundle
  of `src/cli.ts` (built with esbuild) and is committed to this repository —
  that is what lets a Git-URL or HEAD install resolve the engine without a
  build step. CI fails if the committed file differs from a fresh
  `pnpm bundle`.
- `skills/fezo/scripts/fezoctl.mjs` is the same bundle, written by
  `pnpm bundle` (and automatically via npm's `prepack` lifecycle hook) and
  **also committed**. It is what makes the skill directory self-contained for
  installers that take `skills/fezo/` and nothing else. The two files are
  byte-identical, so git stores one blob for both paths — committing the copy
  costs a tree entry, not a second bundle per release. CI gates both for
  freshness; `pnpm pack:check` separately proves the copy reaches the npm
  tarball, which is `package.json`'s `files` allowlist and `.npmignore`'s
  doing, not git's.
- `skills/fezo/SKILL.md` is generated from `build/step0.md` and
  `build/invocation.sh` by `build/gen-skill.mjs`, not hand-written. If you
  need to change its wording, edit those sources and regenerate; do not hand
  edit `SKILL.md`.

## License

MIT
