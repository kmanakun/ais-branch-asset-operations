const decoder = new TextDecoder()
const maxEntryBytes = 32 * 1024 * 1024
const maxArchiveBytes = 80 * 1024 * 1024
const maxColumns = 16_384
const maxRows = 1_048_576

function attribute(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return xml.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`))?.[1] ?? null
}

function xmlText(value) {
  return value.replace(/<[^>]+>/g, '').replace(/&(#x[\da-f]+|#\d+|lt|gt|amp|quot|apos);/gi, entity => {
    const key = entity.slice(1, -1).toLowerCase()
    if (key === 'lt') return '<'
    if (key === 'gt') return '>'
    if (key === 'amp') return '&'
    if (key === 'quot') return '"'
    if (key === 'apos') return "'"
    const point = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10)
    return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : ''
  })
}

function xmlItems(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...xml.matchAll(new RegExp(`<${escaped}\\b([^>]*)>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'g'))]
}

function xmlTagAttributes(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...xml.matchAll(new RegExp(`<${escaped}\\b([^>]*?)(?:\\s*\\/?>)`, 'g'))].map(match => match[1])
}

function readZipEntries(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const minOffset = Math.max(0, bytes.length - 65_557)
  let endOffset = -1
  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) throw new Error('ไฟล์นี้ไม่ใช่ Excel .xlsx ที่อ่านได้')

  const count = view.getUint16(endOffset + 10, true)
  if (count > 10_000) throw new Error('ไฟล์ Excel มีองค์ประกอบมากเกินไป')
  const directoryOffset = view.getUint32(endOffset + 16, true)
  const entries = new Map()
  let expandedBytes = 0
  let offset = directoryOffset
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('โครงสร้างไฟล์ Excel ไม่สมบูรณ์')
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    expandedBytes += uncompressedSize
    if (uncompressedSize > maxEntryBytes || expandedBytes > maxArchiveBytes) {
      throw new Error('ข้อมูลภายในไฟล์ Excel มีขนาดใหญ่เกินกำหนด')
    }
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }

  let actualExpandedBytes = 0
  return async (name) => {
    const entry = entries.get(name)
    if (!entry) return null
    const local = entry.localOffset
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error('ไฟล์ Excel มีรายการข้อมูลที่อ่านไม่ได้')
    const nameLength = view.getUint16(local + 26, true)
    const extraLength = view.getUint16(local + 28, true)
    const start = local + 30 + nameLength + extraLength
    const compressed = bytes.subarray(start, start + entry.compressedSize)
    if (entry.method === 0) {
      if (compressed.byteLength !== entry.uncompressedSize) throw new Error('ข้อมูลภายในไฟล์ Excel ไม่ครบถ้วน')
      actualExpandedBytes += compressed.byteLength
      if (actualExpandedBytes > maxArchiveBytes) throw new Error('ข้อมูลภายในไฟล์ Excel มีขนาดใหญ่เกินกำหนด')
      return decoder.decode(compressed)
    }
    if (entry.method !== 8 || typeof DecompressionStream === 'undefined') {
      throw new Error('เบราว์เซอร์นี้ไม่รองรับการอ่านไฟล์ Excel ชนิดนี้')
    }
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    const reader = stream.getReader()
    const chunks = []
    let expandedBytes = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        expandedBytes += value.byteLength
        if (expandedBytes > entry.uncompressedSize || expandedBytes > maxEntryBytes || actualExpandedBytes + expandedBytes > maxArchiveBytes) {
          await reader.cancel().catch(() => {})
          throw new Error('ข้อมูลภายในไฟล์ Excel มีขนาดใหญ่เกินกำหนดหรือไม่ตรงกับขนาดที่แจ้ง')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    if (expandedBytes !== entry.uncompressedSize) throw new Error('ข้อมูลภายในไฟล์ Excel ไม่ครบถ้วน')
    const expanded = new Uint8Array(expandedBytes)
    let cursor = 0
    for (const chunk of chunks) {
      expanded.set(chunk, cursor)
      cursor += chunk.byteLength
    }
    actualExpandedBytes += expandedBytes
    return decoder.decode(expanded)
  }
}

function columnIndex(reference) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(reference)
  if (!match) throw new Error('ไฟล์ Excel มีตำแหน่งเซลล์ไม่ถูกต้อง')
  const [, letters, rowText] = match
  if (Number(rowText) > maxRows) throw new Error('ไฟล์ Excel มีหมายเลขแถวเกินขอบเขต')
  let result = 0
  for (const letter of letters.toUpperCase()) result = result * 26 + letter.charCodeAt(0) - 64
  if (result > maxColumns) throw new Error('ไฟล์ Excel มีหมายเลขคอลัมน์เกินขอบเขต')
  return result - 1
}

function cellValue(cell, sharedStrings) {
  const type = attribute(cell.attributes, 't')
  if (type === 'inlineStr') return xmlText(cell.content.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] ?? '')
  const value = xmlText(cell.content.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? '')
  if (type === 's') return sharedStrings[Number(value)] ?? ''
  return value
}

const fieldMap = [
  ['location_code', ['locationcode']],
  ['subs_zn', ['subs zn', 'subs_zn', 'subs zn.'].map(value => value.replaceAll(' ', ''))],
  ['loc_bld', ['locbld']],
  ['address', ['address', 'ที่อยู่']],
  ['province', ['province', 'จังหวัด']],
  ['district', ['district', 'เขต/อำเภอ']],
  ['subdistrict', ['subdistrict', 'แขวง/ตำบล']],
  ['postal_code', ['postalcode', 'zipcode', 'postcode', 'รหัสไปรษณีย์']],
  ['ro', ['ro']],
  ['high_level_location', ['highlevellocation']],
  ['hw_name', ['hwname']],
  ['brand', ['brand', 'mdlbrnd']],
  ['model_name', ['modelname', 'mdlname']],
  ['com_id', ['comid']],
  ['com_sn', ['comsn']],
  ['model_id', ['modelid', 'mdlid']],
  ['com_years', ['comyrs', 'comyears']],
  ['phone', ['phone', 'telephone', 'mobile', 'เบอร์โทร', 'เบอร์ติดต่อ']],
  ['install_type', ['installtype', 'การติดตั้ง']],
  ['address_note', ['addressnote', 'หมายเหตุการแยกที่อยู่']],
]

function normalizeHeader(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_./\\-]/g, '')
}

export async function parseRegisterWorkbook(file) {
  if (!file || !/\.xlsx$/i.test(file.name)) throw new Error('เลือกไฟล์ .xlsx เท่านั้น')
  if (file.size > 20 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 20 MB')
  const readZip = readZipEntries(await file.arrayBuffer())
  const workbookText = await readZip('xl/workbook.xml')
  const relationText = await readZip('xl/_rels/workbook.xml.rels')
  if (!workbookText || !relationText) throw new Error('ไม่พบโครงสร้างสมุดงาน Excel')

  const sheets = xmlTagAttributes(workbookText, 'sheet')
  const sheet = sheets.find(attributes => attribute(attributes, 'name') === 'Detail1')
  if (!sheet) throw new Error('ไม่พบชีต Detail1 ในไฟล์')
  const relationId = attribute(sheet, 'r:id')
  const relation = xmlTagAttributes(relationText, 'Relationship')
    .find(attributes => attribute(attributes, 'Id') === relationId)
  const target = relation ? attribute(relation, 'Target') : null
  if (!target) throw new Error('ไม่พบข้อมูลชีต Detail1')
  const sheetPath = target.startsWith('/') ? target.slice(1) : target.startsWith('xl/') ? target : `xl/${target}`
  const sheetText = await readZip(sheetPath)
  if (!sheetText) throw new Error('เปิดข้อมูลชีต Detail1 ไม่สำเร็จ')

  const stringsText = await readZip('xl/sharedStrings.xml')
  const sharedStrings = stringsText
    ? xmlItems(stringsText, 'si').map(([, , item]) => [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(text => xmlText(text[1])).join(''))
    : []
  const sheetData = sheetText.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/)?.[1] ?? ''
  const rawRows = xmlItems(sheetData, 'row').map(([, attributes, contents]) => {
    const rawRowNumber = attribute(attributes, 'r')
    const parsedRowNumber = rawRowNumber ? Number(rawRowNumber) : 0
    if (rawRowNumber && (!Number.isSafeInteger(parsedRowNumber) || parsedRowNumber < 1 || parsedRowNumber > maxRows)) {
      throw new Error('ไฟล์ Excel มีหมายเลขแถวเกินขอบเขต')
    }
    const cells = []
    for (const match of contents.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c\s*>)/g)) {
      const cell = { attributes: match[1], content: match[2] ?? '' }
      const index = columnIndex(attribute(cell.attributes, 'r') ?? '')
      if (index >= 0) cells[index] = cellValue(cell, sharedStrings)
    }
    return { rowNumber: parsedRowNumber || 0, cells }
  }).filter(row => row.cells.some(value => String(value ?? '').trim() !== ''))

  const headerRow = rawRows.find(row => row.cells.some(value => normalizeHeader(value) === 'locationcode'))
  if (!headerRow) throw new Error('ไม่พบหัวคอลัมน์ LocationCode ในชีต Detail1')
  const headerIndices = new Map(headerRow.cells.map((value, index) => [normalizeHeader(value), index]))
  const columns = fieldMap.map(([field, names]) => {
    const index = names.map(normalizeHeader).map(name => headerIndices.get(name)).find(value => value !== undefined)
    return [field, index]
  })
  const missing = ['location_code', 'loc_bld', 'com_sn'].filter(field => columns.find(([name]) => name === field)?.[1] === undefined)
  if (missing.length) throw new Error('ไฟล์ขาดคอลัมน์จำเป็น: ' + missing.join(', '))

  const rows = rawRows.filter(row => row.rowNumber > headerRow.rowNumber).map(row => {
    const data = { source_row: row.rowNumber }
    for (const [field, index] of columns) {
      if (index === undefined) continue
      const value = String(row.cells[index] ?? '').trim()
      data[field] = value || null
    }
    if (data.location_code) data.location_code = data.location_code.replace(/\s+/g, ' ')
    if (data.loc_bld) data.loc_bld = data.loc_bld.replace(/\s+/g, ' ')
    if (data.com_sn) data.com_sn = data.com_sn.trim()
    return data
  }).filter(row => row.location_code || row.loc_bld || row.com_sn)

  if (!rows.length) throw new Error('ชีต Detail1 ไม่มีแถวข้อมูล')
  if (rows.length > 5000) throw new Error('ไฟล์มีข้อมูลเกิน 5,000 แถวต่อชุด')
  return rows
}
