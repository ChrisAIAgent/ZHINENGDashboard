(async () => {
  mountSidebar('dashboard');
  setBreadcrumb([{ label: '首页' }, { label: 'Ticket 看板' }]);
  setToday();

  try {
    const [kpi, , aging] = await Promise.all([api.getKpi(), api.getOwners(), api.getAging()]);

    document.getElementById('welcome-subtitle').textContent =
      `当前 Active ${kpi.totals.active} 个 · 本周新增 ${kpi.totals.new_this_week} · 逾期 ${kpi.totals.overdue}`;

    document.getElementById('kpi-cards').innerHTML = `
      <div class="bg-white p-5 rounded-xl border shadow-sm">
        <div class="flex justify-between items-start">
          <div><p class="text-sm font-medium text-gray-500">Active Tickets</p><h3 class="text-2xl font-bold mt-2 text-gray-900">${U.formatNumber(kpi.totals.active)}</h3></div>
          <div class="p-2 bg-blue-50 text-blue-600 rounded-lg"><span class="iconify text-xl" data-icon="ri:mail-open-line"></span></div>
        </div>
        <div class="mt-4 flex items-center text-sm text-gray-400"><span>当前处理中</span></div>
      </div>
      <div class="bg-white p-5 rounded-xl border shadow-sm">
        <div class="flex justify-between items-start">
          <div><p class="text-sm font-medium text-gray-500">本周新增</p><h3 class="text-2xl font-bold mt-2 text-gray-900">${U.formatNumber(kpi.totals.new_this_week)}</h3></div>
          <div class="p-2 bg-green-50 text-green-600 rounded-lg"><span class="iconify text-xl" data-icon="ri:add-circle-line"></span></div>
        </div>
        <div class="mt-4 flex items-center text-sm text-gray-400"><span>本周创建</span></div>
      </div>
      <div class="bg-white p-5 rounded-xl border shadow-sm">
        <div class="flex justify-between items-start">
          <div><p class="text-sm font-medium text-gray-500">本周已关闭</p><h3 class="text-2xl font-bold mt-2 text-gray-900">${U.formatNumber(kpi.totals.closed_this_week)}</h3></div>
          <div class="p-2 bg-purple-50 text-purple-600 rounded-lg"><span class="iconify text-xl" data-icon="ri:checkbox-circle-line"></span></div>
        </div>
        <div class="mt-4 flex items-center text-sm text-gray-400"><span>已完成</span></div>
      </div>
      <div class="bg-white p-5 rounded-xl border shadow-sm">
        <div class="flex justify-between items-start">
          <div><p class="text-sm font-medium text-gray-500">Overdue</p><h3 class="text-2xl font-bold mt-2 ${kpi.totals.overdue > 0 ? 'text-red-600' : 'text-gray-900'}">${U.formatNumber(kpi.totals.overdue)}</h3></div>
          <div class="p-2 bg-red-50 text-red-600 rounded-lg"><span class="iconify text-xl" data-icon="ri:error-warning-line"></span></div>
        </div>
        <div class="mt-4 flex items-center text-sm text-gray-400"><span>超过 7 天未更新</span></div>
      </div>
    `;

    const chart = echarts.init(document.getElementById('trendChart'));
    chart.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
      xAxis: { type: 'category', boundaryGap: false, data: kpi.trend.map(t => t.date.slice(5)), axisLabel: { color: '#9CA3AF' }, axisLine: { lineStyle: { color: '#E5E7EB' } } },
      yAxis: { type: 'value', axisLabel: { color: '#9CA3AF' }, splitLine: { lineStyle: { type: 'dashed', color: '#F3F4F6' } } },
      series: [
        { name: '新增', type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 3, color: '#3B82F6' },
          areaStyle: { opacity: 0.1, color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#3B82F6' }, { offset: 1, color: '#fff' }]) },
          data: kpi.trend.map(t => t.created) },
        { name: '关闭', type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 2, color: '#10B981', type: 'dashed' }, data: kpi.trend.map(t => t.closed) }
      ]
    });
    window.addEventListener('resize', () => chart.resize());

    document.getElementById('overdue-top').innerHTML = aging.overdue_top.slice(0, 5).map(t => `
      <a href="ticket-detail.html?id=${t.id}" class="flex items-center gap-3 p-3 bg-gray-50 rounded-lg hover:bg-red-50 transition-all border border-transparent hover:border-red-100">
        <div class="w-9 h-9 bg-white rounded-lg flex items-center justify-center border shadow-sm text-red-500 shrink-0">
          <span class="iconify text-lg" data-icon="ri:alarm-warning-line"></span>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold text-gray-800 truncate">${U.escapeHtml(t.subject)}</p>
          <p class="text-xs text-gray-500 mt-0.5 truncate">${U.escapeHtml(t.owner_name)} · ${U.categoryBadge(t.category)}</p>
        </div>
        <span class="px-2 py-0.5 bg-red-100 text-red-700 rounded text-[10px] font-bold shrink-0">${U.formatAging(t.aging_days)}</span>
      </a>
    `).join("") || `<p class="text-sm text-gray-400 text-center py-8">暂无逾期 Ticket</p>`;

    document.getElementById('category-cards').innerHTML = Object.entries(kpi.by_category).map(([cat, m]) => {
      const meta = U.CATEGORY_META[cat] || { color: 'gray', icon: 'ri:question-line', label: cat };
      return `
        <div class="bg-white p-5 rounded-xl border shadow-sm hover:shadow-md transition-shadow">
          <div class="flex justify-between items-start mb-4">
            <div>
              <p class="text-sm font-medium text-gray-500">${meta.label}</p>
              <h3 class="text-2xl font-bold mt-2 text-gray-900">${U.formatNumber(m.active)}</h3>
            </div>
            <div class="p-2 bg-${meta.color}-50 text-${meta.color}-600 rounded-lg"><span class="iconify text-xl" data-icon="${meta.icon}"></span></div>
          </div>
          <div class="grid grid-cols-3 gap-2 text-xs">
            <div><p class="text-gray-400">本周新增</p><p class="font-semibold text-gray-700">${U.formatNumber(m.new_this_week)}</p></div>
            <div><p class="text-gray-400">本周关闭</p><p class="font-semibold text-gray-700">${U.formatNumber(m.closed_this_week)}</p></div>
            <div><p class="text-gray-400">平均时长</p><p class="font-semibold text-gray-700">${m.avg_cycle_hours ? m.avg_cycle_hours + 'h' : '—'}</p></div>
          </div>
        </div>`;
    }).join("");

    iconify.scan();
  } catch (e) {
    document.getElementById('page-body').innerHTML = `<div class="bg-red-50 border border-red-200 text-red-700 p-4 rounded-lg">加载失败：${U.escapeHtml(e.message)}</div>`;
  }
})();
