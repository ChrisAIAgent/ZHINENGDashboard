(async () => {
  mountSidebar('aging');
  setBreadcrumb([{ label: '首页' }, { label: 'Aging 分析' }]);
  setToday();

  try {
    const data = await api.getAging();
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('page-content').classList.remove('hidden');

    const bucketColors = { "0-3d": "green", "3-7d": "blue", "7-14d": "orange", ">14d": "red" };
    const buckets = data.buckets;

    document.getElementById('bucket-cards').innerHTML = Object.entries(buckets).map(([b, n]) => {
      const c = bucketColors[b];
      return `
        <div class="bg-white p-5 rounded-xl border shadow-sm">
          <div class="flex justify-between items-start">
            <div>
              <p class="text-sm font-medium text-gray-500">${b}</p>
              <h3 class="text-3xl font-bold mt-2 text-${c}-600">${U.formatNumber(n)}</h3>
            </div>
            <div class="p-2 bg-${c}-50 text-${c}-600 rounded-lg"><span class="iconify text-xl" data-icon="ri:hourglass-line"></span></div>
          </div>
          <div class="mt-3 text-xs text-gray-400">未关闭 Ticket 数</div>
        </div>
      `;
    }).join("");

    const cats = Object.keys(data.by_category);
    const chart = echarts.init(document.getElementById('agingChart'));
    const bucketColorMap = { "0-3d": "#10B981", "3-7d": "#3B82F6", "7-14d": "#F97316", ">14d": "#EF4444" };
    chart.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: Object.keys(buckets) },
      grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
      xAxis: { type: 'category', data: cats },
      yAxis: { type: 'value' },
      series: Object.keys(buckets).map(b => ({
        name: b, type: 'bar', stack: 'aging',
        itemStyle: { color: bucketColorMap[b] },
        data: cats.map(c => data.by_category[c][b])
      }))
    });
    window.addEventListener('resize', () => chart.resize());

    document.getElementById('overdue-tbody').innerHTML = data.overdue_top.map(t => `
      <tr class="hover:bg-gray-50 cursor-pointer" onclick="location.href='ticket-detail.html?id=${t.id}'">
        <td class="px-6 py-4"><span class="text-blue-600 font-medium hover:underline">${t.id}</span></td>
        <td class="px-6 py-4 max-w-xs"><span class="text-gray-800 truncate inline-block max-w-[300px] align-middle">${U.escapeHtml(t.subject)}</span></td>
        <td class="px-6 py-4">${U.categoryBadge(t.category)}</td>
        <td class="px-6 py-4 text-gray-700">${U.escapeHtml(t.owner_name)}</td>
        <td class="px-6 py-4">${U.statusBadge(t.status)}</td>
        <td class="px-6 py-4 text-right">${U.agingBadge(t.aging_days)}</td>
      </tr>
    `).join("") || `<tr><td colspan="6" class="px-6 py-12 text-center text-gray-400">无逾期 Ticket</td></tr>`;

    iconify.scan();
  } catch (e) {
    document.getElementById('loading').innerHTML = `<div class="text-red-500">加载失败：${U.escapeHtml(e.message)}</div>`;
  }
})();
