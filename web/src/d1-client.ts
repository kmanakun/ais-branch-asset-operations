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
  details?: Record<string, unknown>

  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
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
    let errorDetails: Record<string, unknown> | undefined
    try {
      const errorJson = await response.json()
      if (errorJson && typeof errorJson === 'object') {
        errorDetails = errorJson as Record<string, unknown>
      }
      if (errorJson.error || errorJson.message) {
        errorMessage = errorJson.error || errorJson.message
      }
      if (typeof errorJson.code === 'string') {
        errorCode = errorJson.code
      }
    } catch {
      // ignore
    }
    throw new ApiError(errorMessage, response.status, errorCode, errorDetails)
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

  // 23. Stock Scanner — KPI & ภาพรวมคลังสต็อก (Model B + Hybrid + Reverse Logistics)
  getStockSummary: () => request<StockSummaryResponse>('/api/stock/summary'),

  // 24. Stock Scanner — รายการเครื่องในคลัง/พื้นที่/ซากเครื่องเดิม
  getStockItems: (params: {
    unit_type?: 'new_unit' | 'old_removed'
    status?: string
    source_mode?: 'registered_stock' | 'hybrid_unregistered' | 'onsite_removal'
    dispatch_area?: string
    lot_no?: string
    branch_id?: string
    search?: string
    include_void?: boolean
    limit?: number
    offset?: number
  } = {}) => {
    const q = new URLSearchParams()
    if (params.unit_type) q.set('unit_type', params.unit_type)
    if (params.status) q.set('status', params.status)
    if (params.source_mode) q.set('source_mode', params.source_mode)
    if (params.dispatch_area) q.set('dispatch_area', params.dispatch_area)
    if (params.lot_no) q.set('lot_no', params.lot_no)
    if (params.branch_id) q.set('branch_id', params.branch_id)
    if (params.search) q.set('search', params.search)
    if (params.include_void) q.set('include_void', '1')
    if (params.limit) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return request<{
      total: number
      limit: number
      offset: number
      rows: StockItemRecord[]
    }>(`/api/stock/items?${q.toString()}`)
  },

  // 25. Stock Scanner — ตรวจสอบ SN แบบ Real-time + ประวัติทั้งสาย
  lookupStockSerial: (serial: string, taskId?: string) => {
    const q = new URLSearchParams()
    q.set('serial', serial)
    if (taskId) q.set('task_id', taskId)
    return request<StockLookupResponse>(`/api/stock/lookup?${q.toString()}`)
  },

  // 26. Stock Scanner — Preview ก่อนนำเข้าไฟล์ Supplier Excel
  previewStockImport: (
    rows: StockImportInputPayload[],
    defaults?: StockImportDefaultsPayload,
  ) => request<StockImportPreviewResponse>('/api/stock/import/preview', {
    method: 'POST',
    body: JSON.stringify({ rows, defaults: defaults || {} }),
  }),

  // 27. Stock Scanner — Commit นำเข้าสต็อกเครื่องใหม่เข้าคลัง (RCV / auto DSP)
  commitStockImport: (payload: {
    source_name?: string
    rows: StockImportInputPayload[]
    defaults?: StockImportDefaultsPayload
    skip_invalid?: boolean
  }) => request<StockImportCommitResponse>('/api/stock/import/commit', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),

  // 28. Stock Scanner — เบิกกระจายเข้าพื้นที่/ทีม (Model B)
  dispatchStock: (payload: { serial_numbers: string[]; dispatch_area: string; note?: string }) =>
    request<StockBatchActionResponse & { dispatch_area: string }>('/api/stock/dispatch', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // 29. Stock Scanner — ดึงเครื่องที่ยังไม่ได้ใช้กลับคลังกลาง
  recallStock: (payload: { serial_numbers: string[]; note?: string }) =>
    request<StockBatchActionResponse>('/api/stock/recall', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // 30. Stock Scanner — แจ้งเครื่องใหม่เสีย/ชำรุดรอเคลม (DOA)
  markStockDoa: (payload: { serial_numbers: string[]; note: string }) =>
    request<StockBatchActionResponse>('/api/stock/doa', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // 31. Stock Scanner — Reverse Logistics ขาที่ 1: รับซากเครื่องเดิมเข้าคลัง (RET)
  receiveOldReturns: (payload: { serial_numbers: string[]; note?: string }) =>
    request<StockBatchActionResponse>('/api/stock/old-returns/receive', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // 32. Stock Scanner — Reverse Logistics ขาที่ 2: ส่งมอบซากเครื่องเดิมคืน AIS/G-Able (HOV)
  handoverOldReturns: (payload: { serial_numbers: string[]; recipient_name: string; note?: string }) =>
    request<StockBatchActionResponse & { recipient_name: string }>('/api/stock/old-returns/handover', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // 33. Stock Scanner — รายการเอกสารสต็อกทั้งหมด
  getStockDocuments: (params: { doc_type?: string; search?: string; limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.doc_type) q.set('doc_type', params.doc_type)
    if (params.search) q.set('search', params.search)
    if (params.limit) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return request<{
      total: number
      limit: number
      offset: number
      rows: StockDocumentRecord[]
    }>(`/api/stock/documents?${q.toString()}`)
  },

  // 34. Stock Scanner — รายละเอียดเอกสารและประวัติรายการเครื่องในเอกสารนั้น
  getStockDocumentDetail: (docId: string) => request<{
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
  }>(`/api/stock/documents/${encodeURIComponent(docId)}`),
}

export interface StockSummaryResponse {
  new_units: {
    in_warehouse: number
    dispatched: number
    allocated_to_task: number
    installed: number
    doa_defective: number
    void_hybrid: number
    available_total: number
    total_active: number
    hybrid_unregistered: number
  }
  old_removed: {
    removed_onsite: number
    returned_to_warehouse: number
    handed_over_to_customer: number
    cancelled_restored: number
    total_active: number
  }
  by_model: Array<{
    brand: string
    model_name: string
    in_warehouse: number
    dispatched: number
    allocated_to_task: number
    installed: number
    doa_defective: number
    total: number
  }>
  by_dispatch_area: Array<{
    dispatch_area: string
    dispatched_available: number
    allocated_to_task: number
    installed: number
  }>
  documents_by_type: Record<string, number>
}

export interface StockItemRecord {
  id: string
  serial_number: string
  unit_type: 'new_unit' | 'old_removed'
  status: string
  pre_task_status: string | null
  source_mode: 'registered_stock' | 'hybrid_unregistered' | 'onsite_removal'
  brand: string | null
  model_name: string | null
  lot_no: string | null
  receive_doc_id: string | null
  receive_doc_code: string | null
  dispatch_doc_id: string | null
  dispatch_doc_code: string | null
  dispatch_area: string | null
  return_doc_id: string | null
  return_doc_code: string | null
  handover_doc_id: string | null
  handover_doc_code: string | null
  linked_task_id: string | null
  linked_task_status?: string | null
  linked_branch_id: string | null
  branch_code?: string | null
  branch_name?: string | null
  branch_province?: string | null
  linked_old_asset_id: string | null
  old_asset_sn?: string | null
  received_at: string | null
  dispatched_at: string | null
  allocated_at: string | null
  installed_at: string | null
  returned_at: string | null
  handed_over_at: string | null
  note: string | null
  created_by: string
  updated_by: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface StockMovementRecord {
  id: string
  stock_item_id: string
  doc_id: string | null
  doc_code?: string | null
  task_id: string | null
  branch_id: string | null
  branch_code?: string | null
  branch_name?: string | null
  action: string
  from_status: string | null
  to_status: string
  actor_email: string
  note: string | null
  created_at: string
}

export interface StockLookupResponse {
  found: boolean
  serial_number: string
  availability: {
    available_for_closeout: boolean
    code: string
    message: string
  }
  item: StockItemRecord | null
  movements: StockMovementRecord[]
}

export interface StockImportInputPayload {
  source_row?: number
  serial_number?: string | null
  brand?: string | null
  model_name?: string | null
  lot_no?: string | null
  dispatch_area?: string | null
  received_date?: string | null
  note?: string | null
}

export interface StockImportDefaultsPayload {
  brand?: string | null
  model_name?: string | null
  lot_no?: string | null
  dispatch_area?: string | null
  dispatch_mode?: 'in_warehouse' | 'dispatched' | 'auto_by_column'
  received_date?: string | null
  note?: string | null
}

export interface StockValidatedImportRow {
  source_row: number
  serial_number: string
  action: 'create_new' | 'reconcile_hybrid' | 'reactivate' | 'error'
  valid: boolean
  target_status: 'in_warehouse' | 'dispatched' | null
  existing_item_id: string | null
  existing_status: string | null
  existing_task_id?: string | null
  existing_branch_id?: string | null
  brand: string | null
  model_name: string | null
  lot_no: string | null
  dispatch_area: string | null
  received_date: string | null
  note: string | null
  reason: string | null
}

export interface StockImportPreviewResponse {
  summary: {
    total: number
    valid: number
    create_new: number
    reconcile_hybrid: number
    reactivate: number
    errors: number
  }
  items: StockValidatedImportRow[]
}

export interface StockImportCommitResponse {
  success: boolean
  doc_id: string
  doc_code: string
  dispatch_doc_code: string | null
  committed_count: number
  summary: StockImportPreviewResponse['summary']
  message: string
}

export interface StockBatchActionResponse {
  success: boolean
  doc_id: string
  doc_code: string
  count: number
  message: string
}

export interface StockDocumentRecord {
  id: string
  doc_code: string
  doc_type: 'receive' | 'dispatch' | 'return_in' | 'handover_out' | 'doa_claim' | 'adjustment'
  lot_no: string | null
  destination_area: string | null
  recipient_name: string | null
  note: string | null
  item_count: number
  created_by: string
  created_at: string
}
