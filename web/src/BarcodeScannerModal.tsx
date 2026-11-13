import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Camera, Check, RefreshCw, ScanBarcode, Upload, X } from 'lucide-react'
import { lockBodyScroll, registerActiveDialog } from './dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert } from '@/components/ui/alert'

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
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const streamRef = useRef<MediaStream | null>(null)
  const cameraSessionRef = useRef(0)
  const isDetectingRef = useRef(false)
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

  // ล็อกการเลื่อนหน้าจอ ลงทะเบียน active dialog และรองรับ Escape เมื่อเปิด Modal
  useEffect(() => {
    if (!isOpen) return
    const releaseBodyScroll = lockBodyScroll()
    const unregisterDialog = registerActiveDialog(dialogRef.current)
    dialogRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        stopCamera()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      unregisterDialog()
      releaseBodyScroll()
    }
  }, [isOpen])

  // จัดการเปิด/ปิดกล้อง
  useEffect(() => {
    if (!isOpen) {
      stopCamera()
      return
    }

    setManualSerial('')
    startCamera()

    return () => {
      stopCamera()
    }
  }, [isOpen])

  const stopCamera = () => {
    cameraSessionRef.current += 1
    isDetectingRef.current = false
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
    stopCamera()
    const sessionId = cameraSessionRef.current
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

      if (sessionId !== cameraSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        if (sessionId !== cameraSessionRef.current) {
          stopCamera()
          return
        }
        setCameraActive(true)
        startScanning(sessionId)
      } else {
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }
    } catch (err: any) {
      if (sessionId !== cameraSessionRef.current) return
      console.warn('Camera stream error:', err)
      setCameraError('ไม่สามารถเข้าถึงกล้องได้ โปรดอนุญาตสิทธิ์การใช้กล้อง หรือเลือกถ่ายภาพบาร์โค้ด')
      setCameraActive(false)
    }
  }

  const startScanning = (sessionId: number) => {
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return

    try {
      const formats = ['code_128', 'code_39', 'qr_code', 'ean_13', 'ean_8', 'upc_a', 'data_matrix']
      const detector = new (window as any).BarcodeDetector({ formats })

      scanIntervalRef.current = window.setInterval(async () => {
        if (sessionId !== cameraSessionRef.current || isDetectingRef.current) return
        if (!videoRef.current || videoRef.current.readyState < 2) return

        isDetectingRef.current = true
        try {
          const barcodes = await detector.detect(videoRef.current)
          if (sessionId !== cameraSessionRef.current) return
          if (barcodes && barcodes.length > 0) {
            const rawValue = barcodes[0].rawValue?.trim()
            if (rawValue) {
              handleDetected(rawValue)
            }
          }
        } catch {
          // ignore scan frame errors
        } finally {
          isDetectingRef.current = false
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

    let imageBitmap: ImageBitmap | null = null
    try {
      if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
        const formats = ['code_128', 'code_39', 'qr_code', 'ean_13', 'ean_8', 'upc_a', 'data_matrix']
        const detector = new (window as any).BarcodeDetector({ formats })
        imageBitmap = await createImageBitmap(file)
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
      imageBitmap?.close()
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

  if (!isOpen || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[10500] flex items-center justify-center overflow-y-auto overscroll-contain bg-slate-900/60 p-3 backdrop-blur-xs sm:p-6"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          stopCamera()
          onClose()
        }
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="my-auto flex w-full max-w-[480px] max-h-[92dvh] flex-col overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scanner-modal-title"
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-5 sm:py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-600">
              <ScanBarcode size={20} />
            </div>
            <div className="min-w-0">
              <h2 id="scanner-modal-title" className="m-0 text-base font-bold text-slate-900">
                {title}
              </h2>
              <small className="block truncate text-xs text-slate-500">{subtitle}</small>
            </div>
          </div>
          <button
            type="button"
            className="detail-close shrink-0"
            aria-label="ปิดกล้องสแกน"
            onClick={() => {
              stopCamera()
              onClose()
            }}
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex flex-col gap-3 p-4">
          {/* กรอบวิดีโอแสดงมุมมองกล้อง */}
          <div className="relative flex h-[210px] w-full items-center justify-center overflow-hidden rounded-xl bg-slate-900 sm:h-[250px]">
            <video
              ref={videoRef}
              playsInline
              muted
              className={cameraActive ? 'block h-full w-full object-cover' : 'hidden'}
            />

            {/* Viewfinder Target Overlay */}
            {cameraActive && (
              <div className="pointer-events-none absolute flex h-[140px] w-3/4 items-center justify-center rounded-lg border-2 border-dashed border-emerald-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]">
                <div className="absolute inset-x-0 top-1/2 h-0.5 bg-emerald-400 shadow-[0_0_8px_#4ade80]" />
              </div>
            )}

            {!cameraActive && (
              <div className="flex flex-col items-center gap-2.5 p-5 text-center text-slate-400">
                <Camera size={36} className="text-slate-500" />
                <span className="text-[13px]">
                  {cameraError || 'กำลังเตรียมกล้องสแกน...'}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={startCamera}
                  className="bg-slate-700 text-white hover:bg-slate-600 hover:text-white"
                >
                  <RefreshCw size={14} /> ลองเปิดกล้องใหม่
                </Button>
              </div>
            )}
          </div>

          {/* แถบคำแนะนำหรือแจ้งเตือนข้อผิดพลาด */}
          {cameraError && (
            <Alert variant="destructive">{cameraError}</Alert>
          )}

          {isSupported === false && (
            <Alert variant="warning" className="text-xs">
              <span>ℹ️ เบราว์เซอร์นี้ไม่รองรับ Real-time Barcode API แนะนำให้กดปุ่ม <strong>"ถ่ายภาพบาร์โค้ด"</strong> ด้านล่าง หรือกรอก Serial ด้วยตนเอง</span>
            </Alert>
          )}

          {/* ทางเลือก: ถ่ายภาพบาร์โค้ด หรือ อัปโหลดภาพ */}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1 justify-center"
              disabled={detecting}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={16} />
              {detecting ? 'กำลังอ่านภาพ...' : 'ถ่ายภาพ / เลือกรูปบาร์โค้ด'}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileUpload}
            />
          </div>

          {/* ทางเลือกสำรอง: กรอก Serial ด้วยตนเอง */}
          <form
            onSubmit={handleManualSubmit}
            className="flex gap-2 border-t border-slate-200 pt-3"
          >
            <Input
              type="text"
              placeholder="หรือพิมพ์ Serial Number ที่นี่..."
              value={manualSerial}
              onChange={(e) => setManualSerial(e.target.value)}
              className="flex-1 text-sm"
            />
            <Button
              type="submit"
              disabled={!manualSerial.trim()}
            >
              <Check size={16} /> ใช้งาน
            </Button>
          </form>
        </div>
      </section>
    </div>,
    document.body
  )
}
