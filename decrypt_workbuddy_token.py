#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
解密 WorkBuddy / CodeBuddy 桌面端 `workbuddy-desktop.info` 里的 $wbEncrypted 加密信封，
取出明文 accessToken / refreshToken（JWT），用于自动化签到。

⚠️ 背景（WorkBuddy 5.6.0+）
5.6.0 起，令牌不再以明文字符串写入，而是改成 AES-256-GCM 加密信封：
    "auth": { "accessToken": { "$wbEncrypted": 1, "envelope": "<base64>" }, ... }
信封 base64 解码后是 { suite:1, keyId, nonce, authTag, ciphertext }。
解密密钥 = SHA256(atRestSecretKey 这个字符串本身)，而 atRestSecretKey 由桌面端原生
绑定 `electron_browser_workbuddy_storage` 提供。

算法严格对齐 cockpit-tools v1.3.60 的 workbuddy_auth_crypto.rs：
  key_bytes = SHA256(atRestSecretKey_utf8)            # 32 字节 = AES-256 key
  key_id    = SHA256(key_bytes).hexdigest()[:16]      # 必须等于信封 keyId
  AAD       = b"WB-AAD\0\x01" + 结构化字段(含 key_id)
  plaintext = AES256GCM(key).decrypt(nonce, ct||tag, AAD)

用法：
  # 1) 自测（用假密钥往返加密/解密，验证算法正确，不碰你的真实文件）
  python decrypt_workbuddy_token.py --selftest

  # 2) 自动取密钥并解密（推荐：自动启动本机 WorkBuddy 取出 atRestSecretKey，无需手动操作）
  python decrypt_workbuddy_token.py --auto

  # 3) 手动给 atRestSecretKey（从已登录桌面端控制台取，见下）
  python decrypt_workbuddy_token.py --at-rest-key "<base64字符串>" [--info 路径]
  # 或走环境变量
  set WB_AT_REST_SECRET_KEY=<base64字符串>
  python decrypt_workbuddy_token.py

  # 只打印 accessToken（方便管道写入 Secret / 剪贴板）
  python decrypt_workbuddy_token.py --auto --token-only

输出：默认打印 JSON {"accessToken": "...", "refreshToken": "..."}；
      加 --token-only 只打印 accessToken 字符串。

怎么拿到 atRestSecretKey（仅当你不用 --auto 时才需要手动取，一次性，令牌约 55 天过期后重做）：
  打开已登录的 WorkBuddy/CodeBuddy 桌面端 → 打开开发者工具控制台（Ctrl+Shift+I，
  或菜单里的 Developer/Console）→ 粘贴下面这行并回车，复制输出：
    JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()).atRestSecretKey
  把它作为 --at-rest-key 传给本脚本即可。
（本仓库的 --auto 模式会自动执行等价操作，无需你手动复制。）
"""
import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys

DEFAULT_INFO = os.path.join(
    os.environ.get("LOCALAPPDATA", ""),
    "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"
)

# 在 WorkBuddy 本体里执行，调原生绑定取 atRestSecretKey（与 cockpit-tools KEY_SCRIPT 等价）。
# 注意：只输出 atRestSecretKey 字符串本身，不碰派生 key，也不写日志。
GETKEY_JS = r"""
try {
  const p = JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
  if (p.version !== 1 || typeof p.atRestSecretKey !== 'string') { process.exit(2); }
  process.stdout.write(p.atRestSecretKey);
} catch (e) { process.stderr.write('ERR: ' + (e && e.stack || e)); process.exit(3); }
"""

# 本机 WorkBuddy 可执行文件候选路径（--auto 用）；可用环境变量 WB_EXE 覆盖。
WB_EXE_CANDIDATES = [
    os.environ.get("WB_EXE", ""),
    r"D:\applications\WorkBuddy\WorkBuddy.exe",
    r"C:\Program Files\WorkBuddy\WorkBuddy.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "WorkBuddy", "WorkBuddy.exe"),
    os.path.join(os.environ.get("ProgramFiles", ""), "WorkBuddy", "WorkBuddy.exe"),
]


def b64dec(s: str) -> bytes:
    return base64.b64decode(s)


def b64enc(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def derive_key(at_rest_secret_key: str):
    """key_bytes = SHA256(atRestSecretKey 字符串 utf-8)；key_id 用于校验信封。"""
    key_bytes = hashlib.sha256(at_rest_secret_key.encode("utf-8")).digest()  # 32 bytes
    key_id = hashlib.sha256(key_bytes).hexdigest()[:16]
    return key_bytes, key_id


def build_aad(key_id: str) -> bytes:
    b = b"WB-AAD\x00\x01"
    for value in ["WBEV1", "sym-v1"]:
        b += len(value).to_bytes(4, "big")
        b += value.encode("ascii")
    b += (1).to_bytes(4, "big")
    b += len(key_id).to_bytes(4, "big")
    b += key_id.encode("ascii")
    b += bytes([2, 0, 0])
    return b


def _aead():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM


def decrypt_envelope(envelope_b64: str, key_bytes: bytes, key_id: str) -> str:
    env = json.loads(b64dec(envelope_b64))
    if env.get("suite") != 1:
        raise ValueError(f"不支持的 suite: {env.get('suite')}")
    if env.get("keyId") != key_id:
        raise ValueError(f"keyId 不匹配：信封={env.get('keyId')} 派生={key_id}")
    nonce = b64dec(env["nonce"])
    tag = b64dec(env["authTag"])
    ct = b64dec(env["ciphertext"])
    if len(nonce) != 12 or len(tag) != 16:
        raise ValueError("nonce/tag 长度异常")
    aad = build_aad(key_id)
    aes = _aead()(key_bytes)
    pt = aes.decrypt(nonce, ct + tag, aad)
    return pt.decode("utf-8")


def seal(plaintext: str, key_bytes: bytes, key_id: str) -> str:
    """对应 Rust 的 seal()，仅用于自测往返验证。"""
    nonce = os.urandom(12)
    aad = build_aad(key_id)
    aes = _aead()(key_bytes)
    sealed = aes.encrypt(nonce, plaintext.encode("utf-8"), aad)  # ct||tag
    split = len(sealed) - 16
    env = {
        "suite": 1,
        "keyId": key_id,
        "nonce": b64enc(nonce),
        "authTag": b64enc(sealed[split:]),
        "ciphertext": b64enc(sealed[:split]),
    }
    return b64enc(json.dumps(env, separators=(",", ":")).encode("utf-8"))


def node_to_token(node, key_bytes, key_id):
    """输入 auth.accessToken / refreshToken 字段：明文串直接返回；加密信封则解密。"""
    if isinstance(node, str):
        return node
    if isinstance(node, dict) and node.get("$wbEncrypted") == 1:
        return decrypt_envelope(node["envelope"], key_bytes, key_id)
    return None


def extract_tokens(info_path: str, at_rest_secret_key: str) -> dict:
    key_bytes, key_id = derive_key(at_rest_secret_key)
    with open(info_path, encoding="utf-8") as f:
        d = json.load(f)
    out = {}
    # 优先顶层明文（旧版/部分环境仍有），否则解密 auth.*
    for field in ("accessToken", "refreshToken"):
        val = None
        if field in d and isinstance(d[field], str):
            val = d[field]
        else:
            val = node_to_token(d.get("auth", {}).get(field), key_bytes, key_id)
        if val:
            out[field] = val
    return out


def find_wb_exe() -> str:
    for p in WB_EXE_CANDIDATES:
        if p and os.path.isfile(p):
            return p
    return ""


def get_at_rest_secret_key(exe: str) -> str:
    """用 ELECTRON_RUN_AS_NODE 启动 WorkBuddy 本体执行原生绑定，取 atRestSecretKey。"""
    env = dict(os.environ)
    env["ELECTRON_RUN_AS_NODE"] = "1"
    env.pop("NODE_OPTIONS", None)
    r = subprocess.run(
        [exe, "-e", GETKEY_JS],
        capture_output=True, env=env, timeout=40,
    )
    key = r.stdout.decode("utf-8", "replace").strip()
    if not key:
        err = r.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(
            f"无法从 WorkBuddy 取 atRestSecretKey（exit={r.returncode}）。"
            f"{err[:300]}\n请确认 WorkBuddy 已安装并至少登录过一次；"
            f"或改用 --at-rest-key 手动传入。"
        )
    return key


def selftest():
    import os as _os
    # 造一个假 atRestSecretKey（base64 字符串，解码后 32 字节）
    fake = b64enc(_os.urandom(32))
    key_bytes, key_id = derive_key(fake)
    sample_jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    env_b64 = seal(sample_jwt, key_bytes, key_id)
    got = decrypt_envelope(env_b64, key_bytes, key_id)
    assert got == sample_jwt, "往返解密不一致！"
    assert len(key_id) == 16
    assert key_id == hashlib.sha256(key_bytes).hexdigest()[:16]
    print("[selftest] ✅ AES-256-GCM 信封往返解密通过（算法与 cockpit-tools 对齐）")
    print(f"[selftest] 派生 key_id = {key_id}")


def main():
    ap = argparse.ArgumentParser(description="解密 WorkBuddy 桌面端加密令牌")
    ap.add_argument("--info", default=DEFAULT_INFO, help="workbuddy-desktop.info 路径")
    ap.add_argument("--at-rest-key", default=os.environ.get("WB_AT_REST_SECRET_KEY", ""),
                    help="atRestSecretKey（base64 字符串），或用环境变量 WB_AT_REST_SECRET_KEY")
    ap.add_argument("--auto", action="store_true",
                    help="自动启动本机 WorkBuddy 取 atRestSecretKey（无需手动复制）")
    ap.add_argument("--token-only", action="store_true", help="只打印 accessToken 字符串")
    ap.add_argument("--selftest", action="store_true", help="用假密钥做往返自测")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return

    if not os.path.isfile(args.info):
        sys.exit(f"✗ 找不到 info 文件: {args.info}")

    at_rest_key = args.at_rest_key
    if args.auto:
        exe = find_wb_exe()
        if not exe:
            sys.exit("✗ 找不到 WorkBuddy 可执行文件。请用 WB_EXE 环境变量指定，"
                     "或改用 --at-rest-key 手动传入（见文件顶部说明）。")
        try:
            at_rest_key = get_at_rest_secret_key(exe)
        except Exception as e:
            sys.exit(f"✗ 自动取密钥失败: {e}")
    elif not at_rest_key:
        sys.exit("✗ 缺少 atRestSecretKey：用 --auto 自动取，或用 --at-rest-key / 环境变量 WB_AT_REST_SECRET_KEY 提供。"
                 "\n  来源：在已登录桌面端的开发者控制台执行"
                 " JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()).atRestSecretKey")

    try:
        tokens = extract_tokens(args.info, at_rest_key)
    except Exception as e:
        sys.exit(f"✗ 解密失败: {e}")
    if not tokens:
        sys.exit("✗ 未提取到令牌（文件里没有 accessToken/refreshToken，或 key 不对）")

    if args.token_only:
        # 只输出 accessToken，方便管道 / 剪贴板
        print(tokens.get("accessToken", ""))
    else:
        print(json.dumps(tokens, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
