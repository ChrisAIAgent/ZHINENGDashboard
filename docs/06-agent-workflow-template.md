# Agent 工作流通用模板 —— 如何调用 API 修改看板

> **给谁看**：任何要接入企业看板、通过 REST API 读取并修改工单的 Agent（Python / Node / n8n / Dify / OpenClaw 等）。
> **目标**：读完本文，Agent 就知道「拉什么、判断什么、写回什么、怎么验证生效」。
> 连接凭证与环境地址见 [05-agent-access.md](./05-agent-access.md)；完整端点契约见 [03-agent-api.md](./03-agent-api.md)。
> 本文所有流程均已在生产环境（`43.172.73.230:8088`）实测跑通。

---

## 0. 一句话心智模型

> **看板 = Gmail 邮件的只读镜像 + 一层可写的「结构化标签」。**
> Agent 不能增删工单、不能收发邮件，但能给每个工单**打/改标签**（分类、状态、负责人、摘要、优先级……），看板据此聚合展示。

```
Gmail 邮件 ──(只读同步)──> 工单 ──(Agent 用 PATCH 打标签)──> 看板聚合/分桶展示
```

---

## 1. 标准工作流循环（5 步）

这是所有「Agent 改看板」任务的通用骨架，按需裁剪：

```
① 拉取     GET /api/tickets?pageSize=200        → 拿全部工单（conversation_id 作唯一键）
   ↓  筛选出要处理的（未打标 / 误判 / 某分类 / overdue…）
② 取详情   GET /api/tickets/:id                 → 拿完整邮件线程 emails[].body
   ↓  拼成给 LLM 的输入（可选，纯规则任务可跳过）
③ 判断     调你自己的 LLM（DeepSeek/OpenAI…）  → 输出结构化字段 JSON
   ↓  或用规则/正则直接算出要写的值
④ 写回     PATCH /api/tickets/:id               → 把结果写回，立即生效 + 持久化
   ↓
⑤ 验证     GET /api/kpi/overview 或 /tickets    → 回读确认数值变化，前端刷新可见
```

> **关键原则**：Agent 是「判断 + 写回」，看板是「存储 + 展示」。判断逻辑（LLM 或规则）在 Agent 侧，看板只认最终写回的字段值。

---

## 2. Agent 能改看板的哪些东西（可写字段）

`PATCH /api/tickets/:id`，全部可选、传什么改什么、按 `conversation_id` 幂等覆盖：

| 字段 | 取值 | 改动后看板哪里变 |
|------|------|-----------------|
| `category` | Service / Warranty / Sales / Parts / Technical | 分类占比图、分类筛选 |
| `status` | Open / Pending / Waiting Dealer / Waiting HQ / Closed | **生命周期分桶**（见 §4）、Active 数 |
| `priority` | high / normal | 优先级标记、排序 |
| `owner_email` / `owner_name` | 邮箱 / 姓名 | Owner 工作量统计 |
| `dealer_name` / `dealer_code` | 文本 | 经销商筛选 |
| `summary` | 文本 | 工单摘要展示 |
| `next_action` | 文本 | 建议下一步 |
| `machine_model` | 型号文本 | 设备维度 |
| `part_number` | 编号文本 | 零件维度 |
| `urgency` | high / medium / low | 紧急度 |

**写回特性（已实测）：**
- 立即生效：PATCH 成功后同周期 GET 即返回新值；
- 持久化：落地 `scripts/llm-metadata.json`，服务重启不丢；
- 抗覆盖：按 `conversation_id` 合并，Gmail 重新同步**不会冲掉** Agent 写回值（Agent 值优先于正则初筛）。

**Agent 不能做：** 创建/删除工单、发送/回复邮件、改邮件原文、改系统配置或鉴权。

---

## 3. 复制即用的代码模板

### Python（标准库，无需 pip）

```python
import urllib.request, json, time

BASE = "http://43.172.73.230:8088/api"        # 生产；本地用 http://localhost:8787/api
KEY  = "<你的 API_KEY>"                         # 看板门禁卡，非 LLM key
AH   = {"Authorization": "Bearer " + KEY}

def get(path, tries=4):
    """GET，带重试（应对偶发 502 nginx 瞬断）"""
    for i in range(tries):
        try:
            req = urllib.request.Request(BASE + path, headers=AH)
            return json.load(urllib.request.urlopen(req, timeout=30))
        except Exception:
            if i == tries - 1: raise
            time.sleep(1.5)

def patch(tid, payload, tries=4):
    """PATCH 写回标签，带重试"""
    data = json.dumps(payload).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(
                BASE + "/tickets/" + tid, data=data, method="PATCH",
                headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
            return json.load(urllib.request.urlopen(req, timeout=30))
        except Exception:
            if i == tries - 1: raise
            time.sleep(1.5)

# ① 拉取
tickets = get("/tickets?pageSize=200")["items"]

# ② + ③ 判断（这里示意：把 LLM 判断的标签算出来）
for t in tickets:
    detail = get("/tickets/" + t["id"])                 # 取线程
    thread = "\n---\n".join(e.get("body","") for e in detail.get("emails", []))
    label  = your_judge(t, thread)                       # -> {"category": "...", "status": "...", ...}

    # ④ 写回
    r = patch(t["id"], label)
    print(t["id"], "ok=", r.get("ok"))

# ⑤ 验证
print(get("/kpi/overview")["totals"])
```

### Node.js（v18+ 内置 fetch）

```js
const BASE = "http://43.172.73.230:8088/api";
const KEY  = "<你的 API_KEY>";
const H    = { Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

async function get(path)          { return (await fetch(BASE + path, { headers: H })).json(); }
async function patch(tid, body)   {
  return (await fetch(`${BASE}/tickets/${tid}`, { method: "PATCH", headers: H, body: JSON.stringify(body) })).json();
}

const { items } = await get("/tickets?pageSize=200");     // ①
for (const t of items) {
  const detail = await get(`/tickets/${t.id}`);           // ②
  const thread = (detail.emails || []).map(e => e.body).join("\n---\n");
  const label  = await yourJudge(t, thread);              // ③ LLM/规则判断
  const r      = await patch(t.id, label);                // ④ 写回
  console.log(t.id, r.ok);
}
console.log((await get("/kpi/overview")).totals);         // ⑤ 验证
```

> 项目内置参考实现：`scripts/agent-run.mjs`（拉→判断→写回闭环，支持 `--dry-run` / `--limit` / `--key`）。

---

## 4. 场景模板 A：生命周期分桶（已实测）

**目标**：把工单分门别类到 Active / 本周新增 / 本周已关闭 / Overdue 四个桶。

**分桶规则**（Agent 端纯读即可算，字段 `status` / `open_date` / `aging_days` 均已暴露）：

| 桶 | 判定规则 | 与后台 KPI 口径 |
|----|---------|----------------|
| **Active** | `status != "Closed"` | ✅ 完全一致 |
| **本周新增** | `open_date >= 今天-7天` | ✅ 基本一致（时区边界差 ±1） |
| **本周已关闭** | `status == "Closed"` 且 `last_update >= 今天-7天` | ⚠️ 见下方注意 |
| **Overdue** | `isActive(t) && aging_days > 7` | ✅ 完全一致 |

**若要「判断标签后再分桶」**（推荐，解决正则分类不准）：在分桶前先跑 §1 的 ②③④——用 LLM 判断真实 `category`/`status` 并 PATCH 写回，再按上表分桶，桶和看板就都准了。

**⚠️ 重要口径注意（实测踩坑）：**
- 后端「本周已关闭」= `status=Closed` **且** `last_update` 在 7 天内。
- `last_update` 是 **Gmail 邮件最后活动时间，Agent 的 PATCH 改不了它**。
- 后果：Agent 把一封「老邮件」标成 Closed，它会进 Closed 列表，但**不计入「本周已关闭」**（因为邮件本身不是本周活跃的）。
- 实测：PATCH 4 封 Closed → `closed_this_week` 只从 0 涨到 2（另 2 封邮件是上周的）。
- **若要严格按「Agent 关闭动作时间」统计**：需给 `server.js` 增加 `closed_at` 字段，PATCH status=Closed 时写入当前时间，KPI 改用 `closed_at` 判定（小改动，尚未实施）。

---

## 5. 场景模板 B：用 LLM 纠正分类（判断标签）

**目标**：现有 `category`/`status` 是正则初筛，对非标准邮件不准；用 LLM 重新判断并写回。

```
GET /api/tickets?pageSize=200
  → 筛出可疑的（如 category=Technical 兜底桶，最可能误判）
GET /api/tickets/:id  取 emails[].body
  → 拼 prompt（System prompt + 业务词汇表见 03-agent-api.md §5）
调 LLM，temperature=0.1，response_format=json_object
  → 得到 {category, status, dealer_name, summary, next_action, ...}
PATCH /api/tickets/:id 写回
  → 看板分类占比图立即修正
```

LLM 判断的**约束词表**（务必写进 prompt，否则会产生看板不认的值）：
- category ∈ {Service, Warranty, Sales, Parts, Technical}
- status ∈ {Open, Pending, Waiting Dealer, Waiting HQ, Closed}
- priority ∈ {high, normal}；urgency ∈ {high, medium, low}

完整 System/User prompt 模板见 [03-agent-api.md](./03-agent-api.md) §5。

---

## 6. 验证「改动是否生效」

| 层 | 怎么验 | 预期 |
|----|--------|------|
| 数据层 | PATCH 后立刻 `GET /api/tickets/:id` 回读 | 字段=刚写的值 |
| 聚合层 | `GET /api/kpi/overview` 看 totals | 数值随之变化 |
| 展示层 | 浏览器打开看板，**手动刷新**（顶栏芯片 / F5） | 页面显示新值 |

> **前端默认无自动轮询**，Agent 写回后打开的看板页需手动刷新一次才更新（刷新后即最新，不是假数据）。
> 若需自动实时，可在前端加 `setInterval(() => location.reload(), 30000)`（30s 轮询，小改动）。

---

## 7. 已知坑 & 应对（实测）

| 现象 | 原因 | 应对 |
|------|------|------|
| 偶发 `502 Bad Gateway` | nginx 反代瞬断 / node-proxy 忙 | GET/PATCH 均加**重试**（见 §3 代码，退避 1.5s） |
| `401` | 没带 Bearer / key 错 | Header `Authorization: Bearer <API_KEY>` 一字不差 |
| `403` | 用 `X-IMAP-Auth` 打 PATCH | PATCH **只认 Bearer**（Agent 专用）；GET 两种都行 |
| PATCH 成功但「本周已关闭」没涨 | `last_update` 非本周（见 §4 注意） | 属正常口径；要精确需加 `closed_at` |
| 端口打错写不进 | 生产走 `:8088/api`（nginx） | 不是 `:8787`（那只对本机开放） |
| 改了 key 不生效 | 没重启 | 服务器改 `.env` 后 `pm2 restart dashboard-api` |
| 看板不变 | 前端无自动刷新 | 手动刷新，或加 30s 轮询（§6） |

---

## 8. 接入检查清单

- [ ] 拿到 `API_KEY`（看板门禁卡，非 LLM key），确认能 `GET /api/kpi/overview` 返回 200
- [ ] 确认环境地址：生产 `43.172.73.230:8088/api` / 本地 `localhost:8787/api`
- [ ] GET/PATCH 封装带重试（应对 502）
- [ ] 写回字段值落在 §2 的合法取值域内（尤其 category/status 枚举）
- [ ] PATCH 后回读验证 + KPI 数值核对
- [ ] 告知使用者：看板需手动刷新（或已加轮询）
- [ ]（可选）需要 LLM 判断标签 → 备好自己的 DeepSeek/OpenAI key
- [ ]（可选）需要精确「本周已关闭」→ 先给 server.js 加 `closed_at`

---

## 附：三份文档分工

| 文档 | 定位 |
|------|------|
| `03-agent-api.md` | 完整端点契约、响应字段、错误码、LLM Prompt 模板 |
| `05-agent-access.md` | 接入实操：凭证、环境、连通测试、最小代码 |
| `06-agent-workflow-template.md`（本文） | **通用工作流模板**：怎么组合调用来「改看板」+ 场景模板 + 实测坑 |
