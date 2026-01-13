# Start complete distributed setup
# Launches Gateway + Zone Server in separate windows

param(
    [string]$RedisUrl = "redis://localhost:6379",
    [string]$GatewayWindowTitle = "Ashes & Aether - Gateway",
    [string]$ZoneWindowTitle = "Ashes & Aether - Zone",
    [switch]$SkipRedisCheck
)

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Ashes & Aether - Distributed Setup" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Check if Redis is running
if (-not $SkipRedisCheck) {
    Write-Host "Checking Redis connection..." -ForegroundColor Yellow
    try {
        $null = Test-NetConnection -ComputerName localhost -Port 6379 -InformationLevel Quiet -WarningAction SilentlyContinue
        if ($?) {
            Write-Host "✓ Redis is running on localhost:6379" -ForegroundColor Green
        } else {
            Write-Host "✗ Redis is not running!" -ForegroundColor Red
            Write-Host "`nPlease start Redis first:" -ForegroundColor Yellow
            Write-Host "  redis-server" -ForegroundColor Gray
            Write-Host "`nOr skip this check with -SkipRedisCheck" -ForegroundColor Gray
            exit 1
        }
    } catch {
        Write-Host "✗ Could not check Redis connection" -ForegroundColor Yellow
        Write-Host "Continuing anyway..." -ForegroundColor Gray
    }
}

Write-Host "`nStarting servers..." -ForegroundColor Yellow

# Start Gateway in new window
Write-Host "Launching Gateway Server..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle = '$GatewayWindowTitle'; .\start-gateway.ps1 -RedisUrl '$RedisUrl'"

# Wait a moment for Gateway to initialize
Start-Sleep -Seconds 2

# Start Zone Server in new window
Write-Host "Launching Zone Server..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle = '$ZoneWindowTitle'; .\start-zone.ps1 -RedisUrl '$RedisUrl'"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Servers launched!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "`nGateway:     http://localhost:3100" -ForegroundColor Gray
Write-Host "Health:      http://localhost:3100/health" -ForegroundColor Gray
Write-Host "API Info:    http://localhost:3100/api/info" -ForegroundColor Gray
Write-Host "`nTest Client: node test-client.js" -ForegroundColor Yellow
Write-Host "`nPress Ctrl+C in each window to stop servers" -ForegroundColor Gray
Write-Host "========================================`n" -ForegroundColor Cyan
