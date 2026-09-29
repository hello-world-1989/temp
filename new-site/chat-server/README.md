# 加密聊天（第一期）

按事件建群的网页聊天：不用注册、邮箱或手机号，消息端到端加密，到时间自动删除。

## 工作方式

```
浏览器 ──https://<镜像IP>:8443/chat──► 镜像（nginx stream，只转发 TCP 字节）
                                          │  PROXY 协议头
                                          ▼
                              源站 Debian-1-2（本服务）
                               :8443  TLS 在这里结束（每个镜像 IP 一张 Let's Encrypt 证书）
                               :8080  ACME 验证、镜像报到（经镜像的 80 端口转来）
                               SQLite：只有密文和哈希
```

- **不经过 Cloudflare**：聊天页面和加解密脚本必须原样到达浏览器。七层代理（Cloudflare、普通 nginx 镜像）都能改脚本、偷走密钥，所以这里 TLS 在源站结束，镜像只转发加密后的字节。
- **密钥只在链接里**：邀请链接 `/chat#<群号>.<群密钥>`，`#` 后面不会发给任何服务器。浏览器用 HKDF 从群密钥派生出消息密钥（AES-256-GCM）和入群凭证；服务器只存入群凭证的 SHA-256，没有密钥的人连密文都拿不到。
- **服务器看不到**：消息内容、昵称、群名称都是加密的；消息按 256/1024/4096/16384 字节补齐，看不出长短。服务器不记录 IP、不写访问日志。
- **防冒充**：每个浏览器有一把 Ed25519 签名密钥（存在 IndexedDB，不可导出），消息带签名，昵称旁显示指纹。同一个昵称出现两个指纹会标红。
- **阅后即焚**：
  - 每条消息都有保存时间（5 分钟到 7 天），到时间服务器删除，页面同时消失；
  - 可选「看过 N 秒后删」：第一个别人在屏幕上看到它时开始倒计时，所有人那边一起删除；
  - 发送者可以撤回（在同一个页面里）；
  - 建群的人用管理链接可以销毁整个群；30 天没有新消息的群自动删除。
  - SQLite 开了 `secure_delete`，WAL 每分钟截断一次；数据库**不做备份**。
  - 截图、拍屏防不住，页面上已经提示。
- **防滥用**：建群要做工作量证明（和事件墙同一套 `pow.js`），每个连接限速，群人数和消息数有上限。

## 源站部署（Debian-1-2）

```bash
# 在 Debian-1-2 上，用 root（和事件墙一样，可以用 fetch.sh 按提交部署）
bash new-site/chat-server/deploy/install.sh
# 或
curl -fsSLO https://raw.githubusercontent.com/hello-world-1989/temp/<commit>/new-site/chat-server/deploy/fetch.sh && bash fetch.sh <commit>
```

- 需要 Node.js 20+。脚本会装依赖（`ws`、`better-sqlite3`），下载 acme.sh，并装好 systemd 服务 `end-gfw-chat`。
- **防火墙**：放行 TCP **8443** 和 **8080**（Lightsail：Networking → IPv4 Firewall）。
- 只想让登记过的镜像连进来：在 `/etc/end-gfw-chat/env` 里写 `ALLOW_FROM=镜像IP1,镜像IP2`，然后 `systemctl restart end-gfw-chat`。
- 数据在 `/var/lib/end-gfw-chat/`（数据库、镜像证书、acme.sh 账号）。
- 源站 IP 需要告诉镜像运营者，但普通访客不会直连源站。

## 镜像

```bash
wget <chat-relay.sh 的地址> && sudo bash chat-relay.sh <源站IP>
```

- 已经用 `mirror.sh` 搭了网站镜像的服务器可以直接加装：网站还在 443，聊天在 **8443**。
- 需要放行 TCP 80 和 8443。
- 装好后一两分钟，源站会给这台镜像的 IP 签好证书，之后 `https://<镜像IP>:8443/chat` 就能用。
- 镜像 IP 变了，脚本每 10 分钟报到一次，源站会自动给新 IP 签证书。
- `bash /opt/end-gfw-chat-relay/chat-relay.sh status` 查看状态，`uninstall` 卸载（会还原网站镜像的配置）。

证书怎么签：镜像向源站 `:8080/.well-known/end-gfw-chat/hello` 报到，源站用它的来源 IP 向 Let's Encrypt 申请 IP 证书（6 天有效，剩 2 天时续签）。Let's Encrypt 访问 `http://<镜像IP>/.well-known/acme-challenge/...`，镜像的 nginx 在本地找不到就转给源站 8080。这样只有真的把流量转给源站的 IP 才签得出证书，私钥始终在源站。

## 本地开发

```bash
cd new-site/chat-server
npm install
npm run dev      # http://127.0.0.1:8792/chat（只开本地 HTTP，不签证书）
npm test
```

## 第二期可以做的

- MLS 或 Sender Keys：前向保密，踢人后自动换密钥
- 图片、文件（加密后上传，复用加密分享）
- WebSocket 连不上时退回长轮询
- 在 end-gfw.com 上列出可用的聊天镜像地址
