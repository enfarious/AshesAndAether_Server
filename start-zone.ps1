# Start Zone Server
# Processes game logic for assigned zones

param(
    [string]$ServerId = "zone-1",
    [string]$AssignedZones = "",  # Empty = all zones
    [int]$TickRate = 10,
    [string]$RedisUrl = "redis://localhost:6379"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Ashes & Aether - Zone Server" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Server ID: $ServerId" -ForegroundColor Gray
Write-Host "Tick Rate: $TickRate TPS" -ForegroundColor Gray
Write-Host "Redis: $RedisUrl" -ForegroundColor Gray

if ($AssignedZones -eq "") {
    Write-Host "Zones: ALL (single-server mode)" -ForegroundColor Yellow
} else {
    Write-Host "Zones: $AssignedZones" -ForegroundColor Green
}

Write-Host "========================================`n" -ForegroundColor Cyan

# Name the console window for easier restart/cleanup.
$Host.UI.RawUI.WindowTitle = "Ashes & Aether - Zone"

# Set environment variables
$env:SERVER_ID = $ServerId
$env:ASSIGNED_ZONES = $AssignedZones
$env:TICK_RATE = $TickRate
$env:REDIS_URL = $RedisUrl

# Start server
npm run dev:zone
