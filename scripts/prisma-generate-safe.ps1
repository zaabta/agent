$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

try {
  $nodeProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
} catch {
  Write-Host 'Cannot inspect local Node command lines. Stop this workspace API/worker manually, then rerun npm run prisma:generate.'
  exit 2
}

$lockCandidates = @($nodeProcesses | Where-Object {
  $_.CommandLine -and
  $_.CommandLine.IndexOf($workspace, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine -match '(src[\\/]main\.ts|src[\\/]document-worker\.ts|tsx.*watch)'
})

if ($lockCandidates.Count -gt 0) {
  Write-Host 'Prisma generation cannot replace query_engine-windows.dll while this workspace API/worker is running:'
  $lockCandidates | ForEach-Object { Write-Host ("PID {0}" -f $_.ProcessId) }
  Write-Host 'Stop the API/worker in its owning terminal, then rerun npm run prisma:generate.'
  exit 1
}

& npm exec -- prisma generate
exit $LASTEXITCODE
