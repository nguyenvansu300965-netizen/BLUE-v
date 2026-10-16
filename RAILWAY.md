# Railway 多账号版本部署

## 部署步骤

1. Railway 选择 **Deploy from GitHub repo**，连接 `nguyenvansu300965-netizen/BLUE-v` 的 `main` 分支，Root Directory 使用仓库根目录。
2. 根目录 `railway.json` 自动选择 `Dockerfile`，使用 Node.js 24，无需覆盖 Build / Start Command。
3. 为服务添加 **Volume**，挂载到 `/data`。配置文件不会自动创建卷。用户、订阅、消息、流程、图片和所有 WhatsApp 登录凭据都依赖这个卷。
4. 在 Networking 生成 HTTPS 域名，在 Variables 中配置下表。初次部署可先生成域名，再设置变量并重新部署。
5. 访问该 HTTPS 域名，用 `ADMIN_USER` / `ADMIN_PASSWORD` 在网页登录，进入左侧「超级管理员」后台。
6. 普通用户可自由注册，默认待开通。管理员选套餐、勾选使用权限、设置未来到期时间，保存后用户即可添加对应数量的号码。
7. 每个号码在「连接设备」中独立扫码，然后配置该号码的自动流程并实机测试。

## 环境变量

| 变量 | 设置 |
| --- | --- |
| `ADMIN_USER` | 首次启动创建的超级管理员用户名，例如 `admin`；4–64 位字母、数字、点、横线或 @ |
| `ADMIN_PASSWORD` | 首次启动的管理员密码，至少 12 位，使用长随机密码 |
| `PUBLIC_ORIGIN` | 必填，完整 HTTPS 域名，例如 `https://blue-v-production.up.railway.app`，勿填路径 |
| `HOST` | `0.0.0.0`，Dockerfile 已设置 |
| `NODE_ENV` | `production`，Dockerfile 已设置，登录 Cookie 要求 HTTPS |
| `DATA_DIR` | `/data`，Dockerfile 已设置；必须挂载持久化 Volume |
| `AUTO_CONNECT` | 建议 `true`；仅恢复已有登录且仍在套餐配额与有效订阅内的号码 |
| `TRUST_PROXY` | Railway 单层边缘代理部署可设 `1`，用于识别注册/登录限流的客户 IP；其他环境仅在可信代理后启用 |
| `PORT` | 使用 Railway 自动注入值，无需填写 |

`ADMIN_USER` / `ADMIN_PASSWORD` 仅用于空数据库初始化。已有管理员时修改这两个变量不会重置数据库密码。密码请在 Railway Variables 中安全输入，不提交到 Git。本版本已替换 HTTP Basic 弹窗，改为用户注册及网页登录。

## 套餐与运行约束

- 基础版 1 个号码，高级版 5 个，VIP 10 个；管理员通过后台人工开通或续期，没有自动支付/扣款功能。
- 每个用户独立数据；停用或到期后停止连接和自动回复，超配额号码停止但不删除，恢复套餐后可重新连接。
- 仅运行一个服务副本、一个 Node 进程，不使用集群共用 WhatsApp 凭据。`railway.json` 配置 1 个副本。
- 关闭休眠 / Serverless 功能（如果启用），保持连接常驻。实际费用和能力以 Railway 套餐为准；10 个号码意味着更多长连接和内存，应观察服务资源。
- 健康检查 `/healthz` 返回 `{"ok":true}` 仅代表 Web 服务启动，不代表 WhatsApp 已连接。
- 备份时先停止服务并完整备份 `/data`；SQLite WAL/SHM、用户数据库和号码凭据需一起保留。不要将数据卷公开。
- 每个号码保留最新 500 条消息；客户当前自动流程步骤在重启后重置。登录凭据、订阅及流程从卷恢复。
- WhatsApp HTTPS/WebSocket 与媒体上传必须可达。原生按钮仍需实际客户端验证，不显示时切回数字菜单。

## 旧版本升级

若 Railway 已部署旧单账号版本：先停止并备份 `/data`，保持原有 `ADMIN_USER` / `ADMIN_PASSWORD`，部署后这组凭据会初始化新的超级管理员。旧 `AUTH_DIR` 变量可移除，新版本按用户和号码保存凭据。旧根目录数据不会自动绑定用户；按 [README 升级步骤](README.md#从单账号版本升级) 安全复制到管理员的号码目录，或重新扫码。

## 常见问题

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
docker build -t blue-v .
```

容器启动时通过运行环境提供变量并挂载 `/data`，不要将密码写入镜像。
