# deploy.ps1 — copy frontend + daemon source to the RDP host via Posh-SSH.
# Skips backend/, node_modules/, bin/, and .git/.
#
# Re-runnable: tars locally, uploads once, extracts on the remote in
# place over C:\Users\Administrator\Documents\vidsync.

param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$RemoteHost = "51.38.25.226"
$RemoteUser = "root"
$RemotePass = "9jL5tBNoI1e7"
# This OpenSSH-on-Windows server's SFTP root is a virtual "/" that
# exposes drives as "/C:", "/D:", … so the proper SFTP path needs the
# leading slash. The cmd-style path is reserved for SSH commands
# further down.
$RemoteRootSftp = "/C:/Users/Administrator/Documents/vidsync"
$RemoteRoot = "C:\Users\Administrator\Documents\vidsync"

$RepoRoot = $PSScriptRoot
Set-Location $RepoRoot

if (-not $SkipBuild) {
  Write-Host "[1/4] Building frontend..." -ForegroundColor Cyan
  Push-Location frontend
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "[1/4] Skipping build (using existing dist)" -ForegroundColor DarkGray
}

Write-Host "[2/4] Packing bundle..." -ForegroundColor Cyan
$Bundle = "deploy-bundle.tar.gz"
if (Test-Path $Bundle) { Remove-Item $Bundle -Force }

# Daemon source dirs + frontend (without node_modules). Backend is
# deliberately omitted per the user's deploy scope.
$paths = @(
  "frontend",
  "cmd","lib","internal","proto","gui","assets","etc",
  "build.go","build.ps1","go.mod","go.sum"
)
# .env.local is per-machine (different VITE_API_KEY for each daemon,
# different VITE_CLOUD_API_URL depending on whether the cloud backend
# is reachable directly or via localhost). Excluding it prevents
# clobbering the remote's keys with the local ones.
& tar.exe `
  --exclude="frontend/node_modules" `
  --exclude="frontend/.env.local" `
  --exclude="frontend/.env.development.local" `
  --exclude="frontend/.env.production.local" `
  --exclude=".git" `
  -czf $Bundle @paths
if ($LASTEXITCODE -ne 0) { throw "tar failed" }
$bundleSize = (Get-Item $Bundle).Length / 1MB
Write-Host ("    bundle: {0:N1} MB" -f $bundleSize) -ForegroundColor DarkGray

Import-Module Posh-SSH
$secure = ConvertTo-SecureString $RemotePass -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential($RemoteUser, $secure)

Write-Host "[3/4] Ensuring remote directory + uploading bundle..." -ForegroundColor Cyan
$sftp = New-SFTPSession -ComputerName $RemoteHost -Credential $cred -AcceptKey -Force
try {
  if (-not (Test-SFTPPath -SessionId $sftp.SessionId -Path $RemoteRootSftp)) {
    Write-Host "    creating $RemoteRootSftp" -ForegroundColor DarkGray
    New-SFTPItem -SessionId $sftp.SessionId -Path $RemoteRootSftp -ItemType Directory | Out-Null
  }
  Set-SFTPItem -SessionId $sftp.SessionId -Path (Resolve-Path $Bundle).Path -Destination $RemoteRootSftp -Force
} finally {
  Remove-SFTPSession -SessionId $sftp.SessionId | Out-Null
}

Write-Host "[4/4] Extracting on remote..." -ForegroundColor Cyan
$ssh = New-SSHSession -ComputerName $RemoteHost -Credential $cred -AcceptKey -Force
try {
  $extractCmd = "cd /D `"$RemoteRoot`" && tar.exe -xzf `"$Bundle`" && del `"$Bundle`""
  $result = Invoke-SSHCommand -SessionId $ssh.SessionId -Command $extractCmd
  if ($result.ExitStatus -ne 0) {
    Write-Host "    Remote extract reported exit $($result.ExitStatus)" -ForegroundColor Yellow
    Write-Host $result.Output
    Write-Host $result.Error
  }
} finally {
  Remove-SSHSession -SessionId $ssh.SessionId | Out-Null
}

Remove-Item $Bundle -Force
Write-Host "Deploy complete." -ForegroundColor Green
