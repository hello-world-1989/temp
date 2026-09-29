#!/bin/bash
# Installs / updates the share store on Debian-1-1 (run as root, from this directory).
# The key is read from STORE_KEY in the environment on first install; later runs keep it.
set -euo pipefail
cd "$(dirname "$0")"
command -v caddy >/dev/null || { apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy; }
install -d -m 0755 /opt/end-gfw-share
install -m 0644 store.py /opt/end-gfw-share/store.py
install -d -m 0700 /etc/end-gfw-share
if [ ! -s /etc/end-gfw-share/store-key ]; then
  [ -n "${STORE_KEY:-}" ] || { echo "STORE_KEY missing"; exit 1; }
  (umask 077; printf '%s' "$STORE_KEY" > /etc/end-gfw-share/store-key)
fi
install -m 0644 end-gfw-share.service /etc/systemd/system/end-gfw-share.service
install -m 0644 Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl daemon-reload
systemctl enable --now end-gfw-share
systemctl restart end-gfw-share
systemctl enable caddy
systemctl restart caddy   # admin off: reload is not possible
# Public side: Cloudflare Tunnel (outbound only; no inbound port, server IP not in DNS)
bash ../tunnel/tunnel.sh end-gfw-share share-store.end-gfw.com http://127.0.0.1:8081
sleep 2
systemctl is-active end-gfw-share caddy
