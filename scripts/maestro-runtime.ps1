[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "status", "restart", "stop", "apply-update")]
    [string]$Action = "status",

    [ValidateRange(1, 120)]
    [int]$WaitSeconds = 20,

    [string]$TargetCommit = "",

    [string]$PreviousCommit = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runtimeDir = Join-Path $repoRoot ".maestro\runtime"
$pidPath = Join-Path $runtimeDir "maestro.pid"
$stdoutPath = Join-Path $runtimeDir "maestro.stdout.log"
$stderrPath = Join-Path $runtimeDir "maestro.stderr.log"
$dashboardPort = 4787
$envPath = Join-Path $repoRoot ".env.local"

if ($env:MAESTRO_DASHBOARD_PORT -match '^[0-9]+$') {
    $candidatePort = [int]$env:MAESTRO_DASHBOARD_PORT
    if ($candidatePort -ge 1 -and $candidatePort -le 65535) {
        $dashboardPort = $candidatePort
    }
}
elseif (Test-Path -LiteralPath $envPath) {
    $configuredPort = Get-Content -LiteralPath $envPath |
        Where-Object { $_ -match '^\s*MAESTRO_DASHBOARD_PORT\s*=\s*([0-9]+)\s*$' } |
        Select-Object -First 1
    if ($configuredPort -and $configuredPort -match '=\s*([0-9]+)\s*$') {
        $candidatePort = [int]$Matches[1]
        if ($candidatePort -ge 1 -and $candidatePort -le 65535) {
            $dashboardPort = $candidatePort
        }
    }
}

$healthUrl = "http://127.0.0.1:$dashboardPort/api/health"

function Test-MaestroHealth {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        return $response.ok -eq $true -and $response.runtimeMode -eq "full"
    }
    catch {
        return $false
    }
}

function Get-StoredProcessId {
    if (-not (Test-Path -LiteralPath $pidPath)) {
        return $null
    }

    $stored = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($stored -notmatch '^[0-9]+$') {
        return $null
    }
    return [int]$stored
}

function Get-MaestroProcess([int]$ProcessId) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $process -or -not $process.CommandLine) {
        return $null
    }
    if ($process.CommandLine.IndexOf($repoRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        return $null
    }
    return $process
}

function Get-DescendantProcessIds([int]$ParentProcessId) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentProcessId" -ErrorAction SilentlyContinue)
    $result = [System.Collections.Generic.List[int]]::new()
    foreach ($child in $children) {
        foreach ($descendant in Get-DescendantProcessIds -ParentProcessId $child.ProcessId) {
            $result.Add($descendant)
        }
        $result.Add([int]$child.ProcessId)
    }
    return $result
}

function Stop-MaestroRuntime {
    param([int[]]$ExcludeProcessIds = @())
    $processId = Get-StoredProcessId
    if ($null -eq $processId) {
        Write-Output "Maestro runtime: stopped (no PID)."
        return
    }

    $process = Get-MaestroProcess -ProcessId $processId
    if ($null -eq $process) {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        Write-Output "Maestro runtime: stopped (stale PID removed)."
        return
    }

    foreach ($descendantId in Get-DescendantProcessIds -ParentProcessId $processId) {
        if ($ExcludeProcessIds -contains $descendantId) { continue }
        Stop-Process -Id $descendantId -Force -ErrorAction SilentlyContinue
    }
    if ($ExcludeProcessIds -notcontains $processId) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    Write-Output "Maestro runtime: stopped."
}

function Start-MaestroRuntime {
    if (Test-MaestroHealth) {
        Write-Output "Maestro runtime: already healthy at $healthUrl"
        return
    }

    $existingProcessId = Get-StoredProcessId
    if ($null -ne $existingProcessId -and $null -ne (Get-MaestroProcess -ProcessId $existingProcessId)) {
        throw "Maestro process exists but health check failed. Run restart and inspect $stderrPath."
    }

    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue

    $escapedRepoRoot = $repoRoot.Replace("'", "''")
    $command = "Set-Location -LiteralPath '$escapedRepoRoot'; & npm.cmd run dev; exit `$LASTEXITCODE"
    $process = Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-Command", $command) `
        -WorkingDirectory $repoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii

    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    do {
        if (Test-MaestroHealth) {
            Write-Output "Maestro runtime: healthy at $healthUrl (PID $($process.Id))."
            Write-Output "stdout: $stdoutPath"
            Write-Output "stderr: $stderrPath"
            return
        }
        if ($process.HasExited) {
            throw "Maestro exited during startup. Inspect $stderrPath."
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    throw "Maestro did not become healthy within $WaitSeconds seconds. Inspect $stderrPath."
}

function Show-MaestroStatus {
    $processId = Get-StoredProcessId
    $process = if ($null -ne $processId) { Get-MaestroProcess -ProcessId $processId } else { $null }
    $healthy = Test-MaestroHealth
    [pscustomobject]@{
        healthy = $healthy
        processRunning = $null -ne $process
        processId = if ($null -ne $process) { $processId } else { $null }
        healthUrl = $healthUrl
        stdout = $stdoutPath
        stderr = $stderrPath
    } | ConvertTo-Json
    if (-not $healthy) {
        exit 1
    }
}

function Apply-MaestroUpdate {
    $previousCommit = if ($PreviousCommit) { $PreviousCommit } else { (git rev-parse HEAD).Trim() }
    Write-Output "Maestro update: starting update from $previousCommit..."

    $status = (git status --porcelain).Trim()
    if ($status) {
        throw "Maestro update: uncommitted changes in worktree. Refusing to update."
    }

    Write-Output "Maestro update: fetching remote changes..."
    git fetch origin main | Out-Null

    $target = if ($TargetCommit) { $TargetCommit } else { (git rev-parse origin/main).Trim() }
    git merge-base --is-ancestor $target origin/main
    if ($LASTEXITCODE -ne 0) {
        throw "Maestro update: target commit $target is not contained in origin/main."
    }
    Write-Output "Maestro update: fast-forward merging origin/main at $target..."
    $mergeResult = git merge --ff-only origin/main 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Maestro update: fast-forward merge failed. Local main branch diverged. $mergeResult"
    }

    $newCommit = (git rev-parse HEAD).Trim()
    Write-Output "Maestro update: fast-forwarded to $newCommit."

    Write-Output "Maestro update: stopping current runtime..."
    Stop-MaestroRuntime -ExcludeProcessIds @($PID)

    try {
        Write-Output "Maestro update: starting new runtime..."
        Start-MaestroRuntime
        Write-Output "Maestro update: successfully updated to $newCommit and restarted."
    }
    catch {
        $startupError = $_.Exception.Message
        Write-Output "Maestro update: startup failed: $startupError. Initiating rollback..."

        $rollbackSucceeded = $false
        try {
            Stop-MaestroRuntime -ExcludeProcessIds @($PID)
            Write-Output "Maestro update: rolling back git commit to $previousCommit..."
            git reset --hard $previousCommit | Out-Null
            Start-MaestroRuntime
            Write-Output "Maestro update: rollback to $previousCommit completed successfully."
            $rollbackSucceeded = $true
        }
        catch {
            throw "Maestro update failed and rollback failed: $($_)"
        }
        if ($rollbackSucceeded) {
            throw "Maestro update failed: $startupError (rolled back to $previousCommit)."
        }
    }
}

switch ($Action) {
    "start" { Start-MaestroRuntime }
    "status" { Show-MaestroStatus }
    "restart" {
        Stop-MaestroRuntime
        Start-MaestroRuntime
    }
    "stop" { Stop-MaestroRuntime }
    "apply-update" { Apply-MaestroUpdate }
}
