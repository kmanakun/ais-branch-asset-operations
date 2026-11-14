// Client library for Cloudflare D1 Native Hono API
// Zero-Baht Architecture for AIS Scanner Replacement Project

const DEV_EMAIL_KEY = 'ais_dev_user_email'
let devAuthHeadersEnabled = false

export interface AuthConfigResponse {
  auth_provider: 'google_oauth'
  mode: 'google_oauth' | 'dev_fallback' | 'misconfigured'
  google_enabled: boolean
  dev_auth_enabled: boolean
}

export class ApiError extends Error {
  status: number
  code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function setDevAuthHeadersEnabled(enabled: boolean): void {
  devAuthHeadersEnabled = enabled
}

export function getDevEmail(): string {
  if (typeof window === 'undefined') return 'admin@sym.co.th'
  return localStorage.getItem(DEV_EMAIL_KEY) || 'admin@sym.co.th'
}

export function setDevEmail(email: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(DEV_EMAIL_KEY, email)
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {})
  headers.set('Content-Type', 'application/json')

  // แนบ Dev user email เฉพาะเมื่อ Backend ยังเปิดโหมด Dev Fallback เท่านั้น
  if (devAuthHeadersEnabled) {
    const devEmail = getDevEmail()
    if (devEmail) {
      headers.set('x-dev-user-email', devEmail)
    }
  }

  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers,
  })

  if (!response.ok) {
    let errorMessage = `HTTP Error ${response.status}`
    let errorCode: string | undefined
    try {
      const errorJson = await response.json()
      if (errorJson.error || errorJson.message) {
        errorMessage = errorJson.error || errorJson.message
      }
      if (typeof errorJson.code === 'string') {
        errorCode = errorJson.code
      }
    } catch {
      // ignore
    }
    throw new ApiError(errorMessage, response.status, errorCode)
  }

  const text = await response.text()
  return (text ? JSON.parse(text) : {}) as T
}

export const d1Api = {
  // 1. ตรวจสอบสถานะ API และโหมดการยืนยันตัวตน
  getHealth: () => request<{ status: string; database: string; stats: any }>('/api/health'),
  getAuthConfig: () => request<AuthConfigResponse>('/api/auth/config'),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  // 2. ผู้ใช้ปัจจุบัน
  getMe: () => request<{ email: string; role: string; full_name: string; auth_mode?: string }>('/api/auth/me'),

  // 3. Dashboard สรุปความคืบหน้า
  getDashboard: () => request<{
    summary: {
      total_scanners: number
      total_branches: number
      branches_complete: number
      branches_remaining: number
      open: number
      on_process: number
      awaiting_admin?: number
      awaiting_customer: number
      awaiting_review?: number
      delivered: number
    }
    provinces: Array<{
      province: string
      branch_count: number
      branches_complete: number
      branches_remaining: number
      scanner_count: number
      delivered_count: number
      on_process_count: number
      open_count: number
    }>
    weekly_activity: Array<{
      date: string
      opened: number
      completed: number
    }>
    role: string
  }>('/api/dashboard/summary'),

  // 4. รายการสาขา (ค้นหา, กรองจังหวัด, กรองหมายเหตุที่อยู่)
  getBranches: (params: { province?: string; search?: string; has_address_note?: boolean } = {}) => {
    const q = new URLSearchParams()
    if (params.province) q.set('province', params.province)
    if (params.search) q.set('search', params.search)
    if (params.has_address_note) q.set('has_address_note', 'true')
    return request<{
      branches: Array<{
        id: string
        location_code: string
        loc_bld: string
        address: string | null
        province: string
        district: string | null
        subdistrict: string | null
        postal_code: string | null
        phone: string | null
        install_type: string | null
        address_note: string | null
        scanner_count: number
        delivered_count: number
        awaiting_customer_count: number
      }>
      is_customer_reviewer: boolean
    }>(`/api/branches?${q.toString()}`)
  },

  // 5. รายละเอียดสาขา & รายการเครื่อง
  getBranchDetail: (branchId: string) => request<{
    branch: any
    scanners: Array<{
      scanner_id: string
      com_sn: string
      hw_name: string | null
      brand: string | null
      model_name: string | null
      com_id: string | null
      model_id: string | null
      com_years: string | null
      task_id: string | null
      task_status: string | null
      outcome: string | null
      observed_serial: string | null
      new_serial_number: string | null
      notes?: string | null
      created_at?: string | null
      started_at: string | null
      started_by?: string | null
      closeout_submitted_at: string | null
      closeout_submitted_by?: string | null
      admin_accepted_at: string | null
      admin_accepted_by?: string | null
      customer_accepted_at: string | null
      customer_accepted_by?: string | null
      customer_rejected_at: string | null
      customer_reject_reason: string | null
      work_order_code?: string | null
      version: number | null
    }>
  }>(`/api/branches/${branchId}`),

  // 5.1 รายการเครื่องสแกนเนอร์ (Assets Register)
  getScanners: (params: { province?: string; search?: string; status?: string; limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.province) q.set('province', params.province)
    if (params.search) q.set('search', params.search)
    if (params.status) q.set('status', params.status)
    if (params.limit) q.set('limit', String(params.limit))
    if (params.offset) q.set('offset', String(params.offset))
    return request<{
      rows: any[]
      total: number
      province_count?: number
      offset: number
      limit: number
    }>(`/api/scanners?${q.toString()}`)
  },

  // 5.2 รายการคิวรอตรวจรับ (Pending Reviews Queue)
  getPendingTasks: (search?: string) => {
    const q = new URLSearchParams()
    if (search) q.set('search', search)
    return request<{
      tasks: any[]
      role: string
    }>(`/api/tasks/pending?${q.toString()}`)
  },

  // 6. นำเข้าทะเบียน Master Register จาก Detail1
  importRegister: (rows: any[], sourceName = 'Detail1.xlsx') => request<{
    success: boolean
    message: string
    imported_count?: number
    inserted?: number
    updated?: number
    skipped_count?: number
    branches_count: number
    warnings_count: number
  }>('/api/register/import', {
    method: 'POST',
    body: JSON.stringify({ rows, source_name: sourceName }),
  }),

  // 7. ช่างกดเริ่มงาน Onsite กับเครื่องสแกนเนอร์
  startScannerWork: (scannerId: string) => request<{
    success: boolean
    task_id: string
    status: string
  }>('/api/tasks/start', {
    method: 'POST',
    body: JSON.stringify({ scanner_id: scannerId }),
  }),

  // 8. อัปโหลดรูปภาพหลักฐาน (Cloudflare R2)
  uploadEvidence: (taskId: string, evidenceType: string, fileBase64: string, mimeType = 'image/jpeg') => request<{
    success: boolean
    evidence_id: string
    storage_path: string
    byte_size: number
  }>(`/api/tasks/${taskId}/evidence`, {
    method: 'POST',
    body: JSON.stringify({ evidence_type: evidenceType, file_base64: fileBase64, mime_type: mimeType }),
  }),

  // 8.1 เรียกดูรายการหลักฐานภาพถ่าย
  getTaskEvidence: (taskId: string) => request<{
    evidence: Array<{
      id: string
      replacement_task_id: string
      evidence_type: string
      storage_path: string
      byte_size: number
      mime_type: string
      role_assigned: string
      created_at: string
    }>
  }>(`/api/tasks/${taskId}/evidence`),

  // 9. ส่งมอบผลงาน Closeout
  submitCloseout: (taskId: string, payload: {
    new_serial_number?: string
    observed_serial?: string
    notes?: string
    outcome: string
    version: number
  }) => request<{
    success: boolean
    status: string
  }>(`/api/tasks/${taskId}/closeout`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  // 10. ด่านที่ 1: SYM Admin ตรวจสอบผลงาน Onsite
  symVerify: (
    taskId: string,
    decision: 'pass' | 'reject',
    reason?: string,
    version = 1,
    options?: { register_observed_serial?: boolean },
  ) => request<{
    success: boolean
    status: string
    observed_registered?: boolean
  }>('/api/review/sym-verify', {
    method: 'POST',
    body: JSON.stringify({
      task_id: taskId,
      decision,
      reason,
      version,
      register_observed_serial: options?.register_observed_serial,
    }),
  }),

  // 11. ด่านที่ 2: Gable Customer ตรวจรับงานแบบ Batch รวมต่อสาขา (1 ลายเซ็นรับทั้ง Shop)
  customerBatchAccept: (branchId: string, taskIds: string[], signatureBase64: string) => request<{
    success: boolean
    status: string
    count: number
    message: string
  }>('/api/review/customer-batch-accept', {
    method: 'POST',
    body: JSON.stringify({ branch_id: branchId, task_ids: taskIds, signature_base64: signatureBase64 }),
  }),

  // 12. Gable ปฏิเสธงาน (ส่งตรงกลับช่าง)
  customerReject: (taskId: string, reason: string) => request<{
    success: boolean
    status: string
    message: string
  }>('/api/review/customer-reject', {
    method: 'POST',
    body: JSON.stringify({ task_id: taskId, reason }),
  }),

  // 13. Export Raw Data ภาพรวมทั้งหมด
  getExportRawData: () => request<{
    export_timestamp: string
    total_records: number
    data: any[]
  }>('/api/export/raw-data'),

  // 13.1 ประวัติการนำเข้าไฟล์ทะเบียน
  getImportHistory: () => request<{
    rows: any[]
  }>('/api/register/import/history'),

  // 14. รายงานเครื่องนอกทะเบียน
  reportDiscovery: (payload: { branch_id: string; serial_number: string; observed_model?: string; notes?: string }) => request<{
    success: boolean
    id: string
  }>('/api/discovery', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  // 15. คิวการตรวจรับเครื่องนอกทะเบียนสำหรับ Admin
  getDiscoveryQueue: (limit = 50, offset = 0) => request<{
    rows: any[]
    total: number
    offset: number
    limit: number
  }>(`/api/discovery/queue?limit=${limit}&offset=${offset}`),

  // 16. Admin ตรวจสอบและอนุมัติ/ปฏิเสธเครื่องนอกทะเบียน
  reviewDiscovery: (id: string, decision: 'approve' | 'reject', reviewNote?: string) => request<{
    success: boolean
    status: string
  }>(`/api/discovery/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision, review_note: reviewNote }),
  }),

  // 17. ดำเนินการเกี่ยวกับสถานะงาน (start / block / resume / cancel)
  taskAction: (taskId: string, action: 'start' | 'block' | 'resume' | 'cancel', reason?: string, version?: number) => request<{
    success: boolean
    status: string
  }>(`/api/tasks/${taskId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action, reason, version }),
  }),

  // 18. ลบภาพหลักฐานจาก Storage
  deleteEvidence: (taskId: string, slot: string) => request<{
    success: boolean
    message: string
  }>(`/api/tasks/${taskId}/evidence/${slot}`, {
    method: 'DELETE',
  }),

  // 19. ประวัติการตรวจรับของใบงาน (Task Review Audit Trail)
  getTaskReviews: (taskId: string) => request<{
    reviews: Array<{
      id: string
      task_id: string
      stage: 'sym' | 'customer'
      decision: 'pass' | 'reject'
      reason: string | null
      reviewer_email: string
      created_at: string
    }>
  }>(`/api/tasks/${taskId}/reviews`),

  // 20. รายชื่อผู้ใช้งานใน Allowlist (Admin Only)
  getAllowlistUsers: () => request<{
    users: Array<{
      id: string
      email: string
      role: string
      full_name: string | null
      is_active: number
      created_at: string
    }>
  }>('/api/allowlist'),

  // 21. เพิ่ม/อัปเดตผู้ใช้งานใน Allowlist
  addAllowlistUser: (payload: { email: string; role: string; full_name?: string }) => request<{
    success: boolean
    message: string
  }>('/api/allowlist', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  // 22. เปิด/ปิดการใช้งานผู้ใช้ใน Allowlist
  toggleAllowlistUser: (id: string) => request<{
    success: boolean
    is_active: number
    message: string
  }>(`/api/allowlist/${id}/toggle`, {
    method: 'POST',
  }),
}
