import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Info, Loader2, ShieldAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { d1Api, type StockLookupResponse } from './d1-client'
import { validateSerialFormat } from './lib/stock-serial.mjs'
import { getStockStatusMeta, STOCK_SOURCE_MODE_LABELS } from './lib/stock-ui-labels'

interface StockLookupBadgeProps {
  serial: string
  taskId?: string
  enabled: boolean
  mode: 'closeout' | 'review'
  onAvailabilityChange?: (available: boolean, reason: string, lookup: StockLookupResponse | null) => void
}

const GREEN_CODES = new Set(['IN_WAREHOUSE', 'DISPATCHED', 'ALREADY_ALLOCATED_THIS_TASK'])
const INFO_CODES = new Set(['HYBRID_UNREGISTERED', 'HYBRID_REACTIVATABLE'])

export function StockLookupBadge({
  serial,
  taskId,
  enabled,
  mode,
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
  }, [serial, taskId, enabled, mode])

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
          <span>{isGreen ? 'พร้อมตัดสต็อกใช้งาน' : 'Hybrid Mode — ปิดงานได้ทันที'}</span>
          {item?.model_name && <Badge variant="outline">{item.model_name}</Badge>}
          {item?.lot_no && <Badge variant="neutral">Lot {item.lot_no}</Badge>}
        </AlertTitle>
        <AlertDescription>{availability.message}</AlertDescription>
      </div>
    </Alert>
  )
}
