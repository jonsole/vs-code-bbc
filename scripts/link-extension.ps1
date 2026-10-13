# Install this checkout into VS Code as a junction, so VS Code runs the
# extension straight from here: edits take effect on a window reload
# (Developer: Reload Window), with no packaging. Nothing needs building and
# there is nothing to npm install: the server's only dependency, jsbeeb, is
# vendored with what it needs.
#
#   .\scripts\link-extension.ps1              # VS Code
#   .\scripts\link-extension.ps1 -Insiders    # VS Code Insiders
#   .\scripts\link-extension.ps1 -Remove      # take it out again
#
# Restart VS Code afterwards. A junction needs no administrator rights.

param(
    [switch]$Insiders,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$id = "$($package.publisher).$($package.name)"
$extensions = Join-Path $env:USERPROFILE $(if ($Insiders) { '.vscode-insiders\extensions' } else { '.vscode\extensions' })
New-Item -ItemType Directory -Force -Path $extensions | Out-Null

# Any earlier copy or link of this extension, whatever its version, would be loaded instead of (or beside) this one.
foreach ($old in Get-ChildItem -Path $extensions -Directory -Filter "$id-*" -ErrorAction SilentlyContinue) {
    if ($old.LinkType -eq 'Junction' -or $old.LinkType -eq 'SymbolicLink') {
        # Remove the link only, never what it points at.
        [System.IO.Directory]::Delete($old.FullName)
    } else {
        Remove-Item -Recurse -Force $old.FullName
    }
    Write-Host "Removed $($old.FullName)"
}

if ($Remove) {
    Write-Host "Restart VS Code to finish removing $id."
    return
}

$dest = Join-Path $extensions "$id-$($package.version)"
New-Item -ItemType Junction -Path $dest -Target $root | Out-Null
Write-Host "Linked $dest -> $root"
Write-Host "Restart VS Code. 'BBC Micro: Show Screen' in the Command Palette shows it is there."
