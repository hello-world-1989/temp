#!/bin/bash
# Downloads the board service files of one commit of hello-world-1989/temp and runs
# install.sh from them. Usage (as root): bash fetch.sh <commit>
set -euo pipefail
sha=${1:?commit}
dir=/opt/end-gfw-board-src
base="https://raw.githubusercontent.com/hello-world-1989/temp/$sha/new-site"
rm -rf "$dir"
for f in board-server/package.json board-server/package-lock.json board-server/schema.sql \
  board-server/src/server.js board-server/src/app.js board-server/src/config.js board-server/src/pow.js \
  board-server/src/publish.js board-server/src/images.js board-server/src/admin-token.js board-server/src/telegram.js \
  board-server/deploy/install.sh board-server/deploy/end-gfw-board.service board-server/deploy/board.caddy \
  tunnel/tunnel.sh tunnel/cf_tunnel.py \
  public/assets/share-meta.js; do
  mkdir -p "$dir/$(dirname "$f")"
  curl -fsSL --retry 3 "$base/$f" -o "$dir/$f"
done
bash "$dir/board-server/deploy/install.sh"
