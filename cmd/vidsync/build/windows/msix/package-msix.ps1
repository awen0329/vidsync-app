# package-msix.ps1 — package the built vidsync.exe (+ ffmpeg/braw helpers)
# into an MSIX for Microsoft Store submission.
#
# Prereq: run build-release.ps1 first so cmd\vidsync\build\bin\vidsync.exe
# exists at the right version. Then run this. Requires the Windows 10/11 SDK
# (provides makeappx.exe; signtool.exe only if you -SelfSign for local
# sideload testing). Store submission does NOT need your own cert — Microsoft
# re-signs the package — but the .msix must be signed by *something* to be
# installable locally for smoke-testing, hence the optional -SelfSign.
#
# Usage:
#   .\package-msix.ps1                       # build the .msix
#   .\package-msix.ps1 -SelfSign             # also sign with a throwaway cert + install locally
#   .\package-msix.ps1 -Version 0.0.1.0      # override the 4-part package version
[CmdletBinding()]
param(
  [string]$Version,            # 4-part MSIX version a.b.c.d; default derived from wails.json
  [switch]$SelfSign
)
$ErrorActionPreference = "Stop"

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path     # ...\build\windows\msix
$appDir = (Resolve-Path (Join-Path $here "..\..\..")).Path    # cmd\vidsync
$repo   = (Resolve-Path (Join-Path $appDir "..\..")).Path     # repo root
$binExe = Join-Path $appDir "build\bin\vidsync.exe"
$icon   = Join-Path $appDir "build\appicon.png"

if (-not (Test-Path $binExe)) { throw "vidsync.exe not found at $binExe — run build-release.ps1 first." }

# --- Derive the 4-part MSIX version from wails.json (x.y.z -> x.y.z.0) ------
if (-not $Version) {
  $wj = Get-Content (Join-Path $appDir "wails.json") -Raw
  if ($wj -match '"productVersion"\s*:\s*"([^"]+)"') { $Version = "$($Matches[1]).0" }
  else { throw "Could not read productVersion from wails.json; pass -Version explicitly." }
}
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "MSIX -Version must be 4-part numeric (a.b.c.d), got '$Version'." }
Write-Host "MSIX version: $Version" -ForegroundColor Cyan

# --- Locate makeappx (latest Windows SDK) -----------------------------------
$sdkRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
$makeappx = Get-ChildItem -Path $sdkRoot -Recurse -Filter makeappx.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) {
  throw "makeappx.exe not found under $sdkRoot. Install the Windows 10/11 SDK " +
        "(component 'Windows SDK Signing Tools' / 'MSIX Packaging Tools'), then re-run."
}
Write-Host "makeappx: $($makeappx.FullName)" -ForegroundColor DarkGray

# --- Stage the package layout -----------------------------------------------
$layout = Join-Path $here "layout"
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
$assets = Join-Path $layout "Assets"
New-Item -ItemType Directory -Force -Path $assets | Out-Null

Copy-Item $binExe (Join-Path $layout "vidsync.exe")

# Helper binaries (same sources build-release.ps1 zips). Optional: thumbnails
# degrade to a glyph if absent.
$ffSrc = Join-Path $repo "third_party\ffmpeg\windows\ffmpeg.exe"
if (Test-Path $ffSrc) { Copy-Item $ffSrc (Join-Path $layout "ffmpeg.exe"); Write-Host "  + ffmpeg.exe" -ForegroundColor DarkGray }
else { Write-Host "  ! ffmpeg.exe missing — video thumbnails unavailable" -ForegroundColor Yellow }
$brawSrc = Join-Path $repo "third_party\braw\win"
if (Test-Path (Join-Path $brawSrc "braw-thumb.exe")) {
  New-Item -ItemType Directory -Force (Join-Path $layout "braw") | Out-Null
  Copy-Item (Join-Path $brawSrc "*") (Join-Path $layout "braw") -Force
  Write-Host "  + braw-thumb + SDK" -ForegroundColor DarkGray
} else { Write-Host "  ! braw-thumb missing — .braw thumbnails unavailable" -ForegroundColor Yellow }

# --- Generate Store logo assets from the 1024px icon ------------------------
# High-quality bicubic downscale; wide tile centers the square icon on a
# transparent canvas. These filenames match AppxManifest.xml.
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($icon)
function Save-Logo([int]$w, [int]$h, [string]$name) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  # Fit the icon as a centered square (handles both square and wide tiles).
  $side = [Math]::Min($w, $h); $x = [int](($w - $side) / 2); $y = [int](($h - $side) / 2)
  $g.DrawImage($src, $x, $y, $side, $side)
  $bmp.Save((Join-Path $assets $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
Save-Logo 44  44  "Square44x44Logo.png"
Save-Logo 71  71  "Square71x71Logo.png"
Save-Logo 150 150 "Square150x150Logo.png"
Save-Logo 310 310 "Square310x310Logo.png"
Save-Logo 310 150 "Wide310x150Logo.png"
Save-Logo 50  50  "StoreLogo.png"
$src.Dispose()
Write-Host "  + 6 logo assets" -ForegroundColor DarkGray

# --- Manifest with the version stamped in -----------------------------------
$manifest = (Get-Content (Join-Path $here "AppxManifest.xml") -Raw) -replace 'Version="0\.0\.1\.0"', "Version=`"$Version`""
[System.IO.File]::WriteAllText((Join-Path $layout "AppxManifest.xml"), $manifest, (New-Object System.Text.UTF8Encoding($false)))

# --- Pack -------------------------------------------------------------------
$dist = Join-Path $repo "dist"; New-Item -ItemType Directory -Force $dist | Out-Null
$msix = Join-Path $dist "Vidsync-$Version.msix"
if (Test-Path $msix) { Remove-Item $msix -Force }
& $makeappx.FullName pack /o /d $layout /p $msix
if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed (exit $LASTEXITCODE)" }
Write-Host "`nMSIX ready: $msix" -ForegroundColor Green

if ($SelfSign) {
  Write-Host "`n=== Self-signing for LOCAL sideload testing only ===" -ForegroundColor Cyan
  Write-Host "(Store submissions are signed by Microsoft — do NOT ship a self-signed package.)" -ForegroundColor DarkGray
  $signtool = Get-ChildItem -Path $sdkRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $signtool) { throw "signtool.exe not found; install the SDK signing tools." }
  # The cert subject MUST equal the manifest Publisher. Read it back out.
  if ($manifest -match 'Publisher="([^"]+)"') { $publisher = $Matches[1] } else { throw "no Publisher in manifest" }
  $cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -KeyUsage DigitalSignature `
            -FriendlyName "Vidsync MSIX test" -CertStoreLocation "Cert:\CurrentUser\My" `
            -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
  $pfx = Join-Path $here "vidsync-test.pfx"
  $pw = ConvertTo-SecureString -String "vidsync" -Force -AsPlainText
  Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath $pfx -Password $pw | Out-Null
  & $signtool.FullName sign /fd SHA256 /a /f $pfx /p "vidsync" $msix
  if ($LASTEXITCODE -ne 0) { throw "signtool sign failed (exit $LASTEXITCODE)" }
  Write-Host "Signed with throwaway cert. To install locally, trust the cert then: Add-AppxPackage '$msix'" -ForegroundColor Green
}
