import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { localeTag, localizedProfile, useLocale } from "../i18n";
import type { ConversationState, ConversationSummary } from "../types";
import type { Workspace } from "../useWorkspace";

interface SidebarProps {
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
  onDismiss: () => void;
  listState: ConversationState;
  onListState: (state: ConversationState) => void;
  onOpenSearch: () => void;
  onRequestDelete: (item: ConversationSummary) => void;
}

function relativeDate(value: string, t: ReturnType<typeof useLocale>["t"]) {
  const date = new Date(value);
  const today = new Date();
  const delta = today.getTime() - date.getTime();
  if (delta < 60_000) return t("justNow");
  if (delta < 3_600_000) return t("minutesAgo", { count: Math.max(1, Math.floor(delta / 60_000)) });
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString(localeTag(), { month: "short", day: "numeric" });
}

function ConversationRow({
  item,
  selected,
  onSelect,
  onUpdate,
  onArchive,
  onDelete,
  t
}: {
  item: ConversationSummary;
  selected: boolean;
  onSelect: () => void;
  onUpdate: Workspace["updateConversation"];
  onArchive: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useLocale>["t"];
}) {
  const [menu, setMenu] = useState(false);
  return (
    <motion.div
      layout
      transition={{ type: "spring", bounce: 0, duration: 0.34 }}
      className={`conversation-row-wrap ${selected ? "is-selected" : ""}`}
    >
      <button className="conversation-row" onClick={onSelect} aria-current={selected ? "page" : undefined}>
        <span className="conversation-row-main">
          <span className="conversation-title-line">
            {item.pinned && <Icon name="pin" size={12} />}
            <span className="conversation-title">{item.title}</span>
          </span>
          <span className="conversation-meta">
            <span className="channel-dot" />
            {localizedProfile(item.profileId ?? "", item.profileName ?? item.channel ?? "Web").name} ·{" "}
            {relativeDate(item.updatedAt, t)}
          </span>
        </span>
      </button>
      <button
        className="icon-button row-menu-button"
        onClick={() => setMenu((value) => !value)}
        aria-label={t("manageConversation", { title: item.title })}
        aria-expanded={menu}
      >
        <Icon name="more" size={17} />
      </button>
      <AnimatePresence>
        {menu && (
          <motion.div
            className="popover row-popover"
            role="menu"
            initial={{ opacity: 0, scale: 0.94, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: "spring", bounce: 0, duration: 0.28 }}
          >
            <button
              role="menuitem"
              onClick={() => {
                void onUpdate(item.id, { pinned: !item.pinned });
                setMenu(false);
              }}
            >
              <Icon name="pin" />
              {item.pinned ? t("unpin") : t("pin")}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                void onArchive();
                setMenu(false);
              }}
            >
              <Icon name={item.state === "active" ? "archive" : "unarchive"} />
              {item.state === "active" ? t("archive") : t("unarchive")}
            </button>
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                onDelete();
                setMenu(false);
              }}
            >
              <Icon name="trash" />
              {t("deletePermanently")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function Sidebar({
  workspace,
  open,
  onClose,
  onDismiss,
  listState,
  onListState,
  onOpenSearch,
  onRequestDelete
}: SidebarProps) {
  const { t } = useLocale();
  const [newChatOpen, setNewChatOpen] = useState(false);
  const newChatRef = useRef<HTMLDivElement>(null);
  const items = listState === "active" ? workspace.active : workspace.archived;
  const grouped = useMemo(() => {
    const pinned = items.filter((item) => item.pinned);
    const rest = items.filter((item) => !item.pinned);
    return [
      { label: pinned.length ? t("pinned") : "", items: pinned },
      { label: listState === "active" ? t("recent") : t("archived"), items: rest }
    ].filter((group) => group.items.length);
  }, [items, listState, t]);

  useEffect(() => {
    if (!newChatOpen) return;
    const close = (event: PointerEvent) => {
      if (!newChatRef.current?.contains(event.target as Node)) setNewChatOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNewChatOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [newChatOpen]);

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.button
            className="mobile-scrim"
            aria-label={t("closeConversationList")}
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
        )}
      </AnimatePresence>
      <motion.aside
        className={`sidebar material-heavy ${open ? "is-open" : ""}`}
        animate={{ x: open ? 0 : "-112%", opacity: open ? 1 : 0 }}
        transition={{ type: "spring", bounce: 0.18, duration: 0.32 }}
        aria-label={t("conversationList")}
        aria-hidden={!open}
      >
        <div className="sidebar-command-group">
          <div className="sidebar-brand">
            <span className="sidebar-brand-glyph" aria-hidden="true">
              <Icon name="brand" size={17} />
            </span>
            <span className="sidebar-brand-word">{t("appTitle")}</span>
          </div>
          <div className="sidebar-command-row">
            <div className="new-chat-wrap" ref={newChatRef}>
              <button
                className="new-chat-button"
                onClick={() => {
                  void workspace.createConversation(false, workspace.conversation?.profileId ?? "graduate-admissions");
                  onClose();
                }}
              >
                <span className="new-chat-icon">
                  <Icon name="plus" />
                </span>
                <span>{t("createConversation")}</span>
              </button>
              <button
                className="new-chat-menu-button"
                onClick={() => setNewChatOpen((value) => !value)}
                aria-label={t("chooseChatType")}
                aria-expanded={newChatOpen}
              >
                <Icon name="chevronRight" size={15} />
              </button>
              <AnimatePresence>
                {newChatOpen && (
                  <motion.div
                    className="popover new-chat-popover"
                    role="menu"
                    initial={{ opacity: 0, scale: 0.96, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    transition={{ type: "spring", bounce: 0, duration: 0.24 }}
                  >
                    <p>{t("conversationType")}</p>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setNewChatOpen(false);
                        void workspace.createConversation(true);
                        onClose();
                      }}
                    >
                      <Icon name="clock" />
                      <span>
                        <b>{t("temporaryChat")}</b>
                        <small>{t("temporaryChatHint")}</small>
                      </span>
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <button
              className="icon-button sidebar-close-button"
              onClick={onDismiss}
              aria-label={t("closeConversationList")}
            >
              <Icon name="close" />
            </button>
          </div>

          <button className="search-trigger" onClick={onOpenSearch}>
            <span className="search-trigger-icon">
              <Icon name="search" />
            </span>
            <span>{t("searchConversations")}</span>
          </button>
        </div>

        <nav className="sidebar-nav" aria-label={t("conversationCategories")}>
          <button className={listState === "active" ? "active" : ""} onClick={() => onListState("active")}>
            <span>{t("chats")}</span>
            <span>{workspace.active.length}</span>
          </button>
          <button className={listState === "archived" ? "active" : ""} onClick={() => onListState("archived")}>
            <span>{t("archived")}</span>
            <span>{workspace.archived.length}</span>
          </button>
        </nav>

        <div className="conversation-list" aria-live="polite">
          {workspace.loading ? (
            <div className="list-skeleton">
              <i />
              <i />
              <i />
            </div>
          ) : grouped.length ? (
            grouped.map((group) => (
              <section key={group.label}>
                <h2>{group.label}</h2>
                {group.items.map((item) => (
                  <ConversationRow
                    key={item.id}
                    item={item}
                    selected={workspace.selectedId === item.id}
                    onSelect={() => {
                      workspace.setSelectedId(item.id);
                      onClose();
                    }}
                    onUpdate={workspace.updateConversation}
                    onArchive={() => workspace.archiveConversation(item)}
                    onDelete={() => onRequestDelete(item)}
                    t={t}
                  />
                ))}
              </section>
            ))
          ) : (
            <div className="empty-list">
              <div className="empty-list-glyph">
                <Icon name={listState === "active" ? "chat" : "archive"} />
              </div>
              <p>
                {workspace.searchQuery
                  ? t("noMatchingChats")
                  : listState === "active"
                    ? t("startWithQuestion")
                    : t("archiveKeepsClean")}
              </p>
            </div>
          )}
        </div>
      </motion.aside>
    </>
  );
}
