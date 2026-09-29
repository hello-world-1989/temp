# 加密聊天（第一期）

按事件建群的网页聊天：不用注册、邮箱或手机号，消息端到端加密，到时间自动删除。

## 工作方式

两种入口，群和消息互通：

```
① https://end-gfw.com/chat（也经自己节点的 https://<节点IP>/chat）
   浏览器 ── Cloudflare ── 网站 Worker（/chat、/chat/ws）── Cloudflare Tunnel end-gfw-chat
          ── Debian-1-2 127.0.0.1:8792（本服务）

② https://<节点IP>:8443/chat（备用，更安全）
   浏览器 ──► 自己的 xrayr-next 节点（agent 的 nginx stream，只转发 TCP 字节，带 PROXY 协议头）
          ──► Debian-1-2 :8443  TLS 在这里结束（每个节点 IP 一张 Let's Encrypt 证书）
              Debian-1-2 :8080  ACME 验证、节点报到（经节点的 80 端口转来）
```

- **入口 ① 信任 Cloudflare**：Cloudflare 和你的 Cloudflare 账号 / token 能改页面脚本。用户接受这个取舍，好处是主站能直接打开。
- **入口 ② 不经过 Cloudflare**：TLS 在源站结束，节点只转发加密后的字节。
- **第三方镜像**：任何人用 `mirror.sh`（`new-site/public/mirror.sh`）搭的镜像都能用加密聊天，页面顶部提示“这是第三方镜像”：运营者理论上能改动页面、看到链接里的密钥，敏感的群请用官方地址（:8443、end-gfw.com、网站 `/api/official-hosts` 列出的自己节点 IP）。
- **邀请链接带备用地址**：服务每 10 分钟从网站（`SITE_URL`，默认 https://end-gfw.com）读取聊天能打开的地址（主站、镜像节点 `https://<IP>/chat`、直连 `https://<IP>:8443/chat`），在 `/chat/api/entries` 提供；复制邀请链接、管理链接时会附上这些备用地址（同一个 `#` 片段），一个地址被封还能从别的进群。
- **兼容模式（长轮询）**：WebSocket 连不上时（旧镜像不转发 WebSocket、某些网络），页面自动改用 `/chat/api/poll`（请求最长挂起 25 秒，消息照样实时），协议和 WebSocket 完全一样。
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

## 我的身份与群（保险箱）

没有注册和密码找回：身份就是浏览器里的一把签名密钥，进群靠邀请链接。页面右上角「我的」里可以：

- **设置口令**：把身份（指纹）、昵称和加入过的群用口令加密（PBKDF2-SHA256 60 万次 + AES-256-GCM）保存在本机。之后打开页面要先解锁；也可以「暂不解锁」，这次用临时身份。解锁后同一个标签页刷新不用再输（关掉标签页就锁上）。进过的群会自动加进「我的群」。
- **导出备份文件**：下载一个 JSON 文件，就是本机保存的那份密文，要用原来的口令才能打开。在别的设备上「从备份文件恢复」，指纹和群列表都回来。
- **迁移到新设备**：旧设备生成一个二维码，新设备用相机扫。内容用一把随机密钥加密后上传到服务器，密钥只在二维码链接的 `#` 后面；服务器上的那份**只能取一次**，最多保留 10 分钟。新设备取到后让你另设一个口令。
- **删除本机数据**：清掉这个浏览器里的一切。

口令只在设备上用，服务器不知道，所以**忘了口令就找不回来**，只能删除本机数据重新开始（群还在，有邀请链接就能再进，只是指纹会变）。

## 源站部署（Debian-1-2）

```bash
# 在 Debian-1-2 上，用 root（和事件墙一样，可以用 fetch.sh 按提交部署）
bash new-site/chat-server/deploy/install.sh
# 或
curl -fsSLO https://raw.githubusercontent.com/hello-world-1989/temp/<commit>/new-site/chat-server/deploy/fetch.sh && bash fetch.sh <commit>
```

- 需要 Node.js 20+。脚本会装依赖（`ws`、`better-sqlite3`），下载 acme.sh，并装好 systemd 服务 `end-gfw-chat`。
- **防火墙**：放行 TCP **8443** 和 **8080**（Lightsail：Networking → IPv4 Firewall）。
- 数据在 `/var/lib/end-gfw-chat/`（数据库、节点证书、acme.sh 账号）。
- 入口 ①：`bash new-site/tunnel/tunnel.sh end-gfw-chat chat-store.end-gfw.com http://127.0.0.1:8792`（Cloudflare Tunnel，只出站；网站 Worker 变量 `CHAT_URL`）。
- 入口 ②：Lightsail 防火墙的 8443、8080 只放行开了聊天的自己节点，由 xrayr-next Lambda 自动同步（`CHAT_ORIGIN*` 环境变量，`POST /admin/nodes/chat?name=&on=1|0`）；节点 agent 自己做 TCP 透传和报到，节点每 10 分钟向源站 `:8080/.well-known/end-gfw-chat/hello` 报到，源站据此给节点 IP 签证书，私钥始终在源站。

## 本地开发

```bash
cd new-site/chat-server
npm install
npm run dev      # http://127.0.0.1:8792/chat（只开本地 HTTP，不签证书）
npm test
```

## 以后可以做的

- MLS 或 Sender Keys：前向保密，踢人后自动换密钥
- 图片、文件（加密后上传，复用加密分享）
