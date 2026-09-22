# Manually apply a Folder OTA zip onto an existing PhotoBooth Folder install.
# Use when in-app Install quit but left the old build (or to bootstrap a fixed updater).
#
# Usage:
#   .\scripts\apply-booth-zip.ps1 -ZipPath "..\builds\PhotoBooth-Folder-1.1.2-....zip" -InstallRoot "D:\PhotoBooth"
#
param(
  [Parameter(Mandatory = $true)][string]$ZipPath,
  [Parameter(Mandatory = $true)][string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
$zip = (Resolve-Path $ZipPath).Path
$root = (Resolve-Path $InstallRoot).Path
$preserve = @('config', 'capture', 'data', 'logs', 'updates')

if (-not (Test-Path -LiteralPath (Join-Path $root 'ZYN-Photobooth.exe'))) {
  throw "InstallRoot does not look like a Folder build (missing ZYN-Photobooth.exe): $root"
}

Get-Process -Name 'ZYN-Photobooth','edsdk-bridge' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$stage = Join-Path $env:TEMP ("pb-manual-update-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  Write-Host "Expanding $zip ..."
  Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
  $payload = $stage
  if (-not (Test-Path (Join-Path $payload 'ZYN-Photobooth.exe'))) {
    $nested = Get-ChildItem -LiteralPath $stage -Directory | Where-Object {
      Test-Path (Join-Path $_.FullName 'ZYN-Photobooth.exe')
    } | Select-Object -First 1
    if ($nested) { $payload = $nested.FullName }
  }
  if (-not (Test-Path (Join-Path $payload 'ZYN-Photobooth.exe'))) {
    throw 'Zip does not contain ZYN-Photobooth.exe'
  }

  $exe = Join-Path $root 'ZYN-Photobooth.exe'
  if (Test-Path $exe) {
    Move-Item -LiteralPath $exe -Destination ($exe + '.bak') -Force -ErrorAction SilentlyContinue
  }

  Get-ChildItem -LiteralPath $payload -Force | ForEach-Object {
    if ($preserve -contains $_.Name) { return }
    $dest = Join-Path $root $_.Name
    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
      & robocopy $_.FullName $dest /E /IS /IT /R:5 /W:1 /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
      if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $($_.Name) code=$LASTEXITCODE" }
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    }
  }

  $ver = Get-Content (Join-Path $root 'version.json') -Raw | ConvertFrom-Json
  Write-Host "Applied v$($ver.version) build=$($ver.buildId)"
  Remove-Item -LiteralPath ($exe + '.bak') -Force -ErrorAction SilentlyContinue
  Write-Host "Starting ZYN Photobooth..."
  Start-Process -FilePath (Join-Path $root 'ZYN-Photobooth.exe') -WorkingDirectory $root
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
