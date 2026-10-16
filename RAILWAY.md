# Railway 部署

## 部署步骤

1. 将本次文件推送到 GitHub。在 Railway 创建项目，选择 **Deploy from GitHub repo**，选择 `nguyenvansu300965-netizen/BLUE-v` 的 `main` 分支，Root Directory 留在仓库根目录。
2. Railway 会读取 `railway.json`，使用根目录 `Dockerfile` 构建。无需另设 Build Command 或 Start Command。
3. 为此服务添加 **Volume**，挂载路径设为 `/data`。`railway.json` 不会自动创建 Volume，必须手动添加。不要启用多副本：一个 WhatsApp 会话只运行一个实例。
4. 在服务 Variables 中配置下表中的变量，密码通过 Railway 面板输入，勿提交到仓库。
5. 在 Networking 中生成 HTTPS 域名，将该完整地址填入 `PUBLIC_ORIGIN`，例如 `https://blue-v-production.up.railway.app`。不要填路径。保存变量并部署。
6. 访问生成的 HTTPS 域名，输入管理员账号密码。点击连接 WhatsApp，在手机「已关联的设备」扫码，再测试真实收发。
7. 在自动回复编辑器载入示例，修改文案和图片，设置选项目标节点，启用并保存。

## 变量

| 变量 | 设置 |
| --- | --- |
| `ADMIN_USER` | 管理员用户名，例如 `admin`；不要包含冒号 |
| `ADMIN_PASSWORD` | 必填，使用长随机密码 |
| `PUBLIC_ORIGIN` | 必填，你生成的完整 HTTPS 域名；用于同源请求验证 |
| `HOST` | `0.0.0.0`，Dockerfile 已设置 |
| `NODE_ENV` | `production`，Dockerfile 已设置；未设置管理员账号密码时拒绝启动 |
| `DATA_DIR` | `/data`，Dockerfile 已设置 |
| `AUTH_DIR` | `/data/auth`，Dockerfile 已设置 |
| `AUTO_CONNECT` | 建议 `true`，启动后连接 WhatsApp，复用已有登录；没有会话时生成二维码 |
| `PORT` | 使用 Railway 自动注入值，无需填写 |

`.env.example` 仅作为填写参考，程序不会自动加载 `.env`。本服务使用 HTTP Basic 管理员认证，必须使用 Railway HTTPS 域名访问。所有页面和业务 API 均需认证；只有 `/healthz` 公开用于平台检查。

## 持久化和检查

- `/data/auth`：敏感登录凭据；`/data/flows.json`：流程；`/data/media`：图片。缺少 Volume 时重新部署会丢失这些数据。不要与其他服务共用同一登录目录。
- 健康检查 `GET /healthz` 返回 `{"ok":true}` 仅代表 Web 服务就绪，不代表 WhatsApp 已登录。后台状态显示「已连接」后再测试图片和按钮。
- 重启后消息历史和客户当前分支步骤会重置，已保存流程和登录凭据从 Volume 恢复。`AUTO_CONNECT=true` 可恢复连接；无法恢复时需重新扫码。
- 关闭服务休眠 / Serverless 功能（如果启用），保持常驻连接，避免无人访问时无法及时回复。具体计费与能力以 Railway 当前套餐为准。
- Railway 出站网络须能访问 WhatsApp 的 HTTPS/WebSocket 和媒体上传服务；在受限网络中按实际错误放行相关目标。本地云环境的 403 限制不代表 Railway 网络同样受限。
- 原生交互按钮为实验功能，需用实际账号和手机验证；不显示时切回数字菜单模式。

## 常见问题

- **启动失败，提示 ADMIN_USER / ADMIN_PASSWORD**：补齐两个变量重新部署。
- **健康检查失败**：检查启动日志、`HOST=0.0.0.0`，不要覆盖 Railway 的 `PORT`。
- **页面能打开，保存或连接返回 403**：确保 `PUBLIC_ORIGIN` 与浏览器地址栏的 HTTPS 域名完全相同；更换自定义域名后同步更新。
- **重新部署后要重新登录 / 图片消失**：确认 Volume 挂在本服务的 `/data`，并检查两个目录变量没有被覆盖。

## 本地检查

```sh
npm ci
npm run check
npm test
docker build -t blue-v .
```

容器运行时须提供上述账号、密码、PUBLIC_ORIGIN，挂载 `/data` 并映射端口。不要把密码写入 Dockerfile 或 railway.json。
