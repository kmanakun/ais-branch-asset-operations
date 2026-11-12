import { useEffect, useRef, useState } from 'react'
import { Camera, Check, RefreshCw, ScanBarcode, Upload, X } from 'lucide-react'
import { lockBodyScroll } from './dialog'

interface BarcodeScannerModalProps {
  isOpen: boolean
  title?: string
  subtitle?: string
  onScan: (scannedValue: string) => void
  onClose: () => void
}

export function BarcodeScannerModal({
  isOpen,
  title = 'สแกนบาร์โค้ด / Serial',
  subtitle = 'จัดบาร์โค้ดให้อยู่ในกรอบ หรือถ่ายภาพบาร์โค้ดเพื่ออ่านค่าอัตโนมัติ',
  onScan,
  onClose,
}: BarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [manualSerial, setManualSerial] = useState('')
  const [isSupported, setIsSupported] = useState<boolean | null>(null)
  const [detecting, setDetecting] = useState(false)
  const scanIntervalRef = useRef<number | null>(null)

  // ตรวจสอบการรองรับ BarcodeDetector
  useEffect(() => {
    if (!isOpen) return
    const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window
    setIsSupported(supported)
  }, [isOpen])

  // ล็อกการเลื่อนหน้าจอเมื่อเปิด Modal
  useEffect(() => {
    if (!isOpen) return
    const releaseBodyScroll = lockBodyScroll()
    return () => {
      releaseBodyScroll()
    }
  }, [isOpen])

  // จัดการเปิด/ปิดกล้อง
  useEffect(() => {
    if (!isOpen) {
      stopCamera()
      return
    }

    startCamera()

    return () => {
      stopCamera()
    }
  }, [isOpen])

  const stopCamera = () => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current)
      scanIntervalRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setCameraActive(false)
  }

  const startCamera = async () => {
    setCameraError('')
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('เบราว์เซอร์นี้ไม่รองรับการเข้าถึงกล้องโดยตรง โปรดใช้ปุ่มถ่ายภาพหรือกรอกรหัสด้วยตนเอง')
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })

      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        setCameraActive(true)
        startScanning()
      }
    } catch (err: any) {
      console.warn('Camera stream error:', err)
      setCameraError('ไม่สามารถเข้าถึงกล้องได้ โปรดอนุญาตสิทธิ์การใช้กล้อง หรือเลือกถ่ายภาพบาร์โค้ด')
      setCameraActive(false)
    }
  }

  const startScanning = () => {
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return

    try {
      const formats = ['code_128', 'code_39', 'qr_code', 'ean_13', 'ean_8', 'upc_a', 'data_matrix']
      const detector = new (window as any).BarcodeDetector({ formats })

      scanIntervalRef.current = window.setInterval(async () => {
        if (!videoRef.current || videoRef.current.readyState < 2) return

        try {
          const barcodes = await detector.detect(videoRef.current)
          if (barcodes && barcodes.length > 0) {
            const rawValue = barcodes[0].rawValue?.trim()
            if (rawValue) {
              handleDetected(rawValue)
            }
          }
        } catch {
          // ignore scan frame errors
        }
      }, 250)
    } catch (e) {
      console.warn('BarcodeDetector initialization error:', e)
    }
  }

  const handleDetected = (value: string) => {
    stopCamera()
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(100)
      } catch {
        // ignore vibrate permissions
      }
    }
    onScan(value)
    onClose()
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setDetecting(true)
    setCameraError('')

    try {
      if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
        const formats = ['code_128', 'code_39', 'qr_code', 'ean_13', 'ean_8', 'upc_a', 'data_matrix']
        const detector = new (window as any).BarcodeDetector({ formats })
        const imageBitmap = await createImageBitmap(file)
        const barcodes = await detector.detect(imageBitmap)

        if (barcodes && barcodes.length > 0) {
          const rawValue = barcodes[0].rawValue?.trim()
          if (rawValue) {
            handleDetected(rawValue)
            return
          }
        }
      }
      setCameraError('ตรวจไม่พบบาร์โค้ดในภาพ โปรดลองถ่ายภาพในระยะที่ใกล้ขึ้น หรือกรอก Serial ด้วยตนเอง')
    } catch (err: any) {
      setCameraError('เกิดข้อผิดพลาดในการอ่านภาพ: ' + (err?.message || 'ไม่สามารถวิเคราะห์บาร์โค้ดได้'))
    } finally {
      setDetecting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (manualSerial.trim()) {
      handleDetected(manualSerial.trim())
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="detail-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          stopCamera()
          onClose()
        }
      }}
      style={{ zIndex: 10500 }}
    >
      <section
        className="detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scanner-modal-title"
        style={{ maxWidth: '520px', width: '92%' }}
      >
        <header className="detail-dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ScanBarcode size={22} color="#73c23a" />
            <div>
              <h2 id="scanner-modal-title" style={{ margin: 0, fontSize: '17px' }}>
                {title}
              </h2>
              <small style={{ color: '#64748b' }}>{subtitle}</small>
            </div>
          </div>
          <button
            type="button"
            className="detail-close"
            aria-label="ปิดกล้องสแกน"
            onClick={() => {
              stopCamera()
              onClose()
            }}
          >
            <X size={18} />
          </button>
        </header>

        <div style={{ padding: '16px' }}>
          {/* กรอบวิดีโอแสดงมุมมองกล้อง */}
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: '260px',
              background: '#0f172a',
              borderRadius: '10px',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <video
              ref={videoRef}
              playsInline
              muted
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: cameraActive ? 'block' : 'none',
              }}
            />

            {/* Viewfinder Target Overlay */}
            {cameraActive && (
              <div
                style={{
                  position: 'absolute',
                  width: '75%',
                  height: '140px',
                  border: '2px dashed #73c23a',
                  borderRadius: '8px',
                  boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  pointerEvents: 'none',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: 0,
                    right: 0,
                    height: '2px',
                    background: '#73c23a',
                    boxShadow: '0 0 8px #73c23a',
                  }}
                />
              </div>
            )}

            {!cameraActive && (
              <div
                style={{
                  color: '#94a3b8',
                  textAlign: 'center',
                  padding: '20px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <Camera size={36} color="#64748b" />
                <span style={{ fontSize: '13px' }}>
                  {cameraError || 'กำลังเตรียมกล้องสแกน...'}
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={startCamera}
                  style={{ background: '#334155', color: '#fff', border: 'none' }}
                >
                  <RefreshCw size={14} /> ลองเปิดกล้องใหม่
                </button>
              </div>
            )}
          </div>

          {/* แถบคำแนะนำหรือแจ้งเตือนข้อผิดพลาด */}
          {cameraError && (
            <div
              style={{
                marginTop: '12px',
                padding: '8px 12px',
                borderRadius: '6px',
                background: '#fef2f2',
                color: '#b91c1c',
                fontSize: '13px',
              }}
            >
              {cameraError}
            </div>
          )}

          {isSupported === false && (
            <div
              style={{
                marginTop: '10px',
                padding: '8px 12px',
                borderRadius: '6px',
                background: '#fffbeb',
                color: '#b45309',
                fontSize: '12px',
              }}
            >
              ℹ️ เบราว์เซอร์นี้ไม่รองรับ Real-time Barcode API แนะนำให้กดปุ่ม <strong>"ถ่ายภาพบาร์โค้ด"</strong> ด้านล่าง หรือกรอก Serial ด้วยตนเอง
            </div>
          )}

          {/* ทางเลือก: ถ่ายภาพบาร์โค้ด หรือ อัปโหลดภาพ */}
          <div style={{ marginTop: '14px', display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="secondary-button"
              style={{ flex: 1, justifyContent: 'center' }}
              disabled={detecting}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={16} />
              {detecting ? 'กำลังอ่านภาพ...' : 'ถ่ายภาพ / เลือกรูปบาร์โค้ด'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
          </div>

          {/* ทางเลือกสำรอง: กรอก Serial ด้วยตนเอง */}
          <form
            onSubmit={handleManualSubmit}
            style={{
              marginTop: '14px',
              paddingTop: '12px',
              borderTop: '1px solid #e2e8f0',
              display: 'flex',
              gap: '8px',
            }}
          >
            <input
              type="text"
              placeholder="หรือพิมพ์ Serial Number ที่นี่..."
              value={manualSerial}
              onChange={(e) => setManualSerial(e.target.value)}
              style={{
                flex: 1,
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                fontSize: '14px',
              }}
            />
            <button
              type="submit"
              className="primary-button"
              disabled={!manualSerial.trim()}
              style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Check size={16} /> ใช้งาน
            </button>
          </form>
        </div>
      </section>
    </div>
  )
}
