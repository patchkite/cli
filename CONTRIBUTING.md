# Contributing to the Patchkite CLI

Thanks for helping! Open an issue first for larger changes.

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

- Keep pull requests focused, and add tests for behavior changes.
- Command names and options follow the CodePush CLI where possible; avoid breaking existing flags.
- `src/core/hash.ts` must produce exactly the same package hash as the server. Don't change it without a matching change in [patchkite/patchkite](https://github.com/patchkite/patchkite); `test/hash.test.ts` checks it against `test/fixtures`.

## Releases

Maintainers bump `version` in `package.json` and `.version(...)` in `src/index.ts` (a test checks they match), add a CHANGELOG entry, and push a `vX.Y.Z` tag. CI bundles the CLI into a single file (`pnpm pack:release`) and publishes it to npm with provenance.
