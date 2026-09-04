#!/bin/sh
set -e

if [ "${1:-0}" -eq 0 ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now amuin-ai-stack.service || true
  fi
  rm -f /usr/bin/amuin-ai-stack-server /etc/systemd/system/amuin-ai-stack.service
fi
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || true; fi
