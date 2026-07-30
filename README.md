# fezo-skills

`fezo-skills` is an agent skill (`fezo`) backed by a small, dependency-free
TypeScript CLI (`fezoctl`). The skill discovers and calls Fezo/Zug API gateway
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
- bash or zsh, and network access to your Fezo/Zug gateway.
- [pnpm](https://pnpm.io/) — only if you are developing this repository, not
  to use the CLI.

## Installation

There is no published npm package yet — see
["Known gaps"](#known-gaps) below. Until `fezo-skills` is published, install
one of these ways:

- **Use the skill from a checkout of this repository.** Point your agent at
  `skills/fezo/SKILL.md` in a clone of this repo. The skill resolves
  `fezoctl` itself (see the invocation ladder below); you do not need to
  install anything separately.
- **Run the committed bundle directly.** `dist/fezoctl.mjs` is a
  self-contained, deterministic build committed to this repository — clone it
  and run `node dist/fezoctl.mjs <command>`.
- **Build from source.** `pnpm install && pnpm bundle` produces
  `dist/fezoctl.mjs` from `src/cli.ts`.

### The invocation ladder

`SKILL.md`'s "Resolve fezoctl" step (generated from `build/invocation.sh`)
resolves the `fezoctl` executable in a fixed order, and every subsequent
command in that skill session is invoked through the result
(`"${FEZOCTL_ARGV[@]}"`), never as a bare `fezoctl`:

1. `$FEZOCTL`, if it names an executable file.
2. `<skill dir>/scripts/fezoctl.mjs` — the bundle copied in at pack/build
   time — invoked as `node <path>`, not relied on to be executable (a
   `.skill` archive or plain file copy may not preserve the executable bit).
3. `<skill dir>/../../dist/fezoctl.mjs` — this repo's own committed bundle,
   when the skill is used straight out of a checkout — also invoked as
   `node <path>`.
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
If you bump `package.json`'s `version`, you must re-run and commit **both**:

```bash
pnpm bundle      # rebuilds dist/fezoctl.mjs with the new version baked in
pnpm gen-skill   # regenerates skills/fezo/SKILL.md with the new SKILL_VERSION
```

Bumping the version changes `dist/fezoctl.mjs`'s bytes (the version is baked
in via an esbuild `--define`, not read from `package.json` at run time in the
bundled artifact), so CI's bundle-freshness gate will fail until both commands
are re-run and the results committed.

## Quick start

```bash
# From a checkout of this repository:
node dist/fezoctl.mjs --help

# Configure credentials once (see CONFIGURATION.md for the full story):
printf '%s' "$YOUR_FEZO_API_KEY" | node dist/fezoctl.mjs setup --key-stdin --url https://your-gateway.example.com

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
fezoctl catalog [--json]
fezoctl setup --key-stdin [--url <url>] [--storage keychain|dotenv] [--json]
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
| `catalog` | List every backend and method the gateway currently reports. |
| `setup --key-stdin` | Store the gateway URL and API key without ever putting the key in argv or a transcript. Pass `--url` (or have `FEZO_URL` set): `fezoctl` needs both values, so a `setup` that leaves the URL unconfigured prints `configured url: (not configured — pass --url or set FEZO_URL)` and exits 2 rather than reporting a success that no other command can use. |
| `doctor` | Diagnose configuration and connectivity — the first thing to run when something is wrong. See ["`doctor`"](#doctor). |

### Exit codes

From `src/cli.ts`'s `HELP_TEXT` (and matching its `EXIT_OK`/`EXIT_USAGE`/`EXIT_OPERATIONAL` constants):

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Usage error: a bad command/flag, or an unparseable `--args-json`/`--body-json` payload. Rejected while parsing argv, **before** any candidate is selected or called. |
| `2` | Operational failure: credentials not configured, the gateway/catalog could not be reached or read, arguments failed schema validation, or a `call`/`run` that did not end in success (including a `run` refusal, an empty match, or `doctor` finding a hard failure). |

Verified: `--help`/no-args exit `0`; an unknown command, missing `--args-json`,
invalid JSON, or `--max-attempts 0` exit `1`; missing credentials, an
unresolved tool, failed schema validation, and a `run` that gives up or is
refused all exit `2`.

## HTTP binding behavior

`fezoctl` reads the catalog's `http` block for each method and places your
arguments accordingly — in the URL path, the query string, a request header,
or the JSON body — **based on what the catalog says, not on what the HTTP
verb implies.** This is a deliberate fix for a real bug in the existing Zug
MCP server, which assumes GET means "all args in query" and POST means "all
args in body." That assumption breaks down in practice: **a POST can
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
  `Authorization` or any `X-Zug-*` header, even if a manifest names one.
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
and `run` advances to the next preferred candidate for the same capability:

```
$ node dist/fezoctl.mjs run "scrape url" --args-json '{"url":"https://example.com"}'
run "scrape url"
selected: firecrawl_scrape (firecrawl.scrape, POST /scrape, per_call)
  why: exact-method; matched: scrape, url; termScore=4; preferred for "scrape" (position 0)
attempts:
  1. firecrawl_scrape (firecrawl) [retry] billed=false httpStatus=503 — code-less HTTP 503
  2. scrapingbee_scrape (scrapingbee) [success] billed=true httpStatus=200 — 200 response
  billing: every attempt that reached a 2xx response is billed by the provider (billed=true); attempts that failed or were skipped before a request was sent are not billed
billed: true
result (status 200):
{ "markdown": "# Example\ncontent" }
```

Verified give-up example — the same intent and the same candidate list, but
the first attempt returns a gateway code that is in neither classification
set. `run` stops there rather than spending money on `scrapingbee`, because an
unknown code is not evidence that another provider would do better:

```
$ node dist/fezoctl.mjs run "scrape url" --args-json '{"url":"https://example.com"}'
run "scrape url"
selected: firecrawl_scrape (firecrawl.scrape, POST /scrape, per_call)
  why: exact-method; matched: scrape, url; termScore=4; preferred for "scrape" (position 0)
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

## Provider selection

When `run` has more than one compatible candidate, which one it tries first
is **policy, not measurement**: `src/engine/preference.ts`'s
`CAPABILITY_PREFERENCES` is a small, hand-curated ordering per capability
(`scrape`, `serp`, `web-search`) — recorded human judgment about which
provider to prefer, not a measured cost or latency ranking. `run` never falls
back to alphabetical catalog order as a substitute policy.

- A free-text intent is matched against a small keyword table
  (`CAPABILITY_KEYWORDS`) to infer which capability, if any, applies. If a
  capability is inferred, its preference ordering breaks ties among matching
  candidates.
- If **no** capability hint applies (the intent's wording doesn't match any
  known capability phrase) and the matching candidates span **two or more
  backends**, `run` **refuses to auto-pick** rather than silently making
  catalog/alphabetical order the policy. This refusal is overridable with
  `--allow-unhinted-auto-pick`, which promotes **only the top-ranked
  candidate** — there is no fallback to a second candidate under this
  override, because the user only agreed to the one promotion, not to a
  chain of un-hinted backends.
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

Verified refusal and override:

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
   schema validation failed, or `--version` couldn't read its own version):

   ```json
   {"error": {"kind": "...", "message": "..."}}
   ```

   `kind` is a **closed set of seven values** (from `src/engine/render.ts`'s
   `CliErrorKind`, stable — values may be added in the future but never
   renamed or repurposed): `usage`, `credentials-not-configured`,
   `catalog-unavailable`, `tool-not-found`, `invalid-args`, `invalid-body`,
   `version-unavailable`.

2. **A `call`/`run` that reached the engine** — even if the outcome was a
   retry give-up, an abort, or a run refusal — emits its **full attempt-log
   report** instead of an error envelope, because that document carries
   strictly more information (the attempt log and what was billed). Look for
   an `attempts` array and an `outcome`/`result` field, not an `error` key.
   **This includes `call <tool>` where `<tool>` is not in the catalog**: `call`
   synthesizes the one-entry attempt log `run` would have produced rather than
   emitting a `tool-not-found` envelope, so the marker to test is
   `resolved: false`, not `error`. Only `schema <tool>` produces the
   `tool-not-found` envelope (`src/cli.ts`'s `cmdSchema` vs. `cmdCall`).

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

[^help-json]: `fezoctl --help --json` (or `-h` anywhere in argv alongside
    `--json`) prints the **help text** on stdout and exits `0` — help is
    resolved before argv is parsed into a command, and it has no JSON form.
    That output is not parseable JSON, so a script that unconditionally
    `JSON.parse`es stdout must not pass `--help`/`-h`. Every other command,
    including a bare `fezoctl --json` (which is a `usage` error, because
    `--json` is not a command), does emit a JSON document.

## Credentials

See **[CONFIGURATION.md](CONFIGURATION.md)** for the full credential model:
the four-source resolution order, the security reasoning behind
`setup --key-stdin`, macOS Keychain details, `.env` file location and
permissions, the deprecated `ZUG_*` aliases, and **how to rotate a key** —
which differs between the two storage backends, because a second
`setup --key-stdin` on the default `dotenv` storage is refused rather than
overwriting the file.

## `doctor`

Run `fezoctl doctor` first whenever something is wrong. It reports a sequence
of independent checks rather than bailing out at the first failure, so you
can see exactly how far configuration and connectivity got:

| Check | Meaning |
| --- | --- |
| `gateway-url` | Whether `FEZO_URL` resolved from any source, and which one. |
| `api-key` | Whether `FEZO_API_KEY` resolved from any source, and which one. |
| `gateway-connectivity` | Whether the gateway responded at all to a catalog fetch. |
| `auth` | Whether the gateway accepted the API key (distinguished from connectivity by a 401/403 status specifically). |
| `catalog-readable` | Whether the response body actually parsed as a catalog document. |
| `preference-hints` | Whether every backend named in the provider-preference tables is actually present in the live catalog (a `warn`, not a `fail` — a hint naming an absent backend just means that hint currently does nothing). |

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
the API key **masked** (never the raw key), and `preference-hints`' list of
absent backends. Only the first line of that block carries the indent the
renderer adds, so it looks ragged; that is the literal output, not a
transcription slip.

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
pnpm pack:check   # verify the artifact `npm pack` would actually publish
```

- `dist/fezoctl.mjs` is a deterministic, dependency-free, single-file bundle
  of `src/cli.ts` (built with esbuild) and is committed to this repository —
  that is what lets a Git-URL or HEAD install resolve the engine without a
  build step. CI fails if the committed file differs from a fresh
  `pnpm bundle`.
- `skills/fezo/scripts/fezoctl.mjs` is the same bundle, copied in only at
  pack/build time (`pnpm bundle`, or automatically via npm's `prepack`
  lifecycle hook). It is gitignored on purpose; `.npmignore` is what keeps it
  in the published npm tarball despite that (npm never falls back to
  `.gitignore` once `.npmignore` exists) — see `pnpm pack:check`.
- `skills/fezo/SKILL.md` is generated from `build/step0.md` and
  `build/invocation.sh` by `build/gen-skill.mjs`, not hand-written. If you
  need to change its wording, edit those sources and regenerate; do not hand
  edit `SKILL.md`.

## License

MIT
