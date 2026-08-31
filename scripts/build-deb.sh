#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Building app ==="
npm run build

ELECTRON_VERSION="$(node -p 'require("./node_modules/electron/package.json").version')"
TARGET_ARCH="$(node -p 'process.arch')"
echo "=== Rebuilding native API modules for Electron ${ELECTRON_VERSION} ${TARGET_ARCH} ==="
npm --prefix apps/api rebuild better-sqlite3 \
  --runtime=electron \
  --target="$ELECTRON_VERSION" \
  --arch="$TARGET_ARCH" \
  --dist-url=https://electronjs.org/headers

echo "=== Packaging .deb ==="
npm run pack

echo "=== Building standalone release bundle ==="
node scripts/build-release-bundle.js

echo "=== Done ==="
find dist-release -maxdepth 2 -type f -name "*.deb" -print
