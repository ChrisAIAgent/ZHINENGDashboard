<#
.SYNOPSIS
  Microsoft Graph smoke test for Delegated (Graph Explorer) tokens.

.DESCRIPTION
  Verifies a Graph Explorer access token is alive and can:
    - GET /me (who am I?)
    - GET /me/mailFolders/Inbox/messages (top 5)
    - $search="Mountaintop" / $search="SWE25" (the real case in mocks.js)

.NOTES
  Graph Explorer tokens are DELEGATED (act on behalf of a signed-in user).
  They live ~1 hour. Not for production automation.

.EXAMPLE
  # Option 1: paste interactively
  .\graph-explorer-smoke.ps1

  # Option 2: env var
  $env:GRAPH_TOKEN = "eyJ0eXAiOiJKV1Qi..."
  .\graph-explorer-smoke.ps1
#>

$ErrorActionPreference = "Stop"

$Token = $env:GRAPH_TOKEN
if (-not $Token) {
  Write-Host "Paste your Graph Explorer access token (Bearer):" -ForegroundColor Yellow
  $secure = Read-Host -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $Token = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if (-not $Token) { Write-Host "ERROR: empty token" -ForegroundColor Red; exit 1 }

$H = @{ Authorization = "Bearer $Token"; ConsistencyLevel = "eventual" }
function GraphGet($path) {
  return Invoke-RestMethod -Method Get -Uri "https://graph.microsoft.com/v1.0$path" -Headers $H -TimeoutSec 30
}

Write-Host "=== Step 1: GET /me ===" -ForegroundColor Cyan
try {
  $me = GraphGet "/me?`$select=id,displayName,mail,userPrincipalName"
  Write-Host ("OK  user: {0} <{1}>" -f $me.displayName, $me.mail) -ForegroundColor Green
  Write-Host ("    UPN:  {0}" -f $me.userPrincipalName)
  Write-Host ("    ID:   {0}" -f $me.id)
} catch {
  Write-Host "FAIL Step 1: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

Write-Host "`n=== Step 2: Inbox top 5 ===" -ForegroundColor Cyan
try {
  $inbox = GraphGet "/me/mailFolders/Inbox/messages?`$top=5&`$select=id,subject,from,receivedDateTime,conversationId,bodyPreview"
  Write-Host "OK  - $($inbox.value.Count) messages" -ForegroundColor Green
  $rows = $inbox.value | Select-Object `
    @{n="From";e={$_.from.emailAddress.address}}, `
    subject, `
    receivedDateTime, `
    conversationId
  $rows | Format-Table -AutoSize | Out-String | Write-Host
} catch {
  Write-Host "FAIL Step 2: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

Write-Host "`n=== Step 3: search `"Mountaintop`" ===" -ForegroundColor Cyan
try {
  $hit = GraphGet "/me/messages?`$search=`"Mountaintop`"&`$select=id,subject,from,receivedDateTime,conversationId,bodyPreview&`$top=10"
  Write-Host "OK  - $($hit.value.Count) hits" -ForegroundColor Green
  $rows = $hit.value | Select-Object `
    @{n="From";e={$_.from.emailAddress.address}}, `
    subject, `
    receivedDateTime, `
    conversationId
  $rows | Format-Table -AutoSize | Out-String | Write-Host
  if ($hit.value.Count -gt 0) {
    Write-Host "First conversationId: $($hit.value[0].conversationId)" -ForegroundColor Yellow
    Write-Host "First messageId:      $($hit.value[0].id)" -ForegroundColor Yellow
  }
} catch {
  Write-Host "FAIL Step 3: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n=== Step 4: search `"SWE25`" ===" -ForegroundColor Cyan
try {
  $hit = GraphGet "/me/messages?`$search=`"SWE25`"&`$select=id,subject,from,receivedDateTime,conversationId&`$top=10"
  Write-Host "OK  - $($hit.value.Count) hits" -ForegroundColor Green
  $rows = $hit.value | Select-Object `
    @{n="From";e={$_.from.emailAddress.address}}, `
    subject, `
    receivedDateTime, `
    conversationId
  $rows | Format-Table -AutoSize | Out-String | Write-Host
} catch {
  Write-Host "FAIL Step 4: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "Token valid ~1 hour. To re-run without re-pasting:"
Write-Host "  `$env:GRAPH_TOKEN=...; .\graph-explorer-smoke.ps1"
