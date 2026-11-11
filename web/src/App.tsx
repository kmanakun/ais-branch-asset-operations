import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock3,
  FileSpreadsheet,
  HardDrive,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  MapPin,
  Menu,
  Search,
  ShieldCheck,
  Users,
  Wrench,
  X,
} from 'lucide-react'
import { demoAssets, demoCampaigns, demoStats, demoTasks, dayBars, type MenuKey } from './data'
import { isSupabaseConfigured, supabase } from './supabase'
import type { RegisterImportRow } from './xlsx-register.mjs'
import CampaignDetailsDialog from './CampaignDetailsDialog'
import ScheduleComposer from './ScheduleComposer'
import TaskEvidencePanel, { requiredEvidenceSlotsForOutcome, type EvidenceSlot } from './TaskEvidencePanel'
import { groupRowsByProvince, ProvinceCardGroup, ProvinceTableGroup } from './province'

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
}

type TaskCounts = {
  open: number
  in_progress: number
  awaiting_review: number
  blocked: number
  completed: number
  cancelled: number
}

type TaskStatusFilter = 'all' | 'open' | 'in_progress' | 'pending' | 'delivered' | 'exception_resolved' | 'legacy_completed' | 'cancelled'

const emptyTaskCounts: TaskCounts = { open: 0, in_progress: 0, awaiting_review: 0, blocked: 0, completed: 0, cancelled: 0 }
const campaignPageSize = 20

const navigation: Array<{ key: MenuKey; label: string; icon: typeof LayoutDashboard }> = [
  { key: 'overview', label: 'ภาพรวม', icon: LayoutDashboard },
  { key: 'campaigns', label: 'ประวัติงานเดิม', icon: ClipboardList },
  { key: 'assets', label: 'ทะเบียนอุปกรณ์', icon: HardDrive },
  { key: 'schedule', label: 'ใบงาน', icon: CalendarDays },
  { key: 'imports', label: 'นำเข้าข้อมูล', icon: FileSpreadsheet },
  { key: 'people', label: 'สิทธิ์ผู้ใช้งาน', icon: Users },
]

const pageCopy: Record<MenuKey, { title: string; subtitle: string }> = {
  overview: { title: 'ภาพรวมการปฏิบัติงาน', subtitle: 'สถานะสาขา อุปกรณ์ และใบงานเปลี่ยน Scanner' },
  campaigns: { title: 'ประวัติงานเดิม', subtitle: 'ข้อมูลจากกระบวนการก่อนหน้าไว้ตรวจสอบย้อนหลัง · ใบงานใหม่จัดการในหน้าใบงาน' },
  assets: { title: 'ทะเบียนอุปกรณ์', subtitle: 'ดูข้อมูลสาขาและเครื่องสแกนที่ผูกกับแต่ละ LocationCode' },
  schedule: { title: 'ใบงานและงานช่าง', subtitle: 'ติดตามผลปฏิบัติงาน ใบงาน Pending และประวัติการเปลี่ยนเครื่อง' },
  imports: { title: 'นำเข้าข้อมูล', subtitle: 'ตรวจสอบไฟล์ทะเบียนก่อนบันทึกเป็นชุดข้อมูลเดียว' },
  people: { title: 'สิทธิ์ผู้ใช้งาน', subtitle: 'Admin Office ดูแลงานปฏิบัติการ ส่วนสิทธิ์ผู้ใช้และการตั้งค่าระบบเป็นคนละขอบเขต' },
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
  open: { label: 'เปิดแล้ว · รอเริ่มงาน', tone: 'ready' },
  scheduled: { label: 'เปิดแล้ว · รอเริ่มงาน', tone: 'ready' },
  awaiting_confirmation: { label: 'เปิดแล้ว · รอเริ่มงาน', tone: 'ready' },
  confirmed: { label: 'เปิดแล้ว · รอเริ่มงาน', tone: 'ready' },
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
  exception_resolved: { label: 'ปิดแล้ว · มีข้อยกเว้น', tone: 'neutral' },
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
    'นัดหมายแล้ว': 'open',
    scheduled: 'open',
    confirmed: 'open',
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

function App() {
  const [session, setSession] = useState<{ user: { email?: string } } | null>(null)
  const [userContext, setUserContext] = useState<UserContext | null>(null)
  const [contextStatus, setContextStatus] = useState<'idle' | 'loading' | 'ready' | 'denied' | 'error'>('idle')
  const [contextError, setContextError] = useState('')
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [dashboardError, setDashboardError] = useState('')
  const [activeMenu, setActiveMenu] = useState<MenuKey>('overview')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [provinceOptions, setProvinceOptions] = useState<string[]>([])
  const [activeProvince, setActiveProvince] = useState('')
  const [listError, setListError] = useState('')
  const [listReloadKey, setListReloadKey] = useState(0)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const [demoMode, setDemoMode] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const [pageLoading, setPageLoading] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [listData, setListData] = useState<unknown[]>([])
  const [taskPage, setTaskPage] = useState(0)
  const [taskStatusFilter, setTaskStatusFilter] = useState<TaskStatusFilter>('all')
  const [taskTotal, setTaskTotal] = useState(0)
  const [taskCounts, setTaskCounts] = useState<TaskCounts>(emptyTaskCounts)
  const [assetPage, setAssetPage] = useState(0)
  const [campaignPage, setCampaignPage] = useState(0)
  const [assetTotal, setAssetTotal] = useState(0)
  const [pendingAssetSerial, setPendingAssetSerial] = useState('')
  const [showScheduleComposer, setShowScheduleComposer] = useState(false)
  const authRequestId = useRef(0)
  const mobileMenuRef = useRef<HTMLElement>(null)
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const workspaceMenuRef = useRef<HTMLDivElement>(null)
  const accountMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const callbackUrl = new URL(window.location.href)
    const oauthError = callbackUrl.searchParams.get('error')
    const errorDescription = callbackUrl.searchParams.get('error_description')
    if (!oauthError && !errorDescription) return

    setLoginError('Google Sign-In ไม่สำเร็จ บัญชีอาจยังไม่ได้รับอนุญาต หรือการตั้งค่า OAuth ยังไม่ครบ โปรดติดต่อ Identity Admin')
    callbackUrl.searchParams.delete('error')
    callbackUrl.searchParams.delete('error_code')
    callbackUrl.searchParams.delete('error_description')
    window.history.replaceState({}, document.title, `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`)
  }, [])

  useEffect(() => {
    const client = supabase
    if (!client) {
      setAuthChecked(true)
      return
    }
    let alive = true
    const loadSession = async () => {
      try {
        const { data, error } = await client.auth.getSession()
        if (error) throw error
        if (alive && data.session) {
          setSession(data.session)
          await loadContext()
        }
      } catch {
        if (alive) setLoginError('ตรวจสอบสถานะการเข้าสู่ระบบไม่ได้ โปรดลองอีกครั้ง')
      } finally {
        if (alive) setAuthChecked(true)
      }
    }
    void loadSession()
    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!alive) return
      if (nextSession) setContextStatus('loading')
      else authRequestId.current += 1
      setSession(nextSession)
      if (nextSession) {
        window.setTimeout(() => {
          if (alive) void loadContext()
        }, 0)
      } else {
        setUserContext(null)
        setDashboard(null)
        setDashboardError('')
        setContextError('')
        setContextStatus('idle')
      }
    })
    return () => {
      alive = false
      authRequestId.current += 1
      listener.subscription.unsubscribe()
    }
  }, [])

  async function loadContext() {
    const client = supabase
    if (!client) {
      setContextStatus('error')
      setContextError('ยังไม่ได้ตั้งค่าการเชื่อมต่อระบบ')
      return
    }
    const requestId = ++authRequestId.current
    setContextStatus('loading')
    setContextError('')
    setDashboardError('')
    try {
      const { data, error } = await client.rpc('ais_app_context')
      if (requestId !== authRequestId.current) return
      if (error) throw error
      if (!data || typeof data !== 'object' || typeof (data as UserContext).role !== 'string') {
        setUserContext(null)
        setDashboard(null)
        setContextStatus('denied')
        return
      }

      setUserContext(data as UserContext)
      try {
        const { data: provinces, error: provincesError } = await client.rpc('ais_branch_provinces')
        if (requestId !== authRequestId.current) return
        if (provincesError) throw provincesError
        setProvinceOptions(Array.isArray(provinces) ? provinces.filter((value): value is string => typeof value === 'string') : [])
      } catch {
        if (requestId !== authRequestId.current) return
        setProvinceOptions([])
      }
      try {
        const { data: overview, error: overviewError } = await client.rpc('ais_dashboard')
        if (requestId !== authRequestId.current) return
        if (overviewError) throw overviewError
        setDashboard((overview || null) as DashboardData | null)
      } catch {
        if (requestId !== authRequestId.current) return
        setDashboard(null)
        setDashboardError('โหลดข้อมูลภาพรวมไม่สำเร็จ โปรดลองใหม่ภายหลัง')
      }
      setContextStatus('ready')
    } catch {
      if (requestId !== authRequestId.current) return
      setUserContext(null)
      setDashboard(null)
      setDashboardError('')
      setContextError('เชื่อมต่อเพื่อตรวจสอบสิทธิ์ไม่ได้ โปรดลองอีกครั้ง')
      setContextStatus('error')
    }
  }

  useEffect(() => {
    if (!session || !userContext || !supabase || activeMenu === 'overview' || activeMenu === 'imports' || activeMenu === 'people') return
    const client = supabase
    let active = true
    const loadList = async () => {
      setPageLoading(true)
      setListError('')
      try {
        let result
        if (activeMenu === 'campaigns') result = await client.rpc('ais_list_campaigns', { p_search: search || null })
        else if (activeMenu === 'assets') result = await client.rpc('ais_scanner_page', { p_search: search || null, p_limit: 50, p_offset: assetPage * 50 })
        else result = await client.rpc('ais_branch_work_order_page', { p_search: search.trim() || null, p_status: taskStatusFilter, p_limit: 50, p_offset: taskPage * 50 })
        if (result.error) throw result.error
        if (active) {
          if (activeMenu === 'assets') {
            setListData(Array.isArray(result.data?.rows) ? result.data.rows : [])
            setAssetTotal(Number(result.data?.total || 0))
          } else if (activeMenu === 'schedule') {
            setListData(Array.isArray(result.data?.rows) ? result.data.rows : [])
            setTaskTotal(Number(result.data?.total || 0))
            const counts = result.data?.counts || {}
            setTaskCounts({
              open: Number(counts.open) || 0,
              in_progress: Number(counts.in_progress) || 0,
              awaiting_review: Number(counts.awaiting_review) || 0,
              blocked: Number(counts.blocked) || 0,
              completed: Number(counts.completed) || 0,
              cancelled: Number(counts.cancelled) || 0,
            })
          } else setListData(Array.isArray(result.data) ? result.data : [])
        }
      } catch {
        if (active) {
          setListData([])
          if (activeMenu === 'assets') setAssetTotal(0)
          if (activeMenu === 'schedule') {
            setTaskTotal(0)
            setTaskCounts(emptyTaskCounts)
          }
          setListError('เชื่อมต่อหรือโหลดข้อมูลไม่สำเร็จ โปรดลองอีกครั้ง')
        }
      } finally {
        if (active) setPageLoading(false)
      }
    }
    void loadList()
    return () => { active = false }
  }, [activeMenu, search, session, userContext, listReloadKey, assetPage, taskPage, taskStatusFilter])

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
    setCampaignPage(0)
  }, [activeMenu, search])

  useEffect(() => {
    if (demoMode || userContext?.role === 'admin' || !['imports', 'people'].includes(activeMenu)) return
    setActiveMenu('overview')
    setMobileMenuOpen(false)
  }, [activeMenu, demoMode, userContext?.role])

  useEffect(() => {
    if (!mobileMenuOpen) return
    const menu = mobileMenuRef.current
    const getFocusableItems = () => menu?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    getFocusableItems()?.[0]?.focus()

    const handleMenuKeys = (event: KeyboardEvent) => {
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
      mobileMenuTriggerRef.current?.focus()
    }
  }, [mobileMenuOpen])

  useEffect(() => {
    if (!mobileMenuOpen || !window.matchMedia('(max-width: 640px)').matches) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
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
    if (isSigningIn) return
    setLoginError('')
    if (!supabase) {
      setLoginError('Google Sign-In ยังไม่ได้เชื่อมต่อกับ Supabase เปิดตัวอย่างระบบเพื่อดูหน้าจอได้')
      return
    }
    setIsSigningIn(true)
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      })
      if (error) setLoginError('เข้าใช้ด้วย Google ไม่สำเร็จ โปรดลองอีกครั้งหรือติดต่อ Identity Admin')
    } catch {
      setLoginError('เชื่อมต่อ Google Sign-In ไม่ได้ โปรดลองอีกครั้งหรือติดต่อ Identity Admin')
    } finally {
      setIsSigningIn(false)
    }
  }

  async function signOut() {
    setSignOutError('')
    try {
      if (supabase && session) {
        const { error } = await supabase.auth.signOut()
        if (error) throw error
      }
    } catch {
      setSignOutError('ออกจากระบบไม่สำเร็จ โปรดลองอีกครั้ง')
      setNotice('ออกจากระบบไม่สำเร็จ โปรดลองอีกครั้ง')
      return
    }
    setSession(null)
    setUserContext(null)
    setDashboard(null)
    setDashboardError('')
    setContextStatus('idle')
    setContextError('')
    setSignOutError('')
    setMobileMenuOpen(false)
    setWorkspaceMenuOpen(false)
    setAccountMenuOpen(false)
    setProvinceOptions([])
    setActiveProvince('')
    setDemoMode(false)
    setActiveMenu('overview')
  }

  function navigateTo(menu: MenuKey, searchTerm = '') {
    setActiveMenu(menu)
    setSearch(searchTerm)
    setMobileMenuOpen(false)
    setWorkspaceMenuOpen(false)
    setAccountMenuOpen(false)
    if (menu !== 'assets' || searchTerm !== activeProvince) setActiveProvince('')
    if (menu === 'assets') setAssetPage(0)
    if (menu === 'schedule') setTaskPage(0)
  }

  function selectProvince(province: string) {
    setActiveMenu('assets')
    setSearch(province)
    setAssetPage(0)
    setMobileMenuOpen(false)
    setWorkspaceMenuOpen(false)
    setAccountMenuOpen(false)
    setActiveProvince(province)
  }

  function openScannerFromCampaign(serial: string) {
    const target = serial.trim()
    if (!target) return
    setListData([])
    setListError('')
    setAssetTotal(0)
    setPageLoading(!demoMode)
    setPendingAssetSerial(target)
    navigateTo('assets', target)
  }

  if (!authChecked) return <div className="loading-screen"><div className="spinner" /><span>กำลังตรวจสอบสถานะการเข้าสู่ระบบ</span></div>
  if (!session && !demoMode) {
    return <LoginPage onGoogleSignIn={() => void signInWithGoogle()} onDemo={() => setDemoMode(true)} onHelp={() => setLoginError('ใช้บัญชี Google ที่อยู่ในรายชื่อผู้มีสิทธิ์ หากยังเข้าไม่ได้โปรดติดต่อ Identity Admin')} error={loginError} configured={isSupabaseConfigured} submitting={isSigningIn} />
  }
  if (session && contextStatus === 'loading' && !demoMode) return <div className="loading-screen"><div className="spinner" /><span>กำลังตรวจสอบสิทธิ์การใช้งาน</span></div>
  if (session && contextStatus === 'error' && !demoMode) {
    return <NoAccess email={contextError} error={signOutError} onSignOut={signOut} onRetry={() => void loadContext()} retry />
  }
  if (session && !userContext && !demoMode) {
    return <NoAccess email={session.user.email || ''} error={signOutError} onSignOut={signOut} />
  }

  const role = demoMode ? 'viewer' : userContext?.role
  const canUseAdminModules = demoMode || role === 'admin'
  const visibleNavigation = navigation.filter(item => canUseAdminModules || !['imports', 'people'].includes(item.key))
  const visibleProvinces = demoMode
    ? Array.from(new Set([...demoAssets, ...demoTasks].map(row => String(row.province || '').trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right, 'th'))
    : provinceOptions
  const accountName = demoMode ? 'ทาม' : userContext?.display_name || session?.user.email || 'ผู้ใช้งาน'
  const currentPage = pageCopy[activeMenu]

  return (
    <div className="app-shell">
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
              {item.key === 'schedule' && (demoMode ? 36 : Number(dashboard?.totals?.active_tasks || 0)) > 0 && <span className="nav-counter">{demoMode ? 36 : Number(dashboard?.totals?.active_tasks || 0)}</span>}
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
          <div className="page-heading">
            <div><div className="eyebrow">AIS BRANCH & ASSET OPERATIONS</div><h1>{currentPage.title}</h1><p>{currentPage.subtitle}</p></div>
            {activeMenu === 'assets' && canUseAdminModules && <button className="secondary-button" onClick={() => setActiveMenu('imports')}><FileSpreadsheet size={16} /> นำเข้าทะเบียน</button>}
            {activeMenu === 'schedule' && !showScheduleComposer && <button className="primary-button" disabled={demoMode || role !== 'admin'} title={demoMode ? 'โหมดตัวอย่างไม่บันทึกงานจริง' : role !== 'admin' ? 'ต้องใช้สิทธิ์ Admin' : undefined} onClick={() => setShowScheduleComposer(true)}><CalendarDays size={16} /> เปิดใบงาน</button>}
          </div>

            {activeMenu === 'overview' && <Overview demo={demoMode} role={role} dashboard={dashboard} error={dashboardError} onNavigate={navigateTo} onTaskUpdated={action => { setListReloadKey(key => key + 1); setNotice(action === 'refresh' ? 'กำลังโหลดสถานะใบงานล่าสุด' : action === 'closeout_pending' ? 'ส่งผลหน้างานแล้ว รอ Admin ตรวจหลักฐานและลงนาม' : action === 'resolve_exception' ? 'Admin ตรวจ Pending และบันทึกผลพิจารณาแล้ว' : action === 'accept' ? 'Admin ลงนามรับผ่านและส่งมอบงานแล้ว' : action === 'resolve_pending' ? 'Admin ตรวจและปิดรายการ Pending แล้ว' : action === 'block' ? 'บันทึกรายการ Pending แล้ว' : action === 'resume' ? 'รายการกลับมาดำเนินการแล้ว' : 'เริ่มปฏิบัติงานแล้ว'); void loadContext() }} />}
          {activeMenu === 'campaigns' && <><div className="warning-box"><ClipboardList size={17} /><span>หน้านี้เก็บข้อมูลรอบงานเดิมไว้ตรวจสอบย้อนหลังเท่านั้น ไม่มีการสร้าง แก้ไข จัดทีม หรือนัดหมายจากหน้านี้ · เปิดใบงานใหม่ได้จากหน้าใบงาน</span></div><Campaigns role={role} demo={demoMode} items={demoMode ? demoCampaigns : listData} loading={pageLoading} error={listError} onRetry={() => setListReloadKey(key => key + 1)} onUpdated={message => { setListReloadKey(key => key + 1); setNotice(message); void loadContext() }} onOpenScanner={openScannerFromCampaign} search={search} setSearch={setSearch} page={campaignPage} setPage={setCampaignPage} /> </>}
          {activeMenu === 'assets' && <Assets role={role} demo={demoMode} items={demoMode ? demoAssets : listData} loading={pageLoading} error={listError} onRetry={() => setListReloadKey(key => key + 1)} search={search} setSearch={value => { setActiveProvince(''); setAssetPage(0); setSearch(value) }} page={assetPage} total={assetTotal} setPage={setAssetPage} focusSerial={pendingAssetSerial} onFocusResolved={() => setPendingAssetSerial('')} />}
          {activeMenu === 'schedule' && !showScheduleComposer && !demoMode && role !== 'admin' && <div className="warning-box"><LockKeyhole size={17} /><span>การเปิดใบงานใช้สิทธิ์ Admin บัญชี {getFriendlyRole(role)} ดูงานที่เปิดไว้และบันทึกผลหน้างานได้</span></div>}
          {activeMenu === 'schedule' && showScheduleComposer && <ScheduleComposer onCancel={() => setShowScheduleComposer(false)} onSaved={() => { setShowScheduleComposer(false); setListReloadKey(key => key + 1); setNotice('เปิดใบงานเรียบร้อยแล้ว ช่างทุกคนเห็นงานได้ทันที'); void loadContext() }} />}
          {activeMenu === 'schedule' && !showScheduleComposer && <Schedule demo={demoMode} role={role} items={demoMode ? demoTasks : listData} loading={pageLoading} error={listError} onRetry={() => setListReloadKey(key => key + 1)} onTaskUpdated={action => { setListReloadKey(key => key + 1); setNotice(action === 'refresh' ? 'กำลังโหลดสถานะใบงานล่าสุด' : action === 'closeout_pending' ? 'ส่งผลหน้างานแล้ว รอ Admin ตรวจหลักฐานและลงนาม' : action === 'resolve_exception' ? 'Admin ตรวจ Pending และบันทึกผลพิจารณาแล้ว' : action === 'accept' ? 'Admin ลงนามรับผ่านและส่งมอบงานแล้ว' : action === 'resolve_pending' ? 'Admin ตรวจและปิดรายการ Pending แล้ว' : action === 'block' ? 'บันทึกรายการ Pending แล้ว' : action === 'resume' ? 'รายการกลับมาดำเนินการแล้ว' : 'เริ่มปฏิบัติงานแล้ว'); void loadContext() }} total={taskTotal} counts={taskCounts} page={taskPage} setPage={setTaskPage} search={search} setSearch={value => { setTaskPage(0); setSearch(value) }} statusFilter={taskStatusFilter} setStatusFilter={value => { setTaskPage(0); setTaskStatusFilter(value) }} />}
          {activeMenu === 'imports' && canUseAdminModules && <Imports role={role} onComplete={async () => {
            setListReloadKey(key => key + 1)
            const client = supabase
            if (client) {
              const { data } = await client.rpc('ais_dashboard')
              if (data) setDashboard(data as DashboardData)
            }
          }} />}
          {activeMenu === 'people' && canUseAdminModules && <People />}
          <footer className="page-footer"><span>© 2026 AIS Branch & Asset Operations</span><span>V1 · ระบบนำร่อง</span></footer>
        </div>
      </main>
      <nav className="mobile-bottom-nav" aria-label="เมนูหลักสำหรับโทรศัพท์">
        {visibleNavigation.filter(item => ['overview', 'assets', 'campaigns', 'schedule'].includes(item.key)).map(item => {
          const Icon = item.icon
          const label = item.key === 'overview' ? 'หน้าหลัก' : item.key === 'assets' ? 'อุปกรณ์' : item.key === 'campaigns' ? 'ประวัติเดิม' : 'ใบงาน'
          return <button key={item.key} type="button" className={'mobile-tab' + (activeMenu === item.key ? ' active' : '')} aria-current={activeMenu === item.key ? 'page' : undefined} onClick={() => navigateTo(item.key)}>
            <Icon size={18} aria-hidden="true" /><span>{label}</span>
          </button>
        })}
        <button type="button" className={'mobile-tab mobile-more' + (mobileMenuOpen ? ' active' : '')} aria-label="เมนูเพิ่มเติม" aria-expanded={mobileMenuOpen} aria-controls="primary-navigation" onClick={() => setMobileMenuOpen(true)}>
          <Menu size={18} aria-hidden="true" /><span>เพิ่มเติม</span>
        </button>
      </nav>
      {notice && <div className="toast" role="status" aria-live="polite"><CheckCircle2 size={18} />{notice}<button onClick={() => setNotice('')} aria-label="ปิด"><X size={16} /></button></div>}
    </div>
  )
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
        {!configured && <div className="config-note">ระบบยังไม่ได้เชื่อมต่อ Supabase จึงยังเข้าสู่ระบบไม่ได้</div>}
        <button className="google-sign-in-button" type="button" onClick={onGoogleSignIn} disabled={submitting || !configured}>
          <svg className="google-sign-in-mark" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.44a5.5 5.5 0 0 1-2.39 3.61v2.99h3.87c2.27-2.09 3.57-5.17 3.57-8.84Z" />
            <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.94-2.89l-3.87-2.99c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.95H1.27v3.09C3.25 21 7.28 24 12 24Z" />
            <path fill="#FBBC05" d="M5.27 14.32A7.2 7.2 0 0 1 4.89 12c0-.81.14-1.59.38-2.32V6.59H1.27A11.98 11.98 0 0 0 0 12c0 1.94.46 3.77 1.27 5.41l4-3.09Z" />
            <path fill="#EA4335" d="M12 4.73c1.76 0 3.34.6 4.59 1.82l3.44-3.44C17.95 1.19 15.24 0 12 0 7.28 0 3.25 3 1.27 6.59l4 3.09C6.22 6.84 8.87 4.73 12 4.73Z" />
          </svg>
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

function Overview({ demo, role, dashboard, error, onNavigate, onTaskUpdated }: { demo: boolean; role?: string; dashboard: DashboardData | null; error: string; onNavigate: (key: MenuKey, search?: string) => void; onTaskUpdated: (action: string) => void }) {
  const liveTotals = dashboard?.totals
  const stats = demo ? demoStats : [
    { label: 'สาขาในทะเบียน', value: error ? '—' : liveTotals?.branches ?? 0, change: 'อ้างอิง LocationCode', icon: 'branches', tone: 'blue' },
    { label: 'เครื่องสแกน', value: error ? '—' : liveTotals?.scanners ?? 0, change: 'ทะเบียนอุปกรณ์ปัจจุบัน', icon: 'scanner', tone: 'violet' },
    { label: 'ใบงานที่ยังไม่เสร็จ', value: error ? '—' : liveTotals?.active_tasks ?? 0, change: 'กำลังทำ · Pending', icon: 'activity', tone: 'orange' },
    { label: 'Completed', value: error ? '—' : liveTotals?.completed_tasks ?? 0, change: 'บันทึกผลและปิดใบงานแล้ว', icon: 'check', tone: 'green' },
  ]
  const campaigns = (demo ? demoCampaigns : dashboard?.campaigns ?? []) as Array<Record<string, unknown>>
  const tasks = (demo ? demoTasks : dashboard?.tasks ?? []) as Array<Record<string, unknown>>
  const chartBars = demo
    ? dayBars
    : (dashboard?.weekly_activity ?? []).map(item => ({
      day: new Intl.DateTimeFormat('th-TH', { weekday: 'short', timeZone: 'Asia/Bangkok' })
        .format(new Date(`${item.date}T12:00:00+07:00`)),
      count: Number(item.opened) || 0,
      done: Number(item.completed) || 0,
    }))
  const chartMaximum = Math.max(1, ...chartBars.map(bar => Math.max(0, Number(bar.count) || 0)))
  const chartAxis = [0, Math.round(chartMaximum / 3), Math.round(chartMaximum * 2 / 3), chartMaximum]
  return <div className="overview-content">
    <div className="welcome-strip"><div className="welcome-mark"><Activity size={20} /></div><div><strong>ติดตามงานเปลี่ยนเครื่องได้ตั้งแต่ต้นจนจบ</strong><span>สรุปภาพรวมใบงาน สาขา และงานภาคสนามในหน้าจอเดียว</span></div><button onClick={() => onNavigate('schedule')}>ดูใบงาน <ArrowRight size={15} /></button></div>
    <div className="section-heading-row"><div><h2>ภาพรวมระบบ</h2><p>สรุปสถานะล่าสุดของงานปฏิบัติการ</p></div><span className="period-label"><CalendarDays size={15} /> ทุกช่วงเวลา</span></div>
    <div className="stats-grid">{stats.map((stat, index) => <button type="button" className="stat-card stat-card-action" key={stat.label} aria-label={`เปิด${stat.label}`} onClick={() => onNavigate(index < 2 ? 'assets' : 'schedule')}><div className="stat-top"><span>{stat.label}</span><div className={'stat-icon ' + stat.tone}>{index === 0 ? <MapPin size={18} /> : index === 1 ? <HardDrive size={18} /> : index === 2 ? <Activity size={18} /> : <CheckCircle2 size={18} />}</div></div><div className="stat-value">{stat.value}</div><div className="stat-foot"><span className={'stat-change ' + (index === 3 ? 'positive' : '')}>{index === 3 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{stat.change}</span><span className="stat-period">ดูรายการ <ArrowRight size={12} /></span></div></button>)}</div>
    <div className="dashboard-grid">
      <section className="panel performance-panel"><div className="panel-heading"><div><h2>ใบงานที่เปิดในแต่ละวัน</h2><p>ดูใบงานที่สร้างใน 7 วันล่าสุด · กดกราฟเพื่อดูรายการ</p></div><button className="text-button" onClick={() => onNavigate('schedule')}>ดูใบงาน <ArrowRight size={15} /></button></div>{error ? <EmptyState compact title="โหลดสรุปรายวันไม่สำเร็จ" detail={error} /> : chartBars.length ? <><div className="chart-legend"><span><i className="legend-total" /> เปิดใบงาน</span><span><i className="legend-done" /> Completed</span></div><div className="bar-chart">{chartBars.map((bar, index) => <button type="button" className="bar-column bar-column-action" key={`${bar.day}-${index}`} aria-label={`เปิดรายการใบงานวัน${bar.day}`} onClick={() => onNavigate('schedule')}><span className="bars"><span className="bar-total" style={{ height: `${Math.max(0, Number(bar.count) || 0) / chartMaximum * 120}px` }}><span className="bar-done" style={{ height: getPercent(bar.done, bar.count) + '%' }} /></span></span><span>{bar.day}</span></button>)}</div><div className="chart-axis">{chartAxis.map((mark, index) => <span key={`${mark}-${index}`}>{mark.toLocaleString('th-TH')}{index === chartAxis.length - 1 ? ' ใบงาน' : ''}</span>)}</div></> : <EmptyState compact title="ยังไม่มีสรุปรายวัน" detail="กราฟจะแสดงวันที่เริ่มนับจากการเปิดใบงาน" />}</section>
      <section className="panel campaign-progress-panel"><div className="panel-heading"><div><h2>ความคืบหน้าใบงานรายสาขา</h2><p>งานที่กำลังติดตามจนถึง Completed</p></div><button className="more-button" onClick={() => onNavigate('schedule')}>ทั้งหมด <ChevronRight size={15} /></button></div><div className="campaign-list">{campaigns.slice(0, 3).map((item, index) => {
        const code = String(item.work_order_code || item.code || item.campaign_code || `WO-${index + 1}`)
        const name = String(item.branch_name || item.name || item.campaign_name || '')
        const total = Number(item.tasks || item.item_count || item.total_tasks || 0)
        const done = Number(item.done || item.finished_count || item.done_tasks || 0)
        const percent = getPercent(done, total)
        return <button type="button" className="campaign-progress campaign-progress-action" key={code} aria-label={`เปิดใบงาน ${code}`} onClick={() => onNavigate('schedule', code)}><span className="campaign-line"><span><strong>{name || 'ใบงานเปลี่ยน Scanner'}</strong><span>{code} <i>·</i> {total} เครื่อง</span></span><b>{percent}%</b></span><span className="progress-track"><span style={{ width: percent + '%' }} /></span></button>
      })}{!campaigns.length && <EmptyState compact title={error ? 'โหลดใบงานไม่สำเร็จ' : 'ยังไม่มีใบงาน'} detail={error || 'เมื่อเปิดใบงาน รายการจะแสดงที่นี่'} />}</div></section>
    </div>
    <section className="panel tasks-panel"><div className="panel-heading"><div><h2>ใบงาน Scanner ล่าสุด</h2><p>สาขา อุปกรณ์ Serial และผู้ปฏิบัติงาน</p></div><button className="text-button" onClick={() => onNavigate('schedule')}>ใบงานทั้งหมด <ArrowRight size={15} /></button></div>{tasks.length ? <TaskTable demo={demo} role={role} items={tasks.slice(0, 4)} showStatus={false} onTaskUpdated={onTaskUpdated} /> : <EmptyState compact title={error ? 'โหลดงานไม่สำเร็จ' : 'ยังไม่มีใบงาน'} detail={error || 'เปิดใบงานจากรายการอุปกรณ์ที่ยืนยันแล้ว'} />}</section>
  </div>
}

function Campaigns({ role, demo, items, loading, error, onRetry, onUpdated, onOpenScanner, search, setSearch, page, setPage }: { role?: string; demo: boolean; items: unknown[]; loading: boolean; error: string; onRetry: () => void; onUpdated: (message: string) => void; onOpenScanner: (serial: string) => void; search: string; setSearch: (value: string) => void; page: number; setPage: (page: number) => void }) {
  const [selectedCampaign, setSelectedCampaign] = useState<Record<string, unknown> | null>(null)
  const [selectedTask, setSelectedTask] = useState<Record<string, unknown> | null>(null)
  const [taskLoading, setTaskLoading] = useState(false)
  const [taskError, setTaskError] = useState('')
  const sourceRows = (items.length ? items : (demo ? demoCampaigns : [])) as Array<Record<string, unknown>>
  const searchTerm = search.trim().toLocaleLowerCase()
  const filteredRows = demo && searchTerm
    ? sourceRows.filter(row => `${row.name || row.campaign_name || ''} ${row.code || row.campaign_code || ''}`.toLocaleLowerCase().includes(searchTerm))
    : sourceRows
  const total = filteredRows.length
  const pageCount = Math.max(1, Math.ceil(total / campaignPageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const rows = filteredRows.slice(currentPage * campaignPageSize, (currentPage + 1) * campaignPageSize)
  const firstRow = total === 0 ? 0 : currentPage * campaignPageSize + 1
  const lastRow = Math.min((currentPage + 1) * campaignPageSize, total)
  async function openCampaignTask(assetId: string, taskId: string) {
    if (!supabase || !assetId || !taskId) return
    setSelectedTask(null)
    setTaskError('')
    setTaskLoading(true)
    try {
      const { data, error: rpcError } = await supabase.rpc('ais_scanner_work_history', {
        p_asset_id: assetId,
        p_task_id: taskId,
        p_limit: 1,
        p_offset: 0,
      })
      if (rpcError) throw rpcError
      const result = data as { rows?: unknown[] } | null
      const task = result?.rows?.[0]
      if (!task || typeof task !== 'object' || String((task as Record<string, unknown>).id) !== taskId) throw new Error('Work order not found')
      setSelectedTask(task as Record<string, unknown>)
    } catch {
      setTaskError('เปิดรายละเอียดใบงานไม่ได้ โปรดลองอีกครั้ง')
    } finally {
      setTaskLoading(false)
    }
  }
  return <><section className="panel list-panel"><div className="list-toolbar"><div className="search-box"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="ค้นหาชื่อหรือรหัสจากประวัติเดิม" /></div></div>
    {loading ? <EmptyState loading /> : error ? <EmptyState title="โหลดข้อมูลไม่สำเร็จ" detail={error} onRetry={onRetry} /> : rows.length ? <div className="table-wrap"><table><thead><tr><th>ข้อมูลรอบงานเดิม</th><th>จำนวนสาขา</th><th>ความคืบหน้าที่บันทึกไว้</th><th></th></tr></thead><tbody>{rows.map((row, i) => {
      const total = Number(row.tasks || row.total_tasks || 0)
      const done = Number(row.done || row.done_tasks || 0)
      return <tr key={String(row.code || row.campaign_code || i)}><td><div className="table-primary">{String(row.name || row.campaign_name || 'ข้อมูลรอบงานเดิม')}</div><div className="table-secondary">{String(row.code || row.campaign_code || '')} · {String(row.total_assets ?? row.tasks ?? 0)} เครื่อง</div></td><td>{String(row.branches ?? '—')} สาขา</td><td><div className="mini-progress"><span><i style={{ width: getPercent(done, total) + '%' }} /></span><small>{done}/{total} รายการ</small></div></td><td><button type="button" className="icon-button row-action" aria-label={`ดูรายละเอียด ${String(row.campaign_code || row.code || 'รอบงานเดิม')}`} title="ดูข้อมูลเดิมและรายการ SN" onClick={() => setSelectedCampaign(row)}><ChevronRight size={17} /></button></td></tr>
    })}</tbody></table></div> : <EmptyState title="ยังไม่มีประวัติงานเดิม" detail="หน้านี้จะแสดงข้อมูลที่บันทึกไว้จากกระบวนการก่อนหน้าเท่านั้น" />}
    <div className="list-footer"><span>แสดง {firstRow.toLocaleString('th-TH')}–{lastRow.toLocaleString('th-TH')} จาก {total.toLocaleString('th-TH')} รายการเดิม</span><div><button className="icon-button" aria-label="หน้าก่อน" disabled={loading || currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><span className="page-number">{currentPage + 1} / {pageCount}</span><button className="icon-button" aria-label="หน้าถัดไป" disabled={loading || currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div></div>
  </section>{selectedCampaign && <CampaignDetailsDialog campaign={selectedCampaign} role={role} demo={demo} onClose={() => setSelectedCampaign(null)} onUpdated={message => { setSelectedCampaign(null); onUpdated(message) }} onOpenScanner={serial => { setSelectedCampaign(null); onOpenScanner(serial) }} onOpenTask={(assetId, taskId) => { setSelectedCampaign(null); void openCampaignTask(assetId, taskId) }} />}
  {taskLoading && <div className="detail-readonly-note" role="status">กำลังโหลดรายละเอียดและหลักฐานใบงาน…</div>}
  {taskError && <div className="task-action-error" role="alert">{taskError} <button type="button" className="text-button" onClick={() => setTaskError('')}>ปิด</button></div>}
  {selectedTask && <WorkOrderDetailDialog task={selectedTask} role={role} demo={demo} readOnly onClose={() => setSelectedTask(null)} onUpdated={action => {
    const messages: Record<string, string> = { refresh: 'กำลังโหลดสถานะใบงานล่าสุด', closeout: 'บันทึกผลแล้ว อัปเดตทะเบียนและปิดรายการเป็น Completed แล้ว', resolve_pending: 'Admin พิจารณาและปิดรายการ Pending แล้ว', accept: 'Admin ลงนามรับผ่านและส่งมอบงานแล้ว', block: 'บันทึกสถานะ Pending แล้ว', resume: 'ใบงานกลับมาดำเนินการแล้ว' }
    onUpdated(messages[action] || 'เริ่มปฏิบัติงานแล้ว')
  }} />}</>
}

function Assets({ role, demo, items, loading, error, onRetry, search, setSearch, page, total, setPage, focusSerial, onFocusResolved }: { role?: string; demo: boolean; items: unknown[]; loading: boolean; error: string; onRetry: () => void; search: string; setSearch: (value: string) => void; page: number; total: number; setPage: (page: number) => void; focusSerial: string; onFocusResolved: () => void }) {
  const rows = (items.length ? items : (demo ? demoAssets : [])) as Array<Record<string, unknown>>
  const provinceGroups = groupRowsByProvince(rows)
  const [selectedAsset, setSelectedAsset] = useState<Record<string, unknown> | null>(null)
  const [focusMessage, setFocusMessage] = useState('')
  const linkedToWorkOrder = rows.filter(row => Boolean(String(row.campaign || '').trim())).length

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
    <div className="asset-summary"><div><span>อุปกรณ์ทั้งหมดตามการค้นหา</span><strong>{demo ? '1,284' : total.toLocaleString('th-TH')}</strong></div><div><span>มีใบงานในหน้านี้</span><strong>{demo ? '248' : linkedToWorkOrder}</strong></div><div><span>Serial ในหน้าจอผู้ชม</span><strong className="mask-example">••••••1234</strong></div></div>
    <section className="panel list-panel">
      <div className="list-toolbar"><div className="search-box"><Search size={17} /><input aria-label="ค้นหาสาขา จังหวัด LocationCode รุ่น หรือ Serial" value={search} onChange={event => { setFocusMessage(''); if (focusSerial) onFocusResolved(); setSearch(event.target.value) }} placeholder="ค้นหาสาขา จังหวัด LocationCode รุ่น หรือ Serial" /></div></div>
      {focusMessage && <div className="detail-readonly-note" role="status">{focusMessage}</div>}
      {loading ? <EmptyState loading /> : error ? <EmptyState title="โหลดข้อมูลไม่สำเร็จ" detail={error} onRetry={onRetry} /> : rows.length ? <>
        <div className="table-wrap asset-table-wrap"><table><thead><tr><th>สาขา / LocationCode</th><th>อุปกรณ์</th><th>Serial</th><th>ปีข้อมูลเดิม</th><th>ใบงานล่าสุด</th><th>สถานะงาน</th><th>รายละเอียด</th></tr></thead><tbody>{provinceGroups.flatMap(group => [
          <ProvinceTableGroup key={'province-' + group.province} group={group} colSpan={7} />,
          ...group.rows.map((row, i) => {
            const status = row.status ? getStatusPresentation(row.status) : { label: 'ยังไม่เลือก', tone: 'neutral' }
            const rowKey = String(row.id || String(row.location_code || 'asset') + '-' + String(row.com_sn || 'serial') + '-' + i)
            return <tr key={rowKey}><td><div className="table-primary">{String(row.branch || row.branch_name || row.loc_bld || 'สาขา')}</div><div className="table-secondary">{String(row.code || row.location_code || '')}</div></td><td>{String(row.model || row.model_name || row.hw_name || '—')}</td><td className="serial-cell">{String(row.serial || row.com_sn || '—')}</td><td>{String(row.year || row.com_years || '—')}</td><td>{String(row.campaign || '—')}</td><td><StatusPill label={status.label} tone={String(row.tone || status.tone)} /></td><td><button type="button" className="text-button asset-detail-action" onClick={() => setSelectedAsset(row)}>ดูรายละเอียด</button></td></tr>
          })
        ])}</tbody></table></div>
        <div className="asset-mobile-list">{provinceGroups.map(group => <ProvinceCardGroup key={'mobile-province-' + group.province} group={group}><div className="province-mobile-cards">{group.rows.map((row, i) => {
          const status = row.status ? getStatusPresentation(row.status) : { label: 'ยังไม่เลือก', tone: 'neutral' }
          const rowKey = String(row.id || String(row.location_code || 'asset') + '-' + String(row.com_sn || 'serial') + '-' + i)
          return <article className="mobile-record-card" key={rowKey}>
            <div className="mobile-record-heading"><div><strong>{String(row.serial || row.com_sn || 'Serial ไม่ระบุ')}</strong><span>{String(row.model || row.model_name || row.hw_name || 'เครื่องสแกน')}</span></div><StatusPill label={row.tone ? String(row.status || 'ยังไม่เลือก') : status.label} tone={String(row.tone || status.tone)} /></div>
            <div className="mobile-record-branch">{String(row.branch || row.branch_name || row.loc_bld || 'สาขาไม่ระบุ')}<small>LocationCode {String(row.code || row.location_code || '—')}</small></div>
            <div className="mobile-record-meta"><span>ปีข้อมูลเดิม<strong>{String(row.year || row.com_years || '—')}</strong></span><span>ใบงานล่าสุด<strong>{String(row.campaign || 'ยังไม่มีใบงาน')}</strong></span></div>
            <button className="mobile-card-action" onClick={() => setSelectedAsset(row)}>ดูรายละเอียด</button>
          </article>
        })}</div></ProvinceCardGroup>)}</div>
      </> : <EmptyState title="ยังไม่มีทะเบียนอุปกรณ์" detail="ทะเบียนจะแสดงหลังนำเข้าไฟล์ที่ผ่านการตรวจสอบแล้ว" />}
      <div className="list-footer"><span>{demo ? 'แสดง ' + rows.length + ' รายการตัวอย่าง' : error ? 'โหลดข้อมูลไม่สำเร็จ' : 'แสดง ' + (total ? page * 50 + 1 : 0) + '–' + Math.min(page * 50 + rows.length, total) + ' จาก ' + total.toLocaleString('th-TH') + ' รายการ'}</span><div><button className="icon-button" aria-label="ก่อนหน้า" disabled={demo || loading || page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button><span className="page-number">{demo ? 1 : page + 1}</span><button className="icon-button" aria-label="ถัดไป" disabled={demo || loading || (page + 1) * 50 >= total} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></div></div>
    </section>
    {selectedAsset && <AssetDetailDialog asset={selectedAsset} role={role} demo={demo} onClose={() => setSelectedAsset(null)} />}
  </>
}
function Schedule({ demo, role, items, loading, error, onRetry, onTaskUpdated, total, counts, page, setPage, search, setSearch, statusFilter, setStatusFilter }: { demo: boolean; role?: string; items: unknown[]; loading: boolean; error: string; onRetry: () => void; onTaskUpdated: (action: string) => void; total: number; counts: TaskCounts; page: number; setPage: (page: number) => void; search: string; setSearch: (value: string) => void; statusFilter: TaskStatusFilter; setStatusFilter: (value: TaskStatusFilter) => void }) {
  const sourceRows = (items.length ? items : (demo ? demoTasks : [])) as Array<Record<string, unknown>>
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const rows = useMemo(() => {
    if (!demo) return sourceRows
    const filtered = sourceRows.filter(row => {
      const status = getTaskWorkflowStage(row)
      const text = [row.branch_name, row.branch, row.province, row.location_code, row.code, row.scanner_model, row.model, row.com_sn, row.serial].map(value => String(value || '')).join(' ').toLocaleLowerCase()
      return (statusFilter === 'all' || status === statusFilter) && (!normalizedSearch || text.includes(normalizedSearch))
    })
    const groups = new Map<string, Array<Record<string, unknown>>>()
    for (const row of filtered) {
      const key = String(row.location_code || row.code || row.branch_name || row.branch || 'demo-branch')
      groups.set(key, [...(groups.get(key) || []), row])
    }
    return [...groups.entries()].map(([key, scanners], index) => ({
      id: `demo-work-order-${key}`,
      work_order_code: `DEMO-WO-${String(index + 1).padStart(3, '0')}`,
      branch_name: scanners[0].branch_name || scanners[0].branch,
      location_code: scanners[0].location_code || scanners[0].code,
      province: scanners[0].province,
      created_at: scanners[0].created_at,
      workflow_stage: scanners.some(scanner => getTaskWorkflowStage(scanner) === 'in_progress') ? 'in_progress' : 'open',
      item_count: scanners.length,
      finished_count: scanners.filter(scanner => ['delivered', 'exception_resolved', 'cancelled'].includes(getTaskWorkflowStage(scanner))).length,
      scanners: scanners.map((scanner, itemIndex) => ({ ...scanner, id: scanner.id || `${key}-${itemIndex}`, workflow_stage: getTaskWorkflowStage(scanner), task_status: scanner.task_status || 'scheduled' })),
    }))
  }, [demo, sourceRows, statusFilter, normalizedSearch])
  const firstRow = total === 0 ? 0 : page * 50 + 1
  const lastRow = Math.min(page * 50 + rows.length, total)
  return <>
    <div className="schedule-summary">
      <div className="summary-tile"><div className="summary-icon blue"><CalendarDays size={18} /></div><div><strong>{demo ? '4' : counts.open.toLocaleString('th-TH')}</strong><span>เปิดแล้ว · รอเริ่มงาน</span></div></div>
      <div className="summary-tile"><div className="summary-icon orange"><Clock3 size={18} /></div><div><strong>{demo ? '12' : counts.in_progress.toLocaleString('th-TH')}</strong><span>กำลังดำเนินการ</span></div></div>
      <div className="summary-tile"><div className="summary-icon red"><ShieldCheck size={18} /></div><div><strong>{demo ? '4' : (counts.awaiting_review + counts.blocked).toLocaleString('th-TH')}</strong><span>Pending</span></div></div>
      <div className="summary-tile"><div className="summary-icon green"><Check size={18} /></div><div><strong>{demo ? '214' : counts.completed.toLocaleString('th-TH')}</strong><span>Completed</span></div></div>
    </div>
    <section className="panel list-panel">
      <div className="list-toolbar schedule-toolbar"><label className="search-box schedule-search-box"><Search size={15} aria-hidden="true" /><input aria-label="ค้นหาใบงานตาม Serial รหัสสาขา จังหวัด หรือรุ่น" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} placeholder="ค้นหา Serial, รหัสสาขา จังหวัด หรือรุ่น" /></label><label className="schedule-status-label"><span className="visually-hidden">กรองสถานะใบงาน</span><select className="filter-button schedule-status-filter" aria-label="กรองสถานะใบงาน" value={statusFilter} onChange={event => setStatusFilter(event.target.value as TaskStatusFilter)}><option value="all">ทุกขั้นตอน</option><option value="open">เปิดแล้ว · รอเริ่มงาน</option><option value="in_progress">กำลังดำเนินการ</option><option value="pending">Pending</option><option value="delivered">Completed</option><option value="exception_resolved">ปิดแล้ว · มีข้อยกเว้น</option><option value="legacy_completed">เสร็จแล้ว (ประวัติเดิม)</option><option value="cancelled">ยกเลิก</option></select></label></div>
      {loading ? <EmptyState loading /> : error ? <EmptyState title="โหลดข้อมูลไม่สำเร็จ" detail={error} onRetry={onRetry} /> : rows.length ? <BranchWorkOrderTable demo={demo} role={role} items={rows} onTaskUpdated={onTaskUpdated} /> : <EmptyState title="ยังไม่มีใบงานตามตัวกรอง" detail="เลือกสาขาและ SN จากทะเบียนที่ตรวจสอบแล้ว แล้วเปิดใบงานรายสาขา" />}
      <div className="list-footer"><span>{demo ? `แสดง ${rows.length} ใบงานตัวอย่าง` : `แสดง ${firstRow}–${lastRow} จาก ${total.toLocaleString('th-TH')} ใบงาน`}</span><div><button className="icon-button" aria-label="งานหน้าก่อน" disabled={demo || loading || page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button><span className="page-number">{demo ? 1 : page + 1}</span><button className="icon-button" aria-label="งานหน้าถัดไป" disabled={demo || loading || (page + 1) * 50 >= total} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></div></div>
    </section>
  </>
}

function BranchWorkOrderTable({ demo, role, items, onTaskUpdated }: { demo: boolean; role?: string; items: Array<Record<string, unknown>>; onTaskUpdated: (action: string) => void }) {
  const [selectedOrder, setSelectedOrder] = useState<Record<string, unknown> | null>(null)
  const provinceGroups = groupRowsByProvince(items)
  return <>
    <div className="table-wrap task-table-wrap"><table><thead><tr><th>สาขา / LocationCode</th><th>รหัสใบงาน</th><th>จำนวน Scanner</th><th>เปิดใบงานเมื่อ</th><th>สถานะใบงาน</th><th></th></tr></thead><tbody>{provinceGroups.flatMap(group => [
      <ProvinceTableGroup key={'work-order-province-' + group.province} group={group} colSpan={6} />,
      ...group.rows.map((row, index) => {
        const rowId = String(row.id || row.work_order_id || index)
        const status = String(row.workflow_stage || row.status || 'open')
        const presentation = getStatusPresentation(status)
        const itemCount = Number(row.item_count || (Array.isArray(row.scanners) ? row.scanners.length : 0))
        return <tr key={rowId}>
          <td><div className="table-primary">{String(row.branch_name || 'สาขาไม่ระบุ')}</div><div className="table-secondary">{String(row.province || 'ไม่ระบุจังหวัด')} · {String(row.location_code || '—')}</div></td>
          <td><div className="table-primary">{String(row.work_order_code || 'ใบงาน')}</div><div className="table-secondary">{row.origin === 'legacy' ? 'ประวัติเดิม' : 'ใบงานรายสาขา'}</div></td>
          <td><strong>{itemCount.toLocaleString('th-TH')} เครื่อง</strong><div className="table-secondary">เสร็จ/ยกเลิก {Number(row.finished_count || 0).toLocaleString('th-TH')}</div></td>
          <td>{formatDate(row.created_at) || '—'}</td><td><StatusPill label={presentation.label} tone={presentation.tone} /></td>
          <td><button type="button" className="icon-button row-action" aria-label={'เปิดใบงานสาขา ' + String(row.location_code || '')} title="ดูรายการ SN และรายละเอียดใบงาน" onClick={() => setSelectedOrder(row)}><ChevronRight size={17} /></button></td>
        </tr>
      })
    ])}</tbody></table></div>
    <div className="asset-mobile-list task-mobile-list">{provinceGroups.map(group => <ProvinceCardGroup key={'work-order-mobile-' + group.province} group={group}><div className="province-mobile-cards">{group.rows.map((row, index) => {
      const rowId = String(row.id || row.work_order_id || index)
      const status = getStatusPresentation(String(row.workflow_stage || row.status || 'open'))
      const itemCount = Number(row.item_count || (Array.isArray(row.scanners) ? row.scanners.length : 0))
      return <article className="mobile-record-card task-mobile-card" key={rowId}>
        <div className="mobile-record-heading"><div><strong>{String(row.work_order_code || 'ใบงาน')}</strong><span>{itemCount.toLocaleString('th-TH')} Scanner ในสาขาเดียว</span></div><StatusPill label={status.label} tone={status.tone} /></div>
        <div className="mobile-record-branch">{String(row.branch_name || 'สาขาไม่ระบุ')}<small>{String(row.province || 'ไม่ระบุจังหวัด')} · LocationCode {String(row.location_code || '—')}</small></div>
        <div className="mobile-record-meta"><span>เปิดใบงาน<strong>{formatDate(row.created_at) || '—'}</strong></span><span>ความคืบหน้า<strong>{Number(row.finished_count || 0)} / {itemCount} เครื่อง</strong></span></div>
        <button className="mobile-card-action" onClick={() => setSelectedOrder(row)}>ดู SN และรายละเอียดใบงาน</button>
      </article>
    })}</div></ProvinceCardGroup>)}</div>
    {selectedOrder && <BranchWorkOrderDialog order={selectedOrder} role={role} demo={demo} onClose={() => setSelectedOrder(null)} onUpdated={onTaskUpdated} />}
  </>
}

function BranchWorkOrderDialog({ order, role, demo, onClose, onUpdated }: { order: Record<string, unknown>; role?: string; demo: boolean; onClose: () => void; onUpdated: (action: string) => void }) {
  const [selectedScanner, setSelectedScanner] = useState<Record<string, unknown> | null>(null)
  const close = useCallback(() => setSelectedScanner(null), [])
  const dialogRef = useDialogControls(onClose)
  const scanners = Array.isArray(order.scanners) ? order.scanners.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : []
  const status = getStatusPresentation(String(order.workflow_stage || order.status || 'open'))
  if (selectedScanner) return <WorkOrderDetailDialog task={selectedScanner} role={role} demo={demo} onClose={close} onUpdated={action => { onUpdated(action) }} />
  return <div className="detail-overlay work-order-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} className="detail-dialog work-order-dialog branch-work-order-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="branch-work-order-title" tabIndex={-1}>
      <header className="detail-dialog-header"><button type="button" className="detail-back" aria-label="กลับไปรายการใบงาน" onClick={onClose}><ChevronLeft size={20} /></button><div><span className="detail-eyebrow">ใบงานรายสาขา · {String(order.work_order_code || '')}</span><h2 id="branch-work-order-title">รายละเอียดใบงานเปลี่ยนเครื่อง</h2></div><button type="button" className="detail-close" aria-label="ปิดรายละเอียดใบงาน" onClick={onClose}><X size={18} /></button></header>
      <div className="work-order-content">
        <div className="work-order-identity"><div><strong>{String(order.branch_name || 'สาขาไม่ระบุ')}</strong><span>{String(order.province || 'ไม่ระบุจังหวัด')} · LocationCode {String(order.location_code || '—')}</span><small>เปิดเมื่อ {formatDate(order.created_at) || '—'} · {scanners.length} Scanner</small></div><StatusPill label={status.label} tone={status.tone} /></div>
        <section className="detail-section branch-work-order-items"><div className="scanner-work-detail-heading"><div><h3>รายการ SN ในใบงาน</h3><p>ข้อมูลทะเบียนที่นำเข้าแล้วถือว่ายืนยัน ไม่ต้องให้ช่างตรวจ SN ซ้ำ เลือก SN เพื่อดูผล หลักฐาน และทำขั้นตอนของเครื่องนั้น</p></div><strong>{scanners.length.toLocaleString('th-TH')} เครื่อง</strong></div>
          {scanners.length ? <div className="branch-work-order-item-list">{scanners.map(scanner => {
            const itemStatus = getStatusPresentation(String(scanner.workflow_stage || scanner.task_status || 'open'))
            const serial = scanner.old_serial_snapshot || scanner.com_sn || scanner.serial || 'SN ไม่ระบุ'
            return <article className="branch-work-order-item" key={String(scanner.id)}><div><strong>{String(serial)}</strong><span>{String(scanner.scanner_model || scanner.model || 'ไม่ระบุรุ่น')}</span><small>{scanner.workflow_outcome ? getStatusPresentation(String(scanner.workflow_outcome)).label : 'ผลหน้างานยังไม่บันทึก'}</small></div><StatusPill label={itemStatus.label} tone={itemStatus.tone} /><button type="button" className="secondary-button" onClick={() => setSelectedScanner(scanner)}>รายละเอียด / ดำเนินการ</button></article>
          })}</div> : <EmptyState title="ไม่พบรายการ Scanner" detail="ปิดใบงานนี้แล้วโหลดรายการใหม่" />}
        </section>
        <div className="detail-readonly-note"><ShieldCheck size={16} /><span>เมื่อ SN ไม่ตรงหรือหาเครื่องไม่พบ ให้เลือกผลกรณียกเว้นและระบุสิ่งที่พบ ระบบจะยังไม่เปลี่ยนทะเบียนจนกว่า Admin ตรวจสอบ</span></div>
      </div>
    </section>
  </div>
}

function TaskTable({ demo = false, role, items, showStatus = true, onTaskUpdated = () => undefined }: { demo?: boolean; role?: string; items: Array<Record<string, unknown>>; showStatus?: boolean; onTaskUpdated?: (action: string) => void }) {
  const [selectedTask, setSelectedTask] = useState<Record<string, unknown> | null>(null)
  const provinceGroups = groupRowsByProvince(items)
  const renderRow = (row: Record<string, unknown>, index: number) => {
    const status = getTaskWorkflowStage(row)
    const presentation = getStatusPresentation(status)
    const branch = row.branch || row.branch_name || 'สาขา'
    const code = row.code || row.location_code || ''
    const model = row.model || row.scanner_model || 'เครื่องสแกน'
    const serial = row.serial || row.com_sn || '—'
    const created = formatDate(row.created_at) || 'ไม่ทราบวันเปิดใบงาน'
    const performer = row.performed_by_name || 'ยังไม่มีผู้ส่งผลปฏิบัติงาน'
    const rowKey = String(row.id || String(row.location_code || 'task') + '-' + index)
    return <tr key={rowKey}><td><div className="table-primary">{String(branch)}</div><div className="table-secondary">{String(code)}</div></td><td>{String(model)}</td><td className="serial-cell">{String(serial)}</td><td><div className="table-primary">{created}</div><div className="table-secondary">{String(performer)}</div></td>{showStatus && <td><StatusPill label={row.tone ? String(row.status || presentation.label) : presentation.label} tone={String(row.tone || presentation.tone)} /></td>}<td><button type="button" className="icon-button row-action" aria-label={'เปิดใบงาน ' + String(serial)} title="ดูใบงานของ Scanner เครื่องนี้" onClick={() => setSelectedTask(row)}><ChevronRight size={17} /></button></td></tr>
  }
  const renderMobileCard = (row: Record<string, unknown>, index: number) => {
    const status = getTaskWorkflowStage(row)
    const presentation = getStatusPresentation(status)
    const branch = row.branch || row.branch_name || 'สาขา'
    const code = row.code || row.location_code || ''
    const model = row.model || row.scanner_model || 'เครื่องสแกน'
    const serial = row.serial || row.com_sn || '—'
    const created = formatDate(row.created_at) || 'ไม่ทราบวันเปิดใบงาน'
    const performer = row.performed_by_name || 'ยังไม่มีผู้ส่งผลปฏิบัติงาน'
    const rowKey = String(row.id || String(row.location_code || 'task') + '-' + index)
    return <article className="mobile-record-card task-mobile-card" key={rowKey}>
      <div className="mobile-record-heading"><div><strong>{String(serial)}</strong><span>{String(model)}</span></div>{showStatus && <StatusPill label={row.tone ? String(row.status || presentation.label) : presentation.label} tone={String(row.tone || presentation.tone)} />}</div>
      <div className="mobile-record-branch">{String(branch)}<small>LocationCode {String(code || '—')}</small></div>
      <div className="mobile-record-meta"><span>เปิดใบงาน<strong>{created}</strong></span><span>ผู้ปฏิบัติงาน<strong>{String(performer)}</strong></span></div>
      <button className="mobile-card-action" onClick={() => setSelectedTask(row)}>เปิดใบงาน Scanner เครื่องนี้</button>
    </article>
  }
  return <>
    <div className="table-wrap task-table-wrap"><table><thead><tr><th>สาขา / LocationCode</th><th>อุปกรณ์เดิม</th><th>Serial</th><th>วันที่เปิด / ผู้ปฏิบัติงาน</th>{showStatus && <th>สถานะงาน</th>}<th></th></tr></thead><tbody>{provinceGroups.flatMap(group => [
      <ProvinceTableGroup key={'province-' + group.province} group={group} colSpan={showStatus ? 6 : 5} />,
      ...group.rows.map((row, index) => renderRow(row, index))
    ])}</tbody></table></div>
    <div className="task-mobile-list">{provinceGroups.map(group => <ProvinceCardGroup key={'mobile-province-' + group.province} group={group}><div className="province-mobile-cards">{group.rows.map((row, index) => renderMobileCard(row, index))}</div></ProvinceCardGroup>)}</div>
    {selectedTask && <WorkOrderDetailDialog task={selectedTask} role={role} demo={demo} onClose={() => setSelectedTask(null)} onUpdated={onTaskUpdated} />}
  </>
}
function useDialogControls(onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusables = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
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
    requestAnimationFrame(() => focusables()[0]?.focus())
    return () => {
      window.removeEventListener('keydown', handleKeys)
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [onClose])
  return dialogRef
}

function DetailField({ label, value }: { label: string; value: unknown }) {
  const text = String(value ?? '').trim()
  return <div className="detail-field"><span>{label}</span><strong>{text || '—'}</strong></div>
}

const ignoreEvidenceState = () => undefined

function AssetDetailDialog({ asset, role, demo, onClose }: { asset: Record<string, unknown>; role?: string; demo: boolean; onClose: () => void }) {
  const dialogRef = useDialogControls(onClose)
  const serial = asset.serial || asset.com_sn || '—'
  const model = asset.model || asset.model_name || asset.hw_name || 'เครื่องสแกน'
  const branch = asset.branch || asset.branch_name || asset.loc_bld || 'สาขาไม่ระบุ'
  const code = asset.code || asset.location_code || '—'
  const campaignLabel = String(asset.campaign || '').trim()
  const status = asset.status ? getStatusPresentation(asset.status) : { label: 'ยังไม่เลือก', tone: 'neutral' }
  const assetId = String(asset.id || '')
  const canViewHistory = !demo && ['admin', 'field_technician'].includes(String(role))
  const [workHistory, setWorkHistory] = useState<Array<Record<string, unknown>>>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyRetry, setHistoryRetry] = useState(0)
  const [selectedHistoryTaskId, setSelectedHistoryTaskId] = useState('')
  useEffect(() => {
    let active = true
    if (!canViewHistory) {
      setWorkHistory([])
      setSelectedHistoryTaskId('')
      setHistoryLoading(false)
      setHistoryError('')
      return () => { active = false }
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assetId) || !supabase) {
      setWorkHistory([])
      setSelectedHistoryTaskId('')
      setHistoryLoading(false)
      setHistoryError('โหลดประวัติใบงานไม่ได้')
      return () => { active = false }
    }
    setHistoryLoading(true)
    setHistoryError('')
    const client = supabase
    void (async () => {
      try {
        const { data, error } = await client.rpc('ais_scanner_work_history', { p_asset_id: assetId, p_task_id: null, p_limit: 10, p_offset: 0 })
        if (error) throw error
        const result = data as { rows?: unknown } | null
        const rows = Array.isArray(result?.rows) ? result.rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object') : []
        if (active) {
          setWorkHistory(rows)
          setSelectedHistoryTaskId(String(rows[0]?.id || ''))
        }
      } catch {
        if (active) {
          setWorkHistory([])
          setSelectedHistoryTaskId('')
          setHistoryError('โหลดประวัติการเปลี่ยนและผู้ปฏิบัติงานไม่สำเร็จ โปรดลองใหม่')
        }
      } finally { if (active) setHistoryLoading(false) }
    })()
    return () => { active = false }
  }, [assetId, canViewHistory, historyRetry])
  const selectedHistoryTask = workHistory.find(task => String(task.id || '') === selectedHistoryTaskId) || null
  return <div className="detail-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} className="detail-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-detail-title" tabIndex={-1}>
      <header className="detail-dialog-header"><button type="button" className="detail-back" aria-label="กลับไปทะเบียนอุปกรณ์" onClick={onClose}><ChevronLeft size={20} /></button><div><span className="detail-eyebrow">ทะเบียนอุปกรณ์</span><h2 id="asset-detail-title">รายละเอียด Scanner</h2></div><button type="button" className="detail-close" aria-label="ปิดรายละเอียด" onClick={onClose}><X size={18} /></button></header>
      <div className="detail-status-line"><span className="detail-status-dot" /><strong>{String(model)}</strong><StatusPill label={asset.tone ? String(asset.status || status.label) : status.label} tone={String(asset.tone || status.tone)} /></div>
          <section className="detail-section"><h3>ข้อมูลอุปกรณ์</h3><div className="detail-grid"><DetailField label="Serial Number" value={serial} /><DetailField label="รุ่น" value={model} /><DetailField label="สาขา" value={branch} /><DetailField label="LocationCode" value={code} /><DetailField label="จังหวัด" value={asset.province} /><DetailField label="ปีข้อมูลเดิม" value={asset.year || asset.com_years} /><DetailField label="ใบงานล่าสุด" value={asset.campaign || 'ยังไม่มีใบงาน'} /></div></section>
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
                  <TaskEvidencePanel key={String(selectedHistoryTask.id)} taskId={String(selectedHistoryTask.id)} canEdit={false} canView={canViewHistory} requiredSlots={[...requiredEvidenceSlotsForOutcome(String(selectedHistoryTask.workflow_outcome || '')), ...(selectedHistoryTask.admin_accepted_at ? ['inspector_signature' as const] : [])]} outcome={String(selectedHistoryTask.workflow_outcome || '')} onRequiredReady={ignoreEvidenceState} onBusyChange={ignoreEvidenceState} />
                </>}
              </>
                : <p className="detail-empty-result">{campaignLabel && !['—', '-'].includes(campaignLabel) ? `Scanner เครื่องนี้อยู่ในใบงาน ${campaignLabel} แต่ยังไม่มีผลปฏิบัติงานหรือหลักฐานให้แสดง` : 'ยังไม่มีใบงานที่เปิดสำหรับ Scanner เครื่องนี้ จึงยังไม่มีผู้เปลี่ยนหรือหลักฐานให้แสดง'}</p>}
      </section>
      <div className="detail-readonly-note"><ShieldCheck size={16} /><span>หน้านี้แสดงข้อมูลทะเบียนแบบอ่านอย่างเดียว</span></div>
    </section>
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
  const serverStage = String(task.workflow_stage || (demo ? getTaskWorkflowStage(task) : status === 'scheduled' ? 'open' : status === 'completed' ? 'legacy_completed' : status))
  const taskId = String(task.id || '').trim()
  const [evidenceStartedTask, setEvidenceStartedTask] = useState<{ id: string; version: number } | null>(null)
  const startedLocally = evidenceStartedTask?.id === taskId && serverStage === 'open'
  const stage = startedLocally ? 'in_progress' : serverStage
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
    : stage === 'in_progress' || stage === 'blocked' ? 1
    : ['blocked', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review'].includes(stage) ? 2
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
    if (!supabase || !validTaskVersion) {
      setActionError('เชื่อมต่อระบบไม่ได้หรือข้อมูลใบงานล้าสมัย โปรดปิดแล้วเปิดใบงานใหม่')
      return
    }
    setBusy(true)
    try {
      const { error } = await supabase.rpc('ais_field_task_action', {
        p_task_id: taskId,
        p_action: action,
        p_expected_version: version,
        p_reason: reason || null,
        p_new_serial: null,
        p_install_result: null,
        p_old_scanner_status: null,
        p_old_scanner_note: null,
      })
      if (error) {
        if (error.code === '40001') setActionError('ใบงานถูกอัปเดตจากอีกหน้าจอแล้ว โปรดปิดแล้วเปิดใบงานใหม่')
        else if (error.code === '42501') setActionError('บัญชีนี้ไม่มีสิทธิ์ดำเนินการใบงานนี้')
        else if (error.code === '22023') setActionError('สถานะใบงานไม่อนุญาตให้ทำขั้นตอนนี้ โปรดโหลดรายการล่าสุด')
        else setActionError('บันทึกใบงานไม่สำเร็จ โปรดลองใหม่')
        if (error.code === '40001' || error.code === '22023') onUpdated('refresh')
        return
      }
      onUpdated(action)
      onClose()
    } catch {
      setActionError('การเชื่อมต่อขาดช่วง โปรดตรวจสถานะใบงานก่อนลองใหม่')
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
    if (!supabase || !validTaskVersion) { setActionError('เชื่อมต่อระบบไม่ได้หรือข้อมูลใบงานล้าสมัย โปรดโหลดใบงานใหม่'); return }
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
      const { error } = await supabase.rpc('ais_technician_submit_closeout', {
        p_task_id: taskId,
        p_expected_version: version,
        p_outcome: outcomeInput,
        p_new_serial: outcomeInput === 'replaced' ? cleanSerial : null,
        p_install_result: cleanResult,
        p_old_scanner_status: outcomeInput === 'replaced' ? oldStatusInput : outcomeInput === 'no_damage_found' ? 'returned_usable' : outcomeInput === 'different_device_found' ? 'other' : 'not_returned',
        p_old_scanner_note: outcomeInput === 'replaced' ? (cleanOldNote || null) : outcomeInput === 'different_device_found' || outcomeInput === 'target_device_not_found' ? cleanReason : null,
        p_observed_serial: outcomeInput === 'different_device_found' ? cleanObserved : null,
        p_observed_model: outcomeInput === 'different_device_found' ? observedModelInput.trim() || null : null,
        p_exception_reason: outcomeInput === 'replaced' ? null : cleanReason,
      })
      if (error) {
        if (error.code === '40001') setActionError('ใบงานถูกอัปเดตจากอีกหน้าจอแล้ว โปรดเปิดใบงานใหม่')
        else if (error.code === '23505') setActionError('Serial เครื่องนี้มีรายการซ้ำในระบบ โปรดตรวจสอบก่อนส่งปิดงาน')
        else if (error.code === '42501') setActionError('บัญชีนี้ไม่มีสิทธิ์ส่งปิดใบงาน')
        else if (error.code === '22023') setActionError('ข้อมูลปิดงานยังไม่ครบ โปรดตรวจช่องที่จำเป็น')
        else setActionError('ส่งปิดงานไม่สำเร็จ โปรดตรวจการเชื่อมต่อแล้วลองใหม่')
        if (error.code === '40001') onUpdated('refresh')
        return
      }
      onUpdated('closeout_pending')
      onClose()
    } catch {
      setActionError('ยังยืนยันผลส่งปิดงานไม่ได้ โปรดโหลดสถานะล่าสุดก่อนลองซ้ำ')
      onUpdated('refresh')
    } finally { setBusy(false) }
  }

  const resolvePending = async () => {
    setActionError('')
    if (!supabase || !validTaskVersion) { setActionError('เชื่อมต่อระบบไม่ได้หรือข้อมูลใบงานล้าสมัย โปรดเปิดใบงานใหม่'); return }
    if (!requiredEvidenceReady) { setActionError('ตรวจหลักฐานและลงลายเซ็นผู้ตรวจรับให้ครบก่อนปิดรายการ'); return }
    setBusy(true)
    try {
      const rpcName = outcome === 'replaced' ? 'ais_admin_accept_task' : 'ais_admin_resolve_pending'
      const { error } = await supabase.rpc(rpcName, {
        p_task_id: taskId,
        p_expected_version: version,
        p_register_observed_serial: registerObservedSerial,
      })
      if (error) {
        if (error.code === '40001') setActionError('ใบงานถูกอัปเดตจากอีกหน้าจอแล้ว โปรดโหลดรายการล่าสุด')
        else if (error.code === '23505' && outcome === 'different_device_found') setActionError('SN เครื่องที่พบอยู่ในทะเบียนอีกสาขา ระบบจึงไม่เพิ่มหรือเปลี่ยนทะเบียน โปรดให้ Admin ตรวจและแก้ข้อมูลหลักก่อนปิด Pending')
        else if (error.code === '23505') setActionError('Serial เครื่องนี้ถูกใช้แล้ว โปรดตรวจสอบทะเบียนก่อนปิด Pending')
        else if (error.code === '42501') setActionError('ต้องใช้บัญชี Admin ที่เปิดใช้งานและมีสิทธิ์พิจารณารายการนี้')
        else if (error.code === '22023') setActionError('ปิดรายการ Pending ไม่สำเร็จ โปรดตรวจสถานะใบงานล่าสุด')
        else setActionError('ตรวจรายการ Pending ไม่สำเร็จ โปรดลองใหม่')
        if (error.code === '40001') onUpdated('refresh')
        return
      }
      onUpdated(outcome === 'replaced' ? 'accept' : 'resolve_exception')
      onClose()
    } catch {
      setActionError('บันทึกผลตรวจสอบไม่ได้ โปรดโหลดสถานะล่าสุดก่อนลองซ้ำ')
      onUpdated('refresh')
    } finally { setBusy(false) }
  }

  const submitCancel = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const reason = cancelReason.trim()
    if (!reason || reason.length > 500 || !validTaskVersion || !supabase) {
      setActionError('กรอกเหตุผล 1–500 ตัวอักษร แล้วโหลดใบงานล่าสุดก่อนยืนยัน'); return
    }
    setBusy(true)
    setActionError('')
    try {
      const { error } = await supabase.rpc('ais_cancel_task', { p_task_id: taskId, p_expected_version: version, p_reason: reason })
      if (error) {
        if (error.code === '40001') setActionError('ใบงานถูกอัปเดตจากอีกหน้าจอแล้ว โปรดโหลดสถานะล่าสุด')
        else if (error.code === '42501') setActionError('บัญชีนี้ไม่มีสิทธิ์ยกเลิกใบงาน')
        else setActionError('ยกเลิกใบงานไม่สำเร็จ โปรดลองใหม่')
        if (error.code === '40001') onUpdated('refresh')
        return
      }
      onUpdated('cancel')
      onClose()
    } catch {
      setActionError('การเชื่อมต่อขาดช่วง โปรดตรวจสถานะใบงานก่อนลองยกเลิกซ้ำ')
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
          <section className="detail-section work-order-serial-section"><h3>Serial เครื่องเก่าและเครื่องใหม่</h3><div className="work-order-serial-comparison"><div><span>SN เครื่องเดิม</span><strong>{String(serial)}</strong></div><span className="work-order-serial-arrow" aria-hidden="true">→</span><div><span>SN เครื่องใหม่</span><strong>{newSerial ? String(newSerial) : 'ยังไม่มีข้อมูล'}</strong></div></div>{outcome === 'different_device_found' && <div className="work-order-observed-serial"><span>SN อุปกรณ์ที่พบ</span><strong>{observedSerial ? String(observedSerial) : 'ยังไม่มีข้อมูล'}</strong></div>}</section>
          {(status === 'blocked' || isPendingStage) && Boolean(task.blocked_reason || exceptionReason) && <section className="detail-section"><h3>เหตุผลที่ Pending</h3><p className="task-blocked-reason">{String(task.blocked_reason || exceptionReason)}</p></section>}
          <section className="detail-section"><h3>ผลการเปลี่ยน/ตรวจสอบ</h3><div className="detail-grid"><DetailField label="ผลใบงาน" value={outcome ? getStatusPresentation(outcome).label : 'ยังไม่ส่งผลปฏิบัติงาน'} /><DetailField label="ผู้ปฏิบัติงานที่ส่งผล" value={task.performed_by_name || 'ยังไม่มีผู้ส่งผลปฏิบัติงาน'} /><DetailField label="วันและเวลาปฏิบัติงาน" value={formatDate(task.performed_at) || 'ยังไม่มีเวลาบันทึก'} /><DetailField label="SN เดิมตามทะเบียน" value={task.old_serial_snapshot || serial} /><DetailField label={outcome === 'different_device_found' ? 'SN เครื่องที่พบ' : 'Serial อุปกรณ์ที่พบ'} value={observedSerial || 'ยังไม่มีข้อมูล'} /><DetailField label="รุ่นเครื่องที่พบ" value={task.observed_model} /><DetailField label="ผลการติดตั้งและทดสอบ" value={installResult || 'ยังไม่มีข้อมูล'} /><DetailField label="สถานะเครื่องเดิม" value={recordedOldStatus ? oldStatusLabels[String(recordedOldStatus)] || String(recordedOldStatus) : 'ยังไม่มีข้อมูล'} /><DetailField label="เหตุผล/หมายเหตุ" value={exceptionReason || task.old_scanner_note || 'ยังไม่มีข้อมูล'} /></div><p className="detail-empty-result">ผู้ปฏิบัติงานและเวลาอ้างอิงจากบัญชีที่ส่งผลและเวลาที่บันทึกจริง</p></section>
          {((canViewEvidence && Boolean(taskId)) || demo) && <TaskEvidencePanel key={taskId || 'demo'} taskId={taskId || undefined} canEdit={canEditEvidence} editableSlots={editableSlots} requiredSlots={stageRequiredSlots} canView={canViewEvidence} previewOnly={demo} outcome={outcome || outcomeInput} onRequiredReady={setRequiredEvidenceReady} onBusyChange={setEvidenceBusy} onTaskStarted={nextVersion => {
            setEvidenceStartedTask(current => current?.id === taskId && current.version > nextVersion ? current : { id: taskId, version: nextVersion })
            onUpdated('start')
          }} />}
          {!demo && !canViewEvidence && <section className="detail-section"><h3>หลักฐานประกอบ</h3><p className="detail-empty-result">หลักฐานใบงานดูได้โดย Admin และช่างที่มีสิทธิ์เข้าระบบ</p></section>}
          {canAct && stage === 'in_progress' && <section className="detail-section task-action-panel"><h3>บันทึกผลปฏิบัติงาน</h3><p>กรณีเปลี่ยนเครื่อง ต้องบันทึกรูปหลักฐานเครื่องเก่า 4 รูป เครื่องใหม่ 6 รูป และลายเซ็นช่างกับผู้ใช้ Scanner ให้ครบก่อนส่งผล จากนั้น Admin อีกบัญชีจะตรวจหลักฐาน ลงลายเซ็นรับผ่าน แล้วระบบจึงอัปเดตทะเบียนและส่งมอบงาน หากพบเครื่องอื่นหรือไม่พบเครื่องตาม SN ให้ส่งเป็น Pending เพื่อให้ Admin ตรวจ</p><form className="task-action-form" onSubmit={submitCloseout}>
            <label>ผลการเข้าหน้างาน<select value={outcomeInput} onChange={event => { setOutcomeInput(event.target.value); setActionError('') }}><option value="replaced">เปลี่ยนเครื่องสำเร็จ</option><option value="no_damage_found">ไม่พบเครื่องชำรุด</option><option value="different_device_found">ไม่พบ SN ตามใบงาน แต่พบเครื่องอื่น</option><option value="target_device_not_found">ไม่พบ SN ตามใบงานและไม่พบเครื่องอื่น</option></select></label>
            {outcomeInput === 'different_device_found' && <p className="detail-readonly-note"><ShieldCheck size={16} /><span>บันทึก SN ที่พบและเหตุผล รายการนี้จะเป็น Pending; ระบบยังไม่เพิ่มหรือเปลี่ยนข้อมูลทะเบียนจนกว่า Admin ตรวจ</span></p>}
            {outcomeInput === 'target_device_not_found' && <p className="detail-readonly-note"><ShieldCheck size={16} /><span>บันทึกเหตุผล รายการนี้จะเป็น Pending เพื่อให้ Admin ตรวจ ไม่เพิ่ม SN ใหม่</span></p>}
            {isReplacement && <label>Serial เครื่องใหม่<input value={newSerialInput} onChange={event => setNewSerialInput(event.target.value)} maxLength={100} required autoComplete="off" /></label>}
            {outcomeInput === 'different_device_found' && <><label>Serial ของอุปกรณ์ที่พบ<input value={observedSerialInput} onChange={event => setObservedSerialInput(event.target.value)} maxLength={100} required autoComplete="off" /></label><label>รุ่นของอุปกรณ์ที่พบ (ถ้าทราบ)<input value={observedModelInput} onChange={event => setObservedModelInput(event.target.value)} maxLength={100} autoComplete="off" /></label></>}
            <label>ผลการติดตั้ง/ตรวจสอบ<textarea value={installResultInput} onChange={event => setInstallResultInput(event.target.value)} maxLength={500} required rows={3} /></label>
            {isReplacement && <label>สถานะเครื่องเดิม<select value={oldStatusInput} onChange={event => setOldStatusInput(event.target.value)} required><option value="" disabled>เลือกสถานะเครื่องเดิม</option>{Object.entries(oldStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
            {isReplacement && oldStatusInput === 'other' && <label>หมายเหตุเครื่องเดิม<textarea value={oldStatusNote} onChange={event => setOldStatusNote(event.target.value)} maxLength={1000} required rows={3} /></label>}
            {!isReplacement && <label>เหตุผล/รายละเอียด<textarea value={exceptionReasonInput} onChange={event => setExceptionReasonInput(event.target.value)} maxLength={1000} required rows={3} /></label>}
            {actionError && !showBlockForm && <p className="task-action-error" role="alert">{actionError}</p>}
            {isReplacement && <p className="detail-readonly-note"><ShieldCheck size={16} /><span>รูปและลายเซ็นเป็นข้อมูลเสริม การปิด Completed ใช้ข้อมูล Serial และผลตรวจที่กรอก</span></p>}
            <button type="submit" className="primary-button task-action-submit" disabled={busy || evidenceBusy}>{busy ? 'กำลังบันทึก…' : evidenceBusy ? 'กำลังบันทึกหลักฐาน…' : isReplacement ? 'บันทึกผลและปิดงาน' : 'บันทึกผลเป็น Pending'}</button>
          </form><button type="button" className="secondary-button task-block-toggle" disabled={busy} onClick={() => { setShowBlockForm(value => !value); setActionError('') }}>{showBlockForm ? 'ซ่อนฟอร์ม Pending' : 'พักรายการนี้เป็น Pending'}</button>{showBlockForm && <form className="task-action-form" onSubmit={submitBlock}><label>เหตุผลที่ทำงานต่อไม่ได้<textarea value={blockReason} onChange={event => setBlockReason(event.target.value)} maxLength={500} required rows={3} /></label>{actionError && <p className="task-action-error" role="alert">{actionError}</p>}<button type="submit" className="secondary-button" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึก Pending'}</button></form>}</section>}
          {isPendingReview && !canResolvePending && <div className="detail-readonly-note"><ShieldCheck size={16} /><span>Pending รายการนี้รอ Admin ที่มีสิทธิ์พิจารณา</span></div>}
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

  useEffect(() => {
    const client = supabase
    if (!client || !canImport) return
    let active = true
    setHistoryLoading(true)
    void (async () => {
      try {
        const { data, error: rpcError } = await client.rpc('ais_import_history', { p_limit: 50 })
        if (rpcError) throw rpcError
        if (active) {
          setHistory(Array.isArray(data) ? data as ImportHistoryEntry[] : [])
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
    const client = supabase
    if (!client || !canImport || rows.length === 0 || busy) return
    setBusy(true)
    setError('')
    try {
      const { data, error: rpcError } = await client.rpc('ais_incremental_import_stage', {
        p_rows: rows,
      })
      if (rpcError) throw rpcError
      setPreview(data as ImportPreview)
      setHistoryReloadKey(key => key + 1)
    } catch {
      setError('ตรวจสอบกับฐานข้อมูลไม่สำเร็จ โปรดตรวจสิทธิ์และสถานะ migration แล้วลองอีกครั้ง')
    } finally {
      setBusy(false)
    }
  }

  async function commitImport() {
    const client = supabase
    if (!client || !preview || preview.issue_count !== 0 || !canImport || busy) return
    setBusy(true)
    setError('')
    try {
      const { data, error: rpcError } = await client.rpc('ais_incremental_import_commit', { p_batch_id: preview.batch_id })
      if (rpcError) throw rpcError
      if (!data || data.status !== 'committed' || !Number.isSafeInteger(data.inserted) || !Number.isSafeInteger(data.updated)) {
        setCommitUncertain(true)
        setError('ยังอ่านผลนำเข้าไม่ได้ กดตรวจสอบผลอีกครั้งได้ ระบบจะคืนผลชุดเดิมโดยไม่สร้างข้อมูลซ้ำ')
        return
      }
      setResult(data as ImportResult)
      setPreview(null)
      setRows([])
      setCommitUncertain(false)
      setHistoryReloadKey(key => key + 1)
      try {
        await onComplete()
      } catch {
        setError('นำเข้าข้อมูลสำเร็จแล้ว แต่รีเฟรชรายการไม่ได้ โปรดลองโหลดหน้าใหม่')
      }
    } catch (cause) {
      const failure = cause as { code?: unknown; message?: unknown }
      const code = typeof failure?.code === 'string' ? failure.code : ''
      const message = String(failure?.message || '').toLowerCase()
      if (!code || message.includes('fetch') || message.includes('network') || message.includes('timeout')) {
        setCommitUncertain(true)
        setError('ยังไม่ได้รับคำตอบจากระบบ กดตรวจสอบผลอีกครั้งได้ การลองซ้ำด้วยชุดเดิมจะไม่สร้างข้อมูลซ้ำ')
      } else {
        setError('ฐานข้อมูลปฏิเสธการนำเข้า ชุดข้อมูลไม่ถูกบันทึก โปรดตรวจรายละเอียดแล้วลองใหม่')
      }
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
    <section className="panel import-panel"><div className="import-panel-heading"><div className="upload-icon"><FileSpreadsheet size={23} /></div><div><h2>นำเข้าไฟล์ทะเบียนสาขาและเครื่องสแกน</h2><p>นำเข้าเพิ่มหรือปรับปรุงข้อมูลจากชีต Detail1 โดยจับคู่ Serial เดิม · ไม่เปลี่ยนประวัติงาน</p></div></div>
      <div className="upload-drop"><div className="upload-cloud"><FileSpreadsheet size={24} /></div><strong>{fileName || 'เลือกไฟล์ Excel (.xlsx)'}</strong><span>{rows.length ? `อ่านได้ ${rows.length.toLocaleString('th-TH')} แถวจากชีต Detail1` : 'ไฟล์จะถูกอ่านในเบราว์เซอร์ และส่งเฉพาะข้อมูลทะเบียนที่จำเป็นไปตรวจสอบ'}</span>
        <input ref={inputRef} className="visually-hidden" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="เลือกไฟล์ Excel" onChange={event => void chooseFile(event.target.files?.[0])} />
        <button className="secondary-button" disabled={!canImport || busy || commitUncertain} onClick={() => inputRef.current?.click()}><FileSpreadsheet size={16} /> {canImport ? 'เลือกไฟล์' : 'เฉพาะ Admin'}</button>
        {fileName && !preview && !result && <button className="primary-button" disabled={!canImport || busy || rows.length === 0} onClick={() => void stageImport()}>{busy ? 'กำลังตรวจสอบ…' : 'ตรวจสอบข้อมูลก่อนนำเข้า'}</button>}
      </div>
      {!canImport && <div className="warning-box"><LockKeyhole size={17} /><span>เมนูนำเข้าต้องใช้สิทธิ์ Admin</span></div>}
      {error && <div className="import-error" role="alert">{error}</div>}
      {preview && <section className="import-preview" aria-live="polite"><div className="import-preview-heading"><div><h3>ผลตรวจสอบชุดข้อมูล</h3><p>{preview.row_count.toLocaleString('th-TH')} เครื่อง · {preview.branch_count.toLocaleString('th-TH')} สาขา · {preview.issue_count.toLocaleString('th-TH')} ปัญหา</p></div><button className="secondary-button" disabled={busy} onClick={resetImport}>เลือกไฟล์ใหม่</button></div>
        {preview.issue_count === 0 ? <div className="rule"><CheckCircle2 size={16} /><span>ไม่พบข้อผิดพลาด ระบบพร้อมบันทึกเป็นชุดเดียว</span></div> : <div className="import-issues"><strong>ต้องแก้ปัญหาในไฟล์ก่อนนำเข้า</strong>{preview.issues.map((issue, index) => <div className="import-issue" key={`${issue.row_number}-${issue.field}-${index}`}><span>แถว {issue.row_number}</span><strong>{issue.field}</strong><span>{issue.message}</span></div>)}{preview.issues_truncated && <small>แสดง 100 ปัญหาแรกจากทั้งหมด {preview.issue_count}</small>}</div>}
        <div className="import-actions"><button className="secondary-button" disabled={busy || commitUncertain} onClick={resetImport}>ยกเลิกชุดนี้</button><button className="primary-button" disabled={busy || preview.issue_count > 0} onClick={() => void commitImport()}>{busy ? 'กำลังบันทึก…' : commitUncertain ? 'ตรวจสอบผลนำเข้า' : `บันทึก ${preview.row_count.toLocaleString('th-TH')} รายการ`}</button></div>
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
    <aside className="panel import-side"><div className="panel-heading"><div><h2>ขั้นตอนนำเข้า</h2><p>บันทึกเป็นชุดเพื่อทวนสอบย้อนหลัง</p></div></div><div className="step-list"><div className="import-step active"><span>1</span><div><strong>เลือกไฟล์</strong><small>อ่านเฉพาะชีต Detail1</small></div></div><div className="step-line" /><div className="import-step"><span>2</span><div><strong>ตรวจสอบข้อมูล</strong><small>ตรวจบนฐานข้อมูลก่อนบันทึก</small></div></div><div className="step-line" /><div className="import-step"><span>3</span><div><strong>บันทึกทั้งชุด</strong><small>ฐานข้อมูลยกเลิกทั้งหมดเมื่อผิดพลาด</small></div></div></div><div className="warning-box"><ShieldCheck size={17} /><span>ระบบบันทึกเฉพาะทะเบียนสาขาและเครื่องสแกน ไม่มีอีเมลหรือหมายเหตุแนบไป</span></div></aside>
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
