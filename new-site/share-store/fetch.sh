#!/bin/bash
# Downloads the share store files of one commit of hello-world-1989/temp and runs install.sh.
# Usage (as root, on Debian-1-1): bash fetch.sh <commit>
set -euo pipefail
sha=${1:?commit}
dir=/opt/end-gfw-share-src
base="https://raw.githubusercontent.com/hello-world-1989/temp/$sha/new-site"
rm -rf "$dir"
for f in share-store/store.py share-store/Caddyfile share-store/end-gfw-share.service share-store/install.sh \
  tunnel/tunnel.sh tunnel/cf_tunnel.py; do
  mkdir -p "$dir/$(dirname "$f")"
  curl -fsSL --retry 3 "$base/$f" -o "$dir/$f"
done
bash "$dir/share-store/install.sh"
