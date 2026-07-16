const puppeteer = require('puppeteer-core');
const fs = require('fs');

const CHROMIUM = process.env.CHROME_PATH;
const BASE = process.env.BASE || 'http://127.0.0.1:8090/';

const PAGES = [
  { name: 'dashboard.html',    markers: ['Active Tickets','本周新增','Ticket 趋势','按分类概览','Overdue Top','本周已关闭','本周新增','Service','Warranty','Sales','byCategory', 'rounded-xl border shadow-sm','按分类概览'] },
  { name: 'tickets.html',      markers: ['TKT-2026','Ticket 列表','总 Active','Shanghai Heavy','Beijing Industrial','国部门','部门','总 Active','重置','查询'] },
  { name: 'ticket-detail.html',markers: ['处理时间线','邮件对话','经销商','开单日期','Last Update','conversationId','conversation','Ticket created','Owner assigned','Status update'] },
  { name: 'aging.html',        markers: ['0-3d','3-7d','7-14d','>14d','Aging 分析','Overdue Top 10','bucket-cards','按分类的 Aging 分布'] },
  { name: 'owners.html',       markers: ['Active','Owner 工作量','超负荷','总 Active','总工作量','部门','周关闭','张伟','李明','王芳','overloaded'] }
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--ignore-certificate-errors',
      '--allow-running-insecure-content'
    ],
    defaultViewport: { width: 1440, height: 900 }
  });
  let pass = 0, fail = 0;
  const out = [];
  for (const p of PAGES) {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    const errors = [];
    const consoleErrors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0,200)); });
    let status = 'OK', htmlLen = 0, matched = [];
    let navError = null;
    try {
      // 改用 domcontentloaded,不依赖 CDN
      await page.goto(BASE + p.name, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // 继续等 3.5s 让异步数据 / tailwind 完成
      await new Promise(r => setTimeout(r, 3500));
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      htmlLen = html.length;
      matched = p.markers.filter(m => html.includes(m));
      const needOk = Math.max(2, Math.ceil(p.markers.length / 3));
      const ok = matched.length >= needOk;
      status = ok ? 'PASS' : 'FAIL';
      if (ok) pass++; else fail++;
    } catch (e) {
      status = 'ERROR';
      navError = e.message;
      fail++;
    }
    out.push({ page: p.name, status, htmlLen, matched: matched.length + '/' + p.markers.length, list: matched, errors: errors.length, consoleErrors: consoleErrors.length, navError });
    await page.close();
  }
  await browser.close();
  console.log(JSON.stringify(out, null, 2));
  console.log('---');
  console.log('PASS: ' + pass + ' / ' + PAGES.length);
  console.log('FAIL: ' + fail + ' / ' + PAGES.length);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });


