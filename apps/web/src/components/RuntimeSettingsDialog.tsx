import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { useLocale } from "../i18n";
import { Icon } from "../icons";
import { detectProvider, mappingsFor, providerById, type ModelProviderId } from "../modelProviders";
import type { RuntimeConfigStatus } from "../types";
import { ProviderPicker } from "./ProviderPicker";

export function RuntimeSettingsDialog({
  open,
  onClose,
  onSaved
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useLocale();
  const [status, setStatus] = useState<RuntimeConfigStatus>();
  const [provider, setProvider] = useState<ModelProviderId>("anthropic");
  const [authToken, setAuthToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("sonnet");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ tone: "ok" | "error"; message: string }>();
  const [error, setError] = useState("");
  const authSourceText: Record<RuntimeConfigStatus["authSource"], string> = {
    "local-settings": t("runtimeAuthLocal"),
    "process-env": t("runtimeAuthEnv"),
    "user-settings": t("runtimeAuthCli"),
    "oauth-credentials": t("runtimeAuthOauth"),
    none: t("runtimeAuthNone")
  };

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    setTestResult(undefined);
    void api
      .runtimeConfig()
      .then((next) => {
        setStatus(next);
        setAuthToken("");
        setBaseUrl(next.baseUrl);
        setModel(next.model);
        setProvider(detectProvider(next.baseUrl, next.provider));
      })
      .catch(() => setError(t("runtimeLoading")))
      .finally(() => setLoading(false));
  }, [open, t]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose]);

  /** Selecting a provider fills in everything except the key. */
  function selectProvider(next: ModelProviderId) {
    setProvider(next);
    setTestResult(undefined);
    const preset = providerById(next);
    if (!preset || next === "custom") return;
    setBaseUrl(preset.baseUrl);
    setModel(preset.defaultModel);
  }

  // An untouched form sends `{}` so the server tests whatever it already has.
  async function testConnection() {
    setTesting(true);
    setTestResult(undefined);
    setError("");
    const mappings = mappingsFor(provider, model);
    const payload = {
      ...(authToken.trim() ? { authToken: authToken.trim() } : {}),
      ...(baseUrl.trim() !== (status?.baseUrl ?? "") ? { baseUrl: baseUrl.trim() } : {}),
      ...(model.trim() && model.trim() !== status?.model ? { model: model.trim() } : {}),
      ...(Object.keys(mappings).length > 0 ? { modelMappings: mappings } : {})
    };
    try {
      const result = await api.testRuntime(payload);
      if (result.ok) {
        setTestResult({
          tone: "ok",
          message: t("runtimeTestOk", { model: result.model ?? model, latency: result.latencyMs ?? 0 })
        });
      } else {
        setTestResult({
          tone: "error",
          message:
            result.error === "no-credentials"
              ? t("runtimeTestNoCredentials")
              : t("runtimeTestFailed", { error: result.error ?? "" })
        });
      }
    } catch (reason) {
      setTestResult({
        tone: "error",
        message: t("runtimeTestFailed", { error: reason instanceof ApiError ? reason.message : "" })
      });
    } finally {
      setTesting(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!status?.authConfigured && !authToken.trim()) {
      setError(t("runtimeNeedToken"));
      return;
    }
    if (!model.trim()) {
      setError(t("runtimeNeedModel"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const next = await api.saveRuntimeConfig({
        ...(authToken.trim() ? { authToken: authToken.trim() } : {}),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        provider,
        modelMappings: mappingsFor(provider, model)
      });
      setStatus(next);
      setAuthToken("");
      await onSaved();
    } catch (saveError) {
      setError(saveError instanceof ApiError ? saveError.message : t("runtimeSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const configured = status?.runtime === "claude" && status.authConfigured;
  const backgroundModel = mappingsFor(provider, model).ANTHROPIC_DEFAULT_SONNET_MODEL_NAME;

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
            className="runtime-settings"
            role="dialog"
            aria-modal="true"
            aria-labelledby="runtime-settings-title"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ type: "spring", bounce: 0, duration: 0.32 }}
          >
            <header>
              <div>
                <p>{t("runtimeEyebrow")}</p>
                <h2 id="runtime-settings-title">{t("runtimeTitle")}</h2>
              </div>
              <button onClick={onClose} aria-label={t("closeRuntime")}>
                <Icon name="close" />
              </button>
            </header>
            {loading ? (
              <div className="settings-loading">{t("runtimeReading")}</div>
            ) : (
              <form onSubmit={(event) => void save(event)}>
                <div className={`channel-connection ${configured ? "is-connected" : ""}`}>
                  <span />
                  <div>
                    <b>
                      {configured
                        ? t("runtimeEnabled")
                        : status?.authConfigured
                          ? t("runtimeAuthReady")
                          : t("runtimeNotReady")}
                    </b>
                    <small>
                      {status
                        ? `${authSourceText[status.authSource]} · ${t("runtimeAfterSave")}`
                        : t("runtimeFillBelow")}
                    </small>
                  </div>
                </div>
                <ProviderPicker provider={provider} onSelect={selectProvider} />
                {provider === "anthropic" && (
                  <div className="runtime-region-note">
                    <div>
                      <b>{t("runtimeChina")}</b>
                      <p>{t("runtimeChinaBody")}</p>
                      <small>{t("runtimeChinaNote")}</small>
                    </div>
                    <a href="https://ccswitch.io/zh/" target="_blank" rel="noreferrer">
                      {t("runtimeDownload")}
                      <Icon name="chevronRight" size={14} />
                    </a>
                  </div>
                )}
                <label>
                  <span>
                    {t("runtimeToken")} <code>ANTHROPIC_AUTH_TOKEN</code>
                  </span>
                  <input
                    type="password"
                    value={authToken}
                    onChange={(event) => setAuthToken(event.target.value)}
                    placeholder={
                      status?.hasAuthToken || status?.authConfigured ? t("runtimeTokenHas") : t("runtimeTokenPaste")
                    }
                    autoComplete="new-password"
                    spellCheck={false}
                    autoFocus
                  />
                  <small>{t("runtimeTokenHint")}</small>
                </label>
                {provider === "custom" && (
                  <label>
                    <span>
                      {t("runtimeBaseUrl")} <code>ANTHROPIC_BASE_URL</code>
                    </span>
                    <input
                      type="url"
                      inputMode="url"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder={t("runtimeBasePlaceholder")}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                )}
                <label>
                  <span>
                    {t("runtimeModel")} <code>ANTHROPIC_MODEL</code>
                  </span>
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="sonnet"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <small>
                    {backgroundModel ? t("runtimeBackgroundModel", { model: backgroundModel }) : t("runtimeModelHint")}
                  </small>
                </label>
                <div className="runtime-setup-note">
                  <b>{t("runtimeApply")}</b>
                  <p>{t("runtimeApplyBody")}</p>
                </div>
                {testResult && (
                  <p className={`runtime-test-result is-${testResult.tone}`} role="status">
                    {testResult.message}
                  </p>
                )}
                {error && (
                  <p className="settings-error" role="alert">
                    {error}
                  </p>
                )}
                <footer>
                  <button type="button" className="button-quiet" onClick={onClose}>
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    className="button-quiet"
                    onClick={() => void testConnection()}
                    disabled={testing || saving}
                  >
                    {testing ? t("runtimeTesting") : t("runtimeTestConnection")}
                  </button>
                  <button type="submit" className="button-accent" disabled={saving}>
                    {saving ? t("saving") : t("saveAndApply")}
                  </button>
                </footer>
              </form>
            )}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
