import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { localeTag, localizedProfile, t, useLocale } from "../i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "../icons";
import type {
  AgentProfileSummary,
  ConversationDetail,
  EquipmentItem,
  EvolvedArtifact,
  HandbookDocument,
  MemoryCategory,
  MemoryItemDto,
  MemoryMaintenanceStatusDto,
  MemorySettingsDto,
  ProfileEquipment,
  ShelfItem,
  ToastMessage,
  WorkspaceTab
} from "../types";

function memoryCategories() {
  return [
    { value: "all" as const, label: t("memoryCategoryAll") },
    { value: "profile" as const, label: t("memoryCategoryProfile") },
    { value: "preference" as const, label: t("memoryCategoryPreference") },
    { value: "goal" as const, label: t("memoryCategoryGoal") },
    { value: "project" as const, label: t("memoryCategoryProject") },
    { value: "task" as const, label: t("memoryCategoryTask") }
  ];
}

function categoryLabel(value: MemoryCategory) {
  return memoryCategories().find((item) => item.value === value)?.label ?? value;
}

function maintenanceFailureLabel(error?: string | null) {
  const detail = error?.trim();
  return detail ? t("memoryMaintenanceFailed", { detail }) : t("memoryMaintenanceFailedGeneric");
}

interface MemoryDialogProps {
  open: boolean;
  onClose: () => void;
  toast: (message: string, tone?: ToastMessage["tone"], action?: ToastMessage["action"]) => void;
  agentProfiles: AgentProfileSummary[];
  currentProfileId?: string;
  initialTab?: WorkspaceTab;
  onOpenConversation?: (conversation: ConversationDetail) => void;
}

function workspaceTabItems(): Array<{ id: WorkspaceTab; label: string }> {
  return [
    { id: "memory", label: t("memory") },
    { id: "handbook", label: t("handbook") },
    { id: "capabilities", label: t("capabilities") },
    { id: "shelf", label: t("deliveryShelfTab") }
  ];
}

function workspaceTabTitle(tab: WorkspaceTab) {
  if (tab === "memory") return t("memory");
  if (tab === "handbook") return t("handbook");
  if (tab === "shelf") return t("deliveryShelf");
  return t("capabilities");
}

function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <label className={`memory-toggle-row ${disabled ? "is-disabled" : ""}`}>
      <span>
        <b>{label}</b>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <i aria-hidden="true">
        <span />
      </i>
    </label>
  );
}

function MemoryEditor({
  memory,
  onCancel,
  onSave,
  working,
  agentProfiles,
  currentProfileId
}: {
  memory?: MemoryItemDto;
  onCancel: () => void;
  onSave: (
    input: Pick<MemoryItemDto, "category" | "title" | "content" | "keywords" | "importance"> & {
      profileId?: string | null;
    }
  ) => void;
  working: boolean;
  agentProfiles: AgentProfileSummary[];
  currentProfileId?: string;
}) {
  const [category, setCategory] = useState<MemoryCategory>(memory?.category ?? "preference");
  const [title, setTitle] = useState(memory?.title ?? "");
  const [content, setContent] = useState(memory?.content ?? "");
  const [keywords, setKeywords] = useState(memory?.keywords.join("、") ?? "");
  const [importance, setImportance] = useState(memory?.importance ?? 3);
  const [profileId, setProfileId] = useState(memory?.profileId ?? currentProfileId ?? "graduate-admissions");
  const { t } = useLocale();
  const scoped = category === "goal" || category === "project" || category === "task";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !content.trim()) return;
    onSave({
      category,
      title: title.trim(),
      content: content.trim(),
      keywords: keywords
        .split(/[，,、]/)
        .map((item) => item.trim())
        .filter(Boolean),
      importance,
      ...(scoped ? { profileId } : { profileId: null })
    });
  }

  return (
    <form className="memory-editor" onSubmit={submit}>
      <div className="memory-editor-heading">
        <div>
          <p>{memory ? t("editMemory") : t("addMemory")}</p>
          <h3>{memory ? memory.title : t("writeMemory")}</h3>
        </div>
        <button type="button" onClick={onCancel} aria-label={t("closeEditor")}>
          <Icon name="close" size={17} />
        </button>
      </div>
      <label>
        <span>{t("category")}</span>
        <select value={category} onChange={(event) => setCategory(event.target.value as MemoryCategory)}>
          {memoryCategories()
            .slice(1)
            .map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
        </select>
      </label>
      {scoped && (
        <label>
          <span>
            {t("belongsToAssistant")} <small>{t("scopedHint")}</small>
          </span>
          <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            {agentProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {localizedProfile(profile.id, profile.name, profile.description).name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>{t("titleLabel")}</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("titlePlaceholder")}
          autoFocus
          maxLength={80}
        />
      </label>
      <label>
        <span>{t("contentLabel")}</span>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={t("contentPlaceholder")}
          rows={4}
        />
      </label>
      <label>
        <span>
          {t("keywordsLabel")} <small>{t("keywordsHint")}</small>
        </span>
        <input
          value={keywords}
          onChange={(event) => setKeywords(event.target.value)}
          placeholder={t("keywordsPlaceholder")}
        />
      </label>
      <label>
        <span>{t("importance")}</span>
        <select value={importance} onChange={(event) => setImportance(Number(event.target.value))}>
          {[1, 2, 3, 4, 5].map((value) => (
            <option key={value} value={value}>
              {value === 1
                ? t("importanceLow")
                : value === 3
                  ? t("importanceMid")
                  : value === 5
                    ? t("importanceHigh")
                    : value}
            </option>
          ))}
        </select>
      </label>
      <footer>
        <button type="button" className="button-quiet" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button type="submit" className="button-accent" disabled={working || !title.trim() || !content.trim()}>
          {working ? t("saving") : t("save")}
        </button>
      </footer>
    </form>
  );
}

export function MemoryDialog({
  open,
  onClose,
  toast,
  agentProfiles,
  currentProfileId,
  initialTab = "memory",
  onOpenConversation
}: MemoryDialogProps) {
  const { t } = useLocale();
  const searchRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  const [settings, setSettings] = useState<MemorySettingsDto>({
    enabled: true,
    autoSave: true,
    referenceHistory: true
  });
  const [items, setItems] = useState<MemoryItemDto[]>([]);
  const [maintenance, setMaintenance] = useState<MemoryMaintenanceStatusDto>();
  const [category, setCategory] = useState<MemoryCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [startingMaintenance, setStartingMaintenance] = useState(false);
  const [editor, setEditor] = useState<MemoryItemDto | "new">();
  const [confirmClear, setConfirmClear] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MemoryItemDto>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setPendingDelete(undefined);
      setConfirmClear(false);
      return;
    }
    setTab(initialTab);
    setLoading(true);
    setError("");
    void Promise.all([api.memorySettings(), api.memories(), api.memoryMaintenance()])
      .then(([nextSettings, nextItems, nextMaintenance]) => {
        setSettings(nextSettings);
        setItems(nextItems);
        setMaintenance(nextMaintenance);
      })
      .catch(() => setError(t("memoryLoadFailed")))
      .finally(() => setLoading(false));
  }, [open, initialTab]);

  useEffect(() => {
    if (!open || maintenance?.status !== "running") return;
    const timer = window.setInterval(() => {
      void api
        .memoryMaintenance()
        .then((next) => {
          setMaintenance((previous) => {
            if (previous?.status === "running" && next.status === "failed") {
              toast(maintenanceFailureLabel(next.lastError), "danger");
            } else if (previous?.status === "running" && next.status === "idle") {
              toast(t("memoryMaintenanceDone"), "success");
            }
            return next;
          });
        })
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [open, maintenance?.status, toast]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void api
        .memories(category === "all" ? undefined : category, query)
        .then(setItems)
        .catch(() => setError(t("memorySearchFailed")));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, category, query]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editor) setEditor(undefined);
      else if (pendingDelete) setPendingDelete(undefined);
      else if (confirmClear) setConfirmClear(false);
      else onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, editor, pendingDelete, confirmClear, onClose]);

  async function changeSetting(key: keyof MemorySettingsDto, value: boolean) {
    const previous = settings;
    const next = { ...settings, [key]: value };
    setSettings(next);
    try {
      setSettings(await api.saveMemorySettings({ [key]: value }));
    } catch {
      setSettings(previous);
      toast(t("settingsSaveFailed"), "danger");
    }
  }

  async function saveMemory(
    input: Pick<MemoryItemDto, "category" | "title" | "content" | "keywords" | "importance"> & {
      profileId?: string | null;
    }
  ) {
    setWorking(true);
    try {
      const saved = editor === "new" ? await api.createMemory(input) : await api.updateMemory(editor!.id, input);
      setItems((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setEditor(undefined);
      toast(editor === "new" ? t("memoryAdded") : t("memoryUpdated"), "success");
    } catch {
      toast(t("memorySaveFailed"), "danger");
    } finally {
      setWorking(false);
    }
  }

  async function togglePinned(item: MemoryItemDto) {
    setItems((current) =>
      current.map((memory) => (memory.id === item.id ? { ...memory, pinned: !item.pinned } : memory))
    );
    try {
      const saved = await api.updateMemory(item.id, { pinned: !item.pinned });
      setItems((current) => current.map((memory) => (memory.id === item.id ? saved : memory)));
    } catch {
      setItems((current) => current.map((memory) => (memory.id === item.id ? item : memory)));
      toast(t("pinSaveFailed"), "danger");
    }
  }

  async function deleteMemory(item: MemoryItemDto) {
    const previous = items;
    setWorking(true);
    setItems((current) => current.filter((memory) => memory.id !== item.id));
    try {
      await api.deleteMemory(item.id);
      setPendingDelete(undefined);
      toast(t("memoryDeleted"), "success");
    } catch {
      setItems(previous);
      toast(t("memoryDeleteFailed"), "danger");
    } finally {
      setWorking(false);
    }
  }

  async function clearAll() {
    setWorking(true);
    try {
      const result = await api.clearMemories();
      setItems([]);
      setConfirmClear(false);
      toast(result.deleted ? t("memoriesCleared", { count: result.deleted }) : t("memoriesNoneToClear"), "success");
    } catch {
      toast(t("memoriesClearFailed"), "danger");
    } finally {
      setWorking(false);
    }
  }

  async function startMaintenance() {
    setStartingMaintenance(true);
    try {
      const next = await api.startMemoryMaintenance();
      setMaintenance(next);
      toast(
        next.status === "running"
          ? t("memoryMaintenanceStarted")
          : next.status === "failed"
            ? maintenanceFailureLabel(next.lastError)
            : t("memoryAlreadyFresh"),
        next.status === "failed" ? "danger" : "success"
      );
    } catch {
      toast(t("memoryMaintenanceUnavailable"), "danger");
    } finally {
      setStartingMaintenance(false);
    }
  }

  const maintenanceLabel =
    maintenance?.status === "running"
      ? t("memoryMaintaining")
      : maintenance?.status === "failed"
        ? maintenanceFailureLabel(maintenance.lastError)
        : maintenance?.lastCompletedAt
          ? t("lastMaintained", {
              date: new Date(maintenance.lastCompletedAt).toLocaleDateString(localeTag(), {
                month: "short",
                day: "numeric"
              })
            })
          : t("neverMaintained");

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="memory-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.section
            className="memory-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="memory-title"
            initial={{ opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.99 }}
            transition={{ type: "spring", bounce: 0, duration: 0.3 }}
          >
            <header className="memory-panel-header">
              <div>
                <p>{t("workspace")}</p>
                <h2 id="memory-title">{workspaceTabTitle(tab)}</h2>
              </div>
              <button onClick={onClose} aria-label={t("closeWorkspace")}>
                <Icon name="close" />
              </button>
            </header>
            <nav className="memory-tabs" aria-label={t("workspaceTabs")}>
              {workspaceTabItems().map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={tab === item.id ? "active" : ""}
                  aria-current={tab === item.id ? "page" : undefined}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            <div className="memory-panel-scroll">
              {tab === "handbook" && (
                <HandbookPanel profileId={currentProfileId} agentProfiles={agentProfiles} toast={toast} />
              )}
              {tab === "capabilities" && (
                <CapabilitiesPanel
                  profileId={currentProfileId}
                  agentProfiles={agentProfiles}
                  toast={toast}
                  onOpenConversation={onOpenConversation}
                  onClose={onClose}
                />
              )}
              {tab === "shelf" && (
                <ShelfPanel profileId={currentProfileId} agentProfiles={agentProfiles} toast={toast} />
              )}
              {tab === "memory" && (
                <>
                  <section className="memory-settings" aria-label={t("memorySettings")}>
                    <Toggle
                      checked={settings.enabled}
                      onChange={(value) => void changeSetting("enabled", value)}
                      label={t("useMemory")}
                      description={t("useMemoryHint")}
                    />
                    <Toggle
                      checked={settings.autoSave}
                      onChange={(value) => void changeSetting("autoSave", value)}
                      disabled={!settings.enabled}
                      label={t("autoOrganize")}
                      description={t("autoOrganizeHint")}
                    />
                    <Toggle
                      checked={settings.referenceHistory}
                      onChange={(value) => void changeSetting("referenceHistory", value)}
                      disabled={!settings.enabled}
                      label={t("referenceHistory")}
                      description={t("referenceHistoryHint")}
                    />
                    <div className="memory-maintenance-row">
                      <span>
                        <b>{t("periodicRefine")}</b>
                        <small>{maintenanceLabel}</small>
                        <small>
                          {maintenance
                            ? t("newTasks", {
                                count: maintenance.newTaskCount,
                                threshold: maintenance.taskThreshold,
                                days: maintenance.intervalDays
                              })
                            : t("refineDefault")}
                        </small>
                      </span>
                      <button
                        type="button"
                        onClick={() => void startMaintenance()}
                        disabled={!settings.enabled || startingMaintenance || maintenance?.status === "running"}
                      >
                        {startingMaintenance
                          ? t("starting")
                          : maintenance?.status === "running"
                            ? t("refining")
                            : t("refineNow")}
                      </button>
                    </div>
                  </section>

                  <section className="memory-library" aria-label={t("savedMemories")}>
                    <div className="memory-library-heading">
                      <div>
                        <p>{t("memoryLibrary")}</p>
                        <span>{t("memoryCount", { count: items.length })}</span>
                      </div>
                      <button className="memory-add" onClick={() => setEditor("new")}>
                        <Icon name="plus" size={16} />
                        {t("add")}
                      </button>
                    </div>
                    <div className="memory-search">
                      <Icon name="search" size={17} />
                      <input
                        ref={searchRef}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("searchMemory")}
                        aria-label={t("searchMemory")}
                      />
                      {query && (
                        <button
                          onClick={() => {
                            setQuery("");
                            searchRef.current?.focus();
                          }}
                          aria-label={t("clearSearch")}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      )}
                    </div>
                    <div className="memory-categories" role="tablist" aria-label={t("memoryCategories")}>
                      {memoryCategories().map((item) => (
                        <button
                          key={item.value}
                          role="tab"
                          aria-selected={category === item.value}
                          className={category === item.value ? "active" : ""}
                          onClick={() => setCategory(item.value)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    {error && (
                      <p className="memory-error" role="alert">
                        {error}
                      </p>
                    )}
                    {loading ? (
                      <div className="memory-loading" role="status">
                        {t("loading")}
                      </div>
                    ) : items.length ? (
                      <div className="memory-list">
                        {items.map((item) => (
                          <article className="memory-item" key={item.id}>
                            <div className="memory-item-top">
                              <span>
                                {categoryLabel(item.category)}
                                {item.profileId
                                  ? ` · ${localizedProfile(item.profileId, agentProfiles.find((profile) => profile.id === item.profileId)?.name, undefined).name}`
                                  : ""}
                              </span>
                              <time dateTime={item.updatedAt}>
                                {new Date(item.updatedAt).toLocaleDateString(localeTag(), {
                                  month: "short",
                                  day: "numeric"
                                })}
                              </time>
                            </div>
                            <h3>{item.title}</h3>
                            <p>{item.content}</p>
                            {item.keywords.length > 0 && (
                              <div className="memory-keywords">
                                {item.keywords.slice(0, 4).map((keyword) => (
                                  <span key={keyword}>{keyword}</span>
                                ))}
                              </div>
                            )}
                            <footer>
                              <button
                                className={item.pinned ? "is-pinned" : ""}
                                onClick={() => void togglePinned(item)}
                                aria-pressed={item.pinned}
                              >
                                <Icon name="pin" size={14} />
                                {item.pinned ? t("isPinned") : t("pin")}
                              </button>
                              <span />
                              <button onClick={() => setEditor(item)}>
                                <Icon name="edit" size={14} />
                                {t("edit")}
                              </button>
                              <button className="danger" onClick={() => setPendingDelete(item)}>
                                <Icon name="trash" size={14} />
                                {t("delete")}
                              </button>
                            </footer>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="memory-empty">
                        <Icon name="memory" />
                        <p>{query ? t("noMatchingMemory") : t("noMemoryYet")}</p>
                        <small>{query ? t("tryOtherKeywords") : t("addOrAuto")}</small>
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
            {tab === "memory" && (
              <footer className="memory-panel-footer">
                <p>{t("deleteKeepsMemory")}</p>
                <button className="memory-clear" onClick={() => setConfirmClear(true)} disabled={!items.length}>
                  {t("clearMemory")}
                </button>
              </footer>
            )}
            {tab === "handbook" && (
              <footer className="memory-panel-footer">
                <p>{t("handbookRuntimeOnly")}</p>
              </footer>
            )}
            {tab === "capabilities" && (
              <footer className="memory-panel-footer">
                <p>{t("capabilitiesFooter")}</p>
              </footer>
            )}
            {tab === "shelf" && (
              <footer className="memory-panel-footer">
                <p>{t("deliveryShelfFooter")}</p>
              </footer>
            )}

            <AnimatePresence>
              {editor && (
                <motion.div
                  className="memory-subpanel"
                  initial={{ opacity: 0, x: 18 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  transition={{ type: "spring", bounce: 0, duration: 0.28 }}
                >
                  <MemoryEditor
                    memory={editor === "new" ? undefined : editor}
                    onCancel={() => setEditor(undefined)}
                    onSave={(input) => void saveMemory(input)}
                    working={working}
                    agentProfiles={agentProfiles}
                    currentProfileId={currentProfileId}
                  />
                </motion.div>
              )}
            </AnimatePresence>
            <ConfirmDialog
              open={Boolean(pendingDelete)}
              title={t("deleteMemoryTitle")}
              description={pendingDelete ? t("deleteMemoryBody", { title: pendingDelete.title }) : ""}
              working={working}
              onCancel={() => setPendingDelete(undefined)}
              onConfirm={() => {
                if (pendingDelete) void deleteMemory(pendingDelete);
              }}
            />
            <ConfirmDialog
              open={confirmClear}
              title={t("clearAllTitle")}
              description={t("clearAllBody")}
              confirmLabel={t("confirmClear")}
              workingLabel={t("clearing")}
              working={working}
              onCancel={() => setConfirmClear(false)}
              onConfirm={() => void clearAll()}
            />
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function fileKindLabel(item: ShelfItem, translate: ReturnType<typeof useLocale>["t"]) {
  const name = item.fileName.toLowerCase();
  if (name.endsWith(".pdf") || item.mimeType === "application/pdf") return "PDF";
  if (name.endsWith(".docx") || item.mimeType.includes("wordprocessingml")) return "Word";
  if (name.endsWith(".xlsx") || item.mimeType.includes("spreadsheetml")) return "Excel";
  if (name.endsWith(".md") || item.mimeType === "text/markdown") return "Markdown";
  if (item.mimeType.startsWith("image/")) return item.mimeType.replace("image/", "").toUpperCase();
  return item.mimeType || translate("file");
}

function ShelfPanel({
  profileId,
  agentProfiles,
  toast
}: {
  profileId?: string;
  agentProfiles: AgentProfileSummary[];
  toast: MemoryDialogProps["toast"];
}) {
  const { t } = useLocale();
  const [selectedProfileId, setSelectedProfileId] = useState(profileId ?? agentProfiles[0]?.id ?? "");
  const [items, setItems] = useState<ShelfItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ShelfItem>();
  const [working, setWorking] = useState(false);

  useEffect(() => {
    setSelectedProfileId(profileId ?? agentProfiles[0]?.id ?? "");
  }, [profileId, agentProfiles]);

  useEffect(() => {
    if (!selectedProfileId) {
      setError(t("chooseAssistantFirst"));
      setItems([]);
      return;
    }
    setLoading(true);
    void api
      .shelf(selectedProfileId)
      .then((next) => {
        setItems(next);
        setError("");
      })
      .catch(() => setError(t("shelfLoadFailed")))
      .finally(() => setLoading(false));
  }, [selectedProfileId, t]);

  async function removeItem(item: ShelfItem) {
    setWorking(true);
    try {
      await api.deleteShelfItem(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setPendingDelete(undefined);
      toast(t("shelfItemRemoved", { name: item.fileName }), "success");
    } catch {
      toast(t("shelfDeleteFailed"), "danger");
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="memory-library" aria-label={t("deliveryShelf")}>
      {agentProfiles.length > 1 && (
        <label className="handbook-profile">
          <span>{t("belongsToAssistant")}</span>
          <select value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}>
            {agentProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {localizedProfile(profile.id, profile.name, profile.description).name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="memory-library-heading">
        <div>
          <p>{t("deliveryShelf")}</p>
          <span>{t("shelfCount", { count: items.length })}</span>
        </div>
      </div>
      {error && (
        <p className="memory-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="memory-loading" role="status">
          {t("loading")}
        </div>
      ) : items.length ? (
        <div className="memory-list">
          {items.map((item) => (
            <article className="memory-item" key={item.id}>
              <div className="memory-item-top">
                <span>{fileKindLabel(item, t)}</span>
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleDateString(localeTag(), { month: "short", day: "numeric" })}
                </time>
              </div>
              <h3>{item.fileName}</h3>
              <p>{item.relativePath}</p>
              <footer>
                <a href={api.shelfOpenUrl(item.id)} target="_blank" rel="noreferrer">
                  <Icon name="file" size={14} />
                  {t("open")}
                </a>
                <a href={api.shelfDownloadUrl(item.id)} download={item.fileName}>
                  <Icon name="share" size={14} />
                  {t("download")}
                </a>
                <span />
                <button className="danger" type="button" onClick={() => setPendingDelete(item)}>
                  <Icon name="trash" size={14} />
                  {t("delete")}
                </button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="memory-empty">
          <Icon name="file" />
          <p>{t("deliveryShelfEmpty")}</p>
          <small>{t("deliveryShelfEmptyHint")}</small>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("deleteShelfTitle")}
        description={pendingDelete ? t("deleteShelfBody", { name: pendingDelete.fileName }) : ""}
        working={working}
        onCancel={() => setPendingDelete(undefined)}
        onConfirm={() => {
          if (pendingDelete) void removeItem(pendingDelete);
        }}
      />
    </section>
  );
}

function HandbookPanel({
  profileId,
  agentProfiles,
  toast
}: {
  profileId?: string;
  agentProfiles: AgentProfileSummary[];
  toast: MemoryDialogProps["toast"];
}) {
  const { t } = useLocale();
  const [selectedProfileId, setSelectedProfileId] = useState(profileId ?? agentProfiles[0]?.id ?? "");
  const [handbook, setHandbook] = useState<HandbookDocument>();
  const [markdown, setMarkdown] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setSelectedProfileId(profileId ?? agentProfiles[0]?.id ?? "");
  }, [profileId, agentProfiles]);

  useEffect(() => {
    if (!selectedProfileId) {
      setError(t("chooseAssistantFirst"));
      return;
    }
    void api
      .handbook(selectedProfileId)
      .then((next) => {
        setHandbook(next);
        setMarkdown(next.markdown);
        setError("");
      })
      .catch(() => setError(t("handbookLoadFailed")));
  }, [selectedProfileId]);

  async function save() {
    if (!selectedProfileId) {
      setError(t("chooseAssistantSave"));
      return;
    }
    setWorking(true);
    setError("");
    try {
      const next = await api.saveHandbook(selectedProfileId, markdown);
      setHandbook(next);
      setMarkdown(next.markdown);
      toast(t("handbookSaved"), "success");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("handbookSaveFailed"));
      toast(t("handbookSaveFailed"), "danger");
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="memory-library" aria-label={t("workspaceHandbook")}>
      {agentProfiles.length > 1 && (
        <label className="handbook-profile">
          <span>{t("belongsToAssistant")}</span>
          <select value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}>
            {agentProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {localizedProfile(profile.id, profile.name, profile.description).name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="memory-library-heading">
        <div>
          <p>{t("editableHandbook")}</p>
          <span>{t("handbookLines", { count: handbook?.playbooks.length ?? 0 })}</span>
        </div>
      </div>
      <p className="handbook-hint">{t("handbookFormatHint")}</p>
      {error && (
        <p className="memory-error" role="alert">
          {error}
        </p>
      )}
      <textarea
        className="handbook-editor"
        value={markdown}
        onChange={(event) => setMarkdown(event.target.value)}
        rows={14}
        spellCheck={false}
      />
      <button
        className="button-accent handbook-save"
        type="button"
        onClick={() => void save()}
        disabled={working || !selectedProfileId}
      >
        {working ? t("saving") : t("saveHandbook")}
      </button>
    </section>
  );
}

function CapabilitiesPanel({
  profileId,
  agentProfiles,
  toast,
  onOpenConversation,
  onClose
}: {
  profileId?: string;
  agentProfiles: AgentProfileSummary[];
  toast: MemoryDialogProps["toast"];
  onOpenConversation?: (conversation: ConversationDetail) => void;
  onClose?: () => void;
}) {
  const { t } = useLocale();
  const [selectedProfileId, setSelectedProfileId] = useState(profileId ?? agentProfiles[0]?.id ?? "");
  const [equipment, setEquipment] = useState<ProfileEquipment>();
  const [preview, setPreview] = useState<EvolvedArtifact>();
  const [error, setError] = useState("");
  const [snapshotRunId, setSnapshotRunId] = useState<string>();

  useEffect(() => {
    setSelectedProfileId(profileId ?? agentProfiles[0]?.id ?? "");
  }, [profileId, agentProfiles]);

  function reload() {
    if (!selectedProfileId) {
      setError(t("chooseAssistantCapabilities"));
      return Promise.resolve();
    }
    return api
      .equipment(selectedProfileId)
      .then((next) => {
        setEquipment(next);
        setError("");
      })
      .catch(() => setError(t("capabilitiesLoadFailed")));
  }

  useEffect(() => {
    void reload();
  }, [selectedProfileId]);
  useEffect(() => {
    if (!selectedProfileId) return;
    void api
      .latestSnapshot(selectedProfileId)
      .then((item) => setSnapshotRunId(item.runId))
      .catch(() => setSnapshotRunId(undefined));
  }, [selectedProfileId]);

  async function openReplay(runId: string | undefined, includeArtifactId?: string) {
    if (!runId) {
      toast(t("noReplaySnapshot"));
      return;
    }
    try {
      const result = await api.replayRun(runId, includeArtifactId ? { includeArtifactId } : undefined);
      if (!result.conversation) throw new Error("missing conversation");
      onOpenConversation?.(result.conversation);
      onClose?.();
      toast(t("replayOpened"), "success");
    } catch {
      toast(t("replayFailed"), "danger");
    }
  }

  async function toggle(item: EquipmentItem) {
    if (!item.artifactId || item.origin !== "evolved") return;
    try {
      await api.setEvolvedArtifactEnabled(item.artifactId, !item.enabled);
      await reload();
      toast(item.enabled ? t("evolvedOff") : t("evolvedOn"), "success");
    } catch {
      toast(t("capabilityUpdateFailed"), "danger");
    }
  }

  async function review(artifact: EvolvedArtifact, verdict: "pass" | "reject") {
    try {
      await api.reviewEvolvedArtifact(
        artifact.id,
        verdict,
        verdict === "pass" ? t("workspaceConfirmEnable") : t("workspaceReject")
      );
      await reload();
      toast(
        verdict === "pass" ? t("enabledItem", { name: artifact.name }) : t("rejectedItem", { name: artifact.name }),
        "success"
      );
    } catch {
      toast(t("reviewFailed"), "danger");
    }
  }

  async function showPreview(item: EquipmentItem) {
    if (!item.artifactId) return;
    try {
      setPreview(await api.getEvolvedArtifact(item.artifactId));
    } catch {
      toast(t("previewFailed"), "danger");
    }
  }

  if (!equipment)
    return (
      <div className="memory-loading" role="status">
        {error || t("reading")}
      </div>
    );

  return (
    <section className="memory-library" aria-label={t("assistantSkills")}>
      {agentProfiles.length > 1 && (
        <label className="handbook-profile">
          <span>{t("belongsToAssistant")}</span>
          <select value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}>
            {agentProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {localizedProfile(profile.id, profile.name, profile.description).name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p className="memory-error" role="alert">
          {error}
        </p>
      )}
      {equipment.pending.length > 0 && (
        <div className="capability-pending">
          <p>{t("pendingReview")}</p>
          {equipment.pending.map((item) => (
            <article key={item.id} className="capability-item is-pending">
              <div className="capability-item-top">
                <span>
                  {t("evolved")} · {item.kind === "skill" ? t("skill") : t("subagent")}
                </span>
                <em>{t("pending")}</em>
              </div>
              <h3>{item.name}</h3>
              <p>{item.description}</p>
              {item.evaluation?.reason && <small>{item.evaluation.reason}</small>}
              <footer>
                <button onClick={() => void review(item, "pass")}>{t("enable")}</button>
                <button className="danger" onClick={() => void review(item, "reject")}>
                  {t("reject")}
                </button>
                <button onClick={() => setPreview(item)}>{t("preview")}</button>
                <button onClick={() => void openReplay(item.evaluation?.replayRunId ?? snapshotRunId)}>
                  {t("shadowReplayBefore")}
                </button>
                <button onClick={() => void openReplay(item.evaluation?.replayRunId ?? snapshotRunId, item.id)}>
                  {t("shadowReplayAfter")}
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
      <CapabilityGroup title="Skills" items={equipment.skills} onToggle={toggle} onPreview={showPreview} />
      <CapabilityGroup title={t("subagent")} items={equipment.delegates} onToggle={toggle} onPreview={showPreview} />
      <AnimatePresence>
        {preview && (
          <motion.div
            className="memory-subpanel"
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 10 }}
          >
            <div className="memory-editor-heading">
              <div>
                <p>{t("evolvedPreview")}</p>
                <h3>{preview.name}</h3>
              </div>
              <button type="button" onClick={() => setPreview(undefined)} aria-label={t("closePreview")}>
                <Icon name="close" size={17} />
              </button>
            </div>
            <pre className="capability-preview">{preview.body}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function CapabilityGroup({
  title,
  items,
  onToggle,
  onPreview
}: {
  title: string;
  items: EquipmentItem[];
  onToggle: (item: EquipmentItem) => void;
  onPreview: (item: EquipmentItem) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="capability-group">
      <div className="memory-library-heading">
        <div>
          <p>{title}</p>
          <span>{items.length}</span>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="handbook-hint">{t("noItems", { title })}</p>
      ) : (
        items.map((item) => (
          <article key={`${item.origin}-${item.id}`} className="capability-item">
            <div className="capability-item-top">
              <span>{item.origin === "official" ? t("official") : t("evolved")}</span>
              <em>{item.enabled ? t("enabled") : t("disabled")}</em>
            </div>
            <h3>{item.name}</h3>
            <p>{item.description}</p>
            <footer>
              {item.origin === "evolved" && (
                <button onClick={() => onToggle(item)}>{item.enabled ? t("turnOff") : t("enable")}</button>
              )}
              {item.origin === "evolved" && <button onClick={() => onPreview(item)}>{t("preview")}</button>}
              {item.origin === "official" && <small>{t("officialReadonly")}</small>}
            </footer>
          </article>
        ))
      )}
    </div>
  );
}
