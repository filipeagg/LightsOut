# Pack the Claude Desktop extension (SU-09).
#
#   .\Build-Extension.ps1            -> dist/lightsout.mcpb
#
# An .mcpb is a zip with manifest.json at the root and the stdio server beside it. Entry names
# must use forward slashes: Compress-Archive writes backslashes on Windows PowerShell and the
# loader then does not find the files.
param(
  [string]$Source = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) "extension"),
  [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) "dist")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $Source "manifest.json"))) {
  Write-Host "No manifest.json in $Source" -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$target = Join-Path $OutDir "lightsout.mcpb"
Remove-Item $target -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$files = Get-ChildItem $Source -Recurse -File
$stream = [IO.File]::Open($target, [IO.FileMode]::Create)
$zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $files) {
    $name = $file.FullName.Substring($Source.Length).TrimStart('\', '/').Replace('\', '/')
    $entry = $zip.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
    $writer = New-Object IO.StreamWriter($entry.Open())
    $writer.Write([IO.File]::ReadAllText($file.FullName))
    $writer.Flush()
    $writer.Dispose()
    Write-Host "  added $name"
  }
} finally {
  $zip.Dispose()
  $stream.Dispose()
}

$manifest = Get-Content (Join-Path $Source "manifest.json") -Raw | ConvertFrom-Json
Write-Host ""
Write-Host "Built $target" -ForegroundColor Green
Write-Host "  $($manifest.display_name) $($manifest.version), $($manifest.tools.Count) tools"
Write-Host "Install it by double-clicking the file, or from Claude Desktop:"
Write-Host "  Settings > Extensions > Advanced settings > Install Extension..."
