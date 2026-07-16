// sidebar.js - 侧栏注入器。每页调用 mountSidebar(currentPageKey)

(function(global){
  const NAV = [
    {
      group: "工作台",
      items: [
        { key: "dashboard", label: "Ticket 看板", icon: "ri:dashboard-3-line", href: "dashboard.html" },
        { key: "tickets",   label: "Ticket 列表", icon: "ri:list-check-2",     href: "tickets.html" }
      ]
    },
    {
      group: "分析",
      items: [
        { key: "owners", label: "Owner 工作量", icon: "ri:user-heart-line",  href: "owners.html" },
        { key: "aging",  label: "Aging 分析",   icon: "ri:hourglass-line",   href: "aging.html" }
      ]
    },
    {
      group: "Detail",
      items: [
        { key: "ticket-detail", label: "Ticket 详情", icon: "ri:file-list-3-line", href: "ticket-detail.html" }
      ]
    }
  ];

  function mountSidebar(currentKey) {
    const slot = document.getElementById("sidebar");
    if (!slot) return;
    const groups = NAV.map(g => `
      <div class="pt-4 pb-2 px-4 text-xs font-semibold text-gray-500 uppercase tracking-widest">${g.group}</div>
      ${g.items.map(it => `
        <a class="flex items-center px-4 py-3 hover:bg-white/10 rounded-md transition-all nav-item" data-page="${it.key}" href="${it.href}">
          <span class="iconify mr-3" data-icon="${it.icon}"></span>
          <span class="text-sm font-medium">${it.label}</span>
        </a>
      `).join("")}
    `).join("");
    slot.innerHTML = `
      <aside class="w-64 bg-[#001529] text-gray-300 flex flex-col shrink-0 h-full">
        <div class="h-16 flex items-center px-6 gap-3 shrink-0">
          <div class="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
            <span class="iconify text-white text-xl" data-icon="ri:dashboard-3-line"></span>
          </div>
          <span class="text-white font-bold text-lg tracking-wider">企业看板</span>
        </div>
        <nav class="flex-1 mt-4 px-3 space-y-1 overflow-y-auto">${groups}</nav>
        <div class="p-4 border-t border-white/10 text-xs text-gray-500 shrink-0">Phase 1 · v0.1</div>
      </aside>`;
    // 激活当前页
    document.querySelectorAll(".nav-item").forEach(item => {
      if (item.getAttribute("data-page") === currentKey) {
        item.classList.add("sidebar-item-active");
        item.classList.remove("hover:bg-white/10");
      }
    });
    if (global.iconify) global.iconify.scan();
  }

  function setBreadcrumb(items) {
    const slot = document.getElementById("breadcrumb");
    if (!slot) return;
    slot.innerHTML = `<ol class="flex items-center space-x-2">
      ${items.map((it, i) => i === items.length - 1
        ? `<li><span class="text-gray-900 font-medium">${it.label}</span></li>`
        : `<li>${it.label}<span class="iconify text-xs mx-2" data-icon="ri:arrow-right-s-line"></span></li>`).join("")}
    </ol>`;
    if (global.iconify) global.iconify.scan();
  }

  function setToday() {
    const slot = document.getElementById("today");
    if (slot) slot.textContent = new Date().toLocaleDateString("zh-CN", { year:"numeric", month:"long", day:"numeric", weekday:"long" });
  }

  global.mountSidebar = mountSidebar;
  global.setBreadcrumb = setBreadcrumb;
  global.setToday = setToday;
})(window);
