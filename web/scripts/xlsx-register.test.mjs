import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import test from 'node:test'
import { parseRegisterWorkbook } from '../src/xlsx-register.mjs'

function u16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value)
  return buffer
}

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

function createZip(entries) {
  const localParts = []
  const centralParts = []
  let localOffset = 0

  for (const [name, source, options = {}] of entries) {
    const filename = Buffer.from(name)
    const original = Buffer.from(source)
    const method = options.method ?? 0
    const compressed = method === 8 ? deflateRawSync(original) : original
    const declaredSize = options.declaredSize ?? original.byteLength
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0),
      u32(compressed.byteLength), u32(declaredSize), u16(filename.byteLength), u16(0), filename, compressed,
    ])
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0),
      u32(compressed.byteLength), u32(declaredSize), u16(filename.byteLength), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(localOffset), filename,
    ])
    localParts.push(local)
    centralParts.push(central)
    localOffset += local.byteLength
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralDirectory.byteLength), u32(localOffset), u16(0),
  ])
  return Buffer.concat([...localParts, centralDirectory, end])
}

function makeFile(entries) {
  const buffer = createZip(entries)
  return {
    name: 'scanner-register.xlsx',
    size: buffer.byteLength,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  }
}

function workbookEntries(sheetRows) {
  return [
    ['xl/workbook.xml', '<workbook xmlns:r="urn:relationships"><sheets><sheet name="Detail1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`],
  ]
}

function cell(reference, value) {
  return `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`
}

const header = `<row r="1">${cell('A1', 'LocationCode')}${cell('B1', 'LocBld')}${cell('C1', 'ComSN')}</row>`

test('parses the required Scanner register columns from Detail1', async () => {
  const file = makeFile(workbookEntries(`${header}<row r="2">${cell('A2', '1204')}${cell('B2', 'Central Surat Thani')}${cell('C2', 'SCAN-0001')}</row>`))
  assert.deepEqual(await parseRegisterWorkbook(file), [
    { source_row: 2, location_code: '1204', loc_bld: 'Central Surat Thani', com_sn: 'SCAN-0001' },
  ])
})

test('parses optional installation type, phone, and address note columns', async () => {
  const fullHeader = `<row r="1">${cell('A1', 'LocationCode')}${cell('B1', 'LocBld')}${cell('C1', 'ComSN')}${cell('D1', 'การติดตั้ง')}${cell('E1', 'หมายเหตุการแยกที่อยู่')}${cell('F1', 'เบอร์โทร')}</row>`
  const file = makeFile(workbookEntries(`${fullHeader}<row r="2">${cell('A2', '30149')}${cell('B2', 'Robinson ลาดกระบัง')}${cell('C2', 'G18EA0248')}${cell('D2', 'ส่งของและติดตั้ง')}${cell('E2', 'ไม่มีรหัสไปรษณีย์ในที่อยู่')}${cell('F2', '02-1234567')}</row>`))
  assert.deepEqual(await parseRegisterWorkbook(file), [
    {
      source_row: 2,
      location_code: '30149',
      loc_bld: 'Robinson ลาดกระบัง',
      com_sn: 'G18EA0248',
      install_type: 'ส่งของและติดตั้ง',
      address_note: 'ไม่มีรหัสไปรษณีย์ในที่อยู่',
      phone: '02-1234567',
    },
  ])
})

test('rejects cell coordinates beyond Excel column limits', async () => {
  const file = makeFile(workbookEntries(`${header}<row r="2">${cell('XFE2', 'oversized column')}</row>`))
  await assert.rejects(parseRegisterWorkbook(file), /หมายเลขคอลัมน์เกินขอบเขต/)
})

test('rejects row numbers beyond Excel limits', async () => {
  const file = makeFile(workbookEntries(`${header}<row r="1048577">${cell('A1048577', 'oversized row')}</row>`))
  await assert.rejects(parseRegisterWorkbook(file), /หมายเลขแถวเกินขอบเขต/)
})

test('stops decompression when a ZIP entry expands beyond its declared size', async () => {
  const entries = workbookEntries(header)
  entries[0] = ['xl/workbook.xml', entries[0][1], { method: 8, declaredSize: 1 }]
  const file = makeFile(entries)
  await assert.rejects(parseRegisterWorkbook(file), /มีขนาดใหญ่เกินกำหนดหรือไม่ตรงกับขนาดที่แจ้ง/)
})

test('normalizes lowercase Excel cell column references', async () => {
  const file = makeFile(workbookEntries(`${header}<row r="2">${cell('a2', '1204')}${cell('b2', 'Central Surat Thani')}${cell('c2', 'SCAN-0001')}</row>`))
  assert.deepEqual(await parseRegisterWorkbook(file), [
    { source_row: 2, location_code: '1204', loc_bld: 'Central Surat Thani', com_sn: 'SCAN-0001' },
  ])
})
