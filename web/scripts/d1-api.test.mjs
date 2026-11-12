import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('D1 schema file exists and contains valid core tables', () => {
  const schema = readFileSync('d1/schema.sql', 'utf-8')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS branches/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS scanner_assets/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS branch_work_orders/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS replacement_tasks/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS replacement_task_evidence/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS task_reviews/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS google_signin_allowlist/)
  assert.match(schema, /address_note TEXT/)
  assert.match(schema, /phone TEXT/)
  assert.match(schema, /install_type TEXT/)
})

test('D1 allowlist supports customer_reviewer role', () => {
  const schema = readFileSync('d1/schema.sql', 'utf-8')
  assert.match(schema, /customer_reviewer/)
})

test('Task table supports customer review timestamps and direct reject reason', () => {
  const schema = readFileSync('d1/schema.sql', 'utf-8')
  assert.match(schema, /customer_accepted_at TEXT/)
  assert.match(schema, /customer_rejected_at TEXT/)
  assert.match(schema, /customer_reject_reason TEXT/)
  assert.match(schema, /version INTEGER NOT NULL DEFAULT 1/)
})

test('Task reviews audit trail supports sym and customer stages', () => {
  const schema = readFileSync('d1/schema.sql', 'utf-8')
  assert.match(schema, /stage TEXT NOT NULL CHECK \(stage IN \('sym', 'customer'\)\)/)
  assert.match(schema, /decision TEXT NOT NULL CHECK \(decision IN \('pass', 'reject'\)\)/)
})

test('D1 schema supports scanner discovery reports and full lifecycle status', () => {
  const schema = readFileSync('d1/schema.sql', 'utf-8')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS scanner_discovery_reports/)
  assert.match(schema, /'blocked'/)
  assert.match(schema, /'cancelled'/)
})

test('Edge API routes contain discovery, action, and evidence delete endpoints', () => {
  const routeCode = readFileSync('functions/api/[[route]].ts', 'utf-8')
  assert.match(routeCode, /app\.post\('\/discovery'/)
  assert.match(routeCode, /app\.get\('\/discovery\/queue'/)
  assert.match(routeCode, /app\.post\('\/discovery\/:id\/review'/)
  assert.match(routeCode, /app\.post\('\/tasks\/:id\/action'/)
  assert.match(routeCode, /app\.delete\('\/tasks\/:id\/evidence\/:slot'/)
})

test('Edge API routes contain allowlist user management and review audit trail', () => {
  const routeCode = readFileSync('functions/api/[[route]].ts', 'utf-8')
  assert.match(routeCode, /app\.get\('\/tasks\/:id\/reviews'/)
  assert.match(routeCode, /app\.get\('\/allowlist'/)
  assert.match(routeCode, /app\.post\('\/allowlist'/)
  assert.match(routeCode, /app\.post\('\/allowlist\/:id\/toggle'/)
})
