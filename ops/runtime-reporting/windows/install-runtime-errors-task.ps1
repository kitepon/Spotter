$ErrorActionPreference = 'Stop'
$ops = Split-Path -Parent $MyInvocation.MyCommand.Path
$powershell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1)

$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ops\spotter-runtime-errors.ps1`""
Register-ScheduledTask -TaskName 'spotter-runtime-errors' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Send pending Spotter runtime errors to owner-LAN BugHub hourly' -Force | Out-Null

Start-ScheduledTask -TaskName 'spotter-runtime-errors'
