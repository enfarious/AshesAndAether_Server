# Restart distributed servers (kills old, starts new)
# One-button restart for development

param(
    [string]$RedisUrl = "redis://localhost:6379"
)

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Ashes & Aether - Restart Servers" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Find and close PowerShell windows running the servers
Write-Host "Stopping existing servers..." -ForegroundColor Yellow

# Window titles for server consoles
$gatewayWindowTitle = "Ashes & Aether - Gateway"
$zoneWindowTitle = "Ashes & Aether - Zone"
$repoRoot = (Resolve-Path $PSScriptRoot).Path

# Get all PowerShell windows running tsx watch commands
$serverWindows = Get-Process -Name "powershell" -ErrorAction SilentlyContinue | Where-Object {
    $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine
    $_.MainWindowTitle -like "*$gatewayWindowTitle*" -or
    $_.MainWindowTitle -like "*$zoneWindowTitle*" -or
    $cmdLine -like "*tsx*gateway-main*" -or
    $cmdLine -like "*tsx*zoneserver-main*"
}

if ($serverWindows) {
    $serverWindows | ForEach-Object {
        Write-Host "  Closing window (PID: $($_.Id))..." -ForegroundColor Gray
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host "û Closed $($serverWindows.Count) server window(s)" -ForegroundColor Green
} else {
    Write-Host "û No running server windows found" -ForegroundColor Green
}

# Also kill any orphaned node processes
$orphanedNodes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*$repoRoot*" -and (
        $_.CommandLine -like "*tsx*gateway-main*" -or
        $_.CommandLine -like "*tsx*zoneserver-main*" -or
        $_.CommandLine -like "*src\\gateway-main.ts*" -or
        $_.CommandLine -like "*src\\zoneserver-main.ts*"
    )
}

if ($orphanedNodes) {
    $orphanedNodes | ForEach-Object {
        Write-Host "  Killing orphaned node process $($_.ProcessId)..." -ForegroundColor Gray
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Write-Host "û Killed $($orphanedNodes.Count) orphaned process(es)" -ForegroundColor Green
}

# Wait for processes to fully terminate
Write-Host "`nWaiting for cleanup..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

# Start fresh servers
Write-Host "`nStarting fresh servers..." -ForegroundColor Green
& "$PSScriptRoot\start-distributed.ps1" -RedisUrl $RedisUrl -GatewayWindowTitle $gatewayWindowTitle -ZoneWindowTitle $zoneWindowTitle

Write-Host "`nû Restart complete!" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Cyan