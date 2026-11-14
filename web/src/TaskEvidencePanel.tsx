import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { AlertCircle, Check, ImagePlus, LoaderCircle, RotateCcw, Save, Trash2 } from 'lucide-react'
import { d1Api } from './d1-client'

const OLD_DEVICE_SLOTS = [
  { key: 'old_serial_photo', num: '1', label: 'SN เครื่องเก่า', hint: 'ถ่ายฉลาก Serial ของ Scanner เดิมให้เห็นเลขชัดเจน' },
  { key: 'old_device_photo', num: '2', label: 'ภาพรวมเครื่องเก่า', hint: 'ถ่ายภาพ Scanner เครื่องเดิมทั้งเครื่อง' },
  { key: 'old_condition_photo', num: '3', label: 'สภาพเครื่องเก่า', hint: 'ถ่ายตำหนิหรือสภาพปัจจุบันของ Scanner เดิม' },
  { key: 'old_branch_sticker_photo', num: '4', label: 'สติกเกอร์สาขาเดิม', hint: 'ถ่ายสติกเกอร์ที่ระบุสาขาเดิมให้เห็นชัด' },
] as const

const NEW_DEVICE_SLOTS = [
  { key: 'new_serial_photo', num: '1', label: 'SN เครื่องใหม่', hint: 'ถ่ายฉลาก Serial ของ Scanner ใหม่ให้เห็นเลขชัดเจน' },
  { key: 'new_front_photo', num: '2', label: 'ด้านหน้าเครื่องใหม่', hint: 'ถ่ายด้านหน้าของ Scanner หลังติดตั้ง' },
  { key: 'new_side_photo', num: '3', label: 'ด้านข้างเครื่องใหม่', hint: 'ถ่ายด้านข้างของ Scanner หลังติดตั้ง' },
  { key: 'new_com_serial_photo', num: '4', label: 'Com SN เครื่องใหม่', hint: 'ถ่ายฉลาก Com SN ให้เห็นเลขชัดเจน' },
  { key: 'new_device_photo', num: '5', label: 'ภาพรวมเครื่องใหม่', hint: 'ถ่ายภาพ Scanner ใหม่ทั้งเครื่องหลังติดตั้ง' },
  { key: 'new_cable_management_photo', num: '6', label: 'การจัดสายเครื่องใหม่', hint: 'ถ่ายการจัดสายและจุดเชื่อมต่อหลังติดตั้ง' },
] as const

const SPARE_SLOTS = [
  { key: 'spare_photo_1', num: '1', label: 'รูปสำรอง 1', hint: 'แนบภาพประกอบเพิ่มเติม (ถ้ามี)' },
  { key: 'spare_photo_2', num: '2', label: 'รูปสำรอง 2', hint: 'แนบภาพประกอบเพิ่มเติม (ถ้ามี)' },
] as const

const PHOTO_GROUPS = [
  { id: 'old_device', title: 'เครื่องเก่า (Old Device)', icon: '📦', countText: '4 รูป', slots: OLD_DEVICE_SLOTS },
  { id: 'new_device', title: 'เครื่องใหม่ (New Device)', icon: '✨', countText: '6 รูป', slots: NEW_DEVICE_SLOTS },
  { id: 'spare', title: 'รูปสำรอง (Optional)', icon: '📎', countText: 'ไม่บังคับ 2 รูป', slots: SPARE_SLOTS },
] as const

const PHOTO_SLOTS = [
  ...OLD_DEVICE_SLOTS,
  ...NEW_DEVICE_SLOTS,
  ...SPARE_SLOTS,
] as const

const SIGNATURE_SLOTS = [
  { key: 'technician_signature', label: 'ผู้ปฏิบัติงานที่เข้าสาขา (SYM)', hint: 'ลงลายเซ็นผู้ปฏิบัติงานหน้างาน' },
  { key: 'scanner_user_signature', label: 'ผู้รับมอบประจำสาขา (AIS)', hint: 'พนักงานประจำสาขา AIS ลงลายเซ็นรับทราบ' },
  { key: 'inspector_signature', label: 'ผู้ตรวจรับมอบงาน (ลูกค้า G-Able)', hint: 'ตัวแทนลูกค้าลงลายเซ็นตรวจรับมอบงาน' },
] as const

type PhotoSlot = typeof PHOTO_SLOTS[number]['key']
type SignatureSlot = typeof SIGNATURE_SLOTS[number]['key']
export type EvidenceSlot = PhotoSlot | SignatureSlot

const EVIDENCE_TYPE_ALIASES: Record<string, EvidenceSlot> = {
  photo_old_serial: 'old_serial_photo',
  photo_old_device: 'old_device_photo',
  photo_old_condition: 'old_condition_photo',
  photo_old_branch_sticker: 'old_branch_sticker_photo',
  photo_new_serial: 'new_serial_photo',
  photo_new_front: 'new_front_photo',
  photo_new_side: 'new_side_photo',
  photo_new_com_serial: 'new_com_serial_photo',
  photo_new_device: 'new_device_photo',
  photo_new_cable_management: 'new_cable_management_photo',
  sig_tech: 'technician_signature',
  sig_cust: 'scanner_user_signature',
  customer_signature: 'inspector_signature',
  sig_inspector: 'inspector_signature',
  sig_customer: 'inspector_signature',
}

function normalizeEvidenceSlot(rawType: string): EvidenceSlot | null {
  if (EVIDENCE_TYPE_ALIASES[rawType]) return EVIDENCE_TYPE_ALIASES[rawType]
  if (PHOTO_SLOTS.some(s => s.key === rawType) || SIGNATURE_SLOTS.some(s => s.key === rawType)) {
    return rawType as EvidenceSlot
  }
  return null
}
type EvidenceEntry = {
  slot: EvidenceSlot
  status: 'pending' | 'ready'
  path: string
  byte_size: number
  signer_name: string | null
  outcome_context: string | null
  uploaded_at: string | null
  can_finalize?: boolean
}
export type SignaturePadHandle = { exportJpeg: () => Promise<Blob>; clear: () => void }
type TaskEvidencePanelProps = {
  taskId?: string
  canEdit: boolean
  canView: boolean
  previewOnly?: boolean
  outcome?: string
  editableSlots?: EvidenceSlot[]
  requiredSlots?: EvidenceSlot[]
  onRequiredReady: (ready: boolean) => void
  onRequiredCompleted?: (slot: EvidenceSlot) => void
  onBusyChange: (busy: boolean) => void
  onTaskStarted?: (version: number) => void
}
type Point = { x: number; y: number }

function normalizeOutcomeAlias(outcome?: string | null): string {
  if (outcome === 'aborted') return 'no_damage_found'
  if (outcome === 'scanner_missing') return 'target_device_not_found'
  return String(outcome || '')
}

export function requiredEvidenceSlotsForOutcome(outcome?: string): EvidenceSlot[] {
  const normalized = normalizeOutcomeAlias(outcome)
  const fieldSignatures: EvidenceSlot[] = ['technician_signature', 'scanner_user_signature']
  if (normalized === 'replaced') return [
    'old_serial_photo', 'old_device_photo', 'old_condition_photo', 'old_branch_sticker_photo',
    'new_serial_photo', 'new_front_photo', 'new_side_photo', 'new_com_serial_photo',
    'new_device_photo', 'new_cable_management_photo', ...fieldSignatures,
  ]
  if (normalized === 'no_damage_found') return [
    'old_serial_photo', 'old_device_photo', 'old_condition_photo', 'old_branch_sticker_photo', ...fieldSignatures,
  ]
  if (normalized === 'different_device_found') return [
    'new_serial_photo', 'new_device_photo', ...fieldSignatures,
  ]
  if (normalized === 'target_device_not_found') return []
  return []
}

const REQUIRED_SLOTS: EvidenceSlot[] = []
const MAX_PHOTO_BYTES = 90 * 1024
const MAX_SIGNATURE_BYTES = 32 * 1024

function outcomeLabel(outcome?: string | null) {
  const normalized = normalizeOutcomeAlias(outcome)
  const labels: Record<string, string> = {
    replaced: 'เปลี่ยนเครื่อง',
    no_damage_found: 'ไม่พบเครื่องชำรุด',
    different_device_found: 'พบอุปกรณ์อื่น',
    target_device_not_found: 'ไม่พบเครื่องตาม SN',
  }
  return normalized ? labels[normalized] || normalized : 'ยังไม่ระบุผล'
}

function blobFromCanvas(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('สร้างไฟล์ภาพลายเซ็นไม่ได้')), type, quality)
  })
}

export const SignaturePad = forwardRef<SignaturePadHandle, {
  disabled: boolean
  label: string
  placeholder?: string
  onDisabledAttempt?: () => void
}>(function SignaturePad({ disabled, label, placeholder, onDisabledAttempt }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokesRef = useRef<Point[][]>([])
  const drawingRef = useRef(false)
  const [hasInk, setHasInk] = useState(false)

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const bounds = canvas.getBoundingClientRect()
    const width = Math.max(1, bounds.width)
    const height = Math.max(1, bounds.height)
    const scale = Math.max(1, window.devicePixelRatio || 1)
    const pixelWidth = Math.round(width * scale)
    const pixelHeight = Math.round(height * scale)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    context.setTransform(scale, 0, 0, scale, 0, 0)
    context.fillStyle = disabled ? '#f8fafc' : '#fff'
    context.fillRect(0, 0, width, height)
    context.strokeStyle = '#171717'
    context.fillStyle = '#171717'
    context.lineWidth = 2.4
    context.lineCap = 'round'
    context.lineJoin = 'round'
    for (const stroke of strokesRef.current) {
      if (!stroke.length) continue
      context.beginPath()
      context.moveTo(stroke[0].x * width, stroke[0].y * height)
      for (const point of stroke.slice(1)) context.lineTo(point.x * width, point.y * height)
      context.stroke()
      if (stroke.length === 1) {
        context.beginPath()
        context.arc(stroke[0].x * width, stroke[0].y * height, 1.5, 0, Math.PI * 2)
        context.fill()
      }
    }
  }, [disabled])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(redraw)
    observer.observe(canvas)
    redraw()
    return () => observer.disconnect()
  }, [redraw])

  useImperativeHandle(ref, () => ({
    clear() {
      strokesRef.current = []
      setHasInk(false)
      redraw()
    },
    async exportJpeg() {
      const canvas = canvasRef.current
      const bounds = canvas?.getBoundingClientRect()
      if (!canvas || !bounds) throw new Error('ช่องลายเซ็นยังไม่พร้อม')
      const lineLength = strokesRef.current.reduce((total, stroke) => total + stroke.slice(1).reduce((distance, point, index) => {
        const previous = stroke[index]
        return distance + Math.hypot((point.x - previous.x) * bounds.width, (point.y - previous.y) * bounds.height)
      }, 0), 0)
      if (lineLength < 14) throw new Error('กรุณาเซ็นชื่อให้ครบก่อนบันทึก')
      redraw()
      return blobFromCanvas(canvas, 'image/jpeg', 0.88)
    },
  }), [redraw])

  const getPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height))),
    }
  }
  const startStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled) {
      onDisabledAttempt?.()
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    strokesRef.current = [...strokesRef.current, [getPoint(event)]]
    drawingRef.current = true
    setHasInk(true)
    redraw()
  }
  const continueStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled || !drawingRef.current) return
    event.preventDefault()
    const strokes = strokesRef.current
    const latest = strokes[strokes.length - 1]
    latest.push(getPoint(event))
    redraw()
  }
  const endStroke = () => { drawingRef.current = false }

  return <div className="evidence-signature-pad">
    <canvas
      ref={canvasRef}
      aria-label={label}
      className={disabled ? 'is-disabled' : ''}
      onPointerDown={startStroke}
      onPointerMove={continueStroke}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
      onLostPointerCapture={endStroke}
    />
    {!hasInk && <span className="evidence-signature-placeholder">{placeholder || 'ลงลายเซ็นในช่องนี้'}</span>}
  </div>
})

async function compressPhoto(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('เลือกไฟล์รูปภาพเท่านั้น')
  if (file.size > 15 * 1024 * 1024) throw new Error('รูปต้นฉบับใหญ่เกิน 15 MB กรุณาถ่ายใหม่หรือครอปให้เหลือเฉพาะฉลาก/ตัวเครื่อง')
  if (typeof createImageBitmap !== 'function') throw new Error('เบราว์เซอร์นี้เปิดภาพเพื่อย่อขนาดไม่ได้ กรุณาใช้ไฟล์ JPEG แล้วลองอีกครั้ง')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('เปิดรูปนี้ไม่ได้ กรุณาเลือก JPG, PNG หรือ WebP แล้วลองอีกครั้ง')
  }
  try {
    const areaScale = Math.min(1, Math.sqrt(20_000_000 / Math.max(1, bitmap.width * bitmap.height)))
    let width = Math.max(1, Math.round(bitmap.width * areaScale))
    let height = Math.max(1, Math.round(bitmap.height * areaScale))
    const longest = Math.max(width, height)
    if (longest > 1600) {
      const scale = 1600 / longest
      width = Math.max(1, Math.round(width * scale))
      height = Math.max(1, Math.round(height * scale))
    }
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('เปิดตัวประมวลผลภาพไม่ได้')
    for (let resize = 0; resize < 8; resize += 1) {
      canvas.width = width
      canvas.height = height
      context.fillStyle = '#fff'
      context.fillRect(0, 0, width, height)
      context.drawImage(bitmap, 0, 0, width, height)
      for (const quality of [0.86, 0.78, 0.7, 0.62, 0.54, 0.48]) {
        const blob = await blobFromCanvas(canvas, 'image/jpeg', quality)
        if (blob.size <= MAX_PHOTO_BYTES) return blob
      }
      if (Math.max(width, height) <= 640) break
      width = Math.max(1, Math.round(width * 0.82))
      height = Math.max(1, Math.round(height * 0.82))
    }
    throw new Error('ย่อรูปแล้วยังเกิน 90 KB กรุณาครอปภาพให้เหลือฉลาก Serial หรือตัว Scanner ที่ต้องการ')
  } finally {
    bitmap.close()
  }
}

function slotErrorMessage(error: unknown): string {
  const rawMessage = String((error as { message?: unknown })?.message || '')
  if (/[\u0E00-\u0E7F]/.test(rawMessage)) return rawMessage
  const message = rawMessage.toLowerCase()
  if (message.includes('free-plan safety limit')) return 'พื้นที่จัดเก็บหลักฐานใกล้เต็มโควตาแล้ว กรุณาแจ้งผู้ดูแลระบบ (Admin) ก่อนบันทึกเพิ่ม'
  if (message.includes('reserved by another technician')) return 'ช่างอีกคนกำลังบันทึกช่องนี้อยู่ ลองใหม่ภายหลังหรือแจ้ง Admin'
  if (message.includes('original uploader')) return 'หลักฐานนี้บันทึกโดยช่างอีกคน หากต้องแก้ไขให้แจ้ง Admin'
  if (message.includes('row-level security policy')) return 'ระบบปฏิเสธสิทธิ์บันทึกหลักฐาน กรุณาลองใหม่อีกครั้ง หากยังไม่สำเร็จให้แจ้ง Admin'
  if (message.includes('outside your assigned') || message.includes('permission denied')) return 'บัญชีนี้ไม่มีสิทธิ์บันทึกหลักฐานของใบงานนี้'
  if (message.includes('signer name') || message.includes('signature and consent')) return 'กรอกชื่อผู้ลงนามและยืนยันการบันทึกลายเซ็นก่อน'
  return 'บันทึกหลักฐานไม่สำเร็จ ตรวจสัญญาณอินเทอร์เน็ต แล้วลองอีกครั้ง'
}

export default function TaskEvidencePanel({ taskId, canEdit, canView, previewOnly = false, outcome, editableSlots, requiredSlots, onRequiredReady, onRequiredCompleted, onBusyChange, onTaskStarted: _onTaskStarted }: TaskEvidencePanelProps) {
  const stageEditableSlots = editableSlots || (canEdit ? REQUIRED_SLOTS : [])
  const stageRequiredSlots = requiredSlots || REQUIRED_SLOTS
  const canEditSlot = (slot: EvidenceSlot) => Boolean(taskId) && canEdit && stageEditableSlots.includes(slot)
  const [entries, setEntries] = useState<Partial<Record<EvidenceSlot, EvidenceEntry>>>({})
  const [previewUrls, setPreviewUrls] = useState<Partial<Record<EvidenceSlot, string>>>({})
  const [previewStatuses, setPreviewStatuses] = useState<Partial<Record<EvidenceSlot, 'loading' | 'error'>>>({})
  const [previewRetry, setPreviewRetry] = useState(0)
  const [busySlot, setBusySlot] = useState<EvidenceSlot | null>(null)
  const [loadError, setLoadError] = useState('')
  const [actionNotice, setActionNotice] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const photoInputRefs = useRef<Partial<Record<PhotoSlot, HTMLInputElement | null>>>({})
  const loadRequestRef = useRef(0)
  const evidenceContextRef = useRef({ taskId, canView, stageRequiredSlots, outcome })
  evidenceContextRef.current = { taskId, canView, stageRequiredSlots, outcome }
  const requiredReadyRef = useRef(onRequiredReady)
  const requiredCompletedRef = useRef(onRequiredCompleted)
  const busyCallbackRef = useRef(onBusyChange)
  useEffect(() => { requiredReadyRef.current = onRequiredReady }, [onRequiredReady])
  useEffect(() => { requiredCompletedRef.current = onRequiredCompleted }, [onRequiredCompleted])
  useEffect(() => { busyCallbackRef.current = onBusyChange }, [onBusyChange])
  useEffect(() => { busyCallbackRef.current(busySlot !== null) }, [busySlot])
  useEffect(() => () => { busyCallbackRef.current(false) }, [])
  useEffect(() => {
    const ready = stageRequiredSlots.every(slot => entries[slot]?.status === 'ready')
    requiredReadyRef.current(ready)
  }, [entries, stageRequiredSlots, outcome])

  const loadEvidence = useCallback(async (): Promise<boolean> => {
    const { taskId: activeTaskId, canView: canViewActiveTask, stageRequiredSlots: activeRequiredSlots, outcome: activeOutcome } = evidenceContextRef.current
    const requestId = ++loadRequestRef.current
    const isCurrentRequest = () => requestId === loadRequestRef.current
      && activeTaskId === evidenceContextRef.current.taskId
      && canViewActiveTask === evidenceContextRef.current.canView
    if (!canViewActiveTask || !activeTaskId) {
      setEntries({})
      setPreviewUrls({})
      setPreviewStatuses({})
      setLoadError('')
      requiredReadyRef.current(false)
      setLoadState('ready')
      return false
    }
    setEntries({})
    setPreviewUrls({})
    setPreviewStatuses({})
    setLoadState('loading')
    setLoadError('')
    requiredReadyRef.current(false)
    try {
      const res = await d1Api.getTaskEvidence(activeTaskId)
      if (!isCurrentRequest()) return false
      const nextEntries: Record<string, EvidenceEntry> = {}
      for (const item of (res.evidence || [])) {
        const slotKey = normalizeEvidenceSlot(item.evidence_type)
        if (!slotKey) continue
        nextEntries[slotKey] = {
          slot: slotKey,
          status: 'ready',
          path: item.storage_path,
          byte_size: Number(item.byte_size || (item as any).file_size_bytes || 0),
          signer_name: (item as any).signer_name || null,
          outcome_context: activeOutcome || 'replaced',
          uploaded_at: item.created_at,
        }
      }
      setEntries(nextEntries as Record<EvidenceSlot, EvidenceEntry>)
      setLoadState('ready')
      return activeRequiredSlots.length > 0 && activeRequiredSlots.every(s => nextEntries[s]?.status === 'ready')
    } catch {
      if (!isCurrentRequest()) return false
      setEntries({})
      setLoadError('โหลดหลักฐานไม่ได้ บัญชีนี้อาจไม่มีสิทธิ์ดูใบงาน หรือการเชื่อมต่อขัดข้อง')
      setLoadState('error')
      requiredReadyRef.current(false)
      return false
    }
  }, [])

  useEffect(() => { void loadEvidence() }, [loadEvidence, canView, taskId])
  useEffect(() => () => { loadRequestRef.current += 1 }, [])

  useEffect(() => {
    let active = true
    const loadPreviews = () => {
      if (!canView) return
      const readyEntries = Object.values(entries).filter((entry): entry is EvidenceEntry => entry?.status === 'ready')
      const next: Partial<Record<EvidenceSlot, string>> = {}
      for (const entry of readyEntries) {
        const rawTs = entry.uploaded_at?.trim() || ''
        const normalizedTs = rawTs
          ? (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(rawTs) ? `${rawTs.replace(' ', 'T')}Z` : rawTs)
          : ''
        const parsedMs = normalizedTs ? new Date(normalizedTs).getTime() : NaN
        const timeKey = Number.isNaN(parsedMs) ? `?t=${Date.now()}` : `?t=${parsedMs}`
        next[entry.slot] = `/api/evidence/${entry.path}${timeKey}`
      }
      if (active) {
        setPreviewUrls(prev => ({ ...prev, ...next }))
        setPreviewStatuses({})
      }
    }
    loadPreviews()
    return () => {
      active = false
    }
  }, [canView, entries, previewRetry])

  const retryPreviews = () => setPreviewRetry(value => value + 1)

  const saveBlob = async (slot: EvidenceSlot, blob: Blob): Promise<boolean> => {
    if (!canEditSlot(slot) || !taskId) return false
    setBusySlot(slot)
    setActionNotice(null)
    try {
      const isSignature = SIGNATURE_SLOTS.some(item => item.key === slot)
      if (blob.size > (isSignature ? MAX_SIGNATURE_BYTES : MAX_PHOTO_BYTES)) {
        throw new Error(isSignature ? 'ลายเซ็นใหญ่เกิน 32 KB กรุณาเซ็นใหม่' : 'รูปใหญ่เกิน 90 KB กรุณาครอปภาพแล้วลองใหม่')
      }
      const reader = new FileReader()
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
      const base64 = await base64Promise
      setPreviewUrls(prev => ({ ...prev, [slot]: base64 }))
      await d1Api.uploadEvidence(taskId, slot, base64, blob.type || 'image/jpeg')
      setActionNotice({ text: 'บันทึกหลักฐานเรียบร้อยแล้ว', tone: 'success' })
      const nextReady = await loadEvidence()
      if (nextReady) {
        requiredCompletedRef.current?.(slot)
      }
      return true
    } catch (err: any) {
      setActionNotice({ text: err.message || 'บันทึกหลักฐานไม่สำเร็จ', tone: 'error' })
      return false
    } finally {
      setBusySlot(null)
    }
  }

  const savePhoto = async (slot: PhotoSlot, file?: File) => {
    if (!file) return
    setBusySlot(slot)
    setActionNotice(null)
    try {
      const blob = await compressPhoto(file)
      await saveBlob(slot, blob)
    } catch (error) {
      setBusySlot(null)
      setActionNotice({ text: slotErrorMessage(error), tone: 'error' })
    }
  }

  const removeEvidence = async (slot: EvidenceSlot) => {
    const entry = entries[slot]
    if (!taskId || !canEditSlot(slot) || entry?.status !== 'ready') return
    if (!window.confirm(`ลบหลักฐาน “${[...PHOTO_SLOTS, ...SIGNATURE_SLOTS].find(item => item.key === slot)?.label || slot}” ออกจากใบงานนี้หรือไม่? ระบบจะบันทึกผู้ลบไว้ในประวัติ`)) return

    setBusySlot(slot)
    setActionNotice(null)
    try {
      await d1Api.deleteEvidence(taskId, slot)
      setActionNotice({ text: 'ลบหลักฐานแล้ว', tone: 'success' })
      await loadEvidence()
    } catch (err: any) {
      setActionNotice({ text: err.message || 'ลบหลักฐานไม่สำเร็จ', tone: 'error' })
    } finally {
      setBusySlot(null)
    }
  }

  const retryFinalize = async (slot: EvidenceSlot) => {
    if (!canEditSlot(slot)) return
    await loadEvidence()
  }

  const isTechnicianEditing = stageEditableSlots.some(slot => slot !== 'inspector_signature' && canEditSlot(slot))
  const allRequiredReady = stageRequiredSlots.length > 0 && stageRequiredSlots.every(slot => entries[slot]?.status === 'ready')
  const visibleSignatureSlots = SIGNATURE_SLOTS.filter(
    slot => slot.key !== 'inspector_signature' || Boolean(entries[slot.key]) || canEditSlot(slot.key) || !isTechnicianEditing,
  )
  const showActionNotice = Boolean(
    actionNotice && !(actionNotice.tone === 'success' && allRequiredReady && isTechnicianEditing),
  )

  return <section className="detail-section task-evidence-panel" aria-labelledby="task-evidence-title">
    <div className="task-evidence-heading">
      <div><h3 id="task-evidence-title">รูปภาพและลายเซ็นประกอบใบงาน</h3><p>แนบหลักฐานของ “{outcomeLabel(outcome)}” ได้ทันที ระบบเริ่มบันทึกการปฏิบัติงานเมื่อเริ่มแนบหลักฐาน</p></div>
      {stageRequiredSlots.length > 0 ? <span className={'evidence-completion-badge' + (allRequiredReady ? ' is-ready' : '')}>
        {stageRequiredSlots.filter(slot => entries[slot]?.status === 'ready').length}/{stageRequiredSlots.length} รายการ
      </span> : <span className="evidence-completion-badge">ไม่บังคับ</span>}
    </div>
    {previewOnly && <p className="detail-empty-result">ตัวอย่างนี้ไม่มีรูปหรือลายเซ็นจริงให้ดู และไม่เชื่อมต่อเพื่อบันทึกหลักฐาน</p>}
    {loadState === 'loading' && <p className="evidence-status" role="status">กำลังโหลดหลักฐาน…</p>}
    {loadError && <div className="task-action-error" role="alert">{loadError} <button type="button" className="text-button" onClick={() => void loadEvidence()}>ลองอีกครั้ง</button></div>}

    <div className="evidence-groups-container">
      {PHOTO_GROUPS.map(group => {
        const groupSlots = group.slots
        const groupUploadedCount = groupSlots.filter(s => entries[s.key]?.status === 'ready').length
        const groupRequiredSlots = groupSlots.filter(s => stageRequiredSlots.includes(s.key))
        const isGroupAllRequiredReady = groupRequiredSlots.length > 0 && groupRequiredSlots.every(s => entries[s.key]?.status === 'ready')

        return (
          <div key={group.id} className="evidence-section-group">
            <div className="evidence-section-header">
              <h4 className="evidence-section-title">
                <span>{group.icon}</span>
                <span>{group.title} · {group.countText}</span>
              </h4>
              <span className={`evidence-section-badge ${isGroupAllRequiredReady ? 'is-complete' : ''}`}>
                {groupUploadedCount} / {groupSlots.length} บันทึกแล้ว
              </span>
            </div>

            <div className="evidence-photo-grid">
              {groupSlots.map(slot => {
                const entry = entries[slot.key]
                const imageUrl = previewUrls[slot.key]
                const matchesOutcome = entry?.status === 'ready'
                const label = outcome === 'different_device_found' && slot.key === 'new_serial_photo'
                  ? 'SN เครื่องที่พบ'
                  : outcome === 'different_device_found' && slot.key === 'new_device_photo'
                  ? 'ภาพอุปกรณ์ที่พบ'
                  : outcome === 'target_device_not_found' && slot.key === 'spare_photo_1'
                  ? 'ภาพบริเวณที่ตรวจค้น'
                  : slot.label
                const hint = outcome === 'different_device_found' && slot.key === 'new_serial_photo'
                  ? 'ถ่ายฉลาก Serial ของ Scanner ที่พบจริง ให้เห็นเลขชัดเจน'
                  : outcome === 'different_device_found' && slot.key === 'new_device_photo'
                  ? 'ถ่ายภาพตัว Scanner ที่พบจริงเพื่อให้ Admin ตรวจสอบ'
                  : outcome === 'target_device_not_found' && slot.key === 'spare_photo_1'
                  ? 'ถ่ายภาพบริเวณหรือจุดที่ควรพบ Scanner ตามทะเบียน เพื่อให้ Admin ตรวจสอบ'
                  : slot.hint
                const isRequired = stageRequiredSlots.includes(slot.key)
                const isUploaded = entry?.status === 'ready' && matchesOutcome
                const statusLabel = isUploaded
                  ? '✓ บันทึกแล้ว'
                  : isRequired
                  ? 'จำเป็น'
                  : entry?.status === 'ready'
                  ? 'บันทึกแล้ว'
                  : 'ไม่บังคับ'
                const pillClass = isUploaded || entry?.status === 'ready'
                  ? 'pill-ready'
                  : isRequired
                  ? 'pill-required'
                  : 'pill-optional'

                const missingPreviewMessage = previewStatuses[slot.key] === 'loading'
                  ? 'กำลังโหลดภาพ…'
                  : previewStatuses[slot.key] === 'error'
                  ? 'โหลดภาพไม่สำเร็จ'
                  : entry?.status === 'pending'
                  ? 'รอการยืนยัน'
                  : loadState === 'loading'
                  ? 'กำลังตรวจสอบ…'
                  : loadState === 'error'
                  ? 'ตรวจสอบรูปไม่ได้'
                  : 'ยังไม่มีรูป'

                return (
                  <div key={slot.key} className={`evidence-photo-card ${entry?.status === 'ready' ? 'is-uploaded' : ''}`}>
                    <div className="evidence-photo-card-top">
                      <div className="evidence-photo-card-title-group">
                        <span className="evidence-slot-number">{slot.num}</span>
                        <strong className="evidence-photo-card-title" title={label}>{label}</strong>
                      </div>
                      <span className={`evidence-pill ${pillClass}`}>{statusLabel}</span>
                    </div>

                    <div
                      className={`evidence-photo-box ${imageUrl ? 'has-image' : 'is-empty'}`}
                      onClick={() => {
                        if (imageUrl) {
                          window.open(imageUrl, '_blank')
                        } else if (canEditSlot(slot.key)) {
                          photoInputRefs.current[slot.key]?.click()
                        }
                      }}
                      title={imageUrl ? `คลิกเพื่อดูรูปขยายใหญ่` : canEditSlot(slot.key) ? `คลิกเพื่อถ่ายรูปหรือเลือกไฟล์` : undefined}
                      role={canEditSlot(slot.key) || imageUrl ? 'button' : undefined}
                      tabIndex={canEditSlot(slot.key) || imageUrl ? 0 : undefined}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          if (imageUrl) window.open(imageUrl, '_blank')
                          else if (canEditSlot(slot.key)) photoInputRefs.current[slot.key]?.click()
                        }
                      }}
                    >
                      {imageUrl ? (
                        <img src={imageUrl} alt={`หลักฐาน ${label}`} className="evidence-photo-img" />
                      ) : (
                        <div className="evidence-photo-placeholder">
                          {previewStatuses[slot.key] === 'loading' ? (
                            <LoaderCircle className="evidence-spinner" size={20} />
                          ) : (
                            <ImagePlus size={20} />
                          )}
                          <span className="evidence-photo-placeholder-text">
                            {busySlot === slot.key ? 'กำลังบันทึก…' : missingPreviewMessage}
                          </span>
                        </div>
                      )}
                    </div>

                    <p className="evidence-photo-card-hint" title={hint}>{hint}</p>

                    {entry?.status === 'ready' && (
                      <div className="task-evidence-saved text-[11px] gap-1.5">
                        <Check size={13} className="shrink-0" />
                        <span>บันทึกแล้ว{entry.byte_size > 0 ? ` · ${Math.max(1, Math.round(entry.byte_size / 1024))} KB` : ''}</span>
                      </div>
                    )}
                    {entry?.status === 'pending' && (
                      <div className="task-evidence-pending text-[11px] gap-1.5">
                        <span>การบันทึกยังไม่สมบูรณ์</span>
                        {canEditSlot(slot.key) && entry.can_finalize && (
                          <button type="button" className="text-button" disabled={busySlot !== null} onClick={() => void retryFinalize(slot.key)}>
                            <RotateCcw size={12} /> ลองยืนยันไฟล์เดิม
                          </button>
                        )}
                      </div>
                    )}

                    {canEditSlot(slot.key) && (
                      <div className="evidence-photo-card-actions">
                        <button
                          type="button"
                          className="evidence-photo-btn primary"
                          disabled={busySlot !== null}
                          onClick={() => photoInputRefs.current[slot.key]?.click()}
                        >
                          <ImagePlus size={13} />
                          <span>{busySlot === slot.key ? 'กำลังบันทึก…' : entry?.status === 'ready' ? 'เปลี่ยนรูป' : 'ถ่ายรูป'}</span>
                        </button>
                        {entry?.status === 'ready' && (
                          <button
                            type="button"
                            className="evidence-photo-btn danger"
                            title={`ลบรูป ${label}`}
                            aria-label={`ลบรูป ${label}`}
                            disabled={busySlot !== null}
                            onClick={() => void removeEvidence(slot.key)}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    )}

                    {canEditSlot(slot.key) && (
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        capture="environment"
                        aria-label={`${entry?.status === 'ready' ? 'เปลี่ยน' : 'เพิ่ม'}รูป: ${label}`}
                        tabIndex={-1}
                        ref={(element: HTMLInputElement | null) => { photoInputRefs.current[slot.key] = element }}
                        onChange={event => {
                          const file = event.currentTarget.files?.[0]
                          event.currentTarget.value = ''
                          void savePhoto(slot.key, file)
                        }}
                        className="hidden"
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>

    <div className="task-evidence-signatures">
      <h4>ลายเซ็นผู้เกี่ยวข้อง</h4>
      {isTechnicianEditing && (
        <p className="mb-3 text-xs text-slate-500">
          เมื่อกรอก SN เครื่องใหม่ แนบรูปหลักฐาน และลงลายเซ็นผู้ปฏิบัติงาน (SYM) กับผู้รับมอบประจำสาขา (AIS) ครบแล้ว ระบบจะส่งต่อให้ Admin SYM ตรวจรับอัตโนมัติ (หรือกดปุ่ม “ส่งให้ Admin SYM ตรวจรับ” ด้านล่างได้ทันที)
        </p>
      )}
      <div className="task-evidence-grid signature-grid">
        {visibleSignatureSlots.map(slot => <SignatureEntry
          key={slot.key}
          slot={slot.key}
          label={slot.label}
          hint={slot.hint}
          entry={entries[slot.key]}
          outcome={outcome}
          previewUrl={previewUrls[slot.key]}
          previewStatus={previewStatuses[slot.key]}
          canEdit={canEditSlot(slot.key)}
          busy={busySlot === slot.key}
          disabled={busySlot !== null}
          required={stageRequiredSlots.includes(slot.key)}
          onSave={saveBlob}
          onRetry={() => void retryFinalize(slot.key)}
          onRetryPreview={retryPreviews}
          showEmpty={previewOnly || loadState === 'ready'}
        />)}
      </div>
    </div>
    {isTechnicianEditing && <p className="evidence-storage-note">ระบบจะย่อรูปเป็น JPEG อัตโนมัติ (สูงสุด 90 KB ต่อรูป และ 32 KB ต่อลายเซ็น) เพื่อความรวดเร็วในการอัปโหลดบนมือถือ หากอ่านเลข SN ไม่ชัด ให้ครอปเฉพาะฉลากแล้วถ่ายใหม่</p>}
    {showActionNotice && actionNotice && (
      <p
        className={`task-evidence-message${actionNotice.tone === 'error' ? ' is-error' : ''}`}
        role={actionNotice.tone === 'error' ? 'alert' : 'status'}
      >
        {actionNotice.tone === 'error' ? <AlertCircle size={15} className="shrink-0" /> : <Check size={15} className="shrink-0" />}
        <span>{actionNotice.text}</span>
      </p>
    )}
  </section>
}

function SignatureEntry({
  slot, label, hint, entry, outcome, previewUrl, previewStatus, canEdit, busy, disabled, required, onSave, onRetry, onRetryPreview, showEmpty,
}: {
  slot: SignatureSlot
  label: string
  hint: string
  entry?: EvidenceEntry
  outcome?: string
  previewUrl?: string
  previewStatus?: 'loading' | 'error'
  canEdit: boolean
  busy: boolean
  disabled: boolean
  required: boolean
  showEmpty: boolean
  onSave: (slot: EvidenceSlot, blob: Blob) => Promise<boolean>
  onRetry: () => void
  onRetryPreview: () => void
}) {
  const padRef = useRef<SignaturePadHandle>(null)
  const [consent, setConsent] = useState(false)
  const [consentWarning, setConsentWarning] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)

  const handleConsentChange = (checked: boolean) => {
    setConsent(checked)
    setConsentWarning(false)
    if (!checked) {
      // หากเผลอติ๊กยืนยันออก ก็จะเป็นการลบลายเซ็นด้วย
      padRef.current?.clear()
    }
  }

  const handleDisabledPadAttempt = () => {
    if (!consent) {
      setConsentWarning(true)
      setTimeout(() => setConsentWarning(false), 3000)
    }
  }

  const isPadDisabled = disabled || !consent
  const canSubmit = canEdit && consent && !disabled
  const showEditor = canEdit && (entry?.status !== 'ready' ? showEmpty : editing)

  useEffect(() => {
    if (entry?.status === 'ready') {
      setEditing(false)
      setConsent(false)
      setConsentWarning(false)
    }
  }, [entry?.status])

  const saveSignature = async () => {
    setError('')
    try {
      if (!consent) throw new Error('กรุณากดยืนยันยินยอมข้อตกลงก่อนบันทึกลายเซ็น')
      const blob = await padRef.current?.exportJpeg()
      if (!blob) throw new Error('กรุณาเซ็นชื่อให้ครบก่อนบันทึก')
      if (blob.size > MAX_SIGNATURE_BYTES) throw new Error('ลายเซ็นใหญ่เกิน 32 KB กรุณาเซ็นใหม่')
      const saved = await onSave(slot, blob)
      if (saved) {
        padRef.current?.clear()
        setConsent(false)
      }
    } catch (caught) {
      setError(String((caught as { message?: unknown })?.message || 'กรุณาตรวจลายเซ็นแล้วลองใหม่'))
    }
  }
  const isCustomerSlot = slot === 'inspector_signature'
  const statusPillClass = entry?.status === 'ready'
    ? 'evidence-pill pill-ready'
    : isCustomerSlot
    ? 'evidence-optional'
    : required
    ? 'evidence-required'
    : 'evidence-optional'
  const statusPillLabel = entry?.status === 'ready'
    ? '✓ บันทึกแล้ว'
    : isCustomerSlot
    ? 'รอด่านที่ 2 (G-Able)'
    : required
    ? 'จำเป็นในขั้นนี้'
    : 'ใช้ในขั้นอื่น'

  return <article className="task-evidence-card signature-card">
    <div className="task-evidence-card-heading">
      <strong>{label}</strong>
      <span className={statusPillClass}>
        {statusPillLabel}
      </span>
    </div>
    <p>{hint}</p>
    {entry?.status === 'ready' && (previewUrl ? <a className="task-evidence-preview signature-preview" href={previewUrl} target="_blank" rel="noreferrer"><img src={previewUrl} alt={`ลายเซ็น ${label}`} /></a> : previewStatus === 'loading' ? <div className="task-evidence-empty"><LoaderCircle className="evidence-spinner" size={18} /><span>กำลังโหลดลายเซ็น…</span></div> : <div className="task-evidence-image-missing">โหลดลายเซ็นไม่สำเร็จ <button type="button" className="text-button" onClick={onRetryPreview}>ลองโหลดอีกครั้ง</button></div>)}
    {entry?.status === 'ready' && (
      <div className="task-evidence-saved">
        <Check size={14} className="shrink-0" />
        <span>{entry.signer_name ? `ลงชื่อโดย ${entry.signer_name}` : 'บันทึกลายเซ็นแล้ว'}{outcome ? ` · ${outcomeLabel(outcome)}` : ''}</span>
      </div>
    )}
    {entry?.status === 'pending' && <div className="task-evidence-pending">ลายเซ็นยังรอยืนยัน</div>}
    {!entry && !canEdit && showEmpty && <div className="task-evidence-empty">{isCustomerSlot ? 'ด่านที่ 2: ให้ลูกค้า (G-Able) ลงนามหลัง Admin SYM ตรวจรับ' : 'ยังไม่มีลายเซ็น'}</div>}
    {canEdit && entry?.status === 'ready' && !editing && <button type="button" className="text-button" disabled={disabled} onClick={() => setEditing(true)}>แก้ไขลายเซ็น</button>}
    {showEditor && <>
      {entry?.status === 'ready' && <button type="button" className="text-button" disabled={disabled} onClick={() => { setEditing(false); setConsent(false); }}>ยกเลิกแก้ไข</button>}

      {/* ต้องกดยืนยันก่อนถึงจะเซ็นได้ */}
      <label className={`evidence-consent ${consent ? 'is-checked' : 'is-pending'}`}>
        <input
          type="checkbox"
          checked={consent}
          onChange={event => handleConsentChange(event.target.checked)}
          disabled={disabled}
        />
        <span>
          ผู้ลงนามยืนยันและยินยอมให้บันทึกลายเซ็นนี้เป็นหลักฐานในใบงาน{' '}
          {!consent && <strong className="font-semibold text-amber-700">(กดยืนยันก่อนลงลายเซ็น)</strong>}
        </span>
      </label>

      {consentWarning && (
        <p className="task-action-error mt-1 px-2.5 py-1.5 text-[11.5px]" role="alert">
          ⚠️ กรุณากดยืนยันข้อตกลงด้านบนก่อน จึงจะสามารถลงลายเซ็นได้
        </p>
      )}

      {/* ช่องลงลายเซ็น ปลดล็อกเฉพาะเมื่อติ๊กยืนยันแล้ว */}
      <SignaturePad
        ref={padRef}
        label={`ช่องลายเซ็น ${label}`}
        disabled={isPadDisabled}
        placeholder={!consent ? '🔒 กรุณากดยืนยันด้านบนก่อนลงลายเซ็น' : 'ลงลายเซ็นในช่องนี้'}
        onDisabledAttempt={handleDisabledPadAttempt}
      />

      <div className="evidence-signature-controls">
        <button
          type="button"
          className="text-button"
          disabled={disabled || !consent}
          onClick={() => padRef.current?.clear()}
        >
          <Trash2 size={14} /> ล้างลายเซ็น
        </button>
      </div>

      {error && <p className="task-action-error" role="alert">{error}</p>}
      <button type="button" className="primary-button evidence-save-signature" disabled={!canSubmit || busy} onClick={() => void saveSignature()}>
        {busy ? <><LoaderCircle className="evidence-spinner" size={16} /> กำลังบันทึก…</> : <><Save size={16} />{entry?.status === 'ready' ? 'บันทึกลายเซ็นใหม่' : 'บันทึกลายเซ็น'}</>}
      </button>
      {entry?.status === 'pending' && entry.can_finalize && <button type="button" className="text-button" disabled={disabled} onClick={onRetry}><RotateCcw size={14} /> ลองยืนยันไฟล์เดิม</button>}
    </>}
  </article>
}
