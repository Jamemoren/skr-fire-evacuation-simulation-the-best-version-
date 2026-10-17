import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
  message: string;
}

/** Final UI safety net: a render failure must never leave an unexplained blank screen. */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false, message: "" };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      failed: true,
      message: error instanceof Error && error.message ? error.message : "เกิดข้อผิดพลาดที่ไม่คาดคิด",
    };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Deliberately handled without console output: production QA forbids leaking internal state.
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-fatal-shell" role="alert" aria-live="assertive">
        <section className="app-fatal-card">
          <img src="/assets/skr-school-emblem.png" alt="ตราโรงเรียนสวนกุหลาบวิทยาลัย รังสิต" />
          <span>การกู้คืนระบบ</span>
          <h1>ระบบหยุดอย่างปลอดภัย</h1>
          <p>ตรวจพบข้อผิดพลาดขณะเปิดหน้าจอ ระบบจำลองยังไม่ได้เปลี่ยนข้อมูลใด กรุณาโหลดหน้าใหม่เพื่อเริ่มการตรวจสอบอัตโนมัติอีกครั้ง</p>
          <details><summary>รายละเอียดสำหรับผู้ดูแลระบบ</summary><code>{this.state.message}</code></details>
          <button type="button" onClick={() => window.location.reload()}>โหลดระบบใหม่</button>
        </section>
      </main>
    );
  }
}
