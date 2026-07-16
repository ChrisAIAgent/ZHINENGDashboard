// common.js - 通用工具：格式化、DOM、状态/分类映射

(function(global){
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, attrs={}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  };
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[m]);

  const formatNumber = (n) => {
    if (n == null || isNaN(n)) return "—";
    return new Intl.NumberFormat("zh-CN").format(n);
  };
  const formatCurrency = (n, cur="¥") => `${cur} ${formatNumber(n)}`;
  const formatDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString("zh-CN", { year:"numeric", month:"2-digit", day:"2-digit" });
  };
  const formatDateTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString("zh-CN", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
  };
  const formatRelative = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "刚刚";
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const dys = Math.floor(h / 24);
    if (dys < 30) return `${dys} 天前`;
    return formatDate(iso);
  };
  const formatAging = (days) => {
    if (days == null) return "—";
    if (days < 1) return "< 1 天";
    if (days < 30) return `${days} 天`;
    if (days < 365) return `${Math.floor(days/30)} 月`;
    return `${Math.floor(days/365)} 年`;
  };
  const agingBucket = (days) => {
    if (days == null) return "unknown";
    if (days <= 3) return "0-3d";
    if (days <= 7) return "3-7d";
    if (days <= 14) return "7-14d";
    return ">14d";
  };

  // 状态映射
  const STATUS_META = {
    "Open":              { color: "blue",   icon: "ri:circle-line",          label: "Open" },
    "Pending":           { color: "yellow", icon: "ri:pause-circle-line",    label: "Pending" },
    "Waiting Dealer":    { color: "orange", icon: "ri:time-line",            label: "Waiting Dealer" },
    "Waiting HQ":        { color: "purple", icon: "ri:hourglass-line",       label: "Waiting HQ" },
    "Closed":            { color: "green",  icon: "ri:checkbox-circle-line", label: "Closed" }
  };
  const CATEGORY_META = {
    "Service":   { color: "blue",   icon: "ri:tools-line",        label: "Service" },
    "Warranty":  { color: "purple", icon: "ri:shield-check-line", label: "Warranty" },
    "Sales":     { color: "green",  icon: "ri:shopping-cart-line",label: "Sales" },
    "Parts":     { color: "orange", icon: "ri:shopping-bag-line", label: "Parts" },
    "Technical": { color: "cyan",   icon: "ri:settings-line",     label: "Technical" }
  };
  const PRIORITY_META = {
    "high":   { color: "red",    label: "High" },
    "normal": { color: "blue",   label: "Normal" },
    "low":    { color: "gray",   label: "Low" }
  };

  const statusBadge = (status) => {
    const m = STATUS_META[status] || { color: "gray", icon: "ri:question-line", label: status };
    return `<span class="px-2 py-0.5 bg-${m.color}-100 text-${m.color}-700 rounded text-[10px] font-bold inline-flex items-center gap-1">
      <span class="iconify" data-icon="${m.icon}"></span>${escapeHtml(m.label)}
    </span>`;
  };
  const categoryBadge = (cat) => {
    const m = CATEGORY_META[cat] || { color: "gray", icon: "ri:question-line", label: cat };
    return `<span class="inline-flex items-center gap-1 text-${m.color}-600 text-xs font-medium">
      <span class="iconify" data-icon="${m.icon}"></span>${escapeHtml(m.label)}
    </span>`;
  };
  const priorityBadge = (p) => {
    const m = PRIORITY_META[p] || { color: "gray", label: p };
    return `<span class="px-2 py-0.5 bg-${m.color}-100 text-${m.color}-700 rounded text-[10px] font-bold">${escapeHtml(m.label)}</span>`;
  };
  const agingBadge = (days) => {
    const b = agingBucket(days);
    const colorMap = { "0-3d": "green", "3-7d": "blue", "7-14d": "orange", ">14d": "red", "unknown": "gray" };
    const c = colorMap[b];
    return `<span class="px-2 py-0.5 bg-${c}-100 text-${c}-700 rounded text-[10px] font-bold">${b === "unknown" ? "—" : formatAging(days)}</span>`;
  };

  // 暴露
  global.U = { $, $$, el, escapeHtml, formatNumber, formatCurrency, formatDate, formatDateTime, formatRelative, formatAging, agingBucket,
               STATUS_META, CATEGORY_META, PRIORITY_META, statusBadge, categoryBadge, priorityBadge, agingBadge };

// 兼容:iconify v3.x 把全局改名 Iconify,v2.x 是 iconify;统一别名
if (typeof iconify === 'undefined' && typeof Iconify !== 'undefined') { (function(){var I=Iconify;iconify={scan:function(){try{return I.scan?I.scan():(I.renderAll?I.renderAll():null);}catch(_){return null;}}};})(); }
})(window);

