import { Component, type ErrorInfo, type ReactNode } from "react";

// The boundary must survive a broken i18n module, so its copy is inlined and the
// locale is read straight from storage rather than through the catalog.
const COPY = {
  zh: {
    title: "界面出了点问题",
    body: "这一屏没能渲染出来。重新加载通常就能恢复；如果反复出现，请复制诊断信息一起反馈。",
    reload: "重新加载",
    copy: "复制诊断信息",
    copied: "已复制"
  },
  en: {
    title: "Something went wrong",
    body: "This screen failed to render. Reloading usually fixes it. If it keeps happening, copy the diagnostics and include them in your report.",
    reload: "Reload",
    copy: "Copy diagnostics",
    copied: "Copied"
  }
} as const;

function readLocale(): "zh" | "en" {
  try {
    const saved = localStorage.getItem("fieldnote-locale");
    return saved === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

interface ErrorBoundaryState {
  error?: Error;
  copied: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { copied: false };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.details = `${error.message}\n\n${error.stack ?? ""}\n\nComponent stack:${info.componentStack ?? ""}`;
  }

  private details = "";

  private report() {
    const { error } = this.state;
    return [
      this.details || `${error?.message ?? ""}\n\n${error?.stack ?? ""}`,
      "",
      `User agent: ${navigator.userAgent}`,
      `Time: ${new Date().toISOString()}`
    ].join("\n");
  }

  private async copyReport() {
    try {
      await navigator.clipboard.writeText(this.report());
      this.setState({ copied: true });
    } catch {
      this.setState({ copied: false });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const copy = COPY[readLocale()];
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-card">
          <h1>{copy.title}</h1>
          <p>{copy.body}</p>
          <pre>{this.state.error.message}</pre>
          <div className="crash-actions">
            <button type="button" className="button-accent" onClick={() => window.location.reload()}>
              {copy.reload}
            </button>
            <button type="button" className="button-quiet" onClick={() => void this.copyReport()}>
              {this.state.copied ? copy.copied : copy.copy}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
