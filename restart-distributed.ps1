# Restart distributed servers (kills old, starts new)
# One-button restart for development

param(
    [string]$RedisUrl = "redis://localhost:6379"
)

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "World of Darkness - Restart Servers" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Find and close PowerShell windows running the servers
Write-Host "Stopping existing servers..." -ForegroundColor Yellow

# Get all PowerShell windows running tsx watch commands
$serverWindows = Get-Process -Name "powershell" -ErrorAction SilentlyContinue | Where-Object {
    $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine
    $cmdLine -like "*tsx*gateway-main*" -or $cmdLine -like "*tsx*zoneserver-main*"
}

if ($serverWindows) {
    $serverWindows | ForEach-Object {
        Write-Host "  Closing window (PID: $($_.Id))..." -ForegroundColor Gray
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host "✓ Closed $($serverWindows.Count) server window(s)" -ForegroundColor Green
} else {
    Write-Host "✓ No running server windows found" -ForegroundColor Green
}

# Also kill any orphaned node processes
$orphanedNodes = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*tsx*gateway-main*" -or
    $_.CommandLine -like "*tsx*zoneserver-main*"
}

if ($orphanedNodes) {
    $orphanedNodes | ForEach-Object {
        Write-Host "  Killing orphaned node process $($_.Id)..." -ForegroundColor Gray
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host "✓ Killed $($orphanedNodes.Count) orphaned process(es)" -ForegroundColor Green
}

# Wait for processes to fully terminate
Write-Host "`nWaiting for cleanup..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

# Start fresh servers
Write-Host "`nStarting fresh servers..." -ForegroundColor Green
& "$PSScriptRoot\start-distributed.ps1" -RedisUrl $RedisUrl

Write-Host "`n✓ Restart complete!" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Cyan
