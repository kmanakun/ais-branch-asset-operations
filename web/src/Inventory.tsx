import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Archive,
  Boxes,
  CheckCircle2,
  HardDrive,
  PackageCheck,
  PackagePlus,
  Search,
  Truck,
} from 'lucide-react'
import { supabase } from './supabase'

export type StockItem = {
  id: string
  model: string
  total_received: number
  in_stock: number
  assigned_to_techs: number
  installed: number
  returned_damaged: number
  returned_usable: number
  last_batch?: string
  last_received_date?: string
}

export const initialStockData: StockItem[] = [
  {
    id: 'stock-1',
    model: 'Zebra DS9308',
    total_received: 600,
    in_stock: 245,
    assigned_to_techs: 65,
    installed: 278,
    returned_damaged: 14,
    returned_usable: 4,
    last_batch: 'BATCH-2026-NOV-A',
    last_received_date: '2026-11-01',
  },
  {
    id: 'stock-2',
    model: 'Honeywell HF680',
    total_received: 450,
    in_stock: 180,
    assigned_to_techs: 40,
    installed: 220,
    returned_damaged: 9,
    returned_usable: 3,
    last_batch: 'BATCH-2026-OCT-B',
    last_received_date: '2026-10-25',
  },
  {
    id: 'stock-3',
    model: 'Datalogic Gryphon GFS4400',
    total_received: 200,
    in_stock: 95,
    assigned_to_techs: 20,
    installed: 82,
    returned_damaged: 3,
    returned_usable: 1,
    last_batch: 'BATCH-2026-NOV-C',
    last_received_date: '2026-11-05',
  },
  {
    id: 'stock-4',
    model: 'Zebra DS2208 Handheld',
    total_received: 150,
    in_stock: 70,
    assigned_to_techs: 15,
    installed: 63,
    returned_damaged: 2,
    returned_usable: 0,
    last_batch: 'BATCH-2026-SEP-A',
    last_received_date: '2026-09-18',
  },
]

type DispatchRecord = {
  id: string
  date: string
  team: string
  model: string
  quantity: number
  batch: string
  status: 'dispatched' | 'acknowledged'
}

const initialDispatchHistory: DispatchRecord[] = [
  {
    id: 'disp-101',
    date: '2026-11-10',
    team: 'ทีมเทคนิค A (กทม. โซน 1)',
    model: 'Zebra DS9308',
    quantity: 15,
    batch: 'BATCH-2026-NOV-A',
    status: 'acknowledged',
  },
  {
    id: 'disp-102',
    date: '2026-11-09',
    team: 'ทีมเทคนิค B (ภาคเหนือ)',
    model: 'Honeywell HF680',
    quantity: 20,
    batch: 'BATCH-2026-OCT-B',
    status: 'acknowledged',
  },
  {
    id: 'disp-103',
    date: '2026-11-11',
    team: 'ทีมเทคนิค C (ภาคอีสาน)',
    model: 'Zebra DS9308',
    quantity: 25,
    batch: 'BATCH-2026-NOV-A',
    status: 'dispatched',
  },
]

export function Inventory({ role }: { role?: string }) {
  const [stockList, setStockList] = useState<StockItem[]>(initialStockData)
  const [dispatchHistory, setDispatchHistory] = useState<DispatchRecord[]>(initialDispatchHistory)
  const [search, setSearch] = useState('')
  const [showAddStockModal, setShowAddStockModal] = useState(false)
  const [showDispatchModal, setShowDispatchModal] = useState(false)

  // Form states
  const [newModel, setNewModel] = useState('Zebra DS9308')
  const [newQty, setNewQty] = useState(50)
  const [newBatch, setNewBatch] = useState(`BATCH-${new Date().toISOString().slice(0, 7).toUpperCase()}-NEW`)

  const [dispatchTeam, setDispatchTeam] = useState('ทีมเทคนิค A (กทม. โซน 1)')
  const [dispatchModel, setDispatchModel] = useState('Zebra DS9308')
  const [dispatchQty, setDispatchQty] = useState(10)

  const canManage = role === 'admin'

  useEffect(() => {
    if (!supabase) return
    let active = true
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('ais_stock_list')
        if (error || !data || !active) return
        const res = data as { models?: StockItem[]; dispatches?: DispatchRecord[] }
        if (Array.isArray(res.models) && res.models.length > 0) {
          setStockList(res.models)
        }
        if (Array.isArray(res.dispatches) && res.dispatches.length > 0) {
          setDispatchHistory(res.dispatches)
        }
      } catch {
        // Fallback to local demo data
      }
    })()
    return () => { active = false }
  }, [])

  const totals = stockList.reduce(
    (acc, item) => ({
      received: acc.received + item.total_received,
      in_stock: acc.in_stock + item.in_stock,
      assigned: acc.assigned + item.assigned_to_techs,
      installed: acc.installed + item.installed,
      damaged: acc.damaged + item.returned_damaged,
      usable: acc.usable + item.returned_usable,
    }),
    { received: 0, in_stock: 0, assigned: 0, installed: 0, damaged: 0, usable: 0 }
  )

  const handleAddStock = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newModel || newQty <= 0) return

    setStockList(prev => {
      const existing = prev.find(item => item.model === newModel)
      if (existing) {
        return prev.map(item =>
          item.model === newModel
            ? {
                ...item,
                total_received: item.total_received + newQty,
                in_stock: item.in_stock + newQty,
                last_batch: newBatch,
                last_received_date: new Date().toISOString().slice(0, 10),
              }
            : item
        )
      } else {
        return [
          ...prev,
          {
            id: `stock-${Date.now()}`,
            model: newModel,
            total_received: newQty,
            in_stock: newQty,
            assigned_to_techs: 0,
            installed: 0,
            returned_damaged: 0,
            returned_usable: 0,
            last_batch: newBatch,
            last_received_date: new Date().toISOString().slice(0, 10),
          },
        ]
      }
    })

    if (supabase) {
      void (async () => {
        try {
          await supabase.rpc('ais_stock_receive_batch', {
            p_batch_code: newBatch,
            p_model_name: newModel,
            p_quantity: newQty,
          })
        } catch {
          // Ignore network/offline error
        }
      })()
    }

    setShowAddStockModal(false)
  }

  const handleDispatch = (e: React.FormEvent) => {
    e.preventDefault()
    if (dispatchQty <= 0) return

    const targetStock = stockList.find(s => s.model === dispatchModel)
    if (!targetStock || targetStock.in_stock < dispatchQty) {
      alert('จำนวนเครื่องในสต็อกคงเหลือไม่เพียงพอสำหรับการเบิกจ่าย')
      return
    }

    setStockList(prev =>
      prev.map(item =>
        item.model === dispatchModel
          ? {
              ...item,
              in_stock: item.in_stock - dispatchQty,
              assigned_to_techs: item.assigned_to_techs + dispatchQty,
            }
          : item
      )
    )

    const newDisp: DispatchRecord = {
      id: `disp-${Date.now().toString().slice(-4)}`,
      date: new Date().toISOString().slice(0, 10),
      team: dispatchTeam,
      model: dispatchModel,
      quantity: dispatchQty,
      batch: targetStock.last_batch || 'BATCH-LATEST',
      status: 'dispatched',
    }

    if (supabase) {
      void (async () => {
        try {
          await supabase.rpc('ais_stock_dispatch_team', {
            p_team_name: dispatchTeam,
            p_model_name: dispatchModel,
            p_quantity: dispatchQty,
            p_batch_code: targetStock.last_batch || null,
          })
        } catch {
          // Ignore network/offline error
        }
      })()
    }

    setDispatchHistory(prev => [newDisp, ...prev])
    setShowDispatchModal(false)
  }

  const filteredStock = stockList.filter(
    item =>
      item.model.toLowerCase().includes(search.toLowerCase()) ||
      (item.last_batch && item.last_batch.toLowerCase().includes(search.toLowerCase()))
  )

  return (
    <div className="inventory-view-content">
      {/* Top Banner & Action */}
      <div className="section-heading-row">
        <div>
          <h2>ระบบจัดการคลังและสต็อกเครื่องสแกน (Scanner Stock & Inventory)</h2>
          <p>
            ตรวจสอบยอดรับเข้า คงเหลือในคลัง การเบิกจ่ายให้ช่าง Onsite และเครื่องเดิมที่ส่งคืน
          </p>
        </div>
        <div className="inventory-header-buttons">
          {canManage && (
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowDispatchModal(true)}
              >
                <Truck size={15} /> เบิกจ่ายเครื่องให้ช่าง
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => setShowAddStockModal(true)}
              >
                <PackagePlus size={15} /> บันทึกรับเครื่องเข้าสต็อก
              </button>
            </>
          )}
        </div>
      </div>

      {/* Metric Cards Grid */}
      <div className="stats-grid dashboard-summary-grid">
        <div className="stat-card">
          <div className="stat-top">
            <span>เครื่องรับเข้าคลังสะสม</span>
            <div className="stat-icon blue">
              <Boxes size={18} />
            </div>
          </div>
          <div className="stat-value">{totals.received.toLocaleString('th-TH')}</div>
          <div className="stat-foot">
            <span className="stat-change">รวมทุกรุ่นที่ลงทะเบียนคลัง</span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-top">
            <span>พร้อมใช้งานในคลัง (In Stock)</span>
            <div className="stat-icon green">
              <PackageCheck size={18} />
            </div>
          </div>
          <div className="stat-value">{totals.in_stock.toLocaleString('th-TH')}</div>
          <div className="stat-foot">
            <span className="stat-change">เครื่องใหม่พร้อมนำไปเปลี่ยน</span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-top">
            <span>เบิกจ่ายอยู่กับช่าง (Onsite)</span>
            <div className="stat-icon orange">
              <Truck size={18} />
            </div>
          </div>
          <div className="stat-value">{totals.assigned.toLocaleString('th-TH')}</div>
          <div className="stat-foot">
            <span className="stat-change">อยู่ระหว่างลงพื้นที่เปลี่ยนสาขา</span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-top">
            <span>ติดตั้งเปลี่ยนสำเร็จแล้ว</span>
            <div className="stat-icon green">
              <CheckCircle2 size={18} />
            </div>
          </div>
          <div className="stat-value">{totals.installed.toLocaleString('th-TH')}</div>
          <div className="stat-foot">
            <span className="stat-change">อ้างอิงจากใบงานที่ส่งมอบแล้ว</span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-top">
            <span>เครื่องเดิมส่งคืนชำรุด</span>
            <div className="stat-icon red">
              <AlertCircle size={18} />
            </div>
          </div>
          <div className="stat-value">{totals.damaged.toLocaleString('th-TH')}</div>
          <div className="stat-foot">
            <span className="stat-change">รอส่งเคลม/ซ่อม/ตัดจำหน่าย</span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-top">
            <span>เครื่องเดิมส่งคืนใช้งานได้</span>
            <div className="stat-icon blue">
              <Archive size={18} />
            </div>
          </div>
          <div className="stat-value">{totals.usable.toLocaleString('th-TH')}</div>
          <div className="stat-foot">
            <span className="stat-change">สำรองเข้าคลังเพื่อทดแทน</span>
          </div>
        </div>
      </div>

      {/* Stock Table by Model */}
      <section className="panel inventory-table-panel">
        <div className="panel-heading">
          <div>
            <h2>ยอดสต็อกคงเหลือแยกตามรุ่นอุปกรณ์</h2>
            <p>ติดตามอัตราการใช้งานและการกระจายตัวของแต่ละรุ่น</p>
          </div>
          <div className="inventory-search-box">
            <Search size={15} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="ค้นหารุ่นหรือ Lot/Batch..."
            />
          </div>
        </div>

        <div className="table-wrapper">
          <table className="inventory-table">
            <thead>
              <tr>
                <th>รุ่นอุปกรณ์ Scanner</th>
                <th>รับเข้าทั้งหมด</th>
                <th>คงเหลือในคลัง</th>
                <th>อยู่กับช่าง</th>
                <th>ติดตั้งสำเร็จ</th>
                <th>ส่งคืนชำรุด</th>
                <th>ส่งคืนสภาพดี</th>
                <th>Batch ล่าสุด</th>
                <th>สถานะความพร้อม</th>
              </tr>
            </thead>
            <tbody>
              {filteredStock.map(item => {
                const percentAvailable = Math.round((item.in_stock / item.total_received) * 100)
                const isLow = percentAvailable < 20
                return (
                  <tr key={item.id}>
                    <td>
                      <div className="stock-model-cell">
                        <HardDrive size={16} />
                        <strong>{item.model}</strong>
                      </div>
                    </td>
                    <td>{item.total_received.toLocaleString('th-TH')}</td>
                    <td>
                      <strong className={isLow ? 'text-danger' : 'text-success'}>
                        {item.in_stock.toLocaleString('th-TH')}
                      </strong>
                    </td>
                    <td>{item.assigned_to_techs.toLocaleString('th-TH')}</td>
                    <td>{item.installed.toLocaleString('th-TH')}</td>
                    <td>
                      <span className="badge-damaged">
                        {item.returned_damaged}
                      </span>
                    </td>
                    <td>
                      <span className="badge-usable">
                        {item.returned_usable}
                      </span>
                    </td>
                    <td>
                      <span className="stock-batch-tag">{item.last_batch || '—'}</span>
                    </td>
                    <td>
                      <div className="stock-progress-cell">
                        <div className="stock-progress-bar">
                          <div
                            className={`stock-progress-fill ${isLow ? 'low' : 'normal'}`}
                            style={{ width: `${percentAvailable}%` }}
                          />
                        </div>
                        <small>{percentAvailable}% ว่าง</small>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Dispatch History Panel */}
      <section className="panel inventory-dispatch-panel">
        <div className="panel-heading">
          <div>
            <h2>ประวัติการเบิกจ่ายเครื่องให้ทีมช่าง Onsite</h2>
            <p>บันทึกการกระจายเครื่องสแกนเนอร์ไปยังแต่ละทีมพื้นที่</p>
          </div>
        </div>

        <div className="table-wrapper">
          <table className="inventory-table">
            <thead>
              <tr>
                <th>รหัสการเบิก</th>
                <th>วันที่</th>
                <th>ทีมเทคนิคผู้รับเครื่อง</th>
                <th>รุ่นอุปกรณ์</th>
                <th>จำนวน (เครื่อง)</th>
                <th>Lot / Batch</th>
                <th>สถานะการส่งมอบ</th>
              </tr>
            </thead>
            <tbody>
              {dispatchHistory.map(row => (
                <tr key={row.id}>
                  <td><code>{row.id}</code></td>
                  <td>{row.date}</td>
                  <td><strong>{row.team}</strong></td>
                  <td>{row.model}</td>
                  <td><strong>{row.quantity}</strong></td>
                  <td><span className="stock-batch-tag">{row.batch}</span></td>
                  <td>
                    <span className={`status-pill ${row.status === 'acknowledged' ? 'done' : 'progress'}`}>
                      {row.status === 'acknowledged' ? 'ทีมช่างตรวจรับแล้ว' : 'อยู่ระหว่างจัดส่ง'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Modal: Add Stock */}
      {showAddStockModal && (
        <div className="detail-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setShowAddStockModal(false) }}>
          <div className="detail-dialog" role="dialog" aria-modal="true">
            <header className="detail-dialog-header">
              <div>
                <span className="detail-eyebrow">คลังอุปกรณ์ AIS</span>
                <h2>บันทึกรับเครื่องสแกนเนอร์เข้าสต็อก</h2>
              </div>
              <button type="button" className="detail-close" onClick={() => setShowAddStockModal(false)}>
                ✕
              </button>
            </header>
            <form className="task-action-form" onSubmit={handleAddStock} style={{ padding: '20px' }}>
              <label>
                <span>รุ่นอุปกรณ์ Scanner</span>
                <select value={newModel} onChange={e => setNewModel(e.target.value)}>
                  <option value="Zebra DS9308">Zebra DS9308</option>
                  <option value="Honeywell HF680">Honeywell HF680</option>
                  <option value="Datalogic Gryphon GFS4400">Datalogic Gryphon GFS4400</option>
                  <option value="Zebra DS2208 Handheld">Zebra DS2208 Handheld</option>
                  <option value="Sunmi Blink QR Scanner">Sunmi Blink QR Scanner</option>
                </select>
              </label>

              <label>
                <span>จำนวนเครื่องที่รับเข้า (เครื่อง)</span>
                <input
                  type="number"
                  min="1"
                  max="5000"
                  value={newQty}
                  onChange={e => setNewQty(Number(e.target.value))}
                  required
                />
              </label>

              <label>
                <span>หมายเลข Lot / Batch หรือเลขที่ PO</span>
                <input
                  value={newBatch}
                  onChange={e => setNewBatch(e.target.value)}
                  placeholder="เช่น BATCH-2026-NOV-01"
                  required
                />
              </label>

              <div className="task-action-buttons" style={{ marginTop: '16px' }}>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setShowAddStockModal(false)}
                >
                  ยกเลิก
                </button>
                <button type="submit" className="primary-button">
                  บันทึกรับเข้าคลัง
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Dispatch Stock */}
      {showDispatchModal && (
        <div className="detail-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setShowDispatchModal(false) }}>
          <div className="detail-dialog" role="dialog" aria-modal="true">
            <header className="detail-dialog-header">
              <div>
                <span className="detail-eyebrow">เบิกจ่ายอุปกรณ์หน้างาน</span>
                <h2>เบิกจ่ายเครื่องสแกนเนอร์ให้ทีมช่าง Onsite</h2>
              </div>
              <button type="button" className="detail-close" onClick={() => setShowDispatchModal(false)}>
                ✕
              </button>
            </header>
            <form className="task-action-form" onSubmit={handleDispatch} style={{ padding: '20px' }}>
              <label>
                <span>ทีมเทคนิค Onsite ผู้รับมอบ</span>
                <select value={dispatchTeam} onChange={e => setDispatchTeam(e.target.value)}>
                  <option value="ทีมเทคนิค A (กทม. โซน 1)">ทีมเทคนิค A (กทม. โซน 1)</option>
                  <option value="ทีมเทคนิค B (ภาคเหนือ)">ทีมเทคนิค B (ภาคเหนือ)</option>
                  <option value="ทีมเทคนิค C (ภาคอีสาน)">ทีมเทคนิค C (ภาคอีสาน)</option>
                  <option value="ทีมเทคนิค D (ภาคใต้)">ทีมเทคนิค D (ภาคใต้)</option>
                  <option value="ทีมเทคนิค E (ภาคกลาง/ตะวันออก)">ทีมเทคนิค E (ภาคกลาง/ตะวันออก)</option>
                </select>
              </label>

              <label>
                <span>รุ่นอุปกรณ์ Scanner ที่ต้องการเบิก</span>
                <select value={dispatchModel} onChange={e => setDispatchModel(e.target.value)}>
                  {stockList.map(s => (
                    <option key={s.id} value={s.model}>
                      {s.model} (คงเหลือในคลัง {s.in_stock} เครื่อง)
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>จำนวนเครื่องที่เบิก (เครื่อง)</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={dispatchQty}
                  onChange={e => setDispatchQty(Number(e.target.value))}
                  required
                />
              </label>

              <div className="task-action-buttons" style={{ marginTop: '16px' }}>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setShowDispatchModal(false)}
                >
                  ยกเลิก
                </button>
                <button type="submit" className="primary-button">
                  ยืนยันการเบิกจ่าย
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
