// llm-extract.mjs — LLM 抽取模块
// 导出 extractThreadMeta(apiKey, threads, opts) → 调 DeepSeek/OpenAI 兼容 API 返回结构化元数据。
// 供 server.js 的 POST /api/llm/extract 使用。prompt 构造与 CLI test-llm-extract.mjs 一致。

// ---------- Prompt 构造 ----------
export function buildSystemPrompt() {
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
4. summary 简洁，提到关键信息（什么设备/什么问题/需要什么）。`;
}

function buildThreadBlock(t) {
  const body = t.body || (Array.isArray(t.messages)
    ? t.messages.map(m => `[${m.from || ''} → ${m.to || ''} | ${m.date || ''}]\n${m.body || ''}`).join('\n---\n')
    : '');
  return `### ${t.threadId}
主题: ${t.subject}
发件人: ${t.from || 'unknown'}
收件人: ${Array.isArray(t.to) ? t.to.join(', ') : (t.to || 'unknown')}
日期: ${t.date || 'unknown'}
会话邮件数: ${t.messageCount || 1}
正文:
${body}`;
}

export function buildUserPrompt(threads) {
  return `分析以下 ${threads.length} 个邮件会话，对每个提取结构化元数据。返回纯 JSON 数组（不要 markdown 代码块）。\n\n${threads.map(buildThreadBlock).join('\n\n---\n\n')}`;
}

// ---------- API 调用 ----------
export async function extractThreadMeta(apiKey, threads, opts = {}) {
  if (!apiKey || typeof apiKey !== 'string') return { err: '缺少 apiKey' };
  if (!threads || !Array.isArray(threads) || threads.length === 0) return { err: 'threads 为空或格式错误' };

  // 校验每个线程
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i];
    if (!t.threadId && !t.id) return { err: `第 ${i + 1} 条缺少 threadId` };
    if (!t.subject) return { err: `第 ${i + 1} 条缺少 subject` };
    if (!t.body && !t.messages && !t.body_preview) return { err: `第 ${i + 1} 条缺少 body/messages` };
    // 用 id 补 threadId，用 body_preview 补 body
    if (!t.threadId && t.id) t.threadId = t.id;
    if (!t.body && t.body_preview) t.body = t.body_preview;
  }

  const endpoint = opts.endpoint || 'https://api.deepseek.com/v1/chat/completions';
  const model = opts.model || 'deepseek-chat';
  const reqBody = {
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
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(reqBody),
    });
  } catch (e) {
    return { err: '网络请求失败: ' + (e.cause?.code || e.cause?.message || e.message) };
  }

  const elapsed = Date.now() - t0;
  const rawBody = await resp.text();
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { parsed = null; }

  if (resp.status !== 200) {
    return {
      err: parsed?.error?.message || ('HTTP ' + resp.status),
      status: resp.status,
      detail: rawBody.slice(0, 500),
    };
  }

  const content = parsed?.choices?.[0]?.message?.content;
  const usage = parsed?.usage;
  let extraction = null;
  if (content) {
    try { extraction = JSON.parse(content); } catch { extraction = { raw: content }; }
  }

  return {
    extracted: extraction,
    usage: usage ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : null,
    elapsedMs: elapsed,
    threadCount: threads.length,
  };
}
