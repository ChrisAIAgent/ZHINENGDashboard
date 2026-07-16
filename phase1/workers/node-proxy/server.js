// Node Proxy 鈥?same API contract as the wrangler worker, but using
// raw Node http + imapflow (avoids workerd TLS handshake issue with imapflow).
// Listens on port 8787 (same as wrangler dev) so the frontend is unchanged.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchGmailMessages } from './gmail-connector.mjs';

const PORT = 8787;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, PATCH',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-IMAP-Auth',
  'Access-Control-Expose-Headers': 'X-IMAP-Auth',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
function errResponse(msg, status = 400) {
  return jsonResponse({ error: msg }, status);
}

// ------- Globals -------
const ticketStore = new Map();
const ownerIndex = new Map();
const messagesCacheByUser = new Map();
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// ---------- API Key & Bearer 鉴权（Agent 读写用） ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..'); // node-proxy → workers → phase1 → root
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const API_KEY = readEnv('API_KEY') || '';
const LLM_META_PATH = process.env.LLM_META_PATH || path.join(PROJECT_ROOT, 'scripts', 'llm-metadata.json');

function readEnv(key) {
  try {
    if (!fs.existsSync(ENV_PATH)) return '';
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      if (line.trim().startsWith('#') || !line.trim()) continue;
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return '';
}

function loadLlmMetadata() {
  try {
    if (fs.existsSync(LLM_META_PATH)) return JSON.parse(fs.readFileSync(LLM_META_PATH, 'utf8'));
  } catch { console.warn('[llm-meta] 读取失败，将从头开始'); }
  return {};
}

function saveLlmMetadata(data) {
  try { fs.writeFileSync(LLM_META_PATH, JSON.stringify(data, null, 2)); } catch (e) { console.error('[llm-meta] 写入失败', e.message); }
}

const CATEGORIES = ['Service', 'Warranty', 'Sales', 'Parts', 'Technical'];

const DEALER_PATTERNS = [
  { code: 'US-MT', name: 'Mountaintop Equipment', kw: /mountaintop/i },
  { code: 'US-ABC', name: 'ABC Equipment', kw: /abceq|abc equipment/i },
  { code: 'US-LS', name: 'Lone Star Construction', kw: /lone\s*star|lonestarconst/i },
  { code: 'US-TX', name: 'Texas Earthworks', kw: /texas\s*earthworks|tx\s*earthworks|txearthworks/i },
  { code: 'SUNWARD-INT', name: 'Sunward Internal', kw: /sunwardamerica\.com/i, internal: true },
];

const MODEL_REGEX = /\bSW[E]?[-\s]?\d{2,3}[\s-]*UF\b/i;
const PART_REGEX = /\b\d{9,12}\b/;

// ------- Heuristic detectors -------
function detectCategory(subject, body) {
  const t = (subject + ' ' + body).toLowerCase();
  if (/(door ?latch|lock|assembly|cable|part|stock|qty|inventory|order|ship)/.test(t)) return 'Parts';
  if (/(warranty|claim|defect)/.test(t)) return 'Warranty';
  if (/(price|quote|order|purchase|buy|sale)/.test(t)) return 'Sales';
  if (/(service|repair|broken|fix)/.test(t)) return 'Service';
  return 'Technical';
}
function detectDealer(fromAddr, body) {
  const haystack = `${fromAddr} ${body}`;
  for (const d of DEALER_PATTERNS) {
    if (d.kw.test(haystack)) return d;
  }
  const domain = (fromAddr.split('@')[1] || '').toLowerCase();
  return { code: domain || 'unknown', name: domain || 'unknown', internal: /sunwardamerica\.com$/i.test(fromAddr) };
}
function detectStatus(body, senderIsInternal) {
  const t = body.toLowerCase();
  if (/\b(closed|resolved|completed|done deal|all set|fixed it|tracking|shipped via)\b/.test(t)) return 'Closed';
  if (/(pending|on[- ]?hold|hold the order|pause)/.test(t)) return 'Pending';
  if (/(please reply|please send|please provide|please advise|please assess|please review|send us|send the following|need.*response|waiting for (dealer|you|response)|awaiting your)/i.test(t)) return 'Waiting Dealer';
  if (/(need.*approval|need.*decision|need your|please confirm|awaiting.*(hq|management|engineering|eric|mike|rd))/i.test(t)) return 'Waiting HQ';
  return senderIsInternal ? 'Open' : 'Waiting Dealer';
}
function detectNextAction(category, body) {
  const t = body.toLowerCase();
  if (/(ship|send)/.test(t) && category === 'Parts') return 'Ship parts and invoice';
  if (/(ar|receivable|account|payment)/.test(t)) return 'Resolve AR before release';
  if (/(price|quote)/.test(t)) return 'Confirm price with dealer';
  return 'Follow up';
}
function detectPriority(status, ageDays) {
  if (status === 'Waiting HQ' || ageDays > 7) return 'high';
  if (status === 'Waiting Dealer' || ageDays > 3) return 'normal';
  return 'normal';
}
function nameFromEmail(addr) {
  if (!addr) return '';
  const local = addr.split('@')[0];
  return local.split(/[._-]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}
function detectRole(email) {
  if (!email) return 'Internal';
  if (/eric|mike/i.test(email.split('@')[0])) return 'Manager';
  return 'Internal';
}
function shortId(id) {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || Math.random().toString(36).slice(2, 10);
}
function stripInternal(t) {
  const { _msgs, ...rest } = t;
  return rest;
}
function isActive(t) { return t.status !== 'Closed'; }
function normaliseSubject(s) {
  if (!s) return '';
  return s.replace(/^\s*(\[(external|internal|ext)\]\s*)?((re|fwd|fw)\s*:\s*)+/i, '').trim().toLowerCase();
}

// ------- Gmail fetch -------
// 单账号 Gmail：使用 scripts/tokens.json 中已授权的 refresh_token 拉取真实邮件。
// 前端 X-IMAP-Auth 头仅作访问门禁（任意非空凭据即可），实际账户由后端 OAuth 令牌决定。
// 多账号扩展点：将来可按 auth.user 路由到不同 MailboxConnector。
async function fetchMessages(auth) {
  const cacheKey = 'gmail';
  const now = Date.now();
  if (messagesCacheByUser.has(cacheKey)) {
    const entry = messagesCacheByUser.get(cacheKey);
    if (now - entry.ts < CACHE_TTL_MS) return entry.msgs;
  }
  const msgs = await fetchGmailMessages();
  messagesCacheByUser.set(cacheKey, { ts: now, msgs });
  return msgs;
}

// ------- Build tickets -------
async function buildTicketStore(auth) {
  if (ticketStore.size > 0 && Date.now() - cacheTimestamp < CACHE_TTL_MS) return;
  ticketStore.clear();
  ownerIndex.clear();
  const msgs = await fetchMessages(auth);
  cacheTimestamp = Date.now();

  const conv = new Map();
  for (const m of msgs) {
    const refs = (m.references || []).filter(Boolean);
    // Gmail 消息带 conversationId(threadId) 时直接用它做会话根；否则回退到 References 链
    const root = (m.conversationId || refs[0] || m.inReplyTo || m.messageId || ('subj:' + normaliseSubject(m.subject))).trim();
    if (!root) continue;
    if (!conv.has(root)) conv.set(root, []);
    conv.get(root).push(m);
  }

  for (const [cid, list] of conv.entries()) {
    list.sort((a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime));
    const latest = list[list.length - 1];
    const earliest = list[0];
    const fromAddr = latest.from?.emailAddress?.address || '';
    const senderIsInternal = /@sunwardamerica\.com$/i.test(fromAddr);

    const internalSender = [...list].reverse().find(m => /@sunwardamerica\.com$/i.test(m.from?.emailAddress?.address || ''));
    const ownerEmail = internalSender ? internalSender.from.emailAddress.address : null;

    const subject = latest.subject || '(no subject)';
    const body = latest.bodyPreview || '';
    const fullThread = list.map(m => m._body || m.bodyPreview).join('\n---\n');
    const category = detectCategory(subject, fullThread);
    const dealer = detectDealer(fromAddr, fullThread);
    const ownerName = nameFromEmail(ownerEmail);
    const status = detectStatus(fullThread, senderIsInternal);
    const nextAction = detectNextAction(category, fullThread);
    const modelMatch = subject.match(MODEL_REGEX) || fullThread.match(MODEL_REGEX);
    const machineModel = modelMatch ? modelMatch[0].toUpperCase() : null;
    const partMatch = fullThread.match(PART_REGEX);
    const openMs = new Date(earliest.receivedDateTime).getTime();
    const ageDays = Math.floor((Date.now() - openMs) / 86400000);
    const priority = detectPriority(status, ageDays);

    ticketStore.set(cid, {
      id: shortId(cid),
      conversation_id: cid,
      subject,
      category,
      dealer_code: dealer.code,
      dealer_name: dealer.name,
      machine_model: machineModel,
      owner_email: ownerEmail,
      owner_name: ownerName,
      status,
      priority,
      last_update: latest.receivedDateTime,
      open_date: earliest.receivedDateTime,
      aging_days: ageDays,
      next_action: nextAction,
      email_count: list.length,
      part_number: partMatch ? partMatch[0] : null,
      _msgs: list,
    });
    if (ownerEmail) {
      ownerIndex.set(ownerEmail, {
        owner_email: ownerEmail,
        owner_name: ownerName,
        role: detectRole(ownerEmail),
      });
    }
  }
  // 合并 Agent 写入的 LLM 元数据（覆盖正则抽取结果）
  applyLlmMetadata();
}

// LLM 元数据覆盖：Agent 通过 PATCH 写回的字段优先于正则
function applyLlmMetadata() {
  const meta = loadLlmMetadata();
  for (const [threadId, data] of Object.entries(meta)) {
    const ticket = ticketStore.get(threadId);
    if (!ticket) continue;
    if (data.category) ticket.category = data.category;
    if (data.dealer_name) { ticket.dealer_name = data.dealer_name; if (data.dealer_code) ticket.dealer_code = data.dealer_code; }
    if (data.status) ticket.status = data.status;
    if (data.owner_email !== undefined) { ticket.owner_email = data.owner_email; ticket.owner_name = data.owner_name || ''; }
    if (data.priority) ticket.priority = data.priority;
    if (data.summary !== undefined) ticket.summary = data.summary;
    if (data.next_action) ticket.next_action = data.next_action;
    if (data.machine_model) ticket.machine_model = data.machine_model;
    if (data.part_number) ticket.part_number = data.part_number;
  }
}

// ------- API endpoints -------
async function getKpiOverview(auth) {
  await buildTicketStore(auth);
  const tickets = Array.from(ticketStore.values());
  const weekAgo = Date.now() - 7 * 86400000;
  const dayMs = 86400000;
  const totals = {
    active: tickets.filter(isActive).length,
    new_this_week: tickets.filter(t => new Date(t.open_date).getTime() >= weekAgo).length,
    closed_this_week: tickets.filter(t => t.status === 'Closed' && new Date(t.last_update).getTime() >= weekAgo).length,
    overdue: tickets.filter(t => isActive(t) && t.aging_days > 7).length,
  };
  const by_category = {};
  for (const cat of CATEGORIES) {
    const items = tickets.filter(t => t.category === cat);
    const closedItems = items.filter(t => t.status === 'Closed');
    const cycleSum = closedItems.reduce((s, t) => s + (new Date(t.last_update).getTime() - new Date(t.open_date).getTime()), 0);
    by_category[cat] = {
      active: items.filter(isActive).length,
      new_this_week: items.filter(t => new Date(t.open_date).getTime() >= weekAgo).length,
      closed_this_week: items.filter(t => t.status === 'Closed' && new Date(t.last_update).getTime() >= weekAgo).length,
      avg_cycle_hours: closedItems.length > 0 ? Math.round((cycleSum / closedItems.length) / 3600000) : null,
    };
  }
  const trend = [];
  for (let d = 6; d >= 0; d--) {
    const dayStart = new Date(Date.now() - d * dayMs);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = dayStart.getTime() + dayMs;
    const created = tickets.filter(t => {
      const ms = new Date(t.open_date).getTime();
      return ms >= dayStart.getTime() && ms < dayEnd;
    }).length;
    const closed = tickets.filter(t => {
      if (t.status !== 'Closed') return false;
      const ms = new Date(t.last_update).getTime();
      return ms >= dayStart.getTime() && ms < dayEnd;
    }).length;
    trend.push({ date: dayStart.toISOString().slice(0, 10), created, closed });
  }
  return { totals, by_category, trend };
}

async function getTickets(auth, params = {}) {
  await buildTicketStore(auth);
  let items = Array.from(ticketStore.values()).map(stripInternal);
  if (params.category) items = items.filter(t => t.category === params.category);
  if (params.status) items = items.filter(t => t.status === params.status);
  if (params.owner) items = items.filter(t => t.owner_email === params.owner);
  if (params.dealer) items = items.filter(t => t.dealer_code === params.dealer);
  if (params.q) {
    const q = params.q.toLowerCase();
    items = items.filter(t =>
      (t.subject + ' ' + t.id + ' ' + (t.machine_model || '')).toLowerCase().includes(q)
    );
  }
  items.sort((a, b) => new Date(b.last_update) - new Date(a.last_update));
  const total = items.length;
  const page = Math.max(1, parseInt(params.page) || 1);
  const pageSize = Math.max(1, Math.min(200, parseInt(params.pageSize) || 50));
  const start = (page - 1) * pageSize;
  return { total, page, pageSize, items: items.slice(start, start + pageSize) };
}

async function getTicketDetail(auth, id) {
  await buildTicketStore(auth);
  let t = Array.from(ticketStore.values()).find(x => x.id === id);
  if (!t) t = Array.from(ticketStore.values()).find(x => x.conversation_id === id);
  if (!t) return null;
  const emails = (t._msgs || []).map(m => {
    const fromAddr = m.from?.emailAddress?.address || '';
    const fromDisplay = m.from?.emailAddress?.name
      ? `${m.from.emailAddress.name} <${fromAddr}>`
      : fromAddr;
    const toDisplay = (m.toRecipients || [])
      .map(r => r.emailAddress?.name
        ? `${r.emailAddress.name} <${r.emailAddress.address}>`
        : (r.emailAddress?.address || ''))
      .filter(Boolean)
      .join(', ');
    // 'in' = inbound from dealer/external, 'out' = outbound from internal
    const direction = /@sunwardamerica\.com$/i.test(fromAddr) ? 'out' : 'in';
    return {
      id: m.id,
      subject: m.subject,
      direction,
      from: fromDisplay,
      to: toDisplay,
      received_at: m.receivedDateTime,
      body_preview: m.bodyPreview,
      body: m._body || m.bodyPreview,
    };
  });
  const timeline = [
    { at: t.open_date, event: 'Ticket created', actor: 'AI', note: `已合并 ${t.email_count} 封邮件，识别分类为 ${t.category}` },
    ...(t.owner_email
      ? [{ at: t.open_date, event: 'Owner assigned', actor: 'AI', note: `已分配给 ${t.owner_name}` }]
      : []),
    { at: t.last_update, event: 'Latest update', actor: t.owner_name || 'System', note: t.next_action },
  ];
  const { _msgs, ...rest } = t;
  return { ...rest, emails, timeline };
}

async function getOwnersWorkload(auth) {
  await buildTicketStore(auth);
  const map = new Map();
  for (const t of ticketStore.values()) {
    if (!t.owner_email) continue;
    if (!map.has(t.owner_email)) {
      map.set(t.owner_email, {
        owner_email: t.owner_email,
        owner_name: t.owner_name,
        role: ownerIndex.get(t.owner_email)?.role || 'Internal',
        active_count: 0, closed_this_week: 0, cycle_sum: 0, cycle_n: 0, longest_aging: 0,
      });
    }
    const m = map.get(t.owner_email);
    if (t.status !== 'Closed') m.active_count++;
    else if (Date.now() - new Date(t.last_update).getTime() < 7 * 86400000) m.closed_this_week++;
    if (t.status === 'Closed') {
      m.cycle_sum += new Date(t.last_update) - new Date(t.open_date);
      m.cycle_n++;
    }
    if (t.aging_days > m.longest_aging) m.longest_aging = t.aging_days;
  }
  const items = Array.from(map.values()).map(m => ({
    ...m,
    avg_cycle_hours: m.cycle_n > 0 ? Math.round((m.cycle_sum / m.cycle_n) / 3600000) : null,
  }));
  return { items };
}

async function getAgingBuckets(auth) {
  await buildTicketStore(auth);
  const tickets = Array.from(ticketStore.values()).filter(t => t.status !== 'Closed');
  const bucketOf = d => (d <= 3 ? '0-3d' : d <= 7 ? '3-7d' : d <= 14 ? '7-14d' : '>14d');
  const buckets = { '0-3d': 0, '3-7d': 0, '7-14d': 0, '>14d': 0 };
  const by_category = {};
  for (const c of CATEGORIES) by_category[c] = { '0-3d': 0, '3-7d': 0, '7-14d': 0, '>14d': 0 };
  for (const t of tickets) {
    const b = bucketOf(t.aging_days);
    buckets[b]++;
    if (by_category[t.category]) by_category[t.category][b]++;
  }
  const overdue_top = tickets.slice().sort((a, b) => b.aging_days - a.aging_days).slice(0, 50).map(stripInternal);
  return { buckets, by_category, overdue_top };
}

// ------- HTTP server -------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  // 鉴权：支持两种方式
  //   X-IMAP-Auth: base64(user:pass)  — 前端看板（自动预置 Gmail 哨兵）
  //   Authorization: Bearer <api_key>   — 外部 Agent（.env 中 API_KEY）
  const authHeader = req.headers['x-imap-auth'] || '';
  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  let auth = null;
  let isBearer = false;
  if (authHeader) {
    try {
      const decoded = Buffer.from(authHeader, 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) auth = { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
    } catch (_) { /* ignore */ }
  } else if (bearer && API_KEY && bearer === API_KEY) {
    isBearer = true;
  }
  const hasAuth = auth || isBearer;

  if (!path.startsWith('/api/')) {
    res.writeHead(404, corsHeaders);
    res.end('Not Found');
    return;
  }
  const apiPath = path.slice(4);
  const params = Object.fromEntries(url.searchParams);

  try {
    // ---------- GET 端点（前端 X-IMAP-Auth 或 Agent Bearer 均可） ----------
    if (apiPath === '/kpi/overview') {
      if (!hasAuth) return sendErr(res, 401, '需要鉴权：X-IMAP-Auth 或 Bearer <api_key>');
      sendJson(res, 200, await getKpiOverview(auth));
    } else if (apiPath === '/tickets') {
      if (req.method !== 'GET') return sendErr(res, 405, 'Method not allowed');
      if (!hasAuth) return sendErr(res, 401, '需要鉴权：X-IMAP-Auth 或 Bearer <api_key>');
      sendJson(res, 200, await getTickets(auth, params));
    } else if (apiPath === '/owners/workload') {
      if (!hasAuth) return sendErr(res, 401, '需要鉴权：X-IMAP-Auth 或 Bearer <api_key>');
      sendJson(res, 200, await getOwnersWorkload(auth));
    } else if (apiPath === '/aging/buckets') {
      if (!hasAuth) return sendErr(res, 401, '需要鉴权：X-IMAP-Auth 或 Bearer <api_key>');
      sendJson(res, 200, await getAgingBuckets(auth));

    // ---------- PATCH /api/tickets/:id（Agent 专用：写回 LLM 元数据） ----------
    } else if (req.method === 'PATCH') {
      const m = apiPath.match(/^\/tickets\/(.+)$/);
      if (!m) return sendErr(res, 404, 'Unknown PATCH endpoint');
      if (!isBearer) return sendErr(res, 403, 'PATCH 端点仅限 Agent 使用，请传 Bearer <api_key>');
      const inputId = decodeURIComponent(m[1]); // 可能是短 id 或完整 conversation_id
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw); } catch { return sendErr(res, 400, '请求体 JSON 解析失败'); }
      const allowed = ['category','dealer_name','dealer_code','status','owner_email','owner_name','priority','summary','next_action','machine_model','part_number','urgency'];
      let hasField = false;
      for (const f of allowed) { if (payload[f] !== undefined) hasField = true; }
      if (!hasField) return sendErr(res, 400, '请求体无有效字段。可选字段: ' + allowed.join(', '));
      // 确保 ticketStore 已构建，解析短 id → conversation_id
      await buildTicketStore(auth);
      let ticket = ticketStore.get(inputId);
      if (!ticket) ticket = Array.from(ticketStore.values()).find(t => t.id === inputId);
      if (!ticket) return sendErr(res, 404, 'Ticket not found: ' + inputId);
      const threadId = ticket.conversation_id; // 以 conversation_id 为正式 key
      const patch = { threadId, updatedAt: new Date().toISOString() };
      for (const f of allowed) { if (payload[f] !== undefined) patch[f] = payload[f]; }
      // 持久化写入 llm-metadata.json（key = conversation_id）
      const meta = loadLlmMetadata();
      meta[threadId] = { ...(meta[threadId] || {}), ...patch };
      saveLlmMetadata(meta);
      // 同步更新内存 ticket
      if (patch.category) ticket.category = patch.category;
      if (patch.dealer_name) { ticket.dealer_name = patch.dealer_name; ticket.dealer_code = patch.dealer_code || ticket.dealer_code; }
      if (patch.status) ticket.status = patch.status;
      if (patch.owner_email !== undefined) { ticket.owner_email = patch.owner_email; ticket.owner_name = patch.owner_name || ''; }
      if (patch.priority) ticket.priority = patch.priority;
      if (patch.summary !== undefined) ticket.summary = patch.summary;
      if (patch.next_action) ticket.next_action = patch.next_action;
      if (patch.machine_model) ticket.machine_model = patch.machine_model;
      if (patch.part_number) ticket.part_number = patch.part_number;
      sendJson(res, 200, { ok: true, id: ticket.id, threadId, updated: patch });

    // ---------- GET /api/tickets/:id ----------
    } else {
      const m = apiPath.match(/^\/tickets\/(.+)$/);
      if (m) {
        if (!hasAuth) return sendErr(res, 401, '需要鉴权：X-IMAP-Auth 或 Bearer <api_key>');
        const detail = await getTicketDetail(auth, decodeURIComponent(m[1]));
        if (!detail) return sendErr(res, 404, 'Ticket not found');
        sendJson(res, 200, detail);
      } else {
        sendErr(res, 404, 'Unknown endpoint: ' + apiPath);
      }
    }
  } catch (e) {
    console.error('[handler]', e);
    sendErr(res, 500, e.message || String(e));
  }
});

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...corsHeaders });
  res.end(body);
}
function sendErr(res, status, msg) {
  sendJson(res, status, { error: msg });
}

// ---------- 请求体读取 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1_000_000) reject(new Error('请求体超过 1MB 上限')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[node-proxy] listening on http://127.0.0.1:${PORT}`);
});
