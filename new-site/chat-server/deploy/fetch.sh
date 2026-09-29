#!/bin/bash
# Downloads the chat service files of one commit of hello-world-1989/temp and runs
# install.sh from them. Usage (as root): bash fetch.sh <commit>
set -euo pipefail
sha=${1:?commit}
dir=/opt/end-gfw-chat-src
base="https://raw.githubusercontent.com/hello-world-1989/temp/$sha/new-site"
rm -rf "$dir"
for f in chat-server/package.json chat-server/package-lock.json \
  chat-server/src/server.js chat-server/src/app.js chat-server/src/config.js chat-server/src/store.js \
  chat-server/src/edge.js chat-server/src/certs.js \
  chat-server/public/chat.html chat-server/public/chat.css chat-server/public/chat.js chat-server/public/chat-crypto.js \
  chat-server/deploy/install.sh chat-server/deploy/end-gfw-chat.service \
  board-server/src/pow.js public/assets/vendor/qrcode.js; do
  mkdir -p "$dir/$(dirname "$f")"
  curl -fsSL --retry 3 "$base/$f" -o "$dir/$f"
done
bash "$dir/chat-server/deploy/install.sh"
