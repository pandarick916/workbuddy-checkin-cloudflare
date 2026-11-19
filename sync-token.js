// sync-token.js —— 把本机 WorkBuddy 的最新令牌同步到 Cloudflare Worker
//
// 为什么需要：
//   Worker 里的 WORKBUDDY_TOKEN 约 30 天过期（实测 2026-11-17 那次就是到期）。
//   但本机 WorkBuddy 桌面端只要在用，就会自己续期并把新令牌写回本地存储。
//   所以「定期把本机的新令牌推到云端」= 云端永不掉线，且不依赖任何账号密码。
//
// 用法：node sync-token.js [--dry]
// 退出码：0 成功 / 1 失败（便于计划任务判定）

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 配置从 .env.local 读取，不进仓库。
// 这些值（账号 ID / Worker 名 / 子域）不算密钥，但属于账号标识，不该出现在公开仓库里。
// 首次使用：复制 env.example 为 .env.local 再填。
function loadConfig() {
  const file = path.join(__dirname, '.env.local');
  const cfg = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(CF_[A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return {
    accountId: process.env.CF_ACCOUNT_ID || cfg.CF_ACCOUNT_ID,
    workerName: process.env.CF_WORKER_NAME || cfg.CF_WORKER_NAME,
    subdomain: process.env.CF_WORKERS_SUBDOMAIN || cfg.CF_WORKERS_SUBDOMAIN,
  };
}

const CFG = loadConfig();
const WARN_DAYS = 7;
const SECRET_NAME = 'WORKBUDDY_TOKEN';
const DRY = process.argv.includes('--dry');

function log(...a) { console.log(new Date().toLocaleString('zh-CN'), ...a); }
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

if (!CFG.accountId || !CFG.workerName || !CFG.subdomain) {
  fail('缺少配置：在项目目录把 env.example 复制成 .env.local，填好三个值再运行。');
}
const WORKER_NAME = CFG.workerName;
const ACCOUNT_ID = CFG.accountId;
const HEALTH_URL = `https://${CFG.workerName}.${CFG.subdomain}.workers.dev/`;

// 解析 JWT 的 exp，不做签名校验（只用于算剩余天数）
function jwtExp(token) {
  try {
    const seg = token.split('.')[1];
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch (e) { return null; }
}

// 1) 从本机取最新 accessToken
let raw;
try {
  raw = execFileSync('node', [path.join(__dirname, 'get_token.cjs'), '--json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch (e) {
  fail('读取本机令牌失败。确认 WorkBuddy 桌面端已登录并正在运行。');
}
let token;
try { token = JSON.parse(raw).accessToken || ''; } catch (e) { token = ''; }
if (!token || !token.startsWith('eyJ')) fail('取到的令牌格式不对，已中止（避免把空值写进云端）。');

const expMs = jwtExp(token);
const daysLeft = expMs ? Math.floor((expMs - Date.now()) / 86400000) : null;
log(`本机令牌有效期剩余 ${daysLeft == null ? '未知' : daysLeft + ' 天'}`);
if (daysLeft != null && daysLeft <= WARN_DAYS) {
  log(`[注意] 剩余不足 ${WARN_DAYS} 天，可能 WorkBuddy 客户端长时间没刷新，建议打开一次客户端。`);
}

// 2) 写入 Cloudflare Worker secret
// 注意：不能直接在本项目目录跑 wrangler —— wrangler.toml 里的 account_id 是
// 给开源用户看的占位符 <YOUR_CF_ACCOUNT_ID>，配置文件的优先级高于环境变量，
// 会直接报 "Invalid account ID"。所以这里用一份独立的临时配置，不碰仓库文件。
if (DRY) { log('[dry] 跳过写入，仅完成读取与校验。'); process.exit(0); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-token-sync-'));
fs.writeFileSync(path.join(tmpDir, 'wrangler.toml'),
  `name = "${WORKER_NAME}"\naccount_id = "${ACCOUNT_ID}"\n`, 'utf8');

let r, out;
try {
  r = spawnSync('npx', ['--yes', 'wrangler@4', 'secret', 'put', SECRET_NAME], {
    // 末尾必须带换行：wrangler 读 stdin 直到 EOF，缺换行会被判定为空输入
    input: token + '\n',
    encoding: 'utf8',
    shell: true,
    cwd: tmpDir,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  });
  out = ((r.stdout || '') + (r.stderr || '')).replace(/\s+/g, ' ').trim();
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

if (r.status !== 0) {
  fail('写入 Cloudflare secret 失败：' + out.slice(-300) +
    '\n  常见原因：wrangler 登录态失效 → 在项目目录跑一次 npx wrangler login');
}
log('已写入 Cloudflare secret');

// 3) 回读验证：真实调用 Worker，确认它拿到新令牌后能正常返回业务结果
(async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const resp = await fetch(HEALTH_URL, { signal: ctrl.signal });
    const body = await resp.json();
    clearTimeout(timer);
    if (body && body.ok === true) {
      log('云端验证通过：' + ((body.checkin && body.checkin.msg) || '正常'));
      process.exit(0);
    }
    // ok=false 说明令牌写进去了但接口仍有问题，把真实原因打出来
    const err = body.checkinError || body.travelError || JSON.stringify(body).slice(0, 200);
    fail('云端自检未通过：' + err);
  } catch (e) {
    clearTimeout(timer);
    fail('云端自检请求失败：' + e.message);
  }
})();
