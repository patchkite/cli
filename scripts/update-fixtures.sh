#!/bin/sh
# Downloads the reference fixtures from a patchkite/patchkite release into test/fixtures.
#   scripts/update-fixtures.sh          → latest release
#   scripts/update-fixtures.sh v1.2.0   → a specific release
set -eu
cd "$(dirname "$0")/.."
TAG=${1:-$(curl -fsSL https://api.github.com/repos/patchkite/patchkite/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')}
URL="https://github.com/patchkite/patchkite/releases/download/$TAG/fixtures-$TAG.tar.gz"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" | tar -xz -C "$TMP"
rm -rf test/fixtures && mkdir -p test/fixtures && cp -R "$TMP"/. test/fixtures/
echo "$TAG" > test/fixtures/FIXTURES_VERSION
echo "Fixtures updated to $TAG"
