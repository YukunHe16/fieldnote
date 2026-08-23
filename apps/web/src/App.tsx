import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Composer } from "./components/Composer";
import { ConnectionScreen } from "./components/ConnectionScreen";
import { DiagnosticsDialog } from "./components/DiagnosticsDialog";
import { FeishuSettingsDialog } from "./components/FeishuSettingsDialog";
import { MessageViewport } from "./components/Messages";
import { MemoryDialog } from "./components/MemoryDialog";
import { ONBOARDED_KEY, OnboardingWizard } from "./components/OnboardingWizard";
import { RuntimeSettingsDialog } from "./components/RuntimeSettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { SupportPanel, type SupportPanelKind } from "./components/SupportPanel";
import { Icon } from "./icons";
import { localizedProfile, migrateStoredKey, useLocale } from "./i18n";
import type { ConversationState, ConversationSummary, WorkspaceTab } from "./types";
import { useWorkspace } from "./useWorkspace";

const THEME_KEY = "fieldnote-theme";
const DEMO_BANNER_KEY = "fieldnote-demo-banner-dismissed";
const STREAM_BANNER_DELAY_MS = 3000;

function SearchPalette({
  open,
  onClose,
  workspace
}: {
  open: boolean;
  onClose: () => void;
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const { t } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => [...workspace.active, ...workspace.archived], [workspace.active, workspace.archived]);
  useEffect(() => {
    if (open) window.setTimeout(() => input.current?.focus(), 30);
    else workspace.setSearchQuery("");
  }, [open, workspace.setSearchQuery]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="command-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            className="search-palette material-light"
            role="dialog"
            aria-modal="true"
            aria-label={t("searchDialog")}
            initial={{ opacity: 0, scale: 0.96, y: -14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ type: "spring", bounce: 0, duration: 0.32 }}
          >
            <div className="palette-input">
              <Icon name="search" />
              <input
                ref={input}
                value={workspace.searchQuery}
                onChange={(event) => workspace.setSearchQuery(event.target.value)}
                placeholder={t("searchPlaceholder")}
                onKeyDown={(event) => {
                  if (event.key === "Escape") onClose();
                }}
              />
              <kbd>ESC</kbd>
            </div>
            <div className="palette-results">
              <p>{workspace.searchQuery ? t("searchResults", { query: workspace.searchQuery }) : t("recentOpened")}</p>
              {results.length ? (
                results.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      workspace.setSelectedId(item.id);
                      onClose();
                    }}
                  >
                    <span className="result-icon">
                      <Icon name={item.state === "archived" ? "archive" : "chat"} />
                    </span>
                    <span>
                      <b>{item.title}</b>
                      <small>{item.preview || t("openToContinue")}</small>
                    </span>
                    <em>{item.state === "archived" ? t("archived") : (item.channel ?? "Web")}</em>
                  </button>
                ))
              ) : (
                <div className="palette-empty">
                  <Icon name="search" />
                  <p>{t("noSearchMatches")}</p>
                  <small>{t("tryShorterQuery")}</small>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DeleteDialog({
  item,
  onCancel,
  onConfirm,
  working
}: {
  item?: ConversationSummary;
  onCancel: () => void;
  onConfirm: () => void;
  working: boolean;
}) {
  const { t } = useLocale();
  return (
    <AnimatePresence>
      {item && (
        <motion.div className="dialog-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            className="confirm-dialog material-light"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            aria-describedby="delete-description"
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: "spring", bounce: 0, duration: 0.32 }}
          >
            <span className="danger-glyph">
              <Icon name="trash" />
            </span>
            <h2 id="delete-title">{item.temporary ? t("deleteTemporaryTitle") : t("deletePermanentTitle")}</h2>
            <p id="delete-description">
              {item.temporary ? t("deleteTemporaryBody") : t("deletePermanentBody", { title: item.title })}
            </p>
            <div>
              <button className="button-quiet" onClick={onCancel} disabled={working}>
                {t("cancel")}
              </button>
              <button className="button-danger" onClick={onConfirm} disabled={working}>
                {working ? t("deleting") : item.temporary ? t("endChat") : t("deletePermanently")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ChatHeader({
  workspace,
  onSidebar,
  onDelete,
  onSupport,
  onRuntimeSettings,
  onDiagnostics,
  onFeishuSettings,
  onWorkspace,
  theme,
  onTheme,
  locale,
  onLocale
}: {
  workspace: ReturnType<typeof useWorkspace>;
  onSidebar: () => void;
  onDelete: (item: ConversationSummary) => void;
  onSupport: (kind: SupportPanelKind) => void;
  onRuntimeSettings: () => void;
  onDiagnostics: () => void;
  onFeishuSettings: () => void;
  onWorkspace: (tab: WorkspaceTab) => void;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  locale: "zh" | "en";
  onLocale: (locale: "zh" | "en") => void;
}) {
  const { t } = useLocale();
  const conversation = workspace.conversation;
  const runtimeReady = workspace.capabilities.runtime === "claude";
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation?.title ?? t("newConversation"));
  const [menu, setMenu] = useState(false);
  const [supportMenu, setSupportMenu] = useState(false);
  const [profileMenu, setProfileMenu] = useState(false);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const headerStatus =
    conversation?.runState === "running"
      ? t("working")
      : conversation?.runState === "reconnecting"
        ? t("reconnecting")
        : conversation?.state === "archived"
          ? t("archived")
          : undefined;
  useEffect(() => setTitle(conversation?.title ?? t("newConversation")), [conversation?.id, conversation?.title, t]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);
  async function commitTitle() {
    const next = title.trim() || t("newConversation");
    setTitle(next);
    setEditing(false);
    if (conversation) await workspace.updateConversation(conversation.id, { title: next });
  }
  return (
    <header className="chat-header material-light">
      <div className="header-leading">
        <button className="icon-button" onClick={onSidebar} aria-label={t("toggleSidebar")}>
          <Icon name="sidebar" />
        </button>
        <div className="title-stack">
          {editing ? (
            <input
              className="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitTitle();
                if (event.key === "Escape") {
                  setTitle(conversation?.title ?? t("newConversation"));
                  setEditing(false);
                }
              }}
              autoFocus
              aria-label={t("conversationTitle")}
            />
          ) : (
            <button className="title-button" onClick={() => setEditing(true)}>
              {conversation?.title ?? t("newConversation")}
              <Icon name="edit" size={16} />
            </button>
          )}
          {conversation?.temporary ? (
            <span className="temporary-notice">
              <Icon name="clock" size={12} />
              {t("temporaryNotice")}
            </span>
          ) : (
            headerStatus && (
              <span className={`header-status state-${conversation?.runState ?? "idle"}`}>
                <i />
                {headerStatus}
              </span>
            )
          )}
        </div>
      </div>
      <div className="header-actions">
        <div className="header-menu-wrap profile-switcher-wrap">
          <button
            className="profile-switcher"
            onClick={() => setProfileMenu((value) => !value)}
            aria-label={t("chooseAssistant")}
            aria-expanded={profileMenu}
          >
            <span>
              {localizedProfile(conversation?.profileId ?? "", conversation?.profileName, undefined).name ||
                t("chooseAssistant")}
            </span>
            <Icon name="chevronRight" size={14} className={profileMenu ? "is-open" : ""} />
          </button>
          <AnimatePresence>
            {profileMenu && (
              <motion.div
                className="popover header-popover profile-switcher-popover"
                role="menu"
                initial={{ opacity: 0, scale: 0.95, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ type: "spring", bounce: 0, duration: 0.24 }}
              >
                <p>{t("chooseAssistant")}</p>
                <small className="profile-switcher-hint">{t("switchProfileHint")}</small>
                {workspace.agentProfiles
                  .filter((profile) => profile.id === "graduate-admissions" || profile.id === "local-operator")
                  .sort((a) => (a.id === "graduate-admissions" ? -1 : 1))
                  .map((profile) => {
                    const copy = localizedProfile(profile.id, profile.name, profile.description);
                    return (
                      <button
                        key={profile.id}
                        role="menuitem"
                        aria-current={conversation?.profileId === profile.id ? "true" : undefined}
                        className={conversation?.profileId === profile.id ? "is-current" : ""}
                        onClick={() => {
                          setProfileMenu(false);
                          if (conversation?.profileId !== profile.id)
                            void workspace.createConversation(false, profile.id);
                        }}
                      >
                        <span>
                          <b>{copy.name}</b>
                          <small>{copy.description}</small>
                        </span>
                        {conversation?.profileId === profile.id && <Icon name="check" size={14} />}
                      </button>
                    );
                  })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="header-menu-wrap support-menu-wrap">
          <button
            className="icon-button"
            onClick={() => setSupportMenu((value) => !value)}
            aria-label={t("openSupport")}
            aria-expanded={supportMenu}
          >
            <Icon name="activity" />
          </button>
          <AnimatePresence>
            {supportMenu && (
              <motion.div
                className="popover header-popover support-popover"
                role="menu"
                initial={{ opacity: 0, scale: 0.95, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ type: "spring", bounce: 0, duration: 0.24 }}
              >
                <button
                  onClick={() => {
                    setSupportMenu(false);
                    onSupport("admissions");
                  }}
                >
                  <Icon name="activity" />
                  <span>
                    <b>{t("admissionsBoard")}</b>
                    <small>{t("admissionsBoardHint")}</small>
                  </span>
                </button>
                <button
                  onClick={() => {
                    setSupportMenu(false);
                    onSupport("schedules");
                  }}
                >
                  <Icon name="clock" />
                  <span>
                    <b>{t("scheduledJobs")}</b>
                    <small>{t("scheduledJobsHint")}</small>
                  </span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <button
          className="icon-button"
          onClick={() => onTheme(theme === "light" ? "dark" : "light")}
          aria-label={theme === "light" ? t("themeToDark") : t("themeToLight")}
        >
          <Icon name={theme === "light" ? "moon" : "sun"} />
        </button>
        <div className="header-menu-wrap" ref={workspaceMenuRef}>
          <button
            className="icon-button"
            onClick={() => setMenu((value) => !value)}
            aria-label={t("workspaceMenu")}
            aria-expanded={menu}
          >
            <Icon name="workspace" />
          </button>
          <AnimatePresence>
            {menu && (
              <motion.div
                className="header-popover workspace-popover"
                role="dialog"
                aria-label={t("workspace")}
                initial={{ opacity: 0, scale: 0.95, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ type: "spring", bounce: 0, duration: 0.24 }}
              >
                <header>
                  <span>
                    <b>{t("workspace")}</b>
                    <small>
                      {runtimeReady ? t("connected") : workspace.demoMode ? t("offlineDemo") : t("pendingSetup")}
                    </small>
                  </span>
                  <i className={`workspace-status ${runtimeReady ? "online" : "demo"}`} />
                </header>
                <section className="preference-row">
                  <span>
                    <b>{t("appearance")}</b>
                    <small>{t("appearanceHint")}</small>
                  </span>
                  <div className="theme-choice" role="radiogroup" aria-label={t("appearance")}>
                    <button
                      role="radio"
                      aria-checked={theme === "light"}
                      className={theme === "light" ? "active" : ""}
                      onClick={() => onTheme("light")}
                    >
                      {t("themeLight")}
                    </button>
                    <button
                      role="radio"
                      aria-checked={theme === "dark"}
                      className={theme === "dark" ? "active" : ""}
                      onClick={() => onTheme("dark")}
                    >
                      {t("themeDark")}
                    </button>
                  </div>
                </section>
                <section className="preference-row">
                  <span>
                    <b>{t("language")}</b>
                    <small>{t("languageHint")}</small>
                  </span>
                  <div className="theme-choice" role="radiogroup" aria-label={t("language")}>
                    <button
                      role="radio"
                      aria-checked={locale === "zh"}
                      className={locale === "zh" ? "active" : ""}
                      onClick={() => onLocale("zh")}
                    >
                      {t("languageZh")}
                    </button>
                    <button
                      role="radio"
                      aria-checked={locale === "en"}
                      className={locale === "en" ? "active" : ""}
                      onClick={() => onLocale("en")}
                    >
                      {t("languageEn")}
                    </button>
                  </div>
                </section>
                <section className="channel-status">
                  <p>{t("workspaceSection")}</p>
                  <button
                    onClick={() => {
                      setMenu(false);
                      onWorkspace("memory");
                    }}
                  >
                    <Icon name="memory" size={17} />
                    <span>
                      <b>{t("memory")}</b>
                      <small>{t("memoryHint")}</small>
                    </span>
                    <Icon name="chevronRight" size={15} />
                  </button>
                  <button
                    onClick={() => {
                      setMenu(false);
                      onWorkspace("handbook");
                    }}
                  >
                    <Icon name="book" size={17} />
                    <span>
                      <b>{t("handbook")}</b>
                      <small>{t("handbookHint")}</small>
                    </span>
                    <Icon name="chevronRight" size={15} />
                  </button>
                  <button
                    onClick={() => {
                      setMenu(false);
                      onWorkspace("capabilities");
                    }}
                  >
                    <Icon name="spark" size={17} />
                    <span>
                      <b>{t("capabilities")}</b>
                      <small>{t("capabilitiesHint")}</small>
                    </span>
                    <Icon name="chevronRight" size={15} />
                  </button>
                  <button
                    onClick={() => {
                      setMenu(false);
                      onWorkspace("shelf");
                    }}
                  >
                    <Icon name="file" size={17} />
                    <span>
                      <b>{t("deliveryShelf")}</b>
                      <small>{t("deliveryShelfHint")}</small>
                    </span>
                    <Icon name="chevronRight" size={15} />
                  </button>
                  <p className="profile-section-label">{t("connections")}</p>
                  <button
                    onClick={() => {
                      setMenu(false);
                      onRuntimeSettings();
                    }}
                  >
                    <span className={`status-dot ${runtimeReady ? "online" : ""}`} />
                    <span>
                      <b>{t("modelService")}</b>
                      <small>{runtimeReady ? t("configured") : t("clickToConfigure")}</small>
                    </span>
                    <Icon name="chevronRight" size={15} />
                  </button>
                  <button
                    onClick={() => {
                      setMenu(false);
                      onFeishuSettings();
                    }}
                  >
                    <span
                      className={`status-dot ${workspace.capabilities.feishuConfigured === true ? "online" : ""}`}
                    />
                    <span>
                      <b>{t("feishu")}</b>
                      <small>
                        {workspace.capabilities.feishuConfigured === true ? t("configured") : t("clickToConfigure")}
                      </small>
                    </span>
                    <Icon name="chevronRight" size={15} />
                  </button>
                  <button
                    onClick={() => {
                      setMenu(false);
                      onDiagnostics();
                    }}
                  >
                    <Icon name="activity" size={17} />
                    <span>
                      <b>{t("diagnostics")}</b>
                      <small>{t("diagnosticsHint")}</small>
                    </span>
                    <Icon name="chevronRight" size={15} />
                  </button>
                </section>
                {conversation && (
                  <section className="workspace-conversation-actions">
                    <p>{t("currentConversation")}</p>
                    {!conversation.temporary && (
                      <button
                        onClick={() => {
                          void workspace.updateConversation(conversation.id, { pinned: !conversation.pinned });
                          setMenu(false);
                        }}
                      >
                        <Icon name="pin" />
                        {conversation.pinned ? t("unpin") : t("pin")}
                      </button>
                    )}
                    {!conversation.temporary && (
                      <button
                        onClick={() => {
                          void workspace.archiveConversation(conversation);
                          setMenu(false);
                        }}
                      >
                        <Icon name={conversation.state === "active" ? "archive" : "unarchive"} />
                        {conversation.state === "active" ? t("archive") : t("unarchive")}
                      </button>
                    )}
                    <button
                      className="danger"
                      onClick={() => {
                        onDelete(conversation);
                        setMenu(false);
                      }}
                    >
                      <Icon name="trash" />
                      {conversation.temporary ? t("endTemporary") : t("deletePermanently")}
                    </button>
                  </section>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}

function DemoBanner({ onConfigure }: { onConfigure: () => void }) {
  const { t } = useLocale();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DEMO_BANNER_KEY) === "true";
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <div className="demo-banner" role="status">
      <span className="demo-banner-dot" aria-hidden="true" />
      <p>{t("demoBannerText")}</p>
      <button type="button" className="demo-banner-action" onClick={onConfigure}>
        {t("demoBannerAction")}
      </button>
      <button
        type="button"
        className="demo-banner-close"
        aria-label={t("demoBannerDismiss")}
        onClick={() => {
          setDismissed(true);
          try {
            sessionStorage.setItem(DEMO_BANNER_KEY, "true");
          } catch {
            /* storage may be unavailable */
          }
        }}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

// The SSE flag flickers on ordinary reconnects, so the banner waits out a short
// grace period before it claims the live connection is gone.
function StreamStatusBanner({ visible }: { visible: boolean }) {
  const { t } = useLocale();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!visible) {
      setShow(false);
      return;
    }
    const timer = window.setTimeout(() => setShow(true), STREAM_BANNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="stream-status-banner"
          role="status"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ type: "spring", bounce: 0, duration: 0.26 }}
        >
          <i className="connection-spinner" aria-hidden="true" />
          {t("streamDisconnected")}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Toasts({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  const { t } = useLocale();
  return (
    <div className="toast-region" aria-live="polite">
      <AnimatePresence>
        {workspace.toasts.map((toast) => (
          <motion.div
            className={`toast tone-${toast.tone ?? "default"}`}
            key={toast.id}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: "spring", bounce: 0, duration: 0.3 }}
          >
            <span>
              {toast.tone === "success" ? (
                <Icon name="check" />
              ) : toast.tone === "danger" ? (
                <Icon name="warning" />
              ) : (
                <Icon name="status" />
              )}
            </span>
            <p>{toast.message}</p>
            {toast.action && (
              <button
                onClick={() => {
                  toast.action?.onClick();
                  workspace.dismissToast(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button
              className="toast-close"
              onClick={() => workspace.dismissToast(toast.id)}
              aria-label={t("closeNotification")}
            >
              <Icon name="close" size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  const workspace = useWorkspace();
  const { locale, setLocale, t } = useLocale();
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1180);
  const [listState, setListState] = useState<ConversationState>("active");
  const [searchOpen, setSearchOpen] = useState(false);
  const [runtimeSettingsOpen, setRuntimeSettingsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [feishuSettingsOpen, setFeishuSettingsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("memory");
  const [supportPanel, setSupportPanel] = useState<SupportPanelKind>();
  const [scheduledRunId, setScheduledRunId] = useState<string>();
  const [deleteItem, setDeleteItem] = useState<ConversationSummary>();
  const [deleting, setDeleting] = useState(false);
  const [seededPrompt, setSeededPrompt] = useState<string>();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    migrateStoredKey(THEME_KEY, "quiet-theme");
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "dark" || saved === "light"
      ? saved
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "light" ? "#ffffff" : "#000000");
  }, [theme]);
  useEffect(() => {
    const url = new URL(window.location.href);
    const runId = url.searchParams.get("scheduledRun");
    if (runId) {
      setScheduledRunId(runId);
      setSupportPanel("schedules");
    }
  }, []);
  // First-run wizard: `?onboarding=1` forces it once for anyone; otherwise it only
  // greets a fresh demo-runtime install that neither this browser nor the server
  // has marked as onboarded.
  const onboardingResolved = useRef(false);
  useEffect(() => {
    if (onboardingResolved.current) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("onboarding") === "1") {
      onboardingResolved.current = true;
      url.searchParams.delete("onboarding");
      window.history.replaceState(null, "", url);
      setOnboardingOpen(true);
      return;
    }
    if (workspace.loading || workspace.backendDown) return;
    if (workspace.capabilities.runtime !== "demo") {
      onboardingResolved.current = true;
      return;
    }
    onboardingResolved.current = true;
    let onboarded = false;
    try {
      onboarded = localStorage.getItem(ONBOARDED_KEY) === "true";
    } catch {
      /* storage may be unavailable */
    }
    if (onboarded) return;
    void api
      .onboardingState()
      .then((state) => {
        if (!state.completed) setOnboardingOpen(true);
      })
      .catch(() => setOnboardingOpen(true));
  }, [workspace.loading, workspace.backendDown, workspace.capabilities.runtime]);

  const replayQueryAttempt = useRef<string | null>(null);
  useEffect(() => {
    if (workspace.loading || workspace.backendDown) return;
    const url = new URL(window.location.href);
    const replayRunId = url.searchParams.get("replayRun");
    const withArtifact = url.searchParams.get("withArtifact");
    if (!replayRunId) return;
    const attempt = `${replayRunId}:${withArtifact ?? ""}`;
    if (replayQueryAttempt.current === attempt) return;
    replayQueryAttempt.current = attempt;
    void workspace
      .replayRunById(replayRunId, withArtifact ? { includeArtifactId: withArtifact } : undefined)
      .then((ok) => {
        if (!ok) return;
        const next = new URL(window.location.href);
        next.searchParams.delete("replayRun");
        next.searchParams.delete("withArtifact");
        window.history.replaceState(null, "", next);
      });
  }, [workspace.loading, workspace.backendDown, workspace.replayRunById]);

  const shortcuts = useCallback(
    (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (modifier && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void workspace.createConversation();
      }
      if (modifier && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      }
      if (event.key === "Escape") setSearchOpen(false);
    },
    [workspace.createConversation]
  );
  useEffect(() => {
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [shortcuts]);
  useEffect(() => {
    if (window.innerWidth < 1180) setSidebarOpen(false);
  }, [workspace.selectedId]);
  useEffect(() => {
    const closeAtCompactDesktop = () => {
      if (window.innerWidth < 1180) setSidebarOpen(false);
    };
    window.addEventListener("resize", closeAtCompactDesktop);
    return () => window.removeEventListener("resize", closeAtCompactDesktop);
  }, []);
  useEffect(() => {
    if (supportPanel && window.innerWidth < 1500) setSidebarOpen(false);
  }, [supportPanel]);

  // Only a server-backed conversation opens an SSE stream, so only that case can
  // legitimately report a dropped live connection.
  const streamingConversationId =
    workspace.conversation && !workspace.conversation.id.startsWith("local-") ? workspace.conversation.id : undefined;

  async function confirmDelete() {
    if (!deleteItem) return;
    setDeleting(true);
    try {
      if (
        (deleteItem.runState === "running" ||
          (workspace.conversation?.id === deleteItem.id && workspace.conversation?.runState === "running")) &&
        workspace.conversation?.activeRunId
      )
        await workspace.interrupt();
      await workspace.deleteConversation(deleteItem.id);
      setDeleteItem(undefined);
    } catch {
      workspace.toast(t("cannotDeleteChat"), "danger");
    } finally {
      setDeleting(false);
    }
  }

  function closeSupportPanel() {
    setSupportPanel(undefined);
    if (scheduledRunId) {
      setScheduledRunId(undefined);
      const url = new URL(window.location.href);
      url.searchParams.delete("scheduledRun");
      window.history.replaceState(null, "", url);
    }
  }

  return (
    <div
      className={`app-shell ${sidebarOpen ? "has-sidebar" : "sidebar-collapsed"} ${supportPanel ? "has-support-panel" : ""}`}
    >
      <div className="ambient-field" aria-hidden="true">
        <i />
        <i />
      </div>
      <Sidebar
        workspace={workspace}
        open={sidebarOpen}
        onClose={() => {
          if (window.innerWidth < 1180) setSidebarOpen(false);
        }}
        onDismiss={() => setSidebarOpen(false)}
        listState={listState}
        onListState={setListState}
        onOpenSearch={() => setSearchOpen(true)}
        onRequestDelete={setDeleteItem}
      />
      <main className={`chat-surface ${workspace.backendDown ? "is-offline" : ""}`}>
        {workspace.backendDown ? (
          <ConnectionScreen />
        ) : (
          <>
            <ChatHeader
              workspace={workspace}
              onSidebar={() => setSidebarOpen((value) => !value)}
              onDelete={setDeleteItem}
              onSupport={setSupportPanel}
              onRuntimeSettings={() => setRuntimeSettingsOpen(true)}
              onDiagnostics={() => setDiagnosticsOpen(true)}
              onFeishuSettings={() => setFeishuSettingsOpen(true)}
              onWorkspace={(tab) => {
                setWorkspaceTab(tab);
                setMemoryOpen(true);
              }}
              theme={theme}
              onTheme={setTheme}
              locale={locale}
              onLocale={setLocale}
            />
            <StreamStatusBanner visible={Boolean(streamingConversationId) && !workspace.connected} />
            <div className="chat-main">
              <MessageViewport
                conversation={workspace.conversation}
                workspace={workspace}
                onSeedPrompt={setSeededPrompt}
              />
            </div>
            <div className="composer-dock">
              {workspace.demoMode && <DemoBanner onConfigure={() => setRuntimeSettingsOpen(true)} />}
              <Composer
                workspace={workspace}
                conversation={workspace.conversation}
                seededPrompt={seededPrompt}
                onSeedConsumed={() => setSeededPrompt(undefined)}
                onOpenLearning={() => setSupportPanel("learning")}
              />
            </div>
          </>
        )}
      </main>
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} workspace={workspace} />
      <OnboardingWizard
        open={onboardingOpen}
        workspace={workspace}
        theme={theme}
        onTheme={setTheme}
        onDismiss={() => setOnboardingOpen(false)}
      />
      <RuntimeSettingsDialog
        open={runtimeSettingsOpen}
        onClose={() => setRuntimeSettingsOpen(false)}
        onSaved={workspace.refreshCapabilities}
      />
      <DiagnosticsDialog open={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} toast={workspace.toast} />
      <FeishuSettingsDialog
        open={feishuSettingsOpen}
        onClose={() => setFeishuSettingsOpen(false)}
        onSaved={workspace.refreshCapabilities}
      />
      <MemoryDialog
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        toast={workspace.toast}
        agentProfiles={workspace.agentProfiles}
        currentProfileId={workspace.conversation?.profileId}
        initialTab={workspaceTab}
        onOpenConversation={workspace.adoptConversation}
      />
      <SupportPanel
        kind={supportPanel}
        scheduledRunId={scheduledRunId}
        conversation={workspace.conversation}
        onSessionUpdate={workspace.updateLearningSession}
        onConfirmVerification={workspace.confirmLearningVerification}
        onClose={closeSupportPanel}
      />
      <DeleteDialog
        item={deleteItem}
        onCancel={() => setDeleteItem(undefined)}
        onConfirm={() => void confirmDelete()}
        working={deleting}
      />
      <Toasts workspace={workspace} />
    </div>
  );
}
