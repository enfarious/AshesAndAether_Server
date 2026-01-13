# Ashes & Aether Server Launcher
# Auto-restart script with logging

param(
    [switch]$NoRestart,
    [int]$MaxRestarts = 0  # 0 = unlimited
)

$ServerScript = "src/index.ts"
$LogDir = "logs"
$RestartCount = 0

# Create logs directory if it doesn't exist
if (!(Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}

$Timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$LogFile = Join-Path $LogDir "server_$Timestamp.log"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Ashes & Aether Server Launcher" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Log file: $LogFile" -ForegroundColor Gray
Write-Host "Auto-restart: $(-not $NoRestart)" -ForegroundColor Gray
if ($MaxRestarts -gt 0) {
    Write-Host "Max restarts: $MaxRestarts" -ForegroundColor Gray
}
Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host "========================================`n" -ForegroundColor Cyan

function Start-Server {
    param($IsRestart = $false)

    if ($IsRestart) {
        $script:RestartCount++
        Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Restarting server (attempt $RestartCount)..." -ForegroundColor Yellow
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Server restart #$RestartCount" | Out-File -FilePath $LogFile -Append
        Start-Sleep -Seconds 2
    } else {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting server..." -ForegroundColor Green
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Server started" | Out-File -FilePath $LogFile -Append
    }

    # Run the server and capture exit code
    npm run dev 2>&1 | Tee-Object -FilePath $LogFile -Append

    return $LASTEXITCODE
}

try {
    do {
        $ExitCode = Start-Server -IsRestart ($RestartCount -gt 0)

        if ($ExitCode -ne 0) {
            Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Server exited with code: $ExitCode" -ForegroundColor Red
            "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Server crashed with exit code: $ExitCode" | Out-File -FilePath $LogFile -Append

            if ($NoRestart) {
                Write-Host "Auto-restart disabled. Exiting." -ForegroundColor Yellow
                break
            }

            if ($MaxRestarts -gt 0 -and $RestartCount -ge $MaxRestarts) {
                Write-Host "Max restart limit ($MaxRestarts) reached. Exiting." -ForegroundColor Red
                break
            }

            Write-Host "Restarting in 3 seconds..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
        } else {
            Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Server stopped gracefully." -ForegroundColor Green
            "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Server stopped gracefully" | Out-File -FilePath $LogFile -Append
            break
        }
    } while ($true)
}
catch {
    Write-Host "`nScript interrupted." -ForegroundColor Yellow
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - Script interrupted by user" | Out-File -FilePath $LogFile -Append
}
finally {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "Server launcher stopped" -ForegroundColor Cyan
    Write-Host "Total restarts: $RestartCount" -ForegroundColor Gray
    Write-Host "Log saved to: $LogFile" -ForegroundColor Gray
    Write-Host "========================================" -ForegroundColor Cyan
}
