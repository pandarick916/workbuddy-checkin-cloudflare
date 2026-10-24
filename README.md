# WorkBuddy 每日自动签到（Cloudflare Worker）

每天自动签到领应用内积分。一次配置，之后每天自动跑，不用手动点。

## 核心思路
- WorkBuddy 5.6.0+ 把登录令牌（accessToken）改成了 **AES-256-GCM 加密信封**，不再是明文字符串。
- 本仓库脚本会**自动启动你本机已登录的 WorkBuddy 取出解密密钥，再把令牌解出来**，全程无需手动操作。
- 解出的令牌写进 Cloudflare Worker 的 Secret，由 Worker 每天定时调用签到接口。

## 前置
1. 本机已安装并登录过 WorkBuddy 桌面端（Windows）
2. 一个免费 Cloudflare 账号
3. Node.js（含 npx）

## 三步上手
1. 用记事本打开 `wrangler.toml`，把 `account_id = "<YOUR_CF_ACCOUNT_ID>"` 换成你的 Cloudflare Account ID（控制台右侧）。
2. 双击 `deploy-cf-worker.bat`：自动登录 CF → 自动取令牌写进 Secret → 自动部署。
3. 完成。之后每天北京 10:00 自动签到。

## 拿令牌（三种方式，均为 5.6.0+ 自动解密）
- 双击 `get_checkin_token.bat`（自动复制 accessToken 到剪贴板）
- 命令行 `node get_token.cjs`
- `python decrypt_workbuddy_token.py --auto`
- 备用：手动在 WorkBuddy 控制台执行
  `JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()).atRestSecretKey`
  拿到 key 后 `python decrypt_workbuddy_token.py --at-rest-key "<key>"`。

## 备选：GitHub Actions
Fork 本仓库 → Settings → Secrets → 新建 `WORKBUDDY_TOKEN`（填上面拿到的 accessToken）→ 启用 Actions 工作流。

## 注意
- 令牌约 55 天过期，过期后重跑部署脚本更新 Secret 即可。
- 安全：令牌只存在你自己的 CF / GitHub Secret，不进代码、不公开。本仓库无任何真实令牌 / 密钥 / 账号路径。
- 非官方脚本，接口可能随平台变动；仅供学习自动化，请遵守平台规则。

License: MIT
