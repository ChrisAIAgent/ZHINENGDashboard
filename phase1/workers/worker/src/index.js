// Phase 1 Ticketing Worker — IMAP edition
// Data source: per-user IMAP credentials supplied via X-IMAP-Auth header
//   (base64(user:appPassword)). outlook.com / office365.com over SSL :993.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
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

const CATEGORIES = ['Service', 'Warranty', 'Sales', 'Parts', 'Technical'];

const DEALER_PATTERNS = [
  { code: 'US-MT', name: 'Mountaintop Equipment', kw: /mountaintop/i },
  { code: 'SUNWARD-INT', name: 'Sunward Internal', kw: /sunwardamerica\.com/i, internal: true },
];

const MODEL_REGEX = /\bSW[E]?[-]?\d{2,3}UF?\b/i;
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
  if (/(closed|resolved|done|completed|sent|shipped)/.test(t)) return 'Closed';
  if (senderIsInternal) return 'Open';
  if (/(waiting for (dealer|you|response)|need.*response|please reply|awaiting your)/i.test(t)) return 'Waiting Dealer';
  if (/(need.*approval|need.*decision|please confirm|awaiting.*(hq|management|eric|mike))/i.test(t)) return 'Waiting HQ';
  if (/(pending|on hold|pause)/.test(t)) return 'Pending';
  return 'Open';
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
function detectOwner(latest) {
  // Owner = last internal sender across the thread, else the last recipient who is internal
  if (latest._owner) return latest._owner;
  return null;
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

// ------- Threading helpers -------
function normaliseSubject(s) {
  if (!s) return '';
  return s.replace(/^\s*(\[(external|internal|ext)\]\s*)?((re|fwd|fw)\s*:\s*)+/i, '').trim().toLowerCase();
}

// ------- IMAP fetch -------
// auth = { user: email, pass: appPassword }
async function fetchMessages(auth) {
  if (!auth || !auth.user || !auth.pass) {
    throw new Error('Missing IMAP credentials. Pass { user, pass }.');
  }
  const cacheKey = auth.user;
  const now = Date.now();
  if (messagesCacheByUser.has(cacheKey)) {
    const entry = messagesCacheByUser.get(cacheKey);
    if (now - entry.ts < CACHE_TTL_MS) return entry.msgs;
  }
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');

  const client = new ImapFlow({
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: { user: auth.user, pass: auth.pass },
    logger: false,
    emitLogs: false,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });

  const messages = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(now - 60 * 86400000); // last 60 days
      const uids = await client.search({ since });
      if (uids && uids.length > 0) {
        for (const uid of uids) {
          try {
            const msg = await client.fetchOne(
              uid,
              { envelope: true, source: true, internalDate: true },
              { uid: true }
            );
            if (!msg || !msg.envelope) continue;
            const env = msg.envelope;
            let parsed = null;
            try { parsed = await simpleParser(msg.source); } catch (_) { parsed = null; }
            const fromAddr = parsed?.from?.value?.[0]?.address
              || (env.from && env.from[0] ? `${env.from[0].mailbox}@${env.from[0].host}` : '');
            const fromName = parsed?.from?.value?.[0]?.name || env.from?.[0]?.name || '';
            const toRecipients = (parsed?.to?.value || []).map(v => ({
              emailAddress: { address: v.address, name: v.name || '' },
            }));
            const receivedISO = (msg.internalDate || env.date || new Date()).toISOString();
            const bodyText = parsed?.text || parsed?.html || '';
            messages.push({
              id: String(uid),
              messageId: env.messageId || '',
              inReplyTo: env.inReplyTo || '',
              references: Array.isArray(env.references) ? env.references : (env.references ? [env.references] : []),
              subject: env.subject || '(no subject)',
              from: { emailAddress: { address: fromAddr, name: fromName } },
              toRecipients,
              receivedDateTime: receivedISO,
              bodyPreview: bodyText.replace(/\s+/g, ' ').slice(0, 280),
              _body: bodyText,
            });
          } catch (perMsgErr) {
            console.warn('[imap] skip uid', uid, perMsgErr.message);
          }
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    messagesCacheByUser.delete(cacheKey);
    throw new Error(`IMAP ${err.code || err.responseStatus || 'error'}: ${err.message || String(err)}`);
  } finally {
    try { await client.logout(); } catch (_) {}
  }

  // Compute owner = last internal sender across the thread (used in buildTicketStore)
  messagesCacheByUser.set(cacheKey, { ts: now, msgs: messages });
  return messages;
}

// ------- Build tickets -------
async function buildTicketStore(auth) {
  if (ticketStore.size > 0 && Date.now() - cacheTimestamp < CACHE_TTL_MS) return;
  ticketStore.clear();
  ownerIndex.clear();
  const msgs = await fetchMessages(auth);
  cacheTimestamp = Date.now();

  // Thread by References chain
  const conv = new Map();
  for (const m of msgs) {
    const refs = (m.references || []).filter(Boolean);
    const root = (refs[0] || m.inReplyTo || m.messageId || ('subj:' + normaliseSubject(m.subject))).trim();
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

    // Owner = last internal sender across the thread
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
    return {
      id: m.id,
      subject: m.subject,
      from: m.from,
      to: (m.toRecipients || []).map(r => r.emailAddress),
      received: m.receivedDateTime,
      bodyPreview: m.bodyPreview,
      body: m._body || m.bodyPreview,
    };
  });
  const timeline = [
    { at: t.open_date, event: 'Ticket created', actor: 'AI', note: `从 ${t.email_count} 封邮件合并，识别为 ${t.category}` },
    ...(t.owner_email
      ? [{ at: t.open_date, event: 'Owner assigned', actor: 'AI', note: `分配给 ${t.owner_name}` }]
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

// ------- HTTP router -------




async function handleEvent(req) {
  const url = new URL(req.url);
  const path = url.pathname;
  // Decode IMAP credentials from header (format: base64(user:pass))
  const authHeader = req.headers.get('X-IMAP-Auth') || '';
  let auth = null;
  if (authHeader) {
    try {
      const decoded = atob(authHeader);
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        auth = { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
      }
    } catch (_) { /* ignore bad base64 */ }
  }
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (!path.startsWith('/api/')) return new Response('Not Found', { status: 404, headers: corsHeaders });
  const apiPath = path.slice(4);
  const params = Object.fromEntries(url.searchParams);
  try {
    switch (apiPath) {
      case '/kpi/overview':
        if (!auth) return errResponse('Missing X-IMAP-Auth header', 401);
        return jsonResponse(await getKpiOverview(auth));
      case '/tickets':
        if (req.method !== 'GET') return errResponse('Method not allowed', 405);
        if (!auth) return errResponse('Missing X-IMAP-Auth header', 401);
        return jsonResponse(await getTickets(auth, params));
      case '/owners/workload':
        if (!auth) return errResponse('Missing X-IMAP-Auth header', 401);
        return jsonResponse(await getOwnersWorkload(auth));
      case '/aging/buckets':
        if (!auth) return errResponse('Missing X-IMAP-Auth header', 401);
        return jsonResponse(await getAgingBuckets(auth));
      default: {
        const m = apiPath.match(/^\/tickets\/(.+)$/);
        if (m) {
          if (!auth) return errResponse('Missing X-IMAP-Auth header', 401);
          const detail = await getTicketDetail(auth, decodeURIComponent(m[1]));
          if (!detail) return errResponse('Ticket not found', 404);
          return jsonResponse(detail);
        }
        return errResponse('Unknown endpoint: ' + apiPath, 404);
      }
    }
  } catch (e) {
    return errResponse(e.message || String(e), 500);
  }
}
export default {
  async fetch(request, env, ctx) { return handleEvent(request); }
};
