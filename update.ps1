#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Aggiorna PcMonitor fermando il servizio, copiando i nuovi file e riavviando.
    Alternativa manuale all'aggiornamento dall'UI.
    Eseguire dalla cartella con i nuovi file.
#>
param(
    [string]$InstallDir  = "C:\PcMonitor",
    [string]$ServiceName = "PcMonitor",
    [string]$SourceDir   = $PSScriptRoot
)

$preserveFiles = @("backend\config.json", "backend\positions.json", "piantina.png")

Write-Host "=== Aggiornamento PcMonitor ===" -ForegroundColor Cyan

# Backup file da preservare
$preserved = @{}
foreach ($f in $preserveFiles) {
    $fullPath = Join-Path $InstallDir $f
    if (Test-Path $fullPath) {
        $preserved[$f] = Get-Content $fullPath -Raw
    }
}

Write-Host "Fermo il servizio..." -NoNewline
Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
Start-Sleep 2
Write-Host " OK" -ForegroundColor Green

Write-Host "Copia nuovi file..." -NoNewline
Copy-Item -Path "$SourceDir\*" -Destination $InstallDir -Recurse -Force
Write-Host " OK" -ForegroundColor Green

# Ripristina file preservati
foreach ($f in $preserved.Keys) {
    $fullPath = Join-Path $InstallDir $f
    Set-Content $fullPath $preserved[$f] -Encoding UTF8
}

Write-Host "Avvio servizio..." -NoNewline
Start-Service $ServiceName
Start-Sleep 3
$svc = Get-Service $ServiceName
if ($svc.Status -eq "Running") {
    Write-Host " OK" -ForegroundColor Green
    $version = Get-Content "$InstallDir\version.txt" -ErrorAction SilentlyContinue
    Write-Host "Aggiornamento completato — versione $version" -ForegroundColor Green
} else {
    Write-Host " ERRORE" -ForegroundColor Red
    Write-Host "Controlla: $InstallDir\logs\stderr.log"
}
