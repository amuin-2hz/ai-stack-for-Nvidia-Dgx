#!/bin/sh
set -e

install -d -m 0755 /etc/sysconfig /etc/systemd/system /var/lib/amuin-ai-stack
if [ ! -e /etc/sysconfig/amuin-ai-stack ]; then
  printf '%s\n' \
    'AI_STACK_BIND_ADDR=0.0.0.0' \
    'AI_STACK_SERVE_FRONTEND=1' \
    'PORT=8000' \
    'FRONTEND_PORT=8888' \
    '# MODELS_ROOT=/data/models' > /etc/sysconfig/amuin-ai-stack
fi
chmod 0755 '/opt/amuin-ai-stack/resources/server/amuin-ai-stack-server'
ln -sfn '/opt/amuin-ai-stack/resources/server/amuin-ai-stack-server' /usr/bin/amuin-ai-stack-server
install -m 0644 '/opt/amuin-ai-stack/resources/server/amuin-ai-stack.service' /etc/systemd/system/amuin-ai-stack.service
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  systemctl enable --now amuin-ai-stack.service || true
fi
