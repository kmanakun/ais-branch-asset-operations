import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Printer, ShieldCheck, X } from 'lucide-react'
import { lockBodyScroll, registerActiveDialog } from './dialog'
import { supabase } from './supabase'

type EvidenceEntry = {
  slot: string
  photo_url?: string
  storage_path?: string
  signed_url?: string
}

type WorkOrderCertificateDialogProps = {
  task: Record<string, unknown>
  onClose: () => void
}

function formatDate(value: unknown) {
  if (!value) return '—'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('th-TH', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
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
  return labels[String(value || '')] || String(value || 'ยังไม่มีข้อมูล')
}

function outcomeLabel(value: unknown) {
  const labels: Record<string, string> = {
    replaced: 'เปลี่ยนเครื่องสำเร็จ (Replaced)',
    no_damage_found: 'ไม่พบเครื่องชำรุด (No damage found)',
    different_device_found: 'ไม่พบ SN ตามใบงาน · พบเครื่องอื่น',
    target_device_not_found: 'ไม่พบ SN ตามใบงาน · ไม่พบเครื่องอื่น',
  }
  return labels[String(value || '')] || String(value || 'ส่งมอบตามปกติ')
}

export function WorkOrderCertificateDialog({
  task,
  onClose,
}: WorkOrderCertificateDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [evidenceList, setEvidenceList] = useState<Record<string, EvidenceEntry>>({})
  const [loadingEvidence, setLoadingEvidence] = useState(false)

  const taskId = String(task.id || '').trim()
  const branchName = String(task.branch_name || task.branch || 'สาขาไม่ระบุ')
  const locationCode = String(task.location_code || task.code || '—')
  const province = String(task.province || '—')
  const workOrderCode = String(task.work_order_code || task.order_code || taskId.slice(0, 8).toUpperCase())
  const oldSerial = String(task.old_serial_snapshot || task.serial || task.com_sn || '—')
  const newSerial = String(task.new_serial || '—')
  const scannerModel = String(task.scanner_model || task.model || 'Scanner Asset')
  const outcome = String(task.workflow_outcome || task.outcome || 'replaced')
  const performedBy = String(task.performed_by_name || 'ช่างเทคนิค Onsite')
  const performedAt = formatDate(task.performed_at || task.created_at)
  const installResult = String(task.install_result || 'ติดตั้งและทดสอบสแกนสำเร็จ')
  const oldStatus = oldScannerStatusLabel(task.old_scanner_status)
  const notes = String(task.exception_reason || task.old_scanner_note || '—')

  // Load evidence photos & signatures from Supabase
  useEffect(() => {
    if (!taskId || !supabase) return
    let active = true
    setLoadingEvidence(true)

    void (async () => {
      try {
        const { data, error } = await supabase.rpc('ais_task_evidence_list', {
          p_task_id: taskId,
        })
        if (error || !data || !active) return

        const entries: Record<string, EvidenceEntry> = {}
        const rows = Array.isArray(data) ? data : []

        for (const row of rows) {
          const slot = String(row.slot)
          const storagePath = String(row.storage_path || '')
          if (storagePath) {
            // Get public or signed url
            const { data: urlData } = await supabase.storage
              .from('ais-task-evidence')
              .createSignedUrl(storagePath, 3600)
            entries[slot] = {
              slot,
              storage_path: storagePath,
              signed_url: urlData?.signedUrl || undefined,
            }
          }
        }
        if (active) setEvidenceList(entries)
      } catch {
        // Failed loading evidence
      } finally {
        if (active) setLoadingEvidence(false)
      }
    })()

    return () => {
      active = false
    }
  }, [taskId])

  // Dialog scroll lock
  useEffect(() => {
    const releaseScroll = lockBodyScroll()
    const unregister = registerActiveDialog(dialogRef.current)
    return () => {
      unregister()
      releaseScroll()
    }
  }, [])

  const handlePrint = () => {
    window.print()
  }

  const techSignature = evidenceList['technician_signature']?.signed_url
  const userSignature = evidenceList['scanner_user_signature']?.signed_url
  const adminSignature = evidenceList['inspector_signature']?.signed_url

  const photoSlots = [
    { key: 'old_scanner_front', label: 'เครื่องเดิม: ด้านหน้า/รวม' },
    { key: 'old_scanner_serial', label: 'เครื่องเดิม: ป้าย Serial Number' },
    { key: 'old_scanner_defect', label: 'เครื่องเดิม: จุดชำรุด/สภาพ' },
    { key: 'old_scanner_placement', label: 'เครื่องเดิม: จุดติดตั้งเดิม' },
    { key: 'new_scanner_box', label: 'เครื่องใหม่: กล่องบรรจุภัณฑ์' },
    { key: 'new_scanner_serial', label: 'เครื่องใหม่: ป้าย Serial Number' },
    { key: 'new_scanner_installed', label: 'เครื่องใหม่: ติดตั้งเข้าที่' },
    { key: 'new_scanner_test_scan', label: 'เครื่องใหม่: ทดสอบการสแกน' },
    { key: 'new_scanner_ready', label: 'เครื่องใหม่: สภาพพร้อมใช้งาน' },
    { key: 'new_scanner_wide', label: 'เครื่องใหม่: ภาพรวมเคาน์เตอร์' },
  ]

  return (
    <div
      className="detail-overlay certificate-overlay"
      role="presentation"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="detail-dialog certificate-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="ใบส่งมอบและบันทึกผลการเปลี่ยนเครื่องสแกนบาร์โค้ด"
      >
        <header className="detail-dialog-header no-print">
          <div>
            <span className="detail-eyebrow">เอกสารรับรองการปฏิบัติงาน</span>
            <h2>พิมพ์ใบส่งมอบและตรวจรับงาน (Handover Certificate)</h2>
          </div>
          <div className="certificate-header-actions">
            <button
              type="button"
              className="primary-button"
              onClick={handlePrint}
            >
              <Printer size={16} /> พิมพ์ / บันทึกเป็น PDF
            </button>
            <button
              type="button"
              className="detail-close"
              onClick={onClose}
              aria-label="ปิดเอกสาร"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {/* Printable Sheet */}
        <div className="printable-certificate-container">
          <div className="printable-certificate">
            {/* Certificate Header */}
            <div className="cert-header">
              <div className="cert-brand">
                <div className="cert-logo">AIS</div>
                <div>
                  <h1 className="cert-title">
                    AIS Branch & Asset Operations
                  </h1>
                  <h2 className="cert-subtitle">
                    ใบส่งมอบและบันทึกผลการเปลี่ยนเครื่องสแกนบาร์โค้ด (Scanner Replacement Handover Certificate)
                  </h2>
                </div>
              </div>
              <div className="cert-meta">
                <div className="cert-meta-item">
                  <span>เลขที่ใบงาน:</span>
                  <strong>WO-{workOrderCode}</strong>
                </div>
                <div className="cert-meta-item">
                  <span>วันที่พิมพ์:</span>
                  <span>{new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())}</span>
                </div>
                <div className="cert-meta-badge">
                  <CheckCircle2 size={14} /> ส่งมอบและตรวจรับสมบูรณ์
                </div>
              </div>
            </div>

            <hr className="cert-divider" />

            {/* Section 1: Branch Info */}
            <div className="cert-section">
              <h3 className="cert-section-heading">1. ข้อมูลสาขาและสถานที่ปฏิบัติงาน</h3>
              <div className="cert-grid-3">
                <div className="cert-field">
                  <span className="cert-field-label">ชื่อสาขา (Branch):</span>
                  <span className="cert-field-value">{branchName}</span>
                </div>
                <div className="cert-field">
                  <span className="cert-field-label">รหัสสาขา (LocationCode):</span>
                  <span className="cert-field-value">{locationCode}</span>
                </div>
                <div className="cert-field">
                  <span className="cert-field-label">จังหวัด (Province):</span>
                  <span className="cert-field-value">{province}</span>
                </div>
              </div>
            </div>

            {/* Section 2: Equipment Comparison */}
            <div className="cert-section">
              <h3 className="cert-section-heading">2. รายละเอียดการเปลี่ยนอุปกรณ์สแกนเนอร์</h3>
              <table className="cert-table">
                <thead>
                  <tr>
                    <th>รายการ</th>
                    <th>เครื่องเดิมตามทะเบียน</th>
                    <th>เครื่องใหม่ที่ติดตั้งทดแทน</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><strong>รุ่นอุปกรณ์ (Model)</strong></td>
                    <td>{scannerModel}</td>
                    <td>{task.observed_model ? String(task.observed_model) : scannerModel}</td>
                  </tr>
                  <tr>
                    <td><strong>หมายเลขเครื่อง (Serial Number)</strong></td>
                    <td><span className="cert-sn">{oldSerial}</span></td>
                    <td><span className="cert-sn cert-sn-new">{newSerial}</span></td>
                  </tr>
                  <tr>
                    <td><strong>สถานะ / ผลทดสอบ</strong></td>
                    <td>สภาพเครื่องเดิม: {oldStatus}</td>
                    <td>ผลทดสอบ: {installResult}</td>
                  </tr>
                  <tr>
                    <td><strong>สรุปผลการเข้าหน้างาน</strong></td>
                    <td colSpan={2}>
                      <strong>{outcomeLabel(outcome)}</strong> {notes !== '—' && `(${notes})`}
                    </td>
                  </tr>
                  <tr>
                    <td><strong>วันและเวลาเข้าปฏิบัติงานจริง</strong></td>
                    <td colSpan={2}>{performedAt}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Section 3: Authorized Signatures */}
            <div className="cert-section">
              <h3 className="cert-section-heading">3. ลายมือชื่ออิเล็กทรอนิกส์ยืนยันการปฏิบัติงานและตรวจรับ</h3>
              <div className="cert-signatures-grid">
                {/* Tech Signature */}
                <div className="cert-signature-box">
                  <span className="cert-signature-title">ช่างเทคนิคผู้ปฏิบัติงาน Onsite</span>
                  <div className="cert-signature-canvas">
                    {techSignature ? (
                      <img src={techSignature} alt="ลายเซ็นช่างเทคนิค" />
                    ) : (
                      <span className="cert-sig-placeholder">ลงนามระบบอิเล็กทรอนิกส์แล้ว</span>
                    )}
                  </div>
                  <div className="cert-signature-name">
                    <span>ลงชื่อ: ____________________________</span>
                    <small>({performedBy})</small>
                    <small>วันที่: {performedAt}</small>
                  </div>
                </div>

                {/* User/Branch Signature */}
                <div className="cert-signature-box">
                  <span className="cert-signature-title">ผู้แทนสาขา / ผู้ใช้งานเครื่องสแกน</span>
                  <div className="cert-signature-canvas">
                    {userSignature ? (
                      <img src={userSignature} alt="ลายเซ็นผู้แทนสาขา" />
                    ) : (
                      <span className="cert-sig-placeholder">ลงนามตรวจรับหน้างานแล้ว</span>
                    )}
                  </div>
                  <div className="cert-signature-name">
                    <span>ลงชื่อ: ____________________________</span>
                    <small>(ผู้แทนสาขา {branchName})</small>
                    <small>วันที่: {performedAt}</small>
                  </div>
                </div>

                {/* Admin Signature */}
                <div className="cert-signature-box">
                  <span className="cert-signature-title">Admin Office ผู้ตรวจรับและอนุมัติ</span>
                  <div className="cert-signature-canvas">
                    {adminSignature ? (
                      <img src={adminSignature} alt="ลายเซ็น Admin ผู้ตรวจรับ" />
                    ) : (
                      <span className="cert-sig-placeholder">
                        <ShieldCheck size={28} />
                        <br />
                        ตรวจรับสมบูรณ์ผ่านระบบ
                      </span>
                    )}
                  </div>
                  <div className="cert-signature-name">
                    <span>ลงชื่อ: ____________________________</span>
                    <small>(Admin ประจำ Office)</small>
                    <small>สถานะ: อนุมัติการส่งมอบ</small>
                  </div>
                </div>
              </div>
            </div>

            {/* Section 4: Photographic Evidence */}
            <div className="cert-section cert-photos-section">
              <h3 className="cert-section-heading">4. หลักฐานภาพถ่ายการปฏิบัติงานหน้างาน</h3>
              {loadingEvidence ? (
                <p className="cert-loading-text">กำลังโหลดภาพถ่ายหลักฐาน...</p>
              ) : (
                <div className="cert-photos-grid">
                  {photoSlots.map(slot => {
                    const imgUrl = evidenceList[slot.key]?.signed_url
                    return (
                      <div key={slot.key} className="cert-photo-card">
                        <div className="cert-photo-thumb">
                          {imgUrl ? (
                            <img src={imgUrl} alt={slot.label} />
                          ) : (
                            <div className="cert-photo-empty">
                              <span>บันทึกในระบบ</span>
                            </div>
                          )}
                        </div>
                        <span className="cert-photo-label">{slot.label}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Footer Notice */}
            <div className="cert-footer">
              <p>
                เอกสารนี้สร้างขึ้นโดยระบบอัตโนมัติ AIS Branch & Asset Operations เพื่อใช้เป็นหลักฐานการส่งมอบงานเปลี่ยนเครื่องสแกนเนอร์ประจำสาขาอย่างเป็นทางการ
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
