import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { api, ApiError, type FeishuSenderCandidate } from "../api";
import { localeTag, useLocale } from "../i18n";
import { Icon } from "../icons";
import type { FeishuChannelStatus } from "../types";

/** Open IDs already written into the textarea, so a second click cannot duplicate one. */
export function parseAllowedOpenIds(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Appends an open_id to the textarea text, leaving it untouched when it is already listed. */
export function appendOpenId(value: string, openId: string): string {
  const listed = parseAllowedOpenIds(value);
  if (!openId || listed.includes(openId)) return value;
  return [...listed, openId].join("\n");
}

export function lastSeenLabel(value: string, t: ReturnType<typeof useLocale>["t"]): string {
  const seen = Date.parse(value);
  if (!Number.isFinite(seen)) return "";
  const delta = Date.now() - seen;
  if (delta < 60_000) return t("justNow");
  if (delta < 3_600_000) return t("minutesAgo", { count: Math.max(1, Math.floor(delta / 60_000)) });
  const date = new Date(seen);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(localeTag(), { month: "short", day: "numeric" });
}

export function FeishuSettingsDialog({
  open,
  onClose,
  onSaved
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useLocale();
  const [status, setStatus] = useState<FeishuChannelStatus>();
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [allowedOpenIds, setAllowedOpenIds] = useState("");
  const [candidates, setCandidates] = useState<FeishuSenderCandidate[]>();
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    void api
      .feishuStatus()
      .then((next) => {
        setStatus(next);
        setAppId(next.appId);
        setAppSecret("");
        setAllowedOpenIds(next.allowedOpenIds.join("\n"));
        setCandidates(undefined);
      })
      .catch(() => setError(t("feishuLoadFailed")))
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

  async function loadCandidates() {
    setLoadingCandidates(true);
    setError("");
    try {
      setCandidates(await api.feishuSenderCandidates());
    } catch {
      setError(t("feishuCandidatesFailed"));
    } finally {
      setLoadingCandidates(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!appId.trim()) {
      setError(t("feishuNeedAppId"));
      return;
    }
    if (!status?.hasSecret && !appSecret.trim()) {
      setError(t("feishuNeedSecret"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const next = await api.saveFeishuSettings({
        appId: appId.trim(),
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        allowedOpenIds: parseAllowedOpenIds(allowedOpenIds)
      });
      setStatus(next);
      setAppSecret("");
      await onSaved();
    } catch (saveError) {
      setError(saveError instanceof ApiError ? saveError.message : t("runtimeSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

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
            className="feishu-settings"
            role="dialog"
            aria-modal="true"
            aria-labelledby="feishu-settings-title"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ type: "spring", bounce: 0, duration: 0.32 }}
          >
            <header>
              <div>
                <p>{t("feishuEyebrow")}</p>
                <h2 id="feishu-settings-title">{t("feishuTitle")}</h2>
              </div>
              <button onClick={onClose} aria-label={t("closeFeishu")}>
                <Icon name="close" />
              </button>
            </header>
            {loading ? (
              <div className="settings-loading">{t("runtimeReading")}</div>
            ) : (
              <form onSubmit={(event) => void save(event)}>
                <div className={`channel-connection ${status?.connected ? "is-connected" : ""}`}>
                  <span />
                  <div>
                    <b>
                      {status?.connected
                        ? t("feishuConnected")
                        : status?.configured
                          ? t("feishuSavedOffline")
                          : t("runtimeNotReady")}
                    </b>
                    <small>{status?.connected ? t("feishuReceiving") : status?.error || t("feishuWillConnect")}</small>
                  </div>
                </div>
                <label>
                  <span>App ID</span>
                  <input
                    value={appId}
                    onChange={(event) => setAppId(event.target.value)}
                    placeholder="cli_xxxxxxxxxxxxxxxx"
                    autoComplete="off"
                  />
                </label>
                <label>
                  <span>App Secret</span>
                  <input
                    type="password"
                    value={appSecret}
                    onChange={(event) => setAppSecret(event.target.value)}
                    placeholder={status?.hasSecret ? t("feishuSecretHas") : t("feishuSecretPaste")}
                    autoComplete="new-password"
                  />
                  <small>{t("feishuSecretHint")}</small>
                </label>
                <label>
                  <span>{t("feishuAllow")}</span>
                  <textarea
                    value={allowedOpenIds}
                    onChange={(event) => setAllowedOpenIds(event.target.value)}
                    placeholder={t("feishuAllowHint")}
                    rows={3}
                  />
                  <small>{t("feishuAllowNote")}</small>
                  <small>{t("feishuAllowEmpty")}</small>
                </label>
                <div className="feishu-setup-note">
                  <b>{t("feishuCandidates")}</b>
                  <p>{t("feishuCandidatesHint")}</p>
                  <button
                    type="button"
                    className="button-quiet"
                    disabled={loadingCandidates}
                    onClick={() => void loadCandidates()}
                  >
                    {loadingCandidates ? t("loading") : t("feishuCandidates")}
                  </button>
                  {candidates?.length === 0 && <p>{t("feishuCandidatesEmpty")}</p>}
                  {candidates?.map((candidate) => {
                    const added = parseAllowedOpenIds(allowedOpenIds).includes(candidate.openId);
                    return (
                      <p key={candidate.openId}>
                        <code>{candidate.openId}</code>
                        {" · "}
                        {lastSeenLabel(candidate.lastSeenAt, t)}
                        {" · "}
                        {candidate.authorized ? t("feishuCandidateAllowed") : t("feishuCandidateBlocked")}{" "}
                        <button
                          type="button"
                          className="button-quiet"
                          disabled={added}
                          onClick={() => setAllowedOpenIds((value) => appendOpenId(value, candidate.openId))}
                        >
                          {added ? t("feishuCandidateAdded") : t("feishuCandidateAdd")}
                        </button>
                      </p>
                    );
                  })}
                </div>
                <div className="feishu-setup-note">
                  <b>{t("feishuNeedBackend")}</b>
                  <p>{t("feishuNeedBackendBody")}</p>
                  <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">
                    {t("feishuOpenPlatform")}
                    <Icon name="chevronRight" size={14} />
                  </a>
                </div>
                <div className="feishu-setup-note">
                  <p>{t("feishuStoredOverridesEnv")}</p>
                </div>
                {error && (
                  <p className="settings-error" role="alert">
                    {error}
                  </p>
                )}
                <footer>
                  <button type="button" className="button-quiet" onClick={onClose}>
                    {t("cancel")}
                  </button>
                  <button type="submit" className="button-accent" disabled={saving}>
                    {saving ? t("connecting") : t("saveAndConnect")}
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
