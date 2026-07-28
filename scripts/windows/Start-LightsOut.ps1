# Start LightsOut on Windows with Docker Desktop (SU-02).
# Nothing else is needed: no repository, no shell, no files to edit.
#
#   powershell -ExecutionPolicy Bypass -File Start-LightsOut.ps1
#
# Parameters let a maintainer point at a local build instead of the published image.
param(
  [string]$Image = $env:LO_IMAGE,
  [int]$Port = 8484,
  [string]$Workspace = $env:LIGHTSOUT_WORKSPACE,
  [switch]$Recreate
)

$ErrorActionPreference = "Stop"
# The published multi-arch image (SU-01). Set LO_IMAGE, or pass -Image lightsout:local, to run
# a build made on this machine instead.
if (-not $Image) { $Image = "ghcr.io/filipeagg/lightsout:latest" }
$container = "lightsout"

# RT-02: the workspace is a folder on this machine, so projects open in the user's own editor.
if (-not $Workspace) { $Workspace = Join-Path $env:USERPROFILE "Documents\LightsOut" }
$Workspace = [System.IO.Path]::GetFullPath($Workspace)
if (-not (Test-Path $Workspace)) {
  New-Item -ItemType Directory -Path $Workspace -Force | Out-Null
  Write-Host "Created workspace folder: $Workspace" -ForegroundColor Cyan
}

function Find-Docker {
  $candidates = @(
    "docker",
    "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
    "${env:ProgramFiles(x86)}\Docker\Docker\resources\bin\docker.exe"
  )
  foreach ($candidate in $candidates) {
    $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Source }
  }
  return $null
}

$docker = Find-Docker
if (-not $docker) {
  Write-Host "Docker Desktop is not installed." -ForegroundColor Red
  Write-Host "Install it and run this script again:" -ForegroundColor Yellow
  Write-Host "  winget install Docker.DockerDesktop"
  exit 1
}

# Docker Desktop may be installed but not started yet.
& $docker info --format "{{.ServerVersion}}" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Starting Docker Desktop..." -ForegroundColor Yellow
  $exe = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (Test-Path $exe) { Start-Process $exe }
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    & $docker info --format "{{.ServerVersion}}" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker Desktop did not become ready. Open it once by hand and retry." -ForegroundColor Red
    exit 1
  }
}

$running = (& $docker ps --filter "name=^/$container$" --format "{{.Names}}")
if ($running -eq $container -and -not $Recreate) {
  Write-Host "LightsOut is already running." -ForegroundColor Green
} else {
  if (& $docker ps -a --filter "name=^/$container$" --format "{{.Names}}") {
    & $docker rm -f $container | Out-Null
  }

  if ($Image -notlike "*:local") {
    Write-Host "Downloading $Image ..." -ForegroundColor Cyan
    & $docker pull $Image
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Could not download the image. Check your internet connection." -ForegroundColor Red
      exit 1
    }
  }

  Write-Host "Starting LightsOut..." -ForegroundColor Cyan
  & $docker run -d --name $container --restart unless-stopped `
    -p "127.0.0.1:${Port}:8484" `
    -p "127.0.0.1:1455:1455" `
    -v lightsout-db:/data `
    -v "${Workspace}:/workspace" `
    -v claude-auth:/home/app/.claude `
    -v codex-auth:/home/app/.codex `
    -e LO_WORKSPACE_MODE=host `
    $Image | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host "The container did not start." -ForegroundColor Red; exit 1 }
}

Write-Host "Waiting for LightsOut to answer..." -ForegroundColor Cyan
$health = $null
for ($i = 0; $i -lt 45; $i++) {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3
    break
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $health) {
  Write-Host "No answer on http://127.0.0.1:$Port/health" -ForegroundColor Red
  & $docker logs --tail 30 $container
  exit 1
}

$claude = $health.engines | Where-Object { $_.engine -eq "claude" }
$codex = $health.engines | Where-Object { $_.engine -eq "codex" }
Write-Host ""
Write-Host "LightsOut is running: http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "  Workspace: $Workspace"
Write-Host ("  Claude: " + $(if ($claude.auth) { "connected" } else { "NOT connected" }))
Write-Host ("  Codex:  " + $(if ($codex.auth) { "connected" } else { "NOT connected" }))
if (-not ($claude.auth -and $codex.auth)) {
  Write-Host ""
  Write-Host "Connect the engines from the setup page, or run:" -ForegroundColor Yellow
  Write-Host "  .\Connect-Engine.ps1 claude"
  Write-Host "  .\Connect-Engine.ps1 codex"
}

# First run opens the wizard instead of the panel (SU-03): nothing is set up yet, so the panel
# would have nothing to show.
$landing = "http://127.0.0.1:$Port"
try {
  $setup = Invoke-RestMethod "$landing/api/setup/state" -TimeoutSec 5
  $ready = $setup.workspace.confirmedAt -and $setup.projects.Count -gt 0 -and
           ($setup.engines | Where-Object { $_.auth }).Count -gt 0
  if (-not $ready) { $landing = "$landing/setup.html" }
} catch { $landing = "$landing/setup.html" }
Start-Process $landing
