# Start-SeeingTheBoardClearly.ps1
# Opens the FastAPI app and Cloudflare Tunnel in separate PowerShell windows.
#Step 1: Set the paths to your project folder, Cloudflare config file, and tunnel ID.
#Step 2: Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# Step 3: Run Script: .\Start-SeeingTheBoardClearly.ps1


$projectPath = "C:\Users\dnies\OneDrive\AI Code\SeeingTheBoardClearly\SeeingTheBoardClearly"
$cloudflaredConfig = "C:\Users\dnies\.cloudflared\config.yml"
$tunnelId = "d12b5476-d27e-4d4d-9567-1970c9ce6a94"

# Check that the expected paths and commands are available.
if (-not (Test-Path -LiteralPath $projectPath -PathType Container)) {
    Write-Error "Project folder not found: $projectPath"
    exit 1
}

if (-not (Test-Path -LiteralPath $cloudflaredConfig -PathType Leaf)) {
    Write-Error "Cloudflare config file not found: $cloudflaredConfig"
    exit 1
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "Python was not found on PATH. Install Python or correct your PATH, then try again."
    exit 1
}

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Error "cloudflared was not found on PATH. Install cloudflared or correct your PATH, then try again."
    exit 1
}

# Start the FastAPI development server in its own PowerShell window.
$apiCommand = "Set-Location -LiteralPath '$projectPath'; python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload --log-level debug"
Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoExit",
    "-Command",
    $apiCommand
)

# Start the Cloudflare Tunnel in a second PowerShell window.
$tunnelCommand = "cloudflared tunnel --config '$cloudflaredConfig' run $tunnelId"
Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoExit",
    "-Command",
    $tunnelCommand
)

Write-Host "Started the API server and Cloudflare Tunnel in separate PowerShell windows." -ForegroundColor Green
Write-Host "Keep both windows open while you want the app and tunnel to run."
