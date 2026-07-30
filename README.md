# fezo-skills

An agent skill (`fezo`) backed by a TypeScript CLI (`fezoctl`) that discovers
and calls Fezo/Zug API gateway tools from the live catalog (`GET
/v1/catalog`) rather than a static, hand-maintained method roster.

This repository is under active construction: only the build and tooling
scaffolding is in place so far. The engine, the CLI, and the `fezo` skill
itself are not implemented yet.

## Development

Requires Node >=22.12 and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm typecheck   # or `pnpm build` — same command; tsc runs with noEmit
pnpm test        # run the test suite
```

## License

MIT
