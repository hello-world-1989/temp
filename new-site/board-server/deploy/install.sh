#!/bin/bash
# Installs / updates the 事件墙 service on Debian-1-2 (run as root; idempotent).
# The database is PostgreSQL on Debian-1-1 (private IP, TLS; see db-setup.sh).
#
# Secrets come from Parameter Store (us-east-1; the instance role end-gfw-main-ssm reads /end-gfw/*):
#   /end-gfw/board/BOARD_KEY     shared key between the site's Worker and this service
#   /end-gfw/board/ADMINS        "name:sha256(token)" lines (the tokens themselves never reach the server)
#   /end-gfw/board/DATABASE_URL  postgres://end_gfw_board:...@<Debian-1-1 private IP>:5432/end_gfw_board
#   /end-gfw/board/DB_CA         Debian-1-1's PostgreSQL certificate (TLS is pinned to it)
#   /end-gfw/board/TG_BOT_TOKEN  (optional) Telegram review bot token from @BotFather
# Settings: /etc/end-gfw-board/settings (BOARD_HOST=, SITE_URL=, and for the Telegram review
# chat TG_CHAT_ID= and TG_ADMINS="name:telegram user id,..."), written with defaults on first run.
# Caddy: /etc/caddy/Caddyfile imports /etc/caddy/sites/*.caddy; this service adds board.caddy.
set -euo pipefail
src=$(cd "$(dirname "$0")/../.." && pwd) # the new-site/ tree
conf=/etc/end-gfw-board
export DEBIAN_FRONTEND=noninteractive

need=()
command -v node >/dev/null || need+=(nodejs)
command -v npm >/dev/null || need+=(npm)
command -v caddy >/dev/null || need+=(caddy)
python3 -c 'import boto3' 2>/dev/null || need+=(python3-boto3)
if [ ${#need[@]} -gt 0 ]; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends "${need[@]}" >/dev/null
fi

install -d -m 0750 "$conf"
[ -f "$conf/settings" ] || printf 'BOARD_HOST=board-store.end-gfw.com\nSITE_URL=https://board-preview.end-gfw.com\n' > "$conf/settings"
. "$conf/settings"

param() { python3 -c "import boto3,sys; print(boto3.client('ssm', region_name='us-east-1').get_parameter(Name=sys.argv[1], WithDecryption=True)['Parameter']['Value'])" "$1"; }
(umask 077; param /end-gfw/board/BOARD_KEY > "$conf/board-key.new"; mv "$conf/board-key.new" "$conf/board-key")
(umask 077; param /end-gfw/board/ADMINS > "$conf/admins.new"; mv "$conf/admins.new" "$conf/admins")
(umask 077; param /end-gfw/board/DATABASE_URL > "$conf/db-url.new"; mv "$conf/db-url.new" "$conf/db-url")
param /end-gfw/board/DB_CA > "$conf/db-ca"
# Optional: without the parameter the file is empty and the bot stays off
(umask 077; { param /end-gfw/board/TG_BOT_TOKEN 2>/dev/null || true; } > "$conf/tg-bot-token.new"; mv "$conf/tg-bot-token.new" "$conf/tg-bot-token")
(umask 077; printf 'SITE_URL=%s\nTG_CHAT_ID=%s\nTG_ADMINS=%s\n' "$SITE_URL" "${TG_CHAT_ID:-}" "${TG_ADMINS:-}" > "$conf/env")

id end-gfw-board >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin end-gfw-board

# Code
app=/opt/end-gfw-board
install -d -m 0755 "$app" "$app/board-server" "$app/board-server/src" "$app/public" "$app/public/assets"
printf '{ "type": "module", "private": true }\n' > "$app/package.json" # share-meta.js is an ES module
install -m 0644 "$src/public/assets/share-meta.js" "$app/public/assets/share-meta.js"
install -m 0644 "$src/board-server/package.json" "$src/board-server/package-lock.json" "$src/board-server/schema.sql" "$app/board-server/"
install -m 0644 "$src"/board-server/src/*.js "$app/board-server/src/"
(cd "$app/board-server" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

# Service
install -m 0644 "$src/board-server/deploy/end-gfw-board.service" /etc/systemd/system/end-gfw-board.service
systemctl daemon-reload
systemctl enable end-gfw-board >/dev/null 2>&1
systemctl restart end-gfw-board

# Caddy: listens on 127.0.0.1 only; the public side is the Cloudflare Tunnel below.
install -d -m 0755 /etc/caddy/sites
install -m 0644 "$src/board-server/deploy/board.caddy" /etc/caddy/sites/board.caddy
# Main Caddyfile: each service adds its own site file in /etc/caddy/sites/ (all local, plain HTTP)
printf '{\n\tauto_https off\n}\n\n# Each service adds its own site file in /etc/caddy/sites/ (bound to 127.0.0.1;\n# published through Cloudflare Tunnels, never on a public port)\nimport /etc/caddy/sites/*.caddy\n' > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

# Public side: Cloudflare Tunnel (outbound only; no inbound port, server IP not in DNS)
bash "$src/tunnel/tunnel.sh" end-gfw-board "$BOARD_HOST" http://127.0.0.1:8081

sleep 3
systemctl is-active end-gfw-board caddy
curl -fsS -H "x-board-key: $(cat "$conf/board-key")" http://127.0.0.1:8081/api/board/meta >/dev/null && echo "board api ok"
