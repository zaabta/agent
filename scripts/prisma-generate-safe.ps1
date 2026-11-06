$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

try {
  $nodeProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
} catch {
  Write-Error 'Cannot inspect local Node command lines. Stop this workspace API/worker manually, then run pnpm prisma:generate.'
  exit 2
}

$lockCandidates = @($nodeProcesses | Where-Object {
  $_.CommandLine -and
  $_.CommandLine.IndexOf($workspace, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine -match '(src[\\/]main\.ts|src[\\/]document-worker\.ts|tsx.*watch)'
})

if ($lockCandidates.Count -gt 0) {
  Write-Host 'Prisma generation may fail because these SitePilot processes can hold query_engine-windows.dll:'
  $lockCandidates | ForEach-Object { Write-Host ("PID {0}: {1}" -f $_.ProcessId, $_.CommandLine) }
  Write-Host 'Stop only the listed SitePilot process(es) in their owning terminal, then rerun pnpm prisma:generate:safe.'
  exit 1
}

& pnpm exec prisma generate
exit $LASTEXITCODE
