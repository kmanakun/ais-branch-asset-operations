import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  ClipboardList,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FileDown,
  HardDrive,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  MapPin,
  Menu,
  Printer,
  Search,
  ShieldCheck,
  Users,
  Wrench,
  X,
} from 'lucide-react'
import { demoAssets, demoTasks, type MenuKey } from './data'
import type { RegisterImportRow } from './xlsx-register.mjs'
import TaskEvidencePanel, { requiredEvidenceSlotsForOutcome, type EvidenceSlot, SignaturePad, type SignaturePadHandle } from './TaskEvidencePanel'
import { groupRowsByBranch, groupRowsByProvince, ProvinceCardGroup } from './province'
import { ScannerDiscoveryDialog, ScannerDiscoveryQueue, type BranchReference } from './ScannerDiscovery'
import { getTopmostActiveDialog, isTopmostActiveDialog, lockBodyScroll, registerActiveDialog } from './dialog'
import { d1Api, getDevEmail, setDevEmail } from './d1-client'

type UserContext = {
  role: string
  display_name?: string
  teams?: string[]
}

type DashboardData = {
  totals?: { branches?: number; scanners?: number; active_tasks?: number; completed_tasks?: number }
  campaigns?: Array<Record<string, unknown>>
  tasks?: Array<Record<string, unknown>>
  weekly_activity?: Array<{ date: string; opened: number; completed: number }>
  province_summary?: { totals?: Record<string, number>; provinces?: Array<Record<string, unknown>> }
}

const navigation: Array<{ key: MenuKey; label: string; icon: typeof LayoutDashboard }> = [
  { key: 'overview', label: 'ภาพรวม', icon: LayoutDashboard },
  { key: 'assets', label: 'ทะเบียนอุปกรณ์', icon: HardDrive },
  { key: 'work_orders', label: 'ใบงาน', icon: ClipboardList },
  { key: 'pending', label: 'รอตรวจรับ', icon: ShieldCheck },
  { key: 'completed', label: 'เสร็จแล้ว', icon: CheckCircle2 },
  { key: 'discovery', label: 'เครื่องนอกทะเบียน', icon: Search },
  { key: 'imports', label: 'นำเข้าข้อมูล', icon: FileSpreadsheet },
  { key: 'people', label: 'สิทธิ์ผู้ใช้งาน', icon: Users },
]

const pageCopy: Record<MenuKey, { title: string; subtitle: string }> = {
  overview: { title: 'ภาพรวมการปฏิบัติงาน', subtitle: 'สถานะสาขา อุปกรณ์ และใบงานเปลี่ยน Scanner' },
  work_orders: { title: 'ใบงานเปลี่ยน Scanner', subtitle: 'เปิดดูงานทุกใบและรายละเอียด Scanner ที่ต้องดำเนินการ' },
  assets: { title: 'ทะเบียนอุปกรณ์', subtitle: 'ดูข้อมูลสาขาและเครื่องสแกนที่ผูกกับแต่ละ LocationCode' },
  pending: { title: 'รายการ Pending รอตรวจ', subtitle: 'ตรวจผลหน้างาน รูปภาพ และลายเซ็นที่ช่างส่งมา' },
  completed: { title: 'ใบงานที่เสร็จแล้ว', subtitle: 'ดูงานที่ส่งมอบหรือปิดผลแล้ว พร้อมเปิดหลักฐานและประวัติย้อนหลัง' },
  discovery: { title: 'เครื่องนอกทะเบียน', subtitle: 'ตรวจรายการที่ช่างพบเพิ่ม โดยไม่ปะปนกับทะเบียนอุปกรณ์หลัก' },
  imports: { title: 'นำเข้าข้อมูล', subtitle: 'ตรวจสอบไฟล์ทะเบียนก่อนบันทึกเป็นชุดข้อมูลเดียว' },
  people: { title: 'สิทธิ์ผู้ใช้งาน', subtitle: 'Admin Office ดูแลงานปฏิบัติการ ส่วนสิทธิ์ผู้ใช้และการตั้งค่าระบบเป็นคนละขอบเขต' },
}

const ACTIVE_MENU_STORAGE_KEY = 'ais-branch-asset-operations:active-menu'
const PAGE_SCROLL_STORAGE_KEY = 'ais-branch-asset-operations:page-scroll-y'
const SESSION_OWNER_STORAGE_KEY = 'ais-branch-asset-operations:session-user-id'
const menuKeys = new Set<MenuKey>(navigation.map(item => item.key))

function getInitialMenu(): MenuKey {
  try {
    const storedMenu = window.sessionStorage.getItem(ACTIVE_MENU_STORAGE_KEY)
    return storedMenu && menuKeys.has(storedMenu as MenuKey) ? storedMenu as MenuKey : 'overview'
  } catch {
    return 'overview'
  }
}

function getFriendlyRole(role?: string) {
  const labels: Record<string, string> = {
    admin: 'Admin ประจำ Office',
    field_technician: 'ช่าง Onsite',
    viewer: 'ตัวอย่างระบบ',
  }
  return role ? labels[role] || role : 'ตัวอย่างระบบ'
}

function getPercent(part: unknown, total: unknown) {
  const value = Number(part)
  const denominator = Number(total)
  if (!Number.isFinite(value) || !Number.isFinite(denominator) || denominator <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(value / denominator * 100)))
}

const statusPresentation: Record<string, { label: string; tone: string }> = {
  draft: { label: 'ฉบับร่าง', tone: 'neutral' },
  selection: { label: 'เลือกอุปกรณ์', tone: 'ready' },
  ready_to_schedule: { label: 'พร้อมเปิดใบงาน', tone: 'ready' },
  open: { label: 'กำลังดำเนินการ', tone: 'progress' },
  scheduled: { label: 'กำลังดำเนินการ', tone: 'progress' },
  awaiting_confirmation: { label: 'กำลังดำเนินการ', tone: 'progress' },
  confirmed: { label: 'กำลังดำเนินการ', tone: 'progress' },
  in_progress: { label: 'กำลังดำเนินการ', tone: 'progress' },
  awaiting_admin_acceptance: { label: 'Pending · งานเดิมรอ Admin', tone: 'blocked' },
  awaiting_admin_exception_review: { label: 'Pending · รอ Admin ตรวจ', tone: 'blocked' },
  replaced: { label: 'เปลี่ยนเครื่องสำเร็จ', tone: 'done' },
  no_damage_found: { label: 'ไม่พบเครื่องชำรุด', tone: 'neutral' },
  different_device_found: { label: 'ไม่พบ SN ตามใบงาน · พบเครื่องอื่น', tone: 'blocked' },
  target_device_not_found: { label: 'ไม่พบ SN ตามใบงาน · ไม่พบเครื่องอื่น', tone: 'blocked' },
  blocked: { label: 'Pending', tone: 'blocked' },
  completed: { label: 'Completed', tone: 'done' },
  delivered: { label: 'Completed', tone: 'done' },
  exception_resolved: { label: 'ตรวจแล้ว · ยังต้องเปลี่ยน', tone: 'ready' },
  legacy_completed: { label: 'เสร็จแล้ว (ประวัติเดิม)', tone: 'neutral' },
  cancelled: { label: 'ยกเลิก', tone: 'neutral' },
}

function getStatusPresentation(value: unknown) {
  const status = String(value || '').trim()
  return statusPresentation[status.toLowerCase()] || { label: status || 'ไม่ระบุสถานะ', tone: 'neutral' }
}

function oldScannerStatusLabel(value: unknown) {
  const labels: Record<string, string> = {
    returned_usable: 'ส่งคืนในสภาพใช้งานได้',
    returned_damaged: 'ส่งคืนในสภาพชำรุด',
    sent_for_repair: 'ส่งซ่อม',
    not_returned: 'ยังไม่ส่งคืน',
    lost: 'สูญหาย',
    other: 'อื่น ๆ',
  }
  return labels[String(value || '')] || value || 'ยังไม่มีข้อมูล'
}

function getTaskWorkflowStage(row: Record<string, unknown>) {
  const value = String(row.workflow_stage || row.task_status || row.status || 'open').trim().toLowerCase()
  const demoStages: Record<string, string> = {
    open: 'in_progress',
    'เปิดแล้ว · รอเริ่มงาน': 'in_progress',
    'นัดหมายแล้ว': 'in_progress',
    scheduled: 'in_progress',
    confirmed: 'in_progress',
    awaiting_confirmation: 'in_progress',
    'กำลังติดตั้ง': 'in_progress',
    'ติดปัญหา': 'pending',
    pending: 'pending',
    'เสร็จสิ้น': 'delivered',
  }
  return demoStages[value] || value
}

function formatDate(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw)
  if (Number.isNaN(date.getTime())) return ''
  const options: Intl.DateTimeFormatOptions = raw.includes('T')
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }
  return new Intl.DateTimeFormat('th-TH', options).format(date)
}

function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: string }) {
  return <span className={'status-pill ' + tone}><span className="status-dot" />{label}</span>
}

function DevAuthBar({ currentEmail, onSwitch }: { currentEmail: string; onSwitch: (email: string) => void }) {
  return (
    <div className="dev-auth-bar" role="toolbar" aria-label="Dev Mode Switcher">
      <span className="dev-auth-title">⚡ Cloudflare D1 Native:</span>
      <button type="button" className={`dev-auth-pill ${currentEmail === 'admin@sym.co.th' ? 'active' : ''}`} onClick={() => onSwitch('admin@sym.co.th')}>
        SYM Admin
      </button>
      <button type="button" className={`dev-auth-pill ${currentEmail === 'tech1@sym.co.th' ? 'active' : ''}`} onClick={() => onSwitch('tech1@sym.co.th')}>
        ช่างเทคนิค 1
      </button>
      <button type="button" className={`dev-auth-pill ${currentEmail === 'tech2@sym.co.th' ? 'active' : ''}`} onClick={() => onSwitch('tech2@sym.co.th')}>
        ช่างเทคนิค 2
      </button>
      <button type="button" className={`dev-auth-pill ${currentEmail === 'reviewer@gable.co.th' ? 'active' : ''}`} onClick={() => onSwitch('reviewer@gable.co.th')}>
        Gable Reviewer
      </button>
      <button type="button" className={`dev-auth-pill ${currentEmail === 'viewer@ais.co.th' ? 'active' : ''}`} onClick={() => onSwitch('viewer@ais.co.th')}>
        AIS Viewer
      </button>
    </div>
  )
}

function App() {
  const [devEmail, setDevEmailState] = useState(getDevEmail)
  const handleDevSwitch = (email: string) => {
    setDevEmail(email)
    setDevEmailState(email)
    window.location.reload()
  }
  const [session, setSession] = useState<{ user: { id: string; email?: string } } | null>(null)
  const sessionRef = useRef(session)
  sessionRef.current = session
  const reauthRequiredRef = useRef(false)
  const [reauthRequired, setReauthRequired] = useState(false)
  reauthRequiredRef.current = reauthRequired
  const [userContext, setUserContext] = useState<UserContext | null>(null)
  const [contextStatus, setContextStatus] = useState<'idle' | 'loading' | 'ready' | 'denied' | 'error'>('idle')
  const [contextError, setContextError] = useState('')
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [dashboardError, setDashboardError] = useState('')
  const [activeMenu, setActiveMenu] = useState<MenuKey>(getInitialMenu)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [provinceOptions, setProvinceOptions] = useState<string[]>([])
  const [activeProvince, setActiveProvince] = useState('')
  const [listError, setListError] = useState('')
  const [listReloadKey, setListReloadKey] = useState(0)
  const [loadedAssetSearch, setLoadedAssetSearch] = useState('')
  const [isSigningIn] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const [demoMode, setDemoMode] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const [pageLoading, setPageLoading] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [listData, setListData] = useState<unknown[]>([])
  const [assetPage, setAssetPage] = useState(0)
  const assetPageOffsets = useRef<number[]>([0])
  const [assetTotal, setAssetTotal] = useState(0)
  const [assetProvinceTotal, setAssetProvinceTotal] = useState(0)
  const [assetStatusFilter, setAssetStatusFilter] = useState('all')
  const [pendingAssetSerial, setPendingAssetSerial] = useState('')
  const authRequestId = useRef(0)
  const contextOwnerUserId = useRef<string | null>(null)
  const pageScrollRestored = useRef(false)
  const pageScrollReadyToSave = useRef(false)
  const mobileMenuRef = useRef<HTMLElement>(null)
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const workspaceMenuRef = useRef<HTMLDivElement>(null)
  const accountMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      window.sessionStorage.setItem(ACTIVE_MENU_STORAGE_KEY, activeMenu)
    } catch {
      // Keep in-memory navigation working when browser storage is unavailable.
    }
  }, [activeMenu])

  useEffect(() => {
    const saveScrollPosition = () => {
      if (!contextOwnerUserId.current || !pageScrollReadyToSave.current) return
      try {
        window.sessionStorage.setItem(PAGE_SCROLL_STORAGE_KEY, String(window.scrollY))
      } catch {
        // Page position restoration is best-effort when browser storage is unavailable.
      }
    }
    window.addEventListener('scroll', saveScrollPosition, { passive: true })
    window.addEventListener('pagehide', saveScrollPosition)
    return () => {
      saveScrollPosition()
      window.removeEventListener('scroll', saveScrollPosition)
      window.removeEventListener('pagehide', saveScrollPosition)
    }
  }, [])

  useEffect(() => {
    if (pageScrollRestored.current || !authChecked || demoMode || !session || !userContext || contextStatus !== 'ready') return
    let savedPosition = 0
    try {
      savedPosition = Number(window.sessionStorage.getItem(PAGE_SCROLL_STORAGE_KEY) || 0)
    } catch {
      pageScrollRestored.current = true
      pageScrollReadyToSave.current = true
      return
    }
    if (!Number.isFinite(savedPosition) || savedPosition <= 0) {
      pageScrollRestored.current = true
      pageScrollReadyToSave.current = true
      return
    }
    let attempts = 0
    let timer: number | null = null
    let cancelled = false
    let restored = false
    let userInteracted = false
    let resizeObserver: ResizeObserver | null = null
    const clearRestoreTimer = () => {
      if (timer === null) return
      window.clearTimeout(timer)
      timer = null
    }
    const finishRestore = () => {
      restored = true
      cancelled = true
      clearRestoreTimer()
      resizeObserver?.disconnect()
      pageScrollRestored.current = true
      pageScrollReadyToSave.current = true
      try {
        window.sessionStorage.setItem(PAGE_SCROLL_STORAGE_KEY, String(window.scrollY))
      } catch {
        // Page position restoration is best-effort when browser storage is unavailable.
      }
    }
    const stopRestore = (allowSavingCurrentPosition: boolean) => {
      cancelled = true
      clearRestoreTimer()
      resizeObserver?.disconnect()
      if (allowSavingCurrentPosition) {
        userInteracted = true
        pageScrollRestored.current = true
        pageScrollReadyToSave.current = true
      }
    }
    const scheduleRestore = (delay = 0) => {
      if (cancelled || timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        if (cancelled) return
        const maximumScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
        if (maximumScroll >= savedPosition) {
          window.scrollTo({ top: savedPosition, behavior: 'instant' })
          finishRestore()
          return
        }
        // Keep the stored target intact while the page is still rendering. A
        // later layout change or viewport resize can retry after this bounded
        // polling window without keeping a timer alive indefinitely.
        if (attempts < 40) {
          attempts += 1
          scheduleRestore(100)
        }
      }, delay)
    }
    const retryAfterLayoutChange = () => {
      attempts = 0
      scheduleRestore()
    }
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(retryAfterLayoutChange)
      resizeObserver.observe(document.documentElement)
      if (document.body) resizeObserver.observe(document.body)
    }
    window.addEventListener('resize', retryAfterLayoutChange, { passive: true })
    const stopRestoreForInteraction = () => {
      stopRestore(true)
    }
    window.addEventListener('pointerdown', stopRestoreForInteraction, { once: true })
    window.addEventListener('wheel', stopRestoreForInteraction, { once: true, passive: true })
    window.addEventListener('keydown', stopRestoreForInteraction, { once: true })
    scheduleRestore()
    return () => {
      stopRestore(false)
      // If auth/context changed while a restore was pending, let the next
      // ready session continue from the same saved target.
      pageScrollRestored.current = restored || userInteracted
      window.removeEventListener('resize', retryAfterLayoutChange)
      window.removeEventListener('pointerdown', stopRestoreForInteraction)
      window.removeEventListener('wheel', stopRestoreForInteraction)
      window.removeEventListener('keydown', stopRestoreForInteraction)
    }
  }, [authChecked, contextStatus, demoMode, session?.user.id, userContext?.role])

  useEffect(() => {
    const callbackUrl = new URL(window.location.href)
    const hashParams = new URLSearchParams(callbackUrl.hash.replace(/^#/, ''))
    const oauthError = callbackUrl.searchParams.get('error') || hashParams.get('error')
    const errorCode = callbackUrl.searchParams.get('error_code') || hashParams.get('error_code')
    const errorDescription = callbackUrl.searchParams.get('error_description') || hashParams.get('error_description')
    if (!oauthError && !errorCode && !errorDescription) return

    setLoginError('Google Sign-In ไม่สำเร็จ บัญชีอาจยังไม่ได้รับอนุญาต หรือการตั้งค่า OAuth ยังไม่ครบ โปรดติดต่อ Identity Admin')
    callbackUrl.searchParams.delete('error')
    callbackUrl.searchParams.delete('error_code')
    callbackUrl.searchParams.delete('error_description')
    if (['error', 'error_code', 'error_description'].some(key => hashParams.has(key))) {
      hashParams.delete('error')
      hashParams.delete('error_code')
      hashParams.delete('error_description')
      callbackUrl.hash = hashParams.size ? hashParams.toString() : ''
    }
    window.history.replaceState({}, document.title, `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`)
  }, [])

  useEffect(() => {
    let alive = true
    const loadSession = async () => {
      try {
        const me = await d1Api.getMe()
        if (alive && me?.email) {
          const d1Session = { user: { id: me.email, email: me.email } }
          sessionRef.current = d1Session
          setSession(d1Session)
          await loadContext(me.email)
        }
      } catch {
        if (alive) setLoginError('ตรวจสอบสถานะการเข้าสู่ระบบไม่ได้ โปรดลองอีกครั้ง')
      } finally {
        if (alive) setAuthChecked(true)
      }
    }
    void loadSession()
    return () => { alive = false }
  }, [])

  async function loadContext(_contextForUserId?: string | null) {
    const requestId = ++authRequestId.current
    setContextStatus('loading')
    setContextError('')
    setDashboardError('')
    try {
      const me = await d1Api.getMe()
      if (requestId !== authRequestId.current) return
      setUserContext({
        role: me.role,
        display_name: me.full_name,
        teams: []
      })
      contextOwnerUserId.current = me.email
      reauthRequiredRef.current = false
      setReauthRequired(false)

      try {
        const d1Dash = await d1Api.getDashboard()
        if (requestId !== authRequestId.current) return
        const dashboardMapped: DashboardData = {
          totals: {
            branches: d1Dash.summary.total_branches,
            scanners: d1Dash.summary.total_scanners,
            active_tasks: d1Dash.summary.on_process,
            completed_tasks: d1Dash.summary.delivered
          },
          province_summary: {
            totals: {
              total_scanners: d1Dash.summary.total_scanners,
              open: d1Dash.summary.open,
              on_process: d1Dash.summary.on_process,
              delivered: d1Dash.summary.delivered,
            },
            provinces: d1Dash.provinces.map(p => ({
              province: p.province,
              total_scanners: p.scanner_count,
              open: p.scanner_count - p.delivered_count - p.awaiting_customer_count,
              on_process: p.awaiting_customer_count,
              delivered: p.delivered_count,
              progress_percent: p.scanner_count > 0 ? Math.round((p.delivered_count / p.scanner_count) * 100) : 0
            }))
          }
        }
        setDashboard(dashboardMapped)
        setProvinceOptions(d1Dash.provinces.map(p => p.province))
      } catch {
        if (requestId !== authRequestId.current) return
        setDashboard(null)
        setDashboardError('โหลดข้อมูลภาพรวมไม่สำเร็จ โปรดลองใหม่ภายหลัง')
      }
      setContextStatus('ready')
    } catch (err: any) {
      if (requestId !== authRequestId.current) return
      setContextError(err?.message || 'เชื่อมต่อกับระบบไม่สำเร็จ')
      setContextStatus('error')
    }
  }

  useEffect(() => {
    if (!session || !userContext || activeMenu !== 'assets') return
    let active = true
    const loadList = async () => {
      setPageLoading(true)
      setListError('')
      try {
        const result = await d1Api.getScanners({
          search: search || undefined,
          province: activeProvince || undefined,
          status: assetStatusFilter !== 'all' ? assetStatusFilter : undefined,
          limit: 50,
          offset: assetPageOffsets.current[assetPage] ?? (assetPage === 0 ? 0 : assetPage * 50),
        })
        if (active) {
          setListData(result.rows)
          setAssetTotal(result.total)
          setAssetProvinceTotal(new Set(result.rows.map(r => r.province)).size)
          setLoadedAssetSearch(search)
          const currentOffset = assetPageOffsets.current[assetPage] ?? (assetPage === 0 ? 0 : assetPage * 50)
          const nextOffset = currentOffset + result.rows.length
          assetPageOffsets.current = assetPageOffsets.current.slice(0, assetPage + 1)
          if (nextOffset > currentOffset && nextOffset < result.total) {
            assetPageOffsets.current[assetPage + 1] = nextOffset
          }
        }
      } catch {
        if (active) {
          setListError('โหลดข้อมูล Scanner จาก Cloudflare D1 ไม่สำเร็จ')
        }
      } finally {
        if (active) setPageLoading(false)
      }
    }
    void loadList()
    return () => { active = false }
  }, [activeMenu, search, activeProvince, assetStatusFilter, session?.user.id, userContext?.role, listReloadKey, assetPage])

  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(''), 3500)
    return () => window.clearTimeout(id)
  }, [notice])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!workspaceMenuRef.current?.contains(target)) setWorkspaceMenuOpen(false)
      if (!accountMenuRef.current?.contains(target)) setAccountMenuOpen(false)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (document.querySelector('.app-shell[inert]')) return
      if (event.key === 'Escape') {
        setWorkspaceMenuOpen(false)
        setAccountMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [])

  useEffect(() => {
    // The app may be restored after the browser suspends or discards its tab.
    // Do not send a restored page to Overview while the signed-in role is still loading.
    if (!demoMode && (contextStatus !== 'ready' || !userContext)) return
    if (['pending', 'discovery'].includes(activeMenu)) {
      if (!demoMode && userContext?.role === 'admin') return
      setActiveMenu('overview')
      setMobileMenuOpen(false)
      return
    }
    if (demoMode || userContext?.role === 'admin' || !['imports', 'people'].includes(activeMenu)) return
    setActiveMenu('overview')
    setMobileMenuOpen(false)
  }, [activeMenu, contextStatus, demoMode, userContext?.role])

  useEffect(() => {
    if (!mobileMenuOpen) return
    const menu = mobileMenuRef.current
    const getFocusableItems = () => menu?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    getFocusableItems()?.[0]?.focus()

    const handleMenuKeys = (event: KeyboardEvent) => {
      if (menu?.closest('[inert]')) return
      if (event.key === 'Escape') {
        setMobileMenuOpen(false)
        return
      }
      if (event.key !== 'Tab') return

      const items = getFocusableItems()
      if (!items?.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !menu?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !menu?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleMenuKeys)
    return () => {
      window.removeEventListener('keydown', handleMenuKeys)
      if (!menu?.closest('[inert]')) mobileMenuTriggerRef.current?.focus()
    }
  }, [mobileMenuOpen])

  useEffect(() => {
    if (!mobileMenuOpen || !window.matchMedia('(max-width: 640px)').matches) return
    return lockBodyScroll()
  }, [mobileMenuOpen])

  useEffect(() => {
    const desktopViewport = window.matchMedia('(min-width: 641px)')
    const closeMobileMenuOnDesktop = () => {
      if (desktopViewport.matches) setMobileMenuOpen(false)
    }
    desktopViewport.addEventListener('change', closeMobileMenuOnDesktop)
    return () => desktopViewport.removeEventListener('change', closeMobileMenuOnDesktop)
  }, [])

  async function signInWithGoogle() {
    setLoginError('ระบบปัจจุบันทำงานบน Cloudflare Edge Native กรุณาเลือกสิทธิ์ผู้ใช้งานจากแถบด้านบน (Dev Auth Bar) เพื่อทดสอบตามบทบาท')
  }

  async function signOut() {
    setSignOutError('')
    authRequestId.current += 1
    sessionRef.current = null
    setSession(null)
    reauthRequiredRef.current = false
    setReauthRequired(false)
    clearUserScopedState(true)
    setContextStatus('idle')
    setContextError('')
    setSignOutError('')
    setMobileMenuOpen(false)
    setWorkspaceMenuOpen(false)
    setAccountMenuOpen(false)
    setDemoMode(false)
    setNotice('ออกจากระบบเรียบร้อยแล้ว')
  }

  function clearUserScopedState(clearPersistedNavigation = false) {
    contextOwnerUserId.current = null
    pageScrollRestored.current = false
    pageScrollReadyToSave.current = false
    if (clearPersistedNavigation) {
      try {
        window.sessionStorage.removeItem(PAGE_SCROLL_STORAGE_KEY)
        window.sessionStorage.removeItem(ACTIVE_MENU_STORAGE_KEY)
        window.sessionStorage.removeItem(SESSION_OWNER_STORAGE_KEY)
      } catch {
        // Best-effort cleanup when browser storage is unavailable.
      }
    }
    setUserContext(null)
    setContextError('')
    setDashboard(null)
    setDashboardError('')
    setProvinceOptions([])
    setActiveProvince('')
    setSearch('')
    setListData([])
    setListError('')
    setLoadedAssetSearch('')
    setAssetTotal(0)
    setAssetProvinceTotal(0)
    setAssetStatusFilter('all')
    setPendingAssetSerial('')
    setPageLoading(false)
    setActiveMenu('overview')
    setMobileMenuOpen(false)
    setWorkspaceMenuOpen(false)
    setAccountMenuOpen(false)
    resetAssetPages()
  }

  function resetAssetPages() {
    assetPageOffsets.current = [0]
    setAssetPage(0)
  }

  function clearAssetQueryResults() {
    setListData([])
    setAssetTotal(0)
    setAssetProvinceTotal(0)
    setListError('')
    setLoadedAssetSearch('')
  }

  function navigateTo(menu: MenuKey, searchTerm = '') {
    if (menu === 'assets' && (searchTerm !== activeProvince || search !== '')) clearAssetQueryResults()
    setActiveMenu(menu)
    const province = menu === 'assets' ? searchTerm : ''
    setSearch('')
    setActiveProvince(province)
    setMobileMenuOpen(false)
    setWorkspaceMenuOpen(false)
    setAccountMenuOpen(false)
    if (menu === 'assets') resetAssetPages()
  }

  function selectProvince(province: string) {
    clearAssetQueryResults()
    setActiveMenu('assets')
    setSearch('')
    resetAssetPages()
    setMobileMenuOpen(false)
    setWorkspaceMenuOpen(false)
    setAccountMenuOpen(false)
    setActiveProvince(province)
  }

  const [handoverBranch, setHandoverBranch] = useState<any | null>(null)

  const handleExportRawData = async () => {
    try {
      setNotice('กำลังจัดเตรียมไฟล์ Raw Data...')
      const res = await d1Api.getExportRawData()
      if (!res.data || res.data.length === 0) {
        setNotice('ไม่มีข้อมูลสำหรับส่งออก')
        return
      }
      const headers = Object.keys(res.data[0])
      const csvRows = [headers.join(',')]
      for (const row of res.data) {
        const values = headers.map(header => {
          const val = row[header] === null || row[header] === undefined ? '' : String(row[header])
          return `"${val.replace(/"/g, '""')}"`
        })
        csvRows.push(values.join(','))
      }
      const csvString = '\uFEFF' + csvRows.join('\r\n')
      const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.setAttribute('href', url)
      link.setAttribute('download', `AIS_Scanner_Replacement_RawData_${new Date().toISOString().slice(0, 10)}.csv`)
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      setNotice('ส่งออก Raw Data เรียบร้อยแล้ว')
    } catch (err: any) {
      setNotice('ส่งออกข้อมูลไม่สำเร็จ: ' + err.message)
    }
  }

  if (!authChecked) return <div className="loading-screen"><div className="spinner" /><span>กำลังตรวจสอบสถานะการเข้าสู่ระบบ</span></div>
  if (!session && !reauthRequired && !demoMode) {
    return (
      <>
        <DevAuthBar currentEmail={devEmail} onSwitch={handleDevSwitch} />
        <LoginPage onGoogleSignIn={() => void signInWithGoogle()} onDemo={() => setDemoMode(true)} onHelp={() => setLoginError('ใช้บัญชี Google ที่อยู่ในรายชื่อผู้มีสิทธิ์ หากยังเข้าไม่ได้โปรดติดต่อ Identity Admin')} error={loginError} configured={true} submitting={isSigningIn} />
      </>
    )
  }
  const hasContextForCurrentUser = Boolean(session?.user.id && userContext && contextOwnerUserId.current === session.user.id)
  if (session && contextStatus === 'loading' && !hasContextForCurrentUser && !demoMode) return <div className="loading-screen"><div className="spinner" /><span>กำลังตรวจสอบสิทธิ์การใช้งาน</span></div>
  if (session && contextStatus === 'error' && !hasContextForCurrentUser && !demoMode) {
    return <NoAccess email={contextError} error={signOutError} onSignOut={signOut} onRetry={() => void loadContext()} retry />
  }
  if (session && !userContext && !demoMode) {
    return <NoAccess email={session.user.email || ''} error={signOutError} onSignOut={signOut} />
  }

  const role = demoMode ? 'viewer' : userContext?.role
  const canUseAdminModules = demoMode || role === 'admin'
  const visibleNavigation = navigation.filter(item => {
    if (role === 'customer_reviewer') {
      return ['overview', 'pending', 'completed'].includes(item.key)
    }
    if (item.key === 'pending') {
      return !demoMode && (role === 'admin' || role === 'customer_reviewer')
    }
    if (item.key === 'discovery') {
      return !demoMode && role === 'admin'
    }
    return canUseAdminModules || !['imports', 'people'].includes(item.key)
  })
  const visibleProvinces = demoMode
    ? Array.from(new Set([...demoAssets, ...demoTasks].map(row => String(row.province || '').trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right, 'th'))
    : provinceOptions
  const accountName = demoMode ? 'ทาม' : userContext?.display_name || session?.user.email || 'ผู้ใช้งาน'
  const currentPage = pageCopy[activeMenu]

  return (
    <>
    <DevAuthBar currentEmail={devEmail} onSwitch={handleDevSwitch} />
    <div className="app-shell" inert={reauthRequired}>
      <aside ref={mobileMenuRef} className={'sidebar' + (mobileMenuOpen ? ' open' : '')} role={mobileMenuOpen ? 'dialog' : undefined} aria-modal={mobileMenuOpen || undefined} aria-label="เมนูหลัก">
        <div className="brand">
          <div className="brand-mark"><span>AIS</span></div>
          <div className="brand-copy"><strong>Branch & Asset</strong><small>OPERATIONS</small></div>
          <button className="icon-button mobile-nav-close" aria-label="ปิดเมนูหลัก" onClick={() => setMobileMenuOpen(false)}><X size={18} /></button>
        </div>
        <div ref={workspaceMenuRef} className="workspace-picker">
          <button type="button" className="workspace-switch" aria-haspopup="menu" aria-expanded={workspaceMenuOpen} aria-label="เลือกจังหวัดสำหรับดูทะเบียนอุปกรณ์" onClick={() => { setWorkspaceMenuOpen(open => !open); setAccountMenuOpen(false) }}>
            <div className="workspace-icon"><MapPin size={15} /></div><div><span>พื้นที่ปฏิบัติงาน</span><strong>{activeProvince || 'ทุกภูมิภาค'}</strong></div><ChevronDown size={15} />
          </button>
          {workspaceMenuOpen && <div className="workspace-menu" role="menu" aria-label="เลือกจังหวัด">
            <div className="dropdown-heading">ดูทะเบียนแยกตามจังหวัด</div>
            <button type="button" role="menuitem" className={!activeProvince ? 'selected' : ''} onClick={() => selectProvince('')}>ทุกภูมิภาค</button>
            {visibleProvinces.map(province => <button type="button" role="menuitem" key={province} className={activeProvince === province ? 'selected' : ''} onClick={() => selectProvince(province)}>{province}</button>)}
            {!visibleProvinces.length && <div className="dropdown-empty">ยังไม่มีจังหวัดที่เปิดใบงานหรือข้อมูลให้ดู</div>}
          </div>}
        </div>
        <div className="nav-label">เมนูหลัก</div>
        <nav id="primary-navigation" className="main-nav" aria-label="เมนูหลัก">
          {visibleNavigation.map(item => {
            const Icon = item.icon
            return <button key={item.key} className={'nav-item ' + (activeMenu === item.key ? 'active' : '')} aria-current={activeMenu === item.key ? 'page' : undefined} aria-label={item.label} title={item.label} onClick={() => navigateTo(item.key)}>
              <Icon size={18} strokeWidth={1.8} /><span>{item.label}</span>
            </button>
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-help"><div className="help-icon"><ShieldCheck size={18} /></div><div><strong>สิทธิ์แยกตามบทบาท</strong><span>Admin Office ดูแลงาน · ช่าง Onsite ปฏิบัติงาน</span></div></div>
        <div className="user-profile">
          <div className="avatar">{(userContext?.display_name || 'ท').slice(0, 1)}</div>
          <div className="user-meta"><strong>{demoMode ? 'ผู้ใช้งานตัวอย่าง' : userContext?.display_name || session?.user.email || 'ผู้ใช้งาน'}</strong><span>{getFriendlyRole(role)}</span></div>
          <button className="icon-button" aria-label="ออกจากระบบ" onClick={signOut}><LogOut size={17} /></button>
        </div>
      </aside>
      {mobileMenuOpen && <button className="mobile-nav-backdrop" aria-label="ปิดเมนูหลัก" onClick={() => setMobileMenuOpen(false)} />}

      <main className="main-area">
        <header className="topbar">
          <button ref={mobileMenuTriggerRef} className="icon-button mobile-nav-toggle" aria-label="เปิดเมนูหลัก" aria-expanded={mobileMenuOpen} aria-controls="primary-navigation" onClick={() => setMobileMenuOpen(open => !open)}>
            <Menu size={18} />
          </button>
          <div className="breadcrumb"><span>ระบบปฏิบัติการ</span><ChevronRight size={14} /><strong>{currentPage.title}</strong></div>
          <div className="top-actions">
            {demoMode && <span className="demo-indicator"><span /> DEMO · ข้อมูลตัวอย่าง</span>}
            <button className="icon-button notification-button" aria-label="การแจ้งเตือน" onClick={() => setNotice('ยังไม่มีการแจ้งเตือนใหม่')}><Bell size={18} /><i /></button>
            <div className="top-divider" />
            <div ref={accountMenuRef} className="account-menu-wrap">
              <button type="button" className="top-user" aria-haspopup="menu" aria-expanded={accountMenuOpen} aria-label={`เมนูบัญชี ${accountName}`} onClick={() => { setAccountMenuOpen(open => !open); setWorkspaceMenuOpen(false) }}>
                <div className="avatar avatar-small">{(userContext?.display_name || 'ท').slice(0, 1)}</div><span>{accountName}</span><ChevronDown size={14} />
              </button>
              {accountMenuOpen && <div className="account-menu" role="menu" aria-label="เมนูบัญชี">
                <div className="account-menu-identity"><strong>{accountName}</strong><span>{getFriendlyRole(role)}</span>{!demoMode && session?.user.email && <small>{session.user.email}</small>}</div>
                {canUseAdminModules && <button type="button" role="menuitem" onClick={() => navigateTo('people')}>สิทธิ์ผู้ใช้งาน</button>}
                <button type="button" role="menuitem" className="account-signout" onClick={() => void signOut()}><LogOut size={15} />{demoMode ? 'ออกจากโหมดตัวอย่าง' : 'ออกจากระบบ'}</button>
              </div>}
            </div>
          </div>
        </header>

        <div className="content-wrap">
          {session && contextStatus === 'error' && hasContextForCurrentUser && !demoMode && <div className="auth-revalidation-warning" role="alert">
            <span>{contextError} หน้าปัจจุบันยังเปิดอยู่</span>
            <button type="button" className="secondary-button" onClick={() => void loadContext(session.user.id)}>ลองตรวจอีกครั้ง</button>
          </div>}
          <div className="page-heading">
            <div><div className="eyebrow">AIS BRANCH & ASSET OPERATIONS</div><h1>{currentPage.title}</h1><p>{currentPage.subtitle}</p></div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button type="button" className="secondary-button" onClick={handleExportRawData}><FileDown size={16} /> ส่งออก Raw Data (.csv)</button>
              {activeMenu === 'assets' && canUseAdminModules && <button type="button" className="secondary-button" onClick={() => setActiveMenu('imports')}><FileSpreadsheet size={16} /> นำเข้าทะเบียน</button>}
            </div>
          </div>

          {activeMenu === 'overview' && <Overview demo={demoMode} dashboard={dashboard} error={dashboardError} onNavigate={navigateTo} />}
          {activeMenu === 'work_orders' && <WorkOrders role={role} demo={demoMode} onUpdated={action => { resetAssetPages(); setListReloadKey(key => key + 1); if (action === 'evidence_started') setNotice(''); else setNotice(action === 'closeout_pending' ? 'ส่งผลหน้างานแล้ว รอ Admin ตรวจหลักฐานและลงนาม' : action === 'accept' ? 'ตรวจรับและส่งมอบงานเรียบร้อย' : 'สถานะใบงานอัปเดตแล้ว'); void loadContext() }} />}
          {activeMenu === 'completed' && <WorkOrders role={role} demo={demoMode} view="completed" onUpdated={action => { resetAssetPages(); setListReloadKey(key => key + 1); if (action === 'evidence_started') setNotice(''); else setNotice(action === 'closeout_pending' ? 'ส่งผลหน้างานแล้ว รอ Admin ตรวจหลักฐานและลงนาม' : action === 'accept' ? 'ตรวจรับและส่งมอบงานเรียบร้อย' : 'สถานะใบงานอัปเดตแล้ว'); void loadContext() }} />}
          {activeMenu === 'assets' && <Assets role={role} demo={demoMode} items={demoMode ? demoAssets : listData} loading={pageLoading} error={listError} onRetry={() => setListReloadKey(key => key + 1)} onTaskUpdated={action => { resetAssetPages(); setListReloadKey(key => key + 1); if (action === 'evidence_started') setNotice(''); else setNotice(action === 'refresh' ? 'กำลังโหลดสถานะ Scanner ล่าสุด' : action === 'closeout_pending' ? 'ส่งผลหน้างานแล้ว รอ Admin ตรวจหลักฐานและลงนาม' : action === 'resolve_exception' ? 'Admin ตรวจ Pending และบันทึกผลพิจารณาแล้ว' : action === 'accept' ? 'Admin ลงนามรับผ่านและส่งมอบงานแล้ว' : action === 'block' ? 'บันทึกรายการ Pending แล้ว' : action === 'resume' ? 'รายการกลับมาดำเนินการแล้ว' : 'เริ่มปฏิบัติงานแล้ว'); void loadContext() }} search={search} searchResultsReady={demoMode || loadedAssetSearch === search} setSearch={value => { clearAssetQueryResults(); resetAssetPages(); setSearch(value) }} provinceOptions={visibleProvinces} provinceFilter={activeProvince} setProvinceFilter={value => { clearAssetQueryResults(); resetAssetPages(); setActiveProvince(value) }} statusFilter={assetStatusFilter} setStatusFilter={value => { clearAssetQueryResults(); resetAssetPages(); setAssetStatusFilter(value) }} page={assetPage} pageOffset={assetPageOffsets.current[assetPage] || 0} total={assetTotal} provinceTotal={assetProvinceTotal} setPage={value => { setListData([]); setListError(''); setAssetPage(value) }} focusSerial={pendingAssetSerial} onFocusResolved={() => setPendingAssetSerial('')} />}
          {activeMenu === 'pending' && !demoMode && (role === 'admin' || role === 'customer_reviewer') && <PendingReviews role={role} onUpdated={action => { setListReloadKey(key => key + 1); setNotice(action === 'accept' ? 'ตรวจรับและส่งมอบงานเรียบร้อย' : action === 'reject' ? 'ปฏิเสธงานและส่งกลับแก้ไขแล้ว' : action === 'resolve_exception' ? 'บันทึกผลตรวจ Pending แล้ว' : 'สถานะใบงานอัปเดตแล้ว'); void loadContext() }} />}
          {activeMenu === 'discovery' && !demoMode && role === 'admin' && <ScannerDiscoveryQueue onUpdated={action => { resetAssetPages(); setListReloadKey(key => key + 1); setNotice(action === 'refresh' ? 'รายการเครื่องนอกทะเบียนอัปเดตแล้ว' : action); void loadContext() }} />}
          {handoverBranch && <BranchHandoverSheetModal branch={handoverBranch} onClose={() => setHandoverBranch(null)} />}
          {activeMenu === 'imports' && canUseAdminModules && <Imports role={role} onComplete={async () => {
            resetAssetPages()
            setListReloadKey(key => key + 1)
            await loadContext()
          }} />}
          {activeMenu === 'people' && canUseAdminModules && <People />}
          <footer className="page-footer"><span>© 2026 AIS Branch & Asset Operations</span><span>V1 · ระบบนำร่อง</span></footer>
        </div>
      </main>
      <nav className={'mobile-bottom-nav' + (role === 'admin' && !demoMode ? ' is-admin' : '')} aria-label="เมนูหลักสำหรับโทรศัพท์">
        {visibleNavigation.filter(item => ['overview', 'work_orders', 'pending'].includes(item.key)).map(item => {
          const Icon = item.icon
          const label = item.key === 'overview' ? 'หน้าหลัก' : item.key === 'work_orders' ? 'ใบงาน' : 'รอตรวจ'
          return <button key={item.key} type="button" className={'mobile-tab' + (activeMenu === item.key ? ' active' : '')} aria-current={activeMenu === item.key ? 'page' : undefined} onClick={() => navigateTo(item.key)}>
            <Icon size={18} aria-hidden="true" /><span>{label}</span>
          </button>
        })}
        <button type="button" className={'mobile-tab mobile-more' + (mobileMenuOpen || !['overview', 'work_orders', 'pending'].includes(activeMenu) ? ' active' : '')} aria-label="เมนูเพิ่มเติม" aria-expanded={mobileMenuOpen} aria-controls="primary-navigation" onClick={() => setMobileMenuOpen(true)}>
          <Menu size={18} aria-hidden="true" /><span>เพิ่มเติม</span>
        </button>
      </nav>
      {notice && <div className="toast" role="status" aria-live="polite"><CheckCircle2 size={18} />{notice}<button onClick={() => setNotice('')} aria-label="ปิด"><X size={16} /></button></div>}
    </div>
    {reauthRequired && createPortal(
      <SessionResumeDialog
        error={loginError || signOutError || contextError}
        submitting={isSigningIn}
        retrying={contextStatus === 'loading'}
        canRetry={Boolean(session && contextError)}
        onGoogleSignIn={() => void signInWithGoogle()}
        onSignOut={() => void signOut()}
        onRetry={() => void loadContext(session?.user.id || null)}
      />,
      document.body,
    )}
    </>
  )
}

function SessionResumeDialog({ error, submitting, retrying, canRetry, onGoogleSignIn, onSignOut, onRetry }: {
  error: string; submitting: boolean; retrying: boolean; canRetry: boolean; onGoogleSignIn: () => void; onSignOut: () => void; onRetry: () => void
}) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const releaseBodyScroll = lockBodyScroll()
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || [])
    focusable()[0]?.focus()
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const controls = focusable()
      if (!controls.length) return
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? controls[controls.length - 1] : controls[0]).focus()
      } else if (event.shiftKey && document.activeElement === controls[0]) {
        event.preventDefault()
        controls[controls.length - 1].focus()
      } else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) {
        event.preventDefault()
        controls[0].focus()
      }
    }
    document.addEventListener('keydown', trapTab)
    return () => {
      releaseBodyScroll()
      document.removeEventListener('keydown', trapTab)
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus()
    }
  }, [])

  return <div className="session-resume-backdrop">
    <section ref={dialogRef} className="session-resume-dialog" role="alertdialog" aria-modal="true" aria-labelledby="session-resume-title" aria-describedby="session-resume-description" tabIndex={-1}>
      <div className="login-icon"><LockKeyhole size={22} /></div>
      <h2 id="session-resume-title">เซสชันหมดอายุ</h2>
      <p id="session-resume-description">เข้าสู่ระบบบัญชีเดิมเพื่อกลับไปยังหน้าที่เปิดค้างไว้ ระบบพักหน้าจอเดิมไว้และล็อกการใช้งานจนกว่าจะตรวจสอบสิทธิ์สำเร็จ</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      {error && canRetry && <button type="button" className="session-resume-retry" disabled={retrying} onClick={onRetry}>{retrying ? 'กำลังตรวจสอบสิทธิ์…' : 'ตรวจสอบสิทธิ์อีกครั้ง'}</button>}
      <button type="button" className="google-sign-in-button" disabled={submitting} onClick={onGoogleSignIn}>
        <GoogleMark />{submitting ? 'กำลังเชื่อมต่อ Google…' : 'เข้าสู่ระบบต่อด้วย Google'}
      </button>
      <button type="button" className="session-resume-signout" onClick={onSignOut}>ออกจากระบบและล้างหน้าที่ค้างไว้</button>
    </section>
  </div>
}

function GoogleMark() {
  return <svg className="google-sign-in-mark" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.44a5.5 5.5 0 0 1-2.39 3.61v2.99h3.87c2.27-2.09 3.57-5.17 3.57-8.84Z" />
    <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.94-2.89l-3.87-2.99c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.95H1.27v3.09C3.25 21 7.28 24 12 24Z" />
    <path fill="#FBBC05" d="M5.27 14.32A7.2 7.2 0 0 1 4.89 12c0-.81.14-1.59.38-2.32V6.59H1.27A11.98 11.98 0 0 0 0 12c0 1.94.46 3.77 1.27 5.41l4-3.09Z" />
    <path fill="#EA4335" d="M12 4.73c1.76 0 3.34.6 4.59 1.82l3.44-3.44C17.95 1.19 15.24 0 12 0 7.28 0 3.25 3 1.27 6.59l4 3.09C6.22 6.84 8.87 4.73 12 4.73Z" />
  </svg>
}

function LoginPage({ onGoogleSignIn, onDemo, onHelp, error, configured, submitting }: {
  onGoogleSignIn: () => void; onDemo: () => void; onHelp: () => void; error: string; configured: boolean; submitting: boolean
}) {
  return <div className="login-page">
    <section className="login-panel">
      <div className="login-brand"><div className="brand-mark"><span>AIS</span></div><span>BRANCH & ASSET OPERATIONS</span></div>
      <div className="login-content">
        <div className="eyebrow">SCANNER REPLACEMENT PROGRAM</div>
        <h1>จัดการงานเปลี่ยนเครื่อง<br /><em>ได้ในที่เดียว</em></h1>
        <p className="login-intro">เปิดใบงานแยกตามสาขา ให้ช่างทุกคนเห็นและบันทึกผล Onsite ได้ในที่เดียว</p>
        <div className="login-feature"><div><ClipboardList size={18} /></div><span>ติดตามใบงานตั้งแต่เปิดงานจนส่งมอบ</span></div>
        <div className="login-feature"><div><MapPin size={18} /></div><span>ค้นหาสาขาและอุปกรณ์จากทะเบียนกลาง</span></div>
        <div className="login-feature"><div><ShieldCheck size={18} /></div><span>แสดงใบงานให้ Admin และช่าง Onsite ตามสิทธิ์ปฏิบัติงาน</span></div>
      </div>
      <div className="login-copyright">© 2026 AIS Branch & Asset Operations <span>·</span> ระบบภายใน</div>
    </section>
    <section className="login-form-panel">
      <div className="login-card">
        <div className="login-icon"><LockKeyhole size={21} /></div>
        <h2>เข้าสู่ระบบ</h2>
        <p>ใช้บัญชี Google ที่ Identity Admin อนุมัติไว้</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        {!configured && <div className="config-note">ระบบยังไม่ได้เชื่อมต่อ Cloudflare Edge D1 จึงยังเข้าสู่ระบบไม่ได้</div>}
        <button className="google-sign-in-button" type="button" onClick={onGoogleSignIn} disabled={submitting || !configured}>
          <GoogleMark />
          <span>{submitting ? 'กำลังเชื่อมต่อ Google…' : 'เข้าสู่ระบบด้วย Google'}</span>
        </button>
        <div className="login-separator"><span>หรือ</span></div>
        <button className="demo-button" onClick={onDemo}><Activity size={17} /> ดูตัวอย่างระบบด้วยข้อมูลจำลอง</button>
        <div className="privacy-note"><ShieldCheck size={15} /> อนุญาตเฉพาะอีเมลใน whitelist · โหมดตัวอย่างใช้ข้อมูลจำลอง</div>
      </div>
      <div className="login-bottom"><span>ติดปัญหาการเข้าใช้งาน?</span><button type="button" onClick={onHelp}>ติดต่อ Identity Admin</button></div>
    </section>
  </div>
}

function NoAccess({ email, error, onSignOut, onRetry, retry = false }: { email: string; error: string; onSignOut: () => void; onRetry?: () => void; retry?: boolean }) {
  return <div className="no-access"><div className="no-access-card"><div className="login-icon"><ShieldCheck size={22} /></div><div className="eyebrow">AIS BRANCH & ASSET OPERATIONS</div><h1>{retry ? 'ตรวจสอบสิทธิ์ไม่ได้' : 'บัญชีนี้ยังไม่มีสิทธิ์ใช้งาน'}</h1><p>{retry ? email : `เข้าสู่ระบบสำเร็จด้วย ${email || 'บัญชีของคุณ'} แต่ยังไม่มีบทบาทที่ผู้ดูแลกำหนดไว้ โปรดติดต่อ Identity Admin`}</p>{error && <div className="form-error" role="alert">{error}</div>}{retry && onRetry && <button className="primary-button" onClick={onRetry}>ลองตรวจสอบอีกครั้ง</button>}<button className="secondary-button" onClick={onSignOut}><LogOut size={16} /> ออกจากระบบ</button></div></div>
}

function Overview({ demo, dashboard, error, onNavigate }: { demo: boolean; dashboard: DashboardData | null; error: string; onNavigate: (key: MenuKey, search?: string) => void }) {
  const demoWeeklyActivity = [
    { date: '2026-11-05', opened: 2, completed: 1 }, { date: '2026-11-06', opened: 3, completed: 2 },
    { date: '2026-11-07', opened: 1, completed: 1 }, { date: '2026-11-08', opened: 2, completed: 1 },
    { date: '2026-11-09', opened: 4, completed: 2 }, { date: '2026-11-10', opened: 3, completed: 3 },
    { date: '2026-11-11', opened: 2, completed: 1 },
  ]
  const demoProvinces = [
    { province: 'กรุงเทพมหานคร', branches_total: 3, branches_complete: 1, branches_remaining: 2, scanners_total: 8, scanners_open: 3, scanners_on_process: 3, scanners_complete: 2 },
    { province: 'ปทุมธานี', branches_total: 2, branches_complete: 1, branches_remaining: 1, scanners_total: 5, scanners_open: 1, scanners_on_process: 1, scanners_complete: 3 },
  ]
  const provinceSummary = dashboard?.province_summary
  const totals = (demo ? { branches_total: 5, branches_complete: 2, branches_remaining: 3, scanners_total: 13, scanners_open: 4, scanners_on_process: 4, scanners_complete: 5 } : provinceSummary?.totals || {}) as Record<string, number>
  const provinces = (demo ? demoProvinces : provinceSummary?.provinces || []) as Array<Record<string, unknown>>
  const activity = (demo ? demoWeeklyActivity : dashboard?.weekly_activity || []) as DashboardData['weekly_activity']
  const number = (value: unknown) => Math.max(0, Number(value) || 0)
  const activityMax = Math.max(1, ...(activity || []).map(day => Math.max(number(day.opened), number(day.completed))))
  const stats = [
    { label: 'สาขาทั้งหมด', key: 'branches_total', tone: 'blue', icon: <MapPin size={18} />, destination: 'assets', action: 'ดูทะเบียน' },
    { label: 'สาขาเปลี่ยนครบ', key: 'branches_complete', tone: 'green', icon: <CheckCircle2 size={18} />, destination: 'assets', action: 'ดูทะเบียน' },
    { label: 'สาขาที่ยังเปลี่ยนไม่ครบ', key: 'branches_remaining', tone: 'orange', icon: <Activity size={18} />, destination: 'assets', action: 'ดูทะเบียน' },
    { label: 'Scanner ทั้งหมด', key: 'scanners_total', tone: 'violet', icon: <HardDrive size={18} />, destination: 'assets', action: 'ดูทะเบียน' },
    { label: 'On Process', key: 'scanners_on_process', tone: 'orange', icon: <Wrench size={18} />, destination: 'work_orders', action: 'ดูใบงาน' },
    { label: 'Complete', key: 'scanners_complete', tone: 'green', icon: <CheckCircle2 size={18} />, destination: 'completed', action: 'ดูงานที่เสร็จแล้ว' },
  ] as const
  return <div className="overview-content">
    <div className="welcome-strip"><div className="welcome-mark"><Activity size={20} /></div><div><strong>ติดตามความคืบหน้าการเปลี่ยน Scanner</strong><span>เลือกจังหวัด สาขา และเครื่องจากทะเบียน เพื่อดูรายละเอียดหรือเริ่มงานกับเครื่องนั้นได้ทันที</span></div><button onClick={() => onNavigate('assets')}>เปิดทะเบียนอุปกรณ์ <ArrowRight size={15} /></button></div>
    <div className="section-heading-row"><div><h2>ภาพรวมทุกจังหวัด</h2><p>จำนวนสาขาและสถานะ Scanner จากงานจริงในทะเบียน</p></div><span className="period-label"><MapPin size={15} /> {provinces.length.toLocaleString('th-TH')} จังหวัด</span></div>
    <div className="stats-grid dashboard-summary-grid">{stats.map(stat => <button type="button" className="stat-card stat-card-action" key={stat.key} aria-label={`${stat.action}: ${stat.label}`} onClick={() => onNavigate(stat.destination)}><div className="stat-top"><span>{stat.label}</span><div className={'stat-icon ' + stat.tone}>{stat.icon}</div></div><div className="stat-value">{error && !demo ? '—' : number(totals[stat.key]).toLocaleString('th-TH')}</div><div className="stat-foot"><span className="stat-change">{stat.key.startsWith('branches') ? 'สรุปจากสาขาในทะเบียน' : 'สรุปตามสถานะล่าสุด'}</span><span className="stat-period">{stat.action} <ArrowRight size={12} /></span></div></button>)}</div>
    <section className="panel weekly-activity-panel"><div className="panel-heading"><div><h2>งานที่เปิดและปิดใน 7 วันที่ผ่านมา</h2><p>นับใบงานตามวันที่สร้างและวันที่ส่งมอบงาน</p></div><div className="chart-legend" aria-label="คำอธิบายกราฟ"><span><i className="weekly-open-key" /> เปิดใบงาน</span><span><i className="weekly-complete-key" /> ส่งมอบแล้ว</span></div></div>
      {error && !demo ? <EmptyState compact title="โหลดกราฟไม่สำเร็จ" detail={error} /> : activity?.length ? <div className="bar-chart weekly-activity-chart" role="img" aria-label="กราฟจำนวนใบงานที่เปิดและส่งมอบในแต่ละวัน">
        {activity.map(day => {
          const opened = number(day.opened)
          const completed = number(day.completed)
          const openedHeight = opened ? Math.max(2, opened / activityMax * 100) : 0
          const completedHeight = completed ? Math.max(2, completed / activityMax * 100) : 0
          const date = new Date(`${day.date}T00:00:00`)
          const dayLabel = Number.isNaN(date.getTime()) ? String(day.date) : new Intl.DateTimeFormat('th-TH', { weekday: 'short' }).format(date)
          return <div className="bar-column" key={day.date} aria-label={`${dayLabel}: เปิด ${opened} ใบงาน ส่งมอบ ${completed} ใบงาน`}><span>{opened}/{completed}</span><div className="weekly-activity-bars" aria-hidden="true"><i className="weekly-open-bar" style={{ height: `${openedHeight}%` }} /><i className="weekly-complete-bar" style={{ height: `${completedHeight}%` }} /></div><small>{dayLabel}</small></div>
        })}
      </div> : <EmptyState compact title="ยังไม่มีใบงานในช่วงนี้" detail="กราฟจะแสดงเมื่อมีการเปิดหรือส่งมอบใบงาน" />}
    </section>
    <section className="panel province-summary-panel"><div className="panel-heading"><div><h2>สรุปแยกตามจังหวัด</h2><p>กดจังหวัดเพื่อเปิดทะเบียนและดู Scanner ในพื้นที่นั้น</p></div><button className="text-button" onClick={() => onNavigate('assets')}>ดูทะเบียนทั้งหมด <ArrowRight size={15} /></button></div>
      {error && !demo ? <EmptyState compact title="โหลดสรุปจังหวัดไม่สำเร็จ" detail={error} /> : provinces.length ? <div className="province-summary-list">{provinces.map((province, index) => {
        const name = String(province.province || 'ไม่ระบุจังหวัด')
        const scannerTotal = number(province.scanners_total)
        const open = number(province.scanners_open)
        const onProcess = number(province.scanners_on_process)
        const complete = number(province.scanners_complete)
        return <button type="button" className="province-summary-row" key={name || index} onClick={() => onNavigate('assets', name)} aria-label={`ดูทะเบียนจังหวัด${name}`}>
          <span className="province-summary-main"><strong>{name}</strong><small>{number(province.branches_total).toLocaleString('th-TH')} สาขา · เปลี่ยนครบ {number(province.branches_complete).toLocaleString('th-TH')} · ยังไม่ครบ {number(province.branches_remaining).toLocaleString('th-TH')}</small></span>
          <span className="province-summary-metric"><small>Scanner</small><strong>{scannerTotal.toLocaleString('th-TH')}</strong></span>
          <span className="province-summary-breakdown"><span className="province-status-labels"><small>รอเปิดใบงาน {open}</small><small>On Process {onProcess}</small><small>Complete {complete}</small></span><span className="province-status-bar" aria-label={`รอเปิดใบงาน ${open}, On Process ${onProcess}, Complete ${complete}`}><i className="province-status-open" style={{ width: `${getPercent(open, scannerTotal)}%` }} /><i className="province-status-process" style={{ width: `${getPercent(onProcess, scannerTotal)}%` }} /><i className="province-status-complete" style={{ width: `${getPercent(complete, scannerTotal)}%` }} /></span></span>
          <ArrowRight className="province-summary-arrow" size={17} />
        </button>
      })}</div> : <EmptyState compact title="ยังไม่มีข้อมูลจังหวัด" detail="จังหวัดจะแสดงเมื่อมีสาขาอยู่ในทะเบียน" />}
    </section>
  </div>
}

function Assets({ role, demo, items, loading, error, onRetry, onTaskUpdated, search, searchResultsReady, setSearch, provinceOptions, provinceFilter, setProvinceFilter, statusFilter, setStatusFilter, page, pageOffset, total, provinceTotal, setPage, focusSerial, onFocusResolved }: { role?: string; demo: boolean; items: unknown[]; loading: boolean; error: string; onRetry: () => void; onTaskUpdated: (action: string) => void; search: string; searchResultsReady: boolean; setSearch: (value: string) => void; provinceOptions: string[]; provinceFilter: string; setProvinceFilter: (value: string) => void; statusFilter: string; setStatusFilter: (value: string) => void; page: number; pageOffset: number; total: number; provinceTotal: number; setPage: (page: number) => void; focusSerial: string; onFocusResolved: () => void }) {
  const rows = (items.length ? items : (demo ? demoAssets : [])) as Array<Record<string, unknown>>
  const filteredRows = demo ? rows.filter(row => {
    const query = search.trim().toLocaleLowerCase()
    const searchableText = [row.branch, row.branch_name, row.loc_bld, row.province, row.code, row.location_code, row.model, row.model_name, row.hw_name, row.serial, row.com_sn]
      .map(value => String(value ?? '').toLocaleLowerCase())
      .join(' ')
    const searchMatches = !query || searchableText.includes(query)
    const provinceMatches = !provinceFilter || String(row.province || '') === provinceFilter
    const status = getTaskWorkflowStage(row)
    const statusGroup = ['delivered', 'legacy_completed', 'completed'].includes(status)
      ? 'complete'
      : ['open', 'scheduled', 'awaiting_confirmation', 'confirmed', 'cancelled', 'draft', 'ready_to_schedule', 'exception_resolved', 'selection', 'เลือกเข้ารอบงาน', 'ยังไม่เลือก', 'ยังไม่เปิดใบงาน'].includes(status)
        ? 'open'
        : 'on_process'
    return searchMatches && provinceMatches && (statusFilter === 'all' || statusGroup === statusFilter)
  }) : rows
  const provinceGroups = groupRowsByProvince(filteredRows)
  const [expandedProvinces, setExpandedProvinces] = useState<string[]>([])
  const [expandedBranches, setExpandedBranches] = useState<string[]>([])
  const autoExpandedSearch = useRef('')
  useEffect(() => {
    const query = search.trim()
    if (!query) {
      if (autoExpandedSearch.current) {
        autoExpandedSearch.current = ''
        setExpandedProvinces([])
        setExpandedBranches([])
      }
      return
    }
    const key = `${query}\u0000${page}`
    if (loading || !searchResultsReady || autoExpandedSearch.current === key) return
    autoExpandedSearch.current = key
    setExpandedProvinces(provinceGroups.map(group => group.province))
    setExpandedBranches(provinceGroups.flatMap(group => groupRowsByBranch(group.rows).map(branch => group.province + branch.key)))
  }, [loading, page, provinceGroups, search, searchResultsReady])
  const toggleProvince = (name: string) => setExpandedProvinces(current => current.includes(name) ? current.filter(value => value !== name) : [...current, name])
  const toggleBranch = (key: string) => setExpandedBranches(current => current.includes(key) ? current.filter(value => value !== key) : [...current, key])
  const assetStatus = (row: Record<string, unknown>) => row.status ? getStatusPresentation(row.status) : { label: 'ยังไม่เปิดใบงาน', tone: 'neutral' }
  const [selectedAsset, setSelectedAsset] = useState<Record<string, unknown> | null>(null)
  const [reportBranch, setReportBranch] = useState<BranchReference | null>(null)
  const [focusMessage, setFocusMessage] = useState('')

  useEffect(() => {
    if (!focusSerial || loading) return
    if (error) {
      onFocusResolved()
      return
    }
    const target = focusSerial.trim().toLocaleUpperCase()
    const found = rows.find(row => String(row.serial || row.com_sn || '').trim().toLocaleUpperCase() === target)
    if (found) {
      setFocusMessage('')
      setSelectedAsset(found)
    } else {
      setFocusMessage(`ไม่พบทะเบียน Scanner หมายเลข ${focusSerial}`)
    }
    onFocusResolved()
  }, [error, focusSerial, loading, onFocusResolved, rows])
  return <>
    <div className="asset-summary"><div><span>Scanner ในผลลัพธ์</span><strong>{demo ? filteredRows.length.toLocaleString('th-TH') : total.toLocaleString('th-TH')}</strong></div><div><span>จังหวัดในผลลัพธ์</span><strong>{demo ? new Set(filteredRows.map(row => String(row.province || '').trim()).filter(Boolean)).size.toLocaleString('th-TH') : provinceTotal.toLocaleString('th-TH')}</strong></div><div><span>หน้าปัจจุบัน</span><strong>{demo ? 'ตัวอย่าง' : (page + 1).toLocaleString('th-TH')}</strong></div></div>
    <section className="panel list-panel">
      <div className="asset-register-toolbar">
        <label className="search-box"><Search size={17} /><input aria-label="ค้นหาสาขา LocationCode รุ่น หรือ Serial" value={search} onChange={event => { setFocusMessage(''); if (focusSerial) onFocusResolved(); setSearch(event.target.value) }} placeholder="ค้นหาสาขา LocationCode รุ่น หรือ Serial" /></label>
        <label className="asset-filter-field"><span>จังหวัด</span><select aria-label="กรองตามจังหวัด" value={provinceFilter} onChange={event => setProvinceFilter(event.target.value)}><option value="">ทุกจังหวัด</option>{provinceOptions.map(province => <option value={province} key={province}>{province}</option>)}</select></label>
        <label className="asset-filter-field"><span>สถานะงาน</span><select aria-label="กรองตามสถานะงาน" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">ทุกสถานะ</option><option value="open">รอเปิดใบงาน</option><option value="on_process">On Process · กำลังดำเนินการ</option><option value="complete">Complete · เสร็จสมบูรณ์</option></select></label>
        {(provinceFilter || statusFilter !== 'all' || search) && <button type="button" className="secondary-button asset-filter-reset" onClick={() => { setProvinceFilter(''); setStatusFilter('all'); setSearch(''); setPage(0) }}>ล้างตัวกรอง</button>}
      </div>
      {focusMessage && <div className="detail-readonly-note" role="status">{focusMessage}</div>}
      {loading && !filteredRows.length ? <EmptyState loading /> : error && !filteredRows.length ? <EmptyState title="โหลดข้อมูลไม่สำเร็จ" detail={error} onRetry={onRetry} /> : filteredRows.length ? <>
        {loading && <div className="list-refresh-notice" role="status">กำลังอัปเดตรายการ Scanner…</div>}
        {error && <div className="list-refresh-notice is-error" role="alert"><span>{error}</span><button type="button" className="secondary-button" onClick={onRetry}>ลองอีกครั้ง</button></div>}
        <div className="table-wrap asset-table-wrap"><table><thead><tr><th>สาขา / LocationCode</th><th>อุปกรณ์</th><th>Serial</th><th>สถานะ</th><th>ปีข้อมูลเดิม</th><th>รายละเอียด</th></tr></thead><tbody>{provinceGroups.flatMap(group => [
          <tr className="province-table-group" key={'province-' + group.province}><th scope="rowgroup" colSpan={6}><button type="button" className="register-expand-button" aria-expanded={expandedProvinces.includes(group.province)} onClick={() => toggleProvince(group.province)}><ChevronDown size={15} /> จังหวัด{group.province} <small>{group.branchCount} สาขา · {group.rows.length} เครื่อง</small></button></th></tr>,
          ...(expandedProvinces.includes(group.province) ? groupRowsByBranch(group.rows).flatMap(branch => [
            <tr className="branch-table-group" key={'branch-' + group.province + '-' + branch.key}><th scope="rowgroup" colSpan={6}><div className="branch-table-heading"><button type="button" className="register-expand-button" aria-expanded={expandedBranches.includes(group.province + branch.key)} onClick={() => toggleBranch(group.province + branch.key)}><ChevronDown size={15} /> {branch.name}<small>LocationCode {branch.locationCode || '—'} · {branch.rows.length} เครื่อง</small></button>{branch.addressNote && <span className="address-note-badge" title={branch.addressNote}>⚠️ ที่อยู่ต้องตรวจ</span>}{!demo && ['admin', 'field_technician'].includes(String(role)) && <button type="button" className="text-button" onClick={() => setReportBranch({ id: branch.rows[0]?.branch_id, name: branch.name, code: branch.locationCode, province: group.province })}>พบ Scanner นอกทะเบียน</button>}</div></th></tr>,
            ...(expandedBranches.includes(group.province + branch.key) ? branch.rows.map((row, i) => {
            const rowKey = String(row.id || String(row.location_code || 'asset') + '-' + String(row.com_sn || 'serial') + '-' + i)
            const status = assetStatus(row)
            return <tr key={rowKey}><td><div className="table-primary">{String(row.branch || row.branch_name || row.loc_bld || 'สาขา')}</div><div className="table-secondary">{String(row.code || row.location_code || '')}</div></td><td>{String(row.model || row.model_name || row.hw_name || '—')}</td><td className="serial-cell">{String(row.serial || row.com_sn || '—')}</td><td><StatusPill label={status.label} tone={status.tone} /></td><td>{String(row.year || row.com_years || '—')}</td><td><button type="button" className="text-button asset-detail-action" onClick={() => setSelectedAsset(row)}>ดูรายละเอียดและประวัติ</button></td></tr>
            }) : [])
          ]) : [])
        ])}</tbody></table></div>
        <div className="asset-mobile-list">{provinceGroups.map(group => <ProvinceCardGroup key={'mobile-province-' + group.province} group={group}><div className="province-mobile-cards">{groupRowsByBranch(group.rows).map(branch => <section className="branch-mobile-group" key={'mobile-branch-' + group.province + '-' + branch.key}><div className="branch-mobile-heading"><div><strong>{branch.name}</strong><small>LocationCode {branch.locationCode || '—'} · {branch.rows.length} เครื่อง</small>{branch.addressNote && <span className="address-note-badge" title={branch.addressNote}>⚠️ ที่อยู่ต้องตรวจ</span>}</div>{!demo && ['admin', 'field_technician'].includes(String(role)) && <button type="button" className="text-button" onClick={() => setReportBranch({ id: branch.rows[0]?.branch_id, name: branch.name, code: branch.locationCode, province: group.province })}>พบ Scanner นอกทะเบียน</button>}</div>{branch.rows.map((row, i) => {
          const rowKey = String(row.id || String(row.location_code || 'asset') + '-' + String(row.com_sn || 'serial') + '-' + i)
          const status = assetStatus(row)
          return <article className="mobile-record-card" key={rowKey}>
            <div className="mobile-record-heading"><div><strong>{String(row.serial || row.com_sn || 'Serial ไม่ระบุ')}</strong><span>{String(row.model || row.model_name || row.hw_name || 'เครื่องสแกน')}</span></div><StatusPill label={status.label} tone={status.tone} /></div>
            <div className="mobile-record-branch">{String(row.branch || row.branch_name || row.loc_bld || 'สาขาไม่ระบุ')}<small>LocationCode {String(row.code || row.location_code || '—')}</small></div>
            <div className="mobile-record-meta"><span>ปีข้อมูลเดิม<strong>{String(row.year || row.com_years || '—')}</strong></span></div>
            <button className="mobile-card-action" onClick={() => setSelectedAsset(row)}>รายละเอียด Scanner และเริ่มงาน</button>
          </article>
        })}</section>)}</div></ProvinceCardGroup>)}</div>
      </> : <EmptyState title={provinceFilter || statusFilter !== 'all' || search ? 'ไม่พบ Scanner ที่ตรงกับตัวกรอง' : 'ยังไม่มีทะเบียนอุปกรณ์'} detail={provinceFilter || statusFilter !== 'all' || search ? 'ลองเปลี่ยนจังหวัด สถานะ หรือคำค้นหา แล้วตรวจอีกครั้ง' : 'ทะเบียนจะแสดงหลังนำเข้าไฟล์ที่ผ่านการตรวจสอบแล้ว'} />}
      <div className="list-footer"><span>{demo ? 'แสดง ' + filteredRows.length + ' จาก ' + rows.length + ' รายการตัวอย่าง' : error ? 'โหลดข้อมูลไม่สำเร็จ' : 'แสดง ' + (total ? pageOffset + 1 : 0) + '–' + Math.min(pageOffset + rows.length, total) + ' จาก ' + total.toLocaleString('th-TH') + ' เครื่อง · ไม่ตัดจังหวัดข้ามหน้า'}</span><div><button className="icon-button" aria-label="ก่อนหน้า" disabled={demo || loading || page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button><span className="page-number">{demo ? 1 : page + 1}</span><button className="icon-button" aria-label="ถัดไป" disabled={demo || loading || pageOffset + rows.length >= total} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></div></div>
    </section>
    {selectedAsset && <AssetDetailDialog asset={selectedAsset} role={role} demo={demo} onClose={() => setSelectedAsset(null)} onUpdated={onTaskUpdated} />}
    {reportBranch && <ScannerDiscoveryDialog branch={reportBranch} onClose={() => setReportBranch(null)} onReported={() => { setReportBranch(null); onTaskUpdated('refresh') }} />}
  </>
}

function BranchHandoverSheetModal({ branch, onClose }: { branch: any; onClose: () => void }) {
  const [detail, setDetail] = useState<{ branch: any; scanners: any[] } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const bId = branch.branch_id || branch.id
    if (!bId) {
      setLoading(false)
      return
    }
    void (async () => {
      try {
        const res = await d1Api.getBranchDetail(bId)
        if (alive) setDetail(res)
      } catch {
        // ignore
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [branch])

  return (
    <div className="handover-modal-backdrop" onClick={onClose}>
      <div className="handover-modal-content" onClick={e => e.stopPropagation()}>
        <div className="handover-modal-bar">
          <strong>เอกสารตรวจรับส่งมอบงาน (Handover Certificate)</strong>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="primary-button" onClick={() => window.print()}>
              <Printer size={15} /> พิมพ์ / บันทึก PDF
            </button>
            <button type="button" className="secondary-button" onClick={onClose}>
              <X size={15} /> ปิด
            </button>
          </div>
        </div>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center' }}>กำลังโหลดเอกสาร…</div>
        ) : (
          <div className="handover-sheet">
            <div className="handover-header">
              <div>
                <h2>ใบตรวจรับมอบงานโครงการเปลี่ยนเครื่องสแกนเนอร์บาร์โค้ด</h2>
                <p>AIS Branch Scanner Replacement Project</p>
                <p>คู่สัญญา: AIS — บมจ. จีเอเบิล (G-Able) — บริษัท สยามมัลติมีเดีย จำกัด (SYM)</p>
              </div>
              <div style={{ textAlign: 'right', fontSize: '12px', color: '#64748b' }}>
                <div>วันที่พิมพ์: {new Date().toLocaleDateString('th-TH')}</div>
                <div>สถานะ: ส่งมอบเสร็จสมบูรณ์ (Delivered)</div>
              </div>
            </div>

            <div className="handover-meta-grid">
              <div><strong>ชื่อสาขา:</strong> {detail?.branch?.loc_bld || branch.loc_bld || branch.branch_name || '—'}</div>
              <div><strong>LocationCode:</strong> {detail?.branch?.location_code || branch.location_code || branch.code || '—'}</div>
              <div><strong>จังหวัด:</strong> {detail?.branch?.province || branch.province || '—'}</div>
              <div><strong>อำเภอ/เขต:</strong> {detail?.branch?.district || branch.district || '—'}</div>
              <div><strong>ที่อยู่:</strong> {detail?.branch?.address || branch.address || '—'}</div>
              <div><strong>เบอร์โทรติดต่อ:</strong> {detail?.branch?.phone || branch.phone || '—'}</div>
            </div>

            <h3 style={{ fontSize: '14px', margin: '0 0 10px' }}>รายการอุปกรณ์ที่ดำเนินการเปลี่ยน</h3>
            <table className="handover-table">
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>ลำดับ</th>
                  <th>Serial เดิม</th>
                  <th>Serial ใหม่</th>
                  <th>ยี่ห้อ / รุ่น</th>
                  <th>ผลการเปลี่ยน</th>
                  <th>วันที่ดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {(detail?.scanners || [branch]).map((sc, index) => (
                  <tr key={sc.scanner_id || index}>
                    <td style={{ textAlign: 'center' }}>{index + 1}</td>
                    <td>{sc.com_sn || sc.serial || '—'}</td>
                    <td><strong>{sc.new_serial_number || sc.new_serial || '—'}</strong></td>
                    <td>{sc.brand || ''} {sc.model_name || sc.model || ''}</td>
                    <td>{sc.outcome === 'replaced' ? 'เปลี่ยนเครื่องสำเร็จ' : sc.outcome || 'สำเร็จ'}</td>
                    <td>{sc.closeout_submitted_at ? new Date(sc.closeout_submitted_at).toLocaleDateString('th-TH') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="handover-signatures-grid">
              <div className="handover-sig-box">
                <div className="handover-sig-line">
                  <span style={{ color: '#059669', fontWeight: 600 }}>✓ ลงนามผ่านระบบ</span>
                </div>
                <strong>ผู้ปฏิบัติงานหน้างาน (Onsite Technician)</strong>
                <div>บริษัท สยามมัลติมีเดีย จำกัด</div>
              </div>

              <div className="handover-sig-box">
                <div className="handover-sig-line">
                  <span style={{ color: '#059669', fontWeight: 600 }}>✓ ลงนามรับทราบประจำสาขา</span>
                </div>
                <strong>ตัวแทนผู้ใช้งานประจำสาขา AIS</strong>
                <div>ผู้รับมอบเครื่องประจำสาขา</div>
              </div>

              <div className="handover-sig-box">
                <div className="handover-sig-line">
                  <span style={{ color: '#059669', fontWeight: 600 }}>✓ ตรวจรับมอบงาน (Batch Accepted)</span>
                </div>
                <strong>ผู้ตรวจรับมอบงาน (Customer Reviewer)</strong>
                <div>บมจ. จีเอเบิล (G-Able)</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PendingReviews({ role, onUpdated }: { role?: string; onUpdated: (action: string) => void }) {
  const isCustomerReviewer = role === 'customer_reviewer'
  const [tasks, setTasks] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)

  // Modals & Actions
  const [rejectingTask, setRejectingTask] = useState<Record<string, unknown> | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [batchBranch, setBatchBranch] = useState<{ id: string; name: string; code: string; province: string; tasks: any[] } | null>(null)
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const [viewingEvidenceTask, setViewingEvidenceTask] = useState<Record<string, unknown> | null>(null)
  const [evidenceList, setEvidenceList] = useState<any[]>([])
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const [selectedAdminTask, setSelectedAdminTask] = useState<Record<string, unknown> | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const sigPadRef = useRef<SignaturePadHandle>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const res = await d1Api.getPendingTasks(query || undefined)
        if (active) setTasks(res.tasks || [])
      } catch (err: any) {
        if (active) setError(err.message || 'โหลดรายการ Pending ไม่สำเร็จ')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [query, reload])

  // Group tasks by branch for Customer Reviewer
  const branchGroups = useMemo(() => {
    if (!isCustomerReviewer) return []
    const map = new Map<string, { id: string; name: string; code: string; province: string; isOverdue: boolean; tasks: any[] }>()
    for (const t of tasks) {
      const bId = String(t.branch_id || 'unknown')
      if (!map.has(bId)) {
        map.set(bId, {
          id: bId,
          name: String(t.branch_name || t.loc_bld || 'สาขาไม่ระบุ'),
          code: String(t.location_code || '—'),
          province: String(t.province || '—'),
          isOverdue: Boolean(t.is_overdue),
          tasks: []
        })
      }
      const group = map.get(bId)!
      group.tasks.push(t)
      if (t.is_overdue) group.isOverdue = true
    }
    return Array.from(map.values())
  }, [tasks, isCustomerReviewer])

  const handleOpenBatchAccept = (group: { id: string; name: string; code: string; province: string; tasks: any[] }) => {
    setBatchBranch(group)
    setSelectedTaskIds(group.tasks.map(t => String(t.task_id || t.id)))
  }

  const handleToggleSelectTask = (taskId: string) => {
    setSelectedTaskIds(current =>
      current.includes(taskId) ? current.filter(id => id !== taskId) : [...current, taskId]
    )
  }

  const handleConfirmBatchAccept = async () => {
    if (!batchBranch || selectedTaskIds.length === 0) return
    if (!sigPadRef.current) return
    setSubmitting(true)
    try {
      const blob = await sigPadRef.current.exportJpeg()
      const reader = new FileReader()
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
      const signatureBase64 = await base64Promise

      await d1Api.customerBatchAccept(batchBranch.id, selectedTaskIds, signatureBase64)
      setBatchBranch(null)
      setSelectedTaskIds([])
      setReload(r => r + 1)
      onUpdated('accept')
    } catch (err: any) {
      alert('ตรวจรับงานไม่สำเร็จ: ' + err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleConfirmReject = async () => {
    if (!rejectingTask || !rejectReason.trim()) return
    const taskId = String(rejectingTask.task_id || rejectingTask.id)
    setSubmitting(true)
    try {
      if (isCustomerReviewer) {
        await d1Api.customerReject(taskId, rejectReason.trim())
      } else {
        await d1Api.symVerify(taskId, 'reject', rejectReason.trim(), Number(rejectingTask.version || 1))
      }
      setRejectingTask(null)
      setRejectReason('')
      setReload(r => r + 1)
      onUpdated('reject')
    } catch (err: any) {
      alert('ปฏิเสธงานไม่สำเร็จ: ' + err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleSymPass = async (task: Record<string, unknown>) => {
    const taskId = String(task.task_id || task.id)
    setSubmitting(true)
    try {
      await d1Api.symVerify(taskId, 'pass', undefined, Number(task.version || 1))
      setSelectedAdminTask(null)
      setReload(r => r + 1)
      onUpdated('accept')
    } catch (err: any) {
      alert('ตรวจรับงานไม่สำเร็จ: ' + err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleOpenEvidence = async (task: Record<string, unknown>) => {
    setViewingEvidenceTask(task)
    setEvidenceLoading(true)
    try {
      const taskId = String(task.task_id || task.id)
      const res = await d1Api.getTaskEvidence(taskId)
      setEvidenceList(res.evidence || [])
    } catch {
      setEvidenceList([])
    } finally {
      setEvidenceLoading(false)
    }
  }

  const submitSearch = (e: FormEvent) => {
    e.preventDefault()
    setQuery(draft.trim())
  }

  return (
    <>
      <section className="panel pending-review-panel">
        <div className="panel-heading">
          <div>
            <h2>{isCustomerReviewer ? 'งานรอตรวจรับมอบ (Gable Customer Review)' : 'งานที่รอ SYM Admin ตรวจรับ'}</h2>
            <p>
              {isCustomerReviewer
                ? 'ตรวจรับงานที่ผ่านการตรวจสอบจาก SYM แล้วแบบรวมต่อสาขา (1 ลายเซ็นต่อ Shop)'
                : 'ตรวจผลงาน Onsite รูปภาพ และลายเซ็นที่ช่างส่งมา ก่อนส่งมอบให้ Gable'}
            </p>
          </div>
          <span className="pending-review-count">
            {isCustomerReviewer
              ? `${branchGroups.length} สาขา (${tasks.length} เครื่อง)`
              : `${tasks.length} เครื่อง`}
          </span>
        </div>

        <form className="pending-review-search" onSubmit={submitSearch}>
          <label className="search-box">
            <Search size={17} />
            <input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="ค้นหาเลขสาขา, LocationCode, จังหวัด หรือ Serial"
              aria-label="ค้นหารายการ Pending"
            />
          </label>
          <button type="submit" className="secondary-button">ค้นหา</button>
          <button type="button" className="text-button" disabled={loading} onClick={() => setReload(r => r + 1)}>
            รีเฟรช
          </button>
        </form>

        {loading ? (
          <EmptyState compact loading />
        ) : error ? (
          <EmptyState compact title="โหลดรายการไม่สำเร็จ" detail={error} onRetry={() => setReload(r => r + 1)} />
        ) : isCustomerReviewer ? (
          branchGroups.length ? (
            <div className="branch-review-queue">
              {branchGroups.map(group => {
                return (
                  <article className="branch-review-card" key={group.id}>
                    <div className="branch-review-header">
                      <div>
                        <h3>{group.name}</h3>
                        <p>LocationCode: {group.code} · จังหวัด: {group.province} · {group.tasks.length} เครื่อง</p>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        {group.isOverdue && (
                          <span className="overdue-sla-badge">
                            <AlertTriangle size={12} /> เกินกำหนด SLA 2 วันทำการ
                          </span>
                        )}
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => handleOpenBatchAccept(group)}
                        >
                          <ShieldCheck size={15} /> ตรวจรับทั้งสาขา ({group.tasks.length} เครื่อง)
                        </button>
                      </div>
                    </div>

                    <div className="branch-review-scanners">
                      {group.tasks.map(task => {
                        const taskId = String(task.task_id || task.id)
                        const isChecked = selectedTaskIds.includes(taskId)

                        return (
                          <div className="branch-review-scanner-item" key={taskId}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => handleToggleSelectTask(taskId)}
                              />
                              <div className="branch-review-scanner-info">
                                <strong>SN เดิม: {String(task.com_sn || task.serial || '—')} → SN ใหม่: {String(task.new_serial_number || '—')}</strong>
                                <span>รุ่น: {String(task.model_name || task.model || 'Scanner')} · ผล: {String(task.outcome || 'replaced')}</span>
                              </div>
                            </label>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <button
                                type="button"
                                className="secondary-button"
                                style={{ padding: '4px 10px', fontSize: '12px' }}
                                onClick={() => handleOpenEvidence(task)}
                              >
                                ดูรูปหลักฐาน
                              </button>
                              <button
                                type="button"
                                className="secondary-button"
                                style={{ padding: '4px 10px', fontSize: '12px', color: '#b91c1c' }}
                                onClick={() => setRejectingTask(task)}
                              >
                                ปฏิเสธ
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <EmptyState compact title="ไม่มีงานที่รอตรวจรับมอบ" detail="เมื่อ SYM Admin ตรวจรับงานแล้ว งานจะเข้ามาที่คิวตรวจรับของ Gable" />
          )
        ) : (
          tasks.length ? (
            <div className="pending-review-list">
              {tasks.map(task => {
                const taskId = String(task.task_id || task.id)
                const serial = String(task.com_sn || task.serial || 'ไม่ระบุ')
                const newSerial = String(task.new_serial_number || '—')

                return (
                  <article className="pending-review-row" key={taskId}>
                    <div className="pending-review-main">
                      <div className="pending-review-title">
                        <strong>{String(task.branch_name || task.loc_bld || 'สาขา')} · SN เดิม {serial} → ใหม่ {newSerial}</strong>
                        <StatusPill label={String(task.task_status || task.status || 'รอตรวจ')} tone="orange" />
                      </div>
                      <span>จังหวัด{String(task.province || '—')} · LocationCode {String(task.location_code || '—')}</span>
                      <small>
                        ช่าง: {String(task.started_by || '—')} · ส่งเมื่อ {task.closeout_submitted_at ? formatDate(task.closeout_submitted_at) : '—'}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setSelectedAdminTask(task)
                        void handleOpenEvidence(task)
                      }}
                    >
                      เปิดตรวจหลักฐานและพิจารณา <ArrowRight size={14} />
                    </button>
                  </article>
                )
              })}
            </div>
          ) : (
            <EmptyState compact title="ไม่มีงานที่รอตรวจ" detail="เมื่อช่างส่งผล Onsite ปิดงาน รายการจะเข้ามาแสดงที่นี่" />
          )
        )}
      </section>

      {/* Modal: Batch Acceptance by Gable */}
      {batchBranch && (
        <div className="handover-modal-backdrop" onClick={() => setBatchBranch(null)}>
          <div className="handover-modal-content" style={{ maxWidth: '600px' }} onClick={e => e.stopPropagation()}>
            <div className="handover-modal-bar">
              <strong>ตรวจรับมอบงานแบบรวมทั้งสาขา (Batch Accept)</strong>
              <button type="button" className="icon-button" onClick={() => setBatchBranch(null)}>
                <X size={16} />
              </button>
            </div>
            <div style={{ padding: '20px' }}>
              <div style={{ marginBottom: '16px' }}>
                <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>{batchBranch.name}</h3>
                <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
                  LocationCode: {batchBranch.code} · กำลังตรวจรับจำนวน {selectedTaskIds.length} เครื่อง
                </p>
              </div>

              <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', marginBottom: '16px', fontSize: '12px' }}>
                ข้าพเจ้าในฐานะตัวแทน บมจ. จีเอเบิล (G-Able) ได้ตรวจสอบผลงานและหลักฐานการเปลี่ยนเครื่องสแกนเนอร์ของสาขานี้แล้ว ขอลงนามตรวจรับมอบงานเข้าสู่สถานะส่งมอบสมบูรณ์ (Delivered)
              </div>

              <div style={{ marginBottom: '12px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
                  ลายเซ็นผู้ตรวจรับมอบงาน (Gable Representative)
                </span>
                <SignaturePad ref={sigPadRef} disabled={submitting} label="ช่องลายเซ็นผู้ตรวจรับมอบงาน" />
                <div style={{ marginTop: '6px' }}>
                  <button type="button" className="text-button" onClick={() => sigPadRef.current?.clear()}>
                    ล้างลายเซ็น
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '20px' }}>
                <button type="button" className="secondary-button" onClick={() => setBatchBranch(null)} disabled={submitting}>
                  ยกเลิก
                </button>
                <button type="button" className="primary-button" onClick={handleConfirmBatchAccept} disabled={submitting}>
                  {submitting ? 'กำลังบันทึก…' : `ยืนยันตรวจรับทั้ง ${selectedTaskIds.length} เครื่อง`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Rejection Reason */}
      {rejectingTask && (
        <div className="handover-modal-backdrop" onClick={() => setRejectingTask(null)}>
          <div className="handover-modal-content" style={{ maxWidth: '500px' }} onClick={e => e.stopPropagation()}>
            <div className="handover-modal-bar">
              <strong>ระบุเหตุผลการปฏิเสธงาน (Reject)</strong>
              <button type="button" className="icon-button" onClick={() => setRejectingTask(null)}>
                <X size={16} />
              </button>
            </div>
            <div style={{ padding: '20px' }}>
              <p style={{ margin: '0 0 10px', fontSize: '13px', color: '#475569' }}>
                ใบงานจะถูกส่งกลับไปให้ช่างแก้ไขหน้างานโดยตรง โปรดระบุข้อบกพร่องที่ต้องแก้ไข:
              </p>
              <textarea
                style={{ width: '100%', minHeight: '100px', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '10px', fontSize: '13px' }}
                placeholder="เช่น ภาพถ่ายหมายเลข Serial ไม่ชัดเจน หรือไม่ได้เดินสายแบบไส้ไก่ตามมาตรฐาน"
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
              />
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px' }}>
                <button type="button" className="secondary-button" onClick={() => setRejectingTask(null)} disabled={submitting}>
                  ยกเลิก
                </button>
                <button
                  type="button"
                  className="primary-button"
                  style={{ background: '#b91c1c' }}
                  onClick={handleConfirmReject}
                  disabled={submitting || !rejectReason.trim()}
                >
                  {submitting ? 'กำลังส่งกลับ…' : 'ยืนยันปฏิเสธและส่งกลับช่าง'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Evidence Preview & SYM Admin Verify */}
      {(viewingEvidenceTask || selectedAdminTask) && (
        <div
          className="handover-modal-backdrop"
          onClick={() => {
            setViewingEvidenceTask(null)
            setSelectedAdminTask(null)
          }}
        >
          <div className="handover-modal-content" style={{ maxWidth: '720px' }} onClick={e => e.stopPropagation()}>
            <div className="handover-modal-bar">
              <strong>รายละเอียดหลักฐานหน้างาน</strong>
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  setViewingEvidenceTask(null)
                  setSelectedAdminTask(null)
                }}
              >
                <X size={16} />
              </button>
            </div>
            <div style={{ padding: '20px' }}>
              {(() => {
                const currentTask = selectedAdminTask || viewingEvidenceTask!
                return (
                  <>
                    <div style={{ background: '#f8fafc', padding: '14px', borderRadius: '6px', marginBottom: '18px', fontSize: '13px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                        <div><strong>สาขา:</strong> {String(currentTask.branch_name || currentTask.loc_bld || '—')}</div>
                        <div><strong>LocationCode:</strong> {String(currentTask.location_code || '—')}</div>
                        <div><strong>SN เดิม:</strong> {String(currentTask.com_sn || currentTask.serial || '—')}</div>
                        <div><strong>SN ใหม่:</strong> {String(currentTask.new_serial_number || '—')}</div>
                        <div><strong>ผลการเปลี่ยน:</strong> {String(currentTask.outcome || '—')}</div>
                        <div><strong>หมายเหตุ:</strong> {String(currentTask.notes || '—')}</div>
                      </div>
                    </div>

                    <h4 style={{ margin: '0 0 10px', fontSize: '14px' }}>รูปถ่ายหลักฐาน 10 รูป & ลายเซ็น</h4>
                    {evidenceLoading ? (
                      <div style={{ padding: '30px', textAlign: 'center' }}>กำลังโหลดหลักฐาน…</div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '10px', marginBottom: '20px' }}>
                        {evidenceList.map((ev, i) => (
                          <div key={ev.id || i} style={{ border: '1px solid #e2e8f0', borderRadius: '6px', overflow: 'hidden', textAlign: 'center', fontSize: '11px', background: '#fafafa' }}>
                            <div style={{ height: '90px', background: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <img
                                src={`/api/evidence/${ev.storage_path}`}
                                alt={ev.evidence_type}
                                style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'cover' }}
                                onError={e => {
                                  (e.target as HTMLElement).style.display = 'none'
                                }}
                              />
                              <span style={{ fontSize: '10px', color: '#64748b' }}>{ev.evidence_type}</span>
                            </div>
                            <div style={{ padding: '4px' }}>{ev.evidence_type}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {selectedAdminTask && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #e2e8f0', paddingTop: '16px' }}>
                        <button
                          type="button"
                          className="secondary-button"
                          style={{ color: '#b91c1c' }}
                          onClick={() => {
                            setRejectingTask(selectedAdminTask)
                            setSelectedAdminTask(null)
                          }}
                        >
                          ปฏิเสธ / ส่งกลับช่าง
                        </button>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={submitting}
                          onClick={() => handleSymPass(selectedAdminTask)}
                        >
                          <CheckCircle2 size={16} /> ตรวจผ่าน (ส่งต่อ Gable)
                        </button>
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function WorkOrders({ role, demo, onUpdated, view = 'all' }: { role?: string; demo: boolean; onUpdated: (action: string) => void; view?: 'all' | 'completed' }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(!demo)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [totalOrders, setTotalOrders] = useState(0)
  const [reload, setReload] = useState(0)
  const [selectedTask, setSelectedTask] = useState<Record<string, unknown> | null>(null)
  const pageSize = 25
  const completedView = view === 'completed'

  useEffect(() => {
    if (demo) return
    let active = true
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const res = await d1Api.getScanners({
          search: query || undefined,
          status: completedView ? 'complete' : undefined,
          limit: pageSize,
          offset: page * pageSize,
        })
        if (!active) return
        setRows(res.rows)
        setTotalOrders(res.total)
      } catch {
        if (!active) return
        setRows([]); setTotalOrders(0); setError('โหลดใบงานจาก Cloudflare D1 ไม่สำเร็จ')
      } finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [completedView, demo, page, query, reload])

  const demoRows: Array<Record<string, unknown>> = demoTasks.map((item, index) => ({
    id: `demo-${index}`, branch_name: item.branch, province: item.province, location_code: item.code,
    scanner_model: item.model, com_sn: item.serial, workflow_stage: item.status === 'Pending' ? 'awaiting_admin_exception_review' : item.status === 'กำลังติดตั้ง' ? 'in_progress' : 'open',
    work_order_code: `DEMO-${String(index + 1).padStart(3, '0')}`, created_at: null,
  }))
  const displayRows = demo
    ? completedView ? demoRows.filter(row => ['delivered', 'exception_resolved', 'legacy_completed'].includes(getTaskWorkflowStage(row))) : demoRows
    : rows
  const pageCount = demo ? 1 : Math.ceil(totalOrders / pageSize)
  const submitSearch = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setPage(0); setQuery(draft.trim()) }

  return <>
    <section className="panel pending-review-panel">
      <div className="panel-heading"><div><h2>{completedView ? 'ใบงานที่เสร็จแล้ว' : 'ใบงานทุกสถานะ'}</h2><p>{completedView ? 'รายการที่ส่งมอบแล้วหรือ Admin ปิดผลแล้ว เลือกเพื่อดูหลักฐานและประวัติย้อนหลัง' : 'เลือกใบงานเพื่อดู SN รูปภาพ ลายเซ็น และประวัติการดำเนินงาน'}</p></div><span className="pending-review-count">{demo ? displayRows.length.toLocaleString('th-TH') : totalOrders.toLocaleString('th-TH')} ใบงาน</span></div>
      <form className="pending-review-search" onSubmit={submitSearch}><label className="search-box"><Search size={17} /><input value={draft} onChange={event => setDraft(event.target.value)} placeholder="ค้นหาใบงาน สาขา จังหวัด หรือ Serial" aria-label="ค้นหาใบงาน" /></label><button type="submit" className="secondary-button">ค้นหา</button><button type="button" className="text-button" disabled={loading || demo} onClick={() => setReload(value => value + 1)}>รีเฟรช</button></form>
      {loading ? <EmptyState compact loading /> : error ? <EmptyState compact title="โหลดใบงานไม่สำเร็จ" detail={error} onRetry={() => setReload(value => value + 1)} /> : displayRows.length ? <div className="pending-review-list">{displayRows.map((row, index) => {
        const id = String(row.id || row.task_id || `${row.work_order_code || 'order'}-${index}`)
        const status = getStatusPresentation(getTaskWorkflowStage(row))
        const serial = String(row.com_sn || row.serial || row.old_serial_snapshot || 'ไม่พบ Serial')
        return <article className="pending-review-row" key={id}>
          <div className="pending-review-main"><div className="pending-review-title"><strong>{String(row.branch_name || 'สาขาไม่ระบุ')} · SN {serial}</strong><StatusPill label={status.label} tone={status.tone} /></div><span>{String(row.scanner_model || 'Scanner')} · จังหวัด{String(row.province || 'ไม่ระบุ')} · LocationCode {String(row.location_code || '—')}</span><small>ใบงาน {String(row.work_order_code || '—')} · {row.performed_by_name ? `ผู้ปฏิบัติงาน ${String(row.performed_by_name)}` : 'ยังไม่มีผู้ส่งผล'} · {row.performed_at ? formatDate(row.performed_at) : formatDate(row.created_at)}</small></div>
          <button type="button" className="secondary-button" onClick={() => { if (!demo) setSelectedTask(row) }} disabled={demo}>เปิดรายละเอียด <ArrowRight size={14} /></button>
        </article>
      })}</div> : <EmptyState compact title={completedView ? 'ยังไม่มีใบงานที่เสร็จแล้ว' : 'ยังไม่มีใบงาน'} detail={query ? 'ไม่พบใบงานที่ตรงกับคำค้นหา' : completedView ? 'งานจะแสดงที่นี่เมื่อส่งมอบแล้วหรือ Admin ปิดผลเรียบร้อย' : 'ใบงานที่เปิดแล้วจะแสดงที่นี่'} />}
      {!demo && !loading && !error && pageCount > 1 && <div className="list-footer"><span>หน้า {page + 1} จาก {pageCount} · {totalOrders.toLocaleString('th-TH')} ใบงาน</span><div><button type="button" className="icon-button" aria-label="หน้าก่อนหน้า" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))}><ChevronLeft size={16} /></button><span className="page-number">{page + 1}</span><button type="button" className="icon-button" aria-label="หน้าถัดไป" disabled={page + 1 >= pageCount} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}><ChevronRight size={16} /></button></div></div>}
    </section>
    {selectedTask && <WorkOrderDetailDialog task={selectedTask} role={role} demo={false} onClose={() => { setSelectedTask(null); setReload(value => value + 1) }} onUpdated={action => { setReload(value => value + 1); onUpdated(action) }} />}
  </>
}

function useDialogControls(onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const releaseBodyScroll = lockBodyScroll()
    const unregisterDialog = registerActiveDialog(dialogRef.current)
    const focusableSelector = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) || [])
    const handleKeys = (event: KeyboardEvent) => {
      if (!isTopmostActiveDialog(dialogRef.current)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeys)
    const focusFrame = window.requestAnimationFrame(() => focusables()[0]?.focus())
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleKeys)
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
  return dialogRef
}

function DetailField({ label, value }: { label: string; value: unknown }) {
  const text = String(value ?? '').trim()
  return <div className="detail-field"><span>{label}</span><strong>{text || '—'}</strong></div>
}

const ignoreEvidenceState = () => undefined

function AssetDetailDialog({ asset, role, demo, onClose, onUpdated }: { asset: Record<string, unknown>; role?: string; demo: boolean; onClose: () => void; onUpdated: (action: string) => void }) {
  const dialogRef = useDialogControls(onClose)
  const serial = asset.serial || asset.com_sn || '—'
  const model = asset.model || asset.model_name || asset.hw_name || 'เครื่องสแกน'
  const branch = asset.branch || asset.branch_name || asset.loc_bld || 'สาขาไม่ระบุ'
  const code = asset.code || asset.location_code || '—'
  const status = asset.status ? getStatusPresentation(asset.status) : { label: 'ยังไม่เลือก', tone: 'neutral' }
  const assetId = String(asset.id || '')
  const canViewHistory = !demo && ['admin', 'field_technician'].includes(String(role))
  const [workHistory, setWorkHistory] = useState<Array<Record<string, unknown>>>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyRetry, setHistoryRetry] = useState(0)
  const [selectedHistoryTaskId, setSelectedHistoryTaskId] = useState('')
  const [startingWork, setStartingWork] = useState(false)
  const [startError, setStartError] = useState('')
  const [selectedWorkTask, setSelectedWorkTask] = useState<Record<string, unknown> | null>(null)
  const pendingOpenTaskId = useRef('')
  useEffect(() => {
    let active = true
    if (!canViewHistory) {
      setWorkHistory([])
      setSelectedHistoryTaskId('')
      setHistoryLoading(false)
      setHistoryError('')
      return () => { active = false }
    }
    setHistoryLoading(true)
    setHistoryError('')
    void (async () => {
      try {
        const branchId = String(asset?.branch_id || '')
        const branchRes = branchId ? await d1Api.getBranchDetail(branchId) : null
        const found = branchRes?.scanners.find(s => s.scanner_id === assetId || s.com_sn === asset?.com_sn)
        if (!active) return
        if (found && found.task_id) {
          const row: Record<string, unknown> = {
            id: found.task_id,
            task_id: found.task_id,
            status: found.task_status,
            task_status: found.task_status,
            workflow_outcome: found.outcome,
            outcome: found.outcome,
            new_serial_number: found.new_serial_number,
            observed_serial: found.observed_serial,
            started_at: found.started_at,
            started_by: found.started_by,
            closeout_submitted_at: found.closeout_submitted_at,
            admin_accepted_at: found.admin_accepted_at,
            customer_accepted_at: found.customer_accepted_at,
            customer_rejected_at: found.customer_rejected_at,
            customer_reject_reason: found.customer_reject_reason,
            version: found.version || 1,
          }
          setWorkHistory([row])
          setSelectedHistoryTaskId(found.task_id)
          if (pendingOpenTaskId.current === found.task_id) {
            setSelectedWorkTask(row)
            pendingOpenTaskId.current = ''
          }
        } else {
          setWorkHistory([])
          setSelectedHistoryTaskId('')
        }
      } catch {
        if (!active) return
        setWorkHistory([])
        setSelectedHistoryTaskId('')
        setHistoryError('โหลดประวัติการเปลี่ยนไม่สำเร็จ')
      } finally {
        if (active) setHistoryLoading(false)
      }
    })()
    return () => { active = false }
  }, [asset?.branch_id, asset?.com_sn, assetId, canViewHistory, historyRetry])
  const selectedHistoryTask = workHistory.find(task => String(task.id || '') === selectedHistoryTaskId) || null
  const selectedHistoryOutcome = String(selectedHistoryTask?.workflow_outcome || '')
  const selectedHistoryStage = selectedHistoryTask ? getTaskWorkflowStage(selectedHistoryTask) : ''
  const selectedHistoryEvidenceOutcome = selectedHistoryOutcome || (['open', 'scheduled', 'awaiting_confirmation', 'confirmed', 'in_progress', 'blocked', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review'].includes(selectedHistoryStage) ? 'replaced' : '')
  const selectedHistoryNeedsAdminSignoff = Boolean(selectedHistoryTask?.admin_accepted_at) || ['awaiting_admin_acceptance', 'awaiting_admin_exception_review'].includes(selectedHistoryStage)
  const activeWorkTask = workHistory.find(task => ['scheduled', 'in_progress', 'blocked'].includes(String(task.task_status || '').toLowerCase())) || null
  const startScannerWork = async () => {
    setStartError('')
    if (demo || !assetId || startingWork) return
    setStartingWork(true)
    try {
      const res = await d1Api.startScannerWork(assetId)
      pendingOpenTaskId.current = res.task_id
      setHistoryRetry(value => value + 1)
      onUpdated('start')
    } catch (err: any) {
      setStartError(err?.message || 'เชื่อมต่อระบบไม่ได้ โปรดตรวจสถานะ Scanner ก่อนลองอีกครั้ง')
      setHistoryRetry(value => value + 1)
    } finally { setStartingWork(false) }
  }
  return <div className="detail-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !selectedWorkTask) onClose() }}>
    <section ref={dialogRef} className="detail-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-detail-title" tabIndex={-1} inert={Boolean(selectedWorkTask)}>
      <header className="detail-dialog-header"><button type="button" className="detail-back" aria-label="กลับไปทะเบียนอุปกรณ์" onClick={onClose}><ChevronLeft size={20} /></button><div><span className="detail-eyebrow">ทะเบียนอุปกรณ์</span><h2 id="asset-detail-title">รายละเอียด Scanner</h2></div><button type="button" className="detail-close" aria-label="ปิดรายละเอียด" onClick={onClose}><X size={18} /></button></header>
      <div className="detail-status-line"><span className="detail-status-dot" /><strong>{String(model)}</strong><StatusPill label={asset.tone ? String(asset.status || status.label) : status.label} tone={String(asset.tone || status.tone)} /></div>
          <section className="detail-section"><div className="scanner-detail-title-row"><h3>ข้อมูลอุปกรณ์</h3>{canViewHistory && (activeWorkTask
            ? <button type="button" className="primary-button" onClick={() => setSelectedWorkTask(activeWorkTask)}>เปิดงานที่กำลังทำ <ArrowRight size={15} /></button>
            : <button type="button" className="primary-button" disabled={startingWork} onClick={() => void startScannerWork()}>{startingWork ? 'กำลังเริ่มงาน…' : 'เริ่มงานกับ Scanner นี้'}</button>)}</div><div className="detail-grid"><DetailField label="Serial Number" value={serial} /><DetailField label="รุ่น" value={model} /><DetailField label="สาขา" value={branch} /><DetailField label="LocationCode" value={code} /><DetailField label="จังหวัด" value={asset.province} /><DetailField label="ปีข้อมูลเดิม" value={asset.year || asset.com_years} /></div>{startError && <div className="task-action-error" role="alert">{startError}</div>}</section>
      <section className="detail-section"><h3>ประวัติการเปลี่ยน Scanner</h3>
        {!canViewHistory ? <p className="detail-empty-result">ประวัติการปฏิบัติงานดูได้โดย Admin และช่างภาคสนาม</p>
          : historyLoading ? <p className="evidence-status" role="status">กำลังโหลดผู้ปฏิบัติงานและประวัติใบงาน…</p>
            : historyError ? <div className="task-action-error" role="alert">{historyError} <button type="button" className="text-button" onClick={() => setHistoryRetry(value => value + 1)}>ลองอีกครั้ง</button></div>
              : workHistory.length ? <>
                <div className="scanner-history-list">{workHistory.map((task, index) => {
                  const taskId = String(task.id || '')
                  const stage = getStatusPresentation(task.workflow_stage || task.task_status)
                  return <button type="button" className={'scanner-history-row' + (selectedHistoryTaskId === taskId ? ' is-selected' : '')} aria-pressed={selectedHistoryTaskId === taskId} key={taskId || index} onClick={() => setSelectedHistoryTaskId(taskId)}>
                    <span className="scanner-history-heading"><strong>{String(task.performed_by_name || 'ยังไม่มีผู้ปฏิบัติงานที่บันทึกผล')}</strong><StatusPill label={stage.label} tone={stage.tone} /></span>
                    <span>SN เดิม: {String(task.old_serial_snapshot || task.com_sn || '—')} · SN ใหม่: {String(task.new_serial || 'ยังไม่บันทึก')}</span>
                    <small>{task.performed_at ? `ปฏิบัติงาน ${formatDate(task.performed_at)}` : 'ยังไม่มีวันปฏิบัติงานบันทึกไว้'} · {String(task.branch_name || branch)}</small>
                  </button>
                })}</div>
                {selectedHistoryTask && <>
                  <section className="detail-section scanner-work-detail">
                    <div className="scanner-work-detail-heading"><div><h3>รายละเอียดงานที่เข้าไปเปลี่ยน</h3><p>ผลปฏิบัติงานของ Scanner ในใบงานนี้</p></div><StatusPill label={getStatusPresentation(selectedHistoryTask.workflow_stage || selectedHistoryTask.task_status).label} tone={getStatusPresentation(selectedHistoryTask.workflow_stage || selectedHistoryTask.task_status).tone} /></div>
                    <div className="detail-grid scanner-work-detail-grid">
                      <DetailField label="เปิดใบงานเมื่อ" value={formatDate(selectedHistoryTask.created_at)} />
                      <DetailField label="SN เดิมตามทะเบียน" value={selectedHistoryTask.old_serial_snapshot || selectedHistoryTask.com_sn || serial} />
                      <DetailField label="SN เครื่องใหม่" value={selectedHistoryTask.new_serial || (['no_damage_found', 'different_device_found', 'target_device_not_found'].includes(String(selectedHistoryTask.workflow_outcome || '')) ? 'ไม่มีการเปลี่ยนเครื่อง' : 'ยังไม่บันทึก')} />
                      <DetailField label="ผลที่พบหน้างาน" value={selectedHistoryTask.workflow_outcome ? getStatusPresentation(selectedHistoryTask.workflow_outcome).label : 'ยังไม่บันทึกผลหน้างาน'} />
                      <DetailField label="SN ของเครื่องที่พบ" value={selectedHistoryTask.observed_serial} />
                      <DetailField label="รุ่นของเครื่องที่พบ" value={selectedHistoryTask.observed_model} />
                      <DetailField label="ผลติดตั้งและทดสอบ" value={selectedHistoryTask.install_result} />
                      <DetailField label="สถานะเครื่องเดิม" value={oldScannerStatusLabel(selectedHistoryTask.old_scanner_status)} />
                      <DetailField label="ผู้ปฏิบัติงาน" value={selectedHistoryTask.performed_by_name || 'ยังไม่มีผู้ปฏิบัติงานที่บันทึกผล'} />
                      <DetailField label="วันและเวลาที่ปฏิบัติงาน" value={formatDate(selectedHistoryTask.performed_at) || 'ยังไม่มีเวลาบันทึก'} />
                      <DetailField label="เหตุผล/หมายเหตุ" value={[selectedHistoryTask.exception_reason, selectedHistoryTask.old_scanner_note].map(value => String(value || '').trim()).filter(Boolean).join(' · ')} />
                    </div>
                  </section>
                  <TaskEvidencePanel key={String(selectedHistoryTask.id)} taskId={String(selectedHistoryTask.id)} canEdit={false} canView={canViewHistory} requiredSlots={[...requiredEvidenceSlotsForOutcome(selectedHistoryEvidenceOutcome), ...(selectedHistoryNeedsAdminSignoff ? ['inspector_signature' as const] : [])]} outcome={selectedHistoryEvidenceOutcome} onRequiredReady={ignoreEvidenceState} onBusyChange={ignoreEvidenceState} />
                </>}
              </>
                : <p className="detail-empty-result">ยังไม่มีประวัติการเปลี่ยนเครื่องหรือหลักฐานสำหรับ Scanner นี้</p>}
      </section>
      <div className="detail-readonly-note"><ShieldCheck size={16} /><span>แสดงข้อมูลทะเบียน ประวัติ รูปภาพ และลายเซ็นของ Scanner เครื่องนี้</span></div>
    </section>
    {selectedWorkTask && <WorkOrderDetailDialog task={selectedWorkTask} role={role} demo={demo} onClose={() => { setSelectedWorkTask(null); setHistoryRetry(value => value + 1) }} onUpdated={action => { setHistoryRetry(value => value + 1); onUpdated(action) }} />}
  </div>
}

const onsiteEvidenceSlots: EvidenceSlot[] = [
  'old_serial_photo', 'old_device_photo', 'old_condition_photo', 'old_branch_sticker_photo',
  'new_serial_photo', 'new_front_photo', 'new_side_photo', 'new_com_serial_photo', 'new_device_photo', 'new_cable_management_photo',
  'spare_photo_1', 'spare_photo_2',
  'technician_signature', 'scanner_user_signature',
]
const adminReviewEvidenceSlots: EvidenceSlot[] = ['inspector_signature']

function WorkOrderDetailDialog({ task, role, demo, readOnly = false, onClose, onUpdated }: { task: Record<string, unknown>; role?: string; demo: boolean; readOnly?: boolean; onClose: () => void; onUpdated: (action: string) => void }) {
  const status = String(task.task_status || task.status || 'scheduled').toLowerCase()
  const rawServerStage = String(task.workflow_stage || (demo ? getTaskWorkflowStage(task) : status === 'scheduled' ? 'open' : status === 'completed' ? 'legacy_completed' : status)).toLowerCase()
  const serverStage = ['open', 'scheduled', 'awaiting_confirmation', 'confirmed'].includes(rawServerStage) ? 'in_progress' : rawServerStage
  const taskId = String(task.id || '').trim()
  const [evidenceStartedTask, setEvidenceStartedTask] = useState<{ id: string; version: number } | null>(null)
  const stage = serverStage
  const presentation = getStatusPresentation(stage)
  const serial = task.old_serial_snapshot || task.serial || task.com_sn || '—'
  const newSerial = task.new_serial
  const installResult = task.install_result
  const recordedOldStatus = task.old_scanner_status
  const outcome = String(task.workflow_outcome || '')
  const exceptionReason = task.exception_reason
  const observedSerial = task.observed_serial
  const oldStatusLabels: Record<string, string> = {
    returned_usable: 'ส่งคืนในสภาพใช้งานได้',
    returned_damaged: 'ส่งคืนในสภาพชำรุด',
    sent_for_repair: 'ส่งซ่อม',
    not_returned: 'ยังไม่ส่งคืน',
    lost: 'สูญหาย',
    other: 'อื่น ๆ',
  }
  const isPendingStage = ['blocked', 'pending', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review'].includes(stage)
  const currentStep = stage === 'open' ? 0
    : stage === 'in_progress' ? 1
    : ['blocked', 'pending', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review'].includes(stage) ? 2
    : ['delivered', 'exception_resolved', 'legacy_completed', 'completed'].includes(stage) ? 3 : -1
  const canAct = !demo && !readOnly && ['field_technician', 'admin'].includes(String(role))
  const canManage = !demo && !readOnly && role === 'admin' && !['completed', 'cancelled'].includes(status)
  const isPendingReview = canManage && ['awaiting_admin_acceptance', 'awaiting_admin_exception_review'].includes(stage)
  const canResolvePending = isPendingReview && (task.can_resolve_pending === true || task.can_admin_accept === true)
  const canEditTechnicianEvidence = canAct && ['open', 'in_progress'].includes(stage)
  const editableSlots = useMemo<EvidenceSlot[]>(() => canResolvePending
    ? adminReviewEvidenceSlots
    : canEditTechnicianEvidence ? onsiteEvidenceSlots : [], [canResolvePending, canEditTechnicianEvidence])
  const [outcomeInput, setOutcomeInput] = useState('replaced')
  const fieldRequiredSlots = requiredEvidenceSlotsForOutcome(outcome || outcomeInput)
  const stageRequiredSlots: EvidenceSlot[] = canResolvePending
    ? [...fieldRequiredSlots, 'inspector_signature']
    : fieldRequiredSlots
  const [busy, setBusy] = useState(false)
  const [evidenceBusy, setEvidenceBusy] = useState(false)
  const [requiredEvidenceReady, setRequiredEvidenceReady] = useState(false)
  const [actionError, setActionError] = useState('')
  const [showBlockForm, setShowBlockForm] = useState(false)
  const [showCancelForm, setShowCancelForm] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [blockReason, setBlockReason] = useState('')
  const [newSerialInput, setNewSerialInput] = useState('')
  const [observedSerialInput, setObservedSerialInput] = useState('')
  const [observedModelInput, setObservedModelInput] = useState('')
  const [exceptionReasonInput, setExceptionReasonInput] = useState('')
  const [installResultInput, setInstallResultInput] = useState('')
  const [oldStatusInput, setOldStatusInput] = useState('')
  const [oldStatusNote, setOldStatusNote] = useState('')
  const [registerObservedSerial, setRegisterObservedSerial] = useState(false)
  const closeIfIdle = useCallback(() => { if (!busy && !evidenceBusy) onClose() }, [busy, evidenceBusy, onClose])
  const dialogRef = useDialogControls(closeIfIdle)
  const serverVersion = Number(task.version)
  const version = evidenceStartedTask?.id === taskId && Number.isInteger(evidenceStartedTask.version)
    ? Math.max(serverVersion, evidenceStartedTask.version)
    : serverVersion
  const validTaskVersion = Boolean(taskId) && Number.isInteger(version) && version > 0
  const canViewEvidence = !demo && ['admin', 'field_technician'].includes(String(role))

  const submitAction = async (action: 'start' | 'block' | 'resume', reason?: string) => {
    setActionError('')
    if (!validTaskVersion) {
      setActionError('เชื่อมต่อระบบไม่ได้หรือข้อมูลใบงานล้าสมัย โปรดปิดแล้วเปิดใบงานใหม่')
      return
    }
    setBusy(true)
    try {
      await d1Api.taskAction(taskId, action, reason, version)
      onUpdated(action)
      onClose()
    } catch (err: any) {
      setActionError(err?.message || 'การเชื่อมต่อขาดช่วง โปรดตรวจสถานะใบงานก่อนลองใหม่')
      onUpdated('refresh')
    } finally { setBusy(false) }
  }

  const submitBlock = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const reason = blockReason.trim()
    if (!reason || reason.length > 500) { setActionError('กรอกเหตุผลไม่เกิน 500 ตัวอักษร'); return }
    void submitAction('block', reason)
  }

  const submitCloseout = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setActionError('')
    if (!validTaskVersion) { setActionError('เชื่อมต่อระบบไม่ได้หรือข้อมูลใบงานล้าสมัย โปรดโหลดใบงานใหม่'); return }
    if (!requiredEvidenceReady) { setActionError('บันทึกรูปหลักฐานและลายเซ็นที่จำเป็นให้ครบก่อนส่งผลปิดงาน'); return }
    const cleanSerial = newSerialInput.trim()
    const cleanObserved = observedSerialInput.trim()
    const cleanReason = exceptionReasonInput.trim()
    const cleanResult = installResultInput.trim()
    const cleanOldNote = oldStatusNote.trim()
    if (!cleanResult || cleanResult.length > 500) { setActionError('กรอกผลการตรวจสอบไม่เกิน 500 ตัวอักษร'); return }
    if (outcomeInput === 'replaced') {
      if (!cleanSerial || cleanSerial.length > 100 || !oldStatusInput || (oldStatusInput === 'other' && !cleanOldNote) || cleanOldNote.length > 1000) {
        setActionError('กรอก Serial เครื่องใหม่และสถานะเครื่องเดิมให้ครบ'); return
      }
    } else if (outcomeInput === 'no_damage_found') {
      if (!cleanReason || cleanReason.length > 1000) { setActionError('อธิบายเหตุผลที่ไม่พบเครื่องชำรุด'); return }
    } else if (outcomeInput === 'different_device_found') {
      if (!cleanObserved || cleanObserved.length > 100 || !cleanReason || cleanReason.length > 1000) { setActionError('กรอก Serial ของเครื่องที่พบและอธิบายความแตกต่าง'); return }
    } else if (!cleanReason || cleanReason.length > 1000) {
      setActionError('อธิบายเหตุผลที่ไม่พบเครื่องเป้าหมาย'); return
    }
    setBusy(true)
    try {
      await d1Api.submitCloseout(taskId, {
        new_serial_number: cleanSerial || undefined,
        observed_serial: cleanObserved || undefined,
        notes: cleanResult || cleanReason || undefined,
        outcome: outcomeInput,
        version: version,
      })
      onUpdated('closeout_pending')
      onClose()
    } catch (err: any) {
      setActionError(err?.message || 'ยังยืนยันผลส่งปิดงานไม่ได้ โปรดโหลดสถานะล่าสุดก่อนลองซ้ำ')
      onUpdated('refresh')
    } finally { setBusy(false) }
  }

  const resolvePending = async () => {
    setActionError('')
    if (!validTaskVersion) { setActionError('เชื่อมต่อระบบไม่ได้หรือข้อมูลใบงานล้าสมัย โปรดเปิดใบงานใหม่'); return }
    if (!requiredEvidenceReady) { setActionError('ตรวจหลักฐานและลงลายเซ็นผู้ตรวจรับให้ครบก่อนปิดรายการ'); return }
    setBusy(true)
    try {
      await d1Api.symVerify(taskId, 'pass', undefined, version)
      onUpdated(outcome === 'replaced' ? 'accept' : 'resolve_exception')
      onClose()
    } catch (err: any) {
      setActionError(err?.message || 'บันทึกผลตรวจสอบไม่ได้ โปรดโหลดสถานะล่าสุดก่อนลองซ้ำ')
      onUpdated('refresh')
    } finally { setBusy(false) }
  }

  const submitCancel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const reason = cancelReason.trim()
    if (!reason || reason.length > 500 || !validTaskVersion) {
      setActionError('กรอกเหตุผล 1–500 ตัวอักษร แล้วโหลดใบงานล่าสุดก่อนยืนยัน'); return
    }
    setBusy(true)
    setActionError('')
    try {
      await d1Api.taskAction(taskId, 'cancel', reason, version)
      onUpdated('cancel')
      onClose()
    } catch (err: any) {
      setActionError(err?.message || 'การเชื่อมต่อขาดช่วง โปรดตรวจสถานะใบงานก่อนลองยกเลิกซ้ำ')
      onUpdated('refresh')
    } finally { setBusy(false) }
  }

  const isReplacement = outcomeInput === 'replaced'
  const canEditEvidence = canEditTechnicianEvidence || canResolvePending
  return <div className="detail-overlay work-order-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeIfIdle() }}>
    <section ref={dialogRef} className="detail-dialog work-order-dialog" role="dialog" aria-modal="true" aria-labelledby="work-order-title" tabIndex={-1}>
      <header className="detail-dialog-header"><button type="button" className="detail-back" aria-label="กลับไปรายการใบงาน" disabled={busy || evidenceBusy} onClick={closeIfIdle}><ChevronLeft size={20} /></button><div><span className="detail-eyebrow">รายการ Scanner ในใบงาน</span><h2 id="work-order-title">รายละเอียดการเปลี่ยนเครื่อง</h2></div><button type="button" className="detail-close" aria-label="ปิดใบงาน" disabled={busy || evidenceBusy} onClick={closeIfIdle}><X size={18} /></button></header>
      <div className="work-order-content">
      <div className="work-order-identity"><div><strong>{String(task.branch_name || task.branch || 'สาขาไม่ระบุ')}</strong><span>{String(task.province || 'ไม่ระบุจังหวัด')} · LocationCode {String(task.location_code || task.code || '—')}</span><small>{String(task.scanner_model || task.model || 'เครื่องสแกน')} · {String(serial)}</small></div><StatusPill label={presentation.label} tone={presentation.tone} /></div>
      <div className="work-order-steps" aria-label="ความคืบหน้าของรายการ Scanner">
        {['เปิดใบงาน', 'ปฏิบัติงาน', 'บันทึกผล', 'ปิดรายการ'].map((label, index) => <div className={'work-order-step' + (index < currentStep ? ' complete' : index === currentStep ? ' current' : '')} key={label}><span>{index < currentStep ? '✓' : index + 1}</span><small>{label}</small></div>)}
      </div>
      <div className="work-order-layout">
        <div className="work-order-main">
          <section className="detail-section"><h3>Scanner เครื่องเดิม</h3><div className="detail-grid"><DetailField label="Serial Number" value={serial} /><DetailField label="รุ่น" value={task.scanner_model || task.model} /><DetailField label="สาขา" value={task.branch_name || task.branch} /><DetailField label="จังหวัด" value={task.province} /><DetailField label="LocationCode" value={task.location_code || task.code} /></div></section>
          <section className="detail-section work-order-serial-section"><h3>Serial เครื่องเก่าและเครื่องใหม่</h3><div className="work-order-serial-comparison"><div><span>SN เครื่องเดิม</span><strong>{String(serial)}</strong></div><span className="work-order-serial-arrow" aria-hidden="true">→</span>{canAct && stage === 'in_progress' && isReplacement ? <label className="work-order-new-serial-input"><span>SN เครื่องใหม่ *</span><input aria-label="SN เครื่องใหม่" value={newSerialInput} onChange={event => { setNewSerialInput(event.target.value); setActionError('') }} maxLength={100} required autoComplete="off" placeholder="กรอก Serial ของเครื่องใหม่" /></label> : <div><span>SN เครื่องใหม่</span><strong>{newSerial ? String(newSerial) : 'ยังไม่มีข้อมูล'}</strong></div>}</div>{outcome === 'different_device_found' && <div className="work-order-observed-serial"><span>SN อุปกรณ์ที่พบ</span><strong>{observedSerial ? String(observedSerial) : 'ยังไม่มีข้อมูล'}</strong></div>}</section>
          {(status === 'blocked' || isPendingStage) && Boolean(task.blocked_reason || exceptionReason) && <section className="detail-section"><h3>เหตุผลที่ Pending</h3><p className="task-blocked-reason">{String(task.blocked_reason || exceptionReason)}</p></section>}
          <section className="detail-section"><h3>ผลการเปลี่ยน/ตรวจสอบ</h3><div className="detail-grid"><DetailField label="ผลใบงาน" value={outcome ? getStatusPresentation(outcome).label : 'ยังไม่ส่งผลปฏิบัติงาน'} /><DetailField label="ผู้ปฏิบัติงานที่ส่งผล" value={task.performed_by_name || 'ยังไม่มีผู้ส่งผลปฏิบัติงาน'} /><DetailField label="วันและเวลาปฏิบัติงาน" value={formatDate(task.performed_at) || 'ยังไม่มีเวลาบันทึก'} /><DetailField label="SN เดิมตามทะเบียน" value={task.old_serial_snapshot || serial} /><DetailField label={outcome === 'different_device_found' ? 'SN เครื่องที่พบ' : 'Serial อุปกรณ์ที่พบ'} value={observedSerial || 'ยังไม่มีข้อมูล'} /><DetailField label="รุ่นเครื่องที่พบ" value={task.observed_model} /><DetailField label="ผลการติดตั้งและทดสอบ" value={installResult || 'ยังไม่มีข้อมูล'} /><DetailField label="สถานะเครื่องเดิม" value={recordedOldStatus ? oldStatusLabels[String(recordedOldStatus)] || String(recordedOldStatus) : 'ยังไม่มีข้อมูล'} /><DetailField label="เหตุผล/หมายเหตุ" value={exceptionReason || task.old_scanner_note || 'ยังไม่มีข้อมูล'} /></div><p className="detail-empty-result">ผู้ปฏิบัติงานและเวลาอ้างอิงจากบัญชีที่ส่งผลและเวลาที่บันทึกจริง</p></section>
          {((canViewEvidence && Boolean(taskId)) || demo) && <TaskEvidencePanel key={taskId || 'demo'} taskId={taskId || undefined} canEdit={canEditEvidence} editableSlots={editableSlots} requiredSlots={stageRequiredSlots} canView={canViewEvidence} previewOnly={demo} outcome={outcome || outcomeInput} onRequiredReady={setRequiredEvidenceReady} onBusyChange={setEvidenceBusy} onTaskStarted={nextVersion => {
            setEvidenceStartedTask(current => current?.id === taskId && current.version > nextVersion ? current : { id: taskId, version: nextVersion })
            onUpdated('evidence_started')
          }} />}
          {!demo && !canViewEvidence && <section className="detail-section"><h3>หลักฐานประกอบ</h3><p className="detail-empty-result">หลักฐานใบงานดูได้โดย Admin และช่างที่มีสิทธิ์เข้าระบบ</p></section>}
          {canAct && stage === 'in_progress' && <section className="detail-section task-action-panel"><h3>บันทึกผลปฏิบัติงาน</h3><p>กรอกผลตรวจสอบและแนบหลักฐานตามหัวข้อในส่วนรูปภาพด้านบน ระบบจะตรวจรายการที่ยังขาดก่อนบันทึก</p><form className="task-action-form" onSubmit={submitCloseout}>
            <label>ผลการเข้าหน้างาน<select value={outcomeInput} onChange={event => { setOutcomeInput(event.target.value); setActionError('') }}><option value="replaced">เปลี่ยนเครื่องสำเร็จ</option><option value="no_damage_found">ไม่พบเครื่องชำรุด</option><option value="different_device_found">ไม่พบ SN ตามใบงาน แต่พบเครื่องอื่น</option><option value="target_device_not_found">ไม่พบ SN ตามใบงานและไม่พบเครื่องอื่น</option></select></label>
            {outcomeInput === 'different_device_found' && <p className="detail-readonly-note"><ShieldCheck size={16} /><span>บันทึก SN ที่พบและเหตุผล รายการนี้จะเป็น Pending; ระบบยังไม่เพิ่มหรือเปลี่ยนข้อมูลทะเบียนจนกว่า Admin ตรวจ</span></p>}
            {outcomeInput === 'target_device_not_found' && <p className="detail-readonly-note"><ShieldCheck size={16} /><span>บันทึกเหตุผล รายการนี้จะเป็น Pending เพื่อให้ Admin ตรวจ ไม่เพิ่ม SN ใหม่</span></p>}
            {outcomeInput === 'different_device_found' && <><label>Serial ของอุปกรณ์ที่พบ<input value={observedSerialInput} onChange={event => setObservedSerialInput(event.target.value)} maxLength={100} required autoComplete="off" /></label><label>รุ่นของอุปกรณ์ที่พบ (ถ้าทราบ)<input value={observedModelInput} onChange={event => setObservedModelInput(event.target.value)} maxLength={100} autoComplete="off" /></label></>}
            <label>ผลการติดตั้ง/ตรวจสอบ<textarea value={installResultInput} onChange={event => setInstallResultInput(event.target.value)} maxLength={500} required rows={3} /></label>
            {isReplacement && <label>สถานะเครื่องเดิม<select value={oldStatusInput} onChange={event => setOldStatusInput(event.target.value)} required><option value="" disabled>เลือกสถานะเครื่องเดิม</option>{Object.entries(oldStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
            {isReplacement && oldStatusInput === 'other' && <label>หมายเหตุเครื่องเดิม<textarea value={oldStatusNote} onChange={event => setOldStatusNote(event.target.value)} maxLength={1000} required rows={3} /></label>}
            {!isReplacement && <label>เหตุผล/รายละเอียด<textarea value={exceptionReasonInput} onChange={event => setExceptionReasonInput(event.target.value)} maxLength={1000} required rows={3} /></label>}
            {actionError && !showBlockForm && <p className="task-action-error" role="alert">{actionError}</p>}
            {isReplacement && <p className="detail-readonly-note"><ShieldCheck size={16} /><span>{requiredEvidenceReady ? 'หลักฐานที่จำเป็นครบแล้ว พร้อมส่งผลให้ Admin ตรวจรับ' : 'ยังขาดหลักฐานที่จำเป็น ดูหัวข้อที่ระบุว่า “จำเป็นในขั้นนี้” ในส่วนรูปภาพด้านบน'}</span></p>}
            <button type="submit" className="primary-button task-action-submit" disabled={busy || evidenceBusy}>{busy ? 'กำลังบันทึก…' : evidenceBusy ? 'กำลังบันทึกหลักฐาน…' : isReplacement ? 'บันทึกผลและปิดงาน' : 'บันทึกผลเป็น Pending'}</button>
          </form><button type="button" className="secondary-button task-block-toggle" disabled={busy} onClick={() => { setShowBlockForm(value => !value); setActionError('') }}>{showBlockForm ? 'ซ่อนฟอร์ม Pending' : 'พักรายการนี้เป็น Pending'}</button>{showBlockForm && <form className="task-action-form" onSubmit={submitBlock}><label>เหตุผลที่ทำงานต่อไม่ได้<textarea value={blockReason} onChange={event => setBlockReason(event.target.value)} maxLength={500} required rows={3} /></label>{actionError && <p className="task-action-error" role="alert">{actionError}</p>}<button type="submit" className="secondary-button" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึก Pending'}</button></form>}</section>}
          {isPendingReview && !canResolvePending && <div className="detail-readonly-note"><ShieldCheck size={16} /><span>บัญชีที่ปฏิบัติงานหรือส่งผลหน้างานไม่สามารถตรวจรับงานเดียวกันได้ โปรดให้ Admin อีกบัญชีหนึ่งลงนามตรวจรับ</span></div>}
          {canResolvePending && outcome === 'different_device_found' && <section className="detail-section task-action-panel"><label className="task-exception-register"><input type="checkbox" checked={registerObservedSerial} onChange={event => setRegisterObservedSerial(event.target.checked)} />เพิ่ม SN ที่ตรวจแล้วว่าเป็นเครื่องใหม่ในทะเบียนสาขานี้</label><p>ตรวจ SN สาขาและทะเบียนทุกสาขาก่อนเลือก ระบบจะเพิ่มเฉพาะ SN ที่ยังไม่อยู่ในทะเบียน หากต้องเปลี่ยนเครื่องต่อ ให้เปิดใบงานใหม่ด้วย SN ที่เพิ่มแล้ว การพบ SN ซ้ำต่างสาขาจะถูกปฏิเสธโดยไม่ย้ายข้อมูล</p></section>}
          {demo && <div className="detail-readonly-note"><ShieldCheck size={16} /><span>ใบงานตัวอย่างเป็นแบบอ่านอย่างเดียว ไม่บันทึกข้อมูลจริง</span></div>}
        </div>
        <aside className="work-order-side" aria-label="ขั้นตอน สาขา และการจัดการใบงาน">
          <section className="detail-section"><h3>ข้อมูลการเปิดใบงาน</h3><div className="detail-grid"><DetailField label="เปิดใบงานเมื่อ" value={formatDate(task.created_at)} /><DetailField label="จังหวัด" value={task.province} /><DetailField label="สถานะใบงาน" value={presentation.label} /><DetailField label="ผู้ปฏิบัติงาน" value={task.performed_by_name} /></div></section>
          {canAct && stage === 'blocked' && <section className="detail-section task-action-panel"><h3>ดำเนินงานต่อ</h3><p>แก้สาเหตุที่พักงานแล้วจึงกลับมาทำรายการนี้ต่อ</p><button type="button" className="primary-button" disabled={busy} onClick={() => void submitAction('resume')}>{busy ? 'กำลังบันทึก…' : 'ดำเนินงานต่อ'}</button>{actionError && <p className="task-action-error" role="alert">{actionError}</p>}</section>}
          {canResolvePending && <section className="detail-section task-action-panel"><h3>{outcome === 'replaced' ? 'ตรวจรับและส่งมอบงาน' : 'พิจารณารายการ Pending'}</h3><p>ตรวจรูปและข้อมูลที่ช่างบันทึก แล้วลงลายเซ็นตรวจรับด้วยบัญชี Admin อีกบัญชีหนึ่ง สำหรับเครื่องอื่น ระบบจะเพิ่ม SN ได้เมื่อยืนยันแล้วว่าไม่ซ้ำกับทะเบียนทุกสาขา หากต้องกลับไปทำงานหน้างาน ให้ยกเลิกรายการนี้พร้อมเหตุผลแล้วเปิดใบงานใหม่</p>{actionError && <p className="task-action-error" role="alert">{actionError}</p>}<button type="button" className="primary-button task-action-submit" disabled={busy || evidenceBusy || !requiredEvidenceReady} onClick={() => void resolvePending()}>{busy ? 'กำลังบันทึก…' : evidenceBusy ? 'กำลังบันทึกหลักฐาน…' : outcome === 'replaced' ? 'ลงนามรับผ่านและส่งมอบงาน' : 'บันทึกผลตรวจ Pending'}</button></section>}
          {canManage && !['completed', 'cancelled'].includes(status) && <section className="detail-section task-action-panel"><h3>การจัดการรายการ Scanner</h3>{showCancelForm ? <form className="task-action-form" onSubmit={event => void submitCancel(event)}><label>เหตุผลที่ยกเลิก<textarea value={cancelReason} onChange={event => setCancelReason(event.target.value)} maxLength={500} rows={3} required /></label>{actionError && <p className="task-action-error" role="alert">{actionError}</p>}<div className="task-action-buttons"><button type="button" className="secondary-button" disabled={busy} onClick={() => { setShowCancelForm(false); setCancelReason(''); setActionError('') }}>กลับ</button><button type="submit" className="primary-button" disabled={busy || !cancelReason.trim()}>{busy ? 'กำลังบันทึก…' : 'ยืนยันยกเลิกรายการนี้'}</button></div></form> : <><p>Admin ยกเลิกรายการเครื่องนี้แยกจากเครื่องอื่นในใบงานได้ โดยระบุเหตุผลและระบบจะเก็บประวัติไว้</p><button type="button" className="secondary-button" disabled={busy} onClick={() => { setShowCancelForm(true); setActionError('') }}>ยกเลิกรายการเครื่องนี้</button>{actionError && <p className="task-action-error" role="alert">{actionError}</p>}</>}</section>}
          {['delivered', 'exception_resolved', 'legacy_completed', 'cancelled'].includes(stage) && <div className="detail-readonly-note"><ShieldCheck size={16} /><span>{stage === 'delivered' ? 'รายการนี้ Completed แล้ว และทะเบียนอัปเดตตามผลเปลี่ยนเครื่อง' : stage === 'exception_resolved' ? 'Admin พิจารณา Pending แล้ว รายการนี้ปิดโดยคง SN เดิมไว้' : 'รายการนี้ปิดแล้วและแก้ไขไม่ได้'}</span></div>}
          {!demo && !['field_technician', 'admin'].includes(String(role)) && <div className="detail-readonly-note"><ShieldCheck size={16} /><span>บัญชีปัจจุบันดูข้อมูลได้อย่างเดียว</span></div>}
        </aside>
      </div>
      </div>
    </section>
  </div>
}
type ImportIssue = { row_number: number; field: string; code: string; message: string }
type ImportPreview = { batch_id: string; row_count: number; branch_count: number; issue_count: number; issues_truncated: boolean; issues: ImportIssue[] }
type ImportResult = { batch_id: string; status: 'committed'; branches: number; inserted: number; updated: number }
type ImportHistoryEntry = {
  id: string
  import_mode: 'bootstrap' | 'incremental'
  status: 'staged' | 'committed' | 'rejected' | 'expired'
  row_count: number
  issue_count: number
  created_at: string
  committed_at: string | null
  result_counts: { branches?: number; inserted?: number; updated?: number } | null
}

function Imports({ role, onComplete }: { role?: string; onComplete: () => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const canImport = role === 'admin'
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<RegisterImportRow[]>([])
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [commitUncertain, setCommitUncertain] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<ImportHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyReloadKey, setHistoryReloadKey] = useState(0)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState('')
  const [exportMessage, setExportMessage] = useState('')

  async function exportRegister() {
    if (!canImport || exportBusy) return
    setExportBusy(true); setExportError(''); setExportMessage('')
    try {
      const res = await d1Api.getExportRawData()
      const exported = res.data || []

      const columns: Array<[string, (row: Record<string, unknown>) => unknown]> = [
        ['จังหวัด', row => row.province],
        ['อำเภอ/เขต', row => row.district],
        ['LocationCode', row => row.location_code],
        ['สาขา', row => row.branch_name],
        ['เบอร์ติดต่อสาขา', row => row.branch_phone],
        ['ประเภทการติดตั้ง', row => row.install_type],
        ['หมายเหตุสถานที่', row => row.address_note],
        ['Serial เดิม', row => row.old_serial],
        ['ยี่ห้อ', row => row.brand],
        ['รุ่นเดิม', row => row.old_model],
        ['สถานะงาน', row => getStatusPresentation(row.task_status as string || 'open').label],
        ['Serial ใหม่', row => row.new_serial_number || ''],
        ['ผลการดำเนินการ', row => row.outcome || ''],
        ['เริ่มงานเมื่อ', row => row.started_at || ''],
        ['ส่งปิดงานเมื่อ', row => row.closeout_submitted_at || ''],
        ['SYM ตรวจรับเมื่อ', row => row.admin_accepted_at || ''],
        ['Gable ตรวจรับเมื่อ', row => row.customer_accepted_at || ''],
      ]
      const csvCell = (input: unknown) => {
        let value = String(input ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n')
        if (/^\s*[=+\-@\t]/.test(value)) value = `'${value}`
        return `"${value.replaceAll('"', '""')}"`
      }
      const csv = '\uFEFF' + [columns.map(([label]) => csvCell(label)).join(','), ...exported.map(row => columns.map(([, getValue]) => csvCell(getValue(row))).join(','))].join('\r\n')
      const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
      link.href = blobUrl; link.download = `ais-scanner-register-${timestamp}.csv`; link.hidden = true
      document.body.append(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
      setExportMessage(`ส่งออกทะเบียนสำเร็จ ${exported.length.toLocaleString('th-TH')} เครื่อง`)
    } catch {
      setExportError('ส่งออกทะเบียนไม่สำเร็จ โปรดลองใหม่และตรวจสิทธิ์ Admin')
    } finally { setExportBusy(false) }
  }

  useEffect(() => {
    if (!canImport) return
    let active = true
    setHistoryLoading(true)
    void (async () => {
      try {
        const res = await d1Api.getImportHistory()
        if (active) {
          setHistory(Array.isArray(res.rows) ? res.rows as ImportHistoryEntry[] : [])
          setHistoryError('')
        }
      } catch {
        if (active) setHistoryError('โหลดประวัติการนำเข้าไม่สำเร็จ')
      } finally {
        if (active) setHistoryLoading(false)
      }
    })()
    return () => { active = false }
  }, [canImport, historyReloadKey])

  async function chooseFile(file?: File) {
    setError('')
    setPreview(null)
    setResult(null)
    setCommitUncertain(false)
    setRows([])
    setFileName('')
    if (!file) return
    try {
      const { parseRegisterWorkbook } = await import('./xlsx-register.mjs')
      const parsed = await parseRegisterWorkbook(file)
      setFileName(file.name)
      setRows(parsed)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'อ่านไฟล์ไม่สำเร็จ โปรดตรวจไฟล์แล้วลองอีกครั้ง')
    }
  }

  async function stageImport() {
    if (!canImport || rows.length === 0 || busy) return
    setBusy(true)
    setError('')
    try {
      const branchSet = new Set(rows.map(r => String(r.location_code || '').trim()).filter(Boolean))
      const warnings = rows.filter(r => Boolean(r.address_note)).length
      setPreview({
        batch_id: `batch-${Date.now()}`,
        row_count: rows.length,
        branch_count: branchSet.size,
        issue_count: 0,
        issues: [],
        issues_truncated: false,
        warnings,
      } as any)
    } finally {
      setBusy(false)
    }
  }

  async function commitImport() {
    if (!preview || preview.issue_count !== 0 || !canImport || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await d1Api.importRegister(rows, fileName)
      setResult({
        inserted: rows.length,
        updated: 0,
        unmodified: 0,
        status: 'committed'
      } as any)
      setPreview(null)
      setRows([])
      setCommitUncertain(false)
      if (res.warnings_count > 0) {
        setError(`⚠️ นำเข้าสำเร็จ ${rows.length} เครื่อง แต่มี ${res.warnings_count} รายการที่มี "หมายเหตุการแยกที่อยู่" (ระบบติดป้ายเตือนในหน้าทะเบียนแล้ว)`)
      }
      try {
        await onComplete()
      } catch {
        // ignore
      }
    } catch (cause: any) {
      setError(cause instanceof Error ? cause.message : 'ฐานข้อมูลปฏิเสธการนำเข้า โปรดตรวจรายละเอียดแล้วลองใหม่')
    } finally {
      setBusy(false)
    }
  }

  function resetImport() {
    setFileName('')
    setRows([])
    setPreview(null)
    setResult(null)
    setCommitUncertain(false)
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  return <div className="import-layout">
    <section className="panel import-panel"><div className="import-panel-heading"><div className="upload-icon"><FileSpreadsheet size={23} /></div><div><h2>นำเข้าไฟล์ทะเบียนสาขาและเครื่องสแกน</h2><p>นำเข้าเพิ่มหรือปรับปรุงข้อมูลจากชีต Detail1 โดยจับคู่ Serial เดิม · ไม่เปลี่ยนประวัติงาน</p><p>ส่งออกทะเบียนปัจจุบันเป็น CSV สำหรับเปิดใน Excel</p></div>{canImport && <button type="button" className="secondary-button" disabled={exportBusy} onClick={() => void exportRegister()}><FileDown size={16} />{exportBusy ? 'กำลังส่งออก…' : 'ส่งออกทะเบียน'}</button>}</div>
      {exportMessage && <p className="import-export-message" role="status">{exportMessage}</p>}{exportError && <div className="import-error" role="alert">{exportError}</div>}
      <div className="upload-drop"><div className="upload-cloud"><FileSpreadsheet size={24} /></div><strong>{fileName || 'เลือกไฟล์ Excel (.xlsx)'}</strong><span>{rows.length ? `อ่านได้ ${rows.length.toLocaleString('th-TH')} แถวจากชีต Detail1` : 'ไฟล์จะถูกอ่านในเบราว์เซอร์ และส่งเฉพาะข้อมูลทะเบียนที่จำเป็นไปตรวจสอบ'}</span>
        <input ref={inputRef} className="visually-hidden" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="เลือกไฟล์ Excel" onChange={event => void chooseFile(event.target.files?.[0])} />
        <button className="secondary-button" disabled={!canImport || busy || commitUncertain} onClick={() => inputRef.current?.click()}><FileSpreadsheet size={16} /> {canImport ? 'เลือกไฟล์' : 'เฉพาะ Admin'}</button>
        {fileName && !preview && !result && <button className="primary-button" disabled={!canImport || busy || rows.length === 0} onClick={() => void stageImport()}>{busy ? 'กำลังตรวจสอบ…' : 'ตรวจสอบข้อมูลก่อนนำเข้า'}</button>}
      </div>
      {!canImport && <div className="warning-box"><LockKeyhole size={17} /><span>เมนูนำเข้าต้องใช้สิทธิ์ Admin</span></div>}
      {error && <div className="import-error" role="alert">{error}</div>}
      {preview && <section className="import-preview" aria-live="polite"><div className="import-preview-heading"><div><h3>ผลตรวจสอบชุดข้อมูล</h3><p>{preview.row_count.toLocaleString('th-TH')} เครื่อง · {preview.branch_count.toLocaleString('th-TH')} สาขา · {preview.issue_count.toLocaleString('th-TH')} ปัญหา</p></div><button className="secondary-button" disabled={busy} onClick={resetImport}>เลือกไฟล์ใหม่</button></div>
        {(preview as any).warnings > 0 && <div className="address-warning-box"><span>⚠️ พบ {(preview as any).warnings.toLocaleString('th-TH')} รายการที่มี "หมายเหตุการแยกที่อยู่" (ระบบอนุญาตให้นำเข้าได้ โดยจะติดป้ายเตือนในหน้าทะเบียน)</span></div>}
        {preview.issue_count === 0 ? <div className="rule"><CheckCircle2 size={16} /><span>ไม่พบข้อผิดพลาด รหัสสาขาและ Serial ครบถ้วน ระบบพร้อมบันทึกลง Cloudflare D1</span></div> : <div className="import-issues"><strong>ต้องแก้ปัญหาในไฟล์ก่อนนำเข้า</strong>{preview.issues.map((issue, index) => <div className="import-issue" key={`${issue.row_number}-${issue.field}-${index}`}><span>แถว {issue.row_number}</span><strong>{issue.field}</strong><span>{issue.message}</span></div>)}{preview.issues_truncated && <small>แสดง 100 ปัญหาแรกจากทั้งหมด {preview.issue_count}</small>}</div>}
        <div className="import-actions"><button className="secondary-button" disabled={busy || commitUncertain} onClick={resetImport}>ยกเลิกชุดนี้</button><button className="primary-button" disabled={busy || preview.issue_count > 0} onClick={() => void commitImport()}>{busy ? 'กำลังบันทึก…' : commitUncertain ? 'ตรวจสอบผลนำเข้า' : `บันทึก ${preview.row_count.toLocaleString('th-TH')} รายการลง D1`}</button></div>
      </section>}
      {result && <div className="import-success" role="status"><CheckCircle2 size={18} /><span>นำเข้าสำเร็จ: เพิ่ม {result.inserted.toLocaleString('th-TH')} เครื่อง · อัปเดต {result.updated.toLocaleString('th-TH')} เครื่อง</span><button className="secondary-button" onClick={resetImport}>ปิดผลลัพธ์</button></div>}
      <div className="file-rules"><h3>กติกาตรวจสอบก่อนบันทึก</h3><div className="rule"><CheckCircle2 size={16} /><span><strong>comSN</strong> เป็นกุญแจจับคู่; ค่าเดิมอัปเดตเฉพาะช่องที่อนุญาตและไม่ว่าง</span></div><div className="rule"><CheckCircle2 size={16} /><span>Serial ใหม่เพิ่มรายการ; Serial ซ้ำในไฟล์หรืออยู่คนละสาขาจะปฏิเสธทั้งชุด</span></div><div className="rule"><CheckCircle2 size={16} /><span>สาขาต้องตรงกับ LocationCode และชื่อที่ปรับช่องว่างแล้ว; ไม่ย้ายเครื่องข้ามสาขา</span></div><div className="rule"><CheckCircle2 size={16} /><span>ไฟล์ที่มีแถวผิดจะบันทึกไม่ได้ และการนำเข้าไม่เปลี่ยนประวัติงาน</span></div></div>
      <section className="import-history-panel"><div className="import-preview-heading"><div><h3>ประวัติการนำเข้าล่าสุด</h3><p>แสดงไม่เกิน 50 ชุด โดยไม่แสดงชื่อไฟล์หรือข้อมูลรายแถว</p></div><button type="button" className="secondary-button" disabled={historyLoading || !canImport} onClick={() => setHistoryReloadKey(key => key + 1)}>รีเฟรช</button></div>
        {historyLoading ? <EmptyState compact loading /> : historyError ? <EmptyState compact title="โหลดประวัติไม่สำเร็จ" detail={historyError} onRetry={() => setHistoryReloadKey(key => key + 1)} /> : history.length ? <div className="import-history-list">{history.map(entry => {
          const modeLabel = entry.import_mode === 'incremental' ? 'อัปเดตทะเบียน' : 'นำเข้าครั้งแรก'
          const statusLabel = entry.status === 'committed' ? 'สำเร็จ' : entry.status === 'staged' ? 'รอตรวจสอบ' : entry.status === 'expired' ? 'หมดอายุ' : 'ไม่สำเร็จ'
          const counts = entry.result_counts
          const time = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(entry.committed_at || entry.created_at))
          return <article className="import-history-row" key={entry.id}><div><strong>{modeLabel}</strong><small>{time}</small></div><div><span className={'history-status history-' + entry.status}>{statusLabel}</span><small>{entry.row_count.toLocaleString('th-TH')} แถว · {entry.issue_count.toLocaleString('th-TH')} ปัญหา</small></div><div className="import-history-result">{counts ? `เพิ่ม ${Number(counts.inserted) || 0} · อัปเดต ${Number(counts.updated) || 0} เครื่อง` : 'ยังไม่มีผลบันทึก'}</div></article>
        })}</div> : <EmptyState compact title="ยังไม่มีประวัติการนำเข้า" detail="ชุดข้อมูลที่ตรวจสอบแล้วจะแสดงที่นี่" />}
      </section>
    </section>
    <aside className="panel import-side"><div className="panel-heading"><div><h2>ขั้นตอนนำเข้า</h2><p>บันทึกเป็นชุดเพื่อทวนสอบย้อนหลัง</p></div></div><div className="step-list"><div className="import-step active"><span>1</span><div><strong>เลือกไฟล์</strong><small>อ่านเฉพาะชีต Detail1</small></div></div><div className="step-line" /><div className="import-step"><span>2</span><div><strong>ตรวจสอบข้อมูล</strong><small>ตรวจบนฐานข้อมูลก่อนบันทึก</small></div></div><div className="step-line" /><div className="import-step"><span>3</span><div><strong>บันทึกทั้งชุด</strong><small>ฐานข้อมูลยกเลิกทั้งหมดเมื่อผิดพลาด</small></div></div></div><div className="warning-box"><ShieldCheck size={17} /><span>ระบบบันทึกทะเบียนสาขาและเครื่องสแกน พร้อมจัดเก็บหมายเหตุการแยกที่อยู่และเบอร์ติดต่อลง Cloudflare D1</span></div></aside>
  </div>
}

function People() {
  const roles = [
    ['Admin', 'ดูแลทะเบียนและสิทธิ์ เปิดหรือยกเลิกใบงาน และพิจารณารายการ Pending', 'Admin ประจำ Office'],
    ['Field Technician', 'เห็นใบงานที่เปิดไว้ และบันทึกผลหน้างานได้', 'ช่าง Onsite'],
  ]
  return <div className="people-layout"><section className="panel roles-panel"><div className="panel-heading"><div><h2>บทบาทงานปฏิบัติการ</h2><p>Admin ประจำ Office และช่าง Onsite</p></div><div className="readonly-badge"><LockKeyhole size={14} /> อ่านอย่างเดียว</div></div><div className="roles-list">{roles.map(([role, description, label]) => <div className="role-row" key={role}><div className={'role-avatar role-' + role.toLowerCase().replaceAll(' ', '-')}>{role === 'Field Technician' ? <Wrench size={17} /> : <Users size={17} />}</div><div className="role-copy"><strong>{role}</strong><span>{description}</span></div><span className="role-label">{label}</span></div>)}</div><p className="team-access-note">ช่างทุกคนเข้าถึงใบงานที่เปิดไว้ได้ บันทึกงานและแนบหลักฐานได้โดยไม่จำกัดทีม</p></section></div>
}

function EmptyState({ title, detail, loading, compact, onRetry }: { title?: string; detail?: string; loading?: boolean; compact?: boolean; onRetry?: () => void }) {
  return <div className={'empty-state ' + (compact ? 'compact' : '')}>{loading ? <><div className="spinner" /><strong>กำลังโหลดข้อมูล</strong></> : <><div className="empty-icon"><ClipboardList size={20} /></div><strong>{title || 'ไม่พบรายการ'}</strong><span>{detail || 'ลองเปลี่ยนคำค้นหา หรือกลับมาตรวจสอบอีกครั้ง'}</span>{onRetry && <button className="text-button" onClick={onRetry}>ลองอีกครั้ง</button>}</>}</div>
}

export default App
