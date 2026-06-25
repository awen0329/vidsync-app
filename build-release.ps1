# build-release.ps1 - one-shot release build of the Vidsync desktop app.
#
# The Syncthing daemon now runs in-process (cmd/vidsync/inprocess.go),
# linked into vidsync.exe — so the old "build syncthing.exe, embed it,
# clear the extract cache" steps are gone. The pipeline is now:
#   1. Run `wails build` (with a Version ldflag for lib/build) to
#      produce the single-file vidsync.exe at cmd\vidsync\build\bin\.
#   2. Package the .exe into dist\vidsync-<version>.zip alongside a brief
#      README. Chrome's Safe Browsing blocks direct .exe downloads from
#      unsigned publishers; serving the .zip sidesteps that until we
#      have a code-signing cert.
#
# Usage:
#   .\build-release.ps1                  # default version v0.0.1-vidsync
#   .\build-release.ps1 -Version v0.2.0  # explicit version
#   .\build-release.ps1 -SkipZip         # skip the zip if iterating quickly

[CmdletBinding()]
param(
  [string]$Version = "v0.0.1",
  [switch]$SkipZip
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- Single-source version management -------------------------------------
# One -Version input drives BOTH version surfaces, which must stay in lock-step:
#   1. lib/build.Version  — the in-process Syncthing daemon's version string,
#      injected via ldflag. It MUST carry a leading "v" and match
#      lib/build.allowedVersionExp or the daemon log.Fatalf's at launch.
#   2. wails.json info.productVersion — the plain semver baked into the .exe
#      resource, the NSIS installer, and the macOS Info.plist / About box.
#      Store tooling (MSIX, the App Store) wants a clean numeric x.y.z here.
# We derive (2) from (1) by stripping the leading "v" and any pre-release/build
# suffix, then patch wails.json in place so the two never drift. When the
# derived value already matches what's committed, the file is left untouched
# (no spurious git diff); a real bump rewrites it for you to commit.
if ($Version -notmatch '^v\d+\.\d+\.\d+') {
  throw "Version '$Version' must start with a 'vMAJOR.MINOR.PATCH' core (e.g. v0.0.1) so the daemon's version regex accepts it."
}
$semVer = ($Version -replace '^v', '') -replace '[-+].*$', ''   # v0.0.1-beta.2 -> 0.0.1
$wailsJsonPath = Join-Path $repo "cmd\vidsync\wails.json"
$wailsJsonRaw = Get-Content $wailsJsonPath -Raw
$patched = $wailsJsonRaw -replace '("productVersion"\s*:\s*")[^"]*(")', "`${1}$semVer`${2}"
if ($patched -ne $wailsJsonRaw) {
  # UTF-8 *without* BOM: Go's encoding/json (used by `wails build` to read
  # this file) chokes on a leading BOM, and PS 5.1's `Set-Content -Encoding
  # utf8` always emits one — so go through .NET with a no-BOM encoder.
  [System.IO.File]::WriteAllText($wailsJsonPath, $patched, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Synced wails.json productVersion -> $semVer (from $Version)" -ForegroundColor Yellow
} else {
  Write-Host "wails.json productVersion already $semVer" -ForegroundColor DarkGray
}
# --------------------------------------------------------------------------

# Locate Go: the local install isn't on PATH in the default shell, so
# resolve it explicitly. Falls back to PATH if installed elsewhere.
$goExe = "$env:LOCALAPPDATA\Programs\Go\bin\go.exe"
if (-not (Test-Path $goExe)) {
  $cmd = Get-Command go -ErrorAction SilentlyContinue
  if ($cmd) { $goExe = $cmd.Source } else {
    throw "go.exe not found on PATH or at $env:LOCALAPPDATA\Programs\Go\bin\"
  }
}

$wailsExe = "$env:USERPROFILE\go\bin\wails.exe"
if (-not (Test-Path $wailsExe)) {
  $cmd = Get-Command wails -ErrorAction SilentlyContinue
  if ($cmd) { $wailsExe = $cmd.Source } else {
    throw "wails.exe not found at $env:USERPROFILE\go\bin\ or on PATH (install: go install github.com/wailsapp/wails/v2/cmd/wails@latest)"
  }
}

# Wails shells out to `go build` internally and looks up "go" on PATH;
# our $goExe is a full-path fallback that doesn't help that lookup.
# Prepend the Go bin dir so the wails subprocess can find it.
$goBin = Split-Path -Parent $goExe
if (";$env:Path;" -notlike "*;$goBin;*") {
  $env:Path = "$goBin;$env:Path"
}

# Stop a running vidsync so wails build can overwrite build\bin\vidsync.exe
# (Windows blocks Remove-Item on a running .exe; the rest of the build
# silently fails downstream if it can't clear the previous artifact).
$running = Get-Process vidsync -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "Stopping running vidsync (PID=$($running.Id))..." -ForegroundColor Yellow
  Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue
  Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

Write-Host "=== Step 1/2: wails build (in-process daemon) ===" -ForegroundColor Cyan
# The Syncthing daemon now runs in-process (see cmd/vidsync/inprocess.go),
# linked into vidsync.exe via the lib/syncthing import — there's no
# separate daemon binary to build, embed, or stage anymore.
#
# Because the daemon's lib/build.init() runs inside vidsync.exe, we set
# its Version via ldflags. Leaving it unset is safe (it defaults to
# "unknown-dev", which init() skips) but an explicit version keeps the
# About box and any version-gated behaviour honest. The string must
# match lib/build.allowedVersionExp or init() will log.Fatalf at launch.
$ldflags = "-X github.com/CrownLedger/vidsync/lib/build.Version=$Version"
Push-Location (Join-Path $repo "cmd\vidsync")
try {
  Remove-Item "build\bin\vidsync.exe" -Force -ErrorAction SilentlyContinue
  # Wails writes ANSI-colorized progress to stderr; under
  # $ErrorActionPreference=Stop those writes look like errors and
  # abort the script. Redirect stderr to stdout so PowerShell treats
  # the whole thing as plain output and only $LASTEXITCODE matters.
  & $wailsExe build -ldflags $ldflags 2>&1 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { throw "wails build failed (exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

$out = Join-Path $repo "cmd\vidsync\build\bin\vidsync.exe"
$info = Get-Item $out
Write-Host ""
Write-Host "Release build OK." -ForegroundColor Green
Write-Host ("  Path: {0}" -f $out)
Write-Host ("  Size: {0:N0} bytes ({1:N1} MB)" -f $info.Length, ($info.Length / 1MB))
Write-Host ("  Version: {0}" -f $Version)

if ($SkipZip) {
  Write-Host ""
  Write-Host "Skipped Step 2 (zip) - pass without -SkipZip to package for distribution." -ForegroundColor DarkGray
  return
}

Write-Host ""
Write-Host "=== Step 2/2: packaging dist zip ===" -ForegroundColor Cyan

# Stage the .exe + a brief README in a temp dir, zip the dir, drop the
# archive under dist\. We use a staging dir so the zip's top-level
# layout is predictable (just the two files, no enclosing folder).
$distDir = Join-Path $repo "dist"
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

$zipName = "vidsync-$Version-windows-amd64.zip"
$zipPath = Join-Path $distDir $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("vidsync-zip-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item $out (Join-Path $stage "vidsync.exe")

# Bundle ffmpeg.exe next to vidsync.exe. The app shells out to it for
# thumbnails (lib/api/thumb.go) and finds it next to the running exe, so
# unzipping keeps them together. The binary is git-ignored and staged by
# hand under third_party/ffmpeg (see that dir's README.md to refresh it).
$ffSrc = Join-Path $repo "third_party\ffmpeg\windows\ffmpeg.exe"
if (-not (Test-Path $ffSrc)) {
  throw "ffmpeg.exe not found at $ffSrc - thumbnails won't work in the release. " +
        "Stage it per third_party\ffmpeg\README.md, or pass -SkipZip to build without it."
}
Copy-Item $ffSrc (Join-Path $stage "ffmpeg.exe")
# GPL build: ship its license alongside.
$ffLic = Join-Path $repo "third_party\ffmpeg\windows\LICENSE"
if (Test-Path $ffLic) { Copy-Item $ffLic (Join-Path $stage "ffmpeg-LICENSE.txt") }
Write-Host ("  Bundled ffmpeg.exe ({0:N1} MB)" -f ((Get-Item $ffSrc).Length / 1MB)) -ForegroundColor DarkGray

# Bundle the Blackmagic RAW thumbnailer (braw-thumb.exe + SDK runtime DLLs)
# into a braw/ subdir next to vidsync.exe. The app loads it from there for
# .braw thumbnails (lib/api/thumb.go). Optional: if it isn't staged, we just
# skip it and .braw files fall back to the glyph. Staged per
# third_party/braw/README.md.
$brawSrc = Join-Path $repo "third_party\braw\win"
if (Test-Path (Join-Path $brawSrc "braw-thumb.exe")) {
  $brawDst = Join-Path $stage "braw"
  New-Item -ItemType Directory -Force $brawDst | Out-Null
  Copy-Item (Join-Path $brawSrc "*") $brawDst -Force
  $brawMB = (Get-ChildItem $brawDst | Measure-Object Length -Sum).Sum / 1MB
  Write-Host ("  Bundled braw-thumb + SDK runtime ({0:N1} MB)" -f $brawMB) -ForegroundColor DarkGray
} else {
  Write-Host "  braw-thumb not staged - .braw thumbnails will be unavailable (see third_party\braw\README.md)" -ForegroundColor Yellow
}

# Bundle a short README so the recipient knows what to expect from
# SmartScreen on first launch - without it the "Windows protected
# your PC" dialog reads like a virus warning and people back out.
# Built as a string array to avoid PowerShell 5.1 here-string + nested
# try/finally parser quirks.
$readmeLines = @(
  "Vidsync $Version",
  "",
  "1. Unzip this archive and run vidsync.exe.",
  "2. On first launch Windows will show 'Windows protected your PC'.",
  "   This is because the build is not yet code-signed. To continue:",
  "     - Click 'More info'",
  "     - Click 'Run anyway'",
  "3. Vidsync runs in the background; look for the icon in the system",
  "   tray (bottom-right of the taskbar). Click it to show the window.",
  "   Use the tray menu to Quit - closing the window just hides it.",
  "",
  "Logs live at %TEMP%\vidsync.log if something goes wrong."
)
Set-Content -Path (Join-Path $stage "README.txt") -Value $readmeLines -Encoding utf8

# Compress-Archive's -Path with a directory creates the directory as
# the zip root; we want the files at the root instead, so glob the
# contents.
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal

# Best-effort cleanup; not a failure if it sticks around.
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

$zipInfo = Get-Item $zipPath
Write-Host ""
Write-Host "Zip ready for distribution." -ForegroundColor Green
Write-Host ("  Path: {0}" -f $zipPath)
Write-Host ("  Size: {0:N0} bytes ({1:N1} MB)" -f $zipInfo.Length, ($zipInfo.Length / 1MB))
