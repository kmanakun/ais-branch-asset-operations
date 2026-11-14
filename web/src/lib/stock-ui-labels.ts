import { normalizeSerialInput, sanitizeCsvCell } from './stock-serial.mjs'

export type StockBadgeTone = 'done' | 'progress' | 'warning' | 'destructive' | 'neutral'

export const STOCK_STATUS_META: Record<string, { label: string; tone: StockBadgeTone }> = {
  in_warehouse: { label: 'อยู่ในคลังกลาง', tone: 'done' },
  dispatched: { label: 'เบิกออกพื้นที่', tone: 'progress' },
  allocated_to_task: { label: 'จองใช้งานหน้างาน', tone: 'warning' },
  installed: { label: 'ติดตั้งตรวจรับแล้ว', tone: 'done' },
  doa_defective: { label: 'แจ้งเสีย (DOA)', tone: 'destructive' },
  void_hybrid: { label: 'ยกเลิก Hybrid', tone: 'neutral' },
  removed_onsite: { label: 'ถอดหน้างาน (รอส่งคืน)', tone: 'warning' },
  returned_to_warehouse: { label: 'รับซากเข้าคลังแล้ว', tone: 'progress' },
  handed_over_to_customer: { label: 'ส่งมอบซากคืนลูกค้าแล้ว', tone: 'done' },
  cancelled_restored: { label: 'ยกเลิกงาน/คืนสถานะ', tone: 'neutral' },
}

export const STOCK_SOURCE_MODE_LABELS: Record<string, string> = {
  registered_stock: 'รับเข้าคลังจาก Supplier',
  hybrid_unregistered: 'Hybrid (รอนำเข้า Supplier)',
  onsite_removal: 'ถอดจากสาขาหน้างาน',
}

export const STOCK_DOC_TYPE_META: Record<string, { label: string; prefix: string; tone: StockBadgeTone }> = {
  receive: { label: 'ใบรับเข้าสต็อก (RCV)', prefix: 'RCV', tone: 'done' },
  dispatch: { label: 'ใบเบิกกระจายพื้นที่ (DSP)', prefix: 'DSP', tone: 'progress' },
  return_in: { label: 'ใบรับซากเข้าคลัง (RET)', prefix: 'RET', tone: 'warning' },
  handover_out: { label: 'ใบส่งมอบซากคืนลูกค้า (HOV)', prefix: 'HOV', tone: 'done' },
  doa_claim: { label: 'ใบแจ้งเครื่องเสีย DOA', prefix: 'DOA', tone: 'destructive' },
  adjustment: { label: 'ใบปรับปรุง / ดึงกลับคลัง (ADJ)', prefix: 'ADJ', tone: 'neutral' },
}

export const STOCK_ACTION_LABELS: Record<string, string> = {
  received: 'รับเข้าคลัง',
  reconciled_hybrid: 'จับคู่ Hybrid กับไฟล์ Supplier',
  dispatched: 'เบิกกระจายออกพื้นที่',
  allocated_to_task: 'จองใช้งานกับใบงาน',
  installed: 'ตรวจรับติดตั้งสำเร็จ',
  review_rejected: 'ถูกปฏิเสธงาน (คงจอง SN เดิม)',
  released_from_task: 'ปล่อยคืนจากใบงาน (สลับเครื่อง)',
  marked_doa: 'แจ้งเครื่องใหม่เสีย (DOA)',
  voided_hybrid: 'ยกเลิก Hybrid (ป้องกัน Ghost Stock)',
  removed_onsite: 'ถอดเครื่องเดิมออกจากสาขา',
  returned_to_warehouse: 'รับซากเข้าคลัง SYM',
  handed_over_to_customer: 'ส่งมอบซากคืนลูกค้า AIS / G-Able',
  cancelled_restored: 'ยกเลิกงานและคืนสถานะ',
  adjusted: 'ดึงเครื่องกลับคลัง / ปรับปรุง',
}

export function getStockStatusMeta(status?: string | null): { label: string; tone: StockBadgeTone } {
  if (!status) return { label: 'ไม่ระบุ', tone: 'neutral' }
  return STOCK_STATUS_META[status] || { label: status, tone: 'neutral' }
}

export function getStockActionLabel(action?: string | null): string {
  if (!action) return 'ไม่ระบุ'
  return STOCK_ACTION_LABELS[action] || action
}

export function formatStockDate(value?: string | null): string {
  if (!value) return '—'
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(date)
}

/**
 * Splits multi-line, comma-separated, or whitespace-separated barcode input
 * into deduplicated, normalized serial numbers preserving first-seen order.
 */
export function parseBatchSerialText(raw: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of String(raw || '').split(/[\r\n,;]+/)) {
    const clean = normalizeSerialInput(part)
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    result.push(clean)
  }
  return result
}

export function appendSerialToBatchText(currentText: string, newSerial: string): { nextText: string; added: boolean } {
  const clean = normalizeSerialInput(newSerial)
  if (!clean) return { nextText: currentText, added: false }
  const existing = parseBatchSerialText(currentText)
  if (existing.includes(clean)) {
    return { nextText: currentText, added: false }
  }
  const merged = [...existing, clean]
  return { nextText: merged.join('\n'), added: true }
}

export function downloadStockCsv(filename: string, headers: string[], rows: Array<Array<unknown>>): void {
  const csvLines = [headers.map(h => sanitizeCsvCell(h)).join(',')]
  for (const row of rows) {
    csvLines.push(row.map(cell => sanitizeCsvCell(cell)).join(','))
  }
  const blob = new Blob([`\uFEFF${csvLines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
