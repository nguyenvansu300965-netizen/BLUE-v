# Railway 多账号版本部署

## 部署步骤

1. Railway 选择 **Deploy from GitHub repo**，连接 `nguyenvansu300965-netizen/BLUE-v` 的 `main` 分支，Root Directory 使用仓库根目录。
2. 根目录 `railway.json` 自动选择 `Dockerfile`，使用 Node.js 24 并安装 Chromium、CA 证书与 tini，无需覆盖 Build / Start Command。
3. 为服务添加 **Volume**，挂载到 `/data`。配置文件不会自动创建卷。用户、订阅、消息、流程、图片和所有 WhatsApp 登录凭据都依赖这个卷。
4. 在 Networking 生成 HTTPS 域名，在 Variables 中配置下表。初次部署可先生成域名，再设置变量并重新部署。
5. 访问该 HTTPS 域名，用 `ADMIN_USER` / `ADMIN_PASSWORD` 在网页登录，进入左侧「超级管理员」后台。
6. 普通用户可自由注册，默认待开通。管理员选套餐、勾选使用权限、设置未来到期时间，保存后用户即可添加对应数量的号码。
7. 每个号码在「连接设备」中独立扫码，然后配置该号码的自动流程并实机测试。

## 环境变量

| 变量 | 设置 |
| --- | --- |
| `ADMIN_USER` | 首次启动创建的超级管理员用户名，例如 `admin`；4–64 位字母、数字、点、横线或 @ |
| `ADMIN_PASSWORD` | 首次启动的管理员密码，至少 6 位，使用长随机密码 |
| `PUBLIC_ORIGIN` | 必填，完整 HTTPS 域名，例如 `https://blue-v-production.up.railway.app`，勿填路径 |
| `HOST` | `0.0.0.0`，Dockerfile 已设置 |
| `NODE_ENV` | `production`，Dockerfile 已设置，登录 Cookie 要求 HTTPS |
| `DATA_DIR` | `/data`，Dockerfile 已设置；必须挂载持久化 Volume |
| `AUTO_CONNECT` | 建议 `true`；仅恢复已有 WA-JS 登录标记且仍在套餐配额与有效订阅内的号码 |
| `CHROMIUM_PATH` | `/usr/bin/chromium`，Dockerfile 已设置 |
| `CHROMIUM_NO_SANDBOX` | `true`，Dockerfile 针对容器环境设置 |
| `CHROMIUM_PROXY_SERVER` | 可选，浏览器出站代理；Railway 正常直连时无需填写 |
| `TRUST_PROXY` | Railway 单层边缘代理部署可设 `1`，用于识别注册/登录限流的客户 IP；其他环境仅在可信代理后启用 |
| `PORT` | 使用 Railway 自动注入值，无需填写 |

`ADMIN_USER` / `ADMIN_PASSWORD` 仅用于空数据库初始化。已有管理员时修改这两个变量不会重置数据库密码。密码请在 Railway Variables 中安全输入，不提交到 Git。本版本已替换 HTTP Basic 弹窗，改为用户注册及网页登录。

## 套餐与运行约束

- 基础版 1 个号码，高级版 5 个，VIP 10 个；管理员通过后台人工开通或续期，没有自动支付/扣款功能。
- 每个用户独立数据；停用或到期后停止连接和自动回复，超配额号码停止但不删除，恢复套餐后可重新连接。
- 仅运行一个服务副本、一个 Node 进程，不使用集群共用 WhatsApp 凭据。`railway.json` 配置 1 个副本。
- 关闭休眠 / Serverless 功能（如果启用），保持连接常驻。实际费用和能力以 Railway 套餐为准；每个号码对应独立 Chromium 进程组，10 个号码的内存与 CPU 消耗明显高于原 WebSocket 方案，应根据真实在线量观察并调整服务资源。
- 健康检查 `/healthz` 返回 `{"ok":true}` 仅代表 Web 服务启动，不代表 WhatsApp 已连接。
- 备份时先停止服务并完整备份 `/data`；SQLite WAL/SHM、用户数据库和号码凭据需一起保留。不要将数据卷公开。
- 每个号码保留最新 500 条消息；客户当前自动流程步骤在重启后重置。登录凭据、订阅及流程从卷恢复。
- Chromium 必须能访问 WhatsApp 网页及所需 HTTPS/WebSocket 和媒体资源，且通过 TLS 证书验证。原生按钮仍需实际客户端验证，不显示时切回数字菜单。

## 从 Baileys 版本升级

1. 先停止服务并完整备份 `/data`，保留同一个 Volume 和管理员变量。
2. 部署新 Dockerfile，让 Railway 重建包含 Chromium 的镜像，勿只替换旧容器中的 JavaScript 文件。
3. 用户、套餐、号码、消息、图片和流程继续使用原数据。
4. 每个号码重新扫码。旧 Baileys 凭据无法供 WA-JS 使用；原有 `auth/` 目录保留，不会自动删除。新凭据保存在号码的 `browser-profile/`。
5. 在流程中选择「WA-JS 原生按钮（实验性）」并保存，用接收方 iPhone 测试按钮显示和分支回复。图片 3 个选项时会拆成图片和单独的按钮菜单。

## 常见问题

- **未安装 Chromium / 浏览器启动失败**：确认已使用新 Dockerfile 重建，`CHROMIUM_PATH=/usr/bin/chromium`，数据卷可写。
- **浏览器不信任证书**：若有自定义出站代理，正确配置其 CA 信任，不使用忽略证书错误的参数。
- **服务启动失败**：首次启动检查管理员变量和密码长度；生产模式检查 `PUBLIC_ORIGIN` 为 HTTPS，使用 Node 24。
- **注册后不能添加号码**：这是待开通状态，管理员在后台开通权限、选择套餐和到期时间。
- **保存 / 连接返回 403**：检查订阅是否有效、该号码是否超配额、`PUBLIC_ORIGIN` 是否与地址栏一致。
- **重新部署后用户或登录丢失**：检查 Volume 是否挂载到本服务的 `/data`，不要覆盖 `DATA_DIR` 指向临时目录。
- **降级后号码不可用**：按创建顺序保留套餐配额内号码，可以删除不需要的号码或升级套餐。
- **收到 429**：注册或登录触发限流；确认部署处于可信 Railway 代理后且配置 `TRUST_PROXY=1`，不要无条件信任其他来源的转发头。

## 本地验证

```sh
npm ci
npm run check
npm test
npm run test:browser
docker build -t blue-v .
```

容器启动时通过运行环境提供变量并挂载 `/data`，不要将密码写入镜像。

## 二维码等待与重试

连接窗口显示启动浏览器、打开 WhatsApp 页面、载入 WA-JS 等阶段。二维码读取不再依赖 WA-JS 内部模块就绪。等待期间可点「重新连接」关闭旧浏览器后重试；120 秒仍未获取二维码会停止并显示具体超时阶段。连接失败会显示错误码和当前容器内存，并在 Deploy Logs 写入 `whatsapp_connect_failed`，包括启动阶段、内存上限、OOM 次数、进程/线程数量及经过过滤的启动错误原因。`BROWSER_PROFILE_LOCKED` 表示此号码仍有浏览器占用；Docker 默认启用 `CHROMIUM_SINGLE_REPLICA=true`（只适用于本项目要求的单副本部署），遇到旧容器残留锁时会检查本机进程、仅移除 `SingletonLock/SingletonSocket/SingletonCookie` 并重试一次，保留 Cookie、IndexedDB 及登录档案。不要把同一数据卷挂到多个活跃副本；多副本环境必须关闭此开关并先分离会话存储。`BROWSER_PROCESS_LIMIT` 表示进程/线程创建受限，`BROWSER_OOM` 表示内存不足证据，`BROWSER_START_TIMEOUT` 表示启动超时。这些故障不代表存在两个用户的固定上限。若提示证书、代理或网页访问超时，请按提示检查 Railway 运行环境，而不是反复重置账号。

登录二维码优先直接复制 WhatsApp 页面原图，避免网页图与 WA-JS 生成码互相覆盖。扫码认证后会隐藏二维码并等待同步；同步超过 180 秒则停止本次连接并允许重试，浏览器档案保留。不要在手机正在关联设备时点击重置。
