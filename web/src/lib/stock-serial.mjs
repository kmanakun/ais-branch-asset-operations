export const MAX_STOCK_SERIAL_LENGTH = 100

const INVISIBLE_SERIAL_CHARS = /[\u200B-\u200D\uFEFF\u00A0]/g
const CONTROL_CHARS = /[\x00-\x1F\x7F]/
const SCIENTIFIC_NOTATION_RE = /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i
const FLOAT_ZERO_SUFFIX_RE = /^\d+\.0+$/

/**
 * Strips invisible zero-width/BOM/NBSP artifacts from barcode scanner or Excel cells
 * while preserving the meaningful characters of a hardware serial number.
 */
export function normalizeSerialInput(value) {
  return String(value ?? '').replace(INVISIBLE_SERIAL_CHARS, '').trim()
}

/**
 * Validates that a serial number is safe, bounded, and free from common
 * Excel corruption (scientific notation or trailing .0 float conversion).
 */
export function validateSerialFormat(rawValue) {
  const serial = normalizeSerialInput(rawValue)
  if (!serial) {
    return { valid: false, serial: '', reason: 'Serial Number ว่างเปล่า' }
  }
  if (CONTROL_CHARS.test(serial)) {
    return { valid: false, serial, reason: 'Serial Number มีอักขระควบคุมหรือขึ้นบรรทัดใหม่ที่ไม่รองรับ' }
  }
  if (serial.length > MAX_STOCK_SERIAL_LENGTH) {
    return { valid: false, serial, reason: `Serial Number ยาวเกิน ${MAX_STOCK_SERIAL_LENGTH} ตัวอักษร` }
  }
  if (SCIENTIFIC_NOTATION_RE.test(serial)) {
    return {
      valid: false,
      serial,
      reason: `พบเลข Serial เพี้ยนเป็นรูปแบบวิทยาศาสตร์จาก Excel (${serial}) กรุณาจัดรูปแบบคอลัมน์เป็น Text ก่อนบันทึกไฟล์`,
    }
  }
  if (FLOAT_ZERO_SUFFIX_RE.test(serial)) {
    return {
      valid: false,
      serial,
      reason: `พบเลข Serial ติดทศนิยม .0 จาก Excel (${serial}) กรุณาจัดรูปแบบคอลัมน์เป็น Text ก่อนบันทึกไฟล์`,
    }
  }
  return { valid: true, serial, reason: null }
}

/**
 * Masks sensitive full serial numbers for read-only viewer accounts while keeping
 * enough prefix/suffix characters for audit correlation.
 */
export function maskSerialForViewer(serialValue) {
  const sn = normalizeSerialInput(serialValue)
  if (!sn) return ''
  if (sn.length <= 4) return '****'
  if (sn.length <= 7) return `${sn.slice(0, 1)}***${sn.slice(-2)}`
  return `${sn.slice(0, 2)}***${sn.slice(-4)}`
}

/**
 * Escapes CSV cell values and neutralizes formula injection prefixes (=, +, -, @, tab, cr).
 */
export function sanitizeCsvCell(value) {
  let text = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`
  }
  return text
}
