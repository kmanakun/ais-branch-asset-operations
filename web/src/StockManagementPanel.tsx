import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  ClipboardCheck,
  FileDown,
  FileSpreadsheet,
  History,
  Info,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  ScanBarcode,
  Search,
  Send,
  Truck,
  X,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { BarcodeScannerModal } from './BarcodeScannerModal'
import {
  ApiError,
  d1Api,
  type StockDocumentRecord,
  type StockImportDefaultsPayload,
  type StockImportInputPayload,
  type StockImportPreviewResponse,
  type StockItemRecord,
  type StockLookupResponse,
  type StockMovementRecord,
  type StockSummaryResponse,
} from './d1-client'
import { useDialogControls } from './dialog'
import {
  appendSerialToBatchText,
  downloadStockCsv,
  formatStockDate,
  getStockActionLabel,
  getStockStatusMeta,
  parseBatchSerialText,
  STOCK_DOC_TYPE_META,
  STOCK_SOURCE_MODE_LABELS,
} from './lib/stock-ui-labels'

type StockSubTab = 'inventory' | 'import' | 'operations' | 'reverse' | 'documents'
type OpsMode = 'dispatch' | 'recall' | 'doa'
type ReverseMode = 'receive' | 'handover'
type StockSourceModeFilter = '' | 'registered_stock' | 'hybrid_unregistered' | 'onsite_removal'

interface StockManagementPanelProps {
  role?: string
  onToast: (message: string) => void
}

const ADMIN_STOCK_ROLES = new Set(['admin', 'data_manager'])

function extractInvalidSerials(err: unknown): string[] {
  if (!(err instanceof ApiError)) return []
  const list = err.details?.invalid_serials
  return Array.isArray(list) ? list.map(v => String(v)) : []
}

function InvalidSerialList({ serials }: { serials: string[] }) {
  if (!serials.length) return null
  return (
    <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs">
      {serials.slice(0, 10).map((sn, idx) => (
        <li key={`${sn}-${idx}`} className="font-mono break-all">{sn}</li>
      ))}
      {serials.length > 10 && <li>และอีก {serials.length - 10} รายการ</li>}
    </ul>
  )
}

export function StockManagementPanel({ role, onToast }: StockManagementPanelProps) {
  const canManageStock = ADMIN_STOCK_ROLES.has(String(role || ''))
  const isViewer = role === 'viewer'

  const [subTab, setSubTab] = useState<StockSubTab>('inventory')
  const [summary, setSummary] = useState<StockSummaryResponse | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState('')
  const [reloadTick, setReloadTick] = useState(0)

  // Quick prefill state when Admin selects items from Inventory -> Operations / Reverse
  const [opsModePrefill, setOpsModePrefill] = useState<OpsMode>('dispatch')
  const [opsSerialPrefill, setOpsSerialPrefill] = useState('')
  const [reverseModePrefill, setReverseModePrefill] = useState<ReverseMode>('receive')
  const [reverseSerialPrefill, setReverseSerialPrefill] = useState('')

  // Inventory filter shortcuts (from Model / Area chips)
  const [inventorySearch, setInventorySearch] = useState('')
  const [inventoryStatus, setInventoryStatus] = useState('')
  const [inventoryArea, setInventoryArea] = useState('')
  const [inventoryUnitType, setInventoryUnitType] = useState<'' | 'new_unit' | 'old_removed'>('')
  const [inventorySourceMode, setInventorySourceMode] = useState<StockSourceModeFilter>('')

  // Timeline modal state
  const [timelineLookup, setTimelineLookup] = useState<StockLookupResponse | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)

  const refreshAll = useCallback(() => {
    setReloadTick(t => t + 1)
  }, [])

  useEffect(() => {
    let active = true
    setSummaryLoading(true)
    void (async () => {
      try {
        const res = await d1Api.getStockSummary()
        if (!active) return
        setSummary(res)
        setSummaryError('')
      } catch (err: any) {
        if (!active) return
        setSummaryError(err?.message || 'ไม่สามารถโหลดข้อมูลภาพรวมสต็อกได้')
      } finally {
        if (active) setSummaryLoading(false)
      }
    })()
    return () => { active = false }
  }, [reloadTick])

  useEffect(() => {
    if (!canManageStock && subTab !== 'inventory') {
      setSubTab('inventory')
    }
  }, [canManageStock, subTab])

  const openSerialTimeline = useCallback(async (serial: string) => {
    const clean = serial.trim()
    if (!clean || isViewer) return
    setTimelineLoading(true)
    try {
      const res = await d1Api.lookupStockSerial(clean)
      setTimelineLookup(res)
    } catch (err: any) {
      onToast(err?.message || 'ตรวจสอบประวัติ Serial Number ไม่สำเร็จ')
    } finally {
      setTimelineLoading(false)
    }
  }, [isViewer, onToast])

  const sendToOperations = useCallback((mode: OpsMode, serials: string[]) => {
    if (!canManageStock || serials.length === 0) return
    setOpsModePrefill(mode)
    setOpsSerialPrefill(serials.join('\n'))
    setSubTab('operations')
  }, [canManageStock])

  const sendToReverse = useCallback((mode: ReverseMode, serials: string[]) => {
    if (!canManageStock || serials.length === 0) return
    setReverseModePrefill(mode)
    setReverseSerialPrefill(serials.join('\n'))
    setSubTab('reverse')
  }, [canManageStock])

  const applySummaryQuickFilter = useCallback((opts: {
    unitType?: '' | 'new_unit' | 'old_removed'
    status?: string
    sourceMode?: StockSourceModeFilter
    area?: string
    search?: string
  }) => {
    setInventoryUnitType(opts.unitType ?? '')
    setInventoryStatus(opts.status ?? '')
    setInventorySourceMode(opts.sourceMode ?? '')
    setInventoryArea(opts.area ?? '')
    setInventorySearch(opts.search ?? '')
    setSubTab('inventory')
  }, [])

  const knownDispatchAreas = useMemo(
    () => (summary?.by_dispatch_area || []).map(a => a.dispatch_area).filter(Boolean),
    [summary],
  )

  const subTabs: Array<{ key: StockSubTab; label: string; icon: typeof Package; adminOnly?: boolean }> = [
    { key: 'inventory', label: 'คลัง & รายการ SN', icon: Package },
    { key: 'import', label: 'นำเข้า Supplier', icon: FileSpreadsheet, adminOnly: true },
    { key: 'operations', label: 'เบิกกระจาย / DOA', icon: Truck, adminOnly: true },
    { key: 'reverse', label: 'รับซาก & ส่งคืนลูกค้า', icon: RotateCcw, adminOnly: true },
    { key: 'documents', label: 'ประวัติเอกสาร', icon: History, adminOnly: true },
  ]

  return (
    <div className="min-w-0 space-y-4">
      <StockSummarySection
        summary={summary}
        loading={summaryLoading}
        error={summaryError}
        onRefresh={refreshAll}
        onFilterSelect={applySummaryQuickFilter}
      />

      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-slate-200 pb-2">
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="เมนูจัดการคลังสต็อก">
          {subTabs
            .filter(item => !item.adminOnly || canManageStock)
            .map(item => {
              const Icon = item.icon
              const active = subTab === item.key
              return (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSubTab(item.key)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-semibold transition-colors',
                    active
                      ? 'border-emerald-700 bg-emerald-700 text-white shadow-xs'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <Icon size={15} />
                  <span>{item.label}</span>
                </button>
              )
            })}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={refreshAll} disabled={summaryLoading}>
          <RefreshCw size={14} className={summaryLoading ? 'animate-spin' : ''} />
          <span className="hidden sm:inline">รีเฟรช</span>
        </Button>
      </div>

      {isViewer && (
        <Alert variant="default">
          <Info size={16} className="mt-0.5 shrink-0 text-slate-600" />
          <AlertDescription>
            บัญชีผู้เข้าชมแสดงเฉพาะยอดสรุปและรายการสต็อกแบบปิดบังเลข Serial บางส่วน เพื่อความปลอดภัยของข้อมูลอุปกรณ์
          </AlertDescription>
        </Alert>
      )}

      {subTab === 'inventory' && (
        <StockInventorySection
          canManageStock={canManageStock}
          isViewer={isViewer}
          reloadTick={reloadTick}
          knownAreas={knownDispatchAreas}
          search={inventorySearch}
          setSearch={setInventorySearch}
          status={inventoryStatus}
          setStatus={setInventoryStatus}
          area={inventoryArea}
          setArea={setInventoryArea}
          unitType={inventoryUnitType}
          setUnitType={setInventoryUnitType}
          sourceMode={inventorySourceMode}
          setSourceMode={setInventorySourceMode}
          onInspectSerial={sn => void openSerialTimeline(sn)}
          onBatchToOps={sendToOperations}
          onBatchToReverse={sendToReverse}
          onToast={onToast}
        />
      )}

      {subTab === 'import' && canManageStock && (
        <StockImportSection
          knownAreas={knownDispatchAreas}
          onCommitted={msg => {
            onToast(msg)
            refreshAll()
          }}
        />
      )}

      {subTab === 'operations' && canManageStock && (
        <StockOperationsSection
          initialMode={opsModePrefill}
          initialSerialText={opsSerialPrefill}
          knownAreas={knownDispatchAreas}
          onCompleted={msg => {
            onToast(msg)
            refreshAll()
          }}
        />
      )}

      {subTab === 'reverse' && canManageStock && (
        <StockReverseSection
          initialMode={reverseModePrefill}
          initialSerialText={reverseSerialPrefill}
          reloadTick={reloadTick}
          onCompleted={msg => {
            onToast(msg)
            refreshAll()
          }}
        />
      )}

      {subTab === 'documents' && canManageStock && (
        <StockDocumentsSection reloadTick={reloadTick} />
      )}

      {timelineLoading && (
        <div className="fixed bottom-20 right-4 z-[9990] flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 shadow-lg">
          <Loader2 size={14} className="animate-spin text-emerald-700" />
          <span>กำลังโหลดประวัติ Serial Number…</span>
        </div>
      )}

      {timelineLookup && createPortal(
        <StockSerialTimelineModal lookup={timelineLookup} onClose={() => setTimelineLookup(null)} />,
        document.body,
      )}
    </div>
  )
}

function StockSummarySection({
  summary,
  loading,
  error,
  onRefresh,
  onFilterSelect,
}: {
  summary: StockSummaryResponse | null
  loading: boolean
  error: string
  onRefresh: () => void
  onFilterSelect: (opts: { unitType?: '' | 'new_unit' | 'old_removed'; status?: string; sourceMode?: StockSourceModeFilter; area?: string; search?: string }) => void
}) {
  if (error && !summary) {
    return (
      <Alert variant="destructive">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
          <div>
            <AlertTitle className="text-xs font-bold">โหลดสรุปสต็อกไม่สำเร็จ</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onRefresh}>ลองใหม่</Button>
        </div>
      </Alert>
    )
  }

  const n = summary?.new_units
  const o = summary?.old_removed

  const kpis = [
    {
      label: 'เครื่องใหม่พร้อมเบิกใช้',
      value: n ? n.available_total : 0,
      sub: n ? `คลังกลาง ${n.in_warehouse.toLocaleString('th-TH')} · พื้นที่ ${n.dispatched.toLocaleString('th-TH')}` : '—',
      tone: 'text-emerald-700',
      border: 'border-emerald-200 bg-emerald-50/40',
      onClick: () => onFilterSelect({ unitType: 'new_unit', status: 'in_warehouse,dispatched' }),
    },
    {
      label: 'จองใช้งานหน้างาน',
      value: n ? n.allocated_to_task : 0,
      sub: 'อยู่ระหว่างติดตั้ง/รอตรวจรับ',
      tone: 'text-sky-700',
      border: 'border-sky-200 bg-sky-50/40',
      onClick: () => onFilterSelect({ unitType: 'new_unit', status: 'allocated_to_task' }),
    },
    {
      label: 'ติดตั้งตรวจรับแล้ว',
      value: n ? n.installed : 0,
      sub: 'G-Able ตรวจรับสำเร็จ',
      tone: 'text-emerald-800',
      border: 'border-slate-200 bg-white',
      onClick: () => onFilterSelect({ unitType: 'new_unit', status: 'installed' }),
    },
    {
      label: 'รอนำเข้า Hybrid Mode',
      value: n ? n.hybrid_unregistered : 0,
      sub: 'ปิดงานแล้ว รอจับคู่ไฟล์ Supplier',
      tone: 'text-amber-700',
      border: 'border-amber-200 bg-amber-50/50',
      onClick: () => onFilterSelect({ unitType: 'new_unit', status: '', sourceMode: 'hybrid_unregistered' }),
    },
    {
      label: 'แจ้งเสียรอเคลม (DOA)',
      value: n ? n.doa_defective : 0,
      sub: 'เครื่องใหม่ชำรุดก่อนติดตั้ง',
      tone: 'text-red-700',
      border: 'border-red-200 bg-red-50/40',
      onClick: () => onFilterSelect({ unitType: 'new_unit', status: 'doa_defective' }),
    },
    {
      label: 'ซากเครื่องเดิมรอรับคืน / ค้างคลัง',
      value: o ? o.removed_onsite + o.returned_to_warehouse : 0,
      sub: o ? `หน้างาน ${o.removed_onsite.toLocaleString('th-TH')} · คลัง ${o.returned_to_warehouse.toLocaleString('th-TH')} · คืนแล้ว ${o.handed_over_to_customer.toLocaleString('th-TH')}` : '—',
      tone: 'text-slate-800',
      border: 'border-slate-200 bg-white',
      onClick: () => onFilterSelect({ unitType: 'old_removed', status: 'removed_onsite,returned_to_warehouse' }),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2.5 min-[360px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {kpis.map(kpi => (
          <button
            key={kpi.label}
            type="button"
            onClick={kpi.onClick}
            className={cn(
              'flex flex-col justify-between rounded-xl border p-3.5 text-left transition-all hover:shadow-sm',
              kpi.border,
            )}
          >
            <span className="text-[11.5px] font-semibold text-slate-600">{kpi.label}</span>
            <strong className={cn('mt-1 text-2xl font-extrabold tabular-nums', kpi.tone)}>
              {loading && !summary ? '…' : kpi.value.toLocaleString('th-TH')}
            </strong>
            <span className="mt-1 text-[11px] leading-tight text-slate-500">{kpi.sub}</span>
          </button>
        ))}
      </div>

      {summary && (summary.by_dispatch_area.length > 0 || summary.by_model.length > 0) && (
        <div className="grid gap-2.5 md:grid-cols-2">
          {summary.by_dispatch_area.length > 0 && (
            <Card className="min-w-0 p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700">พื้นที่/ทีมที่เบิกกระจาย (Model B)</span>
                <span className="text-[11px] text-slate-500">คลิกเพื่อกรอง</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {summary.by_dispatch_area.map(area => (
                  <button
                    key={area.dispatch_area}
                    type="button"
                    onClick={() => onFilterSelect({ unitType: 'new_unit', area: area.dispatch_area })}
                    className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-900 hover:bg-sky-100"
                  >
                    <span>{area.dispatch_area}</span>
                    <span className="rounded-full bg-white px-1.5 py-0.5 text-[11px] font-bold text-sky-700">
                      ว่าง {area.dispatched_available}
                    </span>
                    <span className="text-[10.5px] text-slate-500">
                      (ใช้ {area.allocated_to_task + area.installed})
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          )}

          {summary.by_model.length > 0 && (
            <Card className="min-w-0 p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700">สต็อกเครื่องใหม่แยกตามรุ่น</span>
                <span className="text-[11px] text-slate-500">คลิกเพื่อค้นหา</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {summary.by_model.slice(0, 8).map(m => (
                  <button
                    key={`${m.brand}-${m.model_name}`}
                    type="button"
                    onClick={() => onFilterSelect({
                      unitType: 'new_unit',
                      search: m.model_name !== 'ไม่ระบุรุ่น' ? m.model_name : '',
                    })}
                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100"
                  >
                    <span className="font-semibold">{m.brand} {m.model_name}</span>
                    <span className="font-mono text-[11px] text-emerald-700">
                      ว่าง {m.in_warehouse + m.dispatched}
                    </span>
                    <span className="text-[10.5px] text-slate-500">/ {m.total}</span>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}

function StockInventorySection({
  canManageStock,
  isViewer,
  reloadTick,
  knownAreas,
  search,
  setSearch,
  status,
  setStatus,
  area,
  setArea,
  unitType,
  setUnitType,
  sourceMode,
  setSourceMode,
  onInspectSerial,
  onBatchToOps,
  onBatchToReverse,
  onToast,
}: {
  canManageStock: boolean
  isViewer: boolean
  reloadTick: number
  knownAreas: string[]
  search: string
  setSearch: (v: string) => void
  status: string
  setStatus: (v: string) => void
  area: string
  setArea: (v: string) => void
  unitType: '' | 'new_unit' | 'old_removed'
  setUnitType: (v: '' | 'new_unit' | 'old_removed') => void
  sourceMode: StockSourceModeFilter
  setSourceMode: (v: StockSourceModeFilter) => void
  onInspectSerial: (sn: string) => void
  onBatchToOps: (mode: OpsMode, serials: string[]) => void
  onBatchToReverse: (mode: ReverseMode, serials: string[]) => void
  onToast: (msg: string) => void
}) {
  const [includeVoid, setIncludeVoid] = useState(false)
  const [page, setPage] = useState(0)
  const [items, setItems] = useState<StockItemRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({})
  const [quickSnInput, setQuickSnInput] = useState('')

  const PAGE_SIZE = 50

  useEffect(() => {
    setPage(0)
  }, [search, status, area, unitType, sourceMode, includeVoid])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await d1Api.getStockItems({
            unit_type: unitType || undefined,
            status: status || undefined,
            source_mode: sourceMode || undefined,
            dispatch_area: area || undefined,
            search: search.trim() || undefined,
            include_void: includeVoid || Boolean(status),
            limit: PAGE_SIZE,
            offset: page * PAGE_SIZE,
          })
          if (!active) return
          setItems(res.rows || [])
          setTotal(res.total || 0)
          setSelectedIds({})
        } catch (err: any) {
          if (!active) return
          setError(err?.message || 'โหลดรายการสต็อกไม่สำเร็จ')
        } finally {
          if (active) setLoading(false)
        }
      })()
    }, 150)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [unitType, status, sourceMode, area, search, includeVoid, page, reloadTick])

  const selectedItems = useMemo(
    () => items.filter(item => selectedIds[item.id]),
    [items, selectedIds],
  )
  const dispatchableSns = selectedItems
    .filter(i => i.unit_type === 'new_unit' && ['in_warehouse', 'dispatched'].includes(i.status))
    .map(i => i.serial_number)
  const recallableSns = selectedItems
    .filter(i => i.unit_type === 'new_unit' && i.status === 'dispatched')
    .map(i => i.serial_number)
  const receivableOldSns = selectedItems
    .filter(i => i.unit_type === 'old_removed' && i.status === 'removed_onsite')
    .map(i => i.serial_number)
  const handoverOldSns = selectedItems
    .filter(i => i.unit_type === 'old_removed' && i.status === 'returned_to_warehouse')
    .map(i => i.serial_number)

  const toggleAllVisible = () => {
    if (!items.length) return
    const allSelected = items.every(i => selectedIds[i.id])
    if (allSelected) {
      setSelectedIds({})
    } else {
      const next: Record<string, boolean> = {}
      for (const item of items) next[item.id] = true
      setSelectedIds(next)
    }
  }

  const handleExportCurrentCsv = () => {
    if (isViewer || items.length === 0) {
      onToast('ไม่มีรายการสำหรับส่งออก')
      return
    }
    downloadStockCsv(
      `AIS_Stock_Items_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Serial Number', 'ประเภท', 'สถานะ', 'แหล่งที่มา', 'ยี่ห้อ', 'รุ่น', 'Lot/PO', 'พื้นที่เบิก', 'สาขาที่เชื่อม', 'เอกสารรับ', 'เอกสารเบิก', 'เอกสารรับซาก', 'เอกสารคืนลูกค้า', 'อัปเดตล่าสุด'],
      items.map(row => [
        row.serial_number,
        row.unit_type === 'new_unit' ? 'เครื่องใหม่' : 'ซากเครื่องเดิม',
        getStockStatusMeta(row.status).label,
        STOCK_SOURCE_MODE_LABELS[row.source_mode] || row.source_mode,
        row.brand || '',
        row.model_name || '',
        row.lot_no || '',
        row.dispatch_area || '',
        row.branch_code ? `${row.branch_code} ${row.branch_name || ''}`.trim() : '',
        row.receive_doc_code || '',
        row.dispatch_doc_code || '',
        row.return_doc_code || '',
        row.handover_doc_code || '',
        formatStockDate(row.updated_at),
      ]),
    )
    onToast(`ส่งออกรายการหน้านี้ ${items.length} แถวสำเร็จ`)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>ทะเบียนสต็อกเครื่องสแกนเนอร์ราย Serial</CardTitle>
            <CardDescription>
              ค้นหา ตรวจสถานะเครื่องใหม่/ซากเครื่องเดิม กรองตามพื้นที่ Model B และติดตาม Movement ย้อนหลัง
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {!isViewer && (
              <form
                className="flex flex-wrap items-center gap-1.5"
                onSubmit={e => {
                  e.preventDefault()
                  if (quickSnInput.trim()) onInspectSerial(quickSnInput.trim())
                }}
              >
                <Input
                  value={quickSnInput}
                  onChange={e => setQuickSnInput(e.target.value)}
                  placeholder="ตรวจประวัติ SN ด่วน…"
                  aria-label="ตรวจประวัติ SN ด่วน"
                  className="h-8 w-40 text-xs sm:w-52"
                />
                <Button type="submit" size="sm" variant="outline" disabled={!quickSnInput.trim()}>
                  <Search size={13} />
                  <span>เช็ค SN</span>
                </Button>
              </form>
            )}
            {!isViewer && items.length > 0 && (
              <Button type="button" size="sm" variant="outline" onClick={handleExportCurrentCsv}>
                <FileDown size={14} />
                <span>Export CSV</span>
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Filter controls */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={isViewer ? 'ค้นหารุ่น, ยี่ห้อ, พื้นที่, สาขา…' : 'ค้นหา SN, รุ่น, Lot, พื้นที่, สาขา…'}
              aria-label="ค้นหารายการสต็อก"
              className="pl-8 text-xs"
            />
          </div>

          <select
            aria-label="กรองประเภทเครื่อง"
            value={unitType}
            onChange={e => setUnitType(e.target.value as '' | 'new_unit' | 'old_removed')}
            className="h-10 rounded-lg border border-slate-300 bg-white px-2.5 text-xs text-slate-800"
          >
            <option value="">ทุกประเภท (ใหม่ + ซากเดิม)</option>
            <option value="new_unit">เครื่องใหม่ (new_unit)</option>
            <option value="old_removed">ซากเครื่องเดิม (old_removed)</option>
          </select>

          <select
            aria-label="กรองสถานะสต็อก"
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="h-10 rounded-lg border border-slate-300 bg-white px-2.5 text-xs text-slate-800"
          >
            <option value="">ทุกสถานะที่ใช้งานอยู่</option>
            <option value="in_warehouse,dispatched">พร้อมเบิก/ใช้งาน (คลัง+พื้นที่)</option>
            <option value="in_warehouse">อยู่ในคลังกลาง (in_warehouse)</option>
            <option value="dispatched">เบิกออกพื้นที่ (dispatched)</option>
            <option value="allocated_to_task">จองใช้งานหน้างาน (allocated)</option>
            <option value="installed">ติดตั้งตรวจรับแล้ว (installed)</option>
            <option value="doa_defective">แจ้งเสีย DOA</option>
            <option value="removed_onsite">ซากถอดหน้างาน (รอส่งคืน)</option>
            <option value="returned_to_warehouse">รับซากเข้าคลังแล้ว</option>
            <option value="handed_over_to_customer">ส่งมอบซากคืนลูกค้าแล้ว</option>
            <option value="void_hybrid">ยกเลิก Hybrid</option>
            <option value="cancelled_restored">ยกเลิกงาน/คืนสถานะ</option>
          </select>

          <select
            aria-label="กรองแหล่งที่มา"
            value={sourceMode}
            onChange={e => setSourceMode(e.target.value as StockSourceModeFilter)}
            className="h-10 rounded-lg border border-slate-300 bg-white px-2.5 text-xs text-slate-800"
          >
            <option value="">ทุกแหล่งที่มา</option>
            <option value="registered_stock">รับเข้าจาก Supplier ปกติ</option>
            <option value="hybrid_unregistered">Hybrid (รอนำเข้า Supplier)</option>
            <option value="onsite_removal">ถอดจากสาขาหน้างาน</option>
          </select>

          <select
            aria-label="กรองพื้นที่เบิก"
            value={area}
            onChange={e => setArea(e.target.value)}
            className="h-10 rounded-lg border border-slate-300 bg-white px-2.5 text-xs text-slate-800"
          >
            <option value="">ทุกพื้นที่/ทีมเบิก</option>
            {knownAreas.map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
          <div className="flex flex-wrap items-center gap-3">
            <span>พบทั้งหมด <strong>{total.toLocaleString('th-TH')}</strong> รายการ</span>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={includeVoid}
                onChange={e => setIncludeVoid(e.target.checked)}
              />
              <span>แสดงรายการที่ยกเลิก (Void Hybrid / Cancelled)</span>
            </label>
          </div>
          {(search || status || area || unitType || sourceMode) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setSearch('')
                setStatus('')
                setArea('')
                setUnitType('')
                setSourceMode('')
              }}
            >
              ล้างตัวกรอง
            </Button>
          )}
        </div>

        {/* Admin batch action bar */}
        {canManageStock && selectedItems.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs">
            <span className="font-semibold text-emerald-900">
              เลือกแล้ว {selectedItems.length} รายการ
            </span>
            <div className="flex flex-wrap gap-1.5">
              {dispatchableSns.length > 0 && (
                <>
                  <Button type="button" size="sm" onClick={() => onBatchToOps('dispatch', dispatchableSns)}>
                    <Truck size={13} /> เบิกกระจาย ({dispatchableSns.length})
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => onBatchToOps('doa', dispatchableSns)}>
                    แจ้ง DOA ({dispatchableSns.length})
                  </Button>
                </>
              )}
              {recallableSns.length > 0 && (
                <Button type="button" size="sm" variant="outline" onClick={() => onBatchToOps('recall', recallableSns)}>
                  ดึงกลับคลัง ({recallableSns.length})
                </Button>
              )}
              {receivableOldSns.length > 0 && (
                <Button type="button" size="sm" variant="outline" onClick={() => onBatchToReverse('receive', receivableOldSns)}>
                  รับซากเข้าคลัง ({receivableOldSns.length})
                </Button>
              )}
              {handoverOldSns.length > 0 && (
                <Button type="button" size="sm" variant="outline" onClick={() => onBatchToReverse('handover', handoverOldSns)}>
                  ส่งมอบซากคืนลูกค้า ({handoverOldSns.length})
                </Button>
              )}
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-500">
            <Loader2 size={16} className="animate-spin text-emerald-700" />
            <span>กำลังโหลดข้อมูลสต็อก…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-xs text-slate-500">
            ไม่พบรายการสต็อกที่ตรงกับเงื่อนไข
          </div>
        ) : (
          <>
            {/* Mobile cards (< md) */}
            <div className="space-y-2 md:hidden">
              {items.map(row => {
                const st = getStockStatusMeta(row.status)
                return (
                  <div key={row.id} className="rounded-xl border border-slate-200 bg-white p-3 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {canManageStock && (
                          <input
                            type="checkbox"
                            aria-label={`เลือก ${row.serial_number}`}
                            checked={Boolean(selectedIds[row.id])}
                            onChange={e => setSelectedIds(prev => ({ ...prev, [row.id]: e.target.checked }))}
                          />
                        )}
                        <div>
                          <div className="font-mono text-[13px] font-bold text-slate-900">{row.serial_number}</div>
                          <div className="text-[11px] text-slate-500">
                            {row.unit_type === 'new_unit' ? 'เครื่องใหม่' : 'ซากเครื่องเดิม'}
                            {row.model_name ? ` · ${row.brand || ''} ${row.model_name}`.trim() : ''}
                          </div>
                        </div>
                      </div>
                      <Badge variant={st.tone}>{st.label}</Badge>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px] text-slate-600">
                      <div>พื้นที่/ทีม: <strong>{row.dispatch_area || '—'}</strong></div>
                      <div>Lot/PO: <strong>{row.lot_no || '—'}</strong></div>
                      <div className="col-span-2">
                        สาขา: <strong>{row.branch_code ? `${row.branch_code} ${row.branch_name || ''}`.trim() : '—'}</strong>
                      </div>
                      <div className="col-span-2 text-slate-400">อัปเดต: {formatStockDate(row.updated_at)}</div>
                    </div>
                    {!isViewer && (
                      <div className="mt-2 flex justify-end">
                        <Button type="button" size="sm" variant="outline" onClick={() => onInspectSerial(row.serial_number)}>
                          <History size={13} /> ประวัติสายงาน
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Desktop table (>= md) */}
            <div className="hidden rounded-xl border border-slate-200 md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    {canManageStock && (
                      <TableHead className="w-9">
                        <input
                          type="checkbox"
                          aria-label="เลือกทั้งหมดในหน้านี้"
                          checked={items.length > 0 && items.every(i => selectedIds[i.id])}
                          onChange={toggleAllVisible}
                        />
                      </TableHead>
                    )}
                    <TableHead>Serial Number</TableHead>
                    <TableHead>ประเภท / แหล่งที่มา</TableHead>
                    <TableHead>สถานะ</TableHead>
                    <TableHead>ยี่ห้อ / รุ่น</TableHead>
                    <TableHead>Lot / พื้นที่เบิก</TableHead>
                    <TableHead>สาขา / เลขเอกสาร</TableHead>
                    <TableHead>อัปเดตล่าสุด</TableHead>
                    {!isViewer && <TableHead className="text-right">ตรวจสอบ</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map(row => {
                    const st = getStockStatusMeta(row.status)
                    const docBadges = [row.receive_doc_code, row.dispatch_doc_code, row.return_doc_code, row.handover_doc_code].filter(Boolean)
                    return (
                      <TableRow key={row.id}>
                        {canManageStock && (
                          <TableCell>
                            <input
                              type="checkbox"
                              aria-label={`เลือก ${row.serial_number}`}
                              checked={Boolean(selectedIds[row.id])}
                              onChange={e => setSelectedIds(prev => ({ ...prev, [row.id]: e.target.checked }))}
                            />
                          </TableCell>
                        )}
                        <TableCell className="font-mono font-bold text-slate-900">
                          {row.serial_number}
                        </TableCell>
                        <TableCell>
                          <div className="text-xs font-semibold text-slate-800">
                            {row.unit_type === 'new_unit' ? 'เครื่องใหม่' : 'ซากเครื่องเดิม'}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {STOCK_SOURCE_MODE_LABELS[row.source_mode] || row.source_mode}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={st.tone}>{st.label}</Badge>
                        </TableCell>
                        <TableCell>
                          <div>{row.brand || '—'}</div>
                          <div className="text-[11.5px] text-slate-500">{row.model_name || '—'}</div>
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-xs">{row.lot_no || '—'}</div>
                          {row.dispatch_area && (
                            <div className="text-[11.5px] font-medium text-sky-800">{row.dispatch_area}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="text-xs">
                            {row.branch_code ? `${row.branch_code} ${row.branch_name || ''}`.trim() : '—'}
                          </div>
                          {docBadges.length > 0 && (
                            <div className="mt-0.5 flex flex-wrap gap-1">
                              {docBadges.map(code => (
                                <span key={code} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-700">
                                  {code}
                                </span>
                              ))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-slate-500 whitespace-nowrap">
                          {formatStockDate(row.updated_at)}
                        </TableCell>
                        {!isViewer && (
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => onInspectSerial(row.serial_number)}
                            >
                              <History size={13} />
                              <span>ประวัติ</span>
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between pt-2 text-xs text-slate-600">
                <span>หน้า {page + 1} / {totalPages}</span>
                <div className="flex gap-1.5">
                  <Button type="button" size="sm" variant="outline" disabled={page <= 0} onClick={() => setPage(p => Math.max(0, p - 1))}>
                    ก่อนหน้า
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)}>
                    ถัดไป
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function StockImportSection({
  knownAreas,
  onCommitted,
}: {
  knownAreas: string[]
  onCommitted: (message: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [sheetName, setSheetName] = useState('')
  const [parsedRows, setParsedRows] = useState<StockImportInputPayload[]>([])
  const [defaults, setDefaults] = useState<StockImportDefaultsPayload>({
    brand: '',
    model_name: '',
    lot_no: '',
    dispatch_mode: 'in_warehouse',
    dispatch_area: '',
    received_date: new Date().toISOString().slice(0, 10),
    note: '',
  })
  const [preview, setPreview] = useState<StockImportPreviewResponse | null>(null)
  const [showErrorsOnly, setShowErrorsOnly] = useState(false)
  const [skipInvalid, setSkipInvalid] = useState(false)
  const [commitResult, setCommitResult] = useState<{
    doc_code: string
    dispatch_doc_code: string | null
    message: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const handleDownloadTemplate = async () => {
    const { buildStockTemplateCsv } = await import('./xlsx-stock.mjs')
    const csv = buildStockTemplateCsv()
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'Supplier_Scanner_Stock_Template.csv'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const handleChooseFile = async (file?: File) => {
    setError('')
    setPreview(null)
    setCommitResult(null)
    setParsedRows([])
    setFileName('')
    setSheetName('')
    if (!file) return
    try {
      const { parseStockWorkbook } = await import('./xlsx-stock.mjs')
      const res = await parseStockWorkbook(file)
      setFileName(file.name)
      setSheetName(res.sheet_name)
      setParsedRows(res.rows)
    } catch (err: any) {
      setError(err?.message || 'ไม่สามารถอ่านไฟล์ Excel ได้ กรุณาตรวจสอบรูปแบบไฟล์')
    }
  }

  const handlePreview = async () => {
    if (parsedRows.length === 0 || busy) return
    if (defaults.dispatch_mode === 'dispatched' && !String(defaults.dispatch_area || '').trim()) {
      setError('กรุณาระบุพื้นที่/ทีมปลายทาง (dispatch_area) เมื่อเลือกนำเข้าแบบเบิกออกพื้นที่ทันที')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await d1Api.previewStockImport(parsedRows, defaults)
      setPreview(res)
      setShowErrorsOnly(res.summary.errors > 0 && res.summary.valid === 0)
    } catch (err: any) {
      setError(err?.message || 'ตรวจสอบข้อมูลก่อนนำเข้าไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  const handleCommit = async () => {
    if (!preview || busy || parsedRows.length === 0) return
    if (preview.summary.errors > 0 && !skipInvalid) {
      setError(`พบข้อผิดพลาด ${preview.summary.errors} แถว — กรุณาแก้ไขไฟล์หรือเลือก "ข้ามรายการที่มีปัญหา"`)
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await d1Api.commitStockImport({
        source_name: fileName || 'Supplier_Stock.xlsx',
        rows: parsedRows,
        defaults,
        skip_invalid: skipInvalid,
      })
      setCommitResult({
        doc_code: res.doc_code,
        dispatch_doc_code: res.dispatch_doc_code,
        message: res.message,
      })
      setPreview(null)
      setParsedRows([])
      setFileName('')
      setSheetName('')
      if (fileRef.current) fileRef.current.value = ''
      onCommitted(res.message)
    } catch (err: any) {
      setError(err?.message || 'บันทึกนำเข้าสต็อกไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  const displayedPreviewRows = useMemo(() => {
    if (!preview) return []
    const rows = showErrorsOnly ? preview.items.filter(r => !r.valid) : preview.items
    return rows.slice(0, 150)
  }, [preview, showErrorsOnly])

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>นำเข้าสต็อกเครื่องใหม่จาก Supplier (.xlsx)</CardTitle>
            <CardDescription>
              รองรับไฟล์ที่มีเฉพาะคอลัมน์ Serial Number หรือไฟล์ที่มีคอลัมน์เสริม พร้อมตรวจเลขเพี้ยน (2.3E+14 / .0) และจับคู่ Hybrid Mode อัตโนมัติ
            </CardDescription>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => void handleDownloadTemplate()}>
            <FileDown size={14} /> ดาวน์โหลดไฟล์ตัวอย่าง (.csv)
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded-xl border border-dashed border-emerald-300 bg-emerald-50/40 p-4 text-center">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            aria-label="เลือกไฟล์ Excel สต็อก Supplier"
            onChange={e => void handleChooseFile(e.target.files?.[0])}
          />
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <FileSpreadsheet size={20} />
          </div>
          <div className="text-sm font-bold text-slate-800">{fileName || 'เลือกไฟล์ Excel (.xlsx) จาก Supplier'}</div>
          <div className="mt-1 text-xs text-slate-600">
            {parsedRows.length > 0
              ? `อ่านได้ ${parsedRows.length.toLocaleString('th-TH')} รายการ จากชีต "${sheetName}"`
              : 'ระบบอ่านไฟล์ในเบราว์เซอร์ ตรวจจับคอลัมน์ SN อัตโนมัติ (ไม่บังคับชื่อชีต)'}
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
              <FileSpreadsheet size={15} /> เลือกไฟล์ .xlsx
            </Button>
            {parsedRows.length > 0 && (
              <Button type="button" disabled={busy} onClick={() => void handlePreview()}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ClipboardCheck size={15} />}
                <span>ตรวจสอบข้อมูลก่อนนำเข้า (Preview)</span>
              </Button>
            )}
          </div>
        </div>

        {/* Batch Defaults */}
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
          <div className="mb-2.5 text-xs font-bold text-slate-700">
            ค่าตั้งต้นสำหรับไฟล์ชุดนี้ (ใช้เติมเมื่อใน Excel ไม่มีคอลัมน์หรือเว้นว่าง)
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs font-medium text-slate-700">
              ยี่ห้อ (Brand)
              <Input
                value={defaults.brand || ''}
                onChange={e => {
                  setPreview(null)
                  setDefaults(d => ({ ...d, brand: e.target.value }))
                }}
                placeholder="เช่น Zebra / Honeywell"
                className="mt-1 text-xs"
              />
            </label>
            <label className="text-xs font-medium text-slate-700">
              รุ่น (Model)
              <Input
                value={defaults.model_name || ''}
                onChange={e => {
                  setPreview(null)
                  setDefaults(d => ({ ...d, model_name: e.target.value }))
                }}
                placeholder="เช่น DS9308 / HF680"
                className="mt-1 text-xs"
              />
            </label>
            <label className="text-xs font-medium text-slate-700">
              เลข Lot / PO
              <Input
                value={defaults.lot_no || ''}
                onChange={e => {
                  setPreview(null)
                  setDefaults(d => ({ ...d, lot_no: e.target.value }))
                }}
                placeholder="เช่น PO-2026-11-LOT1"
                className="mt-1 text-xs"
              />
            </label>
            <label className="text-xs font-medium text-slate-700">
              วันที่รับเข้า (YYYY-MM-DD)
              <Input
                type="date"
                value={defaults.received_date || ''}
                onChange={e => {
                  setPreview(null)
                  setDefaults(d => ({ ...d, received_date: e.target.value }))
                }}
                className="mt-1 text-xs"
              />
            </label>
            <label className="text-xs font-medium text-slate-700">
              สถานะปลายทางเมื่อรับเข้า (Model B)
              <select
                value={defaults.dispatch_mode || 'in_warehouse'}
                onChange={e => {
                  setPreview(null)
                  setDefaults(d => ({ ...d, dispatch_mode: e.target.value as StockImportDefaultsPayload['dispatch_mode'] }))
                }}
                className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-xs text-slate-800"
              >
                <option value="in_warehouse">รับเข้าคลังกลาง SYM (in_warehouse)</option>
                <option value="dispatched">รับเข้าพร้อมเบิกกระจายทันที (dispatched)</option>
                <option value="auto_by_column">อ้างอิงตามคอลัมน์ พื้นที่ ในไฟล์</option>
              </select>
            </label>
            {(defaults.dispatch_mode === 'dispatched' || defaults.dispatch_mode === 'auto_by_column') && (
              <label className="text-xs font-medium text-slate-700">
                พื้นที่/ทีมปลายทาง (ค่าเริ่มต้น)
                <Input
                  list="stock-area-suggestions"
                  value={defaults.dispatch_area || ''}
                  onChange={e => {
                    setPreview(null)
                    setDefaults(d => ({ ...d, dispatch_area: e.target.value }))
                  }}
                  placeholder="เช่น ภาคเหนือ / ทีม BKK-1"
                  className="mt-1 text-xs"
                />
              </label>
            )}
            <label className="text-xs font-medium text-slate-700 sm:col-span-2 lg:col-span-3">
              หมายเหตุใบรับเข้า
              <Input
                value={defaults.note || ''}
                onChange={e => {
                  setPreview(null)
                  setDefaults(d => ({ ...d, note: e.target.value }))
                }}
                placeholder="เช่น รับมอบ Lot แรกจาก Supplier"
                className="mt-1 text-xs"
              />
            </label>
          </div>
          <datalist id="stock-area-suggestions">
            {knownAreas.map(a => <option key={a} value={a} />)}
          </datalist>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {commitResult && (
          <Alert variant="success">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-700" />
            <div>
              <AlertTitle className="text-xs font-bold">{commitResult.message}</AlertTitle>
              <AlertDescription>
                เลขที่ใบรับเข้า: <span className="font-mono font-bold">{commitResult.doc_code}</span>
                {commitResult.dispatch_doc_code && (
                  <> · เลขที่ใบเบิกกระจายอัตโนมัติ: <span className="font-mono font-bold">{commitResult.dispatch_doc_code}</span></>
                )}
              </AlertDescription>
            </div>
          </Alert>
        )}

        {preview && (
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-bold text-slate-800">ผลตรวจ Preview ({preview.summary.total.toLocaleString('th-TH')} แถว):</span>
                <Badge variant="done">รับเข้าใหม่ {preview.summary.create_new}</Badge>
                <Badge variant="progress">จับคู่ Hybrid {preview.summary.reconcile_hybrid}</Badge>
                {preview.summary.reactivate > 0 && <Badge variant="warning">เปิดใช้ซ้ำ {preview.summary.reactivate}</Badge>}
                {preview.summary.errors > 0 && <Badge variant="destructive">ผิดพลาด {preview.summary.errors}</Badge>}
              </div>
              {preview.summary.errors > 0 && (
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-700">
                  <input type="checkbox" checked={showErrorsOnly} onChange={e => setShowErrorsOnly(e.target.checked)} />
                  <span>ดูเฉพาะแถวที่มีปัญหา</span>
                </label>
              )}
            </div>

            <div className="max-h-72 space-y-2 overflow-y-auto md:hidden">
              {displayedPreviewRows.map(row => {
                const badgeVariant = !row.valid
                  ? 'destructive'
                  : row.action === 'reconcile_hybrid'
                    ? 'progress'
                    : row.action === 'reactivate'
                      ? 'warning'
                      : 'done'
                const actionLabel = row.action === 'create_new'
                  ? 'รับเข้าใหม่'
                  : row.action === 'reconcile_hybrid'
                    ? 'จับคู่ Hybrid'
                    : row.action === 'reactivate'
                      ? 'เปิดใช้ซ้ำ'
                      : 'ผิดพลาด'
                const modelMeta = [row.brand, row.model_name].filter(Boolean).join(' ') || '—'
                return (
                  <div key={`${row.source_row}-${row.serial_number}-m`} className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="mr-1.5 font-mono text-[11px] text-slate-400">#{row.source_row}</span>
                        <strong className="break-all font-mono text-slate-900">{row.serial_number || '—'}</strong>
                      </div>
                      <Badge variant={badgeVariant} className="shrink-0">{actionLabel}</Badge>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-600">
                      {modelMeta}
                      {row.lot_no ? ` · ${row.lot_no}` : ''}
                      {row.dispatch_area ? ` · ${row.dispatch_area}` : ''}
                    </div>
                    <div className="mt-1 text-[11px]">
                      {row.reason
                        ? <span className="text-red-700">{row.reason}</span>
                        : row.action === 'reconcile_hybrid'
                          ? <span className="text-sky-700">จับคู่กับ SN ที่ช่างปิดงานไปแล้ว ({row.existing_status})</span>
                          : <span className="text-emerald-700">พร้อมนำเข้าเป็น {row.target_status}</span>}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="hidden max-h-72 overflow-y-auto rounded-lg border border-slate-200 md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>แถว</TableHead>
                    <TableHead>Serial Number</TableHead>
                    <TableHead>การดำเนินการ</TableHead>
                    <TableHead>รุ่น / Lot / พื้นที่</TableHead>
                    <TableHead>รายละเอียด</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayedPreviewRows.map(row => (
                    <TableRow key={`${row.source_row}-${row.serial_number}`}>
                      <TableCell className="font-mono text-xs">{row.source_row}</TableCell>
                      <TableCell className="font-mono text-xs font-bold">{row.serial_number || '—'}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            !row.valid
                              ? 'destructive'
                              : row.action === 'reconcile_hybrid'
                                ? 'progress'
                                : row.action === 'reactivate'
                                  ? 'warning'
                                  : 'done'
                          }
                        >
                          {row.action === 'create_new'
                            ? 'รับเข้าใหม่'
                            : row.action === 'reconcile_hybrid'
                              ? 'จับคู่ Hybrid'
                              : row.action === 'reactivate'
                                ? 'เปิดใช้ซ้ำ'
                                : 'ผิดพลาด'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {[row.brand, row.model_name].filter(Boolean).join(' ') || '—'}
                        {row.lot_no ? ` · ${row.lot_no}` : ''}
                        {row.dispatch_area ? ` · ${row.dispatch_area}` : ''}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.reason
                          ? <span className="text-red-700">{row.reason}</span>
                          : row.action === 'reconcile_hybrid'
                            ? <span className="text-sky-700">จับคู่กับ SN ที่ช่างปิดงานไปแล้ว ({row.existing_status})</span>
                            : <span className="text-emerald-700">พร้อมนำเข้าเป็น {row.target_status}</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {preview.items.length > 150 && (
              <p className="text-[11px] text-slate-500">แสดงตัวอย่าง 150 แถวแรกจากทั้งหมด {preview.items.length.toLocaleString('th-TH')} แถว</p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-2">
              {preview.summary.errors > 0 ? (
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-amber-800">
                  <input type="checkbox" checked={skipInvalid} onChange={e => setSkipInvalid(e.target.checked)} />
                  <span>ข้าม {preview.summary.errors} แถวที่มีปัญหา และบันทึกเฉพาะ {preview.summary.valid} แถวที่ถูกต้อง</span>
                </label>
              ) : (
                <span className="text-xs font-semibold text-emerald-700">
                  พร้อมบันทึกเข้าสต็อกทั้ง {preview.summary.valid.toLocaleString('th-TH')} เครื่อง
                </span>
              )}
              <Button
                type="button"
                disabled={busy || preview.summary.valid === 0 || (preview.summary.errors > 0 && !skipInvalid)}
                onClick={() => void handleCommit()}
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                <span>ยืนยันนำเข้าสต็อก ({preview.summary.valid.toLocaleString('th-TH')} เครื่อง)</span>
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StockOperationsSection({
  initialMode,
  initialSerialText,
  knownAreas,
  onCompleted,
}: {
  initialMode: OpsMode
  initialSerialText: string
  knownAreas: string[]
  onCompleted: (message: string) => void
}) {
  const [mode, setMode] = useState<OpsMode>(initialMode)
  const [serialText, setSerialText] = useState(initialSerialText)
  const [dispatchArea, setDispatchArea] = useState('')
  const [note, setNote] = useState('')
  const [showScanner, setShowScanner] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [invalidSerials, setInvalidSerials] = useState<string[]>([])
  const [resultMsg, setResultMsg] = useState('')

  useEffect(() => {
    setMode(initialMode)
    setError('')
    setInvalidSerials([])
    setResultMsg('')
  }, [initialMode])

  useEffect(() => {
    if (initialSerialText) {
      setSerialText(initialSerialText)
      setError('')
      setInvalidSerials([])
      setResultMsg('')
    }
  }, [initialSerialText])

  const parsedSerials = useMemo(() => parseBatchSerialText(serialText), [serialText])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError('')
    setInvalidSerials([])
    setResultMsg('')

    if (parsedSerials.length === 0) {
      setError('กรุณากรอกหรือสแกน Serial Number อย่างน้อย 1 รายการ')
      return
    }
    if (mode === 'dispatch' && !dispatchArea.trim()) {
      setError('กรุณาระบุพื้นที่/ทีมปลายทาง')
      return
    }
    if (mode === 'doa' && !note.trim()) {
      setError('กรุณาระบุอาการเสียหรือเหตุผลที่ตั้งสถานะ DOA')
      return
    }

    setBusy(true)
    try {
      const res = mode === 'dispatch'
        ? await d1Api.dispatchStock({ serial_numbers: parsedSerials, dispatch_area: dispatchArea.trim(), note: note.trim() || undefined })
        : mode === 'recall'
          ? await d1Api.recallStock({ serial_numbers: parsedSerials, note: note.trim() || undefined })
          : await d1Api.markStockDoa({ serial_numbers: parsedSerials, note: note.trim() })
      setResultMsg(`${res.message}`)
      setSerialText('')
      setNote('')
      onCompleted(res.message)
    } catch (err: any) {
      setError(err?.message || 'ทำรายการสต็อกไม่สำเร็จ')
      setInvalidSerials(extractInvalidSerials(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>จัดการสต็อกคลังกลาง & พื้นที่ (Model B)</CardTitle>
        <CardDescription>
          เบิกกระจายเครื่องใหม่ออกพื้นที่/ทีม, ดึงเครื่องที่ยังไม่ใช้กลับคลังกลาง หรือแจ้งเครื่องใหม่เสีย (DOA) เพื่อกันช่างหยิบไปติดตั้ง
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={e => void handleSubmit(e)} className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {([
              { key: 'dispatch', label: 'เบิกกระจายพื้นที่ (DSP)', icon: Truck },
              { key: 'recall', label: 'ดึงกลับคลังกลาง (ADJ)', icon: ArrowLeftRight },
              { key: 'doa', label: 'แจ้งเครื่องใหม่เสีย (DOA)', icon: AlertTriangle },
            ] as const).map(item => {
              const Icon = item.icon
              const active = mode === item.key
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setMode(item.key)
                    setError('')
                    setInvalidSerials([])
                    setResultMsg('')
                  }}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors',
                    active
                      ? item.key === 'doa'
                        ? 'border-red-700 bg-red-700 text-white'
                        : 'border-emerald-700 bg-emerald-700 text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <Icon size={14} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>

          {mode === 'dispatch' && (
            <label className="block text-xs font-semibold text-slate-700">
              พื้นที่ / ทีมปลายทาง *
              <Input
                list="stock-ops-area-list"
                value={dispatchArea}
                onChange={e => setDispatchArea(e.target.value)}
                placeholder="เช่น ภาคเหนือ-เชียงใหม่ / ทีมช่าง BKK-A"
                maxLength={120}
                required
                className="mt-1 text-xs"
              />
              <datalist id="stock-ops-area-list">
                {knownAreas.map(a => <option key={a} value={a} />)}
              </datalist>
            </label>
          )}

          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-700">
                รายการ Serial Number * (นับได้ {parsedSerials.length.toLocaleString('th-TH')} เครื่อง)
              </span>
              <div className="flex gap-1.5">
                <Button type="button" size="sm" variant="outline" onClick={() => setShowScanner(true)}>
                  <ScanBarcode size={14} /> สแกนเพิ่มด้วยกล้อง
                </Button>
                {serialText && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setSerialText('')}>
                    ล้างรายการ
                  </Button>
                )}
              </div>
            </div>
            <Textarea
              value={serialText}
              onChange={e => setSerialText(e.target.value)}
              rows={5}
              placeholder={'วาง Serial Number จาก Excel หรือยิงบาร์โค้ดสแกนเนอร์ 1 เครื่องต่อ 1 บรรทัด\nZEBRA-9308-0001\nZEBRA-9308-0002'}
              className="font-mono text-xs"
            />
          </div>

          <label className="block text-xs font-semibold text-slate-700">
            {mode === 'doa' ? 'อาการเสีย / เหตุผลแจ้ง DOA *' : 'หมายเหตุเอกสาร'}
            <Input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={mode === 'doa' ? 'เช่น เปิดไม่ติด / เลนส์สแกนไม่ทำงาน ตั้งแต่แกะกล่อง' : 'หมายเหตุเพิ่มเติม (ถ้ามี)'}
              maxLength={500}
              required={mode === 'doa'}
              className="mt-1 text-xs"
            />
          </label>

          {error && (
            <Alert variant="destructive">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <AlertDescription>{error}</AlertDescription>
                <InvalidSerialList serials={invalidSerials} />
              </div>
            </Alert>
          )}

          {resultMsg && (
            <Alert variant="success">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-700" />
              <AlertDescription>{resultMsg}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end">
            <Button
              type="submit"
              variant={mode === 'doa' ? 'destructive' : 'default'}
              disabled={busy || parsedSerials.length === 0}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              <span>
                {mode === 'dispatch'
                  ? `ยืนยันเบิกกระจาย (${parsedSerials.length})`
                  : mode === 'recall'
                    ? `ยืนยันดึงกลับคลัง (${parsedSerials.length})`
                    : `ยืนยันแจ้งเสีย DOA (${parsedSerials.length})`}
              </span>
            </Button>
          </div>
        </form>

        <BarcodeScannerModal
          isOpen={showScanner}
          title="สแกน Serial เพิ่มเข้ารายการ"
          subtitle="สแกนบาร์โค้ดบนกล่องเครื่องสแกนเนอร์ ระบบจะเพิ่มและตัดซ้ำให้อัตโนมัติ"
          onScan={sn => {
            const { nextText, added } = appendSerialToBatchText(serialText, sn)
            setSerialText(nextText)
            setShowScanner(false)
            if (!added) setError(`Serial ${sn} อยู่ในรายการแล้ว`)
          }}
          onClose={() => setShowScanner(false)}
        />
      </CardContent>
    </Card>
  )
}

function StockReverseSection({
  initialMode,
  initialSerialText,
  reloadTick,
  onCompleted,
}: {
  initialMode: ReverseMode
  initialSerialText: string
  reloadTick: number
  onCompleted: (message: string) => void
}) {
  const [mode, setMode] = useState<ReverseMode>(initialMode)
  const [serialText, setSerialText] = useState(initialSerialText)
  const [recipientName, setRecipientName] = useState('')
  const [note, setNote] = useState('')
  const [showScanner, setShowScanner] = useState(false)
  const [queueItems, setQueueItems] = useState<StockItemRecord[]>([])
  const [queueLoading, setQueueLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [invalidSerials, setInvalidSerials] = useState<string[]>([])
  const [resultMsg, setResultMsg] = useState('')

  useEffect(() => {
    setMode(initialMode)
    setError('')
    setInvalidSerials([])
    setResultMsg('')
  }, [initialMode])

  useEffect(() => {
    if (initialSerialText) {
      setSerialText(initialSerialText)
      setError('')
      setInvalidSerials([])
      setResultMsg('')
    }
  }, [initialSerialText])

  useEffect(() => {
    let active = true
    setQueueLoading(true)
    const targetStatus = mode === 'receive' ? 'removed_onsite' : 'returned_to_warehouse'
    void (async () => {
      try {
        const res = await d1Api.getStockItems({
          unit_type: 'old_removed',
          status: targetStatus,
          limit: 50,
          offset: 0,
        })
        if (active) setQueueItems(res.rows || [])
      } catch {
        if (active) setQueueItems([])
      } finally {
        if (active) setQueueLoading(false)
      }
    })()
    return () => { active = false }
  }, [mode, reloadTick])

  const parsedSerials = useMemo(() => parseBatchSerialText(serialText), [serialText])
  const selectedSet = useMemo(() => new Set(parsedSerials), [parsedSerials])

  const toggleQueueSerial = (sn: string) => {
    if (selectedSet.has(sn)) {
      const next = parsedSerials.filter(s => s !== sn)
      setSerialText(next.join('\n'))
    } else {
      const { nextText } = appendSerialToBatchText(serialText, sn)
      setSerialText(nextText)
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError('')
    setInvalidSerials([])
    setResultMsg('')

    if (parsedSerials.length === 0) {
      setError('กรุณาเลือกหรือสแกน SN ของซากเครื่องเดิมอย่างน้อย 1 รายการ')
      return
    }
    if (mode === 'handover' && !recipientName.trim()) {
      setError('กรุณาระบุชื่อผู้รับมอบซากเครื่องฝั่งลูกค้า (AIS / G-Able)')
      return
    }

    setBusy(true)
    try {
      const res = mode === 'receive'
        ? await d1Api.receiveOldReturns({ serial_numbers: parsedSerials, note: note.trim() || undefined })
        : await d1Api.handoverOldReturns({
            serial_numbers: parsedSerials,
            recipient_name: recipientName.trim(),
            note: note.trim() || undefined,
          })
      setResultMsg(res.message)
      setSerialText('')
      setNote('')
      if (mode === 'handover') setRecipientName('')
      onCompleted(res.message)
    } catch (err: any) {
      setError(err?.message || 'บันทึก Reverse Logistics ไม่สำเร็จ')
      setInvalidSerials(extractInvalidSerials(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>จัดการซากเครื่องเดิมคืนคลัง & ส่งมอบลูกค้า (Reverse Logistics)</CardTitle>
        <CardDescription>
          ติดตามเครื่องเก่าที่ถอดจากสาขาตั้งแต่คลัง SYM รับคืนจากช่าง (RET) จนถึงส่งมอบคืน AIS / G-Able (HOV)
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setMode('receive')
              setError('')
              setInvalidSerials([])
              setResultMsg('')
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold',
              mode === 'receive'
                ? 'border-emerald-700 bg-emerald-700 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
            )}
          >
            <RotateCcw size={14} /> ขาที่ 1: คลัง SYM รับซากเข้าคลัง (RET)
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('handover')
              setError('')
              setInvalidSerials([])
              setResultMsg('')
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold',
              mode === 'handover'
                ? 'border-emerald-700 bg-emerald-700 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
            )}
          >
            <ClipboardCheck size={14} /> ขาที่ 2: ส่งมอบซากคืนลูกค้า (HOV)
          </button>
        </div>

        {/* Quick pick queue from D1 */}
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs">
            <strong className="text-slate-700">
              {mode === 'receive'
                ? `คิวซากเครื่องที่ถอดหน้างาน รอรับเข้าคลัง (${queueItems.length} รายการล่าสุด)`
                : `คิวซากเครื่องในคลัง SYM รอส่งมอบคืนลูกค้า (${queueItems.length} รายการล่าสุด)`}
            </strong>
            {queueItems.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  const allSns = queueItems.map(q => q.serial_number)
                  const combined = Array.from(new Set([...parsedSerials, ...allSns]))
                  setSerialText(combined.join('\n'))
                }}
              >
                เลือกคิวทั้งหมด
              </Button>
            )}
          </div>

          {queueLoading ? (
            <div className="flex items-center gap-1.5 py-2 text-xs text-slate-500">
              <Loader2 size={13} className="animate-spin" /> กำลังโหลดคิวซากเครื่อง…
            </div>
          ) : queueItems.length === 0 ? (
            <div className="py-2 text-xs text-slate-500">
              {mode === 'receive' ? 'ยังไม่มีซากเครื่องเดิมค้างรับเข้าคลัง' : 'ยังไม่มีซากเครื่องในคลังรอส่งมอบลูกค้า'}
            </div>
          ) : (
            <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
              {queueItems.map(item => {
                const picked = selectedSet.has(item.serial_number)
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggleQueueSerial(item.serial_number)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors',
                      picked
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100',
                    )}
                  >
                    <span className="font-mono font-bold">{item.serial_number}</span>
                    {item.branch_code && <span className="text-[11px] text-slate-500">· {item.branch_code}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <form onSubmit={e => void handleSubmit(e)} className="space-y-3">
          {mode === 'handover' && (
            <label className="block text-xs font-semibold text-slate-700">
              ชื่อผู้รับมอบซากเครื่องฝั่งลูกค้า (AIS / G-Able) *
              <Input
                value={recipientName}
                onChange={e => setRecipientName(e.target.value)}
                placeholder="เช่น คุณสมชาย ใจดี (G-Able Warehouse)"
                maxLength={160}
                required
                className="mt-1 text-xs"
              />
            </label>
          )}

          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-700">
                SN ซากเครื่องเดิมที่จะบันทึก * ({parsedSerials.length.toLocaleString('th-TH')} เครื่อง)
              </span>
              <div className="flex gap-1.5">
                <Button type="button" size="sm" variant="outline" onClick={() => setShowScanner(true)}>
                  <ScanBarcode size={14} /> สแกนซากเครื่อง
                </Button>
                {serialText && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setSerialText('')}>
                    ล้างรายการ
                  </Button>
                )}
              </div>
            </div>
            <Textarea
              value={serialText}
              onChange={e => setSerialText(e.target.value)}
              rows={4}
              placeholder="คลิกเลือกจากคิวด้านบน วาง SN ทีละบรรทัด หรือกดสแกนซากเครื่อง"
              className="font-mono text-xs"
            />
          </div>

          <label className="block text-xs font-semibold text-slate-700">
            หมายเหตุ / เลขที่ใบส่งมอบอ้างอิง
            <Input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={mode === 'receive' ? 'เช่น ช่างส่งซากกลับมาถึงคลังกลางแล้ว' : 'เช่น ส่งมอบล็อตประจำเดือนพร้อมเอกสารเซ็นรับ'}
              maxLength={500}
              className="mt-1 text-xs"
            />
          </label>

          {error && (
            <Alert variant="destructive">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <AlertDescription>{error}</AlertDescription>
                <InvalidSerialList serials={invalidSerials} />
              </div>
            </Alert>
          )}

          {resultMsg && (
            <Alert variant="success">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-700" />
              <AlertDescription>{resultMsg}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={busy || parsedSerials.length === 0}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
              <span>
                {mode === 'receive'
                  ? `ยืนยันรับซากเข้าคลัง (${parsedSerials.length})`
                  : `ยืนยันส่งมอบซากคืนลูกค้า (${parsedSerials.length})`}
              </span>
            </Button>
          </div>
        </form>

        <BarcodeScannerModal
          isOpen={showScanner}
          title="สแกน Serial ซากเครื่องเดิม"
          subtitle="สแกนบาร์โค้ดใต้เครื่องเก่าที่รับคืนมา"
          onScan={sn => {
            const { nextText, added } = appendSerialToBatchText(serialText, sn)
            setSerialText(nextText)
            setShowScanner(false)
            if (!added) setError(`Serial ${sn} อยู่ในรายการแล้ว`)
          }}
          onClose={() => setShowScanner(false)}
        />
      </CardContent>
    </Card>
  )
}

function StockDocumentsSection({ reloadTick }: { reloadTick: number }) {
  const [docType, setDocType] = useState('')
  const [search, setSearch] = useState('')
  const [docs, setDocs] = useState<StockDocumentRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailData, setDetailData] = useState<{
    document: StockDocumentRecord
    movements: Array<StockMovementRecord & {
      serial_number: string
      unit_type: 'new_unit' | 'old_removed'
      current_status: string
      brand: string | null
      model_name: string | null
      branch_code: string | null
      branch_name: string | null
    }>
  } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await d1Api.getStockDocuments({
            doc_type: docType || undefined,
            search: search.trim() || undefined,
            limit: 50,
            offset: 0,
          })
          if (!active) return
          setDocs(res.rows || [])
          setTotal(res.total || 0)
          setError('')
        } catch (err: any) {
          if (!active) return
          setError(err?.message || 'โหลดประวัติเอกสารสต็อกไม่สำเร็จ')
        } finally {
          if (active) setLoading(false)
        }
      })()
    }, 150)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [docType, search, reloadTick])

  const openDocument = async (id: string) => {
    setDetailLoading(true)
    try {
      const res = await d1Api.getStockDocumentDetail(id)
      setDetailData(res)
    } catch (err: any) {
      setError(err?.message || 'เปิดรายละเอียดเอกสารไม่สำเร็จ')
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>ประวัติเอกสารรับ-เบิก-รับซาก-ส่งมอบ (Stock Documents)</CardTitle>
        <CardDescription>ตรวจสอบเอกสารทุกใบย้อนหลัง (RCV, DSP, RET, HOV, DOA, ADJ) พร้อมรายการ Serial ภายในเอกสาร</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="ค้นหาเลขที่เอกสาร, Lot, พื้นที่, ผู้รับมอบ…"
              className="pl-8 text-xs"
            />
          </div>
          <select
            aria-label="กรองประเภทเอกสาร"
            value={docType}
            onChange={e => setDocType(e.target.value)}
            className="h-10 rounded-lg border border-slate-300 bg-white px-2.5 text-xs text-slate-800"
          >
            <option value="">ทุกประเภทเอกสาร</option>
            {Object.entries(STOCK_DOC_TYPE_META).map(([key, meta]) => (
              <option key={key} value={key}>{meta.label}</option>
            ))}
          </select>
        </div>

        <div className="text-xs text-slate-500">ทั้งหมด {total.toLocaleString('th-TH')} เอกสาร</div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-500">
            <Loader2 size={15} className="animate-spin text-emerald-700" /> กำลังโหลดประวัติเอกสาร…
          </div>
        ) : docs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-xs text-slate-500">
            ยังไม่มีเอกสารสต็อก
          </div>
        ) : (
          <>
            <div className="space-y-2.5 md:hidden">
              {docs.map(doc => {
                const meta = STOCK_DOC_TYPE_META[doc.doc_type] || { label: doc.doc_type, tone: 'neutral' as const }
                return (
                  <div key={`${doc.id}-m`} className="rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-2xs">
                    <div className="flex items-start justify-between gap-2">
                      <strong className="break-all font-mono text-sm text-slate-900">{doc.doc_code}</strong>
                      <Badge variant={meta.tone} className="shrink-0">{meta.label}</Badge>
                    </div>
                    <div className="mt-1.5 space-y-0.5 text-[11px] text-slate-600">
                      <div>จำนวน <strong className="font-mono text-slate-900">{doc.item_count.toLocaleString('th-TH')}</strong> เครื่อง</div>
                      {doc.lot_no && <div>Lot: {doc.lot_no}</div>}
                      {doc.destination_area && <div className="text-sky-800">พื้นที่: {doc.destination_area}</div>}
                      {doc.recipient_name && <div className="text-emerald-800">ผู้รับ: {doc.recipient_name}</div>}
                      {doc.note && <div className="text-slate-500">{doc.note}</div>}
                      <div className="text-slate-400">{doc.created_by} · {formatStockDate(doc.created_at)}</div>
                    </div>
                    <div className="mt-2.5 flex justify-end border-t border-slate-100 pt-2">
                      <Button type="button" size="sm" variant="outline" className="w-full" disabled={detailLoading} onClick={() => void openDocument(doc.id)}>
                        ดู SN ({doc.item_count})
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="hidden rounded-xl border border-slate-200 md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>เลขที่เอกสาร</TableHead>
                    <TableHead>ประเภท</TableHead>
                    <TableHead>จำนวน</TableHead>
                    <TableHead>Lot / พื้นที่ / ผู้รับมอบ</TableHead>
                    <TableHead>ผู้จัดทำ / วันเวลา</TableHead>
                    <TableHead className="text-right">รายละเอียด</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {docs.map(doc => {
                    const meta = STOCK_DOC_TYPE_META[doc.doc_type] || { label: doc.doc_type, tone: 'neutral' as const }
                    return (
                      <TableRow key={doc.id}>
                        <TableCell className="font-mono font-bold text-slate-900">{doc.doc_code}</TableCell>
                        <TableCell><Badge variant={meta.tone}>{meta.label}</Badge></TableCell>
                        <TableCell className="font-mono font-semibold">{doc.item_count.toLocaleString('th-TH')}</TableCell>
                        <TableCell className="text-xs">
                          {doc.lot_no && <div>Lot: {doc.lot_no}</div>}
                          {doc.destination_area && <div className="text-sky-800">พื้นที่: {doc.destination_area}</div>}
                          {doc.recipient_name && <div className="text-emerald-800">ผู้รับ: {doc.recipient_name}</div>}
                          {doc.note && <div className="text-slate-500">{doc.note}</div>}
                        </TableCell>
                        <TableCell className="text-xs text-slate-500">
                          <div>{doc.created_by}</div>
                          <div>{formatStockDate(doc.created_at)}</div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button type="button" size="sm" variant="outline" disabled={detailLoading} onClick={() => void openDocument(doc.id)}>
                            ดู SN ({doc.item_count})
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>

      {detailData && createPortal(
        <StockDocumentDetailModal
          document={detailData.document}
          movements={detailData.movements}
          onClose={() => setDetailData(null)}
        />,
        document.body,
      )}
    </Card>
  )
}

function StockSerialTimelineModal({
  lookup,
  onClose,
}: {
  lookup: StockLookupResponse
  onClose: () => void
}) {
  const dialogRef = useDialogControls<HTMLElement>(onClose)

  const item = lookup.item
  const statusMeta = getStockStatusMeta(item?.status)

  return (
    <div className="detail-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <section ref={dialogRef} className="detail-dialog max-w-2xl" role="dialog" aria-modal="true" aria-labelledby="stock-timeline-title" tabIndex={-1}>
        <header className="detail-dialog-header">
          <div>
            <span className="detail-eyebrow">Stock Serial Audit Trail</span>
            <h2 id="stock-timeline-title" className="font-mono">{lookup.serial_number}</h2>
          </div>
          <button type="button" className="detail-close" aria-label="ปิดหน้าต่างประวัติ" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="space-y-4">
          <Alert variant={lookup.availability.available_for_closeout ? 'success' : 'warning'}>
            <Info size={16} className="mt-0.5 shrink-0" />
            <div>
              <AlertTitle className="text-xs font-bold">สถานะพร้อมใช้งานปัจจุบัน ({lookup.availability.code})</AlertTitle>
              <AlertDescription>{lookup.availability.message}</AlertDescription>
            </div>
          </Alert>

          {item ? (
            <div className="grid grid-cols-2 gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs sm:grid-cols-3">
              <div><span className="text-slate-500">ประเภท:</span> <strong>{item.unit_type === 'new_unit' ? 'เครื่องใหม่' : 'ซากเครื่องเดิม'}</strong></div>
              <div><span className="text-slate-500">สถานะ:</span> <Badge variant={statusMeta.tone}>{statusMeta.label}</Badge></div>
              <div><span className="text-slate-500">แหล่งที่มา:</span> <strong>{STOCK_SOURCE_MODE_LABELS[item.source_mode] || item.source_mode}</strong></div>
              <div><span className="text-slate-500">ยี่ห้อ / รุ่น:</span> <strong>{[item.brand, item.model_name].filter(Boolean).join(' ') || '—'}</strong></div>
              <div><span className="text-slate-500">Lot / PO:</span> <strong className="font-mono">{item.lot_no || '—'}</strong></div>
              <div><span className="text-slate-500">พื้นที่เบิก:</span> <strong>{item.dispatch_area || '—'}</strong></div>
              <div className="col-span-2 sm:col-span-3">
                <span className="text-slate-500">สาขาที่เชื่อม:</span>{' '}
                <strong>{item.branch_code ? `${item.branch_code} ${item.branch_name || ''}`.trim() : '—'}</strong>
                {item.old_asset_sn && <span className="ml-2 text-slate-600">(แทนเครื่องเดิม {item.old_asset_sn})</span>}
              </div>
              {item.note && (
                <div className="col-span-2 sm:col-span-3">
                  <span className="text-slate-500">หมายเหตุ:</span> {item.note}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500">
              ยังไม่พบประวัติของ Serial Number นี้ในตารางสต็อกกลาง
            </div>
          )}

          <div>
            <h3 className="mb-2 text-xs font-bold text-slate-700">ลำดับการเคลื่อนไหว (Stock Movements)</h3>
            {lookup.movements.length === 0 ? (
              <div className="text-xs text-slate-500">ยังไม่มีประวัติการเคลื่อนไหว</div>
            ) : (
              <div className="space-y-2">
                {lookup.movements.map(mv => (
                  <div key={mv.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <strong className="text-slate-900">{getStockActionLabel(mv.action)}</strong>
                      <div className="flex items-center gap-1.5">
                        {mv.doc_code && <Badge variant="outline" className="font-mono">{mv.doc_code}</Badge>}
                        <Badge variant={getStockStatusMeta(mv.to_status).tone}>{getStockStatusMeta(mv.to_status).label}</Badge>
                      </div>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      ผู้ทำรายการ: {mv.actor_email} · เมื่อ {formatStockDate(mv.created_at)}
                      {mv.branch_code && ` · สาขา ${mv.branch_code}`}
                    </div>
                    {mv.note && <div className="mt-1 text-[11.5px] text-slate-700">{mv.note}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function StockDocumentDetailModal({
  document: doc,
  movements,
  onClose,
}: {
  document: StockDocumentRecord
  movements: Array<StockMovementRecord & {
    serial_number: string
    unit_type: 'new_unit' | 'old_removed'
    current_status: string
    brand: string | null
    model_name: string | null
    branch_code: string | null
    branch_name: string | null
  }>
  onClose: () => void
}) {
  const dialogRef = useDialogControls<HTMLElement>(onClose)

  const meta = STOCK_DOC_TYPE_META[doc.doc_type] || { label: doc.doc_type, tone: 'neutral' as const }

  return (
    <div className="detail-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <section ref={dialogRef} className="detail-dialog max-w-3xl" role="dialog" aria-modal="true" aria-labelledby="stock-doc-title" tabIndex={-1}>
        <header className="detail-dialog-header">
          <div>
            <span className="detail-eyebrow">{meta.label}</span>
            <h2 id="stock-doc-title" className="font-mono">{doc.doc_code}</h2>
          </div>
          <button type="button" className="detail-close" aria-label="ปิดรายละเอียดเอกสาร" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
            <div className="space-y-0.5">
              <div>จำนวนรายการในเอกสาร: <strong>{doc.item_count.toLocaleString('th-TH')}</strong> เครื่อง</div>
              <div>ผู้จัดทำ: <strong>{doc.created_by}</strong> · เมื่อ {formatStockDate(doc.created_at)}</div>
              {doc.lot_no && <div>Lot / PO: <strong className="font-mono">{doc.lot_no}</strong></div>}
              {doc.destination_area && <div>พื้นที่/ทีมปลายทาง: <strong>{doc.destination_area}</strong></div>}
              {doc.recipient_name && <div>ผู้รับมอบ: <strong>{doc.recipient_name}</strong></div>}
              {doc.note && <div>หมายเหตุ: {doc.note}</div>}
            </div>
            {movements.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => downloadStockCsv(
                  `${doc.doc_code}.csv`,
                  ['Serial Number', 'ประเภท', 'สถานะปัจจุบัน', 'ยี่ห้อ', 'รุ่น', 'เหตุการณ์', 'สาขา', 'หมายเหตุ'],
                  movements.map(m => [
                    m.serial_number,
                    m.unit_type === 'new_unit' ? 'เครื่องใหม่' : 'ซากเครื่องเดิม',
                    getStockStatusMeta(m.current_status).label,
                    m.brand || '',
                    m.model_name || '',
                    getStockActionLabel(m.action),
                    m.branch_code ? `${m.branch_code} ${m.branch_name || ''}`.trim() : '',
                    m.note || '',
                  ]),
                )}
              >
                <FileDown size={14} /> Export รายการ SN
              </Button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto rounded-xl border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Serial Number</TableHead>
                  <TableHead>ยี่ห้อ / รุ่น</TableHead>
                  <TableHead>สถานะปัจจุบัน</TableHead>
                  <TableHead>หมายเหตุ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movements.map((mv, idx) => (
                  <TableRow key={mv.id}>
                    <TableCell className="text-xs text-slate-500">{idx + 1}</TableCell>
                    <TableCell className="font-mono text-xs font-bold">{mv.serial_number}</TableCell>
                    <TableCell className="text-xs">{[mv.brand, mv.model_name].filter(Boolean).join(' ') || '—'}</TableCell>
                    <TableCell>
                      <Badge variant={getStockStatusMeta(mv.current_status).tone}>
                        {getStockStatusMeta(mv.current_status).label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-slate-600">{mv.note || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </section>
    </div>
  )
}
