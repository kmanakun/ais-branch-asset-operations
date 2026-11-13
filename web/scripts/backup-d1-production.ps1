<#
.SYNOPSIS
  Automated Backup Script for Cloudflare D1 (ais-scanner-db) + R2 Evidence (ais-scanner-evidence) with 7-Zip AES-256 Encryption.
.DESCRIPTION
  Performs a logical database export from Cloudflare D1, exports R2 evidence objects + manifest,
  compresses and encrypts everything using 7-Zip AES-256 (including encrypted headers),
  verifies archive integrity, rotates old archives, and optionally copies to an external sync folder.
.PARAMETER Passphrase
  Encryption passphrase for 7-Zip. If omitted, reads from $env:D1_BACKUP_PASSWORD.
.PARAMETER RetentionDays
  Number of days to keep local backup archives. Defaults to 30.
.PARAMETER GoogleDriveDir
  Optional external cloud-sync folder path (Google Drive / OneDrive) to copy encrypted backup archives.
.PARAMETER SkipR2
  Skip R2 binary evidence download and back up D1 logical SQL only.
#>
param(
  [string]$Passphrase = $env:D1_BACKUP_PASSWORD,
  [int]$RetentionDays = 30,
  [string]$GoogleDriveDir = $env:GOOGLE_DRIVE_BACKUP_DIR,
  [switch]$SkipR2
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$webRoot = Split-Path -Parent $scriptDir
$wranglerBin = Join-Path $webRoot 'node_modules\wrangler\bin\wrangler.js'
$r2Script = Join-Path $scriptDir 'backup-r2-evidence.mjs'
$backupDir = Join-Path $webRoot 'backups'
$tempRoot = Join-Path $env:LOCALAPPDATA 'Temp'
$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$runId = '{0}_{1}' -f $timestamp, ([guid]::NewGuid().ToString('N').Substring(0, 6))
$stageDir = Join-Path $tempRoot ("ais-cf-backup-$runId")
$tempSql = Join-Path $stageDir ("d1-ais-scanner-db-$runId.sql")
$tempR2Dir = Join-Path $stageDir 'r2-evidence'
$archiveFile = Join-Path $backupDir ("d1-ais-scanner-db-$runId.7z")
$logFile = Join-Path $backupDir 'backup-history.log'
$sevenZip = 'C:\Program Files\7-Zip\7z.exe'
$previousNodeOptions = $env:NODE_OPTIONS

# 1. Verification of Prerequisite Tools
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
  throw "7-Zip not found at '$sevenZip'. Please verify 7-Zip installation."
}
if (-not (Test-Path -LiteralPath $wranglerBin -PathType Leaf)) {
  throw "Wrangler CLI not found at '$wranglerBin'. Run 'npm ci' inside web/ first."
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
    throw "Passphrase is required for automated backup. Set `$env:D1_BACKUP_PASSWORD or pass -Passphrase."
  }
}

if ([string]::IsNullOrWhiteSpace($Passphrase)) {
  throw "Passphrase cannot be empty."
}

New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Cloudflare D1 + R2 Automated Backup" -ForegroundColor Cyan
Write-Host " Timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

try {
  $env:NODE_OPTIONS = (@($previousNodeOptions, '--dns-result-order=ipv4first') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ' '

  # 3. Export Remote D1 Database via Wrangler CLI (with retry for transient network hiccups)
  Write-Host "[1/6] Exporting remote Cloudflare D1 database..." -ForegroundColor Green
  Push-Location $webRoot
  try {
    $d1Success = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      if (Test-Path -LiteralPath $tempSql) { Remove-Item -LiteralPath $tempSql -Force -ErrorAction SilentlyContinue }
      & node $wranglerBin d1 export ais-scanner-db --remote "--output=$tempSql" --skip-confirmation
      if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $tempSql -PathType Leaf)) {
        $d1Success = $true
        break
      }
      if ($attempt -lt 3) {
        Write-Host "  Retrying Wrangler D1 export (attempt $($attempt + 1)/3)..." -ForegroundColor Yellow
        Start-Sleep -Seconds ($attempt * 2)
      }
    }
    if (-not $d1Success) {
      throw "Wrangler D1 export failed after 3 attempts (last exit code $LASTEXITCODE)"
    }
  } finally {
    Pop-Location
  }

  $sqlItem = Get-Item -LiteralPath $tempSql
  if ($sqlItem.Length -lt 1024) {
    throw "Export file '$tempSql' is suspiciously small ($($sqlItem.Length) bytes). Backup aborted."
  }
  Write-Host "  ✔ D1 export completed: $($sqlItem.Length) bytes ($([math]::Round($sqlItem.Length / 1KB, 2)) KB)" -ForegroundColor Gray

  # 4. Export Cloudflare R2 Evidence Objects (ais-scanner-evidence)
  $r2Summary = 'skipped'
  if (-not $SkipR2 -and (Test-Path -LiteralPath $r2Script -PathType Leaf)) {
    Write-Host "[2/6] Exporting Cloudflare R2 evidence objects..." -ForegroundColor Green
    Push-Location $webRoot
    try {
      & node $r2Script --remote --execute "--outdir=$tempR2Dir"
      if ($LASTEXITCODE -ne 0) {
        throw "R2 evidence backup failed with exit code $LASTEXITCODE"
      }
      $manifestPath = Join-Path $tempR2Dir 'r2-manifest.json'
      if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $r2Summary = "$($manifest.downloaded_count)/$($manifest.total_keys) files ($($manifest.total_bytes) bytes, missing=$($manifest.missing_count))"
      }
    } finally {
      Pop-Location
    }
  } else {
    Write-Host "[2/6] R2 evidence backup skipped (-SkipR2)." -ForegroundColor Gray
  }

  # 5. Compress & Encrypt D1 SQL + R2 Evidence with 7-Zip AES-256 (-mhe=on encrypts archive headers)
  Write-Host "[3/6] Compressing & encrypting D1 + R2 with 7-Zip AES-256..." -ForegroundColor Green
  & $sevenZip a -t7z -mhe=on "-p$Passphrase" -bd "$archiveFile" "$stageDir\*" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "7-Zip encryption failed with exit code $LASTEXITCODE"
  }

  # 6. Integrity Verification
  Write-Host "[4/6] Verifying encrypted archive integrity..." -ForegroundColor Green
  & $sevenZip t "-p$Passphrase" -bd "$archiveFile" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Archive verification failed for '$archiveFile'. Archive might be corrupt."
  }

  $archiveItem = Get-Item -LiteralPath $archiveFile
  $sha256 = (Get-FileHash -LiteralPath $archiveFile -Algorithm SHA256).Hash

  Write-Host "  ✔ Integrity verified: $($archiveItem.Length) bytes ($([math]::Round($archiveItem.Length / 1KB, 2)) KB)" -ForegroundColor Gray
  Write-Host "  ✔ SHA256: $sha256" -ForegroundColor Gray

  # 7. Optional Sync to External Cloud Folder (e.g. Google Drive / OneDrive outside workspace)
  if (-not [string]::IsNullOrWhiteSpace($GoogleDriveDir) -and (Test-Path -LiteralPath $GoogleDriveDir)) {
    Write-Host "[5/6] Syncing encrypted archive to external sync folder..." -ForegroundColor Green
    $gDriveTarget = Join-Path $GoogleDriveDir (Split-Path $archiveFile -Leaf)
    Copy-Item -LiteralPath $archiveFile -Destination $gDriveTarget -Force
    Write-Host "  ✔ Synced to: $gDriveTarget" -ForegroundColor Gray
  } else {
    Write-Host "[5/6] External sync copy skipped (OneDrive already syncs web/backups)." -ForegroundColor Gray
  }

  # 8. Backup Rotation (Remove archives older than RetentionDays)
  Write-Host "[6/6] Enforcing backup retention policy ($RetentionDays days)..." -ForegroundColor Green
  $cutoff = (Get-Date).AddDays(-$RetentionDays)
  $prunedCount = 0
  Get-ChildItem -Path $backupDir -Filter "d1-ais-scanner-db-*.7z" | Where-Object { $_.CreationTime -lt $cutoff } | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Force
    $prunedCount++
    Write-Host "  Purged expired archive: $($_.Name)" -ForegroundColor DarkGray
  }
  Write-Host "  ✔ Retention enforced. ($prunedCount old archives pruned)" -ForegroundColor Gray

  # 9. Record in Audit Log
  $logEntry = "[{0}] SUCCESS: {1} | Size: {2} bytes | R2: {3} | SHA256: {4}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), (Split-Path $archiveFile -Leaf), $archiveItem.Length, $r2Summary, $sha256
  Add-Content -Path $logFile -Value $logEntry

  Write-Host "==========================================================" -ForegroundColor Cyan
  Write-Host " BACKUP SUCCESSFUL!" -ForegroundColor Green
  Write-Host " Archive: $archiveFile" -ForegroundColor Green
  Write-Host " R2 Evidence: $r2Summary" -ForegroundColor Green
  Write-Host "==========================================================" -ForegroundColor Cyan
  exit 0
} catch {
  Write-Host "[ERROR] Backup failed: $_" -ForegroundColor Red
  $logEntry = "[{0}] FAILED: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.ToString()
  Add-Content -Path $logFile -Value $logEntry
  exit 1
} finally {
  $env:NODE_OPTIONS = $previousNodeOptions
  if (Test-Path -LiteralPath $stageDir -PathType Container) {
    $fullTempRoot = [System.IO.Path]::GetFullPath($tempRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $fullStageDir = [System.IO.Path]::GetFullPath($stageDir)
    if ($fullStageDir.StartsWith($fullTempRoot + 'ais-cf-backup-', [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $fullStageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
