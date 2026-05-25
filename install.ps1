<#
.SYNOPSIS
    Installa PcMonitor come servizio Windows su questo server.
    Normalmente chiamato da bootstrap.ps1, ma puo essere eseguito direttamente.

.PARAMETER InstallDir
    Cartella di installazione (default: C:\PcMonitor)

.PARAMETER Port
    Porta HTTP (default: 5000)

.PARAMETER ServiceName
    Nome del servizio Windows (default: PcMonitor)

.PARAMETER SourceDir
    Cartella sorgente (default: cartella dello script)

.PARAMETER ConfigFile
    Percorso a un config.json pre-compilato da usare per questa sede.
    Es: -ConfigFile "C:\configs\ciro.json"
    Se non specificato, verra usato config.example.json come punto di partenza.
#>
param(
    [string]$InstallDir  = "C:\PcMonitor",
    [int]   $Port        = 5000,
    [string]$ServiceName = "PcMonitor",
    [string]$SourceDir   = $PSScriptRoot,
    [string]$ConfigFile  = ""
)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERRORE: eseguire come Administrator." -ForegroundColor Red
    exit 1
}

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

Write-Host ""
Write-Host "=== Installazione PcMonitor ===" -ForegroundColor Cyan
Write-Host "  Cartella:  $InstallDir"
Write-Host "  Porta:     $Port"
Write-Host "  Servizio:  $ServiceName"
Write-Host ""

# -- 1. Verifica Python -------------------------------------------------------
Write-Host "[1/6] Verifica Python..." -NoNewline
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host " ERRORE" -ForegroundColor Red
    Write-Error "Python non trovato nel PATH. Installare Python 3.x da https://python.org e aggiungere al PATH."
    exit 1
}
$pyVer = & python --version 2>&1
Write-Host " OK ($pyVer)" -ForegroundColor Green

# -- 2. Copia file ------------------------------------------------------------
Write-Host "[2/6] Copia file in $InstallDir..." -NoNewline

# Ferma servizio e termina processi residui che potrebbero bloccare i file
$existing = Get-Service $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep 2
    $nssmExe = "$InstallDir\tools\nssm.exe"
    if (Test-Path $nssmExe) {
        $ErrorActionPreference = "SilentlyContinue"
        & $nssmExe remove $ServiceName confirm 2>$null
        $ErrorActionPreference = "Stop"
        Start-Sleep 1
    }
}
# Termina qualsiasi processo Python o NSSM rimasto attivo
Stop-Process -Name python -Force -ErrorAction SilentlyContinue
Stop-Process -Name nssm   -Force -ErrorAction SilentlyContinue
Start-Sleep 2

# Preserva config.json e positions.json se esistono gia
$preserveFiles = @("backend\config.json", "backend\positions.json", "piantina.png")
$preserved = @{}
foreach ($f in $preserveFiles) {
    $fullPath = Join-Path $InstallDir $f
    if (Test-Path $fullPath) {
        $preserved[$f] = Get-Content $fullPath -Raw
    }
}

New-Item -ItemType Directory -Force $InstallDir | Out-Null

# Stadio A: copia i sorgenti in C:\Windows\Temp (accessibile da SYSTEM)
# Necessario perche $SourceDir e' in AppData\Local\Temp dell'utente, inaccessibile a SYSTEM
$sysStage = "C:\Windows\Temp\pcmonitor_stage"
Remove-Item $sysStage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $sysStage | Out-Null
Copy-Item -Path "$SourceDir\*" -Destination $sysStage -Recurse -Force

# Stadio B: SYSTEM copia da Windows\Temp a C:\PcMonitor (bypassa permessi bloccati)
$doneFlag = "C:\Windows\Temp\pcmonitor_copy_done.txt"
$copyPs1  = "C:\Windows\Temp\pcmonitor_copy.ps1"
Remove-Item $doneFlag -Force -ErrorAction SilentlyContinue
[System.IO.File]::WriteAllText($copyPs1, @"
robocopy '$sysStage' '$InstallDir' /E /IS /IT /IM /R:1 /W:1 /NFL /NDL /NJH /NJS
`$LASTEXITCODE | Out-File '$doneFlag' -Encoding ASCII
"@)

$action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -NonInteractive -File `"$copyPs1`""
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
Register-ScheduledTask -TaskName "PcMonitorCopy" -Action $action -Settings $settings -RunLevel Highest -User "SYSTEM" -Force | Out-Null
Start-ScheduledTask -TaskName "PcMonitorCopy"

$deadline = (Get-Date).AddSeconds(60)
while (-not (Test-Path $doneFlag) -and (Get-Date) -lt $deadline) { Start-Sleep 2 }
Unregister-ScheduledTask -TaskName "PcMonitorCopy" -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Remove-Item $copyPs1  -Force -ErrorAction SilentlyContinue
Remove-Item $sysStage -Recurse -Force -ErrorAction SilentlyContinue

if (-not (Test-Path $doneFlag)) {
    Write-Host " ERRORE: timeout copia file" -ForegroundColor Red
    exit 1
}
$rcExit = [int]((Get-Content $doneFlag -Raw -ErrorAction SilentlyContinue) -replace '\D','0')
Remove-Item $doneFlag -Force -ErrorAction SilentlyContinue
if ($rcExit -ge 8) {
    Write-Host " ERRORE (robocopy exit $rcExit)" -ForegroundColor Red
    exit 1
}

# Ripristina file preservati
foreach ($f in $preserved.Keys) {
    $fullPath = Join-Path $InstallDir $f
    Set-Content $fullPath $preserved[$f] -Encoding UTF8
}

New-Item -ItemType Directory -Force "$InstallDir\logs" | Out-Null

# Applica config sede se specificata
if ($ConfigFile -and (Test-Path $ConfigFile)) {
    Copy-Item $ConfigFile "$InstallDir\backend\config.json" -Force
    Write-Host "  Config sede: $ConfigFile" -ForegroundColor DarkGray
} elseif (-not (Test-Path "$InstallDir\backend\config.json")) {
    Copy-Item "$InstallDir\backend\config.example.json" "$InstallDir\backend\config.json" -Force
    Write-Host "  Nessun config trovato - copiato config.example.json. Configurare dall'UI." -ForegroundColor Yellow
}
Write-Host " OK" -ForegroundColor Green

# -- 3. pip install -----------------------------------------------------------
Write-Host "[3/6] Installazione dipendenze Python..." -NoNewline
& python -m pip install -r "$InstallDir\backend\requirements.txt" --quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host " ERRORE" -ForegroundColor Red
    Write-Error "pip install fallito. Controlla la connessione internet."
    exit 1
}
# pywin32 richiede post-install per registrare le DLL di sistema
$pyScripts = & python -c "import sys, os; print(os.path.join(sys.prefix, 'Scripts'))" 2>$null
$postInstall = Join-Path $pyScripts "pywin32_postinstall.py"
if (Test-Path $postInstall) {
    & python $postInstall -install 2>$null | Out-Null
}
Write-Host " OK" -ForegroundColor Green

# -- 4. Servizio Windows (NSSM) -----------------------------------------------
Write-Host "[4/6] Configurazione servizio Windows..." -NoNewline
$nssm = "$InstallDir\tools\nssm.exe"
if (-not (Test-Path $nssm)) {
    Write-Host " ERRORE" -ForegroundColor Red
    Write-Error "nssm.exe non trovato in $InstallDir\tools\"
    exit 1
}

& $nssm install $ServiceName python "$InstallDir\backend\app.py"
& $nssm set $ServiceName AppDirectory    "$InstallDir\backend"
& $nssm set $ServiceName Start           SERVICE_AUTO_START
& $nssm set $ServiceName AppRestartDelay 5000
& $nssm set $ServiceName AppStdout       "$InstallDir\logs\stdout.log"
& $nssm set $ServiceName AppStderr       "$InstallDir\logs\stderr.log"
& $nssm set $ServiceName DisplayName     "PcMonitor"
& $nssm set $ServiceName Description     "Monitoraggio PC in rete locale - lucasjbx/pc-monitor"
Write-Host " OK" -ForegroundColor Green

# -- 5. Regola Firewall -------------------------------------------------------
Write-Host "[5/6] Regola Windows Firewall (porta $Port)..." -NoNewline
$ruleName = "PcMonitor porta $Port"
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction   Inbound `
    -Protocol    TCP `
    -LocalPort   $Port `
    -Action      Allow `
    -Profile     "Domain,Private" | Out-Null
Write-Host " OK" -ForegroundColor Green

# -- 6. Avvia e verifica ------------------------------------------------------
Write-Host "[6/6] Avvio servizio..." -NoNewline
Start-Service $ServiceName
# Aspetta fino a 15 secondi che il servizio sia Running
$deadline = (Get-Date).AddSeconds(15)
do {
    Start-Sleep 2
    $svc = Get-Service $ServiceName
} while ($svc.Status -ne "Running" -and (Get-Date) -lt $deadline)
$svc = Get-Service $ServiceName
if ($svc.Status -eq "Running") {
    Write-Host " OK" -ForegroundColor Green
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "  PcMonitor installato e in esecuzione!" -ForegroundColor Green
    Write-Host "  Accesso: http://$(hostname):$Port"     -ForegroundColor Yellow
    Write-Host "  Log:     $InstallDir\logs\"            -ForegroundColor Gray
    Write-Host "==========================================" -ForegroundColor Cyan
} else {
    Write-Host " ERRORE (status: $($svc.Status))" -ForegroundColor Red
    Write-Host "Controlla i log: $InstallDir\logs\stderr.log" -ForegroundColor Yellow
    exit 1
}
