# Phase 1 API 契约

> 本文件定义前端 Dashboard 调用的所有 REST 端点。前端通过 `assets/api.js` 调用，失败时自动 fallback 到 `assets/mocks.js`。后端 Worker 实现必须严格遵循此契约。

Base URL: `/api`

## 通用约定

| 项 | 约定 |
|----|------|
| 鉴权 | `Authorization: Bearer <token>`（Cloudflare Access JWT 或自定义） |
| Content-Type | `application/json` |
| 错误响应 | `{ "error": { "code": "...", "message": "..." } }` + HTTP 4xx/5xx |
| 时间字段 | ISO 8601 字符串（`2026-07-04T08:23:00Z`） |
| 分页参数 | `page`（默认 1）、`pageSize`（默认 20，上限 100） |

## 端点清单

### 1. `GET /api/kpi/overview`

返回 Dashboard 顶部 KPI + 趋势。

**请求参数**：无

**响应**：
```json
{
  "totals": {
    "active": 38,
    "new_this_week": 12,
    "closed_this_week": 7,
    "overdue": 5
  },
  "by_category": {
    "Service":  { "active": 12, "new_this_week": 4, "closed_this_week": 3, "avg_cycle_hours": 48 },
    "Warranty": { "active": 8,  "new_this_week": 3, "closed_this_week": 2, "avg_cycle_hours": 72 },
    "Sales":    { "active": 10, "new_this_week": 3, "closed_this_week": 1, "avg_cycle_hours": 96 },
    "Parts":    { "active": 5,  "new_this_week": 1, "closed_this_week": 1, "avg_cycle_hours": 24 },
    "Technical":{ "active": 3,  "new_this_week": 1, "closed_this_week": 0, "avg_cycle_hours": 36 }
  },
  "trend": [
    { "date": "2026-06-28", "created": 8, "closed": 5 },
    { "date": "2026-06-29", "created": 6, "closed": 4 },
    ...
  ]
}
```

### 2. `GET /api/tickets`

返回 Ticket 列表，支持筛选与分页。

**请求参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `category` | string | Service / Warranty / Sales / Parts / Technical |
| `status` | string | Open / Pending / Waiting Dealer / Waiting HQ / Closed |
| `owner` | string | 负责人邮箱 |
| `dealer` | string | Dealer Code |
| `q` | string | 模糊匹配 Ticket ID 或主题 |
| `page` | int | 默认 1 |
| `pageSize` | int | 默认 20，上限 100 |

**响应**：
```json
{
  "total": 42,
  "page": 1,
  "pageSize": 20,
  "items": [
    {
      "id": "TKT-2026-0001",
      "conversation_id": "conv-xxx",
      "subject": "Service inquiry - Shanghai Heavy - M-1000",
      "category": "Service",
      "dealer_code": "D001",
      "dealer_name": "Shanghai Heavy Machinery Co.",
      "machine_model": "M-1000",
      "owner_email": "zhang.wei@company.com",
      "owner_name": "张伟",
      "status": "Open",
      "priority": "normal",
      "last_update": "2026-07-04T08:23:00Z",
      "open_date": "2026-06-25T03:11:00Z",
      "aging_days": 9,
      "next_action": "Awaiting dealer response",
      "email_count": 3
    }
  ]
}
```

### 3. `GET /api/tickets/:id`

返回单个 Ticket 详情，含邮件 timeline。

**响应**：
```json
{
  "id": "TKT-2026-0001",
  ...(所有 list item 字段),
  "emails": [
    {
      "id": "msg-xxx-0",
      "from": "dealer@example.com",
      "to": "service@company.com",
      "subject": "...",
      "received_at": "2026-06-25T03:11:00Z",
      "body_preview": "邮件正文摘要...",
      "direction": "in"  // in | out
    }
  ],
  "timeline": [
    {
      "at": "2026-06-25T03:11:00Z",
      "event": "Ticket created",
      "actor": "AI",
      "note": "从邮件自动聚合，识别为 Service"
    }
  ]
}
```

### 4. `GET /api/owners/workload`

返回各 Owner 的工作量统计。

**响应**：
```json
{
  "items": [
    {
      "owner_email": "zhang.wei@company.com",
      "owner_name": "张伟",
      "role": "Service Manager",
      "active_count": 12,
      "closed_this_week": 3,
      "avg_cycle_hours": 48,
      "longest_aging_days": 9
    }
  ]
}
```

### 5. `GET /api/aging/buckets`

返回 Aging 桶分布 + Overdue Top 10。

**响应**：
```json
{
  "buckets": {
    "0-3d": 18,
    "3-7d": 10,
    "7-14d": 7,
    ">14d": 3
  },
  "by_category": {
    "Service":  { "0-3d": 6, "3-7d": 3, "7-14d": 2, ">14d": 1 },
    "Warranty": { ... },
    ...
  },
  "overdue_top": [
    { /* ticket item */ }
  ]
}
```

## 实现状态

| 端点 | Mock | Worker 实现 |
|------|------|------------|
| GET /api/kpi/overview | ✅ mocks.js | ⏳ Phase 1.5 |
| GET /api/tickets | ✅ mocks.js | ⏳ Phase 1.5 |
| GET /api/tickets/:id | ✅ mocks.js | ⏳ Phase 1.5 |
| GET /api/owners/workload | ✅ mocks.js | ⏳ Phase 1.5 |
| GET /api/aging/buckets | ✅ mocks.js | ⏳ Phase 1.5 |

## Worker 实现要求（P2 待办）

- 部署在 Cloudflare Workers
- 读 D1（SQLite）表 `tickets`、`emails`、`ticket_events`
- 计算指标（在 Worker 内存中聚合，避免 SQL 复杂查询）
- 用 Cloudflare Cache API 缓存 KPI 类端点（TTL 5 分钟）
- CORS：允许前端域名
