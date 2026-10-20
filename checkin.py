#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkBuddy 每日签到 · 云端无状态版（GitHub Actions / 任意 CI 可跑）
只依赖 Python 标准库。token 从环境变量 WORKBUDDY_TOKEN 读取，绝不硬编码。

原理与本地接口版完全一致（已实测）：
  1. 查询今日签到状态  GET/POST {base}/billing/meter/checkin-activity-status
  2. 若今日未签到，调用 POST {base}/billing/meter/daily-checkin 领取（100 积分/天）
  3. 已签到 / 接口返回 code=10001 则安全跳过，不做重复领取（幂等）

环境变量：
  WORKBUDDY_TOKEN   必填，登录态 accessToken（从本机 workbuddy-desktop.info 取一次）
  WORKBUDDY_DOMAIN  选填，默认 www.codebuddy.cn

用法：
  WORKBUDDY_TOKEN=xxx python checkin.py
退出码：成功 0 / 失败 1（便于 Action 判定是否告警）
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

DOMAIN = os.environ.get("WORKBUDDY_DOMAIN") or "www.codebuddy.cn"
STATUS_PATH = "/billing/meter/checkin-activity-status"
CHECKIN_PATH = "/billing/meter/daily-checkin"
HTTP_TIMEOUT = 10
MAX_RETRY = 1


def get_token():
    t = os.environ.get("WORKBUDDY_TOKEN")
    if not t:
        raise RuntimeError("缺少环境变量 WORKBUDDY_TOKEN（请在仓库 Secrets 中配置）")
    return t


def mask(t):
    return (t[:6] + "..." + t[-4:]) if t and len(t) > 10 else "<empty>"


def decode_jwt_exp(token):
    """Decode exp (UTC epoch seconds) from a JWT payload WITHOUT verifying the
    signature. Best-effort; returns int or None. Used only to warn before the
    token dies so the user knows to re-copy. Never raises."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        seg = parts[1]
        seg += "=" * (-len(seg) % 4)  # base64url padding fix
        payload = json.loads(base64.urlsafe_b64decode(seg).decode("utf-8", "replace"))
        exp = payload.get("exp")
        return int(exp) if isinstance(exp, (int, float)) else None
    except Exception:
        return None


def api_call(base, path, tok, payload=None, method="POST"):
    url = base + path
    data = None if method == "GET" else json.dumps(
        payload if payload is not None else {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer %s" % tok)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "WorkBuddy-Checkin-Cloud/1.0")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            body = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(body)
            except json.JSONDecodeError:
                return resp.status, {"raw": body}
    except urllib.error.HTTPError as e:
        try:
            b = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(b)
            except json.JSONDecodeError:
                return e.code, {"raw": b}
        except Exception:
            return e.code, {"raw": ""}


def extract_balance(*bodies):
    keys = ("total_credits", "total_credit", "total_credit_balance",
            "total_points", "points_balance", "credit_balance", "balance",
            "remain_credit", "remain", "score", "credits", "integral",
            "totalCredit", "pointsBalance", "balanceCredit")
    for body in bodies:
        if not isinstance(body, dict):
            continue
        for sec in ("", "data", "result", "data.result"):
            node = body
            for part in (sec.split(".") if sec else []):
                node = node.get(part) if isinstance(node, dict) else None
                if node is None:
                    break
            if not isinstance(node, dict):
                node = body if sec == "" else None
            if not isinstance(node, dict):
                continue
            for k in keys:
                v = node.get(k)
                if isinstance(v, (int, float)):
                    return v
    return None


def do_checkin(base, tok):
    result = {"status": "unknown", "action": None, "points": None,
              "balance": None, "msg": "", "detail": {}}
    attempt = 0
    last_err = None
    while attempt <= MAX_RETRY:
        attempt += 1
        try:
            st_code, st_body = api_call(base, STATUS_PATH, tok)
            result["detail"]["status_http"] = st_code
            result["balance"] = extract_balance(st_body)

            today_signed = False
            if isinstance(st_body, dict):
                if st_body.get("today_checked_in") is True:
                    today_signed = True
                elif st_body.get("data", {}).get("today_checked_in") is True:
                    today_signed = True
                elif str(st_body.get("code")) == "10001":
                    today_signed = True

            if today_signed:
                bal = (", 当前积分余额 %s" % result["balance"]) if result.get("balance") is not None else ""
                result.update(status="ok", action="skip_already_signed",
                              msg="今日已签到，无需重复领取" + bal)
                return result

            ck_code, ck_body = api_call(base, CHECKIN_PATH, tok)
            result["detail"]["checkin_http"] = ck_code
            result["detail"]["checkin_resp"] = ck_body

            if isinstance(ck_body, dict):
                code = str(ck_body.get("code", ""))
                msg = ck_body.get("msg") or ck_body.get("message") or ""
                data = ck_body.get("data") if isinstance(ck_body.get("data"), dict) else {}
                if code == "10001" or "已签到" in msg or "今天已签到" in msg:
                    result.update(status="ok", action="skip_already_signed",
                                  msg="今日已签到（接口返回 code=10001）")
                    return result
                success_code = code in ("", "0", "200")
                if 200 <= ck_code < 300 and success_code:
                    credit = (ck_body.get("credit") or data.get("credit")
                              or data.get("daily_credit") or data.get("today_credit"))
                    streak = ck_body.get("streak_days") or data.get("streak_days")
                    bbal = extract_balance(ck_body)
                    if bbal is not None:
                        result["balance"] = bbal
                        result["detail"]["balance"] = bbal
                    bal = (", 当前积分余额 %s" % result["balance"]) if result.get("balance") is not None else ""
                    result.update(status="ok", action="clicked", points=credit,
                                  msg="领取成功" + (("，+%s 积分" % credit) if credit else "")
                                       + (("，连续第 %s 天" % streak) if streak else "") + bal)
                    result["detail"]["streak_days"] = streak
                    return result
                result.update(status="error", action="failed",
                              msg=msg or ("HTTP %s（业务码 %s）" % (ck_code, code)))
                return result
            result.update(status="error", action="failed",
                          msg="领取接口返回非 JSON: %s" % ck_body.get("raw", "")[:200])
            return result
        except urllib.error.HTTPError as e:
            last_err = "HTTP %s: %s" % (e.code, e.reason)
        except urllib.error.URLError as e:
            last_err = "网络错误: %s" % e.reason
        except Exception as e:
            last_err = "异常: %s" % e
        if attempt <= MAX_RETRY:
            time.sleep(2)
    result.update(status="error", msg="重试 %d 次后仍失败: %s" % (MAX_RETRY, last_err))
    return result


def main():
    try:
        tok = get_token()
    except Exception as e:
        print(json.dumps({"status": "error", "msg": str(e)}, ensure_ascii=False))
        sys.exit(1)
    base = "https://%s/v2" % DOMAIN
    print("domain=%s token=%s" % (DOMAIN, mask(tok)))

    # 提前预警：accessToken 有寿命（本机实测约 55 天），过期前提醒用户重拷，
    # 避免某天静默失败还以为是脚本坏了。
    exp = decode_jwt_exp(tok)
    if exp:
        left = exp - int(time.time())
        if left <= 0:
            print(json.dumps({"status": "error",
                              "msg": "accessToken 已过期，请从本机 workbuddy-desktop.info 重新复制 accessToken 到 GitHub Secrets(WORKBUDDY_TOKEN)"},
                             ensure_ascii=False))
            sys.exit(1)
        if left <= 7 * 86400:
            sys.stderr.write(
                "[warn] accessToken 约 %d 天后过期（%s UTC），请提前从本机 workbuddy-desktop.info 重新复制 WORKBUDDY_TOKEN\n"
                % (left // 86400, time.strftime("%Y-%m-%d", time.gmtime(exp))))

    res = do_checkin(base, tok)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    sys.exit(0 if res.get("status") == "ok" else 1)


if __name__ == "__main__":
    main()
