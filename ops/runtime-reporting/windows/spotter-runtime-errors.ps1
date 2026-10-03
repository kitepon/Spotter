$ErrorActionPreference = 'Stop'
$spotter = Join-Path $env:APPDATA 'npm\spotter.cmd'
& $spotter runtime-errors report
exit $LASTEXITCODE
