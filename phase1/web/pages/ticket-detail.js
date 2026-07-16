(async () => {
  mountSidebar('ticket-detail');
  setBreadcrumb([{ label: '首页' }, { label: 'Ticket 列表', href: 'tickets.html' }, { label: '详情' }]);
  setToday();

  const params = new URLSearchParams(location.search);
  const id = params.get('id') || 'TKT-2026-0001';

  try {
    const t = await api.getTicket(id);
    document.getElementById('detail-loading').classList.add('hidden');
    document.getElementById('detail-content').classList.remove('hidden');
    document.title = `${t.id} - Ticket 详情`;

    document.getElementById('d-id').textContent = t.id;
    document.getElementById('d-subject').textContent = t.subject;
    document.getElementById('d-category').innerHTML = U.categoryBadge(t.category);
    document.getElementById('d-status').innerHTML = U.statusBadge(t.status);
    document.getElementById('d-priority').innerHTML = U.priorityBadge(t.priority);
    document.getElementById('d-next-action').textContent = t.next_action || '—';
    document.getElementById('d-dealer').textContent = t.dealer_name || '—';
    document.getElementById('d-model').textContent = t.machine_model || '—';
    document.getElementById('d-owner').textContent = t.owner_name || '—';
    document.getElementById('d-aging').innerHTML = U.agingBadge(t.aging_days);
    document.getElementById('d-open').textContent = U.formatDate(t.open_date);
    document.getElementById('d-lastupd').textContent = U.formatRelative(t.last_update);
    document.getElementById('d-emails').textContent = t.email_count;
    document.getElementById('d-conv').textContent = t.conversation_id;

    document.getElementById('d-timeline').innerHTML = t.timeline.map((ev, i) => `
      <div class="flex gap-3">
        <div class="shrink-0 mt-1">
          <div class="w-8 h-8 bg-${i === 0 ? 'blue' : 'gray'}-100 text-${i === 0 ? 'blue' : 'gray'}-600 rounded-full flex items-center justify-center">
            <span class="iconify" data-icon="ri:checkbox-circle-line"></span>
          </div>
        </div>
        <div class="flex-1 pb-2">
          <p class="text-sm font-semibold text-gray-800">${U.escapeHtml(ev.event)}</p>
          <p class="text-xs text-gray-500 mt-0.5">${U.formatDateTime(ev.at)} · ${U.escapeHtml(ev.actor)}</p>
          ${ev.note ? `<p class="text-sm text-gray-600 mt-1">${U.escapeHtml(ev.note)}</p>` : ''}
        </div>
      </div>
    `).join("");

    document.getElementById('d-emails-list').innerHTML = t.emails.map(e => `
      <div class="border rounded-lg p-4 ${e.direction === 'in' ? 'bg-blue-50/30 border-blue-100' : 'bg-gray-50'}">
        <div class="flex justify-between items-start mb-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="iconify ${e.direction === 'in' ? 'text-blue-500' : 'text-green-500'} shrink-0" data-icon="${e.direction === 'in' ? 'ri:mail-download-line' : 'ri:mail-upload-line'}"></span>
            <span class="text-sm font-semibold text-gray-800 truncate">${U.escapeHtml(e.from)} → ${U.escapeHtml(e.to)}</span>
          </div>
          <span class="text-xs text-gray-400 shrink-0 ml-2">${U.formatRelative(e.received_at)}</span>
        </div>
        <p class="text-sm text-gray-600 mt-1">${U.escapeHtml(e.body_preview)}</p>
      </div>
    `).join("") || `<p class="text-sm text-gray-400 text-center py-8">暂无邮件</p>`;

    iconify.scan();
  } catch (e) {
    document.getElementById('detail-loading').innerHTML = `<div class="text-red-500">加载失败：${U.escapeHtml(e.message)}</div>`;
  }
})();
