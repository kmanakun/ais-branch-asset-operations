<#
.SYNOPSIS
  Registers a Windows Scheduled Task to run the Cloudflare D1 backup script daily at midnight.
.DESCRIPTION
  Creates or updates a scheduled task named 'AIS-Scanner-Daily-Backup' that executes
  backup-d1-production.ps1 every day at 00:00 (Midnight).
.PARAMETER Time
  Time to execute daily (HH:mm). Default is '00:00'.
.PARAMETER GoogleDriveDir
  Optional path to Google Drive backup directory.
#>
param(
  [string]$Time = '00:00',
  [string]$GoogleDriveDir = ""
)

$taskName = "AIS-Scanner-D1-Daily-Backup"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backupScript = Join-Path $scriptDir "backup-d1-production.ps1"

if (-not (Test-Path -LiteralPath $backupScript)) {
  throw "Backup script not found at '$backupScript'."
}

Write-Host "Registering Windows Scheduled Task: $taskName..." -ForegroundColor Cyan

$actionArgs = "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$backupScript`""
if (-not [string]::IsNullOrWhiteSpace($GoogleDriveDir)) {
  $actionArgs += " -GoogleDriveDir `"$GoogleDriveDir`""
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Daily encrypted backup of Cloudflare D1 (ais-scanner-db) with 7-Zip AES-256" -Force | Out-Null
  Write-Host "✔ Scheduled Task '$taskName' registered successfully!" -ForegroundColor Green
  Write-Host "  Trigger: Daily at $Time" -ForegroundColor Gray
  Write-Host "  Target Script: $backupScript" -ForegroundColor Gray
  Write-Host "  To run manually: Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor Gray
  Write-Host "  To view in Task Scheduler: taskschd.msc" -ForegroundColor Gray
} catch {
  Write-Host "[WARNING] Could not register scheduled task (Run PowerShell as Administrator if permission denied): $_" -ForegroundColor Yellow
}
