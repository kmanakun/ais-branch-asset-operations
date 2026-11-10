import { useEffect, useState } from 'react'
import { ClipboardList } from 'lucide-react'
import BranchPlanReview from './BranchPlanReview'
import { supabase } from './supabase'

type PlanSummaryData = { has_plan?: boolean; row_count?: number }

export default function BranchPlanSummary({ role, provinces, onOpenScanner }: { role?: string; provinces: string[]; onOpenScanner: (serial: string) => void }) {
  const [plan, setPlan] = useState<PlanSummaryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    if (role !== 'admin') {
      setLoading(false)
      return
    }
    let active = true
    async function loadPlan() {
      if (!supabase) {
        setError('ยังไม่ได้ตั้งค่าการเชื่อมต่อระบบ')
        setLoading(false)
        return
      }
      setLoading(true)
      setError('')
      try {
        const { data, error: rpcError } = await supabase.rpc('ais_branch_plan_summary')
        if (rpcError) throw rpcError
        if (active) setPlan(data as PlanSummaryData)
      } catch {
        if (active) setError('โหลดรายการสาขาจากข้อมูลที่นำเข้าไม่สำเร็จ โปรดลองใหม่')
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadPlan()
    return () => { active = false }
  }, [role, retryCount])

  if (role !== 'admin') return null

  return <>
    <section className="panel branch-plan-panel" aria-live="polite">
      <div className="panel-heading">
        <div><h2>ทะเบียนสาขาที่นำเข้า</h2><p>ใช้ตรวจจังหวัด สาขา และ Serial ที่มีอยู่ในทะเบียนก่อนเปิดใบงาน</p></div>
        <span className="readonly-badge">ข้อมูลอ้างอิง</span>
      </div>
      {loading ? <div className="plan-loading" role="status">กำลังตรวจสอบข้อมูลสาขา…</div>
        : error ? <div className="import-error plan-error" role="alert"><span>{error}</span><button className="secondary-button" type="button" onClick={() => setRetryCount(count => count + 1)}>ลองอีกครั้ง</button></div>
          : !plan?.has_plan ? <div className="plan-loading">ยังไม่มีข้อมูลสาขาที่นำเข้า</div>
            : <div className="plan-summary-grid"><div className="summary-tile"><div className="summary-icon orange"><ClipboardList size={18} /></div><div><strong>{Number(plan.row_count || 0).toLocaleString('th-TH')}</strong><span>รายการสาขาอ้างอิง</span></div></div><p className="plan-draft-note">รายการนี้ใช้ตรวจทะเบียนและเปิดทางไปดูรายละเอียด SN เท่านั้น ไม่มีการกำหนดทีม วันนัดหมาย หรือสถานะงาน</p></div>}
    </section>
    {!loading && !error && plan?.has_plan && <BranchPlanReview role={role} provinces={provinces} onOpenScanner={onOpenScanner} />}
  </>
}
