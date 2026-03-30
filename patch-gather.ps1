# patch-gather.ps1 — Patch GatherV2 shortcuts to always expose CDP on localhost:9222
# Run once after install, and again after each Gather update.
#
# Usage (PowerShell):
#   .\patch-gather.ps1

$ErrorActionPreference = "Stop"

$exePath = "$env:LOCALAPPDATA\Programs\GatherV2\GatherV2.exe"
$cdpArg  = "--remote-debugging-port=9222"

if (-not (Test-Path $exePath)) {
    Write-Error "GatherV2.exe not found at:`n  $exePath`nIs GatherV2 installed?"
    exit 1
}

$shell = New-Object -ComObject WScript.Shell

# Common shortcut locations (user-level install; covers Start Menu and Desktop)
$candidates = @(
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\GatherV2.lnk",
    "$env:USERPROFILE\Desktop\GatherV2.lnk",
    "$env:PUBLIC\Desktop\GatherV2.lnk"
)

$patched = 0
foreach ($lnkPath in $candidates) {
    if (-not (Test-Path $lnkPath)) { continue }

    $lnk = $shell.CreateShortcut($lnkPath)

    if ($lnk.Arguments -like "*$cdpArg*") {
        Write-Host "Already patched: $lnkPath"
    } else {
        $lnk.Arguments = ("$cdpArg " + $lnk.Arguments).Trim()
        $lnk.Save()
        Write-Host "Patched: $lnkPath"
    }
    $patched++
}

if ($patched -eq 0) {
    Write-Warning "No GatherV2 shortcuts found. Searched:"
    $candidates | ForEach-Object { Write-Warning "  $_" }
    Write-Warning ""
    Write-Warning "You can still use Option 1 (launch with the flag directly) as a fallback."
    exit 1
}

Write-Host ""
Write-Host "Done. GatherV2 will now expose CDP on localhost:9222 on every launch."
Write-Host "Re-run this script after each Gather update."
