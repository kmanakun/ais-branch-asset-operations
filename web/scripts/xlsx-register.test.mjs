import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import test from 'node:test'
import { parseRegisterWorkbook } from '../src/xlsx-register.mjs'
import { buildStockTemplateCsv, normalizeExcelDate, parseStockWorkbook } from '../src/xlsx-stock.mjs'
import { maskSerialForViewer, sanitizeCsvCell, validateSerialFormat } from '../src/lib/stock-serial.mjs'

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

test('parseStockWorkbook supports single-column SN Sheet1 without requiring Detail1', async () => {
  const entries = [
    ['xl/workbook.xml', '<workbook xmlns:r="urn:relationships"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    [
      'xl/worksheets/sheet1.xml',
      `<worksheet><sheetData><row r="1">${cell('A1', 'SN')}</row><row r="2">${cell('A2', '\u200BSN-ONLY-001\u00A0')}</row><row r="3">${cell('A3', 'SN-ONLY-002')}</row></sheetData></worksheet>`,
    ],
  ]
  const parsed = await parseStockWorkbook(makeFile(entries))
  assert.equal(parsed.sheet_name, 'Sheet1')
  assert.deepEqual(parsed.rows, [
    { source_row: 2, serial_number: 'SN-ONLY-001' },
    { source_row: 3, serial_number: 'SN-ONLY-002' },
  ])
})

test('parseStockWorkbook scans past cover sheets and parses optional stock columns + Buddhist dates', async () => {
  const entries = [
    [
      'xl/workbook.xml',
      '<workbook xmlns:r="urn:relationships"><sheets><sheet name="Summary" r:id="rId1"/><sheet name="DeliveryStock" r:id="rId2"/></sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<worksheet><sheetData><row r="1">${cell('A1', 'Supplier Cover Page')}</row></sheetData></worksheet>`,
    ],
    [
      'xl/worksheets/sheet2.xml',
      `<worksheet><sheetData>
        <row r="1">${cell('A1', 'Serial Number')}${cell('B1', 'ยี่ห้อ')}${cell('C1', 'Model')}${cell('D1', 'PO')}${cell('E1', 'พื้นที่')}${cell('F1', 'วันที่รับเข้า')}${cell('G1', 'หมายเหตุ')}${cell('H1', 'ExtraIgnoredCol')}</row>
        <row r="2">${cell('A2', 'ZEBRA-9308-01')}${cell('B2', 'Zebra')}${cell('C2', 'DS9308')}${cell('D2', 'PO-2026-88')}${cell('E2', 'ภาคเหนือ')}${cell('F2', '14/11/2569')}${cell('G2', 'ล็อตแรก')}${cell('H2', '9999')}</row>
      </sheetData></worksheet>`,
    ],
  ]
  const parsed = await parseStockWorkbook(makeFile(entries))
  assert.equal(parsed.sheet_name, 'DeliveryStock')
  assert.deepEqual(parsed.rows, [
    {
      source_row: 2,
      serial_number: 'ZEBRA-9308-01',
      brand: 'Zebra',
      model_name: 'DS9308',
      lot_no: 'PO-2026-88',
      dispatch_area: 'ภาคเหนือ',
      received_date: '2026-11-14',
      note: 'ล็อตแรก',
    },
  ])
  assert.equal(normalizeExcelDate('46340'), '2026-11-14')
})

test('parseStockWorkbook enforces zip bomb coordinate bounds and rejects missing SN header', async () => {
  const noSnEntries = [
    ['xl/workbook.xml', '<workbook xmlns:r="urn:relationships"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1">${cell('A1', 'Model')}${cell('B1', 'Qty')}</row></sheetData></worksheet>`],
  ]
  await assert.rejects(parseStockWorkbook(makeFile(noSnEntries)), /ไม่พบหัวคอลัมน์ Serial Number/)

  const badCoordEntries = [
    ['xl/workbook.xml', '<workbook xmlns:r="urn:relationships"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1">${cell('XFE1', 'SN')}</row></sheetData></worksheet>`],
  ]
  await assert.rejects(parseStockWorkbook(makeFile(badCoordEntries)), /หมายเลขคอลัมน์เกินขอบเขต/)
})

test('stock serial validator detects scientific notation, float suffix, masks viewer SN, and prevents CSV injection', () => {
  assert.equal(validateSerialFormat('2.31455E+14').valid, false)
  assert.equal(validateSerialFormat('123456789012.0').valid, false)
  assert.equal(validateSerialFormat('SN\nINJECT').valid, false)
  assert.deepEqual(validateSerialFormat('\uFEFF ZEBRA-001 '), {
    valid: true,
    serial: 'ZEBRA-001',
    reason: null,
  })
  assert.equal(maskSerialForViewer('ZEBRA-9308-0012'), 'ZE***0012')
  assert.equal(maskSerialForViewer('1234'), '****')
  assert.equal(sanitizeCsvCell('=1+1'), "'=1+1")
  assert.equal(sanitizeCsvCell('=CMD("calc")'), '"\'=CMD(""calc"")"')
  assert.ok(buildStockTemplateCsv().startsWith('\uFEFFSerial Number,'))
})
