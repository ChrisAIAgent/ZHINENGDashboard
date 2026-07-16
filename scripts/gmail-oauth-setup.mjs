#!/usr/bin/env node
/**
 * Gmail OAuth 2.0 单账号授权设置脚本（企业看板 / Gmail 接入 P0）
 *
 * 作用：
 *   1. 读取 .env 中的 GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REDIRECT_URI
 *   2. 启动本地回调 server（默认 8787），拼出授权 URL 并打开浏览器
 *   3. 用户在浏览器点"允许"后，用授权码换取 access_token + refresh_token
 *   4. 用 AES-256-GCM 加密 refresh_token，落盘到本脚本同目录的 tokens.json
 *   5. 用 access_token 调 Gmail profile 验证连通，打印邮箱地址
 *
 * 前置（Google Cloud Console）：
 *   - 创建 OAuth client ID（Web 应用），重定向 URI 填 http://localhost:8787/oauth/callback
 *   - 同意屏幕把你的 Gmail 加入 Test users
 *   - 复制 .env.example 为 .env，填入 GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET
 *
 * 运行：node scripts/gmail-oauth-setup.mjs
 * 零第三方依赖，仅用 Node 内置模块（Node 18+）。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const TOKENS_PATH = path.join(__dirname, 'tokens.json');

// ---------- 最小 .env 解析（避免引入 dotenv 依赖） ----------
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    if (line.trim().startsWith('#') || !line.trim()) continue;
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv();
const CLIENT_ID = env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = env.GMAIL_CLIENT_SECRET || '';
const REDIRECT_URI = env.GMAIL_REDIRECT_URI || 'http://localhost:8787/oauth/callback';
const SCOPES = (env.GMAIL_SCOPES || 'https://www.googleapis.com/auth/gmail.readonly')
  .split(/\s+/).filter(Boolean);

if (!CLIENT_ID) {
  console.error('✗ 缺少 GMAIL_CLIENT_ID，请在 .env 中配置（参考 .env.example）');
  process.exit(1);
}

// ---------- 代理支持（企业网络/沙箱常需走 HTTP 代理出网） ----------
// Node 内置 fetch (undici) 默认不读 HTTP_PROXY/HTTPS_PROXY，需显式设置 dispatcher。
// 未检测到代理变量时跳过，保持零依赖零副作用（普通家用网络直连即可）。
const PROXY_URL = env.HTTPS_PROXY || env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (PROXY_URL) {
  try {
    const { setGlobalDispatcher, ProxyAgent } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
    console.log('• 检测到代理，fetch 已走代理：', PROXY_URL);
  } catch {
    console.warn('⚠ 检测到代理环境变量但未安装 undici，将尝试直连（可能失败）。如需代理请先在 scripts/ 执行 npm i undici');
  }
}

// ---------- 加密密钥管理（AES-256-GCM） ----------
function getEncKey() {
  let key = env.GMAIL_ENC_KEY;
  if (!key) {
    key = crypto.randomBytes(32).toString('base64');
    fs.appendFileSync(ENV_PATH, `\n# 自动生成的 refresh_token 加密密钥（请勿提交）\nGMAIL_ENC_KEY=${key}\n`);
    env.GMAIL_ENC_KEY = key;
    console.log('• 已生成并保存加密密钥 GMAIL_ENC_KEY 到 .env');
  }
  return Buffer.from(key, 'base64');
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

// ---------- PKCE（桌面应用类型无 secret 时使用） ----------
const state = crypto.randomBytes(16).toString('hex');
const verifier = crypto.randomBytes(64).toString('hex');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const usePkce = !CLIENT_SECRET;

const authParams = new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPES.join(' '),
  access_type: 'offline',
  prompt: 'consent',
  state,
});
if (usePkce) {
  authParams.set('code_challenge', challenge);
  authParams.set('code_challenge_method', 'S256');
}
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

console.log('\n请在浏览器完成授权（若未自动打开，请手动复制）：\n');
console.log(authUrl + '\n');

// 尝试自动打开浏览器（本地有 GUI 时有效）
try {
  const op = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const { exec } = await import('node:child_process');
  exec(`${op} "${authUrl}"`);
} catch { /* 忽略，用户手动打开即可 */ }

// ---------- 本地回调 server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:8787`);
  if (url.pathname !== '/oauth/callback') {
    res.writeHead(404); res.end('not found'); return;
  }
  const code = url.searchParams.get('code');
  const retState = url.searchParams.get('state');
  const err = url.searchParams.get('error');

  if (err) {
    res.writeHead(400); res.end(`授权被拒绝: ${err}`);
    console.error('授权错误:', err); server.close(); return;
  }
  if (retState !== state) {
    res.writeHead(400); res.end('state 不匹配，疑似 CSRF 攻击');
    console.error('state 不匹配'); server.close(); return;
  }
  if (!code) {
    res.writeHead(400); res.end('缺少授权码 code'); server.close(); return;
  }

  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });
    if (usePkce) body.set('code_verifier', verifier);
    else body.set('client_secret', CLIENT_SECRET);

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok) {
      console.error('✗ token 交换失败:', tokens);
      res.writeHead(500); res.end('token 交换失败: ' + JSON.stringify(tokens)); server.close(); return;
    }
    if (!tokens.refresh_token) {
      console.error('✗ 未返回 refresh_token（请确认同意屏幕已发布为生产，或重新授权时带了 prompt=consent）');
      res.writeHead(500); res.end('missing refresh_token'); server.close(); return;
    }

    const payload = {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scopes: SCOPES,
      refresh_token_enc: encrypt(tokens.refresh_token),
      obtained_at: new Date().toISOString(),
    };
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(payload, null, 2));
    console.log('✓ refresh_token 已加密保存至', TOKENS_PATH);

    // 验证连通
    const prof = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profJson = await prof.json();
    if (prof.ok) {
      console.log('✓ 连通成功！邮箱:', profJson.emailAddress, '| 邮件总数:', profJson.messagesTotal);
    } else {
      console.warn('⚠ 取 profile 失败:', profJson);
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>授权成功，可关闭此页面</h2><p>refresh_token 已加密保存，后端即可拉取邮件。</p>');
    server.close();
  } catch (e) {
    console.error('✗ 回调处理异常:', e);
    res.writeHead(500); res.end('server error'); server.close();
  }
});

const port = Number(new URL(REDIRECT_URI).port) || 8787;
server.listen(port, () => console.log(`• 本地回调 server 已启动：http://localhost:${port}/oauth/callback`));
