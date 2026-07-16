// api.js — Phase 1: IMAP edition
// Sends X-IMAP-Auth: base64(user:appPassword) on every call.
// Auth is read from localStorage (set by assets/auth.js login flow).
// If not logged in, every call short-circuits to a synthetic "auth_required" error
// so the UI can show the login prompt.

(function(global){
  // 本地开发：前端(如 :8080) 直连 node-proxy(:8787)；部署到服务器：走同源 /api（由 nginx 反代到 127.0.0.1:8787）
  const BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:8787/api'
    : '/api';
  const LS_KEY = 'imapAuth';

  function getStored() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return null; }
  }
  function buildHeader() {
    const a = getStored();
    if (!a || !a.user || !a.pass) return null;
    const raw = a.user + ':' + a.pass;
    // btoa works in browsers, but be robust for non-ASCII
    const b64 = btoa(unescape(encodeURIComponent(raw)));
    return 'Basic ' + b64; // header value is base64
  }
  function authError() {
    const err = new Error('auth_required');
    err.code = 'AUTH_REQUIRED';
    throw err;
  }

  function isAuthed() { return !!buildHeader(); }

  async function request(path, params) {
    if (!isAuthed()) authError();
    const url = new URL(BASE + path, location.origin);
    if (params) for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') url.searchParams.set(k, v);
    }
    const headerVal = buildHeader();
    const resp = await fetch(url, { headers: { 'X-IMAP-Auth': headerVal.replace(/^Basic /, '') } });
    if (resp.status === 401) {
      const body = await resp.json().catch(() => ({}));
      const e = new Error(body.error || 'HTTP 401');
      e.code = 'HTTP_401';
      throw e;
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || ('HTTP ' + resp.status));
    }
    return resp.json();
  }

  async function requestById(path, id) {
    return request(path.replace(':id', id));
  }

  global.api = {
    isAuthed,
    getKpi:     () => request('/kpi/overview'),
    getTickets: (f = {}) => {
      const { category, status, owner, dealer, q, page, pageSize } = f;
      return request('/tickets', { category, status, owner, dealer, q, page, pageSize });
    },
    getTicket:  (id) => requestById('/tickets/:id', id),
    getOwners:  () => request('/owners/workload'),
    getAging:   () => request('/aging/buckets'),
  };
})(window);