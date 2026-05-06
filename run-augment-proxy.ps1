# run-augment-proxy.ps1
# Windows version of the Augment Proxy runner with Auto-Continue support

$ErrorActionPreference = "Continue"

# 1. Path and URL Setup
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PROXY_URL = if ($env:AUGMENT_PROXY_URL) { $env:AUGMENT_PROXY_URL } else { "http://127.0.0.1:8765" }
$AUTO_CONTINUE_CONFIG = if ($env:AUGGIE_AUTO_CONTINUE_CONFIG) { $env:AUGGIE_AUTO_CONTINUE_CONFIG } else { Join-Path $PSScriptRoot "tmp\.codex\hooks.json" }
$AUTO_CONTINUE_ACTIVE = if ($env:AUGGIE_AUTO_CONTINUE_ACTIVE) { $env:AUGGIE_AUTO_CONTINUE_ACTIVE } else { "0" }

# 2. Export Environment Variables
$env:AUGMENT_API_URL = $PROXY_URL
$env:AUGMENT_API_TOKEN = if ($env:AUGMENT_API_TOKEN) { $env:AUGMENT_API_TOKEN } else { "fake-augment-access-token" }

$authObj = @{
    accessToken = $env:AUGMENT_API_TOKEN
    tenantURL   = $PROXY_URL
    scopes      = @("email", "profile", "offline_access")
}
$env:AUGMENT_SESSION_AUTH = $authObj | ConvertTo-Json -Compress

# 3. Helper Functions
function Has-Arg {
    param([string]$needle)
    foreach ($arg in $args) {
        if ($arg -eq $needle) { return $true }
    }
    return $false
}

function Get-JsonValue {
    param([string]$keyPath)
    if (-not (Test-Path $AUTO_CONTINUE_CONFIG)) { return $null }
    try {
        $data = Get-Content $AUTO_CONTINUE_CONFIG -Raw | ConvertFrom-Json
        $value = $data.auto_continue
        foreach ($part in $keyPath.Split('.')) {
            if ($null -eq $value) { break }
            $value = $value.$part
        }
        return $value
    } catch {
        return $null
    }
}

# 4. Auto-Continue Logic Check
$shouldWrap = $false
if (Test-Path $AUTO_CONTINUE_CONFIG) {
    $enabled = Get-JsonValue "enabled"
    # PowerShell ConvertFrom-Json converts true/false to actual booleans
    if ($enabled -ne $false -and $AUTO_CONTINUE_ACTIVE -ne "1") {
        if (($args -contains "--print") -or ($args -contains "-p")) {
            $shouldWrap = $true
        }
    }
}

# 5. Execution
if (-not $shouldWrap) {
    # Direct execution if conditions not met
    & auggie $args
    exit $LASTEXITCODE
}

# Wrap execution to monitor for max iterations
$tmpOutput = [System.IO.Path]::GetTempFileName()

try {
    # Run auggie, pipe output to both host and temp file
    # Using --percent to avoid progress bar artifacts in log if needed, 
    # but here we just pass through user args.
    & auggie $args 2>&1 | Tee-Object -FilePath $tmpOutput
    $status = $LASTEXITCODE

    # 6. Check for Max Iterations
    $outputContent = Get-Content $tmpOutput -Raw
    if ($outputContent -match "maximum iterations reached|You can continue the conversation") {
        Write-Host "`n[Auto-Continue] Max iterations detected. Triggering continuation..." -ForegroundColor Cyan
        
        $env:AUGGIE_AUTO_CONTINUE_ACTIVE = "1"
        
        $prompt = Get-JsonValue "continue_prompt"
        if (-not $prompt) {
            $prompt = "继续执行未完成任务，先给出当前进度，然后继续下一步。"
        }
        
        $logFile = Get-JsonValue "log_file"
        if (-not $logFile) {
            $logFile = Join-Path $env:TEMP "augmentproxy-auto-continue.log"
        }
        
        # Ensure log directory exists
        $logDir = Split-Path $logFile -Parent
        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Add-Content -Path $logFile -Value "`n[$timestamp] auto-continue triggered by max iterations"
        
        # Execute continuation
        & auggie --print --quiet --continue $prompt 2>&1 | Tee-Object -FilePath $logFile -Append
        $status = $LASTEXITCODE
    }
} finally {
    if (Test-Path $tmpOutput) { Remove-Item $tmpOutput -ErrorAction SilentlyContinue }
}

exit $status
