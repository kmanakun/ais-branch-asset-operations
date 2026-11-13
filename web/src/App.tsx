import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  Camera,
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
  ScanBarcode,
  Search,
  ShieldCheck,
  Users,
  Wifi,
  WifiOff,
  Wrench,
  X,
} from 'lucide-react'
import { demoAssets, demoTasks, type MenuKey } from './data'
import type { RegisterImportRow } from './xlsx-register.mjs'
import TaskEvidencePanel, { requiredEvidenceSlotsForOutcome, type EvidenceSlot, SignaturePad, type SignaturePadHandle } from './TaskEvidencePanel'
import { groupRowsByBranch } from './province'
import { ScannerDiscoveryDialog, ScannerDiscoveryQueue, type BranchReference } from './ScannerDiscovery'
import { getTopmostActiveDialog, isTopmostActiveDialog, lockBodyScroll, registerActiveDialog } from './dialog'
import { ApiError, type AuthConfigResponse, d1Api, getDevEmail, setDevAuthHeadersEnabled, setDevEmail } from './d1-client'
import { BarcodeScannerModal } from './BarcodeScannerModal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type UserContext = {
  email?: string
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
    customer_reviewer: 'ผู้ตรวจรับมอบงาน (G-Able)',
    viewer: 'ผู้ดูข้อมูล (Viewer)',
  }
  return role ? labels[role] || role : 'ผู้ดูข้อมูล (Viewer)'
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
  open: { label: 'รอเปิดใบงาน', tone: 'neutral' },
  scheduled: { label: 'กำลังดำเนินการ', tone: 'progress' },
  awaiting_confirmation: { label: 'กำลังดำเนินการ', tone: 'progress' },
  confirmed: { label: 'กำลังดำเนินการ', tone: 'progress' },
  in_progress: { label: 'กำลังดำเนินการ', tone: 'progress' },
  awaiting_admin_acceptance: { label: 'รอ SYM Admin ตรวจรับ', tone: 'blocked' },
  awaiting_customer_acceptance: { label: 'รอ Gable ตรวจรับมอบ', tone: 'ready' },
  awaiting_admin_exception_review: { label: 'Pending · รอ Admin ตรวจ', tone: 'blocked' },
  pending_exception: { label: 'Pending · รอ Admin พิจารณา', tone: 'blocked' },
  replaced: { label: 'เปลี่ยนเครื่องสำเร็จ', tone: 'done' },
  no_damage_found: { label: 'ไม่พบเครื่องชำรุด', tone: 'neutral' },
  aborted: { label: 'ไม่พบเครื่องชำรุด', tone: 'neutral' },
  different_device_found: { label: 'ไม่พบ SN ตามใบงาน · พบเครื่องอื่น', tone: 'blocked' },
  target_device_not_found: { label: 'ไม่พบ SN ตามใบงาน · ไม่พบเครื่องอื่น', tone: 'blocked' },
  scanner_missing: { label: 'ไม่พบ SN ตามใบงาน · ไม่พบเครื่องอื่น', tone: 'blocked' },
  blocked: { label: 'Pending', tone: 'blocked' },
  completed: { label: 'ส่งมอบเสร็จสมบูรณ์', tone: 'done' },
  delivered: { label: 'ส่งมอบเสร็จสมบูรณ์', tone: 'done' },
  exception_resolved: { label: 'ตรวจแล้ว · ยังต้องเปลี่ยน', tone: 'ready' },
  legacy_completed: { label: 'เสร็จแล้ว (ประวัติเดิม)', tone: 'neutral' },
  cancelled: { label: 'ยกเลิก', tone: 'neutral' },
}

function getStatusPresentation(value: unknown) {
  const status = String(value || '').trim()
  return statusPresentation[status.toLowerCase()] || { label: status || 'ไม่ระบุสถานะ', tone: 'neutral' }
}

function getTaskWorkflowStage(row: Record<string, unknown>) {
  const value = String(row.workflow_stage || row.task_status || row.status || 'open').trim().toLowerCase()
  const isDemoRow = String(row.id || '').startsWith('demo-')
  if (value === 'open' && !isDemoRow) return 'open'
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
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T00:00:00+07:00`
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)
      ? `${raw.replace(' ', 'T')}Z`
      : raw
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return ''
  const hasTime = /[T ]\d{2}:\d{2}/.test(raw)
  const options: Intl.DateTimeFormatOptions = hasTime
    ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }
    : { dateStyle: 'medium', timeZone: 'Asia/Bangkok' }
  return new Intl.DateTimeFormat('th-TH', options).format(date)
}

function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: string }) {
  const variantMap: Record<string, 'done' | 'ready' | 'progress' | 'blocked' | 'green' | 'orange' | 'red' | 'neutral'> = {
    done: 'done',
    green: 'green',
    ready: 'ready',
    progress: 'progress',
    blocked: 'blocked',
    orange: 'orange',
    red: 'red',
    neutral: 'neutral',
  }
  const toneVariant = variantMap[tone] || 'neutral'
  return (
    <Badge variant={toneVariant} className={cn('status-pill', tone)}>
      <span className="status-dot" />
      {label}
    </Badge>
  )
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
  const [authConfig, setAuthConfig] = useState<AuthConfigResponse>({
    auth_provider: 'google_oauth',
    mode: 'dev_fallback',
    google_enabled: false,
    dev_auth_enabled: false,
  })
  const [accessDeniedMessage, setAccessDeniedMessage] = useState<string | null>(null)
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
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const [showOnlineRestored, setShowOnlineRestored] = useState(false)

  useEffect(() => {
    let restoredTimer: number | null = null
    const clearRestoredTimer = () => {
      if (restoredTimer !== null) {
        window.clearTimeout(restoredTimer)
        restoredTimer = null
      }
    }
    const handleOnline = () => {
      setIsOnline(true)
      setShowOnlineRestored(true)
      clearRestoredTimer()
      restoredTimer = window.setTimeout(() => {
        restoredTimer = null
        setShowOnlineRestored(false)
      }, 4000)
    }
    const handleOffline = () => {
      clearRestoredTimer()
      setIsOnline(false)
      setShowOnlineRestored(false)
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      clearRestoredTimer()
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [provinceOptions, setProvinceOptions] = useState<string[]>([])
  const [activeProvince, setActiveProvince] = useState('')
  const [listError, setListError] = useState('')
  const [listReloadKey, setListReloadKey] = useState(0)
  const [loadedAssetSearch, setLoadedAssetSearch] = useState('')
  const [isSigningIn, setIsSigningIn] = useState(false)
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
    const authError = callbackUrl.searchParams.get('auth_error')
    const oauthError = callbackUrl.searchParams.get('error') || hashParams.get('error')
    const errorCode = callbackUrl.searchParams.get('error_code') || hashParams.get('error_code')
    const errorDescription = callbackUrl.searchParams.get('error_description') || hashParams.get('error_description')
    if (!authError && !oauthError && !errorCode && !errorDescription) return

    const authErrorMessages: Record<string, string> = {
      not_allowlisted: 'เข้าสู่ระบบ Google สำเร็จ แต่บัญชีอีเมลนี้ยังไม่ได้รับอนุญาตในรายชื่อผู้มีสิทธิ์ใช้งาน (Allowlist) กรุณาติดต่อ Identity Admin หรือลองบัญชี Google อื่น',
      unverified_email: 'บัญชี Google นี้ยังไม่ได้ยืนยันอีเมล จึงไม่สามารถเข้าใช้งานระบบได้',
      access_denied: 'ยกเลิกการเข้าสู่ระบบด้วย Google',
      invalid_state: 'ลิงก์ยืนยันตัวตนหมดอายุหรือไม่ถูกต้อง กรุณากดเข้าสู่ระบบด้วย Google ใหม่อีกครั้ง',
      oauth_misconfigured: 'การตั้งค่า Google OAuth บนเซิร์ฟเวอร์ยังไม่ครบถ้วน กรุณาติดต่อผู้ดูแลระบบ',
      oauth_not_configured: 'ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET บน Cloudflare Pages',
      oauth_failed: 'Google Sign-In ไม่สำเร็จ โปรดลองอีกครั้งหรือติดต่อ Identity Admin',
    }

    setLoginError(
      (authError && authErrorMessages[authError]) ||
        'Google Sign-In ไม่สำเร็จ บัญชีอาจยังไม่ได้รับอนุญาต หรือการตั้งค่า OAuth ยังไม่ครบ โปรดติดต่อ Identity Admin',
    )
    callbackUrl.searchParams.delete('auth_error')
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
        const cfg = await d1Api.getAuthConfig()
        if (!alive) return
        setAuthConfig(cfg)
        setDevAuthHeadersEnabled(cfg.dev_auth_enabled)

        if (cfg.mode === 'misconfigured') {
          setLoginError('การตั้งค่า Google OAuth บนเซิร์ฟเวอร์ยังไม่ครบ (ต้องระบุ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET และ SESSION_SECRET)')
          return
        }

        const me = await d1Api.getMe()
        if (alive && me?.email) {
          setAccessDeniedMessage(null)
          const d1Session = { user: { id: me.email, email: me.email } }
          sessionRef.current = d1Session
          setSession(d1Session)
          await loadContext(me.email)
        }
      } catch (error) {
        if (!alive) return
        if (error instanceof ApiError && error.status === 401) {
          // Normal unauthenticated state in Google OAuth mode: show LoginPage cleanly without overwriting callback alerts
          return
        }
        if (error instanceof ApiError && error.status === 403) {
          setAccessDeniedMessage(error.message)
          return
        }
        setLoginError('ตรวจสอบสถานะการเข้าสู่ระบบไม่ได้ โปรดลองอีกครั้ง')
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
        email: me.email,
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
          weekly_activity: d1Dash.weekly_activity || [],
          province_summary: {
            totals: {
              branches_total: d1Dash.summary.total_branches,
              branches_complete: d1Dash.summary.branches_complete,
              branches_remaining: d1Dash.summary.branches_remaining,
              scanners_total: d1Dash.summary.total_scanners,
              scanners_on_process: d1Dash.summary.on_process,
              scanners_complete: d1Dash.summary.delivered,
              open: d1Dash.summary.open,
              on_process: d1Dash.summary.on_process,
              awaiting_review: d1Dash.summary.awaiting_review ?? d1Dash.summary.awaiting_customer ?? 0,
              delivered: d1Dash.summary.delivered,
            },
            provinces: d1Dash.provinces.map(p => ({
              province: p.province,
              branches_total: p.branch_count,
              branches_complete: p.branches_complete,
              branches_remaining: p.branches_remaining,
              scanners_total: p.scanner_count,
              scanners_open: p.open_count,
              scanners_on_process: p.on_process_count,
              scanners_complete: p.delivered_count,
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
          setAssetProvinceTotal(typeof result.province_count === 'number' ? result.province_count : new Set(result.rows.map(r => r.province)).size)
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
    if (activeMenu === 'pending') {
      if (!demoMode && (userContext?.role === 'admin' || userContext?.role === 'customer_reviewer')) return
      setActiveMenu('overview')
      setMobileMenuOpen(false)
      return
    }
    if (activeMenu === 'discovery') {
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
    if (isSigningIn) return
    setLoginError('')
    if (authConfig.google_enabled) {
      setIsSigningIn(true)
      window.location.assign('/api/auth/google/start')
      return
    }
    if (authConfig.mode === 'misconfigured') {
      setLoginError('การตั้งค่า Google OAuth บนเซิร์ฟเวอร์ยังไม่ครบถ้วน กรุณาติดต่อผู้ดูแลระบบ')
      return
    }
    setLoginError('ระบบกำลังทำงานในโหมดทดสอบ (รอเปิดใช้งาน Google OAuth) กรุณาเลือกสิทธิ์ผู้ใช้งานจากแถบด้านบน (Dev Auth Bar)')
  }

  async function signOut() {
    setSignOutError('')
    if (authConfig.google_enabled) {
      await d1Api.logout().catch(() => null)
    }
    authRequestId.current += 1
    sessionRef.current = null
    setSession(null)
    setAccessDeniedMessage(null)
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
    if (demoMode) {
      setNotice('โหมดสาธิตไม่รองรับการส่งออก Raw Data')
      return
    }
    const csvSafeCell = (rawValue: unknown) => {
      const str = rawValue === null || rawValue === undefined ? '' : String(rawValue)
      const neutralized = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str
      return `"${neutralized.replace(/"/g, '""')}"`
    }
    try {
      setNotice('กำลังจัดเตรียมไฟล์ Raw Data...')
      const res = await d1Api.getExportRawData()
      if (!res.data || res.data.length === 0) {
        setNotice('ไม่มีข้อมูลสำหรับส่งออก')
        return
      }
      const headers = Object.keys(res.data[0])
      const csvRows = [headers.map(csvSafeCell).join(',')]
      for (const row of res.data) {
        const values = headers.map(header => csvSafeCell(row[header]))
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
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice('ส่งออก Raw Data เรียบร้อยแล้ว')
    } catch (err: any) {
      setNotice('ส่งออกข้อมูลไม่สำเร็จ: ' + (err?.message || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'))
    }
  }

  if (!authChecked) return <div className="loading-screen"><div className="spinner" /><span>กำลังตรวจสอบสถานะการเข้าสู่ระบบ</span></div>
  if (accessDeniedMessage && !session && !demoMode) {
    return (
      <>
        {authConfig.dev_auth_enabled && <DevAuthBar currentEmail={devEmail} onSwitch={handleDevSwitch} />}
        <NoAccess email={authConfig.dev_auth_enabled ? devEmail : ''} error={signOutError || accessDeniedMessage} onSignOut={() => void signOut()} />
      </>
    )
  }
  if (!session && !reauthRequired && !demoMode) {
    return (
      <>
        {authConfig.dev_auth_enabled && <DevAuthBar currentEmail={devEmail} onSwitch={handleDevSwitch} />}
        <LoginPage onGoogleSignIn={() => void signInWithGoogle()} onDemo={() => setDemoMode(true)} onHelp={() => setLoginError('ใช้บัญชี Google ที่อยู่ในรายชื่อผู้มีสิทธิ์ หากยังเข้าไม่ได้โปรดติดต่อ Identity Admin')} error={loginError} configured={authConfig.mode !== 'misconfigured'} submitting={isSigningIn} />
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
  const canExportRawData = !demoMode && (role === 'admin' || role === 'data_manager' || role === 'customer_reviewer')
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
    {authConfig.dev_auth_enabled && <DevAuthBar currentEmail={devEmail} onSwitch={handleDevSwitch} />}
    {!isOnline && (
      <div className="sticky top-0 z-[9999] flex items-center justify-center gap-2 bg-red-700 px-4 py-2 text-[13px] font-semibold text-white">
        <WifiOff size={16} /> คุณกำลังออฟไลน์ (Offline) สัญญาณอินเทอร์เน็ตขาดหาย โปรดตรวจสอบสัญญาณก่อนทำรายการ
      </div>
    )}
    {showOnlineRestored && isOnline && (
      <div className="sticky top-0 z-[9999] flex items-center justify-center gap-2 bg-emerald-700 px-4 py-2 text-[13px] font-semibold text-white">
        <Wifi size={16} /> เชื่อมต่อสัญญาณอินเทอร์เน็ตเรียบร้อยแล้ว
      </div>
    )}
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
      </aside>
      {mobileMenuOpen && <button className="mobile-nav-backdrop" aria-label="ปิดเมนูหลัก" onClick={() => setMobileMenuOpen(false)} />}

      <main className="main-area">
        <header className="topbar">
          <button ref={mobileMenuTriggerRef} className="icon-button mobile-nav-toggle" aria-label="เปิดเมนูหลัก" aria-expanded={mobileMenuOpen} aria-controls="primary-navigation" onClick={() => setMobileMenuOpen(open => !open)}>
            <Menu size={18} />
          </button>
          <div className="breadcrumb">
            <span className="hidden sm:inline">ระบบปฏิบัติการ</span>
            <ChevronRight size={14} className="hidden sm:inline shrink-0" />
            <strong className="truncate">{currentPage.title}</strong>
          </div>
          <div className="top-actions">
            {demoMode && <span className="demo-indicator"><span /> DEMO · ข้อมูลตัวอย่าง</span>}
            <button className="icon-button notification-button" aria-label="การแจ้งเตือน" onClick={() => setNotice('ยังไม่มีการแจ้งเตือนใหม่')}><Bell size={18} /><i /></button>
            <div className="top-divider hidden sm:block" />
            <div ref={accountMenuRef} className="account-menu-wrap">
              <button type="button" className="top-user" aria-haspopup="menu" aria-expanded={accountMenuOpen} aria-label={`เมนูบัญชี ${accountName}`} onClick={() => { setAccountMenuOpen(open => !open); setWorkspaceMenuOpen(false) }}>
                <div className="avatar avatar-small">{(userContext?.display_name || 'ท').slice(0, 1)}</div>
                <span className="hidden max-w-[140px] truncate sm:inline">{accountName}</span>
                <ChevronDown size={14} className="shrink-0" />
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
            <div className="flex flex-wrap gap-2">
              {canExportRawData && <Button type="button" variant="outline" onClick={handleExportRawData}><FileDown size={16} /> ส่งออก Raw Data (.csv)</Button>}
              {activeMenu === 'assets' && canUseAdminModules && <Button type="button" variant="outline" onClick={() => setActiveMenu('imports')}><FileSpreadsheet size={16} /> นำเข้าทะเบียน</Button>}
            </div>
          </div>

          {activeMenu === 'overview' && <Overview demo={demoMode} dashboard={dashboard} error={dashboardError} onNavigate={navigateTo} role={role} />}
          {activeMenu === 'work_orders' && <WorkOrders role={role} currentEmail={userContext?.email} demo={demoMode} onUpdated={action => { resetAssetPages(); setListReloadKey(key => key + 1); if (action === 'evidence_started') setNotice(''); else setNotice(action === 'closeout_pending' ? 'ส่งผลหน้างานแล้ว รอ Admin ตรวจหลักฐานและลงนาม' : action === 'accept' ? 'ตรวจรับและส่งมอบงานเรียบร้อย' : 'สถานะใบงานอัปเดตแล้ว'); void loadContext() }} onOpenHandover={setHandoverBranch} />}
          {activeMenu === 'completed' && <WorkOrders role={role} currentEmail={userContext?.email} demo={demoMode} view="completed" onUpdated={action => { resetAssetPages(); setListReloadKey(key => key + 1); if (action === 'evidence_started') setNotice(''); else setNotice(action === 'closeout_pending' ? 'ส่งผลหน้างานแล้ว รอ Admin ตรวจหลักฐานและลงนาม' : action === 'accept' ? 'ตรวจรับและส่งมอบงานเรียบร้อย' : 'สถานะใบงานอัปเดตแล้ว'); void loadContext() }} onOpenHandover={setHandoverBranch} />}
          {activeMenu === 'assets' && <Assets role={role} currentEmail={userContext?.email} demo={demoMode} items={demoMode ? demoAssets : listData} loading={pageLoading} error={listError} onRetry={() => setListReloadKey(key => key + 1)} onTaskUpdated={action => { resetAssetPages(); setListReloadKey(key => key + 1); if (action === 'evidence_started') setNotice(''); else setNotice(action === 'refresh' ? 'กำลังโหลดสถานะ Scanner ล่าสุด' : action === 'closeout_pending' ? 'ส่งผลหน้างานแล้ว รอ Admin ตรวจหลักฐานและลงนาม' : action === 'resolve_exception' ? 'Admin ตรวจ Pending และบันทึกผลพิจารณาแล้ว' : action === 'accept' ? 'Admin ลงนามรับผ่านและส่งมอบงานแล้ว' : action === 'block' ? 'บันทึกรายการ Pending แล้ว' : action === 'resume' ? 'รายการกลับมาดำเนินการแล้ว' : 'เริ่มปฏิบัติงานแล้ว'); void loadContext() }} search={search} searchResultsReady={demoMode || loadedAssetSearch === search} setSearch={value => { clearAssetQueryResults(); resetAssetPages(); setSearch(value) }} provinceOptions={visibleProvinces} provinceFilter={activeProvince} setProvinceFilter={value => { clearAssetQueryResults(); resetAssetPages(); setActiveProvince(value) }} statusFilter={assetStatusFilter} setStatusFilter={value => { clearAssetQueryResults(); resetAssetPages(); setAssetStatusFilter(value) }} page={assetPage} pageOffset={assetPageOffsets.current[assetPage] || 0} total={assetTotal} provinceTotal={assetProvinceTotal} setPage={value => { setListData([]); setListError(''); setAssetPage(value) }} focusSerial={pendingAssetSerial} onFocusResolved={() => setPendingAssetSerial('')} onOpenHandover={setHandoverBranch} />}
          {activeMenu === 'pending' && !demoMode && (role === 'admin' || role === 'customer_reviewer') && <PendingReviews role={role} currentEmail={userContext?.email} onUpdated={action => { setListReloadKey(key => key + 1); setNotice(action === 'accept' ? 'ตรวจรับและส่งมอบงานเรียบร้อย' : action === 'reject' ? 'ปฏิเสธงานและส่งกลับแก้ไขแล้ว' : action === 'resolve_exception' ? 'บันทึกผลตรวจ Pending แล้ว' : 'สถานะใบงานอัปเดตแล้ว'); void loadContext() }} onOpenHandover={setHandoverBranch} />}
          {activeMenu === 'discovery' && !demoMode && role === 'admin' && <ScannerDiscoveryQueue onUpdated={action => { resetAssetPages(); setListReloadKey(key => key + 1); setNotice(action === 'refresh' ? 'รายการเครื่องนอกทะเบียนอัปเดตแล้ว' : action); void loadContext() }} />}
          {!demoMode && handoverBranch && createPortal(<BranchHandoverSheetModal branch={handoverBranch} onClose={() => setHandoverBranch(null)} />, document.body)}
          {activeMenu === 'imports' && canUseAdminModules && <Imports role={role} onComplete={async () => {
            resetAssetPages()
            setListReloadKey(key => key + 1)
            await loadContext()
          }} />}
          {activeMenu === 'people' && canUseAdminModules && <People currentEmail={userContext?.email} role={role} />}
          <footer className="page-footer"><span>© 2026 AIS Branch & Asset Operations</span><span>V1 · ระบบนำร่อง</span></footer>
        </div>
      </main>
      <nav className={'mobile-bottom-nav' + (role === 'admin' && !demoMode ? ' is-admin' : '')} aria-label="เมนูหลักสำหรับโทรศัพท์">
        {visibleNavigation.filter(item => (role === 'customer_reviewer' ? ['overview', 'pending', 'completed'] : ['overview', 'assets', 'work_orders', 'pending']).includes(item.key)).map(item => {
          const Icon = item.icon
          const label =
            item.key === 'overview'
              ? 'หน้าหลัก'
              : item.key === 'assets'
                ? 'ทะเบียน'
                : item.key === 'work_orders'
                  ? 'ใบงาน'
                  : item.key === 'completed'
                    ? 'เสร็จแล้ว'
                    : 'รอตรวจ'
          return <button key={item.key} type="button" className={'mobile-tab' + (activeMenu === item.key ? ' active' : '')} aria-current={activeMenu === item.key ? 'page' : undefined} onClick={() => navigateTo(item.key)}>
            <Icon size={18} aria-hidden="true" /><span>{label}</span>
          </button>
        })}
        <button type="button" className={'mobile-tab mobile-more' + (mobileMenuOpen || !(role === 'customer_reviewer' ? ['overview', 'pending', 'completed'] : ['overview', 'assets', 'work_orders', 'pending']).includes(activeMenu) ? ' active' : '')} aria-label="เมนูเพิ่มเติม" aria-expanded={mobileMenuOpen} aria-controls="primary-navigation" onClick={() => setMobileMenuOpen(true)}>
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

function Overview({ demo, dashboard, error, onNavigate, role }: { demo: boolean; dashboard: DashboardData | null; error: string; onNavigate: (key: MenuKey, search?: string) => void; role?: string }) {
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
  const isCustomerReviewer = role === 'customer_reviewer'
  const provinceSummary = dashboard?.province_summary
  const totals = (demo ? { branches_total: 5, branches_complete: 2, branches_remaining: 3, scanners_total: 13, scanners_open: 4, scanners_on_process: 4, scanners_complete: 5, awaiting_review: 2 } : provinceSummary?.totals || {}) as Record<string, number>
  const provinces = (demo ? demoProvinces : provinceSummary?.provinces || []) as Array<Record<string, unknown>>
  const activity = (demo ? demoWeeklyActivity : dashboard?.weekly_activity || []) as DashboardData['weekly_activity']
  const number = (value: unknown) => Math.max(0, Number(value) || 0)
  const activityMax = Math.max(1, ...(activity || []).map(day => Math.max(number(day.opened), number(day.completed))))
  const stats = isCustomerReviewer ? [
    { label: 'รอตรวจรับมอบ', key: 'awaiting_review', tone: 'orange', icon: <ShieldCheck size={18} />, destination: 'pending' as MenuKey, action: 'เปิดตรวจรับ' },
    { label: 'ตรวจรับเรียบร้อย', key: 'scanners_complete', tone: 'green', icon: <CheckCircle2 size={18} />, destination: 'completed' as MenuKey, action: 'ดูงานที่เสร็จแล้ว' },
    { label: 'สาขาทั้งหมด', key: 'branches_total', tone: 'blue', icon: <MapPin size={18} />, destination: 'pending' as MenuKey, action: 'ดูงานรอตรวจรับ' },
    { label: 'Scanner ทั้งหมด', key: 'scanners_total', tone: 'violet', icon: <HardDrive size={18} />, destination: 'pending' as MenuKey, action: 'ดูงานรอตรวจรับ' },
    { label: 'On Process', key: 'scanners_on_process', tone: 'orange', icon: <Wrench size={18} />, destination: 'pending' as MenuKey, action: 'ดูงานรอตรวจรับ' },
    { label: 'สาขาตรวจรับครบ', key: 'branches_complete', tone: 'green', icon: <CheckCircle2 size={18} />, destination: 'completed' as MenuKey, action: 'ดูงานที่เสร็จแล้ว' },
  ] : [
    { label: 'สาขาทั้งหมด', key: 'branches_total', tone: 'blue', icon: <MapPin size={18} />, destination: 'assets' as MenuKey, action: 'ดูทะเบียน' },
    { label: 'Scanner ทั้งหมด', key: 'scanners_total', tone: 'violet', icon: <HardDrive size={18} />, destination: 'assets' as MenuKey, action: 'ดูทะเบียน' },
    { label: 'On Process', key: 'scanners_on_process', tone: 'orange', icon: <Wrench size={18} />, destination: 'work_orders' as MenuKey, action: 'ดูใบงาน' },
    { label: 'รอตรวจรับ', key: 'awaiting_review', tone: 'orange', icon: <ShieldCheck size={18} />, destination: (!demo && (role === 'admin' || role === 'customer_reviewer') ? 'pending' : 'work_orders') as MenuKey, action: !demo && (role === 'admin' || role === 'customer_reviewer') ? 'เปิดตรวจรับ' : 'ดูใบงาน' },
    { label: 'Complete', key: 'scanners_complete', tone: 'green', icon: <CheckCircle2 size={18} />, destination: 'completed' as MenuKey, action: 'ดูงานที่เสร็จแล้ว' },
    { label: 'สาขาเปลี่ยนครบ', key: 'branches_complete', tone: 'green', icon: <CheckCircle2 size={18} />, destination: 'assets' as MenuKey, action: 'ดูทะเบียน' },
  ]
  return <div className="overview-content">
    <div className="welcome-strip">
      <div className="welcome-mark">{isCustomerReviewer ? <ShieldCheck size={20} /> : <Activity size={20} />}</div>
      <div>
        <strong>{isCustomerReviewer ? 'งานรอตรวจรับมอบ Scanner (Gable Review)' : 'ติดตามความคืบหน้าการเปลี่ยน Scanner'}</strong>
        <span>{isCustomerReviewer ? 'ตรวจสอบหลักฐานภาพถ่าย ลายเซ็นช่าง และลงนามรับมอบงานแบบรวมทั้งสาขา' : 'เลือกจังหวัด สาขา และเครื่องจากทะเบียน เพื่อดูรายละเอียดหรือเริ่มงานกับเครื่องนั้นได้ทันที'}</span>
      </div>
      <button onClick={() => onNavigate(isCustomerReviewer ? 'pending' : 'assets')}>
        {isCustomerReviewer ? 'เปิดคิวตรวจรับงาน' : 'เปิดทะเบียนอุปกรณ์'} <ArrowRight size={15} />
      </button>
    </div>
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
    <section className="panel province-summary-panel"><div className="panel-heading"><div><h2>สรุปแยกตามจังหวัด</h2><p>{isCustomerReviewer ? 'กดจังหวัดเพื่อตรวจรับ Scanner ในพื้นที่นั้น' : 'กดจังหวัดเพื่อเปิดทะเบียนและดู Scanner ในพื้นที่นั้น'}</p></div><button className="text-button" onClick={() => onNavigate(isCustomerReviewer ? 'pending' : 'assets')}>{isCustomerReviewer ? 'ดูงานรอตรวจรับ' : 'ดูทะเบียนทั้งหมด'} <ArrowRight size={15} /></button></div>
      {error && !demo ? <EmptyState compact title="โหลดสรุปจังหวัดไม่สำเร็จ" detail={error} /> : provinces.length ? <div className="province-summary-list">{provinces.map((province, index) => {
        const name = String(province.province || 'ไม่ระบุจังหวัด')
        const scannerTotal = number(province.scanners_total)
        const open = number(province.scanners_open)
        const onProcess = number(province.scanners_on_process)
        const complete = number(province.scanners_complete)
        return <button type="button" className="province-summary-row" key={name || index} onClick={() => onNavigate(isCustomerReviewer ? 'pending' : 'assets', name)} aria-label={isCustomerReviewer ? `ดูงานรอตรวจรับจังหวัด${name}` : `ดูทะเบียนจังหวัด${name}`}>
          <span className="province-summary-main"><strong>{name}</strong><small>{number(province.branches_total).toLocaleString('th-TH')} สาขา · เปลี่ยนครบ {number(province.branches_complete).toLocaleString('th-TH')} · ยังไม่ครบ {number(province.branches_remaining).toLocaleString('th-TH')}</small></span>
          <span className="province-summary-metric"><small>Scanner</small><strong>{scannerTotal.toLocaleString('th-TH')}</strong></span>
          <span className="province-summary-breakdown"><span className="province-status-labels"><small>รอเปิดใบงาน {open}</small><small>On Process {onProcess}</small><small>Complete {complete}</small></span><span className="province-status-bar" aria-label={`รอเปิดใบงาน ${open}, On Process ${onProcess}, Complete ${complete}`}><i className="province-status-open" style={{ width: `${getPercent(open, scannerTotal)}%` }} /><i className="province-status-process" style={{ width: `${getPercent(onProcess, scannerTotal)}%` }} /><i className="province-status-complete" style={{ width: `${getPercent(complete, scannerTotal)}%` }} /></span></span>
          <ArrowRight className="province-summary-arrow" size={17} />
        </button>
      })}</div> : <EmptyState compact title="ยังไม่มีข้อมูลจังหวัด" detail="จังหวัดจะแสดงเมื่อมีสาขาอยู่ในทะเบียน" />}
    </section>
  </div>
}

function Assets({ role, currentEmail, demo, items, loading, error, onRetry, onTaskUpdated, search, searchResultsReady, setSearch, provinceOptions, provinceFilter, setProvinceFilter, statusFilter, setStatusFilter, page, pageOffset, total, provinceTotal, setPage, focusSerial, onFocusResolved, onOpenHandover }: { role?: string; currentEmail?: string; demo: boolean; items: unknown[]; loading: boolean; error: string; onRetry: () => void; onTaskUpdated: (action: string) => void; search: string; searchResultsReady: boolean; setSearch: (value: string) => void; provinceOptions: string[]; provinceFilter: string; setProvinceFilter: (value: string) => void; statusFilter: string; setStatusFilter: (value: string) => void; page: number; pageOffset: number; total: number; provinceTotal: number; setPage: (page: number) => void; focusSerial: string; onFocusResolved: () => void; onOpenHandover?: (branch: any) => void }) {
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
  const branchGroups = groupRowsByBranch(filteredRows)
  const [expandedBranches, setExpandedBranches] = useState<string[]>([])
  const autoExpandedSearch = useRef('')
  useEffect(() => {
    const query = search.trim()
    if (!query) {
      if (autoExpandedSearch.current) {
        autoExpandedSearch.current = ''
        setExpandedBranches([])
      }
      return
    }
    const key = `${query}\u0000${page}`
    if (loading || !searchResultsReady || autoExpandedSearch.current === key) return
    autoExpandedSearch.current = key
    setExpandedBranches(branchGroups.map(branch => branch.key))
  }, [loading, page, branchGroups, search, searchResultsReady])
  const toggleBranch = (key: string) => setExpandedBranches(current => current.includes(key) ? current.filter(value => value !== key) : [...current, key])
  const allBranchesExpanded = branchGroups.length > 0 && branchGroups.every(b => expandedBranches.includes(b.key))
  const toggleAllBranches = () => {
    if (allBranchesExpanded) {
      setExpandedBranches([])
    } else {
      setExpandedBranches(branchGroups.map(b => b.key))
    }
  }
  const assetStatus = (row: Record<string, unknown>) => {
    const rawStatus = String(row.task_status || row.status || '').trim().toLowerCase()
    if (!row.task_id || !rawStatus || rawStatus === 'open') {
      return { label: 'รอเปิดใบงาน', tone: 'neutral' }
    }
    return getStatusPresentation(rawStatus)
  }
  const [selectedAsset, setSelectedAsset] = useState<Record<string, unknown> | null>(null)
  const [reportBranch, setReportBranch] = useState<BranchReference | null>(null)
  const [focusMessage, setFocusMessage] = useState('')
  const [scanSearchOpen, setScanSearchOpen] = useState(false)

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
    <div className="asset-summary">
      <div><span>สาขาในผลลัพธ์</span><strong>{branchGroups.length.toLocaleString('th-TH')}</strong></div>
      <div><span>Scanner ในผลลัพธ์</span><strong>{demo ? filteredRows.length.toLocaleString('th-TH') : total.toLocaleString('th-TH')}</strong></div>
      <div><span>จังหวัดในผลลัพธ์</span><strong>{demo ? new Set(filteredRows.map(row => String(row.province || '').trim()).filter(Boolean)).size.toLocaleString('th-TH') : provinceTotal.toLocaleString('th-TH')}</strong></div>
      <div><span>หน้าปัจจุบัน</span><strong>{demo ? 'ตัวอย่าง' : (page + 1).toLocaleString('th-TH')}</strong></div>
    </div>
    <section className="panel list-panel">
      <div className="asset-register-toolbar">
        <label className="search-box">
          <Search size={17} />
          <input
            aria-label="ค้นหาสาขา LocationCode รุ่น หรือ Serial"
            value={search}
            onChange={event => { setFocusMessage(''); if (focusSerial) onFocusResolved(); setSearch(event.target.value) }}
            placeholder="ค้นหาสาขา LocationCode รุ่น หรือ Serial"
          />
          <button
            type="button"
            className="icon-button ml-auto p-1"
            title="สแกนบาร์โค้ดค้นหา"
            aria-label="สแกนบาร์โค้ดค้นหา"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setScanSearchOpen(true)
            }}
          >
            <ScanBarcode size={17} />
          </button>
        </label>
        <label className="asset-filter-field"><span>จังหวัด</span><select aria-label="กรองตามจังหวัด" value={provinceFilter} onChange={event => setProvinceFilter(event.target.value)}><option value="">ทุกจังหวัด</option>{provinceOptions.map(province => <option value={province} key={province}>{province}</option>)}</select></label>
        <label className="asset-filter-field"><span>สถานะงาน</span><select aria-label="กรองตามสถานะงาน" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">ทุกสถานะ</option><option value="open">รอเปิดใบงาน</option><option value="on_process">On Process · กำลังดำเนินการ</option><option value="complete">Complete · เสร็จสมบูรณ์</option></select></label>
        {(provinceFilter || statusFilter !== 'all' || search) && <Button type="button" variant="outline" className="asset-filter-reset h-10" onClick={() => { setProvinceFilter(''); setStatusFilter('all'); setSearch(''); setPage(0) }}>ล้างตัวกรอง</Button>}
        {branchGroups.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={toggleAllBranches} className="ml-auto whitespace-nowrap text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800">
            {allBranchesExpanded ? 'ยุบทุกสาขา' : 'ขยายทุกสาขา'}
          </Button>
        )}
      </div>
      {focusMessage && <div className="detail-readonly-note" role="status">{focusMessage}</div>}
      {loading && !filteredRows.length ? <EmptyState loading /> : error && !filteredRows.length ? <EmptyState title="โหลดข้อมูลไม่สำเร็จ" detail={error} onRetry={onRetry} /> : filteredRows.length ? <>
        {loading && <div className="list-refresh-notice" role="status">กำลังอัปเดตรายการ Scanner…</div>}
        {error && <div className="list-refresh-notice is-error" role="alert"><span>{error}</span><button type="button" className="secondary-button" onClick={onRetry}>ลองอีกครั้ง</button></div>}
        <div className="table-wrap asset-table-wrap">
          <table>
            <thead>
              <tr>
                <th>สาขา / LocationCode</th>
                <th>อุปกรณ์</th>
                <th>Serial</th>
                <th>สถานะ</th>
                <th>ปีข้อมูลเดิม</th>
                <th>รายละเอียด</th>
              </tr>
            </thead>
            <tbody>
              {branchGroups.flatMap(branch => [
                <tr className="branch-table-group" key={'branch-' + branch.key}>
                  <th scope="rowgroup" colSpan={6}>
                    <div className="branch-table-heading">
                      <button
                        type="button"
                        className="register-expand-button"
                        aria-expanded={expandedBranches.includes(branch.key)}
                        onClick={() => toggleBranch(branch.key)}
                      >
                        <ChevronDown size={15} />
                        <span className="branch-name-text">{branch.name}</span>
                        <span className="branch-province-tag">📍 {branch.province}</span>
                        <small>LocationCode {branch.locationCode || '—'} · {branch.rows.length} เครื่อง</small>
                      </button>
                      {branch.addressNote && <span className="address-note-badge" title={branch.addressNote}>⚠️ ที่อยู่ต้องตรวจ</span>}
                      {!demo && (
                        <div className="ml-auto flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => onOpenHandover?.(branch.rows[0])}
                            title="ดูและพิมพ์เอกสารตรวจรับส่งมอบงาน (PDF)"
                          >
                            <Printer size={13} /> ใบตรวจรับ (PDF)
                          </Button>
                          {['admin', 'field_technician'].includes(String(role)) && (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => setReportBranch({ id: branch.rows[0]?.branch_id, name: branch.name, code: branch.locationCode, province: branch.province })}
                            >
                              + พบ Scanner นอกทะเบียน
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </th>
                </tr>,
                ...(expandedBranches.includes(branch.key) ? branch.rows.map((row, i) => {
                  const rowKey = String(row.id || String(row.location_code || 'asset') + '-' + String(row.com_sn || 'serial') + '-' + i)
                  const status = assetStatus(row)
                  return (
                    <tr key={rowKey}>
                      <td>
                        <div className="table-primary">{String(row.branch || row.branch_name || row.loc_bld || 'สาขา')}</div>
                        <div className="table-secondary">{String(row.code || row.location_code || '')}</div>
                      </td>
                      <td>{String(row.model || row.model_name || row.hw_name || '—')}</td>
                      <td className="serial-cell">{String(row.serial || row.com_sn || '—')}</td>
                      <td><StatusPill label={status.label} tone={status.tone} /></td>
                      <td>{String(row.year || row.com_years || '—')}</td>
                      <td>
                        <button type="button" className="text-button asset-detail-action" onClick={() => setSelectedAsset(row)}>
                          ดูรายละเอียดและประวัติ
                        </button>
                      </td>
                    </tr>
                  )
                }) : [])
              ])}
            </tbody>
          </table>
        </div>
        <div className="asset-mobile-list">
          {branchGroups.map(branch => (
            <section className="branch-mobile-group" key={'mobile-branch-' + branch.key}>
              <div className="branch-mobile-heading">
                <div className="branch-mobile-title-block">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <strong className="text-sm font-bold text-slate-900">{branch.name}</strong>
                    <span className="branch-province-tag">📍 {branch.province}</span>
                    {branch.addressNote && <span className="address-note-badge" title={branch.addressNote}>⚠️ ที่อยู่ต้องตรวจ</span>}
                  </div>
                  <small className="block text-xs text-slate-500">LocationCode {branch.locationCode || '—'} · {branch.rows.length} เครื่อง</small>
                </div>
                {!demo && (
                  <div className="branch-mobile-actions">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => onOpenHandover?.(branch.rows[0])}
                      title="ดูและพิมพ์เอกสารตรวจรับส่งมอบงาน (PDF)"
                    >
                      <Printer size={12} /> ใบตรวจรับ (PDF)
                    </Button>
                    {['admin', 'field_technician'].includes(String(role)) && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="flex-1"
                        onClick={() => setReportBranch({ id: branch.rows[0]?.branch_id, name: branch.name, code: branch.locationCode, province: branch.province })}
                      >
                        + พบ Scanner นอกทะเบียน
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {branch.rows.map((row, i) => {
                const rowKey = String(row.id || String(row.location_code || 'asset') + '-' + String(row.com_sn || 'serial') + '-' + i)
                const status = assetStatus(row)
                const rowTaskStatus = String(row.task_status || row.status || '').trim().toLowerCase()
                const mobileCtaLabel = ['completed', 'delivered', 'legacy_completed', 'awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'awaiting_admin_exception_review', 'pending_exception'].includes(rowTaskStatus)
                  ? 'ดูรายละเอียดและประวัติ'
                  : ['in_progress', 'blocked', 'scheduled'].includes(rowTaskStatus)
                    ? 'รายละเอียด Scanner · เปิดงานที่ทำอยู่'
                    : 'รายละเอียด Scanner และเริ่มงาน'
                return (
                  <article className="mobile-record-card" key={rowKey}>
                    <div className="mobile-record-heading">
                      <div className="mobile-record-serial-group">
                        <strong className="font-mono text-[13.5px] font-bold text-slate-900 break-all">{String(row.serial || row.com_sn || 'Serial ไม่ระบุ')}</strong>
                        <span className="text-xs font-medium text-slate-500">{String(row.model || row.model_name || row.hw_name || 'เครื่องสแกน')}</span>
                      </div>
                      <StatusPill label={status.label} tone={status.tone} />
                    </div>
                    <div className="mobile-record-branch">
                      <span className="text-[13px] font-semibold text-slate-700">{String(row.branch || row.branch_name || row.loc_bld || 'สาขาไม่ระบุ')}</span>
                      <small className="text-xs text-slate-500">LocationCode: {String(row.code || row.location_code || '—')}</small>
                    </div>
                    <div className="mobile-record-meta">
                      <span>ปีข้อมูลเดิม: <strong>{String(row.year || row.com_years || '—')}</strong></span>
                    </div>
                    <Button type="button" variant="secondary" className="w-full font-bold" onClick={() => setSelectedAsset(row)}>
                      {mobileCtaLabel}
                    </Button>
                  </article>
                )
              })}
            </section>
          ))}
        </div>
      </> : <EmptyState title={provinceFilter || statusFilter !== 'all' || search ? 'ไม่พบ Scanner ที่ตรงกับตัวกรอง' : 'ยังไม่มีทะเบียนอุปกรณ์'} detail={provinceFilter || statusFilter !== 'all' || search ? 'ลองเปลี่ยนจังหวัด สถานะ หรือคำค้นหา แล้วตรวจอีกครั้ง' : 'ทะเบียนจะแสดงหลังนำเข้าไฟล์ที่ผ่านการตรวจสอบแล้ว'} />}
      <div className="list-footer"><span>{demo ? 'แสดง ' + filteredRows.length + ' จาก ' + rows.length + ' รายการตัวอย่าง' : error ? 'โหลดข้อมูลไม่สำเร็จ' : 'แสดง ' + (total ? pageOffset + 1 : 0) + '–' + Math.min(pageOffset + rows.length, total) + ' จาก ' + total.toLocaleString('th-TH') + ' เครื่อง · ไม่ตัดจังหวัดข้ามหน้า'}</span><div><button className="icon-button" aria-label="ก่อนหน้า" disabled={demo || loading || page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button><span className="page-number">{demo ? 1 : page + 1}</span><button className="icon-button" aria-label="ถัดไป" disabled={demo || loading || pageOffset + rows.length >= total} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></div></div>
    </section>
    {selectedAsset && <AssetDetailDialog asset={selectedAsset} role={role} currentEmail={currentEmail} demo={demo} onClose={() => setSelectedAsset(null)} onUpdated={onTaskUpdated} onOpenHandover={onOpenHandover} />}
    {reportBranch && <ScannerDiscoveryDialog branch={reportBranch} onClose={() => setReportBranch(null)} onReported={() => { setReportBranch(null); onTaskUpdated('refresh') }} />}
    <BarcodeScannerModal
      isOpen={scanSearchOpen}
      title="สแกนบาร์โค้ดค้นหาเครื่อง"
      subtitle="สแกน Serial Number หรือ LocationCode เพื่อค้นหาในทะเบียน"
      onScan={value => {
        setFocusMessage('')
        if (focusSerial) onFocusResolved()
        setSearch(value)
        setScanSearchOpen(false)
      }}
      onClose={() => setScanSearchOpen(false)}
    />
  </>
}

function BranchHandoverSheetModal({ branch, onClose }: { branch: any; onClose: () => void }) {
  const dialogRef = useDialogControls(onClose)
  const [detail, setDetail] = useState<{ branch: any; scanners: any[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailError, setDetailError] = useState('')
  const [sigErrors, setSigErrors] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let alive = true
    setSigErrors({})
    setDetailError('')
    const bId = branch.branch_id || branch.id
    if (!bId) {
      setLoading(false)
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const res = await d1Api.getBranchDetail(bId)
        if (alive) setDetail(res)
      } catch (err: any) {
        if (alive) setDetailError(err?.message || 'โหลดข้อมูลเอกสารสาขาไม่สำเร็จ')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [branch])

  const allScanners = detail?.scanners || []
  const scannersList = allScanners.length > 0 ? allScanners : [branch]
  const firstCompletedTask =
    allScanners.find(s => s.task_id && ['delivered', 'completed'].includes(s.task_status)) ||
    allScanners.find(s => s.task_id && ['awaiting_customer_acceptance', 'awaiting_admin_acceptance'].includes(s.task_status)) ||
    allScanners.find(s => s.task_id)

  const isFullyDelivered = allScanners.some(s => ['delivered', 'completed'].includes(s.task_status))
  const isAwaitingAcceptance = allScanners.some(s => ['awaiting_customer_acceptance', 'awaiting_admin_acceptance'].includes(s.task_status))
  const certStatusLabel = isFullyDelivered
    ? 'ส่งมอบเสร็จสมบูรณ์ (Delivered)'
    : isAwaitingAcceptance
      ? 'รอตรวจรับมอบงาน (Pending Acceptance)'
      : 'กำลังดำเนินการเปลี่ยนอุปกรณ์ (In Progress)'

  const cacheVersion = firstCompletedTask?.version || 3
  const workOrderCode = firstCompletedTask?.work_order_code || branch.work_order_code || '—'
  const branchData = detail?.branch || branch
  const provinceDistrict = [branchData.province, branchData.district].filter(Boolean).join(' · ') || '—'

  return (
    <div className="handover-modal-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="handover-modal-content" role="dialog" aria-modal="true" tabIndex={-1} onClick={e => e.stopPropagation()}>
        <div className="handover-modal-bar">
          <strong className="text-sm leading-snug sm:text-base">
            เอกสารตรวจรับส่งมอบงาน <span className="hidden sm:inline">(Handover Certificate)</span>
          </strong>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" size="sm" disabled={Boolean(detailError)} onClick={() => window.print()}>
              <Printer size={14} /> พิมพ์ PDF
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              <X size={14} /> ปิด
            </Button>
          </div>
        </div>
        {loading ? (
          <div className="p-10 text-center text-sm text-slate-500">กำลังโหลดเอกสาร…</div>
        ) : detailError ? (
          <div className="p-6"><EmptyState compact title="โหลดเอกสารส่งมอบงานไม่สำเร็จ" detail={detailError} /></div>
        ) : (
          <div className="handover-sheet">
            <div className="handover-header">
              <div>
                <div className="handover-doc-kicker">AIS • G-ABLE • SYM HANDOVER CERTIFICATE</div>
                <h2>ใบตรวจรับมอบงานโครงการเปลี่ยนเครื่องสแกนเนอร์บาร์โค้ด</h2>
                <p>AIS Branch Scanner Replacement Project</p>
                <p>คู่สัญญา: AIS — บมจ. จีเอเบิล (G-Able) — บริษัท สยามมัลติมีเดีย จำกัด (SYM)</p>
              </div>
              <div className="handover-header-meta">
                <div><strong>เลขที่ใบงาน:</strong> {workOrderCode}</div>
                <div><strong>วันที่ออกเอกสาร:</strong> {new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date())}</div>
                <div className={`handover-status-pill ${isFullyDelivered ? 'is-delivered' : 'is-pending'}`}>
                  {certStatusLabel}
                </div>
              </div>
            </div>

            <div className="handover-meta-grid">
              <div className="handover-meta-item">
                <span className="handover-meta-label">ชื่อสาขา (Branch Name)</span>
                <strong className="handover-meta-value">{branchData.loc_bld || branchData.branch_name || '—'}</strong>
              </div>
              <div className="handover-meta-item">
                <span className="handover-meta-label">รหัสสาขา (LocationCode)</span>
                <strong className="handover-meta-value font-mono">{branchData.location_code || branchData.code || '—'}</strong>
              </div>
              <div className="handover-meta-item">
                <span className="handover-meta-label">จังหวัด / เขต-อำเภอ</span>
                <strong className="handover-meta-value">{provinceDistrict}</strong>
              </div>
              <div className="handover-meta-item">
                <span className="handover-meta-label">เบอร์โทรติดต่อ (Contact Phone)</span>
                <strong className="handover-meta-value">{branchData.phone || '—'}</strong>
              </div>
              <div className="handover-meta-item">
                <span className="handover-meta-label">จำนวนอุปกรณ์ในใบส่งมอบ</span>
                <strong className="handover-meta-value">{scannersList.length} เครื่อง</strong>
              </div>
              <div className="handover-meta-item">
                <span className="handover-meta-label">ที่อยู่สาขา (Address)</span>
                <strong className="handover-meta-value">{branchData.address || '—'}</strong>
              </div>
            </div>

            <div className="mb-2.5 flex items-center justify-between gap-2">
              <h3 className="m-0 text-sm font-bold text-slate-900">รายการอุปกรณ์ที่ดำเนินการเปลี่ยน</h3>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-600">
                รวม {scannersList.length} รายการ
              </span>
            </div>
            <div className="table-wrap mb-4">
              <table className="handover-table mb-0">
                <thead>
                  <tr>
                    <th className="w-12 text-center">ลำดับ</th>
                    <th>Serial เดิม</th>
                    <th>Serial ใหม่</th>
                    <th>ยี่ห้อ / รุ่น</th>
                    <th>ผลการเปลี่ยน</th>
                    <th>วันที่ดำเนินการ</th>
                  </tr>
                </thead>
                <tbody>
                  {scannersList.map((sc, index) => (
                    <tr key={sc.scanner_id || sc.id || index}>
                      <td className="text-center">{index + 1}</td>
                      <td className="font-mono text-[12px]">{sc.com_sn || sc.serial || '—'}</td>
                      <td className="font-mono text-[12px]"><strong>{sc.new_serial_number || sc.new_serial || '—'}</strong></td>
                      <td>{[sc.brand, sc.model_name || sc.model].filter(Boolean).join(' ') || '—'}</td>
                      <td>
                        {sc.outcome === 'replaced'
                          ? 'เปลี่ยนเครื่องสำเร็จ'
                          : sc.outcome === 'no_damage_found' || sc.outcome === 'aborted'
                            ? 'เครื่องเดิมปกติ'
                            : sc.outcome === 'different_device_found'
                              ? 'เครื่องหน้างานต่างจากทะเบียน'
                              : sc.outcome === 'target_device_not_found' || sc.outcome === 'scanner_missing'
                                ? 'ไม่พบเครื่องเดิม'
                                : sc.outcome || 'รอตรวจสอบ'}
                      </td>
                      <td>{formatDate(sc.closeout_submitted_at) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="handover-cert-note">
              ข้าพเจ้าขอรับรองว่าได้ดำเนินการส่งมอบ ตรวจสอบ และตรวจรับอุปกรณ์สแกนเนอร์บาร์โค้ดตามรายการข้างต้นเรียบร้อยแล้ว ถูกต้องครบถ้วนตามมาตรฐานโครงการฯ
            </div>

            <div className="handover-signatures-grid">
              <div className="handover-sig-box">
                <div className="handover-sig-step">1. ผู้ส่งมอบงานหน้างาน</div>
                <div className="handover-sig-line">
                  {firstCompletedTask?.task_id && !sigErrors.technician_signature ? (
                    <img
                      src={`/api/evidence/tasks/${firstCompletedTask.task_id}/technician_signature.jpg?v=${cacheVersion}`}
                      alt="ลายเซ็นช่าง"
                      onError={() => setSigErrors(prev => ({ ...prev, technician_signature: true }))}
                    />
                  ) : (
                    <span className="handover-sig-empty">รอการลงนามจากผู้ปฏิบัติงาน</span>
                  )}
                </div>
                <div className={`handover-sig-status ${firstCompletedTask?.closeout_submitted_at ? 'is-signed' : 'is-pending'}`}>
                  {firstCompletedTask?.closeout_submitted_at ? '✓ ลงนามผ่านระบบ' : 'รอการส่งมอบ'}
                </div>
                <strong className="handover-sig-role">ผู้ปฏิบัติงานหน้างาน (Onsite Technician)</strong>
                <div className="handover-sig-org">บริษัท สยามมัลติมีเดีย จำกัด (SYM)</div>
                {firstCompletedTask?.closeout_submitted_by && (
                  <div className="handover-sig-meta">ผู้ลงนาม: {firstCompletedTask.closeout_submitted_by}</div>
                )}
                {firstCompletedTask?.closeout_submitted_at && (
                  <div className="handover-sig-meta">
                    วันที่: {formatDate(firstCompletedTask.closeout_submitted_at) || '—'}
                  </div>
                )}
              </div>

              <div className="handover-sig-box">
                <div className="handover-sig-step">2. ผู้รับมอบประจำสาขา</div>
                <div className="handover-sig-line">
                  {firstCompletedTask?.task_id && !sigErrors.scanner_user_signature ? (
                    <img
                      src={`/api/evidence/tasks/${firstCompletedTask.task_id}/scanner_user_signature.jpg?v=${cacheVersion}`}
                      alt="ลายเซ็นผู้รับมอบประจำสาขา"
                      onError={() => setSigErrors(prev => ({ ...prev, scanner_user_signature: true }))}
                    />
                  ) : (
                    <span className="handover-sig-empty">รอการลงนามจากพนักงานสาขา</span>
                  )}
                </div>
                <div className={`handover-sig-status ${firstCompletedTask?.closeout_submitted_at ? 'is-signed' : 'is-pending'}`}>
                  {firstCompletedTask?.closeout_submitted_at ? '✓ ลงนามรับทราบประจำสาขา' : 'รอการลงนาม'}
                </div>
                <strong className="handover-sig-role">ผู้รับมอบประจำสาขา AIS</strong>
                <div className="handover-sig-org">ผู้รับมอบเครื่องประจำสาขา</div>
                {firstCompletedTask?.closeout_submitted_at && (
                  <div className="handover-sig-meta">
                    วันที่: {formatDate(firstCompletedTask.closeout_submitted_at) || '—'}
                  </div>
                )}
              </div>

              <div className="handover-sig-box">
                <div className="handover-sig-step">3. ผู้ตรวจรับมอบโครงการ</div>
                <div className="handover-sig-line">
                  {firstCompletedTask?.task_id && firstCompletedTask?.customer_accepted_at && !sigErrors.inspector_signature ? (
                    <img
                      src={`/api/evidence/tasks/${firstCompletedTask.task_id}/inspector_signature.jpg?v=${cacheVersion}`}
                      alt="ลายเซ็นผู้ตรวจรับมอบงาน (ลูกค้า G-Able)"
                      onError={() => setSigErrors(prev => ({ ...prev, inspector_signature: true }))}
                    />
                  ) : firstCompletedTask?.customer_accepted_at ? (
                    <span className="handover-sig-verified">
                      <ShieldCheck size={18} />
                      <span>ยืนยันตรวจรับผ่านระบบ</span>
                    </span>
                  ) : (
                    <span className="handover-sig-empty">รอผู้ตรวจรับมอบงานลงนาม</span>
                  )}
                </div>
                <div className={`handover-sig-status ${firstCompletedTask?.customer_accepted_at ? 'is-signed' : 'is-pending'}`}>
                  {firstCompletedTask?.customer_accepted_at ? '✓ ตรวจรับมอบงาน (Batch Accepted)' : 'รอตรวจรับมอบงาน'}
                </div>
                <strong className="handover-sig-role">ผู้ตรวจรับมอบงาน (Customer Reviewer)</strong>
                <div className="handover-sig-org">บมจ. จีเอเบิล (G-Able)</div>
                {firstCompletedTask?.customer_accepted_by && (
                  <div className="handover-sig-meta">ผู้ลงนาม: {firstCompletedTask.customer_accepted_by}</div>
                )}
                {firstCompletedTask?.customer_accepted_at && (
                  <div className="handover-sig-meta">
                    วันที่: {formatDate(firstCompletedTask.customer_accepted_at) || '—'}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const EVIDENCE_GROUPS_DEF = [
  {
    id: 'old_device',
    title: 'เครื่องเก่า (Old Device)',
    badge: '4 รูป',
    icon: '📦',
    slots: [
      { key: 'old_serial_photo', aliases: ['photo_old_serial', 'old_serial_photo'], num: '1', title: 'SN เครื่องเก่า', hint: 'ถ่ายฉลาก Serial ของ Scanner เดิม' },
      { key: 'old_device_photo', aliases: ['photo_old_device', 'old_device_photo'], num: '2', title: 'ภาพรวมเครื่องเก่า', hint: 'ถ่ายตัวเครื่อง Scanner เดิมทั้งเครื่อง' },
      { key: 'old_condition_photo', aliases: ['photo_old_condition', 'old_condition_photo'], num: '3', title: 'สภาพเครื่องเก่า', hint: 'ถ่ายตำหนิหรือสภาพปัจจุบัน' },
      { key: 'old_branch_sticker_photo', aliases: ['photo_old_branch_sticker', 'old_branch_sticker_photo'], num: '4', title: 'สติกเกอร์สาขาเดิม', hint: 'ถ่ายสติกเกอร์ที่ระบุสาขาเดิม' },
    ]
  },
  {
    id: 'new_device',
    title: 'เครื่องใหม่ (New Device)',
    badge: '6 รูป',
    icon: '✨',
    slots: [
      { key: 'new_serial_photo', aliases: ['photo_new_serial', 'new_serial_photo'], num: '1', title: 'SN เครื่องใหม่', hint: 'ถ่ายฉลาก Serial ของ Scanner ใหม่' },
      { key: 'new_front_photo', aliases: ['photo_new_front', 'new_front_photo'], num: '2', title: 'ด้านหน้าเครื่องใหม่', hint: 'ถ่ายด้านหน้าของ Scanner ใหม่' },
      { key: 'new_side_photo', aliases: ['photo_new_side', 'new_side_photo'], num: '3', title: 'ด้านข้างเครื่องใหม่', hint: 'ถ่ายด้านข้างของ Scanner ใหม่' },
      { key: 'new_com_serial_photo', aliases: ['photo_new_com_serial', 'new_com_serial_photo'], num: '4', title: 'Com SN / กล่องใหม่', hint: 'ถ่ายฉลาก Com SN / กล่อง' },
      { key: 'new_device_photo', aliases: ['photo_new_device', 'new_device_photo'], num: '5', title: 'ตัวเครื่องพร้อมใช้', hint: 'ถ่ายภาพ Scanner ใหม่พร้อมใช้งาน' },
      { key: 'new_cable_management_photo', aliases: ['photo_new_cable_management', 'new_cable_management_photo'], num: '6', title: 'การต่อสายสัญญาณ/ไฟ', hint: 'ถ่ายจุดเชื่อมต่อและสายสัญญาณ' },
    ]
  },
  {
    id: 'signatures',
    title: 'ลายเซ็นผู้เกี่ยวข้อง (Signatures)',
    badge: '3 ลายเซ็น',
    icon: '✍️',
    slots: [
      { key: 'technician_signature', aliases: ['technician_signature', 'sig_tech'], num: '1', title: 'ลายเซ็นช่างผู้ปฏิบัติงาน (SYM)', hint: 'ช่างผู้ปฏิบัติงานลงนาม Onsite' },
      { key: 'scanner_user_signature', aliases: ['scanner_user_signature', 'sig_cust'], num: '2', title: 'ลายเซ็นผู้รับมอบประจำสาขา (AIS)', hint: 'พนักงานประจำสาขา AIS ลงนามรับทราบ' },
      { key: 'inspector_signature', aliases: ['inspector_signature', 'customer_signature', 'sig_inspector', 'sig_customer'], num: '3', title: 'ลายเซ็นผู้ตรวจรับมอบงาน (ลูกค้า G-Able)', hint: 'ตัวแทนลูกค้า G-Able ลงนามตรวจรับมอบ' },
    ]
  },
  {
    id: 'spares',
    title: 'รูปสำรอง (Optional)',
    badge: 'ไม่บังคับ 2 รูป',
    icon: '📎',
    slots: [
      { key: 'spare_photo_1', aliases: ['spare_photo_1'], num: '1', title: 'รูปสำรอง 1', hint: 'รูปถ่ายเพิ่มเติม (ถ้ามี)' },
      { key: 'spare_photo_2', aliases: ['spare_photo_2'], num: '2', title: 'รูปสำรอง 2', hint: 'รูปถ่ายเพิ่มเติม (ถ้ามี)' },
    ]
  }
] as const

function PendingReviews({ role, currentEmail, onUpdated, onOpenHandover }: { role?: string; currentEmail?: string; onUpdated: (action: string) => void; onOpenHandover?: (branch: any) => void }) {
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
  const [batchConsent, setBatchConsent] = useState(false)
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const [viewingEvidenceTask, setViewingEvidenceTask] = useState<Record<string, unknown> | null>(null)
  const [evidenceList, setEvidenceList] = useState<any[]>([])
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const [selectedAdminTask, setSelectedAdminTask] = useState<Record<string, unknown> | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState('')
  const [zoomedEvidenceIndex, setZoomedEvidenceIndex] = useState<number | null>(null)
  const sigPadRef = useRef<SignaturePadHandle>(null)
  const evidenceRequestRef = useRef(0)

  useEffect(() => {
    const hasModalOpen = Boolean(zoomedEvidenceIndex !== null || batchBranch || rejectingTask || viewingEvidenceTask || selectedAdminTask)
    if (!hasModalOpen) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || submitting) return
      event.preventDefault()
      if (zoomedEvidenceIndex !== null) {
        setZoomedEvidenceIndex(null)
      } else if (rejectingTask) {
        setRejectingTask(null)
        setActionError('')
      } else if (batchBranch) {
        setBatchBranch(null)
        setActionError('')
      } else if (viewingEvidenceTask || selectedAdminTask) {
        setViewingEvidenceTask(null)
        setSelectedAdminTask(null)
        setActionError('')
        setZoomedEvidenceIndex(null)
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [zoomedEvidenceIndex, batchBranch, rejectingTask, viewingEvidenceTask, selectedAdminTask, submitting])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const res = await d1Api.getPendingTasks(query || undefined)
        if (active) {
          const list = res.tasks || []
          setTasks(list)
          setSelectedTaskIds(list.map((t: any) => String(t.task_id || t.id)))
        }
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

  const handleOpenBatchAccept = (
    group: { id: string; name: string; code: string; province: string; tasks: any[] },
    singleTaskId?: string
  ) => {
    setActionError('')
    setBatchConsent(false)
    setBatchBranch(group)
    if (singleTaskId) {
      setSelectedTaskIds([singleTaskId])
    } else {
      const groupTaskIds = group.tasks.map(t => String(t.task_id || t.id))
      const alreadySelectedInGroup = selectedTaskIds.filter(id => groupTaskIds.includes(id))
      setSelectedTaskIds(alreadySelectedInGroup.length > 0 ? alreadySelectedInGroup : groupTaskIds)
    }
  }

  const handleToggleSelectTask = (taskId: string) => {
    setSelectedTaskIds(current =>
      current.includes(taskId) ? current.filter(id => id !== taskId) : [...current, taskId]
    )
  }

  const handleConfirmBatchAccept = async () => {
    if (!batchBranch || selectedTaskIds.length === 0 || !batchConsent) return
    if (!sigPadRef.current) return
    setSubmitting(true)
    setActionError('')
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
      setBatchConsent(false)
      setSelectedTaskIds([])
      setReload(r => r + 1)
      onUpdated('accept')
    } catch (err: any) {
      setActionError(err.message || 'ตรวจรับงานไม่สำเร็จ')
    } finally {
      setSubmitting(false)
    }
  }

  const handleConfirmReject = async () => {
    if (!rejectingTask || !rejectReason.trim()) return
    const taskId = String(rejectingTask.task_id || rejectingTask.id)
    setSubmitting(true)
    setActionError('')
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
      setActionError(err.message || 'ปฏิเสธงานไม่สำเร็จ')
    } finally {
      setSubmitting(false)
    }
  }

  const isSelfActorForTask = (task: Record<string, unknown> | null) => {
    if (!task || !currentEmail) return false
    const me = currentEmail.trim().toLowerCase()
    if (!me) return false
    return [task.closeout_submitted_by, task.started_by].some(actor => String(actor || '').trim().toLowerCase() === me)
  }

  const handleSymPass = async (task: Record<string, unknown>) => {
    if (isSelfActorForTask(task)) {
      setActionError('ตามหลัก 4-Eyes Control ผู้อนุมัติ SYM ต้องไม่เป็นคนเดียวกับช่างที่เปิดงานหรือส่งปิดงาน')
      return
    }
    const taskId = String(task.task_id || task.id)
    setSubmitting(true)
    setActionError('')
    try {
      await d1Api.symVerify(taskId, 'pass', undefined, Number(task.version || 1))
      setSelectedAdminTask(null)
      setReload(r => r + 1)
      onUpdated('accept')
    } catch (err: any) {
      setActionError(err.message || 'ตรวจรับงานไม่สำเร็จ')
    } finally {
      setSubmitting(false)
    }
  }

  const handleOpenEvidence = async (task: Record<string, unknown>) => {
    const requestId = ++evidenceRequestRef.current
    setActionError('')
    setViewingEvidenceTask(task)
    setEvidenceList([])
    setEvidenceLoading(true)
    try {
      const taskId = String(task.task_id || task.id)
      const res = await d1Api.getTaskEvidence(taskId)
      if (requestId === evidenceRequestRef.current) {
        setEvidenceList(res.evidence || [])
      }
    } catch (err: any) {
      if (requestId === evidenceRequestRef.current) {
        setEvidenceList([])
        setActionError(err?.message || 'โหลดรายการหลักฐานไม่สำเร็จ')
      }
    } finally {
      if (requestId === evidenceRequestRef.current) {
        setEvidenceLoading(false)
      }
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

        {actionError && !batchBranch && !rejectingTask && !selectedAdminTask && !viewingEvidenceTask && (
          <div className="form-error mb-3" role="alert">
            {actionError}
          </div>
        )}

        {loading ? (
          <EmptyState compact loading />
        ) : error ? (
          <EmptyState compact title="โหลดรายการไม่สำเร็จ" detail={error} onRetry={() => setReload(r => r + 1)} />
        ) : isCustomerReviewer ? (
          branchGroups.length ? (
            <div className="branch-review-queue">
              {branchGroups.map(group => {
                const groupTaskIds = group.tasks.map(t => String(t.task_id || t.id))
                const selectedInGroupCount = groupTaskIds.filter(id => selectedTaskIds.includes(id)).length

                return (
                  <article className="branch-review-card" key={group.id}>
                    <div className="branch-review-header">
                      <div>
                        <h3>{group.name}</h3>
                        <p>LocationCode: {group.code} · จังหวัด: {group.province} · {group.tasks.length} เครื่อง</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {group.isOverdue && (
                          <span className="overdue-sla-badge">
                            <AlertTriangle size={12} /> เกินกำหนด SLA 2 วันทำการ
                          </span>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onOpenHandover?.(group)}
                          title="ดูและพิมพ์เอกสารตรวจรับส่งมอบงานประจำสาขานี้ (PDF)"
                        >
                          <Printer size={13} /> ใบตรวจรับ (PDF)
                        </Button>
                        <Button
                          type="button"
                          onClick={() => handleOpenBatchAccept(group)}
                        >
                          <ShieldCheck size={15} />{' '}
                          {selectedInGroupCount > 0 && selectedInGroupCount < group.tasks.length
                            ? `ตรวจรับที่เลือก (${selectedInGroupCount} เครื่อง)`
                            : `ตรวจรับทั้งสาขา (${group.tasks.length} เครื่อง)`}
                        </Button>
                      </div>
                    </div>

                    <div className="branch-review-scanners">
                      {group.tasks.map(task => {
                        const taskId = String(task.task_id || task.id)
                        const isChecked = selectedTaskIds.includes(taskId)

                        return (
                          <div className="branch-review-scanner-item" key={taskId}>
                            <label className="flex cursor-pointer items-center gap-2.5">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => handleToggleSelectTask(taskId)}
                                className="size-4 accent-emerald-600"
                              />
                              <div className="branch-review-scanner-info">
                                <strong>SN เดิม: {String(task.com_sn || task.serial || '—')} → SN ใหม่: {String(task.new_serial_number || '—')}</strong>
                                <span>รุ่น: {String(task.model_name || task.model || 'Scanner')} · ผล: {getStatusPresentation(task.outcome || 'replaced').label}</span>
                              </div>
                            </label>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => handleOpenEvidence(task)}
                              >
                                ดูรูปหลักฐาน
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => handleOpenBatchAccept(group, taskId)}
                                title="ตรวจรับเฉพาะเครื่องนี้ (1 เครื่อง)"
                              >
                                <ShieldCheck size={14} /> ตรวจรับเครื่องนี้
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="border-red-200 bg-red-50 text-red-700 hover:bg-red-100 hover:text-red-800"
                                onClick={() => setRejectingTask(task)}
                              >
                                ปฏิเสธ
                              </Button>
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
                        <StatusPill
                          label={getStatusPresentation(task.task_status || task.status || 'awaiting_admin_acceptance').label}
                          tone={getStatusPresentation(task.task_status || task.status || 'awaiting_admin_acceptance').tone}
                        />
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

      {/* Modal: Batch / Single Acceptance by Gable */}
      {batchBranch && (
        <div className="handover-modal-backdrop" onClick={() => { setBatchBranch(null); setActionError('') }}>
          <div className="handover-modal-content max-w-[600px]" onClick={e => e.stopPropagation()}>
            <div className="handover-modal-bar">
              <strong>
                {selectedTaskIds.length === 1
                  ? 'ตรวจรับมอบงาน (เฉพาะเครื่องที่เลือก)'
                  : `ตรวจรับมอบงานแบบรวม (${selectedTaskIds.length} เครื่อง)`}
              </strong>
              <button type="button" className="icon-button" onClick={() => { setBatchBranch(null); setActionError('') }}>
                <X size={16} />
              </button>
            </div>
            <div className="p-5">
              {actionError && (
                <div className="form-error mb-3.5" role="alert">
                  {actionError}
                </div>
              )}
              <div className="mb-4">
                <h3 className="m-0 mb-1 text-base font-bold text-slate-900">{batchBranch.name}</h3>
                <p className="m-0 text-[13px] text-slate-500">
                  LocationCode: {batchBranch.code} · {selectedTaskIds.length === 1 ? 'ตรวจรับเฉพาะเครื่องนี้ (1 เครื่อง)' : `กำลังตรวจรับจำนวน ${selectedTaskIds.length} เครื่อง`}
                </p>
              </div>

              <div className="mb-3.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
                {selectedTaskIds.length === 1
                  ? 'ข้าพเจ้าในฐานะตัวแทน บมจ. จีเอเบิล (G-Able) ได้ตรวจสอบผลงานและหลักฐานของเครื่องนี้แล้ว ขอลงนามตรวจรับมอบงานเข้าสู่สถานะส่งมอบสมบูรณ์ (Delivered)'
                  : 'ข้าพเจ้าในฐานะตัวแทน บมจ. จีเอเบิล (G-Able) ได้ตรวจสอบผลงานและหลักฐานการเปลี่ยนเครื่องสแกนเนอร์ของสาขานี้แล้ว ขอลงนามตรวจรับมอบงานเข้าสู่สถานะส่งมอบสมบูรณ์ (Delivered)'}
              </div>

              <label className="mb-3.5 flex cursor-pointer items-start gap-2 text-[13px] text-slate-700">
                <input
                  type="checkbox"
                  checked={batchConsent}
                  onChange={e => {
                    const checked = e.target.checked
                    setBatchConsent(checked)
                    if (!checked) {
                      sigPadRef.current?.clear()
                    }
                  }}
                  disabled={submitting}
                  className="mt-0.5 size-4 accent-emerald-600"
                />
                <span>ผู้ตรวจรับมอบยืนยันว่าได้ตรวจสอบหลักฐานและยินยอมให้บันทึกลายเซ็นนี้เป็นหลักฐานตรวจรับงาน</span>
              </label>

              <div className="mb-3">
                <span className="mb-1.5 block text-[13px] font-semibold text-slate-800">
                  ลายเซ็นผู้ตรวจรับมอบงาน (Gable Representative)
                </span>
                <SignaturePad
                  ref={sigPadRef}
                  disabled={submitting || !batchConsent}
                  label="ช่องลายเซ็นผู้ตรวจรับมอบงาน"
                  placeholder={!batchConsent ? 'โปรดกดยืนยันข้อความด้านบนก่อนลงลายเซ็น' : undefined}
                />
                <div className="mt-1.5 flex items-center justify-between">
                  <Button type="button" variant="link" size="sm" className="px-0 text-slate-600" onClick={() => sigPadRef.current?.clear()} disabled={!batchConsent || submitting}>
                    ล้างลายเซ็น
                  </Button>
                  {!batchConsent && <small className="text-xs text-slate-400">ติ๊กยืนยันเพื่อเปิดใช้งานช่องลายเซ็น</small>}
                </div>
              </div>

              <div className="mt-5 flex justify-end gap-2.5">
                <Button type="button" variant="outline" onClick={() => setBatchBranch(null)} disabled={submitting}>
                  ยกเลิก
                </Button>
                <Button type="button" onClick={handleConfirmBatchAccept} disabled={submitting || !batchConsent || selectedTaskIds.length === 0}>
                  {submitting ? 'กำลังบันทึก…' : selectedTaskIds.length === 1 ? 'ยืนยันตรวจรับเครื่องนี้' : `ยืนยันตรวจรับทั้ง ${selectedTaskIds.length} เครื่อง`}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Rejection Reason */}
      {rejectingTask && (
        <div className="handover-modal-backdrop" onClick={() => { setRejectingTask(null); setActionError('') }}>
          <div className="handover-modal-content max-w-[500px]" onClick={e => e.stopPropagation()}>
            <div className="handover-modal-bar">
              <strong>ระบุเหตุผลการปฏิเสธงาน (Reject)</strong>
              <button type="button" className="icon-button" onClick={() => { setRejectingTask(null); setActionError('') }}>
                <X size={16} />
              </button>
            </div>
            <div className="p-5">
              {actionError && (
                <div className="form-error mb-3.5" role="alert">
                  {actionError}
                </div>
              )}
              <p className="m-0 mb-2.5 text-[13px] text-slate-600">
                ใบงานจะถูกส่งกลับไปให้ช่างแก้ไขหน้างานโดยตรง โปรดระบุข้อบกพร่องที่ต้องแก้ไข:
              </p>
              <Textarea
                className="min-h-[100px]"
                placeholder="เช่น ภาพถ่ายหมายเลข Serial ไม่ชัดเจน หรือไม่ได้เดินสายแบบไส้ไก่ตามมาตรฐาน"
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
              />
              <div className="mt-4 flex justify-end gap-2.5">
                <Button type="button" variant="outline" onClick={() => setRejectingTask(null)} disabled={submitting}>
                  ยกเลิก
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleConfirmReject}
                  disabled={submitting || !rejectReason.trim()}
                >
                  {submitting ? 'กำลังส่งกลับ…' : 'ยืนยันปฏิเสธและส่งกลับช่าง'}
                </Button>
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
            setActionError('')
            setZoomedEvidenceIndex(null)
          }}
        >
          <div className="evidence-modal-box" onClick={e => e.stopPropagation()}>
            {(() => {
              const currentTask = selectedAdminTask || viewingEvidenceTask!

              // Map uploaded evidence files
              const evidenceMap = new Map<string, any>()
              for (const ev of evidenceList) {
                evidenceMap.set(ev.evidence_type, ev)
                if (ev.evidence_type.startsWith('photo_')) {
                  evidenceMap.set(ev.evidence_type.replace('photo_', '') + '_photo', ev)
                }
                if (ev.evidence_type.endsWith('_photo')) {
                  evidenceMap.set('photo_' + ev.evidence_type.replace('_photo', ''), ev)
                }
                if (ev.evidence_type === 'technician_signature') evidenceMap.set('sig_tech', ev)
                if (ev.evidence_type === 'sig_tech') evidenceMap.set('technician_signature', ev)
                if (ev.evidence_type === 'scanner_user_signature') evidenceMap.set('sig_cust', ev)
                if (ev.evidence_type === 'sig_cust') evidenceMap.set('scanner_user_signature', ev)
                if (
                  ev.evidence_type === 'inspector_signature' ||
                  ev.evidence_type === 'customer_signature' ||
                  ev.evidence_type === 'sig_inspector' ||
                  ev.evidence_type === 'sig_customer'
                ) {
                  evidenceMap.set('inspector_signature', ev)
                  evidenceMap.set('customer_signature', ev)
                  evidenceMap.set('sig_inspector', ev)
                  evidenceMap.set('sig_customer', ev)
                }
              }

              // Build flat list for Lightbox Zoom navigation
              const lightboxList: Array<{ title: string; path: string; groupTitle: string }> = []
              EVIDENCE_GROUPS_DEF.forEach(group => {
                group.slots.forEach(slot => {
                  const matched = slot.aliases.map(a => evidenceMap.get(a)).find(Boolean)
                  if (matched) {
                    lightboxList.push({
                      title: slot.title,
                      path: matched.storage_path,
                      groupTitle: group.title
                    })
                  }
                })
              })

              return (
                <>
                  <div className="evidence-modal-topbar">
                    <div>
                      <h3>
                        <ShieldCheck size={20} color="#15803d" />
                        รายละเอียดหลักฐานหน้างาน
                      </h3>
                      <p>
                        {String(currentTask.branch_name || currentTask.loc_bld || 'สาขาไม่ระบุ')} · LocationCode: {String(currentTask.location_code || '—')}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => {
                        setViewingEvidenceTask(null)
                        setSelectedAdminTask(null)
                        setActionError('')
                        setZoomedEvidenceIndex(null)
                      }}
                    >
                      <X size={18} />
                    </button>
                  </div>

                  <div className="evidence-modal-scroll">
                    {actionError && (
                      <div className="form-error" role="alert">
                        {actionError}
                      </div>
                    )}
                    {selectedAdminTask && isSelfActorForTask(selectedAdminTask) && (
                      <div className="detail-readonly-note" role="status">
                        ตามหลัก 4-Eyes Control ผู้อนุมัติ SYM ต้องไม่เป็นคนเดียวกับช่างที่เปิดงานหรือส่งปิดงาน — โปรดใช้บัญชี Admin ท่านอื่นตรวจผ่าน (ยังสามารถปฏิเสธ/ส่งกลับช่างได้)
                      </div>
                    )}

                    {/* Summary Card */}
                    <div className="review-summary-card">
                      <div className="review-summary-pills">
                        <span className="review-pill-tag">📍 จังหวัด{String(currentTask.province || '—')}</span>
                        <span className="review-pill-tag">LocationCode: {String(currentTask.location_code || '—')}</span>
                        <span className="review-pill-tag is-green">
                          {currentTask.outcome === 'replaced'
                            ? 'เปลี่ยนเครื่องสมบูรณ์ (Replaced)'
                            : currentTask.outcome
                              ? getStatusPresentation(currentTask.outcome).label
                              : 'กำลังตรวจรับ'}
                        </span>
                        {currentTask.admin_accepted_at ? (
                          <span className="review-pill-tag is-green">✓ SYM Admin ตรวจรับแล้ว</span>
                        ) : (
                          <span className="review-pill-tag bg-amber-100 text-amber-800">รอ SYM Admin ตรวจรับ</span>
                        )}
                      </div>

                      <div className="review-summary-grid">
                        <div className="review-metric-item">
                          <span className="metric-label">SN เครื่องเดิม</span>
                          <strong className="metric-val font-mono">{String(currentTask.com_sn || currentTask.serial || '—')}</strong>
                          <span className="metric-sub">รุ่น {String(currentTask.model_name || currentTask.scanner_model || 'Honeywell')}</span>
                        </div>
                        <div className="review-metric-item is-highlight">
                          <span className="metric-label">SN เครื่องใหม่</span>
                          <strong className="metric-val font-mono">{String(currentTask.new_serial_number || '—')}</strong>
                          <span className="metric-sub">ผล: {getStatusPresentation(currentTask.outcome || 'replaced').label}</span>
                        </div>
                        <div className="review-metric-item">
                          <span className="metric-label">ผู้ปฏิบัติงานที่เข้าสาขา</span>
                          <strong className="metric-val">{String(currentTask.started_by || 'ช่าง Onsite')}</strong>
                          <span className="metric-sub">{currentTask.closeout_submitted_at ? `ส่งเมื่อ: ${formatDate(currentTask.closeout_submitted_at)}` : '—'}</span>
                        </div>
                        <div className="review-metric-item">
                          <span className="metric-label">การตรวจสอบ Stage 1 (SYM)</span>
                          <strong className={cn('metric-val', currentTask.admin_accepted_at ? 'text-emerald-700' : 'text-amber-600')}>
                            {currentTask.admin_accepted_at ? '✓ ผ่านการตรวจแล้ว' : 'รอ SYM พิจารณา'}
                          </strong>
                          <span className="metric-sub">{currentTask.admin_accepted_at ? `${String(currentTask.admin_accepted_by || 'Admin')} · ${formatDate(currentTask.admin_accepted_at)}` : 'รอคิว'}</span>
                        </div>
                      </div>

                      {Boolean(currentTask.notes) && (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600">
                          <strong className="text-slate-800">หมายเหตุจากหน้างาน:</strong> {String(currentTask.notes)}
                        </div>
                      )}
                    </div>

                    {/* Evidence Photo Sections */}
                    {evidenceLoading ? (
                      <div className="p-10 text-center text-sm text-slate-500">กำลังโหลดรูปภาพและลายเซ็น…</div>
                    ) : (
                      <div className="review-sections-list">
                        {EVIDENCE_GROUPS_DEF.map(group => {
                          const uploadedCount = group.slots.filter(s => s.aliases.some(a => evidenceMap.has(a))).length
                          const isComplete = group.id === 'signatures'
                            ? (evidenceMap.has('technician_signature') && evidenceMap.has('scanner_user_signature'))
                            : uploadedCount === group.slots.length

                          return (
                            <section className="review-section-box" key={group.id}>
                              <div className="review-section-header">
                                <h4>
                                  <span>{group.icon}</span>
                                  <span>{group.title}</span>
                                </h4>
                                <span className={cn('review-section-counter', !isComplete && 'bg-amber-100 text-amber-800')}>
                                  แนบแล้ว {uploadedCount}/{group.slots.length}
                                </span>
                              </div>

                              <div className="review-grid-cards">
                                {group.slots.map(slot => {
                                  const matched = slot.aliases.map(a => evidenceMap.get(a)).find(Boolean)
                                  const isUploaded = Boolean(matched)

                                  const handleCardClick = () => {
                                    if (!matched) return
                                    const idx = lightboxList.findIndex(item => item.path === matched.storage_path)
                                    if (idx !== -1) setZoomedEvidenceIndex(idx)
                                  }

                                  return (
                                    <div
                                      key={slot.key}
                                      className={`review-card-item ${isUploaded ? 'is-ready' : 'is-empty'}`}
                                      onClick={handleCardClick}
                                      title={isUploaded ? 'คลิกเพื่อขยายดูภาพเต็ม' : undefined}
                                    >
                                      <span className="review-slot-badge">{slot.num}</span>
                                      {isUploaded ? (
                                        <span className="review-ready-pill">✓ แนบแล้ว</span>
                                      ) : slot.key === 'inspector_signature' ? (
                                        <span className="review-ready-pill border border-sky-200 bg-sky-50 text-sky-700">รอ Gable ลงนาม</span>
                                      ) : (
                                        <span className="review-ready-pill border border-slate-200 bg-slate-100 text-slate-500">ยังไม่มีรูป</span>
                                      )}

                                      <div className="review-card-thumb">
                                        {isUploaded ? (
                                          <>
                                            <img
                                              src={`/api/evidence/${matched.storage_path}?v=${Number(currentTask.version || 1)}`}
                                              alt={slot.title}
                                              loading="lazy"
                                              onError={e => {
                                                (e.target as HTMLElement).style.display = 'none'
                                              }}
                                            />
                                            <div className="review-thumb-zoom-hint">
                                              <Search size={14} /> คลิกขยาย
                                            </div>
                                          </>
                                        ) : slot.key === 'inspector_signature' ? (
                                          <div className="review-thumb-missing text-sky-700">
                                            <ShieldCheck size={20} />
                                            <span>รอ Gable ลงนาม</span>
                                          </div>
                                        ) : (
                                          <div className="review-thumb-missing">
                                            <Camera size={20} />
                                            <span>ยังไม่มีรูป</span>
                                          </div>
                                        )}
                                      </div>

                                      <div className="review-card-info">
                                        <strong>{slot.title}</strong>
                                        <small>{slot.hint}</small>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </section>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* Lightbox Zoom Modal */}
                  {zoomedEvidenceIndex !== null && lightboxList[zoomedEvidenceIndex] && (
                    <div
                      className="handover-modal-backdrop z-[10000] bg-slate-900/90 backdrop-blur-xs"
                      onClick={() => setZoomedEvidenceIndex(null)}
                    >
                      <div
                        className="relative flex max-h-[94vh] max-w-[94vw] flex-col items-center justify-center"
                        onClick={e => e.stopPropagation()}
                      >
                        <div className="mb-3 flex w-full items-center justify-between text-white">
                          <div className="flex items-center gap-2">
                            <strong className="text-base">
                              {lightboxList[zoomedEvidenceIndex].title}
                            </strong>
                            <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs">
                              {lightboxList[zoomedEvidenceIndex].groupTitle} · ภาพที่ {zoomedEvidenceIndex + 1} จาก {lightboxList.length}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="icon-button bg-white/20 text-white hover:bg-white/30 hover:text-white"
                            onClick={() => setZoomedEvidenceIndex(null)}
                          >
                            <X size={18} />
                          </button>
                        </div>

                        <img
                          src={`/api/evidence/${lightboxList[zoomedEvidenceIndex].path}?v=${Number(currentTask.version || 1)}`}
                          alt={lightboxList[zoomedEvidenceIndex].title}
                          className="max-h-[78vh] max-w-full rounded-xl bg-slate-900 object-contain shadow-2xl"
                        />

                        <div className="mt-3.5 flex gap-3.5">
                          <Button
                            type="button"
                            variant="ghost"
                            className="border border-white/25 bg-white/15 text-white hover:bg-white/25 hover:text-white"
                            disabled={zoomedEvidenceIndex === 0}
                            onClick={() => setZoomedEvidenceIndex(i => Math.max(0, (i || 0) - 1))}
                          >
                            <ChevronLeft size={16} /> ภาพก่อนหน้า
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="border border-white/25 bg-white/15 text-white hover:bg-white/25 hover:text-white"
                            disabled={zoomedEvidenceIndex === lightboxList.length - 1}
                            onClick={() => setZoomedEvidenceIndex(i => Math.min(lightboxList.length - 1, (i || 0) + 1))}
                          >
                            ภาพถัดไป <ChevronRight size={16} />
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Modal Footer Actions */}
                  <div className="review-modal-actions">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setViewingEvidenceTask(null)
                          setSelectedAdminTask(null)
                          setActionError('')
                          setZoomedEvidenceIndex(null)
                        }}
                      >
                        ปิดหน้าต่าง
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenHandover?.(currentTask)}
                        title="ดูและพิมพ์เอกสารตรวจรับมอบงานประจำสาขานี้ (PDF)"
                      >
                        <Printer size={14} /> ใบตรวจรับ (PDF)
                      </Button>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {isCustomerReviewer ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
                            onClick={() => {
                              setRejectingTask(currentTask)
                              setViewingEvidenceTask(null)
                            }}
                          >
                            ปฏิเสธ (Reject)
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              const bId = String(currentTask.branch_id || '')
                              const group = branchGroups.find(g => g.id === bId)
                              const tId = String(currentTask.task_id || currentTask.id)
                              if (group) {
                                setViewingEvidenceTask(null)
                                handleOpenBatchAccept(group, tId)
                              }
                            }}
                          >
                            <ShieldCheck size={14} /> รับเฉพาะเครื่องนี้
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              const bId = String(currentTask.branch_id || '')
                              const group = branchGroups.find(g => g.id === bId)
                              if (group) {
                                setViewingEvidenceTask(null)
                                handleOpenBatchAccept(group)
                              }
                            }}
                          >
                            <ShieldCheck size={14} /> ตรวจรับทั้งสาขา
                          </Button>
                        </>
                      ) : selectedAdminTask ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
                            onClick={() => {
                              setRejectingTask(selectedAdminTask)
                              setSelectedAdminTask(null)
                            }}
                          >
                            ปฏิเสธ / ส่งกลับช่าง
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={submitting || isSelfActorForTask(selectedAdminTask)}
                            onClick={() => handleSymPass(selectedAdminTask)}
                          >
                            <CheckCircle2 size={14} /> ตรวจผ่าน (ส่งต่อ Gable)
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </>
              )
            })()}
          </div>
        </div>
      )}
    </>
  )
}

function WorkOrders({ role, currentEmail, demo, onUpdated, view = 'all', onOpenHandover }: { role?: string; currentEmail?: string; demo: boolean; onUpdated: (action: string) => void; view?: 'all' | 'completed'; onOpenHandover?: (branchOrTask: any) => void }) {
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
    setPage(0)
    setQuery('')
    setDraft('')
    setSelectedTask(null)
  }, [completedView])

  useEffect(() => {
    setSelectedTask(prev => {
      if (!prev) return prev
      const targetId = String(prev.task_id || prev.id || '')
      if (!targetId) return prev
      const fresh = rows.find(r => String(r.task_id || r.id || '') === targetId)
      return fresh || prev
    })
  }, [rows])

  useEffect(() => {
    if (demo) return
    let active = true
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const res = await d1Api.getScanners({
          search: query || undefined,
          status: completedView ? 'complete' : 'has_task',
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
        const stage = getTaskWorkflowStage(row)
        const status = getStatusPresentation(stage)
        const serial = String(row.com_sn || row.serial || row.old_serial_snapshot || 'ไม่พบ Serial')
        const canPrintHandover = ['awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'delivered', 'completed', 'exception_resolved', 'legacy_completed'].includes(stage)
        return <article className="pending-review-row" key={id}>
          <div className="pending-review-main"><div className="pending-review-title"><strong>{String(row.branch_name || 'สาขาไม่ระบุ')} · SN {serial}</strong><StatusPill label={status.label} tone={status.tone} /></div><span>{String(row.scanner_model || 'Scanner')} · จังหวัด{String(row.province || 'ไม่ระบุ')} · LocationCode {String(row.location_code || '—')}</span><small>ใบงาน {String(row.work_order_code || '—')} · {row.performed_by_name ? `ผู้ปฏิบัติงาน ${String(row.performed_by_name)}` : 'ยังไม่มีผู้ส่งผล'} · {row.performed_at ? formatDate(row.performed_at) : formatDate(row.created_at)}</small></div>
          <div className="flex flex-wrap items-center gap-2">
            {!demo && canPrintHandover && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenHandover?.(row)}
                title="ดูและพิมพ์ใบตรวจรับมอบงานประจำสาขานี้ (PDF)"
              >
                <Printer size={13} /> ใบตรวจรับ
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => { if (!demo) setSelectedTask(row) }} disabled={demo}>เปิดรายละเอียด <ArrowRight size={14} /></Button>
          </div>
        </article>
      })}</div> : <EmptyState compact title={completedView ? 'ยังไม่มีใบงานที่เสร็จแล้ว' : 'ยังไม่มีใบงาน'} detail={query ? 'ไม่พบใบงานที่ตรงกับคำค้นหา' : completedView ? 'งานจะแสดงที่นี่เมื่อส่งมอบแล้วหรือ Admin ปิดผลเรียบร้อย' : 'ใบงานที่เปิดแล้วจะแสดงที่นี่'} />}
      {!demo && !loading && !error && pageCount > 1 && <div className="list-footer"><span>หน้า {page + 1} จาก {pageCount} · {totalOrders.toLocaleString('th-TH')} ใบงาน</span><div><button type="button" className="icon-button" aria-label="หน้าก่อนหน้า" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))}><ChevronLeft size={16} /></button><span className="page-number">{page + 1}</span><button type="button" className="icon-button" aria-label="หน้าถัดไป" disabled={page + 1 >= pageCount} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}><ChevronRight size={16} /></button></div></div>}
    </section>
    {selectedTask && <WorkOrderDetailDialog task={selectedTask} role={role} currentEmail={currentEmail} demo={false} onClose={() => { setSelectedTask(null); setReload(value => value + 1) }} onUpdated={action => { setReload(value => value + 1); onUpdated(action) }} onOpenHandover={onOpenHandover} />}
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

function AssetDetailDialog({ asset, role, currentEmail, demo, onClose, onUpdated, onOpenHandover }: { asset: Record<string, unknown>; role?: string; currentEmail?: string; demo: boolean; onClose: () => void; onUpdated: (action: string) => void; onOpenHandover?: (item: any) => void }) {
  const dialogRef = useDialogControls(onClose)
  const serial = asset.serial || asset.com_sn || '—'
  const model = asset.model || asset.model_name || asset.hw_name || 'เครื่องสแกน'
  const branch = asset.branch || asset.branch_name || asset.loc_bld || 'สาขาไม่ระบุ'
  const code = asset.code || asset.location_code || '—'
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
          const outcomeVal = String(found.outcome || '')
          const noteVal = found.notes ?? (asset.notes as string | undefined) ?? ''
          const performedBy = found.closeout_submitted_by || found.started_by || (asset.closeout_submitted_by as string | undefined) || (asset.started_by as string | undefined) || ''
          const performedAt = found.closeout_submitted_at || found.started_at || (asset.closeout_submitted_at as string | undefined) || (asset.started_at as string | undefined) || ''
          const createdAt = found.created_at || found.started_at || (asset.created_at as string | undefined) || (asset.started_at as string | undefined) || performedAt
          const oldSn = found.com_sn || String(serial || '')
          const newSn = found.new_serial_number || (asset.new_serial_number as string | undefined) || (asset.new_serial as string | undefined) || ''
          const row: Record<string, unknown> = {
            id: found.task_id,
            task_id: found.task_id,
            status: found.task_status,
            task_status: found.task_status,
            workflow_outcome: found.outcome,
            outcome: found.outcome,
            com_sn: oldSn,
            serial: oldSn,
            old_serial_snapshot: oldSn,
            new_serial_number: newSn,
            new_serial: newSn,
            observed_serial: found.observed_serial || (outcomeVal === 'replaced' ? oldSn : ''),
            observed_model: found.model_name || String(model || ''),
            install_result: noteVal || (outcomeVal === 'replaced' ? 'ติดตั้งและทดสอบเครื่องใหม่เรียบร้อย' : ''),
            old_scanner_status: outcomeVal === 'replaced' ? 'returned_damaged' : '',
            exception_reason: outcomeVal && outcomeVal !== 'replaced' ? noteVal : '',
            notes: noteVal,
            created_at: createdAt,
            started_at: found.started_at,
            started_by: found.started_by,
            closeout_submitted_at: found.closeout_submitted_at,
            closeout_submitted_by: found.closeout_submitted_by,
            performed_by_name: performedBy,
            performed_at: performedAt,
            admin_accepted_at: found.admin_accepted_at,
            admin_accepted_by: found.admin_accepted_by,
            customer_accepted_at: found.customer_accepted_at,
            customer_accepted_by: found.customer_accepted_by,
            customer_rejected_at: found.customer_rejected_at,
            customer_reject_reason: found.customer_reject_reason,
            work_order_code: found.work_order_code || (asset.work_order_code as string | undefined) || '',
            branch_id: branchId || asset.branch_id,
            branch_name: branch,
            branch,
            province: asset.province,
            location_code: code,
            code,
            scanner_model: model,
            model,
            version: found.version || 1,
            can_admin_accept: role === 'admin' && !(Boolean(currentEmail?.trim()) && [found.closeout_submitted_by, found.started_by].some(actor => String(actor || '').trim().toLowerCase() === String(currentEmail).trim().toLowerCase())),
            can_resolve_pending: role === 'admin' && !(Boolean(currentEmail?.trim()) && [found.closeout_submitted_by, found.started_by].some(actor => String(actor || '').trim().toLowerCase() === String(currentEmail).trim().toLowerCase())),
          }
          setWorkHistory([row])
          setSelectedHistoryTaskId(found.task_id)
          setSelectedWorkTask(prev => {
            if (pendingOpenTaskId.current === found.task_id) {
              pendingOpenTaskId.current = ''
              return row
            }
            if (prev && String(prev.task_id || prev.id || '') === found.task_id) {
              return row
            }
            return prev
          })
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
  }, [asset?.branch_id, asset?.com_sn, assetId, branch, code, currentEmail, canViewHistory, historyRetry, model, role, serial])
  const selectedHistoryTask = workHistory.find(task => String(task.id || '') === selectedHistoryTaskId) || null
  const latestTask = workHistory[0] || null
  const rawAssetStatus = String(latestTask?.task_status || latestTask?.status || asset.task_status || asset.status || '').trim().toLowerCase()
  const hasTaskRecord = Boolean(latestTask?.task_id || asset.task_id)
  const status = (!hasTaskRecord || !rawAssetStatus || rawAssetStatus === 'open')
    ? { label: 'รอเปิดใบงาน', tone: 'neutral' }
    : getStatusPresentation(rawAssetStatus)
  const selectedHistoryOutcome = String(selectedHistoryTask?.workflow_outcome || '')
  const selectedHistoryStage = selectedHistoryTask ? getTaskWorkflowStage(selectedHistoryTask) : ''
  const selectedHistoryEvidenceOutcome = selectedHistoryOutcome || (['open', 'scheduled', 'awaiting_confirmation', 'confirmed', 'in_progress', 'blocked', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review'].includes(selectedHistoryStage) ? 'replaced' : '')
  const currentTaskStatus = String(latestTask?.task_status || latestTask?.status || (asset.task_id ? (asset.task_status || asset.status) : '') || '').trim().toLowerCase()
  const isTaskInProgress = ['scheduled', 'in_progress', 'blocked'].includes(currentTaskStatus)
  const isTaskPendingReview = ['awaiting_admin_acceptance', 'awaiting_customer_acceptance', 'awaiting_admin_exception_review', 'pending_exception'].includes(currentTaskStatus)
  const isTaskCompleted = ['completed', 'delivered', 'legacy_completed'].includes(currentTaskStatus)
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
  return <>
    <div className="detail-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !selectedWorkTask) onClose() }}>
      <section ref={dialogRef} className="detail-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-detail-title" tabIndex={-1} inert={Boolean(selectedWorkTask)}>
      <header className="detail-dialog-header"><button type="button" className="detail-back" aria-label="กลับไปทะเบียนอุปกรณ์" onClick={onClose}><ChevronLeft size={20} /></button><div><span className="detail-eyebrow">ทะเบียนอุปกรณ์</span><h2 id="asset-detail-title">รายละเอียด Scanner</h2></div><button type="button" className="detail-close" aria-label="ปิดรายละเอียด" onClick={onClose}><X size={18} /></button></header>
      <div className="detail-status-line"><span className="detail-status-dot" /><strong>{String(model)}</strong><StatusPill label={status.label} tone={String(asset.tone || status.tone)} /></div>
          <section className="detail-section"><div className="scanner-detail-title-row"><h3>ข้อมูลอุปกรณ์</h3>{canViewHistory && (isTaskInProgress && latestTask
            ? <button type="button" className="primary-button" onClick={() => setSelectedWorkTask(latestTask)}>เปิดงานที่กำลังทำ <ArrowRight size={15} /></button>
            : isTaskPendingReview && latestTask && role === 'admin' && currentTaskStatus !== 'awaiting_customer_acceptance'
              ? <button type="button" className="secondary-button" onClick={() => setSelectedWorkTask(latestTask)}>ตรวจรับใบงานนี้ <ArrowRight size={15} /></button>
              : (isTaskCompleted || isTaskPendingReview)
                ? null
                : !historyLoading
                  ? <button type="button" className="primary-button" disabled={startingWork} onClick={() => void startScannerWork()}>{startingWork ? 'กำลังเริ่มงาน…' : 'เริ่มงานกับ Scanner นี้'}</button>
                  : null)}</div><div className="detail-grid"><DetailField label="Serial Number" value={serial} /><DetailField label="รุ่น" value={model} /><DetailField label="สาขา" value={branch} /><DetailField label="LocationCode" value={code} /><DetailField label="จังหวัด" value={asset.province} /><DetailField label="ปีข้อมูลเดิม" value={asset.year || asset.com_years} /></div>{startError && <div className="task-action-error" role="alert">{startError}</div>}</section>
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
                      <DetailField label="SN เครื่องใหม่" value={selectedHistoryTask.new_serial || (['no_damage_found', 'aborted', 'different_device_found', 'target_device_not_found', 'scanner_missing'].includes(String(selectedHistoryTask.workflow_outcome || '')) ? 'ไม่มีการเปลี่ยนเครื่อง' : 'ยังไม่บันทึก')} />
                      <DetailField label="ผลที่พบหน้างาน" value={selectedHistoryTask.workflow_outcome ? getStatusPresentation(selectedHistoryTask.workflow_outcome).label : 'ยังไม่บันทึกผลหน้างาน'} />
                      {(Boolean(selectedHistoryTask.observed_serial) || String(selectedHistoryTask.workflow_outcome || '') === 'different_device_found') && (
                        <DetailField label="SN ของเครื่องที่พบ" value={selectedHistoryTask.observed_serial} />
                      )}
                      <DetailField label="ผู้ปฏิบัติงาน" value={selectedHistoryTask.performed_by_name || 'ยังไม่มีผู้ปฏิบัติงานที่บันทึกผล'} />
                      <DetailField label="วันและเวลาที่ปฏิบัติงาน" value={formatDate(selectedHistoryTask.performed_at) || 'ยังไม่มีเวลาบันทึก'} />
                      <DetailField label="ตรวจรับโดย SYM Admin" value={selectedHistoryTask.admin_accepted_at ? `${String(selectedHistoryTask.admin_accepted_by || 'SYM Admin')} · ${formatDate(selectedHistoryTask.admin_accepted_at)}` : 'รอการตรวจรับ'} />
                      <DetailField label="ตรวจรับมอบโดย Gable" value={selectedHistoryTask.customer_accepted_at ? `${String(selectedHistoryTask.customer_accepted_by || 'Gable Reviewer')} · ${formatDate(selectedHistoryTask.customer_accepted_at)}` : 'รอการตรวจรับมอบ'} />
                      <DetailField label="เหตุผล/หมายเหตุ" value={[selectedHistoryTask.exception_reason, selectedHistoryTask.old_scanner_note, selectedHistoryTask.customer_reject_reason].map(value => String(value || '').trim()).filter(Boolean).join(' · ')} />
                    </div>
                  </section>
                  <TaskEvidencePanel key={String(selectedHistoryTask.id)} taskId={String(selectedHistoryTask.id)} canEdit={false} canView={canViewHistory} requiredSlots={requiredEvidenceSlotsForOutcome(selectedHistoryEvidenceOutcome)} outcome={selectedHistoryEvidenceOutcome} onRequiredReady={ignoreEvidenceState} onBusyChange={ignoreEvidenceState} />
                </>}
              </>
                : <p className="detail-empty-result">ยังไม่มีประวัติการเปลี่ยนเครื่องหรือหลักฐานสำหรับ Scanner นี้</p>}
      </section>
      <div className="detail-readonly-note flex-wrap sm:flex-nowrap">
        <ShieldCheck size={16} className="shrink-0" />
        <span>แสดงข้อมูลทะเบียน ประวัติ รูปภาพ และลายเซ็นของ Scanner เครื่องนี้</span>
        {!demo && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto h-7 gap-1 px-2 text-[11px] shrink-0"
            onClick={() => onOpenHandover?.(asset)}
            title="ดูและพิมพ์ใบตรวจรับมอบงานประจำสาขานี้ (PDF)"
          >
            <Printer size={12} /> ใบตรวจรับ (PDF)
          </Button>
        )}
      </div>
      </section>
    </div>
    {selectedWorkTask && <WorkOrderDetailDialog task={selectedWorkTask} role={role} currentEmail={currentEmail} demo={demo} readOnly={isTaskCompleted || currentTaskStatus === 'awaiting_customer_acceptance'} onClose={() => { setSelectedWorkTask(null); setHistoryRetry(value => value + 1) }} onUpdated={action => { setHistoryRetry(value => value + 1); onUpdated(action) }} onOpenHandover={onOpenHandover} />}
  </>
}

const onsiteEvidenceSlots: EvidenceSlot[] = [
  'old_serial_photo', 'old_device_photo', 'old_condition_photo', 'old_branch_sticker_photo',
  'new_serial_photo', 'new_front_photo', 'new_side_photo', 'new_com_serial_photo', 'new_device_photo', 'new_cable_management_photo',
  'spare_photo_1', 'spare_photo_2',
  'technician_signature', 'scanner_user_signature',
]
const adminReviewEvidenceSlots: EvidenceSlot[] = []

function WorkOrderDetailDialog({ task, role, currentEmail, demo, readOnly = false, onClose, onUpdated, onOpenHandover }: { task: Record<string, unknown>; role?: string; currentEmail?: string; demo: boolean; readOnly?: boolean; onClose: () => void; onUpdated: (action: string) => void; onOpenHandover?: (task: any) => void }) {
  const status = String(task.task_status || task.status || 'scheduled').toLowerCase()
  const rawServerStage = String(task.workflow_stage || (demo ? getTaskWorkflowStage(task) : status === 'scheduled' ? 'open' : status === 'completed' ? 'legacy_completed' : status)).toLowerCase()
  const serverStage = ['open', 'scheduled', 'awaiting_confirmation', 'confirmed'].includes(rawServerStage) ? 'in_progress' : rawServerStage
  const taskId = String(task.task_id || (!('task_id' in task) ? task.id : '') || '').trim()
  const [evidenceStartedTask, setEvidenceStartedTask] = useState<{ id: string; version: number } | null>(null)
  const stage = serverStage
  const presentation = getStatusPresentation(stage)
  const serial = task.old_serial_snapshot || task.serial || task.com_sn || '—'
  const newSerial = task.new_serial_number || task.new_serial
  const rawOutcome = String(task.workflow_outcome || task.outcome || '')
  const outcome = rawOutcome === 'aborted' ? 'no_damage_found' : rawOutcome === 'scanner_missing' ? 'target_device_not_found' : rawOutcome
  const exceptionReason = task.exception_reason || task.notes
  const observedSerial = task.observed_serial
  const isPendingStage = ['blocked', 'pending', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review', 'pending_exception'].includes(stage)
  const currentStep = stage === 'open' ? 0
    : stage === 'in_progress' ? 1
    : ['blocked', 'pending', 'awaiting_admin_acceptance', 'awaiting_admin_exception_review', 'pending_exception'].includes(stage) ? 2
    : ['delivered', 'exception_resolved', 'legacy_completed', 'completed'].includes(stage) ? 3 : -1
  const meEmail = String(currentEmail || '').trim().toLowerCase()
  const isSelfActor = Boolean(meEmail) && [task.closeout_submitted_by, task.started_by].some(actor => String(actor || '').trim().toLowerCase() === meEmail)
  const canAct = !demo && !readOnly && ['field_technician', 'admin'].includes(String(role))
  const canManage = !demo && !readOnly && role === 'admin' && !['completed', 'cancelled'].includes(status)
  const isPendingReview = canManage && ['awaiting_admin_acceptance', 'awaiting_admin_exception_review', 'pending_exception'].includes(stage)
  const canResolvePending = isPendingReview && !isSelfActor && task.can_resolve_pending !== false && task.can_admin_accept !== false
  const canEditTechnicianEvidence = canAct && ['open', 'in_progress'].includes(stage)
  const editableSlots = useMemo<EvidenceSlot[]>(() => canResolvePending
    ? adminReviewEvidenceSlots
    : canEditTechnicianEvidence ? onsiteEvidenceSlots : [], [canResolvePending, canEditTechnicianEvidence])
  const [outcomeInput, setOutcomeInput] = useState(() => outcome || 'replaced')
  const activeOutcome = canEditTechnicianEvidence ? outcomeInput : (outcome || outcomeInput)
  const fieldRequiredSlots = requiredEvidenceSlotsForOutcome(activeOutcome)
  const stageRequiredSlots: EvidenceSlot[] = fieldRequiredSlots
  const [busy, setBusy] = useState(false)
  const [evidenceBusy, setEvidenceBusy] = useState(false)
  const [requiredEvidenceReady, setRequiredEvidenceReady] = useState(false)
  const [actionError, setActionError] = useState('')
  const [showBlockForm, setShowBlockForm] = useState(false)
  const [showExceptionForm, setShowExceptionForm] = useState(false)
  const [showCancelForm, setShowCancelForm] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [blockReason, setBlockReason] = useState('')
  const [newSerialInput, setNewSerialInput] = useState(() => String(task.new_serial_number || task.new_serial || ''))
  const newSerialInputRef = useRef<HTMLInputElement>(null)
  const [showNewSnScanner, setShowNewSnScanner] = useState(false)
  const [observedSerialInput, setObservedSerialInput] = useState('')
  const [exceptionReasonInput, setExceptionReasonInput] = useState('')
  const [registerObservedSerial, setRegisterObservedSerial] = useState(false)

  useEffect(() => {
    setOutcomeInput(outcome || 'replaced')
    setNewSerialInput(String(task.new_serial_number || task.new_serial || ''))
    setObservedSerialInput(String(task.observed_serial || ''))
    setExceptionReasonInput(String(task.exception_reason || task.notes || ''))
  }, [taskId])
  const closeIfIdle = useCallback(() => { if (!busy && !evidenceBusy) onClose() }, [busy, evidenceBusy, onClose])
  const dialogRef = useDialogControls(closeIfIdle)
  const serverVersion = Number(task.version)
  const version = evidenceStartedTask?.id === taskId && Number.isInteger(evidenceStartedTask.version)
    ? Math.max(serverVersion, evidenceStartedTask.version)
    : serverVersion
  const validTaskVersion = Boolean(taskId) && Number.isInteger(version) && version > 0
  const closeoutSnapshot = {
    canEditTechnicianEvidence,
    outcomeInput,
    newSerialInput,
    observedSerialInput,
    exceptionReasonInput,
    version,
    validTaskVersion,
    requiredEvidenceReady,
    busy,
  }
  const latestCloseoutStateRef = useRef(closeoutSnapshot)
  latestCloseoutStateRef.current = closeoutSnapshot
  const canViewEvidence = !demo && ['admin', 'field_technician'].includes(String(role))
  const [reviews, setReviews] = useState<Array<any>>([])

  useEffect(() => {
    if (demo || !taskId) return
    let active = true
    void (async () => {
      try {
        const res = await d1Api.getTaskReviews(taskId)
        if (active) setReviews(res.reviews || [])
      } catch {
        if (active) setReviews([])
      }
    })()
    return () => { active = false }
  }, [taskId, demo])

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

  const submitCloseoutData = async (overrideReady = false) => {
    const snap = latestCloseoutStateRef.current
    if (snap.busy) return
    setActionError('')
    if (!snap.validTaskVersion) { setActionError('เชื่อมต่อระบบไม่ได้หรือข้อมูลใบงานล้าสมัย โปรดโหลดใบงานใหม่'); return }
    if (!overrideReady && !snap.requiredEvidenceReady) { setActionError('บันทึกรูปหลักฐานและลายเซ็นที่จำเป็นให้ครบก่อนส่งผลปิดงาน'); return }
    const cleanSerial = snap.newSerialInput.trim()
    const cleanObserved = snap.observedSerialInput.trim()
    const cleanReason = snap.exceptionReasonInput.trim()
    if (snap.outcomeInput === 'replaced') {
      if (!cleanSerial || cleanSerial.length > 100) {
        setActionError('กรุณากรอก Serial เครื่องใหม่ให้ครบถ้วน')
        newSerialInputRef.current?.focus()
        return
      }
    } else if (snap.outcomeInput === 'no_damage_found') {
      if (!cleanReason || cleanReason.length > 1000) { setActionError('อธิบายเหตุผลที่ไม่พบเครื่องชำรุด'); return }
    } else if (snap.outcomeInput === 'different_device_found') {
      if (!cleanObserved || cleanObserved.length > 100 || !cleanReason || cleanReason.length > 1000) { setActionError('กรอก Serial ของเครื่องที่พบและอธิบายความแตกต่าง'); return }
    } else if (!cleanReason || cleanReason.length > 1000) {
      setActionError('อธิบายเหตุผลที่ไม่พบเครื่องเป้าหมาย'); return
    }
    setBusy(true)
    try {
      await d1Api.submitCloseout(taskId, {
        new_serial_number: cleanSerial || undefined,
        observed_serial: cleanObserved || undefined,
        notes: cleanReason || undefined,
        outcome: snap.outcomeInput,
        version: snap.version,
      })
      onUpdated('closeout_pending')
      onClose()
    } catch (err: any) {
      setActionError(err?.message || 'ยังยืนยันผลส่งปิดงานไม่ได้ โปรดโหลดสถานะล่าสุดก่อนลองซ้ำ')
      onUpdated('refresh')
    } finally { setBusy(false) }
  }

  const submitCloseout = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submitCloseoutData(false)
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
          <section className="detail-section work-order-serial-section"><h3>Serial เครื่องเก่าและเครื่องใหม่</h3><div className="work-order-serial-comparison"><div><span>SN เครื่องเดิม</span><strong>{String(serial)}</strong></div><span className="work-order-serial-arrow" aria-hidden="true">→</span>{canAct && stage === 'in_progress' && isReplacement ? <div className="work-order-new-serial-input"><div className="mb-1 flex items-center justify-between gap-2"><span>SN เครื่องใหม่ *</span><Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => setShowNewSnScanner(true)}><ScanBarcode size={13} /> สแกนบาร์โค้ด</Button></div><Input ref={newSerialInputRef} aria-label="SN เครื่องใหม่" value={newSerialInput} onChange={event => { setNewSerialInput(event.target.value); setActionError('') }} maxLength={100} required autoComplete="off" placeholder="กรอก Serial ของเครื่องใหม่ หรือกดปุ่มสแกน" /></div> : <div><span>SN เครื่องใหม่</span><strong>{newSerial ? String(newSerial) : 'ยังไม่มีข้อมูล'}</strong></div>}</div>{outcome === 'different_device_found' && <div className="work-order-observed-serial"><span>SN อุปกรณ์ที่พบ</span><strong>{observedSerial ? String(observedSerial) : 'ยังไม่มีข้อมูล'}</strong></div>}</section>
          {(status === 'blocked' || isPendingStage) && Boolean(task.blocked_reason || exceptionReason) && <section className="detail-section"><h3>เหตุผลที่ Pending</h3><p className="task-blocked-reason">{String(task.blocked_reason || exceptionReason)}</p></section>}
          <section className="detail-section"><h3>ผลการเปลี่ยน/ตรวจสอบ</h3><div className="detail-grid"><DetailField label="ผลใบงาน" value={outcome ? getStatusPresentation(outcome).label : 'ยังไม่ส่งผลปฏิบัติงาน'} /><DetailField label="ผู้ปฏิบัติงานที่ส่งผล" value={task.performed_by_name || 'ยังไม่มีผู้ส่งผลปฏิบัติงาน'} /><DetailField label="วันและเวลาปฏิบัติงาน" value={formatDate(task.performed_at) || 'ยังไม่มีเวลาบันทึก'} /><DetailField label="SN เดิมตามทะเบียน" value={task.old_serial_snapshot || serial} />{(Boolean(observedSerial) || outcome === 'different_device_found') && <DetailField label={outcome === 'different_device_found' ? 'SN เครื่องที่พบ' : 'Serial อุปกรณ์ที่พบ'} value={observedSerial || 'ยังไม่มีข้อมูล'} />}<DetailField label="เหตุผล/หมายเหตุ" value={exceptionReason || task.old_scanner_note || '—'} /></div><p className="detail-empty-result">ผู้ปฏิบัติงานและเวลาอ้างอิงจากบัญชีที่ส่งผลและเวลาที่บันทึกจริง</p></section>
          {reviews.length > 0 && (
            <section className="detail-section">
              <h3>ประวัติการตรวจรับ (Governance Audit Trail)</h3>
              <div className="flex flex-col gap-2">
                {reviews.map(rev => {
                  const isSym = rev.stage === 'sym'
                  const isPass = rev.decision === 'pass'
                  return (
                    <div
                      key={rev.id}
                      className={cn(
                        'rounded-lg border px-3.5 py-2.5 text-[13px]',
                        isPass ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50',
                      )}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <strong>{isSym ? 'ด่านที่ 1: SYM Admin ตรวจรับงาน' : 'ด่านที่ 2: Gable Customer ตรวจรับมอบ'}</strong>
                        <Badge variant={isPass ? 'done' : 'destructive'}>
                          {isPass ? '✔ ผ่านการตรวจรับ' : '✖ ปฏิเสธงาน / ส่งกลับช่าง'}
                        </Badge>
                      </div>
                      <div className="text-xs text-slate-500">
                        ผู้ตรวจ: {rev.reviewer_email} · เมื่อ {formatDate(rev.created_at)}
                      </div>
                      {rev.reason && (
                        <div className="mt-1.5 text-xs text-red-700">
                          <strong>เหตุผล:</strong> {rev.reason}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
          {((canViewEvidence && Boolean(taskId)) || demo) && <TaskEvidencePanel key={taskId || 'demo'} taskId={taskId || undefined} canEdit={canEditEvidence} editableSlots={editableSlots} requiredSlots={stageRequiredSlots} canView={canViewEvidence} previewOnly={demo} outcome={activeOutcome} onRequiredReady={setRequiredEvidenceReady} onRequiredCompleted={() => {
            const snap = latestCloseoutStateRef.current
            if (!snap.canEditTechnicianEvidence || snap.outcomeInput !== 'replaced' || snap.busy) return
            if (!snap.newSerialInput.trim()) {
              setActionError('ลงลายเซ็นและแนบรูปครบแล้ว — กรุณากรอก SN เครื่องใหม่ด้านบน แล้วกด “ส่งให้ Admin SYM ตรวจรับ”')
              newSerialInputRef.current?.focus()
              newSerialInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              return
            }
            void submitCloseoutData(true)
          }} onBusyChange={setEvidenceBusy} onTaskStarted={nextVersion => {
            setEvidenceStartedTask(current => current?.id === taskId && current.version > nextVersion ? current : { id: taskId, version: nextVersion })
            onUpdated('evidence_started')
          }} />}
          {!demo && !canViewEvidence && <section className="detail-section"><h3>หลักฐานประกอบ</h3><p className="detail-empty-result">หลักฐานใบงานดูได้โดย Admin และช่างที่มีสิทธิ์เข้าระบบ</p></section>}
          {canEditTechnicianEvidence && isReplacement && (requiredEvidenceReady || (Boolean(actionError) && !showBlockForm && !showExceptionForm)) && (
            <section className="detail-section border-emerald-200 bg-emerald-50/70">
              {actionError && !showBlockForm && !showExceptionForm && (
                <p className="task-action-error mb-3" role="alert">{actionError}</p>
              )}
              {requiredEvidenceReady && (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-emerald-900">
                    <ShieldCheck size={16} className="shrink-0 text-emerald-700" />
                    <span>
                      {newSerialInput.trim()
                        ? 'หลักฐานและลายเซ็นครบแล้ว พร้อมส่งให้ Admin SYM ตรวจรับต่อ'
                        : 'ลงลายเซ็นและแนบรูปครบแล้ว กรุณากรอก SN เครื่องใหม่ด้านบนเพื่อส่งงาน'}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || evidenceBusy}
                    onClick={() => void submitCloseoutData(false)}
                  >
                    {busy ? 'กำลังส่งงาน…' : evidenceBusy ? 'กำลังบันทึกหลักฐาน…' : 'ส่งให้ Admin SYM ตรวจรับ'}
                  </Button>
                </div>
              )}
            </section>
          )}
          {isPendingReview && !canResolvePending && <div className="detail-readonly-note"><ShieldCheck size={16} className="shrink-0" /><span>บัญชีที่ปฏิบัติงานหรือส่งผลหน้างานไม่สามารถตรวจรับงานเดียวกันได้ โปรดให้ Admin อีกบัญชีหนึ่งลงนามตรวจรับ</span></div>}
          {canResolvePending && outcome === 'different_device_found' && <section className="detail-section task-action-panel"><label className="task-exception-register"><input type="checkbox" checked={registerObservedSerial} onChange={event => setRegisterObservedSerial(event.target.checked)} />เพิ่ม SN ที่ตรวจแล้วว่าเป็นเครื่องใหม่ในทะเบียนสาขานี้</label><p>ตรวจ SN สาขาและทะเบียนทุกสาขาก่อนเลือก ระบบจะเพิ่มเฉพาะ SN ที่ยังไม่อยู่ในทะเบียน หากต้องเปลี่ยนเครื่องต่อ ให้เปิดใบงานใหม่ด้วย SN ที่เพิ่มแล้ว การพบ SN ซ้ำต่างสาขาจะถูกปฏิเสธโดยไม่ย้ายข้อมูล</p></section>}
          {demo && <div className="detail-readonly-note"><ShieldCheck size={16} className="shrink-0" /><span>ใบงานตัวอย่างเป็นแบบอ่านอย่างเดียว ไม่บันทึกข้อมูลจริง</span></div>}
        </div>
        <aside className="work-order-side" aria-label="ขั้นตอน สาขา และการจัดการใบงาน">
          <section className="detail-section"><h3>ข้อมูลการเปิดใบงาน</h3><div className="detail-grid"><DetailField label="เปิดใบงานเมื่อ" value={formatDate(task.created_at)} /><DetailField label="จังหวัด" value={task.province} /><DetailField label="สถานะใบงาน" value={presentation.label} /><DetailField label="ผู้ปฏิบัติงาน" value={task.performed_by_name} /></div></section>
          {canAct && stage === 'in_progress' && (
            <section className="detail-section task-action-panel">
              <h3>แจ้งปัญหา / ไม่ได้เปลี่ยนเครื่อง</h3>
              <p>ใช้เฉพาะกรณีไม่สามารถเปลี่ยนเครื่องได้ตามปกติ เช่น รอสาขาพร้อม หรือไม่พบเครื่องตามใบงาน</p>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="secondary-button w-full justify-center"
                  disabled={busy}
                  onClick={() => {
                    setShowBlockForm(value => !value)
                    setShowExceptionForm(false)
                    setOutcomeInput('replaced')
                    setActionError('')
                  }}
                >
                  {showBlockForm ? 'ซ่อนฟอร์มพักงาน Pending' : 'พักรายการนี้เป็น Pending'}
                </button>
                <button
                  type="button"
                  className="secondary-button w-full justify-center"
                  disabled={busy}
                  onClick={() => {
                    const next = !showExceptionForm
                    setShowExceptionForm(next)
                    setShowBlockForm(false)
                    setOutcomeInput(next ? 'no_damage_found' : 'replaced')
                    setActionError('')
                  }}
                >
                  {showExceptionForm ? 'กลับเป็นโหมดเปลี่ยนเครื่องปกติ' : 'ไม่ได้เปลี่ยนเครื่อง (แจ้งเหตุหน้างาน)'}
                </button>
              </div>
              {showBlockForm && (
                <form className="task-action-form mt-3" onSubmit={submitBlock}>
                  <label>เหตุผลที่ทำงานต่อไม่ได้<textarea value={blockReason} onChange={event => setBlockReason(event.target.value)} maxLength={500} required rows={3} /></label>
                  {actionError && <p className="task-action-error" role="alert">{actionError}</p>}
                  <button type="submit" className="secondary-button" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึก Pending'}</button>
                </form>
              )}
              {showExceptionForm && (
                <form className="task-action-form mt-3" onSubmit={submitCloseout}>
                  <label>
                    สาเหตุที่ไม่ได้เปลี่ยนเครื่อง
                    <select value={outcomeInput} onChange={event => { setOutcomeInput(event.target.value); setActionError('') }}>
                      <option value="no_damage_found">ไม่พบเครื่องชำรุด</option>
                      <option value="different_device_found">ไม่พบ SN ตามใบงาน แต่พบเครื่องอื่น</option>
                      <option value="target_device_not_found">ไม่พบ SN ตามใบงานและไม่พบเครื่องอื่น</option>
                    </select>
                  </label>
                  {outcomeInput === 'different_device_found' && (
                    <label>Serial ของอุปกรณ์ที่พบ<input value={observedSerialInput} onChange={event => setObservedSerialInput(event.target.value)} maxLength={100} required autoComplete="off" /></label>
                  )}
                  <label>เหตุผล/รายละเอียด<textarea value={exceptionReasonInput} onChange={event => setExceptionReasonInput(event.target.value)} maxLength={1000} required rows={3} /></label>
                  {actionError && <p className="task-action-error" role="alert">{actionError}</p>}
                  <button type="submit" className="primary-button task-action-submit" disabled={busy || evidenceBusy}>
                    {busy ? 'กำลังบันทึก…' : evidenceBusy ? 'กำลังบันทึกหลักฐาน…' : 'บันทึกผลเป็น Pending'}
                  </button>
                </form>
              )}
            </section>
          )}
          {canAct && stage === 'blocked' && <section className="detail-section task-action-panel"><h3>ดำเนินงานต่อ</h3><p>แก้สาเหตุที่พักงานแล้วจึงกลับมาทำรายการนี้ต่อ</p><button type="button" className="primary-button" disabled={busy} onClick={() => void submitAction('resume')}>{busy ? 'กำลังบันทึก…' : 'ดำเนินงานต่อ'}</button>{actionError && <p className="task-action-error" role="alert">{actionError}</p>}</section>}
          {canResolvePending && <section className="detail-section task-action-panel"><h3>{outcome === 'replaced' ? 'ตรวจรับและส่งมอบงาน' : 'พิจารณารายการ Pending'}</h3><p>ตรวจรูปและข้อมูลที่ช่างบันทึก แล้วลงลายเซ็นตรวจรับด้วยบัญชี Admin อีกบัญชีหนึ่ง สำหรับเครื่องอื่น ระบบจะเพิ่ม SN ได้เมื่อยืนยันแล้วว่าไม่ซ้ำกับทะเบียนทุกสาขา หากต้องกลับไปทำงานหน้างาน ให้ยกเลิกรายการนี้พร้อมเหตุผลแล้วเปิดใบงานใหม่</p>{actionError && <p className="task-action-error" role="alert">{actionError}</p>}<button type="button" className="primary-button task-action-submit" disabled={busy || evidenceBusy || !requiredEvidenceReady} onClick={() => void resolvePending()}>{busy ? 'กำลังบันทึก…' : evidenceBusy ? 'กำลังบันทึกหลักฐาน…' : outcome === 'replaced' ? 'ลงนามรับผ่านและส่งมอบงาน' : 'บันทึกผลตรวจ Pending'}</button></section>}
          {canManage && !['completed', 'cancelled'].includes(status) && <section className="detail-section task-action-panel"><h3>การจัดการรายการ Scanner</h3>{showCancelForm ? <form className="task-action-form" onSubmit={event => void submitCancel(event)}><label>เหตุผลที่ยกเลิก<textarea value={cancelReason} onChange={event => setCancelReason(event.target.value)} maxLength={500} rows={3} required /></label>{actionError && <p className="task-action-error" role="alert">{actionError}</p>}<div className="task-action-buttons"><button type="button" className="secondary-button" disabled={busy} onClick={() => { setShowCancelForm(false); setCancelReason(''); setActionError('') }}>กลับ</button><button type="submit" className="primary-button" disabled={busy || !cancelReason.trim()}>{busy ? 'กำลังบันทึก…' : 'ยืนยันยกเลิกรายการนี้'}</button></div></form> : <><p>Admin ยกเลิกรายการเครื่องนี้แยกจากเครื่องอื่นในใบงานได้ โดยระบุเหตุผลและระบบจะเก็บประวัติไว้</p><button type="button" className="secondary-button" disabled={busy} onClick={() => { setShowCancelForm(true); setActionError('') }}>ยกเลิกรายการเครื่องนี้</button>{actionError && <p className="task-action-error" role="alert">{actionError}</p>}</>}</section>}
          {['delivered', 'exception_resolved', 'legacy_completed', 'cancelled'].includes(stage) && (
            <div className="flex flex-col gap-2">
              <div className="detail-readonly-note"><ShieldCheck size={16} className="shrink-0" /><span>{stage === 'delivered' ? 'รายการนี้ Completed แล้ว และทะเบียนอัปเดตตามผลเปลี่ยนเครื่อง' : stage === 'exception_resolved' ? 'Admin พิจารณา Pending แล้ว รายการนี้ปิดโดยคง SN เดิมไว้' : 'รายการนี้ปิดแล้วและแก้ไขไม่ได้'}</span></div>
              {!demo && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => onOpenHandover?.(task)}
                  title="ดูและพิมพ์เอกสารตรวจรับส่งมอบงาน (PDF)"
                >
                  <Printer size={15} /> พิมพ์ใบตรวจรับส่งมอบงาน (PDF)
                </Button>
              )}
            </div>
          )}
          {!demo && !['field_technician', 'admin'].includes(String(role)) && <div className="detail-readonly-note"><ShieldCheck size={16} className="shrink-0" /><span>บัญชีปัจจุบันดูข้อมูลได้อย่างเดียว</span></div>}
        </aside>
      </div>
      </div>
      <BarcodeScannerModal
        isOpen={showNewSnScanner}
        title="สแกน Serial เครื่องใหม่"
        subtitle="จัดบาร์โค้ดบนกล่องหรือเครื่องสแกนเนอร์ให้อยู่ในกรอบ"
        onScan={value => {
          setNewSerialInput(value)
          setActionError('')
          setShowNewSnScanner(false)
        }}
        onClose={() => setShowNewSnScanner(false)}
      />
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
      const importedCount = typeof res.imported_count === 'number' ? res.imported_count : rows.length
      setResult({
        inserted: importedCount,
        updated: 0,
        unmodified: 0,
        status: 'committed'
      } as any)
      setPreview(null)
      setRows([])
      setCommitUncertain(false)
      if (res.warnings_count > 0) {
        setError(`⚠️ นำเข้าสำเร็จ ${importedCount} เครื่อง แต่มี ${res.warnings_count} รายการที่มี "หมายเหตุการแยกที่อยู่" (ระบบติดป้ายเตือนในหน้าทะเบียนแล้ว)`)
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
          const time = formatDate(entry.committed_at || entry.created_at) || '—'
          return <article className="import-history-row" key={entry.id}><div><strong>{modeLabel}</strong><small>{time}</small></div><div><span className={'history-status history-' + entry.status}>{statusLabel}</span><small>{entry.row_count.toLocaleString('th-TH')} แถว · {entry.issue_count.toLocaleString('th-TH')} ปัญหา</small></div><div className="import-history-result">{counts ? `เพิ่ม ${Number(counts.inserted) || 0} · อัปเดต ${Number(counts.updated) || 0} เครื่อง` : 'ยังไม่มีผลบันทึก'}</div></article>
        })}</div> : <EmptyState compact title="ยังไม่มีประวัติการนำเข้า" detail="ชุดข้อมูลที่ตรวจสอบแล้วจะแสดงที่นี่" />}
      </section>
    </section>
    <aside className="panel import-side"><div className="panel-heading"><div><h2>ขั้นตอนนำเข้า</h2><p>บันทึกเป็นชุดเพื่อทวนสอบย้อนหลัง</p></div></div><div className="step-list"><div className="import-step active"><span>1</span><div><strong>เลือกไฟล์</strong><small>อ่านเฉพาะชีต Detail1</small></div></div><div className="step-line" /><div className="import-step"><span>2</span><div><strong>ตรวจสอบข้อมูล</strong><small>ตรวจบนฐานข้อมูลก่อนบันทึก</small></div></div><div className="step-line" /><div className="import-step"><span>3</span><div><strong>บันทึกทั้งชุด</strong><small>ฐานข้อมูลยกเลิกทั้งหมดเมื่อผิดพลาด</small></div></div></div><div className="warning-box"><ShieldCheck size={17} /><span>ระบบบันทึกทะเบียนสาขาและเครื่องสแกน พร้อมจัดเก็บหมายเหตุการแยกที่อยู่และเบอร์ติดต่อลง Cloudflare D1</span></div></aside>
  </div>
}

function People({ currentEmail, role }: { currentEmail?: string; role?: string }) {
  const [users, setUsers] = useState<Array<{ id: string; email: string; role: string; full_name: string | null; is_active: number; created_at: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [togglingUserId, setTogglingUserId] = useState('')
  const [toggleError, setToggleError] = useState('')
  const [formError, setFormError] = useState('')
  const [formSuccess, setFormSuccess] = useState('')
  const [reload, setReload] = useState(0)

  // Form state
  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState('field_technician')

  const isAdmin = role === 'admin'

  useEffect(() => {
    let active = true
    if (!isAdmin) {
      setUsers([])
      setError('')
      setLoading(false)
      return () => { active = false }
    }
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const res = await d1Api.getAllowlistUsers()
        if (!active) return
        setUsers(res.users || [])
      } catch (err: any) {
        if (!active) return
        setError(err.message || 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [isAdmin, reload])

  const handleAddUser = async (e: FormEvent) => {
    e.preventDefault()
    setFormError('')
    setFormSuccess('')
    if (!newEmail.trim()) {
      setFormError('กรุณากรอกอีเมล')
      return
    }
    setSubmitting(true)
    try {
      const res = await d1Api.addAllowlistUser({
        email: newEmail.trim(),
        full_name: newName.trim() || undefined,
        role: newRole,
      })
      setFormSuccess(res.message || 'เพิ่มผู้ใช้งานสำเร็จ')
      setNewEmail('')
      setNewName('')
      setReload(r => r + 1)
    } catch (err: any) {
      setFormError(err.message || 'เพิ่มผู้ใช้งานไม่สำเร็จ')
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggleActive = async (user: { id: string; email: string; is_active: number }) => {
    if (!isAdmin || togglingUserId) return
    setToggleError('')
    setTogglingUserId(user.id)
    try {
      await d1Api.toggleAllowlistUser(user.id)
      setReload(r => r + 1)
    } catch (err: any) {
      setToggleError(err?.message || 'ปรับเปลี่ยนสถานะไม่สำเร็จ')
    } finally {
      setTogglingUserId('')
    }
  }

  const roleLabels: Record<string, { label: string; tone: string }> = {
    admin: { label: 'Admin Office', tone: 'ready' },
    field_technician: { label: 'ช่าง Onsite', tone: 'done' },
    customer_reviewer: { label: 'Gable Reviewer', tone: 'progress' },
    viewer: { label: 'Viewer', tone: 'neutral' },
  }

  return (
    <div className="people-layout">
      {/* ส่วนจัดการ Allowlist ผู้ใช้งาน */}
      <section className="panel allowlist-panel">
        <div className="panel-heading">
          <div>
            <h2>รายชื่อผู้มีสิทธิ์ใช้งานระบบ (Google Sign-In Allowlist)</h2>
            <p>ควบคุมการเข้าถึงระบบผ่าน Google OAuth 2.0 จัดเก็บบน Cloudflare D1 (0 บาท)</p>
          </div>
          <button type="button" className="text-button" disabled={!isAdmin || loading} onClick={() => setReload(r => r + 1)}>
            รีเฟรช
          </button>
        </div>

        {toggleError && <div className="form-error mb-3" role="alert">{toggleError}</div>}

        {!isAdmin ? (
          <EmptyState compact title="ต้องใช้สิทธิ์ Admin" detail="เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่สามารถดูและจัดการรายชื่อผู้มีสิทธิ์ใช้งานได้" />
        ) : loading ? (
          <EmptyState compact loading />
        ) : error ? (
          <EmptyState compact title="โหลดรายชื่อไม่สำเร็จ" detail={error} onRetry={() => setReload(r => r + 1)} />
        ) : (
          <div className="mb-6 overflow-x-auto">
            <table className="summary-table w-full text-[13px]">
              <thead>
                <tr>
                  <th className="text-left">อีเมล (Google Account)</th>
                  <th className="text-left">ชื่อ-นามสกุล</th>
                  <th className="text-left">บทบาท (Role)</th>
                  <th className="text-center">สถานะ</th>
                  {isAdmin && <th className="text-right">การจัดการ</th>}
                </tr>
              </thead>
              <tbody>
                {users.map(u => {
                  const rolePres = roleLabels[u.role] || { label: u.role, tone: 'neutral' }
                  const isCurrent = u.email.trim().toLowerCase() === String(currentEmail || '').trim().toLowerCase()
                  const isToggling = togglingUserId === u.id
                  return (
                    <tr key={u.id} className={u.is_active ? 'opacity-100' : 'opacity-60'}>
                      <td>
                        <strong>{u.email}</strong>
                        {isCurrent && <span className="ml-1.5 text-[11px] font-semibold text-emerald-600">(คุณ)</span>}
                      </td>
                      <td>{u.full_name || '—'}</td>
                      <td>
                        <StatusPill label={rolePres.label} tone={rolePres.tone} />
                      </td>
                      <td className="text-center">
                        <Badge variant={u.is_active ? 'done' : 'neutral'}>
                          {u.is_active ? 'เปิดใช้งาน' : 'ระงับชั่วคราว'}
                        </Badge>
                      </td>
                      {isAdmin && (
                        <td className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className={cn(
                              'text-xs font-semibold',
                              isCurrent ? 'text-slate-400' : u.is_active ? 'text-red-700 hover:bg-red-50 hover:text-red-800' : 'text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800',
                            )}
                            disabled={isCurrent || Boolean(togglingUserId)}
                            onClick={() => handleToggleActive(u)}
                          >
                            {isToggling ? 'กำลังบันทึก…' : u.is_active ? 'ระงับสิทธิ์' : 'เปิดสิทธิ์'}
                          </Button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ฟอร์มเพิ่มผู้ใช้งาน (สำหรับ Admin) */}
        {isAdmin && (
          <Card className="mt-4 bg-slate-50 p-4 shadow-none">
            <h3 className="m-0 mb-3 text-sm font-bold text-slate-900">เพิ่มผู้ใช้งานใหม่เข้า Allowlist</h3>
            {formError && <div className="form-error mb-3" role="alert">{formError}</div>}
            {formSuccess && <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] font-medium text-emerald-700">{formSuccess}</div>}
            <form onSubmit={handleAddUser} className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] items-end gap-3">
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
                อีเมล Google (@sym.co.th / @gmail.com)
                <Input
                  type="email"
                  required
                  placeholder="technician@sym.co.th"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
                ชื่อ-นามสกุล (ไม่บังคับ)
                <Input
                  type="text"
                  placeholder="สมชาย ใจดี"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-700">
                บทบาท (Role)
                <select
                  value={newRole}
                  onChange={e => setNewRole(e.target.value)}
                  className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-[13px] text-slate-900 focus:border-emerald-600 focus:outline-none"
                >
                  <option value="field_technician">ช่าง Onsite (Field Technician)</option>
                  <option value="admin">Admin ประจำ Office</option>
                  <option value="customer_reviewer">Gable Customer Reviewer</option>
                  <option value="viewer">Viewer (ดูได้อย่างเดียว)</option>
                </select>
              </label>
              <Button
                type="submit"
                disabled={submitting}
                className="h-10"
              >
                {submitting ? 'กำลังบันทึก…' : 'เพิ่มผู้ใช้งาน'}
              </Button>
            </form>
          </Card>
        )}
      </section>
    </div>
  )
}

function EmptyState({ title, detail, loading, compact, onRetry }: { title?: string; detail?: string; loading?: boolean; compact?: boolean; onRetry?: () => void }) {
  return <div className={'empty-state ' + (compact ? 'compact' : '')}>{loading ? <><div className="spinner" /><strong>กำลังโหลดข้อมูล</strong></> : <><div className="empty-icon"><ClipboardList size={20} /></div><strong>{title || 'ไม่พบรายการ'}</strong><span>{detail || 'ลองเปลี่ยนคำค้นหา หรือกลับมาตรวจสอบอีกครั้ง'}</span>{onRetry && <button className="text-button" onClick={onRetry}>ลองอีกครั้ง</button>}</>}</div>
}

export default App
