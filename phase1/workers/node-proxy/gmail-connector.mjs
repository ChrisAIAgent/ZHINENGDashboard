// gmail-connector.mjs — 企业看板 Gmail API 接入（单账号 OAuth 2.0）
//
// 职责：
//   1. 读取 scripts/tokens.json（refresh_token 已 AES-256-GCM 加密）
//   2. 用 GMAIL_ENC_KEY (.env) 解密 refresh_token，换 access_token（带缓存）
//   3. 拉取最近 N 天的 Gmail thread（format=full），解析为归一化消息
//   4. 给每条消息打 conversationId = threadId，使上层 buildTicketStore 直接复用
//
// 设计要点：
//   - 用 Gmail 原生 threadId 做会话聚合（比 References 链更准，跨转发/改主题不丢）
//   - 通过 undici ProxyAgent 支持企业网络/沙箱代理出网（检测到 HTTPS_PROXY 时启用）
//   - 零 IMAP 依赖；单账号 MVP，MailboxConnector 抽象预留多账号扩展
//
// 运行要求：node-proxy 目录已 npm i undici；项目根 .env 含 GMAIL_ENC_KEY / GMAIL_CLIENT_ID

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..'); // node-proxy -> workers -> phase1 -> root
const TOKENS_PATH = process.env.GMAIL_TOKENS_PATH || path.join(PROJECT_ROOT, 'scripts', 'tokens.json');
const ENV_PATH = process.env.GMAIL_ENV_PATH || path.join(PROJECT_ROOT, '.env');

// ---------- .env 解析 ----------
function loadEnv() {
  const out = {};
  try {
    if (!fs.existsSync(ENV_PATH)) return out;
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      if (line.trim().startsWith('#') || !line.trim()) continue;
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
  return out;
}
const env = loadEnv();
const ENC_KEY = env.GMAIL_ENC_KEY || process.env.GMAIL_ENC_KEY;
const CLIENT_ID = env.GMAIL_CLIENT_ID || process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = env.GMAIL_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || '';
const REDIRECT_URI = env.GMAIL_REDIRECT_URI || 'http://localhost:8787/oauth/callback';

// ---------- 代理支持（企业网络/沙箱常需走 HTTP 代理出网） ----------
// Node 内置 fetch (undici) 默认不读 HTTP_PROXY/HTTPS_PROXY，需显式设置 dispatcher。
const PROXY_URL = env.HTTPS_PROXY || env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (PROXY_URL) {
  try {
    const { setGlobalDispatcher, ProxyAgent } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
    console.log('[gmail-connector] 检测到代理，fetch 已走代理：', PROXY_URL);
  } catch (e) {
    console.warn('[gmail-connector] 代理启用失败（将尝试直连）：', e.message);
  }
}

// ---------- refresh_token 解密 ----------
function decrypt(encB64) {
  const buf = Buffer.from(encB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENC_KEY, 'base64'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ---------- access_token（带缓存） ----------
let _tokenCache = null;
export async function getAccessToken() {
  if (_tokenCache && _tokenCache.expiry > Date.now() + 60000) return _tokenCache.access_token;
  if (!fs.existsSync(TOKENS_PATH)) throw new Error('tokens.json 不存在，请先运行 scripts/gmail-oauth-setup.mjs 完成授权');
  const raw = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  if (!raw.refresh_token_enc) throw new Error('tokens.json 缺少 refresh_token_enc');
  if (!ENC_KEY) throw new Error('GMAIL_ENC_KEY 缺失，请检查项目根 .env');
  const refresh_token = decrypt(raw.refresh_token_enc);
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token,
    grant_type: 'refresh_token',
  });
  const r = await fetchWithRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('refresh_token 交换失败 HTTP ' + r.status + ': ' + JSON.stringify(j).slice(0, 200));
  _tokenCache = { access_token: j.access_token, expiry: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return j.access_token;
}

// ---------- 带重试的 fetch（应对代理偶发 ECONNRESET / 超时） ----------
async function fetchWithRetry(url, opts, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise(res => setTimeout(res, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- Gmail API 封装 ----------
async function gmailFetch(subpath, params) {
  const token = await getAccessToken();
  let url = 'https://gmail.googleapis.com/gmail/v1/users/me/' + subpath;
  if (params) url += '?' + new URLSearchParams(params).toString();
  const r = await fetchWithRetry(url, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('Gmail ' + subpath + ' HTTP ' + r.status + ': ' + txt.slice(0, 200));
  }
  return r.json();
}

// ---------- 邮件头解析 ----------
function parseAddress(header) {
  if (!header) return { name: '', address: '' };
  const m = header.match(/<([^>]+)>/);
  if (m) {
    const address = m[1].trim();
    const name = header.slice(0, m.index).replace(/["']/g, '').trim();
    return { name, address };
  }
  return { name: '', address: header.trim() };
}
function parseAddressList(header) {
  if (!header) return [];
  return header.split(',').map(s => s.trim()).filter(Boolean).map(parseAddress);
}

// ---------- 字符集识别与解码 ----------
function getCharset(payload) {
  const mt = payload?.mimeType || '';
  let m = mt.match(/charset=([^;\s"']+)/i);
  if (m) return m[1];
  const ct = (payload?.headers || []).find(h => h.name.toLowerCase() === 'content-type');
  if (ct) { m = ct.value.match(/charset=([^;\s"']+)/i); if (m) return m[1]; }
  return 'utf-8';
}

// 按邮件声明的 charset 解码 base64url 正文。
// 关键点：Gmail 的 body.data 只解码了传输编码(quoted-printable/base64)，
// 不做 charset 转码；中文邮件常用 GBK/GB2312/Big5，必须显式转码，否则按 UTF-8 硬解会乱码。
function decodeBytes(data, charset) {
  let buf;
  try { buf = Buffer.from(data, 'base64url'); } catch { return ''; }
  const cs = (charset || 'utf-8').toLowerCase().replace(/["']/g, '').trim();
  if (cs === 'utf-8' || cs === 'utf8' || cs === '') return buf.toString('utf8');
  try {
    // Node 内置 TextDecoder（full-icu）支持 gbk / gb2312 / gb18030 / big5 等
    return new TextDecoder(cs.replace(/^x-/, '')).decode(buf);
  } catch {
    try { return buf.toString('utf8'); } catch { return ''; }
  }
}

// 解码邮件头 RFC 2047 编码（=?charset?B?xxx?= / =?charset?Q?xxx?=）。
// Gmail 对部分 UTF-8 头已解码，但 GB2312/Big5 的 RFC2047 仍可能原样返回，需手动解。
function decodeRfc2047(str) {
  if (!str || !str.includes('=?')) return str || '';
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    try {
      const charset = cs.trim().toLowerCase();
      let buf;
      if (enc.toUpperCase() === 'B') buf = Buffer.from(data, 'base64');
      else buf = Buffer.from(data.replace(/_/g, ' '), 'ascii'); // Q 编码用 _ 代空格
      if (charset.includes('utf-8')) return buf.toString('utf8');
      try { return new TextDecoder(charset.replace(/^x-/, '')).decode(buf); }
      catch { return buf.toString('utf8'); }
    } catch { return _; }
  });
}

// 把 HTML 正文剥成纯文本（用于预览、避免整段 HTML 源码出现在列表/ timeline）。
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- 从 payload 抽取正文 ----------
// 优先返回 text/plain；只有 html 时返回纯文本化版本（stripHtml），避免预览出现整段 HTML 源码。
// 每个 part 使用各自声明的 charset 解码，递归时向下传递。
function extractText(payload, inheritedCharset) {
  if (!payload) return '';
  const charset = inheritedCharset || getCharset(payload);
  if (payload.body && payload.body.data) {
    try { return decodeBytes(payload.body.data, charset); } catch { return ''; }
  }
  if (Array.isArray(payload.parts) && payload.parts.length) {
    let plain = '';
    let html = '';
    for (const p of payload.parts) {
      const pCharset = getCharset(p);
      if (p.mimeType && p.mimeType.startsWith('text/plain') && p.body && p.body.data) {
        try { plain += decodeBytes(p.body.data, pCharset) + '\n'; } catch { /* skip */ }
      } else if (p.mimeType && p.mimeType.startsWith('text/html') && p.body && p.body.data) {
        try { html += decodeBytes(p.body.data, pCharset); } catch { /* skip */ }
      } else if (p.parts) {
        const sub = extractText(p, pCharset);
        if (sub) plain += sub + '\n';
      }
    }
    return plain.trim() || stripHtml(html) || '';
  }
  return '';
}

// ---------- 并发限流 ----------
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = null; console.warn('[gmail] 并发处理失败:', e.message); }
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results.filter(Boolean);
}

// ---------- 主入口：拉取最近 N 天 thread 并归一化 ----------
// 返回与旧 IMAP fetchMessages 相同形状的 msg 数组：
// { id, threadId, messageId, inReplyTo, references, subject, conversationId,
//   from:{emailAddress:{address,name}}, toRecipients:[{emailAddress:{address,name}}],
//   receivedDateTime, bodyPreview, _body }
export async function fetchGmailMessages(opts = {}) {
  const maxThreads = Math.max(1, Number(opts.maxThreads || process.env.GMAIL_MAX_THREADS || 60));
  const days = Math.max(1, Number(opts.days || process.env.GMAIL_DAYS || 30));

  const list = await gmailFetch('threads', { q: `newer_than:${days}d`, maxResults: maxThreads });
  const threads = list.threads || [];
  console.log(`[gmail] 命中 ${threads.length} 个 thread（最近 ${days} 天，上限 ${maxThreads}）`);

  const fullThreads = await mapLimit(threads, 6, async (t) => {
    try { return await gmailFetch('threads/' + t.id, { format: 'full' }); }
    catch (e) { console.warn('[gmail] thread', t.id, '拉取失败:', e.message); return null; }
  });

  const out = [];
  for (const full of fullThreads) {
    if (!full) continue;
    const threadId = full.id;
    for (const m of (full.messages || [])) {
      const headers = m.payload?.headers || [];
      const getH = (name) => {
        const h = headers.find(x => x.name.toLowerCase() === name.toLowerCase());
        return h ? h.value : '';
      };
      const subject = decodeRfc2047(getH('Subject'));
      const from = parseAddress(decodeRfc2047(getH('From')));
      const toList = parseAddressList(getH('To'));
      const dateStr = getH('Date');
      const body = extractText(m.payload);
      const received = dateStr
        ? new Date(dateStr).toISOString()
        : (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date().toISOString());
      out.push({
        id: m.id,
        threadId,
        messageId: getH('Message-ID'),
        inReplyTo: getH('In-Reply-To'),
        references: (getH('References') || '').split(/\s+/).filter(Boolean),
        subject: subject || '(no subject)',
        conversationId: threadId,
        from: { emailAddress: { address: from.address, name: from.name } },
        toRecipients: toList.map(a => ({ emailAddress: { address: a.address, name: a.name } })),
        receivedDateTime: received,
        bodyPreview: stripHtml(body).replace(/\s+/g, ' ').slice(0, 280),
        _body: body,
      });
    }
  }
  console.log(`[gmail] 归一化完成，共 ${out.length} 封邮件消息`);
  return out;
}

export const GMAIL_CONFIG = { CLIENT_ID, REDIRECT_URI, TOKENS_PATH };
