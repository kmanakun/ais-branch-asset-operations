import { normalizeSerialInput, sanitizeCsvCell } from './lib/stock-serial.mjs'
import { maxBatchImportRows, normalizeHeader, openXlsxWorkbook } from './xlsx-core.mjs'

const SERIAL_HEADER_ALIASES = [
  'serialnumber',
  'serialno',
  'serial',
  'sn',
  'comsn',
  'imeisn',
  'serialnum',
  'หมายเลขเครื่อง',
  'ซีเรียล',
]

const stockFieldMap = [
  ['serial_number', SERIAL_HEADER_ALIASES],
  ['brand', ['brand', 'manufacturer', 'mdlbrnd', 'ยี่ห้อ']],
  ['model_name', ['modelname', 'model', 'mdlname', 'partno', 'sku', 'รุ่น']],
  ['lot_no', ['lotno', 'lot', 'ponumber', 'po', 'do', 'invoice', 'refno', 'เลขล็อต', 'ใบส่งของ', 'เอกสาร']],
  ['dispatch_area', ['location', 'warehouse', 'area', 'region', 'ro', 'team', 'destination', 'dispatcharea', 'ปลายทาง', 'พื้นที่']],
  ['received_date', ['receiveddate', 'receivedate', 'date', 'วันที่รับเข้า']],
  ['note', ['remark', 'note', 'comment', 'หมายเหตุ']],
]

export const STOCK_IMPORT_TEMPLATE_HEADERS = [
  'Serial Number',
  'Brand',
  'Model Name',
  'Lot / PO',
  'Location / Area',
  'Received Date',
  'Remark',
]

const normalizedSerialAliasSet = new Set(SERIAL_HEADER_ALIASES.map(normalizeHeader))

/**
 * Normalizes supplier receipt dates across ISO strings, DD/MM/YYYY (including Buddhist Era
 * years >= 2400), and Excel numeric serial date values.
 */
export function normalizeExcelDate(rawValue) {
  const text = String(rawValue ?? '').trim()
  if (!text) return null

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text
  }

  const slashMatch = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (slashMatch) {
    const day = Number(slashMatch[1])
    const month = Number(slashMatch[2])
    let year = Number(slashMatch[3])
    if (year >= 2400) year -= 543
    if (year >= 1990 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
    return text
  }

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const excelSerial = Number(text)
    if (Number.isFinite(excelSerial) && excelSerial >= 20_000 && excelSerial <= 80_000) {
      const utcMs = Math.round((excelSerial - 25_569) * 86_400 * 1000)
      return new Date(utcMs).toISOString().slice(0, 10)
    }
  }

  return text
}

/**
 * Parses a Supplier new-scanner stock `.xlsx` workbook by locating the first worksheet
 * that exposes a Serial Number header row and normalizing all supported optional columns.
 */
export async function parseStockWorkbook(file) {
  const { sheets, readSheetRows } = await openXlsxWorkbook(file)
  if (!sheets.length) throw new Error('ไม่พบชีตข้อมูลในไฟล์ Excel')

  let matchedSheetName = null
  let matchedRawRows = null
  let headerRow = null
  let headerRowIndex = -1

  for (const sheet of sheets) {
    if (!sheet.path) continue
    const rawRows = await readSheetRows(sheet.path)
    if (!rawRows || !rawRows.length) continue
    const idx = rawRows.findIndex(row => row.cells.some(value => normalizedSerialAliasSet.has(normalizeHeader(value))))
    if (idx >= 0) {
      matchedSheetName = sheet.name
      matchedRawRows = rawRows
      headerRow = rawRows[idx]
      headerRowIndex = idx
      break
    }
  }

  if (!matchedRawRows || !headerRow) {
    throw new Error('ไม่พบหัวคอลัมน์ Serial Number (เช่น Serial Number, SN, ComSN) ในไฟล์ Excel')
  }

  const headerIndices = new Map()
  headerRow.cells.forEach((value, index) => {
    const key = normalizeHeader(value)
    if (key && !headerIndices.has(key)) {
      headerIndices.set(key, index)
    }
  })

  const columns = stockFieldMap.map(([field, names]) => {
    const index = names.map(normalizeHeader).map(name => headerIndices.get(name)).find(value => value !== undefined)
    return [field, index]
  })

  const dataRows = matchedRawRows
    .map((row, idx) => ({ row, effectiveRowNumber: row.rowNumber > 0 ? row.rowNumber : idx + 1, idx }))
    .filter(({ row, idx }) => (headerRow.rowNumber > 0 ? row.rowNumber > headerRow.rowNumber : idx > headerRowIndex))
    .map(({ row, effectiveRowNumber }) => {
      const data = { source_row: effectiveRowNumber }
      for (const [field, index] of columns) {
        if (index === undefined) continue
        const rawCell = row.cells[index]
        if (field === 'serial_number') {
          const sn = normalizeSerialInput(rawCell)
          data[field] = sn || null
        } else if (field === 'received_date') {
          data[field] = normalizeExcelDate(rawCell)
        } else {
          const text = String(rawCell ?? '').trim()
          data[field] = text || null
        }
      }
      return data
    })
    .filter(row => row.serial_number || row.brand || row.model_name || row.lot_no || row.dispatch_area || row.note)

  if (!dataRows.length) {
    throw new Error(`ชีต ${matchedSheetName || 'Stock'} ไม่มีแถวข้อมูล`)
  }
  if (dataRows.length > maxBatchImportRows) {
    throw new Error('ไฟล์มีข้อมูลเกิน 5,000 แถวต่อชุด')
  }

  return {
    sheet_name: matchedSheetName || 'Sheet1',
    rows: dataRows,
  }
}

/**
 * Generates a UTF-8 BOM formula-safe CSV template for Supplier stock receiving.
 */
export function buildStockTemplateCsv() {
  const lines = [
    STOCK_IMPORT_TEMPLATE_HEADERS.map(sanitizeCsvCell).join(','),
    ['SN-SUPPLIER-0001', 'Zebra', 'DS9308', 'PO-2026-11-01', 'คลังกลาง SYM', '2026-11-14', 'ตัวอย่างรายการ (ลบแถวนี้ก่อนนำเข้าจริง)'].map(sanitizeCsvCell).join(','),
  ]
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
