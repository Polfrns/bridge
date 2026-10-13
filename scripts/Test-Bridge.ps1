param([string]$Model = "gpt-codex")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$envPath = Join-Path $root ".env"
if (!(Test-Path $envPath)) { throw "Run npm run setup first." }
$keyLine = Get-Content $envPath | Where-Object { $_ -match '^BRIDGE_API_KEY=' } | Select-Object -First 1
if (!$keyLine) { throw "Missing BRIDGE_API_KEY." }
$key = ($keyLine -split '=', 2)[1].Trim()
$headers = @{ Authorization = "Bearer $key" }
$payload = @{ model = $Model; stream = $false; messages = @(@{role="user"; content="Responde solamente OK"}) } | ConvertTo-Json -Depth 6
$result = Invoke-RestMethod -Uri "http://127.0.0.1:4000/v1/chat/completions" -Method Post -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 200
$result.choices[0].message.content
