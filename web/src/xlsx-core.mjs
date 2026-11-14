const decoder = new TextDecoder()

export const maxEntryBytes = 32 * 1024 * 1024
export const maxArchiveBytes = 80 * 1024 * 1024
export const maxColumns = 16_384
export const maxRows = 1_048_576
export const maxWorkbookFileBytes = 20 * 1024 * 1024
export const maxBatchImportRows = 5000

export function attribute(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return xml.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`))?.[1] ?? null
}

export function xmlText(value) {
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

export function xmlItems(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...xml.matchAll(new RegExp(`<${escaped}\\b([^>]*)>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'g'))]
}

export function xmlTagAttributes(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...xml.matchAll(new RegExp(`<${escaped}\\b([^>]*?)(?:\\s*\\/?>)`, 'g'))].map(match => match[1])
}

/**
 * Reads ZIP central directory entries and guards against zip bombs by bounding
 * archive entry count, declared sizes, and actual decompressed byte expansion.
 */
export function readZipEntries(buffer) {
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
  let declaredExpandedBytes = 0
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
    declaredExpandedBytes += uncompressedSize
    if (uncompressedSize > maxEntryBytes || declaredExpandedBytes > maxArchiveBytes) {
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

export function columnIndex(reference) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(reference)
  if (!match) throw new Error('ไฟล์ Excel มีตำแหน่งเซลล์ไม่ถูกต้อง')
  const [, letters, rowText] = match
  if (Number(rowText) > maxRows) throw new Error('ไฟล์ Excel มีหมายเลขแถวเกินขอบเขต')
  let result = 0
  for (const letter of letters.toUpperCase()) result = result * 26 + letter.charCodeAt(0) - 64
  if (result > maxColumns) throw new Error('ไฟล์ Excel มีหมายเลขคอลัมน์เกินขอบเขต')
  return result - 1
}

export function cellValue(cell, sharedStrings) {
  const type = attribute(cell.attributes, 't')
  if (type === 'inlineStr') return xmlText(cell.content.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] ?? '')
  const value = xmlText(cell.content.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? '')
  if (type === 's') return sharedStrings[Number(value)] ?? ''
  return value
}

export function normalizeHeader(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_./\\-]/g, '')
}

export async function openXlsxWorkbook(file) {
  if (!file || !/\.xlsx$/i.test(file.name)) throw new Error('เลือกไฟล์ .xlsx เท่านั้น')
  if (file.size > maxWorkbookFileBytes) throw new Error('ไฟล์ใหญ่เกิน 20 MB')
  const readZip = readZipEntries(await file.arrayBuffer())
  const workbookText = await readZip('xl/workbook.xml')
  const relationText = await readZip('xl/_rels/workbook.xml.rels')
  if (!workbookText || !relationText) throw new Error('ไม่พบโครงสร้างสมุดงาน Excel')

  const relations = new Map(
    xmlTagAttributes(relationText, 'Relationship').map(attrs => [attribute(attrs, 'Id'), attribute(attrs, 'Target')])
  )
  const sheets = xmlTagAttributes(workbookText, 'sheet').map(attrs => {
    const name = attribute(attrs, 'name') || 'Sheet'
    const relationId = attribute(attrs, 'r:id')
    const target = relationId ? relations.get(relationId) : null
    const path = target
      ? (target.startsWith('/') ? target.slice(1) : target.startsWith('xl/') ? target : `xl/${target}`)
      : null
    return { name, path }
  })

  const stringsText = await readZip('xl/sharedStrings.xml')
  const sharedStrings = stringsText
    ? xmlItems(stringsText, 'si').map(([, , item]) => [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(text => xmlText(text[1])).join(''))
    : []

  async function readSheetRows(sheetPath) {
    const sheetText = await readZip(sheetPath)
    if (!sheetText) return null
    const sheetData = sheetText.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/)?.[1] ?? ''
    return xmlItems(sheetData, 'row').map(([, attributes, contents]) => {
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
  }

  return { sheets, readSheetRows }
}
