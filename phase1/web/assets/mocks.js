// mocks.js — Phase 1: 已禁用。
// 真实数据由 phase1/workers/worker 通过 Microsoft Graph 拉取。
// 保留此文件仅为兼容 dashboard.html 的 <script src="assets/mocks.js"> 引用，
// 让 api.js 在 Worker 离线时返回空数组而不是抛错。

(function(global){
  const empty = () => ({ items: [], total: 0, page: 1, pageSize: 20, data: [] });

  global.__MOCKS__ = {
    "GET /kpi/overview":     () => ({ totals: { active: 0, new_this_week: 0, closed_this_week: 0, overdue: 0 }, by_category: {}, trend: [] }),
    "GET /tickets":          () => empty(),
    "GET /tickets/:id":      () => null,
    "GET /owners/workload":  () => ({ items: [] }),
    "GET /aging/buckets":    () => ({ buckets: { "0-3d":0, "3-7d":0, "7-14d":0, ">14d":0 }, by_category: {}, overdue_top: [] })
  };
  global.__MOCKS_DEALERS__ = [];
  global.__MOCKS_OWNERS__  = [];
})(window);
