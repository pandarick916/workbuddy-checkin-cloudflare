# 排错手册

这份文档只记录**真实踩过的坑**，不是理论清单。每条都标注了症状，方便对着找。

---

## 一分钟定位

打开 Worker 地址，看返回的 JSON：

| 返回 | 含义 | 处理 |
|---|---|---|
| `ok: true` + `checkin: clicked` | 刚签到成功 | 不用管 |
| `ok: true` + `skip_already_signed` | 今天已经签过 | 不用管 |
| `ok: false` + `checkinError` | 出错，继续往下看 | 见下方 |

---

## 坑 1：Worker 名字对不上，部署"成功"但没生效

**症状**：`npx wrangler deploy` 显示部署成功，但行为完全没变。

**原因**：`wrangler.toml` 里的 `name` 和 Cloudflare 上已有的 Worker 名不一致时，
wrangler 会**新建一个 Worker**，而不是更新旧的。旧的那份继续按旧代码跑，两边互不影响。

**排查**：别按名字查，直接列出账号下所有 Worker：

```bash
npx wrangler deploy --dry-run   # 看它准备部署到哪个名字
```

或者看 Cloudflare 控制台 Workers 列表。本项目线上真实名字是 **`round-limit-17d2`**
（首次部署时自动生成的随机名），不是文件里写的 `workbuddy-checkin-trigger`。

**这条为什么危险**：界面显示成功，日志没有报错，只有实际行为对不上时才会发现。

---

## 坑 2：HTTP 200 不代表业务成功

**症状**：Cloudflare 的调用统计显示每天都是 `success / 0 errors`，但签到实际失败了。

**原因**：Worker 的 `runAll()` 用 `try/catch` 包住了每个步骤，异常被 catch 后仍然
返回 `200` 和 `{ok: false}`。**HTTP 层成功，业务层失败**。

**排查**：不要只看调用统计，必须真的打一次 fetch 端点读 JSON body。

**这是一处设计取舍**：返回 200 是为了让 cron 不重试。代价是监控看不出来。

---

## 坑 3：错误被代码吞掉，报错信息完全误导

**症状**：日志里只有 `TypeError: Body has already been used`，看不到任何鉴权线索。

**原因**：旧版 `apiCall()` 这样写：

```js
try { body = await resp.json(); } catch (e) { body = { raw: await resp.text() }; }
```

令牌失效时接口返回的不是 JSON（是 401 的 HTML 页）。`resp.json()` 失败时 body
**已经被消费掉了**，再调 `resp.text()` 就会抛 `Body has already been used`。
真正的 401 被这个二次读取错误完全盖住。

**修法**：只读一次 body，先取文本再尝试解析：

```js
const text = await resp.text();
let body;
try { body = JSON.parse(text); }
catch (e) { body = { raw: text.slice(0, 300) }; }
```

**通用教训**：任何 `catch` 里再做 I/O 都可能制造新的、更难查的错误。
catch 应该暴露信息，不是掩盖信息。

---

## 坑 4：令牌 30 天过期，不是 55 天

**症状**：连续几天没签到，`checkin_dates` 里出现断档。

**实测**：accessToken 有效期 **30 天**。早期 README 写的 55 天是错的。
本项目 9-23 部署、11-17 到期失效，11-18 断签。

**处理**：跑 `sync-token.bat`，它会把本机最新令牌推上去并自动验证。

**为什么这样能行**：本机 WorkBuddy 桌面端只要在用，就会自己续期令牌并写回本地存储。
所以定期把本机令牌搬到云端即可，不需要任何账号密码。

---

## 排除过、但走不通的路线

**用 refreshToken 在云端自动换新（这条别再试）**

- Keycloak realm：`https://www.codebuddy.cn/auth/realms/copilot`
- token 端点存在，但 `client_id=console`（JWT 里的 `azp` 值）返回 `unauthorized_client`
  —— 说明客户端存在，但属于**机密客户端**，刷新需要 client_secret
- 猜其他名字（copilot / workbuddy / codebuddy / console-web）全是 `invalid_client`
- `client_id=account` 返回 `invalid_grant: Token client and authorized client don't match`

拿不到 client_secret，这条路封死。除非官方开放长期令牌，否则只能靠本机定期同步。

---

## 环境限制

- 本机 `schtasks.exe` 被安全策略拉黑，无法用 Windows 计划任务，改用 WorkBuddy automation
- 本机没有 `gh` CLI
- `wrangler.toml` 里的 `account_id` 占位符**优先级高于**环境变量 `CLOUDFLARE_ACCOUNT_ID`，
  留占位符会直接报 `Invalid account ID`。脚本里要用独立配置绕开
- 用 `spawnSync` 给 wrangler 传 stdin 时**末尾必须带 `\n`**，否则被当作空输入，报 code 10013
