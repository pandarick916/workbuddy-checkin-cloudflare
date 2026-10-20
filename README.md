# WorkBuddy 每日自动签到（Cloudflare Worker 版）

每天自动给 WorkBuddy / CodeBuddy 签到，领 **100 积分/天** + 连签奖励 + 派猫猫旅行奖励。

本项目把「怎么从手动签到，做到全自动」的完整过程开源出来。

## 为什么做了两个版本？

**第一版：GitHub Actions。** 但它不可靠：

- GitHub 的 `schedule` 在整点最堵，官方文档明说会延迟、甚至直接丢弃；
- 我们实测 10:00、10:30 两档被吞，最后改成「每 15 分钟补一档，共 16 档」+ 心跳提交防 60 天自动停用。

**第二版（本仓库主推）：Cloudflare Worker Cron。**

- CF Cron 是确定性的，每天 UTC 02:00（= 北京 10:00）准时跑，不丢；
- 不需要心跳提交，部署一次就一直跑。

## 一个关键发现

两个版本接同一个签到接口。关系是：

- **Cloudflare Worker 先跑**（02:01 UTC）→ 领到 +100、连签 +1；
- 后来 GitHub Actions 跑 → 看到「今日已签」→ 跳过。

所以**真正领分的是 Worker**。Actions 日志里的 `skip_already_signed` 就是证据。
这也是我们最终把 Worker 当主力的原因。

## 文件结构

| 文件 | 作用 |
|------|------|
| `worker.js` | Cloudflare Worker 主脚本（签到 + 派猫猫旅行） |
| `wrangler.toml` | CF 部署配置（填你的 `account_id`，改时间在这里） |
| `get_token.cjs` / `get_checkin_token.bat` | 从本机 WorkBuddy 桌面端读 accessToken |
| `deploy-cf-worker.bat` | 一键部署（登录 CF → 写 Secret → 部署） |
| `checkin.py` | 纯标准库签到逻辑（GitHub Actions 版同款） |
| `.github/workflows/daily-checkin.yml` | GitHub Actions 备选方案 |

## 部署：Cloudflare Worker（推荐）

前提：装好 Node.js（含 npx）。

1. 登录 Cloudflare：`npx wrangler login`
2. 拿令牌：双击 `get_checkin_token.bat`，accessToken 会进剪贴板。
   - 令牌来自本机 WorkBuddy 桌面端的 `workbuddy-desktop.info`（auth.accessToken）。
   - **有效期约 55 天**，过期后重跑这步。
3. 写 Secret：`npx wrangler secret put WORKBUDDY_TOKEN`（粘贴刚才的令牌）
4. 改时间（可选）：编辑 `wrangler.toml` 的 `crons`，比如 `"30 1 * * *"` = 北京 09:30。
5. 部署：`npx wrangler deploy`

完成。之后每天北京 10:00 自动签到。

## 部署：GitHub Actions（备选）

1. Fork 本仓库；
2. 仓库 Settings → Secrets → 加 `WORKBUDDY_TOKEN`（值同上）；
3. 打开 Actions，启用 `WorkBuddy 每日签到` 工作流。

## 安全说明

- **令牌只在 CF Secret / GitHub Secret 里，绝不进代码。**
- 本仓库已脱敏：不含任何 account_id、账号路径、真实令牌。
- 令牌约 55 天过期，到期重拷即可；`checkin.py` 会在临期前打印警告。

## 免责声明

- 这是非官方脚本，调用的 `codebuddy.cn` / `workbuddy.cn` 接口可能变动，不保证长期可用；
- 仅供学习自动化思路，请遵守平台规则，勿滥用。

## License

MIT
