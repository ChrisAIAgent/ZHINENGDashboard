#!/usr/bin/env node
/**
 * agent-run.mjs — 企业看板 Agent 连接器（完整闭环）
 *
 * 作用：把「看板 REST API」与「LLM 抽取」接起来，形成可运行的 Agent 循环：
 *   1. GET /api/tickets                      → 拉取工单列表
 *   2. 筛选未处理（无 summary）的工单
 *   3. GET /api/tickets/:id                  → 取完整邮件线程
 *   4. 调 DeepSeek（或任意 OpenAI 兼容 API）  → 抽取结构化元数据
 *   5. PATCH /api/tickets/:id                → 写回看板（看板立即反映）
 *
 * 这就是「接入 Agent」的实体：外部 Agent 只需这个脚本即可驱动看板自动归类。
 * 也可把其中每一步封装成 tool/function，交给你的 Agent 框架（OpenClaw / ChrisAI / n8n）自主调度。
 *
 * 用法：
 *   node scripts/agent-run.mjs --key sk-xxx
 *   node scripts/agent-run.mjs --key sk-xxx --limit 5
 *   node scripts/agent-run.mjs --key sk-xxx --all          # 强制重抽全部（覆盖旧值）
 *   node scripts/agent-run.mjs --key sk-xxx --dry-run      # 只抽取不写回
 *   node scripts/agent-run.mjs --key sk-xxx --endpoint https://api.deepseek.com/v1/chat/completions
 *
 * 环境变量（可选覆盖）：
 *   AGENT_API_BASE   看板地址（默认 http://localhost:8787）
 *   AGENT_API_KEY    看板 Bearer key（默认 agent-dashboard-2026）
 *   DEEPSEEK_KEY     LLM key（等价于 --key）
 *   HTTPS_PROXY      出网代理（沙箱/企业网自动走）
 *
 * 零持久化：LLM key 仅在内存中使用，不写入任何文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_NAME = path.basename(fileURLToPath(import.meta.url));

// ---------- 配置 ----------
const BASE = process.env.AGENT_API_BASE || 'http://localhost:8787';
const API_KEY = process.env.AGENT_API_KEY || 'agent-dashboard-2026';
const LLM_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
const LLM_MODEL = 'deepseek-chat';

// ---------- CLI ----------
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { args.dryRun = true; continue; }
    if (a === '--all') { args.all = true; continue; }
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    const key = a.replace(/^--/, '');
    const val = argv[i + 1];
    if (['key', 'endpoint', 'model', 'limit'].includes(key)) {
      if (val === undefined || val.startsWith('--')) { console.error('✗ 缺少 --' + key + ' 的值'); process.exit(1); }
      args[key] = val; i++;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Agent 连接器 — ${SCRIPT_NAME}

用法:
  node ${SCRIPT_NAME} --key <sk-xxx> [--limit N] [--all] [--dry-run]
  node ${SCRIPT_NAME} --key <sk-xxx> --endpoint <url> --model <name>

选项:
  --key <sk-xxx>     LLM API key（必填；也可用环境变量 DEEPSEEK_KEY）
  --endpoint <url>   LLM 端点（默认 DeepSeek 官方）
  --model <name>     LLM 模型（默认 deepseek-chat）
  --limit <N>        本次最多处理 N 条（控制成本，默认 10）
  --all              强制重抽全部工单（覆盖旧值），否则只处理无 summary 的
  --dry-run          只抽取不 PATCH 写回（用于验证 LLM 效果）
  --help             本帮助

环境变量: AGENT_API_BASE / AGENT_API_KEY / DEEPSEEK_KEY / HTTPS_PROXY
`);
}

// ---------- 代理 ----------
async function setupProxy() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) return;
  try {
    const { setGlobalDispatcher, ProxyAgent } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
    console.error('[proxy] 已启用代理: ' + proxy);
  } catch {
    console.error('[warn] 检测到代理变量但 undici 不可用，尝试直连');
  }
}

// ---------- 看板 API ----------
async function apiGet(path) {
  const resp = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + API_KEY } });
  if (!resp.ok) throw new Error('GET ' + path + ' → ' + resp.status);
  return resp.json();
}

async function apiPatch(id, body) {
  const resp = await fetch(BASE + '/api/tickets/' + id, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('PATCH ' + id + ' → ' + resp.status + ' ' + text.slice(0, 200));
  return JSON.parse(text || '{}');
}

// ---------- Prompt ----------
function buildSystemPrompt() {
  return `你是企业邮件工单分析助手。从单个邮件会话中提取结构化元数据，严格输出一个 JSON 对象。

## 业务词汇表
分类（category）只能是以下之一：Service / Warranty / Sales / Parts / Technical
状态（status）只能是以下之一：Open / Pending / Waiting Dealer / Waiting HQ / Closed
优先级（priority）只能是以下之一：high / normal

## 字段说明
- dealer_name: 经销商名称（从邮件域名/内容推断）
- dealer_code: 经销商代码（如 US-MT, US-ABC 等，无法确定填 "unknown"）
- owner_name / owner_email: 工单负责人（线程中 @sunwardamerica.com 内部发件人，如无不填）
- machine_model: 工程机械型号（如 SW240UF、SWE155UF 等，正则匹配）
- part_number: 零件编号（9-12 位数字）
- summary: 会话摘要（1-2 句中文）
- next_action: 建议下一步动作（如"备件发货并开票"、"等待经销商回复"）

## 规则
1. 仅从邮件内容推断，不要编造；无法确定就省略该字段。
2. 分类按关键词和语义综合判断：price/quote/order→Sales，warranty/claim/defect→Warranty，service/repair/broken→Service，part/stock/inventory→Parts，其余→Technical。
3. status 从最新邮件语气判断：经销商在等回复→Waiting HQ，HQ 在等经销商→Waiting Dealer，已确认关闭→Closed，刚发起→Open。
4. summary 简洁，提到关键信息（什么设备/什么问题/需要什么）。

只返回 JSON 对象，不要 markdown 代码块，不要多余解释。`;
}

function buildThreadBlock(t) {
  const emails = Array.isArray(t.emails) ? t.emails : [];
  const body = emails.length
    ? emails.map(m => `[${m.from || ''} → ${m.to || 'unknown'} | ${m.date || ''}]\n${m.body || ''}`).join('\n---\n')
    : (t.body || '');
  return `### ${t.conversation_id || t.id}
主题: ${t.subject || ''}
会话邮件数: ${emails.length || t.email_count || 1}
正文:
${body}`;
}

// ---------- LLM 抽取（单条）----------
async function extractOne(ticket, llmKey, endpoint, model) {
  const body = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: '分析以下邮件会话，提取结构化元数据：\n\n' + buildThreadBlock(ticket) },
    ],
    temperature: 0.1,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
  };
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llmKey },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('LLM ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  return JSON.parse(content);
}

// PATCH 可写字段白名单
const WRITABLE = new Set([
  'category', 'status', 'priority', 'dealer_name', 'dealer_code',
  'owner_email', 'owner_name', 'summary', 'next_action', 'machine_model', 'part_number',
]);

function toWritable(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (WRITABLE.has(k) && obj[k] !== null && obj[k] !== undefined && obj[k] !== '') out[k] = obj[k];
  }
  return out;
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }

  const llmKey = args.key || process.env.DEEPSEEK_KEY;
  if (!llmKey) { console.error('✗ 缺少 LLM key：用 --key <sk-xxx> 或环境变量 DEEPSEEK_KEY'); process.exit(1); }

  const endpoint = args.endpoint || LLM_ENDPOINT;
  const model = args.model || LLM_MODEL;
  const limit = parseInt(args.limit || '10', 10);
  const dryRun = !!args.dryRun;

  await setupProxy();

  // ① 拉工单列表
  const list = await apiGet('/api/tickets?pageSize=200');
  const items = list.items || [];
  console.error('• 看板共 ' + list.total + ' 条工单，本次加载 ' + items.length + ' 条');

  // ② 筛选
  const pending = args.all ? items : items.filter(t => !t.summary);
  const batch = pending.slice(0, limit);
  console.error('• 待处理 ' + (args.all ? '全部' : '未抽取') + ' ' + pending.length + ' 条，本次处理 ' + batch.length + ' 条' + (dryRun ? '（dry-run，不写回）' : ''));

  let ok = 0, fail = 0;
  for (const t of batch) {
    try {
      // ③ 取线程详情
      const detail = await apiGet('/api/tickets/' + t.id);
      // ④ LLM 抽取
      const extracted = await extractOne(detail, llmKey, endpoint, model);
      const writable = toWritable(extracted);
      console.error('  ✓ ' + t.id + ' [' + (writable.category || '-') + '/' + (writable.status || '-') + '] ' + (writable.summary || '').slice(0, 40));
      // ⑤ 写回
      if (!dryRun) {
        await apiPatch(t.id, writable);
        ok++;
      } else {
        ok++;
      }
    } catch (e) {
      fail++;
      console.error('  ✗ ' + t.id + ' 失败: ' + e.message);
    }
  }

  console.error('══════════════════════════════');
  console.error('  完成：成功 ' + ok + ' / 失败 ' + fail + (dryRun ? '（dry-run）' : ''));
  console.error('══════════════════════════════');
}

main().catch(e => {
  console.error('✗ 运行时错误:', e.message);
  if (e.cause) console.error('  根因:', e.cause.code || e.cause.message || e.cause);
  process.exit(1);
});
