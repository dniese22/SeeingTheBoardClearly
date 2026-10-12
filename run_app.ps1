param([int]$Port=8000)

$ErrorActionPreference = "Stop"

function Kill-Port([int]$p) {
  $conn = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue
  if ($conn) {
    $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($id in $pids) {
      try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Seconds 1
  }
}

function Ensure-Ngrok {
  $cmd = Get-Command ngrok -ErrorAction SilentlyContinue
  if ($null -ne $cmd) { return $true }

  Write-Host "ngrok not found on PATH. Trying common install locations..." -ForegroundColor Yellow

  $candidates = @(
    "$env:LOCALAPPDATA\ngrok\ngrok.exe",
    "$env:ProgramFiles\ngrok\ngrok.exe",
    "$env:ProgramFiles(x86)\ngrok\ngrok.exe",
    "$PSScriptRoot\ngrok.exe"
  ) | Where-Object { Test-Path $_ }

  if ($candidates.Count -gt 0) {
    return $true
  }

  Write-Host "ngrok.exe not found. Install ngrok from https://ngrok.com and re-run." -ForegroundColor Red
  return $false
}

function Start-Ngrok([int]$p) {
  $ngrokCmd = Get-Command ngrok -ErrorAction SilentlyContinue
  $ngrokExe = $ngrokCmd.Source

  if ([string]::IsNullOrWhiteSpace($ngrokExe)) {
    $ngrokExe = "$env:LOCALAPPDATA\ngrok\ngrok.exe"
    if (-not (Test-Path $ngrokExe)) {
      $ngrokExe = "$PSScriptRoot\ngrok.exe"
    }
  }

  Write-Host "Starting ngrok for port $p ..." -ForegroundColor Cyan

  # Note: ngrok’s local web API is typically on 4040
  $ngrokProc = Start-Process -FilePath $ngrokExe `
    -ArgumentList @("http", $p.ToString(), "--log=stdout") `
    -NoNewWindow -PassThru

  return $ngrokProc
}

function Get-NgrokPublicUrl {
  # wait up to ~15 seconds for ngrok local API to be ready
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -UseBasicParsing
      $httpTunnel = $resp.tunnels |
        Where-Object { $_.proto -eq "https" -or $_.public_url -like "https*" } |
        Select-Object -First 1

      if ($null -ne $httpTunnel -and -not [string]::IsNullOrWhiteSpace($httpTunnel.public_url)) {
        return $httpTunnel.public_url
      }
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  return $null
}

# =========================
# --- Main ---
# =========================
Kill-Port $Port

# ✅ Better fix: kill any existing ngrok processes first
# Prevents ERR_NGROK_334 ("endpoint already online")
Get-Process ngrok -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_ | Stop-Process -Force } catch {}
}
Start-Sleep -Seconds 1

Write-Host "Starting uvicorn..." -ForegroundColor Cyan
$uvicornProc = Start-Process -FilePath "python" -ArgumentList @(
  "-m","uvicorn","main:app","--reload","--port",$Port.ToString()
) -NoNewWindow -PassThru

Write-Host "Uvicorn PID: $($uvicornProc.Id)" -ForegroundColor Cyan
Start-Sleep -Seconds 2

if (-not (Ensure-Ngrok)) {
  Write-Host "ngrok not available; running locally only." -ForegroundColor Yellow
  Write-Host "Local UI: http://127.0.0.1:$Port/"
  while ($true) { Start-Sleep -Seconds 10 }
}

$ngrokProc = Start-Ngrok $Port
Write-Host "ngrok PID: $($ngrokProc.Id)" -ForegroundColor Cyan

Write-Host "Waiting for ngrok public URL..." -ForegroundColor Yellow
$publicUrl = Get-NgrokPublicUrl

if ([string]::IsNullOrWhiteSpace($publicUrl)) {
  Write-Host "Could not auto-detect ngrok public URL. Check ngrok output." -ForegroundColor Yellow
  Write-Host "Local UI: http://127.0.0.1:$Port/"
} else {
  Write-Host "✅ Public URL (phone): $publicUrl" -ForegroundColor Green
  Write-Host "UI:  $publicUrl/" -ForegroundColor Green
  Write-Host "API: $publicUrl/api/team_metrics" -ForegroundColor Green
}

while ($true) { Start-Sleep -Seconds 10 }