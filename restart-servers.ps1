# Restart Servers - Stops and relaunches Gateway + Zone servers
# Useful for picking up changes without manual process management

param(
    [string]$RedisUrl = "redis://localhost:6379",
    [switch]$NoStart,
    [string]$GatewayWindowTitle = "Ashes & Aether - Gateway",
    [string]$ZoneWindowTitle = "Ashes & Aether - Zone"
)

$repoRoot = (Resolve-Path $PSScriptRoot).Path

Write-Host "Ashes & Aether - Restart Servers" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

function Get-ProcessCommandLine {
    param([int]$ProcessId)

    try {
        return (Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue).CommandLine
    } catch {
        return $null
    }
}

function Get-ServerHostProcesses {
    $matchingCommandLines = @(
        "*start-gateway.ps1*",
        "*start-zone.ps1*",
        "*npm*run*dev:gateway*",
        "*npm*run*dev:zone*",
        "*tsx*gateway-main*",
        "*tsx*zoneserver-main*",
        "*src\\gateway-main.ts*",
        "*src\\zoneserver-main.ts*"
    )

    $powershellWindows = Get-Process -Name "powershell" -ErrorAction SilentlyContinue | Where-Object {
        $cmdLine = Get-ProcessCommandLine -ProcessId $_.Id
        ($_.MainWindowTitle -like "*$GatewayWindowTitle*") -or
        ($_.MainWindowTitle -like "*$ZoneWindowTitle*") -or
        ($cmdLine -and ($matchingCommandLines | Where-Object { $cmdLine -like $_ }))
    }

    $cmdWindows = Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and ($matchingCommandLines | Where-Object { $_.CommandLine -like $_ })
    }

    $serverWindows = @()
    if ($powershellWindows) { $serverWindows += $powershellWindows }
    if ($cmdWindows) { $serverWindows += $cmdWindows }

    return $serverWindows
}

function Stop-ServerWindows {
    Write-Host "Stopping server windows..." -ForegroundColor Yellow

    $serverWindows = Get-ServerHostProcesses

    if ($serverWindows.Count -gt 0) {
        $serverWindows | ForEach-Object {
            Write-Host "  Closing window (PID: $($_.Id))..." -ForegroundColor Gray
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
        Write-Host "OK - Closed $($serverWindows.Count) server window(s)" -ForegroundColor Green
    } else {
        Write-Host "OK - No running server windows found" -ForegroundColor Green
    }
}

function Stop-OrphanedNodeProcesses {
    Write-Host "Stopping orphaned node processes..." -ForegroundColor Yellow

    $orphanedNodes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and (
            $_.CommandLine -like "*tsx*gateway-main*" -or
            $_.CommandLine -like "*tsx*zoneserver-main*" -or
            $_.CommandLine -like "*src\\gateway-main.ts*" -or
            $_.CommandLine -like "*src\\zoneserver-main.ts*"
        )
    }

    if ($orphanedNodes) {
        $orphanedNodes | ForEach-Object {
            Write-Host "  Killing node process $($_.ProcessId)..." -ForegroundColor Gray
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Write-Host "OK - Killed $($orphanedNodes.Count) orphaned process(es)" -ForegroundColor Green
    } else {
        Write-Host "OK - No orphaned node processes found" -ForegroundColor Green
    }
}

Stop-ServerWindows
Stop-OrphanedNodeProcesses

Write-Host ""
Write-Host "Waiting 2 seconds for cleanup..." -ForegroundColor Gray
Start-Sleep -Seconds 2

if ($NoStart) {
    Write-Host "Done. Server restart skipped (-NoStart)." -ForegroundColor Yellow
    return
}

Write-Host ""
Write-Host "Relaunching servers..." -ForegroundColor Cyan
Write-Host ""

& "$PSScriptRoot\start-distributed.ps1" -RedisUrl $RedisUrl -GatewayWindowTitle $GatewayWindowTitle -ZoneWindowTitle $ZoneWindowTitle

Write-Host "`nOK - Servers launched" -ForegroundColor Green
