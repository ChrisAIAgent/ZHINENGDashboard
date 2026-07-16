# IMAP smoke test — paste your app password in $APP_PASS, then run
$ErrorActionPreference = "Stop"
$USER_EMAIL = "outlook_6D4D44B38ED5B0AD@outlook.com"
$APP_PASS  = "PASTE-YOUR-APP-PASSWORD-HERE"
$BASE = "http://127.0.0.1:8787"

if ($APP_PASS -eq "PASTE-YOUR-APP-PASSWORD-HERE") {
  Write-Host "Edit this file: replace PASTE-YOUR-APP-PASSWORD-HERE with your real app password" -ForegroundColor Yellow
  exit 1
}

$auth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${USER_EMAIL}:${APP_PASS}"))
$headers = @{ "X-IMAP-Auth" = $auth }

function Probe($path) {
  Write-Host ""
  Write-Host "=== GET $path ===" -ForegroundColor Cyan
  $r = Invoke-WebRequest -Uri "$BASE$path" -Headers $headers -UseBasicParsing -TimeoutSec 60 -ErrorAction Stop
  $body = $r.Content | ConvertFrom-Json
  if ($body.totals) {
    Write-Host "totals: $($body.totals | ConvertTo-Json -Compress)" -ForegroundColor Green
    Write-Host "trend 7d: $($body.trend.Count) days"
  } elseif ($body.items) {
    Write-Host "items: $($body.items.Count)  total: $($body.total)" -ForegroundColor Green
    if ($body.items.Count -gt 0) {
      $body.items | Select-Object id, category, status, dealer_name, machine_model, owner_name, aging_days, subject | Format-Table -AutoSize
    }
  } elseif ($body.buckets) {
    Write-Host "buckets: $($body.buckets | ConvertTo-Json -Compress)" -ForegroundColor Green
  } else {
    Write-Host ($body | ConvertTo-Json -Depth 4) -ForegroundColor Green
  }
}

try {
  Probe "/api/kpi/overview"
  Probe "/api/tickets"
  Probe "/api/tickets?category=Parts"
  Probe "/api/owners/workload"
  Probe "/api/aging/buckets"
  if ($r) {
    $r2 = Invoke-WebRequest -Uri "$BASE/api/tickets" -Headers $headers -UseBasicParsing -TimeoutSec 60
    $j = $r2.Content | ConvertFrom-Json
    if ($j.items.Count -gt 0) { Probe "/api/tickets/$($j.items[0].id)" }
  }
  Write-Host ""
  Write-Host "ALL OK" -ForegroundColor Green
} catch {
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
  if ($_.Exception.Response) {
    $s = $_.Exception.Response.GetResponseStream()
    Write-Host (New-Object System.IO.StreamReader($s).ReadToEnd())
  }
}