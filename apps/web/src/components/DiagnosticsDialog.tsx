import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, localeTag, useLocale } from "../i18n";
import { Icon } from "../icons";
import type { DiagnosticsCheck, DiagnosticsReport } from "../types";

function checkLabel(check: DiagnosticsCheck, english: boolean) {
  return english ? check.labelEn || check.label : check.label;
}

function checkHint(check: DiagnosticsCheck, english: boolean) {
  return english ? check.hintEn || check.hint : check.hint;
}

export function diagnosticsReportText(report: DiagnosticsReport, english: boolean) {
  const lines = [`Fieldnote diagnostics · ${report.generatedAt}`, ""];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${checkLabel(check, english)}`);
    if (check.detail) lines.push(`  ${check.detail}`);
    const hint = checkHint(check, english);
    if (hint && check.status !== "ok") lines.push(`  → ${hint}`);
  }
  return lines.join("\n");
}

export function DiagnosticsDialog({
  open,
  onClose,
  toast
}: {
  open: boolean;
  onClose: () => void;
  toast: (message: string, tone?: "default" | "success" | "danger") => void;
}) {
  const { t } = useLocale();
  const english = getLocale() === "en";
  const [report, setReport] = useState<DiagnosticsReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    void api
      .diagnostics()
      .then(setReport)
      .catch(() => setError(t("diagnosticsFailed")))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    if (!open) return;
    load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose]);

  async function copyReport() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(diagnosticsReportText(report, english));
      toast(t("diagnosticsCopied"), "success");
    } catch {
      toast(t("diagnosticsFailed"), "danger");
    }
  }

  const statusText: Record<DiagnosticsCheck["status"], string> = {
    ok: t("diagnosticsStatusOk"),
    warn: t("diagnosticsStatusWarn"),
    fail: t("diagnosticsStatusFail")
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="settings-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.section
            className="diagnostics-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="diagnostics-title"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ type: "spring", bounce: 0, duration: 0.32 }}
          >
            <header>
              <div>
                <p>{t("diagnosticsEyebrow")}</p>
                <h2 id="diagnostics-title">{t("diagnosticsTitle")}</h2>
              </div>
              <button onClick={onClose} aria-label={t("closeDiagnostics")}>
                <Icon name="close" />
              </button>
            </header>
            <div className="diagnostics-body">
              {loading && !report ? (
                <div className="settings-loading">{t("diagnosticsLoading")}</div>
              ) : error && !report ? (
                <p className="settings-error" role="alert">
                  {error}
                </p>
              ) : report ? (
                <>
                  <ul className="diagnostics-list">
                    {report.checks.map((check) => {
                      const hint = checkHint(check, english);
                      return (
                        <li key={check.id} className={`diagnostics-check is-${check.status}`}>
                          <span
                            className="diagnostics-status"
                            aria-label={statusText[check.status]}
                            title={statusText[check.status]}
                          >
                            <Icon
                              name={check.status === "ok" ? "check" : check.status === "warn" ? "warning" : "close"}
                              size={13}
                            />
                          </span>
                          <span className="diagnostics-text">
                            <b>{checkLabel(check, english)}</b>
                            {check.detail && <small>{check.detail}</small>}
                            {check.status !== "ok" && hint && <em>{hint}</em>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <footer>
                    <small>
                      {t("diagnosticsGeneratedAt", {
                        time: new Date(report.generatedAt).toLocaleTimeString(localeTag())
                      })}
                    </small>
                    <div>
                      <button type="button" className="button-quiet" onClick={load} disabled={loading}>
                        {loading ? t("diagnosticsLoading") : t("diagnosticsRefresh")}
                      </button>
                      <button type="button" className="button-accent" onClick={() => void copyReport()}>
                        {t("diagnosticsCopy")}
                      </button>
                    </div>
                  </footer>
                </>
              ) : null}
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
