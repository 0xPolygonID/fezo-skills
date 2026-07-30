# fezo-skills

An agent skill (`fezo`) backed by a TypeScript CLI (`fezoctl`) that discovers
and calls Fezo/Zug API gateway tools from the live catalog (`GET
/v1/catalog`) rather than a static, hand-maintained method roster.

See [`skills/fezo/SKILL.md`](skills/fezo/SKILL.md) for the skill itself.

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

## Packaging

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
  `build/invocation.sh` by `build/gen-skill.mjs`, not hand-written.

## License

MIT
