#!/usr/bin/env node
/*
 * 取 WorkBuddy / CodeBuddy 桌面端登录令牌（5.6.0+ 加密信封版）。
 *
 * 原理：WorkBuddy 5.6.0 起把 accessToken / refreshToken 写成 AES-256-GCM 加密信封
 * （$wbEncrypted）。解密密钥 = SHA256(atRestSecretKey 字符串)，而 atRestSecretKey 由桌面端
 * 原生绑定 electron_browser_workbuddy_storage 提供。本脚本自动启动本机 WorkBuddy 本体
 * （ELECTRON_RUN_AS_NODE=1）执行该绑定取出 atRestSecretKey，再解密 workbuddy-desktop.info。
 *
 * 用法：
 *   node get_token.cjs                 # 打印 accessToken（可直接复制进 Secret）
 *   node get_token.cjs --refresh       # 打印 refreshToken
 *   node get_token.cjs --json          # 打印 { accessToken, refreshToken }
 *   node get_token.cjs --clip          # 复制到剪贴板（Windows）
 *
 * 需要本机已安装并至少登录过一次 WorkBuddy 桌面端。可用环境变量 WB_EXE 指定其 exe 路径。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 1) 取 atRestSecretKey 的脚本（在 WorkBuddy 本体里跑）
const GETKEY_JS = `
try {
  const p = JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
  if (p.version !== 1 || typeof p.atRestSecretKey !== 'string') { process.exit(2); }
  process.stdout.write(p.atRestSecretKey);
} catch (e) { process.stderr.write('ERR: ' + (e && e.stack || e)); process.exit(3); }
`;

function detectRunningWb() {
  // 粉丝正用着 WorkBuddy，从运行进程取 exe 路径最可靠（不依赖安装位置）
  try {
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      '(Get-Process WorkBuddy -ErrorAction SilentlyContinue).Path',
    ], { encoding: 'utf8', timeout: 8000 });
    if (r.stdout) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const p = line.trim();
        if (p.toLowerCase().endsWith('workbuddy.exe') && fs.existsSync(p)) return p;
      }
    }
  } catch (_) {}
  return '';
}

function findWbExe() {
  const found = [];
  if (process.env.WB_EXE) found.push(process.env.WB_EXE);
  const running = detectRunningWb();
  if (running) found.push(running); // 进程路径优先
  const localApp = process.env.LOCALAPPDATA;
  const bases = [
    localApp,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter(Boolean);
  for (const b of bases) {
    if (b === localApp) {
      found.push(path.join(b, 'WorkBuddy', 'WorkBuddy.exe'));
      found.push(path.join(b, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'));
    } else {
      found.push(path.join(b, 'WorkBuddy', 'WorkBuddy.exe'));
    }
  }
  for (const p of found) if (p && fs.existsSync(p)) return p;
  return '';
}

function getAtRestSecretKey(exe) {
  const r = spawnSync(exe, ['-e', GETKEY_JS], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 40000,
  });
  if (r.error) throw r.error;
  const key = (r.stdout || '').trim();
  if (!key) throw new Error('无法取 atRestSecretKey：' + ((r.stderr || '').slice(0, 300)));
  return key;
}

function deriveKey(s) {
  const keyBytes = crypto.createHash('sha256').update(s, 'utf8').digest();
  const keyId = crypto.createHash('sha256').update(keyBytes).digest('hex').slice(0, 16);
  return { keyBytes, keyId };
}

function buildAad(keyId) {
  const parts = [];
  // b"WB-AAD\0\x01"
  parts.push(Buffer.from([0x57, 0x42, 0x2d, 0x41, 0x41, 0x44, 0x00, 0x01]));
  for (const v of ['WBEV1', 'sym-v1']) {
    const vb = Buffer.from(v, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(vb.length, 0);
    parts.push(len, vb);
  }
  const one = Buffer.alloc(4);
  one.writeUInt32BE(1, 0);
  parts.push(one);
  const kib = Buffer.from(keyId, 'ascii');
  const klen = Buffer.alloc(4);
  klen.writeUInt32BE(kib.length, 0);
  parts.push(klen, kib);
  parts.push(Buffer.from([2, 0, 0]));
  return Buffer.concat(parts);
}

function decryptEnvelope(envB64, keyBytes, keyId) {
  const env = JSON.parse(Buffer.from(envB64, 'base64').toString('utf8'));
  if (env.suite !== 1) throw new Error('不支持的 suite: ' + env.suite);
  if (env.keyId !== keyId) throw new Error('keyId 不匹配：' + env.keyId + ' vs ' + keyId);
  const nonce = Buffer.from(env.nonce, 'base64');
  const tag = Buffer.from(env.authTag, 'base64');
  const ct = Buffer.from(env.ciphertext, 'base64');
  const aad = buildAad(keyId);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

function nodeToToken(node, keyBytes, keyId) {
  if (typeof node === 'string') return node;
  if (node && node.$wbEncrypted === 1) return decryptEnvelope(node.envelope, keyBytes, keyId);
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const wantRefresh = args.includes('--refresh');
  const asJson = args.includes('--json');
  const toClip = args.includes('--clip');

  const exe = findWbExe();
  if (!exe) {
    console.error('✗ 找不到 WorkBuddy 可执行文件。请用 WB_EXE 环境变量指定，或改用 decrypt_workbuddy_token.py。');
    process.exit(1);
  }

  let atRestKey;
  try {
    atRestKey = getAtRestSecretKey(exe);
  } catch (e) {
    console.error('✗ 取 atRestSecretKey 失败：' + e.message);
    process.exit(1);
  }

  const { keyBytes, keyId } = deriveKey(atRestKey);

  const infoPath = path.join(
    process.env.LOCALAPPDATA || '',
    'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'
  );
  if (!fs.existsSync(infoPath)) {
    console.error('✗ 找不到登录文件: ' + infoPath);
    process.exit(1);
  }
  const d = JSON.parse(fs.readFileSync(infoPath, 'utf8'));

  const pick = (field) => {
    if (typeof d[field] === 'string') return d[field];           // 顶层明文（旧版/部分环境）
    return nodeToToken(d.auth && d.auth[field], keyBytes, keyId);  // 5.6.0+ 加密信封
  };

  const accessToken = pick('accessToken');
  const refreshToken = pick('refreshToken');
  if (!accessToken && !refreshToken) {
    console.error('✗ 未提取到令牌（文件无 accessToken/refreshToken，或 key 不对）。');
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify({ accessToken, refreshToken }, null, 2));
    return;
  }
  const token = wantRefresh ? refreshToken : accessToken;
  if (toClip && process.platform === 'win32') {
    try {
      const { spawnSync: sp } = require('child_process');
      sp('clip', [], { input: token });
      console.error('✓ accessToken 已复制到剪贴板');
      return;
    } catch (_) { /* fall through to print */ }
  }
  process.stdout.write(token || '');
  if (!toClip) process.stdout.write('\n');
}

main();
