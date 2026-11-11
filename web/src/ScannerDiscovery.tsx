import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import { supabase } from './supabase'
import { getTopmostActiveDialog, isTopmostActiveDialog, lockBodyScroll, registerActiveDialog } from './dialog'

export type BranchReference = { id: unknown; name: unknown; code: unknown; province: unknown }
type DiscoveryReport = Record<string, unknown>

function formatDate(value: unknown) {
  if (!value) return '—'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function useDialogRef(onClose: () => void, busy: boolean) {
  const ref = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  onCloseRef.current = onClose
  busyRef.current = busy
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const releaseBodyScroll = lockBodyScroll()
    const unregisterDialog = registerActiveDialog(ref.current)
    const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(focusableSelector) || [])
    const handleKey = (event: KeyboardEvent) => {
      if (!isTopmostActiveDialog(ref.current)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busyRef.current) onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const controls = focusable()
      if (!controls.length) {
        event.preventDefault()
        ref.current?.focus()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    const focusFrame = window.requestAnimationFrame(() => focusable()[0]?.focus())
    window.addEventListener('keydown', handleKey)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleKey)
      unregisterDialog()
      releaseBodyScroll()
      if (previousFocus && previousFocus !== document.body && previousFocus.isConnected && !previousFocus.closest('[inert]')) {
        previousFocus.focus()
      } else {
        const parentDialog = getTopmostActiveDialog()
        ;(parentDialog?.querySelector<HTMLElement>(focusableSelector) || parentDialog)?.focus()
      }
    }
  }, [])
  return ref
}

function Alert({ children }: { children: string }) {
  return <div className="task-action-error" role="alert">{children}</div>
}

export function ScannerDiscoveryDialog({ branch, onClose, onReported }: { branch: BranchReference; onClose: () => void; onReported: () => void }) {
  const [serial, setSerial] = useState('')
  const [model, setModel] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useDialogRef(onClose, busy)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    const cleanSerial = serial.trim()
    const cleanModel = model.trim()
    const cleanNotes = notes.trim()
    const branchId = String(branch.id || '')
    if (!branchId || !cleanSerial || cleanSerial.length > 100 || cleanModel.length > 160 || cleanNotes.length > 1000) {
      setError('กรอก SN ให้ถูกต้อง และจำกัดรุ่น 160 ตัวอักษร หมายเหตุ 1,000 ตัวอักษร')
      return
    }
    if (!supabase) { setError('เชื่อมต่อระบบไม่ได้ โปรดลองใหม่'); return }
    setBusy(true)
    try {
      const { error } = await supabase.rpc('ais_report_unregistered_scanner', {
        p_branch_id: branchId,
        p_serial_number: cleanSerial,
        p_observed_model: cleanModel || null,
        p_notes: cleanNotes || null,
      })
      if (error) {
        if (error.code === '23505') setError('SN นี้อยู่ในทะเบียนหรือมีรายงานรอตรวจแล้ว หากพบผิดสาขาให้บันทึกเป็นกรณีเครื่องที่พบไม่ตรงกับงาน')
        else if (error.code === '42501') setError('บัญชีนี้ไม่มีสิทธิ์รายงาน Scanner')
        else setError('ส่งรายงานไม่สำเร็จ โปรดตรวจ SN และการเชื่อมต่อ')
        return
      }
      onReported()
    } catch { setError('เชื่อมต่อระบบไม่ได้ โปรดตรวจสถานะแล้วลองใหม่') }
    finally { setBusy(false) }
  }
  return <div className="detail-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialogRef} className="detail-dialog scanner-discovery-dialog" role="dialog" aria-modal="true" aria-labelledby="scanner-discovery-title" tabIndex={-1}>
      <header className="detail-dialog-header"><div><span className="detail-eyebrow">รายงานให้ Admin ตรวจสอบ</span><h2 id="scanner-discovery-title">พบ Scanner นอกทะเบียน</h2></div><button type="button" className="detail-close" aria-label="ปิดหน้ารายงาน" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <div className="detail-section scanner-discovery-branch"><strong>{String(branch.name || 'สาขา')}</strong><span>LocationCode {String(branch.code || '—')} · {String(branch.province || 'ไม่ระบุจังหวัด')}</span></div>
      <form className="scanner-discovery-form" onSubmit={submit}>
        <label>Serial Number ที่พบ *<input value={serial} onChange={event => setSerial(event.target.value)} maxLength={100} required autoFocus autoComplete="off" /></label>
        <label>รุ่น (ถ้าทราบ)<input value={model} onChange={event => setModel(event.target.value)} maxLength={160} autoComplete="off" /></label>
        <label>รายละเอียด/จุดที่พบ<textarea value={notes} onChange={event => setNotes(event.target.value)} maxLength={1000} rows={3} /></label>
        <p>รายงานนี้จะเข้าคิวให้ Admin ตรวจ SN และสาขาก่อนเพิ่มเข้าในทะเบียน ระบบจะไม่เพิ่มอุปกรณ์ซ้ำหรือย้ายเครื่องให้อัตโนมัติ</p>
        {error && <Alert>{error}</Alert>}
        <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>ยกเลิก</button><button className="primary-button" disabled={busy}>{busy ? 'กำลังส่งรายงาน…' : 'ส่งให้ Admin ตรวจสอบ'}</button></footer>
      </form>
    </section>
  </div>
}

export function ScannerDiscoveryQueue({ onUpdated }: { onUpdated: (action: string) => void }) {
  const [reports, setReports] = useState<DiscoveryReport[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loadedPage, setLoadedPage] = useState<number | null>(null)
  const [busyReport, setBusyReport] = useState('')
  const [error, setError] = useState('')
  const [notesByReport, setNotesByReport] = useState<Record<string, string>>({})
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    const client = supabase
    if (!client) { setLoading(false); setError('เชื่อมต่อระบบไม่ได้'); return () => { active = false } }
    setLoading(true)
    setError('')
    setLoadedPage(null)
    void (async () => {
      try {
        const { data, error } = await client.rpc('ais_scanner_discovery_queue', { p_limit: 50, p_offset: page * 50 })
        if (error) throw error
        const result = data as { rows?: unknown; total?: unknown } | null
        if (active) {
          setReports(Array.isArray(result?.rows) ? result.rows.filter((row): row is DiscoveryReport => Boolean(row) && typeof row === 'object') : [])
          setTotal(Math.max(0, Number(result?.total) || 0))
          setLoadedPage(page)
        }
      } catch {
        if (active) setError('โหลดรายการรายงานไม่สำเร็จ โปรดลองใหม่')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [page, reload])
  const review = async (reportId: string, decision: 'approve' | 'reject') => {
    if (!supabase || busyReport) return
    setBusyReport(reportId)
    setError('')
    try {
      const { error } = await supabase.rpc('ais_admin_review_scanner_discovery', {
        p_report_id: reportId,
        p_decision: decision,
        p_review_note: notesByReport[reportId]?.trim() || null,
      })
      if (error) throw error
      setNotesByReport(current => {
        const next = { ...current }
        delete next[reportId]
        return next
      })
      if (reports.length === 1 && loadedPage === page && page > 0) {
        setPage(value => Math.max(0, value - 1))
      } else {
        setReload(value => value + 1)
      }
      onUpdated('refresh')
    } catch { setError('บันทึกผลตรวจไม่สำเร็จ รายการอาจถูกตรวจไปแล้ว โปรดลองโหลดใหม่') }
    finally { setBusyReport('') }
  }
  const pageReports = loadedPage === page ? reports : []
  const retryLoad = () => setReload(value => value + 1)
  return <section className="panel scanner-discovery-queue" aria-labelledby="scanner-discovery-queue-title">
    <div className="panel-heading"><div><h2 id="scanner-discovery-queue-title">เครื่องที่ช่างรายงานว่าพบนอกทะเบียน</h2><p>ตรวจ SN และสาขาก่อนเพิ่มรายการใหม่ในทะเบียน</p></div><span className="discovery-count">{loading && loadedPage === null ? '…' : total.toLocaleString('th-TH')} รายการ</span></div>
    {error && <div className="scanner-discovery-load-error"><Alert>{error}</Alert><button type="button" className="secondary-button" disabled={loading} onClick={retryLoad}>{loading ? 'กำลังโหลด…' : 'ลองอีกครั้ง'}</button></div>}
    {loading && pageReports.length === 0 ? <p className="evidence-status">กำลังโหลดรายการรายงาน…</p> : pageReports.length ? <>
      {pageReports.map(report => {
        const id = String(report.id || '')
        return <article className="scanner-discovery-report" key={id}>
          <div><strong>SN {String(report.serial_number || '—')}</strong><span>{String(report.observed_model || 'ไม่ทราบรุ่น')}</span><small>{String(report.branch_name || 'สาขา')} · {String(report.location_code || '—')} · {String(report.province || '—')}</small><small>รายงานโดย {String(report.reported_by || 'ผู้ใช้')} · {formatDate(report.created_at)}</small>{Boolean(report.notes) && <p>{String(report.notes)}</p>}</div>
          <div className="scanner-discovery-actions"><input aria-label={`หมายเหตุ Admin สำหรับ SN ${String(report.serial_number || '')}`} placeholder="หมายเหตุ (ถ้ามี)" maxLength={1000} value={notesByReport[id] || ''} onChange={event => setNotesByReport(current => ({ ...current, [id]: event.target.value }))} /><button type="button" className="secondary-button" disabled={Boolean(busyReport)} onClick={() => void review(id, 'reject')}>{busyReport === id ? 'กำลังบันทึก…' : 'ปฏิเสธ'}</button><button type="button" className="primary-button" disabled={Boolean(busyReport)} onClick={() => void review(id, 'approve')}>{busyReport === id ? 'กำลังบันทึก…' : <><Check size={15} /> ตรวจแล้วเพิ่มทะเบียน</>}</button></div>
        </article>
      })}
    </> : error ? null : <div className="scanner-discovery-empty"><span><Plus size={17} /></span><strong>ไม่มีรายการรอตรวจ</strong><small>รายงานจากช่างจะปรากฏที่นี่ และจะยังไม่เพิ่มเข้าในทะเบียนจนกว่า Admin อนุมัติ</small></div>}
    {pageReports.length > 0 && total > 50 && <div className="list-footer"><span>แสดง {page * 50 + 1}–{Math.min(page * 50 + pageReports.length, total)} จาก {total.toLocaleString('th-TH')} รายการ</span><div><button type="button" className="icon-button" aria-label="หน้าก่อนหน้า" disabled={page === 0 || loading} onClick={() => setPage(value => Math.max(0, value - 1))}><ChevronLeft size={16} /></button><span className="page-number">{page + 1}</span><button type="button" className="icon-button" aria-label="หน้าถัดไป" disabled={(page + 1) * 50 >= total || loading} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button></div></div>}
  </section>
}
