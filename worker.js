// worker.js — WorkBuddy 每日签到（Cloudflare Worker Cron 版，确定性触发）
// 设计：用 CF Cron（确定性）替代 GitHub 不可靠的 schedule，直接调 WorkBuddy 接口签到。
// 令牌存于 CF Secret: WORKBUDDY_TOKEN（本机 workbuddy-desktop.info 的 auth.accessToken，约55天过期需重拷）
// 触发：wrangler.toml 中 crons = ["0 2 * * *"] 即每日 UTC 02:00 = 北京 10:00（可改任意时间）

const CHECKIN_BASE = "https://www.codebuddy.cn/v2";
const TRAVEL_BASE  = "https://www.workbuddy.cn";
const UA = "WorkBuddy-Checkin-CF/1.0";

async function apiCall(base, path, token, method = "POST", payload = {}) {
  const url = base + path;
  const init = {
    method,
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": UA,
    },
  };
  if (method !== "GET") init.body = JSON.stringify(payload);
  const resp = await fetch(url, init);
  let body = null;
  try { body = await resp.json(); } catch (e) { body = { raw: await resp.text() }; }
  return { status: resp.status, body };
}

function extractBalance(...bodies) {
  const keys = ["total_credits","total_credit","total_credit_balance","total_points",
    "points_balance","credit_balance","balance","remain_credit","remain","score",
    "credits","integral","totalCredit","pointsBalance","balanceCredit"];
  for (const body of bodies) {
    if (!body || typeof body !== "object") continue;
    for (const sec of ["", "data", "result", "data.result"]) {
      let node = body;
      if (sec) for (const part of sec.split(".")) {
        node = (node && typeof node === "object") ? node[part] : null;
        if (node === null) break;
      }
      if (!node || typeof node !== "object") node = (sec === "" ? body : null);
      if (!node || typeof node !== "object") continue;
      for (const k of keys) { const v = node[k]; if (typeof v === "number") return v; }
    }
  }
  return null;
}

async function doCheckin(token) {
  const out = {};
  const st = await apiCall(CHECKIN_BASE, "/billing/meter/checkin-activity-status", token, "POST", {});
  out.statusHttp = st.status;
  out.statusResp = st.body;
  out.balance = extractBalance(st.body);
  let todaySigned = false;
  if (st.body && typeof st.body === "object") {
    if (st.body.today_checked_in === true) todaySigned = true;
    else if (st.body.data && st.body.data.today_checked_in === true) todaySigned = true;
    else if (String(st.body.code) === "10001") todaySigned = true;
  }
  if (todaySigned) { out.checkin = "skip_already_signed"; out.msg = "今日已签到，无需重复领取"; return out; }
  const ck = await apiCall(CHECKIN_BASE, "/billing/meter/daily-checkin", token, "POST", {});
  out.checkinHttp = ck.status;
  out.checkinResp = ck.body;
  if (ck.body && typeof ck.body === "object") {
    const code = String(ck.body.code ?? "");
    const msg = ck.body.msg || ck.body.message || "";
    if (code === "10001" || msg.includes("已签到") || msg.includes("今天已签到")) {
      out.checkin = "skip_already_signed"; out.msg = "今日已签到（code=10001）"; return out;
    }
    const okCode = code === "" || code === "0" || code === "200";
    if (ck.status >= 200 && ck.status < 300 && okCode) {
      const credit = ck.body.credit || (ck.body.data && ck.body.data.credit) ||
        (ck.body.data && ck.body.data.daily_credit) || (ck.body.data && ck.body.data.today_credit);
      const streak = ck.body.streak_days || (ck.body.data && ck.body.data.streak_days);
      const bal = extractBalance(ck.body);
      if (bal != null) out.balance = bal;
      out.checkin = "clicked"; out.points = credit; out.streak = streak;
      out.msg = "领取成功" + (credit ? "，+" + credit + " 积分" : "") + (streak ? "，连续第 " + streak + " 天" : "");
      return out;
    }
    out.checkin = "failed"; out.msg = msg || ("HTTP " + ck.status + "（业务码 " + code + "）"); return out;
  }
  out.checkin = "failed"; out.msg = "领取接口返回非 JSON"; return out;
}

async function travelAuto(token) {
  const get = async (path) => {
    const r = await apiCall(TRAVEL_BASE, path, token, "GET");
    return (r.status === 200 && r.body && r.body.code === 0) ? r.body.data : null;
  };
  const status = await get("/activity/growth/buddy/travel/status");
  if (!status) return { available: false, log: ["查询旅行状态失败，跳过"] };
  const log = [];
  if (status.state === "arrived") {
    const c = await apiCall(TRAVEL_BASE, "/activity/growth/buddy/travel/claim", token, "POST", {});
    if (c.status === 200 && c.body && c.body.code === 0)
      log.push("已领取旅行奖励 +" + ((c.body.data && c.body.data.reward_credit) || "?"));
  }
  if (status.daily_limit_reached) log.push("今日派遣次数已用完");
  else if (!status.state || status.state === "idle") {
    const cfg = await get("/activity/growth/buddy/travel/config") || {};
    const ids = (cfg.locations || []).map(l => l.id).filter(x => x != null);
    const loc = ids.length ? ids[Math.floor(Math.random() * ids.length)] : null;
    if (loc != null) {
      const dp = await apiCall(TRAVEL_BASE, "/activity/growth/buddy/travel/depart", token, "POST", { location_id: loc });
      if (dp.status === 200 && dp.body && dp.body.code === 0)
        log.push("已派出前往 " + ((dp.body.data && dp.body.data.location && dp.body.data.location.name) || ("地点" + loc)));
      else log.push("派遣失败");
    } else log.push("无可选地点，跳过派遣");
  } else log.push("Buddy 旅行中，无需派遣");
  return { available: true, log };
}

async function runAll(token) {
  const result = { ok: true, ts: new Date().toISOString() };
  try { result.checkin = await doCheckin(token); }
  catch (e) { result.ok = false; result.checkinError = String(e); }
  try { result.travel = await travelAuto(token); }
  catch (e) { result.ok = false; result.travelError = String(e); }
  result.balance = result.checkin && result.checkin.balance;
  result.msg = ((result.checkin && result.checkin.msg) || "") +
    (result.travel && result.travel.log ? " ｜ 派猫猫旅行：" + result.travel.log.join("，") : "");
  return result;
}

export default {
  async scheduled(event, env, ctx) {
    const token = (env.WORKBUDDY_TOKEN || "").trim();
    if (!token) { console.error("缺少 WORKBUDDY_TOKEN"); return; }
    ctx.waitUntil(runAll(token).then(r => console.log(JSON.stringify(r))).catch(e => console.error(String(e))));
  },
  async fetch(request, env) {
    const token = (env.WORKBUDDY_TOKEN || "").trim();
    if (!token) return new Response("缺少 WORKBUDDY_TOKEN 环境变量", { status: 500 });
    const r = await runAll(token);
    return new Response(JSON.stringify(r, null, 2), { headers: { "content-type": "application/json" } });
  },
};
