import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Check, ImagePlus, LoaderCircle, RotateCcw, Save, Trash2 } from 'lucide-react'
import { supabase } from './supabase'

const PHOTO_SLOTS = [
  { key: 'old_serial_photo', label: 'SN เครื่องเดิม', required: true, hint: 'ถ่ายฉลาก Serial ของ Scanner เครื่องเดิมให้เห็นเลขชัดเจน' },
  { key: 'new_serial_photo', label: 'SN เครื่องใหม่', required: true, hint: 'ถ่ายฉลาก Serial ของ Scanner เครื่องใหม่ให้เห็นเลขชัดเจน' },
  { key: 'old_device_photo', label: 'เครื่องเดิม', required: true, hint: 'ถ่ายสภาพ Scanner เครื่องเดิมก่อนถอดหรือส่งคืน' },
  { key: 'new_device_photo', label: 'เครื่องใหม่', required: true, hint: 'ถ่าย Scanner เครื่องใหม่หลังติดตั้งและทดสอบ' },
  { key: 'spare_photo_1', label: 'รูปสำรอง 1', required: false, hint: 'แนบภาพประกอบเพิ่มเติม (ถ้ามี)' },
  { key: 'spare_photo_2', label: 'รูปสำรอง 2', required: false, hint: 'แนบภาพประกอบเพิ่มเติม (ถ้ามี)' },
] as const

const SIGNATURE_SLOTS = [
  { key: 'technician_signature', label: 'ผู้ปฏิบัติงานที่เข้าสาขา', hint: 'ช่าง Onsite หรือ Admin ที่ลงพื้นที่ต้องลงลายเซ็น ระบบบันทึกบัญชีและเวลาปฏิบัติงานประกอบ' },
  { key: 'scanner_user_signature', label: 'ผู้ใช้งาน Scanner', hint: 'ผู้ใช้งานประจำลงชื่อรับรองการเปลี่ยนเครื่อง' },
  { key: 'inspector_signature', label: 'Admin ผู้ตรวจรับ', hint: 'Admin อีกบัญชีลงชื่อรับรองหลังตรวจหลักฐาน ผู้ปฏิบัติงานห้ามตรวจรับงานของตนเอง' },
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
}
type Point = { x: number; y: number }

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
  if (message.includes('outside your assigned') || message.includes('permission denied')) return 'บัญชีนี้ไม่มีสิทธิ์บันทึกหลักฐานของใบงานนี้'
  if (message.includes('signer name') || message.includes('signature and consent')) return 'กรอกชื่อผู้ลงนามและยืนยันการบันทึกลายเซ็นก่อน'
  return 'บันทึกหลักฐานไม่สำเร็จ ตรวจสัญญาณอินเทอร์เน็ต แล้วลองอีกครั้ง'
}

export default function TaskEvidencePanel({ taskId, canEdit, canView, previewOnly = false, outcome, editableSlots, requiredSlots, onRequiredReady, onBusyChange }: TaskEvidencePanelProps) {
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
  const requiredReadyRef = useRef(onRequiredReady)
  const busyCallbackRef = useRef(onBusyChange)
  useEffect(() => { requiredReadyRef.current = onRequiredReady }, [onRequiredReady])
  useEffect(() => { busyCallbackRef.current = onBusyChange }, [onBusyChange])
  useEffect(() => { busyCallbackRef.current(busySlot !== null) }, [busySlot])

  const loadEvidence = useCallback(async () => {
    if (!supabase || !canView || !taskId) {
      setEntries({})
      setPreviewUrls({})
      setPreviewStatuses({})
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
    const { data, error } = await supabase.rpc('ais_task_evidence_list', { p_task_id: taskId })
    if (error) {
      setEntries({})
      setLoadError('โหลดหลักฐานไม่ได้ บัญชีนี้อาจไม่มีสิทธิ์ดูใบงาน หรือการเชื่อมต่อขัดข้อง')
      setLoadState('error')
      requiredReadyRef.current(false)
      return
    }
    const nextEntries = toEntryMap(data)
    setEntries(nextEntries)
    requiredReadyRef.current(stageRequiredSlots.every(slot => nextEntries[slot]?.status === 'ready'))
    setLoadState('ready')
  }, [canView, taskId, stageRequiredSlots])

  useEffect(() => { void loadEvidence() }, [loadEvidence])

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
        const { data, error } = await client.storage.from(EVIDENCE_BUCKET).download(entry.path)
        if (error || !data) return [entry.slot, null] as const
        return [entry.slot, URL.createObjectURL(data)] as const
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
    try {
      const isSignature = SIGNATURE_SLOTS.some(item => item.key === slot)
      if (blob.size > (isSignature ? MAX_SIGNATURE_BYTES : MAX_PHOTO_BYTES)) {
        throw new Error(isSignature ? 'ลายเซ็นใหญ่เกิน 32 KB กรุณาเซ็นใหม่' : 'รูปใหญ่เกิน 90 KB กรุณาครอปภาพแล้วลองใหม่')
      }
      const { data: reservation, error: reserveError } = await supabase.rpc('ais_task_evidence_reserve', {
        p_task_id: taskId,
        p_slot: slot,
        p_byte_size: blob.size,
        p_signer_name: signerName,
        p_consent_confirmed: isSignature,
      })
      if (reserveError) throw reserveError
      const reservationToken = (reservation as { reservation_token?: unknown } | null)?.reservation_token
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
        if (recovery.error) {
          await supabase.rpc('ais_task_evidence_cancel_pending', { p_task_id: taskId, p_slot: slot })
          throw uploadError
        }
      } else {
        const { error: finalizeError } = await supabase.rpc('ais_task_evidence_finalize', { p_task_id: taskId, p_slot: slot })
        if (finalizeError) throw finalizeError
      }
      setActionMessage('บันทึกหลักฐานแล้ว')
      await loadEvidence()
      return true
    } catch (error) {
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
      setBusySlot(null)
      await saveBlob(slot, blob)
    } catch (error) {
      setBusySlot(null)
      setActionMessage(slotErrorMessage(error))
    }
  }

  const retryFinalize = async (slot: EvidenceSlot) => {
    if (!supabase || !canEditSlot(slot)) return
    setBusySlot(slot)
    setActionMessage('')
    const { error } = await supabase.rpc('ais_task_evidence_finalize', { p_task_id: taskId, p_slot: slot })
    if (error) setActionMessage('ยังยืนยันไฟล์ไม่ได้ เลือกรูป/เซ็นใหม่แล้วบันทึกซ้ำได้')
    else setActionMessage('ยืนยันหลักฐานแล้ว')
    await loadEvidence()
    setBusySlot(null)
  }

  return <section className="detail-section task-evidence-panel" aria-labelledby="task-evidence-title">
    <div className="task-evidence-heading">
      <div><h3 id="task-evidence-title">รูปภาพและลายเซ็นของใบงาน</h3><p>หลักฐานจะเปลี่ยนตามผลที่บันทึก รายการที่ระบุว่า “จำเป็นในขั้นนี้” ต้องครบก่อนส่งผลปฏิบัติงานหรือ Admin ตรวจรับ</p></div>
      {stageRequiredSlots.length > 0 ? <span className={'evidence-completion-badge' + (stageRequiredSlots.every(slot => entries[slot]?.status === 'ready') ? ' is-ready' : '')}>
        {stageRequiredSlots.filter(slot => entries[slot]?.status === 'ready').length}/{stageRequiredSlots.length} รายการ
      </span> : <span className="evidence-completion-badge">หลักฐานที่บันทึกไว้</span>}
    </div>
    {previewOnly && <p className="detail-empty-result">ตัวอย่างนี้ไม่มีรูปหรือลายเซ็นจริงให้ดู และไม่เชื่อมต่อเพื่อบันทึกหลักฐาน</p>}
    {!supabase && !previewOnly && <p className="task-action-error" role="alert">ระบบยังไม่เชื่อมต่อฐานข้อมูล จึงบันทึกหลักฐานไม่ได้</p>}
    {loadState === 'loading' && <p className="evidence-status" role="status">กำลังโหลดหลักฐาน…</p>}
    {loadError && <div className="task-action-error" role="alert">{loadError} <button type="button" className="text-button" onClick={() => void loadEvidence()}>ลองอีกครั้ง</button></div>}

    <div className="task-evidence-grid">
      {PHOTO_SLOTS.map(slot => {
        const entry = entries[slot.key]
        const imageUrl = previewUrls[slot.key]
        const label = outcome === 'different_device_found' && slot.key === 'new_serial_photo'
          ? 'SN เครื่องที่พบ'
          : outcome === 'different_device_found' && slot.key === 'new_device_photo'
            ? 'อุปกรณ์ที่พบ'
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
        return <article className="task-evidence-card" key={slot.key}>
          <div className="task-evidence-card-heading"><strong>{label}</strong><span className={stageRequiredSlots.includes(slot.key) ? 'evidence-required' : 'evidence-optional'}>{stageRequiredSlots.includes(slot.key) ? 'จำเป็นในขั้นนี้' : entry?.status === 'ready' ? 'บันทึกแล้ว' : slot.required ? 'ใช้ในขั้นอื่น' : 'สำรอง'}</span></div>
          <p>{hint}</p>
          {imageUrl ? <a className="task-evidence-preview" href={imageUrl} target="_blank" rel="noreferrer" aria-label={`เปิดดูรูป ${label} ขนาดเต็ม`}><img src={imageUrl} alt={`หลักฐาน ${label}`} /></a> : entry?.status === 'ready' ? previewStatuses[slot.key] === 'loading' ? <div className="task-evidence-empty"><LoaderCircle className="evidence-spinner" size={18} /><span>กำลังโหลดภาพ…</span></div> : <div className="task-evidence-image-missing">โหลดภาพไม่สำเร็จ <button type="button" className="text-button" onClick={retryPreviews}>ลองโหลดอีกครั้ง</button></div> : <div className="task-evidence-empty"><ImagePlus size={20} /><span>{entry?.status === 'pending' ? 'รอการยืนยัน' : loadState === 'loading' ? 'กำลังตรวจสอบรายการ…' : loadState === 'error' ? 'ตรวจสอบรูปไม่ได้' : 'ยังไม่มีรูป'}</span></div>}
          {entry?.status === 'ready' && <div className="task-evidence-saved"><Check size={14} />บันทึกแล้ว · {(entry.byte_size / 1024).toFixed(0)} KB</div>}
          {entry?.status === 'pending' && <div className="task-evidence-pending">การบันทึกยังไม่สมบูรณ์</div>}
          {canEditSlot(slot.key) && <label className="secondary-button evidence-upload-button">
            <ImagePlus size={16} />{busySlot === slot.key ? 'กำลังบันทึก…' : entry?.status === 'ready' ? 'ถ่าย/เลือกรูปใหม่' : 'ถ่าย/เลือกรูป'}
            <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={busySlot !== null} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void savePhoto(slot.key, file) }} />
          </label>}
          {canEditSlot(slot.key) && entry?.status === 'pending' && entry.can_finalize && <button type="button" className="text-button" disabled={busySlot !== null} onClick={() => void retryFinalize(slot.key)}><RotateCcw size={14} /> ลองยืนยันไฟล์เดิม</button>}
        </article>
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
          previewUrl={previewUrls[slot.key]}
          previewStatus={previewStatuses[slot.key]}
          canEdit={canEditSlot(slot.key)}
          busy={busySlot === slot.key}
          disabled={busySlot !== null}
          needsName={slot.key === 'scanner_user_signature'}
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
  slot, label, hint, entry, previewUrl, previewStatus, canEdit, busy, disabled, needsName, required, onSave, onRetry, onRetryPreview, showEmpty,
}: {
  slot: SignatureSlot
  label: string
  hint: string
  entry?: EvidenceEntry
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
  const canSubmit = canEdit && consent && (!needsName || Boolean(signerName.trim())) && !disabled
  useEffect(() => { setSignerName(entry?.signer_name || '') }, [entry?.signer_name])
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
    <div className="task-evidence-card-heading"><strong>{label}</strong><span className={required ? 'evidence-required' : 'evidence-optional'}>{required ? 'จำเป็นในขั้นนี้' : entry?.status === 'ready' ? 'บันทึกแล้ว' : 'ใช้ในขั้นอื่น'}</span></div>
          <p>{hint}</p>
    {needsName && canEdit && <label className="evidence-signer-name">ชื่อ-นามสกุลผู้ลงนาม<input value={signerName} onChange={event => setSignerName(event.target.value)} maxLength={120} autoComplete="name" required /></label>}
    {entry?.status === 'ready' && (previewUrl ? <a className="task-evidence-preview signature-preview" href={previewUrl} target="_blank" rel="noreferrer"><img src={previewUrl} alt={`ลายเซ็น ${label}`} /></a> : previewStatus === 'loading' ? <div className="task-evidence-empty"><LoaderCircle className="evidence-spinner" size={18} /><span>กำลังโหลดลายเซ็น…</span></div> : <div className="task-evidence-image-missing">โหลดลายเซ็นไม่สำเร็จ <button type="button" className="text-button" onClick={onRetryPreview}>ลองโหลดอีกครั้ง</button></div>)}
    {entry?.status === 'ready' && <div className="task-evidence-saved"><Check size={14} />{entry.signer_name ? `ลงชื่อโดย ${entry.signer_name}` : 'บันทึกลายเซ็นแล้ว'}</div>}
    {entry?.status === 'pending' && <div className="task-evidence-pending">ลายเซ็นยังรอยืนยัน</div>}
    {!entry && !canEdit && showEmpty && <div className="task-evidence-empty">ยังไม่มีลายเซ็น</div>}
    {canEdit && <>
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
