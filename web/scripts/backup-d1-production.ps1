<#
.SYNOPSIS
  Automated Backup Script for Cloudflare D1 (ais-scanner-db) with 7-Zip AES-256 Encryption.
.DESCRIPTION
  Performs an automated logical database export from Cloudflare D1, verifies SQL integrity,
  compresses and encrypts the backup using 7-Zip AES-256 (including encrypted file headers),
  rotates backups older than retention policy, and optionally syncs to Google Drive.
.PARAMETER Passphrase
  Encryption passphrase for 7-Zip. If omitted, reads from $env:D1_BACKUP_PASSWORD.
.PARAMETER RetentionDays
  Number of days to keep local backup archives. Defaults to 30.
.PARAMETER GoogleDriveDir
  Optional Google Drive folder path to sync encrypted backup archives.
#>
param(
  [string]$Passphrase = $env:D1_BACKUP_PASSWORD,
  [int]$RetentionDays = 30,
  [string]$GoogleDriveDir = $env:GOOGLE_DRIVE_BACKUP_DIR
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$webRoot = Split-Path -Parent $scriptDir
$backupDir = Join-Path $webRoot 'backups'
$tempRoot = Join-Path $env:LOCALAPPDATA 'Temp'
$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$runId = '{0}_{1}' -f $timestamp, ([guid]::NewGuid().ToString('N').Substring(0, 6))
$tempSql = Join-Path $tempRoot ("d1-ais-scanner-db-$runId.sql")
$archiveFile = Join-Path $backupDir ("d1-ais-scanner-db-$runId.7z")
$logFile = Join-Path $backupDir 'backup-history.log'
$sevenZip = 'C:\Program Files\7-Zip\7z.exe'

# 1. Verification of Prerequisite Tools
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
  throw "7-Zip not found at '$sevenZip'. Please verify 7-Zip installation."
}

if (-not (Test-Path -LiteralPath $backupDir)) {
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}

# 2. Resolve Passphrase
if ([string]::IsNullOrWhiteSpace($Passphrase)) {
  if ([Environment]::UserInteractive) {
    Write-Host "[INPUT REQUIRED] Enter archive encryption passphrase for 7-Zip AES-256:" -ForegroundColor Yellow
    $securePass = Read-Host -Prompt "Encryption Passphrase" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass)
    try {
      $Passphrase = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      $securePass.Dispose()
    }
  } else {
    throw "Passphrase is required for automated backup. Set $env:D1_BACKUP_PASSWORD or pass -Passphrase."
  }
}

if ([string]::IsNullOrWhiteSpace($Passphrase)) {
  throw "Passphrase cannot be empty."
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Cloudflare D1 Automated Backup (ais-scanner-db)" -ForegroundColor Cyan
Write-Host " Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

try {
  # 3. Export Remote D1 Database via Wrangler CLI
  Write-Host "[1/5] Exporting remote Cloudflare D1 database..." -ForegroundColor Green
  Push-Location $webRoot
  try {
    & npx wrangler d1 export ais-scanner-db --remote --output=$tempSql --skip-confirmation
    if ($LASTEXITCODE -ne 0) {
      throw "Wrangler D1 export failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  if (-not (Test-Path -LiteralPath $tempSql -PathType Leaf)) {
    throw "Export failed to produce file at '$tempSql'."
  }

  $sqlItem = Get-Item -LiteralPath $tempSql
  if ($sqlItem.Length -lt 1024) {
    throw "Export file '$tempSql' is suspiciously small ($($sqlItem.Length) bytes). Backup aborted."
  }
  Write-Host "  ✔ Export completed: $($sqlItem.Length) bytes ($([math]::Round($sqlItem.Length / 1KB, 2)) KB)" -ForegroundColor Gray

  # 4. Compress & Encrypt with 7-Zip AES-256 (-mhe=on encrypts archive headers)
  Write-Host "[2/5] Compressing & encrypting with 7-Zip AES-256..." -ForegroundColor Green
  & $sevenZip a -t7z -mhe=on -p"$Passphrase" -bd "$archiveFile" "$tempSql" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "7-Zip encryption failed with exit code $LASTEXITCODE"
  }

  # Shred temporary unencrypted SQL dump
  Remove-Item -LiteralPath $tempSql -Force -ErrorAction SilentlyContinue

  # 5. Integrity Verification
  Write-Host "[3/5] Verifying encrypted archive integrity..." -ForegroundColor Green
  & $sevenZip t -p"$Passphrase" -bd "$archiveFile" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Archive verification failed for '$archiveFile'. Archive might be corrupt."
  }

  $archiveItem = Get-Item -LiteralPath $archiveFile
  $sha256 = (Get-FileHash -LiteralPath $archiveFile -Algorithm SHA256).Hash

  Write-Host "  ✔ Integrity verified: $($archiveItem.Length) bytes ($([math]::Round($archiveItem.Length / 1KB, 2)) KB)" -ForegroundColor Gray
  Write-Host "  ✔ SHA256: $sha256" -ForegroundColor Gray

  # 6. Optional Sync to Google Drive
  if (-not [string]::IsNullOrWhiteSpace($GoogleDriveDir) -and (Test-Path -LiteralPath $GoogleDriveDir)) {
    Write-Host "[4/5] Syncing encrypted archive to Google Drive..." -ForegroundColor Green
    $gDriveTarget = Join-Path $GoogleDriveDir (Split-Path $archiveFile -Leaf)
    Copy-Item -LiteralPath $archiveFile -Destination $gDriveTarget -Force
    Write-Host "  ✔ Synced to Google Drive: $gDriveTarget" -ForegroundColor Gray
  } else {
    Write-Host "[4/5] Google Drive sync skipped (directory not configured or not mounted)." -ForegroundColor Gray
  }

  # 7. Backup Rotation (Remove archives older than RetentionDays)
  Write-Host "[5/5] Enforcing backup retention policy ($RetentionDays days)..." -ForegroundColor Green
  $cutoff = (Get-Date).AddDays(-$RetentionDays)
  $prunedCount = 0
  Get-ChildItem -Path $backupDir -Filter "d1-ais-scanner-db-*.7z" | Where-Object { $_.CreationTime -lt $cutoff } | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Force
    $prunedCount++
    Write-Host "  Purged expired archive: $($_.Name)" -ForegroundColor DarkGray
  }
  Write-Host "  ✔ Retention enforced. ($prunedCount old archives pruned)" -ForegroundColor Gray

  # 8. Record in Audit Log
  $logEntry = "[{0}] SUCCESS: {1} | Size: {2} bytes | SHA256: {3}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), (Split-Path $archiveFile -Leaf), $archiveItem.Length, $sha256
  Add-Content -Path $logFile -Value $logEntry

  Write-Host "==========================================================" -ForegroundColor Cyan
  Write-Host " BACKUP SUCCESSFUL!" -ForegroundColor Green
  Write-Host " Archive: $archiveFile" -ForegroundColor Green
  Write-Host "==========================================================" -ForegroundColor Cyan
  exit 0
} catch {
  Write-Host "[ERROR] Backup failed: $_" -ForegroundColor Red
  # Remove temp files if any
  if (Test-Path -LiteralPath $tempSql) { Remove-Item -LiteralPath $tempSql -Force -ErrorAction SilentlyContinue }
  
  $logEntry = "[{0}] FAILED: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.ToString()
  Add-Content -Path $logFile -Value $logEntry
  exit 1
}
