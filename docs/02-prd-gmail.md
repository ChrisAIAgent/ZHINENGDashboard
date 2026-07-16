# PRD — 企业看板 v2（Gmail API 接入版）

> 版本：v2.0（Gmail 转向）
> 日期：2026-07-11
> 状态：草稿待评审
> 前身：docs/01-feasibility-analysis.md（M365 Graph 方案，已弃用）

---

## 1. 变更背景与决策

| 项 | 说明 |
|----|------|
| 原方案 | Microsoft 365 + Graph API（Webhook + Delta），Cloudflare Workers + D1 |
| 受阻点 | 拿不到 M365 Tenant Admin 授权（`Mail.Read` 应用权限被拒），无法推进 Graph 接入 |
| 临时方案 | 退化为 IMAP 直连 `outlook.office365.com`（app password），见 `phase1/workers/worker` 与 `node-proxy` |
| 新决策 | **改为 Gmail API 接入**。谷歌侧已有可用的 API 凭据可做测试 |
| 本次确认的范围 | ① 抽象 `MailboxConnector` 接口，现实现 `GmailOAuthConnector`（单账号 OAuth）；② 现阶段仅接**单账号**（自己的 Gmail）跑通，架构预留多账号/服务账号；③ **完全删除 IMAP 代码**，后端统一走 Gmail API |

**关键结论**：放弃 IMAP 兜底与 M365 路径；Gmail API 的 `threadId`（原生会话）与 `historyId`（原生增量）比 IMAP 的 References 解析和 60 天全量扫描更可靠，聚合准确率与同步效率都会提升。

---

## 2. 产品目标与范围

### 目标
把分散的经销商/客服邮件（现统一进一个 Gmail 收件箱）自动聚合成 Ticket，提供管理看板 + 每日/每周摘要。

### 范围内（Phase 1 Gmail 版）
- Gmail OAuth 2.0 授权接入（单账号）
- 基于 `threadId` 的会话级 Ticket 聚合
- 基于 `historyId` 的增量同步（不再每次全量拉 60 天）
- 元数据启发式抽取（Dealer / Model / Category / Owner / Status）+ LLM 升级预留
- 状态机 + Dashboard 五页（KPI / 列表 / 详情 / Aging / Owner 工作量）
- Overdue 告警 + 周报（经 Gmail 发信或 Webhook）
- 单账号端到端可用，demo 模式保留

### 非目标（本期不做）
- 多账号统一看板（仅预留 connector 扩展点，不实现）
- Google Workspace 服务账号全域委派（仅预留 stub）
- 跨线程语义合并（Vectorize，Phase 2+）
- ERP / 业务系统接入
- 多语言 / 多租户

---

## 3. 角色与用户

| 角色 | 说明 |
|------|------|
| 管理员（Chris） | 配置 Google Cloud OAuth、运行接入脚本、查看看板 |
| 内部处理人（Owner） | 邮件线程中最后从受监控 Gmail 发出的内部人员（Kim / Mike / Eric 等） |
| 外部方（Dealer） | 发邮件进来的经销商/客户，被识别为 Dealer |

---

## 4. 总体架构

```mermaid
flowchart LR
  subgraph Google["Gmail (单账号)"]
    MB[受监控 Gmail 收件箱]
  end

  MB -->|OAuth 2.0<br/>Gmail API| C[MailboxConnector<br/>GmailOAuthConnector]
  C -->|threadId 聚合| P[Ticket 构建层]
  P -->|抽取| H[启发式/LLM 抽取]
  P -->|持久化| DB[(D1 / 本地 JSON)]
  C -->|historyId| SYNC[增量同步调度]

  subgraph UI["Dashboard (React/Pages)"]
    K1[看板] K2[Aging] K3[Owner] K4[详情]
  end
  UI -->|Read API| API[query-api Worker]
  API --> DB

  AUTH[/api/auth/*] -->|存 refresh token| TOK[(Token 存储)]
  TOK --> C
```

**核心变化**：邮件传输层从「IMAP app password」替换为「Gmail API + OAuth token」；新增 `MailboxConnector` 抽象，把「怎么取邮件」与「怎么建 Ticket」解耦。

---

## 5. Gmail API 接入方案

### 5.1 OAuth 2.0 授权码流程（单账号）

1. 后端拼授权 URL，前端「连接 Gmail」按钮跳转：
   ```
   https://accounts.google.com/o/oauth2/v2/auth
     ?client_id=...
     &redirect_uri=...
     &response_type=code
     &scope=https://www.googleapis.com/auth/gmail.readonly
     &access_type=offline
     &prompt=consent
   ```
   - `access_type=offline` + `prompt=consent` → 拿 `refresh_token`
2. 用户在谷歌同意屏授权 → 跳回 `redirect_uri?code=...`
3. 后端 `POST https://oauth2.googleapis.com/token` 用 `code` 交换 `access_token` + `refresh_token`
4. **`refresh_token` 加密落库**（D1 / 本地 `tokens.json`，gitignore）；`access_token` 内存持有，过期前用 `refresh_token` 刷新
5. 测试阶段可用一次性脚本 `scripts/gmail-oauth-setup.mjs` 在本地完成 1–4，直接产出 `tokens.json`

### 5.2 Scopes

| Scope | 用途 | 阶段 |
|-------|------|------|
| `gmail.readonly` | 读取邮件/线程/历史（最小权限） | 必须 |
| `gmail.modify` | 给已处理邮件打 `Ticketed` 标签，避免重复处理 | 可选（P2） |
| `gmail.send` | 发送周报 / Overdue 告警邮件 | 可选（P2，或改用 Webhook） |

> 本期先用 `gmail.readonly`，其余按需追加；同意屏类型用「外部 + 测试用户」，仅加本人为测试用户即可跑通。

### 5.3 核心端点与字段映射

| Gmail API | 用途 | 映射到 |
|-----------|------|--------|
| `GET /gmail/v1/users/me/messages?q=in:inbox after:YYYY/MM/DD` | 初始拉取（按日期，替代 IMAP `search({since})`） | 邮件清单 |
| `GET /gmail/v1/users/me/messages/{id}?format=raw` | 取单封原始 RFC822（base64url）→ `mailparser` 解析（复用现有解析） | 单封邮件 |
| `GET /gmail/v1/users/me/threads/{threadId}?format=raw` | **原生会话聚合**（替代 References 解析） | 一个 Ticket = 一个 thread |
| `GET /gmail/v1/users/me/history?startHistoryId=&labelId=INBOX&historyTypes=messageAdded` | **增量同步**（替代 60 天全量 + Graph delta） | 新邮件/变更 |

**字段映射**：
- `threadId` → `conversation_id`（原生，可靠）
- `internalDate`（epoch ms）→ 接收时间
- `payload.headers` / `raw` → From / To / Subject / Date / Message-ID / In-Reply-To / References
- `snippet` → `bodyPreview`
- `labelIds` 含 `SENT` → 出站（内部）；`INBOX`+`UNREAD` → 未读入站

### 5.4 增量同步（historyId）

- 每个邮箱持久化一个 `historyId`（单账号阶段存 `tokens.json` 或 D1 行）
- 每次同步后更新 `historyId`
- 拉新邮件只取 `historyId` 之后的 `messageAdded`，不再全量扫 60 天
- 首跑用 `after:` 日期做冷启动（限最近 30–60 天），之后切增量

### 5.5 会话聚合（threadId）

- **一个 Gmail thread = 一个 Ticket**（比 IMAP References 解析更准，跨转发/改主题也不丢）
- Owner 规则重定义：线程中**最后从受监控 Gmail 账户发出**的邮件作者即 Owner（原 IMAP 版是「最后一个 @sunwardamerica.com」，现改为「最后一个 = 受监控账户本身」）
- Dealer = 线程中来自外部的对方域名/地址

---

## 6. MailboxConnector 抽象设计

```js
// connectors/connector.js —— 统一接口
export class MailboxConnector {
  /** 冷启动：拉取 since 之后的邮件元信息 */
  async listMessagesSince(sinceDate, opts = {}) { throw new Error('not implemented'); }
  /** 取一个会话（thread）的全部原始邮件 */
  async getThread(conversationId) { throw new Error('not implemented'); }
  /** 增量：返回 historyId 之后的新增/变更 */
  async getHistory(startHistoryId) { throw new Error('not implemented'); }
  /** 当前账号信息 */
  async getProfile() { throw new Error('not implemented'); }
  /** 可选：发信（周报/告警） */
  async sendMail(to, subject, body) { throw new Error('not implemented'); }
}

// connectors/gmail-oauth.js —— 现实现（单账号）
export class GmailOAuthConnector extends MailboxConnector {
  constructor({ clientId, clientSecret, refreshToken, accessToken, tokenStore }) { /* ... */ }
  // 内部用 googleapis / 直接 fetch Gmail REST API
  // 自动 refresh access_token
}

// connectors/gmail-service-account.js —— 预留（多账号/Workspace，本期不实现）
// export class GmailServiceAccountConnector extends MailboxConnector { /* TODO Phase 3 */ }
```

- 后端 `buildTicketStore` 只依赖 `MailboxConnector` 接口，不关心底层是 OAuth 还是服务账号
- 单账号阶段注入 `GmailOAuthConnector`；多账号阶段由 `mailboxes` 表按 `email` 选 connector + token

---

## 7. 数据模型

| 表/文件 | 字段 | 说明 |
|--------|------|------|
| `tickets` | id, conversation_id(threadId), subject, category, dealer_code, dealer_name, machine_model, owner_email, owner_name, status, priority, open_date, last_update, aging_days, next_action, email_count, part_number | 同现有结构，conversation_id 来源改为 threadId |
| `emails` | id, ticket_id, from, to, subject, received_at, body_preview, body, direction(in/out) | 复用 |
| `ticket_events` | id, ticket_id, at, event, actor, note | 复用 |
| `mailboxes`（多账号预留） | email, connector_type, refresh_token_encrypted, history_id, updated_at | 单账号阶段可仅用一行或本地 tokens.json |
| `tokens`（单账号） | access_token, refresh_token_encrypted, expiry, history_id | 加密落库，禁止进代码/提交 |

> 加密：`refresh_token` 用 AES-256-GCM，密钥来自环境变量（Cloudflare：`secret`；本地：`.dev.vars`）。

---

## 8. API 契约（更新）

沿用现有 5 个读端点，移除 `X-IMAP-Auth`，新增鉴权端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/auth/url` | GET | 返回 Google 同意屏 URL（前端跳转用） |
| `GET /api/auth/callback?code=...` | GET | 交换 token、加密存储、重定向回 dashboard |
| `GET /api/auth/status` | GET | `{ connected: bool, email: string }` |
| `GET /api/kpi/overview` | GET | 沿用（不再读 header，token 来自存储） |
| `GET /api/tickets` | GET | 沿用 |
| `GET /api/tickets/:id` | GET | 沿用 |
| `GET /api/owners/workload` | GET | 沿用 |
| `GET /api/aging/buckets` | GET | 沿用 |

---

## 9. 前端改造

| 文件 | 改造点 |
|------|--------|
| `assets/auth.js` | 删除 IMAP 登录弹窗（email+app password）；改为「连接 Gmail」按钮 → `GET /api/auth/url` → 跳转；回调后刷新。保留 `demo@local/demo` 走 demo 夹具 |
| `assets/api.js` | 移除 `X-IMAP-Auth` 构造；`BASE` 改为可配置（环境变量/相对路径），避免硬编码 `localhost:8787` |
| `pages/*` | 登录态判断改为 `GET /api/auth/status`；其余渲染逻辑不变 |
| `dashboard.html` 等 5 页 | 结构不变，仅 auth 触发方式变化 |

> Demo 模式保留：`node-proxy` 的 demo 分支（10 条 `demo-fixture.js`）继续用于无真实 Gmail 时的本地演示。

---

## 10. 元数据抽取策略（演进）

| 阶段 | 做法 |
|------|------|
| Phase 1（现） | 复用现有正则/关键词启发式（Category/Dealer/Status/Model），仅把 Owner 判定改为「线程末封来自受监控账户」 |
| Phase 1.5（增强） | 接入 LLM（Gemini / Workers AI）做 Category/Dealer/Status 抽取，正则结果作 fallback；关键字段 LLM 偏差时回退 |
| Phase 2+ | 跨线程语义合并（Vectorize），多语言 |

> 现有 `detectCategory/detectDealer/detectStatus` 等函数**基本可复用**，只需调整 Owner 内部判定与 Dealer 域名来源。

---

## 11. Dashboard 指标（沿用 docs/01 第 6 节）

- 管理看板：本周新增 / 已关闭 / Active / Avg Cycle Time（按 Service/Warranty/Sales/Parts/Technical）
- Overall：Pending / Hold / Overdue（3d/7d/14d）
- Aging：0–3d / 3–7d / 7–14d / >14d，按分类
- Owner 工作量：Active / 本周关闭 / 平均处理时长 / 最久未更新
- Sales 专属（后续）

---

## 12. 安全与合规

| 项 | 要求 |
|----|------|
| Token 存储 | `refresh_token` 加密（AES-256-GCM），密钥走环境变量；绝不进代码/仓库 |
| Scope 最小化 | 先用 `gmail.readonly`，按需追加 `modify`/`send` |
| PII | 邮件正文含客户 PII；D1 加密 at-rest，前端加 Cloudflare Access 限内网 |
| 日志 | 禁止打印 token、完整邮件正文 |
| 同意屏 | 外部应用仅加测试用户；如需对外需走 Google 验证流程 |

---

## 13. 风险与缓解

| # | 风险 | 缓解 |
|---|------|------|
| 1 | OAuth 同意屏未验证，外部用户无法授权 | 本期单账号测试，仅加本人为测试用户；对外发布再走验证 |
| 2 | `refresh_token` 丢失/撤销 | 检测刷新失败 → 前端提示重新授权；`prompt=consent` 可重新签发 |
| 3 | Gmail API 配额 | 每分钟每用户 250 次；用 historyId 增量 + 分页，避免全量 |
| 4 | `after:` 日期过滤近似 | 冷启动限 30–60 天，之后纯增量；必要时 `historyTypes=messageAdded` 校正 |
| 5 | 邮件隐私/合规 | 同 §12 |
| 6 | 多账号将来要 Workspace 全域委派 | connector 抽象已预留，P3 再补 `GmailServiceAccountConnector` |

---

## 14. 重排后的实施计划（剩余步骤）

> 已完成：可行性分析、前端 5 页、IMAP 后端 5 端点、Puppeteer 5/5、demo 夹具。
> 现重排为 Gmail 版，预计 **5 周（1 工程师）**。

### P0 — Gmail 接入准备（≈1 周）
- [ ] P0.1 Google Cloud 项目 + OAuth 同意屏（外部/测试用户，加本人）
- [ ] P0.2 建 OAuth Web 客户端，拿 `client_id`/`client_secret`，配 `redirect_uri`
- [ ] P0.3 `scripts/gmail-oauth-setup.mjs`：跑通授权码 → `refresh_token`，存 `tokens.json`（加密）
- [ ] P0.4 Gmail API 烟雾测试脚本（list / thread / history 三件套）
- [ ] P0.5 主数据补齐（dealers.csv / machine-models.csv / routing-rules.yaml）—— 业务侧仍缺失

### P1 — 后端 Gmail 化改造（≈1.5 周）
- [ ] P1.1 抽象 `MailboxConnector` 接口（`connectors/connector.js`）
- [ ] P1.2 实现 `GmailOAuthConnector`（单账号，自动 refresh）
- [ ] P1.3 **删除 IMAP 代码**：`worker/src/index.js` IMAP 分支、`node-proxy` IMAP 分支；**保留 demo 模式**
- [ ] P1.4 `threadId` 原生聚合替换 References 解析
- [ ] P1.5 `historyId` 增量同步替换 60 天全量
- [ ] P1.6 新增 `/api/auth/{url,callback,status}` 端点
- [ ] P1.7 Token 加解密存储（AES-256-GCM）

### P2 — 联调 + 抽取增强 + 看板（≈1.5 周）
- [ ] P2.1 `auth.js` 改 Gmail OAuth 登录流（保留 demo）
- [ ] P2.2 真实 Gmail 端到端联调，验证 5 页渲染
- [ ] P2.3 元数据抽取：正则 → LLM（Gemini/Workers AI）升级，正则兜底
- [ ] P2.4 Dashboard 指标核对 + Aging/Overdue 修正
- [ ] P2.5 周报 + Overdue 告警（gmail.send 或 Webhook）

### P3 — 生产化（≈1 周）
- [ ] P3.1 Cloudflare Pages 部署前端
- [ ] P3.2 D1 持久化 tickets/emails/token
- [ ] P3.3 Cloudflare Access 限前端访问
- [ ] P3.4 多账号扩展点（`GmailServiceAccountConnector` stub）
- [ ] P3.5 配额/同步监控告警

---

## 15. 验收标准

- [ ] 单 Gmail 账号经 OAuth 接入，**无需 app password**
- [ ] 5 个 Dashboard 页面渲染真实 Gmail 数据
- [ ] 会话聚合基于 `threadId`，跨转发/改主题不丢
- [ ] 增量同步基于 `historyId`，刷新不再全量扫 60 天
- [ ] Demo 模式仍可用（`demo@local/demo`）
- [ ] `refresh_token` 加密存储，不在代码/仓库中明文出现
- [ ] IMAP 代码已从后端移除

---

## 16. 附录：与旧方案差异对照

| 维度 | 旧（IMAP） | 新（Gmail API） |
|------|-----------|----------------|
| 传输 | `outlook.office365.com:993` IMAP | `gmail.googleapis.com` REST |
| 鉴权 | `base64(email:appPassword)` 头 | OAuth 2.0 `access_token` + `refresh_token` |
| 会话 | References 头解析（易丢） | `threadId` 原生（可靠） |
| 增量 | 每次全量搜 60 天 | `historyId` 增量 |
| 抽象 | 无（worker 与 node-proxy 各写一份） | `MailboxConnector` 统一接口 |
| 多账号 | 不支持 | connector 预留（本期不实现） |
| 删除项 | — | IMAP 代码整体移除 |

---

*生成依据：通读 README、docs/01、phase1 前端 5 页 + 6 个 JS 资产、worker/src/index.js、node-proxy/server.js、demo-fixture.js、scripts/*、phase0 主数据后，结合用户「转 Gmail、有 API 可测、先单账号预留多账号、删 IMAP」的决策整理。*
