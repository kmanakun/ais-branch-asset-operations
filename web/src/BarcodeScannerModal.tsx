import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, RefreshCw, Upload, X } from 'lucide-react'
import { lockBodyScroll, registerActiveDialog } from './dialog'

type BarcodeScannerModalProps = {
  title?: string
  onScan: (scannedValue: string) => void
  onClose: () => void
}

export function BarcodeScannerModal({
  title = 'สแกนบาร์โค้ด / QR Code',
  onScan,
  onClose,
}: BarcodeScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [manualInput, setManualInput] = useState('')
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment')
  const [hasDetector, setHasDetector] = useState(false)

  // Sound feedback on successful scan
  const playBeep = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, audioCtx.currentTime)
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start()
      osc.stop(audioCtx.currentTime + 0.15)
    } catch {
      // AudioContext might be blocked or unsupported; ignore
    }
  }

  const handleDetected = useCallback((value: string) => {
    const clean = value.trim()
    if (!clean) return
    playBeep()
    if ('vibrate' in navigator) {
      try { navigator.vibrate(80) } catch { /* ignore */ }
    }
    onScan(clean)
    onClose()
  }, [onScan, onClose])

  // Stop camera helper
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
    setCameraActive(false)
  }, [])

  // Start camera stream
  const startCamera = useCallback(async (mode: 'environment' | 'user') => {
    stopCamera()
    setCameraError('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('เบราว์เซอร์ไม่รองรับการเปิดกล้องโดยตรง กรุณาใช้การถ่ายรูปหรือกรอกด้วยตนเอง')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: mode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })

      // If user closed dialog while waiting for getUserMedia permission/hardware
      if (!mountedRef.current) {
        stream.getTracks().forEach(track => track.stop())
        return
      }

      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        try {
          await videoRef.current.play()
        } catch {
          // Play was interrupted or video element unmounted
        }
        if (mountedRef.current) {
          setCameraActive(true)
        } else {
          stream.getTracks().forEach(track => track.stop())
          streamRef.current = null
        }
      }
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Permission') || msg.includes('NotAllowedError')) {
        setCameraError('ไม่ได้รับอนุญาตให้เข้าถึงกล้อง กรุณาเปิดสิทธิ์ในเบราว์เซอร์')
      } else {
        setCameraError('ไม่สามารถเริ่มกล้องได้: ' + msg)
      }
    }
  }, [stopCamera])

  // Continuous barcode detection loop using native BarcodeDetector
  useEffect(() => {
    const isSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window
    setHasDetector(isSupported)

    let detector: { detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>> } | null = null
    if (isSupported) {
      try {
        const BarcodeDetectorClass = (window as unknown as {
          BarcodeDetector: new (options?: { formats: string[] }) => typeof detector
        }).BarcodeDetector
        detector = new BarcodeDetectorClass({
          formats: ['code_128', 'code_39', 'qr_code', 'ean_13', 'ean_8', 'data_matrix'],
        })
      } catch {
        detector = null
      }
    }

    let active = true
    let animationFrameId: number

    const scanFrame = async () => {
      if (!active || !mountedRef.current) return
      if (videoRef.current && videoRef.current.readyState >= 2 && detector) {
        try {
          const barcodes = await detector.detect(videoRef.current)
          if (barcodes.length > 0 && barcodes[0].rawValue) {
            handleDetected(barcodes[0].rawValue)
            return
          }
        } catch {
          // Frame error; continue scanning
        }
      }
      if (active && mountedRef.current) {
        animationFrameId = requestAnimationFrame(scanFrame)
      }
    }

    void startCamera(facingMode).then(() => {
      if (active && mountedRef.current && detector) {
        animationFrameId = requestAnimationFrame(scanFrame)
      }
    })

    return () => {
      active = false
      if (animationFrameId) cancelAnimationFrame(animationFrameId)
      stopCamera()
    }
  }, [facingMode, startCamera, stopCamera, handleDetected])

  // Manage modal scroll lock and focus
  useEffect(() => {
    const releaseScroll = lockBodyScroll()
    const unregister = registerActiveDialog(dialogRef.current)
    return () => {
      unregister()
      releaseScroll()
    }
  }, [])

  // File upload barcode detection
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setCameraError('')

    try {
      const bitmap = await createImageBitmap(file)
      if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
        const BarcodeDetectorClass = (window as unknown as {
          BarcodeDetector: new (options?: { formats: string[] }) => {
            detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>
          }
        }).BarcodeDetector
        const detector = new BarcodeDetectorClass({
          formats: ['code_128', 'code_39', 'qr_code', 'ean_13', 'ean_8', 'data_matrix'],
        })
        const results = await detector.detect(bitmap)
        if (results.length > 0 && results[0].rawValue) {
          handleDetected(results[0].rawValue)
          return
        }
      }
      setCameraError('ไม่พบบาร์โค้ดในภาพ กรุณาถ่ายให้ชัดเจนหรือกรอก Serial ด้วยตนเอง')
    } catch {
      setCameraError('ไม่สามารถอ่านรูปภาพได้ โปรดลองใหม่อีกครั้ง')
    }
  }

  const toggleFacingMode = () => {
    setFacingMode(prev => (prev === 'environment' ? 'user' : 'environment'))
  }

  return (
    <div
      className="detail-overlay"
      role="presentation"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="detail-dialog barcode-scanner-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="detail-dialog-header">
          <div>
            <span className="detail-eyebrow">ระบบสแกนบาร์โค้ดอุปกรณ์</span>
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            className="detail-close"
            onClick={onClose}
            aria-label="ปิดหน้าต่างสแกน"
          >
            <X size={18} />
          </button>
        </header>

        <div className="barcode-scanner-body">
          <div className="scanner-viewfinder-container">
            <video
              ref={videoRef}
              className="scanner-video-preview"
              playsInline
              muted
              autoPlay
            />
            <canvas ref={canvasRef} style={{ display: 'none' }} />

            <div className="scanner-target-reticle" aria-hidden="true">
              <div className="reticle-laser" />
              <div className="reticle-corner top-left" />
              <div className="reticle-corner top-right" />
              <div className="reticle-corner bottom-left" />
              <div className="reticle-corner bottom-right" />
            </div>

            {cameraActive && (
              <div className="scanner-viewfinder-hint">
                <span>วางบาร์โค้ดหรือ QR Code ของเครื่องสแกนให้อยู่ในกรอบ</span>
              </div>
            )}
          </div>

          {cameraError && (
            <p className="task-action-error" role="alert">
              {cameraError}
            </p>
          )}

          {!hasDetector && (
            <div className="detail-readonly-note">
              <Camera size={16} />
              <span>
                เบราว์เซอร์นี้ไม่ได้เปิดใช้ตัวอ่านบาร์โค้ดอัตโนมัติ คุณสามารถถ่ายรูปเพื่อถอดรหัส หรือกรอก Serial ด้านล่างได้โดยตรง
              </span>
            </div>
          )}

          <div className="barcode-scanner-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={toggleFacingMode}
              title="สลับกล้องหน้า/หลัง"
            >
              <RefreshCw size={15} /> สลับกล้อง
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={15} /> อัปโหลดภาพบาร์โค้ด
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
          </div>

          <form
            className="barcode-manual-form"
            onSubmit={e => {
              e.preventDefault()
              if (manualInput.trim()) handleDetected(manualInput.trim())
            }}
          >
            <label>
              <span>หรือกรอก Serial ด้วยตนเอง</span>
              <div className="barcode-manual-row">
                <input
                  value={manualInput}
                  onChange={e => setManualInput(e.target.value)}
                  placeholder="กรอกหมายเลข Serial Number..."
                  autoComplete="off"
                />
                <button
                  type="submit"
                  className="primary-button"
                  disabled={!manualInput.trim()}
                >
                  ใช้ค่านี้
                </button>
              </div>
            </label>
          </form>
        </div>
      </div>
    </div>
  )
}
