#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Building app ==="
npm run build

echo "=== Packaging .deb ==="
npm run pack

echo "=== Done ==="
find dist-electron -maxdepth 1 -type f -name "*.deb" -print
