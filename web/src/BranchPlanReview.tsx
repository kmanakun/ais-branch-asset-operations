import { Fragment, useEffect, useState } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { supabase } from './supabase'
import { groupRowsByProvince, ProvinceCardGroup, ProvinceTableGroup } from './province'

type PlanRow = {
  source_row: number
  location_code: string
  branch_name: string | null
  province: string | null
  registered_device_count: number
}
type PlanPage = { total: number; rows: PlanRow[] }
type InventoryDevice = {
  brand: string | null
  hw_name: string | null
  model_name: string | null
  com_sn: string
}
type InventoryReview = {
  found: boolean
  branch: { source_row: number; location_code: string; branch_name: string | null } | null
  registered_device_count: number
  devices_truncated: boolean
  devices: InventoryDevice[]
}

const PAGE_SIZE = 50

export default function BranchPlanReview({ role, provinces, onOpenScanner }: { role?: string; provinces: string[]; onOpenScanner: (serial: string) => void }) {
  const [search, setSearch] = useState('')
  const [province, setProvince] = useState('')
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<PlanRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [inventorySourceRow, setInventorySourceRow] = useState<number | null>(null)
  const [inventory, setInventory] = useState<InventoryReview | null>(null)
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [inventoryError, setInventoryError] = useState('')
  const [inventoryRetry, setInventoryRetry] = useState(0)

  useEffect(() => {
    if (role !== 'admin') {
      setLoading(false)
      setRows([])
      setTotal(0)
      setError('')
      return
    }
    let active = true
    setLoading(true)
    setError('')
    setRows([])
    setTotal(0)
    const timer = window.setTimeout(async () => {
      try {
        if (!supabase) throw new Error('Unavailable')
        const { data, error: rpcError } = await supabase.rpc('ais_branch_plan_page', {
          p_search: search.trim() || null,
          p_team_name: null,
          p_date_filter: 'all',
          p_limit: PAGE_SIZE,
          p_offset: page * PAGE_SIZE,
          p_province: province || null,
        })
        if (rpcError) throw rpcError
        const result = data as PlanPage | null
        if (!result || !Array.isArray(result.rows) || !Number.isInteger(Number(result.total))) throw new Error('Invalid response')
        if (active) {
          setRows(result.rows)
          setTotal(Number(result.total))
        }
      } catch {
        if (active) {
          setRows([])
          setTotal(0)
          setError('โหลดรายการสาขาไม่สำเร็จ โปรดลองอีกครั้ง')
        }
      } finally {
        if (active) setLoading(false)
      }
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [role, search, province, page, retry])

  useEffect(() => {
    if (role !== 'admin' || inventorySourceRow === null) {
      setInventory(null)
      setInventoryLoading(false)
      setInventoryError('')
      return
    }
    let active = true
    setInventory(null)
    setInventoryLoading(true)
    setInventoryError('')
    async function loadInventory() {
      try {
        if (!supabase) throw new Error('Unavailable')
        const { data, error: rpcError } = await supabase.rpc('ais_branch_plan_inventory_for_row', {
          p_source_row: inventorySourceRow,
        })
        if (rpcError) throw rpcError
        const result = data as InventoryReview | null
        if (!result || typeof result.found !== 'boolean' || !Array.isArray(result.devices)
          || !Number.isSafeInteger(result.registered_device_count) || result.registered_device_count < 0
          || typeof result.devices_truncated !== 'boolean' || result.devices.length > 100
          || (result.found && !result.branch)) throw new Error('Invalid response')
        if (active) setInventory(result)
      } catch {
        if (active) {
          setInventory(null)
          setInventoryError('โหลดรายการอุปกรณ์ของสาขาไม่สำเร็จ โปรดลองอีกครั้ง')
        }
      } finally {
        if (active) setInventoryLoading(false)
      }
    }
    void loadInventory()
    return () => { active = false }
  }, [role, inventorySourceRow, inventoryRetry])

  const firstRow = total === 0 ? 0 : page * PAGE_SIZE + 1
  const lastRow = Math.min(total, (page + 1) * PAGE_SIZE)
  const provinceGroups = groupRowsByProvince(rows)
  function resetInventory() {
    setInventorySourceRow(null)
    setInventory(null)
    setInventoryError('')
  }
  function toggleInventory(sourceRow: number) {
    if (inventorySourceRow === sourceRow) {
      resetInventory()
      return
    }
    setInventorySourceRow(sourceRow)
    setInventory(null)
    setInventoryError('')
  }
  function inventoryDetails(row: PlanRow, id: string) {
    return <InventoryDetails id={id} row={row} inventory={inventory} loading={inventoryLoading} error={inventoryError} onClose={resetInventory} onRetry={() => setInventoryRetry(value => value + 1)} onOpenScanner={onOpenScanner} />
  }

  return <section className="panel branch-plan-review" aria-busy={loading}>
    <div className="plan-review-heading">
      <div><h3>ตรวจทะเบียน Scanner แยกตามสาขา</h3><p>ใช้ค้นหาจังหวัดและสาขา แล้วเปิดดู SN ที่ลงทะเบียนไว้ หน้านี้ไม่สร้างใบงาน</p></div>
    </div>
    <div className="plan-review-toolbar">
      <label className="plan-review-field"><span>ค้นหารหัสหรือชื่อสาขา</span><span className="plan-review-search"><Search size={15} aria-hidden="true" /><input aria-label="ค้นหารหัสหรือชื่อสาขา" maxLength={100} value={search} onChange={event => { setSearch(event.target.value); setPage(0); resetInventory() }} placeholder="พิมพ์รหัสหรือชื่อสาขา" /></span></label>
      <label className="plan-review-field"><span>จังหวัด</span><select aria-label="กรองตามจังหวัด" value={province} onChange={event => { setProvince(event.target.value); setPage(0); resetInventory() }}><option value="">ทุกจังหวัด</option><option value="__unassigned__">ไม่ระบุจังหวัด</option>{provinces.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    </div>
    <div className="plan-review-count" role="status" aria-live="polite">{loading ? 'กำลังค้นหารายการ…' : `แสดง ${firstRow.toLocaleString('th-TH')}–${lastRow.toLocaleString('th-TH')} จาก ${total.toLocaleString('th-TH')} สาขา`}</div>
    {error ? <div className="import-error plan-review-error" role="alert"><span>{error}</span><button className="secondary-button" type="button" onClick={() => setRetry(count => count + 1)}>ลองอีกครั้ง</button></div> : loading ? <div className="plan-review-loading" aria-hidden="true">กำลังค้นหารายการ…</div> : rows.length === 0 ? <div className="plan-review-empty">ไม่พบสาขาตามตัวกรองนี้</div> : <>
      <div className="table-wrap plan-review-table-wrap">
        <table className="plan-review-table">
          <caption className="visually-hidden">ทะเบียนสาขาและอุปกรณ์ที่ลงทะเบียน</caption>
          <thead><tr><th>แถวต้นทาง</th><th>สาขา / LocationCode</th><th>จังหวัด</th><th>อุปกรณ์ในทะเบียน</th></tr></thead>
          <tbody>{provinceGroups.flatMap(group => [
            <ProvinceTableGroup key={`province-${group.province}`} group={group} colSpan={4} />,
            ...group.rows.map(row => {
              const expanded = inventorySourceRow === row.source_row
              const detailsId = `plan-inventory-desktop-${row.source_row}`
              return <Fragment key={row.source_row}>
                <tr>
                  <td>{row.source_row.toLocaleString('th-TH')}</td>
                  <td><strong className="plan-review-location-code">{row.location_code}</strong><div className="plan-review-branch-name">{row.branch_name || 'ไม่ระบุชื่อสาขา'}</div></td>
                  <td>{row.province || 'ไม่ระบุจังหวัด'}</td>
                  <td><button type="button" className="plan-inventory-toggle" aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => toggleInventory(row.source_row)}>{expanded ? 'ซ่อนรายการ' : 'ดูรายการ ' + Number(row.registered_device_count || 0).toLocaleString('th-TH') + ' เครื่อง'}</button></td>
                </tr>
                {expanded && <tr className="plan-inventory-detail-row" key={`inventory-${row.source_row}`}><td colSpan={4}>{inventoryDetails(row, detailsId)}</td></tr>}
              </Fragment>
            }),
          ])}</tbody>
        </table>
      </div>
      <div className="plan-review-cards">{provinceGroups.map(group => <ProvinceCardGroup key={`mobile-province-${group.province}`} group={group}><div className="province-mobile-cards">{group.rows.map(row => {
        const expanded = inventorySourceRow === row.source_row
        const detailsId = `plan-inventory-mobile-${row.source_row}`
        return <article className="plan-review-card" key={row.source_row}>
          <div className="plan-review-card-heading"><span>แถวต้นทาง {row.source_row.toLocaleString('th-TH')}</span></div>
          <strong className="plan-review-location-code">{row.location_code}</strong>
          <span className="plan-review-branch-name">{row.branch_name || 'ไม่ระบุชื่อสาขา'}</span>
          <div className="plan-review-card-meta"><div><span>จังหวัด</span><strong>{row.province || 'ไม่ระบุจังหวัด'}</strong></div></div>
          <button type="button" className="plan-inventory-toggle" aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => toggleInventory(row.source_row)}>{expanded ? 'ซ่อนรายการอุปกรณ์' : 'ดูรายการ ' + Number(row.registered_device_count || 0).toLocaleString('th-TH') + ' เครื่อง'}</button>
          {expanded && inventoryDetails(row, detailsId)}
        </article>
      })}</div></ProvinceCardGroup>)}</div>
      <div className="plan-review-pagination"><span>หน้า {(page + 1).toLocaleString('th-TH')}</span><div><button type="button" className="secondary-button" aria-label="หน้าก่อนหน้า" disabled={loading || page === 0} onClick={() => { setPage(current => current - 1); resetInventory() }}><ChevronLeft size={15} /> ก่อนหน้า</button><button type="button" className="secondary-button" aria-label="หน้าถัดไป" disabled={loading || (page + 1) * PAGE_SIZE >= total} onClick={() => { setPage(current => current + 1); resetInventory() }}>ถัดไป <ChevronRight size={15} /></button></div></div>
    </>}
  </section>
}

function InventoryDetails({ id, row, inventory, loading, error, onClose, onRetry, onOpenScanner }: {
  id: string
  row: PlanRow
  inventory: InventoryReview | null
  loading: boolean
  error: string
  onClose: () => void
  onRetry: () => void
  onOpenScanner: (serial: string) => void
}) {
  return <section id={id} className="plan-inventory-panel" aria-label="รายการอุปกรณ์ในทะเบียนสาขา" aria-busy={loading} tabIndex={-1}>
    <div className="plan-inventory-heading"><div><h4>อุปกรณ์ในทะเบียน · {inventory?.branch?.location_code || row.location_code} · {inventory?.branch?.branch_name || row.branch_name || ''}</h4><p>แถวต้นทาง {row.source_row} · รายการที่ให้มาถือเป็นทะเบียนอ้างอิงของสาขานี้</p></div><button type="button" className="plan-inventory-close" aria-label="ปิดรายการอุปกรณ์" onClick={onClose}><X size={16} /></button></div>
    {loading ? <div className="plan-review-loading" role="status">กำลังโหลดทะเบียนอุปกรณ์…</div> : error ? <div className="import-error plan-review-error" role="alert"><span>{error}</span><button className="secondary-button" type="button" onClick={onRetry}>ลองอีกครั้ง</button></div> : inventory && !inventory.found ? <div className="plan-review-empty">ไม่พบสาขานี้ในข้อมูลต้นทางชุดล่าสุด</div> : inventory ? <>
      <div className="plan-inventory-summary"><strong>{Number(inventory.registered_device_count).toLocaleString('th-TH')} เครื่องในทะเบียน</strong><span>จังหวัด{row.province || 'ไม่ระบุจังหวัด'} · แถวต้นทาง {Number(inventory.branch?.source_row || row.source_row).toLocaleString('th-TH')}</span></div>
      {inventory.registered_device_count === 0 ? <div className="plan-review-empty">ไม่พบอุปกรณ์ที่ลงทะเบียนในสาขานี้</div> : <ul className="plan-inventory-list">{inventory.devices.map(device => <li key={device.com_sn}><button type="button" className="plan-inventory-serial" aria-label={`เปิดรายละเอียด Scanner Serial ${device.com_sn}`} title="เปิดรายละเอียด Scanner" onClick={() => onOpenScanner(device.com_sn)}>{device.com_sn}<ArrowUpRight size={12} aria-hidden="true" /></button><span>{device.model_name || device.hw_name || 'ไม่ระบุรุ่น'}{device.brand ? ' · ' + device.brand : ''}</span></li>)}</ul>}
      {inventory.devices_truncated && <p className="plan-inventory-truncated">แสดง 100 รายการแรก จากทั้งหมด {Number(inventory.registered_device_count).toLocaleString('th-TH')} เครื่อง</p>}
    </> : null}
  </section>
}
