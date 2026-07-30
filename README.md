# fezo-skills

An agent skill (`fezo`) backed by a TypeScript CLI (`fezoctl`) that discovers
and calls Fezo/Zug API gateway tools from the live catalog (`GET
/v1/catalog`) rather than a static, hand-maintained method roster.

This repository is under active construction. See the implementation plan for
current status.

## Development

Requires Node >=22 and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm build   # type-check
pnpm test    # run the test suite
```

## License

MIT
