# Agent 接入指南（企业看板）

> 给**要接入看板 REST API 的外部 Agent**（Python 脚本 / n8n / Dify / 自有程序）看的实操手册。
> 完整字段定义与端点契约见 [03-agent-api.md](./03-agent-api.md)。
> 本指南只讲「怎么连、怎么跑通、别踩哪些坑」。

---

## 0. 一句话结论

外部 Agent 不需要看板前端页面，直接打 REST API 即可。看板前端和 Agent 走的是**同一套后端、两条独立鉴权通道**，互不干扰。

```
Agent ──HTTP──> [nginx :8088] ──/api──> [node-proxy :8787] ──> Gmail
                    (生产)                (仅本机, Bearer 鉴权)
```

---

## 1. 你需要两条「Key」——千万别搞混 ⚠️

| 凭证 | 是什么 | 谁用 | 看板关心吗 |
|------|--------|------|-----------|
| **API_KEY（看板访问凭证）** | 本文档给的 `Bearer` 令牌 | Agent 调看板 API 时带在 Header | ✅ 必需 |
| **LLM Key（如 DeepSeek / OpenAI）** | 你自己的大模型密钥 | Agent 调 LLM 做邮件抽取时 | ❌ 不关心 |

**关键区别**：API_KEY 是「进入看板系统的门禁卡」，不是大模型密钥。Agent 自己调 DeepSeek 用的 key 是另一回事，看板后端完全不知道也不需要它。

---

## 2. 连接信息（两套环境）

| 环境 | Base URL | 说明 |
|------|----------|------|
| **生产（已部署）** | `http://43.172.73.230:8088/api` | 腾讯云美国 VPS，nginx 反代，公网可访问 |
| 本地开发 | `http://localhost:8787/api` | 需本地 `node server.js` 起 node-proxy |

**通用 Header：**

```
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

> 生产 API_KEY（当前值）：
> ```
> ksQr56ll67P4_4eY8ggwg3FeMfG9UlAG90daZ5cSbkw
> ```
> ⚠️ 这是**明文暴露在公网**的生产密钥。一旦要对外公开此文档或怀疑泄露，立即在服务器 `.env` 改 `API_KEY` 并 `pm2 restart dashboard-api`。**不要把 key 提交进公开 Git 仓库**。

---

## 3. 30 秒连通测试

打开终端，复制下面两条命令直接跑（生产环境已验证返回 200）：

```bash
# ① 读：拉 KPI 总览（验证 GET + 鉴权）
curl -s -H "Authorization: Bearer ksQr56ll67P4_4eY8ggwg3FeMfG9UlAG90daZ5cSbkw" \
  http://43.172.73.230:8088/api/kpi/overview | head -c 400
echo

# ② 写：给某工单写回一条测试结果 summary（验证 PATCH + 持久化）
curl -s -X PATCH \
  -H "Authorization: Bearer ksQr56ll67P4_4eY8ggwg3FeMfG9UlAG90daZ5cSbkw" \
  -H "Content-Type: application/json" \
  -d '{"summary":"Agent连通性自测写入"}' \
  http://43.172.73.230:8088/api/tickets/<工单短ID或conversation_id>
echo
```

**预期结果：**
- ① 返回 JSON，含 `totals.active` / `by_category` 等；
- ② 返回 `{"ok":true,"id":"...","updated":{...}}`。

**错误对照：**
- `401` → Header 没带 `Authorization: Bearer` 或 key 写错；
- `404` → 工单 ID 不存在（确认是 8 位短 ID 或完整 `conversation_id`）；
- `403` → 用 `X-IMAP-Auth` 打 PATCH 了（PATCH 只接受 `Bearer`，见 §5）。

---

## 4. 标准接入闭环（4 步）

```
① GET  /api/tickets?pageSize=200        拿全部工单，用 conversation_id 作唯一键
        ↓  筛选未抽取/误判的
② GET  /api/tickets/:id                 拿线程全文（emails[].body）
        ↓  拼成 prompt
③ 调你的 LLM（DeepSeek 等）            抽取 JSON {category, dealer, status, ...}
        ↓
④ PATCH /api/tickets/:id               把 LLM 结果写回看板，立即生效、持久化
```

**调度建议：**
- **增量**：记录上次处理的 `updatedAt`，只跑新建/未抽取工单；
- **全量**：定时（如每 30 分钟）全量重抽，覆盖旧值；
- **选择性**：只处理易误判分类（如 `Technical`）或正则初筛出的。

---

## 5. 最小可用代码

### Python（requests）

```python
import requests, json

BASE = "http://43.172.73.230:8088/api"
H = {"Authorization": "Bearer ksQr56ll67P4_4eY8ggwg3FeMfG9UlAG90daZ5cSbkw"}

# 1) 拉工单列表
tickets = requests.get(f"{BASE}/tickets", headers=H, params={"pageSize": 200}).json()["items"]

# 2) 挑没被 Agent 写过的
to_do = [t for t in tickets if not t.get("summary")]

for t in to_do[:10]:                       # 控制成本，先跑 10 条
    # 3) 取线程详情
    detail = requests.get(f"{BASE}/tickets/{t['id']}", headers=H).json()
    thread = "\n---\n".join(e.get("body", "") for e in detail.get("emails", []))

    # 4) 调你自己的 LLM 抽取（这里用伪代码，key 是你自己的 LLM key，不是看板 API_KEY）
    extracted = your_llm_extract(thread)   # -> dict, 见 03-agent-api.md §5 Prompt 模板

    # 5) 写回看板
    r = requests.patch(f"{BASE}/tickets/{t['id']}", headers=H, json=extracted)
    print(t["id"], r.json().get("ok"))
```

### Node.js（fetch，v18+ 内置）

```js
const BASE = "http://43.172.73.230:8088/api";
const H = { Authorization: "Bearer ksQr56ll67P4_4eY8ggwg3FeMfG9UlAG90daZ5cSbkw" };

const list = await (await fetch(`${BASE}/tickets?pageSize=200`, { headers: H })).json();
const toDo = list.items.filter(t => !t.summary).slice(0, 10);

for (const t of toDo) {
  const detail = await (await fetch(`${BASE}/tickets/${t.id}`, { headers: H })).json();
  const thread = (detail.emails || []).map(e => e.body).join("\n---\n");
  const extracted = await yourLlmExtract(thread);          // 你自己的 LLM，用自己的 key
  const r = await fetch(`${BASE}/tickets/${t.id}`, {
    method: "PATCH", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(extracted)
  });
  console.log(t.id, (await r.json()).ok);
}
```

> 项目里也内置了一个参考实现 `scripts/agent-run.mjs`（拉→抽→写回闭环，支持 `--dry-run` / `--limit` / `--key`），可直接 `node scripts/agent-run.mjs --key <API_KEY>` 跑通。

---

## 6. 常见坑（已踩过）

| 现象 | 原因 | 解决 |
|------|------|------|
| `401` | 没带 `Authorization` 或 key 错 | Header 必须 `Bearer <API_KEY>`，一字不差 |
| `403` | 用 `X-IMAP-Auth` 打 PATCH | PATCH **只接受 Bearer**（Agent 专用），GET 两种都行 |
| 写回没生效 | 端口打错 | 生产走 **`:8088/api`**（nginx），不是 `:8787`；`:8787` 仅本机 |
| `404` | ID 写错 | 用 8 位短 `id` 或完整 `conversation_id`（详情接口二者皆可） |
| 改了 key 不生效 | 没重启 | 服务器改 `.env` 后 `pm2 restart dashboard-api` |
| 页面能开但 API 401 | 前端和 Agent 用不同通道 | 前端用 `X-IMAP-Auth`；Agent 必须用 `Bearer`，两套不混 |

---

## 7. 可写字段速查（PATCH）

全部可选，传什么改什么、幂等覆盖：

`category`(Service/Warranty/Sales/Parts/Technical) · `status`(Open/Pending/Waiting Dealer/Waiting HQ/Closed) · `priority`(high/normal) · `dealer_name` · `dealer_code` · `owner_email` · `owner_name` · `summary` · `next_action` · `machine_model` · `part_number`

写回后**立即生效**（同周期 GET 即见新值），并持久化到 `scripts/llm-metadata.json`，重启不丢。Agent 写入值优先级高于正则初筛。

---

## 8. 完整 API 契约

端点、响应字段、错误码、Prompt 模板、n8n 配置 → 见 **[03-agent-api.md](./03-agent-api.md)**。
