// auth.js — Gmail 数据源（后端已 OAuth 授权），无演示模式
//
// 策略：
//   - 脚本加载时自动预置 Gmail 哨兵凭据到 localStorage（在 dashboard.js 等执行前生效），
//     各页面带 X-IMAP-Auth 头拉取真实邮件，首页直接出数据，无登录弹窗。
//   - 顶栏芯片显示「Gmail 已连接」，点击刷新数据。
//   - 后端 isDemoAuth 已移除，任意非空凭据统一走 Gmail API（账户由后端 OAuth 令牌决定）。

(function (global) {
  const LS_KEY = 'imapAuth';
  // Gmail 模式哨兵凭据：后端仅需非空 X-IMAP-Auth 即放行，实际账户由 tokens.json 决定
  const GMAIL_SENTINEL_USER = 'Gmail (已授权)';
  const GMAIL_SENTINEL_PASS = 'oauth';

  function read() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return null; }
  }
  function write(v) { localStorage.setItem(LS_KEY, JSON.stringify(v)); }
  function clear() { localStorage.removeItem(LS_KEY); }

  // 自动预置 Gmail 凭据（在 dashboard.js 等执行前生效，避免首页拉数据 401）
  if (!read()) write({ user: GMAIL_SENTINEL_USER, pass: GMAIL_SENTINEL_PASS });

  function injectChipStyles() {
    if (document.getElementById('imap-auth-style')) return;
    const s = document.createElement('style');
    s.id = 'imap-auth-style';
    s.textContent = `
      .account-chip { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px; background: #F1F5F9; border-radius: 999px; font-size: 13px; color: #334155; cursor: pointer; }
      .account-chip .dot { width: 8px; height: 8px; border-radius: 50%; background: #10B981; }
      .account-chip:hover { background: #E2E8F0; }
    `;
    document.head.appendChild(s);
  }

  function ensureHeader() {
    let slot = document.getElementById('imap-account-slot');
    if (!slot) {
      const headerRight = document.querySelector('header .flex.items-center.gap-6');
      if (!headerRight) return null;
      slot = document.createElement('div');
      slot.id = 'imap-account-slot';
      headerRight.appendChild(slot);
    }
    return slot;
  }

  function updateHeader() {
    injectChipStyles();
    const slot = ensureHeader();
    if (!slot) return;
    if (!read()) write({ user: GMAIL_SENTINEL_USER, pass: GMAIL_SENTINEL_PASS });
    slot.innerHTML = `<span class="account-chip" id="imap-chip" title="点击刷新数据">
      <span class="dot"></span><span>Gmail 已连接</span>
    </span>`;
    const chip = document.getElementById('imap-chip');
    if (chip) chip.addEventListener('click', () => location.reload());
  }

  global.imapAuth = {
    read, write, clear,
    isAuthed: () => true,
    showModal: () => location.reload(), // 兼容旧调用：刷新数据
    hideModal: () => {},
    updateHeader,
    requireAuth: () => { if (!read()) write({ user: GMAIL_SENTINEL_USER, pass: GMAIL_SENTINEL_PASS }); return true; },
    init: () => updateHeader(),
  };
})(window);
