#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

rm -rf dist
./node_modules/.bin/tsc

chmod +x dist/cli/entry.js
chmod +x dist/hook/entry.js

echo "✓ built → dist/"
