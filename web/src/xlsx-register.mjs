import { maxBatchImportRows, normalizeHeader, openXlsxWorkbook } from './xlsx-core.mjs'

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

export async function parseRegisterWorkbook(file) {
  const { sheets, readSheetRows } = await openXlsxWorkbook(file)

  const sheet = sheets.find(entry => entry.name === 'Detail1')
  if (!sheet) throw new Error('ไม่พบชีต Detail1 ในไฟล์')
  if (!sheet.path) throw new Error('ไม่พบข้อมูลชีต Detail1')
  const rawRows = await readSheetRows(sheet.path)
  if (!rawRows) throw new Error('เปิดข้อมูลชีต Detail1 ไม่สำเร็จ')

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
  if (rows.length > maxBatchImportRows) throw new Error('ไฟล์มีข้อมูลเกิน 5,000 แถวต่อชุด')
  return rows
}
