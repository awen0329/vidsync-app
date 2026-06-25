# build.ps1 - build braw-thumb.exe (the Blackmagic RAW thumbnail helper) and
# stage it with its runtime DLLs under third_party/braw/win/.
#
# The desktop app shells out to braw-thumb to decode the first frame of a
# .braw clip (ffmpeg can't - it has no Blackmagic RAW decoder). See
# lib/api/thumb.go. The helper loads the SDK DLLs from next to itself, so we
# ship it + the DLLs together in a braw/ subdir beside vidsync.exe.
#
# Prerequisites (both are unzipped, not installed - see third_party/braw/README.md):
#   -BlackmagicRawSDK : the "Blackmagic RAW SDK\Win" folder (Include + Libraries),
#                       from the Blackmagic RAW Windows installer.
#   -W64Devkit        : a w64devkit folder (provides g++ and widl).
#
# Usage:
#   .\tools\braw-thumb\build.ps1 `
#       -BlackmagicRawSDK "C:\path\to\Blackmagic RAW SDK\Win" `
#       -W64Devkit        "C:\path\to\w64devkit"

[CmdletBinding()]
param(
  [string]$BlackmagicRawSDK,
  [string]$W64Devkit,
  [string]$SystemDlls   # optional: dir with MSVC runtime DLLs (msvcp140.dll, vcruntime140*.dll, ...)
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..\..")

if (-not $BlackmagicRawSDK -or -not (Test-Path $BlackmagicRawSDK)) {
  throw "Pass -BlackmagicRawSDK pointing at the SDK's 'Win' folder (with Include\ and Libraries\). See third_party\braw\README.md"
}
if (-not $W64Devkit -or -not (Test-Path (Join-Path $W64Devkit "bin\g++.exe"))) {
  throw "Pass -W64Devkit pointing at a w64devkit folder (must contain bin\g++.exe and bin\widl.exe)."
}

$gpp  = Join-Path $W64Devkit "bin\g++.exe"
$widl = Join-Path $W64Devkit "bin\widl.exe"
$idlInc = Join-Path $W64Devkit "include"
$sdkInc = Join-Path $BlackmagicRawSDK "Include"
$sdkLib = Join-Path $BlackmagicRawSDK "Libraries"

# Work in a temp dir so we don't pollute the source tree with generated files.
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("braw-thumb-build-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $work | Out-Null
try {
  Copy-Item (Join-Path $sdkInc "BlackmagicRawAPI.idl") $work -Force
  Copy-Item (Join-Path $sdkInc "BlackmagicRawAPIDispatch.h") $work -Force
  Copy-Item (Join-Path $sdkInc "BlackmagicRawAPIDispatch.cpp") $work -Force
  Copy-Item (Join-Path $here "braw-thumb.cpp") $work -Force

  # widl (unlike MSVC midl) needs the OLE base imports explicit and doesn't
  # accept "(unsigned) long long" - normalise the IDL to its 'hyper' type.
  $idl = Join-Path $work "BlackmagicRawAPI.idl"
  $txt = Get-Content $idl -Raw
  $txt = $txt -replace 'import "unknwn.idl";', "import `"oaidl.idl`";`r`nimport `"ocidl.idl`";"
  $txt = $txt -replace 'unsigned long long', 'unsigned hyper'
  $txt = $txt -replace '(?<!unsigned )long long', 'hyper'
  Set-Content $idl $txt -Encoding ASCII

  Write-Host "Generating BlackmagicRawAPI.h via widl..." -ForegroundColor Cyan
  & $widl -I"$idlInc" -h -o (Join-Path $work "BlackmagicRawAPI.h") $idl
  if ($LASTEXITCODE -ne 0) { throw "widl failed ($LASTEXITCODE)" }

  Write-Host "Compiling braw-thumb.exe via g++..." -ForegroundColor Cyan
  Push-Location $work
  try {
    & $gpp -O2 -s -o "braw-thumb.exe" "braw-thumb.cpp" "BlackmagicRawAPIDispatch.cpp" -loleaut32 -lole32
    if ($LASTEXITCODE -ne 0) { throw "g++ failed ($LASTEXITCODE)" }
  } finally { Pop-Location }

  # Stage exe + SDK runtime DLLs (+ optional MSVC runtime) under third_party.
  $out = Join-Path $repo "third_party\braw\win"
  New-Item -ItemType Directory -Force $out | Out-Null
  Get-ChildItem $out -Filter *.dll | Remove-Item -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $work "braw-thumb.exe") $out -Force
  Copy-Item (Join-Path $sdkLib "*.dll") $out -Force
  if ($SystemDlls -and (Test-Path $SystemDlls)) {
    Get-ChildItem $SystemDlls -Filter *.dll | ForEach-Object { Copy-Item $_.FullName $out -Force }
  }

  Write-Host "`nStaged braw-thumb to $out" -ForegroundColor Green
  Get-ChildItem $out | Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize
}
finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
