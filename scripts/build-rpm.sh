#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET_ARCH="${TARGET_ARCH:-x64}"
HOST_ARCH="$(uname -m)"
if [[ "$TARGET_ARCH" != "x64" || "$HOST_ARCH" != "x86_64" ]]; then
  echo "RPM release requires an x86_64 build host and TARGET_ARCH=x64 (host: $HOST_ARCH)" >&2
  exit 2
fi

echo "=== Building app ==="
npm run build

ELECTRON_VERSION="$(node -p 'require("./node_modules/electron/package.json").version')"
echo "=== Rebuilding native API modules for Electron ${ELECTRON_VERSION} x64 ==="
npm --prefix apps/api rebuild better-sqlite3 \
  --runtime=electron \
  --target="$ELECTRON_VERSION" \
  --arch=x64 \
  --dist-url=https://electronjs.org/headers
echo "=== Packaging x86_64 RPM ==="
RPM_MAJOR=""
if command -v rpmbuild >/dev/null 2>&1; then
  RPM_MAJOR="$(rpmbuild --version | awk '{ print $NF }' | cut -d. -f1)"
fi

if [[ "$RPM_MAJOR" =~ ^[0-9]+$ ]] && (( RPM_MAJOR < 6 )); then
  npx electron-builder --linux rpm --x64 --config.productName=amuin-ai-stack
elif command -v docker >/dev/null 2>&1; then
  echo "=== Using Debian Bookworm RPM 4.18 builder (host rpmbuild ${RPM_MAJOR:-missing}) ==="
  mkdir -p .build-tools/electron-cache .build-tools/electron-builder-cache
  HOST_UID="$(id -u)"
  HOST_GID="$(id -g)"
  docker run --rm \
    -e ELECTRON_CACHE=/work/.build-tools/electron-cache \
    -e ELECTRON_BUILDER_CACHE=/work/.build-tools/electron-builder-cache \
    -e HOST_UID="$HOST_UID" \
    -e HOST_GID="$HOST_GID" \
    -v "$PWD:/work" \
    -w /work \
    debian:bookworm-slim \
    bash -lc '
      apt-get update >/dev/null
      apt-get install -y --no-install-recommends rpm ca-certificates nodejs >/dev/null
      node node_modules/electron-builder/out/cli/cli.js --linux rpm --x64 --config.productName=amuin-ai-stack
      status=$?
      chown -R "$HOST_UID:$HOST_GID" dist-electron apps/api/node_modules .build-tools
      exit "$status"
    '
else
  echo "RPM packaging requires rpmbuild 4/5 or Docker (rpmbuild ${RPM_MAJOR:-missing} detected)" >&2
  exit 3
fi

echo "=== Done ==="
find dist-electron -maxdepth 1 -type f -name "*.rpm" -print
