import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { demoAssets } from './data'

type CampaignRow = Record<string, unknown>
type Device = { id: string; asset_id: string; serial: string; model: string }
type Branch = { branch_id: string; location_code: string; branch_name: string; selected_assets: number; devices: Device[] }
type CampaignPreview = { campaign_id: string; updated_at: string; selected_assets: number; branches: Branch[] }
type Scanner = { id: string; branch_name: string; location_code: string; model_name: string; com_sn: string; campaign?: string | null }
type CampaignAsset = { asset_id: string | null; task_id: string | null; serial: string; can_navigate: boolean; model: string; location_code: string; branch_name: string; province: string | null; task_status: string | null }

const taskStatusLabels: Record<string, string> = {
  scheduled: 'กำลังดำเนินการ', awaiting_confirmation: 'กำลังดำเนินการ', confirmed: 'กำลังดำเนินการ',
  in_progress: 'กำลังดำเนินการ', awaiting_admin_acceptance: 'Pending',
  awaiting_admin_exception_review: 'Pending · รอ Admin ตรวจ', delivered: 'Completed',
  completed: 'เสร็จสิ้น (ประวัติเดิม)', blocked: 'Pending', cancelled: 'ยกเลิก',
}
const taskStatusTones: Record<string, string> = {
  scheduled: 'scheduled', awaiting_confirmation: 'scheduled', confirmed: 'ready',
  in_progress: 'progress', awaiting_admin_acceptance: 'blocked', awaiting_admin_exception_review: 'blocked',
  delivered: 'done', completed: 'done', blocked: 'blocked', cancelled: 'neutral',
}

function isTransportUncertain(error: { code?: string; message?: string; status?: number }) {
  return error.status === 0 || !error.code || /failed to fetch|network|timed? ?out|connection/i.test(error.message || '')
}

export default function CampaignDetailsDialog({ campaign, role, demo, onClose, onUpdated, onOpenScanner, onOpenTask }: {
  campaign: CampaignRow
  role?: string
  demo: boolean
  onClose: () => void
  onUpdated: (message: string) => void
  onOpenScanner: (serial: string) => void
  onOpenTask: (assetId: string, taskId: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(busy)
  onCloseRef.current = onClose
  busyRef.current = busy
  const campaignId = String(campaign.id || '')
  const code = String(campaign.campaign_code || campaign.code || '')
  const name = String(campaign.campaign_name || campaign.name || 'รอบงานเปลี่ยนเครื่อง')
  const selectable = false
  const canManage = false
  const canEditSelection = false
  const [preview, setPreview] = useState<CampaignPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [previewRetry, setPreviewRetry] = useState(0)
  const [campaignAssets, setCampaignAssets] = useState<CampaignAsset[]>([])
  const [campaignAssetTotal, setCampaignAssetTotal] = useState(0)
  const [campaignAssetPage, setCampaignAssetPage] = useState(0)
  const [campaignAssetsLoading, setCampaignAssetsLoading] = useState(false)
  const [campaignAssetsError, setCampaignAssetsError] = useState('')
  const [campaignAssetsRetry, setCampaignAssetsRetry] = useState(0)
  const [editingSelection, setEditingSelection] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [scanners, setScanners] = useState<Scanner[]>([])
  const [scannerTotal, setScannerTotal] = useState(0)
  const [scannerLoading, setScannerLoading] = useState(false)
  const [scannerError, setScannerError] = useState('')
  const [scannerRetry, setScannerRetry] = useState(0)
  const [additions, setAdditions] = useState<Record<string, Scanner>>({})
  const [removals, setRemovals] = useState<string[]>([])
  const [selectionReason, setSelectionReason] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    dialogRef.current?.focus()
    document.body.style.overflow = 'hidden'
    const focusables = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || []).filter(element => element.tabIndex >= 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    requestAnimationFrame(() => focusables()[0]?.focus())
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    if (demo || !canManage || !selectable || !campaignId || !supabase) {
      setPreview(null)
      setPreviewLoading(false)
      setPreviewError('')
      return
    }
    let active = true
    setPreviewLoading(true)
    setPreviewError('')
    void (async () => {
      const result = await supabase.rpc('ais_campaign_schedule_preview', { p_campaign_id: campaignId })
      if (!active) return
      if (result.error) setPreviewError('โหลดรายการเครื่องในรอบงานไม่สำเร็จ โปรดลองใหม่')
      else {
        const next = result.data as CampaignPreview | null
        if (!next || next.campaign_id !== campaignId || !next.updated_at || !Array.isArray(next.branches)) setPreviewError('ข้อมูลรอบงานไม่ครบ โปรดลองโหลดใหม่')
        else { setPreview(next); setPreviewError('') }
      }
      setPreviewLoading(false)
    })().catch(() => {
      if (active) { setPreviewError('เชื่อมต่อเพื่อโหลดรายละเอียดไม่สำเร็จ'); setPreviewLoading(false) }
    })
    return () => { active = false }
  }, [campaignId, canManage, demo, previewRetry, selectable])

  useEffect(() => {
    const client = supabase
    const visibleRoles = ['admin', 'field_technician']
    if (demo || !client || !campaignId || !role || !visibleRoles.includes(role)) {
      setCampaignAssets([])
      setCampaignAssetTotal(0)
      setCampaignAssetsLoading(false)
      setCampaignAssetsError('')
      return
    }
    let active = true
    setCampaignAssetsLoading(true)
    setCampaignAssetsError('')
    void (async () => {
      const result = await client.rpc('ais_campaign_asset_page', {
        p_campaign_id: campaignId,
        p_limit: 25,
        p_offset: campaignAssetPage * 25,
      })
      if (!active) return
      if (result.error) throw result.error
      const data = result.data as { campaign_id?: string; total?: number; rows?: CampaignAsset[] } | null
      if (!data || data.campaign_id !== campaignId || !Array.isArray(data.rows) || !Number.isFinite(Number(data.total))) {
        throw new Error('Invalid campaign asset page')
      }
      setCampaignAssets(data.rows)
      setCampaignAssetTotal(Math.max(0, Number(data.total)))
    })().catch(() => {
      if (active) {
        setCampaignAssets([])
        setCampaignAssetTotal(0)
        setCampaignAssetsError('โหลดรายการ SN ในรอบงานไม่สำเร็จ โปรดลองใหม่')
      }
    }).finally(() => { if (active) setCampaignAssetsLoading(false) })
    return () => { active = false }
  }, [campaignAssetPage, campaignAssetsRetry, campaignId, demo, role])

  useEffect(() => { setCampaignAssetPage(0) }, [campaignId])

  useEffect(() => {
    const client = supabase
    if (!editingSelection || !canEditSelection || !client) return
    let active = true
    const timer = window.setTimeout(() => {
      setScannerLoading(true)
      setScannerError('')
      void (async () => {
        const result = await client.rpc('ais_scanner_page', { p_search: search.trim() || null, p_limit: 25, p_offset: page * 25 })
        if (!active) return
        if (result.error) throw result.error
        const data = result.data as { rows?: Scanner[]; total?: number } | null
        setScanners(Array.isArray(data?.rows) ? data.rows : [])
        setScannerTotal(Number(data?.total || 0))
      })().catch(() => { if (active) setScannerError('โหลดทะเบียนอุปกรณ์ไม่สำเร็จ') })
        .finally(() => { if (active) setScannerLoading(false) })
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [canEditSelection, editingSelection, page, scannerRetry, search])

  const selectedDevices = preview?.branches.flatMap(branch => branch.devices.map(device => ({ ...device, branch_name: branch.branch_name, location_code: branch.location_code }))) || []
  const demoCampaignAssets: CampaignAsset[] = demoAssets
    .filter(asset => String(asset.campaign || '') === code)
    .map((asset, index) => ({
      asset_id: `demo-${index}`,
      task_id: null,
      serial: String(asset.serial || 'Serial ไม่ระบุ'),
      can_navigate: true,
      model: String(asset.model || 'เครื่องสแกน'),
      location_code: String(asset.code || '—'),
      branch_name: String(asset.branch || 'สาขาไม่ระบุ'),
      province: String(asset.province || '') || null,
      task_status: String(asset.status || '') || null,
    }))
  const visibleCampaignAssets = demo ? demoCampaignAssets : campaignAssets
  const visibleCampaignAssetTotal = demo ? demoCampaignAssets.length : campaignAssetTotal
  const selectedIds = new Set(selectedDevices.map(device => device.asset_id))
  const addedIds = Object.keys(additions)
  const selectedCount = (preview?.selected_assets || 0) - removals.length + addedIds.length
  function toggleAddition(scanner: Scanner) {
    if (selectedIds.has(scanner.id)) return
    setAdditions(current => {
      const next = { ...current }
      if (next[scanner.id]) delete next[scanner.id]
      else next[scanner.id] = scanner
      return next
    })
  }

  function toggleRemoval(assetId: string) {
    setRemovals(current => current.includes(assetId) ? current.filter(id => id !== assetId) : [...current, assetId])
  }

  async function saveSelection() {
    if (!supabase || !preview || busy || !selectionReason.trim() || (addedIds.length === 0 && removals.length === 0)) return
    setBusy(true)
    setError('')
    try {
      const result = await supabase.rpc('ais_update_campaign_selection', {
        p_campaign_id: campaignId,
        p_expected_updated_at: preview.updated_at,
        p_add_asset_ids: addedIds,
        p_remove_asset_ids: removals,
        p_reason: selectionReason.trim(),
      })
      if (result.error) {
        if (result.error.code === '40001') {
          onUpdated('รอบงานเปลี่ยนไปแล้ว ระบบโหลดสถานะล่าสุด โปรดเปิดรายละเอียดรอบงานอีกครั้ง')
        } else if (result.error.code === '23505') setError('มีอุปกรณ์บางเครื่องอยู่ในรอบงานอื่นที่ยังไม่สิ้นสุด โปรดตรวจรายการใหม่')
        else if (result.error.code === '42501') setError('ต้องใช้บัญชี Admin ที่เปิดใช้งานอยู่')
        else if (isTransportUncertain(result.error)) onUpdated('ยังยืนยันผลบันทึกรายการเครื่องไม่ได้ ระบบโหลดสถานะล่าสุดแล้ว โปรดเปิดรอบงานเพื่อตรวจผล')
        else setError('แก้รายการเครื่องไม่สำเร็จ โปรดตรวจรายการแล้วลองใหม่')
        return
      }
      onUpdated('บันทึกการแก้ไขอุปกรณ์ในรอบงานแล้ว')
    } catch {
      onUpdated('การเชื่อมต่อขาดช่วง ระบบโหลดสถานะล่าสุดแล้ว โปรดเปิดรอบงานเพื่อตรวจผลก่อนลองใหม่')
    } finally { setBusy(false) }
  }

  return <div className="detail-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialogRef} className="detail-dialog campaign-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="campaign-detail-title" tabIndex={-1}>
      <header className="detail-dialog-header"><button type="button" className="detail-back" aria-label="กลับไปรายการรอบงาน" disabled={busy} onClick={onClose}>‹</button><div><span className="detail-eyebrow">{code || 'รอบงานเปลี่ยนเครื่อง'}</span><h2 id="campaign-detail-title">{name}</h2></div><button type="button" className="detail-close" aria-label="ปิดรายละเอียด" disabled={busy} onClick={onClose}>×</button></header>
      <div className="detail-readonly-note">ข้อมูลรอบงานนี้เป็นประวัติจากกระบวนการเดิม ใช้อ้างอิงย้อนหลังเท่านั้น การเปิดและดำเนินงานใหม่ให้ใช้หน้าใบงาน</div>
      <section className="detail-section"><h3>ภาพรวมรอบงาน</h3><div className="detail-grid">
        <div className="detail-field"><span>จำนวนเครื่อง</span><strong>{Number(campaign.total_assets ?? campaign.selected_assets ?? 0).toLocaleString('th-TH')}</strong></div>
        <div className="detail-field"><span>สาขา</span><strong>{Number(campaign.branches || 0).toLocaleString('th-TH')}</strong></div>
        <div className="detail-field"><span>รายการ Scanner ที่ปิดแล้ว</span><strong>{Number(campaign.done_tasks || 0).toLocaleString('th-TH')} / {Number(campaign.total_tasks || 0).toLocaleString('th-TH')}</strong></div>
      </div></section>

      <section className="detail-section">
        <h3>รายการ SN ในรอบงาน</h3>
        <p className="campaign-asset-summary">{demo ? 'ข้อมูลตัวอย่าง' : 'รายการ Scanner ที่อยู่ในรอบงานนี้'} · {visibleCampaignAssetTotal.toLocaleString('th-TH')} เครื่อง</p>
        {demo ? visibleCampaignAssets.length ? <CampaignAssetList rows={visibleCampaignAssets} page={0} total={visibleCampaignAssetTotal} onPage={() => undefined} onOpenScanner={onOpenScanner} onOpenTask={onOpenTask} demo /> : <p className="detail-empty-result">รอบงานตัวอย่างนี้ไม่มีทะเบียนเครื่องที่ผูกไว้</p>
          : !role ? <p className="detail-readonly-note">บัญชีนี้ยังไม่มีสิทธิ์ดูรายการเครื่อง</p>
            : campaignAssetsLoading ? <p role="status">กำลังโหลดรายการ SN…</p>
              : campaignAssetsError ? <div className="task-action-error" role="alert">{campaignAssetsError} <button type="button" className="text-button" onClick={() => setCampaignAssetsRetry(value => value + 1)}>ลองอีกครั้ง</button></div>
                : visibleCampaignAssets.length ? <CampaignAssetList rows={visibleCampaignAssets} page={campaignAssetPage} total={visibleCampaignAssetTotal} onPage={setCampaignAssetPage} onOpenScanner={onOpenScanner} onOpenTask={onOpenTask} />
                  : role === 'field_technician' && visibleCampaignAssetTotal === 0 ? <p className="detail-empty-result">รอบงานนี้ยังไม่มีใบงานที่เปิดให้ช่าง</p>
                    : <p className="detail-empty-result">รอบงานนี้ยังไม่มีรายการ Scanner</p>}
      </section>

      {selectable && <section className="detail-section">
        <h3>อุปกรณ์ในรอบงาน</h3>
        {demo ? <p className="detail-empty-result">ข้อมูลตัวอย่างเป็นแบบอ่านอย่างเดียว</p> : previewLoading ? <p role="status">กำลังโหลดรายการเครื่อง…</p> : previewError ? <div className="task-action-error" role="alert">{previewError} <button type="button" className="text-button" onClick={() => setPreviewRetry(value => value + 1)}>ลองอีกครั้ง</button></div> : <>
          <p className="detail-empty-result">เลือกอยู่ {preview?.selected_assets ?? Number(campaign.total_assets ?? 0)} เครื่อง · {preview?.branches.length ?? Number(campaign.branches ?? 0)} สาขา</p>
          {!canManage && !demo && <div className="detail-readonly-note">บัญชีนี้ดูยอดรวมได้ แต่ไม่มีสิทธิ์เปิดรายชื่ออุปกรณ์ในรอบงาน</div>}
          {canEditSelection && !editingSelection && <button type="button" className="secondary-button" onClick={() => { setEditingSelection(true); setError('') }}>แก้ไขรายการอุปกรณ์</button>}
          {editingSelection && canEditSelection && <div className="campaign-selection-editor">
            <div className="campaign-selected-list"><strong>อุปกรณ์ที่เลือก</strong>{selectedDevices.map(device => <div className="campaign-selection-row" key={device.asset_id}><span>{device.branch_name} · {device.serial}<small>{device.location_code} · {device.model}</small></span><button type="button" className="text-button" disabled={busy} onClick={() => toggleRemoval(device.asset_id)}>{removals.includes(device.asset_id) ? 'เก็บไว้' : 'เอาออก'}</button></div>)}</div>
            <label className="campaign-search">ค้นหาอุปกรณ์เพื่อเพิ่ม<input value={search} onChange={event => { setSearch(event.target.value); setPage(0) }} placeholder="สาขา รุ่น หรือ Serial" /></label>
            {scannerLoading ? <p role="status">กำลังค้นหา…</p> : scannerError ? <p className="task-action-error" role="alert">{scannerError} <button type="button" className="text-button" onClick={() => setScannerRetry(value => value + 1)}>ลองอีกครั้ง</button></p> : <div className="campaign-selected-list">{scanners.map(scanner => {
              const isSelected = selectedIds.has(scanner.id)
              const isAdded = Boolean(additions[scanner.id])
              return <label className="campaign-selection-row campaign-add-row" key={scanner.id}><input type="checkbox" checked={isSelected || isAdded} disabled={busy || isSelected} onChange={() => toggleAddition(scanner)} /><span>{scanner.branch_name} · {scanner.com_sn}<small>{scanner.location_code} · {scanner.model_name}{scanner.campaign ? ` · อยู่ในรอบงาน ${scanner.campaign}` : ''}</small></span></label>
            })}{!scanners.length && <p>ไม่พบอุปกรณ์ตามคำค้นหา</p>}<div className="list-footer"><span>รวม {scannerTotal.toLocaleString('th-TH')} เครื่อง · หน้า {page + 1}</span><div><button type="button" className="secondary-button" disabled={page === 0 || scannerLoading} onClick={() => setPage(value => value - 1)}>ก่อนหน้า</button><button type="button" className="secondary-button" disabled={(page + 1) * 25 >= scannerTotal || scannerLoading} onClick={() => setPage(value => value + 1)}>ถัดไป</button></div></div></div>}
            <p>หลังบันทึกจะเหลือ {selectedCount.toLocaleString('th-TH')} เครื่อง (เลือกได้ 1–500 เครื่อง)</p>
            <label className="campaign-reason">เหตุผลการแก้ไข<textarea value={selectionReason} onChange={event => setSelectionReason(event.target.value)} maxLength={1000} rows={3} required /></label>
            {error && <p className="task-action-error" role="alert">{error}</p>}
            <div className="import-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => { setEditingSelection(false); setAdditions({}); setRemovals([]); setSelectionReason(''); setError('') }}>ยกเลิกการแก้ไข</button><button type="button" className="primary-button" disabled={busy || !selectionReason.trim() || (!addedIds.length && !removals.length) || selectedCount < 1 || selectedCount > 500} onClick={() => void saveSelection()}>{busy ? 'กำลังบันทึก…' : 'บันทึกการแก้ไข'}</button></div>
          </div>}
        </>}
      </section>}

      {demo && <div className="detail-readonly-note">ข้อมูลตัวอย่างนี้ไม่บันทึกการเปลี่ยนแปลงจริง</div>}
    </section>
  </div>
}

function CampaignAssetList({ rows, page, total, onPage, onOpenScanner, onOpenTask, demo = false }: {
  rows: CampaignAsset[]
  page: number
  total: number
  onPage: (page: number) => void
  onOpenScanner: (serial: string) => void
  onOpenTask: (assetId: string, taskId: string) => void
  demo?: boolean
}) {
  return <div className="campaign-asset-list" role="region" aria-label="รายการ SN ในรอบงาน" tabIndex={0}>
    {rows.map((row, index) => {
      const status = row.task_status ? taskStatusLabels[row.task_status] || row.task_status : 'ยังไม่มีใบงาน'
      const tone = row.task_status ? taskStatusTones[row.task_status] || 'neutral' : 'neutral'
      return <article className="campaign-asset-row" key={row.task_id || row.asset_id || `${row.location_code}-${row.serial}-${index}`}>
        <div className="campaign-asset-info"><strong>{row.branch_name}</strong><span>SN {row.serial}</span><small>{row.model} · {row.location_code}{row.province ? ` · ${row.province}` : ''}</small><div className="campaign-asset-status"><span>สถานะใบงาน</span><span className={`status-pill ${tone}`}><i className="status-dot" aria-hidden="true" />{status}</span></div></div>
        {(demo || row.can_navigate) && <button type="button" className="campaign-asset-link" aria-label={row.task_id && row.asset_id ? `เปิดใบงาน Scanner SN ${row.serial}` : `เปิดรายละเอียด Scanner SN ${row.serial}`} onClick={() => {
          if (!demo && row.task_id && row.asset_id) onOpenTask(row.asset_id, row.task_id)
          else onOpenScanner(row.serial)
        }}>{row.task_id && row.asset_id ? 'เปิดใบงาน' : 'เปิดเครื่องนี้'} <span aria-hidden="true">→</span></button>}
      </article>
    })}
    {!demo && <div className="list-footer"><span>แสดง {total ? page * 25 + 1 : 0}–{Math.min((page + 1) * 25, total)} จาก {total.toLocaleString('th-TH')} เครื่อง</span><div><button type="button" className="secondary-button" disabled={page === 0} onClick={() => onPage(page - 1)}>ก่อนหน้า</button><button type="button" className="secondary-button" disabled={(page + 1) * 25 >= total} onClick={() => onPage(page + 1)}>ถัดไป</button></div></div>}
  </div>
}
