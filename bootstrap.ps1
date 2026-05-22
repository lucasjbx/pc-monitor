<#
.SYNOPSIS
    Installa PcMonitor scaricando l'ultima release da GitHub.
    Eseguire come Administrator su AD04:

    irm https://raw.githubusercontent.com/lucasjbx/pc-monitor/main/bootstrap.ps1 | iex
#>

# Verifica Admin (manuale - #Requires non funziona con iex)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "ERRORE: eseguire PowerShell come Administrator." -ForegroundColor Red
    Write-Host "Tasto destro su PowerShell -> 'Esegui come amministratore'" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Premi Invio per chiudere"
    exit 1
}

$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest altrimenti e' lentissimo

$repo = "lucasjbx/pc-monitor"
$tmp  = "$env:TEMP\pc-monitor-install"

Write-Host ""
Write-Host "=== PcMonitor Bootstrap ===" -ForegroundColor Cyan

# -- Python --------------------------------------------------------------------
Write-Host "[0/6] Verifica Python..." -NoNewline
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host " non trovato, installazione in corso..." -ForegroundColor Yellow
    $pyUrl = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe"
    $pyInstaller = "$env:TEMP\python-installer.exe"
    try {
        Invoke-WebRequest $pyUrl -OutFile $pyInstaller
    } catch {
        Write-Host "ERRORE download Python: $_" -ForegroundColor Red
        Read-Host "Premi Invio per chiudere"
        exit 1
    }
    Write-Host "  Installazione Python (silente)..." -ForegroundColor DarkGray
    $proc = Start-Process $pyInstaller -ArgumentList "/quiet InstallAllUsers=1 PrependPath=1 Include_test=0" -Wait -PassThru
    Remove-Item $pyInstaller -Force -ErrorAction SilentlyContinue
    if ($proc.ExitCode -ne 0) {
        Write-Host "ERRORE: installazione Python fallita (exit code $($proc.ExitCode))." -ForegroundColor Red
        Read-Host "Premi Invio per chiudere"
        exit 1
    }
    # Aggiorna PATH per la sessione corrente
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) {
        Write-Host "ERRORE: python.exe non trovato dopo installazione." -ForegroundColor Red
        Read-Host "Premi Invio per chiudere"
        exit 1
    }
    $pyVer = & python --version 2>&1
    Write-Host "  Python installato: $pyVer" -ForegroundColor Green
} else {
    $pyVer = & python --version 2>&1
    Write-Host " OK ($pyVer)" -ForegroundColor Green
}

# -- Download release ----------------------------------------------------------
Write-Host "Scarico l'ultima release da GitHub..."

try {
    $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
} catch {
    Write-Host "ERRORE: impossibile contattare GitHub. Verifica la connessione internet." -ForegroundColor Red
    Read-Host "Premi Invio per chiudere"
    exit 1
}

$version = $release.tag_name
Write-Host "Versione: $version"

# Pulizia cartella temp precedente
Remove-Item $tmp       -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$tmp.zip"           -Force -ErrorAction SilentlyContinue

# Download zip
Write-Host "Download in corso..."
try {
    Invoke-WebRequest $release.zipball_url -OutFile "$tmp.zip"
} catch {
    Write-Host "ERRORE durante il download: $_" -ForegroundColor Red
    Read-Host "Premi Invio per chiudere"
    exit 1
}

# Estrazione
Write-Host "Estrazione..."
Expand-Archive "$tmp.zip" -DestinationPath $tmp -Force

# Trova install.ps1 nella cartella estratta
$installScript = Get-ChildItem $tmp -Recurse -Filter "install.ps1" | Select-Object -First 1
if (-not $installScript) {
    Write-Host "ERRORE: install.ps1 non trovato nella release." -ForegroundColor Red
    Read-Host "Premi Invio per chiudere"
    exit 1
}

Write-Host "Avvio installazione..."
& $installScript.FullName -SourceDir $installScript.DirectoryName

# Pulizia
Remove-Item $tmp       -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$tmp.zip"           -Force -ErrorAction SilentlyContinue

Read-Host "Premi Invio per chiudere"
