#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installa PcMonitor scaricando l'ultima release da GitHub.
    Eseguire come Administrator su AD04:

    irm https://raw.githubusercontent.com/lucasjbx/pc-monitor/main/bootstrap.ps1 | iex
#>

$repo = "lucasjbx/pc-monitor"
$tmp  = "$env:TEMP\pc-monitor-install"

Write-Host "=== PcMonitor Bootstrap ===" -ForegroundColor Cyan
Write-Host "Scarico l'ultima release da GitHub..."

try {
    $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
} catch {
    Write-Error "Impossibile contattare GitHub. Verifica la connessione internet."
    exit 1
}

$version = $release.tag_name
Write-Host "Versione: $version"

# Pulizia cartella temp precedente
Remove-Item $tmp      -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$tmp.zip"          -Force -ErrorAction SilentlyContinue

# Download zip
Write-Host "Download in corso..."
Invoke-WebRequest $release.zipball_url -OutFile "$tmp.zip"

# Estrazione
Write-Host "Estrazione..."
Expand-Archive "$tmp.zip" -DestinationPath $tmp -Force

# Trova install.ps1 nella cartella estratta
$installScript = Get-ChildItem $tmp -Recurse -Filter "install.ps1" | Select-Object -First 1
if (-not $installScript) {
    Write-Error "install.ps1 non trovato nella release. Release corrotta?"
    exit 1
}

Write-Host "Avvio installazione..."
& $installScript.FullName -SourceDir $installScript.DirectoryName

# Pulizia
Remove-Item $tmp      -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$tmp.zip"          -Force -ErrorAction SilentlyContinue
