let state = { page: 1, pageSize: 20, filters: {} };

function readFilters() {
  return {
    category: document.getElementById('f-category').value,
    status: document.getElementById('f-status').value,
    owner: document.getElementById('f-owner').value,
    dealer: document.getElementById('f-dealer').value,
    q: document.getElementById('f-q').value
  };
}

async function load() {
  const data = await api.getTickets({ ...state.filters, page: state.page, pageSize: state.pageSize });
  document.getElementById('total-badge').textContent = `共 ${data.total} 条`;
  const start = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const end = Math.min(data.page * data.pageSize, data.total);
  document.getElementById('page-info').textContent = `显示第 ${start}-${end} 条，共 ${data.total} 条`;

  document.getElementById('ticket-tbody').innerHTML = data.items.map(t => `
    <tr class="hover:bg-gray-50 cursor-pointer" onclick="location.href='ticket-detail.html?id=${t.id}'">
      <td class="px-6 py-4"><span class="text-blue-600 font-medium hover:underline">${t.id}</span></td>
      <td class="px-6 py-4 max-w-xs"><span class="text-gray-800 truncate inline-block max-w-[260px] align-middle">${U.escapeHtml(t.subject)}</span></td>
      <td class="px-6 py-4">${U.categoryBadge(t.category)}</td>
      <td class="px-6 py-4">
        <div class="text-gray-700">${U.escapeHtml(t.dealer_name)}</div>
        <div class="text-xs text-gray-400">${U.escapeHtml(t.machine_model || '—')}</div>
      </td>
      <td class="px-6 py-4 text-gray-700">${U.escapeHtml(t.owner_name)}</td>
      <td class="px-6 py-4">${U.statusBadge(t.status)}</td>
      <td class="px-6 py-4">${U.agingBadge(t.aging_days)}</td>
      <td class="px-6 py-4 text-gray-400 text-xs">${U.formatRelative(t.last_update)}</td>
    </tr>
  `).join("") || `<tr><td colspan="8" class="px-6 py-12 text-center text-gray-400">无数据</td></tr>`;

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pg = document.getElementById('pagination');
  let html = `<button class="px-3 py-1 border rounded hover:bg-gray-50 ${state.page === 1 ? 'opacity-50 cursor-not-allowed' : ''}" onclick="changePage(${state.page - 1})" ${state.page === 1 ? 'disabled' : ''}>上一页</button>`;
  const maxBtn = 5;
  let start2 = Math.max(1, state.page - 2);
  let end2 = Math.min(totalPages, start2 + maxBtn - 1);
  start2 = Math.max(1, end2 - maxBtn + 1);
  for (let i = start2; i <= end2; i++) {
    html += `<button class="px-3 py-1 border rounded ${i === state.page ? 'bg-blue-600 text-white border-blue-600 font-medium' : 'hover:bg-gray-50'}" onclick="changePage(${i})">${i}</button>`;
  }
  html += `<button class="px-3 py-1 border rounded hover:bg-gray-50 ${state.page === totalPages ? 'opacity-50 cursor-not-allowed' : ''}" onclick="changePage(${state.page + 1})" ${state.page === totalPages ? 'disabled' : ''}>下一页</button>`;
  pg.innerHTML = html;
}

function changePage(p) {
  const totalPages = Math.max(1, Math.ceil((window.__lastTotal || 1) / state.pageSize));
  if (p < 1 || p > totalPages) return;
  state.page = p;
  load();
}

(async () => {
  mountSidebar('tickets');
  setBreadcrumb([{ label: '首页' }, { label: 'Ticket 列表' }]);
  setToday();

  if (window.__MOCKS_OWNERS__) {
    document.getElementById('f-owner').innerHTML =
      '<option value="">全部</option>' + window.__MOCKS_OWNERS__.map(o => `<option value="${U.escapeHtml(o.email)}">${U.escapeHtml(o.name)}</option>`).join('');
  }
  if (window.__MOCKS_DEALERS__) {
    document.getElementById('f-dealer').innerHTML =
      '<option value="">全部</option>' + window.__MOCKS_DEALERS__.map(d => `<option value="${U.escapeHtml(d.code)}">${U.escapeHtml(d.name)}</option>`).join('');
  }

  document.getElementById('btn-search').onclick = () => { state.page = 1; state.filters = readFilters(); load(); };
  document.getElementById('btn-reset').onclick = () => {
    ['f-category', 'f-status', 'f-owner', 'f-dealer'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('f-q').value = '';
    state.page = 1; state.filters = {}; load();
  };

  const _origLoad = load;
  window.load = async () => { const r = await _origLoad(); window.__lastTotal = r ? r.total : 0; };

  await load();
  iconify.scan();
})();
