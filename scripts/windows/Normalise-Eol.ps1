# Bring the index and the working tree into line with .gitattributes (2026-07-27).
#
# Run once, after adding .gitattributes. Two separate problems it fixes:
#   - a file committed with CRLF in the *index* (`git ls-files --eol` shows `i/crlf`), which no
#     amount of attribute setting corrects on its own;
#   - files sitting on disk with CRLF that the attributes say should be LF. Harmless for .ts, fatal
#     for a shell script, which fails in the container with `bad interpreter: /bin/bash^M`.
#
# It refuses to run on a dirty tree, and it proves the content did not change: the SHA-256 of every
# tracked file with its line endings normalised is taken before and after and compared. A
# line-ending pass that alters a byte of content is not a line-ending pass.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\Normalise-Eol.ps1

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

if (git status --porcelain) {
    Write-Error 'The tree is not clean. Commit or stash first: this rewrites every tracked file.'
    exit 1
}

function Get-ContentFingerprint {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $acc = [System.Text.StringBuilder]::new()
    foreach ($file in (git ls-files)) {
        if (-not (Test-Path -LiteralPath $file)) { continue }
        $bytes = [System.IO.File]::ReadAllBytes($file)
        # Drop every CR so CRLF and LF hash the same; this is the only thing allowed to differ.
        $noCr = $bytes | Where-Object { $_ -ne 13 }
        $hash = $sha.ComputeHash([byte[]]$noCr)
        [void]$acc.AppendLine("$file $([System.BitConverter]::ToString($hash))")
    }
    return $acc.ToString()
}

Write-Output 'Fingerprinting the content before...'
$before = Get-ContentFingerprint

git add --renormalize .
$staged = git diff --cached --name-only
if ($staged) {
    Write-Output ''
    Write-Output 'Index corrected for:'
    $staged | ForEach-Object { Write-Output "  $_" }
} else {
    Write-Output 'Index was already normalised.'
}

# Rewrite the working tree from the index, which applies eol=lf on checkout.
git rm --cached -r -q .
git reset --hard -q

Write-Output ''
Write-Output 'Fingerprinting the content after...'
$after = Get-ContentFingerprint

if ($before -eq $after) {
    Write-Output 'Content is byte-identical ignoring CR. Only line endings changed.'
} else {
    Write-Error 'CONTENT CHANGED. Do not commit this; inspect with git diff.'
    exit 1
}

Write-Output ''
Write-Output '--- files still holding CRLF that should not ---'
$bad = git ls-files --eol | Select-String 'w/crlf' | Where-Object { $_ -notmatch '\.(ps1|bat|cmd)$' }
if ($bad) { $bad } else { Write-Output '(none)' }

Write-Output ''
Write-Output '--- status ---'
git status --short
