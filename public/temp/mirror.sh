#!/bin/bash
# end-gfw.com 镜像站一键脚本
#
# 下载：curl -fsSLO https://end-gfw.com/mirror.sh
#  （打不开时：curl -fsSLO https://raw.githubusercontent.com/hello-world-1989/temp/main/public/temp/mirror.sh）
#
# 用法（root 执行，Debian 11+/Ubuntu 20.04+，需要公网 IPv4，并放行 TCP 80、443）：
#   bash mirror.sh              # 用服务器 IP 访问：https://<IP>/（Let's Encrypt IP 证书，自动续签）
#   bash mirror.sh 你的域名      # 用自己的域名访问（域名 A 记录先指向本机，不要开 Cloudflare 代理）
#   bash mirror.sh status       # 查看状态
#   bash mirror.sh uninstall    # 卸载
#
# 可选环境变量：
#   UPSTREAM=https://end-gfw.com         镜像的网站
#   MATRIX_UPSTREAM=https://matrix.end-gfw.com   Matrix 聊天（设为空则不转发）
#
# 隐私：本机不记录访问日志，不把访客 IP 传给源站。
set -euo pipefail

UPSTREAM="${UPSTREAM:-https://end-gfw.com}"
MATRIX_UPSTREAM="${MATRIX_UPSTREAM-https://matrix.end-gfw.com}"
DIR=/opt/end-gfw-mirror
CONF=/etc/nginx/conf.d/end-gfw-mirror.conf
CRON=/etc/cron.d/end-gfw-mirror
SELF="$DIR/mirror.sh"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m%s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 运行（sudo bash mirror.sh）"
# 定时任务要用脚本自己，所以必须先下载成文件再运行（不能 curl | bash）
grep -q 'end-gfw.com 镜像站一键脚本' "$0" 2>/dev/null || die "请先下载成文件再运行：curl -fsSLO https://end-gfw.com/mirror.sh && bash mirror.sh"

public_ip() {
  local ip
  for u in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
    ip=$(curl -4 -fsS --max-time 8 "$u" 2>/dev/null | tr -d ' \n\r') || true
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "$ip"; return; fi
  done
  return 1
}

load_state() { [ -f "$DIR/state" ] && . "$DIR/state" || true; }

write_nginx() {
  local name=$1 host
  host=$(echo "$UPSTREAM" | sed -E 's#^https?://##; s#/.*$##')
  local proxy="
      proxy_pass \$xn_up;
      proxy_set_header Host $host;
      proxy_ssl_server_name on;
      proxy_ssl_name $host;
      proxy_set_header X-Forwarded-For \"\";
      proxy_set_header X-Real-IP \"\";
      proxy_set_header Forwarded \"\";"
  local matrix=""
  if [ -n "$MATRIX_UPSTREAM" ]; then
    local mhost
    mhost=$(echo "$MATRIX_UPSTREAM" | sed -E 's#^https?://##; s#/.*$##')
    for p in /_matrix/ /_synapse/client/; do
      matrix+="
    location $p {
      set \$xn_up $MATRIX_UPSTREAM;
      proxy_pass \$xn_up;
      proxy_set_header Host $mhost;
      proxy_ssl_server_name on;
      proxy_ssl_name $mhost;
      proxy_set_header X-Forwarded-For \"\";
      proxy_set_header X-Real-IP \"\";
      proxy_set_header Forwarded \"\";
      proxy_buffering off;
    }"
    done
  fi
  # 没有 IPv6 的机器不能监听 [::]
  local v6_80="" v6_443=""
  if [ -s /proc/net/if_inet6 ]; then
    v6_80="listen [::]:80 default_server;"
    v6_443="listen [::]:443 ssl http2 default_server;"
  fi
  cat >"$CONF" <<EOF
# 由 end-gfw 镜像脚本生成，重新运行脚本会覆盖
limit_req_zone \$binary_remote_addr zone=xn_share_up:1m rate=10r/m;
limit_req_zone \$binary_remote_addr zone=xn_share_rd:1m rate=60r/m;

server {
  listen 80 default_server;
  $v6_80
  access_log off;
  location /.well-known/acme-challenge/ { root $DIR/webroot; }
  location / { return 301 https://\$host\$request_uri; }
}

server {
  listen 443 ssl http2 default_server;
  $v6_443
  server_name $name;
  access_log off;
  server_tokens off;
  ssl_certificate $DIR/cert/fullchain.pem;
  ssl_certificate_key $DIR/cert/key.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:xnssl:10m;
  resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;
  resolver_timeout 5s;
  client_max_body_size 64m;
  proxy_http_version 1.1;
  proxy_read_timeout 120s;
  limit_req_status 429;
  gzip on;
  gzip_proxied any;
  gzip_types text/css application/javascript application/json text/plain image/svg+xml;
$matrix

  location = /api/share {
    set \$xn_up $UPSTREAM;$proxy
    limit_req zone=xn_share_up burst=5 nodelay;
    proxy_request_buffering off;
  }
  location ^~ /api/share/ {
    set \$xn_up $UPSTREAM;$proxy
    limit_req zone=xn_share_rd burst=30 nodelay;
    proxy_buffering off;
  }
  location / {
    set \$xn_up $UPSTREAM;$proxy
    proxy_set_header Accept-Encoding "";
    sub_filter 'https://$host' '';
    sub_filter '//$host' '';
    sub_filter_once off;
    sub_filter_types text/css application/javascript application/json;
    proxy_redirect https://$host/ /;
    proxy_cookie_domain $host \$host;
  }
}
EOF
}

# 自签证书占位，保证 nginx 能先启动（真正的证书签好后替换）
placeholder_cert() {
  local name=$1 san
  [ -s "$DIR/cert/fullchain.pem" ] && return
  if [[ "$name" =~ ^[0-9.]+$ ]]; then san="IP:$name"; else san="DNS:$name"; fi
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 \
    -subj "/CN=$name" -addext "subjectAltName=$san" \
    -keyout "$DIR/cert/key.pem" -out "$DIR/cert/fullchain.pem" 2>/dev/null
}

# 证书是否由 CA 签发、覆盖 name、剩余时间超过 $2 秒
cert_ok() {
  local name=$1 secs=$2 f="$DIR/cert/fullchain.pem"
  [ -s "$f" ] || return 1
  local subj iss
  subj=$(openssl x509 -in "$f" -noout -subject 2>/dev/null)
  iss=$(openssl x509 -in "$f" -noout -issuer 2>/dev/null)
  [ "${subj#subject=}" != "${iss#issuer=}" ] || return 1
  openssl x509 -in "$f" -noout -checkend "$secs" >/dev/null 2>&1 || return 1
  openssl x509 -in "$f" -noout -ext subjectAltName 2>/dev/null | grep -Eq "(IP Address|DNS):$name(,|\$| )"
}

issue_cert() {
  local name=$1 extra=()
  local acme=("$DIR/acme/acme.sh" --home "$DIR/acme" --server letsencrypt)
  if [[ "$name" =~ ^[0-9.]+$ ]]; then
    # IP 证书只有 6 天有效期（Let's Encrypt shortlived），剩余不到 2 天就重签
    cert_ok "$name" 172800 && return 0
    extra=(--cert-profile shortlived --days 3)
  else
    cert_ok "$name" 2592000 && return 0
  fi
  say "申请 Let's Encrypt 证书：$name"
  "${acme[@]}" --issue --force -d "$name" --webroot "$DIR/webroot" "${extra[@]}" || return 1
  "${acme[@]}" --install-cert -d "$name" \
    --key-file "$DIR/cert/key.pem" --fullchain-file "$DIR/cert/fullchain.pem" \
    --reloadcmd "systemctl reload nginx"
}

# 定时任务：IP 变了就换新 IP 的证书；证书快过期就续签
renew() {
  load_state
  [ -n "${NAME:-}" ] || exit 0
  if [ "${MODE:-ip}" = ip ]; then
    local ip
    ip=$(public_ip) || exit 0
    if [ "$ip" != "$NAME" ]; then
      say "IP 已变化：$NAME → $ip"
      NAME=$ip
      save_state
      rm -f "$DIR/cert/fullchain.pem" "$DIR/cert/key.pem"
      placeholder_cert "$NAME"
      write_nginx "$NAME"
      nginx -t -q && systemctl reload nginx
    fi
  fi
  issue_cert "$NAME" || true
}

save_state() {
  cat >"$DIR/state" <<EOF
MODE=$MODE
NAME=$NAME
UPSTREAM=$UPSTREAM
MATRIX_UPSTREAM=$MATRIX_UPSTREAM
EOF
}

status() {
  load_state
  [ -n "${NAME:-}" ] || die "没有安装"
  echo "地址：https://$NAME/"
  echo "源站：$UPSTREAM"
  systemctl is-active nginx >/dev/null && echo "nginx：运行中" || echo "nginx：未运行"
  if cert_ok "$NAME" 0; then
    echo "证书：$(openssl x509 -in "$DIR/cert/fullchain.pem" -noout -enddate | cut -d= -f2) 到期"
  else
    echo "证书：还没有签好（占位证书），等几分钟或运行 bash $SELF renew"
  fi
}

uninstall() {
  rm -f "$CONF" "$CRON"
  nginx -t -q 2>/dev/null && systemctl reload nginx || true
  rm -rf "$DIR"
  say "已卸载（nginx 本身保留，不需要可 apt-get remove nginx）"
}

install() {
  local arg=${1:-}
  if [ -n "$arg" ]; then MODE=domain; NAME=$arg; else MODE=ip; fi

  say "安装 nginx、curl、openssl、cron"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx curl openssl ca-certificates cron >/dev/null

  # 检查 80/443 有没有被别的程序占用
  local busy
  busy=$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v nginx || true)
  [ -z "$busy" ] || die "80 或 443 端口被其他程序占用：
$busy"

  if [ "$MODE" = ip ]; then
    NAME=$(public_ip) || die "获取不到本机公网 IPv4"
  else
    local resolved
    resolved=$(getent ahostsv4 "$NAME" | awk 'NR==1{print $1}')
    local ip; ip=$(public_ip || true)
    [ -n "$resolved" ] || die "域名 $NAME 解析不到，请先把 A 记录指向本机"
    [ "$resolved" = "$ip" ] || say "注意：$NAME 解析到 $resolved，本机 IP 是 $ip（开了 CDN 代理会导致签证书失败）"
  fi

  mkdir -p "$DIR/cert" "$DIR/webroot/.well-known/acme-challenge" "$DIR/acme"
  chmod 755 "$DIR" "$DIR/webroot" "$DIR/webroot/.well-known" "$DIR/webroot/.well-known/acme-challenge"
  chmod 700 "$DIR/cert"
  [ "$(readlink -f "$0")" = "$SELF" ] || cp -f "$0" "$SELF"
  chmod 700 "$SELF"
  save_state

  if [ ! -x "$DIR/acme/acme.sh" ]; then
    say "下载 acme.sh"
    curl -fsSL https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh -o "$DIR/acme/acme.sh"
    chmod 700 "$DIR/acme/acme.sh"
  fi

  # 去掉系统自带的默认站点（它也占 80 端口的 default_server）
  rm -f /etc/nginx/sites-enabled/default

  placeholder_cert "$NAME"
  write_nginx "$NAME"
  nginx -t -q || die "nginx 配置检查失败"
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl restart nginx

  if command -v ufw >/dev/null && ufw status | grep -q active; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  fi

  echo "*/30 * * * * root bash $SELF renew >/dev/null 2>&1" >"$CRON"
  chmod 644 "$CRON"

  if issue_cert "$NAME"; then
    systemctl reload nginx
    say "证书已签发"
  else
    say "证书这次没签成功（多半是云服务商防火墙没放行 80 端口），放行后会每 30 分钟自动重试"
  fi

  echo
  say "完成！镜像地址：https://$NAME/"
  [ "$MODE" = ip ] && echo "    IP 变了会自动换新证书，新地址就是 https://<新IP>/"
  echo "    查看状态：bash $SELF status    卸载：bash $SELF uninstall"
}

case "${1:-}" in
  renew) renew ;;
  status) status ;;
  uninstall) uninstall ;;
  -h|--help|help) sed -n '2,18p' "$0" ;;
  *) install "${1:-}" ;;
esac
