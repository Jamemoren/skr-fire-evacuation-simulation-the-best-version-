import { useEffect, useRef, useState } from "react";

interface BarcodeDetectorLike { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> }
declare global {
  interface Window { BarcodeDetector?: new (options: { formats: string[] }) => BarcodeDetectorLike }
}

/** QR content is a /mobile?cp=<code> link (or the bare code). Never contains credentials. */
export function parseCheckpointFromQr(raw: string): string | null {
  const text = raw.trim();
  try {
    const url = new URL(text, window.location.origin);
    const cp = url.searchParams.get("cp");
    if (cp) return cp.toUpperCase();
  } catch { /* not a URL */ }
  return /^[A-Z0-9]{2,5}(F\d+)?-\d{3}$/i.test(text) ? text.toUpperCase() : null;
}

interface QrScannerProps {
  supported: boolean;
  onCheckpoint: (checkpointId: string) => void;
  onClose: () => void;
}

/**
 * Uses the browser's BarcodeDetector + camera only where the device really supports it. Elsewhere
 * (e.g. iPhone Safari, or plain HTTP) it says so and offers the phone camera app or the printed code.
 */
export function QrScanner({ supported, onCheckpoint, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<string>(supported ? "กำลังเปิดกล้อง…" : "");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported || !window.BarcodeDetector) return undefined;
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let stopped = false;
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setStatus("เล็งกล้องไปที่ QR บนป้ายจุดตรวจ");
        const scan = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            const checkpoint = found.map((item) => parseCheckpointFromQr(item.rawValue)).find(Boolean);
            if (checkpoint) { onCheckpoint(checkpoint); return; }
          } catch { /* frame not ready */ }
          timer = window.setTimeout(() => void scan(), 300);
        };
        void scan();
      } catch (error) {
        setStatus((error as DOMException).name === "NotAllowedError" ? "ไม่ได้รับอนุญาตให้ใช้กล้อง — ใช้รหัสใต้ QR แทนได้" : "เปิดกล้องไม่สำเร็จ — ใช้รหัสใต้ QR แทนได้");
      }
    })();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [supported, onCheckpoint]);

  const submitCode = () => {
    const checkpoint = parseCheckpointFromQr(code);
    if (!checkpoint) { setCodeError("รหัสไม่ถูกรูปแบบ เช่น B1F5-012"); return; }
    onCheckpoint(checkpoint);
  };

  return (
    <section className="m-sheet" aria-label="สแกน QR จุดตรวจ">
      <header className="m-sheet-head">
        <h2>สแกน QR จุดตรวจ</h2>
        <button type="button" className="m-btn is-ghost" onClick={onClose}>ปิด</button>
      </header>
      {supported ? (
        <div className="m-camera">
          <video ref={videoRef} playsInline muted aria-label="ภาพจากกล้อง" />
          <p role="status">{status}</p>
        </div>
      ) : (
        <p className="m-note">
          อุปกรณ์หรือเบราว์เซอร์นี้สแกน QR ในหน้าเว็บไม่ได้ (ต้องมี BarcodeDetector และเปิดผ่าน HTTPS)
          — ใช้แอปกล้องของโทรศัพท์สแกน QR ที่ป้าย ลิงก์จะเปิดหน้านี้และยืนยันจุดให้ หรือพิมพ์รหัสที่อยู่ใต้ QR
        </p>
      )}
      <label className="m-field">
        <span>รหัสจุดตรวจใต้ QR</span>
        <input value={code} onChange={(event) => { setCode(event.target.value); setCodeError(null); }} placeholder="เช่น B1F5-012" autoCapitalize="characters" inputMode="text" />
      </label>
      {codeError && <p className="m-error" role="alert">{codeError}</p>}
      <button type="button" className="m-btn is-primary" onClick={submitCode}>ยืนยันจุดนี้</button>
      <p className="m-fine">QR ยืนยันตำแหน่ง ณ เวลาที่สแกนเท่านั้น ไม่ได้ติดตามตำแหน่งต่อเนื่อง และไม่บอกทิศที่คุณหันหน้า</p>
    </section>
  );
}
