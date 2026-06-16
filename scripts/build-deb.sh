#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Building API ==="
npm --prefix apps/api run build

echo "=== Building Frontend ==="
npm --prefix apps/frontend run build

echo "=== Building Electron Main ==="
tsc -p apps/main/tsconfig.json

echo "=== Packaging .deb ==="
npx electron-builder --linux deb

echo "=== Done ==="
ls -la dist-electron/*.deb 2>/dev/null || echo "No .deb found (check build output above)"
