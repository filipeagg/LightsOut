# Connect an engine (RT-04, SU-04). Runs the login inside the running container; the OAuth
# callback reaches it through the published 1455 port and the internal forwarder.
#
#   .\Connect-Engine.ps1 claude
#   .\Connect-Engine.ps1 codex
#   .\Connect-Engine.ps1 codex -ApiKey        (paste an API key instead of the browser flow)
param(
  [Parameter(Mandatory = $true)][ValidateSet("claude", "codex")][string]$Engine,
  [switch]$ApiKey,
  [switch]$Console,
  [switch]$Token
)

$ErrorActionPreference = "Stop"
$container = "lightsout"

function Find-Docker {
  foreach ($candidate in @("docker", "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe")) {
    $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Source }
  }
  return $null
}

$docker = Find-Docker
if (-not $docker) { Write-Host "Docker Desktop is not installed." -ForegroundColor Red; exit 1 }
if (-not (& $docker ps --filter "name=^/$container$" --format "{{.Names}}")) {
  Write-Host "LightsOut is not running. Run Start-LightsOut.ps1 first." -ForegroundColor Red
  exit 1
}

$mode = ""
if ($ApiKey) { $mode = "--api-key" }
elseif ($Console) { $mode = "--console" }
elseif ($Token) { $mode = "--token" }

Write-Host "Starting the $Engine login inside the container." -ForegroundColor Cyan
Write-Host "A URL will appear: open it, approve, and come back here." -ForegroundColor Cyan
Write-Host ""

if ($mode -eq "--api-key") {
  $secure = Read-Host "Paste the API key" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  $plain | & $docker exec -i $container node dist/cli/login.js $Engine --api-key
} else {
  & $docker exec -it $container node dist/cli/login.js $Engine $mode
}

Write-Host ""
try {
  $health = Invoke-RestMethod "http://127.0.0.1:8484/health" -TimeoutSec 5
  $state = $health.engines | Where-Object { $_.engine -eq $Engine }
  if ($state.auth) {
    Write-Host "$Engine is connected ($($state.authSource))." -ForegroundColor Green
  } else {
    Write-Host "$Engine is still not connected. Try again, or use -ApiKey." -ForegroundColor Yellow
  }
} catch {
  Write-Host "Could not read /health to confirm." -ForegroundColor Yellow
}
