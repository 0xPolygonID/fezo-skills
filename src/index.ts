// Type-check anchor. Not a consumable entry point: the package declares no
// `main`/`exports`, tsc runs with `noEmit`, and `src/` is excluded from the
// published tarball.
//
// It exists only so tsconfig's `src/**/*.ts` include glob matches at least one
// file — TypeScript fails hard (TS18003) on a glob that matches none, which
// would make `pnpm typecheck` unrunnable until the engine modules land.
// Intentionally zero logic.
export {};
