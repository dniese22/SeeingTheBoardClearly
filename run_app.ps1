# ============================================================================
# run_app.ps1
# Starts the FastAPI app + Cloudflare Named Tunnel (persistent custom domain)
# ============================================================================

param(
    [int]$Port = 8000,
    [string]$TunnelName = "seeingtheboardclearly",
    [string]$PublicHostname = "seeingtheboardclearly.com",
    [string]$ConfigPath = "$env:USERPROFILE\.cloudflared\config.yml"
)

$ErrorActionPreference = "Stop"

# --------------------------------------------------------------------------
# 0. Helper: Locate cloudflared.exe (PATH first, then known install paths)
# --------------------------------------------------------------------------
function Get-CloudflaredPath {
    # 1. Check PATH
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    # 2. Check common install locations
    $candidates = @(
        "C:\Program Files (x86)\cloudflared\cloudflared.exe",
        "C:\Program Files\cloudflared\cloudflared.exe",
        "$env:USERPROFILE\cloudflared\cloudflared.exe",
        "$env:LOCALAPPDATA\cloudflared\cloudflared.exe"
    )

    foreach ($path in $candidates) {
        if (Test-Path $path) {
            return $path
        }
    }

    return $null
}

# --------------------------------------------------------------------------
# 1. Check Prerequisites
# --------------------------------------------------------------------------
Write-Host "[INFO] Checking prerequisites..." -ForegroundColor Cyan

$CloudflaredExe = Get-CloudflaredPath
if (-not $CloudflaredExe) {
    Write-Host "[ERROR] cloudflared not found. Install it from:" -ForegroundColor Red
    Write-Host "        https://github.com/cloudflare/cloudflared/releases" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] cloudflared found: $CloudflaredExe" -ForegroundColor Green

if (-not (Test-Path $ConfigPath)) {
    Write-Host "[ERROR] config.yml not found at: $ConfigPath" -ForegroundColor Red
    Write-Host "        Run the one-time tunnel setup before using this script." -ForegroundColor Red
    exit 1
}
Write-Host "[OK] config.yml found: $ConfigPath" -ForegroundColor Green

# --------------------------------------------------------------------------
# 2. Kill any process already using the target port
# --------------------------------------------------------------------------
Write-Host "`n[INFO] Checking for existing process on port $Port..." -ForegroundColor Cyan

$portProcess = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

if ($portProcess) {
    foreach ($procId in $portProcess) {
        try {
            $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Host "[INFO] Stopping process on port $Port (PID $procId, $($proc.ProcessName))..." -ForegroundColor Yellow
                Stop-Process -Id $procId -Force -ErrorAction Stop
            }
        } catch {
            Write-Host "[WARN] Stop-Process failed for PID $procId, trying taskkill..." -ForegroundColor DarkYellow
            taskkill /F /PID $procId /T | Out-Null
        }
    }
    Start-Sleep -Seconds 1
}

# --------------------------------------------------------------------------
# 3. Kill any existing cloudflared processes (service + standalone)
# --------------------------------------------------------------------------
Write-Host "[INFO] Checking for cloudflared running as a Windows Service..." -ForegroundColor Cyan

$cfService = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
if ($cfService -and $cfService.Status -ne 'Stopped') {
    Write-Host "[INFO] Stopping cloudflared Windows service..." -ForegroundColor Yellow
    Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

Write-Host "[INFO] Checking for existing cloudflared processes..." -ForegroundColor Cyan

$existingCloudflared = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
if ($existingCloudflared) {
    foreach ($proc in $existingCloudflared) {
        Write-Host "[INFO] Stopping cloudflared (PID $($proc.Id))..." -ForegroundColor Yellow
        try {
            Stop-Process -Id $proc.Id -Force -ErrorAction Stop
        } catch {
            Write-Host "[WARN] Stop-Process failed, trying taskkill..." -ForegroundColor DarkYellow
            try {
                taskkill /F /PID $proc.Id /T | Out-Null
            } catch {
                Write-Host "[ERROR] Could not kill cloudflared PID $($proc.Id)." -ForegroundColor Red
                Write-Host "        Try running this script as Administrator, or reboot." -ForegroundColor Red
            }
        }
    }
    Start-Sleep -Seconds 1
}

# --------------------------------------------------------------------------
# 4. Prepare log files
# --------------------------------------------------------------------------
$LogDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}

$UvicornOutLog = Join-Path $LogDir "uvicorn.out.log"
$UvicornErrLog = Join-Path $LogDir "uvicorn.err.log"
$CloudflaredOutLog = Join-Path $LogDir "cloudflared.out.log"
$CloudflaredErrLog = Join-Path $LogDir "cloudflared.err.log"

# --------------------------------------------------------------------------
# 5. Start Uvicorn (FastAPI) server
# --------------------------------------------------------------------------
Write-Host "`n[INFO] Starting Uvicorn server on port $Port..." -ForegroundColor Cyan

$uvicornProcess = Start-Process -FilePath "python" `
    -ArgumentList "-m uvicorn main:app --host 0.0.0.0 --port $Port" `
    -RedirectStandardOutput $UvicornOutLog `
    -RedirectStandardError $UvicornErrLog `
    -NoNewWindow `
    -PassThru

Start-Sleep -Seconds 2

if ($uvicornProcess.HasExited) {
    Write-Host "[ERROR] Uvicorn failed to start. Check logs:" -ForegroundColor Red
    Write-Host "        $UvicornErrLog" -ForegroundColor Red
    Get-Content $UvicornErrLog -Tail 20
    exit 1
}

Write-Host "[OK] Uvicorn running (PID $($uvicornProcess.Id))" -ForegroundColor Green

# --------------------------------------------------------------------------
# 6. Start Cloudflare Named Tunnel
# --------------------------------------------------------------------------
Write-Host "`n[INFO] Starting Cloudflare Tunnel '$TunnelName'..." -ForegroundColor Cyan

$cloudflaredProcess = Start-Process -FilePath $CloudflaredExe `
    -ArgumentList "tunnel --config `"$ConfigPath`" run $TunnelName" `
    -RedirectStandardOutput $CloudflaredOutLog `
    -RedirectStandardError $CloudflaredErrLog `
    -NoNewWindow `
    -PassThru

Start-Sleep -Seconds 3

if ($cloudflaredProcess.HasExited) {
    Write-Host "[ERROR] cloudflared failed to start. Check logs:" -ForegroundColor Red
    Write-Host "        $CloudflaredErrLog" -ForegroundColor Red
    Get-Content $CloudflaredErrLog -Tail 20
    Stop-Process -Id $uvicornProcess.Id -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "[OK] cloudflared running (PID $($cloudflaredProcess.Id))" -ForegroundColor Green

# --------------------------------------------------------------------------
# 7. Display Public URL
# --------------------------------------------------------------------------
Write-Host "`n============================================================" -ForegroundColor Magenta
Write-Host " 🌍 Public URL:  https://$PublicHostname" -ForegroundColor Magenta
Write-Host " 🖥️  Local URL:   http://localhost:$Port" -ForegroundColor Magenta
Write-Host "============================================================`n" -ForegroundColor Magenta

Write-Host "[INFO] Press Ctrl+C to stop both the server and the tunnel.`n" -ForegroundColor Cyan

# --------------------------------------------------------------------------
# 8. Monitor & Clean shutdown
# --------------------------------------------------------------------------
try {
    while ($true) {
        Start-Sleep -Seconds 2

        if ($uvicornProcess.HasExited) {
            Write-Host "[WARN] Uvicorn process exited unexpectedly." -ForegroundColor Yellow
            break
        }
        if ($cloudflaredProcess.HasExited) {
            Write-Host "[WARN] cloudflared process exited unexpectedly." -ForegroundColor Yellow
            break
        }
    }
}
finally {
    Write-Host "`n[INFO] Shutting down..." -ForegroundColor Cyan

    if (-not $cloudflaredProcess.HasExited) {
        Stop-Process -Id $cloudflaredProcess.Id -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] cloudflared stopped." -ForegroundColor Green
    }

    if (-not $uvicornProcess.HasExited) {
        Stop-Process -Id $uvicornProcess.Id -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] Uvicorn stopped." -ForegroundColor Green
    }
}