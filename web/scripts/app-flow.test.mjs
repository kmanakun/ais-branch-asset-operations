import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test, before, after } from 'node:test'
import { createClient } from '@supabase/supabase-js'

const localOnly = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/
const cli = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const config = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8')
const projectId = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m)?.[1]
assert.ok(projectId, 'Supabase config must contain a valid local project_id')
const databaseContainer = `supabase_db_${projectId}`
const commandOptions = {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  timeout: 60_000,
}
const fixtureTag = randomUUID().replaceAll('-', '').slice(0, 12)
const fixture = {
  admin: { email: `admin-${fixtureTag}@test.invalid`, password: randomBytes(32).toString('base64url'), id: null },
  technician: { email: `tech-${fixtureTag}@test.invalid`, password: randomBytes(32).toString('base64url'), id: null },
  inactive: { email: `inactive-${fixtureTag}@test.invalid`, password: randomBytes(32).toString('base64url'), id: null },
  branchA: randomUUID(), branchB: randomUUID(), scannerA: randomUUID(), scannerB: randomUUID(),
  serialA: `E2E-${fixtureTag}-SECRET-1234`, serialB: `E2E-${fixtureTag}-OTHER-5678`,
  oldSerial: `E2E-${fixtureTag}-OLD-1111`, newSerial: `E2E-${fixtureTag}-NEW-9876`,
  teamA: randomUUID(), teamB: randomUUID(), campaign: randomUUID(), itemA: randomUUID(), itemB: randomUUID(),
  orderA: randomUUID(), orderB: randomUUID(), openRequestId: randomUUID(), taskA: randomUUID(), taskB: randomUUID(), visit: randomUUID(), importBatch: null,
}

let apiUrl
let anonKey
let serviceKey
const clients = []

function signIn(user) {
  return user.client.auth.signInWithPassword({ email: user.email, password: user.password })
}

function runSupabase(args) {
  if (!args.every(argument => /^[A-Za-z0-9_.\/-]+$/.test(argument))) {
    throw new Error('Refusing unsafe arguments for the Supabase CLI test helper')
  }
  const command = `${cli} supabase ${args.map(argument => `"${argument}"`).join(' ')}`
  try {
    return execSync(command, { ...commandOptions, maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    if (error.code === 'ETIMEDOUT') {
      throw new Error('Supabase CLI timed out. Confirm Docker Desktop and the local Supabase stack are available before running app-flow tests.')
    }
    throw error
  }
}

function runLocalSql(sql, databaseRole = 'postgres') {
  if (!['postgres', 'supabase_admin'].includes(databaseRole)) {
    throw new Error('Refusing an unsupported local database role for the app-flow test helper')
  }
  try {
    return execFileSync('docker', [
      'exec', '-i', databaseContainer, 'psql', '--no-psqlrc',
      '-v', 'ON_ERROR_STOP=1', '-U', databaseRole, '-d', 'postgres',
    ], {
      encoding: 'utf8',
      input: sql,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    })
  } catch (error) {
    if (error.code === 'ETIMEDOUT') {
      throw new Error('Local Supabase database SQL fixture timed out. Confirm Docker Desktop and the local database container are available.')
    }
    throw new Error(`Could not run SQL against the local Supabase Docker database: ${error.stderr?.toString().trim() || error.message}`)
  }
}

function parseEnvValue(output, name) {
  const match = output.match(new RegExp(`^${name}=["']?([^"'\\r\\n]+)["']?$`, 'm'))
  assert.ok(match, `Supabase local status did not return ${name}`)
  return match[1]
}

async function adminRequest(path, options = {}) {
  const response = await fetch(`${apiUrl}/auth/v1/admin/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Local Auth admin request failed (${response.status}): ${body.msg || body.message || 'unknown error'}`)
  return body
}

async function createLocalUser(user) {
  const body = await adminRequest('users', {
    method: 'POST',
    body: JSON.stringify({ email: user.email, password: user.password, email_confirm: true }),
  })
  user.id = body.user?.id || body.id
  assert.ok(user.id, 'Local Auth did not return a user ID')
}

function sqlFixture() {
  const u = fixture
  return `do $$ begin
insert into app_private.user_access (user_id, role, display_name, is_active) values
  ('${u.admin.id}', 'admin', 'Local E2E Admin', true),
  ('${u.technician.id}', 'field_technician', 'Local E2E Technician', true),
  ('${u.inactive.id}', 'field_technician', 'Local E2E Inactive', false);
insert into app_private.branches (id, location_code, loc_bld, province) values
  ('${u.branchA}', 'E2E-${fixtureTag}', 'E2E Branch A', 'à¹€à¸Šà¸µà¸¢à¸‡à¹ƒà¸«à¸¡à¹ˆ'),
  ('${u.branchB}', 'E2E-${fixtureTag}', 'E2E Branch B', 'à¸à¸£à¸¸à¸‡à¹€à¸—à¸à¸¡à¸«à¸²à¸™à¸„à¸£');
insert into app_private.scanner_assets (id, branch_id, model_name, com_sn) values
  ('${u.scannerA}', '${u.branchA}', 'E2E Scanner', '${u.serialA}'),
  ('${u.scannerB}', '${u.branchB}', 'E2E Scanner', '${u.serialB}');
insert into app_private.teams (id, team_name) values
  ('${u.teamA}', 'E2E Team A ${fixtureTag}'),
  ('${u.teamB}', 'E2E Team B ${fixtureTag}');
insert into app_private.user_team_memberships (user_id, team_id) values ('${u.technician.id}', '${u.teamA}');
insert into app_private.campaigns (id, campaign_code, campaign_name, status)
values ('${u.campaign}', 'E2E-${fixtureTag}', 'Local app flow test', 'scheduled');
insert into app_private.campaign_items (id, campaign_id, scanner_asset_id, selection_reason) values
  ('${u.itemA}', '${u.campaign}', '${u.scannerA}', 'Local app flow fixture'),
  ('${u.itemB}', '${u.campaign}', '${u.scannerB}', 'Local app flow fixture');
insert into app_private.branch_work_orders (id, work_order_code, branch_id, origin, created_by) values
  ('${u.orderA}', 'E2E-${fixtureTag}-ORDER-A', '${u.branchA}', 'admin', '${u.admin.id}'),
  ('${u.orderB}', 'E2E-${fixtureTag}-ORDER-B', '${u.branchB}', 'admin', '${u.admin.id}');
insert into app_private.replacement_tasks (id, campaign_item_id, team_id, status, scanner_asset_id,
  branch_work_order_id, scanner_serial_snapshot) values
  ('${u.taskA}', '${u.itemA}', '${u.teamA}', 'completed', '${u.scannerA}', '${u.orderA}', '${u.serialA}'),
  ('${u.taskB}', '${u.itemB}', '${u.teamB}', 'scheduled', '${u.scannerB}', '${u.orderB}', '${u.serialB}');
insert into app_private.field_visits (id, task_id, old_serial_snapshot, new_serial, install_result, old_scanner_status, performed_by)
values ('${u.visit}', '${u.taskA}', '${u.oldSerial}', '${u.newSerial}', 'success', 'returned_usable', '${u.technician.id}');
end $$;
`
}

function sqlCleanup() {
  const u = fixture
  return `do $$ begin
delete from app_private.task_evidence_removal_history where task_id in ('${u.taskA}', '${u.taskB}');
delete from app_private.task_evidence_delete_reservations where task_id in ('${u.taskA}', '${u.taskB}');
delete from app_private.field_visits where id = '${u.visit}';
delete from app_private.replacement_task_evidence where task_id in ('${u.taskA}', '${u.taskB}');
delete from vçM­¢G§²ÚîÆ­yİÜK\œ›Üˆ\İÜQ\œ›ÜˆHH]ØZ]š^\™KXÚšXÚX[‹˜ÛY[œœÊ	ØZ\×ÜØØ[›™\—İÛÜš×Ú\İÜIËÂˆØ\ÜÙ]ÚYˆš^\™KœØØ[›™\‹İ\Ú×ÚYˆš^\™K\ÚĞ‹Û[Z]ˆKÛÙ™œÙ]ˆˆJBˆ\ÜÙ\šY‘\œ›ÜŠ\İÜQ\œ›ÜŠBˆ\ÜÙ\™\]X[
X[P’\İÜKİ[K	ØHXÚšXÚX[ˆØ[ˆÜ[ˆÛÜšÈ\İÜHİ]ÚYHZ\ˆ›Ü›Y\ˆX[HY[X™\œÚ\	ÊBˆ\ÜÙ\™\]X[
X[P’\İÜKœ›İÜÖÌKšYš^\™K\ÚĞŠBŸJB‚\İ
	Ø[ˆ[˜Xİ]™H›Ùš[HÚYÛœÈ[ˆ]]]]\XØ][Ûˆ”ÜÈ[HXØÙ\ÜÉË\Ş[˜È

HOˆÂˆÛÛœİÈ]Nˆ]]\œ›Üˆ]]\œ›ÜˆHH]ØZ]ÚYÛ’[Šš^\™Kš[˜Xİ]™JBˆ\ÜÙ\šY‘\œ›ÜŠ]]\œ›ÜŠBˆ\ÜÙ\›ÚÊ]]œÙ\ÜÚ[ÛŠB‚ˆÛÛœİÈ]NˆÛÛ^\œ›ÜˆÛÛ^\œ›ÜˆHH]ØZ]š^\™Kš[˜Xİ]™K˜ÛY[œœÊ	ØZ\×Ø\ØÛÛ^	ÊBˆ\ÜÙ\šY‘\œ›ÜŠÛÛ^\œ›ÜŠBˆ\ÜÙ\™\]X[
ÛÛ^[
B‚ˆÛÛœİÈ\œ›Üˆ\Ú›Ø\™\œ›ÜˆHH]ØZ]š^\™Kš[˜Xİ]™K˜ÛY[œœÊ	ØZ\×Ù\Ú›Ø\™	ÊBˆ\ÜÙ\™\]X[
\Ú›Ø\™\œ›ÜË˜ÛÙK	ÍLIÊBŸJB‚\İ
	ĞYZ[ˆØ[ˆİYÙH[ˆ[˜Ü™[Y[[[\ÜÚ[H[ˆ[˜Xİ]™HXÚšXÚX[ˆ\È[šYY	Ë\Ş[˜È

HOˆÂˆÛÛœİÈ\œ›Üˆ[˜Xİ]™P]]\œ›ÜˆHH]ØZ]ÚYÛ’[Šš^\™Kš[˜Xİ]™JBˆ\ÜÙ\šY‘\œ›ÜŠ[˜Xİ]™P]]\œ›ÜŠBˆÛÛœİ[šYYH]ØZ]š^\™Kš[˜Xİ]™K˜ÛY[œœÊ	ØZ\×Ú[˜Ü™[Y[[Ú[\ÜÜİYÙIËÂˆÜ›İÜÎˆŞÈÛİ\˜ÙWÜ›İÎˆ‹ØØ][Û—ØÛÙNˆS’QQIÙš^\™UYßXØ×Ø›ˆ	Ñ[šYYœ˜[˜Ú	ËÛÛWÜÛˆS’QQIÙš^\™UYßXWKˆJBˆ\ÜÙ\™\]X[
[šYY™\œ›ÜË˜ÛÙK	ÍLIÊBˆ]ØZ]š^\™Kš[˜Xİ]™K˜ÛY[˜]]œÚYÛ“İ]

B‚ˆÛÛœİÈ\œ›ÜˆYZ[]]\œ›ÜˆHH]ØZ]ÚYÛ’[Šš^\™K˜YZ[ŠBˆ\ÜÙ\šY‘\œ›ÜŠYZ[]]\œ›ÜŠBˆÛÛœİÈ]K\œ›ÜˆHH]ØZ]š^\™K˜YZ[‹˜ÛY[œœÊ	ØZ\×Ú[˜Ü™[Y[[Ú[\ÜÜİYÙIËÂˆÜ›İÜÎˆŞÂˆÛİ\˜ÙWÜ›İÎˆ‹ˆØØ][Û—ØÛÙNˆL‘KIÙš^\™UYßXˆØ×Ø›ˆ	ÑL‘Hœ˜[˜ÚIËˆ›İš[˜ÙNˆ	Õ\İ›İš[˜ÙIËˆœ˜[™ˆ	Õ\İœ˜[™	Ëˆ[Ù[Û˜[YNˆ	Õ\İ[Ù[	ËˆÛÛWÜÛˆš^\™KœÙ\šX[Kˆ[\ÛXZ[ˆ	Û]\İ[›İX™K\İYÙY^[\Kš[˜[Y	Ëˆ›İNˆ	Û]\İ›İ™HİYÙY	ËˆWKˆJBˆ\ÜÙ\šY‘\œ›ÜŠ\œ›ÜŠBˆ\ÜÙ\™\]X[
]Kœ›İ×ØÛİ[JBˆ\ÜÙ\™\]X[
]K˜œ˜[˜ÚØÛİ[JBˆ\ÜÙ\™\]X[
]Kš\ÜİYWØÛİ[
Bˆš^\™Kš[\Ü˜]ÚH]K˜˜]ÚÚYŸJB‚\İ
	ØÛÛ˜İ\œ™[™]šY\È›ÜˆÛ™HÛÜšË[Ü™\ˆ™\]Y\İ™]\›ˆHØ[YHÜ™\ˆÚ]İ]\XØ]H\œ›ÜœÉË\Ş[˜È

HOˆÂˆÛÛœİÈ\œ›Üˆ]]\œ›ÜˆHH]ØZ]ÚYÛ’[Šš^\™K˜YZ[ŠBˆ\ÜÙ\šY‘\œ›ÜŠ]]\œ›ÜŠB‚ˆÛÛœİ^[ØYHÂˆØœ˜[˜ÚÚYˆš^\™K˜œ˜[˜ÚKˆÜØØ[›™\—Ø\ÜÙ]ÚYÎˆÙš^\™KœØØ[›™\WKˆÜ™\]Y\İÚYˆš^\™K›Ü[”™\]Y\İYˆBˆÛÛœİ™\İ[ÈH]ØZ]›ÛZ\ÙK˜[
Âˆš^\™K˜YZ[‹˜ÛY[œœÊ	ØZ\×ÛÜ[—Øœ˜[˜ÚİÛÜš×ÛÜ™\‰Ë^[ØY
Kˆš^\™K˜YZ[‹˜ÛY[œœÊ	ØZ\×ÛÜ[—Øœ˜[˜ÚİÛÜš×ÛÜ™\‰Ë^[ØY
KˆJBˆ\ÜÙ\šY‘\œ›ÜŠ™\İ[ÖÌK™\œ›ÜŠBˆ\ÜÙ\šY‘\œ›ÜŠ™\İ[ÖÌWK™\œ›ÜŠBˆ\ÜÙ\™\]X[
™\İ[ÖÌK™]KÛÜš×ÛÜ™\—ÚY™\İ[ÖÌWK™]KÛÜš×ÛÜ™\—ÚY
Bˆ\ÜÙ\™Y\\]X[
ˆ™\İ[Ë›X\
™\İ[Oˆ™\İ[™]K˜[™XYWÛÜ[™Y
KœÛÜ

KˆÙ˜[ÙKYWKˆ
Bˆ\ÜÙ\™\]X[
™\İ[ÖÌK™]KœÙ[XİYÜØØ[›™\œËJBˆ\ÜÙ\™\]X[
™\İ[ÖÌWK™]KœÙ[XİYÜØØ[›™\œËJBŸJB‚\İ
	ÜÚYÛ™YZ[ˆXÚšXÚX[ˆØ[ˆ\ØYš[˜[^™K[™ØY™[H™[[İ™HHØØ[›™\ˆİÈ›İYÚİÜ˜YÙHTIË\Ş[˜È

HOˆÂˆÛÛœİÈ\œ›Üˆ]]\œ›ÜˆHH]ØZ]ÚYÛ’[Šš^\™KXÚšXÚX[ŠBˆ\ÜÙ\šY‘\œ›ÜŠ]]\œ›ÜŠBˆÛÛœİÈ\œ›ÜˆYZ[]]\œ›ÜˆHH]ØZ]ÚYÛ’[Šš^\™K˜YZ[ŠBˆ\ÜÙ\šY‘\œ›ÜŠYZ[]]\œ›ÜŠB‚ˆÛÛœİÛİH	ÛÛÜÙ\šX[ÜİÉÂˆÛÛœİ]H	Ùš^\™K\ÚĞŸKÉÜÛİKšœØˆÛÛœİİÈH™]È›ØŠĞY™™\‹™œ›ÛJ	Ù™™™™LLMMŒLLLL™™IË	Ú^	ÊWKÈ\Nˆ	Ú[XYÙKÚœYÉÈJBˆ]İÜ˜YÙSØš™Xİ^\İÈH˜[ÙBˆÛÛœİÛX[\ÛY[HÜ™X]PÛY[
\U\›Ù\šXÙRÙ^KÂˆ]]ˆÈ]]Ô™Yœ™\ÚÚÙ[ˆ˜[ÙK\œÚ\İÙ\ÜÚ[Ûˆ˜[ÙK]XİÙ\ÜÚ[Û’[•\›ˆ˜[ÙHKˆJBˆHÂˆÛÛœİÈ]Nˆ™\Ù\˜][Û‹\œ›Üˆ™\Ù\™Q\œ›ÜˆHH]ØZ]š^\™KXÚšXÚX[‹˜ÛY[œœÊ	ØZ\×İ\Ú×Ù]šY[˜ÙWÜ™\Ù\™WÙ›Ü—Ûİ]ÛÛYIËÂˆİ\Ú×ÚYˆš^\™K\ÚĞ‹ˆÜÛİˆÛİˆØ]WÜÚ^™NˆİËœÚ^™KˆÜÚYÛ™\—Û˜[YNˆ[ˆØÛÛœÙ[ØÛÛ™š\›YYˆ˜[ÙKˆÛİ]ÛÛYNˆ	Ü™\XÙY	ËˆJBˆ\ÜÙ\šY‘\œ›ÜŠ™\Ù\™Q\œ›ÜŠBˆ\ÜÙ\™\]X[
™\Ù\˜][Û‹\Ú×Üİ\YYJBˆ\ÜÙ\›ÚÊ™\Ù\˜][Û‹œ™\Ù\˜][Û—İÚÙ[ŠB‚ˆÛÛœİ\ØYÛXŞHH[“ØØ[Ü[
œÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[KœİX‰Ë	ÉÙš^\™KXÚšXÚX[‹šYIË˜[ÙJNÂœÙ[XİœÛÛ˜—ØZ[Ø\œ˜^Jˆ\Üš]˜]K˜Ø[—ÙY]İ\Ú×Ù]šY[˜ÙWÜÛİ
	ÉÙš^\™K\ÚĞŸIË	ÉÜÛİIÊKˆ\Üš]˜]K˜Ø[—ØXØÙ\Ü×İ\Ú×Ù]šY[˜ÙWÛØš™Xİ
	ÉÜ]IË	İÜš]IÊKˆ\Üš]˜]K˜Ø[—İ\ØYİ\Ú×Ù]šY[˜ÙWÛØš™Xİ
	ÉÜ]IË	ÉÜİËœÚ^™_IË	Ú[XYÙKÚœYÉË	ÉÜ™\Ù\˜][Û‹œ™\Ù\˜][Û—İÚÙ[ŸIÊBŠNÂ˜
BˆÛÛœİÛXŞQ›YÜÈH\ØYÛXŞK›X]Ú
×ÊÎY_˜[ÙJK
ÎY_˜[ÙJK
ÎY_˜[ÙJWKÊOË–ÌBˆ\ÜÙ\™\]X[
ÛXŞQ›YÜË	ÖİYKYKYWIË™\Ù\™Y\ØYÛXŞHÚXÚÜÈÙ\™H	ÜÛXŞQ›YÜÈ	İ[˜]˜Z[X›IßX
B‚ˆÛÛœİÈ\œ›Üˆ\ØY\œ›ÜˆHH]ØZ]š^\™KXÚšXÚX[‹˜ÛY[œİÜ˜YÙK™œ›ÛJ	ØZ\Ë]\ÚËY]šY[˜ÙIÊK\ØY
]İËÂˆÛÛ[\Nˆ	Ú[XYÙKÚœYÉËˆ\Ù\ˆYKˆØXÚPÛÛ›Ûˆ	Ì	ËˆY]Y]NˆÈ™\Ù\˜][Û—İÚÙ[ˆ™\Ù\˜][Û‹œ™\Ù\˜][Û—İÚÙ[ˆKˆJBˆ\ÜÙ\šY‘\œ›ÜŠ\ØY\œ›ÜŠBˆİÜ˜YÙSØš™Xİ^\İÈHYB‚ˆÛÛœİÈ]Nˆš[˜[^™Y\œ›Üˆš[˜[^™Q\œ›ÜˆHH]ØZ]š^\™KXÚšXÚX[‹˜ÛY[œœÊ	ØZ\×İ\Ú×Ù]šY[˜ÙWÙš[˜[^™IËÂˆİ\Ú×ÚYˆš^\™K\ÚĞ‹ˆÜÛİˆÛİˆJBˆ\ÜÙ\šY‘\œ›ÜŠš[˜[^™Q\œ›ÜŠBˆ\ÜÙ\™\]X[
š[˜[^™Yœİ]\Ë	Ü™XYIÊB‚ˆÛÛœİÈ]Nˆ[]T™\Ù\˜][Û‹\œ›Üˆ[]T™\Ù\™Q\œ›ÜˆHH]ØZ]š^\™KXÚšXÚX[‹˜ÛY[œœÊ	ØZ\×İ\Ú×Ù]šY[˜ÙWÙ[]WÜ™\Ù\™IËÂˆİ\Ú×ÚYˆš^\™K\ÚĞ‹ˆÜÛİˆÛİˆJBˆ\ÜÙ\šY‘\œ›ÜŠ[]T™\Ù\™Q\œ›ÜŠBˆ\ÜÙ\™\]X[
[]T™\Ù\˜][Û‹œ]]
B‚ˆ]ØZ]š^\™K˜YZ[‹˜ÛY[œİÜ˜YÙK™œ›ÛJ	ØZ\Ë]\ÚËY]šY[˜ÙIÊKœ™[[İ™JÜ]JBˆÛÛœİÈ]Nˆİ[™\Ù[\œ›ÜˆİÛ›ØY\œ›ÜˆHH]ØZ]š^\™KXÚšXÚX[‹˜ÛY[œİÜ˜YÙK™œ›ÛJ	ØZ\Ë]\ÚËY]šY[˜ÙIÊK™İÛ›ØY
]
Bˆ\ÜÙ\šY‘\œ›ÜŠİÛ›ØY\œ›ÜŠBˆ\ÜÙ\›ÚÊİ[™\Ù[	ØHY™™\™[]]Üš^™YXØÛİ[Ø[››İ™[[İ™HHXÚšXÚX[ˆ™\Ù\˜][Û‰ÊB‚ˆÛÛœİÈ\œ›Üˆ™[[İ™Q\œ›ÜˆHH]ØZ]š^\™KXÚšXÚX[‹˜ÛY[œİÜ˜YÙK™œ›ÛJ	ØZ\Ë]\ÚËY]šY[˜ÙIÊKœ™[[İ™JÜ]JBˆ\ÜÙ\šY‘\œ›ÜŠ™[[İ™Q\œ›ÜŠBˆİÜ˜YÙSØš™Xİ^\İÈH˜[ÙB‚ˆÛÛœİÈ]Nˆ™[[İ™Y\œ›Üˆ[]Qš[˜[^™Q\œ›ÜˆHH]ØZ]š^\™KXÚšXÚX[‹˜ÛY[œœÊ	ØZ\×İ\Ú×Ù]šY[˜ÙWÙ[]WÙš[˜[^™IËÂˆİ\Ú×ÚYˆš^\™K\ÚĞ‹ˆÜÛİˆÛİˆÜ™\Ù\˜][Û—İÚÙ[ˆ[]T™\Ù\˜][Û‹œ™\Ù\˜][Û—İÚÙ[‹ˆJBˆ\ÜÙ\šY‘\œ›ÜŠ[]Qš[˜[^™Q\œ›ÜŠBˆ\ÜÙ\™\]X[
™[[İ™Yœİ]\Ë	Ü™[[İ™Y	ÊB‚ˆÛÛœİÈ]Nˆ]šY[˜ÙT›İÜË\œ›Üˆ\İ\œ›ÜˆHH]ØZ]š^\™KXÚšXÚX[‹˜ÛY[œœÊ	ØZ\×İ\Ú×Ù]šY[˜ÙWÛ\İ	ËÈİ\Ú×ÚYˆš^\™K\ÚĞˆJBˆ\ÜÙ\šY‘\œ›ÜŠ\İ\œ›ÜŠBˆ\ÜÙ\›ÚÊY]šY[˜ÙT›İÜËœÛÛYJ›İÈOˆ›İËœÛİOOHÛİ
K	İH™[[İ™Y]šY[˜ÙH›ÈÛ™Ù\ˆ\X\œÈÛˆHÛÜšÈÜ™\‰ÊB‚ˆÛÛœİ]Y]™\İ[H[“ØØ[Ü[
Ù[XİÛİ[

ŠHHHœ›ÛH\Üš]˜]K\Ú×Ù]šY[˜ÙWÜ™[[İ˜[Ú\İÜBÚ\™H\Ú×ÚYH	ÉÙš^\™K\ÚĞŸIÈ[™ÛİH	ÉÜÛİIÈ[™™[[İ™YØHH	ÉÙš^\™KXÚšXÚX[‹šYIÎØ
Bˆ\ÜÙ\›X]Ú
]Y]™\İ[×‹Ë	İH™[[İ˜[\İÜH™XÛÜ™ÈHXÚšXÚX[ˆÚÈ\™›Ü›YY]	ÊBˆHš[˜[HÂˆYˆ
İÜ˜YÙSØš™Xİ^\İÊHÂˆÛÛœİÈ\œ›ÜˆÛX[\\œ›ÜˆHH]ØZ]ÛX[\ÛY[œİÜ˜YÙK™œ›ÛJ	ØZ\Ë]\ÚËY]šY[˜ÙIÊKœ™[[İ™JÜ]JBˆYˆ
ÛX[\\œ›ÜŠHÛÛœÛÛK™\œ›ÜŠ	ĞÛİ[›İ™[[İ™HHØØ[\ØYš^\™N‰ËÛX[\\œ›Ü‹›Y\ÜØYÙJBˆBˆ]ØZ]ÛX[\ÛY[˜]]œÚYÛ“İ]

K˜Ø]Ú


HOˆßJBˆBŸJB