import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { api } from "../api";
import { localeTag, useLocale } from "../i18n";
import { pendingLearningVerification } from "../learningPresentation";
import { matchSlashCommands, slashQuery, type SlashCommandId } from "../slashCommands";
import type {
  AskUserQuestion,
  AskUserQuestionItem,
  Attachment,
  ConversationDetail,
  LearningDemoScenarioDto
} from "../types";
import type { Workspace } from "../useWorkspace";

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: unknown) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function sizeLabel(bytes?: number) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function speechConstructor() {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

export function Composer({
  workspace,
  conversation,
  seededPrompt,
  onSeedConsumed,
  onOpenLearning
}: {
  workspace: Workspace;
  conversation?: ConversationDetail;
  seededPrompt?: string;
  onSeedConsumed: () => void;
  onOpenLearning: () => void;
}) {
  const { t } = useLocale();
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashError, setSlashError] = useState(false);
  const [submittingMessage, setSubmittingMessage] = useState(false);
  const [steeringRunId, setSteeringRunId] = useState<string>();
  const [editingRunId, setEditingRunId] = useState<string>();
  const [editDraft, setEditDraft] = useState("");
  const [queueBusyId, setQueueBusyId] = useState<string>();
  const [learningSetupOpen, setLearningSetupOpen] = useState(false);
  const [learningGoal, setLearningGoal] = useState("");
  const [learningTopic, setLearningTopic] = useState("");
  const [learningCondition, setLearningCondition] = useState<"on-call" | "one-shot" | "multi-turn">("on-call");
  const [learningBusy, setLearningBusy] = useState(false);
  const [learningDemos, setLearningDemos] = useState<LearningDemoScenarioDto[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | undefined>(undefined);
  const running =
    conversation?.runState === "submitting" ||
    conversation?.runState === "running" ||
    conversation?.runState === "reconnecting";
  const interrupting = conversation?.runState === "interrupting";
  const uploading = attachments.some((item) => item.status === "uploading");
  const offline = workspace.backendDown;
  const canSend =
    !offline &&
    Boolean(content.trim() || attachments.some((item) => item.status === "ready")) &&
    !uploading &&
    !interrupting &&
    !submittingMessage;
  const sendingQueuedMessage = Boolean(running && canSend);
  const showStop = Boolean((running && !sendingQueuedMessage) || interrupting);
  const lastAssistant = useMemo(
    () => [...(conversation?.messages ?? [])].reverse().find((message) => message.role === "assistant"),
    [conversation?.messages]
  );
  const queuedMessages = useMemo(() => {
    const messages = new Map((conversation?.messages ?? []).map((message) => [message.id, message]));
    return (conversation?.queuedRuns ?? []).flatMap((run) => {
      const message = messages.get(run.userMessageId);
      return message ? [{ ...run, message }] : [];
    });
  }, [conversation?.messages, conversation?.queuedRuns]);
  const slashMatches = useMemo(() => matchSlashCommands(content), [content]);
  const slashRequested = slashQuery(content) !== undefined;
  const slashOpen = slashRequested && !slashDismissed;
  const learningSession = conversation?.learningSession;
  const learningVerification = useMemo(
    () => pendingLearningVerification(learningSession, conversation?.messages ?? [], conversation?.activeRunId),
    [conversation?.activeRunId, conversation?.messages, learningSession]
  );

  useEffect(() => {
    if (seededPrompt) {
      setContent(seededPrompt);
      onSeedConsumed();
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [seededPrompt, onSeedConsumed]);

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 176)}px`;
  }, [content]);

  useEffect(() => {
    if (steeringRunId && !queuedMessages.some((run) => run.runId === steeringRunId)) setSteeringRunId(undefined);
    if (editingRunId && !queuedMessages.some((run) => run.runId === editingRunId)) {
      setEditingRunId(undefined);
      setEditDraft("");
    }
  }, [queuedMessages, steeringRunId, editingRunId]);

  useEffect(() => {
    setSlashIndex(0);
    setSlashError(false);
  }, [content]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!learningSetupOpen || learningSession || learningDemos.length) return;
    void api
      .learningDemoScenarios()
      .then(setLearningDemos)
      .catch(() => setLearningDemos([]));
  }, [learningSetupOpen, learningSession, learningDemos.length]);

  useEffect(() => () => recognitionRef.current?.stop(), []);

  async function addFiles(files: File[]) {
    if (!workspace.capabilities.attachments?.enabled) {
      workspace.toast(t("attachmentsOff"), "danger");
      return;
    }
    const remaining = Math.max(0, (workspace.capabilities.attachments?.maxFiles ?? 8) - attachments.length);
    const selected = files.slice(0, remaining);
    if (selected.length < files.length)
      workspace.toast(t("maxFiles", { count: workspace.capabilities.attachments?.maxFiles ?? 8 }));
    const pending = selected.map((file) => ({
      id: `pending-${crypto.randomUUID()}`,
      name: file.name,
      size: file.size,
      type: file.type,
      status: "uploading" as const
    }));
    setAttachments((current) => [...current, ...pending]);
    const uploaded = await workspace.uploadFiles(selected);
    setAttachments((current) => [
      ...current.filter((item) => !pending.some((entry) => entry.id === item.id)),
      ...uploaded
    ]);
  }

  async function remove(item: Attachment) {
    setAttachments((current) => current.filter((entry) => entry.id !== item.id));
    await workspace.removeAttachment(item);
  }

  async function submit() {
    if (slashRequested) {
      const selected = slashMatches[Math.min(slashIndex, Math.max(0, slashMatches.length - 1))];
      if (!selected || commandDisabled(selected.id)) {
        setSlashError(true);
        return;
      }
      await executeSlash(selected.id);
      return;
    }
    if (!canSend) return;
    const nextContent = content.trim();
    const nextAttachments = attachments.filter((item) => item.status === "ready");
    setContent("");
    setAttachments([]);
    setSubmittingMessage(true);
    const accepted = await workspace.sendMessage(nextContent, running ? "queue" : "normal", nextAttachments);
    if (!accepted) {
      setContent(nextContent);
      setAttachments(nextAttachments);
    }
    setSubmittingMessage(false);
    inputRef.current?.focus();
  }

  async function steer(runId: string) {
    setSteeringRunId(runId);
    const accepted = await workspace.steerQueuedRun(runId);
    if (!accepted) setSteeringRunId(undefined);
  }

  function beginEdit(runId: string, text: string) {
    setEditingRunId(runId);
    setEditDraft(text);
  }

  async function saveEdit(runId: string, attachments?: Attachment[]) {
    const next = editDraft.trim();
    if (!next && !attachments?.length) return;
    setQueueBusyId(runId);
    const accepted = await workspace.updateQueuedRun(runId, next);
    setQueueBusyId(undefined);
    if (accepted) {
      setEditingRunId(undefined);
      setEditDraft("");
    }
  }

  async function removeQueued(runId: string) {
    setQueueBusyId(runId);
    await workspace.deleteQueuedRun(runId);
    setQueueBusyId(undefined);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((value) => (slashMatches.length ? (value + 1) % slashMatches.length : 0));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((value) => (slashMatches.length ? (value - 1 + slashMatches.length) % slashMatches.length : 0));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  function commandDisabled(id: SlashCommandId) {
    if (id === "archive") return !conversation || running || interrupting || conversation.runState === "submitting";
    return false;
  }

  async function executeSlash(id: SlashCommandId) {
    if (commandDisabled(id)) return;
    setSlashError(false);
    setContent("");
    setSlashDismissed(true);
    if (id === "new") await workspace.createConversation();
    else if (id === "archive" && conversation) await workspace.archiveConversation(conversation);
    inputRef.current?.focus();
  }

  async function copyLastReply() {
    if (!lastAssistant) return;
    try {
      await navigator.clipboard.writeText(lastAssistant.content);
      workspace.toast(t("lastReplyCopied"), "success");
    } catch {
      workspace.toast(t("copyFailed"), "danger");
    }
    setMenuOpen(false);
  }

  async function startLearning() {
    if (!learningGoal.trim()) return;
    setLearningBusy(true);
    const started = await workspace.createLearningSession({
      goal: learningGoal.trim(),
      topicKey: learningTopic.trim() || null,
      ...(workspace.researchEnabled ? { condition: learningCondition } : {})
    });
    setLearningBusy(false);
    if (started) {
      setLearningSetupOpen(false);
      onOpenLearning();
    }
  }

  async function updateLearning(status: "active" | "paused" | "completed" | "dismissed") {
    setLearningBusy(true);
    const updated = await workspace.updateLearningSession(
      status === "active" && learningSession?.status === "suggested"
        ? {
            status,
            goal: learningGoal.trim() || learningSession.goal,
            topicKey: learningTopic.trim() || learningSession.topicKey
          }
        : { status }
    );
    setLearningBusy(false);
    if (updated && status === "active") onOpenLearning();
  }

  async function startLearningDemo(scenario: LearningDemoScenarioDto, executionMode: "deterministic" | "agent") {
    setLearningBusy(true);
    const started = await workspace.startLearningDemoScenario(
      scenario.id,
      executionMode,
      workspace.researchEnabled ? learningCondition : "on-call"
    );
    setLearningBusy(false);
    if (started) {
      setLearningSetupOpen(false);
      onOpenLearning();
    }
  }

  function toggleMicrophone() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Recognition = speechConstructor();
    if (!Recognition) {
      workspace.toast(t("speechUnsupported"));
      return;
    }
    const recognition = new Recognition();
    recognition.lang = localeTag();
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const results = (event as { results?: ArrayLike<ArrayLike<{ transcript?: string }>> }).results;
      let transcript = "";
      if (results)
        for (let index = 0; index < results.length; index += 1) transcript += results[index]?.[0]?.transcript ?? "";
      if (transcript) setContent((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${transcript}`);
    };
    recognition.onerror = () => workspace.toast(t("speechEmpty"), "danger");
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = undefined;
    };
    recognitionRef.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      setListening(false);
      workspace.toast(t("speechStartFailed"), "danger");
    }
  }

  return (
    <div
      className={`composer-zone${conversation?.pendingQuestion || learningVerification ? " has-question" : ""}${offline ? " is-offline" : ""}`}
    >
      {learningSession?.status === "suggested" && (
        <div className="learning-suggestion" role="status">
          <span>
            <b>{t("learningSuggested")}</b>
            <small>{learningSession.suggestionReason || t("learningSuggestedDetail")}</small>
          </span>
          <div>
            <button
              type="button"
              onClick={() => {
                setLearningGoal(learningSession.goal);
                setLearningTopic(learningSession.topicKey ?? "");
                setLearningSetupOpen(true);
              }}
            >
              {t("learningStart")}
            </button>
            <button type="button" onClick={() => void updateLearning("dismissed")} disabled={learningBusy}>
              {t("learningDismiss")}
            </button>
          </div>
        </div>
      )}
      {learningSession && (learningSession.status === "active" || learningSession.status === "paused") && (
        <div className={`learning-status-pill is-${learningSession.status}`}>
          <button type="button" onClick={onOpenLearning}>
            <Icon name="learning" size={14} />
            {learningSession.status === "active" ? t("learningActive") : t("learningPaused")}
          </button>
          <span>{learningSession.goal}</span>
          <button
            type="button"
            onClick={() => void updateLearning(learningSession.status === "active" ? "paused" : "active")}
            disabled={learningBusy}
          >
            {learningSession.status === "active" ? t("learningPause") : t("learningResume")}
          </button>
        </div>
      )}
      <AnimatePresence initial={false}>
        {conversation?.pendingQuestion && (
          <AskUserPanel
            key="tool-question"
            question={conversation.pendingQuestion}
            onAnswer={(answers) => void workspace.answerQuestion(answers)}
          />
        )}
        {!conversation?.pendingQuestion && learningVerification && (
          <AskUserPanel
            key={`learning-${learningVerification.id}`}
            question={{
              questions: [{ header: t("learningAnswerEyebrow"), question: t("learningAnswerPrompt"), options: [] }]
            }}
            ariaLabel={t("learningAnswerEyebrow")}
            placeholder={t("learningAnswerPlaceholder")}
            confirmLabel={t("learningSubmitAnswer")}
            onAnswer={(answers) => {
              const answer = Object.values(answers)[0]?.trim();
              if (answer) void workspace.sendMessage(answer, "normal", []);
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {queuedMessages.length > 0 && (
          <motion.div
            className="queued-message-list"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
            transition={{ type: "spring", bounce: 0, duration: 0.28 }}
          >
            {queuedMessages.map(({ runId, message }) => {
              const editing = editingRunId === runId;
              const busy = Boolean(steeringRunId || queueBusyId);
              const label =
                message.content ||
                message.attachments?.map((item) => item.name).join(localeTag() === "en-US" ? ", " : "、") ||
                t("attachment");
              return (
                <motion.div
                  className={`queued-message-row${editing ? " is-editing" : ""}`}
                  layout="position"
                  key={runId}
                >
                  <span className="queue-turn" aria-hidden="true" />
                  {editing ? (
                    <textarea
                      className="queued-message-edit"
                      value={editDraft}
                      rows={Math.min(4, Math.max(1, editDraft.split("\n").length))}
                      autoFocus
                      disabled={queueBusyId === runId}
                      onChange={(event) => setEditDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingRunId(undefined);
                          setEditDraft("");
                        } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void saveEdit(runId, message.attachments);
                        }
                      }}
                      aria-label={t("edit")}
                    />
                  ) : (
                    <span className="queued-message-copy">{label}</span>
                  )}
                  <div className="queued-message-actions">
                    {editing ? (
                      <>
                        <button
                          type="button"
                          className="queue-icon"
                          onClick={() => void saveEdit(runId, message.attachments)}
                          disabled={queueBusyId === runId || (!editDraft.trim() && !message.attachments?.length)}
                          aria-label={t("save")}
                        >
                          <Icon name="check" size={15} />
                        </button>
                        <button
                          type="button"
                          className="queue-icon"
                          onClick={() => {
                            setEditingRunId(undefined);
                            setEditDraft("");
                          }}
                          disabled={queueBusyId === runId}
                          aria-label={t("cancel")}
                        >
                          <Icon name="close" size={15} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="queue-icon"
                          onClick={() => beginEdit(runId, message.content)}
                          disabled={busy}
                          aria-label={t("edit")}
                        >
                          <Icon name="edit" size={14} />
                        </button>
                        <button
                          type="button"
                          className="queue-icon"
                          onClick={() => void removeQueued(runId)}
                          disabled={busy}
                          aria-label={t("delete")}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                        <button type="button" onClick={() => void steer(runId)} disabled={!running || busy}>
                          {steeringRunId === runId ? t("steering") : t("steerCurrent")}
                        </button>
                      </>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
      <motion.div
        className={`composer material-light ${dragging ? "is-dragging" : ""}`}
        layout
        transition={{ type: "spring", bounce: 0, duration: 0.34 }}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {dragging && (
          <div className="drop-overlay">
            <Icon name="paperclip" />
            <span>{t("dropFiles")}</span>
          </div>
        )}

        <AnimatePresence>
          {learningSetupOpen && (
            <motion.form
              className="learning-setup"
              onSubmit={(event) => {
                event.preventDefault();
                void startLearning();
              }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 5 }}
            >
              <header>
                <span>
                  <Icon name="learning" size={15} />
                  {t("learningSetupTitle")}
                </span>
                <button type="button" onClick={() => setLearningSetupOpen(false)} aria-label={t("cancel")}>
                  <Icon name="close" size={14} />
                </button>
              </header>
              <label>
                {t("learningGoal")}
                <input
                  value={learningGoal}
                  onChange={(event) => setLearningGoal(event.target.value)}
                  placeholder={t("learningGoalPlaceholder")}
                  maxLength={500}
                  autoFocus
                  required
                />
              </label>
              <label>
                {t("learningTopic")}
                <input
                  value={learningTopic}
                  onChange={(event) => setLearningTopic(event.target.value)}
                  placeholder={t("learningTopicPlaceholder")}
                  maxLength={100}
                />
              </label>
              {workspace.researchEnabled && (
                <div className="learning-condition-picker">
                  <span>{t("learningCondition")}</span>
                  <div role="radiogroup" aria-label={t("learningCondition")}>
                    {(["on-call", "one-shot", "multi-turn"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={learningCondition === option}
                        className={learningCondition === option ? "is-selected" : ""}
                        onClick={() => setLearningCondition(option)}
                      >
                        {option === "on-call"
                          ? t("learningConditionOnCall")
                          : option === "one-shot"
                            ? t("learningConditionOneShot")
                            : t("learningConditionMultiTurn")}
                      </button>
                    ))}
                  </div>
                  <small>{t("learningConditionHint")}</small>
                </div>
              )}
              <footer>
                <button type="button" onClick={() => setLearningSetupOpen(false)}>
                  {t("cancel")}
                </button>
                <button type="submit" disabled={!learningGoal.trim() || learningBusy}>
                  {t("learningStart")}
                </button>
              </footer>
              {!learningSession && (
                <div className="learning-demo-cards">
                  <p>{t("learningDemoPick")}</p>
                  {learningDemos.map((scenario) => (
                    <article key={scenario.id}>
                      <header>
                        <em>{t("learningDemoCase")}</em>
                        <small>{t("learningDemoLoop")}</small>
                      </header>
                      <h3>{scenario.title}</h3>
                      <p>{scenario.description}</p>
                      <pre>{scenario.preview}</pre>
                      <div className="learning-demo-loop">{scenario.loop}</div>
                      <div className="learning-demo-actions">
                        <div>
                          <button
                            type="button"
                            className="learning-demo-agent"
                            aria-label={`${t("learningDemoAgent")} · ${scenario.title}`}
                            disabled={learningBusy || !scenario.agentAvailable}
                            onClick={() => void startLearningDemo(scenario, "agent")}
                          >
                            {t("learningDemoAgent")}
                          </button>
                          <small>
                            {scenario.agentAvailable ? t("learningDemoAgentDetail") : t("learningDemoAgentUnavailable")}
                          </small>
                        </div>
                        <button
                          type="button"
                          className="learning-demo-stable"
                          aria-label={`${t("learningDemoStable")} · ${scenario.title}`}
                          disabled={learningBusy}
                          onClick={() => void startLearningDemo(scenario, "deterministic")}
                        >
                          {t("learningDemoStable")}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </motion.form>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {attachments.length > 0 && (
            <motion.div
              className="attachment-tray"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
            >
              {attachments.map((item) => (
                <div className={`attachment-chip state-${item.status}`} key={item.id}>
                  <span className="attachment-icon">
                    <Icon name="file" />
                  </span>
                  <span>
                    <b>{item.name}</b>
                    <small>
                      {item.status === "uploading"
                        ? t("uploading")
                        : item.status === "failed"
                          ? t("uploadFailed")
                          : `${item.type || t("file")} ${sizeLabel(item.size)}`}
                    </small>
                  </span>
                  <button onClick={() => void remove(item)} aria-label={t("removeFile", { name: item.name })}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {slashOpen && (
            <motion.div
              className="slash-menu"
              role="menu"
              aria-label={t("slashCommands")}
              initial={{ opacity: 0, y: 7, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 5, scale: 0.98 }}
              transition={{ type: "spring", bounce: 0, duration: 0.28 }}
            >
              {slashMatches.map((command, index) => {
                const disabled = commandDisabled(command.id);
                return (
                  <button
                    key={command.id}
                    type="button"
                    role="menuitem"
                    className={index === slashIndex ? "is-selected" : ""}
                    disabled={disabled}
                    onPointerEnter={() => setSlashIndex(index)}
                    onClick={() => void executeSlash(command.id)}
                  >
                    <span className="slash-command-icon">
                      <Icon name={command.id === "new" ? "chat" : "archive"} size={20} />
                    </span>
                    <span>
                      <b>{command.label}</b>
                      <small>{disabled ? t("stopFirst") : command.description}</small>
                    </span>
                    <kbd>{command.command}</kbd>
                  </button>
                );
              })}
              {!slashMatches.length && <div className="slash-empty">{t("noSuchCommand")}</div>}
              {slashError && slashMatches.length > 0 && <div className="slash-error">{t("cannotRunCommand")}</div>}
            </motion.div>
          )}
        </AnimatePresence>

        <textarea
          ref={inputRef}
          value={content}
          rows={1}
          placeholder={offline ? t("composerBackendDown") : t("composerPlaceholder")}
          disabled={offline}
          onChange={(event) => {
            setContent(event.target.value);
            setSlashDismissed(false);
            setMenuOpen(false);
          }}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              void addFiles(Array.from(event.clipboardData.files));
            }
          }}
          aria-label={t("composerInput")}
        />

        <div className="composer-actions">
          <div className="composer-tools" ref={menuRef}>
            <input
              ref={fileRef}
              type="file"
              hidden
              multiple
              accept={workspace.capabilities.attachments?.accept?.join(",")}
              onChange={(event) => {
                void addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <motion.button
              whileTap={{ scale: 0.94 }}
              className="composer-plus"
              onClick={() => setMenuOpen((value) => !value)}
              aria-label={t("addAndActions")}
              aria-expanded={menuOpen}
            >
              <Icon name="plus" />
            </motion.button>
            {conversation && !learningSession && (
              <button
                type="button"
                className="learning-mode-button"
                onClick={() => setLearningSetupOpen((value) => !value)}
                aria-expanded={learningSetupOpen}
                aria-label={t("learningMode")}
              >
                <Icon name="learning" size={17} />
              </button>
            )}
            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  className="composer-menu material-light"
                  role="menu"
                  initial={{ opacity: 0, scale: 0.95, y: 8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 5 }}
                  transition={{ type: "spring", bounce: 0, duration: 0.28 }}
                >
                  <p>{t("addAndActions")}</p>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      fileRef.current?.click();
                    }}
                  >
                    <Icon name="paperclip" />
                    {t("addFile")}
                  </button>
                  {lastAssistant && (
                    <button role="menuitem" onClick={() => void copyLastReply()}>
                      <Icon name="copy" />
                      {t("copyLastReply")}
                    </button>
                  )}
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void workspace.createConversation();
                    }}
                  >
                    <Icon name="chat" />
                    {t("newChat")}
                  </button>
                  {conversation && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void workspace.updateConversation(conversation.id, { pinned: !conversation.pinned });
                      }}
                    >
                      <Icon name="pin" />
                      {conversation.pinned ? t("unpin") : t("pinChat")}
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="send-actions">
            <button
              className={`microphone-button ${listening ? "is-listening" : ""}`}
              onClick={toggleMicrophone}
              aria-pressed={listening}
              aria-label={listening ? t("stopSpeech") : t("startSpeech")}
            >
              <Icon name="microphone" />
            </button>
            <motion.button
              whileTap={{ scale: 0.94 }}
              className={`send-button ${showStop ? "is-stop" : ""}`}
              onClick={() => (showStop ? void workspace.interrupt() : void submit())}
              disabled={showStop ? interrupting || !conversation?.activeRunId : !canSend}
              aria-label={showStop ? t("stopReply") : sendingQueuedMessage ? t("queueMessage") : t("sendMessage")}
            >
              <Icon name={showStop ? "stop" : "arrowUp"} />
            </motion.button>
          </div>
        </div>
      </motion.div>
      <p className="composer-footnote">{t("composerFootnote")}</p>
    </div>
  );
}

function questionKind(item: AskUserQuestionItem) {
  if (item.multiSelect) return "multi" as const;
  const choices = item.options.filter((option) => !option.freeForm);
  if (choices.length === 0) return "fill" as const;
  return "single" as const;
}

function isOtherOption(option: AskUserQuestionItem["options"][number]) {
  return option.freeForm || /^(其他|其它|other)$/i.test(option.label.trim());
}

function displayOptions(item: AskUserQuestionItem, otherLabel: string) {
  if (questionKind(item) === "fill") return item.options;
  const options = item.options.map((option) => (isOtherOption(option) ? { ...option, freeForm: true } : option));
  if (!options.some((option) => option.freeForm)) options.push({ label: otherLabel, freeForm: true });
  return options;
}

function AskUserPanel({
  question,
  onAnswer,
  ariaLabel,
  placeholder,
  confirmLabel
}: {
  question: AskUserQuestion;
  onAnswer: (answers: Record<string, string>) => void;
  ariaLabel?: string;
  placeholder?: string;
  confirmLabel?: string;
}) {
  const { t } = useLocale();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  function toggle(item: AskUserQuestionItem, label: string) {
    setSelected((current) => {
      const previous = current[item.question] ?? [];
      const next = item.multiSelect
        ? previous.includes(label)
          ? previous.filter((value) => value !== label)
          : [...previous, label]
        : [label];
      return { ...current, [item.question]: next };
    });
  }

  function answerFor(item: AskUserQuestionItem) {
    const kind = questionKind(item);
    const options = displayOptions(item, t("askUserOther"));
    const draft = (drafts[item.question] ?? "").trim();
    const labels = selected[item.question] ?? [];
    const freeForm = options.filter((option) => option.freeForm && labels.includes(option.label));
    if (kind === "fill") return draft;
    if (freeForm.length > 0 && !draft) return "";
    const picked = options
      .filter((option) => labels.includes(option.label) && !option.freeForm)
      .map((option) => option.label);
    if (draft && freeForm.length > 0) picked.push(draft);
    return picked.join(", ");
  }

  function confirm() {
    const answers: Record<string, string> = {};
    for (const item of question.questions) {
      const answer = answerFor(item);
      if (!answer) return;
      answers[item.question] = answer;
    }
    onAnswer(answers);
  }

  const ready = question.questions.every((item) => Boolean(answerFor(item)));

  return (
    <motion.div
      className="ask-user-sheet"
      role="group"
      aria-label={ariaLabel ?? t("askUserTitle")}
      initial={{ opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.99 }}
      transition={{ type: "spring", bounce: 0, duration: 0.34 }}
    >
      {question.questions.map((item) => {
        const kind = questionKind(item);
        const options = displayOptions(item, t("askUserOther"));
        const labels = selected[item.question] ?? [];
        const showFill = kind === "fill" || options.some((option) => option.freeForm && labels.includes(option.label));
        return (
          <section key={item.question}>
            <header className="ask-user-heading">
              {item.header && <p>{item.header}</p>}
              <h3>{item.question}</h3>
            </header>
            {options.length > 0 && (
              <div className="ask-user-options">
                {options.map((option, index) => {
                  const active = labels.includes(option.label);
                  return (
                    <motion.button
                      key={option.label}
                      type="button"
                      className={active ? "is-selected" : ""}
                      whileTap={{ scale: 0.985 }}
                      transition={{ duration: 0.12 }}
                      style={{ animationDelay: `${index * 40}ms` }}
                      onClick={() => toggle(item, option.label)}
                    >
                      <i aria-hidden="true">{String(index + 1).padStart(2, "0")}</i>
                      <span>
                        <b>{option.label}</b>
                        {option.description && <small>{option.description}</small>}
                      </span>
                    </motion.button>
                  );
                })}
              </div>
            )}
            {showFill && (
              <textarea
                className="ask-user-fill"
                value={drafts[item.question] ?? ""}
                placeholder={placeholder ?? t("askUserFillPlaceholder")}
                rows={3}
                onChange={(event) => setDrafts((current) => ({ ...current, [item.question]: event.target.value }))}
                aria-label={item.question}
              />
            )}
          </section>
        );
      })}
      <div className="ask-user-actions">
        <button type="button" className="ask-user-confirm" disabled={!ready} onClick={confirm}>
          {confirmLabel ?? t("askUserConfirm")}
        </button>
      </div>
    </motion.div>
  );
}
