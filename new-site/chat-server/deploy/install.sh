#!/bin/bash
# Installs / updates the 加密聊天 service on Debian-1-2 (run as root from a checkout; idempotent).
#
#   bash new-site/chat-server/deploy/install.sh
#
# Unlike 事件墙 this service is NOT behind Cloudflare: the page and its scripts must reach the
# browser unchanged, so TLS ends here. Own xrayr-next nodes forward raw TCP (their agent nginx):
#   mirror :8443  --TCP-->  here :8443   TLS with the mirror IP's Let's Encrypt certificate
#   mirror :80    --HTTP->  here :8080   ACME http-01 answers and the mirrors' check-ins
# Open TCP 8443 and 8080 in the instance firewall (Lightsail: Networking -> IPv4 firewall).
# To accept only known mirrors, put ALLOW_FROM=<ip>,<ip> in /etc/end-gfw-chat/env.
#
# No secrets: rooms are opened with keys that never leave the browsers, the proof-of-work key is
# random per start, and the certificates are issued here by acme.sh.
set -euo pipefail
src=$(cd "$(dirname "$0")/../.." && pwd) # the new-site/ tree
app=/opt/end-gfw-chat
export DEBIAN_FRONTEND=noninteractive

need=()
command -v node >/dev/null || need+=(nodejs)
command -v npm >/dev/null || need+=(npm)
command -v curl >/dev/null || need+=(curl)
command -v openssl >/dev/null || need+=(openssl)
# better-sqlite3 builds from source when no prebuilt binary matches (Debian 13 + distro Node)
command -v make >/dev/null || need+=(make)
command -v g++ >/dev/null || need+=(g++)
if [ ${#need[@]} -gt 0 ]; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends "${need[@]}" >/dev/null
fi
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "Node.js 20 or newer is required" >&2; exit 1; }

install -d -m 0750 /etc/end-gfw-chat
[ -f /etc/end-gfw-chat/env ] || printf '# ALLOW_FROM=1.2.3.4,5.6.7.8\n' > /etc/end-gfw-chat/env
# Site admins (the same tokens as 事件墙): review which rooms go into the public list.
# Parameter Store /end-gfw/board/ADMINS ("name:sha256(token)" lines), else 事件墙's copy on this
# machine, else nobody (the list then stays empty).
(umask 077
if python3 -c 'import boto3' 2>/dev/null && python3 -c "import boto3,sys; print(boto3.client('ssm', region_name='us-east-1').get_parameter(Name='/end-gfw/board/ADMINS', WithDecryption=True)['Parameter']['Value'])" > /etc/end-gfw-chat/admins.new 2>/dev/null; then
  mv /etc/end-gfw-chat/admins.new /etc/end-gfw-chat/admins
elif [ -s /etc/end-gfw-board/admins ]; then
  rm -f /etc/end-gfw-chat/admins.new; cp /etc/end-gfw-board/admins /etc/end-gfw-chat/admins
else
  rm -f /etc/end-gfw-chat/admins.new; : > /etc/end-gfw-chat/admins
fi)
id end-gfw-chat >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin end-gfw-chat

# Code: the same relative layout as the repository (the service imports pow.js from board-server
# and serves the QR code library from public/assets/vendor)
install -d -m 0755 "$app" "$app/chat-server" "$app/chat-server/src" "$app/chat-server/public" \
  "$app/board-server/src" "$app/public/assets/vendor"
printf '{ "type": "module", "private": true }\n' > "$app/package.json"
install -m 0644 "$src/chat-server/package.json" "$src/chat-server/package-lock.json" "$app/chat-server/"
install -m 0644 "$src"/chat-server/src/*.js "$app/chat-server/src/"
install -m 0644 "$src"/chat-server/public/* "$app/chat-server/public/"
install -m 0644 "$src/board-server/src/pow.js" "$app/board-server/src/pow.js"
install -m 0644 "$src/public/assets/vendor/qrcode.js" "$app/public/assets/vendor/qrcode.js"
(cd "$app/chat-server" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

# acme.sh for the mirrors' IP certificates (run by the service as end-gfw-chat)
if [ ! -x "$app/acme.sh" ] || [ -n "$(find "$app/acme.sh" -mtime +30 2>/dev/null)" ]; then
  curl -fsSL https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh -o "$app/acme.sh.new"
  install -m 0755 "$app/acme.sh.new" "$app/acme.sh"
  rm -f "$app/acme.sh.new"
fi

install -m 0644 "$src/chat-server/deploy/end-gfw-chat.service" /etc/systemd/system/end-gfw-chat.service
systemctl daemon-reload
systemctl enable end-gfw-chat >/dev/null 2>&1
systemctl restart end-gfw-chat

sleep 2
systemctl is-active end-gfw-chat
curl -fsS http://127.0.0.1:8792/chat/api/health && echo
echo "chat ok. Entries: end-gfw.com/chat (Cloudflare Tunnel end-gfw-chat) and https://<node IP>:8443/chat (xrayr-next chat nodes)"
