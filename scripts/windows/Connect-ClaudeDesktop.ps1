# Register LightsOut as an MCP server in Claude Desktop (MC-01, SU-09).
#
# Claude Desktop rewrites claude_desktop_config.json with its own preferences when it exits, so
# editing that file while the app is running silently loses the change. This script waits for the
# app to close, patches the file, keeps a .bak, and offers to start it again.
#
#   .\Connect-ClaudeDesktop.ps1
param(
  [string]$ConfigPath = "$env:APPDATA\Claude\claude_desktop_config.json",
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

function Find-Docker {
  foreach ($candidate in @("docker", "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe")) {
    $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Source }
  }
  return $null
}

$docker = Find-Docker
if (-not $docker) { Write-Host "Docker Desktop is not installed." -ForegroundColor Red; exit 1 }

if (Get-Process claude -ErrorAction SilentlyContinue) {
  Write-Host "Close Claude Desktop completely, including the tray icon." -ForegroundColor Yellow
  Write-Host "Waiting..." -NoNewline
  while (Get-Process claude -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 2
    Write-Host "." -NoNewline
  }
  Write-Host ""
  Start-Sleep -Seconds 2   # let it finish writing its own file
}

if (-not (Test-Path $ConfigPath)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $ConfigPath) | Out-Null
  "{}" | Set-Content $ConfigPath -Encoding UTF8
}

Copy-Item $ConfigPath "$ConfigPath.bak" -Force
$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json

$server = @{
  command = $docker
  args    = @("exec", "-i", "lightsout", "node", "dist/mcp/stdio-bridge.js")
}

if ($config.PSObject.Properties.Name -contains "mcpServers") {
  $config.mcpServers | Add-Member -NotePropertyName "lightsout" -NotePropertyValue $server -Force
} else {
  $config | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue @{ lightsout = $server } -Force
}

$config | ConvertTo-Json -Depth 20 | Set-Content $ConfigPath -Encoding UTF8
Write-Host "Claude Desktop is configured (backup at $ConfigPath.bak)." -ForegroundColor Green

if (-not $NoRestart) {
  $exe = Get-ChildItem "$env:LOCALAPPDATA\AnthropicClaude" -Filter "claude.exe" -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($exe) {
    Start-Process $exe.FullName
    Write-Host "Claude Desktop is starting. Ask it: use the health tool of lightsout" -ForegroundColor Cyan
  } else {
    Write-Host "Open Claude Desktop and ask: use the health tool of lightsout" -ForegroundColor Cyan
  }
}
