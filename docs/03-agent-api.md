# Agent API — 企业看板 REST 接口规范

> 外部 Agent（n8n / Dify / Python 脚本）通过 REST API 读写工单，
> 配合 DeepSeek 等 LLM 对邮件线程做结构化元数据抽取后写回，实现智能工单分类与调度。

## 1. 连接信息

| 项目 | 值 |
|------|-----|
| Base URL | `http://localhost:8787` |
| 鉴权方式 | `Authorization: Bearer <api_key>` |
| API Key | `.env` 中 `API_KEY=` 的值（当前: `agent-dashboard-2026`） |
| Content-Type | `application/json` |

> API Key 可随时修改（改 `.env` → 重启 node-proxy）。前端看板使用 `X-IMAP-Auth` 头，与 Agent 的 Bearer 互不干扰。

## 2. 端点总览

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/kpi/overview` | KPI 总览（active/new/closed/overdue + 分类统计 + 7天趋势） |
| GET | `/api/tickets` | 工单列表（支持筛选+分页） |
| GET | `/api/tickets/:id` | 工单详情（元数据 + 邮件时间线） |
| GET | `/api/owners/workload` | Owner 工作量统计 |
| GET | `/api/aging/buckets` | Aging 桶分布 + Overdue Top 50 |
| PATCH | `/api/tickets/:id` | **写回 LLM 抽取的元数据**（Agent 专用） |

> PATCH 端点仅接受 Bearer 鉴权。GET 端点同时支持前端 `X-IMAP-Auth` 和 Agent `Bearer`。

## 3. 端点详情

### 3.1 GET /api/kpi/overview

```
curl -H "Authorization: Bearer agent-dashboard-2026" \
  http://localhost:8787/api/kpi/overview
```

**响应字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| totals.active | number | 活跃工单数 |
| totals.new_this_week | number | 本周新建 |
| totals.closed_this_week | number | 本周关闭 |
| totals.overdue | number | 逾期数（>7天未更新） |
| by_category.* | object | 按分类统计 |
| trend[] | array | 7天趋势 (date/created/closed) |

### 3.2 GET /api/tickets

```
curl -H "Authorization: Bearer agent-dashboard-2026" \
  "http://localhost:8787/api/tickets?category=Warranty&status=Open&page=1&pageSize=20"
```

**查询参数：**

| 参数 | 说明 |
|------|------|
| category | 按分类筛选 (Service/Warranty/Sales/Parts/Technical) |
| status | 按状态筛选 (Open/Pending/Waiting Dealer/Waiting HQ/Closed) |
| owner | 按 owner_email 筛选 |
| dealer | 按 dealer_code 筛选 |
| q | 关键词搜索 |
| page | 页码（默认 1） |
| pageSize | 每页条数（默认 50，最大 200） |

**响应项字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 工单短 ID（8位） |
| conversation_id | string | Gmail threadId（用于 PATCH 时的唯一标识） |
| subject | string | 邮件主题 |
| category | string | 分类 |
| dealer_name / dealer_code | string | 经销商 |
| status | string | 状态 |
| owner_email / owner_name | string | 负责人 |
| priority | string | high / normal |
| aging_days | number | 活跃天数 |
| next_action | string | 建议下一步 |
| machine_model | string/null | 机械型号 |
| part_number | string/null | 零件编号 |
| summary | string/undefined | LLM 抽取的摘要（Agent 写入后存在） |

### 3.3 GET /api/tickets/:id

```
curl -H "Authorization: Bearer agent-dashboard-2026" \
  http://localhost:8787/api/tickets/18255b29
```

`:id` 可以是短 ID（8位）或完整 `conversation_id`。

**额外包含：**
- `emails[]` — 线程中每封邮件的 from/to/body/direction
- `timeline[]` — 事件时间线

### 3.4 PATCH /api/tickets/:id ⭐ Agent 核心端点

```
curl -X PATCH -H "Authorization: Bearer agent-dashboard-2026" \
  -H "Content-Type: application/json" \
  -d '{
    "category": "Warranty",
    "status": "Open",
    "priority": "high",
    "dealer_name": "Mountaintop Equipment",
    "dealer_code": "US-MT",
    "owner_email": "support@sunwardamerica.com",
    "owner_name": "Support Team",
    "summary": "SW240UF 液压泵保修索赔，需紧急更换",
    "next_action": "备件发货并安排现场服务",
    "machine_model": "SW240UF",
    "part_number": "240155089234"
  }' \
  http://localhost:8787/api/tickets/<id>
```

**可写字段（全部可选，传什么改什么）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| category | string | Service / Warranty / Sales / Parts / Technical |
| dealer_name | string | 经销商名称 |
| dealer_code | string | 经销商代码 |
| status | string | Open / Pending / Waiting Dealer / Waiting HQ / Closed |
| owner_email | string | 负责人邮箱 |
| owner_name | string | 负责人姓名 |
| priority | string | high / normal |
| summary | string | 会话摘要 |
| next_action | string | 建议下一步动作 |
| machine_model | string | 机械型号 |
| part_number | string | 零件编号 |

**响应：**

```json
{
  "ok": true,
  "id": "18255b29",
  "threadId": "19f5184218255b29",
  "updated": { "threadId": "...", "updatedAt": "...", "category": "Warranty", ... }
}
```

**特性：**
- 写入立即生效：PATCH 成功后同一请求周期内 GET 即返回新值
- 持久化：写入 `scripts/llm-metadata.json`，重启不丢失
- 优先级：Agent 写入的值覆盖正则抽取结果（下次缓存刷新时自动合并）
- 幂等：同一 threadId 重复 PATCH 会覆盖

### 3.5 GET /api/owners/workload

```
curl -H "Authorization: Bearer agent-dashboard-2026" \
  http://localhost:8787/api/owners/workload
```

### 3.6 GET /api/aging/buckets

```
curl -H "Authorization: Bearer agent-dashboard-2026" \
  http://localhost:8787/api/aging/buckets
```

## 4. Agent 标准工作流

```
┌─────────────────────────────────────────────────────┐
│  Agent 工作流（n8n / Dify / Python 脚本）          │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ① GET /api/tickets?pageSize=200                    │
│     → 拿到所有工单，筛选 category 含误判的         │
│     → conversation_id 作为唯一标识                  │
│                                                     │
│  ② GET /api/tickets/:id                             │
│     → 拿完整线程内容（emails[].body）              │
│     → 拼接为 LLM prompt                            │
│                                                     │
│  ③ 调 DeepSeek / OpenAI 抽取                       │
│     → 输入: 线程主题+正文                          │
│     → 输出: JSON {category, dealer, status, ...}    │
│     → Prompt 模板见下文 §5                         │
│                                                     │
│  ④ PATCH /api/tickets/:id                           │
│     → 将 LLM 返回的字段写回                        │
│     → 看板立即反映                                 │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 调度建议

- **增量模式**：记录上次处理的 `updatedAt`，只处理新建/未抽取的工单
- **全量模式**：定时全量跑（如每 30 分钟），LLM 重新抽取覆盖
- **选择性**：只处理 category=Technical 的（最可能误判），或用正则初筛

## 5. LLM 抽取 Prompt 模板

System prompt：

```
你是企业邮件工单分析助手。从邮件会话中提取结构化元数据，严格输出 JSON 数组。

## 业务词汇表
分类（category）只能是以下之一：Service / Warranty / Sales / Parts / Technical
状态（status）只能是以下之一：Open / Pending / Waiting Dealer / Waiting HQ / Closed
优先级（priority）只能是以下之一：high / normal
紧急度（urgency）只能是以下之一：high / medium / low

## 字段说明
- dealer_name: 经销商名称（从邮件域名/内容推断）
- dealer_code: 经销商代码（如 US-MT, US-ABC 等，无法确定填 "unknown"）
- owner_name / owner_email: 工单负责人（线程中 @sunwardamerica.com 内部发件人，如无不填）
- machine_model: 工程机械型号（如 SW240UF、SWE155UF 等，正则匹配）
- part_number: 零件编号（9-12 位数字）
- summary: 会话摘要（1-2 句中文）
- next_action: 建议下一步动作（如"备件发货并开票"、"等待经销商回复"）

## 规则
1. 仅从邮件内容推断，不要编造。
2. 分类按关键词和语义综合判断：price/quote/order→Sales，warranty/claim/defect→Warranty，service/repair/broken→Service，part/stock/inventory→Parts，其余→Technical。
3. status 从最新邮件语气判断：经销商在等回复→Waiting HQ，HQ 在等经销商→Waiting Dealer，已确认关闭→Closed，刚发起→Open。
4. summary 简洁，提到关键信息（什么设备/什么问题/需要什么）。
```

User prompt：

```
分析以下 N 个邮件会话，对每个提取结构化元数据。返回纯 JSON 数组（不要 markdown 代码块）。

### <threadId>
主题: <subject>
发件人: <from>
收件人: <to>
日期: <date>
会话邮件数: <messageCount>
正文:
<email body>
```

调用 DeepSeek API 时建议 `temperature: 0.1`，`response_format: { type: "json_object" }`。

## 6. 错误码

| 状态码 | 含义 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误（缺少字段/JSON 格式错误） |
| 401 | 缺少鉴权（需带 X-IMAP-Auth 或 Bearer） |
| 403 | PATCH 端点仅限 Bearer（Agent 专用） |
| 404 | 工单不存在 |
| 500 | 服务端内部错误 |

## 7. 完整示例：Python Agent

```python
import requests
import json

BASE = "http://localhost:8787"
HEADERS = {"Authorization": "Bearer agent-dashboard-2026"}

# 1. 获取未处理的工单
resp = requests.get(f"{BASE}/api/tickets", headers=HEADERS, params={"pageSize": 200})
tickets = resp.json()["items"]

# 2. 筛选需要 LLM 处理的（如未被 Agent 写过的）
to_process = [t for t in tickets if not t.get("summary")]

for t in to_process[:10]:  # 每次处理 10 条，控制成本
    # 3. 获取线程详情
    detail = requests.get(f"{BASE}/api/tickets/{t['id']}", headers=HEADERS).json()
    thread_text = "\n---\n".join([e["body"] for e in detail.get("emails", [])])
    
    # 4. 调 DeepSeek 抽取
    deepseek_resp = requests.post(
        "https://api.deepseek.com/v1/chat/completions",
        headers={"Authorization": "Bearer sk-your-deepseek-key"},
        json={
            "model": "deepseek-chat",
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},  # 见 §5
                {"role": "user", "content": f"### {t['conversation_id']}\n{t['subject']}\n{thread_text}"}
            ],
            "temperature": 0.1,
            "response_format": {"type": "json_object"}
        }
    )
    extracted = json.loads(deepseek_resp.json()["choices"][0]["message"]["content"])
    
    # 5. 写回看板
    requests.patch(f"{BASE}/api/tickets/{t['id']}", headers=HEADERS, json=extracted)
```

## 8. n8n 最小配置

1. **HTTP Request 节点** — GET `http://localhost:8787/api/tickets?pageSize=200`
2. **Code 节点** — 筛选需要 LLM 的工单
3. **Loop 节点** — 遍历工单
4. **HTTP Request 节点** — GET 详情 + POST DeepSeek + PATCH 写回
5. **Cron 触发器** — 每 30 分钟

> n8n 的 HTTP Request 节点 Header 填 `Authorization: Bearer agent-dashboard-2026`
