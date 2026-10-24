# WorkBuddy 每日自动签到（Cloudflare Worker 版 · 小白教程）

> 每天自动给你的 WorkBuddy / CodeBuddy 签到，领 **100 积分/天** + 连签奖励 + 派猫猫旅行奖励。你不用每天手动点开 App。

本仓库把「从手动签到 → 全自动」的完整做法开源出来。照着下面的教程一步步做，就能跑起来。

---

## 0. 先说清楚：这东西能帮你做什么

- 你每天要做的：第一次部署时花约 10 分钟配置一次；之后**什么都不用管**，每天到点自动签到。
- 它领的是 WorkBuddy / CodeBuddy 的每日签到积分（应用内积分，不是钱）。
- 它**不是**官方功能，是社区脚本，调用的接口可能随平台更新变动（见底部免责声明）。

---

## 1. 你需要先准备好这三样

| 准备项 | 说明 | 怎么确认有了 |
|--------|------|--------------|
| ① WorkBuddy 桌面端已登录 | 脚本的"签到令牌"从你本机已登录的 WorkBuddy 里取 | 打开 WorkBuddy 桌面端，确认是登录状态 |
| ② 一个 Cloudflare 账号（免费） | 用来托管自动签到的小程序（Worker），免费额度足够 | 去 cloudflare.com 注册，不用绑卡 |
| ③ Node.js（含 npx） | 部署工具 wrangler 需要它 | 打开终端输入 `node -v`，能显示版本号就 OK |

> 没有 Node.js？去 [nodejs.org](https://nodejs.org) 下载 **LTS** 版，一路下一步安装，装完重开终端。

---

## 2. 最快上手：只做 3 步（给怕麻烦的人）

如果你不想懂原理，只想要它跑起来，做这 3 步就够了：

1. **填你的 Cloudflare Account ID**：用记事本打开 `wrangler.toml`，把
   ```toml
   account_id = "<YOUR_CF_ACCOUNT_ID>"
   ```
   改成你在 Cloudflare 控制台（登录后主页**右侧**）看到的那串 Account ID，保存。
2. **双击 `deploy-cf-worker.bat`**：它会自动打开浏览器让你登录 Cloudflare → 自动从本机 WorkBuddy 读取令牌并写进 Secret → 自动部署。中途按提示点"允许"即可。
3. **完事。** 之后每天**北京 10:00** 自动签到。第二天去 WorkBuddy 看积分有没有 +100 就行。

> 想看懂每一步在干嘛、或者卡住了怎么查，看下面的【详细分步教程】。

---

## 3. 详细分步教程（想知道每一步在干嘛的人看这里）

### 3.1 装 Node.js
去 [nodejs.org](https://nodejs.org) 下载 LTS 版安装。装完打开终端输入 `node -v`，能看到版本号就成功了。

### 3.2 注册 / 登录 Cloudflare，拿到 Account ID
1. 浏览器打开 https://dash.cloudflare.com ，注册并登录（免费，不用绑卡）。
2. 登录后，页面**右侧**会显示你的 **Account ID**（一长串字母数字）。复制它备用。

### 3.3 改 `wrangler.toml`
用记事本打开仓库里的 `wrangler.toml`，把 `<YOUR_CF_ACCOUNT_ID>` 换成你刚复制的 ID，保存。
```toml
account_id = "你的真实AccountID"
```
> 想改签到时间？同一文件里有 `crons = ["0 2 * * *"]`，这是"每天 UTC 02:00"跑（= 北京 10:00）。不懂 cron 没关系，默认就行。

### 3.4 核心概念：什么是"令牌"（token），为什么要它
签到本质是一个"带身份的网络请求"。要让自动脚本替你签到，它必须知道"你是谁"——这个身份证明就是 **accessToken**（一串字符）。

> **WorkBuddy 5.6.0+ 注意**：从 5.6.0 起，令牌在 `workbuddy-desktop.info` 里改成了 **AES-256-GCM 加密信封**（`auth.accessToken` 不再是明文字符串，而是一个加密对象）。本仓库的取令牌脚本（`get_token.cjs` / `decrypt_workbuddy_token.py`）会**自动解密**，你无需关心加密细节；只要本机 WorkBuddy 桌面端已安装并登录过，双击/运行脚本即可拿到明文令牌。

- 它来自你本机 WorkBuddy 桌面端的登录态文件 `workbuddy-desktop.info`。
- **有效期约 55 天**，到期后脚本签到会失败，需要重新取一次（很正常，10 秒搞定）。
- 它**只**放在 Cloudflare 的 Secret 里，**不会**写进任何代码或发到网上（本仓库已脱敏，看不到任何真实令牌）。

记住一句话：**令牌 = 你的签到身份证，定期换，别乱发。**

### 3.5 登录 CF + 写 Secret + 部署（手动命令版，对应 .bat 里做的事）
打开终端，进入本仓库目录，依次执行：

```bash
# 1) 登录 Cloudflare（弹浏览器授权，点允许）
npx wrangler login

# 2) 把令牌写进 Cloudflare Secret（粘贴你的 accessToken 后回车）
#    —— 拿令牌最简单的方式：双击 get_checkin_token.bat，它已把令牌复制到剪贴板
npx wrangler secret put WORKBUDDY_TOKEN

# 3) 部署
npx wrangler deploy
```
看到 `Successfully deployed` 就成功了。

> 拿令牌另外两种方式（均为 5.6.0+ 自动解密版）：
> - **双击 `get_checkin_token.bat`**：自动解密 accessToken 并复制到剪贴板（需 Node.js）。
> - **命令行**：`node get_token.cjs` 会把令牌直接打印出来；`python decrypt_workbuddy_token.py --auto` 等价（Python 版）。
> - 若自动解密失败（极少情况），可手动在桌面端控制台取 `atRestSecretKey` 后跑 `python decrypt_workbuddy_token.py --at-rest-key "<key>"`，详见该脚本顶部注释。

### 3.6 验证部署成功
- 回到 https://dash.cloudflare.com → **Workers & Pages**，能看到 `workbuddy-checkin-trigger` 这个 Worker。
- 点进去看 **Settings → Variables**，应能看到 `WORKBUDDY_TOKEN`（值被隐藏，正常）。
- 它会**每天北京 10:00** 自动跑一次。第二天去 WorkBuddy 看积分有没有 +100 即可。

---

## 4. 方式二：GitHub Actions（不想用 Cloudflare 的人）

适合你已有 GitHub 账号、不想注册 Cloudflare 的情况。缺点：GitHub 定时任务不保证准时（整点可能延迟甚至被跳过），所以仓库里保留了 16 档兜底。

1. 右上角 **Fork** 本仓库到你自己的 GitHub。
2. 进你 Fork 的仓库 → **Settings → Secrets and variables → Actions → New repository secret**。
   - Name 填 `WORKBUDDY_TOKEN`
   - Secret 填第 3.4/3.5 步拿到的 accessToken
3. 进 **Actions** 标签页，找到 `WorkBuddy 每日签到` 工作流，点 **Enable workflow**。

之后它会按配置自动跑。

---

## 5. 常见问题 / 排错

**Q：部署报 `account_id` 相关错误？**
A：第 3.3 步没填或填错。重新打开 `wrangler.toml` 核对 Account ID（在 CF 控制台右侧）。

**Q：某天发现没签到、积分没加？**
A：最常见是令牌过期（约 55 天）。重跑第 3.5 步的 `wrangler secret put` 更新令牌即可。也可以在 CF Worker 的 **Logs / 监控** 里看报错。

**Q：`get_checkin_token.bat` 双击报错？**
A：它依赖 Node.js（需要 `node` 在 PATH，部署 wrangler 时已经装了）。若提示找不到 WorkBuddy，请确认桌面端已安装并至少登录过一次；若提示无法取密钥，可手动打开桌面端控制台执行 `JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()).atRestSecretKey` 拿到 `atRestSecretKey`，再用 `python decrypt_workbuddy_token.py --at-rest-key "<key>"`。

**Q：`deploy-cf-worker.bat` 中途卡住 / 报错？**
A：它本质是依次执行 `wrangler login` → 读令牌 → `wrangler secret put` → `wrangler deploy`。哪步报错就按第 3.5 节的手动命令一步步跑，更容易看到具体原因。

**Q：我 Worker 和 Actions 都开着，会领两次分吗？**
A：**不会。** 两者调同一个接口，接口有"今日已签"判断。实测是 **Cloudflare Worker 先跑**（北京 10:00）领到分；GitHub Actions 后到，看到已签就跳过（日志里 `skip_already_signed`）。所以真正领分的是 Worker，Actions 是兜底。建议只开一个，避免混乱。

---

## 6. 一个关键发现（为什么主推 Worker 版）

两个版本接同一个签到接口。关系是：
- **Cloudflare Worker 先跑**（02:01 UTC）→ 领到 +100、连签 +1；
- 后来 GitHub Actions 跑 → 看到「今日已签」→ 跳过。

所以**真正领分的是 Worker**。Actions 日志里的 `skip_already_signed` 就是证据。这也是本仓库把 Worker 当主力的原因。

---

## 7. 安全说明

- 令牌只存在于你自己的 Cloudflare / GitHub Secret 中，**绝不进代码、绝不公开**。
- 本仓库已脱敏：没有任何 account_id、本地账号路径、真实令牌。
- 令牌约 55 天过期，到期重拷即可；`checkin.py` 会在临期前打印警告，方便你提前换。

## 8. 免责声明

- 这是非官方脚本，调用的 `codebuddy.cn` / `workbuddy.cn` 接口可能随平台更新变动，不保证长期可用。
- 仅供学习自动化思路，请遵守平台规则，勿滥用。

## License

MIT
