import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckSquare, MapPin, Search } from 'lucide-react'
import { supabase } from './supabase'

type BranchOption = {
  branch_id: string
  location_code: string
  branch_name: string
  province: string | null
  scanner_count: number
  available_count: number
}
type BranchScanner = {
  scanner_asset_id: string
  com_sn: string
  model: string
  has_active_work_order: boolean
  active_status: string | null
}

export default function ScheduleComposer({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const [branches, setBranches] = useState<BranchOption[]>([])
  const [devices, setDevices] = useState<BranchScanner[]>([])
  const [province, setProvince] = useState('')
  const [branchSearch, setBranchSearch] = useState('')
  const [deviceSearch, setDeviceSearch] = useState('')
  const [branchId, setBranchId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [loadingBranches, setLoadingBranches] = useState(true)
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflictRequiresReload, setConflictRequiresReload] = useState(false)
  const [branchError, setBranchError] = useState('')
  const [deviceError, setDeviceError] = useState('')
  const [branchReloadCount, setBranchReloadCount] = useState(0)
  const [deviceReloadCount, setDeviceReloadCount] = useState(0)
  const [requestId, setRequestId] = useState('')
  const openRequestInFlight = useRef(false)

  useEffect(() => {
    let active = true
    void (async () => {
      if (!supabase) {
        if (active) { setBranchError('ยังไม่ได้ตั้งค่าการเชื่อมต่อระบบ'); setLoadingBranches(false) }
        return
      }
      setLoadingBranches(true)
      setBranchError('')
      try {
        const { data, error: rpcError } = await supabase.rpc('ais_branch_work_order_options', { p_search: null, p_province: null })
        if (rpcError) throw rpcError
        const next = Array.isArray(data) ? data as BranchOption[] : []
        if (active) {
          setBranches(next)
          setBranchId(current => next.some(branch => branch.branch_id === current) ? current : '')
        }
      } catch {
        if (active) setBranchError('โหลดรายชื่อสาขาจากทะเบียนไม่สำเร็จ โปรดลองอีกครั้ง')
      } finally {
        if (active) setLoadingBranches(false)
      }
    })()
    return () => { active = false }
  }, [branchReloadCount])

  useEffect(() => {
    let active = true
    setDevices([])
    setSelected([])
    setDeviceSearch('')
    setDeviceError('')
    setConflictRequiresReload(false)
    setRequestId('')
    if (!branchId || !supabase) { setLoadingDevices(false); return () => { active = false } }
    setLoadingDevices(true)
    void (async () => {
      try {
        const { data, error: rpcError } = await supabase.rpc('ais_branch_work_order_assets', { p_branch_id: branchId })
        if (rpcError) throw rpcError
        if (active) { setDevices(Array.isArray(data) ? data as BranchScanner[] : []); setDeviceError('') }
      } catch {
        if (active) setDeviceError('โหลดรายการ Scanner ของสาขานี้ไม่สำเร็จ โปรดลองอีกครั้ง')
      } finally {
        if (active) setLoadingDevices(false)
      }
    })()
    return () => { active = false }
  }, [branchId, deviceReloadCount])

  const provinceOptions = useMemo(() => [...new Set(branches.map(branch => branch.province).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'th')), [branches])
  const visibleBranches = useMemo(() => {
    const query = branchSearch.trim().toLocaleLowerCase()
    return branches.filter(branch => (!province || branch.province === province)
      && (!query || `${branch.location_code} ${branch.branch_name} ${branch.province || ''}`.toLocaleLowerCase().includes(query)))
  }, [branches, branchSearch, province])
  const visibleDevices = useMemo(() => {
    const query = deviceSearch.trim().toLocaleLowerCase()
    return devices.filter(device => !query || `${device.com_sn} ${device.model}`.toLocaleLowerCase().includes(query))
  }, [devices, deviceSearch])
  const selectedBranch = branches.find(branch => branch.branch_id === branchId)
  const visibleAvailableDevices = visibleDevices.filter(device => !device.has_active_work_order)

  function updateBranchSearch(value: string) {
    setBranchSearch(value)
    const query = value.trim().toLocaleLowerCase()
    if (selectedBranch && query && !`${selectedBranch.location_code} ${selectedBranch.branch_name} ${selectedBranch.province || ''}`.toLocaleLowerCase().includes(query)) {
      setBranchId('')
      setRequestId('')
      setError('')
      setConflictRequiresReload(false)
    }
  }

  function updateProvince(value: string) {
    setProvince(value)
    if (selectedBranch && value && selectedBranch.province !== value) {
      setBranchId('')
      setRequestId('')
      setError('')
      setConflictRequiresReload(false)
    }
  }

  function toggleDevice(id: string, checked: boolean) {
    if (saving) return
    setSelected(current => {
      if (checked && current.includes(id)) return current
      if (checked && current.length >= 500) return current
      return checked ? [...current, id] : current.filter(value => value !== id)
    })
    setRequestId('')
    setError('')
    setConflictRequiresReload(false)
  }

  function toggleAllAvailable(checked: boolean) {
    if (saving) return
    const visibleIds = new Set(visibleAvailableDevices.map(device => device.scanner_asset_id))
    setSelected(current => {
      if (!checked) return current.filter(id => !visibleIds.has(id))
      return [...new Set([...current, ...visibleIds])].slice(0, 500)
    })
    setRequestId('')
    setError('')
    setConflictRequiresReload(false)
  }

  async function openWorkOrder() {
    if (saving || openRequestInFlight.current || !supabase || !branchId || selected.length === 0) return
    openRequestInFlight.current = true
    const submittedBranchId = branchId
    const submittedScannerIds = [...selected]
    const stableRequestId = requestId || crypto.randomUUID()
    setRequestId(stableRequestId)
    setSaving(true)
    setError('')
    setConflictRequiresReload(false)
    try {
      const { data, error: rpcError } = await supabase.rpc('ais_open_branch_work_order', {
        p_branch_id: submittedBranchId,
        p_scanner_asset_ids: submittedScannerIds,
        p_request_id: stableRequestId,
      })
      if (rpcError) {
        const messages: Record<string, string> = {
          '42501': 'บัญชีนี้ไม่มีสิทธิ์เปิดใบงาน',
          '22023': 'ข้อมูลสาขาหรือรายการ SN เปลี่ยนไป โปรดโหลดรายการใหม่',
          '23505': 'มี SN ซ้ำ โปรดตรวจรายการทะเบียนก่อนเปิดใบงาน',
          '40001': 'รายการ Scanner เปลี่ยนระหว่างเปิดใบงาน โปรดโหลดใหม่',
          '55000': 'มี Scanner บางเครื่องอยู่ในใบงานที่ยังไม่เสร็จ กรุณาตรวจสถานะเครื่องนั้นก่อน',
        }
        setError(messages[rpcError.code] || 'เปิดใบงานไม่สำเร็จ โปรดตรวจสถานะแล้วลองใหม่')
        setConflictRequiresReload(['22023', '23505', '40001', '55000'].includes(rpcError.code))
        return
      }
      if (!data || typeof data !== 'object' || !(data as { work_order_id?: string }).work_order_id) {
        setError('ระบบยังยืนยันผลเปิดใบงานไม่ได้ โปรดตรวจรายการใบงานก่อนลองซ้ำ')
        return
      }
      onSaved()
    } catch {
      setError('การเชื่อมต่อขาดช่วง ระบบจะใช้รหัสคำขอเดิมเมื่อลองซ้ำเพื่อป้องกันใบงานซ้ำ')
    } finally {
      openRequestInFlight.current = false
      setSaving(false)
    }
  }

  return <section className="panel campaign-composer schedule-composer branch-work-order-composer" aria-busy={loadingBranches || loadingDevices || saving}>
    <h2>เปิดใบงานรายสาขา</h2>
    <p>ทะเบียน SN และสาขาที่นำเข้าแล้วถือเป็นข้อมูลยืนยัน ไม่ต้องให้ช่างตรวจหรือยืนยันซ้ำ เลือก Scanner ที่ต้องดำเนินการในสาขาเดียวกันเพื่อรวมเป็นใบงานเดียว</p>
    {loadingBranches ? <div role="status">กำลังโหลดสาขาจากทะเบียน…</div> : branchError ? <div className="import-error" role="alert"><span>{branchError}</span>{supabase && <button type="button" className="secondary-button" disabled={loadingBranches} onClick={() => setBranchReloadCount(value => value + 1)}>ลองโหลดสาขาอีกครั้ง</button>}</div> : branches.length === 0 ? <div className="schedule-prerequisites" role="status"><p><strong>ยังไม่มีสาขาที่มี Scanner ในทะเบียน</strong><span>นำเข้าทะเบียนที่ผ่านการตรวจสอบก่อนเปิดใบงาน</span></p></div> : <>
      <div className="branch-work-order-filters">
        <label><span>ค้นหาสาขา / LocationCode</span><div className="search-box"><Search size={16} aria-hidden="true" /><input value={branchSearch} disabled={saving} onChange={event => updateBranchSearch(event.target.value)} maxLength={100} placeholder="พิมพ์ชื่อสาขาหรือ LocationCode" /></div></label>
        <label><span>จังหวัด</span><select disabled={saving} value={province} onChange={event => updateProvince(event.target.value)}><option value="">ทุกจังหวัด</option>{provinceOptions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>สาขา</span><select required disabled={saving} value={branchId} onChange={event => { setBranchId(event.target.value); setRequestId(''); setError(''); setConflictRequiresReload(false) }}><option value="">เลือกสาขา</option>{visibleBranches.map(branch => <option key={branch.branch_id} value={branch.branch_id}>{branch.location_code} · {branch.branch_name} ({branch.available_count}/{branch.scanner_count} เครื่องพร้อม)</option>)}</select></label>
      </div>
      {selectedBranch && <section className="schedule-branch-card branch-work-order-selected-branch">
        <div className="schedule-branch-heading"><div><span><MapPin size={14} /> {selectedBranch.province || 'ไม่ระบุจังหวัด'} · LocationCode {selectedBranch.location_code}</span><h3>{selectedBranch.branch_name}</h3></div><strong>{selectedBranch.scanner_count.toLocaleString('th-TH')} เครื่อง</strong></div>
        <p className="branch-work-order-register-note">เลือกเครื่องจากทะเบียนสาขานี้เท่านั้น ใบงานนี้จะเริ่มนับตั้งแต่เปิด และจะแสดงให้ช่างทุกคนเห็น</p>
        <div className="branch-work-order-device-toolbar">
          <label className="search-box"><Search size={15} aria-hidden="true" /><input aria-label="ค้นหา Serial ในสาขา" value={deviceSearch} disabled={saving || loadingDevices} onChange={event => setDeviceSearch(event.target.value)} placeholder="ค้นหา Serial หรือรุ่นในสาขานี้" /></label>
          <label className="branch-work-order-select-all"><input type="checkbox" disabled={saving || loadingDevices || visibleAvailableDevices.length === 0} checked={visibleAvailableDevices.length > 0 && visibleAvailableDevices.every(device => selected.includes(device.scanner_asset_id))} onChange={event => toggleAllAvailable(event.target.checked)} />เลือกเครื่องที่แสดงอยู่และพร้อมทั้งหมด (สูงสุด 500)</label>
        </div>
        {loadingDevices ? <div className="plan-loading" role="status">กำลังโหลด SN ในทะเบียนสาขา…</div> : deviceError ? <div className="import-error" role="alert"><span>{deviceError}</span><button type="button" className="secondary-button" disabled={loadingDevices || saving} onClick={() => setDeviceReloadCount(value => value + 1)}>ลองโหลดรายการอีกครั้ง</button></div> : devices.length === 0 ? <div className="plan-review-empty">สาขานี้ไม่มี Scanner ในทะเบียน</div> : <div className="branch-work-order-device-list">
          {visibleDevices.map(device => <label className={'branch-work-order-device' + (device.has_active_work_order ? ' is-unavailable' : '')} key={device.scanner_asset_id}>
            <input type="checkbox" checked={selected.includes(device.scanner_asset_id)} disabled={device.has_active_work_order || saving || (!selected.includes(device.scanner_asset_id) && selected.length >= 500)} onChange={event => toggleDevice(device.scanner_asset_id, event.target.checked)} />
            <span><strong>{device.com_sn}</strong><small>{device.model}</small></span>
            {device.has_active_work_order && <em>มีใบงานค้าง</em>}
          </label>)}
        </div>}
        <div className="branch-work-order-selection-summary"><CheckSquare size={16} /> เลือกแล้ว {selected.length.toLocaleString('th-TH')} / 500 เครื่อง{selected.length >= 500 ? ' · ถึงจำนวนสูงสุดแล้ว' : ''}</div>
      </section>}
      {error && <div className="import-error" role="alert"><span>{error}</span>{conflictRequiresReload && branchId ? <button type="button" className="secondary-button" disabled={saving || loadingDevices} onClick={() => { setRequestId(''); setError(''); setConflictRequiresReload(false); setDeviceReloadCount(value => value + 1) }}>โหลดสถานะ SN ใหม่และเลือกเครื่องอีกครั้ง</button> : requestId && <button type="button" className="secondary-button" disabled={saving || !branchId || !selected.length} onClick={() => void openWorkOrder()}>ลองตรวจและเปิดซ้ำ</button>}</div>}
    </>}
    <div className="import-actions"><button type="button" className="secondary-button" disabled={saving} onClick={onCancel}>ยกเลิก</button><button type="button" className="primary-button" disabled={saving || loadingBranches || loadingDevices || Boolean(branchError) || !selectedBranch || !branchId || selected.length === 0} onClick={() => void openWorkOrder()}>{saving ? 'กำลังเปิดใบงาน…' : `เปิดใบงาน ${selected.length.toLocaleString('th-TH')} เครื่อง`}</button></div>
  </section>
}
