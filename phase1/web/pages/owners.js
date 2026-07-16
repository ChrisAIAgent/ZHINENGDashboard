(async () => {
  mountSidebar('owners');
  setBreadcrumb([{ label: '首页' }, { label: 'Owner 工作量' }]);
  setToday();

  try {
    const data = await api.getOwners();
    const total = data.items.reduce((s, x) => s + x.active_count, 0);
    const totalClosed = data.items.reduce((s, x) => s + x.closed_this_week, 0);
    const longest = data.items.reduce((m, x) => Math.max(m, x.longest_aging), 0);
    const overloaded = data.items.filter(x => x.longest_aging > 14).length;

    document.getElementById('loading').classList.add('hidden');
    document.getElementById('page-content').classList.remove('hidden');

    document.getElementById('summary-cards').innerHTML = `
      <div class="bg-white p-5 rounded-xl border shadow-sm">
        <p class="text-sm text-gray-500">总 Active</p>
        <h3 class="text-3xl font-bold mt-2 text-gray-900">${U.formatNumber(total)}</h3>
        <p class="text-xs text-gray-400 mt-2">由 ${data.items.length} 位负责人处理</p>
      </div>
      <div class="bg-white p-5 rounded-xl border shadow-sm">
        <p class="text-sm text-gray-500">本周关闭</p>
        <h3 class="text-3xl font-bold mt-2 text-gray-900">${U.formatNumber(totalClosed)}</h3>
        <p class="text-xs text-gray-400 mt-2">所有 Owner 合计</p>
      </div>
      <div class="bg-white p-5 rounded-xl border shadow-sm ${overloaded > 0 ? 'border-red-200' : ''}">
        <p class="text-sm text-gray-500">超负荷 Owner</p>
        <h3 class="text-3xl font-bold mt-2 ${overloaded > 0 ? 'text-red-600' : 'text-gray-900'}">${U.formatNumber(overloaded)}</h3>
        <p class="text-xs text-gray-400 mt-2">有 >14 天未更新 Ticket</p>
      </div>
    `;

    const colors = ['bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500', 'bg-pink-500', 'bg-cyan-500'];
    document.getElementById('owner-cards').innerHTML = data.items
      .sort((a, b) => b.active_count - a.active_count)
      .map(o => {
        const initials = (o.owner_name || '?').slice(0, 2);
        const idx = (o.owner_name || '?').charCodeAt(0) % colors.length;
        const overload = o.longest_aging > 14;
        return `
          <div class="bg-white p-5 rounded-xl border shadow-sm hover:shadow-md transition-shadow ${overload ? 'border-red-200' : ''}">
            <div class="flex items-center gap-3 mb-4">
              <div class="w-12 h-12 ${colors[idx]} rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">${U.escapeHtml(initials)}</div>
              <div class="flex-1 min-w-0">
                <p class="font-bold text-gray-800 truncate">${U.escapeHtml(o.owner_name)}</p>
                <p class="text-xs text-gray-400 truncate">${U.escapeHtml(o.role || o.owner_email)}</p>
              </div>
              ${overload ? '<span class="px-2 py-0.5 bg-red-100 text-red-700 rounded text-[10px] font-bold">Overloaded</span>' : ''}
            </div>
            <div class="grid grid-cols-2 gap-4 text-sm">
              <div><p class="text-xs text-gray-400">Active</p><p class="text-2xl font-bold text-gray-800">${o.active_count}</p></div>
              <div><p class="text-xs text-gray-400">本周关闭</p><p class="text-2xl font-bold text-gray-800">${o.closed_this_week}</p></div>
              <div><p class="text-xs text-gray-400">平均处理时长</p><p class="text-base font-semibold text-gray-700">${o.avg_cycle_hours ? o.avg_cycle_hours + ' h' : '—'}</p></div>
              <div><p class="text-xs text-gray-400">最长 Aging</p><p class="text-base font-semibold ${o.longest_aging > 14 ? 'text-red-600' : o.longest_aging > 7 ? 'text-orange-600' : 'text-gray-700'}">${U.formatAging(o.longest_aging)}</p></div>
            </div>
          </div>
        `;
      }).join("") || `<p class="text-sm text-gray-400 text-center col-span-3 py-8">暂无负责人</p>`;

    iconify.scan();
  } catch (e) {
    document.getElementById('loading').innerHTML = `<div class="text-red-500">加载失败：${U.escapeHtml(e.message)}</div>`;
  }
})();
