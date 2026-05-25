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

# Ferma e RIMUOVE il servizio prima di toccare i file
$existing = Get-Service $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Set-Service  $ServiceName -StartupType Disabled -ErrorAction SilentlyContinue  # Blocca auto-restart
    Stop-Service $ServiceName -Force    -ErrorAction SilentlyContinue
    Start-Sleep 2
    $nssmExe = "$InstallDir\tools\nssm.exe"
    if (Test-Path $nssmExe) {
        $ErrorActionPreference = "SilentlyContinue"
        & $nssmExe remove $ServiceName confirm 2>$null
        $ErrorActionPreference = "Stop"
    } else {
        sc.exe delete $ServiceName 2>$null | Out-Null  # Fallback se nssm.exe non esiste
    }
    Start-Sleep 2
}
# Termina qualsiasi processo Python o NSSM rimasto attivo
Stop-Process -Name python -Force -ErrorAction SilentlyContinue
Stop-Process -Name nssm   -Force -ErrorAction SilentlyContinue
Start-Sleep 2

# Preserva config.json e positions.json (testo) e piantina.png (binario) se esistono gia.
# ATTENZIONE: Get-Content / Set-Content in PS 5.1 aggiunge BOM ai testi e corrompe i binari.
# Si usa quindi [System.IO.File] con encoding esplicito UTF-8 senza BOM per i testi,
# e ReadAllBytes / WriteAllBytes per i file binari.
$preserveText   = @("backend\config.json", "backend\positions.json")
$preserveBinary = @("piantina.png")
$savedText      = @{}
$savedBinary    = @{}
foreach ($f in $preserveText) {
    $fp = Join-Path $InstallDir $f
    if (Test-Path $fp) { $savedText[$f] = [System.IO.File]::ReadAllText($fp) }
}
foreach ($f in $preserveBinary) {
    $fp = Join-Path $InstallDir $f
    if (Test-Path $fp) { $savedBinary[$f] = [System.IO.File]::ReadAllBytes($fp) }
}

# Rinomina la vecchia directory invece di sovrascriverla.
# Rename richiede solo accesso al parent (C:\), non ai file dentro —
# nessun problema di permessi anche se i file sono di SYSTEM.
if (Test-Path $InstallDir) {
    $backup = "${InstallDir}_old"
    Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue
    Rename-Item $InstallDir $backup -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Item -Path "$SourceDir\*" -Destination $InstallDir -Recurse -Force

# Elimina il backup in background (potrebbe fallire se file ancora aperti, non critico)
if (Test-Path "${InstallDir}_old") {
    Start-Job -ScriptBlock { param($p) Start-Sleep 5; Remove-Item $p -Recurse -Force -EA SilentlyContinue } `
              -ArgumentList "${InstallDir}_old" | Out-Null
}

# Ripristina file preservati (senza BOM per i testi, byte-per-byte per i binari)
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
foreach ($f in $savedText.Keys) {
    $fp = Join-Path $InstallDir $f
    [System.IO.File]::WriteAllText($fp, $savedText[$f], $utf8NoBom)
}
foreach ($f in $savedBinary.Keys) {
    $fp = Join-Path $InstallDir $f
    [System.IO.File]::WriteAllBytes($fp, $savedBinary[$f])
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
