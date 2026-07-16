#!/usr/bin/env node
/**
 * test-llm-extract.mjs — 企业看板 LLM 抽取测试接口
 *
 * 作用：
 *   接收邮件线程 JSON 输入 → 构造业务 prompt → 调 DeepSeek（或任意 OpenAI 兼容 API）→
 *   输出完整响应（状态码 + 响应体 + 耗时 + token 用量），用于验证抽取 prompt 和返回结构。
 *
 * 用法：
 *   node scripts/test-llm-extract.mjs --key sk-xxx --file scripts/sample-threads.json
 *   node scripts/test-llm-extract.mjs --key sk-xxx --data '{"threads":[{...}]}'
 *   node scripts/test-llm-extract.mjs --dry-run --file scripts/sample-threads.json
 *   node scripts/test-llm-extract.mjs --help
 *
 * 选项：
 *   --key <sk-xxx>      API key（必填，除非 --dry-run；不变动写入任何文件）
 *   --endpoint <url>    API 端点（默认 https://api.deepseek.com/v1/chat/completions）
 *   --model <name>      模型名（默认 deepseek-chat）
 *   --file <path>       JSON 线程数据文件路径
 *   --data <json>       直接传入 JSON 线程数据
 *   --dry-run            仅打印即将发送的请求体，不实际调用 API
 *   --verbose            输出完整 prompt 和原始响应
 *   --help               显示帮助
 *
 * 零持久化：--key 仅在内存中用于本次调用，不写入 .env 或任何文件。
 * 代理支持：检测到 HTTPS_PROXY 时通过 undici ProxyAgent 出网（需 scripts/ 下有 undici）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_NAME = path.basename(fileURLToPath(import.meta.url));

// ---------- CLI 参数解析 ----------
function parseArgs(rawArgs) {
  const args = { _: [] };
  const flags = ['key', 'endpoint', 'model', 'file', 'data'];
  for (let i = 2; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--dry-run') { args.dryRun = true; continue; }
    if (a === '--verbose') { args.verbose = true; continue; }
    if (a === '--help' || a === '-h') { args.help = true; return args; }
    if (flags.includes(a.replace('--', ''))) {
      const key = a.replace('--', '');
      const val = rawArgs[++i];
      if (!val || val.startsWith('--')) { args._err = `缺少 ${a} 的值`; return args; }
      args[key] = val;
      continue;
    }
    args._.push(a);
  }
  return args;
}

// ---------- 参数校验 ----------
function validate(args) {
  if (args.help) return { ok: true };
  if (!args.dryRun && !args.key) return { err: '缺少 --key。每次运行需传入 API key（不写入文件），或用 --dry-run 仅预览请求体。' };
  if (!args.file && !args.data) return { err: '缺少输入。请用 --file <路径> 或 --data <JSON字符串> 传入线程数据。' };
  if (args.file && args.data) return { err: '--file 和 --data 不能同时使用，选一个即可。' };
  if (args.file && !fs.existsSync(args.file)) return { err: `文件不存在: ${args.file}` };
  return { ok: true };
}

// ---------- 加载线程数据 ----------
function loadThreads(args) {
  if (args.file) {
    const raw = fs.readFileSync(args.file, 'utf8');
    return parseThreads(raw, args.file);
  }
  if (args.data) return parseThreads(args.data, '--data');
  return null;
}

function parseThreads(raw, source) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { err: `JSON 解析失败 (${source}): ${e.message}` }; }
  // 支持 { threads: [...] } 和单条对象
  if (Array.isArray(parsed)) return { threads: parsed };
  if (parsed.threads && Array.isArray(parsed.threads)) return { threads: parsed.threads };
  if (parsed.threadId || parsed.subject) return { threads: [parsed] };
  return { err: `输入 JSON 格式错误 (${source})：需为 { "threads": [...] } 或单条线程对象 (含 threadId/subject)` };
}

// ---------- 线程数据校验 ----------
function validateThreads(threads) {
  const errors = [];
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i];
    if (!t.threadId) errors.push(`第 ${i + 1} 条: 缺少 threadId`);
    if (!t.subject) errors.push(`第 ${i + 1} 条: 缺少 subject`);
    if (!t.body && !t.messages) errors.push(`第 ${i + 1} 条: 缺少 body 或 messages`);
    // 可选字段不做强制校验，但提示
  }
  if (errors.length) return { err: '输入线程数据校验失败:\n  ' + errors.join('\n  ') };
  return { ok: true };
}

// ---------- 构造 Prompt ----------
function buildSystemPrompt() {
  return `你是企业邮件工单分析助手。从邮件会话中提取结构化元数据，严格输出 JSON 数组。

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
4. summary 要简洁，提到关键信息（什么设备/什么问题/需要什么）。`;
}

function buildThreadBlock(t) {
  const body = t.body || (Array.isArray(t.messages) ? t.messages.map(m =>
    `[${m.from || ''} → ${m.to || 'unknown'} | ${m.date || ''}]\n${m.body || ''}`
  ).join('\n---\n') : '');
  return `### ${t.threadId}
主题: ${t.subject}
发件人: ${t.from || 'unknown'}
收件人: ${Array.isArray(t.to) ? t.to.join(', ') : (t.to || 'unknown')}
日期: ${t.date || 'unknown'}
会话邮件数: ${t.messageCount || 1}
正文:
${body}`;
}

function buildUserPrompt(threads) {
  return `分析以下 ${threads.length} 个邮件会话，对每个提取结构化元数据。返回纯 JSON 数组（不要 markdown 代码块）。\n\n${threads.map(buildThreadBlock).join('\n\n---\n\n')}`;
}

// ---------- 代理支持 ----------
async function setupProxy() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) return;
  try {
    const { setGlobalDispatcher, ProxyAgent } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
    console.error('[proxy] 已启用代理: ' + proxy);
  } catch {
    console.error('[warn] 检测到代理变量但 undici 不可用，将尝试直连');
  }
}

// ---------- 调用 LLM ----------
async function callLLM(args, threads) {
  const endpoint = args.endpoint || 'https://api.deepseek.com/v1/chat/completions';
  const model = args.model || 'deepseek-chat';
  const body = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(threads) },
    ],
    temperature: 0.1,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  };

  const t0 = Date.now();
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + args.key,
    },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - t0;
  const respBody = await resp.text();
  let parsed;
  try { parsed = JSON.parse(respBody); } catch { parsed = null; }

  return {
    status: resp.status,
    elapsedMs: elapsed,
    body: parsed || respBody,
    rawBody: respBody,
    request: { endpoint, model, threadCount: threads.length, promptTokens: JSON.stringify(body).length },
  };
}

// ---------- 输出 ----------
function printResult(args, result) {
  console.log('═══════════════════════════════════════');
  console.log('  LLM 抽取测试结果');
  console.log('═══════════════════════════════════════');
  console.log('  接口:', result.request.endpoint);
  console.log('  模型:', result.request.model);
  console.log('  线程数:', result.request.threadCount);
  console.log('  状态码:', result.status);
  console.log('  耗时:', result.elapsedMs + 'ms');
  console.log('═══════════════════════════════════════');
  console.log('');

  if (result.status !== 200) {
    console.log('[错误] 非 200 响应');
    console.log('');
    if (args.verbose) console.log(result.rawBody);
    else console.log(result.rawBody.slice(0, 800));
  } else {
    // 从响应中提取 content
    try {
      const content = result.body.choices?.[0]?.message?.content;
      const usage = result.body.usage;
      if (usage) {
        console.log('  Token 用量:', JSON.stringify(usage));
        console.log('');
      }
      if (content) {
        let extracted;
        try {
          // json_object 模式 content 是 JSON 字符串
          extracted = JSON.parse(content);
        } catch {
          extracted = content;
        }
        console.log('  抽取结果:');
        console.log(JSON.stringify(extracted, null, 2));
      } else {
        console.log('[警告] 响应中没有 content');
        if (args.verbose) console.log(JSON.stringify(result.body, null, 2));
      }
    } catch (e) {
      console.log('[解析异常]', e.message);
      if (args.verbose) console.log(result.rawBody.slice(0, 2000));
    }
  }
  console.log('');
  console.log('═══════════════════════════════════════');
}

// ---------- dry-run 输出 ----------
function printDryRun(args, threads) {
  console.log('[dry-run] 即将发送的请求（不实际调用 API）');
  console.log('');
  console.log('  端点: ' + (args.endpoint || 'https://api.deepseek.com/v1/chat/completions'));
  console.log('  模型: ' + (args.model || 'deepseek-chat'));
  console.log('  线程数: ' + threads.length);
  console.log('');
  if (args.verbose) {
    console.log('--- SYSTEM ---');
    console.log(buildSystemPrompt());
    console.log('--- USER ---');
    console.log(buildUserPrompt(threads));
    console.log('--- END ---');
  } else {
    console.log('  提示词总长: ' + (buildSystemPrompt() + buildUserPrompt(threads)).length + ' 字符');
    console.log('  (用 --verbose 查看完整 prompt)');
  }
}

// ---------- help ----------
function printHelp() {
  console.log(`
LLM 抽取测试接口 — ${SCRIPT_NAME}

用法:
  node ${SCRIPT_NAME} --key <sk-xxx> --file <path>       从文件加载线程数据
  node ${SCRIPT_NAME} --key <sk-xxx> --data '<json>'     直接传入线程数据
  node ${SCRIPT_NAME} --dry-run --file <path>             仅预览请求体（无需 key）

选项:
  --key <sk-xxx>       API key（每次运行传入，不写入文件）
  --endpoint <url>     API 端点 (默认: https://api.deepseek.com/v1/chat/completions)
  --model <name>       模型名 (默认: deepseek-chat)
  --file <path>        JSON 线程数据文件路径
  --data <json>        直接传入 JSON 线程数据（单条对象或 {threads:[...]}）
  --dry-run            仅打印即将发送的请求体，不实际调用 API
  --verbose            输出完整 system prompt / user prompt 和原始响应
  --help               显示本帮助

输入格式:
  {
    "threads": [
      {
        "threadId": "必填·线程ID",
        "subject": "必填·主题",
        "from": "发件人",
        "to": ["收件人1", "收件人2"],
        "date": "2026-07-10T08:00:00Z",
        "body": "必填·正文",
        "messages": [{"from":"","to":"","date":"","body":""}],
        "messageCount": 3
      }
    ]
  }
  支持单条对象自动包装，支持 messages 数组（多封邮件）优先于 body。

示例:
  node ${SCRIPT_NAME} --key sk-abc123 --file scripts/sample-threads.json
  node ${SCRIPT_NAME} --dry-run --file scripts/sample-threads.json --verbose
  node ${SCRIPT_NAME} --key sk-abc123 --data '{"threadId":"t1","subject":"Test","from":"x@y.com","to":["a@b.com"],"body":"test body"}'
`);
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) { printHelp(); process.exit(0); }

  const v = validate(args);
  if (v.err) { console.error('✗ 参数错误:', v.err); console.error('  用 --help 查看用法'); process.exit(1); }

  const loadResult = loadThreads(args);
  if (loadResult.err) { console.error('✗ 输入错误:', loadResult.err); process.exit(1); }
  const threads = loadResult.threads;

  const tv = validateThreads(threads);
  if (tv.err) { console.error('✗ 校验失败:\n' + tv.err); process.exit(1); }

  console.error('• 已加载 ' + threads.length + ' 条线程数据');
  if (args.dryRun) {
    printDryRun(args, threads);
    process.exit(0);
  }

  await setupProxy();
  console.error('• 正在调用 LLM ...');
  const result = await callLLM(args, threads);
  printResult(args, result);
  if (result.status !== 200) process.exit(1);
}

main().catch(e => {
  console.error('✗ 运行时错误:', e.message);
  if (e.cause) console.error('  根因:', e.cause.code || e.cause.message || e.cause);
  process.exit(1);
});
