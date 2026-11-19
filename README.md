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

## 让令牌一直不过期（自动同步）
实测 accessToken 有效期是 **30 天**（早期写的是 55 天，不对）。到期后 Worker 会签到失败，
而且失败信息会被旧版代码藏成一个看不懂的 TypeError，很容易漏掉。

解决办法：本机 WorkBuddy 桌面端只要在用，就会自己续期令牌并写回本地。
所以只要**定期把本机的最新令牌搬到云端**，Worker 就永远不会到期，全程不需要账号密码。

- 手动：双击 `sync-token.bat`（或 `node sync-token.js`）
- 脚本做了三件事：取本机令牌 → 写入 CF Secret → 真的调一次 Worker 验证结果
- 已验证可挂定时执行（WorkBuddy automation，每周一 09:30）

## 注意
- 令牌约 **30 天**过期。`sync-token.js` 会在写入前打印剩余天数，低于 7 天会提示。
- 部署时 `wrangler.toml` 的 `name` 必须和 Cloudflare 上已有的 Worker 名一致，否则会**新建**一个 Worker，旧的那份继续跑，表面显示成功实际没生效。
- 安全：令牌只存在你自己的 CF / GitHub Secret，不进代码、不公开。本仓库无任何真实令牌 / 密钥 / 账号路径。
- 非官方脚本，接口可能随平台变动；仅供学习自动化，请遵守平台规则。

License: MIT
