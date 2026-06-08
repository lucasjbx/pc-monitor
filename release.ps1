<#
.SYNOPSIS
    Crea una nuova release di PcMonitor.
    Aggiorna version.txt, committa, pusha e crea la release su GitHub.

    Uso: .\release.ps1 1.1.0 "Descrizione delle modifiche"
#>
param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$Notes
)

$tag = "v$Version"

# Verifica che gh sia disponibile
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "ERRORE: GitHub CLI (gh) non trovato." -ForegroundColor Red
    exit 1
}

# Aggiorna version.txt
[System.IO.File]::WriteAllText("$PSScriptRoot\version.txt", "$Version`n")
Write-Host "version.txt aggiornato a $Version" -ForegroundColor Green

# Commit e push
git -C $PSScriptRoot add version.txt
git -C $PSScriptRoot commit -m "chore: release $tag"
git -C $PSScriptRoot push origin main

# Crea release su GitHub
gh release create $tag --title $tag --notes $Notes --repo lucasjbx/pc-monitor
Write-Host ""
Write-Host "Release $tag pubblicata!" -ForegroundColor Cyan
Write-Host "Le sedi attive vedranno la notifica di aggiornamento entro 1 ora." -ForegroundColor Yellow
