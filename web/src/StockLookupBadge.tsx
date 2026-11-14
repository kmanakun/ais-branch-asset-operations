import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, FileCheck2, Info, Loader2, ShieldAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { d1Api, type StockImportCommitResponse, type StockLookupResponse } from './d1-client'
import { validateSerialFormat } from './lib/stock-serial.mjs'
import { getStockStatusMeta, STOCK_SOURCE_MODE_LABELS } from './lib/stock-ui-labels'

interface StockLookupBadgeProps {
  serial: string
  taskId?: string
  enabled: boolean
  mode: 'closeout' | 'review'
  refreshKey?: number
  onAvailabilityChange?: (available: boolean, reason: string, lookup: StockLookupResponse | null) => void
}

const GREEN_CODES = new Set(['IN_WAREHOUSE', 'DISPATCHED', 'ALREADY_ALLOCATED_THIS_TASK'])
const INFO_CODES = new Set(['HYBRID_UNREGISTERED', 'HYBRID_REACTIVATABLE'])

export function StockLookupBadge({
  serial,
  taskId,
  enabled,
  mode,
  refreshKey = 0,
  onAvailabilityChange,
}: StockLookupBadgeProps) {
  const [loading, setLoading] = useState(false)
  const [formatError, setFormatError] = useState('')
  const [lookup, setLookup] = useState<StockLookupResponse | null>(null)
  const [apiError, setApiError] = useState('')
  const latestReqRef = useRef(0)
  const callbackRef = useRef(onAvailabilityChange)
  callbackRef.current = onAvailabilityChange

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setFormatError('')
      setLookup(null)
      setApiError('')
      return
    }

    const trimmed = serial.trim()
    if (!trimmed) {
      latestReqRef.current += 1
      setLoading(false)
      setFormatError('')
      setLookup(null)
      setApiError('')
      callbackRef.current?.(true, '', null)
      return
    }

    const clientCheck = validateSerialFormat(trimmed)
    if (!clientCheck.valid) {
      latestReqRef.current += 1
      const reason = clientCheck.reason || 'รูปแบบ Serial Number ไม่ถูกต้อง'
      setLoading(false)
      setFormatError(reason)
      setLookup(null)
      setApiError('')
      callbackRef.current?.(false, reason, null)
      return
    }

    setFormatError('')
    setApiError('')

    if (clientCheck.serial.length < 3) {
      latestReqRef.current += 1
      setLoading(false)
      setLookup(null)
      callbackRef.current?.(true, '', null)
      return
    }

    const reqId = ++latestReqRef.current
    const delayMs = mode === 'closeout' ? 300 : 100
    setLoading(true)

    const timerId = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await d1Api.lookupStockSerial(clientCheck.serial, taskId)
          if (reqId !== latestReqRef.current) return
          setLookup(result)
          setApiError('')
          callbackRef.current?.(
            result.availability.available_for_closeout,
            result.availability.available_for_closeout ? '' : result.availability.message,
            result,
          )
        } catch (err: any) {
          if (reqId !== latestReqRef.current) return
          setLookup(null)
          // Fail open on transient network glitch during lookup; authoritative server check remains on closeout submit.
          setApiError(err?.message || 'ไม่สามารถตรวจสอบสต็อกแบบเรียลไทม์ได้ชั่วคราว')
          callbackRef.current?.(true, '', null)
        } finally {
          if (reqId === latestReqRef.current) {
            setLoading(false)
          }
        }
      })()
    }, delayMs)

    return () => {
      window.clearTimeout(timerId)
    }
  }, [serial, taskId, enabled, mode, refreshKey])

  if (!enabled || !serial.trim()) return null

  if (formatError) {
    return (
      <Alert variant="destructive" className="mt-2">
        <ShieldAlert size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <AlertTitle className="text-xs font-bold">Serial Number ไม่ถูกต้อง</AlertTitle>
          <AlertDescription>{formatError}</AlertDescription>
        </div>
      </Alert>
    )
  }

  if (loading && !lookup) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
        <Loader2 size={13} className="animate-spin text-emerald-700" />
        <span>กำลังตรวจสอบสถานะสต็อก…</span>
      </div>
    )
  }

  if (apiError) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-amber-700">
        <Info size={13} className="shrink-0" />
        <span>{apiError}</span>
      </div>
    )
  }

  if (!lookup) return null

  if (mode === 'review') {
    const item = lookup.item
    const statusMeta = getStockStatusMeta(item?.status)
    const sourceLabel = item?.source_mode ? (STOCK_SOURCE_MODE_LABELS[item.source_mode] || item.source_mode) : 'ยังไม่พบในตารางสต็อก'
    return (
      <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-700">
        <span className="font-semibold text-slate-600">สถานะสต็อก:</span>
        {item ? (
          <>
            <Badge variant={statusMeta.tone}>{statusMeta.label}</Badge>
            <span className="text-slate-600">· {sourceLabel}</span>
            {item.dispatch_area && <span className="text-slate-600">· พื้นที่ {item.dispatch_area}</span>}
            {item.lot_no && <span className="font-mono text-[11px] text-slate-500">Lot {item.lot_no}</span>}
          </>
        ) : (
          <Badge variant="neutral">{sourceLabel}</Badge>
        )}
      </div>
    )
  }

  const { availability, item } = lookup
  if (!availability.available_for_closeout) {
    return (
      <Alert variant="destructive" className="mt-2">
        <ShieldAlert size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <AlertTitle className="text-xs font-bold">ไม่สามารถใช้ SN นี้ปิดงานได้ ({availability.code})</AlertTitle>
          <AlertDescription>{availability.message}</AlertDescription>
        </div>
      </Alert>
    )
  }

  const isGreen = GREEN_CODES.has(availability.code)
  const isInfo = INFO_CODES.has(availability.code)

  return (
    <Alert variant={isGreen ? 'success' : isInfo ? 'warning' : 'default'} className="mt-2">
      {isGreen ? (
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-700" />
      ) : (
        <Info size={16} className="mt-0.5 shrink-0 text-amber-700" />
      )}
      <div className="min-w-0 flex-1">
        <AlertTitle className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
          <span>{isGreen ? 'พร้อมตัดสต็อกใช้งาน' : 'ปิดงานได้ทันที (รอรับเข้าภายหลัง)'}</span>
          {item?.model_name && <Badge variant="outline">{item.model_name}</Badge>}
          {item?.lot_no && <Badge variant="neutral">Lot {item.lot_no}</Badge>}
        </AlertTitle>
        <AlertDescription>{availability.message}</AlertDescription>
      </div>
    </Alert>
  )
}

export interface HybridReconcileCardProps {
  serial: string
  defaultBrand?: string | null
  defaultModel?: string | null
  defaultLotNo?: string | null
  defaultNote?: string | null
  defaultExpanded?: boolean
  onReconciled?: (
    res: StockImportCommitResponse,
    details: { brand: string; modelName: string; lotNo: string },
  ) => void
}

export function HybridReconcileCard({
  serial,
  defaultBrand,
  defaultModel,
  defaultLotNo,
  defaultNote,
  defaultExpanded = false,
  onReconciled,
}: HybridReconcileCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [brand, setBrand] = useState(() => String(defaultBrand || '').trim())
  const [modelName, setModelName] = useState(() => String(defaultModel || '').trim())
  const [lotNo, setLotNo] = useState(() => String(defaultLotNo || '').trim())
  const [note, setNote] = useState(() => String(defaultNote || '').trim())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [doneDocCode, setDoneDocCode] = useState('')

  useEffect(() => {
    setExpanded(defaultExpanded)
    setBrand(String(defaultBrand || '').trim())
    setModelName(String(defaultModel || '').trim())
    setLotNo(String(defaultLotNo || '').trim())
    setNote(String(defaultNote || '').trim())
    setSubmitting(false)
    setError('')
    setDoneDocCode('')
  }, [serial, defaultBrand, defaultModel, defaultLotNo, defaultNote, defaultExpanded])

  if (!serial.trim()) return null

  if (doneDocCode) {
    return (
      <Alert variant="success" className="mt-2">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-700" />
        <div className="min-w-0">
          <AlertTitle className="text-xs font-bold">
            จับคู่รับเข้า Supplier สำเร็จ ({doneDocCode})
          </AlertTitle>
          <AlertDescription>
            อัปเกรด SN <span className="font-mono font-semibold">{serial.trim().toUpperCase()}</span> เข้าระบบสต็อกทางการเรียบร้อย
          </AlertDescription>
        </div>
      </Alert>
    )
  }

  const handleSubmit = async () => {
    const cleanSerial = serial.trim().toUpperCase()
    const cleanLot = lotNo.trim()
    const cleanBrand = brand.trim()
    const cleanModel = modelName.trim()
    const cleanNote = note.trim()

    if (!cleanLot) {
      setError('กรุณาระบุเลข Lot / PO Supplier สำหรับออกเอกสารรับเข้า (RCV)')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const res = await d1Api.commitStockImport({
        source_name: 'hybrid-reconcile-ui',
        rows: [
          {
            source_row: 1,
            serial_number: cleanSerial,
            brand: cleanBrand || undefined,
            model_name: cleanModel || undefined,
            lot_no: cleanLot,
            note: cleanNote || 'จับคู่รับเข้าจาก Supplier สำหรับรายการปิดงานล่วงหน้า',
          },
        ],
        defaults: {
          dispatch_mode: 'in_warehouse',
          brand: cleanBrand || undefined,
          model_name: cleanModel || undefined,
          lot_no: cleanLot,
        },
      })
      setDoneDocCode(res.doc_code || 'RCV')
      setExpanded(false)
      onReconciled?.(res, {
        brand: cleanBrand,
        modelName: cleanModel,
        lotNo: cleanLot,
      })
    } catch (err: any) {
      setError(err?.message || 'ไม่สามารถจับคู่รับเข้า Supplier ได้')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2">
          <FileCheck2 size={15} className="shrink-0 text-amber-700" />
          <div className="min-w-0">
            <strong className="block text-xs font-bold text-amber-950">
              รอจับคู่ใบรับเข้า Supplier (RCV)
            </strong>
            <span className="text-[11.5px] text-amber-800">
              บันทึกเลข Lot / PO ยี่ห้อและรุ่น เพื่ออัปเกรดเข้าเอกสารสต็อกทางการโดยไม่เปลี่ยนสถานะงาน
            </span>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 border-amber-300 bg-white px-2.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
          onClick={() => {
            setExpanded(prev => !prev)
            setError('')
          }}
        >
          {expanded ? 'ซ่อนฟอร์มจับคู่' : 'จับคู่รับเข้า Supplier'}
        </Button>
      </div>

      {expanded && (
        <div className="mt-3 grid gap-2.5 border-t border-amber-200/80 pt-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="grid gap-1 text-[11px] font-semibold text-slate-700">
              <span>เลข Lot / PO Supplier *</span>
              <Input
                value={lotNo}
                onChange={e => {
                  setLotNo(e.target.value)
                  setError('')
                }}
                maxLength={100}
                placeholder="เช่น LOT-2026-04-A"
                className="h-8 bg-white text-xs"
              />
            </label>
            <label className="grid gap-1 text-[11px] font-semibold text-slate-700">
              <span>ยี่ห้อ (Brand)</span>
              <Input
                value={brand}
                onChange={e => setBrand(e.target.value)}
                maxLength={100}
                placeholder="เช่น Honeywell / Zebra"
                className="h-8 bg-white text-xs"
              />
            </label>
            <label className="grid gap-1 text-[11px] font-semibold text-slate-700">
              <span>รุ่น (Model)</span>
              <Input
                value={modelName}
                onChange={e => setModelName(e.target.value)}
                maxLength={120}
                placeholder="เช่น Xenon 1950g"
                className="h-8 bg-white text-xs"
              />
            </label>
          </div>

          <label className="grid gap-1 text-[11px] font-semibold text-slate-700">
            <span>หมายเหตุ RCV (ไม่บังคับ)</span>
            <Input
              value={note}
              onChange={e => setNote(e.target.value)}
              maxLength={500}
              placeholder="อ้างอิงใบส่งของ Supplier หรือหมายเหตุการตรวจรับ"
              className="h-8 bg-white text-xs"
            />
          </label>

          {error && (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11.5px] font-medium text-rose-700" role="alert">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2.5 text-xs"
              disabled={submitting}
              onClick={() => setExpanded(false)}
            >
              ยกเลิก
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 px-3 text-xs"
              disabled={submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  กำลังจับคู่เอกสาร RCV…
                </>
              ) : (
                <>
                  <FileCheck2 size={13} />
                  ยืนยันจับคู่ RCV
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
