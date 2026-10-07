# Patchkite CLI

Command-line interface for [Patchkite](https://github.com/patchkite/patchkite), self-hosted over-the-air updates for React Native and Flutter.

```bash
npm install -g @patchkite/cli
```

Requires Node.js 22.12 or newer.

## Usage

```bash
patchkite login https://patchkite.example.com
patchkite app add MyApp-Android android react-native
patchkite deployment ls MyApp-Android -k

# React Native: bundle and release to Staging
patchkite release-react MyApp-Android android --description "Fix checkout" -k private.pem

# Flutter (Android): build and release the Dart code
patchkite release-flutter MyApp-Android android --description "Fix checkout" -k private.pem

# Promote to Production for 20% of devices, then finish the rollout
patchkite promote MyApp-Android Staging Production -r 20
patchkite patch MyApp-Android Production -r 100

# Something went wrong?
patchkite rollback MyApp-Android Production
```

Run `patchkite --help` or `patchkite <command> --help` for every command and option, or read the [CLI reference](https://patchkite.github.io/docs/reference/cli/).

### In CI

Create an access key with `patchkite access-key add "CI" --ttl 365d`, then set these environment variables instead of logging in:

| Variable | Value |
|---|---|
| `PATCHKITE_ACCESS_KEY` | The access key |
| `PATCHKITE_SERVER_URL` | Your Patchkite server URL |

See [Releasing from CI](https://patchkite.github.io/docs/guides/ci/).

## Development

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
node dist/index.js --help
```

`src/core` contains a copy of the package hash, semver, and API types from the [server](https://github.com/patchkite/patchkite). The tests in `test/hash.test.ts` check the hash against the server's reference values in `test/fixtures`, which are synced from the server's releases by `scripts/update-fixtures.sh`.

## License

[MIT](LICENSE)
