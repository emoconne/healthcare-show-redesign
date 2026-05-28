# JBCC Healthcare Show - Kiosk Startup Script
$VoicevoxPath = $env:VOICEVOX_PATH
if (-not $VoicevoxPath) {
    $VoicevoxPath = "C:\VOICEVOX\run.exe"
}

Write-Host "Starting JBCC Healthcare Show Kiosk..." -ForegroundColor Cyan

# Start VOICEVOX if TTS_ENGINE is voicevox
$ttsEngine = $env:TTS_ENGINE
if (-not $ttsEngine) {
    # Read from .env file
    $envFile = Join-Path $PSScriptRoot ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^TTS_ENGINE=(.+)$') { $ttsEngine = $Matches[1] }
        }
    }
}

if ($ttsEngine -eq "voicevox") {
    if (Test-Path $VoicevoxPath) {
        Write-Host "Starting VOICEVOX..." -ForegroundColor Yellow
        Start-Process -FilePath $VoicevoxPath -WindowStyle Minimized

        Write-Host "Waiting for VOICEVOX to be ready..." -ForegroundColor Yellow
        $maxRetries = 30
        $ready = $false
        for ($i = 0; $i -lt $maxRetries; $i++) {
            try {
                $response = Invoke-WebRequest -Uri "http://localhost:50021/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                if ($response.StatusCode -eq 200) {
                    Write-Host "VOICEVOX is ready! (version: $($response.Content))" -ForegroundColor Green
                    $ready = $true
                    break
                }
            } catch {}
            Start-Sleep -Seconds 1
        }

        if (-not $ready) {
            Write-Host "WARNING: VOICEVOX did not start. TTS will fall back to Azure." -ForegroundColor Red
        }
    } else {
        Write-Host "WARNING: VOICEVOX not found at $VoicevoxPath. Set VOICEVOX_PATH env var." -ForegroundColor Red
    }
}

# Start Node.js server
Write-Host "Starting Node.js server..." -ForegroundColor Yellow
Set-Location $PSScriptRoot
node server.js
