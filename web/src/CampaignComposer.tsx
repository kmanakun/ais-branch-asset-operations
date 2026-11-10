import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { supabase } from './supabase'

type Asset = { id: string; branch_name: string; location_code: string; model_name: string; com_sn: string; campaign?: string; status?: string }

export default function CampaignComposer({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const dialogRef = useRef<HTMLFormElement>(null)
  const onCancelRef = useRef(onCancel)
  const savingRef = useRef(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<Asset[]>([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<Record<string, Asset>>({})
  const [markedCatalog, setMarkedCatalog] = useState<Record<string, Asset>>({})
  const [markedSelected, setMarkedSelected] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const chosen = Object.values(selected)
  const markedCatalogRows = Object.values(markedCatalog)
  const markedSelectedIds = Object.keys(markedSelected).filter(id => markedSelected[id])
  onCancelRef.current = onCancel

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    dialogRef.current?.querySelector<HTMLInputElement>('input:not([type="checkbox"])')?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) onCancelRef.current()
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]'))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError('')
    const timer = window.setTimeout(async () => {
      try {
        if (!supabase) throw new Error('Unavailable')
        const result = await supabase.rpc('ais_scanner_page', { p_search: search || null, p_limit: 25, p_offset: page * 25 })
        if (result.error) throw result.error
        const data = result.data as { rows?: Asset[]; total?: number } | null
        if (!Array.isArray(data?.rows) || !Number.isInteger(data.total)) throw new Error('Invalid scanner response')
        if (active) { setRows(data.rows); setTotal(data.total || 0) }
      } catch {
        if (active) { setRows([]); setTotal(0); setLoadError('โหลดทะเบียนไม่สำเร็จ โปรดลองอีกครั้ง') }
      } finally { if (active) setLoading(false) }
    }, 200)
    return () => { active = false; window.clearTimeout(timer) }
  }, [search, page, retry])

  function markCatalog(asset: Asset) {
    if (selected[asset.id]) return
    setMarkedCatalog(current => {
      const next = { ...current }
      if (next[asset.id]) delete next[asset.id]
      else next[asset.id] = asset
      return next
    })
  }

  function markSelected(id: string) {
    setMarkedSelected(current => ({ ...current, [id]: !current[id] }))
  }

  function addMarkedAssets() {
    setSelected(current => {
      const next = { ...current }
      for (const asset of markedCatalogRows) if (!next[asset.id] && Object.keys(next).length < 500) next[asset.id] = asset
      return next
    })
    setMarkedCatalog({})
  }

  function removeMarkedAssets() {
    setSelected(current => {
      const next = { ...current }
      for (const id of markedSelectedIds) delete next[id]
      return next
    })
    setMarkedSelected({})
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (savingRef.current || !supabase || chosen.length === 0) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const result = await supabase.rpc('ais_create_campaign', {
        p_code: code.trim(), p_name: name.trim(), p_reason: reason.trim() || 'ไม่ระบุรายละเอียดเพิ่มเติม',
        p_asset_ids: chosen.map(asset => asset.id), p_start_on: null, p_end_on: null,
      })
      if (result.error) {
        const messages: Record<string, string> = {
          '42501': 'ต้องใช้บัญชี Admin ที่เปิดใช้งานอยู่',
          '23505': 'รหัสรอบงานซ้ำ หรือมีเครื่องที่อยู่ในรอบงานซึ่งยังไม่สิ้นสุด โปรดตรวจรายการอีกครั้ง',
          '22023': 'โปรดตรวจรหัส ชื่อ วันที่ และเครื่องที่เลือกให้ถูกต้อง',
        }
        setError(messages[result.error.code] || 'บันทึกไม่สำเร็จ โปรดลองอีกครั้ง โดยใช้รหัสรอบงานเดิมเพื่อตรวจป้องกันรายการซ้ำ')
        return
      }
      onSaved()
    } catch { setError('เชื่อมต่อไม่สำเร็จ โปรดตรวจรายการรอบงานก่อนลองบันทึกซ้ำ') }
    finally { savingRef.current = false; setSaving(false) }
  }

  return <div className="detail-overlay campaign-plan-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onCancel() }}>
    <form ref={dialogRef} className="campaign-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="campaign-plan-title" tabIndex={-1} onSubmit={event => void save(event)}>
      <header className="campaign-plan-header">
        <div><span className="detail-eyebrow">สร้างแผนงานเปลี่ยน Scanner</span><h2 id="campaign-plan-title">เลือกอุปกรณ์เข้ารอบงาน</h2><p>กำหนดรายละเอียดรอบงานและย้ายอุปกรณ์ที่ต้องการจากรายการทางซ้าย</p></div>
        <button type="button" className="detail-close" aria-label="ปิดหน้าสร้างรอบงาน" disabled={saving} onClick={onCancel}><X size={18} /></button>
      </header>
      <fieldset disabled={saving}>
        <section className="campaign-plan-meta" aria-label="รายละเอียดรอบงาน">
          <label>รหัสรอบงาน <span>*</span><input required value={code} onChange={event => setCode(event.target.value)} minLength={2} maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,39}" placeholder="เช่น SCN-2026-01" /></label>
          <label>ชื่อรอบงาน <span>*</span><input required value={name} onChange={event => setName(event.target.value)} minLength={3} maxLength={200} placeholder="ระบุชื่อรอบงาน" /></label>
          <label className="campaign-plan-description">รายละเอียด (ถ้ามี)<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} rows={2} placeholder="เพิ่มรายละเอียดของรอบงานนี้ได้ตามต้องการ" /></label>
        </section>
        <section className="campaign-plan-assets" aria-label="เลือกอุปกรณ์">
          <div className="campaign-plan-search-row">
            <label className="campaign-plan-search"><span>ค้นหาอุปกรณ์</span><div><Search size={16} /><input value={search} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} onChange={event => { setSearch(event.target.value); setPage(0); setMarkedCatalog({}) }} placeholder="Serial, สาขา, รุ่น หรือ LocationCode" /></div></label>
            <span className="campaign-plan-limit">เลือกได้สูงสุด 500 เครื่อง</span>
          </div>
          <div className="campaign-plan-transfer">
            <section className="campaign-asset-pane" aria-label="รายการอุปกรณ์ที่ค้นพบ">
              <div className="campaign-asset-heading"><strong>รายการอุปกรณ์</strong><span>{total.toLocaleString('th-TH')} เครื่อง</span></div>
              <div className="campaign-asset-table-wrap">
                <table className="campaign-asset-table"><thead><tr><th aria-label="เลือก"></th><th>Serial / รุ่น</th><th>สาขา / LocationCode</th><th>รอบงานปัจจุบัน</th></tr></thead><tbody>
                  {rows.map(asset => <tr key={asset.id} className={selected[asset.id] ? 'is-selected' : ''}>
                    <td><input type="checkbox" checked={Boolean(selected[asset.id] || markedCatalog[asset.id])} disabled={Boolean(selected[asset.id])} aria-label={`เลือก ${asset.com_sn}`} onChange={() => markCatalog(asset)} /></td>
                    <td><strong>{asset.com_sn}</strong><small>{asset.model_name || 'ไม่ระบุรุ่น'}</small></td>
                    <td><strong>{asset.branch_name || 'ไม่ระบุสาขา'}</strong><small>{asset.location_code || '—'}</small></td>
                    <td>{asset.campaign || '—'}</td>
                  </tr>)}
                  {!loading && !loadError && rows.length === 0 && <tr><td colSpan={4} className="campaign-asset-empty">ไม่พบอุปกรณ์ในรายการ</td></tr>}
                  {loading && <tr><td colSpan={4} className="campaign-asset-empty" role="status">กำลังโหลดรายการ…</td></tr>}
                  {loadError && <tr><td colSpan={4} className="campaign-asset-empty" role="alert">{loadError} <button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}>ลองอีกครั้ง</button></td></tr>}
                </tbody></table>
              </div>
              <div className="campaign-asset-pagination"><span>หน้า {page + 1} · แสดง {rows.length} เครื่อง</span><div><button type="button" className="secondary-button" disabled={loading || page === 0} aria-label="หน้าก่อนหน้า" onClick={() => { setPage(page - 1); setMarkedCatalog({}) }}><ChevronLeft size={16} /></button><button type="button" className="secondary-button" disabled={loading || (page + 1) * 25 >= total} aria-label="หน้าถัดไป" onClick={() => { setPage(page + 1); setMarkedCatalog({}) }}><ChevronRight size={16} /></button></div></div>
            </section>
            <div className="campaign-plan-transfer-controls" aria-label="ย้ายอุปกรณ์ระหว่างรายการ">
              <button type="button" className="secondary-button" aria-label="เพิ่มเครื่องที่เลือก" title="เพิ่มเครื่องที่เลือก" disabled={markedCatalogRows.length === 0 || chosen.length + markedCatalogRows.length > 500} onClick={addMarkedAssets}><ChevronRight size={18} /></button>
              <button type="button" className="secondary-button" aria-label="นำเครื่องที่เลือกออก" title="นำเครื่องที่เลือกออก" disabled={markedSelectedIds.length === 0} onClick={removeMarkedAssets}><ChevronLeft size={18} /></button>
            </div>
            <section className="campaign-asset-pane campaign-selected-pane" aria-label="อุปกรณ์ที่เลือกเข้ารอบงาน">
              <div className="campaign-asset-heading"><strong>อุปกรณ์ที่เลือก</strong><span>{chosen.length.toLocaleString('th-TH')} เครื่อง</span></div>
              <div className="campaign-asset-table-wrap">
                <table className="campaign-asset-table"><thead><tr><th aria-label="เลือก"></th><th>Serial / รุ่น</th><th>สาขา / LocationCode</th></tr></thead><tbody>
                  {chosen.map(asset => <tr key={asset.id}>
                    <td><input type="checkbox" checked={Boolean(markedSelected[asset.id])} aria-label={`เลือกเอา ${asset.com_sn} ออกจากรอบงาน`} onChange={() => markSelected(asset.id)} /></td>
                    <td><strong>{asset.com_sn}</strong><small>{asset.model_name || 'ไม่ระบุรุ่น'}</small></td>
                    <td><strong>{asset.branch_name || 'ไม่ระบุสาขา'}</strong><small>{asset.location_code || '—'}</small></td>
                  </tr>)}
                  {chosen.length === 0 && <tr><td colSpan={3} className="campaign-asset-empty">ยังไม่ได้เลือกอุปกรณ์</td></tr>}
                </tbody></table>
              </div>
              {chosen.length > 0 && <button type="button" className="campaign-remove-selected" disabled={!markedSelectedIds.length} onClick={removeMarkedAssets}>นำรายการที่ทำเครื่องหมายออก</button>}
            </section>
          </div>
        </section>
        {error && <p className="import-error campaign-plan-error" role="alert">{error}</p>}
        <footer className="campaign-plan-actions"><span>เลือกแล้ว {chosen.length.toLocaleString('th-TH')} / 500 เครื่อง</span><div><button type="button" className="secondary-button" onClick={onCancel}>ยกเลิก</button><button className="primary-button" disabled={chosen.length === 0 || saving}>{saving ? 'กำลังบันทึก…' : `สร้างรอบงาน · ${chosen.length.toLocaleString('th-TH')} เครื่อง`}</button></div></footer>
      </fieldset>
    </form>
  </div>
}
