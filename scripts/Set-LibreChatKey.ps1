param([Parameter(Mandatory=$true)][string]$LibreChatPath)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$bridgeEnv = Join-Path $root ".env"
$target = Join-Path (Resolve-Path $LibreChatPath).Path ".env"
if (!(Test-Path $bridgeEnv) -or !(Test-Path $target)) { throw "Both bridge and LibreChat .env files must exist." }
$keyLine = Get-Content $bridgeEnv | Where-Object { $_ -match '^BRIDGE_API_KEY=' } | Select-Object -First 1
if (!$keyLine) { throw "Missing BRIDGE_API_KEY." }
$key = ($keyLine -split '=', 2)[1].Trim()
if ($key -notmatch '^[a-fA-F0-9]{64}$') { throw "Expected the generated 64-character hex key." }
# Private backup lives outside the tracked templates. No secrets printed.
$backupDir = Join-Path $root "runtime\backups"
New-Item -ItemType Directory -Force $backupDir | Out-Null
Copy-Item $target (Join-Path $backupDir ("librechat.env." + (Get-Date -Format 'yyyyMMdd-HHmmss-ffff') + ".bak"))
$content = [IO.File]::ReadAllText($target)
$line = "CLAUDE_BRIDGE_KEY=$key"
if ($content -match '(?m)^CLAUDE_BRIDGE_KEY=') {
  $content = [regex]::Replace($content, '(?m)^CLAUDE_BRIDGE_KEY=[^\r\n]*', $line)
} else { $content = $content.TrimEnd("`r", "`n") + "`r`n" + $line + "`r`n" }
[IO.File]::WriteAllText($target, $content, (New-Object Text.UTF8Encoding($false)))
Write-Host "Updated LibreChat .env; previous file backed up privately. Recreate the api container after merging the YAML changes."
