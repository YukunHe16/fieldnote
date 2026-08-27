import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { localizedProfile, useLocale, type MessageKey } from "../i18n";
import { Icon } from "../icons";
import { detectProvider, mappingsFor, providerById, type ModelProviderId } from "../modelProviders";
import type { AgentProfileId, RuntimeConfigStatus } from "../types";
import { ProviderPicker } from "./ProviderPicker";
import type { Workspace } from "../useWorkspace";

export const ONBOARDED_KEY = "fieldnote-onboarded";

const TOTAL_STEPS = 3;
const WIZARD_PROFILES: AgentProfileId[] = ["local-operator"];

const SAMPLE_PROMPTS: Record<string, Array<[MessageKey, MessageKey]>> = {
  "local-operator": [
    ["promptIdeas", "promptIdeasHint"],
    ["promptFiles", "promptFilesHint"],
    ["promptSteps", "promptStepsHint"]
  ]
};

type ModelChoice = "detected" | "token";

export function OnboardingWizard({
  open,
  workspace,
  theme,
  onTheme,
  onDismiss
}: {
  open: boolean;
  workspace: Workspace;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  onDismiss: () => void;
}) {
  const { locale, setLocale, t } = useLocale();
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<RuntimeConfigStatus>();
  const [choice, setChoice] = useState<ModelChoice>();
  const [authToken, setAuthToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("sonnet");
  const [provider, setProvider] = useState<ModelProviderId>("anthropic");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ tone: "ok" | "error"; message: string }>();
  const [profileId, setProfileId] = useState<AgentProfileId>("local-operator");
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    void api
      .runtimeConfig()
      .then((next) => {
        setStatus(next);
        setBaseUrl(next.baseUrl);
        setModel(next.model || "sonnet");
        setProvider(detectProvider(next.baseUrl, next.provider));
      })
      .catch(() => setStatus(undefined));
  }, [open]);

  // Escape counts as a skip: the wizard should never nag on the next load.
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      void persist().then(onDismiss);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onDismiss]);

  async function persist() {
    try {
      localStorage.setItem(ONBOARDED_KEY, "true");
    } catch {
      /* storage may be unavailable */
    }
    await api.saveOnboardingState(true).catch(() => undefined);
  }

  async function skip() {
    await persist();
    onDismiss();
  }

  async function runTest(payload: { authToken?: string; baseUrl?: string; model?: string }) {
    setTesting(true);
    setTestResult(undefined);
    try {
      const result = await api.testRuntime(payload);
      if (result.ok) {
        setTestResult({
          tone: "ok",
          message: t("runtimeTestOk", { model: result.model ?? model, latency: result.latencyMs ?? 0 })
        });
        return true;
      }
      setTestResult({
        tone: "error",
        message:
          result.error === "no-credentials"
            ? t("runtimeTestNoCredentials")
            : t("runtimeTestFailed", { error: result.error ?? "" })
      });
      return false;
    } catch (reason) {
      setTestResult({
        tone: "error",
        message: t("runtimeTestFailed", { error: reason instanceof ApiError ? reason.message : "" })
      });
      return false;
    } finally {
      setTesting(false);
    }
  }

  /** Selecting a provider fills in everything except the key. */
  function selectProvider(next: ModelProviderId) {
    setProvider(next);
    setTestResult(undefined);
    const preset = providerById(next);
    if (!preset || next === "custom") return;
    setBaseUrl(preset.baseUrl);
    setModel(preset.defaultModel);
  }

  async function testAndSave() {
    if (!authToken.trim() && !status?.authConfigured) {
      setTestResult({ tone: "error", message: t("runtimeTestNoCredentials") });
      return;
    }
    const mappings = mappingsFor(provider, model.trim() || "sonnet");
    const payload = {
      ...(authToken.trim() ? { authToken: authToken.trim() } : {}),
      baseUrl: baseUrl.trim(),
      model: model.trim() || "sonnet",
      ...(Object.keys(mappings).length > 0 ? { modelMappings: mappings } : {})
    };
    if (!(await runTest(payload))) return;
    try {
      await api.saveRuntimeConfig({ ...payload, provider });
      await workspace.refreshCapabilities();
      setAuthToken("");
      setStep(2);
    } catch (reason) {
      setTestResult({ tone: "error", message: reason instanceof ApiError ? reason.message : t("setupSaveFailed") });
    }
  }

  async function finish() {
    setFinishing(true);
    setError("");
    try {
      await persist();
      await workspace.createConversation(false, profileId);
      onDismiss();
    } catch {
      setError(t("setupSaveFailed"));
    } finally {
      setFinishing(false);
    }
  }

  const detectedAvailable = Boolean(status && status.authSource !== "none");
  const prompts = SAMPLE_PROMPTS[profileId] ?? SAMPLE_PROMPTS["local-operator"];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="settings-layer onboarding-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.section
            className="onboarding-wizard"
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-wizard-title"
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", bounce: 0, duration: 0.34 }}
          >
            <header>
              <div>
                <p>
                  {t("setupEyebrow")} · {t("setupStep", { current: step + 1, total: TOTAL_STEPS })}
                </p>
                <h2 id="onboarding-wizard-title">
                  {step === 0 ? t("setupLanguageTitle") : step === 1 ? t("setupModelTitle") : t("setupProfileTitle")}
                </h2>
              </div>
              <button
                type="button"
                className="onboarding-skip"
                onClick={() => void skip()}
                aria-label={t("setupClose")}
              >
                {t("setupSkip")}
              </button>
            </header>

            <div className="onboarding-progress" aria-hidden="true">
              {Array.from({ length: TOTAL_STEPS }, (_, index) => (
                <i key={index} className={index <= step ? "is-done" : ""} />
              ))}
            </div>

            <div className="onboarding-body">
              {step === 0 && (
                <>
                  <p className="onboarding-lead">{t("setupLanguageBody")}</p>
                  <section className="preference-row">
                    <span>
                      <b>{t("language")}</b>
                      <small>{t("languageHint")}</small>
                    </span>
                    <div className="theme-choice" role="radiogroup" aria-label={t("language")}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={locale === "zh"}
                        className={locale === "zh" ? "active" : ""}
                        onClick={() => setLocale("zh")}
                      >
                        {t("languageZh")}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={locale === "en"}
                        className={locale === "en" ? "active" : ""}
                        onClick={() => setLocale("en")}
                      >
                        {t("languageEn")}
                      </button>
                    </div>
                  </section>
                  <section className="preference-row">
                    <span>
                      <b>{t("appearance")}</b>
                      <small>{t("appearanceHint")}</small>
                    </span>
                    <div className="theme-choice" role="radiogroup" aria-label={t("appearance")}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={theme === "light"}
                        className={theme === "light" ? "active" : ""}
                        onClick={() => onTheme("light")}
                      >
                        {t("themeLight")}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={theme === "dark"}
                        className={theme === "dark" ? "active" : ""}
                        onClick={() => onTheme("dark")}
                      >
                        {t("themeDark")}
                      </button>
                    </div>
                  </section>
                </>
              )}

              {step === 1 && (
                <>
                  <p className="onboarding-lead">{t("setupModelBody")}</p>

                  {detectedAvailable && (
                    <div className={`onboarding-card ${choice === "detected" ? "is-open" : ""}`}>
                      <button
                        type="button"
                        className="onboarding-card-head"
                        onClick={() => {
                          setChoice("detected");
                          setTestResult(undefined);
                        }}
                        aria-expanded={choice === "detected"}
                      >
                        <span className="onboarding-card-icon">
                          <Icon name="spark" size={17} />
                        </span>
                        <span>
                          <b>{t("setupUseDetected")}</b>
                          <small>{t("setupUseDetectedHint")}</small>
                        </span>
                        <Icon name="chevronRight" size={15} />
                      </button>
                      {choice === "detected" && (
                        <div className="onboarding-card-body">
                          <div className="onboarding-card-actions">
                            <button
                              type="button"
                              className="button-quiet"
                              onClick={() => void runTest({})}
                              disabled={testing}
                            >
                              {testing ? t("runtimeTesting") : t("runtimeTestConnection")}
                            </button>
                            <button type="button" className="button-accent" onClick={() => setStep(2)}>
                              {t("setupDone")}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  <div className={`onboarding-card ${choice === "token" ? "is-open" : ""}`}>
                    <button
                      type="button"
                      className="onboarding-card-head"
                      onClick={() => {
                        setChoice("token");
                        setTestResult(undefined);
                      }}
                      aria-expanded={choice === "token"}
                    >
                      <span className="onboarding-card-icon">
                        <Icon name="globe" size={17} />
                      </span>
                      <span>
                        <b>{t("setupPasteToken")}</b>
                        <small>{t("setupPasteTokenHint")}</small>
                      </span>
                      <Icon name="chevronRight" size={15} />
                    </button>
                    {choice === "token" && (
                      <div className="onboarding-card-body onboarding-token-form">
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
                              status?.hasAuthToken || status?.authConfigured
                                ? t("runtimeTokenHas")
                                : t("runtimeTokenPaste")
                            }
                            autoComplete="new-password"
                            spellCheck={false}
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
                          <small>{t("runtimeModelHint")}</small>
                        </label>
                        <div className="onboarding-card-actions">
                          <button
                            type="button"
                            className="button-accent"
                            onClick={() => void testAndSave()}
                            disabled={testing}
                          >
                            {testing ? t("runtimeTesting") : t("setupTestAndSave")}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="onboarding-card">
                    <button
                      type="button"
                      className="onboarding-card-head"
                      onClick={() => {
                        setChoice(undefined);
                        setTestResult(undefined);
                        setStep(2);
                      }}
                    >
                      <span className="onboarding-card-icon">
                        <Icon name="chat" size={17} />
                      </span>
                      <span>
                        <b>{t("setupDemoCard")}</b>
                        <small>{t("setupDemoCardHint")}</small>
                      </span>
                      <Icon name="chevronRight" size={15} />
                    </button>
                  </div>

                  {testResult && (
                    <p className={`onboarding-test-result is-${testResult.tone}`} role="status">
                      {testResult.message}
                    </p>
                  )}
                </>
              )}

              {step === 2 && (
                <>
                  <p className="onboarding-lead">{t("setupProfileBody")}</p>
                  <div className="onboarding-profiles" role="radiogroup" aria-label={t("setupProfileTitle")}>
                    {WIZARD_PROFILES.map((id) => {
                      const summary = workspace.agentProfiles.find((item) => item.id === id);
                      const copy = localizedProfile(id, summary?.name, summary?.description);
                      return (
                        <button
                          key={id}
                          type="button"
                          role="radio"
                          aria-checked={profileId === id}
                          className={`onboarding-profile ${profileId === id ? "is-selected" : ""}`}
                          onClick={() => setProfileId(id)}
                        >
                          <span className="onboarding-card-icon">
                            <Icon name="workspace" size={17} />
                          </span>
                          <span>
                            <b>{copy.name}</b>
                            <small>{copy.description}</small>
                          </span>
                          {profileId === id && <Icon name="check" size={15} />}
                        </button>
                      );
                    })}
                  </div>
                  <p className="onboarding-sample-label">{t("setupSamplePrompts")}</p>
                  <ul className="onboarding-samples">
                    {prompts.map(([label, hint]) => (
                      <li key={label}>
                        <b>{t(label)}</b>
                        <small>{t(hint)}</small>
                      </li>
                    ))}
                  </ul>
                  {error && (
                    <p className="settings-error" role="alert">
                      {error}
                    </p>
                  )}
                </>
              )}
            </div>

            <footer>
              {step > 0 ? (
                <button type="button" className="button-quiet" onClick={() => setStep((value) => value - 1)}>
                  {t("setupBack")}
                </button>
              ) : (
                <span />
              )}
              {step === 0 && (
                <button type="button" className="button-accent" onClick={() => setStep(1)}>
                  {t("setupNext")}
                </button>
              )}
              {step === 1 && (
                <button type="button" className="button-quiet" onClick={() => setStep(2)}>
                  {t("setupNext")}
                </button>
              )}
              {step === 2 && (
                <button type="button" className="button-accent" onClick={() => void finish()} disabled={finishing}>
                  {finishing ? t("saving") : t("setupStart")}
                </button>
              )}
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
