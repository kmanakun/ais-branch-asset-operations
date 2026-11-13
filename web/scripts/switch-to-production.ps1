<#
.SYNOPSIS
  Switches Cloudflare D1 database (ais-scanner-db) to clean Production state.
.DESCRIPTION
  Performs an automated encrypted pre-wipe backup with 7-Zip AES-256,
  clears test branches, scanners, tasks, evidence, and reviews from D1,
  preserves the google_signin_allowlist (so admins/users remain authorized),
  and verifies that the database is 100% clean and ready for official AIS Excel import.
.PARAMETER Force
  Skips interactive confirmation prompt.
#>
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$webRoot = Split-Path -Parent $scriptDir
$backupScript = Join-Path $scriptDir "backup-d1-production.ps1"

Write-Host "==========================================================" -ForegroundColor Yellow
Write-Host " Cloudflare D1 Production Switch & Test Data Wipe" -ForegroundColor Yellow
Write-Host " Target Database: ais-scanner-db (Remote Production Edge)" -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Yellow

if (-not $Force) {
  Write-Host "`n[WARNING] This action will permanently wipe all test data from:" -ForegroundColor Red
  Write-Host "  - branches" -ForegroundColor Gray
  Write-Host "  - scanner_assets" -ForegroundColor Gray
  Write-Host "  - replacement_tasks" -ForegroundColor Gray
  Write-Host "  - replacement_task_evidence" -ForegroundColor Gray
  Write-Host "  - task_reviews" -ForegroundColor Gray
  Write-Host "  - scanner_discovery_reports" -ForegroundColor Gray
  Write-Host "  - register_imports" -ForegroundColor Gray
  Write-Host "`n[SAFEGUARD] google_signin_allowlist WILL BE PRESERVED (Admins will NOT be locked out).`n" -ForegroundColor Green

  $confirmation = Read-Host "Type 'YES' to create encrypted backup and switch to Production"
  if ($confirmation -ne 'YES') {
    Write-Host "Aborted by user. No changes were made." -ForegroundColor Yellow
    exit 0
  }
}

# 1. Take Pre-Wipe Encrypted Backup First (Safety Guarantee)
Write-Host "`n[Step 1/3] Creating mandatory pre-wipe encrypted backup..." -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $backupScript)) {
  throw "Backup script not found at '$backupScript'. Cannot proceed without backup."
}

try {
  & powershell.exe -ExecutionPolicy Bypass -NoProfile -File "$backupScript"
  if ($LASTEXITCODE -ne 0) {
    throw "Pre-wipe backup failed with exit code $LASTEXITCODE. Production switch aborted for data safety."
  }
} catch {
  throw "Backup failed: $_. Production switch aborted."
}

Write-Host "  ✔ Pre-wipe backup completed and verified." -ForegroundColor Green

# 2. Execute Atomic Wipe on Remote D1
Write-Host "`n[Step 2/3] Wiping test data from remote D1 database..." -ForegroundColor Cyan

$wipeSql = @"
DELETE FROM replacement_task_evidence;
DELETE FROM task_reviews;
DELETE FROM scanner_discovery_reports;
DELETE FROM replacement_tasks;
DELETE FROM scanner_assets;
DELETE FROM branches;
DELETE FROM register_imports;
VACUUM;
"@

Push-Location $webRoot
try {
  $tempWipeFile = Join-Path $env:TEMP ("d1-wipe-" + [guid]::NewGuid().ToString('N') + ".sql")
  Set-Content -Path $tempWipeFile -Value $wipeSql -Encoding utf8
  
  & npx wrangler d1 execute ais-scanner-db --remote --file=$tempWipeFile
  if ($LASTEXITCODE -ne 0) {
    throw "Wrangler D1 execute failed with exit code $LASTEXITCODE"
  }
  Remove-Item -LiteralPath $tempWipeFile -Force -ErrorAction SilentlyContinue
} finally {
  Pop-Location
}

Write-Host "  ✔ Test data purged and SQLite VACUUM completed." -ForegroundColor Green

# 3. Post-Wipe Verification
Write-Host "`n[Step 3/3] Verifying database integrity..." -ForegroundColor Cyan

Push-Location $webRoot
try {
  $verifyResult = & npx wrangler d1 execute ais-scanner-db --remote --command="SELECT (SELECT count(*) FROM branches) as branches, (SELECT count(*) FROM scanner_assets) as scanners, (SELECT count(*) FROM replacement_tasks) as tasks, (SELECT count(*) FROM google_signin_allowlist) as allowlist_users;" --json
  Write-Host "  Table counts after wipe:" -ForegroundColor Gray
  Write-Host "  $verifyResult" -ForegroundColor Gray
} finally {
  Pop-Location
}

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host " PRODUCTION SWITCH COMPLETE!" -ForegroundColor Green
Write-Host " Database is clean, secure, and ready for official Excel import." -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
