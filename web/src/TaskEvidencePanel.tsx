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
    const height = Math.max(1, bounds.heu��6����k�w��p)', whiteSpace: 'nowrap', border: 0 }}
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
