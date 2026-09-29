#!/bin/bash
# Publishes a local service through a Cloudflare Tunnel (outbound-only: the server needs no
# inbound port and its IP is not in DNS). Run as root; idempotent.
# Usage: bash tunnel.sh <tunnel name> <hostname> <local service URL>
#   e.g. bash tunnel.sh end-gfw-board board-store.end-gfw.com http://127.0.0.1:8081
set -euo pipefail
name=${1:?tunnel name}; host=${2:?hostname}; service=${3:?service url}
here=$(cd "$(dirname "$0")" && pwd)
export DEBIAN_FRONTEND=noninteractive

python3 -c 'import boto3' 2>/dev/null || { apt-get update -qq; apt-get install -y -qq --no-install-recommends python3-boto3 >/dev/null; }
if ! command -v cloudflared >/dev/null; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq
  apt-get install -y -qq cloudflared >/dev/null
fi

python3 "$here/cf_tunnel.py" "$name" "$host" "$service" "/etc/cloudflared/$name.env"

cat > "/etc/systemd/system/cloudflared-$name.service" <<EOF
[Unit]
Description=Cloudflare Tunnel $name ($host)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/cloudflared/$name.env
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel --metrics 127.0.0.1:0 run
Restart=always
RestartSec=5
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "cloudflared-$name" >/dev/null 2>&1
systemctl restart "cloudflared-$name"
sleep 5
systemctl is-active "cloudflared-$name"
