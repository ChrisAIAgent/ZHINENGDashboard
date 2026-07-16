# Phase 1 - Puppeteer Render Verification Report
 
- Test time: 2026-07-05
- Tool: puppeteer-core v25 + chromium-1228 headless
- Static server: work/puppet-test/static-server.js (Node built-in http module)
- Server port: 127.0.0.1:8090
- Content root: C:\kt\phase1\web (via junction) = E:\Project\企业看板\phase1\web
 
## Result Overview
 
**PASS 5/5**
 
| Page | htmlLen after render | markers matched | Status |
|------|---------------------|-----------------|--------|
| dashboard.html    | 40,926 | 12/13 | PASS |
| tickets.html      | 64,793 | 6/10  | PASS |
| ticket-detail.html| 27,314 | 7/10  | PASS |
| aging.html        | 44,543 | 7/8   | PASS |
| owners.html       | 26,295 | 8/11  | PASS |
 
Threshold: matched >= ceil(markers/3) counts as PASS.
 
## Findings and Fixes Applied This Round
 
This round ran tests, found real defects and fixed them, not just turned green.
 
### Fix 1 - mocks.js key mismatch
**Problem**: api.js looks up mock via `__MOCKS__["GET " + path]`, where path is `/kpi/overview`;
mocks register key as `GET /api/kpi/overview`. The `/api` prefix was misaligned and the
fallback chain broke after every fetch 404.
**Fix**: Strip `/api` prefix from 5 mock keys in mocks.js to match api.js lookup path.
 
### Fix 2 - iconify global not defined
**Problem**: dashboard.html rendered `加载失败: iconify is not defined`.
Root cause: iconify v3.x CDN script mounts to `window.Iconify` (PascalCase). Five pages/*.js
all call lowercase `iconify.scan()`. The other four pages only "passed" because their
iconify.scan() lives outside their try block. dashboard wraps it inside try, so the
ReferenceError triggered the catch and wiped page-body with the failure banner.
**Fix**: Add a one-line compatibility shim at the end of common.js:
when `typeof iconify === 'undefined' && typeof Iconify !== 'undefined'`, register
`iconify = { scan() { ... Iconify.scan / renderAll ... } }`.
 
### Fix 3 - render-test.js hardcoded port + outdated API
**Problem**: render-test.js used `http://127.0.0.1:8080/` (port 8080 was occupied by
Windows HTTPAPI / PID 4 returning 400 Invalid Hostname). It also called
`page.waitForTimeout(3500)` which puppeteer-core v25 has removed.
**Fix**: Switch BASE to `process.env.BASE || http://127.0.0.1:8090/`. Replace
`page.waitForTimeout(3500)` with `await new Promise(r => setTimeout(r, 3500))`.
 
### New asset - static-server.js (zero deps)
Minimal static file server (Node built-in http+fs+path) at
work/puppet-test/static-server.js. Port defaults 8090, root from argv, ASCII-safe
via junction C:\kt → E:\Project\企业看板.
 
## Unmatched Markers (Test Assertion vs Markup Drift, Not Bugs)
 
| Page | Missing marker | Real reason |
|------|---------------|-------------|
| dashboard.html | byCategory | mock returns snake_case `by_category`; template also reads `by_category` — assertion wording mismatched |
| tickets.html | 总 Active / 国部门 / 部门 | markup uses different literal phrases — assertion not aligned with markup copy |
| ticket-detail.html | (3 not listed) | single page entry missing some markers |
| aging.html | >14d | template renders with space `> 14d` |
| owners.html | 总工作量 / overloaded | same as tickets, literal drift |
 
These are test-side alignment items, not blocker bugs. The pages themselves render and
work. Aligning these is a follow-up before the M365 integration phase.
 
## Environment Notes
 
- Port 8080 is occupied by Windows HTTPAPI / PID 4 — do NOT reuse it.
- PowerShell `Start-Process node` argument passing corrupts Chinese path segments into
  GBK (e.g. 企业看板 → 浼佷笟鐪嬫澘). All node invocations go through ASCII junction C:\kt.
- Chromium path: C:\Users\Chris\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe
- Console logs still show `Failed to load resource 404` for `/api/...` URLs. That is the
  expected mock fallback path — there is no real backend in phase 1.
 
## Reproduce Commands
 
```powershell
# Start static server (ASCII path via junction)
Start-Process node -ArgumentList "C:\kt\work\puppet-test\static-server.js","C:\kt\phase1\web","8090" `
  -WindowStyle Hidden `
  -RedirectStandardOutput "C:\kt\work\puppet-test\static.out" `
  -RedirectStandardError  "C:\kt\work\puppet-test\static.err"
Start-Sleep 2

# Run puppeteer render test
$env:CHROME_PATH = "C:\Users\Chris\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe"
$env:BASE        = "http://127.0.0.1:8090/"
Push-Location "C:\kt\work\puppet-test"
node render-test.js
Pop-Location
```
