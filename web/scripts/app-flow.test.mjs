import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { test, before, after } from 'node:test'
import { createClient } from '@supabase/supabase-js'

const localOnly = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/
const cli = process.platform === 'win32' ? 'npx.cmd' : 'npx'
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
  teamA: randomUUID(), teamB: randomUUID(), campaign: randomUUID(), itemA: randomUUID(), itemB: randomUUID(),
  orderA: randomUUID(), orderB: randomUUID(), taskA: randomUUID(), taskB: randomUUID(), visit: randomUUID(), importBatch: null,
}

let apiUrl
let anonKey
let serviceKey
let seedFile
let cleanupFile
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
  ('${u.branchA}', 'E2E-${fixtureTag}', 'E2E Branch A', 'เชียงใหม่'),
  ('${u.branchB}', 'E2E-${fixtureTag}', 'E2E Branch B', 'กรุงเทพมหานคร');
insert into app_private.scanner_assets (id, branch_id, model_name, com_sn) values
  ('${u.scannerA}', '${u.branchA}', 'E2E Scanner', 'E2E-SECRET-1234'),
  ('${u.scannerB}', '${u.branchB}', 'E2E Scanner', 'E2E-OTHER-5678');
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
  ('${u.taskA}', '${u.itemA}', '${u.teamA}', 'completed', '${u.scannerA}', '${u.orderA}', 'E2E-SECRET-1234'),
  ('${u.taskB}', '${u.itemB}', '${u.teamB}', 'scheduled', '${u.scannerB}', '${u.orderB}', 'E2E-OTHER-5678');
insert into app_private.field_visits (id, task_id, old_serial_snapshot, new_serial, install_result, old_scanner_status, performed_by)
values ('${u.visit}', '${u.taskA}', 'E2E-OLD-1111', 'E2E-NEW-9876', 'success', 'returned_usable', '${u.technician.id}');
end $$;
`
}

function sqlCleanup() {
  const u = fixture
  return `do $$ begin
delete from app_private.field_visits where id = '${u.visit}';
delete from app_private.replacement_tasks where id in ('${u.taskA}', '${u.taskB}');
delete from app_private.branch_work_orders where id in ('${u.orderA}', '${u.orderB}');
delete from app_private.campaign_items where id in ('${u.itemA}', '${u.itemB}');
delete from app_private.campaigns where id = '${u.campaign}';
delete from app_private.scanner_assets where id in ('${u.scannerA}', '${u.scannerB}');
delete from app_private.branches where id in ('${u.branchA}', '${u.branchB}');
delete from app_private.user_team_memberships where user_id = '${u.technician.id}';
delete from app_private.teams where id in ('${u.teamA}', '${u.teamB}');
delete from app_private.import_row_issues where batch_id = '${u.importBatch || '00000000-0000-4000-8000-000000000000'}';
delete from app_private.import_staging_rows where batch_id = '${u.importBatch || '00000000-0000-4000-8000-000000000000'}';
delete from app_private.import_batches where id = '${u.importBatch || '00000000-0000-4000-8000-000000000000'}';
delete from app_private.user_access where user_id in ('${u.admin.id}', '${u.technician.id}', '${u.inactive.id}');
end $$;
`
}

before(async () => {
  const status = runSupabase(['status', '--output', 'env'])
  apiUrl = parseEnvValue(status, 'API_URL')
  anonKey = parseEnvValue(status, 'ANON_KEY')
  serviceKey = parseEnvValue(status, 'SERVICE_ROLE_KEY')
  assert.match(apiUrl, localOnly, 'Refusing to run application tests against a non-local Supabase URL')

  await createLocalUser(fixture.admin)
  await createLocalUser(fixture.technician)
  await createLocalUser(fixture.inactive)

  await mkdir('supabase/.temp', { recursive: true })
  seedFile = `supabase/.temp/app-flow-seed-${fixtureTag}.sql`
  cleanupFile = `supabase/.temp/app-flow-cleanup-${fixtureTag}.sql`
  await writeFile(seedFile, sqlFixture(), 'utf8')
  runSupabase(['db', 'query', '--file', seedFile])

  for (const user of [fixture.admin, fixture.technician, fixture.inactive]) {
    user.client = createClient(apiUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })
    clients.push(user.client)
  }
})

after(async () => {
  for (const client of clients) await client.auth.signOut().catch(() => {})
  if (apiUrl && localOnly.test(apiUrl)) {
    if (fixture.admin.id && fixture.technician.id && fixture.inactive.id) {
      try {
        await mkdir('supabase/.temp', { recursive: true })
        await writeFile(cleanupFile, sqlCleanup(), 'utf8')
        runSupabase(['db', 'query', '--file', cleanupFile])
      } catch (error) {
        console.error('Could not remove local app-flow database fixtures:', error.message)
      }
    }
    for (const user of [fixture.admin, fixture.technician, fixture.inactive]) {
      if (user.id) {
        try { await adminRequest(`users/${user.id}`, { method: 'DELETE' }) }
        catch (error) { console.error('Could not remove a local Auth test user:', error.message) }
      }
    }
  }
  for (const file of [seedFile, cleanupFile]) {
    if (file) await unlink(file).catch(() => {})
  }
})

test('real sign-in rejects an incorrect password', async () => {
  const { error } = await fixture.admin.client.auth.signInWithPassword({
    email: fixture.admin.email,
    password: `${fixture.admin.password}-wrong`,
  })
  assert.ok(error, 'incorrect credentials must not create a session')
  const { data } = await fixture.admin.client.auth.getSession()
  assert.equal(data.session, null)
})

test('Admin login returns operational Serial values and can search them', async () => {
  const { data: auth, error: authError } = await signIn(fixture.admin)
  assert.ifError(authError)
  assert.ok(auth.session)

  const { data: context, error: contextError } = await fixture.admin.client.rpc('ais_app_context')
  assert.ifError(contextError)
  assert.equal(context.role, 'admin')

  const { data: scanners, error: scannerError } = await fixture.admin.client.rpc('ais_list_scanners')
  assert.ifError(scannerError)
  const targetScanner = scanners.find(row => row.branch_name === 'E2E Branch A')
  const secondBranchScanner = scanners.find(row => row.branch_name === 'E2E Branch B')
  assert.ok(targetScanner.id)
  assert.ok(secondBranchScanner.id)
  assert.notEqual(targetScanner.id, secondBranchScanner.id)
  assert.equal(targetScanner.com_sn, 'E2E-SECRET-1234')
  assert.ok(JSON.stringify(scanners).includes('E2E-SECRET-1234'))

  const { data: searchResults, error: searchError } = await fixture.admin.client.rpc('ais_list_scanners', { p_search: 'SECRET' })
  assert.ifError(searchError)
  assert.equal(searchResults.length, 1)
  assert.equal(searchResults[0].com_sn, 'E2E-SECRET-1234')

  const { data: taskPage, error: taskError } = await fixture.admin.client.rpc('ais_task_filtered_page', {
    p_search: null, p_status: 'all', p_limit: 50, p_offset: 0,
  })
  assert.ifError(taskError)
  const tasks = taskPage.rows
  const targetTask = tasks.find(row => row.branch_name === 'E2E Branch A')
  assert.equal(targetTask.new_serial, 'E2E-NEW-9876')
  assert.equal(targetTask.performed_by_name, 'Local E2E Technician')
  assert.ok(targetTask.performed_at)

  const { data: workHistory, error: historyError } = await fixture.admin.client.rpc('ais_scanner_work_history', {
    p_asset_id: fixture.scannerA, p_task_id: fixture.taskA, p_limit: 1, p_offset: 0,
  })
  assert.ifError(historyError)
  assert.equal(workHistory.total, 1)
  assert.equal(workHistory.rows[0].performed_by_name, 'Local E2E Technician')
  assert.equal(workHistory.rows[0].old_serial_snapshot, 'E2E-OLD-1111')
  assert.equal(workHistory.rows[0].new_serial, 'E2E-NEW-9876')

  const { error: signOutError } = await fixture.admin.client.auth.signOut()
  assert.ifError(signOutError)
  const { data: signedOut } = await fixture.admin.client.auth.getSession()
  assert.equal(signedOut.session, null)
})

test('Field Technician sees every work order opened for technicians', async () => {
  const { data: auth, error: authError } = await signIn(fixture.technician)
  assert.ifError(authError)
  assert.ok(auth.session)

  const { data: taskPage, error: taskError } = await fixture.technician.client.rpc('ais_task_filtered_page', {
    p_search: null, p_status: 'all', p_limit: 50, p_offset: 0,
  })
  assert.ifError(taskError)
  const tasks = taskPage.rows
  assert.equal(tasks.length, 2)
  assert.deepEqual(new Set(tasks.map(row => row.branch_name)), new Set(['E2E Branch A', 'E2E Branch B']))
  assert.equal(tasks.find(row => row.branch_name === 'E2E Branch B').workflow_stage, 'open')

  const { data: scannerPage, error: scannerError } = await fixture.technician.client.rpc('ais_scanner_page', {
    p_search: null, p_limit: 50, p_offset: 0,
  })
  assert.ifError(scannerError)
  const scanners = scannerPage.rows
  assert.equal(scanners.length, 2)
  assert.ok(scanners[0].id)
  assert.equal(scanners.find(row => row.branch_name === 'E2E Branch A').com_sn, 'E2E-SECRET-1234')
  assert.equal(scanners.find(row => row.branch_name === 'E2E Branch A').province, 'เชียงใหม่')
  assert.equal(scanners.find(row => row.branch_name === 'E2E Branch B').province, 'กรุงเทพมหานคร')

  const { data: teamBHistory, error: historyError } = await fixture.technician.client.rpc('ais_scanner_work_history', {
    p_asset_id: fixture.scannerB, p_task_id: fixture.taskB, p_limit: 1, p_offset: 0,
  })
  assert.ifError(historyError)
  assert.equal(teamBHistory.total, 1, 'a technician can open work history outside their former team membership')
  assert.equal(teamBHistory.rows[0].id, fixture.taskB)
})

test('an inactive profile signs in at Auth but application RPCs deny access', async () => {
  const { data: auth, error: authError } = await signIn(fixture.inactive)
  assert.ifError(authError)
  assert.ok(auth.session)

  const { data: context, error: contextError } = await fixture.inactive.client.rpc('ais_app_context')
  assert.ifError(contextError)
  assert.equal(context, null)

  const { error: dashboardError } = await fixture.inactive.client.rpc('ais_dashboard')
  assert.equal(dashboardError?.code, '42501')
})

test('Admin can stage an incremental import while an inactive technician is denied', async () => {
  const { error: inactiveAuthError } = await signIn(fixture.inactive)
  assert.ifError(inactiveAuthError)
  const denied = await fixture.inactive.client.rpc('ais_incremental_import_stage', {
    p_rows: [{ source_row: 2, location_code: `DENIED-${fixtureTag}`, loc_bld: 'Denied Branch', com_sn: `DENIED-${fixtureTag}` }],
  })
  assert.equal(denied.error?.code, '42501')
  await fixture.inactive.client.auth.signOut()

  const { error: adminAuthError } = await signIn(fixture.admin)
  assert.ifError(adminAuthError)
  const { data, error } = await fixture.admin.client.rpc('ais_incremental_import_stage', {
    p_rows: [{
      source_row: 2,
      location_code: `E2E-${fixtureTag}`,
      loc_bld: 'E2E Branch A',
      province: 'Test Province',
      brand: 'Test Brand',
      model_name: 'Test Model',
      com_sn: 'E2E-SECRET-1234',
      emp_mail: 'must-not-be-staged@example.invalid',
      note: 'must not be staged',
    }],
  })
  assert.ifError(error)
  assert.equal(data.row_count, 1)
  assert.equal(data.branch_count, 1)
  assert.equal(data.issue_count, 0)
  fixture.importBatch = data.batch_id
})
