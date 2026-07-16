<#
.SYNOPSIS
  Microsoft Graph API 烟雾测试

.DESCRIPTION
  验证 Azure AD App 注册是否成功，Application 权限是否生效。

.PARAMETER TenantId
  M365 租户域名（如 xxx.onmicrosoft.com）或 Tenant ID

.PARAMETER ClientId
  Azure AD App 的 Client ID

.PARAMETER ClientSecret
  Azure AD App 的 Client Secret

.EXAMPLE
  .\smoke-test.ps1 -TenantId "xxx.onmicrosoft.com" -ClientId "..." -ClientSecret "..."

.EXAMPLE
  # 从环境变量读取
  $env:GRAPH_TENANT_ID="..."; $env:GRAPH_CLIENT_ID="..."; $env:GRAPH_CLIENT_SECRET="..."
  .\smoke-test.ps1
#>
param(
  [string]$TenantId = $env:GRAPH_TENANT_ID,
  [string]$ClientId = $env:GRAPH_CLIENT_ID,
  [string]$ClientSecret = $env:GRAPH_CLIENT_SECRET
)

$ErrorActionPreference = "Stop"

if (-not $TenantId -or -not $ClientId -or -not $ClientSecret) {
  Write-Host "ERROR: 缺少参数。请提供 TenantId/ClientId/ClientSecret 或设置环境变量。" -ForegroundColor Red
  Write-Host "  `$env:GRAPH_TENANT_ID, `$env:GRAPH_CLIENT_ID, `$env:GRAPH_CLIENT_SECRET"
  exit 1
}

function Get-GraphToken($tenant, $cid, $secret) {
  $body = @{
    grant_type    = "client_credentials"
    client_id     = $cid
    client_secret = $secret
    scope         = "https://graph.microsoft.com/.default"
  }
  $resp = Invoke-RestMethod -Method Post `
    -Uri "https://login.microsoftonline.com/$tenant/oauth2/v2.0/token" `
    -Body $body `
    -ContentType "application/x-www-form-urlencoded"
  return $resp.access_token
}

function Invoke-Graph($token, $path) {
  $headers = @{ Authorization = "Bearer $token" }
  return Invoke-RestMethod -Method Get `
    -Uri "https://graph.microsoft.com/v1.0$path" `
    -Headers $headers
}

Write-Host "=== Step 1: 获取 access token ===" -ForegroundColor Cyan
try {
  $token = Get-GraphToken $TenantId $ClientId $ClientSecret
  Write-Host "OK - token length: $($token.Length)" -ForegroundColor Green
} catch {
  Write-Host "FAIL - token 失败: $_" -ForegroundColor Red
  exit 1
}

Write-Host "`n=== Step 2: 列用户（前 5 个） ===" -ForegroundColor Cyan
try {
  $users = Invoke-Graph $token "/users?`$select=id,displayName,mail&`$top=5"
  Write-Host "OK - 找到 $($users.value.Count) 个用户" -ForegroundColor Green
  $users.value | Select-Object displayName, mail, id | Format-Table -AutoSize | Out-String | Write-Host
} catch {
  Write-Host "FAIL - 用户列表失败: $_" -ForegroundColor Red
  Write-Host "提示：检查 API permissions 是否包含 User.Read.All，并已 Grant admin consent" -ForegroundColor Yellow
  exit 1
}

Write-Host "=== Step 3: 拉第一个用户收件箱（前 5 封） ===" -ForegroundColor Cyan
try {
  $uid = (Invoke-Graph $token "/users?`$top=1").value[0].id
  $msgs = Invoke-Graph $token "/users/$uid/mailFolders/Inbox/messages?`$top=5&`$select=id,subject,from,receivedDateTime,conversationId,bodyPreview"
  Write-Host "OK - 用户 ID: $uid" -ForegroundColor Green
  Write-Host "OK - 收到 $($msgs.value.Count) 封邮件" -ForegroundColor Green
  $msgs.value | Select-Object @{n="From";e={$_.from.emailAddress.address}}, subject, receivedDateTime, conversationId | Format-Table -AutoSize | Out-String | Write-Host
} catch {
  Write-Host "FAIL - 邮件拉取失败: $_" -ForegroundColor Red
  Write-Host "提示：检查 Mail.Read.All 是否已 Grant admin consent" -ForegroundColor Yellow
  exit 1
}

Write-Host "=== Step 4: Delta 同步测试 ===" -ForegroundColor Cyan
try {
  $delta = Invoke-Graph $token "/users/$uid/mailFolders/Inbox/messages/delta?`$top=2"
  $deltaLink = $delta.'@odata.deltaLink'
  Write-Host "OK - delta link: $($deltaLink.Substring(0, [Math]::Min(80, $deltaLink.Length)))..." -ForegroundColor Green
  Write-Host "提示：保存 deltaLink 用于下次增量同步" -ForegroundColor Yellow
} catch {
  Write-Host "FAIL - delta 失败: $_" -ForegroundColor Red
  exit 1
}

Write-Host "`n=== 全部通过 ===" -ForegroundColor Green
Write-Host "下一步：可以开始搭 Worker 骨架（phase1/workers/）"
