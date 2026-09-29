#!/bin/bash
# end-gfw 加密聊天 镜像转发脚本（TCP 透传）
#
# 让这台服务器的 https://<本机IP>:8443/chat 打开加密聊天。本机只转发加密后的字节，
# 看不到也改不了聊天页面和消息：TLS 证书和私钥都在聊天源站上。
# 已经用 mirror.sh 搭了网站镜像的服务器可以直接加装，互不影响（网站仍在 443 端口）。
#
# 用法（root 执行，Debian 11+/Ubuntu 20.04+，放行 TCP 80 和 8443）：
#   bash chat-relay.sh <源站IP>     # 安装或更新；源站 IP 请向网站管理员索取
#   bash chat-relay.sh status       # 查看状态
#   bash chat-relay.sh uninstall    # 卸载
#
# 做了什么：
#   - nginx stream：本机 8443 端口原样转发到源站 8443（附带 PROXY 协议头，只用于选证书）
#   - 本机 80 端口的 /.well-known/acme-challenge/ 找不到的请求转给源站 8080，
#     这样源站能为本机 IP 申请 Let's Encrypt 证书；网站镜像自己的证书照常签发
#   - 每 10 分钟向源站报到一次：IP 变了，源站会自动给新 IP 签证书
#   - 不记录访问日志
set -euo pipefail

DIR=/opt/end-gfw-chat-relay
SELF="$DIR/chat-relay.sh"
STREAM=/etc/nginx/end-gfw-chat-relay.conf
OWN80=/etc/nginx/conf.d/end-gfw-chat-relay.conf
MIRROR80=/etc/nginx/conf.d/end-gfw-mirror.conf # mirror.sh 的网站镜像配置
CRON=/etc/cron.d/end-gfw-chat-relay
INCLUDE="include $STREAM;"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m%s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 运行（sudo bash chat-relay.sh <源站IP>）"
grep -q 'end-gfw 加密聊天 镜像转发脚本' "$0" 2>/dev/null || die "请先下载成文件再运行"

public_ip() {
  local ip
  for u in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
    ip=$(curl -4 -fsS --max-time 8 "$u" 2>/dev/null | tr -d ' \n\r') || true
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "$ip"; return; fi
  done
  return 1
}

load_state() { [ -f "$DIR/state" ] && . "$DIR/state" || true; }

write_stream() {
  local v6=""
  [ -s /proc/net/if_inet6 ] && v6="listen [::]:8443;"
  cat >"$STREAM" <<EOF
# 由 end-gfw 加密聊天转发脚本生成，重新运行脚本会覆盖
# 原样转发 TCP：TLS 在源站结束，本机看不到内容
stream {
  server {
    listen 8443;
    $v6
    proxy_pass $ORIGIN:8443;
    proxy_protocol on;
    proxy_connect_timeout 10s;
    proxy_timeout 1h;
  }
}
EOF
  # stream {} 必须在 nginx.conf 的最外层
  grep -qF "$INCLUDE" /etc/nginx/nginx.conf || printf '\n%s\n' "$INCLUDE" >>/etc/nginx/nginx.conf
}

acme_location() {
  cat <<EOF
  location @end_gfw_chat_acme {
    proxy_pass http://$ORIGIN:8080;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Real-IP "";
  }
EOF
}

# 80 端口：有网站镜像就在它的配置里加一条回退，没有就自己监听
write_80() {
  if [ -f "$MIRROR80" ]; then
    rm -f "$OWN80"
    if ! grep -q '@end_gfw_chat_acme' "$MIRROR80"; then
      # mirror.sh：location /.well-known/acme-challenge/ { root .../webroot; }
      local loc
      loc=$(acme_location)
      LOC="$loc" perl -0pi -e 's#(location /\.well-known/acme-challenge/ \{ root ([^;]+);) \}#$1 try_files \$uri \@end_gfw_chat_acme; }\n$ENV{LOC}#' "$MIRROR80"
      grep -q '@end_gfw_chat_acme' "$MIRROR80" || say "注意：没能修改 $MIRROR80，源站可能签不了证书"
    else
      # 源站 IP 变了：更新回退地址
      sed -i -E "s#proxy_pass http://[0-9.]+:8080;#proxy_pass http://$ORIGIN:8080;#" "$MIRROR80"
    fi
  else
    cat >"$OWN80" <<EOF
# 由 end-gfw 加密聊天转发脚本生成（本机没有网站镜像时使用）
server {
  listen 80;
  access_log off;
  server_tokens off;
  location /.well-known/acme-challenge/ { try_files /nonexistent @end_gfw_chat_acme; }
$(acme_location)
  location / { return 302 https://\$host:8443/chat; }
}
EOF
    rm -f /etc/nginx/sites-enabled/default
  fi
}

reload() {
  nginx -t -q || die "nginx 配置检查失败"
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
}

hello() {
  curl -4 -fsS --max-time 15 "http://$ORIGIN:8080/.well-known/end-gfw-chat/hello" 2>/dev/null || echo '{"error":"连不上源站 8080 端口"}'
}

save_state() {
  mkdir -p "$DIR"
  printf 'ORIGIN=%s\n' "$ORIGIN" >"$DIR/state"
}

conf_sum() { { cat "$STREAM" "$MIRROR80" "$OWN80" 2>/dev/null || true; } | md5sum; }

# 定时任务：mirror.sh 在 IP 变化时会重写自己的配置，这里补回回退规则，并向源站报到
apply() {
  load_state
  [ -n "${ORIGIN:-}" ] || exit 0
  local before after
  before=$(conf_sum)
  write_stream
  write_80
  after=$(conf_sum)
  [ "$before" = "$after" ] || reload
  hello >/dev/null
}

status() {
  load_state
  [ -n "${ORIGIN:-}" ] || die "没有安装"
  local ip
  ip=$(public_ip || echo '<本机IP>')
  echo "聊天地址：https://$ip:8443/chat"
  echo "源站：$ORIGIN"
  systemctl is-active nginx >/dev/null && echo "nginx：运行中" || echo "nginx：未运行"
  echo "源站报到结果：$(hello)"
  echo '（"cert":"ok" 表示证书已签好；"pending" 表示正在签，等几分钟）'
}

uninstall() {
  rm -f "$STREAM" "$OWN80" "$CRON"
  sed -i "\\#^$INCLUDE\$#d" /etc/nginx/nginx.conf
  if [ -f "$MIRROR80" ]; then
    perl -0pi -e 's# try_files \$uri \@end_gfw_chat_acme;##; s#\n  location \@end_gfw_chat_acme \{.*?\n  \}##s' "$MIRROR80"
  fi
  nginx -t -q 2>/dev/null && systemctl reload nginx || true
  rm -rf "$DIR"
  say "已卸载"
}

install() {
  ORIGIN=${1:-}
  [[ "$ORIGIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "请提供源站的 IPv4 地址：bash chat-relay.sh <源站IP>"

  say "安装 nginx（含 stream 模块）、curl、cron"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx libnginx-mod-stream curl cron perl >/dev/null

  local busy
  busy=$(ss -ltnpH '( sport = :8443 )' 2>/dev/null | grep -v nginx || true)
  [ -z "$busy" ] || die "8443 端口被其他程序占用：
$busy"
  if [ ! -f "$MIRROR80" ]; then
    busy=$(ss -ltnpH '( sport = :80 )' 2>/dev/null | grep -v nginx || true)
    [ -z "$busy" ] || die "80 端口被其他程序占用：
$busy"
  fi

  mkdir -p "$DIR"
  [ "$(readlink -f "$0")" = "$SELF" ] || cp -f "$0" "$SELF"
  chmod 700 "$SELF"
  save_state
  write_stream
  write_80
  systemctl enable nginx >/dev/null 2>&1 || true
  nginx -t -q || die "nginx 配置检查失败"
  systemctl restart nginx

  if command -v ufw >/dev/null && ufw status | grep -q active; then
    ufw allow 80/tcp >/dev/null; ufw allow 8443/tcp >/dev/null
  fi

  echo "*/10 * * * * root bash $SELF apply >/dev/null 2>&1" >"$CRON"
  chmod 644 "$CRON"

  say "向源站报到：$(hello)"
  local ip
  ip=$(public_ip || echo '<本机IP>')
  echo
  say "完成！聊天地址：https://$ip:8443/chat"
  echo "    源站给本机 IP 签证书需要一两分钟；之前打开会连不上，稍等再试"
  echo "    查看状态：bash $SELF status    卸载：bash $SELF uninstall"
}

case "${1:-}" in
  apply) apply ;;
  status) status ;;
  uninstall) uninstall ;;
  -h|--help|help|'') sed -n '2,19p' "$0" ;;
  *) install "$1" ;;
esac
