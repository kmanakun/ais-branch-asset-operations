import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Box, Button, Chip, Typography } from '@mui/material'
import { Check, ImagePlus, LoaderCircle, RotateCcw, Save, Trash2 } from 'lucide-react'
import { supabase } from './supabase'

const PHOTO_SLOTS = [
  { key: 'old_serial_photo', label: 'SN เครื่องเก่า', required: false, hint: 'ถ่ายฉลาก Serial ของ Scanner เดิมให้เห็นเลขชัดเจน', section: 'เครื่องเก่า · 4 รูป' },
  { key: 'old_device_photo', label: 'ภาพรวมเครื่องเก่า', required: false, hint: 'ถ่ายภาพ Scanner เครื่องเดิมทั้งเครื่อง' },
  { key: 'old_condition_photo', label: 'สภาพเครื่องเก่า', required: false, hint: 'ถ่ายตำหนิหรือสภาพปัจจุบันของ Scanner เดิม' },
  { key: 'old_branch_sticker_photo', label: 'สติกเกอร์สาขาเดิม', required: false, hint: 'ถ่ายสติกเกอร์ที่ระบุสาขาเดิมให้เห็นชัด' },
  { key: 'new_serial_photo', label: 'SN เครื่องใหม่', required: false, hint: 'ถ่ายฉลาก Serial ของ Scanner ใหม่ให้เห็นเลขชัดเจน', section: 'เครื่องใหม่ · 6 รูป' },
  { key: 'new_front_photo', label: 'ด้านหน้าเครื่องใหม่', required: false, hint: 'ถ่ายด้านหน้าของ Scanner หลังติดตั้ง' },
  { key: 'new_side_photo', label: 'ด้านข้างเครื่องใหม่', required: false, hint: 'ถ่ายด้านข้างของ Scanner หลังติดตั้ง' },
  { key: 'new_com_serial_photo', label: 'Com SN เครื่องใหม่', required: false, hint: 'ถ่ายฉลาก Com SN ให้เห็นเลขชัดเจน' },
  { key: 'new_device_photo', label: 'ภาพรวมเครื่องใหม่', required: false, hint: 'ถ่ายภาพ Scanner ใหม่ทั้งเครื่องหลังติดตั้ง' },
  { key: 'new_cable_management_photo', label: 'การจัดสายเครื่องใหม่', required: false, hint: 'ถ่ายการจัดสายและจุดเชื่อมต่อหลังติดตั้ง' },
  { key: 'spare_photo_1', label: 'รูปสำรอง 1', required: false, hint: 'แนบภาพประกอบเพิ่มเติม (ถ้ามี)', section: 'รูปสำรอง · ไม่บังคับ 2 รูป' },
  { key: 'spare_photo_2', label: 'รูปสำรอง 2', required: false, hint: 'แนบภาพประกอบเพิ่มเติม (ถ้ามี)' },
] as const

const SIGNATURE_SLOTS = [
  { key: 'technician_signature', label: 'ผู้ปฏิบัติงานที่เข้าสาขา', hint: 'ลงลายเซ็นผู้ปฏิบัติงาน' },
  { key: 'scanner_user_signature', label: 'ผู้ใช้งาน Scanner', hint: 'ผู้ใช้งาน Scanner ลงลายเซ็นรับทราบ' },
  { key: 'inspector_signature', label: 'ผู้ตรวจรับงาน', hint: 'Admin ลงลายเซ็นหลังตรวจงาน' },
] as const

type PhotoSlot = typeof PHOTO_SLOTS[number]['key']
type SignatureSlot = typeof SIGNATURE_SLOTS[number]['key']
export type EvidenceSlot = PhotoSlot | SignatureSlot
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
type SignaturePadHandle = { exportJpeg: () => Promise<Blob>; clear: () => void }
type TaskEvidencePanelProps = {
  taskId?: string
  canEdit: boolean
  canView: boolean
  previewOnly?: boolean
  outcome?: string
  editableSlots?: EvidenceSlot[]
  requiredSlots?: EvidenceSlot[]
  onRequiredReady: (ready: boolean) => void
  onBusyChange: (busy: boolean) => void
  onTaskStarted?: (version: number) => void
}
type Point = { x: number; y: number }

export function requiredEvidenceSlotsForOutcome(outcome?: string): EvidenceSlot[] {
  const fieldSignatures: EvidenceSlot[] = ['technician_signature', 'scanner_user_signature']
  if (outcome === 'replaced') return [
    'old_serial_photo', 'old_device_photo', 'old_condition_photo', 'old_branch_sticker_photo',
    'new_serial_photo', 'new_front_photo', 'new_side_photo', 'new_com_serial_photo',
    'new_device_photo', 'new_cable_management_photo', ...fieldSignatures,
  ]
  if (outcome === 'no_damage_found') return [
    'old_serial_photo', 'old_device_photo', 'old_condition_photo', 'old_branch_sticker_photo', ...fieldSignatures,
  ]
  if (outcome === 'different_device_found') return [
    'new_serial_photo', 'new_device_photo', ...fieldSignatures,
  ]
  if (outcome === 'target_device_not_found') return ['spare_photo_1', ...fieldSignatures]
  return []
}

const REQUIRED_SLOTS: EvidenceSlot[] = []
const MAX_PHOTO_BYTES = 90 * 1024
const MAX_SIGNATURE_BYTES = 32 * 1024
const EVIDENCE_BUCKET = 'ais-task-evidence'

function toEntryMap(rows: unknown): Partial<Record<EvidenceSlot, EvidenceEntry>> {
  if (!Array.isArray(rows)) return {}
  return Object.fromEntries(rows.flatMap((row: EvidenceEntry) => {
    const slot = row?.slot
    const knownSlot = PHOTO_SLOTS.some(item => item.key === slot) || SIGNATURE_SLOTS.some(item => item.key === slot)
    if (!knownSlot || !['pending', 'ready'].includes(row.status) || typeof row.path !== 'string') return []
    return [[slot, row]]
  })) as Partial<Record<EvidenceSlot, EvidenceEntry>>
}

function outcomeLabel(outcome?: string | null) {
  const labels: Record<string, string> = {
    replaced: 'เปลี่ยนเครื่อง',
    no_damage_found: 'ไม่พบเครื่องชำรุด',
    different_device_found: 'พบอุปกรณ์อื่น',
    target_device_not_found: 'ไม่พบเครื่องตาม SN',
  }
  return outcome ? labels[outcome] || outcome : 'ยังไม่ระบุผล'
}

function blobFromCanvas(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('สร้างไฟล์ภาพลายเซ็นไม่ได้')), type, quality)
  })
}

const SignaturePad = forwardRef<SignaturePadHandle, { disabled: boolean; label: string }>(function SignaturePad({ disabled, label }, ref) {
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
    context.fillStyle = '#fff'
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
  }, [])

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
    if (disabled) return
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
    {!hasInk && <span className="evidence-signature-placeholder">ลงลายเซ็นในช่องนี้</span>}
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
  if (message.includes('free-plan safety limit')) return 'พื้นที่เก็บหลักฐานฟรีใกล้เต็มแล้ว กรุณาแจ้ง Admin ก่อนบันทึกเพิ่ม'
  if (message.includes('reserved by another technician')) return 'ช่างอีกคนกำลังบันทึกช่องนี้อยู่ ลองใหม่ภายหลังหรือแจ้ง Admin'
  if (message.includes('original uploader')) return 'หลักฐานนี้บันทึกโดยช่างอีกคน หากต้องแก้ไขให้แจ้ง Admin'
  if (message.includes('row-level security policy')) return 'ระบบปฏิเสธสิทธิ์บันทึกหลักฐาน กรุณาลองใหม่อีกครั้ง หากยังไม่สำเร็จให้แจ้ง Admin'
  if (message.includes('outside your assigned') || message.includes('permission denied')) return 'บัญชีนี้ไม่มีสิทธิ์บันทึกหลักฐานของใบงานนี้'
  if (message.includes('signer name') || message.includes('signature and consent')) return 'กรอกชื่อผู้ลงนามและยืนยันการบันทึกลายเซ็นก่อน'
  return 'บันทึกหลักฐานไม่สำเร็จ ตรวจสัญญาณอินเทอร์เน็ต แล้วลองอีกครั้ง'
}

export default function TaskEvidencePanel({ taskId, canEdit, canView, previewOnly = false, outcome, editableSlots, requiredSlots, onRequiredReady, onBusyChange, onTaskStarted }: TaskEvidencePanelProps) {
  const stageEditableSlots = editableSlots || (canEdit ? REQUIRED_SLOTS : [])
  const stageRequiredSlots = requiredSlots || REQUIRED_SLOTS
  const canEditSlot = (slot: EvidenceSlot) => Boolean(taskId) && canEdit && stageEditableSlots.includes(slot)
  const [entries, setEntries] = useState<Partial<Record<EvidenceSlot, EvidenceEntry>>>({})
  const [previewUrls, setPreviewUrls] = useState<Partial<Record<EvidenceSlot, string>>>({})
  const [previewStatuses, setPreviewStatuses] = useState<Partial<Record<EvidenceSlot, 'loading' | 'error'>>>({})
  const [previewRetry, setPreviewRetry] = useState(0)
  const [busySlot, setBusySlot] = useState<EvidenceSlot | null>(null)
  const [loadError, setLoadError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const photoInputRefs = useRef<Partial<Record<PhotoSlot, HTMLInputElement | null>>>({})
  const loadRequestRef = useRef(0)
  const evidenceContextRef = useRef({ taskId, canView })
  evidenceContextRef.current = { taskId, canView }
  const requiredReadyRef = useRef(onRequiredReady)
  const busyCallbackRef = useRef(onBusyChange)
  useEffect(() => { requiredReadyRef.current = onRequiredReady }, [onRequiredReady])
  useEffect(() => { busyCallbackRef.current = onBusyChange }, [onBusyChange])
  useEffect(() => { busyCallbackRef.current(busySlot !== null) }, [busySlot])
  useEffect(() => () => { busyCallbackRef.current(false) }, [])
  useEffect(() => {
    const ready = stageRequiredSlots.every(slot => entries[slot]?.status === 'ready' && entries[slot]?.outcome_context === outcome)
    requiredReadyRef.current(ready)
  }, [entries, stageRequiredSlots, outcome])

  const loadEvidence = useCallback(async () => {
    const { taskId: activeTaskId, canView: canViewActiveTask } = evidenceContextRef.current
    const requestId = ++loadRequestRef.current
    const isCurrentRequest = () => requestId === loadRequestRef.current
      && activeTaskId === evidenceContextRef.current.taskId
      && canViewActiveTask === evidenceContextRef.current.canView
    if (!supabase || !canViewActiveTask || !activeTaskId) {
      setEntries({})
      setPreviewUrls({})
      setPreviewStatuses({})
      setLoadError('')
      requiredReadyRef.current(false)
      setLoadState('ready')
      return
    }
    setEntries({})
    setPreviewUrls({})
    setPreviewStatuses({})
    setLoadState('loading')
    setLoadError('')
    requiredReadyRef.current(false)
    try {
      const { data, error } = await supabase.rpc('ais_task_evidence_list', { p_task_id: activeTaskId })
      if (!isCurrentRequest()) return
      if (error) throw error
      const nextEntries = toEntryMap(data)
      setEntries(nextEntries)
      setLoadState('ready')
    } catch {
      if (!isCurrentRequest()) return
      setEntries({})
      setLoadError('โหลดหลักฐานไม่ได้ บัญชีนี้อาจไม่มีสิทธิ์ดูใบงาน หรือการเชื่อมต่อขัดข้อง')
      setLoadState('error')
      requiredReadyRef.current(false)
    }
  }, [])

  useEffect(() => { void loadEvidence() }, [loadEvidence, canView, taskId])
  useEffect(() => () => { loadRequestRef.current += 1 }, [])

  useEffect(() => {
    let active = true
    const urls: string[] = []
    const client = supabase
    const loadPreviews = async () => {
      if (!client || !canView) return
      const readyEntries = Object.values(entries).filter((entry): entry is EvidenceEntry => entry?.status === 'ready')
      setPreviewStatuses(Object.fromEntries(readyEntries.map(entry => [entry.slot, 'loading'])) as Partial<Record<EvidenceSlot, 'loading' | 'error'>>)
      if (!readyEntries.length) {
        setPreviewUrls({})
        return
      }
      const pairs = await Promise.all(readyEntries.map(async entry => {
        try {
          const { data, error } = await client.storage.from(EVIDENCE_BUCKET).download(entry.path)
          if (error || !data) return [entry.slot, null] as const
          return [entry.slot, URL.createObjectURL(data)] as const
        } catch {
          return [entry.slot, null] as const
        }
      }))
      const next: Partial<Record<EvidenceSlot, string>> = {}
      const nextStatuses: Partial<Record<EvidenceSlot, 'loading' | 'error'>> = {}
      for (const [slot, url] of pairs) {
        if (url) { next[slot] = url; urls.push(url) }
        else nextStatuses[slot] = 'error'
      }
      if (active) {
        setPreviewUrls(next)
        setPreviewStatuses(nextStatuses)
      }
      else urls.forEach(URL.revokeObjectURL)
    }
    void loadPreviews()
    return () => {
      active = false
      urls.forEach(URL.revokeObjectURL)
    }
  }, [canView, entries, previewRetry])

  const retryPreviews = () => setPreviewRetry(value => value + 1)

  const saveBlob = async (slot: EvidenceSlot, blob: Blob, signerName: string | null = null): Promise<boolean> => {
    if (!supabase || !canEditSlot(slot)) return false
    setBusySlot(slot)
    setActionMessage('')
    let startedTaskVersion: number | null = null
    const syncStartedTask = () => {
      if (startedTaskVersion === null) return
      onTaskStarted?.(startedTaskVersion)
      startedTaskVersion = null
    }
    try {
      const isSignature = SIGNATURE_SLOTS.some(item => item.key === slot)
      if (blob.size > (isSignature ? MAX_SIGNATURE_BYTES : MAX_PHOTO_BYTES)) {
        throw new Error(isSignature ? 'ลายเซ็นใหญ่เกิน 32 KB กรุณาเซ็นใหม่' : 'รูปใหญ่เกิน 90 KB กรุณาครอปภาพแล้วลองใหม่')
      }
      const { data: reservation, error: reserveError } = await supabase.rpc('ais_task_evidence_reserve_for_outcome', {
        p_task_id: taskId,
        p_slot: slot,
        p_byte_size: blob.size,
        p_signer_name: signerName,
        p_consent_confirmed: isSignature,
        p_outcome: outcome,
      })
      if (reserveError) throw reserveError
      const reservationResult = reservation as { reservation_token?: unknown; task_started?: unknown; task_version?: unknown } | null
      if (reservationResult?.task_started === true && typeof reservationResult.task_version === 'number' && Number.isInteger(reservationResult.task_version)) {
        startedTaskVersion = reservationResult.task_version
      }
      const reservationToken = reservationResult?.reservation_token
      if (typeof reservationToken !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reservationToken)) {
        throw new Error('ระบบไม่คืนรหัสยืนยันการอัปโหลด กรุณาลองใหม่')
      }

      const path = `${taskId}/${slot}.jpg`
      const { error: uploadError } = await supabase.storage.from(EVIDENCE_BUCKET).upload(path, blob, {
        contentType: 'image/jpeg',
        upsert: true,
        cacheControl: '0',
        metadata: { reservation_token: reservationToken },
      })
      if (uploadError) {
        const recovery = await supabase.rpc('ais_task_evidence_finalize', { p_task_id: taskId, p_slot: slot })
        const recoveryStatus = (recovery.data as { status?: unknown } | null)?.status
        if (recovery.error || recoveryStatus !== 'ready') {
          await supabase.rpc('ais_task_evidence_cancel_pending', { p_task_id: taskId, p_slot: slot })
          throw uploadError
        }
      } else {
        const { data: finalized, error: finalizeError } = await supabase.rpc('ais_task_evidence_finalize', { p_task_id: taskId, p_slot: slot })
        if (finalizeError) throw finalizeError
        if ((finalized as { status?: unknown } | null)?.status !== 'ready') {
          throw new Error('ระบบยังยืนยันหลักฐานไม่สำเร็จ กรุณาลองบันทึกอีกครั้ง')
        }
      }
      setActionMessage('บันทึกหลักฐานแล้ว')
      syncStartedTask()
      await loadEvidence()
      return true
    } catch (error) {
      // The reservation transaction may already have started the task even if
      // the subsequent Storage upload fails. Keep the UI in sync, but only
      // after the file attempt has finished so opening the picker does not
      // trigger a page refresh while the technician is selecting evidence.
      syncStartedTask()
      setActionMessage(slotErrorMessage(error))
      await loadEvidence()
      return false
    } finally {
      setBusySlot(null)
    }
  }

  const savePhoto = async (slot: PhotoSlot, file?: File) => {
    if (!file) return
    setBusySlot(slot)
    setActionMessage('')
    try {
      const blob = await compressPhoto(file)
      await saveBlob(slot, blob)
    } catch (error) {
      setBusySlot(null)
      setActionMessage(slotErrorMessage(error))
    }
  }

  const removeEvidence = async (slot: EvidenceSlot) => {
    const entry = entries[slot]
    if (!supabase || !taskId || !canEditSlot(slot) || entry?.status !== 'ready') return
    if (!window.confirm(`ลบหลักฐาน “${[...PHOTO_SLOTS, ...SIGNATURE_SLOTS].find(item => item.key === slot)?.label || slot}” ออกจากใบงานนี้หรือไม่? ระบบจะบันทึกผู้ลบไว้ในประวัติ`)) return

    setBusySlot(slot)
    setActionMessage('')
    let reservationToken = ''
    let storageRemoved = false
    try {
      const { data, error } = await supabase.rpc('ais_task_evidence_delete_reserve', { p_task_id: taskId, p_slot: slot })
      if (error) throw error
      const reservation = data as { reservation_token?: unknown; path?: unknown } | null
      if (typeof reservation?.reservation_token !== 'string' || typeof reservation.path !== 'string' || reservation.path !== entry.path) {
        throw new Error('ระบบไม่ยืนยันรายการรูปที่ต้องการลบ กรุณาโหลดใบงานใหม่')
      }
      reservationToken = reservation.reservation_token

      const { error: removeError } = await supabase.storage.from(EVIDENCE_BUCKET).remove([reservation.path])
      if (removeError) {
        const recovery = await supabase.rpc('ais_task_evidence_delete_finalize', {
          p_task_id: taskId, p_slot: slot, p_reservation_token: reservationToken,
        })
        if (!recovery.error && (recovery.data as { status?: unknown } | null)?.status === 'removed') {
          setActionMessage('ลบหลักฐานแล้ว และบันทึกผู้ดำเนินการไว้ในประวัติ')
          await loadEvidence()
          return
        }
        throw new Error('ระบบยังยืนยันผลการลบรูปไม่ได้ ลองกดลบรูปเดิมอีกครั้งเพื่อให้ระบบตรวจซ้ำ')
      }
      storageRemoved = true

      const { data: finalized, error: finalizeError } = await supabase.rpc('ais_task_evidence_delete_finalize', {
        p_task_id: taskId, p_slot: slot, p_reservation_token: reservationToken,
      })
      if (finalizeError || (finalized as { status?: unknown } | null)?.status !== 'removed') {
        throw new Error('ลบไฟล์รูปแล้ว แต่ยังบันทึกประวัติไม่สำเร็จ กดลบรูปเดิมอีกครั้งเพื่อให้ระบบยืนยันต่อ')
      }
      setActionMessage('ลบหลักฐานแล้ว และบันทึกผู้ดำเนินการไว้ในประวัติ')
      await loadEvidence()
    } catch (error) {
      if (reservationToken && !storageRemoved) {
        try {
          await supabase.rpc('ais_task_evidence_delete_cancel', {
            p_task_id: taskId, p_slot: slot, p_reservation_token: reservationToken,
          })
        } catch {
          // A failed Storage request may still have removed the object. Keep the reservation for a safe retry.
        }
      }
      setActionMessage(slotErrorMessage(error))
      await loadEvidence()
    } finally {
      setBusySlot(null)
    }
  }

  const retryFinalize = async (slot: EvidenceSlot) => {
    if (!supabase || !canEditSlot(slot)) return
    setBusySlot(slot)
    setActionMessage('')
    try {
      const { data, error } = await supabase.rpc('ais_task_evidence_finalize', { p_task_id: taskId, p_slot: slot })
      const status = (data as { status?: unknown } | null)?.status
      if (error || status !== 'ready') setActionMessage('ยังยืนยันไฟล์ไม่ได้ เลือกรูป/เซ็นใหม่แล้วบันทึกซ้ำได้')
      else setActionMessage('ยืนยันหลักฐานแล้ว')
      await loadEvidence()
    } catch {
      setActionMessage('ยังยืนยันไฟล์ไม่ได้ ตรวจสัญญาณอินเทอร์เน็ต แล้วลองอีกครั้ง')
      await loadEvidence()
    } finally {
      setBusySlot(null)
    }
  }

  return <section className="detail-section task-evidence-panel" aria-labelledby="task-evidence-title">
    <div className="task-evidence-heading">
      <div><h3 id="task-evidence-title">รูปภาพและลายเซ็นประกอบใบงาน</h3><p>แนบหลักฐานของ “{outcomeLabel(outcome)}” ได้ทันที ระบบเริ่มบันทึกการปฏิบัติงานเมื่อเริ่มแนบหลักฐาน</p></div>
      {stageRequiredSlots.length > 0 ? <span className={'evidence-completion-badge' + (stageRequiredSlots.every(slot => entries[slot]?.status === 'ready' && entries[slot]?.outcome_context === outcome) ? ' is-ready' : '')}>
        {stageRequiredSlots.filter(slot => entries[slot]?.status === 'ready' && entries[slot]?.outcome_context === outcome).length}/{stageRequiredSlots.length} รายการ
      </span> : <span className="evidence-completion-badge">ไม่บังคับ</span>}
    </div>
    {previewOnly && <p className="detail-empty-result">ตัวอย่างนี้ไม่มีรูปหรือลายเซ็นจริงให้ดู และไม่เชื่อมต่อเพื่อบันทึกหลักฐาน</p>}
    {!supabase && !previewOnly && <p className="task-action-error" role="alert">ระบบยังไม่เชื่อมต่อฐานข้อมูล จึงบันทึกหลักฐานไม่ได้</p>}
    {loadState === 'loading' && <p className="evidence-status" role="status">กำลังโหลดหลักฐาน…</p>}
    {loadError && <div className="task-action-error" role="alert">{loadError} <button type="button" className="text-button" onClick={() => void loadEvidence()}>ลองอีกครั้ง</button></div>}

    <div className="task-evidence-grid">
      {PHOTO_SLOTS.map(slot => {
        const entry = entries[slot.key]
        const imageUrl = previewUrls[slot.key]
        const matchesOutcome = entry?.outcome_context === outcome
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
        const statusLabel = isRequired
          ? entry?.status === 'ready' && !matchesOutcome ? 'ต้องบันทึกใหม่' : 'จำเป็นในขั้นนี้'
          : entry?.status === 'ready' ? 'บันทึกแล้ว' : slot.required ? 'ใช้ในขั้นอื่น' : 'ไม่บังคับ'
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
        return <Fragment key={slot.key}>
          {'section' in slot && <h4 className="task-evidence-group-title">{slot.section}</h4>}
          <Box component="article" sx={{
            minWidth: 0,
            display: 'grid',
            gridTemplateColumns: { xs: '54px minmax(0, 1fr) 44px', sm: '58px minmax(0, 1fr) auto' },
            gridTemplateRows: 'auto auto auto',
            gridTemplateAreas: '"preview heading action" "preview hint action" "state state state"',
            alignContent: 'center',
            alignItems: 'center',
            columnGap: { xs: 1, sm: 1.25 },
            rowGap: '3px',
            px: { xs: 1, sm: 1.25 },
            py: 1,
            border: '1px solid #eceae6',
            borderRadius: '13px',
            bgcolor: '#fff',
            transition: 'border-color 140ms ease',
            '&:hover': { borderColor: '#dbe7d3' },
          }}>
            <Box sx={{ gridArea: 'heading', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 0.75 }}>
              <Typography component="strong" sx={{ minWidth: 0, color: '#343a43', fontSize: 11, fontWeight: 700, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{label}</Typography>
              <Chip
                size="small"
                label={statusLabel}
                sx={{
                  flexShrink: 0,
                  height: 20,
                  borderRadius: '999px',
                  color: isRequired && !(entry?.status === 'ready' && matchesOutcome) ? '#8b461f' : entry?.status === 'ready' ? '#376e28' : '#6a717a',
                  bgcolor: isRequired && !(entry?.status === 'ready' && matchesOutcome) ? '#fff0e7' : entry?.status === 'ready' ? '#edf8e8' : '#f1f2f3',
                  '& .MuiChip-label': { px: 0.75, fontSize: 8, fontWeight: 700 },
                }}
              />
            </Box>
            <Typography component="p" sx={{ gridArea: 'hint', minWidth: 0, m: 0, color: '#757b84', fontSize: 9, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{hint}</Typography>
            {imageUrl ? <Box component="a" href={imageUrl} target="_blank" rel="noreferrer" aria-label={`เปิดดูรูป ${label} ขนาดเต็ม`} sx={{
              gridArea: 'preview', minWidth: 0, width: { xs: 54, sm: 58 }, height: { xs: 54, sm: 58 }, display: 'grid', placeItems: 'center', overflow: 'hidden',
              border: '1px solid #eeece8', borderRadius: '10px', bgcolor: '#f8f7f5',
            }}>
              <Box component="img" src={imageUrl} alt={`หลักฐาน ${label}`} sx={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
            </Box> : <Box aria-label={missingPreviewMessage} sx={{
              gridArea: 'preview', minWidth: 0, width: { xs: 54, sm: 58 }, height: { xs: 54, sm: 58 }, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px', p: 0.5,
              overflow: 'hidden', border: '1px dashed #dfddd9', borderRadius: '10px', color: previewStatuses[slot.key] === 'error' ? '#84512e' : '#858b93', bgcolor: previewStatuses[slot.key] === 'error' ? '#fff8f0' : '#faf9f7',
            }}>
              {previewStatuses[slot.key] === 'loading' ? <LoaderCircle className="evidence-spinner" size={17} /> : <ImagePlus size={17} />}
              <Typography component="span" sx={{ maxWidth: '100%', color: 'inherit', fontSize: 7, lineHeight: 1.15, textAlign: 'center' }}>{missingPreviewMessage}</Typography>
            </Box>}
            {(entry?.status === 'ready' || entry?.status === 'pending') && <Box sx={{ gridArea: 'state', minWidth: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75, color: entry.status === 'ready' ? '#3e792d' : '#965528', fontSize: 9, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
              {entry.status === 'ready' ? <>
                <Check size={14} />
                <Typography component="span" sx={{ color: 'inherit', fontSize: 'inherit' }}>บันทึกแล้วสำหรับ “{outcomeLabel(entry.outcome_context)}” · {(entry.byte_size / 1024).toFixed(0)} KB</Typography>
                {canEditSlot(slot.key) && <Button type="button" size="small" color="inherit" disabled={busySlot !== null} onClick={() => void removeEvidence(slot.key)} startIcon={<Trash2 size={13} />} sx={{ minWidth: 0, minHeight: { xs: 44, sm: 'auto' }, px: { xs: 0.75, sm: 0 }, py: 0, fontSize: 9, lineHeight: 1.3, textTransform: 'none' }}>ลบรูป</Button>}
                {previewStatuses[slot.key] === 'error' && <><Typography component="span" sx={{ color: 'inherit', fontSize: 'inherit' }}>โหลดภาพไม่สำเร็จ</Typography><Button type="button" size="small" onClick={retryPreviews} sx={{ minWidth: 0, minHeight: { xs: 44, sm: 'auto' }, px: { xs: 0.75, sm: 0 }, py: 0, fontSize: 9, lineHeight: 1.3, textTransform: 'none' }}>ลองโหลดอีกครั้ง</Button></>}
              </> : <>
                <Typography component="span" sx={{ color: 'inherit', fontSize: 'inherit' }}>การบันทึกยังไม่สมบูรณ์</Typography>
                {canEditSlot(slot.key) && entry.can_finalize && <Button type="button" size="small" disabled={busySlot !== null} startIcon={<RotateCcw size={13} />} onClick={() => void retryFinalize(slot.key)} sx={{ minWidth: 0, minHeight: { xs: 44, sm: 'auto' }, px: { xs: 0.75, sm: 0 }, py: 0, fontSize: 9, lineHeight: 1.3, textTransform: 'none' }}>ลองยืนยันไฟล์เดิม</Button>}
              </>}
            </Box>}
            {canEditSlot(slot.key) && <Button
              type="button"
              variant="outlined"
              color="inherit"
              aria-label={`${entry?.status === 'ready' ? 'เปลี่ยน' : 'เพิ่ม'}รูป: ${label}`}
              disabled={busySlot !== null}
              onClick={() => photoInputRefs.current[slot.key]?.click()}
              startIcon={<ImagePlus size={16} />}
              sx={{
                gridArea: 'action', width: { xs: 44, sm: 'auto' }, minWidth: { xs: 44, sm: 88 }, minHeight: { xs: 44, sm: 34 }, px: { xs: 0, sm: 1 },
                borderColor: '#e2e5e9', borderRadius: '9px', color: '#555c67', fontFamily: 'inherit', fontSize: 9, lineHeight: 1.2, textTransform: 'none', whiteSpace: 'nowrap',
                '& .MuiButton-startIcon': { mx: { xs: 0, sm: '5px' } },
              }}
            >
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{busySlot === slot.key ? 'กำลังบันทึก…' : entry?.status === 'ready' ? 'เปลี่ยนรูป' : 'เพิ่มรูป'}</Box>
            </Button>}
            {canEditSlot(slot.key) && <Box
              component="input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label={`${entry?.status === 'ready' ? 'เปลี่ยน' : 'เพิ่ม'}รูป: ${label}`}
              tabIndex={-1}
              aria-hidden="true"
              ref={(element: HTMLInputElement | null) => { photoInputRefs.current[slot.key] = element }}
              onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void savePhoto(slot.key, file) }}
              sx={{ position: 'absolute', width: '1px', height: '1px', p: 0, m: '-1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}
            />}
          </Box>
        </Fragment>
      })}
    </div>

    <div className="task-evidence-signatures">
      <h4>ลายเซ็นผู้เกี่ยวข้อง</h4>
      <div className="task-evidence-grid signature-grid">
        {SIGNATURE_SLOTS.map(slot => <SignatureEntry
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
          needsName={slot.key === 'scanner_user_signature' || slot.key === 'inspector_signature'}
          required={stageRequiredSlots.includes(slot.key)}
          onSave={saveBlob}
          onRetry={() => void retryFinalize(slot.key)}
          onRetryPreview={retryPreviews}
          showEmpty={previewOnly || loadState === 'ready'}
        />)}
      </div>
    </div>
    {actionMessage && <p className="task-evidence-message" role="status">{actionMessage}</p>}
    {stageEditableSlots.some(slot => canEditSlot(slot)) && <p className="evidence-storage-note">รูปจะถูกย่อเป็น JPEG เพื่อเก็บในพื้นที่ฟรีของระบบ (สูงสุด 90 KB ต่อรูป และ 32 KB ต่อลายเซ็น) หากอ่านเลข SN ไม่ชัด ให้ครอปเฉพาะฉลากแล้วถ่ายใหม่</p>}
  </section>
}

function SignatureEntry({
  slot, label, hint, entry, outcome, previewUrl, previewStatus, canEdit, busy, disabled, needsName, required, onSave, onRetry, onRetryPreview, showEmpty,
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
  needsName: boolean
  required: boolean
  showEmpty: boolean
  onSave: (slot: EvidenceSlot, blob: Blob, signerName?: string | null) => Promise<boolean>
  onRetry: () => void
  onRetryPreview: () => void
}) {
  const padRef = useRef<SignaturePadHandle>(null)
  const [signerName, setSignerName] = useState(entry?.signer_name || '')
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const canSubmit = canEdit && consent && (!needsName || Boolean(signerName.trim())) && !disabled
  const showEditor = canEdit && (entry?.status !== 'ready' ? showEmpty : editing)
  useEffect(() => {
    setSignerName(entry?.signer_name || '')
    if (entry?.status === 'ready') setEditing(false)
  }, [entry?.signer_name, entry?.status])
  const saveSignature = async () => {
    setError('')
    try {
      const blob = await padRef.current?.exportJpeg()
      if (!blob) throw new Error('กรุณาเซ็นชื่อให้ครบก่อนบันทึก')
      if (blob.size > MAX_SIGNATURE_BYTES) throw new Error('ลายเซ็นใหญ่เกิน 32 KB กรุณาเซ็นใหม่')
      const saved = await onSave(slot, blob, needsName ? signerName.trim() : null)
      if (saved) {
        padRef.current?.clear()
        setConsent(false)
      }
    } catch (caught) {
      setError(String((caught as { message?: unknown })?.message || 'กรุณาตรวจลายเซ็นแล้วลองใหม่'))
    }
  }
  return <article className="task-evidence-card signature-card">
    <div className="task-evidence-card-heading"><strong>{label}</strong><span className={required ? 'evidence-required' : 'evidence-optional'}>{required ? (entry?.status === 'ready' && entry.outcome_context !== outcome ? 'ต้องบันทึกใหม่' : 'จำเป็นในขั้นนี้') : entry?.status === 'ready' ? 'บันทึกแล้ว' : 'ใช้ในขั้นอื่น'}</span></div>
          <p>{hint}</p>
    {needsName && canEdit && <label className="evidence-signer-name">ชื่อ-นามสกุลผู้ลงนาม<input value={signerName} onChange={event => setSignerName(event.target.value)} maxLength={120} autoComplete="name" required /></label>}
    {entry?.status === 'ready' && (previewUrl ? <a className="task-evidence-preview signature-preview" href={previewUrl} target="_blank" rel="noreferrer"><img src={previewUrl} alt={`ลายเซ็น ${label}`} /></a> : previewStatus === 'loading' ? <div className="task-evidence-empty"><LoaderCircle className="evidence-spinner" size={18} /><span>กำลังโหลดลายเซ็น…</span></div> : <div className="task-evidence-image-missing">โหลดลายเซ็นไม่สำเร็จ <button type="button" className="text-button" onClick={onRetryPreview}>ลองโหลดอีกครั้ง</button></div>)}
    {entry?.status === 'ready' && <div className="task-evidence-saved"><Check size={14} />{entry.signer_name ? `ลงชื่อโดย ${entry.signer_name}` : 'บันทึกลายเซ็นแล้ว'} · {outcomeLabel(entry.outcome_context)}</div>}
    {entry?.status === 'pending' && <div className="task-evidence-pending">ลายเซ็นยังรอยืนยัน</div>}
    {!entry && !canEdit && showEmpty && <div className="task-evidence-empty">ยังไม่มีลายเซ็น</div>}
    {canEdit && entry?.status === 'ready' && !editing && <button type="button" className="text-button" disabled={disabled} onClick={() => setEditing(true)}>แก้ไขลายเซ็น</button>}
    {showEditor && <>
      {entry?.status === 'ready' && <button type="button" className="text-button" disabled={disabled} onClick={() => setEditing(false)}>ยกเลิกแก้ไข</button>}
      <SignaturePad ref={padRef} label={`ช่องลายเซ็น ${label}`} disabled={disabled} />
      <div className="evidence-signature-controls"><button type="button" className="text-button" disabled={disabled} onClick={() => padRef.current?.clear()}><Trash2 size={14} /> ล้างลายเซ็น</button></div>
      <label className="evidence-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={disabled} /><span>ผู้ลงนามยืนยันและยินยอมให้บันทึกลายเซ็นนี้เป็นหลักฐานในใบงาน</span></label>
      {error && <p className="task-action-error" role="alert">{error}</p>}
      <button type="button" className="primary-button evidence-save-signature" disabled={!canSubmit || busy} onClick={() => void saveSignature()}>
        {busy ? <><LoaderCircle className="evidence-spinner" size={16} /> กำลังบันทึก…</> : <><Save size={16} />{entry?.status === 'ready' ? 'บันทึกลายเซ็นใหม่' : 'บันทึกลายเซ็น'}</>}
      </button>
      {entry?.status === 'pending' && entry.can_finalize && <button type="button" className="text-button" disabled={disabled} onClick={onRetry}><RotateCcw size={14} /> ลองยืนยันไฟล์เดิม</button>}
    </>}
  </article>
}
