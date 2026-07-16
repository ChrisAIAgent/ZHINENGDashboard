# 企业看板 (Enterprise Dashboard)

基于 **Gmail API** 的 AI Ticketing Dashboard。Phase 1 以邮箱为唯一数据源，把分散邮件聚合成可管理的 Ticket，并提供管理看板。
> 注：原方案为 Microsoft 365 + Graph API，因拿不到 Tenant Admin 授权而放弃；临时 IMAP 方案也已废弃，现统一走 Gmail API（详见 `docs/02-prd-gmail.md`）。

## 目标

- 自动从 M365 邮箱拉取邮件，按会话/语义聚合成 Ticket
- AI 抽取：Dealer、Machine Model、Category、Owner、Status、Next Action
- 管理看板：按 Service/Warranty/Sales 分组的 New/Active/Closed/Avg Cycle Time
- Aging 桶（3/7/14d）、Owner 工作量、Overdue 告警
- 每日/每周自动生成管理摘要

## 目录结构

```
企业看板/
├── README.md                         本文件
├── docs/                             设计文档
│   ├── 01-feasibility-analysis.md    可行性分析（M365 Graph 原方案，已弃用）
│   └── 02-prd-gmail.md               Gmail API 转向 PRD（当前方案）
├── phase0/                           Phase 0 - 主数据准备
│   └── master-data/
│       ├── dealers.csv               Dealer 主数据
│       ├── machine-models.csv        型号字典
│       └── routing-rules.yaml        Owner 路由规则
├── phase1/                           Phase 1 - 代码
│   ├── workers/                      Cloudflare Workers
│   │   ├── graph-webhook/            实时 Webhook 接收
│   │   ├── graph-delta-sync/         增量同步
│   │   └── query-api/                前端 API
│   └── web/                          React Dashboard
├── scripts/                          工具脚本
│   └── smoke-test.ps1                M365 API 烟雾测试
└── work/                             草稿/临时
```

## 技术栈

| 模块 | 选型 |
|------|------|
| 邮箱接入 | **Gmail API（OAuth 2.0 + threadId 聚合 + historyId 增量）** |
| 抽象层 | MailboxConnector 接口（现 GmailOAuthConnector，预留多账号） |
| 计算 | Cloudflare Workers（或 Node 代理，本地调试） |
| 存储 | D1 (SQLite) / 本地 tokens.json |
| 向量 | Vectorize（Phase 2 跨线程语义合并） |
| 状态 | Durable Objects |
| AI | Workers AI / Gemini（抽取增强） |
| 调度 | Cloudflare Workflows |
| 前端 | 原生 JS + Tailwind + ECharts（Cloudflare Pages） |

## 当前进度

- [x] Phase 0.0 可行性分析（原 M365 方案，已弃用）
- [x] Phase 1 前端 Dashboard（5 页面完整，可用 demo 模式）
- [x] Phase 1 后端 API（5 端点完整，原 IMAP 方案）
- [x] Puppeteer 渲染测试（5/5 PASS）
- [x] Demo 夹具（10 条测试邮件，覆盖全分类/状态）
- [ ] **P0 Gmail 接入准备**：Google Cloud OAuth 同意屏 + 客户端 + 授权脚本 + API 烟雾测试
- [ ] **P1 后端 Gmail 化**：MailboxConnector 抽象 + GmailOAuthConnector + 删 IMAP + threadId 聚合 + historyId 增量 + 鉴权端点
- [ ] **P2 联调增强**：前端改 Gmail OAuth 登录 + 真实 Gmail 联调 + 抽取 LLM 升级 + 看板核对 + 周报/告警
- [ ] **P3 生产化**：Pages 部署 + D1 持久化 + Access 鉴权 + 多账号扩展点
- [ ] Phase 0 主数据补齐（dealers / models / routing 仍仅占位示例）

## 快速开始

```powershell
# 1. 注册 M365 Developer Program（见 docs/01-feasibility-analysis.md 第 9 节）
# 2. 配置环境变量
$env:GRAPH_TENANT_ID = "xxx.onmicrosoft.com"
$env:GRAPH_CLIENT_ID = "<your_client_id>"
$env:GRAPH_CLIENT_SECRET = "<your_client_secret>"

# 3. 跑烟雾测试
cd "E:\Project\企业看板"
.\scripts\smoke-test.ps1
```
